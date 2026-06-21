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
  // Normalise to E.164 (+61XXXXXXXXX)
  if (p.startsWith("0") && p.length === 10) p = "+61" + p.slice(1);
  else if (p.startsWith("614") && p.length === 11) p = "+" + p;
  else if (p.startsWith("61") && !p.startsWith("+") && p.length === 11) p = "+" + p;
  // Accept any valid Australian number (mobile +614x or landline +612/3/7/8x, 11 chars)
  if (/^\+61[2-9][0-9]{8}$/.test(p)) return p;
  return null;
}

// ── Consent-bound routing helpers ────────────────────────────────────────────
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

// Tidy a Facebook-style choice value for display: "asap_(next_30_days)" →
// "asap - next 30 days", "3–6_months" → "3–6 months". Underscores → spaces,
// "(" → " - ", other brackets removed, whitespace collapsed. (Idempotent.)
function prettifyChoice(v: unknown): string {
  return String(v ?? "")
    .replace(/_/g, " ")
    .replace(/\(/g, " - ")
    .replace(/[)\]\[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The average-quarterly-bill answer, as free text, no matter the format ("$300–$600",
// "$1,000+", "More than $600") or the exact key Make posts it under. Prefers the
// named field, then falls back to any body key that looks like a power-bill field.
function pickBillText(body: Record<string, unknown>): string | null {
  const named = body?.avg_quarterly_bill;
  if (named != null && String(named).trim()) return String(named).trim();
  for (const [k, v] of Object.entries(body)) {
    if (/(quarter|power|electric|energy).*bill|^bill$|bill.*amount/i.test(k) && v != null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return null;
}

// Build the qualifying details we forward to QuoteLeadsHQ — as structured
// custom_data AND a human-readable notes block (which is always visible on the
// HQ lead, regardless of a company's custom-field setup). Consent is read from
// an explicit field or the stored custom_fields JSON, raw (never normalised).
function buildHqExtras(lead: Record<string, unknown>): { custom_data: Record<string, string>; notes: string } {
  let consent = typeof lead.consent_text === "string" ? lead.consent_text.trim() : "";
  if (!consent && typeof lead.custom_fields === "string" && lead.custom_fields.trim()) {
    try {
      const parsed = JSON.parse(lead.custom_fields);
      if (parsed && typeof parsed.consent_text === "string") consent = parsed.consent_text.trim();
    } catch { /* custom_fields isn't JSON — ignore */ }
  }
  const bill = lead.avg_quarterly_bill != null ? String(lead.avg_quarterly_bill).trim() : "";
  const timeline = lead.purchase_timeline != null ? String(lead.purchase_timeline).trim() : "";

  const cd: Record<string, string> = {};
  const lines: string[] = [];
  if (bill)     { cd["Avg Quarterly Bill"] = bill;     lines.push(`Avg Quarterly Bill: ${bill}`); }
  if (timeline) { cd["Purchase Timeline"]  = timeline; lines.push(`Purchase Timeline: ${timeline}`); }
  if (typeof lead.interested_in === "string" && lead.interested_in.trim()) {
    cd["Interested In"] = lead.interested_in.trim(); lines.push(`Interested In: ${lead.interested_in.trim()}`);
  }
  if (lead.is_homeowner === true) { cd["Homeowner"] = "Yes"; lines.push("Homeowner: Yes"); }
  else if (lead.is_homeowner === false) { cd["Homeowner"] = "No"; lines.push("Homeowner: No"); }
  if (consent)  { cd["Consent"] = consent;             lines.push(`Consent: ${consent}`); }

  return { custom_data: cd, notes: lines.join("\n") };
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
    // Tidy the timeline choice ("asap_(next_30_days)" → "asap - next 30 days")
    // once, so the stored value and every delivery downstream are clean.
    if (purchase_timeline) purchase_timeline = prettifyChoice(purchase_timeline);

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

    // STEP 3 — DEDUPLICATE (within the same lead_type only — cross-niche dedup
    // would incorrectly block e.g. an aircon lead from a phone already used for solar)
    let dedupQuery = supabaseAdmin
      .from("ppl_leads")
      .select("id, consent_text, custom_fields")
      .eq("lead_type", lead_type)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    if (email) {
      dedupQuery = dedupQuery.or(`phone.eq.${normalisedPhone},email.eq.${email}`);
    } else {
      dedupQuery = dedupQuery.eq("phone", normalisedPhone);
    }

    const { data: dupes } = await dedupQuery;
    if (dupes && dupes.length > 0) {
      // If the consent_text differs (different advertiser/business name), the same person
      // filling out another form is a new exclusive lead — allow it through.
      const incomingConsent = getConsentText(body, custom_fields);
      const trueDedup = dupes.some((d) => {
        const existingConsent = getConsentText(
          d as Record<string, unknown>,
          typeof d.custom_fields === "string" ? d.custom_fields : null,
        );
        if (!incomingConsent && !existingConsent) return true;
        return !!incomingConsent && !!existingConsent && incomingConsent === existingConsent;
      });
      if (trueDedup) {
        return new Response(JSON.stringify({ status: "duplicate", lead_id: dupes[0].id }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
      .select("id, postcodes, weekly_cap, monthly_cap, leads_delivered, total_leads_purchased, company_name, from_name, has_quoteleads_platform_account, hq_bearer_token, delivery_method, ql_hq_company_id")
      .eq("type", "ppl")
      .eq("stage", "active_client")
      .or(`niche.eq.${lead_type},active_niches.cs.{${lead_type}}`);

    let matchedClient: { id: string; company_name: string; has_quoteleads_platform_account?: boolean; hq_bearer_token?: string | null; ql_hq_company_id?: string | null } | null = null;

    if (candidates && candidates.length > 0) {
      // Filter by postcode match
      const postcodeFiltered = candidates.filter((c: Record<string, unknown>) => {
        const pcs = c.postcodes as string[] | null;
        if (!pcs || !Array.isArray(pcs) || pcs.length === 0) return false;
        return pcs.includes(postcode);
      });

      // ── CONSENT-BOUND ROUTING ──────────────────────────────────────────────
      // Only when the postcode is contested (2+ clients serve it) do we honour
      // the installer named in the homeowner's consent text. A match needs the
      // company name to appear in the consent AND the client to serve this
      // postcode — and postcodeFiltered already guarantees the postcode, so a
      // same-named company in another area can never be picked here. If exactly
      // one client matches we route to them, even if they're capped or out of
      // pack (consent wins, per business rule). Anything ambiguous — no name
      // found, or two same-named clients on this same postcode — falls through
      // to the normal fill-ratio routing below, completely unchanged.
      if (postcodeFiltered.length >= 2) {
        const consentText = getConsentText(body, custom_fields);
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

      // Fill-ratio routing — runs only if consent didn't already pick a client
      if (!matchedClient) {
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
            ql_hq_company_id: best.ql_hq_company_id as string | null | undefined,
          };
        }
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
      // Stored verbatim as text — never parseFloat'd — so "$300–$600"/"$1,000+" survive.
      avg_quarterly_bill: pickBillText(body),
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

      // Forward to QuoteLeads HQ if the client has a ql_hq_company_id or a platform bearer token
      if (matchedClient.ql_hq_company_id || (matchedClient.has_quoteleads_platform_account && matchedClient.hq_bearer_token)) {
        forwardToQuoteLeadsHQ(
          {
            id: inserted.id, name, email, phone: normalisedPhone, postcode, lead_type, source, custom_fields,
            avg_quarterly_bill: pickBillText(body), purchase_timeline: purchase_timeline || null,
            is_homeowner: is_homeowner != null ? is_homeowner : null, interested_in: interested_in || null,
          },
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
  client: { id: string; company_name: string; hq_bearer_token?: string | null | undefined; ql_hq_company_id?: string | null | undefined },
): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // HQ's intake drops `custom_fields`; it accepts `custom_data` (jsonb, shown on
  // the lead) and `notes` (always visible). Send the qualifying details via both.
  const extras = buildHqExtras(lead);
  const hqPayload: Record<string, unknown> = {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    postcode: lead.postcode,
    lead_type: lead.lead_type,
    source: lead.source,
    custom_data: extras.custom_data,
    notes: extras.notes || undefined,
    company_id: client.ql_hq_company_id ?? null,
  };

  let status: "delivered" | "failed" = "failed";
  let responseCode: number | null = null;
  let responseBody = "";

  try {
    const authToken = client.hq_bearer_token || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetchWithRetry(
      "https://api.quoteleadshq.com/v1/leads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
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
