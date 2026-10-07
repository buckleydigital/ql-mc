/**
 * outreach-send - Mission Control's side of Instantly (cold outreach stage 4).
 *
 *   status    - is the key working, which inboxes exist and how warm they are,
 *               and what state each niche's campaign is in. Read-only.
 *   sync      - creates or updates one Instantly campaign per niche from its
 *               APPROVED sequence, the sender details and the sending window;
 *               sets up the webhook back to outreach-webhook; and copies the
 *               do-not-contact list into Instantly's block list. A campaign is
 *               created paused - nothing sends until a batch is pushed.
 *   push      - sends the prospects you approved today (status 'queued') into
 *               their niche's campaign, re-checking the do-not-contact list
 *               one last time, and starts the campaign.
 *   pause / resume { niche } - stop or restart a niche's campaign.
 *
 * Called from the dashboard with the user's session (operators only, checked
 * by jarvis_assert_operator), or with the service-role key.
 *
 * Every email carries the Spam Act essentials: who it is from, how to reach
 * them, and a working unsubscribe (reply "unsubscribe" - handled by
 * outreach-webhook - plus the one-click unsubscribe header).
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const API = 'https://api.instantly.ai/api/v2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// ── Instantly ────────────────────────────────────────────────────────────────

async function ig<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const key = Deno.env.get('INSTANTLY_API_KEY')
  if (!key) throw new Error('INSTANTLY_API_KEY is not set (Supabase > Edge Functions > Secrets)')
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  })
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const msg = (data as { message?: string; error?: string })?.message ?? (data as { error?: string })?.error ?? String(text).slice(0, 200)
    throw new Error(`Instantly ${res.status} on ${method} ${path.split('?')[0]}: ${msg}`)
  }
  return data as T
}

const CAMPAIGN_STATE: Record<string, string> = {
  '0': 'draft', '1': 'active', '2': 'paused', '3': 'completed', '4': 'running subsequences',
  '-99': 'account suspended', '-1': 'inboxes unhealthy', '-2': 'bounce protection',
}
const ACCOUNT_STATE: Record<string, string> = {
  '1': 'active', '2': 'paused', '3': 'maintenance', '-1': 'connection error', '-2': 'soft bounce error', '-3': 'sending error',
}
const WARMUP_STATE: Record<string, string> = {
  '0': 'warm-up paused', '1': 'warming up', '-1': 'banned', '-2': 'spam folder unknown', '-3': 'suspended',
}

// ── Turning a sequence into Instantly copy ──────────────────────────────────

type Step = { subject: string; body: string; delay_days?: number }
type Settings = {
  sender_name: string | null; business_name: string; postal_address: string | null; sending_accounts: string[]
  send_from: string; send_to: string; timezone: string; daily_limit: number; webhook_id: string | null; webhook_secret: string | null
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Our placeholders -> Instantly's. {first_name} is the custom variable
 * `greet` (their first name, or "there"), so "Hi {first_name}" never reads
 * "Hi ,". {opener} is the line stage 3 wrote for that business.
 */
function toInstantly(text: string, s: Settings, html: boolean): string {
  const t = html ? esc(text) : text
  return t
    .replace(/\{first_name\}/g, '{{greet}}')
    .replace(/\{company\}/g, '{{companyName}}')
    .replace(/\{suburb\}/g, '{{suburb}}')
    .replace(/\{opener\}/g, '{{personalization}}')
    .replace(/\{sender\}/g, html ? esc(s.sender_name ?? '') : (s.sender_name ?? ''))
}

function footer(s: Settings): string {
  return '<br/><br/>--<br/>' + esc(`${s.sender_name}, ${s.business_name}`) + '<br/>' + esc(s.postal_address ?? '') +
    '<br/>Not for you? Reply "unsubscribe" and you will not hear from us again.'
}

