const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NOTIFY_TO = "contact@quoteleads.com.au";

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:5px 12px;color:#72728a;font-size:12px;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:5px 12px;color:#eeeef3;font-weight:600;font-size:12px">${value}</td></tr>`;
}

function buildEmailHtml(title: string, rows: string, note?: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#1a1a20;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#1a1a20">
  <div style="background:#0f0f12;padding:14px 20px">
    <span style="color:#eeeef3;font-weight:700;font-size:14px">QuoteLeads · ${esc(title)}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#1a1a20">${rows}</table>
  ${note ? `<div style="padding:12px;margin:0 12px 12px;background:#0f0f12;border-radius:4px;font-size:11px;color:#72728a">${esc(note)}</div>` : ""}
</div></body></html>`;
}

function handleOrderDelivered(data: Record<string, unknown>): { subject: string; html: string } {
  const subject = `✓ Order Complete — ${data.company_name} · ${data.leads_qty} leads`;
  const leadsQty = Number(data.leads_qty ?? 0);
  const leadsGen = Number(data.leads_generated ?? 0);
  const pctSold = leadsGen > 0 ? ((leadsQty / leadsGen) * 100).toFixed(0) + "%" : "—";
  const totalRevenue = leadsQty * Number(data.lead_price ?? 0);

  let rows = "";
  rows += row("Client", esc(String(data.company_name ?? "—")));
  if (data.contact_name) rows += row("Contact", esc(String(data.contact_name)));
  if (data.email) rows += row("Email", `<a href="mailto:${esc(String(data.email))}" style="color:#4f8fff">${esc(String(data.email))}</a>`);
  if (data.phone) rows += row("Phone", `<a href="tel:${esc(String(data.phone))}" style="color:#4f8fff">${esc(String(data.phone))}</a>`);
  if (data.niche) rows += row("Niche", esc(String(data.niche)));
  rows += row("Leads Sold (Ordered)", String(leadsQty));
  rows += row("Leads Generated", String(leadsGen));
  rows += row("% Sold", pctSold);
  if (data.lead_price) rows += row("$/Lead", "$" + Number(data.lead_price).toFixed(0));
  if (totalRevenue > 0) rows += row("Order Revenue", "$" + totalRevenue.toFixed(0));
  if (data.order_date) rows += row("Order Date", esc(String(data.order_date)));

  const html = buildEmailHtml("PPL Order Complete", rows);
  return { subject, html };
}

function handlePaymentDue(data: Record<string, unknown>): { subject: string; html: string } {
  const subject = `Payment Due Today — ${data.company_name}`;

  let rows = "";
  rows += row("Client", esc(String(data.company_name ?? "—")));
  if (data.contact_name) rows += row("Contact", esc(String(data.contact_name)));
  if (data.email) rows += row("Email", `<a href="mailto:${esc(String(data.email))}" style="color:#4f8fff">${esc(String(data.email))}</a>`);
  if (data.phone) rows += row("Phone", `<a href="tel:${esc(String(data.phone))}" style="color:#4f8fff">${esc(String(data.phone))}</a>`);
  if (data.ad_account_id) rows += row("Ad Account", esc(String(data.ad_account_id)));
  if (data.monthly_budget) rows += row("Monthly Budget", "$" + Number(data.monthly_budget).toLocaleString());
  if (data.management_fee) rows += row("Management Fee", "$" + Number(data.management_fee).toLocaleString() + "/mo");
  if (data.start_date) rows += row("Client Since", esc(String(data.start_date)));
  if (data.last_payment_date) rows += row("Last Payment", esc(String(data.last_payment_date)));
  rows += row("Next Payment Due", `<span style="color:#f59e0b;font-weight:700">${esc(String(data.next_payment_date ?? "—"))}</span>`);

  const html = buildEmailHtml("Managed Client — Payment Due", rows, "This client's retainer payment is due today. Please follow up.");
  return { subject, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { type, data } = await req.json();

    if (!type || !data) {
      return new Response(JSON.stringify({ error: "type and data required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let subject = "";
    let html = "";

    if (type === "order_delivered") {
      ({ subject, html } = handleOrderDelivered(data));
    } else if (type === "payment_due") {
      ({ subject, html } = handlePaymentDue(data));
    } else {
      return new Response(JSON.stringify({ error: "unknown type" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL")!;
    const apiKey = Deno.env.get("RESEND_API_KEY")!;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `QuoteLeads <${fromEmail}>`,
        to: [NOTIFY_TO],
        subject,
        html,
      }),
    });

    const resBody = await res.text();
    return new Response(JSON.stringify({ ok: res.ok, status: res.status, body: resBody.slice(0, 200) }), {
      status: res.ok ? 200 : 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
