/**
 * The QuoteLeads tool surface.
 *
 * TOOL NAMING IS LOad-BEARING. JARVIS's bridge decides permissions by reading
 * verbs out of the tool name (bridge/server.mjs, decideTool):
 *
 *   - EFFECTFUL_VERB is unanchored and tested FIRST. Any name containing
 *     send/create/update/post/delete/pay/... is held behind JARVIS_ALLOW_WRITES.
 *   - READ_VERB is anchored: a read tool must START with get/list/find/check/...
 *
 * So every read below leads with `get`/`find` and contains no effectful
 * substring anywhere, and every write is named with the verb that describes
 * what it does. That is what makes `npm run bridge` safe to leave running and
 * `npm run bridge:writes` a deliberate act.
 */

import { select, count, patch, insert, remove, invoke, rpc } from './db.mjs'
import { config, stageKey, env } from './config.mjs'
import { EXPLORE_TOOLS } from './explore.mjs'
import { MEMORY_TOOLS } from './memory.mjs'
import { CONTENT_TOOLS } from './content.mjs'
import { OUTREACH_TOOLS } from './outreach.mjs'
import { userToken } from './auth.mjs'
import { localDate, localMonth, startOfLocalDay, daysAgo, startOfMonth } from './dates.mjs'

const money = (n) =>
  `${config.currency} ${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`

const sum = (rows, key) => rows.reduce((t, r) => t + Number(r[key] || 0), 0)
const norm = (s) => String(s ?? '').trim().toLowerCase()
const isDead = (stage) => config.deadStages.includes(stageKey(stage))
const isWon = (stage) => config.wonStages.includes(stageKey(stage))

/** PostgREST `in` needs the quoted-list form: in.("a","b") */
const inList = (values) => `in.(${values.map((v) => `"${v}"`).join(',')})`

const ok = (summary, data) => ({ summary, ...data })

// ---------------------------------------------------------------- reads

async function getLeadsToday() {
  const today = startOfLocalDay(localDate())
  const [todayRows, weekRows] = await Promise.all([
    select('leads', { select: 'id,stage,source,niche,value', created_at: `gte.${today}` }, { limit: 2000 }),
    select('leads', { select: 'id,created_at', created_at: `gte.${daysAgo(7)}` }, { limit: 5000 }),
  ])

  // Yesterday, from the same seven-day pull rather than a second round trip.
  const yStart = daysAgo(1)
  const yesterday = weekRows.rows.filter((r) => r.created_at >= yStart && r.created_at < today).length
  const priorSix = weekRows.rows.filter((r) => r.created_at < today).length
  const dailyAverage = Math.round((priorSix / 6) * 10) / 10

  const bySource = {}
  for (const r of todayRows.rows) bySource[r.source || 'unknown'] = (bySource[r.source || 'unknown'] || 0) + 1

  const n = todayRows.total
  return ok(
    `${n} lead${n === 1 ? '' : 's'} today. Yesterday was ${yesterday}; the seven-day average is ${dailyAverage}.`,
    { today: n, yesterday, daily_average_7d: dailyAverage, by_source: bySource, date: localDate() },
  )
}

async function getPipelineSummary() {
  const { rows, total } = await select(
    'leads',
    { select: 'stage,value,owner_id', order: 'created_at.desc' },
    { limit: 10000 },
  )

  const stages = {}
  let openValue = 0
  for (const r of rows) {
    const stage = r.stage || 'unset'
    stages[stage] ??= { count: 0, value: 0 }
    stages[stage].count += 1
    stages[stage].value += Number(r.value || 0)
    if (!isDead(r.stage) && !isWon(r.stage)) openValue += Number(r.value || 0)
  }

  const open = rows.filter((r) => !isDead(r.stage) && !isWon(r.stage)).length
  const ranked = Object.entries(stages)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([stage, s]) => `${s.count} ${stage}`)

  return ok(
    `${open} open leads worth ${money(openValue)}. ${ranked.slice(0, 4).join(', ')}.`,
    { total_leads: total, open_leads: open, open_value: openValue, by_stage: stages },
  )
}

/**
 * The months a managed client's retainer is attributed to.
 *
 * Mirrors mgPaymentMonths() in index.html: `active_months` is a JSON array of
 * YYYY-MM, and `retainer_payment_dates` can remap any of them to the month the
 * money actually arrived. Cash basis, so a fee counts in the month it was paid.
 */
function retainerMonths(client) {
  let months = []
  let paid = {}
  try { months = JSON.parse(client.active_months || '[]') } catch {}
  try { paid = JSON.parse(client.retainer_payment_dates || '{}') } catch {}
  return months.map((m) => (paid?.[m] ? String(paid[m]).slice(0, 7) : m))
}

/**
 * Revenue is not a table. The `revenue` table exists in the schema but nothing
 * writes to it - the app computes revenue from three sources, and so does this
 * (loadFinance / renderFinance in index.html):
 *
 *   pay-per-lead   ppl_order_log, leads_qty x lead_price
 *   managed custom managed_order_log.amount
 *   retainers      managed clients, fee x months attributed to the period
 */
async function getRevenueVsGoal({ month } = {}) {
  const target = month || localMonth()
  const from = `${target}-01`
  const end = new Date(`${from}T12:00:00Z`)
  end.setUTCMonth(end.getUTCMonth() + 1)
  const next = end.toISOString().slice(0, 8) + '01'

  const [pplOrders, mgOrders, mgClients, goals, expenses, spendLog] = await Promise.all([
    select('ppl_order_log', { select: 'leads_qty,lead_price,order_date', order_date: `gte.${from}`, and: `(order_date.lt.${next})` }, { limit: 5000 }),
    select('managed_order_log', { select: 'amount,order_date', order_date: `gte.${from}`, and: `(order_date.lt.${next})` }, { limit: 5000 }),
    select('clients', { select: 'company_name,management_fee,active_months,retainer_payment_dates,payments_made,stage', type: 'eq.managed' }, { limit: 500 }),
    select('monthly_goals', { select: 'month,revenue_goal,margin_goal' }, { limit: 200 }),
    select('expenses', { select: 'amount,category,date', date: `gte.${from}`, and: `(date.lt.${next})` }, { limit: 5000 }),
    select('campaign_spend_log', { select: 'spend,leads,period', period: `eq.${target}` }, { limit: 2000 }),
  ])

  const pplRevenue = pplOrders.rows.reduce((s, o) => s + Number(o.leads_qty || 0) * Number(o.lead_price || 0), 0)
  const managedCustom = sum(mgOrders.rows, 'amount')
  const retainers = mgClients.rows.reduce(
    (s, c) => s + retainerMonths(c).filter((m) => m === target).length * Number(c.management_fee || 0),
    0,
  )

  const revenue = pplRevenue + managedCustom + retainers
  // The app counts ad spend as an expense alongside the expenses table.
  const adSpend = sum(spendLog.rows, 'spend')
  const costs = sum(expenses.rows, 'amount') + adSpend

  const goal = goals.rows.find((g) => norm(g.month) === target)
  const revenueGoal = Number(goal?.revenue_goal || 0)
  const pct = revenueGoal ? Math.round((revenue / revenueGoal) * 100) : null

  const summary = revenueGoal
    ? `${money(revenue)} booked this month against a goal of ${money(revenueGoal)}. That is ${pct} percent.`
    : `${money(revenue)} booked this month. No revenue goal is set for ${target}.`

  return ok(summary, {
    month: target,
    revenue,
    revenue_goal: revenueGoal || null,
    pct_of_goal: pct,
    breakdown: { pay_per_lead: pplRevenue, managed_custom: managedCustom, retainers },
    costs,
    ad_spend: adSpend,
    margin: revenue - costs,
    margin_goal: Number(goal?.margin_goal || 0) || null,
  })
}

