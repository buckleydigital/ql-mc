// =============================================================================
// QuoteLeads MC — Twilio Inbound SMS Webhook
// =============================================================================
// Receives inbound SMS from Twilio and stores them in lead_sms_log with
// direction='inbound'. Twilio requires a 200 TwiML response.
//
// Setup in Twilio Console:
//   Phone Numbers → [your number] → Messaging → "A message comes in"
//   URL: https://wmegoygrancfwxagqskh.supabase.co/functions/v1/twilio-inbound-sms
//   Method: HTTP POST
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

function twimlResponse(msg?: string): Response {
  // Return an empty TwiML response (no auto-reply)
  const body = msg
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new Response(body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
}

function normalisePhone(raw: string): string {
  let p = (raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("04")) p = "+61" + p.slice(1);
  else if (p.startsWith("614") && !p.startsWith("+")) p = "+" + p;
  else if (p.startsWith("61") && !p.startsWith("+")) p = "+" + p;
  return p;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Twilio sends form-encoded POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Parse Twilio's form-encoded body
    const text = await req.text();
    const params = new URLSearchParams(text);

    const from       = params.get("From") || "";       // lead's phone number
    const to         = params.get("To") || "";         // your Twilio number
    const body       = params.get("Body") || "";
    const messageSid = params.get("MessageSid") || "";

    if (!from || !body) {
      // Still return 200 so Twilio doesn't retry
      return twimlResponse();
    }

    const normFrom = normalisePhone(from);

    // Build a deduplicated list of candidate phone formats to check.
    // Twilio sends E.164 (+61412345678) and that's what submit-lead stores,
    // so normFrom === from in the happy path. The .in() approach avoids
    // Supabase filter-string issues with the leading '+' that .or() can trip on.
    const candidates = [...new Set([from, normFrom])].filter(Boolean);

    // Opt-out / opt-in keyword detection (carrier-standard).
    const kw = body.trim().toUpperCase().replace(/[.!,?]/g, "").replace(/\s+/g, " ").trim();
    const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT", "OPT OUT"]);
    const START_WORDS = new Set(["START", "UNSTOP", "RESUBSCRIBE", "OPTIN", "OPT-IN", "OPT IN"]);
    const isStop = STOP_WORDS.has(kw);
    const isStart = START_WORDS.has(kw);

    // ── Sales-pipeline lead first (bulk SMS + Sales Conversations) ──────────────
    const { data: salesLeads } = await db
      .from("leads")
      .select("id, name, phone, sms_opted_out")
      .in("phone", candidates)
      .limit(1);
    const salesLead = salesLeads?.[0] ?? null;

    if (salesLead) {
      await db.from("sales_sms_log").insert({
        lead_id: salesLead.id,
        to_number: to,
        message: body,
        sent_by: from,
        twilio_sid: messageSid,
        status: "received",
        direction: "inbound",
      });
      if (isStop && !salesLead.sms_opted_out) {
        await db.from("leads").update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString() }).eq("id", salesLead.id);
        return twimlResponse("You have been unsubscribed and won't receive further messages. Reply START to opt back in.");
      }
      if (isStart && salesLead.sms_opted_out) {
        await db.from("leads").update({ sms_opted_out: false, sms_opted_out_at: null }).eq("id", salesLead.id);
        return twimlResponse("You're resubscribed. Reply STOP at any time to opt out.");
      }
      return twimlResponse();
    }

    // Find the lead by their phone number in ppl_leads
    const { data: leads } = await db
      .from("ppl_leads")
      .select("id, name, phone")
      .in("phone", candidates)
      .limit(1);

    const lead = leads?.[0] ?? null;

    if (!lead) {
      console.warn(`Inbound SMS from unknown number: ${from}`);
      // Log it anyway with a null lead_id so it's not silently dropped
      await db.from("lead_sms_log").insert({
        lead_id: null,
        to_number: to,
        message: body,
        sent_by: from,
        twilio_sid: messageSid,
        status: "received",
        direction: "inbound",
      });
      return twimlResponse();
    }

    // Store the inbound message
    await db.from("lead_sms_log").insert({
      lead_id: lead.id,
      to_number: to,
      message: body,
      sent_by: from,
      twilio_sid: messageSid,
      status: "received",
      direction: "inbound",
    });

    console.log(`Inbound SMS from ${from} (lead: ${lead.name}) stored.`);
    return twimlResponse();
  } catch (err) {
    console.error("twilio-inbound-sms error:", err);
    // Always return 200 to prevent Twilio retries
    return twimlResponse();
  }
});
