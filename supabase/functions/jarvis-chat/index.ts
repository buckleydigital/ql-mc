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
      'Sending requires a login: add QL_USER_EMAIL and QL_USER_PASSWORD as Supabase ' +
        'Edge Function secrets (Supabase dashboard, ql-mc project, Edge Functions > Secrets), ' +
        'or to tools/jarvis/.env for the local bridge. Emails and texts are sent as that user, ' +
        'and replies go to them.',
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

// ─── memory.mjs ──────────────────────────────────────────────────

/**
 * Long-term memory: what JARVIS has been told and should still know tomorrow.
 *
 * Before this, "memory" was the transcript the browser happened to be holding.
 * Reload the page and it was gone; a text message and the panel had never met.
 * These are durable facts - preferences, standing instructions, context about a
 * client - kept in jarvis_memory and handed to the model at the start of every
 * conversation, on every channel.
 *
 * Business numbers are NOT memory. They come from the tools every time, because
 * a remembered figure is a stale figure. Memory is for what the database does
 * not already say: "Dave at Sandford prefers texts", "never chase before 9am",
 * "the goal this quarter is 60 closes".
 *
 * Naming follows the bridge's verb rules (see tools.mjs): get_ reads,
 * create_/delete_ write. The hosted brain lets the memory tools through even in
 * read-only mode - writing a note to himself reaches no customer.
 */


/** How much memory goes into the prompt. Newest first past this. */
const MEMORY_LIMIT = 200

async function loadMemories() {
  const { rows } = await select(
    'jarvis_memory',
    { select: 'id,content,created_at', order: 'created_at.desc' },
    { limit: MEMORY_LIMIT },
  )
  return rows.reverse()
}

async function getMemories({ search } = {}) {
  const params = { select: 'id,content,source,created_at', order: 'created_at.desc' }
  if (search) params.content = `ilike.*${String(search).replace(/[*,()]/g, ' ').trim()}*`
  const { rows, total } = await select('jarvis_memory', params, { limit: MEMORY_LIMIT })
  return { summary: `${total} memor${total === 1 ? 'y' : 'ies'}.`, memories: rows }
}

async function createMemory({ content, source } = {}) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('Nothing to remember.')
  if (text.length > 1000) throw new Error('Keep a memory under 1000 characters - one fact per memory.')
  const [row] = await insert('jarvis_memory', { content: text, source: source || null })
  return { summary: 'Remembered.', memory: { id: row.id, content: row.content } }
}

async function deleteMemory({ memory_id } = {}) {
  if (!memory_id) throw new Error('memory_id is required - get it from get_memories.')
  const rows = await remove('jarvis_memory', { id: `eq.${memory_id}` })
  if (!rows.length) return { summary: 'No memory with that id.' }
  return { summary: 'Forgotten.', memory: { id: rows[0].id, content: rows[0].content } }
}

const MEMORY_TOOLS = [
  {
    name: 'get_memories',
    description:
      'List what you have been told to remember. The hosted assistant already has these in its instructions; use this to find a memory id before deleting or correcting one, or to search by keyword.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Optional keyword to filter by.' } },
    },
    handler: getMemories,
  },
  {
    name: 'create_memory',
    description:
      'Save a durable fact for future conversations: a preference, a standing instruction, context about a client, lead or rep, a goal, a decision. One fact per call, written so it makes sense with no other context ("Dave at Sandford Electrical prefers SMS over email"). Never store business numbers the tools can fetch - they go stale.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact, as a complete sentence.' },
        source: { type: 'string', description: 'Optional: panel, sms or call.' },
      },
      required: ['content'],
    },
    handler: createMemory,
  },
  {
    name: 'delete_memory',
    description:
      'Forget a memory that is wrong or no longer true. Takes the id from get_memories. To correct one, delete it and create the corrected version.',
    inputSchema: {
      type: 'object',
      properties: { memory_id: { type: 'string', description: 'Memory UUID, from get_memories.' } },
      required: ['memory_id'],
    },
    handler: deleteMemory,
  },
]

// ─── jobs.mjs ────────────────────────────────────────────────────

