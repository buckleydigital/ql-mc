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

// Spoken, not written. A phone call gets one or two sentences, said twice with
// a pause - people miss the first seconds answering, and there is no scrollback
// on a voice call. Punctuation is doing real work here: it is what makes the
// difference between a readout and a sentence.
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
      .select('jarvis_notify_number, jarvis_notify_enabled, jarvis_timezone, jarvis_quiet_start, jarvis_quiet_end, jarvis_daily_sms_cap, twilio_from_number, jarvis_from_number, jarvis_call_enabled, jarvis_call_cap, jarvis_call_voice')
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
      // Texts only. A call is logged here too and is always accompanied by a
      // text, so counting both would burn the SMS cap at twice the rate and
      // silence him after five urgent events instead of ten.
      .eq('channel', 'sms')
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

    // ── The phone call ────────────────────────────────────────────────────
    // Urgent only, and never instead of the text: the SMS is the record you
    // can re-read, the call is the interrupt. Quiet hours already returned
    // above, so reaching here means it is a reasonable hour to ring.
    //
    // Two-way, but only just: he says the thing, listens once, and hangs up.
    // Twilio's own speech recognition does the listening (see the Gather
    // below), so there is still no media stream and no realtime audio here.
    // One turn is the right amount - the point is to say "chase Sandford and
    // Everlite" and get on with your day, not to hold a conversation.
    let callSid: string | null = null
    let callError: string | null = null
    if (res.ok && tier === 'urgent' && s.jarvis_call_enabled === true) {
      const callCap = Number(s.jarvis_call_cap ?? 3)
      const { count: callsToday } = await db
        .from('jarvis_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('channel', 'call').eq('status', 'sent').gte('created_at', since)

      // He must never ring a client. That is true by construction today - `to`
      // is read from jarvis_notify_number and nothing else writes it, and no
      // tool he has can dial at all - but "true by construction" quietly stops
      // being true the first time someone refactors this block.
      //
      // So it is asserted rather than assumed: the number about to be dialled
      // is compared against the configured owner number immediately before the
      // call goes out. A mismatch means something upstream is wrong, and the
      // right response to that is no call at all.
      const ownerCheck = normalisePhone(s.jarvis_notify_number || '')
      if (!ownerCheck || to !== ownerCheck) {
        console.error('refusing to dial: destination is not the configured owner number')
        return json({ ok: true, scanned: pendingCount, sent: true, called: false, reason: 'dial_guard' })
      }

      if (callCap > 0 && (callsToday ?? 0) < callCap) {
        const voice = String(s.jarvis_call_voice || 'Polly.Brian-Neural')
        const line = speakable(shown.map(describe), extra)
        const spoken = xmlEscape(line)

        // Twilio's own Polly neural voice, which is included in the call price
        // and needs no second provider to be reachable for the call to happen.
        //
        // Said twice with a pause between, because the first seconds of an
        // answered call are spent saying "hello".
        //
        // Then it listens, rather than hanging up on you.
        //
        // <Gather input="speech"> is the whole trick: Twilio does the speech
        // recognition itself and posts the transcript to jarvis-voice-reply, so
        // there is no media stream, no websocket and no realtime audio to run.
        // speechTimeout="auto" ends the turn when you stop talking instead of
        // after a fixed count, which is the difference between a conversation
        // and a countdown.
        //
        // The whole message is said once inside the Gather, so talking over it
        // is allowed - barge-in is what makes it feel like a person rather than
        // an answering machine. If nothing is said, the Gather falls through to
        // the goodbye after it.
        const askLine = 'Anything you would like me to do?'
        const gatherBody =
          `<Say voice="${xmlEscape(voice)}" language="en-GB">${spoken}</Say>` +
          `<Say voice="${xmlEscape(voice)}" language="en-GB">${xmlEscape(askLine)}</Say>`

        const replyUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/jarvis-voice-reply`
        const twiml =
          `<Response><Pause length="1"/>` +
          `<Gather input="speech" language="en-AU" speechTimeout="auto" ` +
          `action="${xmlEscape(replyUrl)}" method="POST">` +
          gatherBody +
          `</Gather>` +
          // Reached only when nothing was said: repeat once, then let them go.
          `<Say voice="${xmlEscape(voice)}" language="en-GB">${spoken}</Say>` +
          `<Say voice="${xmlEscape(voice)}" language="en-GB">Details are in your messages. Goodbye.</Say>` +
          `</Response>`

        const callRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Basic ' + btoa(accountSid + ':' + authToken),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ To: to, From: from, Twiml: twiml }).toString(),
          },
        )
        const callRaw = await callRes.text()
        try { callSid = JSON.parse(callRaw).sid || null } catch { /* keep raw */ }
        if (!callRes.ok) callError = callRaw.slice(0, 300)

        await db.from('jarvis_notifications').insert({
          channel: 'call', to_number: to, tier,
          body: line,
          event_ids: evs.map((e) => e.id),
          twilio_sid: callSid,
          status: callRes.ok ? 'sent' : 'failed',
          error: callRes.ok ? null : callRaw.slice(0, 500),
        })
      }
    }

    // Only mark them spoken if the text actually left. A failed send that
    // silently burns the events is how you find out about a problem never.
    // The call is deliberately not part of this test: the SMS is the delivery
    // that counts, and a failed call must not re-announce everything next run.
    if (res.ok) {
      await db.from('jarvis_events')
        .update({ notified_at: new Date().toISOString() })
        .in('id', evs.map((e) => e.id))
    }

    return json({
      ok: res.ok, scanned: pendingCount, sent: res.ok,
      events: evs.length, twilio_sid: sid,
      ...(callSid ? { called: true, call_sid: callSid } : {}),
      ...(callError ? { call_error: callError } : {}),
      ...(res.ok ? {} : { error: raw.slice(0, 300) }),
    })
  } catch (err) {
    console.error('jarvis-notify error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
