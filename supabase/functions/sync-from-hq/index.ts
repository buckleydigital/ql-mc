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
//   upsert_managed_purchase — a Branded Lead Gen System bought online: the
//                       lead goes to Closed Won, a managed client is created
//                       in Onboarding and the build fee is logged.
//   upsert_fulfilment — ql-hq owns fulfilment (its Team Panel is where the work
//                       happens) and pushes the derived summary here whenever a
//                       step moves, so ql-mc can report on what is stuck without
//                       holding the audit trail. Authority over each column is
//                       split explicitly at the handler. It also carries the
//                       ads-live date, which is day 1 of management here too.
//   billing_schedule  — every linked managed client's next payment date and the
//                       draft invoice for it, for ql-hq's daily VA reminder.
//   client_billing    — one client's payment dates, invoices and the business
//                       settings the invoice PDF is drawn from, for the Team
//                       Panel. ql-mc stays the only place invoices are made and
//                       numbered; the Team Panel shows and sends these same ones.
//   send_client_invoice — the Team Panel's Send: emails the PDF it drew (the
//                       same layout as the Invoices screen) and stamps the
//                       invoice sent here, so both panels show it sent.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { mcLeadIdFor } from '../_shared/hq-lead-link.ts'
import '../_shared/no-em-dash.ts'

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
        solar: 'solar', solar_battery: 'solar', solar_and_battery: 'solar',
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
      // The business's today, not UTC's.
      //
      // toISOString() is UTC, and Sydney runs 10-11 hours ahead, so from 10am
      // AEST the UTC date is still yesterday and a card shows a follow-up date
      // a day behind.
      //
      // This was deployed once, reverted on a false alarm, and is now back: the
      // enquiry that looked lost had in fact been folded into an existing card
      // by the duplicate guard below, and the row it wrote carried the Sydney
      // date - proving this code was working at the moment it was blamed. The
      // same Intl call is used in jarvis-notify's localHHMM.
      //
      // en-CA formats as YYYY-MM-DD, which is what a date column wants.
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Australia/Sydney',
      }).format(new Date())

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
      let existingNotes: string | null = null
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      for (const [col, val] of [['email', email], ['phone', phone]] as const) {
        if (!val || existingId) continue
        const { data } = await supabase
          .from('leads').select('id, notes')
          .eq(col, val)
          .not('stage', 'in', '(closed_won,closed_lost)')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(1)
        existingId = data?.[0]?.id ?? null
        existingNotes = (data?.[0]?.notes as string | null) ?? null
      }

      if (existingId) {
        // Say so on the card.
        //
        // Folding a repeat enquiry into the existing lead is right - nobody
        // wants the same person twice on the board - but it used to happen
        // silently, so someone who filled the form again left no trace at all.
        // That is indistinguishable from a broken form, and was read as exactly
        // that: an enquiry "vanished", a deploy got blamed, and a working
        // change was reverted over it.
        //
        // It is also information a rep wants. Someone enquiring a second time
        // is warmer than the card's history suggests.
        //
        // Skipped when the same line is already there, so a double-tap on the
        // button does not write the note twice.
        const again = `Enquired again ${today} via ${source}.`
        const notesPatch = (existingNotes ?? '').includes(again)
          ? {}
          : { notes: [existingNotes, again].filter(Boolean).join('\n') }

        // Deliberately does NOT touch contactable. A repeat enquiry used to
        // force it back to "Contactable", which silently overwrote a rep who
        // had marked them uncontactable - the one value on this row that is a
        // human's explicit judgement. The follow-up date is bumped because a
        // fresh enquiry genuinely is a reason to look again.
        await supabase.from('leads').update({
          next_followup: today,
          ...notesPatch,
          updated_at: new Date().toISOString(),
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
      const { ql_hq_company_id, hq_lead_id, phone, name } = body as {
        ql_hq_company_id?: string; hq_lead_id?: string | null; phone?: string | null; name?: string | null
      }
      if (!ql_hq_company_id || (!hq_lead_id && (!phone || !name))) {
        return json({ error: 'ql_hq_company_id and hq_lead_id (or phone and name) are required' }, 400)
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

      // 2) find the exact lead. By the ql-hq lead id first: the delivery log
      //    links it to the ql-mc lead it came from. Else same client + exact
      //    phone (E.164-normalised on both sides) + exact name (trimmed,
      //    case-insensitive). Most recent non-scrubbed match wins;
      //    already-scrubbed leads are skipped so the idempotent guard in the
      //    RPC is never even needed for re-sends.
      let match: { id: string; name?: string | null; phone?: string | null } | undefined
      const linkedId = hq_lead_id ? await mcLeadIdFor(supabase, hq_lead_id) : null
      if (linkedId) {
        const { data: linked } = await supabase
          .from('ppl_leads')
          .select('id, name, phone, status')
          .eq('id', linkedId)
          .eq('assigned_client_id', client.id)
          .neq('status', 'scrubbed')
          .maybeSingle()
        match = linked ?? undefined
      }
      if (!match && phone && name) {
        const normPhone = normalisePhone(phone)
        const wantName  = name.trim().toLowerCase()
        const { data: candidates } = await supabase
          .from('ppl_leads')
          .select('id, name, phone, status')
          .eq('assigned_client_id', client.id)
          .neq('status', 'scrubbed')
          .order('created_at', { ascending: false })
          .limit(200)
        match = (candidates || []).find((l) =>
          normalisePhone((l.phone as string) || '') === normPhone &&
          ((l.name as string) || '').trim().toLowerCase() === wantName,
        )
      }
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
                hq_lead_id: hq_lead_id ?? null,
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
    // ── action: billing_schedule ─────────────────────────────────────────────
    if (action === 'billing_schedule') {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: clients, error } = await supabase.from('clients')
        .select('id, ql_hq_company_id, company_name, next_payment_date, management_fee')
        .eq('type', 'managed').eq('stage', 'active').not('ql_hq_company_id', 'is', null)
      if (error) return json({ error: error.message }, 500)
      const ids = (clients ?? []).map((c) => c.id)
      const { data: invs } = ids.length
        ? await supabase.from('invoices').select('id, client_id, invoice_number, status, due_date, total, sent_at')
            .in('client_id', ids).order('created_at', { ascending: false })
        : { data: [] }
      return json({
        clients: (clients ?? []).map((c) => {
          const inv = (invs ?? []).find((i) => i.client_id === c.id && i.due_date === c.next_payment_date) ?? null
          return { hq_company_id: c.ql_hq_company_id, company_name: c.company_name, next_payment_date: c.next_payment_date,
                   management_fee: c.management_fee, invoice: inv }
        }),
      })
    }

    // ── action: client_billing ───────────────────────────────────────────────
    if (action === 'client_billing') {
      const hqId = String(body.hq_company_id ?? '')
      if (!hqId) return json({ error: 'hq_company_id is required' }, 400)
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: client } = await supabase.from('clients')
        .select('id, company_name, contact_name, email, phone, management_fee, start_date, ads_first_live_date, last_payment_date, next_payment_date, stage')
        .eq('ql_hq_company_id', hqId).maybeSingle()
      if (!client) return json({ client: null, invoices: [], biz: null })
      const [{ data: invoices }, { data: biz }] = await Promise.all([
        supabase.from('invoices').select('*').eq('client_id', client.id).order('created_at', { ascending: false }).limit(24),
        supabase.from('business_settings').select('business_name, abn, payid, bsb, account_number').limit(1).maybeSingle(),
      ])
      return json({ client, invoices: invoices ?? [], biz: biz ?? {} })
    }

    // ── action: send_client_invoice ──────────────────────────────────────────
    // The same checks and the same sent stamp as send-invoice; the Team Panel
    // has already checked that its caller may see this client.
    if (action === 'send_client_invoice') {
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/
      const hqId = String(body.hq_company_id ?? '')
      const to = String(body.to ?? '').trim().toLowerCase()
      const subject = String(body.subject ?? '').trim()
      const message = String(body.message ?? '').trim()
      const pdf = String(body.pdf_base64 ?? '')
      const replyTo = String(body.reply_to ?? '').trim()
      if (!hqId || !body.invoice_id) return json({ error: 'hq_company_id and invoice_id are required' }, 400)
      if (!EMAIL_RE.test(to)) return json({ error: 'That email address does not look right' }, 400)
      if (!subject || subject.length > 200) return json({ error: 'Add a subject (200 characters at most)' }, 400)
      if (!message || message.length > 5000) return json({ error: 'Add a message (5000 characters at most)' }, 400)
      if (!pdf.startsWith('JVBER') || pdf.length * 0.75 > 5 * 1024 * 1024) return json({ error: 'The invoice PDF is missing or not a PDF' }, 400)

      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: client } = await supabase.from('clients').select('id').eq('ql_hq_company_id', hqId).maybeSingle()
      if (!client) return json({ error: 'No Mission Control client for this company' }, 404)
      const { data: inv } = await supabase.from('invoices').select('id, invoice_number, status, client_id')
        .eq('id', String(body.invoice_id)).maybeSingle()
      if (!inv || inv.client_id !== client.id) return json({ error: 'Invoice not found for this client' }, 404)

      const { data: bset } = await supabase.from('business_settings')
        .select('business_name, sales_from_email, sales_reply_to_email').limit(1).maybeSingle()
      const fromEmail = String(bset?.sales_from_email ?? '').trim() || Deno.env.get('RESEND_FROM_EMAIL')
      const apiKey = Deno.env.get('RESEND_API_KEY')
      if (!fromEmail || !apiKey) return json({ error: 'Email is not configured' }, 500)
      const fromName = String(bset?.business_name ?? '').trim() || 'QuoteLeads'
      const reply = String(bset?.sales_reply_to_email || replyTo || '').trim()
      const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff"><div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a20">${
        message.split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div></body></html>`
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`, to, subject, html, text: message,
          ...(EMAIL_RE.test(reply) ? { reply_to: reply } : {}),
          attachments: [{ filename: `${inv.invoice_number || 'invoice'}.pdf`, content: pdf }],
        }),
      })
      if (!res.ok) {
        console.error('send_client_invoice resend error:', res.status, await res.text().catch(() => ''))
        return json({ error: 'The email provider rejected the message. Nothing was sent.' }, 502)
      }
      const now = new Date().toISOString()
      await supabase.from('invoices').update({
        sent_at: now, sent_to: to, updated_at: now, ...(inv.status === 'paid' ? {} : { status: 'sent' }),
      }).eq('id', inv.id)
      return json({ ok: true, to, sent_at: now })
    }

    if (action === 'upsert_fulfilment') {
      const { hq_company_id, summary, ads_live_date } = body as {
        hq_company_id?: string
        summary?: Record<string, unknown>
        ads_live_date?: string | null
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
        .select('id, stage, active_status, type, start_date, ads_first_live_date, next_payment_date')
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

      // The day the ads went live is day 1 of management, here as in ql-hq: the
      // start date, and the first payment 30 days on. Set once, when the date is
      // first known, so a date someone has corrected by hand is never moved.
      const live = /^\d{4}-\d{2}-\d{2}$/.test(String(ads_live_date ?? '')) ? String(ads_live_date) : null
      if (live && client.type === 'managed' && !client.ads_first_live_date) {
        patch.ads_first_live_date = live
        patch.start_date = live
        if (!client.next_payment_date) {
          const d = new Date(live + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 30)
          patch.next_payment_date = d.toISOString().slice(0, 10)
        }
      }

      const { error: upErr } = await supabase.from('clients').update(patch).eq('id', client.id)
      if (upErr) {
        console.error('upsert_fulfilment: update failed:', upErr.message)
        return json({ error: upErr.message }, 500)
      }
      return json({ ok: true, mirrored: true, client_id: client.id })
    }

    // ── action: upsert_managed_purchase ──────────────────────────────────────
    // A Branded Lead Gen System was bought online: /buy-system on ql-site,
    // paid in Stripe, provisioned by ql-hq's stripe-webhook. It is recorded the
    // way a won deal is recorded by hand (convertLead in index.html): the
    // pipeline lead goes to Closed Won, a managed client is created in
    // Onboarding, and the build fee is logged as a one-off order. Amounts are
    // ex GST, like the rest of the revenue figures.
    //
    // Idempotent: a client already linked to this ql-hq company means the
    // purchase is already recorded, so a repeat call adds nothing.
    if (action === 'upsert_managed_purchase') {
      const b = body as {
        ql_hq_company_id?: string; name?: string; company_name?: string; email?: string; phone?: string
        niche?: string; tier_label?: string; build_fee?: number; management_fee?: number; goal?: string
      }
      const hqId = String(b.ql_hq_company_id ?? '').trim()
      const email = String(b.email ?? '').trim().toLowerCase()
      if (!hqId || !email) return json({ error: 'ql_hq_company_id and email are required' }, 400)

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      const { data: already } = await supabase
        .from('clients').select('id').eq('ql_hq_company_id', hqId).maybeSingle()
      if (already) return json({ ok: true, client_id: already.id, duplicate: true })

      const name     = String(b.name ?? '').trim()
      const company  = String(b.company_name ?? '').trim()
      const phone    = normalisePhone(String(b.phone ?? ''))
      const label    = String(b.tier_label ?? 'Branded Lead Gen System').trim()
      const buildFee = Number(b.build_fee) || 0
      const monthly  = Number(b.management_fee) || 0
      const today    = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date())
      const nowIso   = new Date().toISOString()
      const note     = `Bought the ${label} online on ${today}: $${buildFee.toLocaleString('en-AU')} + GST build, then $${monthly.toLocaleString('en-AU')}/mo + GST optional.` +
        (b.goal ? `\nVolume they want: ${b.goal}.` : '')

      // The pipeline lead: the existing one if we have spoken to them, else a
      // new one, so the sale shows on the board and in the close rate.
      const { data: matches } = await supabase.rpc('find_leads_by_contact', {
        p_email: email, p_phone: phone, p_limit: 1,
      })
      let leadId: string | null = (matches?.[0]?.id as string | undefined) ?? null
      const leadPatch = {
        stage: 'closed_won', lead_type: 'managed', value: buildFee,
        hq_company_id: hqId, hq_account_created_at: nowIso,
        stage_changed_at: nowIso, updated_at: nowIso,
      }
      if (leadId) {
        const { data: cur } = await supabase.from('leads').select('notes').eq('id', leadId).maybeSingle()
        await supabase.from('leads').update({
          ...leadPatch, notes: [cur?.notes, note].filter(Boolean).join('\n'),
        }).eq('id', leadId)
      } else {
        const { data: lead, error: leadErr } = await supabase.from('leads').insert([{
          ...leadPatch, name: name || company || email, company: company || null, email, phone,
          niche: b.niche || null, source: 'website', notes: note,
        }]).select('id').single()
        if (leadErr) console.error('upsert_managed_purchase: lead insert failed:', leadErr.message)
        leadId = lead?.id ?? null
      }

      const { data: client, error: clientErr } = await supabase.from('clients').insert([{
        type: 'managed', company_name: company || name || email, contact_name: name || null,
        email, phone, management_fee: monthly, stage: 'onboarding', onboarding_sub_stage: 'Paid & Signed',
        ql_hq_company_id: hqId, created_at: nowIso,
      }]).select('id').single()
      if (clientErr || !client) {
        console.error('upsert_managed_purchase: client insert failed:', clientErr?.message)
        return json({ error: clientErr?.message || 'client insert failed', lead_id: leadId }, 500)
      }

      const { error: ordErr } = await supabase.from('managed_order_log').insert([{
        client_id: client.id, description: `Build fee - ${label} (paid online)`,
        amount: buildFee, order_date: today, created_at: nowIso,
      }])
      if (ordErr) console.error('upsert_managed_purchase: build fee not logged:', ordErr.message)

      const { error: taskErr } = await supabase.from('tasks').insert([{
        title: `New system purchase - ${company || name || email} · ${label}`,
        priority: 'urgent', done: false,
        notes: `${note}\nPaid by card on the website. Their QuoteLeadsHQ account is created and the welcome email sent; next is the intro call and onboarding (Team Panel). Email: ${email}`,
        created_at: nowIso,
      }])
      if (taskErr) console.warn('upsert_managed_purchase: task not created:', taskErr.message)

      return json({ ok: true, client_id: client.id, lead_id: leadId, duplicate: false })
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
    // ql-hq sends the company's open area postcodes when every active order
    // is split into areas (one area, one order, its own postcodes). Those are
    // what leads are routed by; ppl-area-refresh keeps them current as areas
    // fill. Without them the old behaviour stands.
    const areaPostcodes: string[] | null = Array.isArray(body.postcodes)
      ? body.postcodes.map((p: unknown) => String(p).trim()).filter((p: string) => /^\d{4}$/.test(p))
      : null

    if (!ql_hq_company_id || !email) {
      return json({ error: 'ql_hq_company_id and email are required' }, 400)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const normPhone   = normalisePhone(phone || '')
    const postcodes: string[] = areaPostcodes ?? (location_type === 'postcodes' && postcode_list
      ? String(postcode_list).split(/[\s,\n]+/).map((p: string) => p.trim()).filter(Boolean)
      : [])

    const qty         = parseInt(String(quantity))    || 0
    const pplPrice    = parseFloat(String(price_per_lead)) || 0
    const nicheLabel  = [niche, sub_niche].filter(Boolean).join(' › ')

    // submit-lead routes on clients.active_niches against the lead_type the
    // forms send. The solar forms send ql-hq's own slugs (solar_and_battery,
    // battery_retrofit), so those are used as they are; solar_battery is the
    // old name for solar_and_battery. The HVAC forms send 'aircon', not
    // ql-hq's 'hvac', so an HVAC client gets 'aircon' as well.
    const ROUTING_NICHE: Record<string, string> = {
      solar_battery: 'solar_and_battery',
      hvac: 'aircon',
    }
    const nicheSlug    = String(niche || '').toLowerCase().trim().replace(/-/g, '_')
    const routingNiches = [...new Set([ROUTING_NICHE[nicheSlug], nicheSlug].filter(Boolean))]

    // Prefer lookup by ql_hq_company_id; fall back to email match on PPL clients
    let { data: existing } = await supabase
      .from('clients')
      .select('id, total_leads_purchased, has_reordered, active_niches')
      .eq('ql_hq_company_id', ql_hq_company_id)
      .maybeSingle()

    if (!existing) {
      const { data: byEmail } = await supabase
        .from('clients')
        .select('id, total_leads_purchased, has_reordered, active_niches')
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
      // A re-order can be for another niche; add it so its leads route too.
      // Niches already on the client (set by hand or earlier) are kept.
      const activeNiches = [...new Set([...((existing.active_niches as string[] | null) || []), ...routingNiches])]

      await supabase.from('clients').update({
        ql_hq_company_id,
        stage:                 'active_client',
        total_leads_purchased: newTotal,
        has_reordered:         (priorOrders || 0) >= 1,
        active_niches:         activeNiches,
        updated_at:            new Date().toISOString(),
        ...((areaPostcodes || postcodes.length > 0) && { postcodes }),
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
          active_niches:         routingNiches,
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

      // Auto-task so the team knows to configure campaigns. Non-fatal. A
      // supabase query has no .catch(), so chaining one threw a TypeError
      // here, which failed the whole call before the order was logged.
      const { error: taskErr } = await supabase.from('tasks').insert([{
        title:      `New PPL signup — ${company_name || email} · ${qty} × ${nicheLabel} leads`,
        priority:   'urgent',
        done:       false,
        notes:      areaPostcodes
          ? `Auto-created from ql-hq checkout. Postcodes are set from the order's areas. Link campaigns in the PPL Clients panel. Email: ${email}`
          : `Auto-created from ql-hq checkout. Configure postcodes and link campaigns in the PPL Clients panel. Email: ${email}`,
        created_at: new Date().toISOString(),
      }])
      if (taskErr) console.warn('task insert non-fatal:', taskErr.message)
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
