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

import { config } from './config.mjs'

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

export async function getSchema({ table } = {}) {
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
export async function queryTable({ table, columns = '*', filters = {}, order, limit = 50 } = {}) {
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

export const EXPLORE_TOOLS = [
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
