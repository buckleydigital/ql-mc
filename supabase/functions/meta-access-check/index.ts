// meta-access-check - what can the system user see in Meta right now?
//
// Read-only. Lists the ad accounts and Pages shared with the QuoteLeads
// Business Manager (and the ones it owns), with the health of each ad account,
// and matches them to Mission Control clients by ad account ID. Writes nothing
// to Meta and nothing to the database.
//
// It answers the question Phase 1 (detecting client access) depends on: can
// this token see what clients share with us, before Meta's app review and
// business verification are done? It is also the first half of that watch.
//
// POST {} with the service role key, the way the scheduled jobs call functions
// (the jarvis_service_key in the vault).
//
// Env: META_ACCESS_TOKEN (the system user token), META_BUSINESS_ID (defaults to
// the QuoteLeads Business Manager), META_GRAPH_VERSION (defaults below).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUSINESS_ID = Deno.env.get('META_BUSINESS_ID') || '1065750507426304'
const GRAPH = `https://graph.facebook.com/${Deno.env.get('META_GRAPH_VERSION') || 'v23.0'}`

// Meta's account_status codes, so the result reads without a lookup table.
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'active', 2: 'disabled', 3: 'unsettled', 7: 'pending risk review',
  8: 'pending settlement', 9: 'in grace period', 100: 'pending closure',
  101: 'closed', 201: 'any active', 202: 'any closed',
}

const AD_ACCOUNT_FIELDS = 'account_id,name,account_status,disable_reason,currency,timezone_name,business{id,name}'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } })
}

type GraphError = { message: string; code?: number; error_subcode?: number; type?: string }

// Every page of a Graph edge, or the error that stopped it.
async function graphList(path: string, token: string): Promise<{ data: Record<string, unknown>[]; error?: GraphError }> {
  const out: Record<string, unknown>[] = []
  let url: string | null = `${GRAPH}/${path}${path.includes('?') ? '&' : '?'}limit=100&access_token=${encodeURIComponent(token)}`
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url)
    const body: { data?: Record<string, unknown>[]; error?: GraphError; paging?: { next?: string } } = await res.json().catch(() => ({}))
    if (!res.ok || body.error) return { data: out, error: body.error ?? { message: `HTTP ${res.status}` } }
    out.push(...(body.data ?? []))
    url = body.paging?.next ?? null
  }
  return { data: out }
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')

Deno.serve(async (req: Request) => {
  // The service-role key, proven by reading jarvis_messages, which nothing
  // else can (the same check ppl-area-refresh uses for pg_cron's key).
  const caller = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!caller) return json({ error: 'unauthorized' }, 401)
  const { error: capErr } = await createClient(Deno.env.get('SUPABASE_URL')!, caller)
    .from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'unauthorized' }, 401)
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const token = Deno.env.get('META_ACCESS_TOKEN')
  if (!token) return json({ error: 'META_ACCESS_TOKEN not configured' }, 500)

  const meRes = await fetch(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(token)}`)
  const me = await meRes.json().catch(() => ({}))
  if (!meRes.ok || me.error) return json({ ok: false, step: 'token', error: me.error ?? { message: `HTTP ${meRes.status}` } })

  // { "probe_account": "123" }: how Meta reports one ad account to us, and
  // through what relationship we can see it. Still read-only.
  const body = await req.json().catch(() => ({})) as { probe_account?: string }
  const probe = digits(body.probe_account)
  if (probe) {
    const get = async (path: string) => {
      const r = await fetch(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`)
      return await r.json().catch(() => ({}))
    }
    const [account, assigned, agencies, pending] = await Promise.all([
      get(`act_${probe}?fields=account_id,name,account_status,currency,business{id,name},owner`),
      get(`act_${probe}/assigned_users?business=${BUSINESS_ID}&fields=id,name,tasks`),
      get(`act_${probe}/agencies?fields=id,name,access_status,access_requested_time`),
      get(`${BUSINESS_ID}/pending_client_ad_accounts?fields=ad_account{account_id,name},access_status`),
    ])
    return json({ ok: true, token_user: me, probe, account, assigned_users: assigned, agencies, pending_client_ad_accounts: pending })
  }

  const [shared, owned, sharedPages, ownedPages] = await Promise.all([
    graphList(`${BUSINESS_ID}/client_ad_accounts?fields=${AD_ACCOUNT_FIELDS}`, token),
    graphList(`${BUSINESS_ID}/owned_ad_accounts?fields=${AD_ACCOUNT_FIELDS}`, token),
    graphList(`${BUSINESS_ID}/client_pages?fields=id,name,is_published,link`, token),
    graphList(`${BUSINESS_ID}/owned_pages?fields=id,name,is_published,link`, token),
  ])

  // Mission Control clients, matched on the ad account ID they hold.
  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey)
  const { data: clients } = await db.from('clients').select('id, company_name, type, stage, ad_account_id')
  const byAccount = new Map<string, { company_name: string; type: string; stage: string }>()
  for (const c of clients ?? []) {
    const id = digits(c.ad_account_id)
    if (id) byAccount.set(id, { company_name: c.company_name, type: c.type, stage: c.stage })
  }

  const describe = (a: Record<string, unknown>, relation: 'shared' | 'owned') => ({
    relation,
    account_id: a.account_id,
    name: a.name,
    status: ACCOUNT_STATUS[a.account_status as number] ?? a.account_status,
    disable_reason: a.disable_reason || null,
    currency: a.currency,
    timezone: a.timezone_name,
    owner_business: (a.business as { name?: string } | undefined)?.name ?? null,
    mc_client: byAccount.get(digits(a.account_id)) ?? null,
  })
  const accounts = [
    ...shared.data.map((a) => describe(a, 'shared')),
    ...owned.data.map((a) => describe(a, 'owned')),
  ]
  const seen = new Set(accounts.map((a) => digits(a.account_id)))
  const clientsNotVisible = (clients ?? [])
    .filter((c) => digits(c.ad_account_id) && !seen.has(digits(c.ad_account_id)) && c.stage === 'active')
    .map((c) => ({ company_name: c.company_name, type: c.type, ad_account_id: c.ad_account_id }))

  return json({
    ok: true,
    token_user: me,
    business_id: BUSINESS_ID,
    graph: GRAPH,
    errors: {
      client_ad_accounts: shared.error ?? null,
      owned_ad_accounts: owned.error ?? null,
      client_pages: sharedPages.error ?? null,
      owned_pages: ownedPages.error ?? null,
    },
    counts: {
      shared_ad_accounts: shared.data.length,
      owned_ad_accounts: owned.data.length,
      shared_pages: sharedPages.data.length,
      owned_pages: ownedPages.data.length,
      matched_to_mc_clients: accounts.filter((a) => a.mc_client).length,
    },
    ad_accounts: accounts,
    pages: [
      ...sharedPages.data.map((p) => ({ relation: 'shared', ...p })),
      ...ownedPages.data.map((p) => ({ relation: 'owned', ...p })),
    ],
    active_clients_not_visible: clientsNotVisible,
  })
})
