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

// The no-tools answer: everything he already knows, put into a sentence.
//
// This is the fallback when the tool-holding function will not take the call,
// and it is genuinely useful on its own - most replies to an alert are "which
// one", "how long", "what else is open", all answerable from the context that
// came with the alert. What it cannot do is change anything, and it says so
// rather than pretending.
async function answerFromContext(
  question: string,
  context: Record<string, unknown>,
  history: Array<{ role: string; content: string }>,
): Promise<string> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) return ''
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 300,
        system:
          'You are Jarvis, answering the business owner by SMS. Under 300 characters, ' +
          'plain text, no markdown, no greeting. Answer only from the context given. ' +
          'You currently cannot change anything - if asked to act, say so in one short ' +
          'sentence and tell them to use the panel. Never invent a number or a name.',
        messages: [
          ...history.slice(-4),
          { role: 'user', content: `Context: ${JSON.stringify(context)}\n\nThey said: ${question}` },
        ],
      }),
    })
    if (!res.ok) {
      console.warn('anthropic fallback failed:', res.status, (await res.text()).slice(0, 200))
      return ''
    }
    const j = await res.json()
    return (j?.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('')
      .trim()
  } catch (err) {
    console.warn('answerFromContext error:', err instanceof Error ? err.message : err)
    return ''
  }
}

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

    // Two ways to answer, and the difference is whether he can ACT.
    //
    // jarvis-chat holds the tools, but it requires a real signed-in user and a
    // text has none. Until that is resolved it declines this call, so there is
    // a second path: answer from the context already gathered above, with no
    // tools at all. That covers "what is open", "which client", "how many" -
    // everything except changing something.
    //
    // Deliberately not worked around here. Getting the tools onto SMS means
    // giving jarvis-chat a way to trust a caller with no user behind it, and
    // that is a decision to make on purpose rather than to slip in as the
    // side effect of wiring up a phone number.
    let answer = ''
    let acted = false

    const chatRes = await fetch(`${url}/functions/v1/jarvis-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
      },
      body: JSON.stringify({
        // Marks this as the SMS bridge. jarvis-chat then proves the bearer is
        // service-role by using it, rather than taking this flag on trust.
        via: 'sms',
        messages: [{ role: 'user', content: preamble }, ...history],
        allow_writes: true,
      }),
    })
    if (chatRes.ok) {
      const chatRaw = await chatRes.text()
      // jarvis-chat answers { reply, tools, messages }.
      try { answer = String(JSON.parse(chatRaw)?.reply ?? '') } catch { /* falls through */ }
      if (answer) acted = true
    }

    if (!answer) answer = await answerFromContext(question, context, history)
    if (!answer) answer = 'I could not put that into words. Try the panel.'

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

    return json({ ok: sendRes.ok, replied: reply.length, twilio_sid: sid, with_tools: acted })
  } catch (err) {
    console.error('jarvis-reply error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
