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
    // Auth: accept either user JWT or service-role key (for cron triggers)
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    // Use service role for DB reads (needs full access to count leads)
    const dbClient = createClient(supabaseUrl, serviceKey)

    // Verify the caller is authenticated
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    // Allow service-role callers (cron) or authenticated users
    const isServiceRole = authHeader === `Bearer ${serviceKey}`
    if (!isServiceRole && (authError || !user)) throw new Error('Unauthorized')

    const metaToken = Deno.env.get('META_ACCESS_TOKEN')
    if (!metaToken) throw new Error('META_ACCESS_TOKEN not configured')

    // Get all active PPL clients with caps and campaign IDs
    const { data: clients, error: clientErr } = await dbClient
      .from('clients')
      .select('id,company_name,weekly_cap,monthly_cap,meta_campaign_ids,leads_mtd,stage')
      .eq('type', 'ppl')
      .eq('stage', 'active_client')
      .not('meta_campaign_ids', 'is', null)

    if (clientErr) throw new Error(`DB error: ${clientErr.message}`)
    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ message: 'No clients with campaign IDs', actions: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Calculate current week boundaries (Mon-Sun)
    const now = new Date()
    const dayOfWeek = now.getDay()
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() + mondayOffset)
    weekStart.setHours(0, 0, 0, 0)

    // Current month boundaries
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const actions: Array<{
      client: string
      client_id: string
      action: string
      reason: string
      campaign_ids: string[]
      results?: unknown[]
    }> = []

    for (const client of clients) {
      const campaignIds: string[] = client.meta_campaign_ids || []
      if (campaignIds.length === 0) continue

      // Count leads delivered this week
      const { count: weeklyLeads } = await dbClient
        .from('ppl_order_log')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('status', 'delivered')
        .gte('created_at', weekStart.toISOString())

      // Count leads delivered this month
      const { count: monthlyLeads } = await dbClient
        .from('ppl_order_log')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('status', 'delivered')
        .gte('created_at', monthStart.toISOString())

      const weeklyCount = weeklyLeads || 0
      const monthlyCount = monthlyLeads || 0

      let shouldPause = false
      let reason = ''

      if (client.weekly_cap && weeklyCount >= client.weekly_cap) {
        shouldPause = true
        reason = `Weekly cap hit: ${weeklyCount}/${client.weekly_cap}`
      }
      if (client.monthly_cap && monthlyCount >= client.monthly_cap) {
        shouldPause = true
        reason = reason
          ? `${reason} | Monthly cap hit: ${monthlyCount}/${client.monthly_cap}`
          : `Monthly cap hit: ${monthlyCount}/${client.monthly_cap}`
      }

      if (shouldPause) {
        // Pause all campaigns for this client
        const results = await toggleCampaigns(campaignIds, 'PAUSED', metaToken)
        actions.push({
          client: client.company_name,
          client_id: client.id,
          action: 'PAUSED',
          reason,
          campaign_ids: campaignIds,
          results,
        })

        // Update client record with cap_paused flag
        await dbClient.from('clients').update({
          meta_cap_paused: true,
          meta_cap_paused_at: new Date().toISOString(),
          meta_cap_pause_reason: reason,
        }).eq('id', client.id)
      }
    }

    // Log the check
    await dbClient.from('meta_api_log').insert({
      action: 'CAP_CHECK',
      campaign_ids: [],
      results: actions,
      triggered_by: isServiceRole ? 'cron' : user?.id,
    })

    return new Response(JSON.stringify({ checked: clients.length, actions }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

async function toggleCampaigns(
  campaignIds: string[],
  action: string,
  token: string
): Promise<Array<{ campaign_id: string; success: boolean; error?: string }>> {
  const results = []
  for (const id of campaignIds) {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: action, access_token: token }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        results.push({ campaign_id: id, success: false, error: data.error?.message || `HTTP ${res.status}` })
      } else {
        results.push({ campaign_id: id, success: true })
      }
    } catch (err) {
      results.push({ campaign_id: id, success: false, error: err.message })
    }
  }
  return results
}