/**
 * Spend and cost per lead.
 *
 * Two sources, and they work differently:
 *
 *   - campaign_spend_log is the pay-per-lead source of truth, keyed by a
 *     YYYY-MM `period`. Monthly granularity - there is no daily figure.
 *   - ad_spend_daily.day_spend for account_type 'agency' is what the
 *     QuoteLeads ad account spent that day (synced from Meta each morning).
 *     A period's spend is those days added up. (ad_spend_daily.spend on the
 *     same rows is the running total for the year: never add that up.)
 */
async function getAdSpendAndCpl({ month } = {}) {
  const target = month || localMonth()
  const from = `${target}-01`
  const end = new Date(`${from}T12:00:00Z`)
  end.setUTCMonth(end.getUTCMonth() + 1)
  const next = end.toISOString().slice(0, 8) + '01'

  const [spendLog, days] = await Promise.all([
    select('campaign_spend_log', { select: 'campaign_name,spend,leads,period,source', period: `eq.${target}` }, { limit: 2000 }),
    select('ad_spend_daily', { select: 'date,day_spend', account_type: 'eq.agency', date: `gte.${from}`, and: `(date.lt.${next})`, order: 'date.desc' }, { limit: 40 }),
  ])

  const pplSpend = sum(spendLog.rows, 'spend')
  const pplLeads = spendLog.rows.reduce((s, r) => s + Number(r.leads || 0), 0)
  const cpl = pplLeads ? Math.round((pplSpend / pplLeads) * 100) / 100 : null
  const agencySpend = Math.round(sum(days.rows, 'day_spend') * 100) / 100

  return ok(
    pplLeads
      ? `${money(pplSpend)} on pay-per-lead advertising this month for ${pplLeads} leads, a cost per lead of ${money(cpl)}. Agency spend is ${money(agencySpend)}.`
      : `No pay-per-lead spend is logged for ${target}. Agency spend is ${money(agencySpend)}.`,
    {
      month: target,
      pay_per_lead: { spend: pplSpend, leads: pplLeads, cpl, campaigns: spendLog.rows.length },
      agency: { spend: agencySpend, as_at: days.rows[0]?.date ?? null },
      total_spend: pplSpend + agencySpend,
      note: 'Pay-per-lead spend is logged monthly. Agency spend is the QuoteLeads ad account, added up day by day. For the full sales metrics (CPL against pipeline leads, CAC, ROAS) use get_sales_metrics.',
    },
  )
}

/**
 * The Scoreboard's 15 sales metrics for a period, computed in the database
 * (sales_metrics) exactly as the dashboard shows them. Optionally one rep's
 * leads, with their share of ad spend.
 */
async function getSalesMetrics({ from, to, rep } = {}) {
  let owner = null
  if (rep) {
    const reps = await select('sales_reps', { select: 'user_id,name,email' }, { limit: 200 })
    const q = norm(rep)
    const hit = reps.rows.find((r) => norm(r.name || r.email).includes(q))
    if (!hit) return ok(`I have no record of a representative named ${rep}.`, { reps: reps.rows.map((r) => r.name || r.email) })
    owner = hit.user_id
  }
  const m = await rpc('sales_metrics', { p_from: from || null, p_to: to || null, p_owner: owner })
  return ok(
    `${m.from} to ${m.to}: ${m.lead_volume} leads, ${m.sales} sales, ${money(m.revenue_incl_gst)} revenue, ${money(m.spent_on_ads)} on ads.`,
    {
      metrics: m,
      definitions: 'Leads, contactable: leads that came in during the period. Sent offer: offers sent during it. Sales and revenue: deals won during it (revenue incl. GST). Spend: QuoteLeads ad account, day by day. CAC = spend / sales. Avg gross profit per sale = (revenue / 1.1 - spend) / sales. Average LTV = total billed to the business, else the deal value.',
    },
  )
}

/**
 * Monthly churn, the dashboard's way: clients lost in the month divided by
 * every client we had that month (there at its start or joining in it).
 * Paused counts as a client.
 */
async function getChurn({ type = 'managed', month } = {}) {
  const months = await rpc('churn_by_month', { p_type: type === 'ppl' ? 'ppl' : 'managed' })
  if (!months.length) return ok(`No ${type} clients have a start date yet.`, { months })
  const pick = month
    ? months.find((x) => x.month === month)
    : [...months].reverse().find((x) => !x.month_in_progress) || months[months.length - 1]
  const pct = (r) => (r == null ? 'no rate' : `${r}%`)
  const summary = pick
    ? `${pick.label}${pick.month_in_progress ? ' so far' : ''}: ${pct(pick.churn_rate_pct)} churn, ${pick.lost} of the ${pick.clients_that_month} ${type} clients we had that month lost.`
    : `No ${type} churn figures for ${month}.`
  return ok(summary, {
    type, month: pick ?? null, by_month: months.slice(-12),
    definition: 'Churn % = clients lost in the month / all clients we had that month. Always give the percentage.',
  })
}

/**
 * The guardrails: each metric against its amber and red lines, with the owner
 * and the action, and the scale signal. Live, not this morning's snapshot.
 */
async function getGuardrails() {
  const metrics = await rpc('guardrail_metrics')
  const red = metrics.filter((x) => x.level === 'breach')
  const amber = metrics.filter((x) => x.level === 'warning')
  const signal = red.length ? 'red: pause scaling' : amber.length ? 'amber: hold spend and fix' : 'green: scale 20 to 25%'
  const line = (x) => `${x.label} ${x.display}`
  return ok(
    `Signal ${signal}.${red.length ? ` Red: ${red.map(line).join(', ')}.` : ''}${amber.length ? ` Amber: ${amber.map(line).join(', ')}.` : ''}`,
    { signal, metrics },
  )
}

