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

// ── Consent-bound routing helpers (identical to submit-lead) ─────────────────
// Normalise free text for name matching: lowercase, drop punctuation, collapse
// whitespace. Keeps '&' since it's common in trading names.
function normaliseText(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Same, but also strips common legal suffixes so "Yagi Solar Pty Ltd" → "yagi solar".
function normaliseName(n: string): string {
  return normaliseText(n).replace(/\b(pty\s*ltd|pty|ltd|inc|llc|co)\b/g, " ").replace(/\s+/g, " ").trim();
}

// Pull the consent sentence off the lead — either a top-level consent_text field
// or one nested inside the custom_fields JSON. Returns it normalised, or null.
function getConsentText(body: Record<string, unknown>, customFieldsStr: string | null): string | null {
  const direct = body?.consent_text;
  if (typeof direct === "string" && direct.trim()) return normaliseText(direct);
  if (customFieldsStr) {
    try {
      const parsed = JSON.parse(customFieldsStr);
      if (parsed && typeof parsed.consent_text === "string" && (parsed.consent_text as string).trim()) {
        return normaliseText(parsed.consent_text as string);
      }
    } catch { /* custom_fields isn't JSON — ignore */ }
  }
  return null;
}

// Longest of a client's names (company_name / from_name) that appears in the
// consent text, or "" if neither does. Length lets us prefer the most specific
// match when one name is a substring of another.
function longestNameInConsent(client: Record<string, unknown>, consentText: string): string {
  const names = [client.company_name as string, client.from_name as string]
    .map(normaliseName)
    .filter((n) => n.length >= 3);
  let best = "";
  for (const n of names) {
    if (consentText.includes(n) && n.length > best.length) best = n;
  }
  return best;
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
      .select("id, postcodes, weekly_cap, monthly_cap, leads_delivered, total_leads_purchased, company_name, from_name, has_quoteleads_platform_account, hq_bearer_token, delivery_method, ql_hq_company_id")
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

      // ── CONSENT-BOUND ROUTING (mirrors submit-lead) ────────────────────────
      // When the postcode is contested (2+ clients serve it), honour the
      // installer named in the homeowner's stored consent text. Exactly one
      // clean name match wins — even if that client is capped — consistent with
      // the live intake flow. Anything ambiguous falls through to fill-ratio.
      if (postcodeFiltered.length >= 2) {
        const consentText = getConsentText({}, (lead.custom_fields as string | null) ?? null);
        if (consentText) {
          const scored = postcodeFiltered
            .map((c: Record<string, unknown>) => ({ client: c, matched: longestNameInConsent(c, consentText) }))
            .filter((s) => s.matched.length > 0)
            .sort((a, b) => b.matched.length - a.matched.length);
          if (scored.length > 0) {
            const topLen = scored[0].matched.length;
            const top = scored.filter((s) => s.matched.length === topLen);
            if (top.length === 1) {
              const c = top[0].client;
              matchedClient = {
                id: c.id as string,
                company_name: c.company_name as string,
                has_quoteleads_platform_account: c.has_quoteleads_platform_account as boolean | undefined,
                hq_bearer_token: c.hq_bearer_token as string | null | undefined,
                ql_hq_company_id: c.ql_hq_company_id as string | null | undefined,
              };
            }
          }
        }
      }

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

      if (!matchedClient && validCandidates.length > 0) {
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

    // Deliver (email/SMS/webhook). AWAIT it — a fire-and-forget invoke gets
    // killed the moment this function returns, which left leads stuck on
    // "assigned" and never actually delivered. Awaiting guarantees the send
    // runs to completion and deliver-webhook flips the lead to "delivered".
    let delivered = false;
    let deliveryError: string | null = null;
    try {
      const { data: delivRes, error: delivErr } = await supabaseAdmin.functions.invoke(
        "deliver-webhook",
        { body: { lead_id, client_id: matchedClient.id } },
      );
      if (delivErr) {
        deliveryError = delivErr.message;
      } else if (delivRes && (delivRes as { success?: boolean }).success === false) {
        deliveryError = "delivery failed — check the client's delivery settings";
      } else {
        delivered = true;
      }
    } catch (err) {
      deliveryError = err instanceof Error ? err.message : String(err);
    }
    if (deliveryError) console.error("deliver-webhook failed:", deliveryError);

    // Forward to QuoteLeads HQ platform if the client is linked. Await so it
    // actually completes before the function returns.
    if (matchedClient.ql_hq_company_id || (matchedClient.has_quoteleads_platform_account && matchedClient.hq_bearer_token)) {
      try {
        await forwardToQuoteLeadsHQ(supabaseAdmin, lead, matchedClient);
      } catch (err) {
        console.error("forwardToQuoteLeadsHQ unhandled error:", err instanceof Error ? err.message : String(err));
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        matched: true,
        client_name: matchedClient.company_name,
        delivered,
        delivery_error: deliveryError,
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
