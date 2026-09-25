/**
 * jarvis-chat — the brain, server-side.
 *
 * The local bridge runs Claude Code on a laptop, which means JARVIS only works
 * at that desk, while that process is running. This function is the hosted
 * alternative: it runs the same tool loop against the Anthropic API, so the
 * assistant works from the deployed site on any device with nothing running
 * locally.
 *
 * The API key is a Supabase secret and never leaves the server. The browser
 * sends a question and gets an answer; it never sees the key, and it cannot
 * ask for a tool it was not offered.
 *
 * THIS FILE IS GENERATED. Edit index.template.ts for the handler, or
 * quoteleads/*.mjs for the tools, then run:
 *
 *     node tools/jarvis/build-edge.mjs
 *
 * It is one self-contained file because this project's deploy ships only the
 * entrypoint — a local import of a sibling file does not survive bundling,
 * which is why every other function here is a single file too. The modules in
 * quoteleads/ remain the editable source, and are what the MCP server imports
 * for the local bridge, so both brains run the same code.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.115.0'

// ══════════════════════════════════════════════════════════════════
//  GENERATED — do not edit below this line.
//  Source: supabase/functions/jarvis-chat/quoteleads/*.mjs
//  Rebuild: node tools/jarvis/build-edge.mjs
// ══════════════════════════════════════════════════════════════════

// ─── config.mjs ──────────────────────────────────────────────────

/**
 * Configuration for the QuoteLeads MCP server.
 *
 * Everything comes from the environment, because this server is launched by
 * JARVIS's bridge (or any MCP client) rather than by a person — there is no
 * prompt to answer and no file to pick. Start it with `node --env-file=.env`
 * or set the variables in the MCP client's `env` block.
 */

/**
 * Read an environment variable in either runtime.
 *
 * These modules run in two places: Node, as the MCP server the local bridge
 * spawns, and Deno, inside the jarvis-chat edge function. Reading env through
 * one accessor is what lets the tool implementations stay a single copy.
 */
const env = (name) =>
  globalThis.Deno?.env?.get?.(name) ?? globalThis.process?.env?.[name] ?? undefined

const required = (name) => {
  const value = env(name)
  if (!value) {
    throw new Error(
      `${name} is not set. Copy tools/jarvis/.env.example to .env and fill it in.`,
    )
  }
  return value
}

/**
 * Stage names are matched on a canonical form: lowercased, with underscores
 * and hyphens folded to spaces. The database says `closed_won`; someone
 * configuring this will write `closed won` or `Closed Won`. All three match,
 * because a silent miss here reports zero closes rather than an error.
 */
const stageKey = (s) =>
  String(s ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')

const list = (name, fallback) =>
  (env(name) ?? fallback)
    .split(',')
    .map(stageKey)
    .filter(Boolean)

const config = {
  /** PostgREST base, e.g. https://<ref>.supabase.co */
  // Inside an edge function SUPABASE_URL and the service-role key are provided
  // by the platform, so the QL_ names are only needed outside it.
  url: () => (env('QL_SUPABASE_URL') ?? required('SUPABASE_URL')).replace(/\/+$/, ''),

  /**
   * Service-role or anon key. Service-role reads past RLS, which is what a
   * single-operator assistant wants; it never leaves this machine, and this
   * server exposes no tool that runs caller-supplied SQL.
   */
  key: () => env('QL_SUPABASE_KEY') ?? required('SUPABASE_SERVICE_ROLE_KEY'),

  /**
   * The business runs on Australian dates. "Today" has to mean the local day,
   * not UTC, or every morning before 10am reports yesterday's numbers.
   */
  timezone: env('QL_TIMEZONE') ?? 'Australia/Sydney',

  /**
   * Stage vocabulary. `leads.stage` is free text, so which values count as won
   * or dead is a business fact, not a schema fact — it belongs in config where
   * it can change without a code edit.
   */
  // The live vocabulary: closed_won, closed_lost, proposal, no_answer,
  // new_lead. Anything not named here counts as open.
  wonStages: list('QL_WON_STAGES', 'closed_won,won'),
  deadStages: list('QL_DEAD_STAGES', 'closed_lost,lost,dead,disqualified'),

  /**
   * A lead with no owner_id is not unassigned — it is handled by the operator
   * running this assistant. Naming that makes the rep table complete instead
   * of showing most of the pipeline as nobody's.
   */
  ownerlessName: env('QL_OWNERLESS_NAME') ?? 'you',

  /** Currency label used in spoken summaries. */
  currency: env('QL_CURRENCY') ?? 'AUD',
}

// ─── dates.mjs ───────────────────────────────────────────────────

/**
 * Local-day arithmetic.
 *
 * Every timestamp in the database is timestamptz (UTC), but "how many leads
 * today" means the local business day. In Australia that is 10-11 hours ahead
 * of UTC, so a naive UTC day boundary reports yesterday's number for the whole
 * working morning — the one bug guaranteed to make the assistant untrusted.
 */


const tz = () => config.timezone

/** Local calendar date as YYYY-MM-DD. */
function localDate(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/** Local month as YYYY-MM. */
const localMonth = (at = new Date()) => localDate(at).slice(0, 7)

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutes(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz(),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(at)
    .reduce((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: p.value }), {})

  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  )
  return (asUTC - at.getTime()) / 60000
}

