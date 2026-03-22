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
    // Verify auth
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) throw new Error('Unauthorized')

    const { campaign_ids, action } = await req.json()

    if (!campaign_ids || !Array.isArray(campaign_ids) || campaign_ids.length === 0) {
      throw new Error('campaign_ids (array) is required')
    }
    if (!['PAUSED', 'ACTIVE'].includes(action)) {
      throw new Error('action must be PAUSED or ACTIVE')
    }

    const metaToken = Deno.env.get('META_ACCESS_TOKEN')
    if (!metaToken) throw new Error('META_ACCESS_TOKEN not configured')

    const results: Array<{ campaign_id: string; success: boolean; error?: string }> = []

    for (const campaignId of campaign_ids) {
      try {
        const url = `https://graph.facebook.com/v21.0/${campaignId}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: action,
            access_token: metaToken,
          }),
        })

        const data = await res.json()

        if (!res.ok || data.error) {
          results.push({
            campaign_id: campaignId,
            success: false,
            error: data.error?.message || `HTTP ${res.status}`,
          })
        } else {
          results.push({ campaign_id: campaignId, success: true })
        }
      } catch (err) {
        results.push({
          campaign_id: campaignId,
          success: false,
          error: err.message,
        })
      }
    }

    // Log the action
    await supabaseClient.from('meta_api_log').insert({
      action,
      campaign_ids,
      results,
      triggered_by: user.id,
    })

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
