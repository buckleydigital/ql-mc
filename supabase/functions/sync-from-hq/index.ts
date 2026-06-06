// sync-from-hq — accepts inbound calls from ql-hq authenticated via x-api-secret.
// Called by ql-hq's stripe-webhook after a PPL checkout completes to create or
// update the matching client record in ql-mc so they appear as active_client
// automatically — no manual entry required.
//
// Actions:
//   upsert_ppl_client — create (new signup) or update (reorder) a PPL client
//                       and append a ppl_order_log row for the new order.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalisePhone(raw: string): string | null {
  let p = (raw || '').replace(/[\s\-().]/g, '')
  if (p.startsWith('04')) p = '+61' + p.slice(1)
  else if (p.startsWith('614')) p = '+' + p
  else if (p.startsWith('61') && !p.startsWith('+')) p = '+' + p
  if (/^\+614[0-9]{8}$/.test(p)) return p
  return p || null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const apiSecret = Deno.env.get('QL_MC_API_SECRET')
  const provided  = req.headers.get('x-api-secret')
  if (!apiSecret || !provided || provided !== apiSecret) {
    return json({ error: 'unauthorized' }, 401)
  }

  try {
    const body = await req.json()
    const { action } = body

    if (action !== 'upsert_ppl_client') {
      return json({ error: `unknown action: ${action}` }, 400)
    }

    const {
      ql_hq_company_id,
      company_name,
      contact_name,
      email,
      phone,
      niche,
      sub_niche,
      area_city,
      quantity,
      price_per_lead,
      location_type,
      radius_km,
      postcode_list,
      ql_hq_order_id,
    } = body

    if (!ql_hq_company_id || !email) {
      return json({ error: 'ql_hq_company_id and email are required' }, 400)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const normPhone   = normalisePhone(phone || '')
    const postcodes: string[] = location_type === 'postcodes' && postcode_list
      ? String(postcode_list).split(/[\s,\n]+/).map((p: string) => p.trim()).filter(Boolean)
      : []

    const qty         = parseInt(String(quantity))    || 0
    const pplPrice    = parseFloat(String(price_per_lead)) || 0
    const nicheLabel  = [niche, sub_niche].filter(Boolean).join(' › ')

    // Prefer lookup by ql_hq_company_id; fall back to email match on PPL clients
    let { data: existing } = await supabase
      .from('clients')
      .select('id, total_leads_purchased, has_reordered')
      .eq('ql_hq_company_id', ql_hq_company_id)
      .maybeSingle()

    if (!existing) {
      const { data: byEmail } = await supabase
        .from('clients')
        .select('id, total_leads_purchased, has_reordered')
        .eq('email', email)
        .eq('type', 'ppl')
        .maybeSingle()
      existing = byEmail
    }

    const today  = new Date().toISOString().split('T')[0]
    const slaDue = new Date()
    slaDue.setDate(slaDue.getDate() + 14)

    let clientId: string
    let resultAction: string

    if (existing) {
      // ── Update existing client ────────────────────────────────────────────
      clientId     = existing.id
      resultAction = 'updated'

      const { count: priorOrders } = await supabase
        .from('ppl_order_log')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId)

      const newTotal = (existing.total_leads_purchased || 0) + qty

      await supabase.from('clients').update({
        ql_hq_company_id,
        stage:                 'active_client',
        total_leads_purchased: newTotal,
        has_reordered:         (priorOrders || 0) >= 1,
        updated_at:            new Date().toISOString(),
        ...(postcodes.length > 0 && { postcodes }),
      }).eq('id', clientId)

    } else {
      // ── Create new client ─────────────────────────────────────────────────
      const { data: newClient, error: insertErr } = await supabase
        .from('clients')
        .insert([{
          type:                  'ppl',
          company_name:          company_name || email,
          contact_name:          contact_name || null,
          email,
          phone:                 normPhone,
          stage:                 'active_client',
          niche:                 nicheLabel,
          active_niches:         [niche].filter(Boolean),
          lead_price:            pplPrice,
          total_leads_purchased: qty,
          leads_delivered:       0,
          delivery_method:       'email',
          delivery_email:        email,
          delivery_phone:        normPhone,
          postcodes,
          postcodes_radius:      parseInt(String(radius_km)) || 50,
          has_reordered:         false,
          ql_hq_company_id,
          created_at:            new Date().toISOString(),
        }])
        .select('id')
        .single()

      if (insertErr || !newClient) {
        console.error('Client insert error:', insertErr?.message)
        return json({ error: insertErr?.message || 'insert failed' }, 500)
      }

      clientId     = newClient.id
      resultAction = 'created'

      // Auto-task so the team knows to configure campaigns
      await supabase.from('tasks').insert([{
        title:      `New PPL signup — ${company_name || email} · ${qty} × ${nicheLabel} leads`,
        priority:   'urgent',
        done:       false,
        notes:      `Auto-created from ql-hq checkout. Configure postcodes and link campaigns in the PPL Clients panel. Email: ${email}`,
        created_at: new Date().toISOString(),
      }]).catch((e: Error) => console.warn('task insert non-fatal:', e.message))
    }

    // ── Append order to ppl_order_log ─────────────────────────────────────
    const { error: orderErr } = await supabase.from('ppl_order_log').insert([{
      client_id:    clientId,
      leads_qty:    qty,
      lead_price:   pplPrice,
      notes:        `${nicheLabel} — ${area_city} | HQ Order ${ql_hq_order_id}`,
      order_date:   today,
      status:       'in_progress',
      sla_due_date: slaDue.toISOString().split('T')[0],
      created_at:   new Date().toISOString(),
    }])
    if (orderErr) console.error('ppl_order_log insert error (non-fatal):', orderErr.message)

    return json({ ok: true, client_id: clientId, action: resultAction })

  } catch (err) {
    console.error('sync-from-hq error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
