/**
 * jarvis-notify - the heartbeat.
 *
 * Runs on a schedule, asks the watchers what is wrong, and texts one message
 * about anything new. This is what turns Jarvis from something you open into
 * something that speaks first.
 *
 * Not reusing send-sms, deliberately: that function requires a lead_id it
 * validates against leads/ppl_leads, and a user bearer token. Jarvis texting
 * the owner has neither - there is no lead, and no human is logged in when the
 * cron fires. Sharing it would have meant loosening the checks that stop a
 * client SMS going to the wrong person, so this owns its own send path and
 * borrows only the Twilio credentials and the AU number rules.
 *
 * Composition is deliberately deterministic rather than a Claude call. These
 * are factual alerts about money and clients; a model paraphrasing "3 overdue"
 * is a downside with no matching upside, and it would put a paid API call and a
 * network failure in the path of every heartbeat. Jarvis's voice lives in the
 * templates. Phrasing can move to a model later without touching detection.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// Same rules as send-sms: AU mobiles only, in the format Twilio expects.
function normalisePhone(raw: string): string | null {
  let p = (raw || '').replace(/[\s\-().]/g, '')
  if (p.startsWith('04')) p = '+61' + p.slice(1)
  else if (p.startsWith('614') && !p.startsWith('+')) p = '+' + p
  else if (p.startsWith('61') && !p.startsWith('+')) p = '+' + p
  return /^\+614[0-9]{8}$/.test(p) ? p : null
}

type Ev = {
  id: string
  kind: string
  tier: string
  subject: string | null
  payload: Record<string, unknown>
}

// Jarvis's voice. One line per event, shortest thing that still tells you what
// to do. Anything longer stops being glanceable on a lock screen, which is the
// only place these are ever read.
function describe(e: Ev): string {
  const who = e.subject || 'Unnamed'
  switch (e.kind) {
    case 'won_no_account': {
      const h = Number(e.payload.hours ?? 0)
      const d = h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`
      return `${who} closed won ${d} ago and still has no HQ account.`
    }
    case 'proposal_cold': {
      const d = Number(e.payload.days ?? 0)
      const v = e.payload.value
      // The value is worth saying when it is there, because it is what decides
      // which of these you ring back first. Most leads carry none, so it is
      // appended rather than assumed.
      const worth = typeof v === 'number' && v > 0 ? ` ($${v.toLocaleString('en-AU')})` : ''
      return `${who}${worth} - proposal cold ${d} days.`
    }
    case 'don_off': {
      const n = Number(e.payload.waiting ?? 0)
      const h = Number(e.payload.since_hours ?? 0)
      // Naming the config case explicitly: "turn it on" is the wrong
      // instruction when the switch that matters is a different one.
      const why = e.payload.config_inactive ? ' Its agent is set inactive.' : ''
      return `The AI SMS agent is off and ${n} ${n === 1 ? 'lead has' : 'leads have'} texted in` +
        `${h ? `, oldest ${h}h ago` : ''}.${why}`
    }
    case 'followup_overdue':
      return `${who} - follow-up is overdue.`
    case 'fulfilment_overdue':
      return `${who} - onboarding is past due${e.payload.step ? ` on ${e.payload.step}` : ''}.`
    case 'fulfilment_blocked':
      return `${who} - fulfilment is blocked${e.payload.blocked ? ` (${e.payload.blocked})` : ''}.`
    default:
      return `${who} - ${e.kind}.`
  }
}

// Refresh the mirror of Don's on/off state.
//
// Don's config lives in ql-hq. A watcher is a SELECT, and a SELECT cannot make
// an HTTP call to another project - so the only way jarvis_scan() can see him
// is if his state is sitting in a local column when it runs. Same arrangement
// as fulfilment, which ql-hq pushes here for the same reason.
//
// Best effort on purpose. If ql-hq is unreachable the columns keep their last
// values and don_synced_at goes stale, which the watcher reads as "I do not
// know" and stays quiet about, rather than announcing an outage as though Don
// had been switched off.
// deno-lint-ignore no-explicit-any
async function syncDonState(db: any): Promise<void> {
  const hq = Deno.env.get('QL_HQ_API_URL')
  const secret = Deno.env.get('QL_MC_API_SECRET')
  if (!hq || !secret) return

  try {
    const res = await fetch(`${hq}/sync-from-mc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
      body: JSON.stringify({ action: 'get_sms_agent_config' }),
    })
    if (!res.ok) {
      console.warn('syncDonState: ql-hq returned', res.status)
      return
    }
    const cfg = (await res.json())?.config
    if (!cfg) return

    // Both halves matter. auto_reply off means he is not answering; is_active
    // off means the config is not even attached to the inbound number, so
    // switching auto_reply on alone would not wake him. Recording only the
    // first would make "Don is on" true and useless.
    const { data: row } = await db.from('business_settings').select('id').limit(1).maybeSingle()
    if (!row?.id) return
    await db.from('business_settings').update({
      don_enabled:   cfg.auto_reply === true,
      don_active:    cfg.is_active === true,
      don_synced_at: new Date().toISOString(),
    }).eq('id', row.id)
  } catch (err) {
    console.warn('syncDonState failed:', err instanceof Error ? err.message : err)
  }
}

// Wall-clock time where the person is, not where the server is. A cron running
// in UTC must not get to decide that 4am Sydney is a reasonable hour.
function localHHMM(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(now)
  } catch {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(now)
  }
}

// Quiet hours normally wrap midnight (20:00 -> 07:30), so this is an OR across
// the wrap rather than a plain between.
function inQuietHours(nowHHMM: string, start: string, end: string): boolean {
  const s = (start || '20:00').slice(0, 5)
  const e = (end || '07:30').slice(0, 5)
  if (s === e) return false
  return s > e ? (nowHHMM >= s || nowHHMM < e) : (nowHHMM >= s && nowHHMM < e)
}

// ── Scheduled jobs ─────────────────────────────────────────────────────────
// Work Jarvis set for himself with create_job. Each due job goes to jarvis-chat
// (via:'job'), which does it with his full tools and memory and returns a short
// report; the report is texted here like any alert, so the same quiet hours and
// daily cap apply, and a reply of "yes" reaches jarvis-reply with it as context.

/** Stop claiming more jobs this heartbeat once this much time has gone. */
const JOB_TIME_BUDGET_MS = 60_000
const MAX_JOBS_PER_BEAT = 2

