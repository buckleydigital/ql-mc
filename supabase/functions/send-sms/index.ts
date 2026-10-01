import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalisePhone(raw: string): string | null {
  let p = (raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("04")) p = "+61" + p.slice(1);
  else if (p.startsWith("614")) p = "+" + p;
  else if (p.startsWith("61") && !p.startsWith("+")) p = "+" + p;
  if (/^\+614[0-9]{8}$/.test(p)) return p;
  return null;
}

// Every text Mission Control sends is commercial, so each carries a working
// way to opt out (Spam Act 2003). Added here, in one place, so no sender - the
// dashboard, bulk sends, Jarvis - can forget it. Skipped when the message
// already mentions STOP, so it never appears twice.
const OPT_OUT_FOOTER = "Reply STOP to opt out";
const withOptOutFooter = (msg: string) =>
  /\bstop\b/i.test(msg) ? msg : `${msg}\n\n${OPT_OUT_FOOTER}`;

// Tell ql-hq what was sent, so Don - who answers replies on this number - has
// it in the conversation history. Best effort: a failure here must never
// affect the send, which has already happened.
async function recordInHq(payload: Record<string, unknown>): Promise<void> {
  const hq = Deno.env.get("QL_HQ_API_URL");
  const secret = Deno.env.get("QL_MC_API_SECRET");
  if (!hq || !secret) {
    console.warn("QL_HQ_API_URL or QL_MC_API_SECRET not set - Don will not see this SMS");
    return;
  }
  try {
    const res = await fetch(`${hq.replace(/\/+$/, "")}/sync-from-mc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ action: "record_outbound_sms", ...payload }),
    });
    if (!res.ok) console.error(`record_outbound_sms returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } catch (err) {
    console.error("record_outbound_sms failed:", err instanceof Error ? err.message : err);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth: require valid Supabase Bearer token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Verify user token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { to, message, lead_id, source } = await req.json();
    const isSales = source === "sales";

    // Validate phone
    const normalisedTo = normalisePhone(to);
    if (!normalisedTo) {
      return new Response(JSON.stringify({ error: "Invalid AU mobile number" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate message
    if (!message || typeof message !== "string" || !message.trim()) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (message.length > 500) {
      return new Response(JSON.stringify({ error: "Message exceeds 500 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate lead_id exists in the correct table
    const { data: lead } = await supabaseAdmin
      .from(isSales ? "leads" : "ppl_leads")
      .select(isSales ? "id, name, company, sms_opted_out" : "id")
      .eq("id", lead_id)
      .single();

    if (!lead) {
      return new Response(JSON.stringify({ error: "Lead not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Never message a number that has opted out (replied STOP) - legal
    // requirement. The register (sms_opt_outs) is checked for every send, sales
    // and pay-per-lead alike, by the NUMBER being texted: an opt-out given to
    // ql-hq, or before this lead existed, counts. Fails closed - if the check
    // cannot run, nothing is sent.
    const { data: regOptOut, error: regErr } = await supabaseAdmin.rpc("sms_is_opted_out", {
      p_phone: normalisedTo,
    });
    const flagged = isSales && (lead as { sms_opted_out?: boolean }).sms_opted_out;
    if (flagged || regOptOut === true || regErr) {
      return new Response(JSON.stringify({
        error: regErr
          ? "Could not confirm this number has not opted out of SMS. Message not sent."
          : "This number has opted out of SMS (replied STOP). Message not sent.",
        opted_out: !regErr,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const outbound = withOptOutFooter(message.trim());

    // Never the same message to the same number twice in 30 days - a resent
    // bulk list, a retried request, a double-click. Claimed atomically before
    // sending (outreach_claim, migration 20261001000001) and given back if
    // Twilio rejects it. Fails closed, like the opt-out check.
    const { data: claimed, error: claimErr } = await supabaseAdmin.rpc("outreach_claim", {
      p_channel: "sms", p_recipient: normalisedTo, p_message: outbound, p_lead_id: isSales ? lead_id : null,
    });
    if (claimed !== true || claimErr) {
      return new Response(JSON.stringify({
        error: claimErr
          ? "Could not check whether this message was already sent. Message not sent."
          : "This exact message already went to this number in the last 30 days. Not sent again.",
        duplicate: !claimErr,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send SMS via Twilio
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;

    // from number: prefer business_settings (UI-configurable), fall back to env var
    const { data: bizSettings } = await supabaseAdmin
      .from("business_settings")
      .select("twilio_from_number")
      .limit(1)
      .maybeSingle();
    const fromNumber = bizSettings?.twilio_from_number || Deno.env.get("TWILIO_FROM_NUMBER") || "";;

    const params = new URLSearchParams();
    params.set("To", normalisedTo);
    params.set("From", fromNumber);
    params.set("Body", outbound);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(accountSid + ":" + authToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
    );

    const resBody = await res.text();
    let twilioSid: string | null = null;
    try {
      const parsed = JSON.parse(resBody);
      twilioSid = parsed.sid || null;
    } catch {
      // ignore parse error
    }

    const smsTable = isSales ? "sales_sms_log" : "lead_sms_log";

    if (res.ok) {
      await supabaseAdmin.from(smsTable).insert([{
        lead_id,
        to_number: normalisedTo,
        message: outbound,
        sent_by: user.email || user.id,
        twilio_sid: twilioSid,
        status: "delivered",
        direction: "outbound",
      }]);

      // Sales texts go out on the agency number Don answers; give him the
      // context. Pay-per-lead contacts are homeowners, not agency prospects,
      // and are not added to the agency's CRM in ql-hq.
      if (isSales) {
        const hqCall = recordInHq({
          phone: normalisedTo,
          message: outbound,
          lead_name: (lead as { name?: string }).name ?? null,
          company: (lead as { company?: string }).company ?? null,
          sent_by: user.email || user.id,
          twilio_sid: twilioSid,
        });
        const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (rt?.waitUntil) rt.waitUntil(hqCall);
        else await hqCall;
      }

      return new Response(
        JSON.stringify({ success: true, twilio_sid: twilioSid, error: null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      // Not sent, so it may be tried again.
      await supabaseAdmin.rpc("outreach_release", {
        p_channel: "sms", p_recipient: normalisedTo, p_message: outbound,
      });
      await supabaseAdmin.from(smsTable).insert([{
        lead_id,
        to_number: normalisedTo,
        message: outbound,
        sent_by: user.email || user.id,
        twilio_sid: twilioSid,
        status: "failed",
        direction: "outbound",
      }]);

      return new Response(
        JSON.stringify({ success: false, twilio_sid: null, error: resBody.slice(0, 500) }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
