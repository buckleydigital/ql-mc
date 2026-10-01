/**
 * Outreach: what has gone to whom, and bulk sends that cannot double up.
 *
 * On 1 Oct a 180-lead campaign sent one tool call at a time hit the edge
 * function time limit after 17 leads. The conversation was never saved, so
 * JARVIS then said nothing had gone out - and a "yes" would have sent the list
 * again from the top. So:
 *
 *   send_bulk_message  writes the whole list to jarvis_outbox in ONE call and
 *                      hands it to the jarvis-outbox worker, which sends it in
 *                      batches and survives timeouts. Leads already contacted
 *                      recently are left out before anything is queued.
 *                      Previews by default; nothing is queued until dry_run
 *                      is false.
 *   get_outreach_log   what was actually sent, to whom, when - from the send
 *                      logs, not from memory of the conversation.
 *
 * Underneath both, send-sms and send-sales-email refuse the same message to
 * the same phone or email inside 30 days (outreach_claim), whoever asks.
 */

import { select, insert, invoke } from './db.mjs'
import { env } from './config.mjs'

/** The most leads one bulk send may target. */
const MAX_BULK = 500

/** AU mobile to E.164, the form outreach_sent and sms_opt_outs store. */
function e164(raw) {
  let p = String(raw ?? '').replace(/[\s\-().]/g, '')
  if (p.startsWith('04')) p = '+61' + p.slice(1)
  else if (p.startsWith('61') && !p.startsWith('+')) p = '+' + p
  return /^\+614\d{8}$/.test(p) ? p : null
}
const emailKey = (e) => {
  const v = String(e ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v) ? v : null
}

/** PostgREST in.() over a long list, in chunks the URL can carry. */
async function selectIn(table, column, values, params, size = 80) {
  const out = []
  for (let i = 0; i < values.length; i += size) {
    const part = values.slice(i, i + size).map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')
    const { rows } = await select(table, { ...params, [column]: `in.(${part})` }, { limit: 5000 })
    out.push(...rows)
  }
  return out
}

