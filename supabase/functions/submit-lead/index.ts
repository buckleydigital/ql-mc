import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NAMED_FIELDS = new Set([
  "name", "first_name", "last_name", "email", "phone", "postcode",
  "niche", "subtype", "lead_type", "source",
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
      niche, subtype, lead_type, source,
      is_homeowner, avg_quarterly_bill, interested_in, purchase_timeline,
    } = body;

    if (!name && (first_name || last_name)) {
      name = [first_name, last_name].filter(Boolean).join(" ");
    }
    if (lead_type && !niche) niche = lead_type;
    if (!niche) niche = "solar";
    if (!source) source = "webhook";

    const custom_data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!NAMED_FIELDS.has(k) && k !== "custom_data") {
        custom_data[k] = v;
      }
    }
    // If the caller sent custom_data as an object, merge it in
    if (body.custom_data && typeof body.custom_data === "object" && !Array.isArray(body.custom_data)) {
      Object.assign(custom_data, body.custom_data);
    } else if (body.custom_data && typeof body.custom_data === "string" && body.custom_data.trim()) {
      custom_data["_text"] = body.custom_data;
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

    if (email && typeof email === "string" && email.trim()) {
      email = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ error: "invalid_email" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      email = null;
    }

    // Supabase admin client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // STEP 3 — DEDUPLICATE
    let dedupQuery = supabaseAdmin
      .from("leads")
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
      .select("id, postcodes, weekly_cap, monthly_cap, leads_delivered, total_leads_purchased, company_name, from_name")
      .eq("type", "ppl")
      .eq("stage", "active_client")
      .or(`niche.eq.${niche},active_niches.cs.{${niche}}`);

    let matchedClient: { id: string; company_name: string } | null = null;

    if (candidates && candidates.length > 0) {
      // Filter by postcode match
      const postcodeFiltered = candidates.filter((c: Record<string, unknown>) => {
        const pcs = c.postcodes as string[] | null;
        if (!pcs || !Array.isArray(pcs) || pcs.length === 0) return true;
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
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("assigned_client_id", clientId)
          .eq("status", "delivered")
          .gte("created_at", weekStart);

        const weeklyCap = client.weekly_cap as number | null;
        if (weeklyCap != null && (weeklyDelivered || 0) >= weeklyCap) continue;

        // Count monthly delivered
        const { count: monthlyDelivered } = await supabaseAdmin
          .from("leads")
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
        matchedClient = { id: best.id as string, company_name: best.company_name as string };
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
      niche,
      subtype: subtype || null,
      source,
      custom_data,
      is_homeowner: is_homeowner != null ? is_homeowner : null,
      avg_quarterly_bill: avg_quarterly_bill != null ? parseFloat(avg_quarterly_bill) || null : null,
      interested_in: interested_in || null,
      purchase_timeline: purchase_timeline || null,
      assigned_client_id: matchedClient ? matchedClient.id : null,
      status: matchedClient ? "assigned" : "pending",
      assigned_at: matchedClient ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    };

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("leads")
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
