// register-campaign - ql-hq built a campaign for a managed client; record it.
//
// ql-hq's campaign-build makes the campaign in the client's own ad account
// (always paused) and calls this. It goes in managed_campaigns, managed
// advertising's own list: never in meta_campaigns or clients.meta_campaign_ids,
// which are pay-per-lead's and are synced, capped and cost-checked as such.
// Fills clients.ad_account_id only when nobody has typed one in.
//
// POST { hq_company_id, campaign: { meta_campaign_id, ad_account_id, name,
// status, notes } } with x-api-secret (QL_MC_API_SECRET), as sync-from-hq.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')

Deno.serve(async (req: Request) => {
  const apiSecret = Deno.env.get('QL_MC_API_SECRET')
  const provided = req.headers.get('x-api-secret')
  if (!apiSecret || !provided || provided !== apiSecret) return json({ error: 'unauthorized' }, 401)

  try {
    const { hq_company_id, campaign } = await req.json() as {
      hq_company_id?: string
      campaign?: { meta_campaign_id?: string; ad_account_id?: string; name?: string; status?: string; notes?: string }
    }
    const campaignId = digits(campaign?.meta_campaign_id)
    const account = digits(campaign?.ad_account_id)
    if (!hq_company_id || !campaignId || !account) {
      return json({ error: 'hq_company_id, campaign.meta_campaign_id and campaign.ad_account_id are required' }, 400)
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: client } = await supabase.from('clients')
      .select('id, ad_account_id').eq('ql_hq_company_id', hq_company_id).maybeSingle()

    const { error: campErr } = await supabase.from('managed_campaigns').upsert({
      meta_campaign_id: campaignId,
      hq_company_id,
      client_id: client?.id ?? null,
      ad_account_id: account,
      name: String(campaign?.name || `Campaign ${campaignId}`).slice(0, 200),
      status: campaign?.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
      notes: campaign?.notes ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'meta_campaign_id' })
    if (campErr) return json({ error: campErr.message }, 500)

    if (!client) return json({ ok: true, linked: false, reason: 'no matching ql-mc client' })
    // Fill the ad account only when nobody has typed one in.
    if (!String(client.ad_account_id || '').trim()) {
      const { error: upErr } = await supabase.from('clients')
        .update({ ad_account_id: account, updated_at: new Date().toISOString() }).eq('id', client.id)
      if (upErr) return json({ error: upErr.message }, 500)
    }
    return json({ ok: true, linked: true, client_id: client.id })
  } catch (err) {
    console.error('register-campaign error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
