import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Mirror the same matching logic as the assign_and_deliver_lead RPC:
    // - type = 'ppl', stage = 'active_client'
    // - has remaining capacity (leads_delivered < total_leads_purchased + scrubbed)
    // - postcode matches
    // - weekly/monthly caps not exceeded
    // - ordered by least-recently-served (last_lead_delivered_at ASC NULLS FIRST)
    const { data, error } = await supabase.rpc("preview_postcode_match", {
      p_postcode: postcode,
    });

    if (error) {
      console.error("RPC error:", error);
      return new Response(
        JSON.stringify({ error: "Database query failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!data || !data.buyer_name) {
      return new Response(
        JSON.stringify({ buyer_name: null, message: "No installer found for this postcode" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        buyer_name: data.buyer_name,
        buyer_id: data.buyer_id,
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