type Job = { id: string; title: string; instruction: string; repeat: string }

async function runJob(url: string, job: Job): Promise<string> {
  try {
    const res = await fetch(`${url}/functions/v1/jarvis-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
      },
      body: JSON.stringify({
        via: 'job',
        allow_writes: true,
        messages: [{
          role: 'user',
          content: `Scheduled job "${job.title}" (${job.repeat}) is due now.\n\nInstruction:\n${job.instruction}`,
        }],
      }),
    })
    const raw = await res.text()
    let reply = ''
    try { reply = String(JSON.parse(raw)?.reply ?? '') } catch { /* below */ }
    if (!res.ok || !reply) return `I could not complete this job (${res.status}). ${raw.slice(0, 120)}`
    return reply
  } catch (err) {
    return `I could not complete this job: ${err instanceof Error ? err.message : err}`
  }
}

async function sendSms(to: string, from: string, body: string) {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(accountSid + ':' + authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    },
  )
  const raw = await res.text()
  let sid: string | null = null
  try { sid = JSON.parse(raw).sid || null } catch { /* keep raw */ }
  return { ok: res.ok, sid, raw }
}

Deno.serve(async (req: Request) => {
  // No public surface. The only callers are pg_cron (via pg_net) and a human
  // testing with the same key. Checked here rather than by verify_jwt, because
  // a cron has no user JWT to present.
  //
  // The check is a capability test, not a string compare. Comparing the bearer
  // to SUPABASE_SERVICE_ROLE_KEY looked equivalent and was not: the value the
  // edge runtime injects is not always the same string as the service_role key
  // in the dashboard, so the first live cron returned 401 - and would have gone
  // on doing that silently every 15 minutes, which is the worst possible
  // failure for something whose whole job is telling you when things are wrong.
  //
  // Instead the presented key is used to read jarvis_events, which is revoked
  // from anon and authenticated and forces RLS with no policies. Only a
  // service-role key can read it, so a successful read IS the proof of
  // authority, and it cannot drift out of sync with a rotated or reformatted
  // key the way a hardcoded comparison does.
  const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const caller = createClient(url, auth)
  const { error: authErr } = await caller.from('jarvis_events').select('id').limit(1)
  if (authErr) return json({ error: 'unauthorized' }, 401)

  // Past the gate, use the runtime's own key for the work itself.
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const body = await req.json().catch(() => ({}))
    // dry_run exercises the whole path and reports what it WOULD send, so the
    // first live test cannot put a real text on a real phone.
    const dryRun = body?.dry_run === true

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_notify_number, jarvis_notify_enabled, jarvis_timezone, jarvis_quiet_start, jarvis_quiet_end, jarvis_daily_sms_cap, twilio_from_number, jarvis_from_number')
      .limit(1).maybeSingle()

    // The mirror first, then the scan: jarvis_scan() reads don_enabled, so
    // refreshing it afterwards would leave every run reasoning about the
    // previous heartbeat's answer.
    await syncDonState(db)

    // Refresh the facts first. Worth doing even when he cannot speak: the event
    // table stays current, so the panel and the first message after quiet hours
    // both describe now rather than whenever he was last allowed to talk.
    const { data: pendingCount, error: scanErr } = await db.rpc('jarvis_apply_scan')
    if (scanErr) return json({ error: `scan failed: ${scanErr.message}` }, 500)

    if (!s?.jarvis_notify_enabled) return json({ ok: true, scanned: pendingCount, sent: false, reason: 'disabled' })

    const to = normalisePhone(s.jarvis_notify_number || '')
    if (!to) return json({ ok: true, scanned: pendingCount, sent: false, reason: 'no_valid_number' })

    const tz = s.jarvis_timezone || 'Australia/Sydney'
    if (inQuietHours(localHHMM(tz), String(s.jarvis_quiet_start), String(s.jarvis_quiet_end))) {
      // Held, not dropped. notified_at stays null so it goes out at 07:30
      // instead of being silently swallowed overnight.
      return json({ ok: true, scanned: pendingCount, sent: false, reason: 'quiet_hours' })
    }

    // The cap counts real sends in the last 24h. This is the one guard that
    // holds when everything else is wrong, so it is checked against what was
    // actually delivered rather than against anything the scan believes.
    const cap = Number(s.jarvis_daily_sms_cap ?? 10)
    if (cap <= 0) return json({ ok: true, scanned: pendingCount, sent: false, reason: 'cap_zero' })
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { count: sentToday } = await db
      .from('jarvis_notifications')
      .select('id', { count: 'exact', head: true })
      // Texts only: older rows include phone calls, which no longer exist.
      .eq('channel', 'sms')
      .eq('status', 'sent').gte('created_at', since)
    if ((sentToday ?? 0) >= cap) {
      return json({ ok: true, scanned: pendingCount, sent: false, reason: 'daily_cap_reached', cap })
    }

    // Jobs before alerts. Claimed one at a time so that a slow job leaves the
    // rest queued for the next heartbeat instead of claimed and then dropped.
    // Held (not claimed) through quiet hours and a spent cap, like alerts.
    let jobsRun = 0
    let sentSoFar = sentToday ?? 0
    const jobFrom = s.jarvis_from_number || s.twilio_from_number || Deno.env.get('TWILIO_FROM_NUMBER') || ''
    if (!dryRun && jobFrom) {
      const started = Date.now()
      while (jobsRun < MAX_JOBS_PER_BEAT && sentSoFar < cap && Date.now() - started < JOB_TIME_BUDGET_MS) {
        const { data: claimed, error: jobErr } = await db.rpc('jarvis_claim_due_jobs', { p_limit: 1, p_tz: tz })
        if (jobErr) { console.error('jarvis-notify: job claim failed:', jobErr.message); break }
        const job = (claimed || [])[0] as Job | undefined
        if (!job) break

        const report = await runJob(url, job)
        const text = `Jarvis - ${job.title}: ${report}`.slice(0, 640)
        const sent = await sendSms(to, jobFrom, text)
        await db.from('jarvis_notifications').insert({
          channel: 'sms', to_number: to, tier: 'job', body: text,
          twilio_sid: sent.sid,
          status: sent.ok ? 'sent' : 'failed',
          error: sent.ok ? null : sent.raw.slice(0, 500),
        })
        await db.from('jarvis_jobs').update({ last_result: report.slice(0, 2000) }).eq('id', job.id)
        jobsRun++
        if (sent.ok) sentSoFar++
      }
      if (sentSoFar >= cap) {
        return json({ ok: true, scanned: pendingCount, sent: jobsRun > 0, jobs: jobsRun, reason: 'daily_cap_reached', cap })
      }
    }

    const { data: events } = await db
      .from('jarvis_events')
      .select('id, kind, tier, subject, payload')
      .is('notified_at', null).is('resolved_at', null)
      .or(`snoozed_until.is.null,snoozed_until.lt.${new Date().toISOString()}`)
      .order('tier', { ascending: true })
      .order('first_seen_at', { ascending: true })
      .limit(20)

    const evs = (events || []) as Ev[]
    if (!evs.length) return json({ ok: true, scanned: pendingCount, sent: jobsRun > 0, jobs: jobsRun, reason: 'nothing_new' })

    // One message per run, never one per event - that is the difference between
    // a briefing and a phone going off six times in a row.
    const urgent = evs.filter((e) => e.tier === 'urgent')
    const rest = evs.filter((e) => e.tier !== 'urgent')
    const lead = urgent.length ? urgent : rest
    const shown = lead.slice(0, 3)
    const extra = evs.length - shown.length

    let text = shown.map(describe).join('\n')
    if (extra > 0) text += `\n+${extra} more waiting.`
    const bodyText = `Jarvis: ${text}`.slice(0, 480)
    const tier = urgent.length ? 'urgent' : 'notable'

    if (dryRun) {
      return json({ ok: true, scanned: pendingCount, sent: false, reason: 'dry_run', would_send: bodyText, to, events: evs.length })
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
    // His own number when he has one, so replies reach him rather than the
    // client agents' webhook; the main number until then, which still sends.
    const from = s.jarvis_from_number || s.twilio_from_number || Deno.env.get('TWILIO_FROM_NUMBER') || ''
    if (!from) return json({ error: 'no Twilio from-number configured' }, 500)

    const params = new URLSearchParams({ To: to, From: from, Body: bodyText })
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(accountSid + ':' + authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    )
    const raw = await res.text()
    let sid: string | null = null
    try { sid = JSON.parse(raw).sid || null } catch { /* keep raw for the log */ }

    await db.from('jarvis_notifications').insert({
      channel: 'sms', to_number: to, tier, body: bodyText,
      event_ids: evs.map((e) => e.id),
      twilio_sid: sid,
      status: res.ok ? 'sent' : 'failed',
      error: res.ok ? null : raw.slice(0, 500),
    })

    // Only mark them spoken if the text actually left. A failed send that
    // silently burns the events is how you find out about a problem never.
    if (res.ok) {
      await db.from('jarvis_events')
        .update({ notified_at: new Date().toISOString() })
        .in('id', evs.map((e) => e.id))
    }

    return json({
      ok: res.ok, scanned: pendingCount, sent: res.ok,
      events: evs.length, twilio_sid: sid, jobs: jobsRun,
      ...(res.ok ? {} : { error: raw.slice(0, 300) }),
    })
  } catch (err) {
    console.error('jarvis-notify error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
