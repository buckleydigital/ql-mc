// managed-campaigns - Phase 5: launch and watch the managed (done-for-you)
// campaigns that ql-hq's campaign-build left paused. Nothing here touches the
// pay-per-lead tables (meta_campaigns, meta_campaign_ids).
//
// From the dashboard (a signed-in user):
//   { action: 'list' }                         every managed campaign, with its stats
//   { action: 'preflight', id }                is it safe to switch on?
//   { action: 'launch', id }                   preflight, then ads, ad sets, campaign ACTIVE
//   { action: 'pause', id }                    campaign PAUSED
//   { action: 'set_target', client_id, cpl_target }   our CPL target for a client
// From the hourly job (the service key, as the other scheduled jobs call):
//   { action: 'watch' }                        refresh stats, raise or clear alerts
//
// Alerts land in managed_alerts, which jarvis_scan() reads, so Jarvis tells us
// and clears them by itself once the watch stops seeing the problem.
//
// Env: META_ACCESS_TOKEN, META_GRAPH_VERSION, QL_HQ_API_URL, QL_MC_API_SECRET.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH = `https://graph.facebook.com/${Deno.env.get('META_GRAPH_VERSION') || 'v23.0'}`
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

type G = Record<string, any>
const token = () => Deno.env.get('META_ACCESS_TOKEN') ?? ''

async function gget(path: string): Promise<G> {
  const r = await fetch(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token())}`)
  return await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }))
}
async function gpost(id: string, params: Record<string, string>): Promise<G> {
  const r = await fetch(`${GRAPH}/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: token() }),
  })
  return await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }))
}

// Leads the way meta-cost-check counts them.
function countLeads(actions: G[] | undefined): number {
  const n = (t: string) => Number(actions?.find((a) => a.action_type === t)?.value ?? 0)
  const lead = n('lead')
  return lead || n('offsite_conversion.fb_pixel_lead') + n('onsite_conversion.lead_grouped')
}
const act = (id: string) => (String(id).startsWith('act_') ? id : `act_${id}`)

type Check = { check: string; result: 'pass' | 'warn' | 'fail'; detail: string }

async function preflight(db: any, row: G): Promise<Check[]> {
  const out: Check[] = []
  const add = (check: string, result: Check['result'], detail: string) => out.push({ check, result, detail })

  const camp = await gget(`${row.meta_campaign_id}?fields=id,name,status,effective_status`)
  if (camp.error) { add('campaign', 'fail', camp.error.message); return out }
  add('campaign', 'pass', `${camp.name} (${camp.effective_status})`)

  const acc = await gget(`${act(row.ad_account_id)}?fields=account_status,disable_reason,funding_source_details`)
  if (acc.error) add('ad account', 'fail', acc.error.message)
  else if (acc.account_status !== 1) add('ad account', 'fail', `status ${acc.account_status}, not active`)
  else add('ad account', 'pass', 'active')
  if (!acc.error) {
    if (acc.funding_source_details) add('payment method', 'pass', acc.funding_source_details.display_string ?? 'on file')
    else add('payment method', 'fail', 'no payment method on the ad account')
  }

  const sets = await gget(`${row.meta_campaign_id}/adsets?fields=id,daily_budget,lifetime_budget&limit=50`)
  if (sets.error) add('ad sets', 'fail', sets.error.message)
  else if (!sets.data?.length) add('ad sets', 'fail', 'no ad sets')
  else if (sets.data.some((s: G) => !Number(s.daily_budget) && !Number(s.lifetime_budget))) add('budget', 'fail', 'an ad set has no budget')
  else add('ad sets', 'pass', `${sets.data.length}, $${sets.data.reduce((t: number, s: G) => t + Number(s.daily_budget || 0), 0) / 100}/day`)

  const ads = await gget(`${row.meta_campaign_id}/ads?fields=id,name,effective_status&limit=100`)
  if (ads.error) add('ads', 'fail', ads.error.message)
  else if (!ads.data?.length) add('ads', 'fail', 'no ads (the Meta app must be Live before ads can be made)')
  else {
    const bad = ads.data.filter((a: G) => a.effective_status === 'DISAPPROVED')
    const issues = ads.data.filter((a: G) => a.effective_status === 'WITH_ISSUES')
    if (bad.length) add('ads', 'fail', `${bad.length} rejected by Meta`)
    else if (issues.length) add('ads', 'warn', `${issues.length} with issues`)
    else add('ads', 'pass', `${ads.data.length} ready`)
  }

  const { data: client } = await db.from('clients').select('managed_cpl_target').eq('id', row.client_id).maybeSingle()
  if (client?.managed_cpl_target) add('CPL target', 'pass', `$${client.managed_cpl_target}`)
  else add('CPL target', 'warn', 'not set, so the watch cannot flag a high cost per lead')
  return out
}

