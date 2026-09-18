/**
 * jarvis-reply - answering a text you sent him.
 *
 * Split out from twilio-inbound-sms for one hard reason: Twilio gives a webhook
 * about fifteen seconds before it gives up, and the Claude tool loop can run
 * well past that when it has to look something up. So the webhook stores the
 * message, kicks this off without waiting, and answers Twilio immediately. The
 * reply comes back as a fresh outbound SMS rather than as the webhook response.
 *
 * The side effect is that he can take half a minute to answer a hard question,
 * which is the right trade - a late answer beats a truncated one, and it is how
 * texting a person works anyway.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  // Same capability test as jarvis-notify: prove the caller holds a key that
  // can read a table only service_role can read, rather than comparing against
  // an env var whose value the runtime does not always agree about.
  const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const caller = createClient(url, auth)
  const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'unauthorized' }, 401)

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { from, body: text } = await req.json().catch(() => ({}))
    const question = String(text ?? '').trim()
    if (!question) return json({ ok: true, reason: 'empty' })

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_from_number, jarvis_notify_number, twilio_from_number')
      .limit(1).maybeSingle()

    // Only ever answers the owner's own number. The webhook checks this too;
    // it is repeated here because this function can be called directly and a
    // reply that goes to whoever asked would leak the whole business.
    const owner = String(s?.jarvis_notify_number ?? '').replace(/[\s\-().]/g, '')
    const sender = String(from ?? '').replace(/[\s\-().]/g, '')
    const ownerE164 = owner.startsWith('0') ? '+61' + owner.slice(1) : owner
    if (!ownerE164 || sender !== ownerE164) {
      return json({ ok: true, reason: 'not_the_owner' })
    }

    // What he last raised, so "sort it" and "which one" resolve to something.
    // Only open events and only the last message: an SMS reply is about the
    // thing that just buzzed, not about the whole history.
    const { data: lastNote } = await db
      .from('jarvis_notifications')
      .select('body, created_at')
      .eq('channel', 'sms').eq('status', 'sent')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()

    const { data: openEvents } = await db
      .from('jarvis_events')
      .select('kind, subject, tier, payload')
      .is('resolved_at', null)
      .order('first_seen_at', { ascending: true }).limit(10)

    const context = {
      last_alert: lastNote?.body ?? null,
      last_alert_at: lastNote?.created_at ?? null,
      open_items: (openEvents || []).map((e: Record<string, unknown>) => ({
        kind: e.kind, subject: e.subject, tier: e.tier,
      })),
    }

    await db.from('jarvis_messages').insert({
      direction: 'inbound', body: question,
      from_number: sender, to_number: s?.jarvis_from_number ?? null,
      context,
    })

    // Recent turns, so a two-message exchange is a conversation rather than
    // two unrelated questions. Kept short: SMS threads are not transcripts.
    const { data: recent } = await db
      .from('jarvis_messages')
      .select('direction, body')
      .order('created_at', { ascending: false }).limit(8)
    const history = (recent || []).reverse().map((m: { direction: string; body: string }) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }))

    const preamble =
      `You are answering by SMS, so keep it under 300 characters, plain text, no markdown. ` +
      `Context you alerted about: ${JSON.stringify(context)}. ` +
      `If asked to do something, do it with your tools and confirm briefly what you did. ` +
      `If the request is unclear or would affect a client, ask one short question first.`

    const chatRes = await fetch(`${url}/functions/v1/jarvis-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
      },
      body: JSON.stringify({
        via: 'sms',
        messages: [{ role: 'user', content: preamble }, ...history],
        // Internal changes only. He can move a stage or tick a task from a
        // text; anything that reaches a client is not something to authorise
        // on the strength of a phone number, which is all an SMS proves.
        allow_writes: true,
      }),
    })
    const chatRaw = await chatRes.text()
    let answer = ''
    // jarvis-chat answers { reply, tools, messages }.
    try { answer = String(JSON.parse(chatRaw)?.reply ?? '') } catch { /* handled below */ }
    if (!answer) answer = chatRes.ok ? 'I could not put that into words. Try the panel.' : 'I could not reach my tools just now.'

    const reply = answer.slice(0, 300)

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
    const fromNum = s?.jarvis_from_number || s?.twilio_from_number || ''
    const sendRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(accountSid + ':' + authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: ownerE164, From: fromNum, Body: reply }).toString(),
      },
    )
    const sendRaw = await sendRes.text()
    let sid: string | null = null
    try { sid = JSON.parse(sendRaw).sid || null } catch { /* keep raw */ }

    await db.from('jarvis_messages').insert({
      direction: 'outbound', body: reply,
      from_number: fromNum, to_number: ownerE164,
      twilio_sid: sid,
      handled_at: new Date().toISOString(),
      error: sendRes.ok ? null : sendRaw.slice(0, 400),
    })

    return json({ ok: sendRes.ok, replied: reply.length, twilio_sid: sid })
  } catch (err) {
    console.error('jarvis-reply error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
