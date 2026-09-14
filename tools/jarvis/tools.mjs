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

import { select, count, patch, insert, invoke } from './db.mjs'
import { config } from './config.mjs'
import { EXPLORE_TOOLS } from './explore.mjs'
import { userToken } from './auth.mjs'
import { localDate, localMonth, startOfLocalDay, daysAgo, startOfMonth } from './dates.mjs'

const money = (n) =>
  `${config.currency} ${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`

const sum = (rows, key) => rows.reduce((t, r) => t + Number(r[key] || 0), 0)
const norm = (s) => String(s ?? '').trim().toLowerCase()
const isDead = (stage) => config.deadStages.includes(norm(stage))
const isWon = (stage) => config.wonStages.includes(norm(stage))

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

async function getRevenueVsGoal({ month } = {}) {
  const target = month || localMonth()
  const from = month ? startOfLocalDay(`${month}-01`) : startOfMonth()
  const fromDate = from.slice(0, 10)

  const [rev, exp, goals] = await Promise.all([
    select('revenue', { select: 'amount,type,date,client_id', date: `gte.${fromDate}` }, { limit: 5000 }),
    select('expenses', { select: 'amount,category,date', date: `gte.${fromDate}` }, { limit: 5000 }),
    // Small table, and `month` is free text — match in JS rather than guess its format.
    select('monthly_goals', { select: 'month,revenue_goal,margin_goal' }, { limit: 200 }),
  ])

  const booked = sum(rev.rows, 'amount')
  const spent = sum(exp.rows, 'amount')
  const goal = goals.rows.find((g) => norm(g.month).startsWith(target))
  const revenueGoal = Number(goal?.revenue_goal || 0)
  const pct = revenueGoal ? Math.round((booked / revenueGoal) * 100) : null

  const byType = {}
  for (const r of rev.rows) byType[r.type || 'other'] = (byType[r.type || 'other'] || 0) + Number(r.amount || 0)

  const summary = revenueGoal
    ? `${money(booked)} booked this month against a goal of ${money(revenueGoal)}. That is ${pct} percent.`
    : `${money(booked)} booked this month. No revenue goal is set for ${target}.`

  return ok(summary, {
    month: target,
    revenue: booked,
    revenue_goal: revenueGoal || null,
    pct_of_goal: pct,
    expenses: spent,
    margin: booked - spent,
    margin_goal: Number(goal?.margin_goal || 0) || null,
    revenue_by_type: byType,
  })
}

