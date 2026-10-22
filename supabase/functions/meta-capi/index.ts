// Our own funnel back to Meta (Conversions API): the dogfood of ql-hq's
// meta-capi. As a pipeline lead moves on, the leads trigger
// (send_meta_conversion) calls this, once per lead and step, and the event
// goes to the dataset in business_settings.meta_dataset_id, so Meta can see
// which of our ads bring businesses that book, get a proposal and sign:
//   Schedule    the lead moves to call_back (Call-Back/Booked)
//   QuoteSent   the lead moves to proposal (a custom event)
//   Purchase    the lead moves to closed_won, with the build fee as its value
// No dataset ID, nothing is sent. Online checkouts are skipped by the trigger:
// the site pixel already sent those.
//
// Not through our Meta app: events are sent with a Conversions API token
// generated for our pixel in Events Manager (pixel > Settings > Conversions
// API > Generate access token), saved from Business Settings into the vault
// ('meta_capi_token'). Until there is one that reaches the pixel, a sale is
// held without using up a try, and the retry sends it once it can, while it's
// still within Meta's 7 days.
//
// Meta matches the sale by SHA-256 of the lead's email, phone, name, suburb
// and state; the value is the lead's build fee when one was entered.
//
//   POST {"action":"send","lead_id","event"?} / {"action":"retry"}  service role key
//     (the trigger, and pg_cron every 30 minutes for sales Meta didn't take)
//   POST {"action":"test","lead_id","test_event_code"}  service role key: the
//     lead's Purchase, timed now, to Events Manager's Test events tab only
//     (not counted, not recorded here), to check the setup end to end
//   POST {"action":"state"}  a signed-in MC user (not a rep): the dataset,
//     whether the saved token can reach it, and what was sent in 30 days
//
// Env: META_GRAPH_VERSION, META_TEST_EVENT_CODE (optional: send to Events
// Manager's Test events tab).
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH = `https://graph.facebook.com/${Deno.env.get('META_GRAPH_VERSION') || 'v23.0'}`
const MAX_ATTEMPTS = 5
const EVENTS = ['Schedule', 'QuoteSent', 'Purchase']
// What a held sale's error starts with.
const HELD = "Held: can't reach the dataset yet"
// Meta refuses events more than 7 days old.
const MAX_AGE_MS = 7 * 86_400_000

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
type Row = Record<string, unknown>
type Db = ReturnType<typeof createClient>

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function graph(path: string, token: string, init?: { form?: Row }): Promise<Row> {
  let res: Response
  if (init?.form) {
    const body = new URLSearchParams({ access_token: token })
    for (const [k, v] of Object.entries(init.form)) if (v != null) body.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    res = await fetch(`${GRAPH}/${path}`, { method: 'POST', body })
  } else {
    res = await fetch(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`)
  }
  const out = await res.json().catch(() => ({})) as Row
  const err = out.error as { message?: string; error_user_msg?: string } | undefined
  if (!res.ok || err) throw new Error(`Meta: ${err?.message || `HTTP ${res.status}`}${err?.error_user_msg ? ` (${err.error_user_msg})` : ''}`)
  return out
}

async function sha256(v: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Australian numbers as Meta wants them: country code, digits only. */
function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, '')
  if (d.startsWith('61')) return d
  if (d.startsWith('0')) return '61' + d.slice(1)
  return d.length === 9 ? '61' + d : d
}

async function userData(lead: Row): Promise<{ user: Row; matchedBy: string[] }> {
  const user: Row = {}, matchedBy: string[] = []
  const add = async (key: string, raw: unknown, norm: (s: string) => string = (s) => s.trim().toLowerCase()) => {
    const v = typeof raw === 'string' ? norm(raw) : ''
    if (!v) return
    user[key] = [await sha256(v)]
    matchedBy.push(key)
  }
  const [first, ...rest] = String(lead.name ?? '').trim().split(/\s+/)
  await add('em', lead.email)
  await add('ph', lead.phone, phoneDigits)
  await add('fn', first)
  await add('ln', rest.join(' '))
  await add('ct', lead.suburb, (s) => s.toLowerCase().replace(/[^a-z]/g, ''))
  await add('st', lead.state, (s) => s.toLowerCase().replace(/[^a-z]/g, ''))
  if (matchedBy.length) user.country = [await sha256('au')]
  user.external_id = [await sha256(String(lead.id))]
  return { user, matchedBy }
}

/**
 * Can this token send events to this pixel? A Conversions API token from
 * Events Manager may only send, not read the pixel, so this posts an empty
 * batch: Meta rejects it without recording anything, and how it rejects it
 * says whether the token itself was allowed. null when it can, else why not.
 */
async function canSend(dataset: string, token: string): Promise<string | null> {
  try {
    await graph(`${dataset}/events`, token, { form: { data: [] } })
    return null
  } catch (e) {
    // Meta checked the token and only then objected to the empty batch.
    const msg = (e as Error).message
    return /must be non-empty/i.test(msg) ? null : msg
  }
}

async function capiToken(db: Db): Promise<string | null> {
  const { data } = await db.rpc('get_meta_capi_token')
  return data ? String(data) : null
}

async function datasetId(db: Db): Promise<string> {
  const { data } = await db.from('business_settings').select('meta_dataset_id').limit(1).maybeSingle()
  return data?.meta_dataset_id ? String(data.meta_dataset_id) : ''
}

/** One funnel step as Meta's event. Only the sale carries the build fee. */
async function funnelEvent(lead: Row, name: string, at: string, eventId: string) {
  const { user, matchedBy } = await userData(lead)
  const value = name === 'Purchase' ? Number(lead.value || 0) : 0
  const event = {
    event_name: name,
    event_time: Math.floor(new Date(at).getTime() / 1000),
    event_id: eventId,
    action_source: 'system_generated',
    user_data: user,
    custom_data: {
      event_source: 'crm',
      lead_event_source: 'QuoteLeads Mission Control',
      ...(value > 0 ? { value, currency: 'AUD' } : {}),
    },
  }
  return { event, matchedBy, value }
}

/** A lead's Purchase to the Test events tab only: nothing counted or recorded. */
async function testSend(db: Db, leadId: string, testCode: string): Promise<Row> {
  const { data: lead } = await db.from('leads').select('*').eq('id', leadId).maybeSingle()
  if (!lead) return { ok: false, error: 'lead not found' }
  const dataset = await datasetId(db)
  const token = await capiToken(db)
  if (!dataset || !token) return { ok: false, error: 'no dataset ID or token saved' }
  const { event, matchedBy } = await funnelEvent(lead, 'Purchase', new Date().toISOString(), `test-${leadId}-${Date.now()}`)
  try {
    const out = await graph(`${dataset}/events`, token, { form: { data: [event], test_event_code: testCode } })
    return { ok: true, meta: out, matched_by: matchedBy }
  } catch (e) {
    return { ok: false, error: (e as Error).message, matched_by: matchedBy }
  }
}

/** One funnel step for one lead, sent once. */
async function send(db: Db, leadId: string, name: string): Promise<Row> {
  const { data: lead } = await db.from('leads').select('*').eq('id', leadId).maybeSingle()
  if (!lead) return { ok: true, skipped: 'lead not found' }
  // A sale reopened before it went isn't a sale; booking and proposal stand.
  if (name === 'Purchase' && lead.stage !== 'closed_won') return { ok: true, skipped: 'not closed_won' }
  const dataset = await datasetId(db)
  if (!dataset) return { ok: true, skipped: 'no dataset id' }

  const { data: prior } = await db.from('meta_capi_events').select('*').eq('lead_id', leadId).eq('event_name', name).maybeSingle()
  if (prior?.sent_at) return { ok: true, skipped: 'already sent' }

  // Meta would refuse it anyway: hold it, leaving the tries for real failures.
  const token = await capiToken(db)
  try {
    if (!token) throw new Error('no Conversions API token saved')
    const problem = await canSend(dataset, token)
    if (problem) throw new Error(problem)
  } catch (e) {
    await db.from('meta_capi_events').upsert({
      lead_id: leadId, event_name: name, dataset_id: dataset, attempts: Number(prior?.attempts || 0),
      error: `${HELD}: ${(e as Error).message}`,
    }, { onConflict: 'lead_id,event_name' })
    return { ok: true, sent: false, held: true }
  }

  // When it happened: the first try's time, so a retry reports the same moment.
  const eventId = name === 'Purchase' ? `closed_won-${leadId}` : `${name.toLowerCase()}-${leadId}`
  const { event, matchedBy, value } = await funnelEvent(lead, name, String(prior?.created_at || new Date().toISOString()), eventId)

  let error: string | null = null
  try {
    const testCode = Deno.env.get('META_TEST_EVENT_CODE')
    await graph(`${dataset}/events`, token!, { form: { data: [event], ...(testCode ? { test_event_code: testCode } : {}) } })
  } catch (e) {
    error = (e as Error).message
  }
  await db.from('meta_capi_events').upsert({
    lead_id: leadId, event_name: name, dataset_id: dataset, value: value > 0 ? value : null, matched_by: matchedBy,
    sent_at: error ? null : new Date().toISOString(), error, attempts: Number(prior?.attempts || 0) + 1,
  }, { onConflict: 'lead_id,event_name' })
  if (error) console.warn(`meta-capi: ${name} for lead ${leadId} to dataset ${dataset}: ${error}`)
  return { ok: !error, sent: !error, error, matched_by: matchedBy }
}

/** Events Meta didn't take, while they're recent enough for it to accept. */
async function retry(db: Db) {
  const since = new Date(Date.now() - MAX_AGE_MS + 3_600_000).toISOString()
  const { data: failed } = await db.from('meta_capi_events').select('lead_id, event_name').is('sent_at', null)
    .lt('attempts', MAX_ATTEMPTS).gte('created_at', since).order('created_at').limit(50)
  let sent = 0
  for (const r of failed ?? []) {
    const out = await send(db, String(r.lead_id), String(r.event_name))
    if (out.sent) sent++
    // Reopened, or the dataset ID taken off since: stop trying.
    else if (out.skipped) await db.from('meta_capi_events').update({ attempts: MAX_ATTEMPTS, error: `Not sent: ${out.skipped}` })
      .eq('lead_id', r.lead_id).eq('event_name', r.event_name)
  }
  return { ok: true, tried: (failed ?? []).length, sent }
}

/** For Business Settings: can our token reach the dataset, and what went. */
async function state(db: Db) {
  const dataset = await datasetId(db)
  const token = await capiToken(db)
  let reachable: boolean | null = null, name: string | null = null, problem: string | null = null
  if (dataset && !token) {
    reachable = false
    problem = 'No Conversions API token saved'
  } else if (dataset && token) {
    problem = await canSend(dataset, token)
    reachable = !problem
    // The pixel's name only when the token may read it; sending doesn't need it.
    if (reachable) name = await graph(`${dataset}?fields=name`, token).then((o) => o.name ? String(o.name) : null).catch(() => null)
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: rows } = await db.from('meta_capi_events').select('sent_at, error').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(500)
  const r = rows ?? []
  return {
    ok: true, dataset_id: dataset || null, token_saved: !!token, reachable, dataset_name: name, problem,
    last_30_days: {
      sent: r.filter((x) => x.sent_at).length,
      held: r.filter((x) => !x.sent_at && String(x.error ?? '').startsWith(HELD)).length,
      failed: r.filter((x) => !x.sent_at && !String(x.error ?? '').startsWith(HELD)).length,
    },
    last_error: r.find((x) => !x.sent_at && x.error && !String(x.error).startsWith(HELD))?.error ?? null,
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const auth = req.headers.get('Authorization') ?? ''
  const caller = auth.replace('Bearer ', '').trim()
  if (!caller) return json({ error: 'unauthorized' }, 401)
  const body = await req.json().catch(() => ({})) as Row
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    // The service key, proven by reading jarvis_messages, which nothing else can.
    const { error: notService } = await createClient(url, caller).from('jarvis_messages').select('id').limit(1)
    if (body.action === 'send' || body.action === 'retry' || body.action === 'test') {
      if (notService) return json({ error: 'unauthorized' }, 401)
      if (body.action === 'test') {
        if (!body.lead_id || !body.test_event_code) return json({ error: 'lead_id and test_event_code are required' }, 400)
        return json(await testSend(db, String(body.lead_id), String(body.test_event_code)))
      }
      if (body.action === 'retry') return json(await retry(db))
      if (!body.lead_id) return json({ error: 'lead_id is required' }, 400)
      const event = EVENTS.includes(String(body.event)) ? String(body.event) : 'Purchase'
      return json(await send(db, String(body.lead_id), event))
    }
    if (body.action === 'state' && !notService) return json(await state(db))
    if (body.action === 'state') {
      const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
      const { data: { user } } = await asUser.auth.getUser()
      if (!user) return json({ error: 'unauthorized' }, 401)
      const { data: rep } = await asUser.rpc('is_sales_rep')
      if (rep === true) return json({ error: 'forbidden' }, 403)
      return json(await state(db))
    }
    return json({ error: `Unknown action: ${body.action}` }, 400)
  } catch (err) {
    console.error('meta-capi error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
