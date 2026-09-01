// send-sales-email — the Send Info / Follow Up buttons on a pipeline lead.
//
// The browser sends the draft the rep actually approved (subject + body, already
// merged and possibly hand-edited). This function decides everything that must
// not be decided in a browser: who the lead belongs to, whether that email has
// already gone out, which address replies come back to, and the stamp on the
// lead that greys the button out.
//
// Reps are view-only on `leads`, so the stamp is written here under the service
// role. That also makes the button state honest: it only changes once Resend has
// accepted the message.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The rep writes a plain-text script; this renders it as the same plain text a
// person would have typed, rather than dressing it up as a marketing template.
function bodyToHtml(text: string): string {
  const paras = String(text).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`
  ).join("");
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a20">
${paras}
</div></body></html>`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const leadId  = String(body.lead_id ?? "").trim();
    const kind    = String(body.kind ?? "").trim();
    const subject = String(body.subject ?? "").trim();
    const text    = String(body.body ?? "").trim();

    if (!leadId) return json({ error: "lead_id is required" }, 400);
    if (kind !== "info" && kind !== "followup") return json({ error: "kind must be info or followup" }, 400);
    if (!subject) return json({ error: "Subject is required" }, 400);
    if (!text) return json({ error: "Body is required" }, 400);
    if (subject.length > 300) return json({ error: "Subject is too long" }, 400);
    if (text.length > 20000) return json({ error: "Body is too long" }, 400);

    const { data: lead, error: leadErr } = await admin
      .from("leads")
      .select("id, name, email, owner_id, info_sent_at, followup_sent_at")
      .eq("id", leadId)
      .single();
    if (leadErr || !lead) return json({ error: "Lead not found" }, 404);

    // A rep may only email their own leads. Full users may email any.
    const isRep = (user.app_metadata as Record<string, unknown>)?.account_type === "sales_rep";
    if (isRep && lead.owner_id !== user.id) return json({ error: "That lead is not assigned to you" }, 403);

    const to = String(lead.email ?? "").trim();
    if (!to || !EMAIL_RE.test(to)) return json({ error: "This lead has no valid email address" }, 400);

    // Order and once-only are enforced here, not by the disabled attribute on a
    // button: a stale tab must not be able to send a second copy.
    if (kind === "info" && lead.info_sent_at) return json({ error: "The info email has already been sent" }, 409);
    if (kind === "followup") {
      if (!lead.info_sent_at) return json({ error: "Send the info email first" }, 400);
      if (lead.followup_sent_at) return json({ error: "The follow-up has already been sent" }, 409);
    }

    // Reply-To: the rep's own address, so the answer lands with whoever sent it.
    const { data: rep } = await admin
      .from("sales_reps")
      .select("name, email, reply_to_email")
      .eq("user_id", user.id)
      .maybeSingle();
    const replyTo = String(rep?.reply_to_email || rep?.email || user.email || "").trim();
    const repName = String(rep?.name || (user.user_metadata as Record<string, unknown>)?.name || "").trim();

    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
    const apiKey    = Deno.env.get("RESEND_API_KEY");
    if (!fromEmail || !apiKey) return json({ error: "Email is not configured" }, 500);

    // Sent on the verified domain, under the rep's name, replying to the rep.
    const fromName = repName ? `${repName} at QuoteLeads` : "QuoteLeads";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        html: bodyToHtml(text),
        text,
        ...(replyTo && EMAIL_RE.test(replyTo) ? { reply_to: replyTo } : {}),
      }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("resend error:", res.status, JSON.stringify(payload));
      return json({ error: "The email provider rejected the message" }, 502);
    }

    // Only now does the lead get stamped, so a failed send leaves the button live.
    const stamp = kind === "info"
      ? { info_sent_at: new Date().toISOString(), info_sent_by: user.id }
      : { followup_sent_at: new Date().toISOString(), followup_sent_by: user.id };
    const { error: updErr } = await admin.from("leads").update(stamp).eq("id", leadId);
    if (updErr) console.error("lead stamp failed after send:", updErr.message);

    await admin.from("sales_email_log").insert({
      lead_id: leadId, kind, to_email: to, reply_to: replyTo || null,
      subject, body: text, sent_by: user.id, provider_id: payload?.id ?? null,
    });

    return json({ ok: true, to, reply_to: replyTo || null, sent_at: stamp.info_sent_at ?? stamp.followup_sent_at });
  } catch (err) {
    console.error("send-sales-email error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
