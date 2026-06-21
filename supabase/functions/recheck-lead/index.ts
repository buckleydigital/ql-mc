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

// Tidy a Facebook-style choice value: "asap_(next_30_days)" → "asap - next 30 days".
function prettifyChoice(v: unknown): string {
  return String(v ?? "")
    .replace(/_/g, " ")
    .replace(/\(/g, " - ")
    .replace(/[)\]\[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Build qualifying details for HQ — structured custom_data + a human-readable
// notes block. Consent is read raw from the stored custom_fields JSON.
function buildHqExtras(lead: Record<string, unknown>): { custom_data: Record<string, string>; notes: string } {
  let consent = typeof lead.consent_text === "string" ? lead.consent_text.trim() : "";
  if (!consent && typeof lead.custom_fields === "string" && lead.custom_fields.trim()) {
    try {
      const parsed = JSON.parse(lead.custom_fields);
      if (parsed && typeof parsed.consent_text === "string") consent = parsed.consent_text.trim();
    } catch { /* not JSON */ }
  }
  const bill = lead.avg_quarterly_bill != null ? String(lead.avg_quarterly_bill).trim() : "";
  const timeline = lead.purchase_timeline != null ? prettifyChoice(lead.purchase_timeline) : "";

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

async function forwardToQuoteLeadsHQ(
  supabaseAdmin: ReturnType<typeof createClient>,
  lead: Record<string, unknown>,
  client: { id: string; company_name: string; hq_bearer_token?: string | null; ql_hq_company_id?: string | null },
): Promise<void> {
  // HQ drops `custom_fields`; it stores `custom_data` (shown on the lead) and
  // `notes` (always visible). Send the qualifying details via both.
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

    const reqBody = await req.json();
    const lead_id = reqBody?.lead_id;
    // Two-step rescue flow:
    //   action "assign"  (default) → match + claim only. Nothing is sent.
    //   action "deliver"           → actually send the already-assigned lead.
    const action = reqBody?.action === "deliver" ? "deliver" : "assign";

    if (!lead_id) {
      return new Response(JSON.stringify({ error: "missing_lead_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the lead — include all fields needed for HQ forwarding + delivery
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("ppl_leads")
      .select("id, postcode, lead_type, status, name, email, phone, source, custom_fields, assigned_client_id, avg_quarterly_bill, purchase_timeline, is_homeowner, interested_in")
      .eq("id", lead_id)
      .single();

    if (leadError || !lead) {
      return new Response(JSON.stringify({ error: "lead_not_found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── DELIVER: send a lead that was already assigned (manual 2nd step) ──────
    // At assign time NOTHING was sent — no email/SMS, no delivered-count bump,
    // no HQ forward. This step performs the real delivery to the assigned
    // client, so a wrong match can be caught before anything leaves the system.
    if (action === "deliver") {
      if (lead.status !== "assigned" || !lead.assigned_client_id) {
        return new Response(
          JSON.stringify({ error: "lead_not_assigned", status: lead.status }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const deliverClientId = lead.assigned_client_id as string;
      const { data: client } = await supabaseAdmin
        .from("clients")
        .select("id, company_name, has_quoteleads_platform_account, hq_bearer_token, ql_hq_company_id")
        .eq("id", deliverClientId)
        .single();

      let delivered = false;
      let deliveryError: string | null = null;
      try {
        const { data: delivRes, error: delivErr } = await supabaseAdmin.functions.invoke(
          "deliver-webhook",
          { body: { lead_id, client_id: deliverClientId } },
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

      if (client && (client.ql_hq_company_id || (client.has_quoteleads_platform_account && client.hq_bearer_token))) {
        try {
          await forwardToQuoteLeadsHQ(
            supabaseAdmin,
            lead,
            client as unknown as { id: string; company_name: string; hq_bearer_token?: string | null; ql_hq_company_id?: string | null },
          );
        } catch (err) {
          console.error("forwardToQuoteLeadsHQ unhandled error:", err instanceof Error ? err.message : String(err));
        }
      }

      return new Response(
        JSON.stringify({ success: true, delivered, client_name: client?.company_name ?? null, delivery_error: deliveryError }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── ASSIGN (default): match + claim. No send, no count, no forward. ───────
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
      // If consent names a known business, ONLY route to that business.
      // Check ALL candidates (not just postcode-filtered) so a named client
      // who doesn't serve this postcode still blocks fill-ratio routing.
      // Any consent text blocks fill-ratio entirely. These are exclusive leads —
      // every form is set up for a specific client. If the consent names a
      // client we have → route to them. If not → pending. Never fall through
      // to fill-ratio when consent text is present.
      const consentText = getConsentText({}, (lead.custom_fields as string | null) ?? null);
      const consentBlocked = !!consentText;
      if (consentText && candidates.length > 0) {
        const allScored = (candidates as Record<string, unknown>[])
          .map((c) => ({ client: c, matched: longestNameInConsent(c, consentText) }))
          .filter((s) => s.matched.length > 0)
          .sort((a, b) => b.matched.length - a.matched.length);

        if (allScored.length > 0) {
          const topLen = allScored[0].matched.length;
          const top = allScored.filter((s) => s.matched.length === topLen);
          if (top.length === 1) {
            const c = top[0].client;
            const pcs = c.postcodes as string[] | null;
            if (Array.isArray(pcs) && pcs.includes(postcode)) {
              matchedClient = {
                id: c.id as string,
                company_name: c.company_name as string,
                has_quoteleads_platform_account: c.has_quoteleads_platform_account as boolean | undefined,
                hq_bearer_token: c.hq_bearer_token as string | null | undefined,
                ql_hq_company_id: c.ql_hq_company_id as string | null | undefined,
              };
            }
            // else: named client doesn't serve this postcode → stays pending
          }
          // else: ambiguous match → stays pending
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

      if (!matchedClient && !consentBlocked && validCandidates.length > 0) {
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

    // ASSIGN ONLY — the lead is now claimed for this client but NOTHING has
    // been sent: no email/SMS, no delivered-count increment, no HQ forward.
    // The operator reviews the match in the table, then clicks Deliver, which
    // calls this same function again with action: "deliver".
    return new Response(
      JSON.stringify({ success: true, matched: true, assigned: true, client_name: matchedClient.company_name }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
