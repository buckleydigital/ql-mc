/**
 * jarvis-voice-reply - what you say back on the call.
 *
 * jarvis-notify rings about something urgent, then ends with a <Gather>, so the
 * call does not just hang up on you. Twilio records what you say, transcribes
 * it, and posts the text here.
 *
 * The hard constraint is that Twilio wants TwiML back in about fifteen seconds,
 * and the tool loop can run longer than that. So this does NOT wait: it answers
 * the call immediately with "on it", dispatches the work to jarvis-reply, and
 * the confirmation arrives by SMS a moment later. You get a short call and a
 * written record, which is the right shape for both.
 *
 * Deliberately reuses jarvis-reply rather than duplicating the rules about
 * acting only on who was named - two copies of that logic is two chances to get
 * it wrong, on the one thing here that reaches real clients.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const twiml = (inner: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })

const xmlEscape = (v: string) =>
  v.replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string
  ))

function normalisePhone(raw: string): string {
  let p = (raw || '').replace(/[\s\-().]/g, '')
  if (p.startsWith('04')) p = '+61' + p.slice(1)
  else if (p.startsWith('614') && !p.startsWith('+')) p = '+' + p
  else if (p.startsWith('61') && !p.startsWith('+')) p = '+' + p
  return p
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const db = createClient(url, serviceKey)

  try {
    const params = new URLSearchParams(await req.text())
    const speech = (params.get('SpeechResult') || '').trim()
    // On an outbound call Twilio reports the person who answered as `To`.
    const answered = normalisePhone(params.get('To') || '')

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_notify_number, jarvis_call_voice')
      .limit(1).maybeSingle()
    const owner = normalisePhone(String(s?.jarvis_notify_number ?? ''))
    const voice = xmlEscape(String(s?.jarvis_call_voice || 'Polly.Brian-Neural'))

    // This endpoint is public because Twilio has to reach it. The gate is that
    // it only ever acts on a call that went to the owner's own number - a
    // stranger POSTing here gets a goodbye and nothing happens.
    if (!owner || answered !== owner) {
      console.warn('voice-reply: call not to the owner, ignoring:', answered)
      return twiml(`<Say voice="${voice}" language="en-GB">Goodbye.</Say>`)
    }

    // Said nothing, or Twilio heard nothing. Do not guess - just end politely.
    if (!speech) {
      return twiml(
        `<Say voice="${voice}" language="en-GB">Nothing heard. Details are in your messages. Goodbye.</Say>`,
      )
    }

    await db.from('jarvis_messages').insert({
      direction: 'inbound', body: speech,
      from_number: owner, to_number: null,
      context: { via: 'voice' },
    })

    // Fire and forget, for the fifteen-second reason above.
    const work = fetch(`${url}/functions/v1/jarvis-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ from: owner, body: speech }),
    }).catch((e) => console.error('voice-reply dispatch failed:', e))

    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (rt?.waitUntil) rt.waitUntil(work)

    // Repeat it back before hanging up. Speech recognition mangles company
    // names, and hearing the mangled version is the only chance you get to
    // notice before the email goes out.
    return twiml(
      `<Say voice="${voice}" language="en-GB">Understood: ${xmlEscape(speech.slice(0, 200))}. ` +
      `I will text you to confirm. Goodbye.</Say>`,
    )
  } catch (err) {
    console.error('jarvis-voice-reply error:', err)
    // Never leave the caller hanging on an exception.
    return twiml(`<Say>Something went wrong. Goodbye.</Say>`)
  }
})
