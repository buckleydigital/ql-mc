import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let postcode: string | null = null;
    let niche = "solar";

    if (req.method === "POST") {
      const body = await req.json();
      postcode = (body.postcode || "").toString().replace(/\s/g, "");
      if (body.niche) niche = body.niche;
    } else {
      const url = new URL(req.url);
      postcode = (url.searchParams.get("postcode") || "").replace(/\s/g, "");
      niche = url.searchParams.get("niche") || "solar";
    }

    if (!postcode || !/^[0-9]{4}$/.test(postcode)) {
      return new Response(JSON.stringify({ error: "invalid_postcode" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Whitelist niche to prevent query injection
    const ALLOWED_NICHES = new Set(["solar", "hvac", "roofing", "gutters", "insulation"]);
    if (!ALLOWED_NICHES.has(niche)) {
      return new Response(JSON.stringify({ error: "invalid_niche" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Look up suburb / state via zippopotam.us
    let suburb: string | null = null;
    let state: string | null = null;
    try {
      const pcRes = await fetch(`https://api.zippopotam.us/au/${encodeURIComponent(postcode)}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (pcRes.ok) {
        const pcData = await pcRes.json();
        const place = pcData.places && pcData.places[0];
        if (place) {
          suburb = place["place name"] || null;
          state = place["state abbreviation"] || place["state"] || null;
        }
      }
    } catch {
      // Continue — suburb enrichment is best-effort
    }

    if (!suburb) {
      return new Response(
        JSON.stringify({ error: "not_found", postcode }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Check whether any active clients cover this postcode
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: clients } = await supabase
      .from("clients")
      .select("id, postcodes, leads_delivered, total_leads_purchased")
      .eq("type", "ppl")
      .eq("stage", "active_client")
      .or(`niche.eq.${niche},active_niches.cs.{${niche}}`);

    let has_active_clients = false;
    if (clients && clients.length > 0) {
      for (const client of clients) {
        const pcs = client.postcodes as string[] | null;
        // Skip clients whose postcode list doesn't include this postcode
        if (Array.isArray(pcs) && pcs.length > 0 && !pcs.includes(postcode)) {
          continue;
        }
        // Check remaining capacity
        const remaining =
          ((client.total_leads_purchased as number) || 0) -
          ((client.leads_delivered as number) || 0);
        if (remaining > 0) {
          has_active_clients = true;
          break;
        }
      }
    }

    return new Response(
      JSON.stringify({ postcode, suburb, state, has_active_clients }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