/**
 * Jobs: work JARVIS schedules for himself.
 *
 * "Every weekday at 8 text me the numbers." "Thursday, chase Sandford if they
 * have not replied." Before this he could only act while someone was talking to
 * him. A job is an instruction plus a time; the heartbeat (jarvis-notify, every
 * 15 minutes) claims the due ones, runs each through jarvis-chat with his full
 * tools and memory, and texts the result to the owner.
 *
 * Times are LOCAL (config.timezone). The owner says "8am", not "22:00 UTC".
 */


const REPEATS = ['once', 'daily', 'weekdays', 'weekly', 'monthly']

/** Cost guard: every active job is a model run on its schedule. */
const MAX_ACTIVE_JOBS = 25

/** A local wall-clock time as a UTC instant, correct across DST (two passes). */
function localInstant(date, time) {
  const guess = new Date(`${date}T${time}:00Z`)
  const first = new Date(guess.getTime() - offsetMinutes(guess) * 60000)
  return new Date(guess.getTime() - offsetMinutes(first) * 60000)
}

const localWhen = (iso) =>
  iso
    ? new Intl.DateTimeFormat('en-AU', {
        timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit',
      }).format(new Date(iso))
    : null

async function getJobs() {
  const { rows } = await select(
    'jarvis_jobs',
    { select: 'id,title,instruction,repeat,next_run_at,last_run_at,last_result,runs', active: 'is.true', order: 'next_run_at.asc' },
    { limit: 100 },
  )
  const jobs = rows.map((j) => ({ ...j, next_run_local: localWhen(j.next_run_at) }))
  return {
    summary: jobs.length
      ? `${jobs.length} scheduled: ${jobs.slice(0, 3).map((j) => `${j.title} (${j.next_run_local})`).join('; ')}.`
      : 'Nothing scheduled.',
    jobs,
  }
}

