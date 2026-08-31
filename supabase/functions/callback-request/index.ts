// Callback requests from the public marketing site → Sales Pipeline.
//
// The branded-solar-lead-system funnel (ql-site) has two buttons on the same
// form: "Buy now" goes to Stripe via create-checkout, and "Request a callback"
// posts here. This function is the callback half — it drops the enquiry
// straight into public.leads as a New Lead so it shows up on the pipeline
// kanban the moment the form is submitted, then emails the internal alert.
//
// No JWT: the caller is an anonymous visitor on a static page (see
// config.toml). Writes go through the service-role key, which also lets the
// auto_assign_lead trigger hand the lead to a rep.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The funnel sells a one-off build ($2,500) plus optional ongoing management.
// `leads.value` is rendered as "$X/mo" throughout the pipeline UI, so it holds
// the recurring figure; the build fee lives in the notes instead.
const BUILD_FEE = 2500;
const MONTHLY_MANAGEMENT = 600;

// The funnel's campaign choices, mapped onto the niche vocabulary ql-mc
// already uses (solar / battery_retrofit / roofing / hvac / renovations).
// The visitor's exact answer is preserved in the notes and custom_data.
const NICHE_MAP: Record<string, { niche: string; label: string }> = {
  solar:            { niche: "solar",            label: "All solar" },
  solar_battery:    { niche: "solar",            label: "Solar + battery" },
  battery_retrofit: { niche: "battery_retrofit", label: "Battery retrofit" },
  commercial_solar: { niche: "solar",            label: "Commercial solar" },
};

function str(v: unknown, max = 300): string {
  return String(v ?? "").trim().slice(0, max);
}

// Australian numbers to E.164, matching submit-lead's normalisation so the
// same business appears with one phone format wherever it lands.
function normalisePhone(raw: string): string | null {
  let p = (raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("0") && p.length === 10) p = "+61" + p.slice(1);
  else if (p.startsWith("614") && p.length === 11) p = "+" + p;
  else if (p.startsWith("61") && !p.startsWith("+") && p.length === 11) p = "+" + p;
  if (/^\+61[2-9][0-9]{8}$/.test(p)) return p;
  return null;
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(v);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));

    const name = str(body.name, 120);
    const company = str(body.company, 160);
    const emailRaw = str(body.email, 160).toLowerCase();
    const phoneRaw = str(body.phone, 40);
    const postcode = str(body.postcode, 80);
    const source = str(body.source, 120) || "branded-solar-lead-system-funnel";
    const nicheKey = str(body.niche, 40);

    const email = isEmail(emailRaw) ? emailRaw : null;
    const phone = normalisePhone(phoneRaw);

    // A callback is useless without a way to call back.
    if (!name || (!email && !phone)) {
      return new Response(
        JSON.stringify({ error: "name and a valid email or Australian phone number are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const campaign = NICHE_MAP[nicheKey] ?? { niche: "solar", label: nicheKey || "not specified" };

    const notes = [
      `Callback requested from the ${source} page.`,
      `Campaign wanted: ${campaign.label}.`,
      postcode ? `Service area: ${postcode}.` : null,
      `Offer: $${BUILD_FEE} one-off build + first 30 days management, then $${MONTHLY_MANAGEMENT}/mo optional.`,
      phone && phone !== phoneRaw ? `Phone as entered: ${phoneRaw}.` : null,
      !email && emailRaw ? `Email as entered (failed validation): ${emailRaw}.` : null,
    ].filter(Boolean).join("\n");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Double-taps on the button, and people who fill the form again a few
    // minutes later, should land on the existing card rather than create a
    // second one for a rep to work twice.
    let existingId: string | null = null;
    let existingNotes: string | null = null;
    const dedupeSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Matched on email and phone separately: PostgREST's .or() takes a filter
    // string, and interpolating user input into one invites parse surprises.
    for (const [col, val] of [["email", email], ["phone", phone]] as const) {
      if (!val || existingId) continue;
      const { data: dupes } = await supabase
        .from("leads")
        .select("id,notes")
        .eq(col, val)
        .not("stage", "in", "(closed_won,closed_lost)")
        .gte("created_at", dedupeSince)
        .order("created_at", { ascending: false })
        .limit(1);
      existingId = dupes?.[0]?.id ?? null;
      existingNotes = dupes?.[0]?.notes ?? null;
    }

    const custom_data = {
      callback_request: {
        page: source,
        campaign_requested: nicheKey || null,
        campaign_label: campaign.label,
        service_area: postcode || null,
        build_fee: BUILD_FEE,
        monthly_management: MONTHLY_MANAGEMENT,
        requested_at: new Date().toISOString(),
      },
    };

    let leadId = existingId;

    if (existingId) {
      // Re-enquiry: refresh the details and re-flag it for a call today,
      // appending rather than overwriting whatever a rep has already written.
      const { error } = await supabase
        .from("leads")
        .update({
          name,
          company: company || null,
          email,
          phone,
          contactable: true,
          next_followup: today(),
          notes: existingNotes ? `${notes}\n\n--- earlier ---\n${existingNotes}` : notes,
          custom_data,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingId);
      if (error) throw error;
    } else {
      const { data, error } = await supabase
        .from("leads")
        .insert({
          name,
          company: company || null,
          email,
          phone,
          stage: "new_lead",
          lead_type: "managed",
          niche: campaign.niche,
          value: MONTHLY_MANAGEMENT,
          source: "inbound",
          notes,
          contactable: true,
          next_followup: today(),
          custom_data,
        })
        .select("id")
        .single();
      if (error) throw error;
      leadId = data.id;
    }

    // Best-effort internal alert. A failed email must not fail the form —
    // the lead is already on the board, which is the part that matters.
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-internal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          type: "callback_request",
          data: {
            name,
            company,
            email: email ?? emailRaw,
            phone: phone ?? phoneRaw,
            service_area: postcode,
            campaign: campaign.label,
            page: source,
            repeat: Boolean(existingId),
          },
        }),
      });
    } catch (_) { /* alert is advisory only */ }

    return new Response(JSON.stringify({ ok: true, lead_id: leadId, duplicate: Boolean(existingId) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("callback-request failed:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