/**
 * The UTC instant at which a local date begins, as an ISO string.
 *
 * Two passes: guess with the offset in effect at UTC midnight, then correct
 * with the offset actually in effect at the guess. That second pass is what
 * makes the DST changeover days right.
 */
function startOfLocalDay(dateStr) {
  const guess = new Date(`${dateStr}T00:00:00Z`)
  const first = new Date(guess.getTime() - offsetMinutes(guess) * 60000)
  const corrected = new Date(guess.getTime() - offsetMinutes(first) * 60000)
  return corrected.toISOString()
}

/** Start of the local day `n` days before `from` (n=0 is today). */
function daysAgo(n, from = new Date()) {
  const base = new Date(`${localDate(from)}T12:00:00Z`)
  base.setUTCDate(base.getUTCDate() - n)
  return startOfLocalDay(localDate(base))
}

/** Start of the current local month. */
const startOfMonth = (at = new Date()) =>
  startOfLocalDay(`${localMonth(at)}-01`)

// ─── db.mjs ──────────────────────────────────────────────────────

/**
 * The data layer: PostgREST over fetch, plus edge-function invocation.
 *
 * No @supabase/supabase-js on purpose. This server has zero dependencies, so
 * `node server.mjs` runs it on any machine with Node 20 — no install step, no
 * lockfile, nothing to drift out of date on a laptop that only ever runs it
 * through JARVIS.
 */


const headers = () => ({
  apikey: config.key(),
  Authorization: `Bearer ${config.key()}`,
  'Content-Type': 'application/json',
})

/**
 * @param {string} table
 * @param {Record<string, string>} params PostgREST query params, e.g.
 *   { select: 'id,stage', 'created_at': 'gte.2026-01-01', order: 'created_at.desc' }
 */
async function select(table, params = {}, { limit } = {}) {
  const qs = new URLSearchParams(params)
  if (limit) qs.set('limit', String(limit))

  const res = await fetch(`${config.url()}/rest/v1/${table}?${qs}`, {
    headers: { ...headers(), Prefer: 'count=exact' },
  })
  if (!res.ok) {
    throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }

  const rows = await res.json()
  // PostgREST reports the unpaginated total in Content-Range: 0-24/1234.
  const total = Number(res.headers.get('content-range')?.split('/')[1])
  return { rows, total: Number.isFinite(total) ? total : rows.length }
}

/** A count without transferring the rows. */
async function count(table, params = {}) {
  const qs = new URLSearchParams({ ...params, select: 'id' })
  const res = await fetch(`${config.url()}/rest/v1/${table}?${qs}`, {
    method: 'HEAD',
    headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' },
  })
  if (!res.ok) throw new Error(`${table}: ${res.status}`)
  return Number(res.headers.get('content-range')?.split('/')[1]) || 0
}

async function patch(table, params, body) {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${config.url()}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  return res.json()
}

