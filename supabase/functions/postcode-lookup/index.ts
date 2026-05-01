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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: clients, error } = await supabase
      .from("clients")
      .select("id, company_name, postcodes")
      .eq("type", "ppl")
      .eq("stage", "active_client");

    if (error) {
      console.error("Query error:", error);
      return new Response(
        JSON.stringify({ error: "Database query failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const match = (clients ?? []).find(
      (c) => !c.postcodes || c.postcodes.length === 0 || c.postcodes.includes(postcode)
    );

    if (!match) {
      return new Response(
        JSON.stringify({ buyer_name: null, message: "No installer found for this postcode" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ buyer_name: match.company_name, buyer_id: match.id }),
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
