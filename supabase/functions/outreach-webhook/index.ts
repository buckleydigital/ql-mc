/**
 * outreach-webhook - what Instantly tells us about cold outreach (stage 4).
 *
 * Instantly calls this for every campaign event, presenting the secret header
 * outreach-send set up (x-ql-hook) - Instantly does not sign its webhooks, so
 * that header is the whole of the proof. Every event is logged in
 * outreach_events, then acted on:
 *
 *   email_sent           -> the prospect is 'contacted'
 *   reply_received       -> 'replied', and a note in the Jarvis panel; a reply
 *                           asking to be removed is treated as an unsubscribe
 *   lead_interested,
 *   lead_meeting_booked  -> 'interested', and a new lead in the Sales Pipeline
 *   lead_not_interested,
 *   lead_wrong_person    -> 'not_interested', and on the do-not-contact list
 *   lead_unsubscribed    -> 'unsubscribed', and on the do-not-contact list
 *   email_bounced        -> 'bounced', and on the do-not-contact list
 *   account_error        -> an urgent note: an inbox has a problem
 *
 * Bounces are what get sending domains flagged, so after each one the niche's
 * bounce rate over the last 7 days is checked: past 3% (once 20 or more have
 * been emailed) its campaign is paused in Instantly and you get an urgent
 * note. Resume it from the Sending tab once the list is fixed.
 *
 * Always answers 200 once the secret checks out, so one odd payload cannot
 * get the subscription disabled for repeated failures.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A reply that asks to be left alone, in the ways people actually write it. */
