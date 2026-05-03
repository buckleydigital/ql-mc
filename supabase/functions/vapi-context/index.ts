// vapi-context: returns the Master Brain system prompt + live data context so the
// VAPI voice assistant can be seeded with the same knowledge as the text chat agent.
// Called by the frontend just before starting a VAPI call.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") || ""
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || ""

const SYSTEM_PROMPT = `You are JARVIS — the voice-activated AI assistant for this business dashboard. You have the same knowledge and data access as the Master Brain text agent.

## Revenue Streams
- **Pay-Per-Lead (PPL)**: generate solar leads via paid Meta ads and sell them to PPL clients. Key metric: Meta ad cost per lead (CPL) vs sell price per lead.
- **Managed Advertising**: manage Meta ad campaigns for clients on a monthly retainer fee.
- **Sales Pipeline**: leads tracked in CRM — closed deals convert to active clients.

## Your Scope
You cover marketing, finance, operations, strategy, and sales. Be concise since this is a voice conversation — keep responses under 3 sentences unless asked to elaborate. Lead with the most important number or action.

## Key Metrics
Meta ad CPL (cost per lead), effective CPL (after unsold leads), managed spend MTD, retainer revenue, net profit margin, pipeline value, lead aging.

## Sales Prioritisation Framework (when asked who to call / pipeline focus)
1. Call-back appointments (highest urgency — they're expecting a call)
2. Proposals sent but not yet followed up
3. Qualified leads with high deal value
4. New leads from the last 48 hours
5. No-answer leads not attempted in 3+ days

## Voice Conversation Style
- Speak naturally and conversationally
- Keep responses short — 1–3 sentences for most answers
- Use numbers precisely: say "forty-five dollars" not "$45"
- If asked for a full report, provide it but structure it clearly
- Always end action-item responses with a clear next step
- Say "I don't have that data" rather than guessing

## Data Context Notes
- All spend/revenue figures are in AUD
- MTD = month-to-date, YTD = year-to-date
- Never describe MTD totals as "daily" figures`

