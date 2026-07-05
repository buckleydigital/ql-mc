// sync-sales-conversation — accepts inbound calls from ql-hq authenticated via
// x-api-secret. Mirrors the agency's own AI SMS conversations (the super-admin
// company in ql-hq) into ql-mc's Sales Conversations so the whole team — and
// their assigned reps — can see them alongside the sales pipeline.
//
// Action:
//   mirror_conversation — find-or-create a sales-pipeline lead by phone, then
//                         append the inbound message (and the AI reply, if any)
//                         to sales_sms_log. Idempotent on the inbound Twilio SID.

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

// Match the normalisation used across ql-mc (submit-lead) so a lead created here
// is matched again on the next message. Produces E.164 (+61…) for AU numbers.
function normalisePhone(raw: string): string | null {
  let p = (raw || '').replace(/[\s\-().]/g, '')
  if (p.startsWith('0') && p.length === 10) p = '+61' + p.slice(1)
  else if (p.startsWith('614') && p.length === 11) p = '+' + p
  else if (p.startsWith('61') && !p.startsWith('+') && p.length === 11) p = '+' + p
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

    if (action !== 'mirror_conversation') {
      return json({ error: `unknown action: ${action}` }, 400)
    }

    const {
      lead_name,
      company,
      phone,
      twilio_number,
      inbound_message,
      inbound_sid,
      outbound_message,
      source,
    } = body as Record<string, string | null | undefined>

    const normPhone = normalisePhone(phone || '')
    if (!normPhone) return json({ error: 'phone is required' }, 400)
    if (!inbound_message && !outbound_message) {
      return json({ error: 'inbound_message or outbound_message is required' }, 400)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Idempotency: if we've already mirrored this inbound Twilio SID, do nothing.
    // This guards against Twilio webhook retries double-posting the thread.
    if (inbound_sid) {
      const { data: dupe } = await supabase
        .from('sales_sms_log')
        .select('id')
        .eq('twilio_sid', inbound_sid)
        .limit(1)
        .maybeSingle()
      if (dupe) return json({ ok: true, skipped: 'duplicate_inbound_sid' })
    }

    // ── Find-or-create the sales-pipeline lead by phone ──────────────────────
    let { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('phone', normPhone)
      .limit(1)
      .maybeSingle()

    if (!lead) {
      const { data: created, error: leadErr } = await supabase
        .from('leads')
        .insert([{
          name:       (lead_name && lead_name.trim()) || (company && company.trim()) || normPhone,
          company:    (company && company.trim()) || null,
          phone:      normPhone,
          stage:      'new_lead',
          source:     (source && source.trim()) || 'Agency SMS',
          created_at: new Date().toISOString(),
        }])
        .select('id')
        .single()

      if (leadErr || !created) {
        console.error('sales lead insert error:', leadErr?.message)
        return json({ error: leadErr?.message || 'lead insert failed' }, 500)
      }
      lead = created
    }

    const leadId = lead.id as string
    const nowIso = new Date().toISOString()
    const rows: Array<Record<string, unknown>> = []

    if (inbound_message && inbound_message.trim()) {
      rows.push({
        lead_id:    leadId,
        to_number:  twilio_number || null,   // the agency Twilio number the lead texted
        message:    inbound_message.trim(),
        sent_by:    normPhone,               // the lead's own number
        twilio_sid: inbound_sid || null,
        status:     'received',
        direction:  'inbound',
        created_at: nowIso,
      })
    }
    if (outbound_message && outbound_message.trim()) {
      rows.push({
        lead_id:    leadId,
        to_number:  normPhone,               // reply goes to the lead
        message:    outbound_message.trim(),
        sent_by:    'AI (Don)',
        twilio_sid: null,
        status:     'delivered',
        direction:  'outbound',
        // Ensure the reply sorts after the inbound message in the thread.
        created_at: new Date(Date.now() + 1000).toISOString(),
      })
    }

    if (rows.length) {
      const { error: logErr } = await supabase.from('sales_sms_log').insert(rows)
      if (logErr) {
        console.error('sales_sms_log insert error:', logErr.message)
        return json({ error: logErr.message }, 500)
      }
    }

    return json({ ok: true, lead_id: leadId, inserted: rows.length })

  } catch (err) {
    console.error('sync-sales-conversation error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
