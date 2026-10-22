import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const postcode = url.searchParams.get("postcode");

    if (!postcode || !/^\d{4}$/.test(postcode)) {
      return new Response(
        JSON.stringify({ error: "A valid 4-digit postcode is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const niche = url.searchParams.get("niche") || url.searchParams.get("lead_type");
    if (!niche) {
      return new Response(
        JSON.stringify({ error: "A niche (or lead_type) parameter is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query active PPL clients filtered by niche (same logic as submit-lead).
    // Only clients where niche matches OR active_niches contains the requested niche.
    const { data: clients, error } = await supabase
      .from("clients")
      .select("id, company_name, postcodes, leads_delivered, total_leads_purchased, leads_scrubbed")
      .eq("type", "ppl")
      .eq("stage", "active_client")
      .or(`niche.eq.${niche},active_niches.cs.{${niche}}`);

    if (error) {
      console.error("DB error:", error);
      return new Response(
        JSON.stringify({ error: "Database query failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find the first client that has the exact postcode in their postcodes list
    // and has remaining capacity. Empty postcodes array does NOT mean "covers all".
    const match = (clients ?? []).find((c) => {
      const pcs = c.postcodes as string[] | null;
      if (!Array.isArray(pcs) || pcs.length === 0 || !pcs.includes(postcode)) return false;
      const delivered = (c.leads_delivered as number) || 0;
      const purchased = (c.total_leads_purchased as number) || 0;
      const scrubbed = (c.leads_scrubbed as number) || 0;
      return delivered < purchased + scrubbed;
    });

    if (!match) {
      return new Response(
        JSON.stringify({ buyer_name: null, message: "No installer found for this postcode" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        buyer_name: match.company_name,
        buyer_id: match.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", Connection: "keep-alive" },
      }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
