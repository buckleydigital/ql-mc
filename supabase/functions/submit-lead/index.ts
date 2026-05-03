import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NAMED_FIELDS = new Set([
  "name", "first_name", "last_name", "email", "phone", "postcode",
  "lead_type", "niche", "source",
  "is_homeowner", "avg_quarterly_bill", "interested_in", "purchase_timeline",
]);

function normalisePhone(raw: string): string | null {
  let p = (raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("04")) p = "+61" + p.slice(1);
  else if (p.startsWith("614")) p = "+" + p;
  else if (p.startsWith("61") && !p.startsWith("+")) p = "+" + p;
  if (/^\+614[0-9]{8}$/.test(p)) return p;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // STEP 1 — PARSE
    let {
      name, first_name, last_name, email, phone, postcode,
      lead_type, niche, source,
      is_homeowner, avg_quarterly_bill, interested_in, purchase_timeline,
    } = body;

    if (!name && (first_name || last_name)) {
      name = [first_name, last_name].filter(Boolean).join(" ");
    }
    // Accept either lead_type or niche from the caller
    if (!lead_type && niche) lead_type = niche;
    if (!lead_type) {
      return new Response(JSON.stringify({ error: "missing_lead_type" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!source) source = "webhook";

    // Collect any extra fields into custom_fields (stored as JSON text)
    const extraFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!NAMED_FIELDS.has(k) && k !== "custom_fields") {
        extraFields[k] = v;
      }
    }
    // If the caller sent custom_fields as a string, use it directly; otherwise stringify extras
    let custom_fields: string | null = null;
    if (body.custom_fields && typeof body.custom_fields === "string" && body.custom_fields.trim()) {
      custom_fields = body.custom_fields.trim();
    } else if (Object.keys(extraFields).length > 0) {
      custom_fields = JSON.stringify(extraFields);
    }

    // STEP 2 — VALIDATE
    if (!name || typeof name !== "string" || !name.trim()) {
      return new Response(JSON.stringify({ error: "missing_name" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    name = name.trim();

    const normalisedPhone = normalisePhone(phone);
    if (!normalisedPhone) {
      return new Response(JSON.stringify({ error: "invalid_phone" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    postcode = (postcode || "").toString().replace(/\s/g, "");
    if (!/^[0-9]{4}$/.test(postcode)) {
      return new Response(JSON.stringify({ error: "invalid_postcode" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!email || typeof email !== "string" || !email.trim()) {
      return new Response(JSON.stringify({ error: "missing_email" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    email = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "invalid_email" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Supabase admin client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // STEP 3 — DEDUPLICATE
    let dedupQuery = supabaseAdmin
      .from("ppl_leads")
      .select("id")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (email) {
      dedupQuery = dedupQuery.or(`phone.eq.${normalisedPhone},email.eq.${email}`);
    } else {
      dedupQuery = dedupQuery.eq("phone", normalisedPhone);
    }

    const { data: dupes } = await dedupQuery;
    if (dupes && dupes.length > 0) {
      return new Response(JSON.stringify({ status: "duplicate", lead_id: dupes[0].id }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 4 — POSTCODE ENRICHMENT
    let suburb: string | null = null;
    let state: string | null = null;
    try {
      const pcRes = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/postcode-lookup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ postcode }),
          signal: AbortSignal.timeout(3000),
        },
      );
      if (pcRes.ok) {
        const pcData = await pcRes.json();
        suburb = pcData.suburb || null;
        state = pcData.state || null;
      }
    } catch {
      // Continue without enrichment
    }

    // STEP 5 — CLIENT MATCHING
    const { data: candidates } = await supabaseAdmin
      .from("clients")
      .select("id, postcodes, weekly_cap, monthly_cap, leads_delivered, total_leads_purchased, company_name, from_name, has_quoteleads_platform_account, hq_bearer_token, delivery_method")
      .eq("type", "ppl")
      .eq("stage", "active_client")
      .or(`niche.eq.${lead_type},active_niches.cs.{${lead_type}}`);

    let matchedClient: { id: string; company_name: string; has_quoteleads_platform_account?: boolean; hq_bearer_token?: string | null } | null = null;

    if (candidates && candidates.length > 0) {
      // Filter by postcode match
      const postcodeFiltered = candidates.filter((c: Record<string, unknown>) => {
        const pcs = c.postcodes as string[] | null;
        if (!pcs || !Array.isArray(pcs) || pcs.length === 0) return false;
        return pcs.includes(postcode);
      });

      // Check caps for each candidate
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
        const leadsRemaining = totalPurchased - leadsDelivered;

        if (leadsRemaining <= 0) continue;

        // Count weekly delivered
        const { count: weeklyDelivered } = await supabaseAdmin
          .from("ppl_leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_client_id", clientId)
          .eq("status", "delivered")
          .gte("created_at", weekStart);

        const weeklyCap = client.weekly_cap as number | null;
        if (weeklyCap != null && (weeklyDelivered || 0) >= weeklyCap) continue;

        // Count monthly delivered
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

      // Sort: exact postcode match first, then lowest ratio
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
        };
      }
    }

    // STEP 6 — INSERT LEAD
    const leadRecord: Record<string, unknown> = {
      name,
      email,
      phone: normalisedPhone,
      postcode,
      suburb,
      state,
      lead_type,
      source,
      custom_fields,
      is_homeowner: is_homeowner != null ? is_homeowner : null,
      avg_quarterly_bill: avg_quarterly_bill != null ? parseFloat(avg_quarterly_bill) || null : null,
      interested_in: interested_in || null,
      purchase_timeline: purchase_timeline || null,
      assigned_client_id: matchedClient ? matchedClient.id : null,
      status: matchedClient ? "assigned" : "pending",
      assigned_at: matchedClient ? new Date().toISOString() : null,
      delivery_method: matchedClient ? (matchedClient as Record<string, unknown>).delivery_method as string || null : null,
      created_at: new Date().toISOString(),
    };

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("ppl_leads")
      .insert([leadRecord])
      .select("id")
      .single();

    if (insertError || !inserted) {
      throw new Error(insertError?.message || "Failed to insert lead");
    }

    // Fire-and-forget delivery — log but don't block
    if (matchedClient) {
      supabaseAdmin.functions.invoke("deliver-webhook", {
        body: { lead_id: inserted.id, client_id: matchedClient.id },
      }).catch((err: Error) => {
        console.error("deliver-webhook invocation failed:", err.message);
      });

      // Forward to QuoteLeads HQ if the client has a platform account and bearer token
      if (matchedClient.has_quoteleads_platform_account && matchedClient.hq_bearer_token) {
        forwardToQuoteLeadsHQ(
          { id: inserted.id, name, email, phone: normalisedPhone, postcode, lead_type, source, custom_fields },
          matchedClient,
        ).catch((err: Error) => {
          console.error("forwardToQuoteLeadsHQ unhandled error:", err.message);
        });
      }
    }

    // STEP 8 — RETURN
    return new Response(
      JSON.stringify({
        success: true,
        lead_id: inserted.id,
        status: matchedClient ? "assigned" : "pending",
        matched_client: matchedClient ? matchedClient.id : null,
        suburb,
        state,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 2,
  delayMs = 500,
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
    const res = await fetch(url, options); // throws on network error
    if (res.ok) return res;
    lastRes = res;
  }
  if (!lastRes) throw new Error("fetchWithRetry: no response obtained");
  return lastRes;
}

async function forwardToQuoteLeadsHQ(
  lead: Record<string, unknown>,
  client: { id: string; company_name: string; hq_bearer_token: string | null | undefined },
): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const hqPayload: Record<string, unknown> = {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    postcode: lead.postcode,
    lead_type: lead.lead_type,
    source: lead.source,
    custom_fields: lead.custom_fields,
  };

  let status: "delivered" | "failed" = "failed";
  let responseCode: number | null = null;
  let responseBody = "";

  try {
    const res = await fetchWithRetry(
      "https://api.quoteleadshq.com/v1/leads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${client.hq_bearer_token}`,
        },
        body: JSON.stringify(hqPayload),
      },
    );
    responseCode = res.status;
    responseBody = await res.text().catch((e: Error) => e.message);
    responseBody = responseBody.slice(0, 500);
    status = res.ok ? "delivered" : "failed";
  } catch (err) {
    responseBody = err instanceof Error ? err.message : String(err);
  }

  const { error: logError } = await supabase.from("lead_delivery_log").insert([{
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

function getWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

function getMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
