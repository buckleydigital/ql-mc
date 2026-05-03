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
  const fmtN = (n: number | null | undefined) => (n != null && n !== 0) ? '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0}) : 'n/a'
  const fmtC = (n: number | null | undefined) => (n != null && n > 0) ? '$' + Number(n).toFixed(2) : 'n/a'
  const now = new Date()
  const yr = now.getFullYear() + '-01-01'
  const monthStart = now.toISOString().slice(0,7) + '-01'   // YYYY-MM-01
  const monthEnd   = now.toISOString().slice(0,10)           // today (inclusive upper bound)
  const monthLabel = now.toLocaleString('en-AU', {month:'long', year:'numeric'})
  const today = now.toISOString().split('T')[0]
  const curPeriod = now.toISOString().slice(0,7)            // YYYY-MM
  const yrMonth   = `${now.getFullYear()}-01`
  const todayMs   = Date.now()

  let out = `\n\n## Live Data Context — ${now.toLocaleString('en-AU', {weekday:'long', day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'})}`

  // ── Agent configuration files ────────────────────────────────────────────
  try {
    const { data: files, error } = await sb.from('agent_files').select('filename,content').eq('agent', 'master')
    if (error) console.error('vapi-context agent_files:', error.message)
    if (files && files.length) {
      out += '\n\n## Agent Configuration'
      files.forEach((f: any) => { out += `\n### ${f.filename}\n${f.content}` })
    }
  } catch(e: any) { console.error('vapi-context agent_files exception:', e?.message) }

  // ── Tasks — full open list ───────────────────────────────────────────────
  try {
    const { data: tasks, error } = await sb.from('tasks')
      .select('title,due_date,priority,status,notes')
      .in('status', ['todo','in_progress'])
      .order('due_date', {ascending: true, nullsFirst: false})
    if (error) console.error('vapi-context tasks:', error.message)
    if (tasks && tasks.length) {
      const overdue   = tasks.filter((t: any) => t.due_date && t.due_date < today)
      const dueToday  = tasks.filter((t: any) => t.due_date === today)
      const upcoming  = tasks.filter((t: any) => !t.due_date || t.due_date > today)
      out += `\n\n## Open Tasks (${tasks.length} total)`
      if (overdue.length)  out += `\n⚠ OVERDUE (${overdue.length}): ${overdue.map((t: any) => `${t.title} [due ${t.due_date}]`).join(' | ')}`
      if (dueToday.length) out += `\n• DUE TODAY (${dueToday.length}): ${dueToday.map((t: any) => t.title).join(' | ')}`
      if (upcoming.length) {
        out += `\n• UPCOMING:`
        upcoming.slice(0,20).forEach((t: any) => {
          out += `\n  - [${t.priority||'normal'}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}${t.notes ? ` — ${t.notes}` : ''}`
        })
      }
    } else {
      out += '\n\n## Open Tasks\n- No open tasks.'
    }
  } catch(e: any) { console.error('vapi-context tasks exception:', e?.message) }

  // ── Daily notes — last 14 days ───────────────────────────────────────────
  try {
    const fortnight = new Date(now); fortnight.setDate(fortnight.getDate() - 14)
    const { data: notes, error } = await sb.from('daily_notes')
      .select('date,category,content')
      .gte('date', fortnight.toISOString().split('T')[0])
      .order('date', {ascending: false})
      .limit(30)
    if (error) console.error('vapi-context daily_notes:', error.message)
    if (notes && notes.length) {
      out += `\n\n## Recent Daily Notes (last 14 days)`
      notes.forEach((n: any) => {
        out += `\n- [${n.date}]${n.category && n.category !== 'general' ? ` [${n.category}]` : ''} ${n.content}`
      })
    }
  } catch(e: any) { console.error('vapi-context daily_notes exception:', e?.message) }

  // ── Monthly goals — current month ────────────────────────────────────────
  try {
    const { data: goals, error } = await sb.from('monthly_goals')
      .select('month,revenue_goal,margin_goal,notes')
      .eq('month', curPeriod)
      .maybeSingle()
    if (error) console.error('vapi-context monthly_goals:', error.message)
    if (goals) {
      out += `\n\n## Monthly Goals — ${monthLabel}`
      if (goals.revenue_goal) out += `\n- Revenue target: ${fmtN(goals.revenue_goal)}`
      if (goals.margin_goal)  out += `\n- Margin target: ${fmtN(goals.margin_goal)}`
      if (goals.notes)        out += `\n- Notes: ${goals.notes}`
    }
  } catch(e: any) { console.error('vapi-context monthly_goals exception:', e?.message) }

  // ── PPL clients — ALL with full metrics ──────────────────────────────────
  try {
    const { data: pplClients, error } = await sb.from('clients')
      .select('id,company_name,contact_name,email,phone,leads_delivered,total_leads_purchased,meta_cpl,true_cpl,pct_sold,lead_price,balance,stage,cx_score,weekly_cap,monthly_cap,postcodes,niche,delivery_method')
      .eq('type','ppl')
      .order('company_name')
    if (error) console.error('vapi-context ppl_clients:', error.message)
    if (pplClients && pplClients.length) {
      const active    = pplClients.filter((c: any) => c.stage === 'active_client')
      const inactive  = pplClients.filter((c: any) => c.stage !== 'active_client')
      const totalRetainer = active.reduce((s: number, c: any) => s + (c.lead_price||0) * (c.total_leads_purchased||0), 0)
      out += `\n\n## PPL Clients — ${active.length} active, ${pplClients.length} total`
      out += `\n\n### Active PPL Clients`
      active.forEach((c: any) => {
        const remaining = (c.total_leads_purchased||0) - (c.leads_delivered||0)
        out += `\n- ${c.company_name}${c.contact_name?` (${c.contact_name})`:''}${c.phone?` · ph: ${c.phone}`:''}${c.email?` · em: ${c.email}`:''}`
        out += `\n  Leads: ${c.leads_delivered||0} delivered / ${c.total_leads_purchased||0} purchased (${remaining} remaining) · $${c.lead_price||0}/lead`
        out += `\n  Meta CPL: ${fmtC(c.meta_cpl)} · True CPL: ${fmtC(c.true_cpl)} · Sold: ${c.pct_sold||0}% · Balance: ${fmtN(c.balance)}`
        if (c.cx_score != null) out += ` · CX Score: ${c.cx_score}/10`
        if (c.weekly_cap) out += ` · Weekly cap: ${c.weekly_cap}`
        if (c.monthly_cap) out += ` · Monthly cap: ${c.monthly_cap}`
        if (c.delivery_method) out += ` · Delivery: ${c.delivery_method}`
      })
      if (inactive.length) {
        out += `\n\n### Inactive PPL Clients (${inactive.length})`
        inactive.forEach((c: any) => {
          out += `\n- ${c.company_name} [${c.stage}] · ${c.leads_delivered||0}/${c.total_leads_purchased||0} delivered`
        })
      }
    }
  } catch(e: any) { console.error('vapi-context ppl_clients exception:', e?.message) }

  // ── Managed clients — ALL with full metrics ──────────────────────────────
  try {
    const { data: mgClients, error } = await sb.from('clients')
      .select('id,company_name,contact_name,email,phone,management_fee,monthly_budget,ad_account_id,stage,cx_score,start_date,next_payment_date,last_payment_date')
      .eq('type','managed')
      .order('company_name')
    if (error) console.error('vapi-context managed_clients:', error.message)
    if (mgClients && mgClients.length) {
      const active   = mgClients.filter((c: any) => c.stage === 'active')
      const inactive = mgClients.filter((c: any) => c.stage !== 'active')
      const totalRetainer = active.reduce((s: number, c: any) => s + (c.management_fee||0), 0)
      out += `\n\n## Managed Clients — ${active.length} active, ${mgClients.length} total · Total retainer: ${fmtN(totalRetainer)}/mo`
      out += `\n\n### Active Managed Clients`
      active.forEach((c: any) => {
        out += `\n- ${c.company_name}${c.contact_name?` (${c.contact_name})`:''}${c.phone?` · ph: ${c.phone}`:''}${c.email?` · em: ${c.email}`:''}`
        out += `\n  Fee: ${fmtN(c.management_fee)}/mo · Budget: ${fmtN(c.monthly_budget)}/mo`
        if (c.cx_score != null) out += ` · CX Score: ${c.cx_score}/10`
        if (c.next_payment_date) out += ` · Next payment: ${c.next_payment_date}`
        if (c.last_payment_date) out += ` · Last paid: ${c.last_payment_date}`
      })
      if (inactive.length) {
        out += `\n\n### Inactive Managed Clients (${inactive.length})`
        inactive.forEach((c: any) => {
          out += `\n- ${c.company_name} [${c.stage}] · ${fmtN(c.management_fee)}/mo`
        })
      }
    }
  } catch(e: any) { console.error('vapi-context managed_clients exception:', e?.message) }

  // ── PPL order log — all in-progress orders ───────────────────────────────
  try {
    const { data: pplOrders, error } = await sb.from('ppl_order_log')
      .select('id,client_id,leads_qty,lead_price,order_date,status,sla_due_date,purchase_date,clients(company_name)')
      .in('status', ['in_progress','pending'])
      .order('order_date', {ascending: false})
    if (error) console.error('vapi-context ppl_order_log:', error.message)
    if (pplOrders && pplOrders.length) {
      const overdueSLA = pplOrders.filter((o: any) => o.sla_due_date && o.sla_due_date < today)
      out += `\n\n## Active PPL Orders (${pplOrders.length})`
      if (overdueSLA.length) out += ` — ⚠ ${overdueSLA.length} SLA OVERDUE`
      pplOrders.forEach((o: any) => {
        const client = (o.clients as any)?.company_name || o.client_id
        const sla = o.sla_due_date ? ` · SLA: ${o.sla_due_date}${o.sla_due_date < today ? ' ⚠ OVERDUE' : ''}` : ''
        out += `\n- ${client}: ${o.leads_qty} leads · $${o.lead_price||0}/lead · ordered ${o.order_date}${sla} [${o.status}]`
      })
    }
  } catch(e: any) { console.error('vapi-context ppl_order_log exception:', e?.message) }

  // ── PPL leads distribution pipeline — this month stats ──────────────────
  try {
    const { data: pplLeads, error } = await sb.from('ppl_leads')
      .select('status,lead_type,assigned_client_id')
      .gte('created_at', monthStart)
    if (error) console.error('vapi-context ppl_leads:', error.message)
    if (pplLeads && pplLeads.length) {
      const byStatus: Record<string,number> = {}
      pplLeads.forEach((l: any) => { byStatus[l.status] = (byStatus[l.status]||0)+1 })
      const total = pplLeads.length
      out += `\n\n## PPL Leads Distribution — ${monthLabel} MTD (${total} received)`
      out += `\n- ${Object.entries(byStatus).map(([s,n]) => `${s}: ${n}`).join(' · ')}`
    }
    // All-time total
    const { count: totalAllTime } = await sb.from('ppl_leads').select('id', {count:'exact', head:true})
    if (totalAllTime) out += ` · All-time total: ${totalAllTime}`
  } catch(e: any) { console.error('vapi-context ppl_leads exception:', e?.message) }

  // ── Managed order log — this month ──────────────────────────────────────
  try {
    const { data: mgOrders, error } = await sb.from('managed_order_log')
      .select('description,amount,order_date,clients(company_name)')
      .gte('order_date', monthStart)
      .lte('order_date', monthEnd)
      .order('order_date', {ascending: false})
    if (error) console.error('vapi-context managed_order_log:', error.message)
    if (mgOrders && mgOrders.length) {
      const totalMgRevenue = mgOrders.reduce((s: number, o: any) => s + (o.amount||0), 0)
      out += `\n\n## Managed Billing — ${monthLabel} MTD`
      out += `\n- Total billed: ${fmtN(totalMgRevenue)} across ${mgOrders.length} order(s)`
      mgOrders.forEach((o: any) => {
        const client = (o.clients as any)?.company_name || 'Unknown'
        out += `\n  - ${client}: ${fmtN(o.amount)} — ${o.description} [${o.order_date}]`
      })
    }
  } catch(e: any) { console.error('vapi-context managed_order_log exception:', e?.message) }

  // ── Expenses — MTD ───────────────────────────────────────────────────────
  try {
    const { data: expenses, error } = await sb.from('expenses')
      .select('category,description,amount,type,date')
      .gte('date', monthStart)
      .lte('date', monthEnd)
      .order('date', {ascending: false})
    if (error) console.error('vapi-context expenses:', error.message)
    if (expenses && expenses.length) {
      const totalExpenses = expenses.reduce((s: number, e: any) => s + (e.amount||0), 0)
      const byCategory: Record<string,number> = {}
      expenses.forEach((e: any) => { byCategory[e.category||'other'] = (byCategory[e.category||'other']||0) + (e.amount||0) })
      out += `\n\n## Expenses — ${monthLabel} MTD`
      out += `\n- Total: ${fmtN(totalExpenses)} across ${expenses.length} item(s)`
      out += `\n- By category: ${Object.entries(byCategory).map(([c,a]) => `${c}: ${fmtN(a)}`).join(' · ')}`
      expenses.slice(0,15).forEach((e: any) => {
        out += `\n  - ${e.category||'other'}: ${fmtN(e.amount)}${e.description ? ` — ${e.description}` : ''} [${e.type||'variable'}]`
      })
    } else {
      out += `\n\n## Expenses — ${monthLabel} MTD\n- No expenses recorded this month.`
    }
  } catch(e: any) { console.error('vapi-context expenses exception:', e?.message) }

  // ── Subscriptions — recurring costs ─────────────────────────────────────
  try {
    const { data: subs, error } = await sb.from('subscriptions')
      .select('name,monthly_cost,active')
      .order('active', {ascending: false})
    if (error) console.error('vapi-context subscriptions:', error.message)
    if (subs && subs.length) {
      const active = subs.filter((s: any) => s.active)
      const totalMonthlyCost = active.reduce((s: number, sub: any) => s + (sub.monthly_cost||0), 0)
      out += `\n\n## Subscriptions / Recurring Costs`
      out += `\n- ${active.length} active · Total: ${fmtN(totalMonthlyCost)}/mo`
      active.forEach((s: any) => { out += `\n  - ${s.name}: ${fmtN(s.monthly_cost)}/mo` })
      const inactive = subs.filter((s: any) => !s.active)
      if (inactive.length) out += `\n- ${inactive.length} inactive: ${inactive.map((s: any) => s.name).join(', ')}`
    }
  } catch(e: any) { console.error('vapi-context subscriptions exception:', e?.message) }

  // ── Meta campaigns — MTD with per-campaign breakdown ────────────────────
  try {
    const { data: campaigns, error } = await sb.from('meta_campaigns')
      .select('name,status,spend_mtd,leads_mtd,cpl_mtd,clicks_mtd,last_synced_at,notes')
      .order('status')
      .order('name')
    if (error) console.error('vapi-context meta_campaigns:', error.message)
    if (campaigns && campaigns.length) {
      const active       = campaigns.filter((c: any) => c.status === 'ACTIVE')
      const totalSpend   = campaigns.reduce((s: number, c: any) => s + (Number(c.spend_mtd)||0), 0)
      const totalLeads   = campaigns.reduce((s: number, c: any) => s + (Number(c.leads_mtd)||0), 0)
      const lastSync     = campaigns.find((c: any) => c.last_synced_at)?.last_synced_at
      out += `\n\n## Meta Campaigns — ${monthLabel} MTD`
      out += `\n- ${active.length} active, ${campaigns.length} total · Spend MTD: ${fmtN(totalSpend)} · Leads MTD: ${totalLeads} · Blended CPL: ${totalLeads > 0 ? fmtC(totalSpend/totalLeads) : 'n/a'}`
      if (lastSync) out += ` · Last synced: ${new Date(lastSync).toLocaleString('en-AU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`
      out += '\n'
      campaigns.forEach((c: any) => {
        const spend  = Number(c.spend_mtd)||0
        const leads  = Number(c.leads_mtd)||0
        const cpl    = leads > 0 ? fmtC(spend/leads) : 'n/a'
        out += `\n- [${c.status}] ${c.name}: spend ${fmtN(spend)} · ${leads} leads · CPL ${cpl}${c.notes?` · ${c.notes}`:''}`
      })
    }
  } catch(e: any) { console.error('vapi-context meta_campaigns exception:', e?.message) }

  // ── Ad spend YTD ─────────────────────────────────────────────────────────
  try {
    const [spendLogR, agencyR] = await Promise.all([
      sb.from('campaign_spend_log').select('spend,leads').gte('period', yrMonth).lte('period', curPeriod),
      sb.from('ad_spend_daily').select('spend').eq('account_type','agency').gte('date', yr).order('date', {ascending:false}).limit(1),
    ])
    if (spendLogR.error) console.error('vapi-context campaign_spend_log:', spendLogR.error.message)
    if (agencyR.error)   console.error('vapi-context ad_spend_daily:', agencyR.error.message)
    const spendLog      = spendLogR.data || []
    const campSpendYTD  = spendLog.reduce((s: number, r: any) => s + (r.spend||0), 0)
    const campLeadsYTD  = spendLog.reduce((s: number, r: any) => s + (r.leads||0), 0)
    const agencySpendYTD = agencyR.data?.[0]?.spend || 0
    out += `\n\n## Ad Spend — YTD (${now.getFullYear()})`
    out += `\n- Campaign spend: ${fmtN(campSpendYTD)} · ${campLeadsYTD} leads · avg CPL ${campLeadsYTD > 0 ? fmtC(campSpendYTD/campLeadsYTD) : 'n/a'}`
    if (agencySpendYTD) out += `\n- Agency acquisition spend: ${fmtN(agencySpendYTD)}`
  } catch(e: any) { console.error('vapi-context ad_spend_ytd exception:', e?.message) }

  // ── Sales pipeline (CRM leads) — full per-lead detail ───────────────────
  try {
    const stageLabels: Record<string,string> = {call_back:'Call Back',proposal:'Proposal',proposal_sent:'Proposal Sent',qualified:'Qualified',new_lead:'New Lead',no_answer:'No Answer',paused:'Paused',onboarding:'Onboarding',closed_won:'Closed Won',closed_lost:'Closed Lost'}
    const stageOrder:  Record<string,number>  = {call_back:1,proposal:2,proposal_sent:2,qualified:3,new_lead:4,no_answer:5,paused:6,onboarding:1}
    const CLOSED = new Set(['closed_won','closed_lost'])
    const ACTIVE_STAGES = ['new_lead','no_answer','call_back','proposal','qualified','onboarding','proposal_sent','paused']

    const [activeR, nullR, closedR] = await Promise.all([
      sb.from('leads').select('name,company,email,phone,stage,lead_type,value,source,notes,last_contact,next_followup,updated_at').in('stage', ACTIVE_STAGES).order('updated_at',{ascending:false}),
      sb.from('leads').select('name,company,email,phone,stage,lead_type,value,source,notes,last_contact,next_followup,updated_at').is('stage', null).order('updated_at',{ascending:false}),
      sb.from('leads').select('name,company,phone,email,stage,value').in('stage',['closed_won','closed_lost']).order('updated_at',{ascending:false}).limit(50),
    ])
    if (activeR.error) console.error('vapi-context leads active:', activeR.error.message)

    const active = [...(activeR.data||[]), ...(nullR.data||[])].sort((a: any, b: any) => {
      const so = (stageOrder[a.stage||'']||9) - (stageOrder[b.stage||'']||9)
      return so !== 0 ? so : (b.value||0) - (a.value||0)
    })
    const closed = closedR.data || []
    const totalValue       = active.reduce((s: number, l: any) => s+(l.value||0), 0)
    const followupOverdue  = active.filter((l: any) => l.last_contact && (todayMs-new Date(l.last_contact).getTime())/86400000 > 7).length
    const neverContacted   = active.filter((l: any) => !l.last_contact).length

    out += `\n\n## Sales Pipeline (CRM) — ${active.length} active leads · ${fmtN(totalValue)}/mo pipeline value`
    if (followupOverdue) out += ` · ⚠ ${followupOverdue} not contacted in 7+ days`
    if (neverContacted)  out += ` · ${neverContacted} never contacted`

    const counts: Record<string,number> = {}
    active.forEach((l: any) => { const k=l.stage||'new_lead'; counts[k]=(counts[k]||0)+1 })
    out += `\n- By stage: ${Object.entries(counts).map(([s,n])=>`${stageLabels[s]||s}: ${n}`).join(' · ')}`

    out += `\n\n### Active Leads (${active.length})`
    active.forEach((l: any) => {
      const stage      = stageLabels[l.stage||''] || l.stage || 'New Lead'
      const dsc        = l.last_contact ? Math.floor((todayMs-new Date(l.last_contact).getTime())/86400000) : null
      const contactAge = dsc != null ? `last contact ${dsc}d ago` : 'never contacted'
      const followup   = l.next_followup ? ` · followup ${l.next_followup}` : ''
      const phone      = l.phone ? ` · ph: ${l.phone}` : ''
      const email      = l.email ? ` · em: ${l.email}` : ''
      const notes      = l.notes ? ` · notes: ${l.notes}` : ''
      const type       = l.lead_type === 'ppl' ? ' [PPL]' : l.lead_type === 'managed' ? ' [Managed]' : ''
      out += `\n- ${l.name||'Unknown'}${l.company?` (${l.company})`:''}${type}${phone}${email} | ${stage} | ${contactAge}${followup}${l.value?` | ${fmtN(l.value)}/mo`:''}${notes}`
    })

    if (closed.length) {
      out += `\n\n### Closed Leads (${closed.length} most recent)`
      closed.forEach((l: any) => {
        out += `\n- ${l.name||'Unknown'}${l.company?` (${l.company})`:''}${l.phone?` · ph: ${l.phone}`:''}${l.email?` · em: ${l.email}`:''} | ${stageLabels[l.stage||'']||l.stage}${l.value?` | ${fmtN(l.value)}/mo`:''}`
      })
    }
  } catch(e: any) { console.error('vapi-context leads exception:', e?.message) }

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
    const vapiPublicKey = Deno.env.get("VAPI_PUBLIC_KEY") || Deno.env.get("VAPI_API_KEY") || null
    // ElevenLabs voice ID — passed as an inline voice override in the VAPI call.
    // No pre-created VAPI assistant is needed; the assistant is configured inline.
    // Set ELEVENLABS_VOICE_ID as a Supabase edge function secret.
    const elevenLabsVoiceId = Deno.env.get("ELEVENLABS_VOICE_ID") || null
    // Custom LLM URL: points to the vapi-llm edge function which proxies to Anthropic.
    // This means no OpenAI (or any external) API key needs to be set in the VAPI dashboard.
    const customLlmUrl = supabaseUrl ? `${supabaseUrl}/functions/v1/vapi-llm` : null
    return new Response(JSON.stringify({ systemPrompt, vapiPublicKey, elevenLabsVoiceId, customLlmUrl }), {
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