/** {first_name} or {{first_name}}, plus company and rep - the app's own placeholders. */
function render(template, lead, rep) {
  const vals = {
    first_name: String(lead.name || '').trim().split(/\s+/)[0] || 'there',
    company_name: String(lead.company || '').trim(),
    rep_name: rep.name || '',
    rep_email: rep.reply_to_email || rep.email || '',
  }
  return String(template ?? '')
    .replace(/\{\{?\s*(first_name|company_name|rep_name|rep_email)\s*\}?\}/g, (_, k) => vals[k] || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim()
}

async function sendBulkMessage({
  campaign, lead_ids, sms_message, email_subject, email_body,
  skip_recent_days = 7, dry_run = true,
} = {}) {
  campaign = String(campaign ?? '').trim()
  if (!campaign) throw new Error('campaign (a short name for this send) is required')
  const ids = [...new Set((Array.isArray(lead_ids) ? lead_ids : []).map(String).filter(Boolean))]
  if (!ids.length) throw new Error('lead_ids is required - find the leads first with query_table or find_lead')
  if (ids.length > MAX_BULK) throw new Error(`At most ${MAX_BULK} leads per bulk send; split it.`)
  const wantSms = Boolean(String(sms_message ?? '').trim())
  const wantEmail = Boolean(String(email_subject ?? '').trim() && String(email_body ?? '').trim())
  if (!wantSms && !wantEmail) throw new Error('Give sms_message, or email_subject and email_body, or both.')
  if (wantSms && String(sms_message).length > 440) throw new Error('sms_message must be 440 characters or fewer (the opt-out line is added after).')
  const days = Math.max(0, Number(skip_recent_days ?? 7))

  const leads = await selectIn('leads', 'id', ids, { select: 'id,name,company,phone,email,sms_opted_out' })
  const found = new Set(leads.map((l) => l.id))
  const missing = ids.filter((id) => !found.has(id))

  const phones = [...new Set(leads.map((l) => e164(l.phone)).filter(Boolean))]
  const emails = [...new Set(leads.map((l) => emailKey(l.email)).filter(Boolean))]
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const [optedOut, recentRecipients, recentSms, recentEmail, pending, repRows] = await Promise.all([
    phones.length ? selectIn('sms_opt_outs', 'phone', phones, { select: 'phone', opted_out: 'is.true' }) : [],
    days && (phones.length || emails.length)
      ? selectIn('outreach_sent', 'recipient', [...phones, ...emails], { select: 'recipient', claimed_at: `gte.${since}` })
      : [],
    days ? selectIn('sales_sms_log', 'lead_id', ids, { select: 'lead_id', direction: 'eq.outbound', created_at: `gte.${since}` }) : [],
    days ? selectIn('sales_email_log', 'lead_id', ids, { select: 'lead_id', sent_at: `gte.${since}` }) : [],
    selectIn('jarvis_outbox', 'lead_id', ids, { select: 'lead_id', status: 'in.(queued,sending)' }),
    env('QL_USER_EMAIL')
      ? select('sales_reps', { select: 'name,email,reply_to_email', email: `eq.${env('QL_USER_EMAIL')}` }, { limit: 1 }).then((r) => r.rows)
      : [],
  ])
  const rep = repRows[0] ?? { name: '', email: env('QL_USER_EMAIL') || '', reply_to_email: null }

  const optedSet = new Set(optedOut.map((r) => r.phone))
  const recentSet = new Set(recentRecipients.map((r) => r.recipient))
  const recentLeads = new Set([...recentSms, ...recentEmail].map((r) => r.lead_id))
  const pendingLeads = new Set(pending.map((r) => r.lead_id))

  const skipped = { recently_contacted: [], already_queued: [], opted_out: [], no_phone: [], no_email: [], duplicate_contact: [] }
  const usedPhones = new Set()
  const usedEmails = new Set()
  const rows = []
  const campaignId = crypto.randomUUID()
  const label = (l) => l.name || l.company || l.phone || l.email || l.id

  for (const l of leads) {
    const phone = e164(l.phone)
    const email = emailKey(l.email)

    // Whole lead out: contacted recently on ANY channel, by any route, or
    // already waiting in another send. A reworded message is still a second
    // message to the same person.
    if (recentLeads.has(l.id) || (phone && recentSet.has(phone)) || (email && recentSet.has(email))) {
      skipped.recently_contacted.push(label(l)); continue
    }
    if (pendingLeads.has(l.id)) { skipped.already_queued.push(label(l)); continue }

    // Two lead rows with the same phone or email are one person: whoever comes
    // first gets the message, the other gets nothing on any channel.
    if ((phone && usedPhones.has(phone)) || (email && usedEmails.has(email))) {
      skipped.duplicate_contact.push(label(l)); continue
    }
    if (phone) usedPhones.add(phone)
    if (email) usedEmails.add(email)

    if (wantSms) {
      if (!phone) skipped.no_phone.push(label(l))
      else if (l.sms_opted_out || optedSet.has(phone)) skipped.opted_out.push(label(l))
      else rows.push({ campaign_id: campaignId, campaign, lead_id: l.id, lead_name: label(l), channel: 'sms', recipient: phone, body: render(sms_message, l, rep) })
    }
    if (wantEmail) {
      if (!email) skipped.no_email.push(label(l))
      else rows.push({ campaign_id: campaignId, campaign, lead_id: l.id, lead_name: label(l), channel: 'email', recipient: email, subject: render(email_subject, l, rep), body: render(email_body, l, rep) })
    }
  }

  const people = new Set(rows.map((r) => r.lead_id)).size
  const sms = rows.filter((r) => r.channel === 'sms').length
  const em = rows.filter((r) => r.channel === 'email').length
  const counts = Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length]))
  const skipLine = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')
  const sample = {
    sms: rows.find((r) => r.channel === 'sms')?.body ?? null,
    email: rows.find((r) => r.channel === 'email') ? { subject: rows.find((r) => r.channel === 'email').subject, body: rows.find((r) => r.channel === 'email').body } : null,
  }
  const detail = {
    people, sms, emails: em, skipped: counts,
    skipped_names: Object.fromEntries(Object.entries(skipped).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 40)])),
    not_found: missing.length, sample, skip_recent_days: days,
  }

  if (dry_run !== false) {
    return {
      summary: `Preview only, nothing sent: ${people} people (${sms} texts, ${em} emails)${skipLine ? `; left out ${skipLine}` : ''}. ` +
        'Read this back; once they say yes, call again with the same arguments and dry_run false.',
      dry_run: true,
      ...detail,
    }
  }

  if (!rows.length) return { summary: `Nothing to send${skipLine ? ` - left out ${skipLine}` : ''}.`, ...detail }

  for (let i = 0; i < rows.length; i += 200) await insert('jarvis_outbox', rows.slice(i, i + 200))
  // The worker answers at once and sends in the background; the minutely cron
  // starts it anyway if this call is lost.
  try { await invoke('jarvis-outbox', {}) } catch (e) { console.error('jarvis-outbox kick failed:', e.message) }

  return {
    summary: `Queued: ${people} people (${sms} texts, ${em} emails), sending now in the background${skipLine ? `; left out ${skipLine}` : ''}. ` +
      'Check progress with get_outreach_log and this campaign_id. Do not send it again.',
    campaign_id: campaignId,
    ...detail,
  }
}