const WANTS_OUT = /\b(unsubscribe|remove me|take me off|opt(?:-| )?out|stop (?:emailing|contacting|sending)|do not (?:contact|email)|don'?t (?:contact|email)|no more emails)\b|^\s*stop\s*[.!]*\s*$/i

const strip = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim()

/** Text of the reply only, without the quoted email underneath it. */
function replyOnly(text: string): string {
  const cut = text.search(/\n\s*(On .{5,80}wrote:|-{2,}\s*Original Message|From: .+\n|>)/i)
  return (cut > 0 ? text.slice(0, cut) : text).trim()
}

const brisbaneToday = () => new Date(Date.now() + 10 * 3_600_000).toISOString().slice(0, 10)

async function note(db: SupabaseClient, tier: string, body: string) {
  await db.from('jarvis_notifications').insert({ channel: 'panel', to_number: 'panel', tier, body: body.slice(0, 2000), status: 'sent' })
}

async function suppress(db: SupabaseClient, email: string, reason: string, note_: string) {
  const { error } = await db.rpc('contact_suppress', { p_kind: 'email', p_value: email, p_reason: reason, p_source: 'instantly', p_note: note_ })
  if (error) console.error('outreach-webhook: suppress failed:', error.message)
}

/** Best effort: Instantly's own block list, so nothing else in it emails them. */
async function blockInInstantly(email: string) {
  const key = Deno.env.get('INSTANTLY_API_KEY')
  if (!key) return
  await fetch('https://api.instantly.ai/api/v2/block-lists-entries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bl_value: email }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => console.error('outreach-webhook: block in Instantly failed:', e))
}

/** Bounce rate past which a niche's campaign is paused. */
const BOUNCE_PAUSE = 0.03
const BOUNCE_MIN_SENT = 20

async function bounceGuard(db: SupabaseClient, niche: string): Promise<string> {
  const { data } = await db.rpc('outreach_bounce_rate', { p_niche: niche })
  const r = (data ?? {}) as { emailed?: number; bounced?: number }
  const emailed = Number(r.emailed ?? 0), bounced = Number(r.bounced ?? 0)
  if (emailed < BOUNCE_MIN_SENT || bounced / emailed <= BOUNCE_PAUSE) return ''
  const { data: n } = await db.from('outreach_niches').select('label, instantly_campaign_id, campaign_state').eq('key', niche).single()
  const row = n as { label: string; instantly_campaign_id: string | null; campaign_state: string | null } | null
  if (!row?.instantly_campaign_id || row.campaign_state === 'paused') return ''
  const key = Deno.env.get('INSTANTLY_API_KEY')
  const res = key
    ? await fetch(`https://api.instantly.ai/api/v2/campaigns/${row.instantly_campaign_id}/pause`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
    : null
  const pct = Math.round((1000 * bounced) / emailed) / 10
  if (res?.ok) {
    await db.from('outreach_niches').update({ campaign_state: 'paused' }).eq('key', niche)
    await note(db, 'urgent', `Paused ${row.label} cold email: ${bounced} of ${emailed} bounced this week (${pct}%). Bounces this high get domains flagged. Check the list, then resume it on the Sending tab.`)
    return `, ${row.label} paused at ${pct}% bounces`
  }
  await note(db, 'urgent', `${row.label} cold email is bouncing at ${pct}% this week and could not be paused automatically - pause it in Instantly now.`)
  return `, could not pause at ${pct}% bounces`
}

type Prospect = {
  id: string; niche_key: string; business_name: string; contact_name: string | null; email: string; phone: string | null
  suburb: string | null; state: string | null; status: string; lead_id: string | null; website: string | null
}

/** An interested reply becomes a Sales Pipeline lead, once. */
async function toPipeline(db: SupabaseClient, p: Prospect, reply: string, unibox: string | null): Promise<string> {
  if (p.lead_id) return 'already in the pipeline'
  const { data: existing } = await db.from('leads').select('id').ilike('email', p.email.replace(/[\\%_]/g, '\\$&')).limit(1)
  let leadId = (existing ?? [])[0]?.id as string | undefined
  if (!leadId) {
    const { data, error } = await db.from('leads').insert({
      name: p.contact_name || p.business_name,
      company: p.business_name,
      email: p.email,
      phone: p.phone,
      stage: 'new_lead',
      source: 'cold_email',
      lead_type: 'managed',   // cold email is aimed at managed advertising clients
      niche: p.niche_key,
      suburb: p.suburb,
      state: p.state,
      next_followup: brisbaneToday(),
      notes: `Replied to cold email ${brisbaneToday()}:\n${reply.slice(0, 1500)}`,
      custom_data: { prospect_id: p.id, website: p.website, unibox_url: unibox },
    }).select('id').single()
    if (error) return `could not create lead: ${error.message}`
    leadId = (data as { id: string }).id
  }
  await db.from('prospects').update({ lead_id: leadId }).eq('id', p.id)
  return 'added to the Sales Pipeline'
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const db = createClient(URL_, SERVICE)

  const { data: s } = await db.from('outreach_settings').select('webhook_secret').eq('id', 1).single()
  if (!sameSecret(req.headers.get('x-ql-hook') ?? '', (s as { webhook_secret: string | null } | null)?.webhook_secret ?? '')) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const ev = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!ev) return json({ ok: true, ignored: 'not json' })
  const type = String(ev.event_type ?? 'unknown')
  const email = String(ev.lead_email ?? '').trim().toLowerCase() || null
  const replyRaw = String(ev.reply_text ?? '') || strip(String(ev.reply_html ?? '')) || String(ev.reply_text_snippet ?? '')
  const reply = replyOnly(replyRaw)
  const unibox = (ev.unibox_url as string | undefined) ?? null

  let p: Prospect | null = null
  if (email) {
    const { data } = await db.from('prospects')
      .select('id, niche_key, business_name, contact_name, email, phone, suburb, state, status, lead_id, website')
      .eq('email', email).maybeSingle()
    p = (data as Prospect | null) ?? null
  }
  const who = p ? `${p.business_name}${p.suburb ? ` (${p.suburb})` : ''}` : (email ?? 'someone')
  const now = new Date().toISOString()
  const set = (patch: Record<string, unknown>) =>
    p ? db.from('prospects').update({ ...patch, last_event_at: now }).eq('id', p.id) : Promise.resolve()
  let handled = 'logged'

  try {
    switch (type) {
      case 'email_sent':
        if (p && ['queued', 'qualified', 'verified'].includes(p.status)) await set({ status: 'contacted', contacted_at: now })
        else await set({})
        handled = 'marked contacted'
        break

      case 'reply_received':
        if (email && WANTS_OUT.test(reply)) {
          await suppress(db, email, 'unsubscribed', 'replied asking to be removed')
          await blockInInstantly(email)
          await set({ status: 'unsubscribed', status_reason: 'replied asking to be removed' })
          handled = 'unsubscribed (asked by reply)'
        } else {
          if (p && !['interested', 'converted'].includes(p.status)) await set({ status: 'replied' })
          await note(db, 'notable', `Cold email reply from ${who}:\n"${reply.slice(0, 400)}"${unibox ? `\n${unibox}` : ''}`)
          handled = 'replied, noted in the panel'
        }
        break

      case 'auto_reply_received':
      case 'lead_out_of_office':
        await set({})
        handled = 'auto-reply, nothing to do'
        break

      case 'lead_interested':
      case 'lead_meeting_booked':
        if (p) {
          await set({ status: 'interested' })
          const r = await toPipeline(db, p, reply || String(ev.email_text ?? ''), unibox)
          await note(db, 'urgent', `${who} is interested in ${type === 'lead_meeting_booked' ? 'a meeting' : 'hearing more'} - ${r}.`)
          handled = `interested, ${r}`
        } else {
          await note(db, 'urgent', `${who} is marked interested in Instantly, but is not one of our prospects.`)
          handled = 'interested, unknown prospect'
        }
        break

      case 'lead_not_interested':
      case 'lead_wrong_person':
        if (email) await suppress(db, email, 'not_interested', type === 'lead_wrong_person' ? 'wrong person' : 'not interested')
        await set({ status: 'not_interested', status_reason: type === 'lead_wrong_person' ? 'wrong person' : 'not interested' })
        handled = 'not interested, never contacted again'
        break

      case 'lead_unsubscribed':
        if (email) await suppress(db, email, 'unsubscribed', 'unsubscribed in Instantly')
        await set({ status: 'unsubscribed', status_reason: 'unsubscribed' })
        handled = 'unsubscribed'
        break

      case 'email_bounced':
        if (email) await suppress(db, email, 'bounced', 'bounced')
        await set({ status: 'bounced', status_reason: 'email bounced' })
        handled = 'bounced, never contacted again' + (p ? await bounceGuard(db, p.niche_key) : '')
        break

      case 'account_error':
        await note(db, 'urgent', `A sending inbox has a problem: ${String(ev.email_account ?? 'unknown inbox')}. Check it in Instantly - its campaigns may stop sending.`)
        handled = 'inbox problem, noted in the panel'
        break

      case 'campaign_completed':
        await note(db, 'notable', `Instantly finished the campaign "${String(ev.campaign_name ?? '')}" - everyone in it has had every email.`)
        handled = 'noted in the panel'
        break

      default:
        await set({})
    }
  } catch (e) {
    handled = `failed: ${(e as Error).message}`
    console.error('outreach-webhook:', type, (e as Error).message)
  }

  await db.from('outreach_events').insert({
    event_type: type,
    campaign_id: (ev.campaign_id as string | undefined) ?? null,
    lead_email: email,
    prospect_id: p?.id ?? null,
    step: typeof ev.step === 'number' ? ev.step : null,
    email_id: (ev.email_id as string | undefined) ?? null,
    subject: String(ev.reply_subject ?? ev.email_subject ?? '').slice(0, 300) || null,
    body: (reply || String(ev.email_text ?? '')).slice(0, 5000) || null,
    handled,
    payload: ev,
  })
  return json({ ok: true, handled })
})
