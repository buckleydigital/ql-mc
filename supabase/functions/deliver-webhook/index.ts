import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function formatAEST(date: Date): string {
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " AEST";
}

function titleCase(str: string): string {
  return str.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildLocationString(lead: Record<string, unknown>): string {
  return `${lead.postcode}${lead.suburb ? " " + lead.suburb : ""}${lead.state ? " " + lead.state : ""}`;
}

/** Strip control characters and trim whitespace to keep SMS fields safe. */
function sanitizeSmsField(value: unknown): string {
  return String(value ?? "").replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

// Tidy a Facebook-style choice value for display: "asap_(next_30_days)" →
// "asap - next 30 days", "3–6_months" → "3–6 months".
function prettifyChoice(v: unknown): string {
  return String(v ?? "")
    .replace(/_/g, " ")
    .replace(/\(/g, " - ")
    .replace(/[)\]\[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse the stored custom_fields JSON into clean [label, value] pairs for
// delivery. NEVER emits raw JSON or braces. Falls back to plain text if not JSON.
function parseCustomFields(cf: unknown): Array<[string, string]> {
  const raw = typeof cf === "string" ? cf.trim() : "";
  if (!raw) return [];
  const labelise = (k: string) =>
    k === "consent_text" ? "Consent" : k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .filter(([, v]) => v != null && String(v).trim() !== "")
        .map(([k, v]) => [labelise(k), String(v).trim()] as [string, string]);
    }
  } catch { /* not JSON */ }
  const cleaned = raw.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? [["Notes", cleaned]] : [];
}

function buildEmailHtml(lead: Record<string, unknown>, _client: Record<string, unknown>): string {
  const now = formatAEST(new Date());
  const typeStr = lead.lead_type as string || "—";

  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#666666;font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 12px;color:#111111;font-weight:600;font-size:13px">${value}</td></tr>`;

  let rows = "";
  rows += row("Name", esc(lead.name as string));
  rows += row("Phone", `<a href="tel:${lead.phone}" style="color:#2563eb">${esc(lead.phone as string)}</a>`);
  rows += row("Email", lead.email
    ? `<a href="mailto:${lead.email}" style="color:#2563eb">${esc(lead.email as string)}</a>`
    : "—");
  rows += row("Postcode", esc(lead.postcode as string || "—"));
  rows += row("Type", esc(typeStr));
  rows += row("Source", esc(lead.source as string || "webhook"));
  if (lead.is_homeowner === true) rows += row("Homeowner", "Yes");
  else if (lead.is_homeowner === false) rows += row("Homeowner", "No");

  if (lead.avg_quarterly_bill != null && String(lead.avg_quarterly_bill).trim() !== "") rows += row("Quarterly Bill", esc(String(lead.avg_quarterly_bill)));
  if (lead.interested_in) rows += row("Interested In", esc(lead.interested_in as string));
  if (lead.purchase_timeline) rows += row("Timeline", esc(prettifyChoice(lead.purchase_timeline)));

  // Qualifying / consent details — clean labelled rows, never raw JSON.
  let customSection = "";
  const cfPairs = parseCustomFields(lead.custom_fields);
  if (cfPairs.length) {
    customSection = `<tr><td colspan="2" style="padding:14px 12px 6px;font-size:10px;color:#666666;text-transform:uppercase;letter-spacing:.1em;font-variant:small-caps">Details</td></tr>`;
    for (const [label, value] of cfPairs) customSection += row(label, esc(value));
  }

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#ffffff">
  <div style="background:#ffffff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e5e5">
    <span style="color:#111111;font-weight:700;font-size:14px">QuoteLeads · New Lead</span>
    <span style="color:#666666;font-size:12px">${esc(now)}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#ffffff">${rows}${customSection}</table>
  <div style="padding:16px 12px;font-size:11px;color:#999999">Delivered by QuoteLeads · ${esc(lead.id as string)}</div>
</div></body></html>`;
}

function buildEmailPreview(lead: Record<string, unknown>, subject: string): string {
  const lines: string[] = [`Subject: ${subject}`];
  lines.push(`Name: ${lead.name ?? "—"}`);
  lines.push(`Phone: ${lead.phone ?? "—"}`);
  if (lead.email) lines.push(`Email: ${lead.email}`);
  lines.push(`Postcode: ${lead.postcode ?? "—"}`);
  if (lead.suburb) lines.push(`Suburb: ${lead.suburb}`);
  if (lead.state) lines.push(`State: ${lead.state}`);
  if (lead.lead_type) lines.push(`Type: ${lead.lead_type}`);
  if (lead.source) lines.push(`Source: ${lead.source}`);
  if (lead.is_homeowner != null) lines.push(`Homeowner: ${lead.is_homeowner ? "Yes" : "No"}`);
  if (lead.avg_quarterly_bill != null && String(lead.avg_quarterly_bill).trim() !== "") lines.push(`Quarterly Bill: ${lead.avg_quarterly_bill}`);
  if (lead.interested_in) lines.push(`Interested In: ${lead.interested_in}`);
  if (lead.purchase_timeline) lines.push(`Timeline: ${prettifyChoice(lead.purchase_timeline)}`);
  for (const [label, value] of parseCustomFields(lead.custom_fields)) lines.push(`${label}: ${value}`);
  return lines.join("\n");
}

function buildSmsBody(lead: Record<string, unknown>): string {
  const lines: string[] = ["QL: New Lead"];
  lines.push(`Name: ${sanitizeSmsField(lead.name)}`);
  lines.push(`Phone: ${sanitizeSmsField(lead.phone)}`);
  if (lead.email) lines.push(`Email: ${sanitizeSmsField(lead.email)}`);
  lines.push(`Postcode: ${sanitizeSmsField(lead.postcode)}`);
  if (lead.lead_type) lines.push(`Type: ${sanitizeSmsField(lead.lead_type)}`);
  if (lead.source) lines.push(`Source: ${sanitizeSmsField(lead.source)}`);
  if (lead.is_homeowner != null) lines.push(`Homeowner: ${lead.is_homeowner ? "Yes" : "No"}`);
  if (lead.avg_quarterly_bill != null && String(lead.avg_quarterly_bill).trim() !== "") lines.push(`Quarterly Bill: ${sanitizeSmsField(lead.avg_quarterly_bill)}`);
  if (lead.interested_in) lines.push(`Interested In: ${sanitizeSmsField(lead.interested_in)}`);
  if (lead.purchase_timeline) lines.push(`Timeline: ${sanitizeSmsField(prettifyChoice(lead.purchase_timeline))}`);

  return lines.join("\n");
}

async function deliverEmail(
  supabase: ReturnType<typeof createClient>,
  lead: Record<string, unknown>,
  client: Record<string, unknown>,
  subject: string,
  htmlBody: string,
  emailPreview: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const fromName = (client.from_name as string) || "QuoteLeads";
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL")!;
  const toEmail = client.delivery_email as string;

  const payload: Record<string, unknown> = {
    from: `${fromName} <${fromEmail}>`,
    to: [toEmail],
    reply_to: fromEmail,
    subject,
    html: htmlBody,
  };
  if (client.delivery_email_cc) {
    payload.cc = [client.delivery_email_cc as string];
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const resBody = (await res.text()).slice(0, 500);

  await supabase.from("lead_delivery_log").insert([{
    lead_id: lead.id,
    client_id: client.id,
    method: "email",
    destination: toEmail,
    message_preview: emailPreview,
    response_code: res.status,
    response_body: resBody,
    status: res.ok ? "delivered" : "failed",
    delivered_at: res.ok ? new Date().toISOString() : null,
  }]);

  return { ok: res.ok, status: res.status, body: resBody };
}

async function deliverSms(
  supabase: ReturnType<typeof createClient>,
  lead: Record<string, unknown>,
  client: Record<string, unknown>,
  smsBody: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER")!;
  const toNumber = client.delivery_phone as string;

  const params = new URLSearchParams();
  params.set("To", toNumber);
  params.set("From", fromNumber);
  params.set("Body", smsBody);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(accountSid + ":" + authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  const resBody = (await res.text()).slice(0, 500);

  await supabase.from("lead_delivery_log").insert([{
    lead_id: lead.id,
    client_id: client.id,
    method: "sms",
    destination: toNumber,
    message_preview: smsBody,
    response_code: res.status,
    response_body: resBody,
    status: res.ok ? "delivered" : "failed",
    delivered_at: res.ok ? new Date().toISOString() : null,
  }]);

  return { ok: res.ok, status: res.status, body: resBody };
}

async function deliverWebhook(
  supabase: ReturnType<typeof createClient>,
  lead: Record<string, unknown>,
  client: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const webhookUrl = client.client_webhook as string;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lead),
  });

  const resBody = (await res.text()).slice(0, 500);

  await supabase.from("lead_delivery_log").insert([{
    lead_id: lead.id,
    client_id: client.id,
    method: "webhook",
    destination: webhookUrl,
    message_preview: `POST ${webhookUrl} — full lead JSON payload`,
    response_code: res.status,
    response_body: resBody,
    status: res.ok ? "delivered" : "failed",
    delivered_at: res.ok ? new Date().toISOString() : null,
  }]);

  return { ok: res.ok, status: res.status, body: resBody };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { lead_id, client_id } = await req.json();
    if (!lead_id || !client_id) {
      return jsonResponse({ error: "lead_id and client_id required" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // STEP 1 — FETCH
    const [leadR, clientR] = await Promise.all([
      supabaseAdmin.from("ppl_leads").select("*").eq("id", lead_id).single(),
      supabaseAdmin.from("clients").select("*").eq("id", client_id).single(),
    ]);

    if (!leadR.data || !clientR.data) {
      await supabaseAdmin.from("lead_delivery_log").insert([{
        lead_id,
        client_id,
        method: "unknown",
        status: "failed",
        response_body: "record not found",
      }]);
      return jsonResponse({ error: "record not found" }, 404);
    }

    const lead = leadR.data;
    const client = clientR.data;

    // STEP 2 — BUILD EMAIL
    const subject = `New ${lead.lead_type ? titleCase(lead.lead_type as string) : "PPL"} Lead — ${lead.name} · ${lead.postcode}${lead.suburb ? " " + lead.suburb : ""}`;
    const htmlBody = buildEmailHtml(lead, client);
    const emailPreview = buildEmailPreview(lead, subject);

    // STEP 3 — BUILD SMS
    const smsBody = buildSmsBody(lead);

    // STEP 4 — DELIVER
    const methods: Array<{ method: string; status: string; error?: string }> = [];
    let anySuccess = false;
    let firstError: string | null = null;

    // If the client is linked to ql-hq, use delivery_configs channels
    let usedDeliveryConfig = false;
    if (client.ql_hq_company_id) {
      const { data: dc } = await supabaseAdmin
        .from("delivery_configs")
        .select("email, sms_number, webhook_url")
        .eq("ql_hq_company_id", client.ql_hq_company_id as string)
        .maybeSingle();

      if (dc && (dc.email || dc.sms_number || dc.webhook_url)) {
        usedDeliveryConfig = true;
        const channelJobs: Array<[string, Promise<{ ok: boolean; status: number; body: string }>]> = [];
        if (dc.email) {
          channelJobs.push(["email", deliverEmail(supabaseAdmin, lead, { ...client, delivery_email: dc.email }, subject, htmlBody, emailPreview)]);
        }
        if (dc.sms_number) {
          channelJobs.push(["sms", deliverSms(supabaseAdmin, lead, { ...client, delivery_phone: dc.sms_number }, smsBody)]);
        }
        if (dc.webhook_url) {
          channelJobs.push(["webhook", deliverWebhook(supabaseAdmin, lead, { ...client, client_webhook: dc.webhook_url })]);
        }
        const settled = await Promise.allSettled(channelJobs.map(([, p]) => p));
        settled.forEach((r, i) => {
          const [methodName] = channelJobs[i];
          if (r.status === "fulfilled") {
            methods.push({ method: methodName, status: r.value.ok ? "delivered" : "failed", ...(!r.value.ok && { error: r.value.body }) });
            if (r.value.ok) anySuccess = true;
            else firstError = firstError || r.value.body;
          } else {
            methods.push({ method: methodName, status: "failed", error: r.reason?.message });
            firstError = firstError || r.reason?.message;
          }
        });
      }
    }

    if (!usedDeliveryConfig) {
    const deliveryMethod = client.delivery_method || (client.delivery_email ? "email" : null);

    switch (deliveryMethod) {
      case "email": {
        const r = await deliverEmail(supabaseAdmin, lead, client, subject, htmlBody, emailPreview);
        methods.push({ method: "email", status: r.ok ? "delivered" : "failed", ...(!r.ok && { error: r.body }) });
        if (r.ok) anySuccess = true;
        else firstError = firstError || r.body;
        break;
      }
      case "phone": {
        const r = await deliverSms(supabaseAdmin, lead, client, smsBody);
        methods.push({ method: "sms", status: r.ok ? "delivered" : "failed", ...(!r.ok && { error: r.body }) });
        if (r.ok) anySuccess = true;
        else firstError = firstError || r.body;
        break;
      }
      case "email_and_phone": {
        const [emailR, smsR] = await Promise.allSettled([
          deliverEmail(supabaseAdmin, lead, client, subject, htmlBody, emailPreview),
          deliverSms(supabaseAdmin, lead, client, smsBody),
        ]);
        if (emailR.status === "fulfilled") {
          methods.push({ method: "email", status: emailR.value.ok ? "delivered" : "failed", ...(!emailR.value.ok && { error: emailR.value.body }) });
          if (emailR.value.ok) anySuccess = true;
          else firstError = firstError || emailR.value.body;
        } else {
          methods.push({ method: "email", status: "failed", error: emailR.reason?.message });
          firstError = firstError || emailR.reason?.message;
        }
        if (smsR.status === "fulfilled") {
          methods.push({ method: "sms", status: smsR.value.ok ? "delivered" : "failed", ...(!smsR.value.ok && { error: smsR.value.body }) });
          if (smsR.value.ok) anySuccess = true;
          else firstError = firstError || smsR.value.body;
        } else {
          methods.push({ method: "sms", status: "failed", error: smsR.reason?.message });
          firstError = firstError || smsR.reason?.message;
        }
        break;
      }
      case "crm": {
        if (!client.client_webhook) {
          await supabaseAdmin.from("lead_delivery_log").insert([{
            lead_id,
            client_id,
            method: "webhook",
            status: "failed",
            response_body: "no webhook URL configured",
          }]);
          methods.push({ method: "webhook", status: "failed", error: "no webhook URL configured" });
          firstError = "no webhook URL configured";
        } else {
          const r = await deliverWebhook(supabaseAdmin, lead, client);
          methods.push({ method: "webhook", status: r.ok ? "delivered" : "failed", ...(!r.ok && { error: r.body }) });
          if (r.ok) anySuccess = true;
          else firstError = firstError || r.body;
        }
        break;
      }
      default: {
        if (client.delivery_email) {
          const r = await deliverEmail(supabaseAdmin, lead, client, subject, htmlBody, emailPreview);
          methods.push({ method: "email", status: r.ok ? "delivered" : "failed", ...(!r.ok && { error: r.body }) });
          if (r.ok) anySuccess = true;
          else firstError = firstError || r.body;
        } else {
          await supabaseAdmin.from("lead_delivery_log").insert([{
            lead_id,
            client_id,
            method: "none",
            status: "failed",
            response_body: "no delivery method configured",
          }]);
          methods.push({ method: "none", status: "failed", error: "no delivery method configured" });
          firstError = "no delivery method configured";
          return jsonResponse({ success: false, lead_id, methods }, 400);
        }
      }
    } // end switch
    } // end if (!usedDeliveryConfig)

    // STEP 5 — UPDATE PPL_LEADS TABLE
    if (anySuccess) {
      await supabaseAdmin.from("ppl_leads").update({
        status: "delivered",
        delivered_at: new Date().toISOString(),
        delivery_error: null,
      }).eq("id", lead_id);

      // Atomically increment leads_delivered on client
      const { error: rpcError } = await supabaseAdmin.rpc("increment_leads_delivered", { p_client_id: client_id });
      if (rpcError) {
        // Fallback: manual non-atomic increment on any RPC failure
        await supabaseAdmin.from("clients").update({
          leads_delivered: (client.leads_delivered || 0) + 1,
        }).eq("id", client_id);
      }

      // STEP 5b — ORDER COMPLETE CHECK
      // After this delivery the client's leads_delivered becomes prev+1.
      // If that now equals total_leads_purchased the order is fulfilled —
      // send an internal notification to contact@quoteleads.com.au.
      const newDelivered = (client.leads_delivered as number || 0) + 1;
      const totalPurchased = client.total_leads_purchased as number || 0;
      if (totalPurchased > 0 && newDelivered >= totalPurchased) {
        const fromEmail = Deno.env.get("RESEND_FROM_EMAIL")!;
        const apiKey = Deno.env.get("RESEND_API_KEY")!;
        const orderRevenue = totalPurchased * (client.lead_price as number || 0);
        const orderHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#1a1a20;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#1a1a20">
  <div style="background:#0f0f12;padding:14px 20px">
    <span style="color:#eeeef3;font-weight:700;font-size:14px">QuoteLeads · PPL Order Complete</span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#1a1a20">
    <tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Client</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(client.company_name as string || "—")}</td></tr>
    ${client.contact_name ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Contact</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(client.contact_name as string)}</td></tr>` : ""}
    ${client.email ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Email</td><td style="padding:5px 12px;font-size:12px"><a href="mailto:${esc(client.email as string)}" style="color:#4f8fff">${esc(client.email as string)}</a></td></tr>` : ""}
    ${client.phone ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Phone</td><td style="padding:5px 12px;font-size:12px"><a href="tel:${esc(client.phone as string)}" style="color:#4f8fff">${esc(client.phone as string)}</a></td></tr>` : ""}
    ${client.niche ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Niche</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(client.niche as string)}</td></tr>` : ""}
    <tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Leads Ordered</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${totalPurchased}</td></tr>
    <tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Leads Delivered</td><td style="padding:5px 12px;color:#10b981;font-weight:700;font-size:12px">${newDelivered}</td></tr>
    ${client.lead_price ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">$/Lead</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">$${Number(client.lead_price).toFixed(0)}</td></tr>` : ""}
    ${orderRevenue > 0 ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Order Revenue</td><td style="padding:5px 12px;color:#10b981;font-weight:700;font-size:12px">$${orderRevenue.toFixed(0)}</td></tr>` : ""}
  </table>
  <div style="padding:12px;margin:0 12px 12px;background:#0f0f12;border-radius:4px;font-size:11px;color:#72728a">All ordered leads have been delivered. Consider reaching out for a reorder.</div>
</div></body></html>`;
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `QuoteLeads <${fromEmail}>`,
              to: ["contact@quoteleads.com.au"],
              subject: `Order Complete — ${client.company_name} · ${totalPurchased}/${totalPurchased} leads delivered`,
              html: orderHtml,
            }),
          });
        } catch { /* best-effort */ }
      }
    } else {
      await supabaseAdmin.from("ppl_leads").update({
        delivered_at: new Date().toISOString(),
        delivery_error: firstError,
      }).eq("id", lead_id);
    }

    // STEP 6 — ADMIN NOTIFICATION (per-lead, to sending address)
    if (anySuccess) {
      const notifyEmail = Deno.env.get("RESEND_FROM_EMAIL");
      if (notifyEmail) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: `QuoteLeads <${notifyEmail}>`,
              to: [notifyEmail],
              subject: `✓ Lead Delivered → ${client.company_name} | ${lead.name} ${lead.postcode}`,
              html: `<p>Lead <strong>${esc(lead.name as string)}</strong> (${esc(lead.phone as string)}) delivered to <strong>${esc(client.company_name as string)}</strong> via ${methods.filter((m) => m.status === "delivered").map((m) => m.method).join(", ")}.</p>`,
            }),
          });
        } catch {
          // Admin notification is best-effort
        }
      }
    }

    // STEP 7 — RETURN
    return jsonResponse({ success: anySuccess, lead_id, methods });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal server error" },
      500,
    );
  }
});
