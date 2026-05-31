import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOTIFY_TO = "contact@quoteleads.com.au";

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Accept calls from pg_cron (service role key) or internal scheduler
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${serviceKey}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }); // YYYY-MM-DD in AEST

  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, company_name, contact_name, email, phone, ad_account_id, monthly_budget, management_fee, start_date, last_payment_date, next_payment_date")
    .eq("type", "managed")
    .eq("stage", "active")
    .eq("next_payment_date", today);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });
  }

  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL")!;
  const apiKey = Deno.env.get("RESEND_API_KEY")!;

  const results: Array<{ client: string; ok: boolean }> = [];

  for (const c of clients) {
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#1a1a20;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#1a1a20">
  <div style="background:#0f0f12;padding:14px 20px">
    <span style="color:#eeeef3;font-weight:700;font-size:14px">QuoteLeads · Managed Client — Payment Due Today</span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#1a1a20">
    <tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Client</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(c.company_name)}</td></tr>
    ${c.contact_name ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Contact</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(c.contact_name)}</td></tr>` : ""}
    ${c.email ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Email</td><td style="padding:5px 12px;font-size:12px"><a href="mailto:${esc(c.email)}" style="color:#4f8fff">${esc(c.email)}</a></td></tr>` : ""}
    ${c.phone ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Phone</td><td style="padding:5px 12px;font-size:12px"><a href="tel:${esc(c.phone)}" style="color:#4f8fff">${esc(c.phone)}</a></td></tr>` : ""}
    ${c.ad_account_id ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Ad Account</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(c.ad_account_id)}</td></tr>` : ""}
    ${c.monthly_budget ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Monthly Budget</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">$${Number(c.monthly_budget).toLocaleString()}</td></tr>` : ""}
    ${c.management_fee ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Management Fee</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">$${Number(c.management_fee).toLocaleString()}/mo</td></tr>` : ""}
    ${c.start_date ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Client Since</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(c.start_date)}</td></tr>` : ""}
    ${c.last_payment_date ? `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Last Payment</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${esc(c.last_payment_date)}</td></tr>` : ""}
    <tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap">Payment Due</td><td style="padding:5px 12px;color:#f59e0b;font-weight:700;font-size:13px">${esc(c.next_payment_date)} — Today</td></tr>
  </table>
  <div style="padding:12px;margin:0 12px 12px;background:#0f0f12;border-radius:4px;font-size:11px;color:#72728a">Retainer payment is due today. Please follow up with the client.</div>
</div></body></html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `QuoteLeads <${fromEmail}>`,
        to: [NOTIFY_TO],
        subject: `Payment Due Today — ${c.company_name}`,
        html,
      }),
    });

    results.push({ client: c.company_name, ok: res.ok });
  }

  return new Response(JSON.stringify({ ok: true, sent: results.length, results }), { status: 200 });
});
