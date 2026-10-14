/**
 * pipeline-no-answer-email - one email to a pipeline lead we could not reach.
 *
 * A lead that has sat in No Answer for business_settings.no_answer_email_days
 * (3 to start) gets the no-answer email from Settings, once. It goes out
 * through send-sales-email, so the do-not-contact list, the 30-day duplicate
 * guard, the from address and the email log all apply exactly as for the
 * Follow Up button. It is sent as the lead's rep when it has one, so it is
 * signed by and replies go to the rep who tried calling; an unassigned lead's
 * email is signed just "QuoteLeads".
 *
 * "In No Answer for 3 days" is leads.stage_changed_at, stamped by a trigger
 * from 14 Oct 2026. Leads already in No Answer before then have none and are
 * left alone, so switching this on never emails old leads out of the blue.
 *
 * Run by pg_cron each morning with the service-role key, proven the same way
 * send-sales-email proves Jarvis: by reading jarvis_messages, which nothing
 * else can.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Same rules as mergeTemplate in index.html: a placeholder with no value is
// dropped with the space it leaves, never printed as a gap.
function merge(text: string, vals: Record<string, string>): string {
  return String(text || "")
    .replace(/\{(first_name|company_name|rep_name|rep_email)\}/g, (_, k) => vals[k] || "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/ -\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const firstName = (name: string) => String(name || "").trim().split(/\s+/)[0] || "";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Missing authorization" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, token);
  const { error: capErr } = await caller.from("jarvis_messages").select("id").limit(1);
  if (capErr) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const dryRun = (await req.json().catch(() => ({})))?.dry_run === true;

  const { data: cfg } = await admin
    .from("business_settings")
    .select("no_answer_email_enabled, no_answer_email_days, no_answer_email_subject, no_answer_email_body")
    .limit(1).maybeSingle();
  if (!cfg?.no_answer_email_enabled) return json({ message: "No-answer email is switched off", sent: 0 });
  const days = Math.max(1, Number(cfg.no_answer_email_days) || 3);
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();

  const { data: leads, error } = await admin
    .from("leads")
    .select("id, name, company, email, owner_id")
    .eq("stage", "no_answer")
    .not("stage_changed_at", "is", null)
    .lte("stage_changed_at", cutoff)
    .is("no_answer_email_sent_at", null)
    .not("email", "is", null)
    .neq("email", "")
    .limit(50);
  if (error) return json({ error: error.message }, 500);
  if (!leads?.length) return json({ message: "Nobody due", sent: 0 });

  // {rep_name} and {rep_email} are the lead's rep. An unassigned lead has
  // none, so its email just ends "QuoteLeads" (the empty line is dropped).
  const { data: reps } = await admin.from("sales_reps").select("user_id, name, email, reply_to_email");
  const repByUser = new Map((reps || []).map((r) => [r.user_id, r]));

  const results: Array<{ lead_id: string; to: string; ok: boolean; error?: string }> = [];
  for (const lead of leads) {
    const rep = lead.owner_id ? repByUser.get(lead.owner_id) : undefined;
    const vals = {
      first_name: firstName(lead.name),
      company_name: String(lead.company || "").trim(),
      rep_name: String(rep?.name || "").trim(),
      rep_email: String(rep?.reply_to_email || rep?.email || "").trim(),
    };
    const subject = merge(cfg.no_answer_email_subject, vals);
    const body = merge(cfg.no_answer_email_body, vals);
    if (dryRun) { results.push({ lead_id: lead.id, to: lead.email, ok: true }); continue; }

    const res = await fetch(`${url}/functions/v1/send-sales-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ lead_id: lead.id, kind: "no_answer", subject, body, via: "auto" }),
    });
    const out = await res.json().catch(() => ({}));
    results.push({ lead_id: lead.id, to: lead.email, ok: res.ok, ...(res.ok ? {} : { error: out.error || `HTTP ${res.status}` }) });
  }

  return json({ dry_run: dryRun, days, sent: results.filter((r) => r.ok).length, results });
});
