/**
 * jarvis-reply - a text you sent him.
 *
 * Jarvis used to answer texts by text. Since 7 Oct he talks only in the
 * dashboard (migration 20261007000004), to save SMS credits: a text to his
 * number is saved as a message and shown in the Jarvis panel, where you can
 * ask him properly. Nothing is sent back by SMS.
 *
 * Called by twilio-inbound-sms, which has already checked the text came to
 * Jarvis's number from the owner's.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  // Same capability test as jarvis-notify: prove the caller holds a key that
  // can read a table only service_role can read.
  const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const caller = createClient(url, auth)
  const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'unauthorized' }, 401)

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { from, body: text } = await req.json().catch(() => ({}))
    const said = String(text ?? '').trim()
    if (!said) return json({ ok: true, reason: 'empty' })

    const { data: s } = await db
      .from('business_settings')
      .select('jarvis_from_number, jarvis_notify_number')
      .limit(1).maybeSingle()

    // Only the owner's own number counts. The webhook checks this too; it is
    // repeated here because this function can be called directly.
    const owner = String(s?.jarvis_notify_number ?? '').replace(/[\s\-().]/g, '')
    const sender = String(from ?? '').replace(/[\s\-().]/g, '')
    const ownerE164 = owner.startsWith('0') ? '+61' + owner.slice(1) : owner
    if (!ownerE164 || sender !== ownerE164) return json({ ok: true, reason: 'not_the_owner' })

    await db.from('jarvis_messages').insert({
      direction: 'inbound', body: said,
      from_number: sender, to_number: s?.jarvis_from_number ?? null,
      context: { answered: 'panel' },
    })
    await db.from('jarvis_notifications').insert({
      channel: 'panel', to_number: 'panel', tier: 'notable', status: 'sent',
      body: `You texted me: "${said.slice(0, 400)}". I only reply here now - ask me in this panel.`,
    })
    return json({ ok: true, replied: false, noted: true })
  } catch (err) {
    console.error('jarvis-reply error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
