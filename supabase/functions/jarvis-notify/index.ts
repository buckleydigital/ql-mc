/**
 * jarvis-notify - the heartbeat.
 *
 * Runs on a schedule, asks the watchers what is wrong, and leaves one note in
 * the Jarvis panel about anything new. This is what turns Jarvis from
 * something you open into something that speaks first.
 *
 * The panel note is always written (channel 'panel', shown unread in the
 * dashboard). On top of that, two switches in Jarvis settings put him on your
 * phone again:
 *
 *   - Texts (jarvis_notify_enabled): new alerts are texted to the owner.
 *   - Calls (jarvis_call_enabled): urgent alerts also ring the owner, who can
 *     answer out loud (jarvis-voice-reply picks up what was said).
 *
 * Both go out from the business's main Twilio number (twilio_from_number),
 * not a separate Jarvis number. Quiet hours hold them, the daily caps bound
 * them, and only ever to jarvis_notify_number. Which events have been dealt
 * with on the phone is tracked apart from the panel (phone_handled_at), so a
 * text held overnight still goes out in the morning.
 *
 * Composition is deliberately deterministic rather than a Claude call. These
 * are factual alerts about money and clients; a model paraphrasing "3 overdue"
 * is a downside with no matching upside, and it would put a paid API call and a
 * network failure in the path of every heartbeat. Jarvis's voice lives in the
 * templates. Phrasing can move to a model later without touching detection.
 *
 * It never calls a model. It used to run Jarvis's scheduled jobs through
 * jarvis-chat; those were removed on 9 Oct so Jarvis only spends API credit
 * when someone asks him something.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import '../_shared/no-em-dash.ts'

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
// to do, so a note reads at a glance.
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

// Spoken, not written. Said with "Sir" in front, the way he talks, and the
// rest counted rather than read out - there is no scrollback on a call.
function speakable(lines: string[], extra: number): string {
  const body = lines.join(' ')
  const tail = extra > 0 ? ` And ${extra} more ${extra === 1 ? 'item' : 'items'} waiting.` : ''
  return `Sir. ${body}${tail}`
}

// TwiML is XML, so anything interpolated into it has to be escaped or a client
// named "Smith & Sons" truncates the call.
function xmlEscape(v: string): string {
  return v.replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string
  ))
}

// Wall-clock time where the person is, not where the server is. A cron running
// in UTC must not get to decide that 4am Sydney is a reasonable hour.
function localHHMM(tz: string, now = new Date()): string {
  const fmt = (zone: string) => new Intl.DateTimeFormat('en-AU', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now)
  try { return fmt(tz) } catch { return fmt('Australia/Sydney') }
}

// Quiet hours normally wrap midnight (20:00 -> 07:30), so this is an OR across
// the wrap rather than a plain between.
function inQuietHours(nowHHMM: string, start: string, end: string): boolean {
  const s = (start || '20:00').slice(0, 5)
  const e = (end || '07:30').slice(0, 5)
  if (s === e) return false
  return s > e ? (nowHHMM >= s || nowHHMM < e) : (nowHHMM >= s && nowHHMM < e)
}

async function twilio(path: 'Messages' | 'Calls', params: Record<string, string>) {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/${path}.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(accountSid + ':' + authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    },
  )
  const raw = await res.text()
  let sid: string | null = null
  try { sid = JSON.parse(raw).sid || null } catch { /* keep raw for the log */ }
  return { ok: res.ok, sid, raw }
}

type Settings = {
  jarvis_notify_number: string | null
  jarvis_notify_enabled: boolean | null
  jarvis_call_enabled: boolean | null
  jarvis_quiet_start: string | null
  jarvis_quiet_end: string | null
  jarvis_daily_sms_cap: number | null
  jarvis_call_cap: number | null
  jarvis_call_voice: string | null
  twilio_from_number: string | null
}