async function getOutreachLog({ campaign_id, lead_id, days = 7 } = {}) {
  const since = new Date(Date.now() - Math.max(1, Number(days) || 7) * 86_400_000).toISOString()

  if (campaign_id) {
    const { rows } = await select('jarvis_outbox',
      { select: 'lead_name,channel,status,detail,sent_at,created_at,campaign', campaign_id: `eq.${campaign_id}` }, { limit: 2000 })
    if (!rows.length) return { summary: 'No bulk send with that id.' }
    const by = {}
    for (const r of rows) by[r.status] = (by[r.status] || 0) + 1
    const open = (by.queued || 0) + (by.sending || 0)
    return {
      summary: `${rows[0].campaign}: ${by.sent || 0} sent, ${open} still to go, ${by.skipped || 0} skipped, ${by.failed || 0} failed.`,
      by_status: by,
      problems: rows.filter((r) => r.status === 'failed' || r.status === 'skipped')
        .slice(0, 50).map((r) => ({ lead: r.lead_name, channel: r.channel, status: r.status, why: r.detail })),
    }
  }

  // Every outbound message in the window, from the send logs themselves.
  const smsParams = { select: 'lead_id,to_number,message,sent_by,status,created_at', direction: 'eq.outbound', created_at: `gte.${since}`, order: 'created_at.desc' }
  const emailParams = { select: 'lead_id,kind,to_email,subject,sent_at', sent_at: `gte.${since}`, order: 'sent_at.desc' }
  if (lead_id) { smsParams.lead_id = `eq.${lead_id}`; emailParams.lead_id = `eq.${lead_id}` }

  const [sms, email, outbox] = await Promise.all([
    select('sales_sms_log', smsParams, { limit: 1000 }),
    select('sales_email_log', emailParams, { limit: 1000 }),
    select('jarvis_outbox', {
      select: 'campaign_id,campaign,status,created_at',
      created_at: `gte.${since}`,
      ...(lead_id ? { lead_id: `eq.${lead_id}` } : {}),
    }, { limit: 5000 }),
  ])

  const leadIds = [...new Set([...sms.rows, ...email.rows].map((r) => r.lead_id).filter(Boolean))]
  const names = new Map(
    (leadIds.length ? await selectIn('leads', 'id', leadIds, { select: 'id,name,company' }) : [])
      .map((l) => [l.id, l.name || l.company]),
  )

  const sends = [
    ...sms.rows.map((r) => ({ at: r.created_at, channel: 'sms', lead: names.get(r.lead_id) || r.to_number, lead_id: r.lead_id, status: r.status, text: String(r.message || '').slice(0, 90) })),
    ...email.rows.map((r) => ({ at: r.sent_at, channel: 'email', lead: names.get(r.lead_id) || r.to_email, lead_id: r.lead_id, kind: r.kind, text: r.subject })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1))

  const campaigns = {}
  for (const r of outbox.rows) {
    const c = (campaigns[r.campaign_id] ??= { campaign_id: r.campaign_id, name: r.campaign, started: r.created_at, sent: 0, to_go: 0, skipped: 0, failed: 0 })
    if (r.status === 'sent') c.sent++
    else if (r.status === 'queued' || r.status === 'sending') c.to_go++
    else c[r.status]++
  }

  const people = new Set(sends.map((s) => s.lead_id || s.lead)).size
  const smsN = sends.filter((s) => s.channel === 'sms').length
  return {
    summary: lead_id
      ? (sends.length
          ? `${sends.length} message${sends.length === 1 ? '' : 's'} to them in the last ${days} days, the latest ${sends[0].channel} on ${sends[0].at.slice(0, 10)}.`
          : `Nothing sent to them in the last ${days} days.`)
      : `${smsN} texts and ${sends.length - smsN} emails to ${people} people in the last ${days} days.`,
    bulk_sends: Object.values(campaigns),
    sends: sends.slice(0, lead_id ? 100 : 60),
  }
}