async function insert(table, body) {
  const res = await fetch(`${config.url()}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  return res.json()
}

async function remove(table, params) {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${config.url()}/rest/v1/${table}?${qs}`, {
    method: 'DELETE',
    headers: { ...headers(), Prefer: 'return=representation' },
  })
  if (!res.ok) {
    throw new Error(`${table}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  return res.json()
}

/** Call a Supabase edge function, so the assistant reuses the app's own logic. */
async function invoke(fn, body, { token } = {}) {
  // The edge functions verify a USER token and attribute the send to it, so a
  // caller identity is passed through rather than the service-role key.
  const auth = token ? { ...headers(), Authorization: `Bearer ${token}` } : headers()
  const res = await fetch(`${config.url()}/functions/v1/${fn}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return { ok: true, body: text }
  }
}

// ─── auth.mjs ────────────────────────────────────────────────────

/**
 * A user session for the edge functions.
 *
 * `send-sales-email` and `send-sms` both verify the caller with
 * `auth.getUser(token)` and then attribute the send to that user — the rep's
 * name and reply-to address come out of the session. A service-role key is not
 * a user token and fails that check, so the sending tools need a real login.
 *
 * Reads never come through here: they use the service-role key directly.
 */


let cached = null

function hasSendIdentity() {
  return Boolean(env('QL_USER_EMAIL') && env('QL_USER_PASSWORD'))
}

/** A valid access token, logging in or refreshing as needed. */
async function userToken() {
  if (!hasSendIdentity()) {
    throw new Error(
      'Sending requires a login: set QL_USER_EMAIL and QL_USER_PASSWORD. ' +
        'The email and SMS functions attribute the send to that user.',
    )
  }

  // A minute of margin, so a token never expires mid-call.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token

  const key = env('QL_SUPABASE_ANON_KEY') || config.key()
  const res = await fetch(`${config.url()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: env('QL_USER_EMAIL'),
      password: env('QL_USER_PASSWORD'),
    }),
  })

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }

  const session = await res.json()
  cached = {
    token: session.access_token,
    expiresAt: Date.now() + (session.expires_in ?? 3600) * 1000,
  }
  return cached.token
}

// ─── explore.mjs ─────────────────────────────────────────────────

/**
 * The open-ended half of the server.
 *
 * The curated tools answer the questions that get asked every day, fast and
 * correctly. These two answer everything else — because the assistant is only
 * as good as the data it can reach, and a fixed tool list quietly turns every
 * unanticipated question into "I have no record of that".
 *
 * Both are read-only BY CONSTRUCTION, not by promise: they issue PostgREST GET
 * requests. There is no SQL string to inject into and no verb that writes.
 */


/** Columns whose values are credentials rather than business data. */
const SECRET = /(token|secret|password|_key|apikey|bearer)/i

/** The most rows a single answer may pull back. */
const MAX_LIMIT = 500

const redact = (rows) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, SECRET.test(k) && v ? '[redacted]' : v]),
    ),
  )

const authHeaders = () => ({
  apikey: config.key(),
  Authorization: `Bearer ${config.key()}`,
})

let schemaCache = null

/**
 * PostgREST serves an OpenAPI description of the whole schema at its root, so
 * the table and column list is live rather than a copy that goes stale the
 * next time a migration lands.
 */
async function fetchSchema() {
  if (schemaCache) return schemaCache
  const res = await fetch(`${config.url()}/rest/v1/`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`schema: ${res.status}`)

  const spec = await res.json()
  const tables = {}
  for (const [name, def] of Object.entries(spec.definitions ?? {})) {
    tables[name] = Object.entries(def.properties ?? {}).map(([col, p]) => `${col} ${p.format ?? p.type}`)
  }
  schemaCache = tables
  return tables
}

async function getSchema({ table } = {}) {
  const tables = await fetchSchema()
  if (table) {
    const match = Object.keys(tables).find((t) => t.toLowerCase() === String(table).toLowerCase())
    if (!match) {
      return {
        summary: `There is no table called ${table}.`,
        tables: Object.keys(tables),
      }
    }
    return {
      summary: `${match} has ${tables[match].length} columns.`,
      table: match,
      columns: tables[match],
    }
  }
  const names = Object.keys(tables)
  return {
    summary: `${names.length} tables are available.`,
    tables: names,
    hint: 'Call get_schema with a table name for its columns, then query_table to read it.',
  }
}

/**
 * Read any table, with PostgREST filters.
 *
 * @param {object} args
 * @param {string} args.table
 * @param {string} [args.columns] comma-separated, or '*'
 * @param {Record<string,string>} [args.filters] column -> PostgREST operator,
 *   e.g. { stage: 'eq.won', value: 'gte.5000', suburb: 'ilike.*brisbane*' }
 * @param {string} [args.order] e.g. 'created_at.desc'
 * @param {number} [args.limit]
 */
async function queryTable({ table, columns = '*', filters = {}, order, limit = 50 } = {}) {
  if (!table) throw new Error('table is required')

  const qs = new URLSearchParams({ select: columns })
  for (const [col, expr] of Object.entries(filters)) qs.set(col, String(expr))
  if (order) qs.set('order', order)
  qs.set('limit', String(Math.min(Number(limit) || 50, MAX_LIMIT)))

  const res = await fetch(`${config.url()}/rest/v1/${table}?${qs}`, {
    headers: { ...authHeaders(), Prefer: 'count=exact' },
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    // PostgREST's own errors name the bad column or operator, which is exactly
    // what the assistant needs to correct itself and try again.
    throw new Error(`${table}: ${res.status} ${body}`)
  }

  const rows = redact(await res.json())
  const total = Number(res.headers.get('content-range')?.split('/')[1])
  const matched = Number.isFinite(total) ? total : rows.length

  return {
    summary: `${matched} row${matched === 1 ? '' : 's'} in ${table}${matched > rows.length ? `, showing ${rows.length}` : ''}.`,
    table,
    matched,
    returned: rows.length,
    rows,
  }
}

const EXPLORE_TOOLS = [
  {
    name: 'get_schema',
    description:
      'List every table in the QuoteLeads database, or the columns of one table. Use this before query_table when a question needs data the purpose-built tools do not cover.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string', description: 'Table name. Omit to list all tables.' } },
    },
    handler: getSchema,
  },
  {
    name: 'query_table',
    description:
      'Read any table with filters — the general-purpose fallback for questions the other tools do not answer. Filters are PostgREST expressions keyed by column: {"stage":"eq.won","value":"gte.5000","created_at":"gte.2026-08-01","suburb":"ilike.*brisbane*"}. Prefer a purpose-built tool when one fits; it is faster and already knows the business rules.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table to read. Get names from get_schema.' },
        columns: { type: 'string', description: 'Comma-separated column list, or * for all. Default *.' },
        filters: {
          type: 'object',
          description: 'Column to PostgREST filter expression: eq, neq, gt, gte, lt, lte, like, ilike, in, is.',
          additionalProperties: { type: 'string' },
        },
        order: { type: 'string', description: 'e.g. created_at.desc' },
        limit: { type: 'number', description: 'Rows to return. Default 50, maximum 500.' },
      },
      required: ['table'],
    },
    handler: queryTable,
  },
]

// ─── tools.mjs ───────────────────────────────────────────────────

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
 * writes to it — the app computes revenue from three sources, and so does this
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
 *     YYYY-MM `period`. Monthly granularity — there is no daily figure.
 *   - ad_spend_daily.spend for account_type 'agency' is CUMULATIVE year to
 *     date, not that day's spend. Spend for a period is the latest row in it
 *     minus the latest row before it. Summing those rows, as an obvious
 *     reading would, inflates the number enormously.
 */
async function getAdSpendAndCpl({ month } = {}) {
  const target = month || localMonth()
  const from = `${target}-01`
  const end = new Date(`${from}T12:00:00Z`)
  end.setUTCMonth(end.getUTCMonth() + 1)
  const next = end.toISOString().slice(0, 8) + '01'

  const agency = { select: 'date,spend', account_type: 'eq.agency', order: 'date.desc' }
  const [spendLog, latest, baseline] = await Promise.all([
    select('campaign_spend_log', { select: 'campaign_name,spend,leads,period,source', period: `eq.${target}` }, { limit: 2000 }),
    select('ad_spend_daily', { ...agency, date: `gte.${from}`, and: `(date.lt.${next})` }, { limit: 1 }),
    select('ad_spend_daily', { ...agency, date: `lt.${from}` }, { limit: 1 }),
  ])

  const pplSpend = sum(spendLog.rows, 'spend')
  const pplLeads = spendLog.rows.reduce((s, r) => s + Number(r.leads || 0), 0)
  const cpl = pplLeads ? Math.round((pplSpend / pplLeads) * 100) / 100 : null

  const agencySpend = Math.max(
    0,
    Number(latest.rows[0]?.spend || 0) - Number(baseline.rows[0]?.spend || 0),
  )

  return ok(
    pplLeads
      ? `${money(pplSpend)} on pay-per-lead advertising this month for ${pplLeads} leads, a cost per lead of ${money(cpl)}. Agency spend is ${money(agencySpend)}.`
      : `No pay-per-lead spend is logged for ${target}. Agency spend is ${money(agencySpend)}.`,
    {
      month: target,
      pay_per_lead: { spend: pplSpend, leads: pplLeads, cpl, campaigns: spendLog.rows.length },
      agency: { spend: agencySpend, as_at: latest.rows[0]?.date ?? null },
      total_spend: pplSpend + agencySpend,
      note: 'Pay-per-lead spend is logged monthly, so there is no daily figure. Agency spend is a delta of cumulative year-to-date rows.',
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
 * index.html does — same table, same single-brace placeholders.
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
  if (!task_id) throw new Error('task_id is required — get it from list_tasks')

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
  if (!task_id) throw new Error('task_id is required — get it from list_tasks')
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

const TOOLS = [
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
    description: 'Sales pipeline leads that arrived today, with yesterday and the seven-day average for comparison, broken down by source. Sales pipeline only — use get_ppl_summary for pay-per-lead.',
    inputSchema: { type: 'object', properties: {} },
    handler: getLeadsToday,
  },
  {
    name: 'get_lead_totals',
    description:
      'Lead counts for every period at once — today, yesterday, the last seven days, month to date, all time — for BOTH the sales pipeline (the `leads` table) and pay-per-lead (`ppl_leads`). Answers "how many leads today", "how many in our sales pipeline" and "how many pay per lead leads".',
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
      'Permanently delete a task. There is no undo. Requires the task id from list_tasks — never delete from a name match alone, and confirm with the user first.',
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



const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

/** Tools that change something. Withheld unless the caller opts in. */
const EFFECTFUL = /^(update|send|create|delete)_/

const SYSTEM = `You are JARVIS, speaking to the person who runs QuoteLeads.

You are spoken aloud, so length is the main constraint. Two sentences is the
ceiling in conversation; reading out data they asked for is the one exception.
No filler, no enthusiasm, no apologies. Say "Yes", never "yeah". Address them as
"sir" in roughly half your replies, never twice in one reply.

THE NUMBERS ARE NEVER FROM MEMORY. Every business fact comes from a tool. If a
tool reports nothing, that is a fact about the business: "I have no record of
it." Never estimate.

"LEADS" MEANS TWO THINGS AND THE WORDING DECIDES WHICH. "our sales pipeline",
"the pipeline", or a bare "leads" is the sales pipeline; "pay per lead" or "PPL"
is a different and larger set. get_lead_totals returns both, but ANSWER WITH ONE.
A bare "leads" question is about the sales pipeline: give that figure and stop.
Do not mention pay per lead, do not add "and none in pay per lead", do not
contrast the two. Pay per lead is reported only when they name it.

- "How are we doing", "what are our numbers" -> get_daily_brief, one call.
- "How many leads" -> get_lead_totals. "How many closes" -> get_closes.
- "Are we ahead of goal" -> get_revenue_vs_goal.
- A name is a lead, a client, or a rep: try find_lead, then get_client_snapshot,
  then get_rep_performance.
- Anything not covered: get_schema to find the table, then query_table. Never
  say data is unavailable without trying that.
- A lead with no owner is handled by the person you are speaking to. It is never
  "unassigned".
- Read money as words: "forty-one thousand dollars", not "AUD 41000".

BEFORE ANYTHING IRREVERSIBLE — sending an email or SMS, deleting a task — say
what you are about to do and who it affects, and wait for them to confirm. Use
get_email_draft to read an email back before sending it. Never act on a lead you
matched loosely; if more than one matched, ask which.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    // Same gate as every other function here: a real signed-in user, or nothing.
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization' }, 401)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const bearer = authHeader.replace('Bearer ', '').trim()
    const body = await req.json().catch(() => ({}))

    // ── The SMS bridge ──────────────────────────────────────────────────────
    // A text arrives from Twilio, not from a browser, so there is no user token
    // to present. This is the second accepted caller, and it is narrow:
    //
    //   1. the request must say via:'sms', and
    //   2. the bearer must be able to read jarvis_messages, which is revoked
    //      from anon and authenticated and forces RLS with no policies - so
    //      only a service-role key can do it.
    //
    // A capability test rather than a string compare against the service key:
    // that comparison broke once already when the runtime's copy turned out not
    // to match the dashboard's, and it fails silently when it breaks.
    //
    // What makes this safe is upstream, not here: the only route to it is
    // twilio-inbound-sms, which accepts a message only if it was sent TO
    // Jarvis's own number AND FROM the number in jarvis_notify_number. The
    // service key is not reachable from any browser, so nothing a client can
    // run reaches this branch.
    let isBridge = false
    if (body?.via === 'sms') {
      const caller = createClient(Deno.env.get('SUPABASE_URL')!, bearer)
      const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
      if (capErr) return json({ error: 'Unauthorized' }, 401)
      isBridge = true
    }

    let user: { app_metadata?: Record<string, unknown> } | null = null
    if (!isBridge) {
      const { data: { user: u }, error: authErr } = await admin.auth.getUser(bearer)
      if (authErr || !u) return json({ error: 'Unauthorized' }, 401)
      user = u
    }

    // Reps are scoped to their own leads in this app; JARVIS answers across the
    // whole business — revenue, margin, ad spend, every client, every rep's
    // numbers. account_type lives in app_metadata, which only the service role
    // can write, so it cannot be forged by the caller. This is the real
    // restriction: hiding the button in the UI is a convenience, not a control.
    const accountType = (user?.app_metadata as Record<string, unknown> | undefined)?.account_type
    if (!isBridge && (accountType === 'sales_rep' || accountType === 'lead_buyer')) {
      return json({ error: 'Not available for this account.' }, 403)
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set' }, 500)

    const messages = Array.isArray(body.messages) ? body.messages : []
    const text = String(body.text ?? '').trim()
    if (text) messages.push({ role: 'user', content: text })
    if (!messages.length) return json({ error: 'Nothing to answer' }, 400)
    if (messages.length > 40) messages.splice(0, messages.length - 40)

    // Writes are off unless the caller asks for them, mirroring the local
    // bridge's JARVIS_ALLOW_WRITES. A read-only session cannot be talked into
    // sending anything, because the tools are not on the list it is given.
    const allowWrites = body.allow_writes === true
    const available = TOOLS.filter((t) => allowWrites || !EFFECTFUL.test(t.name))
    const byName = new Map(available.map((t) => [t.name, t]))

    const client = new Anthropic({ apiKey })
    const used: string[] = []

    // The agentic loop: ask, run whatever tools come back, ask again with the
    // results, until the model answers in words. Bounded so a confused turn
    // cannot bill indefinitely.
    for (let turn = 0; turn < 8; turn++) {
      const res = await client.beta.messages.create({
        model: Deno.env.get('JARVIS_MODEL') ?? 'claude-opus-5',
        max_tokens: 8192,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        // Routes around a safety refusal instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        tools: available.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages,
      })

      messages.push({ role: 'assistant', content: res.content })

      if (res.stop_reason === 'refusal') {
        return json({ reply: 'I am unable to answer that.', tools: used }, 200)
      }

      if (res.stop_reason !== 'tool_use') {
        const reply = res.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('')
          .trim()
        return json({ reply, tools: used, messages }, 200)
      }

      // Every tool_use block must come back in ONE user message, including the
      // failures — dropping one ends the conversation mid-turn.
      const calls = res.content.filter((b: { type: string }) => b.type === 'tool_use')
      const results = await Promise.all(
        calls.map(async (call: { id: string; name: string; input: unknown }) => {
          used.push(call.name)
          const tool = byName.get(call.name)
          if (!tool) {
            return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `No such tool: ${call.name}` }
          }
          try {
            const out = await tool.handler(call.input ?? {})
            return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) }
          } catch (err) {
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: (err as Error).message,
            }
          }
        }),
      )
      messages.push({ role: 'user', content: results })
    }

    return json({ reply: 'That took too many steps, sir.', tools: used }, 200)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