// ── Your phone ───────────────────────────────────────────────────────────────
// Texts and calls about open events not yet dealt with on the phone. Separate
// from the panel note so quiet hours and the caps can hold a text without
// holding the note.
// deno-lint-ignore no-explicit-any
async function phoneOwner(db: any, s: Settings | null, tz: string, dryRun: boolean) {
  const textOn = s?.jarvis_notify_enabled === true
  const callOn = s?.jarvis_call_enabled === true

  const { data: events } = await db
    .from('jarvis_events')
    .select('id, kind, tier, subject, payload')
    .is('phone_handled_at', null).is('resolved_at', null)
    .or(`snoozed_until.is.null,snoozed_until.lt.${new Date().toISOString()}`)
    .order('tier', { ascending: true })
    .order('first_seen_at', { ascending: true })
    .limit(20)
  let evs = (events || []) as Ev[]
  if (!evs.length) return { phoned: false, reason: 'nothing_new' }

  const markHandled = async (ids: string[]) => {
    if (dryRun || !ids.length) return
    await db.from('jarvis_events').update({ phone_handled_at: new Date().toISOString() }).in('id', ids)
  }

  // Off is off: whatever came up meanwhile is marked dealt with, so switching
  // texts on later does not empty a week of backlog onto your phone at once.
  if (!textOn && !callOn) {
    await markHandled(evs.map((e) => e.id))
    return { phoned: false, reason: 'phone_off' }
  }
  // Calls only, no texts: only urgent items ring, so the rest are done with.
  if (!textOn) {
    await markHandled(evs.filter((e) => e.tier !== 'urgent').map((e) => e.id))
    evs = evs.filter((e) => e.tier === 'urgent')
    if (!evs.length) return { phoned: false, reason: 'nothing_urgent' }
  }

  const to = normalisePhone(s?.jarvis_notify_number || '')
  if (!to) return { phoned: false, reason: 'no_valid_number' }

  // The business's main Twilio number - the one the clients and leads see -
  // rather than a number of his own.
  const from = s?.twilio_from_number || Deno.env.get('TWILIO_FROM_NUMBER') || ''
  if (!from) return { phoned: false, reason: 'no_twilio_number' }

  if (inQuietHours(localHHMM(tz), String(s?.jarvis_quiet_start ?? ''), String(s?.jarvis_quiet_end ?? ''))) {
    // Held, not dropped: phone_handled_at stays null, so it goes out when
    // quiet hours end.
    return { phoned: false, reason: 'quiet_hours' }
  }

  // The caps count real sends in the last 24 hours. They are the guard that
  // holds when everything else is wrong.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const sentToday = async (channel: string) => {
    const { count } = await db.from('jarvis_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('channel', channel).eq('status', 'sent').gte('created_at', since)
    return count ?? 0
  }

  const urgent = evs.filter((e) => e.tier === 'urgent')
  const rest = evs.filter((e) => e.tier !== 'urgent')
  const lead = urgent.length ? urgent : rest
  const shown = lead.slice(0, 3)
  const extra = evs.length - shown.length
  const tier = urgent.length ? 'urgent' : 'notable'
  const ids = evs.map((e) => e.id)

  // ── The text ──
  let texted = false
  let textError: string | null = null
  let textBody: string | null = null
  if (textOn) {
    const cap = Number(s?.jarvis_daily_sms_cap ?? 10)
    if (cap <= 0 || (await sentToday('sms')) >= cap) {
      return { phoned: false, reason: 'daily_text_cap_reached', cap }
    }
    let text = shown.map(describe).join('\n')
    if (extra > 0) text += `\n+${extra} more waiting.`
    // Replies to the main number go to the client agents, not to him, so he
    // says where to answer.
    textBody = `Jarvis: ${text}\nReply in the Jarvis panel.`.slice(0, 480)
    if (!dryRun) {
      const res = await twilio('Messages', { To: to, From: from, Body: textBody })
      await db.from('jarvis_notifications').insert({
        channel: 'sms', to_number: to, tier, body: textBody, event_ids: ids,
        twilio_sid: res.sid, status: res.ok ? 'sent' : 'failed',
        error: res.ok ? null : res.raw.slice(0, 500),
      })
      texted = res.ok
      if (!res.ok) textError = res.raw.slice(0, 300)
    }
  }

  // ── The call ── urgent only, and never instead of a text that failed: a
  // failed text is retried next heartbeat, and ringing every 15 minutes
  // alongside it would be worse than not ringing at all.
  let called = false
  let callError: string | null = null
  let spokenLine: string | null = null
  if (callOn && urgent.length && (!textOn || texted || dryRun)) {
    const callCap = Number(s?.jarvis_call_cap ?? 3)
    // He must never ring a client. `to` is read from jarvis_notify_number and
    // nothing else, but that is asserted here rather than assumed, right before
    // the call goes out.
    const ownerCheck = normalisePhone(s?.jarvis_notify_number || '')
    if (!ownerCheck || to !== ownerCheck) {
      console.error('refusing to dial: destination is not the configured owner number')
    } else if (callCap > 0 && (await sentToday('call')) < callCap) {
      const voice = xmlEscape(String(s?.jarvis_call_voice || 'Polly.Brian-Neural'))
      const urgentShown = urgent.slice(0, 3)
      spokenLine = speakable(urgentShown.map(describe), urgent.length - urgentShown.length)
      const spoken = xmlEscape(spokenLine)
      const say = (t: string) => `<Say voice="${voice}" language="en-GB">${t}</Say>`

      // Twilio's Polly voice is included in the call price. <Gather
      // input="speech"> has Twilio transcribe the answer and post it to
      // jarvis-voice-reply, so there is no media stream to run. The action
      // URL travels with the call, so it works from the main number without
      // touching that number's own voice webhook. Barge-in is allowed; if
      // nothing is said it repeats once and says goodbye.
      const replyUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/jarvis-voice-reply`
      const twiml =
        `<Response><Pause length="1"/>` +
        `<Gather input="speech" language="en-AU" speechTimeout="auto" ` +
        `action="${xmlEscape(replyUrl)}" method="POST">` +
        say(spoken) + say('Anything you would like me to do?') +
        `</Gather>` +
        say(spoken) +
        say(textOn ? 'Details are in your messages. Goodbye.' : 'Details are in the Jarvis panel. Goodbye.') +
        `</Response>`

      if (!dryRun) {
        const res = await twilio('Calls', { To: to, From: from, Twiml: twiml })
        await db.from('jarvis_notifications').insert({
          channel: 'call', to_number: to, tier, body: spokenLine, event_ids: urgent.map((e) => e.id),
          twilio_sid: res.sid, status: res.ok ? 'sent' : 'failed',
          error: res.ok ? null : res.raw.slice(0, 500),
        })
        called = res.ok
        if (!res.ok) callError = res.raw.slice(0, 300)
      }
    }
  }

  if (dryRun) {
    return { phoned: false, reason: 'dry_run', to, from, would_text: textBody, would_call: spokenLine }
  }

  // Dealt with when the text left. With texts off, a call is a single try:
  // a failed or capped call is not retried every 15 minutes.
  if (texted || !textOn) await markHandled(ids)

  return {
    phoned: texted || called, texted, called,
    ...(textError ? { text_error: textError } : {}),
    ...(callError ? { call_error: callError } : {}),
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

Deno.serve(async (req: Request) => {
  // No public surface. The only callers are pg_cron (via pg_net) and a human
  // testing with the same key. Checked here rather than by verify_jwt, because
  // a cron has no user JWT to present.
  //
  // The check is a capability test, not a string compare: the presented key is
  // used to read jarvis_events, which is revoked from anon and authenticated
  // and forces RLS with no policies. Only a service-role key can read it, so a
  // successful read IS the proof of authority.
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
    // dry_run reports what it WOULD leave in the panel, text and say, and
    // writes and sends nothing.
    const dryRun = body?.dry_run === true

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_timezone, jarvis_notify_number, jarvis_notify_enabled, jarvis_call_enabled, jarvis_quiet_start, jarvis_quiet_end, jarvis_daily_sms_cap, jarvis_call_cap, jarvis_call_voice, twilio_from_number')
      .limit(1).maybeSingle()
    const tz = s?.jarvis_timezone || 'Australia/Sydney'

    // The mirror first, then the scan: jarvis_scan() reads don_enabled, so
    // refreshing it afterwards would leave every run reasoning about the
    // previous heartbeat's answer.
    await syncDonState(db)

    const { data: pendingCount, error: scanErr } = await db.rpc('jarvis_apply_scan')
    if (scanErr) return json({ error: `scan failed: ${scanErr.message}` }, 500)

    const note = (tier: string, text: string, eventIds: string[] = []) =>
      db.from('jarvis_notifications').insert({
        channel: 'panel', to_number: 'panel', tier, body: text, event_ids: eventIds, status: 'sent',
      })

    const { data: events } = await db
      .from('jarvis_events')
      .select('id, kind, tier, subject, payload')
      .is('notified_at', null).is('resolved_at', null)
      .or(`snoozed_until.is.null,snoozed_until.lt.${new Date().toISOString()}`)
      .order('tier', { ascending: true })
      .order('first_seen_at', { ascending: true })
      .limit(20)

    const evs = (events || []) as Ev[]

    // The panel note: one per run, never one per event. Urgent ones first.
    let panel: Record<string, unknown> = { noted: false, reason: 'nothing_new' }
    if (evs.length) {
      const urgent = evs.filter((e) => e.tier === 'urgent')
      const rest = evs.filter((e) => e.tier !== 'urgent')
      const text = [...urgent, ...rest].map(describe).join('\n')
      const tier = urgent.length ? 'urgent' : 'notable'
      if (dryRun) {
        panel = { noted: false, reason: 'dry_run', would_note: text, events: evs.length }
      } else {
        const { error: noteErr } = await note(tier, text, evs.map((e) => e.id))
        // Only mark them told if the note was saved. A failed write that
        // silently burns the events is how you find out about a problem never.
        if (!noteErr) {
          await db.from('jarvis_events')
            .update({ notified_at: new Date().toISOString() })
            .in('id', evs.map((e) => e.id))
        }
        panel = { noted: !noteErr, events: evs.length, ...(noteErr ? { error: noteErr.message } : {}) }
      }
    }

    // Then your phone, if texts or calls are switched on.
    const phone = await phoneOwner(db, s as Settings | null, tz, dryRun)

    return json({ ok: !panel.error, scanned: pendingCount, ...panel, phone })
  } catch (err) {
    console.error('jarvis-notify error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
