// sync-from-hq — accepts inbound calls from ql-hq authenticated via x-api-secret.
// Called by ql-hq's stripe-webhook after a PPL checkout completes to create or
// update the matching client record in ql-mc so they appear as active_client
// automatically — no manual entry required.
//
// Actions:
//   upsert_ppl_client — create (new signup) or update (reorder) a PPL client
//                       and append a ppl_order_log row for the new order.
//   scrub_lead        — a client's dispute was APPROVED in ql-hq. Find the
//                       exact ppl_lead (phone + name + client via
//                       ql_hq_company_id, all exact) and scrub it here.
//                       ql-mc is the single source of truth for credits:
//                       mark_lead_scrubbed() moves the counters (idempotent),
//                       then we propagate the decrement + scrubbed flag back
//                       to ql-hq via its sync-from-mc. ql-hq never decrements
//                       itself on dispute approval, so nothing double-counts.

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

    // ── action: scrub_lead (dispute approved in ql-hq) ───────────────────────
    if (action === 'scrub_lead') {
      const { ql_hq_company_id, phone, name } = body as {
        ql_hq_company_id?: string; phone?: string; name?: string
      }
      if (!ql_hq_company_id || !phone || !name) {
        return json({ error: 'ql_hq_company_id, phone and name are required' }, 400)
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      // 1) resolve the client by ql_hq_company_id (exact company match)
      const { data: client } = await supabase
        .from('clients')
        .select('id, ql_hq_company_id')
        .eq('ql_hq_company_id', ql_hq_company_id)
        .maybeSingle()
      if (!client) return json({ ok: false, note: 'no client with that ql_hq_company_id' }, 404)

      // 2) find the exact lead: same client + exact phone (E.164-normalised on
      //    both sides) + exact name (trimmed, case-insensitive). Most recent
      //    non-scrubbed match wins; already-scrubbed leads are skipped so the
      //    idempotent guard in the RPC is never even needed for re-sends.
      const normPhone = normalisePhone(phone)
      const wantName  = name.trim().toLowerCase()
      const { data: candidates } = await supabase
        .from('ppl_leads')
        .select('id, name, phone, status')
        .eq('assigned_client_id', client.id)
        .neq('status', 'scrubbed')
        .order('created_at', { ascending: false })
        .limit(200)
      const match = (candidates || []).find((l) =>
        normalisePhone((l.phone as string) || '') === normPhone &&
        ((l.name as string) || '').trim().toLowerCase() === wantName,
      )
      if (!match) return json({ ok: false, note: 'no matching non-scrubbed lead (phone+name+client)' }, 404)

      // 3) scrub it — the RPC owns ALL counter movement and is idempotent
      const { data: acted, error: scrubErr } = await supabase
        .rpc('mark_lead_scrubbed', { p_lead_id: match.id })
      if (scrubErr) return json({ ok: false, error: scrubErr.message }, 500)

      // 4) propagate the credit to ql-hq (order decrement + flag the hq lead)
      //    only when this call actually scrubbed it — never on a repeat.
      let hqSynced = false
      if (acted === true) {
        const QL_HQ_API_URL = Deno.env.get('QL_HQ_API_URL')
        if (QL_HQ_API_URL) {
          try {
            const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-secret': apiSecret },
              body: JSON.stringify({
                action: 'scrub',
                ql_hq_company_id,
                lead: { name: match.name ?? null, phone: match.phone ?? null },
              }),
            })
            hqSynced = res.ok
            if (!res.ok) console.error('scrub_lead: hq propagation failed:', res.status, await res.text())
          } catch (e) {
            console.error('scrub_lead: hq propagation error:', e instanceof Error ? e.message : e)
          }
        }
      }

      return json({ ok: true, lead_id: match.id, scrubbed_now: acted === true, hq_synced: hqSynced })
    }

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