async function getAdSpendAndCpl() {
  const today = localDate()
  const monthStart = startOfMonth().slice(0, 10)

  const { rows } = await select(
    'ad_spend_daily',
    { select: 'date,spend,leads,clicks,impressions,account_type,client_name', date: `gte.${monthStart}` },
    { limit: 5000 },
  )

  const todayRows = rows.filter((r) => r.date === today)
  const mtdSpend = sum(rows, 'spend')
  const mtdLeads = sum(rows, 'leads')
  const todaySpend = sum(todayRows, 'spend')
  const todayLeads = sum(todayRows, 'leads')
  const cpl = (s, l) => (l ? Math.round((s / l) * 100) / 100 : null)

  return ok(
    `${money(todaySpend)} spent today for ${todayLeads} leads, a cost per lead of ${money(cpl(todaySpend, todayLeads) ?? 0)}. Month to date is ${money(mtdSpend)} at ${money(cpl(mtdSpend, mtdLeads) ?? 0)}.`,
    {
      today: { date: today, spend: todaySpend, leads: todayLeads, cpl: cpl(todaySpend, todayLeads) },
      month_to_date: { spend: mtdSpend, leads: mtdLeads, cpl: cpl(mtdSpend, mtdLeads) },
    },
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
  const unassigned = { name: 'unassigned', total: 0, won: 0, open: 0, won_value: 0 }

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
    : `No leads were assigned in the last ${days} days.`

  return ok(summary, { window_days: Number(days), reps: table })
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
      select: 'id,name,company,email,phone,stage,value,source,owner_id,last_contact,next_followup,status,suburb,state,info_sent_at,followup_sent_at',
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
  // One call answers "today", "this week", "this month" and "overall", because
  // spoken questions arrive in every one of those shapes and a second round
  // trip is a second silence while he waits.
  const today = startOfLocalDay(localDate())
  const [all, mtd, week, todayCount, yesterdayAndToday] = await Promise.all([
    count('leads', {}),
    count('leads', { created_at: `gte.${startOfMonth()}` }),
    count('leads', { created_at: `gte.${daysAgo(7)}` }),
    count('leads', { created_at: `gte.${today}` }),
    count('leads', { created_at: `gte.${daysAgo(1)}` }),
  ])

  const yesterday = yesterdayAndToday - todayCount
  return ok(
    `${todayCount} today, ${week} in the last seven days, ${mtd} this month, ${all} overall.`,
    {
      today: todayCount,
      yesterday,
      last_7_days: week,
      month_to_date: mtd,
      all_time: all,
      month: localMonth(),
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
  // lead is edited in a later month — worth saying out loud rather than hiding.
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

async function sendLeadEmail({ lead_id, kind = 'info', subject, body } = {}) {
  if (!lead_id) throw new Error('lead_id is required')
  if (kind !== 'info' && kind !== 'followup') throw new Error('kind must be info or followup')

  // The function validates a rendered subject and body — it does not read the
  // templates itself. The app merges them client-side (mergeTemplate in
  // index.html), so that work happens here too, from the same table and with
  // the same single-brace placeholders.
  const [{ rows: leads }, { rows: templates }] = await Promise.all([
    select('leads', { select: 'id,name,company,email,stage', id: `eq.${lead_id}` }, { limit: 1 }),
    select('sales_email_templates', { select: 'kind,subject,body' }, { limit: 20 }),
  ])

  const lead = leads[0]
  if (!lead) throw new Error(`No lead with id ${lead_id}`)
  if (!lead.email) throw new Error(`${lead.name || 'That lead'} has no email address.`)

  const token = await userToken()
  const me = await currentRep(token)
  const vals = {
    first_name: String(lead.name || '').trim().split(/\s+/)[0] || '',
    company_name: (lead.company || '').trim(),
    rep_name: me.name,
    rep_email: me.reply_to_email || me.email,
  }

  const tpl = templates.find((x) => x.kind === kind)
  if (!tpl && (!subject || !body)) {
    throw new Error(`No "${kind}" email template is saved, and no subject and body were given.`)
  }

  const merged = (text) =>
    String(text || '')
      .replace(/\{(first_name|company_name|rep_name|rep_email)\}/g, (_, k) => vals[k] || '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .trim()

  const res = await invoke(
    'send-sales-email',
    {
      lead_id,
      kind,
      subject: subject || merged(tpl.subject),
      body: body || merged(tpl.body),
    },
    { token },
  )
  return ok(`The ${kind} email has gone to ${lead.email}.`, { lead: lead.name || lead.company, result: res })
}

/** Who the send is attributed to, from the logged-in session. */
async function currentRep(token) {
  const res = await fetch(`${config.url()}/auth/v1/user`, {
    headers: { apikey: config.key(), Authorization: `Bearer ${token}` },
  })
  const user = res.ok ? await res.json() : {}
  const { rows } = await select('sales_reps', { select: 'user_id,name,email,reply_to_email', user_id: `eq.${user.id}` }, { limit: 1 })
  return rows[0] ?? { name: user.user_metadata?.name || '', email: user.email || '', reply_to_email: null }
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

async function createTask({ title, assigned_to, due_date, priority = 'normal', notes } = {}) {
  if (!title) throw new Error('title is required')
  const [row] = await insert('tasks', [{ title, assigned_to, due_date, priority, notes, done: false }])
  return ok(`Task logged: ${row.title}.`, { task: row })
}

// ---------------------------------------------------------------- manifest

const str = (description) => ({ type: 'string', description })

export const TOOLS = [
  ...EXPLORE_TOOLS,

  {
    name: 'get_daily_brief',
    description:
      'The whole morning picture in one call: leads today, ad spend and cost per lead, revenue against the monthly goal, follow-ups due, and delivery failures. Use this for open questions like "how are we doing" or "what are our numbers".',
    inputSchema: { type: 'object', properties: {} },
    handler: getDailyBrief,
  },
  {
    name: 'get_leads_today',
    description: 'How many leads arrived today, with yesterday and the seven-day average for comparison, broken down by source.',
    inputSchema: { type: 'object', properties: {} },
    handler: getLeadsToday,
  },
  {
    name: 'get_lead_totals',
    description:
      'Lead counts for every period at once: today, yesterday, the last seven days, month to date, and all time. Answers "how many leads today" and "how many overall".',
    inputSchema: { type: 'object', properties: {} },
    handler: getLeadTotals,
  },
  {
    name: 'get_closes',
    description:
      'Deals closed this month: how many, what they are worth, how that compares with last month, and which representative closed them. Answers "how many closes this month".',
    inputSchema: { type: 'object', properties: { month: str('Month as YYYY-MM. Defaults to the current month.') } },
    handler: getCloses,
  },
  {
    name: 'get_pipeline_summary',
    description: 'Counts and dollar value of the sales pipeline grouped by stage, plus total open value.',
    inputSchema: { type: 'object', properties: {} },
    handler: getPipelineSummary,
  },
  {
    name: 'get_revenue_vs_goal',
    description: 'Revenue booked this month against the monthly revenue goal, with expenses and margin. Answers "are we ahead of goal".',
    inputSchema: { type: 'object', properties: { month: str('Month as YYYY-MM. Defaults to the current month.') } },
    handler: getRevenueVsGoal,
  },
  {
    name: 'get_ad_spend_and_cpl',
    description: 'Advertising spend, leads generated and cost per lead, for today and month to date.',
    inputSchema: { type: 'object', properties: {} },
    handler: getAdSpendAndCpl,
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

  // Writes. Named so the bridge holds them behind JARVIS_ALLOW_WRITES.
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
    description: 'Send the info or follow-up email to a lead, using the app\'s own templates and logging.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: str('Lead UUID, from find_lead.'), kind: str('"info" or "followup". Defaults to info.') },
      required: ['lead_id'],
    },
    handler: sendLeadEmail,
  },
  {
    name: 'send_lead_sms',
    description: 'Send an SMS to a lead through Twilio.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: str('Lead UUID, from find_lead.'), message: str('The message body.') },
      required: ['lead_id', 'message'],
    },
    handler: sendLeadSms,
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
