/**
 * The data layer: PostgREST over fetch, plus edge-function invocation.
 *
 * No @supabase/supabase-js on purpose. This server has zero dependencies, so
 * `node server.mjs` runs it on any machine with Node 20 — no install step, no
 * lockfile, nothing to drift out of date on a laptop that only ever runs it
 * through JARVIS.
 */

import { config } from './config.mjs'

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
export async function select(table, params = {}, { limit } = {}) {
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
export async function count(table, params = {}) {
  const qs = new URLSearchParams({ ...params, select: 'id' })
  const res = await fetch(`${config.url()}/rest/v1/${table}?${qs}`, {
    method: 'HEAD',
    headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' },
  })
  if (!res.ok) throw new Error(`${table}: ${res.status}`)
  return Number(res.headers.get('content-range')?.split('/')[1]) || 0
}

export async function patch(table, params, body) {
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

export async function insert(table, body) {
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

export async function remove(table, params) {
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
export async function invoke(fn, body, { token } = {}) {
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
