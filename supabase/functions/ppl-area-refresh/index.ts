/**
 * ppl-area-refresh - keeps pay-per-lead routing in step with area fill.
 *
 * ql-hq splits a pay-per-lead order into areas, each with its own postcodes
 * and its own number of leads. Leads are routed here by clients.postcodes, so
 * every few minutes this asks ql-hq (ppl-area-postcodes) which postcodes each
 * company still has room in and writes them onto the client: a full area's
 * postcodes drop off and its leads stop. Companies ql-hq does not list (an
 * older, unsplit order still running) are left exactly as they are.
 *
 * Run by pg_cron with the service-role key, proven by reading jarvis_messages,
 * which nothing else can.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Missing authorization' }, 401)
  const url = Deno.env.get('SUPABASE_URL')!
  const { error: capErr } = await createClient(url, token).from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'Unauthorized' }, 401)

  const hqUrl = Deno.env.get('QL_HQ_API_URL'), secret = Deno.env.get('QL_MC_API_SECRET')
  if (!hqUrl || !secret) return json({ error: 'QL_HQ_API_URL / QL_MC_API_SECRET not set' }, 500)

  const res = await fetch(`${hqUrl}/ppl-area-postcodes`, { method: 'POST', headers: { 'x-api-secret': secret } })
  const out = await res.json().catch(() => ({}))
  if (!res.ok || !Array.isArray(out.companies)) return json({ error: out.error || `ql-hq returned ${res.status}` }, 502)

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const changed: Array<{ company_id: string; postcodes: number }> = []
  for (const c of out.companies as Array<{ company_id: string; postcodes: string[] }>) {
    const want = [...new Set((c.postcodes || []).map(String))].sort()
    const { data: clients } = await db.from('clients')
      .select('id, postcodes').eq('type', 'ppl').eq('ql_hq_company_id', c.company_id)
    for (const cl of clients || []) {
      const have = [...new Set(((cl.postcodes as string[] | null) || []).map(String))].sort()
      if (have.length === want.length && have.every((p, i) => p === want[i])) continue
      const { error } = await db.from('clients')
        .update({ postcodes: want, updated_at: new Date().toISOString() }).eq('id', cl.id)
      if (!error) changed.push({ company_id: c.company_id, postcodes: want.length })
    }
  }
  return json({ ok: true, companies: out.companies.length, changed })
})