async function setStatus(row: G, status: 'ACTIVE' | 'PAUSED'): Promise<string | null> {
  if (status === 'ACTIVE') {
    // Children first, so nothing is left paused under a live campaign.
    for (const edge of ['ads', 'adsets']) {
      const list = await gget(`${row.meta_campaign_id}/${edge}?fields=id,effective_status&limit=100`)
      if (list.error) return list.error.message
      for (const x of list.data ?? []) {
        if (x.effective_status === 'DISAPPROVED') continue
        const r = await gpost(x.id, { status: 'ACTIVE' })
        if (r.error) return `${edge} ${x.id}: ${r.error.message}`
      }
    }
  }
  const r = await gpost(row.meta_campaign_id, { status })
  return r.error ? r.error.message : null
}

async function watch(db: any) {
  const { data: rows } = await db.from('managed_campaigns')
    .select('*, clients(company_name, managed_cpl_target)').not('launched_at', 'is', null)
  const seen: string[] = []
  let checked = 0
  for (const row of rows ?? []) {
    const who = row.clients?.company_name ?? row.name ?? 'A managed client'
    const issues: G[] = []
    const raise = (type: string, tier: 'urgent' | 'notable', kind: string, payload: G = {}) => {
      issues.push({ type, tier, kind, ...payload })
      seen.push(`managed:${row.meta_campaign_id}:${type}`)
    }

    const camp = await gget(`${row.meta_campaign_id}?fields=effective_status,status,daily_budget`)
    if (camp.error) { raise('unreadable', 'urgent', `campaign unreadable: ${camp.error.message}`); }
    const acc = await gget(`${act(row.ad_account_id)}?fields=account_status`)
    if (!acc.error && acc.account_status !== 1) raise('account', 'urgent', `ad account status ${acc.account_status}, ads not running`)
    const ads = await gget(`${row.meta_campaign_id}/ads?fields=effective_status&limit=100`)
    const rejected = (ads.data ?? []).filter((a: G) => a.effective_status === 'DISAPPROVED').length
    if (rejected) raise('rejected', 'urgent', `${rejected} ad${rejected > 1 ? 's' : ''} rejected by Meta`)

    const sets = await gget(`${row.meta_campaign_id}/adsets?fields=daily_budget&limit=50`)
    const budget = Number(camp.daily_budget || 0) / 100 ||
      (sets.data ?? []).reduce((t: number, s: G) => t + Number(s.daily_budget || 0), 0) / 100
    const ins = async (preset: string) => {
      const r = await gget(`${row.meta_campaign_id}/insights?fields=spend,actions&date_preset=${preset}`)
      const d = r.data?.[0]
      return { spend: Number(d?.spend ?? 0), leads: countLeads(d?.actions) }
    }
    const today = await ins('today'), week = await ins('last_7d')
    // The last 48 hours: yesterday plus today.
    const yday = await ins('yesterday')
    const cpl = week.leads ? week.spend / week.leads : null
    const live = camp.effective_status === 'ACTIVE'

    if (live && budget && week.spend > budget * 7 * 1.1) raise('overspend', 'notable', `spent $${week.spend.toFixed(2)} in 7 days, over the $${budget}/day budget`)
    if (live && yday.spend + today.spend > 0 && yday.leads + today.leads === 0) raise('no_leads', 'notable', `no leads in 48 hours ($${(yday.spend + today.spend).toFixed(2)} spent)`)
    const target = Number(row.clients?.managed_cpl_target || 0)
    if (target && cpl !== null && cpl > target) raise('cpl', 'notable', `cost per lead $${cpl.toFixed(2)} over the $${target} target`)
    if (target && cpl === null && week.spend > target * 2) raise('cpl', 'notable', `$${week.spend.toFixed(2)} spent this week with no leads`)

    await db.from('managed_campaigns').update({
      effective_status: camp.effective_status ?? null, status: camp.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
      daily_budget: budget || null, spend_today: today.spend, spend_7d: week.spend, leads_7d: week.leads,
      cpl_7d: cpl, issues, checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', row.id)

    for (const i of issues) {
      await db.from('managed_alerts').upsert({
        dedup_key: `managed:${row.meta_campaign_id}:${i.type}`, managed_campaign_id: row.id,
        kind: i.kind, tier: i.tier, subject: who, payload: { campaign: row.name, client_id: row.client_id },
        active: true, updated_at: new Date().toISOString(),
      })
    }
    checked++
  }
  // Whatever wasn't seen this time has cleared.
  const { data: open } = await db.from('managed_alerts').select('dedup_key').eq('active', true)
  const gone = (open ?? []).map((a: G) => a.dedup_key).filter((k: string) => !seen.includes(k))
  if (gone.length) await db.from('managed_alerts').update({ active: false, updated_at: new Date().toISOString() }).in('dedup_key', gone)
  return { ok: true, checked, alerts: seen.length, cleared: gone.length }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const auth = req.headers.get('Authorization') ?? ''
  const caller = auth.replace('Bearer ', '').trim()
  if (!caller) return json({ error: 'unauthorized' }, 401)
  const body = await req.json().catch(() => ({})) as G
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  if (!token()) return json({ error: 'META_ACCESS_TOKEN not configured' }, 500)

  if (body.action === 'watch') {
    // The service key, proven by reading jarvis_messages, which nothing else can.
    const { error } = await createClient(url, caller).from('jarvis_messages').select('id').limit(1)
    if (error) return json({ error: 'unauthorized' }, 401)
    return json(await watch(db))
  }

  const { data: { user } } = await createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  }).auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const actor = (user.user_metadata?.full_name as string) || user.email || 'Team'

  if (body.action === 'list') {
    const { data, error } = await db.from('managed_campaigns')
      .select('*, clients(company_name, managed_cpl_target)').order('created_at', { ascending: false })
    return error ? json({ error: error.message }, 500) : json({ campaigns: data })
  }

  if (body.action === 'set_target') {
    const v = body.cpl_target === '' || body.cpl_target == null ? null : Number(body.cpl_target)
    if (v !== null && !(v > 0)) return json({ error: 'cpl_target must be a positive number' }, 400)
    const { error } = await db.from('clients').update({ managed_cpl_target: v }).eq('id', body.client_id)
    return error ? json({ error: error.message }, 500) : json({ ok: true })
  }

  const { data: row } = await db.from('managed_campaigns').select('*').eq('id', body.id).maybeSingle()
  if (!row) return json({ error: 'campaign not found' }, 404)

  if (body.action === 'preflight') return json({ checks: await preflight(db, row) })

  if (body.action === 'launch') {
    const checks = await preflight(db, row)
    if (checks.some((c) => c.result === 'fail')) return json({ ok: false, checks })
    const err = await setStatus(row, 'ACTIVE')
    if (err) return json({ ok: false, checks, error: err })
    const now = new Date().toISOString()
    await db.from('managed_campaigns').update({ status: 'ACTIVE', launched_at: row.launched_at ?? now, launched_by: actor, updated_at: now }).eq('id', row.id)
    await db.from('managed_launch_log').insert({ managed_campaign_id: row.id, client_id: row.client_id, action: 'launch', by_name: actor, daily_budget: row.daily_budget, preflight: checks })
    // Tick "Ads live" on the client's onboarding in HQ.
    let hq: unknown = null
    if (row.hq_company_id && Deno.env.get('QL_HQ_API_URL')) {
      const r = await fetch(`${Deno.env.get('QL_HQ_API_URL')}/sync-from-mc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': Deno.env.get('QL_MC_API_SECRET') ?? '' },
        body: JSON.stringify({ action: 'mark_ads_live', ql_hq_company_id: row.hq_company_id, actor_name: actor }),
      }).catch((e) => ({ ok: false, statusText: String(e) }) as Response)
      hq = r.ok ? 'ads live ticked' : `HQ not updated: ${r.statusText}`
    }
    return json({ ok: true, checks, hq })
  }

  if (body.action === 'pause') {
    const err = await setStatus(row, 'PAUSED')
    if (err) return json({ ok: false, error: err })
    await db.from('managed_campaigns').update({ status: 'PAUSED', updated_at: new Date().toISOString() }).eq('id', row.id)
    await db.from('managed_launch_log').insert({ managed_campaign_id: row.id, client_id: row.client_id, action: 'pause', by_name: actor })
    return json({ ok: true })
  }

  return json({ error: 'unknown action' }, 400)
})
