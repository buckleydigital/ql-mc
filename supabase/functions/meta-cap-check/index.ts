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
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    const dbClient = createClient(supabaseUrl, serviceKey)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()

    const isServiceRole = authHeader === `Bearer ${serviceKey}`
    if (!isServiceRole && (authError || !user)) throw new Error('Unauthorized')

    const metaToken = Deno.env.get('META_ACCESS_TOKEN')
    if (!metaToken) throw new Error('META_ACCESS_TOKEN not configured')

    // Get ALL active PPL clients with campaign IDs (even those without caps,
    // because they share campaigns with capped clients)
    const { data: clients, error: clientErr } = await dbClient
      .from('clients')
      .select('id,company_name,weekly_cap,monthly_cap,meta_campaign_ids,stage')
      .eq('type', 'ppl')
      .eq('stage', 'active_client')
      .not('meta_campaign_ids', 'is', null)

    if (clientErr) throw new Error(`DB error: ${clientErr.message}`)
    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ message: 'No clients with campaign IDs', actions: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Week boundaries (Mon-Sun)
    const now = new Date()
    const dayOfWeek = now.getDay()
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() + mondayOffset)
    weekStart.setHours(0, 0, 0, 0)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    // ── Step 1: Check each client's cap status ──
    type ClientCapStatus = {
      id: string
      company_name: string
      capped: boolean
      reason: string
      campaign_ids: string[]
    }

    const clientStatuses: ClientCapStatus[] = []

    for (const client of clients) {
      const campaignIds: string[] = client.meta_campaign_ids || []
      if (campaignIds.length === 0) continue

      // No caps set = never capped (unlimited)
      if (!client.weekly_cap && !client.monthly_cap) {
        clientStatuses.push({
          id: client.id,
          company_name: client.company_name,
          capped: false,
          reason: 'No caps set',
          campaign_ids: campaignIds,
        })
        continue
      }

      const { count: weeklyLeads } = await dbClient
        .from('ppl_order_log')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('status', 'delivered')
        .gte('created_at', weekStart.toISOString())

      const { count: monthlyLeads } = await dbClient
        .from('ppl_order_log')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('status', 'delivered')
        .gte('created_at', monthStart.toISOString())

      const weeklyCount = weeklyLeads || 0
      const monthlyCount = monthlyLeads || 0

      let capped = false
      let reason = ''

      if (client.weekly_cap && weeklyCount >= client.weekly_cap) {
        capped = true
        reason = `Weekly cap hit: ${weeklyCount}/${client.weekly_cap}`
      }
      if (client.monthly_cap && monthlyCount >= client.monthly_cap) {
        capped = true
        reason = reason
          ? `${reason} | Monthly cap hit: ${monthlyCount}/${client.monthly_cap}`
          : `Monthly cap hit: ${monthlyCount}/${client.monthly_cap}`
      }

      clientStatuses.push({
        id: client.id,
        company_name: client.company_name,
        capped,
        reason: reason || `Under cap (W: ${weeklyCount}/${client.weekly_cap || '∞'}, M: ${monthlyCount}/${client.monthly_cap || '∞'})`,
        campaign_ids: campaignIds,
      })

      // Flag individual client as capped in DB
      if (capped) {
        await dbClient.from('clients').update({
          meta_cap_paused: true,
          meta_cap_paused_at: new Date().toISOString(),
          meta_cap_pause_reason: reason,
        }).eq('id', client.id)
      } else {
        // Clear cap flag if previously set but now under cap
        await dbClient.from('clients').update({
          meta_cap_paused: false,
          meta_cap_paused_at: null,
          meta_cap_pause_reason: null,
        }).eq('id', client.id)
      }
    }

    // ── Step 2: Build campaign → clients map ──
    // A campaign should only be paused if EVERY client linked to it is capped.
    // If even one client still has room, the campaign stays active.
    const campaignToClients: Record<string, ClientCapStatus[]> = {}

    for (const cs of clientStatuses) {
      for (const cid of cs.campaign_ids) {
        if (!campaignToClients[cid]) campaignToClients[cid] = []
        campaignToClients[cid].push(cs)
      }
    }

    // ── Step 3: Decide per campaign ──
    const campaignActions: Array<{
      campaign_id: string
      action: 'PAUSED' | 'ACTIVE'
      reason: string
      clients_capped: string[]
      clients_remaining: string[]
    }> = []

    const toPause: string[] = []
    const toResume: string[] = []

    for (const [campaignId, linkedClients] of Object.entries(campaignToClients)) {
      const capped = linkedClients.filter(c => c.capped)
      const remaining = linkedClients.filter(c => !c.capped)

      if (remaining.length === 0) {
        // ALL clients for this campaign are capped → pause it
        toPause.push(campaignId)
        campaignActions.push({
          campaign_id: campaignId,
          action: 'PAUSED',
          reason: `All ${capped.length} client(s) hit caps`,
          clients_capped: capped.map(c => c.company_name),
          clients_remaining: [],
        })
      } else {
        // At least one client still has room → keep active
        // (also resume if it was previously paused by us)
        toResume.push(campaignId)
        campaignActions.push({
          campaign_id: campaignId,
          action: 'ACTIVE',
          reason: `${remaining.length} client(s) still under cap`,
          clients_capped: capped.map(c => c.company_name),
          clients_remaining: remaining.map(c => c.company_name),
        })
      }
    }

    // ── Step 4: Execute Meta API calls ──
    const apiResults: Array<{
      campaign_id: string
      action: string
      success: boolean
      error?: string
    }> = []

    if (toPause.length > 0) {
      const results = await toggleCampaigns(toPause, 'PAUSED', metaToken)
      apiResults.push(...results.map(r => ({ ...r, action: 'PAUSED' })))
    }

    if (toResume.length > 0) {
      const results = await toggleCampaigns(toResume, 'ACTIVE', metaToken)
      apiResults.push(...results.map(r => ({ ...r, action: 'ACTIVE' })))
    }

    // Log
    await dbClient.from('meta_api_log').insert({
      action: 'CAP_CHECK',
      campaign_ids: [...toPause, ...toResume],
      results: { client_statuses: clientStatuses, campaign_actions: campaignActions, api_results: apiResults },
      triggered_by: isServiceRole ? 'cron' : user?.id,
    })

    return new Response(JSON.stringify({
      checked_clients: clientStatuses.length,
      checked_campaigns: Object.keys(campaignToClients).length,
      paused: toPause.length,
      kept_active: toResume.length,
      campaign_actions: campaignActions,
      api_results: apiResults,
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