async function createJob({ title, instruction, date, time, repeat = 'once' } = {}) {
  title = String(title ?? '').trim()
  instruction = String(instruction ?? '').trim()
  if (!title || !instruction) throw new Error('title and instruction are required')
  if (!REPEATS.includes(repeat)) throw new Error(`repeat must be one of ${REPEATS.join(', ')}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) throw new Error('date must be YYYY-MM-DD (local)')
  if (!/^\d{2}:\d{2}$/.test(String(time ?? ''))) throw new Error('time must be HH:MM, 24-hour, local')

  const at = localInstant(date, time)
  if (Number.isNaN(at.getTime())) throw new Error('That date and time do not exist.')
  if (at.getTime() < Date.now() - 60_000) {
    throw new Error(`${date} ${time} has already passed (today is ${localDate()}). Pick a future time.`)
  }

  const { total } = await select('jarvis_jobs', { select: 'id', active: 'is.true' }, { limit: 1 })
  if (total >= MAX_ACTIVE_JOBS) {
    throw new Error(`There are already ${total} scheduled jobs, the limit. Cancel one first.`)
  }

  const [row] = await insert('jarvis_jobs', {
    title: title.slice(0, 120),
    instruction: instruction.slice(0, 2000),
    repeat,
    next_run_at: at.toISOString(),
  })
  return {
    summary: `Scheduled "${row.title}" for ${localWhen(row.next_run_at)}${repeat === 'once' ? '' : `, then ${repeat}`}.`,
    job: { id: row.id, title: row.title, repeat: row.repeat, next_run_local: localWhen(row.next_run_at) },
  }
}

async function deleteJob({ job_id } = {}) {
  if (!job_id) throw new Error('job_id is required - get it from get_jobs.')
  // Deactivated rather than deleted, so its history stays readable.
  const rows = await patch('jarvis_jobs', { id: `eq.${job_id}` }, { active: false })
  if (!rows.length) return { summary: 'No job with that id.' }
  return { summary: `Cancelled "${rows[0].title}".` }
}

const JOB_TOOLS = [
  {
    name: 'get_jobs',
    description: 'List the jobs you have scheduled for yourself: what, when next, how often, and the last result. Returns the ids delete_job needs.',
    inputSchema: { type: 'object', properties: {} },
    handler: getJobs,
  },
  {
    name: 'create_job',
    description:
      'Schedule work for yourself to do later, once or on repeat - a report, a check, a follow-up. ' +
      'When it comes due you will run it with all your tools and memory, and the result is texted to the owner. ' +
      'Write the instruction as a complete brief to your future self: what to check or do, for whom, and what ' +
      'to report. If it may send an email or SMS to a lead, say so explicitly in the instruction - a job only ' +
      'sends to leads when its instruction says to. Times are local.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name, e.g. "Morning numbers".' },
        instruction: { type: 'string', description: 'The full brief for when it runs.' },
        date: { type: 'string', description: 'First run date, YYYY-MM-DD, local.' },
        time: { type: 'string', description: 'First run time, HH:MM 24-hour, local.' },
        repeat: { type: 'string', enum: REPEATS, description: 'once (default), daily, weekdays, weekly or monthly.' },
      },
      required: ['title', 'instruction', 'date', 'time'],
    },
    handler: createJob,
  },
  {
    name: 'delete_job',
    description: 'Cancel a scheduled job. Takes the id from get_jobs.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job UUID, from get_jobs.' } },
      required: ['job_id'],
    },
    handler: deleteJob,
  },
]

// ─── content.mjs ─────────────────────────────────────────────────

/**
 * Content: social posts JARVIS drafts for the owner to approve and post.
 *
 * Not connected to any social account. There is no publish tool, on purpose:
 * a post ends on the Posts screen as a branded image and a caption, and the
 * owner posts it themselves.
 *
 * Drafting goes through jarvis-content, which runs every draft past a lint and
 * an editor model before saving it. A draft that fails comes back with the
 * exact fixes; revise and call create_post_draft again. Only passing drafts
 * reach the owner.
 */


async function getContentBrief() {
  const out = await invoke('jarvis-content', { action: 'brief' })
  return {
    summary: out.brief_is_default
      ? 'Using the default content brief (the owner has not written one yet).'
      : 'Content brief loaded.',
    ...out,
  }
}

async function createPostDraft({ caption, card, facts = [], platforms, post_id } = {}) {
  const out = await invoke('jarvis-content', {
    action: 'draft', caption, card, facts, platforms, post_id,
  })
  if (out.accepted) {
    return {
      summary: `Draft passed the editor (${out.score}/10) and is on the Posts screen for approval.`,
      ...out,
    }
  }
  // Not an error: the editor did its job. The fixes are the next step.
  return {
    summary: `Not good enough yet (${out.stage}${out.score ? `, ${out.score}/10` : ''}). Revise using the fixes and call create_post_draft again.`,
    ...out,
  }
}

async function getPosts({ status } = {}) {
  const params = {
    select: 'id,created_at,caption,original_caption,card,facts,image_url,editor_score,status,approved_at,posted_at',
    order: 'created_at.desc',
  }
  if (status) params.status = `eq.${status}`
  else params.status = 'neq.rejected'
  const { rows, total } = await select('jarvis_posts', params, { limit: 30 })
  const drafts = rows.filter((r) => r.status === 'draft').length
  return { summary: `${total} post${total === 1 ? '' : 's'}; ${drafts} waiting for approval.`, posts: rows }
}

const CONTENT_TOOLS = [
  {
    name: 'get_content_brief',
    description:
      'Before writing any social post: the content brief (audience, voice, rules), the owner\'s approved posts and their edits to your drafts (match that voice), and recent posts (do not repeat a topic or hook).',
    inputSchema: { type: 'object', properties: {} },
    handler: getContentBrief,
  },
  {
    name: 'create_post_draft',
    description:
      'Submit a Facebook/Instagram post for the owner to approve. It is checked by a strict editor first; if it fails you get the issues and fixes - revise and resubmit. ' +
      'Nothing is ever published: the owner posts it themselves. ' +
      'Every number and factual claim in the caption or card must be listed in facts with where it came from (a tool you ran, a table, the owner). ' +
      'Card styles: "stat" (stat of 9 characters or fewer, e.g. "3 sec", plus a headline), "tip" (a punchy headline, optional body), "quote" (a real quote the owner has approved, with attribution). ' +
      'Pass post_id to revise an existing draft.',
    inputSchema: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'The full post caption, as it will be posted.' },
        card: {
          type: 'object',
          description: 'The image text.',
          properties: {
            style: { type: 'string', enum: ['stat', 'tip', 'quote'] },
            kicker: { type: 'string', description: 'Small label above, 32 characters max. Optional.' },
            stat: { type: 'string', description: 'stat style only: the number, 9 characters max.' },
            headline: { type: 'string', description: '90 characters max. For quote style, the quote itself.' },
            body: { type: 'string', description: 'Optional supporting line, 170 characters max.' },
            attribution: { type: 'string', description: 'quote style only.' },
          },
          required: ['style', 'headline'],
        },
        facts: {
          type: 'array',
          description: 'Every figure or claim the post rests on.',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string', description: 'The fact, with its numbers, e.g. "98% of 400 delivered leads arrived within 5 minutes".' },
              source: { type: 'string', description: 'Where it came from, e.g. "ppl_leads delivered_at vs created_at, Mar-Aug 2026".' },
            },
            required: ['claim', 'source'],
          },
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['facebook', 'instagram', 'linkedin'] },
          description: 'Where it is meant for. Default facebook + instagram.',
        },
        post_id: { type: 'string', description: 'To revise an existing draft.' },
      },
      required: ['caption', 'card', 'facts'],
    },
    handler: createPostDraft,
  },
  {
    name: 'get_posts',
    description: 'Posts you have drafted and their state: draft (waiting for the owner), approved, posted. Includes the owner\'s edits.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['draft', 'approved', 'posted'] } },
    },
    handler: getPosts,
  },
]

// ─── outreach.mjs ────────────────────────────────────────────────

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

const OUTREACH_TOOLS = [
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
  ...MEMORY_TOOLS,
  ...JOB_TOOLS,
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

/**
 * Except his own notes. Remembering or forgetting a fact reaches no customer and
 * changes no number, and a read-only Jarvis that cannot be told "remember that"
 * is exactly the goldfish this was built to stop being.
 *
 * Post drafts likewise: a draft sits on the Posts screen until the owner
 * approves it and posts it by hand. No tool publishes anything.
 */
const ALWAYS_ALLOWED = /_memor(y|ies)$|^create_post_draft$/

/**
 * Anthropic-hosted tools: they run on Anthropic's servers, not here, so he can
 * look something up on the web - a supplier, a suburb, a competitor, an award
 * rate - without this function fetching anything itself. Capped per turn so a
 * curious question cannot run up a search bill.
 */
const SERVER_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
]

/**
 * List prices, US dollars per million tokens, for costing each question.
 * `write` is the 5-minute cache write (1.25x input), `read` the cache read.
 * Keyed by model-id prefix; a model not listed is costed at Claude Opus 5
 * rates rather than at zero, so an unknown model over-reports, never hides.
 */
const PRICES: Record<string, { input: number; output: number; write: number; read: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, write: 5, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, write: 6.25, read: 0.5 },
  'claude-opus-4': { input: 5, output: 25, write: 6.25, read: 0.5 },
  'claude-fable-5': { input: 10, output: 50, write: 12.5, read: 0.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, write: 2.5, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, write: 2.5, read: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, write: 1.25, read: 0.1 },
}
const WEB_SEARCH_USD = 10 / 1000

function priceFor(model: string) {
  const key = Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return PRICES[key ?? 'claude-opus-5']
}

/** Running total for one question, across every step of the loop. */
function newSpend() {
  return {
    steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    searches: 0, fetches: 0, cost: 0, models: new Set<string>(),
  }
}

function addUsage(spend: ReturnType<typeof newSpend>, res: any) {
  const u = res?.usage ?? {}
  const model = String(res?.model ?? '')
  const p = priceFor(model)
  const input = Number(u.input_tokens ?? 0)
  const output = Number(u.output_tokens ?? 0)
  const read = Number(u.cache_read_input_tokens ?? 0)
  const write = Number(u.cache_creation_input_tokens ?? 0)
  const searches = Number(u.server_tool_use?.web_search_requests ?? 0)
  spend.steps += 1
  spend.input += input
  spend.output += output
  spend.cacheRead += read
  spend.cacheWrite += write
  spend.searches += searches
  spend.fetches += Number(u.server_tool_use?.web_fetch_requests ?? 0)
  if (model) spend.models.add(model)
  spend.cost +=
    (input * p.input + output * p.output + read * p.read + write * p.write) / 1e6 +
    searches * WEB_SEARCH_USD
}

/** Rounds of tool use per question before he gives up. */
const MAX_STEPS = 16

/** How much of a panel conversation is kept. */
const MAX_HISTORY = 40

/**
 * Keep the last `max` messages, starting on a real question.
 *
 * Cutting at an arbitrary index can leave a tool_result first, answering a
 * tool_use that was cut off - and the API rejects the whole conversation. So
 * after the cut, drop forward to the first user turn that is a question.
 */
function trimHistory(messages: any[], max = MAX_HISTORY) {
  if (messages.length <= max) return messages
  let out = messages.slice(-max)
  const isQuestion = (m: any) =>
    m?.role === 'user' &&
    (typeof m.content === 'string' ||
      (Array.isArray(m.content) && !m.content.some((b: any) => b?.type === 'tool_result')))
  const start = out.findIndex(isQuestion)
  out = start === -1 ? [] : out.slice(start)
  return out
}

/**
 * The thread as it is kept between questions: without the model's thinking.
 *
 * On Claude Opus 5.5 a thinking block is bound to the exact conversation that
 * produced it - system prompt, tools, every earlier message. Between questions
 * all three change here: the memory block in the system prompt grows, the
 * read-only switch changes the tool list, and the thread is trimmed from the
 * front. Replaying old thinking after any of that is a 400 on enforced
 * accounts. Removing all of it is always allowed (it is a leading run), and
 * costs nothing - earlier turns' thinking is not what the next answer needs.
 * Within one question the loop keeps its thinking, as tool use requires.
 */
function withoutThinking(messages: any[]) {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m
    const content = m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking')
    return { ...m, content: content.length ? content : [{ type: 'text', text: '…' }] }
  })
}

/** A stored transcript as lines a person can read: questions and answers only. */
function readable(messages: any[]) {
  const lines: { role: 'you' | 'jarvis'; text: string }[] = []
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      lines.push({ role: 'you', text: m.content })
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('')
        .trim()
      if (text) lines.push({ role: 'jarvis', text })
    }
  }
  return lines
}

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

YOU ARE AN AGENT, NOT A SEARCH BOX. When asked to do something, do all of it:
chain as many tools as the job takes, check your own work, and report what you
did. Do not stop to ask permission for reads or lookups. If a request is vague,
make the sensible call and say what you assumed. If something fails, try
another way before reporting it.

YOU HAVE A MEMORY. What you know appears below under WHAT YOU REMEMBER, and it
carries across days, devices, texts and calls.
- When they tell you a preference, a standing instruction, a fact about a
  client, lead or rep, a goal, or say "remember", call create_memory at once,
  one fact per call, written to make sense on its own later. Do not announce it
  beyond a word like "Noted."
- When a memory turns out wrong or stale, delete_memory it and save the fix.
- Never save business numbers the tools can fetch; they go stale.
- Use what you remember without being asked: if you know Dave prefers texts,
  suggest a text.

YOU CAN SCHEDULE YOUR OWN WORK. "Every morning", "on Friday", "remind me",
"if they have not replied by Thursday" -> create_job with a complete brief to
your future self, then confirm the time in one line. get_jobs lists them,
delete_job cancels. A job that should send anything to a lead must say so in its
instruction; otherwise it reports and drafts.

SOCIAL POSTS. You draft Facebook/Instagram posts; the owner approves and posts
them by hand - you cannot publish anything, and never say you have.
- Always get_content_brief first, and match the owner's own voice from it.
- Build posts on something true and specific: real aggregate numbers from the
  tools (rounded, never a single client's), a practical lesson for installers,
  or how the business actually works. If there is nothing true and interesting
  to say, say so rather than writing filler.
- Never name or identify a client or lead, never show a client's own figures,
  never invent a number, result or quote.
- List every figure and claim in facts with its source. The editor rejects
  anything else. When it sends a draft back, fix exactly what it says and
  resubmit; do not argue with it. Three rejections: stop and tell the owner why.
- Once saved, tell them it is on the Posts screen, in one line.

THE WEB. web_search and web_fetch are for the outside world: a business, a
supplier, a competitor, a suburb, a regulation, a news item. Never for our own
numbers, which are only ever from the tools above.

WHAT HAS BEEN SENT IS IN THE LOG, NOT IN YOUR MEMORY. Before you say whether
anything went out, before a follow-up or chase, and after any error or cut-off
during a send, call get_outreach_log and answer from it. A request can die
halfway through a send; the log is the only record of what actually happened.
- More than 3 leads: send_bulk_message, once. Never loop send_lead_sms or
  send_lead_email over a list. Preview first, read back who is in and who is
  left out, get a yes, then send with dry_run false.
- Never message a lead twice. Anyone contacted in the last 7 days is left out
  automatically; only lower that if the owner explicitly says so. The server
  refuses the same message to the same person within 30 days - if a send is
  refused as already sent, it was sent: say so, do not try to get round it.

BEFORE ANYTHING IRREVERSIBLE — sending an email or SMS, deleting a task — say
what you are about to do and who it affects, and wait for them to confirm. Use
get_email_draft to read an email back before sending it. Never act on a lead you
matched loosely; if more than one matched, ask which.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Declared outside the try so a question that errors halfway is still
  // costed - the API calls it made before failing were billed all the same.
  const spend = newSpend()
  let channel = 'panel'
  let spender: string | null = null
  const recordUsage = async (outcome: string) => {
    if (!spend.steps) return
    try {
      const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { error } = await db.from('jarvis_usage').insert({
        channel,
        user_id: spender,
        model: [...spend.models].join(', ') || null,
        outcome,
        steps: spend.steps,
        input_tokens: spend.input,
        output_tokens: spend.output,
        cache_read_tokens: spend.cacheRead,
        cache_write_tokens: spend.cacheWrite,
        web_searches: spend.searches,
        web_fetches: spend.fetches,
        cost_usd: Math.round(spend.cost * 1e6) / 1e6,
      })
      if (error) console.error('jarvis-chat: usage not recorded:', error.message)
    } catch (err) {
      console.error('jarvis-chat: usage not recorded:', (err as Error).message)
    }
  }

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
    // Scheduled jobs come in the same way, from jarvis-notify's heartbeat, and
    // pass the same service-role capability test.
    let isBridge = false
    if (body?.via === 'sms' || body?.via === 'job') {
      const caller = createClient(Deno.env.get('SUPABASE_URL')!, bearer)
      const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
      if (capErr) return json({ error: 'Unauthorized' }, 401)
      isBridge = true
    }

    let user: { id?: string; app_metadata?: Record<string, unknown> } | null = null
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

    // ── The panel's conversation lives here, not in the browser ─────────────
    // A caller that sends its own `messages` (the SMS bridge) owns its history.
    // The panel sends only the new question; the thread is loaded from and
    // saved to jarvis_threads under the signed-in user, so a reload, a second
    // tab or a phone continues the same conversation.
    const userId = user?.id ?? null
    channel = isBridge ? String(body.via) : 'panel'
    spender = userId
    const threaded = !isBridge && !!userId && !Array.isArray(body.messages)

    const loadThread = async () => {
      const { data } = await admin
        .from('jarvis_threads').select('messages').eq('user_id', userId).maybeSingle()
      return Array.isArray(data?.messages) ? data.messages : []
    }
    const saveThread = async (msgs: unknown[]) => {
      if (!threaded) return
      const { error } = await admin.from('jarvis_threads').upsert({
        user_id: userId,
        messages: withoutThinking(trimHistory(msgs)),
        updated_at: new Date().toISOString(),
      })
      if (error) console.error('jarvis-chat: thread not saved:', error.message)
    }

    if (body.action === 'history') {
      if (!threaded) return json({ lines: [] })
      return json({ lines: readable(await loadThread()) })
    }
    if (body.action === 'reset') {
      if (threaded) await admin.from('jarvis_threads').delete().eq('user_id', userId)
      return json({ ok: true })
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set' }, 500)

    let messages: any[] = threaded
      ? withoutThinking(await loadThread())
      : Array.isArray(body.messages) ? body.messages : []
    // A thread that ends on tool results is a turn that was cut off mid-way.
    // Close it in words that send him to the log, rather than letting him
    // guess what happened.
    if (threaded && messages[messages.length - 1]?.role === 'user' && typeof messages[messages.length - 1].content !== 'string') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: '[My last request was cut off before I finished. Anything above may or may not have completed; I must check get_outreach_log before saying what was sent.]' }],
      })
    }
    const text = String(body.text ?? '').trim()
    if (text) messages.push({ role: 'user', content: text })
    if (!messages.length) return json({ error: 'Nothing to answer' }, 400)
    messages = trimHistory(messages)

    // What he remembers, read fresh every question so a fact saved by text is
    // known in the panel a second later. Best effort: a memory table that is
    // missing or down must not take the assistant with it.
    let remembered = '(nothing yet)'
    try {
      const mems = await loadMemories()
      if (mems.length) remembered = mems.map((m: { content: string }) => `- ${m.content}`).join('\n')
    } catch (err) {
      console.error('jarvis-chat: memory unavailable:', (err as Error).message)
    }
    const system = [
      // Static first, so the prompt cache can hold it across questions.
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text:
          `Today is ${localDate()} (${config.timezone}). ` +
          `Channel: ${channel}.` +
          (channel === 'job'
            ? ' This is one of your scheduled jobs running unattended: nobody is watching this turn. Do the ' +
              'job now, then write the report that will be texted to the owner - plain text, no markdown, ' +
              'under 600 characters, leading with what matters. Send an email or SMS to a lead ONLY if the ' +
              'job instruction explicitly says to; otherwise draft it and say in the report what you would ' +
              'send, so they can reply yes.'
            : '') +
          `\n\nWHAT YOU REMEMBER:\n${remembered}`,
      },
    ]

    // Writes are off unless the caller asks for them, mirroring the local
    // bridge's JARVIS_ALLOW_WRITES. A read-only session cannot be talked into
    // sending anything, because the tools are not on the list it is given.
    const allowWrites = body.allow_writes === true
    const available = TOOLS.filter(
      (t) => allowWrites || !EFFECTFUL.test(t.name) || ALWAYS_ALLOWED.test(t.name),
    )
    const byName = new Map(available.map((t) => [t.name, t]))

    const client = new Anthropic({ apiKey })
    const used: string[] = []

    // The agentic loop: ask, run whatever tools come back, ask again with the
    // results, until the model answers in words. Bounded so a confused turn
    // cannot bill indefinitely.
    for (let turn = 0; turn < MAX_STEPS; turn++) {
      const res = await client.beta.messages.create({
        model: Deno.env.get('JARVIS_MODEL') ?? 'claude-opus-5-5',
        max_tokens: 8192,
        system,
        // drop_block: if a stored thread ever does carry thinking the model no
        // longer accepts, drop that reasoning and answer rather than fail the
        // whole question. withoutThinking() means it should never be needed.
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        // Set explicitly: Opus 5.5 defaults to medium. He is spoken aloud and
        // most questions are one lookup, so low keeps him quick and cheap.
        output_config: { effort: 'low' },
        // Routes around a safety refusal instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
        fallbacks: 'default',
        tools: [
          ...available.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
          ...SERVER_TOOLS,
        ],
        messages,
      })

      addUsage(spend, res)
      messages.push({ role: 'assistant', content: res.content })

      // Record the hosted tools too, so the panel shows he went to the web.
      for (const b of res.content as { type: string; name?: string }[]) {
        if (b.type === 'server_tool_use' && b.name) used.push(b.name)
      }

      if (res.stop_reason === 'refusal') {
        // Not saved: a refused turn in the stored thread would poison the next.
        await recordUsage('refused')
        return json({ reply: 'I am unable to answer that.', tools: used }, 200)
      }

      // The web tools run in a loop on Anthropic's side, which pauses after a
      // while. Sending the transcript straight back resumes it - no extra user
      // message, the trailing server_tool_use is what tells the API to carry on.
      if (res.stop_reason === 'pause_turn') continue

      if (res.stop_reason !== 'tool_use') {
        const reply = res.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('')
          .trim()
        await saveThread(messages)
        await recordUsage('answered')
        return json({ reply, tools: used, messages: threaded ? undefined : messages }, 200)
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
      // Saved after every round, not only at the end: if this request is cut
      // off (the platform's time limit, a dropped connection), the next
      // question still sees what the tools already did - including sends.
      await saveThread(messages)
    }

    // Close the turn in words so the saved thread stays a valid conversation
    // and the next question does not land in the middle of a tool call.
    const giveUp = 'That took too many steps, sir. Tell me which part to do first.'
    if (messages[messages.length - 1]?.role === 'user') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: giveUp }] })
    }
    await saveThread(messages)
    await recordUsage('too_many_steps')
    return json({ reply: giveUp, tools: used }, 200)
  } catch (err) {
    await recordUsage('error')
    return json({ error: (err as Error).message }, 500)
  }
})
