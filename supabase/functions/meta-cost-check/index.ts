// Cost cut-off for pay-per-lead campaigns.
//
// For every campaign feeding an outstanding order (ppl_order_log in_progress,
// linked through clients.meta_campaign_ids), pull the last WINDOW_DAYS of spend
// and leads from Meta and work out cost per lead. Then:
//   - an order whose max cost per lead is below that is flagged (cpl_breached_at)
//   - a campaign whose cost is above the max_cpl of EVERY outstanding order on
//     it is paused in Meta and marked cost_paused, the same "only pause when
//     nobody on it still wants leads" rule meta-cap-check uses for caps
// An order's max is its own max_cpl if set, otherwise the most a lead can cost
// Meta and still leave business_settings.target_margin_pct (see maxCplFor).
// An order with neither has no limit, so it keeps its campaigns running.
// Anything newly flagged or paused is emailed. A cost pause sticks until the
// campaign is resumed from MC, which clears it (see meta-campaign-toggle).
//
// POST {} runs it; POST {"dry_run":true} works everything out and changes
// nothing. Callable by a signed-in MC user or with the service role key.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const WINDOW_DAYS = 3
const NOTIFY_TO = 'contact@quoteleads.com.au'

type CplSettings = {
  margin: number; dud: number; stripe: number; gstRate: number;
  priceIncludesGst: boolean; repCommission: number; commissionBase: 'ex' | 'inc';
  stripeFixed: number;
}

type Order = {
  client_id: string
  company_name: string
  leads_qty: number
  lead_price: number | null
  max_cpl: number | null
  max_source: 'order' | 'default' | 'none'
  cpl_breached_at: string | null
  repCommission: number | null
  commissionBase: 'ex' | 'inc' | null
}

