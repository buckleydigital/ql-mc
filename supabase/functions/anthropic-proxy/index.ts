import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") || ""
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""

function buildSystemPrompt(agent: string): string | null {
  switch (agent) {
    case "master":
      return `You are the Master Brain — the single AI assistant for this business dashboard with full access to all data.

## Revenue Streams
- **Pay-Per-Lead (PPL)**: generate solar leads via paid Meta ads and sell them to PPL clients. Key metric: Meta ad cost per lead (CPL) vs sell price per lead.
- **Managed Advertising**: manage Meta ad campaigns for clients on a monthly retainer fee.
- **Sales Pipeline**: leads tracked in CRM — closed deals convert to active clients.

## Your Scope
You cover marketing, finance, operations, strategy, and sales — there is no separate specialist agent. Use whichever data is relevant to answer.

## Key Metrics
Meta ad CPL (cost per lead), effective CPL (after unsold leads), managed spend MTD, retainer revenue, net profit margin, pipeline value, lead aging.

## Sales Prioritisation Framework (when asked who to call / pipeline focus)
1. Call-back appointments (highest urgency — they're expecting a call)
2. Proposals sent but not yet followed up (strike while warm)
3. Qualified leads with high deal value
4. New leads from the last 48 hours (strike while fresh)
5. No-answer leads that haven't been attempted in 3+ days
Retainer (managed) deals are higher value and more strategic — prioritise these for follow-up.

## Data Context Notes
- **MTD figures** = current month-to-date totals pulled live from Meta API (campaigns, spend, leads, CPL)
- **YTD figures** = year-to-date totals from historical daily records (January 1 onwards)
- All spend/revenue figures are in AUD
- Never describe MTD totals as "daily" figures — they are period totals

## Instructions
Be concise, direct and data-driven. Lead with numbers and specific names/actions. Never invent or estimate figures — if data is unavailable, say so. Flag anomalies, cold leads (7+ days no contact), and quick wins.`

    default:
      return null
  }
}

