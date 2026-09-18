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

// Render the line in Jarvis's actual voice and hand back a URL Twilio can pull.
//
// Returns null on any failure, and the caller falls back to Twilio's own Polly
// voice. That is the whole point of the design: the call still happens if
// ElevenLabs is down, out of credits, or has stopped recognising the voice id.
// An alert that does not arrive because the nice voice was unavailable would be
// a worse outcome than an alert in a plain one.
//
// The clip is uploaded to a PRIVATE bucket and handed over as a signed URL that
// expires in ten minutes. It names clients and says what is wrong with them, so
// it does not belong on a public URL just because the filename is a uuid.
async function renderVoiceLine(
  // deno-lint-ignore no-explicit-any
  db: any,
  text: string,
): Promise<string | null> {
  const key = Deno.env.get('ELEVENLABS_API_KEY')
  if (!key) return null
  const voice = Deno.env.get('ELEVENLABS_VOICE_ID') ?? Deno.env.get('JARVIS_VOICE_ID') ?? 'Y6FMJQzB8Hprka91pf7R'
  try {
    // mp3 at 22kHz: a phone line is 8kHz anyway, so anything higher is bytes
    // spent on detail the call will throw away.
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
        }),
      },
    )
    if (!res.ok) {
      console.warn('elevenlabs render failed:', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const path = `call-${crypto.randomUUID()}.mp3`
    const { error: upErr } = await db.storage.from('jarvis-audio')
      .upload(path, bytes, { contentType: 'audio/mpeg', upsert: false })
    if (upErr) { console.warn('audio upload failed:', upErr.message); return null }

    const { data: signed, error: signErr } = await db.storage.from('jarvis-audio')
      .createSignedUrl(path, 600)
    if (signErr || !signed?.signedUrl) { console.warn('sign failed:', signErr?.message); return null }
    return signed.signedUrl as string
  } catch (err) {
    console.warn('renderVoiceLine error:', err instanceof Error ? err.message : err)
    return null
  }
}

// Old clips are rubbish the moment the call ends; Storage has no expiry of its
// own, so they are swept on the way past rather than left to accumulate.
// deno-lint-ignore no-explicit-any
async function pruneVoiceClips(db: any) {
  try {
    const { data: files } = await db.storage.from('jarvis-audio').list('', { limit: 100 })
    const cutoff = Date.now() - 3600_000
    const stale = (files || [])
      .filter((f: { name: string; created_at?: string }) =>
        f.created_at ? new Date(f.created_at).getTime() < cutoff : false)
      .map((f: { name: string }) => f.name)
    if (stale.length) await db.storage.from('jarvis-audio').remove(stale)
  } catch { /* housekeeping, never worth failing a run over */ }
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
    // Deliberately one-way. He says the thing and hangs up - no media stream,
    // no speech recognition, no conversation. That is a different and much
    // larger project, and for "a client wants to go ahead" it adds nothing:
    // you are going to ring the client, not argue with Jarvis.
    let callSid: string | null = null
    let callError: string | null = null
    if (res.ok && tier === 'urgent' && s.jarvis_call_enabled === true) {
      const callCap = Number(s.jarvis_call_cap ?? 3)
      const { count: callsToday } = await db
        .from('jarvis_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('channel', 'call').eq('status', 'sent').gte('created_at', since)

      if (callCap > 0 && (callsToday ?? 0) < callCap) {
        const voice = String(s.jarvis_call_voice || 'Polly.Brian-Neural')
        const line = speakable(shown.map(describe), extra)
        const spoken = xmlEscape(line)

        // Jarvis's own voice when ElevenLabs can render it, Twilio's Polly when
        // it cannot. Said twice with a pause between either way, because the
        // first seconds of an answered call are spent saying "hello".
        const clip = await renderVoiceLine(db, `${line} Details are in your messages.`)
        const twiml = clip
          ? `<Response><Pause length="1"/>` +
            `<Play>${xmlEscape(clip)}</Play>` +
            `<Pause length="1"/>` +
            `<Play>${xmlEscape(clip)}</Play>` +
            `</Response>`
          : `<Response><Pause length="1"/>` +
            `<Say voice="${xmlEscape(voice)}" language="en-GB">${spoken}</Say>` +
            `<Pause length="1"/>` +
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

        await pruneVoiceClips(db)
        await db.from('jarvis_notifications').insert({
          channel: 'call', to_number: to, tier,
          body: (clip ? '[elevenlabs] ' : '[polly] ') + line,
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
