/**
 * jarvis-voice-reply - what you say back on one of his calls.
 *
 * jarvis-notify rings about something urgent (when calls are switched on in
 * Jarvis settings), from the business's main Twilio number, and ends with a
 * <Gather>. Twilio transcribes what you say and posts the text here. The URL
 * is set inside the call itself, so the main number's own voice webhook is
 * not involved.
 *
 * Twilio wants TwiML back in about fifteen seconds and the tool loop can run
 * longer, so this answers the call at once, hands the words to jarvis-reply,
 * and the result arrives in the panel (and by text when texts are on).
 *
 * Public, because Twilio has to reach it. The gate is that it only acts on a
 * call that went to the owner's own number.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { noEmDash } from '../_shared/no-em-dash.ts'

const twiml = (inner: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${noEmDash(inner)}</Response>`, {
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
      .select('jarvis_notify_number, jarvis_notify_enabled, jarvis_call_enabled, jarvis_call_voice')
      .limit(1).maybeSingle()
    const owner = normalisePhone(String(s?.jarvis_notify_number ?? ''))
    const voice = xmlEscape(String(s?.jarvis_call_voice || 'Polly.Brian-Neural'))
    const say = (t: string) => `<Say voice="${voice}" language="en-GB">${t}</Say>`

    // A stranger POSTing here, or calls switched off since, gets a goodbye and
    // nothing happens.
    if (!owner || answered !== owner || s?.jarvis_call_enabled !== true) {
      console.warn('voice-reply: not an owner call, or calls are off; ignoring')
      return twiml(say('Goodbye.'))
    }

    const where = s?.jarvis_notify_enabled === true ? 'I will text you to confirm.' : 'I will confirm in the Jarvis panel.'

    if (!speech) {
      return twiml(say('Nothing heard. Goodbye.'))
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
      body: JSON.stringify({ from: owner, body: speech, via: 'voice' }),
    }).catch((e) => console.error('voice-reply dispatch failed:', e))

    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (rt?.waitUntil) rt.waitUntil(work)

    // Repeat it back before hanging up. Speech recognition mangles company
    // names, and hearing the mangled version is the chance to notice.
    return twiml(say(`Understood: ${xmlEscape(speech.slice(0, 200))}. ${where} Goodbye.`))
  } catch (err) {
    console.error('jarvis-voice-reply error:', err)
    return twiml(`<Say>Something went wrong. Goodbye.</Say>`)
  }
})
