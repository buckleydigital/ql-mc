import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function getWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

function getMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 2,
  delayMs = 500,
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs * attempt));
    const res = await fetch(url, options);
    if (res.ok) return res;
    lastRes = res;
  }
  if (!lastRes) throw new Error("fetchWithRetry: no response obtained");
  return lastRes;
}

async function forwardToQuoteLeadsHQ(
  supabaseAdmin: ReturnType<typeof createClient>,
  lead: Record<string, unknown>,
  client: { id: string; company_name: string; hq_bearer_token?: string | null; ql_hq_company_id?: string | null },
): Promise<void> {
  const hqPayload: Record<string, unknown> = {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    postcode: lead.postcode,
    lead_type: lead.lead_type,
    source: lead.source,
    custom_fields: lead.custom_fields,
    company_id: client.ql_hq_company_id ?? null,
  };

  let status: "delivered" | "failed" = "failed";
  let responseCode: number | null = null;
  let responseBody = "";

  try {
    const authToken = client.hq_bearer_token || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetchWithRetry("https://api.quoteleadshq.com/v1/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
      body: JSON.stringify(hqPayload),
    });
    responseCode = res.status;
    responseBody = (await res.text().catch((e: Error) => e.message)).slice(0, 500);
    status = res.ok ? "delivered" : "failed";
  } catch (err) {
    responseBody = err instanceof Error ? err.message : String(err);
  }

  const { error: logError } = await supabaseAdmin.from("lead_delivery_log").insert([{
    lead_id: lead.id,
    client_id: client.id,
    method: "quoteleads_hq",
    destination: "api.quoteleadshq.com",
    status,
    response_code: responseCode,
    response_body: responseBody,
    delivered_at: status === "delivered" ? new Date().toISOString() : null,
  }]);
  if (logError) {
    console.error(`forwardToQuoteLeadsHQ: failed to write delivery log for lead_id=${lead.id}:`, logError.message);
  }
  if (status === "failed") {
    console.error(`forwardToQuoteLeadsHQ failed: lead_id=${lead.id} client_id=${client.id} response_body=${responseBody}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { lead_id } = await req.json();

    if (!lead_id) {
      return new Response(JSON.stringify({ error: "missing_lead_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the lead — include all fields needed for HQ forwarding
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("ppl_leads")
      .select("id, postcode, lead_type, status, name, email, phone, source, custom_fields")
      .eq("id", lead_id)
      .single();

    if (leadError || !lead) {
      return new Response(JSON.stringify({ error: "lead_not_found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (lead.status !== "pending") {
      return new Response(
        JSON.stringify({ error: "lead_not_pending", status: lead.status }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { postcode, lead_type } = lead;

    // Run client matching — same algorithm as submit-lead
    const { data: candidates } = await supabaseAdmin
      .from("clients")
      .select("id, postcodes, weekly_cap, monthly_cap, leads_delivered, total_leads_purchased, company_name, has_quoteleads_platform_account, hq_bearer_token, delivery_method, ql_hq_company_id")
      .eq("type", "ppl")
      .eq("stage", "active_client")
      .or(`niche.eq.${lead_type},active_niches.cs.{${lead_type}}`);

    let matchedClient: {
      id: string;
      company_name: string;
      has_quoteleads_platform_account?: boolean;
      hq_bearer_token?: string | null;
      ql_hq_company_id?: string | null;
    } | null = null;

    if (candidates && candidates.length > 0) {
      const postcodeFiltered = candidates.filter((c: Record<string, unknown>) => {
        const pcs = c.postcodes as string[] | null;
        if (!pcs || !Array.isArray(pcs) || pcs.length === 0) return false;
        return pcs.includes(postcode);
      });

      const validCandidates: Array<{
        client: Record<string, unknown>;
        ratio: number;
        exactMatch: boolean;
      }> = [];

      const weekStart = getWeekStart();
      const monthStart = getMonthStart();

      for (const client of postcodeFiltered) {
        const clientId = client.id as string;
        const leadsDelivered = (client.leads_delivered as number) || 0;
        const totalPurchased = (client.total_leads_purchased as number) || 0;

        if (totalPurchased - leadsDelivered <= 0) continue;

        const { count: weeklyDelivered } = await supabaseAdmin
          .from("ppl_leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_client_id", clientId)
          .eq("status", "delivered")
          .gte("created_at", weekStart);

        const weeklyCap = client.weekly_cap as number | null;
        if (weeklyCap != null && (weeklyDelivered || 0) >= weeklyCap) continue;

        const { count: monthlyDelivered } = await supabaseAdmin
          .from("ppl_leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_client_id", clientId)
          .eq("status", "delivered")
          .gte("created_at", monthStart);

        const monthlyCap = client.monthly_cap as number | null;
        if (monthlyCap != null && (monthlyDelivered || 0) >= monthlyCap) continue;

        const pcs = client.postcodes as string[] | null;
        const exactMatch = Array.isArray(pcs) && pcs.length > 0 && pcs.includes(postcode);
        const ratio = totalPurchased > 0 ? leadsDelivered / totalPurchased : 0;

        validCandidates.push({ client, ratio, exactMatch });
      }

      validCandidates.sort((a, b) => {
        if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
        return a.ratio - b.ratio;
      });

      if (validCandidates.length > 0) {
        const best = validCandidates[0].client;
        matchedClient = {
          id: best.id as string,
          company_name: best.company_name as string,
          has_quoteleads_platform_account: best.has_quoteleads_platform_account as boolean | undefined,
          hq_bearer_token: best.hq_bearer_token as string | null | undefined,
          ql_hq_company_id: best.ql_hq_company_id as string | null | undefined,
        };
      }
    }

    if (!matchedClient) {
      return new Response(
        JSON.stringify({ success: true, matched: false, message: "No matching client found for this postcode/niche" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update lead to assigned — only if still pending (guard against races)
    const { error: updateError } = await supabaseAdmin
      .from("ppl_leads")
      .update({
        status: "assigned",
        assigned_client_id: matchedClient.id,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id)
      .eq("status", "pending");

    if (updateError) throw new Error(updateError.message);

    // Fire deliver-webhook (email/SMS/webhook channels)
    supabaseAdmin.functions.invoke("deliver-webhook", {
      body: { lead_id, client_id: matchedClient.id },
    }).catch((err: Error) => {
      console.error("deliver-webhook invocation failed:", err.message);
    });

    // Forward to QuoteLeads HQ platform if the client is linked
    if (matchedClient.ql_hq_company_id || (matchedClient.has_quoteleads_platform_account && matchedClient.hq_bearer_token)) {
      forwardToQuoteLeadsHQ(supabaseAdmin, lead, matchedClient).catch((err: Error) => {
        console.error("forwardToQuoteLeadsHQ unhandled error:", err.message);
      });
    }

    return new Response(
      JSON.stringify({ success: true, matched: true, client_name: matchedClient.company_name }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