function campaignBody(label: string, steps: Step[], s: Settings) {
  return {
    name: `Mission Control · ${label}`,
    campaign_schedule: {
      schedules: [{
        name: 'Business hours',
        timing: { from: s.send_from, to: s.send_to },
        days: { '0': false, '1': true, '2': true, '3': true, '4': true, '5': true, '6': false },
        timezone: s.timezone,
      }],
    },
    sequences: [{
      steps: steps.map((st, i) => ({
        type: 'email',
        // Instantly's delay is the wait before the NEXT step; ours is the wait
        // before this one - so each step carries the next one's delay.
        delay: Math.max(1, Number(steps[i + 1]?.delay_days ?? 3)),
        delay_unit: 'days',
        variants: [{
          subject: toInstantly(st.subject, s, false),
          body: toInstantly(st.body, s, true).replace(/\r?\n/g, '<br/>') + footer(s),
        }],
      })),
    }],
    email_list: s.sending_accounts,
    daily_limit: s.daily_limit,
    stop_on_reply: true,
    stop_on_auto_reply: false,
    stop_for_company: true,
    text_only: true,
    first_email_text_only: true,
    link_tracking: false,
    open_tracking: false,
    insert_unsubscribe_header: true,
    allow_risky_contacts: true,         // catch-all addresses were verified 'risky' on purpose
    prioritize_new_leads: false,
    email_gap: 10,
    random_wait_max: 10,
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db.from('outreach_settings').select('*').eq('id', 1).single()
  if (error) throw error
  return data as Settings
}

type NicheRow = {
  key: string; label: string; sequence: Step[]; sequence_approved_at: string | null
  instantly_campaign_id: string | null; campaign_state: string | null
}

async function status(db: SupabaseClient) {
  const s = await loadSettings(db)
  const workspace = await ig<{ name?: string }>('GET', '/workspaces/current')
  const acc = await ig<{ items?: Record<string, unknown>[] }>('GET', '/accounts?limit=100')
  const accounts = (acc.items ?? []).map((a) => ({
    email: String(a.email ?? ''),
    state: ACCOUNT_STATE[String(a.status)] ?? String(a.status ?? ''),
    warmup: WARMUP_STATE[String(a.warmup_status)] ?? String(a.warmup_status ?? ''),
    warmup_score: a.stat_warmup_score ?? null,
    daily_limit: a.daily_limit ?? null,
    selected: s.sending_accounts.includes(String(a.email ?? '').toLowerCase()),
  }))
  const { data: niches } = await db.from('outreach_niches').select('key, instantly_campaign_id').not('instantly_campaign_id', 'is', null)
  const campaigns: Record<string, string> = {}
  for (const n of (niches ?? []) as { key: string; instantly_campaign_id: string }[]) {
    try {
      const c = await ig<{ status?: number }>('GET', `/campaigns/${n.instantly_campaign_id}`)
      campaigns[n.key] = CAMPAIGN_STATE[String(c.status)] ?? String(c.status)
      await db.from('outreach_niches').update({ campaign_state: campaigns[n.key] }).eq('key', n.key)
    } catch (e) {
      campaigns[n.key] = `unreadable: ${(e as Error).message.slice(0, 80)}`
    }
  }
  return { ok: true, workspace: workspace?.name ?? null, accounts, campaigns, webhook: !!s.webhook_id }
}

async function ensureWebhook(db: SupabaseClient, s: Settings): Promise<string> {
  if (s.webhook_id) {
    try { await ig('GET', `/webhooks/${s.webhook_id}`); return 'kept' } catch { /* gone: make a new one */ }
  }
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes)
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const hook = await ig<{ id: string }>('POST', '/webhooks', {
    name: 'Mission Control',
    target_hook_url: `${URL_}/functions/v1/outreach-webhook`,
    event_type: 'all_events',
    headers: { 'x-ql-hook': secret },
  })
  await db.from('outreach_settings').update({ webhook_id: hook.id, webhook_secret: secret, updated_at: new Date().toISOString() }).eq('id', 1)
  return 'created'
}

/** Our do-not-contact emails and domains, into Instantly's block list. */
async function syncBlocklist(db: SupabaseClient): Promise<number> {
  const { data } = await db.from('contact_suppressions').select('kind, value').in('kind', ['email', 'domain'])
  const values = [...new Set(((data ?? []) as { value: string }[]).map((r) => r.value).filter(Boolean))]
  for (let i = 0; i < values.length; i += 1000) {
    await ig('POST', '/block-lists-entries/bulk-create', { bl_values: values.slice(i, i + 1000) })
  }
  return values.length
}

async function sync(db: SupabaseClient) {
  const s = await loadSettings(db)
  const missing = [
    !s.sender_name && 'your name',
    !s.postal_address && 'a postal address',
    !s.sending_accounts.length && 'at least one sending inbox',
  ].filter(Boolean)
  if (missing.length) return { ok: false, error: `Fill in ${missing.join(', ')} under Sender first - every email must say who it is from.` }

  const webhook = await ensureWebhook(db, s)
  const blocked = await syncBlocklist(db)

  const { data } = await db.from('outreach_niches')
    .select('key, label, sequence, sequence_approved_at, instantly_campaign_id, campaign_state')
    .not('sequence_approved_at', 'is', null)
  const results: Record<string, string> = {}
  for (const n of (data ?? []) as NicheRow[]) {
    const body = campaignBody(n.label, n.sequence, s)
    try {
      if (n.instantly_campaign_id) {
        await ig('PATCH', `/campaigns/${n.instantly_campaign_id}`, body)
        results[n.key] = 'updated'
      } else {
        const c = await ig<{ id: string }>('POST', '/campaigns', body)
        await db.from('outreach_niches').update({ instantly_campaign_id: c.id, campaign_state: 'draft' }).eq('key', n.key)
        results[n.key] = 'created (paused until a batch is sent)'
      }
      await db.from('outreach_niches').update({ campaign_synced_at: new Date().toISOString() }).eq('key', n.key)
    } catch (e) {
      results[n.key] = `failed: ${(e as Error).message}`
    }
  }
  return { ok: true, webhook, blocklist: blocked, campaigns: results }
}

