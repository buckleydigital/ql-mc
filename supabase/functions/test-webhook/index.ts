// Fires a realistic sample lead at a webhook URL so a client can capture the
// payload shape in Zapier/Make before any real lead is delivered.
//
// Deliberately separate from deliver-webhook: it touches no real lead, writes
// nothing to lead_delivery_log, and cannot affect live delivery. It only
// mirrors that function's payload shape.
//
// Requires a signed-in caller. Without that it would be an open proxy that
// POSTs attacker-chosen bodies to attacker-chosen URLs from our infrastructure.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sample leads per niche. The qualifying fields differ by vertical, which is
// the point: a battery retrofit lead carries existing system details, a
// roofing lead does not, and the client maps whichever they will receive.
const SAMPLES: Record<string, Record<string, unknown>> = {
  "solar": {
    lead_type: "Solar Residential",
    is_homeowner: true,
    property_type: "House",
    roof_type: "Tile",
    avg_quarterly_bill: "$500 - $800",
    interested_in: "Solar",
    purchase_timeline: "asap - next 30 days",
    custom_fields: { "Consent": "I agree to be contacted by {{business_name}} regarding my obligation-free quote." },
  },
  "battery-retrofit": {
    lead_type: "Battery Retrofit",
    is_homeowner: true,
    property_type: "House",
    system_size: "6.6kW",
    avg_quarterly_bill: "$500 - $800",
    interested_in: "Battery storage",
    purchase_timeline: "asap - next 30 days",
    custom_fields: {
      "Consent": "I agree to be contacted by {{business_name}} regarding my obligation-free quote.",
      "Existing System": "6.6kW",
      "Existing Inverter": "Fronius",
    },
  },
  "roofing": {
    lead_type: "Roofing - Restorations",
    is_homeowner: true,
    property_type: "House",
    roof_type: "Tile",
    interested_in: "Roof restoration",
    purchase_timeline: "1-3 months",
    custom_fields: {
      "Consent": "I agree to be contacted by {{business_name}} regarding my obligation-free quote.",
      "Roof Age": "20+ years",
    },
  },
  "hvac": {
    lead_type: "HVAC",
    is_homeowner: true,
    property_type: "House",
    interested_in: "Ducted air conditioning",
    purchase_timeline: "asap - next 30 days",
    custom_fields: {
      "Consent": "I agree to be contacted by {{business_name}} regarding my obligation-free quote.",
      "Home Size": "4 bedroom",
    },
  },
};

// Mirrors buildWebhookPayload in deliver-webhook. Keep the two in step: a
// client maps against whatever this sends.
function buildSamplePayload(niche: string): Record<string, unknown> {
  const extra = SAMPLES[niche] || SAMPLES["solar"];
  return {
    event: "lead.delivered",
    version: "1",
    test: true, // present only on test sends, so a client can filter them out
    delivered_at: new Date().toISOString(),
    lead: {
      id: "00000000-0000-0000-0000-000000000000",
      name: "Sarah Mitchell",
      first_name: "Sarah",
      last_name: "Mitchell",
      phone: "0412000111",
      email: "sarah.mitchell@example.com",
      postcode: "2150",
      suburb: "Parramatta",
      state: "NSW",
      address: "12 Example Street, Parramatta NSW 2150",
      source: "meta",
      monthly_bill: null,
      ...extra,
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "Not authenticated" }, 401);

    const { url, niche, auth_mode, auth_header, secret } = await req.json().catch(() => ({}));

    if (!url || typeof url !== "string") return json({ error: "A webhook URL is required" }, 400);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return json({ error: "That does not look like a valid URL" }, 400);
    }
    if (parsed.protocol !== "https:") {
      return json({ error: "Webhook URLs must use https" }, 400);
    }

    const body = JSON.stringify(buildSamplePayload(String(niche || "solar")), null, 2);
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    const cred = typeof secret === "string" ? secret : "";
    if (auth_mode === "header" && cred) {
      const name = String(auth_header || "Authorization").trim();
      if (/^[A-Za-z0-9-]+$/.test(name)) headers[name] = cred;
    } else if (auth_mode === "signature" && cred) {
      const ts = Math.floor(Date.now() / 1000).toString();
      headers["X-QuoteLeads-Timestamp"] = ts;
      headers["X-QuoteLeads-Signature"] = "sha256=" + (await hmacHex(cred, ts + "." + body));
      headers["X-QuoteLeads-Secret"] = cred;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(parsed.toString(), {
        method: "POST", headers, body, signal: controller.signal,
      });
      const text = (await res.text()).slice(0, 500);
      return json({
        ok: res.ok,
        status: res.status,
        response: text,
        sent_headers: Object.keys(headers).filter((h) => h !== "Content-Type"),
        payload: JSON.parse(body),
      });
    } catch (err) {
      const msg = err instanceof Error
        ? (err.name === "AbortError" ? "No response within 15 seconds" : err.message)
        : "Request failed";
      return json({ ok: false, status: 0, response: msg });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
