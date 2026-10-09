/**
 * jarvis-reply - acting on something you said back to him.
 *
 * Reached from jarvis-voice-reply (what you said on one of his calls) and from
 * twilio-inbound-sms (a text to a dedicated Jarvis number, if one is ever set
 * again), and from QL HQ's twilio-inbound-sms (your reply to the main number,
 * which is HQ's AI SMS number and so rings HQ's webhook). Split out because
 * Twilio gives a webhook about fifteen seconds and the Claude tool loop can
 * run past that: the webhook answers Twilio at once and this does the work.
 *
 * The answer always lands in the Jarvis panel, and a text is always answered
 * by text from the business's main Twilio number. A spoken reply is also
 * confirmed by text when texts are switched on in Jarvis settings.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import '../_shared/no-em-dash.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  const url = Deno.env.get('SUPABASE_URL')!

  // QL HQ forwards your texts here: Jarvis texts from the number HQ's AI SMS
  // agent uses, so replies to him land on HQ's webhook. HQ proves itself with
  // the same shared secret it already uses for sync-sales-conversation.
  const apiSecret = Deno.env.get('QL_MC_API_SECRET')
  const fromHq = !!apiSecret && req.headers.get('x-api-secret') === apiSecret

  if (!fromHq) {
    // Same capability test as jarvis-notify: prove the caller holds a key that
    // can read a table only service_role can read.
    const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
    if (!auth) return json({ error: 'unauthorized' }, 401)
    const caller = createClient(url, auth)
    const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
    if (capErr) return json({ error: 'unauthorized' }, 401)
  }

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { from, body: text, via } = await req.json().catch(() => ({}))
    const question = String(text ?? '').trim()
    if (!question) return json({ ok: true, reason: 'empty' })

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_notify_number, jarvis_notify_enabled, twilio_from_number')
      .limit(1).maybeSingle()

    // Only ever acts for the owner's own number. The webhooks check this too;
    // it is repeated here because this function can be called directly.
    const owner = String(s?.jarvis_notify_number ?? '').replace(/[\s\-().]/g, '')
    const sender = String(from ?? '').replace(/[\s\-().]/g, '')
    const ownerE164 = owner.startsWith('0') ? '+61' + owner.slice(1) : owner
    if (!ownerE164 || sender !== ownerE164) return json({ ok: true, reason: 'not_the_owner' })

    // What he raised and has not been resolved, so "chase Sandford" resolves
    // to exactly one lead. lead_id travels with each item on purpose: making
    // him search by name invites emailing the wrong company.
    const { data: openEvents } = await db
      .from('jarvis_events')
      .select('kind, subject, tier, payload')
      .is('resolved_at', null)
      .order('first_seen_at', { ascending: true }).limit(10)
    const context = {
      open_items: (openEvents || []).map((e: Record<string, unknown>) => {
        const p = (e.payload ?? {}) as Record<string, unknown>
        return {
          kind: e.kind, subject: e.subject, tier: e.tier,
          ...(p.lead_id ? { lead_id: p.lead_id } : {}),
          ...(p.client_id ? { client_id: p.client_id } : {}),
          ...(p.days ? { days: p.days } : {}),
        }
      }),
    }

    // A spoken reply was already saved by jarvis-voice-reply.
    if (via !== 'voice') {
      await db.from('jarvis_messages').insert({
        direction: 'inbound', body: question, from_number: sender, to_number: null, context,
      })
    }

    // The rules that make "chase Sandford" safe to act on. The hard one is the
    // second: act on exactly who was named. The open items are right there, so
    // the tempting failure is chasing the other eleven because they were also
    // overdue - the one mistake that reaches real clients.
    const preamble =
      `The owner answered you ${via === 'voice' ? 'on a phone call (speech-to-text, so names may be misheard)' : 'by SMS'}. ` +
      `Keep your answer under 300 characters, plain text, no markdown.\n` +
      `Open items you raised, with their ids: ${JSON.stringify(context)}\n` +
      `Rules:\n` +
      `1. Match what they name against the subjects above and use that item's lead_id. ` +
      `Partial or misheard names are fine if only one item fits ("Sandford" means "Sandford Electrical").\n` +
      `2. Act on EXACTLY the ones they name. Never include an item they did not name, however overdue.\n` +
      `3. If they say "all" or "everyone", do NOT send - say how many that is and ask them to confirm in the panel.\n` +
      `4. If a name matches nothing or more than one item, ask which, and send nothing.\n` +
      `5. Use the saved follow-up template: send_lead_email with kind:"followup", never kind:"info". ` +
      `Do not write your own wording unless they dictate it.\n` +
      `6. After sending, confirm briefly who you contacted, by name.\n` +
      `7. Anything else that would change something: answer it, do not act on it. ` +
      `If they tell you something to remember, create_memory.\n\n` +
      `They said: ${question}`

    // jarvis-chat holds the tools and memory; it accepts this as the bridge
    // after proving the bearer is service-role.
    let answer = ''
    const chatRes = await fetch(`${url}/functions/v1/jarvis-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
      },
      body: JSON.stringify({ via: 'sms', messages: [{ role: 'user', content: preamble }], allow_writes: true }),
    })
    if (chatRes.ok) {
      try { answer = String((await chatRes.json())?.reply ?? '') } catch { /* falls through */ }
    } else {
      console.error('jarvis-reply: jarvis-chat returned', chatRes.status, (await chatRes.text()).slice(0, 300))
    }
    if (!answer) answer = 'I could not act on that. Ask me again in the panel.'
    const reply = answer.slice(0, 300)

    // Always in the panel.
    await db.from('jarvis_notifications').insert({
      channel: 'panel', to_number: 'panel', tier: 'notable', status: 'sent',
      body: `You said: "${question.slice(0, 300)}"\n${reply}`,
    })

    // And by text, from the main number. A text always gets a text back: you
    // asked him something, so the answer goes where you asked it. "Text me new
    // alerts" only decides whether he texts you first, and whether a call is
    // confirmed by text.
    let sid: string | null = null
    let sendError: string | null = null
    const fromNum = s?.twilio_from_number || Deno.env.get('TWILIO_FROM_NUMBER') || ''
    if ((via !== 'voice' || s?.jarvis_notify_enabled === true) && fromNum) {
      const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
      const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
      const sendRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(accountSid + ':' + authToken),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: ownerE164, From: fromNum, Body: `Jarvis: ${reply}` }).toString(),
        },
      )
      const sendRaw = await sendRes.text()
      try { sid = JSON.parse(sendRaw).sid || null } catch { /* keep raw */ }
      if (!sendRes.ok) sendError = sendRaw.slice(0, 400)
    }

    await db.from('jarvis_messages').insert({
      direction: 'outbound', body: reply,
      from_number: sid || sendError ? fromNum : null, to_number: ownerE164,
      twilio_sid: sid, handled_at: new Date().toISOString(), error: sendError,
    })

    return json({ ok: true, replied: reply.length, texted: !!sid, ...(sendError ? { error: sendError } : {}) })
  } catch (err) {
    console.error('jarvis-reply error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
