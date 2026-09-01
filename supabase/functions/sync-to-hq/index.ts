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

    // ── action: create_hq_account ─────────────────────────────────────────────
    // A won lead becomes a ql-hq client. The lead is read here rather than
    // taken from the request, so the account is created from what is actually
    // on the record, and hq_company_id is written back so the lead knows it has
    // one and the button cannot be pressed into creating a second.
    if (action === 'create_hq_account') {
      const { lead_id } = body as { lead_id?: string }
      if (!lead_id) return json({ error: 'lead_id is required' }, 400)

      const { data: lead } = await supabase
        .from('leads')
        .select('id, name, company, email, phone, niche, stage, hq_company_id')
        .eq('id', lead_id)
        .maybeSingle()
      if (!lead) return json({ error: 'Lead not found' }, 404)
      if (!lead.email) return json({ error: 'This lead has no email address' }, 400)
      if (lead.stage !== 'closed_won') return json({ error: 'Only a Closed Won lead can be converted' }, 400)
      if (lead.hq_company_id) return json({ error: 'This lead already has a QuoteLeadsHQ account', company_id: lead.hq_company_id }, 409)

      const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': QL_MC_API_SECRET },
        body: JSON.stringify({
          action: 'create_client_account',
          email: lead.email,
          name: lead.name,
          company_name: lead.company,
          phone: lead.phone,
          niche: lead.niche,
          plan: 'managed',
        }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) return json({ error: out.error || 'ql-hq rejected the account' }, 502)

      if (out.company_id) {
        await supabase.from('leads')
          .update({ hq_company_id: out.company_id, hq_account_created_at: new Date().toISOString() })
          .eq('id', lead_id)
      }
      return json({ ok: true, ...out })
    }

    // ── action: list_vas ──────────────────────────────────────────────────────
    if (action === 'list_vas') {
      const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': QL_MC_API_SECRET },
        body: JSON.stringify({ action: 'list_vas' }),
      })
      const out = await res.json().catch(() => ({}))
      return json(out, res.ok ? 200 : 502)
    }

    // ── action: assign_va ─────────────────────────────────────────────────────
    if (action === 'assign_va') {
      const { lead_id, va_user_id } = body as { lead_id?: string; va_user_id?: string }
      if (!lead_id || !va_user_id) return json({ error: 'lead_id and va_user_id are required' }, 400)
      const { data: lead } = await supabase
        .from('leads').select('hq_company_id').eq('id', lead_id).maybeSingle()
      if (!lead?.hq_company_id) return json({ error: 'Create the QuoteLeadsHQ account first' }, 400)

      const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': QL_MC_API_SECRET },
        body: JSON.stringify({ action: 'assign_va', va_user_id, company_id: lead.hq_company_id }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) return json({ error: out.error || 'ql-hq rejected the assignment' }, 502)
      await supabase.from('leads')
        .update({ hq_va_user_id: va_user_id, hq_va_assigned_at: new Date().toISOString() })
        .eq('id', lead_id)
      return json({ ok: true, ...out })
    }

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