async function buildContext(agent: string): Promise<string> {
  const sb = createClient(supabaseUrl, supabaseServiceKey)
  const fmtN = (n: number | null) => (n != null && n !== 0) ? '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0}) : 'n/a'
  const fmtC = (n: number | null) => (n != null && n > 0) ? '$' + Number(n).toFixed(2) : 'n/a'
  const yr = new Date().getFullYear() + '-01-01'
  const now = new Date()
  const monthLabel = now.toLocaleString('en-AU', {month:'long', year:'numeric'})
  let out = '\n\n## Live Dashboard Context'

  // Load agent files for additional context
  try {
    const { data: files } = await sb.from('agent_files').select('filename,content').eq('agent', agent)
    if (files && files.length) {
      out += '\n\n## Agent Configuration Files'
      files.forEach((f: any) => { out += `\n### ${f.filename}\n${f.content}` })
    }
  } catch(_) {}

  // Sales pipeline context (master is the only agent reaching this far)
  try {
    const stageLabels: Record<string,string> = {call_back:'Call Back',proposal:'Proposal',qualified:'Qualified',new_lead:'New Lead',no_answer:'No Answer',paused:'Paused',closed_won:'Closed Won',closed_lost:'Closed Lost'}
    const stageOrder: Record<string,number> = {call_back:1,proposal:2,qualified:3,new_lead:4,no_answer:5,paused:6}
    const { data: leads } = await sb.from('leads').select('id,name,company,stage,lead_type,value,source,notes,last_contact,created_at,updated_at').not('stage','in','("closed_won","closed_lost")').order('updated_at',{ascending:false})
    if (leads && leads.length) {
      const sorted = [...leads].sort((a: any, b: any) => {
        const so = (stageOrder[a.stage]||9) - (stageOrder[b.stage]||9)
        return so !== 0 ? so : (b.value||0) - (a.value||0)
      })
      const lines = sorted.map((l: any) => {
        const lastContact = l.last_contact ? new Date(l.last_contact).toLocaleDateString('en-AU') : 'never contacted'
        const value = l.value ? `$${Number(l.value).toLocaleString()}/mo` : 'value TBD'
        const daysSince = l.last_contact ? Math.floor((Date.now()-new Date(l.last_contact).getTime())/(1000*86400)) : null
        const urgency = daysSince !== null && daysSince > 7 ? ` ⚠ ${daysSince}d since contact` : ''
        return `  - [${stageLabels[l.stage]||l.stage}] ${l.name}${l.company?' @ '+l.company:''} · ${value} · ${l.lead_type==='ppl'?'PPL':'Managed Ads'} · Last: ${lastContact}${urgency}\n    Notes: ${l.notes||'none'}`
      })
      const counts = sorted.reduce((acc: Record<string,number>, l: any) => { acc[l.stage]=(acc[l.stage]||0)+1; return acc }, {})
      out += `\n\n## Full Active Sales Pipeline (${leads.length} leads)\n${lines.join('\n')}`
      out += `\n\n### Counts by Stage\n${Object.entries(counts).map(([s,n]) => `  - ${stageLabels[s]||s}: ${n}`).join('\n')}`
      out += `\n\n### Total Pipeline Value\n  $${sorted.reduce((s: number, l: any) => s+(l.value||0),0).toLocaleString()}/mo across ${leads.length} leads`
    } else {
      out += '\n\n## Sales Pipeline\nNo active leads in pipeline.'
    }
  } catch(_) { out += '\n\n## Sales Pipeline\nUnable to load pipeline data.' }

  // ── Meta Campaigns — MTD performance (primary ad spend source) ──
  try {
    const { data: campaigns } = await sb.from('meta_campaigns')
      .select('name,status,spend_mtd,leads_mtd,cpl_mtd,clicks_mtd,last_synced_at')
      .order('name')
    if (campaigns && campaigns.length) {
      const active = campaigns.filter((c: any) => c.status === 'ACTIVE')
      const paused = campaigns.filter((c: any) => c.status === 'PAUSED')
      const totalSpendMTD = campaigns.reduce((s: number, c: any) => s + (Number(c.spend_mtd)||0), 0)
      const totalLeadsMTD = campaigns.reduce((s: number, c: any) => s + (Number(c.leads_mtd)||0), 0)
      const lastSync = campaigns.find((c: any) => c.last_synced_at)?.last_synced_at
      out += `\n\n### Meta Ad Campaign Performance — MTD (${monthLabel})`
      out += `\n(These are month-to-date TOTALS for ${monthLabel}, not daily figures)`
      out += `\n- Campaigns: ${active.length} active, ${paused.length} paused (${campaigns.length} total)`
      out += `\n- Total ad spend MTD: ${fmtN(totalSpendMTD)}`
      out += `\n- Total leads generated MTD: ${totalLeadsMTD}`
      out += `\n- Blended CPL MTD: ${totalLeadsMTD > 0 ? fmtC(totalSpendMTD / totalLeadsMTD) : 'n/a'}`
      if (lastSync) out += `\n- Stats last synced from Meta: ${new Date(lastSync).toLocaleString('en-AU', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`
      out += `\n\nIndividual campaign breakdown (MTD totals):`
      campaigns.forEach((c: any) => {
        const spend = Number(c.spend_mtd)||0
        const leads = Number(c.leads_mtd)||0
        const cpl = leads > 0 ? fmtC(spend/leads) : 'n/a'
        out += `\n- ${c.name} [${c.status}]: spend ${fmtN(spend)} MTD · ${leads} leads MTD · CPL ${cpl}`
      })
    } else {
      out += `\n\n### Meta Ad Campaigns\nNo campaigns configured yet.`
    }
  } catch(_) {}

  // ── Historical YTD ad spend (from daily records) ──
  try {
    const { data: adRows } = await sb.from('ad_spend_daily').select('date,account_type,spend,leads').gte('date', yr).order('date', {ascending:false})
    if (adRows && adRows.length) {
      const ppl = adRows.filter((r: any) => r.account_type === 'solar_ppl')
      const agency = adRows.filter((r: any) => r.account_type === 'agency')
      const pplSpend = ppl.reduce((s: number, r: any) => s + (r.spend||0), 0)
      const pplLeads = ppl.reduce((s: number, r: any) => s + (r.leads||0), 0)
      const agencySpend = agency.reduce((s: number, r: any) => s + (r.spend||0), 0)
      out += `\n\n### Historical Ad Spend — YTD Total (${yr.slice(0,4)}, summed from ${adRows.length} daily records)`
      out += `\n(These are YEAR-TO-DATE cumulative totals, not daily figures)`
      out += `\n- Solar PPL spend YTD: ${fmtN(pplSpend)} · ${pplLeads} total leads · avg CPL ${pplLeads > 0 ? fmtC(pplSpend/pplLeads) : 'n/a'}`
      out += `\n- Agency acquisition spend YTD: ${fmtN(agencySpend)}`
    }
  } catch(_) {}

  // ── Active PPL clients ──
  try {
    const { data: pplClients } = await sb.from('clients').select('company_name,leads_delivered,total_leads_purchased,meta_cpl,true_cpl,pct_sold,lead_price,balance').eq('type','ppl').eq('stage','active_client').order('company_name')
    if (pplClients && pplClients.length) {
      out += '\n\n### Active PPL Clients'
      pplClients.forEach((c: any) => {
        out += `\n- ${c.company_name}: ${c.leads_delivered||0} delivered · ${c.total_leads_purchased||0} purchased · Meta CPL ${fmtC(c.meta_cpl)} · True CPL ${fmtC(c.true_cpl)} · ${c.pct_sold||0}% sold · $${c.lead_price||0}/lead · balance ${fmtN(c.balance)}`
      })
    }
  } catch(_) {}

  // ── Active Managed Ads clients ──
  try {
    const { data: mgClients } = await sb.from('clients').select('company_name,management_fee,leads_delivered,stage').eq('type','managed').eq('stage','active').order('company_name')
    if (mgClients && mgClients.length) {
      out += '\n\n### Active Managed Ads Clients'
      mgClients.forEach((c: any) => {
        out += `\n- ${c.company_name}: ${fmtN(c.management_fee)}/mo retainer fee`
      })
    }
  } catch(_) {}

  return out
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const { agent, messages } = await req.json()

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "ANTHROPIC_API_KEY secret not set" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const baseSystem = buildSystemPrompt(agent)

    if (!baseSystem) {
      return new Response(
        JSON.stringify({ error: { message: "Unknown agent" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Build context server-side
    const context = await buildContext(agent)
    const system = baseSystem + context

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data.error || { message: `Anthropic API error ${response.status}` } }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error"
    return new Response(
      JSON.stringify({ error: { message } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
