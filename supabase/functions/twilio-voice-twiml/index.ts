/**
 * twilio-voice-twiml
 *
 * Twilio calls this endpoint when the browser initiates an outbound call.
 * It returns TwiML that dials the destination number using the Twilio number
 * stored in PHONETIC_TWILIO_NUMBER.
 *
 * Security: validates that the 'To' number exists in comm_solar_appointments
 * so random numbers cannot be dialled.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const XML_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "text/xml; charset=utf-8",
};

function twimlError(msg: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${msg}</Say><Hangup/></Response>`,
    { headers: XML_HEADERS },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: XML_HEADERS });

  try {
    const body = await req.text();
    const params = new URLSearchParams(body);
    const to = params.get("To");

    if (!to) return twimlError("No destination number provided.");

    // Validate: 'to' must match a phone in comm_solar_appointments
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Normalise number for comparison (strip spaces/dashes)
    const normalise = (n: string) => n.replace(/[\s\-().]/g, "");
    const normTo = normalise(to);

    const { data: rows } = await supabase
      .from("comm_solar_appointments")
      .select("id, phone")
      .in("stage", ["new_lead", "no_answer", "appointment_booked", "disputed"]);

    const valid = (rows || []).some((r: { phone: string }) => normalise(r.phone) === normTo);
    if (!valid) {
      return twimlError("Destination number is not in the appointment list.");
    }

    const fromNumber = Deno.env.get("PHONETIC_TWILIO_NUMBER");
    if (!fromNumber) return twimlError("Caller ID not configured.");

    // Hard 10-minute cap at the Twilio level too
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${fromNumber}" timeout="30" timeLimit="600">
    <Number>${to}</Number>
  </Dial>
</Response>`;

    return new Response(twiml, { headers: XML_HEADERS });
  } catch (err) {
    return twimlError("Internal error: " + (err instanceof Error ? err.message : "unknown"));
  }
});
