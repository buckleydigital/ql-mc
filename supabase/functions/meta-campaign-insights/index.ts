import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    const supabaseClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) throw new Error('Unauthorized')

    const metaToken = Deno.env.get('META_ACCESS_TOKEN')
    if (!metaToken) throw new Error('META_ACCESS_TOKEN not configured')

    // Parse period from request body
    let period = 'mtd'
    try {
      const body = await req.json()
      if (body.period && ['7d', '30d', 'mtd', 'ytd'].includes(body.period)) {
        period = body.period
      }
    } catch (_) { /* empty body is fine, default to mtd */ }

    // Get all campaigns grouped by ad account
    const { data: campaigns, error: campErr } = await supabaseClient
      .from('meta_campaigns')
      .select('id,meta_campaign_id,ad_account_id')

    if (campErr) throw new Error(`DB error: ${campErr.message}`)
    if (!campaigns || campaigns.length === 0) {
      return new Response(JSON.stringify({ message: 'No campaigns to sync', results: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Get unique ad accounts
    const { data: adAccounts } = await supabaseClient
      .from('meta_ad_accounts')
      .select('account_id')

    const validAccounts = new Set((adAccounts || []).map(a => a.account_id))

    // Date range based on selected period
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    let sinceStr: string
    if (period === '7d') {
      const d = new Date(now)
      d.setDate(d.getDate() - 6)
      sinceStr = d.toISOString().slice(0, 10)
    } else if (period === '30d') {
      const d = new Date(now)
      d.setDate(d.getDate() - 29)
      sinceStr = d.toISOString().slice(0, 10)
    } else if (period === 'ytd') {
      sinceStr = `${now.getFullYear()}-01-01`
    } else {
      // mtd
      sinceStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    }

    type InsightResult = {
      campaign_id: string
      meta_campaign_id: string
      success: boolean
      error?: string
      status?: string
      spend?: number
      impressions?: number
      clicks?: number
      leads?: number
      cpl?: number
      cpm?: number
      ctr?: number
      cpc?: number
    }

    const results: InsightResult[] = []

    for (const camp of campaigns) {
      try {
        // Fetch campaign status + insights in one call
        const fields = 'name,status,effective_status'
        const statusUrl = `https://graph.facebook.com/v21.0/${camp.meta_campaign_id}?fields=${fields}&access_token=${metaToken}`
        const statusRes = await fetch(statusUrl)
        const statusData = await statusRes.json()

        if (statusData.error) {
          results.push({
            campaign_id: camp.id,
            meta_campaign_id: camp.meta_campaign_id,
            success: false,
            error: statusData.error.message,
          })
          continue
        }

        // Fetch insights for this month
        const insightsUrl = `https://graph.facebook.com/v21.0/${camp.meta_campaign_id}/insights?fields=spend,impressions,clicks,actions,cpm,ctr,cpc&time_range={"since":"${sinceStr}","until":"${todayStr}"}&access_token=${metaToken}`
        const insightsRes = await fetch(insightsUrl)
        const insightsData = await insightsRes.json()

        let spend = 0, impressions = 0, clicks = 0, leads = 0
        let cpm = 0, ctr = 0, cpc = 0

        if (insightsData.data && insightsData.data.length > 0) {
          const row = insightsData.data[0]
          spend = parseFloat(row.spend || '0')
          impressions = parseInt(row.impressions || '0', 10)
          clicks = parseInt(row.clicks || '0', 10)
          cpm = parseFloat(row.cpm || '0')
          ctr = parseFloat(row.ctr || '0')
          cpc = parseFloat(row.cpc || '0')

          if (row.actions) {
            for (const action of row.actions) {
              if (action.action_type === 'offsite_conversion.fb_pixel_lead') {
                leads += parseInt(action.value || '0', 10)
              }
            }
          }
        }

        const cpl = leads > 0 ? spend / leads : 0
        const metaStatus = statusData.effective_status || statusData.status || 'UNKNOWN'

        await supabaseClient.from('meta_campaigns').update({
          status: metaStatus === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
          spend_mtd: spend,
          impressions_mtd: impressions,
          clicks_mtd: clicks,
          leads_mtd: leads,
          cpl_mtd: cpl,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', camp.id)

        results.push({
          campaign_id: camp.id,
          meta_campaign_id: camp.meta_campaign_id,
          success: true,
          status: metaStatus,
          spend,
          impressions,
          clicks,
          leads,
          cpl,
          cpm,
          ctr,
          cpc,
        })
      } catch (err) {
        results.push({
          campaign_id: camp.id,
          meta_campaign_id: camp.meta_campaign_id,
          success: false,
          error: err.message,
        })
      }
    }

    const succeeded = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length

    // ── Roll up: spend from Meta campaigns, leads from our DB ──
    // CPL = campaign spend / actual leads delivered to client (from ppl_order_log)
    try {
      const { data: pplClients } = await supabaseClient
        .from('clients')
        .select('id,meta_campaign_ids')
        .eq('type', 'ppl')
        .not('meta_campaign_ids', 'is', null)

      if (pplClients && pplClients.length > 0) {
        const campStats: Record<string, { spend: number; leads: number }> = {}
        for (const camp of campaigns) {
          const r = results.find(x => x.campaign_id === camp.id && x.success)
          if (r) campStats[camp.meta_campaign_id] = { spend: r.spend || 0, leads: r.leads || 0 }
        }

        for (const client of pplClients) {
          const linkedIds: string[] = client.meta_campaign_ids || []
          if (linkedIds.length === 0) continue

          let totalSpend = 0, totalLeads = 0
          for (const cid of linkedIds) {
            const s = campStats[cid]
            if (s) { totalSpend += s.spend; totalLeads += s.leads }
          }

          const clientCpl = totalLeads > 0 ? totalSpend / totalLeads : null

          await supabaseClient.from('clients').update({
            meta_cpl: clientCpl !== null ? Number(clientCpl.toFixed(2)) : null,
            leads_mtd: totalLeads,
            updated_at: new Date().toISOString(),
          }).eq('id', client.id)
        }
      }
    } catch (_) { /* non-critical: client rollup failed */ }

    return new Response(JSON.stringify({
      synced: succeeded,
      failed,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
