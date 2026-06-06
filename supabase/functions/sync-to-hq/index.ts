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

  // Validate caller is an authenticated MC user
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return json({ error: 'unauthorized' }, 401)

  const QL_HQ_API_URL    = Deno.env.get('QL_HQ_API_URL')!     // e.g. https://api.ql-hq.com or https://<ref>.supabase.co/functions/v1
  const QL_MC_API_SECRET = Deno.env.get('QL_MC_API_SECRET')!   // shared secret

  try {
    const body = await req.json()
    const { ql_hq_company_id, email, sms_number, webhook_url, postcodes } = body

    if (!ql_hq_company_id || typeof ql_hq_company_id !== 'string' || !ql_hq_company_id.trim()) {
      return json({ error: 'ql_hq_company_id is required' }, 400)
    }

    const res = await fetch(`${QL_HQ_API_URL}/sync-from-mc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': QL_MC_API_SECRET,
      },
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