type Queued = {
  id: string; niche_key: string; business_name: string; website: string | null; email: string; phone: string | null
  contact_name: string | null; suburb: string | null; opener: string | null
}

async function push(db: SupabaseClient) {
  const { data, error } = await db.from('prospects')
    .select('id, niche_key, business_name, website, email, phone, contact_name, suburb, opener')
    .eq('status', 'queued').is('instantly_pushed_at', null).not('email', 'is', null).limit(1000)
  if (error) throw error
  const rows = (data ?? []) as Queued[]
  if (!rows.length) return { ok: true, pushed: 0, note: 'nothing queued' }

  const { data: nicheRows } = await db.from('outreach_niches').select('key, label, instantly_campaign_id, campaign_state')
  const niches = new Map(((nicheRows ?? []) as NicheRow[]).map((n) => [n.key, n]))
  const out: Record<string, unknown> = {}

  const byNiche = new Map<string, Queued[]>()
  for (const r of rows) byNiche.set(r.niche_key, [...(byNiche.get(r.niche_key) ?? []), r])
  for (const [key, group] of byNiche) {
    const n = niches.get(key)
    if (!n?.instantly_campaign_id) { out[key] = 'no campaign - press Sync first'; continue }

    // Last look at the do-not-contact list: an unsubscribe since approval wins.
    const ok: Queued[] = []
    for (const p of group) {
      const { data: blocked } = await db.rpc('contact_is_suppressed', { p_email: p.email, p_phone: p.phone })
      if (blocked === true) {
        await db.from('prospects').update({ status: 'blocked', status_reason: 'do not contact (added after approval)' }).eq('id', p.id)
      } else ok.push(p)
    }
    if (!ok.length) { out[key] = 'all blocked since approval'; continue }

    const r = await ig<Record<string, number>>('POST', '/leads/add', {
      campaign_id: n.instantly_campaign_id,
      skip_if_in_workspace: true,
      verify_leads_on_import: false,
      leads: ok.map((p) => ({
        email: p.email,
        first_name: p.contact_name ?? null,
        company_name: p.business_name,
        website: p.website,
        personalization: p.opener ?? '',
        custom_variables: { greet: p.contact_name || 'there', suburb: p.suburb || 'your area', ql_prospect_id: p.id },
      })),
    })
    const now = new Date().toISOString()
    await db.from('prospects').update({ instantly_pushed_at: now }).in('id', ok.map((p) => p.id))
    if (n.campaign_state !== 'active') {
      await ig('POST', `/campaigns/${n.instantly_campaign_id}/activate`)
      await db.from('outreach_niches').update({ campaign_state: 'active' }).eq('key', key)
    }
    out[key] = { sent_to_instantly: ok.length, uploaded: r.leads_uploaded ?? null, skipped: r.skipped_count ?? 0, in_blocklist: r.in_blocklist ?? 0, remaining_in_plan: r.remaining_in_plan ?? null }
  }
  return { ok: true, results: out }
}

async function setState(db: SupabaseClient, key: string, to: 'pause' | 'activate') {
  const { data } = await db.from('outreach_niches').select('instantly_campaign_id').eq('key', key).single()
  const id = (data as { instantly_campaign_id: string | null } | null)?.instantly_campaign_id
  if (!id) return { ok: false, error: 'This niche has no campaign yet' }
  await ig('POST', `/campaigns/${id}/${to}`)
  const state = to === 'pause' ? 'paused' : 'active'
  await db.from('outreach_niches').update({ campaign_state: state }).eq('key', key)
  return { ok: true, state }
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function authorised(bearer: string): Promise<boolean> {
  // The service-role key: proven by reading a table nothing else can.
  const { error: capErr } = await createClient(URL_, bearer).from('jarvis_messages').select('id').limit(1)
  if (!capErr) return true
  // A signed-in operator: the same gate every outreach RPC uses.
  const asUser = createClient(URL_, ANON || SERVICE, { global: { headers: { Authorization: `Bearer ${bearer}` } } })
  const { error } = await asUser.rpc('jarvis_assert_operator')
  return !error
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!bearer || !(await authorised(bearer))) return json({ error: 'Unauthorized' }, 401)

  const input = await req.json().catch(() => ({})) as { action?: string; niche?: string }
  const db = createClient(URL_, SERVICE)
  try {
    switch (input.action) {
      case 'status': return json(await status(db))
      case 'sync': return json(await sync(db))
      case 'push': return json(await push(db))
      case 'pause': return json(await setState(db, String(input.niche ?? ''), 'pause'))
      case 'resume': return json(await setState(db, String(input.niche ?? ''), 'activate'))
      default: return json({ error: 'Unknown action' }, 400)
    }
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 502)
  }
})
