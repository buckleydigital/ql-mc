/**
 * twilio-voice-token
 *
 * Generates a short-lived Twilio Access Token with a Voice Grant so the
 * browser (Twilio Voice JS SDK) can make outbound calls using the device mic.
 *
 * Required Supabase Edge Function secrets:
 *   TWILIO_ACCOUNT_SID      – Twilio Account SID (AC…)
 *   TWILIO_AUTH_TOKEN       – Twilio Auth Token
 *   TWILIO_API_KEY          – Twilio API Key SID (SK…)  ← create in Twilio Console
 *   TWILIO_API_SECRET       – Twilio API Key Secret      ← create in Twilio Console
 *   TWILIO_TWIML_APP_SID    – TwiML App SID (AP…)       ← Voice URL = .../twilio-voice-twiml
 *
 * How to set up the TwiML App in Twilio Console:
 *   1. Go to https://console.twilio.com/us1/develop/voice/manage/twiml-apps
 *   2. Create a new app.
 *   3. Set Voice → Request URL to:
 *      https://<your-supabase-ref>.supabase.co/functions/v1/twilio-voice-twiml
 *      (HTTP POST)
 *   4. Copy the App SID and add it as TWILIO_TWIML_APP_SID in Supabase secrets.
 *
 * How to create an API Key (required for Access Tokens):
 *   1. Go to https://console.twilio.com → Account → API keys & tokens
 *   2. Create a new Standard API key.
 *   3. Copy the SID → TWILIO_API_KEY, copy the Secret → TWILIO_API_SECRET.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function b64url(data: Uint8Array): string {
  let str = "";
  data.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function buildAccessToken(
  accountSid: string,
  apiKey: string,
  apiSecret: string,
  twimlAppSid: string,
  identity: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jti = `${apiKey}-${now}`;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    jti,
    iss: apiKey,
    sub: accountSid,
    exp: now + ttlSeconds,
    grants: {
      identity,
      voice: {
        incoming: { allow: false },
        outgoing: { application_sid: twimlAppSid },
      },
    },
  };

  const enc = new TextEncoder();
  const headerB64 = b64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Authenticate the caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const apiKey = Deno.env.get("TWILIO_API_KEY");
    const apiSecret = Deno.env.get("TWILIO_API_SECRET");
    const twimlAppSid = Deno.env.get("TWILIO_TWIML_APP_SID");

    if (!accountSid || !apiKey || !apiSecret || !twimlAppSid) {
      return new Response(
        JSON.stringify({
          error:
            "Twilio Voice not fully configured. Required secrets: TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const identity = (user.email || user.id).replace(/[^a-zA-Z0-9_\-]/g, "_");
    const ttl = 600; // 10 minutes — matches the hard call cap in the UI

    const accessToken = await buildAccessToken(
      accountSid,
      apiKey,
      apiSecret,
      twimlAppSid,
      identity,
      ttl,
    );

    return new Response(JSON.stringify({ token: accessToken, identity, ttl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
