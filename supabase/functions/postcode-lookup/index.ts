import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATE_ABBREV: Record<string, string> = {
  "New South Wales": "NSW",
  "Victoria": "VIC",
  "Queensland": "QLD",
  "South Australia": "SA",
  "Western Australia": "WA",
  "Tasmania": "TAS",
  "Australian Capital Territory": "ACT",
  "Northern Territory": "NT",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const postcode = (body.postcode || "").toString().replace(/\s/g, "");
    const niche: string | undefined = body.niche;

    if (!/^[0-9]{4}$/.test(postcode)) {
      return new Response(
        JSON.stringify({ error: "invalid_postcode" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── SUBURB / STATE LOOKUP via Nominatim ──────────────────────────────────
    let suburb: string | null = null;
    let state: string | null = null;
    try {
      const nominatimUrl =
        `https://nominatim.openstreetmap.org/search?format=json&postalcode=${postcode}&countrycodes=au&limit=5&addressdetails=1`;
      const nominatimRes = await fetch(nominatimUrl, {
        headers: {
          "User-Agent": "QuoteLeads/1.0 (hello@quoteleads.com.au)",
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (nominatimRes.ok) {
        const places = await nominatimRes.json();
        if (Array.isArray(places) && places.length > 0) {
          const addr = places[0].address || {};
          // Prefer suburb, then city, then town, then village, then county
          suburb =
            addr.suburb ||
            addr.city ||
            addr.town ||
            addr.village ||
            addr.county ||
            null;
          const fullState: string = addr.state || "";
          state = STATE_ABBREV[fullState] || fullState || null;
        }
      }
    } catch {
      // Continue without enrichment — postcode may still be valid
    }

    if (!suburb) {
      return new Response(
        JSON.stringify({ error: "postcode_not_found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── ACTIVE CLIENT CHECK ──────────────────────────────────────────────────
    let has_active_clients = false;
    try {
      const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      let query = supabaseAdmin
        .from("clients")
        .select("id, postcodes", { count: "exact" })
        .eq("type", "ppl")
        .eq("stage", "active_client");

      if (niche) {
        query = query.or(`niche.eq.${niche},active_niches.cs.{${niche}}`);
      }

      const { data: clients } = await query;

      if (clients && clients.length > 0) {
        has_active_clients = clients.some((c: Record<string, unknown>) => {
          const pcs = c.postcodes as string[] | null;
          // A client with no postcodes restriction covers everywhere
          if (!pcs || !Array.isArray(pcs) || pcs.length === 0) return true;
          return pcs.includes(postcode);
        });
      }
    } catch {
      // Non-fatal — return suburb/state without coverage info
    }

    return new Response(
      JSON.stringify({ suburb, state, has_active_clients }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "internal_error", detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
