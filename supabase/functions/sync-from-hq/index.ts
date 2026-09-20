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
//   check_lead_exists — the growth-onboarding spam gate. Is this email or phone
//                       already in our sales pipeline (any stage)? Only ql-mc can
//                       answer; ql-hq holds the signup for review if not.
//   upsert_fulfilment — ql-hq owns fulfilment (its Team Panel is where the work
//                       happens) and pushes the derived summary here whenever a
//                       step moves, so ql-mc can report on what is stuck without
//                       holding the audit trail. Authority over each column is
//                       split explicitly at the handler.

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

    // ── action: create_pipeline_lead (callback request on the public site) ───
    // ql-hq's callback-request forwards the funnel enquiry here so it lands on
    // the Sales Pipeline board immediately, instead of only emailing contact@.
    // ql-hq still sends that email; this is the pipeline half only.
    if (action === 'create_pipeline_lead') {
      const name     = String(body.name ?? '').trim()
      const company  = String(body.company ?? '').trim()
      const email    = String(body.email ?? '').trim().toLowerCase()
      const phoneRaw = String(body.phone ?? '').trim()
      const postcode = String(body.postcode ?? '').trim()
      const source   = String(body.source ?? 'quoteleads.com.au').trim()
      const campaign = String(body.campaign ?? '').trim()
      // What volume they said they want. A qualifying answer, so it belongs on
      // the card rather than only in the notification email.
      const goal     = String(body.goal ?? '').trim()
      const phone    = normalisePhone(phoneRaw)

      if (!name || (!email && !phone)) {
        return json({ error: 'name and an email or phone are required' }, 400)
      }

      // The funnels send two different vocabularies: the solar funnel sends
      // platform slugs, /get-started sends the trade label the visitor picked.
      // Both are mapped here.
      //
      // The fallback used to be 'solar', which quietly filed every HVAC, roofing
      // and renovation enquiry as a solar lead - a reporting error that looks
      // like data. An unrecognised trade now keeps whatever the visitor chose;
      // leads.niche is free text and clients already carry labels like 'HVAC',
      // so an honest unknown beats a confident wrong one.
      const NICHE: Record<string, string> = {
        // slugs (solar funnel)
        solar: 'solar', solar_battery: 'solar',
        battery_retrofit: 'battery_retrofit', commercial_solar: 'solar',
        // slugs the /get-started page maps its trade choices onto
        hvac: 'HVAC', roofing: 'Roofing', renovation: 'Renovation',
        // and the raw labels, in case a page ever sends those instead
        'All Solar': 'solar',
        'Solar + Battery': 'solar',
        'Battery Retrofit': 'battery_retrofit',
        'HVAC': 'HVAC',
        'Roofing': 'Roofing',
        'Renovation': 'Renovation',
      }
      const niche = NICHE[campaign] ?? (campaign || 'solar')
      // This is the UTC date, which in Sydney is yesterday from 10am AEST, so
      // a card can show a follow-up date a day behind.
      //
      // A fix using Intl.DateTimeFormat with timeZone 'Australia/Sydney' was
      // deployed as v13 and then reverted - WRONGLY. Web enquiries appeared to
      // stop reaching the pipeline and the deploy was blamed; in fact the one
      // submission in that window matched an existing lead on email and phone
      // and was folded into it by the duplicate guard below, which is what it
      // is supposed to do. The give-away is that the update it wrote set
      // next_followup to the Sydney date, not the UTC one - so v13 was working
      // correctly at the moment it was judged broken.
      //
      // The Intl approach is sound and is used already in jarvis-notify
      // (localHHMM). Reapplying it is safe. Nothing alerts on this date any
      // more - followup_overdue requires last_contact - so the cost of leaving
      // it as UTC is cosmetic.
      const today = new Date().toISOString().split('T')[0]

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      const notes = [
        `Callback requested via ${source}.`,
        campaign ? `Trade / campaign: ${campaign}.` : null,
        goal ? `Volume they want: ${goal}.` : null,
        postcode ? `Service area: ${postcode}.` : null,
        '$2,500 one-off build + first 30 days management, then $600/mo optional.',
      ].filter(Boolean).join('\n')

      // A double-tap on the button, or a second try minutes later, should land
      // on the existing card rather than give a rep the same lead twice.
      let existingId: string | null = null
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      for (const [col, val] of [['email', email], ['phone', phone]] as const) {
        if (!val || existingId) continue
        const { data } = await supabase
          .from('leads').select('id')
          .eq(col, val)
          .not('stage', 'in', '(closed_won,closed_lost)')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(1)
        existingId = data?.[0]?.id ?? null
      }

      if (existingId) {
        // Deliberately does NOT touch contactable. A repeat enquiry used to
        // force it back to "Contactable", which silently overwrote a rep who
        // had marked them uncontactable - the one value on this row that is a
        // human's explicit judgement. The follow-up date is bumped because a
        // fresh enquiry genuinely is a reason to look again.
        await supabase.from('leads').update({
          next_followup: today, updated_at: new Date().toISOString(),
        }).eq('id', existingId)
        return json({ ok: true, lead_id: existingId, duplicate: true })
      }

      const { data, error } = await supabase.from('leads').insert([{
        name,
        company:       company || null,
        email:         email || null,
        phone,
        stage:         'new_lead',
        lead_type:     'managed',
        niche,
        // No build fee. This used to seed 600 back when the field was "Deal
        // Value (AUD/mo)" and 600 was the standard monthly management fee - a
        // sensible default for a recurring figure. The field is now the Build
        // Fee, a ONE-OFF charge that gets logged as a real order line the
        // moment the lead converts, so seeding it would invent a $600 charge
        // nobody quoted on every site enquiry.
        //
        // Left null on purpose: the build fee is whatever is actually agreed on
        // the call, and an empty field asks for it. The pricing note below
        // still tells the rep what the list price is.
        source:        'inbound',
        notes,
        // Contact status is left unset, which the board reads as "Not set".
        //
        // It used to arrive as "Contactable", which is a claim nobody had
        // checked: filling in a web form says someone is interested, not that
        // the number works or that they are happy to be rung. Starting at
        // "Not set" makes it a judgement a person makes once they have tried,
        // which is what the three states are for.
        next_followup: today,
      }]).select('id').single()
      if (error) return json({ error: error.message }, 500)

      return json({ ok: true, lead_id: data.id, duplicate: false })
    }

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

    // ── action: check_lead_exists ────────────────────────────────────────────
    // The spam gate for growth-onboarding. ql-hq asks: is this person already in
    // our sales pipeline? Only ql-mc can answer, because the pipeline lives here.
    //
    // A match means we have actually spoken to them, which is the whole signal.
    // A signup from an email and phone that appear nowhere in the pipeline is
    // either spam or someone who found the form without ever talking to us, and
    // both of those want a human to look before an account exists.
    //
    // ANY stage counts, closed_lost included. The question is "do we know this
    // person", not "are they still open". Deliberately no stage filter.
    if (action === 'check_lead_exists') {
      const email = String((body as { email?: string }).email ?? '').trim().toLowerCase()
      const phoneRaw = String((body as { phone?: string }).phone ?? '').trim()
      const phone = phoneRaw ? normalisePhone(phoneRaw) : null

      if (!email && !phone) {
        return json({ error: 'email or phone is required' }, 400)
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      // The digit comparison happens in SQL (find_leads_by_contact), not here.
      // Doing it in this function meant fetching leads and comparing in memory,
      // which silently stops matching past whatever row cap the fetch used - so
      // the gate would start holding genuine clients as the pipeline grew. The
      // function is service_role only and SECURITY DEFINER, because it has to
      // read past the restrictive no_sales_rep policy on `leads`.
      const { data: matchRows, error: rpcErr } = await supabase.rpc('find_leads_by_contact', {
        p_email: email || null,
        p_phone: phone || null,
        p_limit: 5,
      })

      if (rpcErr) {
        // Say so rather than answering "no match": a failed lookup must not be
        // mistaken for a clean miss, or a database blip would start holding
        // every genuine signup (or worse, be read as a pass).
        console.error('check_lead_exists: lookup failed:', rpcErr.message)
        return json({ error: `lookup failed: ${rpcErr.message}` }, 500)
      }

      const matches = matchRows || []

      return json({
        ok: true,
        matched: matches.length > 0,
        match_count: matches.length,
        // Capped: the gate only needs to know it matched and roughly where. The
        // full pipeline is not ql-hq's to hold.
        matches: matches.slice(0, 5),
        checked_email: email || null,
        checked_phone: phone,
      })
    }

    // ── action: upsert_fulfilment ────────────────────────────────────────────
    // ql-hq owns fulfilment and pushes the DERIVED SUMMARY here whenever a step
    // moves. Never the audit trail: that stays in one place, written by the
    // service that performs the actions.
    //
    // Authority is split deliberately, and this is the only place it is
    // decided:
    //   • onboarding_sub_stage - ql-hq's. It is computed from the actual steps,
    //     so it is overwritten on every push.
    //   • active_status        - ql-mc's. "Ads Paused (Billing Issue)",
    //     "Ads Scaling", "Churned" are management decisions ql-hq knows nothing
    //     about, so a value already set here is never clobbered; ql-hq can only
    //     fill it when it is empty.
    //   • stage                - advanced onboarding → active when ads go live,
    //     because that is what going live means, but never moved backwards and
    //     never touched for a client already past onboarding.
    if (action === 'upsert_fulfilment') {
      const { hq_company_id, summary } = body as {
        hq_company_id?: string
        summary?: Record<string, unknown>
      }
      if (!hq_company_id || !summary) {
        return json({ error: 'hq_company_id and summary are required' }, 400)
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      const { data: client } = await supabase
        .from('clients')
        .select('id, stage, active_status')
        .eq('ql_hq_company_id', hq_company_id)
        .maybeSingle()

      // Not every ql-hq company has a ql-mc client row - a self-serve PPL signup
      // that was never taken on as a managed client, for instance. That is not an
      // error and must not make ql-hq retry: there is simply nothing to mirror.
      if (!client) {
        return json({ ok: true, mirrored: false, reason: 'no matching ql-mc client' })
      }

      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const patch: Record<string, unknown> = {
        fulfilment_steps_done:    num(summary.steps_done),
        fulfilment_steps_settled: num(summary.steps_settled),
        fulfilment_steps_total:   num(summary.steps_total),
        fulfilment_blocked_count: num(summary.blocked_count) ?? 0,
        fulfilment_stage_at:      summary.stage_at ?? null,
        fulfilment_next_step:     summary.next_step_key ?? null,
        fulfilment_next_due:      summary.next_step_due ?? null,
        fulfilment_synced_at:     new Date().toISOString(),
        updated_at:               new Date().toISOString(),
      }

      // The kanban already renders this column, and ql-hq maps its steps onto
      // the exact same strings, so the existing board gains real history without
      // being touched.
      if (summary.stage) patch.onboarding_sub_stage = summary.stage

      const hqActive = summary.active_status as string | null | undefined
      // ql-hq says "Ads Live" because the ads_live STEP is done, which is a
      // historical fact. Writing that onto a churned or paused client would
      // claim they are running right now, which is false - and it is exactly
      // the kind of wrong that reads as data rather than as a bug. So ql-hq may
      // only fill this when the client is actually live-ish and the field is
      // empty; anything else stays ql-mc's.
      const liveish = client.stage !== 'churned' && client.stage !== 'paused'
      if (hqActive && !client.active_status && liveish) patch.active_status = hqActive
      if (hqActive === 'Ads Live' && client.stage === 'onboarding') patch.stage = 'active'

      const { error: upErr } = await supabase.from('clients').update(patch).eq('id', client.id)
      if (upErr) {
        console.error('upsert_fulfilment: update failed:', upErr.message)
        return json({ error: upErr.message }, 500)
      }
      return json({ ok: true, mirrored: true, client_id: client.id })
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
