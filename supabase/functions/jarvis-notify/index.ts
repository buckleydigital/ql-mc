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

Deno.serve(async (req: Request) => {
  // No public surface. The only callers are pg_cron (via pg_net, with the
  // service key) and a human testing it with the same key. Checked here rather
  // than relying on verify_jwt, because a cron has no user JWT to present.
  const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  if (!auth || auth !== serviceKey) return json({ error: 'unauthorized' }, 401)

  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey)

  try {
    const body = await req.json().catch(() => ({}))
    // dry_run exercises the whole path and reports what it WOULD send, so the
    // first live test cannot put a real text on a real phone.
    const dryRun = body?.dry_run === true

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_notify_number, jarvis_notify_enabled, jarvis_timezone, jarvis_quiet_start, jarvis_quiet_end, jarvis_daily_sms_cap, twilio_from_number')
      .limit(1).maybeSingle()

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
      .eq('status', 'sent').gte('created_at', since)
    if ((sentToday ?? 0) >= cap) {
      return json({ ok: true, scanned: pendingCount, sent: false, reason: 'daily_cap_reached', cap })
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
    if (!evs.length) return json({ ok: true, scanned: pendingCount, sent: false, reason: 'nothing_new' })

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
    const from = s.twilio_from_number || Deno.env.get('TWILIO_FROM_NUMBER') || ''
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
      events: evs.length, twilio_sid: sid,
      ...(res.ok ? {} : { error: raw.slice(0, 300) }),
    })
  } catch (err) {
    console.error('jarvis-notify error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
