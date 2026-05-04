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

## ⚠ Data Freshness — Critical
The "Live Dashboard Context" section below is queried fresh from the live database on EVERY message. It is ALWAYS the authoritative ground truth. Any lead counts, pipeline figures, or financial data mentioned in previous conversation messages may be from earlier sessions with stale snapshots — IGNORE them. Always report the live figures from the current context section, never from memory or chat history.

## Instructions
Be concise, direct and data-driven. Lead with numbers and specific names/actions. Never invent or estimate figures — if data is unavailable, say so. Flag anomalies, cold leads (7+ days no contact), and quick wins.`

    default:
      return null
  }
}

async function buildContext(agent: string): Promise<string> {
  const sb = createClient(supabaseUrl, supabaseServiceKey)
  const fmtN = (n: number | null | undefined) => (n != null && n !== 0) ? '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0}) : 'n/a'
  const fmtC = (n: number | null | undefined) => (n != null && n > 0) ? '$' + Number(n).toFixed(2) : 'n/a'
  const now = new Date()
  const yr = now.getFullYear() + '-01-01'
  const monthLabel = now.toLocaleString('en-AU', {month:'long', year:'numeric'})
  const monthStart = now.toISOString().slice(0,7) + '-01'
  const monthEnd   = now.toISOString().slice(0,10)
  const today      = monthEnd
  const curPeriod  = now.toISOString().slice(0,7)
  const yrMonth    = `${now.getFullYear()}-01`
  const todayMs    = Date.now()
  let out = `\n\n## Live Dashboard Context — ${now.toLocaleString('en-AU', {weekday:'long', day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'})}`

  // ── Agent configuration files ──────────────────────────────────────────
  try {
    const { data: files, error } = await sb.from('agent_files').select('filename,content').eq('agent', agent)
    if (error) console.error('anthropic-proxy agent_files:', error.message)
    if (files && files.length) {
      out += '\n\n## Agent Configuration Files'
      files.forEach((f: any) => { out += `\n### ${f.filename}\n${f.content}` })
    }
  } catch(e: any) { console.error('anthropic-proxy agent_files exception:', e?.message) }

  // ── Tasks — full open list ─────────────────────────────────────────────
  try {
    const { data: tasks, error } = await sb.from('tasks')
      .select('title,due_date,priority,status,notes')
      .in('status', ['todo','in_progress'])
      .order('due_date', {ascending: true, nullsFirst: false})
    if (error) console.error('anthropic-proxy tasks:', error.message)
    if (tasks && tasks.length) {
      const overdue  = tasks.filter((t: any) => t.due_date && t.due_date < today)
      const dueToday = tasks.filter((t: any) => t.due_date === today)
      const upcoming = tasks.filter((t: any) => !t.due_date || t.due_date > today)
      out += `\n\n## Open Tasks (${tasks.length} total)`
      if (overdue.length)  out += `\n⚠ OVERDUE (${overdue.length}): ${overdue.map((t: any) => `${t.title} [due ${t.due_date}]`).join(' | ')}`
      if (dueToday.length) out += `\n• DUE TODAY: ${dueToday.map((t: any) => t.title).join(' | ')}`
      upcoming.forEach((t: any) => {
        out += `\n- [${t.priority||'normal'}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}${t.notes ? ` — ${t.notes}` : ''}`
      })
    } else {
      out += '\n\n## Open Tasks\nNo open tasks.'
    }
  } catch(e: any) { console.error('anthropic-proxy tasks exception:', e?.message) }

  // ── Daily notes — last 14 days ─────────────────────────────────────────
  try {
    const fortnight = new Date(now); fortnight.setDate(fortnight.getDate() - 14)
    const { data: notes, error } = await sb.from('daily_notes')
      .select('date,category,content')
      .gte('date', fortnight.toISOString().split('T')[0])
      .order('date', {ascending: false})
      .limit(40)
    if (error) console.error('anthropic-proxy daily_notes:', error.message)
    if (notes && notes.length) {
      out += `\n\n## Recent Daily Notes (last 14 days)`
      notes.forEach((n: any) => {
        out += `\n- [${n.date}]${n.category && n.category !== 'general' ? ` [${n.category}]` : ''} ${n.content}`
      })
    }
  } catch(e: any) { console.error('anthropic-proxy daily_notes exception:', e?.message) }

  // ── Monthly goals ──────────────────────────────────────────────────────
  try {
    const { data: goals, error } = await sb.from('monthly_goals')
      .select('month,revenue_goal,margin_goal,notes')
      .eq('month', curPeriod)
      .maybeSingle()
    if (error) console.error('anthropic-proxy monthly_goals:', error.message)
    if (goals) {
      out += `\n\n## Monthly Goals — ${monthLabel}`
      if (goals.revenue_goal) out += `\n- Revenue target: ${fmtN(goals.revenue_goal)}`
      if (goals.margin_goal)  out += `\n- Margin target: ${fmtN(goals.margin_goal)}`
      if (goals.notes)        out += `\n- Notes: ${goals.notes}`
    }
  } catch(e: any) { console.error('anthropic-proxy monthly_goals exception:', e?.message) }

  // ── PPL clients — ALL, full detail ────────────────────────────────────
  try {
    const { data: pplClients, error } = await sb.from('clients')
      .select('id,company_name,contact_name,email,phone,leads_delivered,total_leads_purchased,meta_cpl,true_cpl,pct_sold,lead_price,balance,stage,cx_score,weekly_cap,monthly_cap,postcodes,niche,delivery_method,delivery_email,delivery_phone')
      .eq('type','ppl')
      .order('stage').order('company_name')
    if (error) console.error('anthropic-proxy ppl_clients:', error.message)
    if (pplClients && pplClients.length) {
      const active   = pplClients.filter((c: any) => c.stage === 'active_client')
      const inactive = pplClients.filter((c: any) => c.stage !== 'active_client')
      out += `\n\n## PPL Clients — ${active.length} active, ${pplClients.length} total`
      out += `\n\n### Active PPL Clients`
      active.forEach((c: any) => {
        const remaining = (c.total_leads_purchased||0) - (c.leads_delivered||0)
        out += `\n- **${c.company_name}**${c.contact_name?` (${c.contact_name})`:''}${c.phone?` · ph: ${c.phone}`:''}${c.email?` · em: ${c.email}`:''}`
        out += `\n  Leads: ${c.leads_delivered||0} delivered / ${c.total_leads_purchased||0} purchased (${remaining} remaining) · $${c.lead_price||0}/lead`
        out += `\n  Meta CPL: ${fmtC(c.meta_cpl)} · True CPL: ${fmtC(c.true_cpl)} · Sold: ${c.pct_sold||0}% · Balance: ${fmtN(c.balance)}`
        if (c.cx_score != null) out += ` · CX Score: ${c.cx_score}/10`
        if (c.weekly_cap)       out += ` · Weekly cap: ${c.weekly_cap}`
        if (c.monthly_cap)      out += ` · Monthly cap: ${c.monthly_cap}`
        if (c.delivery_method)  out += ` · Delivery: ${c.delivery_method}`
        if (c.delivery_email)   out += ` → ${c.delivery_email}`
        if (c.niche && c.niche !== 'solar') out += ` · Niche: ${c.niche}`
      })
      if (inactive.length) {
        out += `\n\n### Inactive / Prospect PPL Clients (${inactive.length})`
        inactive.forEach((c: any) => {
          out += `\n- ${c.company_name} [${c.stage}]${c.contact_name?` (${c.contact_name})`:''}${c.phone?` · ph: ${c.phone}`:''} · ${c.leads_delivered||0}/${c.total_leads_purchased||0} delivered`
        })
      }
    }
  } catch(e: any) { console.error('anthropic-proxy ppl_clients exception:', e?.message) }

  // ── Managed clients — ALL, full detail ────────────────────────────────
  try {
    const { data: mgClients, error } = await sb.from('clients')
      .select('id,company_name,contact_name,email,phone,management_fee,monthly_budget,ad_account_id,stage,cx_score,start_date,next_payment_date,last_payment_date')
      .eq('type','managed')
      .order('stage').order('company_name')
    if (error) console.error('anthropic-proxy managed_clients:', error.message)
    if (mgClients && mgClients.length) {
      const active   = mgClients.filter((c: any) => c.stage === 'active')
      const inactive = mgClients.filter((c: any) => c.stage !== 'active')
      const totalRetainer = active.reduce((s: number, c: any) => s + (c.management_fee||0), 0)
      out += `\n\n## Managed Clients — ${active.length} active, ${mgClients.length} total · Total retainer: ${fmtN(totalRetainer)}/mo`
      out += `\n\n### Active Managed Clients`
      active.forEach((c: any) => {
        out += `\n- **${c.company_name}**${c.contact_name?` (${c.contact_name})`:''}${c.phone?` · ph: ${c.phone}`:''}${c.email?` · em: ${c.email}`:''}`
        out += `\n  Fee: ${fmtN(c.management_fee)}/mo · Budget: ${fmtN(c.monthly_budget)}/mo`
        if (c.cx_score != null)      out += ` · CX Score: ${c.cx_score}/10`
        if (c.next_payment_date)     out += ` · Next payment: ${c.next_payment_date}`
        if (c.last_payment_date)     out += ` · Last paid: ${c.last_payment_date}`
      })
      if (inactive.length) {
        out += `\n\n### Inactive / Prospect Managed Clients (${inactive.length})`
        inactive.forEach((c: any) => {
          out += `\n- ${c.company_name} [${c.stage}]${c.contact_name?` (${c.contact_name})`:''}${c.phone?` · ph: ${c.phone}`:''} · ${fmtN(c.management_fee)}/mo`
        })
      }
    }
  } catch(e: any) { console.error('anthropic-proxy managed_clients exception:', e?.message) }

  // ── PPL order log — all active/pending ────────────────────────────────
  try {
    const { data: pplOrders, error } = await sb.from('ppl_order_log')
      .select('id,client_id,leads_qty,lead_price,order_date,status,sla_due_date,purchase_date,clients(company_name)')
      .in('status', ['in_progress','pending'])
      .order('order_date', {ascending: false})
    if (error) console.error('anthropic-proxy ppl_order_log:', error.message)
    if (pplOrders && pplOrders.length) {
      const overdueSLA = pplOrders.filter((o: any) => o.sla_due_date && o.sla_due_date < today)
      out += `\n\n## Active PPL Orders (${pplOrders.length})${overdueSLA.length ? ` — ⚠ ${overdueSLA.length} SLA OVERDUE` : ''}`
      pplOrders.forEach((o: any) => {
        const client = (o.clients as any)?.company_name || o.client_id
        const sla = o.sla_due_date ? ` · SLA: ${o.sla_due_date}${o.sla_due_date < today ? ' ⚠ OVERDUE' : ''}` : ''
        out += `\n- ${client}: ${o.leads_qty} leads · $${o.lead_price||0}/lead · ordered ${o.order_date}${sla} [${o.status}]`
      })
    }
  } catch(e: any) { console.error('anthropic-proxy ppl_order_log exception:', e?.message) }

  // ── PPL leads distribution — MTD ──────────────────────────────────────
  try {
    const { data: pplLeads, error } = await sb.from('ppl_leads')
      .select('status,lead_type')
      .gte('created_at', monthStart)
    if (error) console.error('anthropic-proxy ppl_leads:', error.message)
    const byStatus: Record<string,number> = {}
    ;(pplLeads||[]).forEach((l: any) => { byStatus[l.status] = (byStatus[l.status]||0)+1 })
    const { count: totalAllTime } = await sb.from('ppl_leads').select('id', {count:'exact', head:true})
    out += `\n\n## PPL Leads Distribution — ${monthLabel} MTD`
    if (pplLeads && pplLeads.length) {
      out += ` (${pplLeads.length} received this month)`
      out += `\n- ${Object.entries(byStatus).map(([s,n]) => `${s}: ${n}`).join(' · ')}`
    } else {
      out += '\n- No leads received this month.'
    }
    if (totalAllTime) out += `\n- All-time total in database: ${totalAllTime}`
  } catch(e: any) { console.error('anthropic-proxy ppl_leads exception:', e?.message) }

  // ── Managed order log — this month ────────────────────────────────────
  try {
    const { data: mgOrders, error } = await sb.from('managed_order_log')
      .select('description,amount,order_date,clients(company_name)')
      .gte('order_date', monthStart)
      .lte('order_date', monthEnd)
      .order('order_date', {ascending: false})
    if (error) console.error('anthropic-proxy managed_order_log:', error.message)
    if (mgOrders && mgOrders.length) {
      const total = mgOrders.reduce((s: number, o: any) => s + (o.amount||0), 0)
      out += `\n\n## Managed Billing — ${monthLabel} MTD`
      out += `\n- Total billed: ${fmtN(total)} across ${mgOrders.length} order(s)`
      mgOrders.forEach((o: any) => {
        const client = (o.clients as any)?.company_name || 'Unknown'
        out += `\n  - ${client}: ${fmtN(o.amount)} — ${o.description} [${o.order_date}]`
      })
    }
  } catch(e: any) { console.error('anthropic-proxy managed_order_log exception:', e?.message) }

  // ── Expenses — MTD ────────────────────────────────────────────────────
  try {
    const { data: expenses, error } = await sb.from('expenses')
      .select('category,description,amount,type,date')
      .gte('date', monthStart)
      .lte('date', monthEnd)
      .order('date', {ascending: false})
    if (error) console.error('anthropic-proxy expenses:', error.message)
    if (expenses && expenses.length) {
      const total = expenses.reduce((s: number, e: any) => s + (e.amount||0), 0)
      const byCategory: Record<string,number> = {}
      expenses.forEach((e: any) => { byCategory[e.category||'other'] = (byCategory[e.category||'other']||0) + (e.amount||0) })
      out += `\n\n## Expenses — ${monthLabel} MTD`
      out += `\n- Total: ${fmtN(total)} across ${expenses.length} item(s)`
      out += `\n- By category: ${Object.entries(byCategory).map(([c,a]) => `${c}: ${fmtN(a)}`).join(' · ')}`
      expenses.forEach((e: any) => {
        out += `\n  - [${e.type||'variable'}] ${e.category||'other'}: ${fmtN(e.amount)}${e.description ? ` — ${e.description}` : ''} [${e.date}]`
      })
    } else {
      out += `\n\n## Expenses — ${monthLabel} MTD\n- No expenses recorded this month.`
    }
  } catch(e: any) { console.error('anthropic-proxy expenses exception:', e?.message) }

  // ── Subscriptions ──────────────────────────────────────────────────────
  try {
    const { data: subs, error } = await sb.from('subscriptions')
      .select('name,monthly_cost,active')
      .order('active', {ascending: false})
    if (error) console.error('anthropic-proxy subscriptions:', error.message)
    if (subs && subs.length) {
      const active = subs.filter((s: any) => s.active)
      const total  = active.reduce((s: number, sub: any) => s + (sub.monthly_cost||0), 0)
      out += `\n\n## Recurring Subscriptions`
      out += `\n- ${active.length} active · Total: ${fmtN(total)}/mo`
      active.forEach((s: any) => { out += `\n  - ${s.name}: ${fmtN(s.monthly_cost)}/mo` })
      const inactive = subs.filter((s: any) => !s.active)
      if (inactive.length) out += `\n- Inactive (${inactive.length}): ${inactive.map((s: any) => s.name).join(', ')}`
    }
  } catch(e: any) { console.error('anthropic-proxy subscriptions exception:', e?.message) }

  // ── Meta campaigns — MTD per-campaign breakdown ────────────────────────
  try {
    const { data: campaigns, error } = await sb.from('meta_campaigns')
      .select('name,status,spend_mtd,leads_mtd,cpl_mtd,clicks_mtd,last_synced_at,notes')
      .order('status').order('name')
    if (error) console.error('anthropic-proxy meta_campaigns:', error.message)
    if (campaigns && campaigns.length) {
      const active       = campaigns.filter((c: any) => c.status === 'ACTIVE')
      const paused       = campaigns.filter((c: any) => c.status === 'PAUSED')
      const totalSpend   = campaigns.reduce((s: number, c: any) => s + (Number(c.spend_mtd)||0), 0)
      const totalLeads   = campaigns.reduce((s: number, c: any) => s + (Number(c.leads_mtd)||0), 0)
      const lastSync     = campaigns.find((c: any) => c.last_synced_at)?.last_synced_at
      out += `\n\n## Meta Ad Campaigns — ${monthLabel} MTD`
      out += `\n(Month-to-date TOTALS — not daily figures)`
      out += `\n- ${active.length} active, ${paused.length} paused (${campaigns.length} total)`
      out += `\n- Total spend MTD: ${fmtN(totalSpend)} · Leads MTD: ${totalLeads} · Blended CPL: ${totalLeads > 0 ? fmtC(totalSpend/totalLeads) : 'n/a'}`
      if (lastSync) out += `\n- Last synced from Meta: ${new Date(lastSync).toLocaleString('en-AU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`
      out += '\n'
      campaigns.forEach((c: any) => {
        const spend = Number(c.spend_mtd)||0
        const leads = Number(c.leads_mtd)||0
        const cpl   = leads > 0 ? fmtC(spend/leads) : 'n/a'
        out += `\n- [${c.status}] ${c.name}: spend ${fmtN(spend)} · ${leads} leads · CPL ${cpl}${c.notes?` · ${c.notes}`:''}`
      })
    } else {
      out += `\n\n## Meta Ad Campaigns\nNo campaigns configured yet.`
    }
  } catch(e: any) { console.error('anthropic-proxy meta_campaigns exception:', e?.message) }

  // ── Ad spend YTD ──────────────────────────────────────────────────────
  // campaign_spend_log: monthly PPL campaign spend (matches Financials page)
  // ad_spend_daily: each row is a CUMULATIVE YTD total — take latest row only
  try {
    const [spendLogR, agencyR] = await Promise.all([
      sb.from('campaign_spend_log').select('spend,leads').gte('period', yrMonth).lte('period', curPeriod),
      sb.from('ad_spend_daily').select('spend').eq('account_type','agency').gte('date', yr).order('date', {ascending:false}).limit(1),
    ])
    if (spendLogR.error) console.error('anthropic-proxy campaign_spend_log:', spendLogR.error.message)
    if (agencyR.error)   console.error('anthropic-proxy ad_spend_daily:', agencyR.error.message)
    const spendLogRows  = spendLogR.data || []
    const campSpendYTD  = spendLogRows.reduce((s: number, r: any) => s + (r.spend||0), 0)
    const campLeadsYTD  = spendLogRows.reduce((s: number, r: any) => s + (r.leads||0), 0)
    const agencySpendYTD = agencyR.data?.[0]?.spend || 0
    out += `\n\n## Ad Spend — YTD (${now.getFullYear()})`
    out += `\n(Year-to-date totals matching the Financials page)`
    out += `\n- Campaign spend YTD: ${fmtN(campSpendYTD)} · ${campLeadsYTD} leads · avg CPL ${campLeadsYTD > 0 ? fmtC(campSpendYTD/campLeadsYTD) : 'n/a'}`
    if (agencySpendYTD) out += `\n- Agency acquisition spend YTD: ${fmtN(agencySpendYTD)}`
  } catch(e: any) { console.error('anthropic-proxy ad_spend_ytd exception:', e?.message) }

  // ── Sales pipeline (CRM leads) — every lead, full detail ──────────────
  // Uses a paginated fetch so any server-side max-rows cap cannot truncate
  // the result set. All non-closed leads are fetched regardless of stage value.
  try {
    const stageLabels: Record<string,string> = {call_back:'Call Back',proposal:'Proposal',qualified:'Qualified',new_lead:'New Lead',no_answer:'No Answer',paused:'Paused',onboarding:'Onboarding',proposal_sent:'Proposal Sent',closed_won:'Closed Won',closed_lost:'Closed Lost'}
    const stageOrder:  Record<string,number>  = {call_back:1,proposal:2,proposal_sent:2,qualified:3,new_lead:4,no_answer:5,paused:6,onboarding:1}
    const LEAD_FIELDS = 'id,name,company,email,phone,stage,lead_type,value,source,notes,last_contact,next_followup,created_at,updated_at'

    // Get the definitive total count of ALL leads in the database first.
    const { count: totalLeadCount } = await sb.from('leads').select('id', {count:'exact', head:true})

    // Fetch ALL non-closed leads — paginated to defeat any server-side row cap.
    // Using .not() instead of .in() means leads with any unexpected/legacy stage
    // are still included; only explicitly closed ones are excluded.
    const allActive: any[] = []
    const PAGE = 200
    let from = 0
    while (true) {
      const { data: page, error: pageErr, count: pageTotal } = await sb.from('leads')
        .select(LEAD_FIELDS, {count:'exact'})
        .not('stage', 'in', '(closed_won,closed_lost)')
        .order('updated_at', {ascending:false})
        .range(from, from + PAGE - 1)
      if (pageErr) { console.error('anthropic-proxy leads page:', pageErr.message); break }
      if (!page?.length) break
      allActive.push(...page)
      // If we have the total count, stop as soon as we have all rows
      const knownTotal = pageTotal ?? null
      if (knownTotal !== null && allActive.length >= knownTotal) break
      if (page.length < PAGE) break
      from += PAGE
    }

    // Fetch recently closed leads (last 100) — no pagination needed, hard cap is intentional.
    const { data: closedRaw, error: closedErr } = await sb.from('leads')
      .select('id,name,company,email,phone,stage,value,notes,updated_at')
      .in('stage', ['closed_won','closed_lost'])
      .order('updated_at', {ascending:false})
      .limit(100)
    if (closedErr) console.error('anthropic-proxy leads closed:', closedErr.message)
    const closed = closedRaw || []

    const active = allActive.sort((a: any, b: any) => {
      const so = (stageOrder[a.stage||'']||9) - (stageOrder[b.stage||'']||9)
      return so !== 0 ? so : (b.value||0) - (a.value||0)
    })

    const totalValue      = active.reduce((s: number, l: any) => s+(l.value||0), 0)
    const overdueContact  = active.filter((l: any) => l.last_contact && (todayMs-new Date(l.last_contact).getTime())/86400000 > 7).length
    const neverContacted  = active.filter((l: any) => !l.last_contact).length
    const counts: Record<string,number> = {}
    active.forEach((l: any) => { const k=l.stage||'(no stage)'; counts[k]=(counts[k]||0)+1 })

    out += `\n\n## Sales Pipeline (CRM) — ${active.length} active / ${totalLeadCount ?? '?'} total in DB`
    out += `\n- Total pipeline value: ${fmtN(totalValue)}/mo`
    out += `\n- By stage: ${Object.entries(counts).map(([s,n]) => `${stageLabels[s]||s}: ${n}`).join(' · ')}`
    if (overdueContact) out += `\n- ⚠ ${overdueContact} leads not contacted in 7+ days`
    if (neverContacted) out += `\n- ${neverContacted} leads never contacted`

    out += `\n\n### Active Leads (${active.length}) — sorted by priority stage then value`
    active.forEach((l: any) => {
      const stage      = stageLabels[l.stage||''] || l.stage || '(no stage)'
      const dsc        = l.last_contact ? Math.floor((todayMs-new Date(l.last_contact).getTime())/86400000) : null
      const contactAge = dsc != null ? `last contact ${dsc}d ago${dsc > 7 ? ' ⚠' : ''}` : 'never contacted'
      const followup   = l.next_followup ? ` · followup ${l.next_followup}` : ''
      const phone      = l.phone ? ` · ph: ${l.phone}` : ''
      const email      = l.email ? ` · em: ${l.email}` : ''
      const notes      = l.notes ? `\n  Notes: ${l.notes}` : ''
      const type       = l.lead_type === 'ppl' ? ' [PPL]' : l.lead_type === 'managed' ? ' [Managed]' : ''
      out += `\n- **${l.name||'Unknown'}**${l.company?` @ ${l.company}`:''}${type}${phone}${email}`
      out += `\n  Stage: ${stage} | ${contactAge}${followup}${l.value?` | ${fmtN(l.value)}/mo`:''}${notes}`
    })

    if (closed.length) {
      out += `\n\n### Closed Leads (${closed.length} most recent)`
      closed.forEach((l: any) => {
        out += `\n- ${l.name||'Unknown'}${l.company?` @ ${l.company}`:''}${l.phone?` · ph: ${l.phone}`:''}${l.email?` · em: ${l.email}`:''} | ${stageLabels[l.stage||'']||l.stage}${l.value?` | ${fmtN(l.value)}/mo`:''}${l.notes?` — ${l.notes}`:''}`
      })
    }
  } catch(e: any) { console.error('anthropic-proxy leads exception:', e?.message); out += `\n\n## Sales Pipeline\nERROR loading pipeline data: ${e?.message||'unknown error'}` }

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
        max_tokens: 8192,
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