type CampaignResult = {
  campaign_id: string
  spend: number
  leads: number
  cpl: number | null
  limit: number | null
  orders: Array<{ order_id: string; company_name: string; max_cpl: number | null; max_source: string; breached: boolean }>
  action: 'pause' | 'already_cost_paused' | 'ok' | 'no_spend' | 'error'
  error?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    const db = createClient(supabaseUrl, serviceKey)

    const isServiceRole = authHeader === `Bearer ${serviceKey}`
    let userId: string | null = null
    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error: authError } = await userClient.auth.getUser()
      if (authError || !user) throw new Error('Unauthorized')
      userId = user.id
    }

    let dryRun = false
    try {
      const body = await req.json()
      dryRun = body?.dry_run === true
    } catch (_) { /* empty body is fine */ }

    const metaToken = Deno.env.get('META_ACCESS_TOKEN')
    if (!metaToken) throw new Error('META_ACCESS_TOKEN not configured')

    const { data: settings } = await db
      .from('business_settings').select('target_margin_pct,dud_rate_pct,stripe_fee_pct,gst_rate_pct,price_includes_gst,rep_commission_pct,commission_base,stripe_fee_fixed').limit(1).maybeSingle()
    const margin = settings?.target_margin_pct == null ? null : {
      margin: Number(settings.target_margin_pct),
      dud: Number(settings.dud_rate_pct ?? 0),
      stripe: Number(settings.stripe_fee_pct ?? 0),
      gstRate: Number(settings.gst_rate_pct ?? 10),
      priceIncludesGst: settings.price_includes_gst === true,
      repCommission: Number(settings.rep_commission_pct ?? 0),
      commissionBase: settings.commission_base ?? 'ex',
      stripeFixed: Number(settings.stripe_fee_fixed ?? 0),
    }

    // ── Outstanding orders and the campaigns that feed them ──
    const { data: orderRows, error: orderErr } = await db
      .from('ppl_order_log')
      .select('id,client_id,leads_qty,lead_price,max_cpl,cpl_breached_at,rep_commission_pct,commission_base,clients!inner(company_name,type,meta_campaign_ids)')
      .eq('status', 'in_progress')
      .eq('clients.type', 'ppl')
    if (orderErr) throw new Error(`DB error: ${orderErr.message}`)

    const ordersByCampaign: Record<string, Order[]> = {}
    for (const r of orderRows || []) {
      // deno-lint-ignore no-explicit-any
      const client = (r as any).clients
      const leadPrice = r.lead_price === null ? null : Number(r.lead_price)
      const own = r.max_cpl === null ? null : Number(r.max_cpl)
      const fallback = margin && leadPrice ? maxCplFor(leadPrice, mergeSettings(margin, r.rep_commission_pct == null ? null : Number(r.rep_commission_pct), r.commission_base)) : null
      const order: Order = {
        id: r.id,
        client_id: r.client_id,
        company_name: client?.company_name ?? '',
        leads_qty: r.leads_qty,
        lead_price: leadPrice,
        max_cpl: own ?? fallback,
        max_source: own !== null ? 'order' : fallback !== null ? 'default' : 'none',
        cpl_breached_at: r.cpl_breached_at,
        repCommission: r.rep_commission_pct == null ? null : Number(r.rep_commission_pct),
        commissionBase: r.commission_base,
      }
      for (const cid of (client?.meta_campaign_ids || []) as string[]) {
        if (!ordersByCampaign[cid]) ordersByCampaign[cid] = []
        ordersByCampaign[cid].push(order)
      }
    }

    const campaignIds = Object.keys(ordersByCampaign)
    if (campaignIds.length === 0) {
      return json({ message: 'No outstanding orders with campaigns', dry_run: dryRun, campaigns: [] })
    }

    const { data: existing } = await db
      .from('meta_campaigns')
      .select('meta_campaign_id,cost_paused')
      .in('meta_campaign_id', campaignIds)
    const costPaused = new Set((existing || []).filter(c => c.cost_paused).map(c => c.meta_campaign_id))
    const known = new Set((existing || []).map(c => c.meta_campaign_id))

    // Last WINDOW_DAYS days including today.
    const now = new Date()
    const until = now.toISOString().slice(0, 10)
    const sinceDate = new Date(now)
    sinceDate.setUTCDate(now.getUTCDate() - (WINDOW_DAYS - 1))
    const since = sinceDate.toISOString().slice(0, 10)

    const results: CampaignResult[] = []
    const breachedOrderIds = new Set<string>()
    const okOrderIds = new Set<string>()

    for (const cid of campaignIds) {
      const orders = ordersByCampaign[cid]
      try {
        const url = `https://graph.facebook.com/v21.0/${cid}/insights?fields=spend,actions&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&access_token=${metaToken}`
        const res = await fetch(url)
        const data = await res.json()
        if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`)

        const row = data.data?.[0]
        const spend = parseFloat(row?.spend || '0')
        const leads = countLeads(row?.actions)

        // No limit on an order counts as never breached.
        const limit = orders.some(o => o.max_cpl === null)
          ? null
          : Math.max(...orders.map(o => o.max_cpl as number))

        if (spend <= 0) {
          results.push({
            campaign_id: cid, spend, leads, cpl: null, limit,
            orders: orders.map(o => ({ order_id: o.id, company_name: o.company_name, max_cpl: o.max_cpl, max_source: o.max_source, breached: false })),
            action: costPaused.has(cid) ? 'already_cost_paused' : 'no_spend',
          })
          continue
        }

        // No leads yet: everything spent so far is the cost of the next one.
        const cpl = spend / Math.max(leads, 1)
        const orderStates = orders.map(o => {
          const breached = o.max_cpl !== null && cpl > o.max_cpl
          if (breached) breachedOrderIds.add(o.id)
          else okOrderIds.add(o.id)
          return { order_id: o.id, company_name: o.company_name, max_cpl: o.max_cpl, max_source: o.max_source, breached }
        })

        const overLimit = limit !== null && cpl > limit
        results.push({
          campaign_id: cid, spend, leads, cpl: round(cpl), limit, orders: orderStates,
          action: costPaused.has(cid) ? 'already_cost_paused' : overLimit ? 'pause' : 'ok',
        })
      } catch (err) {
        results.push({
          campaign_id: cid, spend: 0, leads: 0, cpl: null, limit: null,
          orders: orders.map(o => ({ order_id: o.id, company_name: o.company_name, max_cpl: o.max_cpl, max_source: o.max_source, breached: false })),
          action: 'error', error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // An order fed by several campaigns is breached if any of them is over its max.
    for (const id of breachedOrderIds) okOrderIds.delete(id)

    const allOrders = new Map<string, Order>()
    for (const list of Object.values(ordersByCampaign)) for (const o of list) allOrders.set(o.id, o)
    const newlyBreached = [...breachedOrderIds].map(id => allOrders.get(id)!).filter(o => !o.cpl_breached_at)
    const recovered = [...okOrderIds].map(id => allOrders.get(id)!).filter(o => o.cpl_breached_at)

    const pauseResults: Array<{ campaign_id: string; success: boolean; error?: string }> = []

    if (!dryRun) {
      const nowIso = new Date().toISOString()

      for (const r of results) {
        if (r.action === 'pause') {
          const res = await setCampaignStatus(r.campaign_id, 'PAUSED', metaToken)
          pauseResults.push(res)
          if (!res.success) r.action = 'error'
          if (!res.success) r.error = res.error
        }
      }

      for (const r of results) {
        if (r.action === 'error' && r.cpl === null) continue
        const paused = pauseResults.some(p => p.campaign_id === r.campaign_id && p.success)
        const upd: Record<string, unknown> = {
          spend_3d: round(r.spend),
          leads_3d: r.leads,
          cpl_3d: r.cpl,
          cost_checked_at: nowIso,
          updated_at: nowIso,
        }
        if (paused) {
          Object.assign(upd, {
            status: 'PAUSED',
            cost_paused: true,
            cost_paused_at: nowIso,
            cost_pause_reason: `Cost per lead $${r.cpl} over ${WINDOW_DAYS} days is above the max of every outstanding order ($${r.limit})`,
          })
        }
        if (known.has(r.campaign_id)) {
          await db.from('meta_campaigns').update(upd).eq('meta_campaign_id', r.campaign_id)
        } else if (paused) {
          // Only linked on the client so far: add it so the cost pause is recorded.
          await db.from('meta_campaigns').insert({ meta_campaign_id: r.campaign_id, name: r.campaign_id, ...upd })
        }
      }

      if (newlyBreached.length) {
        await db.from('ppl_order_log').update({ cpl_breached_at: nowIso }).in('id', newlyBreached.map(o => o.id))
      }
      if (recovered.length) {
        await db.from('ppl_order_log').update({ cpl_breached_at: null }).in('id', recovered.map(o => o.id))
      }

      await db.from('meta_api_log').insert({
        action: 'COST_CHECK',
        campaign_ids: results.filter(r => r.action === 'pause').map(r => r.campaign_id),
        results: { window_days: WINDOW_DAYS, since, until, campaigns: results, pause_results: pauseResults },
        triggered_by: isServiceRole ? 'cron' : userId,
      })

      const paused = results.filter(r => r.action === 'pause')
      if (paused.length || newlyBreached.length) {
        await sendAlert(paused, newlyBreached, results)
      }
    }

    return json({
      dry_run: dryRun,
      margin_settings: margin,
      window: { since, until },
      checked_campaigns: results.length,
      paused: results.filter(r => r.action === 'pause').map(r => r.campaign_id),
      newly_breached_orders: newlyBreached.map(o => ({ order_id: o.id, company_name: o.company_name, max_cpl: o.max_cpl })),
      recovered_orders: recovered.map(o => o.id),
      campaigns: results,
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// The most Meta can charge per lead and still leave the target margin of the
// price ex GST, after paying the rep commission, giving away dud replacements
// and paying Stripe.
//
//   price ex-GST by default (priceIncludesGst = false):
//     revenue = price, gross = price x (1 + gst rate)
//   price includes GST (priceIncludesGst = true):
//     revenue = price / (1 + gst rate), gross = price
//   commission = commission base x rep commission %, base is revenue ex-GST
//     by default ('ex') or the customer payment incl GST ('inc')
//   max CPL = (revenue - commission - stripe - margin kept) / (1 + dud rate)
//
// price includes GST; Meta spend has none. Same formula as maxCplFor in MC.
function maxCplFor(price: number, s: CplSettings): number {
  const gst = s.gstRate / 100
  const gross = s.priceIncludesGst ? price : price * (1 + gst)
  const revenue = s.priceIncludesGst ? price / (1 + gst) : price
  const base = s.commissionBase === 'inc' ? gross : revenue
  const rep = base * s.repCommission / 100
  const stripe = gross * s.stripe / 100 + s.stripeFixed
  const kept = revenue * s.margin / 100
  return round(Math.max(0, (revenue - rep - stripe - kept) / (1 + s.dud / 100)))
}

// Merge business-level settings with order-level overrides. Order-level
// repCommission / commissionBase win when set; otherwise the business default
// applies (which itself defaults to ex-GST / 15% / $0.30 fixed).
function mergeSettings(base: CplSettings, repCommission: number | null, commissionBase: 'ex' | 'inc' | null): CplSettings {
  return {
    ...base,
    repCommission: repCommission ?? base.repCommission,
    commissionBase: commissionBase ?? base.commissionBase,
  };
}

// Meta's "lead" action already totals pixel and on-Facebook form leads, so use
// it when present and only add the parts up when it is missing.
// deno-lint-ignore no-explicit-any
function countLeads(actions: any[] | undefined): number {
  if (!actions) return 0
  const get = (t: string) => {
    const a = actions.find(x => x.action_type === t)
    return a ? parseInt(a.value || '0', 10) : 0
  }
  const total = get('lead')
  if (total > 0) return total
  return get('offsite_conversion.fb_pixel_lead') + get('onsite_conversion.lead_grouped')
}

async function setCampaignStatus(id: string, status: 'PAUSED' | 'ACTIVE', token: string) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, access_token: token }),
    })
    const data = await res.json()
    if (!res.ok || data.error) return { campaign_id: id, success: false, error: data.error?.message || `HTTP ${res.status}` }
    return { campaign_id: id, success: true }
  } catch (err) {
    return { campaign_id: id, success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function sendAlert(paused: CampaignResult[], breached: Order[], results: CampaignResult[]) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL')
  if (!apiKey || !fromEmail) return

  const cplFor = (orderId: string) =>
    Math.max(...results.filter(r => r.cpl !== null && r.orders.some(o => o.order_id === orderId)).map(r => r.cpl as number))

  let body = `<p>Cost check over the last ${WINDOW_DAYS} days.</p>`
  if (paused.length) {
    body += '<p><b>Campaigns paused</b> (cost per lead above every outstanding order\'s max):</p><ul>'
    for (const r of paused) {
      body += `<li>${esc(r.campaign_id)}: $${r.cpl} per lead ($${round(r.spend)} spend, ${r.leads} leads), highest max $${r.limit}. Orders: ${esc(r.orders.map(o => o.company_name).join(', '))}</li>`
    }
    body += '</ul><p>They stay paused until resumed from Mission Control.</p>'
  }
  if (breached.length) {
    body += '<p><b>Orders now over their max cost per lead:</b></p><ul>'
    for (const o of breached) {
      body += `<li>${esc(o.company_name)}: max $${o.max_cpl}${o.max_source === 'default' ? ' (default)' : ''}, currently $${round(cplFor(o.id))} per lead (${o.leads_qty} lead order${o.lead_price ? ` at $${o.lead_price}` : ''})</li>`
    }
    body += '</ul><p>Their campaigns keep running while another order on them is still under its max. Decide whether to keep going or stop the order and refund what is undelivered.</p>'
  }

  const subject = paused.length
    ? `Cost cut-off: ${paused.length} campaign${paused.length === 1 ? '' : 's'} paused`
    : `Cost cut-off: ${breached.length} order${breached.length === 1 ? '' : 's'} over max cost per lead`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `QuoteLeads <${fromEmail}>`, to: [NOTIFY_TO], subject, html: body }),
  }).catch(() => {})
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

function esc(s: string) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
