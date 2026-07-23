import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return json({ error: 'unauthorized' }, 401)

  const QL_HQ_API_URL    = Deno.env.get('QL_HQ_API_URL')!
  const QL_MC_API_SECRET = Deno.env.get('QL_MC_API_SECRET')!

  try {
    const body = await req.json()
    const { action } = body

    // ── action: scrub ─────────────────────────────────────────────────────────
    // Looks up the lead → client → ql_hq_company_id, then notifies ql-hq to
    // decrement delivered_leads on the matching ppl_order AND flag the exact
    // lead as scrubbed over there (matched by phone + name + company), so the
    // client can't dispute a lead that's already been credited.
    if (action === 'scrub') {
      const { lead_id } = body as { lead_id?: string }
      if (!lead_id) return json({ error: 'lead_id is required for scrub action' }, 400)

      // Get the lead's assigned client + identity (name/phone travel to ql-hq)
      const { data: lead } = await supabase
        .from('ppl_leads')
        .select('assigned_client_id, name, phone')
        .eq('id', lead_id)
        .maybeSingle()

      if (!lead?.assigned_client_id) return json({ ok: true, note: 'lead has no assigned client' })

      // Get the client's ql_hq_company_id
      const { data: client } = await supabase
        .from('clients')
        .select('ql_hq_company_id')
        .eq('id', lead.assigned_client_id)
        .maybeSingle()

      if (!client?.ql_hq_company_id) return json({ ok: true, note: 'client not linked to ql-hq' })

      const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': QL_MC_API_SECRET },
        body: JSON.stringify({
          action: 'scrub',
          ql_hq_company_id: client.ql_hq_company_id,
          lead: { name: lead.name ?? null, phone: lead.phone ?? null },
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`ql-hq returned ${res.status}: ${text}`)
      }

      return json({ ok: true })
    }

    // ── action: disable_ai ────────────────────────────────────────────────────
    // Forward a bulk-SMS recipient list to ql-hq so the AI SMS agent is switched
    // OFF for each of them (they went through the bulk SMS flow). ql-hq resolves
    // the agency super-admin company server-side, so no ql_hq_company_id needed.
    if (action === 'disable_ai') {
      const leads = Array.isArray(body.leads) ? body.leads : []
      if (!leads.length) return json({ ok: true, note: 'no leads to disable' })

      const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': QL_MC_API_SECRET },
        body: JSON.stringify({ action: 'disable_ai', leads }),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`ql-hq returned ${res.status}: ${text}`)
      }

      return json(await res.json().catch(() => ({ ok: true })))
    }

    // ── default action: sync delivery config + postcodes ─────────────────────
    const { ql_hq_company_id, email, sms_number, webhook_url, postcodes } = body

    if (!ql_hq_company_id || typeof ql_hq_company_id !== 'string' || !ql_hq_company_id.trim()) {
      return json({ error: 'ql_hq_company_id is required' }, 400)
    }

    const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': QL_MC_API_SECRET },
      body: JSON.stringify({
        ql_hq_company_id: ql_hq_company_id.trim(),
        email:       email       ?? null,
        sms_number:  sms_number  ?? null,
        webhook_url: webhook_url ?? null,
        postcodes:   Array.isArray(postcodes) ? postcodes : [],
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`ql-hq returned ${res.status}: ${text}`)
    }

    return json({ ok: true })
  } catch (err) {
    console.error('sync-to-hq error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