async function getRepPerformance({ rep, days = 30 } = {}) {
  const since = daysAgo(Number(days))
  const [reps, leads] = await Promise.all([
    select('sales_reps', { select: 'user_id,name,email,active' }, { limit: 200 }),
    select('leads', { select: 'owner_id,stage,value,created_at', created_at: `gte.${since}` }, { limit: 10000 }),
  ])

  const byRep = new Map()
  for (const r of reps.rows) {
    byRep.set(r.user_id, { name: r.name || r.email, active: r.active, total: 0, won: 0, open: 0, won_value: 0 })
  }
  // Ownerless leads belong to the operator, so they get a named row rather
  // than being written off as unassigned.
  const unassigned = { name: config.ownerlessName, total: 0, won: 0, open: 0, won_value: 0 }

  for (const l of leads.rows) {
    const bucket = byRep.get(l.owner_id) ?? unassigned
    bucket.total += 1
    if (isWon(l.stage)) {
      bucket.won += 1
      bucket.won_value += Number(l.value || 0)
    } else if (!isDead(l.stage)) bucket.open += 1
  }

  let table = [...byRep.values(), unassigned]
    .filter((r) => r.total > 0)
    .map((r) => ({ ...r, close_rate_pct: r.total ? Math.round((r.won / r.total) * 100) : 0 }))
    .sort((a, b) => b.won - a.won)

  if (rep) {
    const q = norm(rep)
    const match = table.filter((r) => norm(r.name).includes(q))
    if (!match.length) {
      return ok(`I have no record of a representative named ${rep}.`, { reps: table.map((r) => r.name) })
    }
    table = match
  }

  const top = table[0]
  const summary = top
    ? `${top.name} closed ${top.won} of ${top.total} over ${days} days, a close rate of ${top.close_rate_pct} percent.`
    : `No leads came in over the last ${days} days.`

  return ok(summary, { window_days: Number(days), reps: table, leads_in_window: leads.rows.length })
}

async function getClientSnapshot({ name } = {}) {
  const params = { select: '*', order: 'leads_mtd.desc' }
  if (name) params.company_name = `ilike.*${name}*`
  const { rows } = await select('clients', params, { limit: name ? 5 : 50 })

  if (!rows.length) return ok(`I have no record of a client matching ${name}.`, { clients: [] })

  const brief = rows.map((c) => ({
    company_name: c.company_name,
    stage: c.stage,
    status: c.active_status || c.status,
    leads_mtd: c.leads_mtd,
    leads_total: c.leads_total,
    lead_price: c.lead_price,
    true_cpl: c.true_cpl,
    spend_mtd: c.spend_mtd,
    balance: c.balance,
    next_payment_date: c.next_payment_date,
    monthly_cap: c.monthly_cap,
    weekly_cap: c.weekly_cap,
    cap_paused: c.meta_cap_paused,
    cx_score: c.cx_score,
    target_leads_month: c.target_leads_month,
  }))

  const c = brief[0]
  const summary =
    rows.length === 1
      ? `${c.company_name} is ${c.status || c.stage || 'active'}, ${c.leads_mtd || 0} leads this month against a target of ${c.target_leads_month ?? 'none'}, balance ${money(c.balance)}.`
      : `${rows.length} clients. ${brief.slice(0, 3).map((x) => `${x.company_name} ${x.leads_mtd || 0}`).join(', ')}.`

  return ok(summary, { clients: brief })
}

async function findLead({ query } = {}) {
  if (!query) throw new Error('query is required')
  const q = String(query).replace(/[(),]/g, ' ').trim()
  const { rows } = await select(
    'leads',
    {
      select: 'id,name,company,email,phone,stage,value,source,owner_id,last_contact,next_followup,status,suburb,state,info_sent_at,followup_sent_at,notes',
      or: `(name.ilike.*${q}*,company.ilike.*${q}*,email.ilike.*${q}*,phone.ilike.*${q}*)`,
      order: 'created_at.desc',
    },
    { limit: 10 },
  )

  if (!rows.length) return ok(`I have no record of ${query}.`, { leads: [] })
  const l = rows[0]
  return ok(
    `${l.name || l.company} is at ${l.stage || 'no stage'}, worth ${money(l.value)}${l.next_followup ? `, next follow-up ${l.next_followup}` : ''}.`,
    { leads: rows },
  )
}

async function getFollowupsDue() {
  const today = localDate()
  const [leads, tasks] = await Promise.all([
    select(
      'leads',
      { select: 'id,name,company,phone,stage,value,next_followup,last_contact', next_followup: `lte.${today}`, order: 'next_followup.asc' },
      { limit: 200 },
    ),
    select(
      'tasks',
      { select: 'id,title,assigned_to,priority,due_date', done: 'is.false', due_date: `lte.${today}`, order: 'due_date.asc' },
      { limit: 200 },
    ),
  ])

  const due = leads.rows.filter((l) => !isDead(l.stage))
  const overdue = due.filter((l) => l.next_followup < today).length

  return ok(
    `${due.length} follow-up${due.length === 1 ? '' : 's'} due, ${overdue} overdue, and ${tasks.total} open task${tasks.total === 1 ? '' : 's'}.`,
    { due_today: due.length, overdue, leads: due.slice(0, 25), tasks: tasks.rows.slice(0, 25) },
  )
}

async function listTasks({ search, assigned_to, include_done = false, limit = 50 } = {}) {
  const params = { select: 'id,title,assigned_to,priority,done,due_date,notes,linked_name', order: 'due_date.asc.nullslast' }
  if (!include_done) params.done = 'is.false'
  if (assigned_to) params.assigned_to = `ilike.*${assigned_to}*`
  if (search) params.title = `ilike.*${String(search).replace(/[(),]/g, ' ').trim()}*`

  const { rows, total } = await select('tasks', params, { limit })
  if (!rows.length) {
    return ok(search ? `I have no record of a task matching ${search}.` : 'There are no open tasks.', { tasks: [] })
  }

  const today = localDate()
  const overdue = rows.filter((r) => !r.done && r.due_date && r.due_date < today)
  const summary =
    rows.length === 1
      ? `One task: ${rows[0].title}${rows[0].due_date ? `, due ${rows[0].due_date}` : ''}.`
      : `${total} task${total === 1 ? '' : 's'}${overdue.length ? `, ${overdue.length} overdue` : ''}. ${rows.slice(0, 3).map((r) => r.title).join('; ')}.`

  return ok(summary, { total, overdue: overdue.length, tasks: rows })
}

