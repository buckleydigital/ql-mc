/**
 * jarvis-outbox — sends Jarvis's bulk messages, a few at a time.
 *
 * A bulk send used to be Jarvis calling send_lead_sms and send_lead_email once
 * per lead inside one request. On 1 Oct a 180-lead campaign hit the edge
 * function time limit after 17 leads and died with half the list sent. Now
 * send_bulk_message writes the whole list to jarvis_outbox in one call and this
 * worker sends it:
 *
 *   - rows are claimed with jarvis_outbox_claim(), so each goes to exactly one
 *     worker even when two run at once;
 *   - every send goes through send-sms / send-sales-email, so the opt-out
 *     register, the 30-day duplicate guard and the logs all apply as for any
 *     other send;
 *   - it stops well inside the time limit and calls itself again if anything
 *     is left. If it dies anyway, the minutely cron (migration 20261001000001)
 *     picks the queue back up, and a row it was halfway through is retried -
 *     where the duplicate guard refuses it if it did go out.
 *
 * Callers: send_bulk_message (via jarvis-chat) and the cron. Both present the
 * service-role key, proven the same way jarvis-chat proves it: by reading
 * jarvis_messages, which nothing else can.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/** Seconds of sending per invocation; the platform limit is well above this. */
const BUDGET_MS = 100_000
/** Rows claimed per round. */
const BATCH = 5
/** Pause between sends, so Twilio and Resend see a steady trickle. */
const GAP_MS = 400

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Sends are made as the configured user, exactly as Jarvis's single sends are:
 * send-sms and send-sales-email attribute the message to that login.
 */
let session: { token: string; expiresAt: number } | null = null
async function userToken(): Promise<string> {
  if (session && session.expiresAt - 60_000 > Date.now()) return session.token
  const email = Deno.env.get('QL_USER_EMAIL')
  const password = Deno.env.get('QL_USER_PASSWORD')
  if (!email || !password) {
    throw new Error('QL_USER_EMAIL and QL_USER_PASSWORD are not set (Supabase > Edge Functions > Secrets)')
  }
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || SERVICE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const s = await res.json()
  session = { token: s.access_token, expiresAt: Date.now() + (s.expires_in ?? 3600) * 1000 }
  return session.token
}

type Row = {
  id: string; lead_id: string; channel: 'sms' | 'email'; recipient: string | null
  subject: string | null; body: string
}

/** One send. Returns the row's outcome. */
async function sendOne(row: Row): Promise<{ status: 'sent' | 'skipped' | 'failed'; detail: string | null }> {
  const token = await userToken()
  const [fn, payload] = row.channel === 'sms'
    ? ['send-sms', { to: row.recipient, message: row.body, lead_id: row.lead_id, source: 'sales' }]
    : ['send-sales-email', { lead_id: row.lead_id, kind: 'campaign', subject: row.subject, body: row.body }]

  const res = await fetch(`${URL_}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SERVICE },
    body: JSON.stringify(payload),
  })
  const out = await res.json().catch(() => ({} as Record<string, unknown>))
  const err = String((out as { error?: unknown }).error ?? '').slice(0, 300) || null

  // 409 is a refusal on principle - opted out, or already sent - not a fault.
  if (res.status === 409) return { status: 'skipped', detail: err }
  if (!res.ok) return { status: 'failed', detail: err ?? `${fn} ${res.status}` }
  // send-sms answers 200 with success:false when Twilio rejects the message.
  if (row.channel === 'sms' && (out as { success?: boolean }).success !== true) {
    return { status: 'failed', detail: err ?? 'Twilio rejected the message' }
  }
  return { status: 'sent', detail: null }
}

async function drain(): Promise<{ sent: number; skipped: number; failed: number; more: boolean }> {
  const db = createClient(URL_, SERVICE)
  const started = Date.now()
  const tally = { sent: 0, skipped: 0, failed: 0 }

  while (Date.now() - started < BUDGET_MS) {
    const { data: rows, error } = await db.rpc('jarvis_outbox_claim', { p_limit: BATCH })
    if (error) throw new Error(`claim: ${error.message}`)
    if (!rows?.length) return { ...tally, more: false }

    for (const row of rows as Row[]) {
      let result: { status: 'sent' | 'skipped' | 'failed'; detail: string | null }
      try {
        result = await sendOne(row)
      } catch (e) {
        result = { status: 'failed', detail: (e as Error).message.slice(0, 300) }
      }
      tally[result.status] += 1
      await db.from('jarvis_outbox').update({
        status: result.status,
        detail: result.detail,
        sent_at: result.status === 'sent' ? new Date().toISOString() : null,
      }).eq('id', row.id)
      await sleep(GAP_MS)
    }
  }

  const { count } = await db.from('jarvis_outbox').select('id', { count: 'exact', head: true }).eq('status', 'queued')
  return { ...tally, more: (count ?? 0) > 0 }
}

const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!bearer) return json({ error: 'Missing authorization' }, 401)
  const caller = createClient(URL_, bearer)
  const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'Unauthorized' }, 401)

  // Answer at once and send in the background, so a caller (jarvis-chat, the
  // cron) never waits on a whole batch.
  const work = drain()
    .then(async (r) => {
      console.log(`jarvis-outbox: ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed${r.more ? ', more queued' : ''}`)
      if (r.more) {
        // Next round in a fresh invocation, with a fresh time budget.
        await fetch(`${URL_}/functions/v1/jarvis-outbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
          body: '{}',
        }).catch((e) => console.error('jarvis-outbox: re-invoke failed:', e))
      }
    })
    .catch((e) => console.error('jarvis-outbox:', (e as Error).message))

  if (runtime?.waitUntil) runtime.waitUntil(work)
  else await work

  return json({ ok: true, started: true })
})
