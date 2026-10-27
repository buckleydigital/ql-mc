/**
 * agency-spend-sync - the QuoteLeads ad account's spend, day by day, from Meta.
 *
 * One insights call a day (time_increment=1) for the agency ad account
 * (business_settings.agency_ad_account_id), written into ad_spend_daily as
 * each day's own spend (day_spend). Every day in the range gets a row, zero
 * days included, so a paused week reads as $0 a day rather than as a gap.
 * agency_spend_apply then rebuilds the running total for the year.
 *
 * The range is the last 7 days to yesterday (Sydney): Meta revises recent days
 * a little, and a missed morning heals itself. The first run, or a call with
 * { "backfill": true }, goes back to 1 January.
 *
 * Called by pg_cron each morning with the service-role key (proven by reading
 * jarvis_messages, which nothing else can), or by the owner from the
 * Scoreboard ("Sync spend now") with their login.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH = `https://graph.facebook.com/${Deno.env.get('META_GRAPH_VERSION') || 'v23.0'}`

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const sydneyDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Missing authorization' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  // The cron's service key reads jarvis_messages; an owner's login passes
  // jarvis_assert_operator. A rep, or anyone else, does neither.
  const asService = createClient(url, token)
  const { error: svcErr } = await asService.from('jarvis_messages').select('id').limit(1)
  if (svcErr) {
    const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } })
    const { error: opErr } = await asUser.rpc('jarvis_assert_operator')
    if (opErr) return json({ error: 'Unauthorized' }, 401)
  }

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const body = await req.json().catch(() => ({}))

  const { data: bs } = await db.from('business_settings')
    .select('id, agency_ad_account_id, agency_spend_synced_at').limit(1).maybeSingle()
  const account = String(bs?.agency_ad_account_id || '').replace(/^act_/, '').trim()
  if (!bs?.id || !/^\d+$/.test(account)) return json({ error: 'Set the QuoteLeads ad account ID first' }, 400)
  const metaToken = Deno.env.get('META_ACCESS_TOKEN')
  if (!metaToken) return json({ error: 'META_ACCESS_TOKEN not configured' }, 500)

  const until = addDays(sydneyDate(new Date()), -1)
  const since = body?.backfill === true || !bs.agency_spend_synced_at ? `${until.slice(0, 4)}-01-01` : addDays(until, -6)

  const fail = async (msg: string, status = 502) => {
    await db.from('business_settings').update({ agency_spend_error: msg.slice(0, 500) }).eq('id', bs.id)
    return json({ error: msg }, status)
  }

  // One call; pages only if Meta splits a long backfill.
  const days: Array<{ date: string; spend: number }> = []
  let next: string | null = `${GRAPH}/act_${account}/insights?` + new URLSearchParams({
    fields: 'spend',
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
    access_token: metaToken,
  })
  try {
    while (next) {
      const res: Response = await fetch(next)
      const out = await res.json().catch(() => ({}))
      if (!res.ok || out.error) return await fail(`Meta: ${out.error?.message || `HTTP ${res.status}`}`)
      for (const r of out.data || []) days.push({ date: r.date_start, spend: Number(r.spend || 0) })
      next = out.paging?.next || null
    }
  } catch (e) {
    return await fail(`Meta unreachable: ${(e as Error).message}`)
  }

  const { data: written, error } = await db.rpc('agency_spend_apply', { p_from: since, p_to: until, p_days: days })
  if (error) return await fail(error.message, 500)
  await db.from('business_settings')
    .update({ agency_spend_synced_at: new Date().toISOString(), agency_spend_error: null }).eq('id', bs.id)

  return json({
    ok: true, since, until, days: written,
    spend: Math.round(days.reduce((a, d) => a + d.spend, 0) * 100) / 100,
  })
})
