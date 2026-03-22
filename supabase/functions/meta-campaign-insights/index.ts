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

    // Date range: today for daily, this month for monthly
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    type InsightResult = {
      campaign_id: string
      meta_campaign_id: string
      success: boolean
      error?: string
      status?: string
      spend?: number
      impressions?: number
      clicks?: number
      results?: number
      cpm?: number
      ctr?: number
      cpc?: number
      cpl?: number
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
        const insightsUrl = `https://graph.facebook.com/v21.0/${camp.meta_campaign_id}/insights?fields=spend,impressions,clicks,actions,cpm,ctr,cpc&time_range={"since":"${monthStart}","until":"${todayStr}"}&access_token=${metaToken}`
        const insightsRes = await fetch(insightsUrl)
        const insightsData = await insightsRes.json()

        let spend = 0, impressions = 0, clicks = 0, leadActions = 0
        let cpm = 0, ctr = 0, cpc = 0

        if (insightsData.data && insightsData.data.length > 0) {
          const row = insightsData.data[0]
          spend = parseFloat(row.spend || '0')
          impressions = parseInt(row.impressions || '0', 10)
          clicks = parseInt(row.clicks || '0', 10)
          cpm = parseFloat(row.cpm || '0')
          ctr = parseFloat(row.ctr || '0')
          cpc = parseFloat(row.cpc || '0')

          // Extract lead actions (lead, onsite_conversion.lead_grouped, etc.)
          if (row.actions) {
            for (const action of row.actions) {
              if (
                action.action_type === 'lead' ||
                action.action_type === 'onsite_conversion.lead_grouped' ||
                action.action_type === 'offsite_conversion.fb_pixel_lead'
              ) {
                leadActions += parseInt(action.value || '0', 10)
              }
            }
          }
        }

        const cpl = leadActions > 0 ? spend / leadActions : 0
        const metaStatus = statusData.effective_status || statusData.status || 'UNKNOWN'

        // Update DB with fresh stats
        await supabaseClient.from('meta_campaigns').update({
          status: metaStatus === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
          spend_mtd: spend,
          impressions_mtd: impressions,
          clicks_mtd: clicks,
          leads_mtd: leadActions,
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
          results: leadActions,
          cpm,
          ctr,
          cpc,
          cpl,
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
