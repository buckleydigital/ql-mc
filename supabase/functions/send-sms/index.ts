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

    const { to, message, lead_id } = await req.json();

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

    // Validate lead_id exists
    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("id", lead_id)
      .single();

    if (!lead) {
      return new Response(JSON.stringify({ error: "Lead not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send SMS via Twilio
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER")!;

    const params = new URLSearchParams();
    params.set("To", normalisedTo);
    params.set("From", fromNumber);
    params.set("Body", message.trim());

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

    if (res.ok) {
      await supabaseAdmin.from("lead_sms_log").insert([{
        lead_id,
        to_number: normalisedTo,
        message: message.trim(),
        sent_by: user.email || user.id,
        twilio_sid: twilioSid,
        status: "delivered",
      }]);

      return new Response(
        JSON.stringify({ success: true, twilio_sid: twilioSid, error: null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      await supabaseAdmin.from("lead_sms_log").insert([{
        lead_id,
        to_number: normalisedTo,
        message: message.trim(),
        sent_by: user.email || user.id,
        twilio_sid: twilioSid,
        status: "failed",
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