export const OUTREACH_TOOLS = [
  {
    name: 'get_outreach_log',
    description:
      'What has actually been sent, to whom and when: every text and email from the send logs, plus the progress of bulk sends. ' +
      'Check this BEFORE saying whether something was sent, before any follow-up or chase, and after any error during a send - ' +
      'never answer from memory of the conversation. With lead_id: everything sent to that lead. With campaign_id: that bulk send\'s progress and any failures.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'Optional: one lead.' },
        campaign_id: { type: 'string', description: 'Optional: one bulk send, from send_bulk_message.' },
        days: { type: 'number', description: 'Look-back window in days. Default 7.' },
      },
    },
    handler: getOutreachLog,
  },
  {
    name: 'send_bulk_message',
    description:
      'Text and/or email a list of leads - the ONLY way to message more than 3 leads. Never loop send_lead_sms or send_lead_email over a list. ' +
      'Previews by default (dry_run true): read back the count, who is left out and the sample, get a yes, then call again with dry_run false. ' +
      'It queues everything in one call and a background worker sends it, so it cannot time out halfway; it is sent from the agency number. ' +
      'Leads contacted in the last skip_recent_days (default 7) on any channel, opted out, already queued, or sharing a phone/email with another lead on the list are left out automatically. ' +
      'Templates take {first_name}, {company_name}, {rep_name}, {rep_email}. "Reply STOP to opt out" is added to texts automatically. ' +
      'Never call it twice for the same send; check get_outreach_log instead.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: { type: 'string', description: 'Short name, e.g. "Quiet season Oct".' },
        lead_ids: { type: 'array', items: { type: 'string' }, description: 'Lead UUIDs (sales pipeline). Up to 500.' },
        sms_message: { type: 'string', description: 'Text template. Omit for email only.' },
        email_subject: { type: 'string', description: 'Email subject template. Omit for SMS only.' },
        email_body: { type: 'string', description: 'Email body template, plain text.' },
        skip_recent_days: { type: 'number', description: 'Leave out anyone messaged within this many days. Default 7. Lower it only if the owner explicitly says to.' },
        dry_run: { type: 'boolean', description: 'Default true: preview only. false queues and sends.' },
      },
      required: ['campaign', 'lead_ids'],
    },
    handler: sendBulkMessage,
  },
]
