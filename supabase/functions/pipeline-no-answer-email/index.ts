/**
 * pipeline-no-answer-email - follow-ups to pipeline leads we could not reach.
 *
 * A lead moved to No Answer gets a text and an email on day 1, 3, 7 and 10
 * after the move: the four messages in business_settings.no_answer_followups,
 * edited under Settings, switched on and off together by
 * no_answer_email_enabled. Moving the lead out of No Answer stops them.
 *
 * Each step goes on its day, or the day after if a morning was missed, and
 * never later: switching this on, or a lead sitting in No Answer for weeks,
 * never sends a backlog. Every attempt is recorded in no_answer_followup_log,
 * success or not, so nothing goes twice and a lead with no mobile or who has
 * opted out isn't tried again every morning.
 *
 * Emails go through send-sales-email and texts through send-sms, so the
 * do-not-contact list, the SMS opt-out register, the 30-day duplicate guard,
 * the from address and the logs all apply exactly as for a send by hand. The
 * email goes out as the lead's rep when it has one, so it is signed by and
 * replies go to the rep who tried calling.
 *
 * "Moved to No Answer" is leads.stage_changed_at. Run by pg_cron each morning
 * with the service-role key, proven by reading jarvis_messages, which nothing
 * else can.
 *
 * POST {} to send, or { "dry_run": true } to see what would go.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Step = { day: number; sms?: string; subject?: string; email?: string };

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

// Whole days between two moments, counted on Sydney's calendar, so a lead moved
// at 4pm is on day 1 the next morning.
const sydneyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
const daysBetween = (from: Date, to: Date) =>
  Math.round((Date.parse(sydneyDay(to)) - Date.parse(sydneyDay(from))) / 86400e3);

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
    .select("no_answer_email_enabled, no_answer_followups")
    .limit(1).maybeSingle();
  if (!cfg?.no_answer_email_enabled) return json({ message: "No-answer follow-ups are switched off", sent: 0 });
  const steps = ((cfg.no_answer_followups || []) as Step[])
    .filter((s) => Number(s?.day) >= 1).sort((a, b) => a.day - b.day);
  if (!steps.length) return json({ message: "No follow-up messages set", sent: 0 });

  // Only leads moved to No Answer recently enough to have a step due.
  const lastDay = steps[steps.length - 1].day + 1;
  const since = new Date(Date.now() - (lastDay + 1) * 86400e3).toISOString();
  const { data: leads, error } = await admin
    .from("leads")
    .select("id, name, company, email, phone, owner_id, stage_changed_at, sms_opted_out")
    .eq("stage", "no_answer")
    .not("stage_changed_at", "is", null)
    .gte("stage_changed_at", since)
    .limit(200);
  if (error) return json({ error: error.message }, 500);
  if (!leads?.length) return json({ message: "Nobody in No Answer", sent: 0 });

  const { data: done } = await admin.from("no_answer_followup_log")
    .select("lead_id, entered_at, step_day, channel").in("lead_id", leads.map((l) => l.id));
  const seen = new Set((done || []).map((d) => `${d.lead_id}|${Date.parse(d.entered_at)}|${d.step_day}|${d.channel}`));

  const { data: reps } = await admin.from("sales_reps").select("user_id, name, email, reply_to_email");
  const repByUser = new Map((reps || []).map((r) => [r.user_id, r]));

  const now = new Date();
  const results: Array<Record<string, unknown>> = [];
  for (const lead of leads) {
    const entered = new Date(lead.stage_changed_at);
    const day = daysBetween(entered, now);
    // Today's step, else yesterday's if this morning is the day after it.
    const step = steps.find((s) => s.day === day) || steps.find((s) => s.day + 1 === day);
    if (!step) continue;

    const rep = lead.owner_id ? repByUser.get(lead.owner_id) : undefined;
    const vals = {
      first_name: firstName(lead.name),
      company_name: String(lead.company || "").trim(),
      rep_name: String(rep?.name || "").trim(),
      rep_email: String(rep?.reply_to_email || rep?.email || "").trim(),
    };
    const key = (channel: string) => `${lead.id}|${entered.getTime()}|${step.day}|${channel}`;
    const record = async (channel: string, ok: boolean, detail: string | null) => {
      results.push({ lead_id: lead.id, day: step.day, channel, ok, ...(detail ? { detail } : {}) });
      if (dryRun) return;
      await admin.from("no_answer_followup_log").upsert({
        lead_id: lead.id, entered_at: entered.toISOString(), step_day: step.day, channel, ok, detail,
      }, { onConflict: "lead_id,entered_at,step_day,channel", ignoreDuplicates: true });
    };

    // The email.
    if (!seen.has(key("email")) && step.subject && step.email) {
      if (!lead.email) await record("email", false, "no email address");
      else if (dryRun) await record("email", true, `would email ${lead.email}`);
      else {
        const res = await fetch(`${url}/functions/v1/send-sales-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            lead_id: lead.id, kind: "no_answer_followup", via: "auto",
            subject: merge(step.subject, vals), body: merge(step.email, vals),
          }),
        });
        const out = await res.json().catch(() => ({}));
        await record("email", res.ok, res.ok ? null : String(out.error || `HTTP ${res.status}`));
      }
    }

    // The text.
    if (!seen.has(key("sms")) && step.sms) {
      if (!lead.phone) await record("sms", false, "no phone number");
      else if (lead.sms_opted_out) await record("sms", false, "opted out of SMS");
      else if (dryRun) await record("sms", true, `would text ${lead.phone}`);
      else {
        const res = await fetch(`${url}/functions/v1/send-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ to: lead.phone, message: merge(step.sms, vals), lead_id: lead.id, source: "sales", via: "auto" }),
        });
        const out = await res.json().catch(() => ({}));
        const ok = res.ok && out.success === true;
        await record("sms", ok, ok ? null : String(out.error || `HTTP ${res.status}`).slice(0, 300));
      }
    }
  }

  return json({ dry_run: dryRun, sent: results.filter((r) => r.ok).length, results });
});