async function buildContext(): Promise<string> {
  const sb = createClient(supabaseUrl, supabaseServiceKey)
  const fmtN = (n: number | null) => (n != null && n !== 0) ? '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0}) : 'n/a'
  const fmtC = (n: number | null) => (n != null && n > 0) ? '$' + Number(n).toFixed(2) : 'n/a'
  const now = new Date()
  const yr = now.getFullYear() + '-01-01'
  const monthLabel = now.toLocaleString('en-AU', {month:'long', year:'numeric'})
  const today = now.toISOString().split('T')[0]
  let out = `\n\n## Live Data Context — ${now.toLocaleString('en-AU', {weekday:'long', day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'})}`

  // Load agent files for additional context
  try {
    const { data: files } = await sb.from('agent_files').select('filename,content').eq('agent', 'master')
    if (files && files.length) {
      files.forEach((f: any) => { out += `\n### ${f.filename}\n${f.content}` })
    }
  } catch(_) {}

  // Tasks due today / overdue
  try {
    const { data: tasks } = await sb.from('tasks').select('title,due_date,priority,status').in('status', ['todo','in_progress']).order('due_date')
    if (tasks && tasks.length) {
      const overdue = tasks.filter((t: any) => t.due_date && t.due_date < today)
      const dueToday = tasks.filter((t: any) => t.due_date === today)
      out += `\n\n## Tasks`
      out += `\n- Total open: ${tasks.length}`
      if (overdue.length) out += `\n- Overdue: ${overdue.length} (${overdue.map((t: any) => t.title).join(', ')})`
      if (dueToday.length) out += `\n- Due today: ${dueToday.map((t: any) => t.title).join(', ')}`
    }
  } catch(_) {}

  // SLA overdue orders
  try {
    const { data: slaOrders } = await sb.from('ppl_order_log').select('leads_qty,sla_due_date,order_date').eq('status','in_progress').lte('sla_due_date',today).not('sla_due_date','is',null)
    if (slaOrders && slaOrders.length) {
      out += `\n\n## SLA Overdue Orders\n- ${slaOrders.length} PPL order(s) past their SLA due date`
      slaOrders.forEach((o: any) => { out += `\n  - ${o.leads_qty} leads ordered ${o.order_date}, due ${o.sla_due_date}` })
    }
  } catch(_) {}

  // Active PPL clients
  try {
    const { data: pplClients } = await sb.from('clients').select('company_name,leads_delivered,total_leads_purchased,meta_cpl,true_cpl,pct_sold,lead_price,balance,stage').eq('type','ppl').order('company_name')
    if (pplClients && pplClients.length) {
      const active = pplClients.filter((c: any) => c.stage === 'active_client')
      out += `\n\n## PPL Clients\n- ${active.length} active, ${pplClients.length} total`
      active.forEach((c: any) => {
        out += `\n- ${c.company_name}: ${c.leads_delivered||0}/${c.total_leads_purchased||0} delivered · $${c.lead_price||0}/lead · balance ${fmtN(c.balance)}`
      })
    }
  } catch(_) {}

  // Active Managed clients
  try {
    const { data: mgClients } = await sb.from('clients').select('company_name,management_fee,stage').eq('type','managed').order('company_name')
    if (mgClients && mgClients.length) {
      const active = mgClients.filter((c: any) => c.stage === 'active')
      const totalRetainer = active.reduce((s: number, c: any) => s + (c.management_fee||0), 0)
      out += `\n\n## Managed Clients\n- ${active.length} active, ${mgClients.length} total · Total retainer: ${fmtN(totalRetainer)}/mo`
      active.forEach((c: any) => { out += `\n- ${c.company_name}: ${fmtN(c.management_fee)}/mo` })
    }
  } catch(_) {}

  // Meta campaign performance
  try {
    const { data: campaigns } = await sb.from('meta_campaigns').select('name,status,spend_mtd,leads_mtd,cpl_mtd').order('name')
    if (campaigns && campaigns.length) {
      const active = campaigns.filter((c: any) => c.status === 'ACTIVE')
      const totalSpend = campaigns.reduce((s: number, c: any) => s + (Number(c.spend_mtd)||0), 0)
      const totalLeads = campaigns.reduce((s: number, c: any) => s + (Number(c.leads_mtd)||0), 0)
      out += `\n\n## Meta Campaigns — MTD (${monthLabel})\n- ${active.length} active, ${campaigns.length} total`
      out += `\n- Total ad spend MTD: ${fmtN(totalSpend)} · Leads: ${totalLeads} · Blended CPL: ${totalLeads > 0 ? fmtC(totalSpend/totalLeads) : 'n/a'}`
    }
  } catch(_) {}

  // YTD ad spend
  try {
    const curPeriod = now.toISOString().slice(0,7)
    const yrMonth = `${yr.slice(0,4)}-01`
    const [spendLogR, agencyR] = await Promise.all([
      sb.from('campaign_spend_log').select('spend,leads').gte('period', yrMonth).lte('period', curPeriod),
      sb.from('ad_spend_daily').select('spend').eq('account_type','agency').gte('date', yr).order('date', {ascending:false}).limit(1),
    ])
    const spendLog = spendLogR.data || []
    const campSpendYTD = spendLog.reduce((s: number, r: any) => s + (r.spend||0), 0)
    const campLeadsYTD = spendLog.reduce((s: number, r: any) => s + (r.leads||0), 0)
    const agencySpendYTD = agencyR.data?.[0]?.spend || 0
    out += `\n\n## Ad Spend YTD (${yr.slice(0,4)})`
    out += `\n- Campaign spend: ${fmtN(campSpendYTD)} · ${campLeadsYTD} leads · avg CPL ${campLeadsYTD > 0 ? fmtC(campSpendYTD/campLeadsYTD) : 'n/a'}`
    out += `\n- Agency acquisition: ${fmtN(agencySpendYTD)}`
  } catch(_) {}

  // Sales pipeline
  try {
    const stageLabels: Record<string,string> = {call_back:'Call Back',proposal:'Proposal',qualified:'Qualified',new_lead:'New Lead',no_answer:'No Answer',paused:'Paused'}
    const { data: leads } = await sb.from('leads').select('name,company,stage,lead_type,value,last_contact').not('stage','in','("closed_won","closed_lost")').order('updated_at',{ascending:false})
    if (leads && leads.length) {
      const counts = leads.reduce((acc: Record<string,number>, l: any) => { acc[l.stage]=(acc[l.stage]||0)+1; return acc }, {})
      const totalValue = leads.reduce((s: number, l: any) => s+(l.value||0),0)
      const followupNeeded = leads.filter((l: any) => l.last_contact && (Date.now()-new Date(l.last_contact).getTime())/(1000*86400) > 7).length
      out += `\n\n## Sales Pipeline\n- ${leads.length} active leads · ${fmtN(totalValue)}/mo pipeline value`
      out += `\n- By stage: ${Object.entries(counts).map(([s,n]) => `${stageLabels[s]||s}: ${n}`).join(', ')}`
      if (followupNeeded > 0) out += `\n- ⚠ ${followupNeeded} leads with no contact in 7+ days`
    }
  } catch(_) {}

  return out
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  // Verify JWT
  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders })
    }
    const token = authHeader.slice(7)
    const userSb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    })
    const { data: { user }, error } = await userSb.auth.getUser()
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders })
    }
  } catch(e) {
    return new Response(JSON.stringify({ error: "Auth check failed" }), { status: 401, headers: corsHeaders })
  }

  try {
    const context = await buildContext()
    const systemPrompt = SYSTEM_PROMPT + context
    // Return VAPI credentials from server-side secrets so the frontend never needs
    // to store them in browser storage. vapiPublicKey will be null if the secret
    // has not been set — the frontend falls back to any manual sessionStorage override.
    const vapiPublicKey = Deno.env.get("VAPI_PUBLIC_KEY") || null
    // ElevenLabs voice ID — passed as an inline voice override in the VAPI call.
    // No pre-created VAPI assistant is needed; the assistant is configured inline.
    // Set ELEVENLABS_VOICE_ID as a Supabase edge function secret.
    const elevenLabsVoiceId = Deno.env.get("ELEVENLABS_VOICE_ID") || null
    return new Response(JSON.stringify({ systemPrompt, vapiPublicKey, elevenLabsVoiceId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error"
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