async function getDeliveryFailures({ hours = 24 } = {}) {
  const since = new Date(Date.now() - Number(hours) * 3600_000).toISOString()
  const [failures, stuck] = await Promise.all([
    select(
      'lead_delivery_log',
      { select: 'id,lead_id,client_id,method,status,destination,response_code,attempted_at', status: 'neq.delivered', attempted_at: `gte.${since}`, order: 'attempted_at.desc' },
      { limit: 100 },
    ),
    count('leads', { status: inList(['failed', 'pending']) }),
  ])

  return ok(
    failures.total
      ? `${failures.total} delivery failure${failures.total === 1 ? '' : 's'} in the last ${hours} hours, and ${stuck} leads are undelivered.`
      : `No delivery failures in the last ${hours} hours.`,
    { failures: failures.total, undelivered_leads: stuck, recent: failures.rows.slice(0, 20) },
  )
}

async function getDailyBrief() {
  // Everything the first question of the morning needs, in one round of calls.
  const [leads, spend, revenue, followups, delivery] = await Promise.allSettled([
    getLeadsToday(),
    getAdSpendAndCpl(),
    getRevenueVsGoal(),
    getFollowupsDue(),
    getDeliveryFailures({ hours: 24 }),
  ])

  const value = (r) => (r.status === 'fulfilled' ? r.value : { summary: `unavailable: ${r.reason?.message}` })
  const parts = [value(leads), value(spend), value(revenue), value(followups), value(delivery)]

  return ok(parts.map((p) => p.summary).join(' '), {
    leads_today: value(leads),
    ad_spend: value(spend),
    revenue: value(revenue),
    followups: value(followups),
    delivery: value(delivery),
  })
}

async function getLeadTotals() {
  // Two different questions share the word "leads". The SALES PIPELINE is the
  // `leads` table; PAY PER LEAD is `ppl_leads`. Both come back every time,
  // labelled, so an ambiguous question never gets a confidently wrong number.
  const today = startOfLocalDay(localDate())
  const periods = {
    today: { created_at: `gte.${today}` },
    since_yesterday: { created_at: `gte.${daysAgo(1)}` },
    last_7_days: { created_at: `gte.${daysAgo(7)}` },
    month_to_date: { created_at: `gte.${startOfMonth()}` },
    all_time: {},
  }

  const tally = async (table) => {
    const entries = await Promise.all(
      Object.entries(periods).map(async ([k, filter]) => [k, await count(table, filter)]),
    )
    const out = Object.fromEntries(entries)
    out.yesterday = out.since_yesterday - out.today
    delete out.since_yesterday
    return out
  }

  const [sales, ppl] = await Promise.all([tally('leads'), tally('ppl_leads')])

  return ok(
    // The summary line names the SALES PIPELINE only. Both tallies used to be
    // in it, so every answer to "how many leads this week" came back with a
    // pay per lead figure nobody had asked for - usually "and none in pay per
    // lead", which is noise attached to every single lead question.
    //
    // The pay-per-lead numbers still come back in the data, so a follow-up is
    // answered without a second round trip. They are just no longer in the
    // sentence the model reads out.
    `Sales pipeline: ${sales.today} today, ${sales.last_7_days} in the last 7 days, ` +
      `${sales.month_to_date} this month, ${sales.all_time} overall.`,
    {
      sales_pipeline: sales,
      pay_per_lead: ppl,
      month: localMonth(),
      note: 'Unless the question was specifically about pay per lead, answer with the '
        + 'sales pipeline figures only and do not mention pay per lead at all. '
        + 'The pay_per_lead numbers are here for a follow-up question, not to be volunteered.',
    },
  )
}

