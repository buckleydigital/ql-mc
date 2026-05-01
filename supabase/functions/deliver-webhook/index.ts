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

function buildEmailHtml(lead: Record<string, unknown>, _client: Record<string, unknown>): string {
  const now = formatAEST(new Date());
  const typeStr = lead.lead_type as string || "—";

  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#72728a;font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:6px 12px;color:#eeeef3;font-weight:600;font-size:13px">${value}</td></tr>`;

  let rows = "";
  rows += row("Name", esc(lead.name as string));
  rows += row("Phone", `<a href="tel:${lead.phone}" style="color:#4f8fff">${esc(lead.phone as string)}</a>`);
  rows += row("Email", lead.email
    ? `<a href="mailto:${lead.email}" style="color:#4f8fff">${esc(lead.email as string)}</a>`
    : "—");
  rows += row("Postcode", esc(lead.postcode as string || "—"));
  rows += row("Type", esc(typeStr));
  rows += row("Source", esc(lead.source as string || "webhook"));
  if (lead.is_homeowner === true) rows += row("Homeowner", "Yes");
  else if (lead.is_homeowner === false) rows += row("Homeowner", "No");

  if (lead.avg_quarterly_bill != null && lead.avg_quarterly_bill !== "") rows += row("Quarterly Bill", "$" + lead.avg_quarterly_bill);
  if (lead.interested_in) rows += row("Interested In", esc(lead.interested_in as string));
  if (lead.purchase_timeline) rows += row("Timeline", esc(lead.purchase_timeline as string));

  // Custom fields section (plain text)
  let customSection = "";
  const cf = lead.custom_fields as string | null;
  if (cf && cf.trim()) {
    customSection = `<tr><td colspan="2" style="padding:14px 12px 6px;font-size:10px;color:#72728a;text-transform:uppercase;letter-spacing:.1em;font-variant:small-caps">Notes</td></tr>`;
    customSection += row("Notes", esc(cf.trim()));
  }

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#1a1a20;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#1a1a20">
  <div style="background:#0f0f12;padding:14px 20px;display:flex;justify-content:space-between;align-items:center">
    <span style="color:#eeeef3;font-weight:700;font-size:14px">QuoteLeads · New Lead</span>
    <span style="color:#72728a;font-size:12px">${esc(now)}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#1a1a20">${rows}${customSection}</table>
  <div style="padding:16px 12px;font-size:11px;color:#55556a">Delivered by QuoteLeads · ${esc(lead.id as string)}</div>
</div></body></html>`;
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
  if (lead.avg_quarterly_bill != null && lead.avg_quarterly_bill !== "") lines.push(`Quarterly Bill: $${sanitizeSmsField(lead.avg_quarterly_bill)}`);
  if (lead.interested_in) lines.push(`Interested In: ${sanitizeSmsField(lead.interested_in)}`);
  if (lead.purchase_timeline) lines.push(`Timeline: ${sanitizeSmsField(lead.purchase_timeline)}`);

  return lines.join("\n");
}

async function deliverEmail(
  supabase: ReturnType<typeof createClient>,
  lead: Record<string, unknown>,
  client: Record<string, unknown>,
  subject: string,
  htmlBody: string,
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
    message_preview: subject,
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
    const subject = `New ${lead.lead_type || "PPL"} Lead — ${lead.name} · ${lead.postcode}${lead.suburb ? " " + lead.suburb : ""}`;
    const htmlBody = buildEmailHtml(lead, client);

    // STEP 3 — BUILD SMS
    const smsBody = buildSmsBody(lead);

    // STEP 4 — DELIVER
    const methods: Array<{ method: string; status: string; error?: string }> = [];
    let anySuccess = false;
    let firstError: string | null = null;

    const deliveryMethod = client.delivery_method || (client.delivery_email ? "email" : null);

    switch (deliveryMethod) {
      case "email": {
        const r = await deliverEmail(supabaseAdmin, lead, client, subject, htmlBody);
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
          deliverEmail(supabaseAdmin, lead, client, subject, htmlBody),
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
          const r = await deliverEmail(supabaseAdmin, lead, client, subject, htmlBody);
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
    }

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
    } else {
      await supabaseAdmin.from("ppl_leads").update({
        delivered_at: new Date().toISOString(),
        delivery_error: firstError,
      }).eq("id", lead_id);
    }

    // STEP 6 — ADMIN NOTIFICATION
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
