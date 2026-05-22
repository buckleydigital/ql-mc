import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Validate shared secret
  const apiSecret = Deno.env.get("QL_MC_API_SECRET");
  const provided = req.headers.get("x-api-secret");
  if (!apiSecret || !provided || provided !== apiSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const body = await req.json();
    const { ql_hq_company_id, company_name, email, sms_number, webhook_url } = body;

    if (!ql_hq_company_id || typeof ql_hq_company_id !== "string" || !ql_hq_company_id.trim()) {
      return json({ error: "ql_hq_company_id is required" }, 400);
    }
    if (!company_name || typeof company_name !== "string" || !company_name.trim()) {
      return json({ error: "company_name is required" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await supabaseAdmin
      .from("delivery_configs")
      .upsert(
        {
          ql_hq_company_id: ql_hq_company_id.trim(),
          company_name: company_name.trim(),
          email: email ?? null,
          sms_number: sms_number ?? null,
          webhook_url: webhook_url ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "ql_hq_company_id" },
      );

    if (error) throw error;

    return json({ ok: true });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