async function getLeadForecast() {
  // What to expect by the end of this month, at the pace so far. Everything is
  // counted in local time from rows since the start of last month, so "this
  // month", "the same point last month" and "the last 7 days" all agree.
  const now = Date.now()
  const month = localMonth()
  const shift = (n) => { const d = new Date(`${month}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7) }
  const monthStart = Date.parse(startOfMonth())
  const lastStart = Date.parse(startOfLocalDay(`${shift(-1)}-01`))
  const nextStart = Date.parse(startOfLocalDay(`${shift(1)}-01`))
  const elapsedDays = (now - monthStart) / 864e5
  const daysLeft = Math.max(0, (nextStart - now) / 864e5)
  const samePoint = Math.min(lastStart + (now - monthStart), monthStart)
  const since = new Date(lastStart).toISOString()

  const [sales, ppl] = await Promise.all([
    select('leads', { select: 'stage,created_at,updated_at', or: `(created_at.gte.${since},updated_at.gte.${since})` }, { limit: 20000 }),
    select('ppl_leads', { select: 'created_at', created_at: `gte.${since}` }, { limit: 20000 }),
  ])

  // One projection, used for every series: this month's daily rate (or the
  // last 14 days' in the first 3 days, so one quiet morning doesn't project
  // zero), the last 7 days' rate as the trend, and last month at the same point.
  const project = (times) => {
    const t = times.map((x) => Date.parse(x)).filter(Number.isFinite)
    const n = (from, to) => t.filter((x) => x >= from && x < to).length
    const mtd = n(monthStart, now)
    const last14 = n(now - 14 * 864e5, now)
    const last7 = n(now - 7 * 864e5, now)
    const rate = elapsedDays >= 3 ? mtd / elapsedDays : last14 / 14
    const lastSame = n(lastStart, samePoint)
    const lastTotal = n(lastStart, monthStart)
    return {
      so_far: mtd,
      daily_rate: +rate.toFixed(2),
      last_7_day_rate: +(last7 / 7).toFixed(2),
      projected_month_end: Math.round(mtd + rate * daysLeft),
      same_point_last_month: lastSame,
      vs_last_month_pct: lastSame ? Math.round(((mtd - lastSame) / lastSame) * 100) : null,
      last_month_total: lastTotal,
    }
  }

  const salesLeads = project(sales.rows.map((r) => r.created_at))
  // `leads` has no closed_at, so a win is dated by when it last moved, the
  // same as get_closes.
  const closes = project(sales.rows.filter((r) => isWon(r.stage)).map((r) => r.updated_at || r.created_at))
  const pplLeads = project(ppl.rows.map((r) => r.created_at))

  const vs = (p) => (p.vs_last_month_pct == null ? 'no comparison with last month' : `${p.vs_last_month_pct >= 0 ? '+' : ''}${p.vs_last_month_pct}% on the same point last month`)
  const trend = (p) => (p.last_7_day_rate > p.daily_rate * 1.15 ? 'picking up' : p.last_7_day_rate < p.daily_rate * 0.85 ? 'slowing' : 'steady')

  return ok(
    `Sales pipeline: on pace for about ${salesLeads.projected_month_end} leads this month `
      + `(${salesLeads.so_far} so far, about ${salesLeads.daily_rate} a day, ${Math.ceil(daysLeft)} days left), `
      + `${vs(salesLeads)}; the last 7 days are ${trend(salesLeads)}. `
      + `Closes: on pace for about ${closes.projected_month_end} (${closes.so_far} so far).`,
    {
      month,
      days_elapsed: +elapsedDays.toFixed(1),
      days_left: +daysLeft.toFixed(1),
      sales_pipeline_leads: salesLeads,
      closes,
      pay_per_lead_leads: pplLeads,
      method: 'Projection = so far + daily rate x days left. The rate is this month\'s, or the last 14 days\' '
        + 'in the first 3 days of a month. It assumes the current pace holds; say so when giving the number.',
      note: 'Unless the question was specifically about pay per lead, answer with the sales pipeline and '
        + 'closes figures only. The pay_per_lead_leads numbers are here for a follow-up, not to be volunteered. '
        + 'For revenue, combine with get_revenue_vs_goal rather than guessing.',
    },
  )
}

async function getPplSummary() {
  const today = startOfLocalDay(localDate())
  const [todayRows, monthRows, undelivered, unassigned, total] = await Promise.all([
    count('ppl_leads', { created_at: `gte.${today}` }),
    select('ppl_leads', { select: 'status,assigned_client_id,source,delivered_at,created_at', created_at: `gte.${startOfMonth()}` }, { limit: 10000 }),
    count('ppl_leads', { delivered_at: 'is.null' }),
    count('ppl_leads', { assigned_client_id: 'is.null' }),
    count('ppl_leads', {}),
  ])

  const byStatus = {}
  for (const r of monthRows.rows) byStatus[r.status || 'unset'] = (byStatus[r.status || 'unset'] || 0) + 1

  return ok(
    `${todayRows} pay-per-lead leads today, ${monthRows.total} this month, ${total} overall. ${undelivered} are undelivered and ${unassigned} are unassigned.`,
    {
      today: todayRows,
      month_to_date: monthRows.total,
      all_time: total,
      undelivered,
      unassigned,
      by_status_this_month: byStatus,
    },
  )
}

async function getCloses({ month } = {}) {
  const target = month || localMonth()
  const from = startOfLocalDay(`${target}-01`)

  // The month before the target, for the comparison he will be asked for next.
  const prior = new Date(`${target}-01T12:00:00Z`)
  prior.setUTCMonth(prior.getUTCMonth() - 1)
  const priorMonth = prior.toISOString().slice(0, 7)

  const [reps, rows] = await Promise.all([
    select('sales_reps', { select: 'user_id,name,email' }, { limit: 200 }),
    select(
      'leads',
      { select: 'id,name,company,stage,value,owner_id,updated_at,created_at', updated_at: `gte.${startOfLocalDay(`${priorMonth}-01`)}` },
      { limit: 10000 },
    ),
  ])

  const names = new Map(reps.rows.map((r) => [r.user_id, r.name || r.email]))
  // `leads` has no closed_at column, so a win is dated by when it last moved.
  // That is exact for a lead closed and left alone, and drifts only if a won
  // lead is edited in a later month - worth saying out loud rather than hiding.
  const won = rows.rows.filter((r) => isWon(r.stage))
  const inMonth = won.filter((r) => (r.updated_at || r.created_at) >= from)
  const inPrior = won.filter((r) => {
    const at = r.updated_at || r.created_at
    return at >= startOfLocalDay(`${priorMonth}-01`) && at < from
  })

  const value = sum(inMonth, 'value')
  const byRep = {}
  for (const l of inMonth) {
    const who = names.get(l.owner_id) || 'unassigned'
    byRep[who] ??= { closes: 0, value: 0 }
    byRep[who].closes += 1
    byRep[who].value += Number(l.value || 0)
  }

  const delta = inMonth.length - inPrior.length
  const trend = delta === 0 ? 'level with' : `${Math.abs(delta)} ${delta > 0 ? 'ahead of' : 'behind'}`
  return ok(
    `${inMonth.length} close${inMonth.length === 1 ? '' : 's'} this month worth ${money(value)}, ${trend} last month${delta === 0 ? '' : ''}.`,
    {
      month: target,
      closes: inMonth.length,
      value,
      prior_month: priorMonth,
      prior_month_closes: inPrior.length,
      by_rep: byRep,
      won_stages: config.wonStages,
      dated_by: 'updated_at (the leads table has no closed_at column)',
      recent: inMonth.slice(0, 15).map((l) => ({ name: l.name || l.company, value: l.value, stage: l.stage })),
    },
  )
}

// --------------------------------------------------------------- writes

async function updateLeadStage({ lead_id, stage } = {}) {
  if (!lead_id || !stage) throw new Error('lead_id and stage are required')
  const [row] = await patch('leads', { id: `eq.${lead_id}` }, { stage, updated_at: new Date().toISOString() })
  if (!row) throw new Error(`No lead with id ${lead_id}`)
  return ok(`${row.name || row.company} is now at ${row.stage}.`, { lead: row })
}

async function updateLeadFollowup({ lead_id, next_followup } = {}) {
  if (!lead_id || !next_followup) throw new Error('lead_id and next_followup (YYYY-MM-DD) are required')
  const [row] = await patch('leads', { id: `eq.${lead_id}` }, { next_followup, updated_at: new Date().toISOString() })
  if (!row) throw new Error(`No lead with id ${lead_id}`)
  return ok(`Follow-up for ${row.name || row.company} is set for ${next_followup}.`, { lead: row })
}

// Don's side of the story. ql-mc mirrors the agency's sales SMS into
// sales_sms_log, so this reads the same thread the Sales Conversations panel
// shows rather than reaching across to ql-hq for it.
async function getSmsThread({ lead_id, limit = 20 } = {}) {
  if (!lead_id) throw new Error('lead_id is required')
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100)

  const { rows } = await select(
    'sales_sms_log',
    { select: 'direction,message,sent_by,status,created_at', lead_id: `eq.${lead_id}`, order: 'created_at.desc' },
    { limit: n },
  )
  if (!rows.length) return ok('No SMS with that lead.', { messages: [] })

  // Oldest first for reading; the query took the newest N.
  const msgs = rows.slice().reverse().map((m) => ({
    who: m.direction === 'inbound' ? 'lead' : (m.sent_by || 'us'),
    text: m.message,
    at: m.created_at,
    ...(m.status && m.status !== 'sent' ? { status: m.status } : {}),
  }))
  const lastIn = msgs.filter((m) => m.who === 'lead').slice(-1)[0]

  return ok(
    lastIn
      ? `${msgs.length} messages. They last said: "${String(lastIn.text).slice(0, 120)}"`
      : `${msgs.length} messages, none of them from the lead.`,
    { messages: msgs },
  )
}

// Don lives on ql-hq; sync-to-hq is the only way in, and it refuses a sales rep
// and pins the edit to the agency's own company - so a client's agent can never
// be read or changed from here.
async function donConfig(patch) {
  const token = await userToken()
  return await invoke(
    'sync-to-hq',
    patch
      ? { action: 'update_sms_agent_config', patch }
      : { action: 'get_sms_agent_config' },
    { token },
  )
}

async function getDonStatus() {
  const res = await donConfig(null)
  const c = res?.config ?? res ?? {}
  const on = c.auto_reply === true
  return ok(
    on
      ? `Don is on${c.out_of_hours_only ? ', out of hours only' : ''}.`
      : 'Don is off - inbound texts from leads are stored but not answered.',
    { enabled: on, out_of_hours_only: c.out_of_hours_only === true, agent_name: c.agent_name ?? null },
  )
}

async function setDonEnabled({ enabled } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false')
  await donConfig({ auto_reply: enabled })
  return ok(
    enabled
      ? 'Don is on. He will answer inbound texts from sales leads.'
      : 'Don is off. Inbound texts will be stored for you rather than answered.',
    { enabled },
  )
}

async function sendLeadEmail({ lead_id, kind = 'info', subject, body } = {}) {
  if (!lead_id) throw new Error('lead_id is required')
  if (kind !== 'info' && kind !== 'followup') throw new Error('kind must be info or followup')

  // The function validates a rendered subject and body; it does not read the
  // templates itself. get_email_draft renders the same text, so the assistant
  // can read a draft aloud before this is ever called.
  const draft = await composeEmail(lead_id, kind)
  if (!draft.lead.email) throw new Error(`${draft.lead.name || 'That lead'} has no email address.`)
  if (!draft.template_found && (!subject || !body)) {
    throw new Error(`No "${kind}" email template is saved, and no subject and body were given.`)
  }

  const token = await userToken()
  const res = await invoke(
    'send-sales-email',
    { lead_id, kind, subject: subject || draft.subject, body: body || draft.body },
    { token },
  )
  return ok(`The ${kind} email has gone to ${draft.lead.email}.`, {
    lead: draft.lead.name || draft.lead.company,
    result: res,
  })
}

/** Who a send is attributed to: the rep row for the configured login. */
async function repIdentity() {
  const email = env('QL_USER_EMAIL')
  if (!email) return { name: '', email: '', reply_to_email: null }
  const { rows } = await select(
    'sales_reps',
    { select: 'user_id,name,email,reply_to_email', email: `eq.${email}` },
    { limit: 1 },
  )
  return rows[0] ?? { name: '', email, reply_to_email: null }
}

/**
 * Render an email from the saved template, exactly as mergeTemplate() in
 * index.html does - same table, same single-brace placeholders.
 */
async function composeEmail(lead_id, kind) {
  const [{ rows: leads }, { rows: templates }, me] = await Promise.all([
    select('leads', { select: 'id,name,company,email,stage', id: `eq.${lead_id}` }, { limit: 1 }),
    select('sales_email_templates', { select: 'kind,subject,body' }, { limit: 20 }),
    repIdentity(),
  ])

  const lead = leads[0]
  if (!lead) throw new Error(`No lead with id ${lead_id}`)

  const vals = {
    first_name: String(lead.name || '').trim().split(/\s+/)[0] || '',
    company_name: (lead.company || '').trim(),
    rep_name: me.name,
    rep_email: me.reply_to_email || me.email,
  }
  const merged = (text) =>
    String(text || '')
      .replace(/\{(first_name|company_name|rep_name|rep_email)\}/g, (_, k) => vals[k] || '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .trim()

  const tpl = templates.find((x) => x.kind === kind)
  return {
    lead,
    rep: me,
    template_found: Boolean(tpl),
    subject: tpl ? merged(tpl.subject) : '',
    body: tpl ? merged(tpl.body) : '',
  }
}

async function getEmailDraft({ lead_id, kind = 'info' } = {}) {
  if (!lead_id) throw new Error('lead_id is required')
  const draft = await composeEmail(lead_id, kind)
  if (!draft.template_found) {
    return ok(`There is no "${kind}" template saved.`, { kind })
  }
  return ok(
    `To ${draft.lead.name || draft.lead.company} at ${draft.lead.email || 'no address on file'}, subject: ${draft.subject}.`,
    {
      to: draft.lead.email,
      lead: draft.lead.name || draft.lead.company,
      from_rep: draft.rep.name || draft.rep.email,
      kind,
      subject: draft.subject,
      body: draft.body,
    },
  )
}

async function sendLeadSms({ lead_id, message } = {}) {
  if (!lead_id || !message) throw new Error('lead_id and message are required')

  // The function takes the destination number explicitly, and needs
  // source:'sales' to look the lead up in `leads` rather than `ppl_leads`.
  const { rows } = await select(
    'leads',
    { select: 'id,name,phone,sms_opted_out', id: `eq.${lead_id}` },
    { limit: 1 },
  )
  const lead = rows[0]
  if (!lead) throw new Error(`No lead with id ${lead_id}`)
  if (!lead.phone) throw new Error(`${lead.name || 'That lead'} has no phone number.`)
  if (lead.sms_opted_out) throw new Error(`${lead.name || 'That lead'} has opted out of messages.`)

  const token = await userToken()
  const res = await invoke('send-sms', { to: lead.phone, message, lead_id, source: 'sales' }, { token })
  return ok(`The message has gone to ${lead.name || lead.phone}.`, { result: res })
}

async function updateTask({ task_id, done, title, assigned_to, due_date, priority, notes } = {}) {
  if (!task_id) throw new Error('task_id is required - get it from list_tasks')

  const patchBody = { updated_at: new Date().toISOString() }
  for (const [k, v] of Object.entries({ done, title, assigned_to, due_date, priority, notes })) {
    if (v !== undefined) patchBody[k] = v
  }
  if (Object.keys(patchBody).length === 1) throw new Error('Nothing to change')

  const [row] = await patch('tasks', { id: `eq.${task_id}` }, patchBody)
  if (!row) throw new Error(`No task with id ${task_id}`)
  return ok(
    done === true ? `${row.title} is done.` : done === false ? `${row.title} is open again.` : `${row.title} is updated.`,
    { task: row },
  )
}

async function deleteTask({ task_id } = {}) {
  // By id only, never by title: a loose match plus a misheard sentence is how
  // the wrong task gets deleted, and there is nothing to undo it with.
  if (!task_id) throw new Error('task_id is required - get it from list_tasks')
  const rows = await remove('tasks', { id: `eq.${task_id}` })
  if (!rows.length) throw new Error(`No task with id ${task_id}`)
  return ok(`${rows[0].title} is deleted.`, { deleted: rows[0] })
}

async function createTask({ title, assigned_to, due_date, priority = 'normal', notes } = {}) {
  if (!title) throw new Error('title is required')
  const [row] = await insert('tasks', [{ title, assigned_to, due_date, priority, notes, done: false }])
  return ok(`Task logged: ${row.title}.`, { task: row })
}

// ---------------------------------------------------------------- manifest

const str = (description) => ({ type: 'string', description })

export const TOOLS = [
  ...EXPLORE_TOOLS,
  ...MEMORY_TOOLS,
  ...CONTENT_TOOLS,
  ...OUTREACH_TOOLS,

  {
    name: 'get_daily_brief',
    description:
      'The whole morning picture in one call: leads today, ad spend and cost per lead, revenue against the monthly goal, follow-ups due, and delivery failures. Use this for open questions like "how are we doing" or "what are our numbers".',
    inputSchema: { type: 'object', properties: {} },
    handler: getDailyBrief,
  },
  {
    name: 'get_leads_today',
    description: 'Sales pipeline leads that arrived today, with yesterday and the seven-day average for comparison, broken down by source. Sales pipeline only - use get_ppl_summary for pay-per-lead.',
    inputSchema: { type: 'object', properties: {} },
    handler: getLeadsToday,
  },
  {
    name: 'get_lead_totals',
    description:
      'Lead counts for every period at once - today, yesterday, the last seven days, month to date, all time - for BOTH the sales pipeline (the `leads` table) and pay-per-lead (`ppl_leads`). Answers "how many leads today", "how many in our sales pipeline" and "how many pay per lead leads".',
    inputSchema: { type: 'object', properties: {} },
    handler: getLeadTotals,
  },
  {
    name: 'get_lead_forecast',
    description:
      'Forecast for the rest of this month at the current pace: how many sales pipeline leads and closes to expect by month end, how this month compares with the same point last month, and whether the last 7 days are picking up or slowing (pay-per-lead volume is included for follow-ups). Answers "what can we expect this month", "how many leads will we get", "are we on track" and "will we beat last month".',
    inputSchema: { type: 'object', properties: {} },
    handler: getLeadForecast,
  },
  {
    name: 'get_closes',
    description:
      'Deals closed this month: how many, what they are worth, how that compares with last month, and which representative closed them. Answers "how many closes this month".',
    inputSchema: { type: 'object', properties: { month: str('Month as YYYY-MM. Defaults to the current month.') } },
    handler: getCloses,
  },
  {
    name: 'get_ppl_summary',
    description:
      'Pay-per-lead volume and health (the `ppl_leads` table): how many arrived today and this month, how many are undelivered or unassigned, and the breakdown by status. Use this when the question says "pay per lead" or "PPL".',
    inputSchema: { type: 'object', properties: {} },
    handler: getPplSummary,
  },
  {
    name: 'get_pipeline_summary',
    description: 'Counts and dollar value of the sales pipeline (the `leads` table) grouped by stage, plus total open value.',
    inputSchema: { type: 'object', properties: {} },
    handler: getPipelineSummary,
  },
  {
    name: 'get_revenue_vs_goal',
    description: 'Revenue booked this month against the monthly goal, broken into pay-per-lead orders, managed custom orders and retainers, with costs and margin. Answers "are we ahead of goal".',
    inputSchema: { type: 'object', properties: { month: str('Month as YYYY-MM. Defaults to the current month.') } },
    handler: getRevenueVsGoal,
  },
  {
    name: 'get_ad_spend_and_cpl',
    description: 'Advertising spend and cost per lead for the month: pay-per-lead from the campaign spend log, plus agency spend. Logged monthly, so there is no daily figure.',
    inputSchema: { type: 'object', properties: { month: str('Month as YYYY-MM. Defaults to the current month.') } },
    handler: getAdSpendAndCpl,
  },
  {
    name: 'get_sales_metrics',
    description: 'The Scoreboard\'s 15 sales metrics for any period: lead volume, contactable, sent offer, sales, revenue, ad spend, ROAS, cost per lead, value per lead, average LTV, AOV, cost per offer sent, CAC, average gross profit per sale, average days to sale. Optionally for one rep. Answers "what was our CAC last month", "how many offers did we send in September", "what is Dave\'s revenue this month".',
    inputSchema: {
      type: 'object',
      properties: {
        from: str('First day, YYYY-MM-DD (Sydney). Omit for all time.'),
        to: str('Last day, YYYY-MM-DD, inclusive. Omit for today.'),
        rep: str('A sales rep\'s name, to see only their leads.'),
      },
    },
    handler: getSalesMetrics,
  },
  {
    name: 'get_churn',
    description: 'Monthly client churn as a percentage: clients lost in the month divided by all clients we had that month, month by month. Answers "what was our churn last month". Defaults to the last full month for managed clients.',
    inputSchema: {
      type: 'object',
      properties: {
        type: str('managed (default) or ppl.'),
        month: str('Month as YYYY-MM. Omit for the last full month.'),
      },
    },
    handler: getChurn,
  },
  {
    name: 'get_guardrails',
    description: 'The business guardrails right now: CPL, pitch rate, pitch-to-close, speed-to-lead, spend vs plan, lead volume, clients per VA, no-show rate, day-21 cohort CAC, cash collected, churn vs baseline, leads with no touch in 24h. Each is green, amber or red, with its owner and action, plus the overall scale signal. Answers "should we scale", "are we on track", "what is red".',
    inputSchema: { type: 'object', properties: {} },
    handler: getGuardrails,
  },
  {
    name: 'get_rep_performance',
    description: 'Close rates by sales representative over a window. Answers "what is Dave\'s close rate".',
    inputSchema: {
      type: 'object',
      properties: {
        rep: str('Representative name, partial match. Omit for the whole team.'),
        days: { type: 'number', description: 'Window in days. Defaults to 30.' },
      },
    },
    handler: getRepPerformance,
  },
  {
    name: 'get_client_snapshot',
    description: 'Client health: stage, leads this month against target, cost per lead, balance, caps and next payment date.',
    inputSchema: { type: 'object', properties: { name: str('Company name, partial match. Omit for the top clients by volume.') } },
    handler: getClientSnapshot,
  },
  {
    name: 'find_lead',
    description: 'Look up a lead by name, company, email or phone. Returns stage, value, owner and follow-up dates.',
    inputSchema: { type: 'object', properties: { query: str('Name, company, email or phone.') }, required: ['query'] },
    handler: findLead,
  },
  {
    name: 'list_tasks',
    description:
      'Open tasks from the task board, newest due first: title, who it is for, priority, due date. Filter by a word in the title or by assignee. Returns each task id, which update_task and delete_task need.',
    inputSchema: {
      type: 'object',
      properties: {
        search: str('Match part of the task title.'),
        assigned_to: str('Whose tasks, partial match.'),
        include_done: { type: 'boolean', description: 'Include completed tasks. Default false.' },
        limit: { type: 'number', description: 'Default 50.' },
      },
    },
    handler: listTasks,
  },
  {
    name: 'get_followups_due',
    description: 'Leads whose follow-up date has arrived or passed, and open tasks past their due date.',
    inputSchema: { type: 'object', properties: {} },
    handler: getFollowupsDue,
  },
  {
    name: 'get_delivery_failures',
    description: 'Lead deliveries that failed recently, and how many leads are sitting undelivered.',
    inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'Look-back window in hours. Defaults to 24.' } } },
    handler: getDeliveryFailures,
  },
  {
    name: 'get_sms_thread',
    description:
      'The SMS conversation with a lead - both sides, oldest first, including anything ' +
      'Don (the AI SMS agent) sent or received. Read this BEFORE suggesting a chase: a ' +
      'lead who replied to Don two days ago does not need chasing, and saying so when ' +
      'they do not is how the assistant stops being trusted.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: str('Lead UUID, from find_lead.'),
        limit: { type: 'number', description: 'Messages to return, newest kept. Default 20.' },
      },
      required: ['lead_id'],
    },
    handler: getSmsThread,
  },
  {
    name: 'get_don_status',
    description:
      'Whether Don, the AI SMS agent that answers sales-pipeline leads, is currently ' +
      'switched on, plus his hours and wording. Answers "is Don on".',
    inputSchema: { type: 'object', properties: {} },
    handler: getDonStatus,
  },

  {
    name: 'get_email_draft',
    description:
      'Render the info or follow-up email for a lead WITHOUT sending it: who it goes to, the subject and the body, from the saved template. Read this back before calling send_lead_email.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: str('Lead UUID, from find_lead.'), kind: str('"info" or "followup". Defaults to info.') },
      required: ['lead_id'],
    },
    handler: getEmailDraft,
  },

  // Writes. Named so the bridge holds them behind JARVIS_ALLOW_WRITES.
  {
    // Named update_* deliberately: EFFECTFUL is /^(update|send|create|delete)_/
    // and anchored, so a name like set_don_enabled would have been classed as
    // a READ and handed to read-only sessions. The naming is the permission.
    name: 'update_don_enabled',
    description:
      'Switch Don, the AI SMS agent, on or off for the agency\'s own sales pipeline. ' +
      'On means he answers inbound texts from leads himself. This changes how real ' +
      'leads are handled, so confirm before calling it. It can never reach a client\'s ' +
      'agent - only the agency\'s own.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'true switches him on.' } },
      required: ['enabled'],
    },
    handler: setDonEnabled,
  },
  {
    name: 'update_lead_stage',
    description: 'Move a lead to a different pipeline stage.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: str('Lead UUID, from find_lead.'), stage: str('The new stage.') },
      required: ['lead_id', 'stage'],
    },
    handler: updateLeadStage,
  },
  {
    name: 'update_lead_followup',
    description: 'Set the next follow-up date on a lead.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: str('Lead UUID, from find_lead.'), next_followup: str('Date as YYYY-MM-DD.') },
      required: ['lead_id', 'next_followup'],
    },
    handler: updateLeadFollowup,
  },
  {
    name: 'send_lead_email',
    description:
      'Send the info or follow-up email to ONE lead, using the app\'s own templates and logging. For more than 3 leads use send_bulk_message. ' +
      'Pass subject and body ONLY when the person has asked for wording of their own - for ' +
      'example tailoring it to what was discussed on a call. Leave both out and the saved ' +
      'template is used, which is the right default. Read the wording back and get a yes ' +
      'before calling this: it sends immediately and cannot be recalled.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: str('Lead UUID, from find_lead.'),
        kind: str('"info" or "followup". Defaults to info.'),
        subject: str('Overrides the template subject. Only when custom wording was asked for.'),
        body: str('Overrides the template body, plain text. Only when custom wording was asked for.'),
      },
      required: ['lead_id'],
    },
    handler: sendLeadEmail,
  },
  {
    name: 'send_lead_sms',
    description:
      'Send an SMS to ONE lead through Twilio, from the agency number Don answers. For more than 3 leads use send_bulk_message, never this in a loop. ' +
      '"Reply STOP to opt out" is added automatically - do not write it yourself. ' +
      'A number that has opted out is refused by the server; tell the owner, never try another way to reach them by SMS. ' +
      'The same message to the same number within 30 days is refused too - it was already sent.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: str('Lead UUID, from find_lead.'), message: str('The message body.') },
      required: ['lead_id', 'message'],
    },
    handler: sendLeadSms,
  },
  {
    name: 'update_task',
    description: 'Mark a task done or not done, or change its title, assignee, due date, priority or notes.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: str('Task UUID, from list_tasks.'),
        done: { type: 'boolean', description: 'true marks it complete.' },
        title: str('New title.'),
        assigned_to: str('New assignee.'),
        due_date: str('Date as YYYY-MM-DD.'),
        priority: str('low, normal or high.'),
        notes: str('New notes.'),
      },
      required: ['task_id'],
    },
    handler: updateTask,
  },
  {
    name: 'delete_task',
    description:
      'Permanently delete a task. There is no undo. Requires the task id from list_tasks - never delete from a name match alone, and confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { task_id: str('Task UUID, from list_tasks.') },
      required: ['task_id'],
    },
    handler: deleteTask,
  },
  {
    name: 'create_task',
    description: 'Add a task to the task board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('What needs doing.'),
        assigned_to: str('Who it is for.'),
        due_date: str('Date as YYYY-MM-DD.'),
        priority: str('low, normal or high.'),
        notes: str('Any detail.'),
      },
      required: ['title'],
    },
    handler: createTask,
  },
]
