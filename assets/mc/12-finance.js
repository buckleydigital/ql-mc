'use strict';

function nextMonthStart(m) {
  const [y,mo]=m.split('-').map(Number);
  return mo===12?`${y+1}-01-01`:`${y}-${String(mo+1).padStart(2,'0')}-01`;
}
async function loadFinance() {
  const val=$('fin-month').value;
  const today=new Date().toISOString().split('T')[0];
  const isYtd = val.startsWith('ytd-');
  const ytdYear = isYtd ? val.split('-')[1] : null;
  const from = isYtd ? `${ytdYear}-01-01` : `${val}-01`;
  // A past year runs to 31 December; this year, to today.
  const pastYear = isYtd && +ytdYear < new Date().getFullYear();
  const next = isYtd ? (pastYear ? `${ytdYear}-12-31` : today) : nextMonthStart(val);
  const monthStart = today.slice(0,7)+'-01';
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth()+1, 1).toISOString().split('T')[0];
  const weekAhead = new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
  const curYear = new Date().getFullYear();
  // Prior period for trend arrows
  let priorFrom, priorNext;
  if (isYtd) {
    priorFrom = `${+ytdYear-1}-01-01`;
    priorNext = `${+ytdYear}-01-01`;
  } else {
    const [py,pm]=val.split('-').map(Number);
    const pd = new Date(py,pm-2,1); // one month back
    priorFrom = `${pd.getFullYear()}-${String(pd.getMonth()+1).padStart(2,'0')}-01`;
    priorNext = from;
  }
  // Build campaign_spend_log period filter: single month or full YTD range (capped at current month)
  const curPeriod = new Date().toISOString().slice(0,7); // YYYY-MM
  let spendLogQ = db.from('campaign_spend_log').select('id,campaign_name,period,spend,leads,source,notes');
  if (isYtd) {
    spendLogQ = spendLogQ.gte('period',`${ytdYear}-01`).lte('period',pastYear ? `${ytdYear}-12` : curPeriod);
  } else {
    spendLogQ = spendLogQ.eq('period', val);
  }
  // Prior period spend log
  let priorSpendLogQ = db.from('campaign_spend_log').select('spend');
  if (isYtd) {
    priorSpendLogQ = priorSpendLogQ.gte('period',`${+ytdYear-1}-01`).lte('period',`${+ytdYear-1}-12`);
  } else {
    const priorPeriod = `${priorFrom.slice(0,7)}`;
    priorSpendLogQ = priorSpendLogQ.eq('period', priorPeriod);
  }
  // For monthly view: also fetch the latest agency row before the period starts so we can
  // compute a delta. Each row in ad_spend_daily stores the exact cumulative YTD spend at
  // that point in time, so the actual spend for a month = (latest row in period) − (latest
  // row before period). For YTD the latest row IS the total, so no prior baseline needed.
  const priorAgQ = isYtd
    ? Promise.resolve({data:[]})
    : db.from('ad_spend_daily').select('spend').eq('account_type','agency').lt('date',from).order('date',{ascending:false}).limit(1);
  const [expR,spR,subR,pplR,mgR,mgOrdR,pplOrdR,spendLogR,priorAgR,priorExpR,priorMgOrdR,priorPplOrdR,priorSpendR,pplOrdMtdR,mgOrdMtdR,ordR,slaOverdueR,goalsR,crmR,pplLeadsR]=await Promise.all([
    db.from('expenses').select('*').gte('date',from).lte('date',next),
    db.from('ad_spend_daily').select('date,account_type,spend,leads').gte('date',from).lt('date',next).order('date',{ascending:false}),
    db.from('subscriptions').select('*').order('created_at'),
    db.from('clients').select('leads_delivered,lead_price,leads_mtd,pct_sold,meta_cpl,true_cpl,stage,total_leads_purchased').eq('type','ppl'),
    db.from('clients').select('id,company_name,management_fee,payments_made,stage,active_months,retainer_payment_dates,retainer_amounts,next_payment_date').eq('type','managed'),
    db.from('managed_order_log').select('client_id,amount,order_date').gte('order_date',from).lte('order_date',next),
    db.from('ppl_order_log').select('leads_qty,lead_price,order_date').gte('order_date',from).lte('order_date',next),
    spendLogQ,
    priorAgQ,
    db.from('expenses').select('amount').gte('date',priorFrom).lte('date',priorNext),
    db.from('managed_order_log').select('amount').gte('order_date',priorFrom).lte('order_date',priorNext),
    db.from('ppl_order_log').select('leads_qty,lead_price').gte('order_date',priorFrom).lte('order_date',priorNext),
    priorSpendLogQ,
    db.from('ppl_order_log').select('leads_qty,lead_price').gte('order_date',monthStart).lt('order_date',monthEnd),
    db.from('managed_order_log').select('amount').gte('order_date',monthStart).lt('order_date',monthEnd),
    db.from('ppl_order_log').select('id,client_id,leads_qty,status,sla_due_date,order_date').eq('status','in_progress'),
    db.from('ppl_order_log').select('id,client_id,leads_qty,sla_due_date,order_date,clients(company_name)').eq('status','in_progress').lte('sla_due_date',today).not('sla_due_date','is',null),
    db.from('monthly_goals').select('revenue_goal,month').gte('month',`${curYear}-01`).lte('month',`${curYear}-12`),
    db.from('leads').select(CRM_FOLLOWUP_COLS).not('stage','in','(closed_won,closed_lost,churned)'),
    db.from('ppl_leads').select('id,status').in('status',['pending','assigned']),
  ]);
  const latestAgSpend = (spR.data||[]).find(a=>a.account_type==='agency')?.spend || 0;
  const priorAgSpend  = priorAgR.data?.[0]?.spend || 0;
  const agSp = isYtd ? latestAgSpend : Math.max(0, latestAgSpend - priorAgSpend);
  // Compute prior period totals for trend arrows
  const priorPplRev = (priorPplOrdR.data||[]).reduce((s,o)=>s+((o.leads_qty||0)*(o.lead_price||0)),0);
  const priorMgCustom = (priorMgOrdR.data||[]).reduce((s,o)=>s+(o.amount||0),0);
  const priorMgRetainer = mgR.data ? (() => {
    const pFrom=priorFrom, pNext=priorNext;
    return (mgR.data||[]).reduce((s,c)=>{
      return s+(c.active_months!=null?mgRetainerSum(c,m=>m+'-01'>=pFrom&&m+'-01'<pNext):0);
    },0);
  })() : 0;
  const priorTotalRev = priorPplRev + priorMgRetainer + priorMgCustom;
  const priorTotalExp = (priorExpR.data||[]).reduce((s,e)=>s+(e.amount||0),0)
    + (priorSpendR.data||[]).reduce((s,e)=>s+(e.spend||0),0);
  // For YTD view, retainer revenue counts every active month in the selected
  // year (not just months that have already started before today). This way,
  // toggling a future retainer month on a managed client immediately flows
  // into the Total Revenue / Retainer Revenue KPIs, which is what users
  // expect when they pre-book retainers for upcoming months. Expense and
  // ad-spend queries continue to cap at `today` (`next`).
  const mgRevNext = isYtd ? `${+ytdYear+1}-01-01` : next;
  // Extras for sections migrated from Command Center
  const curMonthKey = today.slice(0,7);
  const mgRetainerThisMonth = (mgR.data||[]).reduce((s,c)=>{
    return s+mgPayments(c).filter(p=>p.m===curMonthKey).reduce((a,p)=>a+p.amt,0);
  },0);
  const mtdPplRev = (pplOrdMtdR.data||[]).reduce((s,o)=>s+((o.leads_qty||0)*(o.lead_price||0)),0);
  const mtdMgRev = (mgOrdMtdR.data||[]).reduce((s,o)=>s+(o.amount||0),0);
  const mtdRev = mtdPplRev + mtdMgRev + mgRetainerThisMonth;
  const activeOrders = ordR.data||[];
  const overdueOrders = slaOverdueR.data||[];
  const dueSoon = activeOrders.filter(o=>o.sla_due_date&&o.sla_due_date>today&&o.sla_due_date<=weekAhead).length;
  const goals = goalsR.data||[];
  const ytdMonth = today.slice(0,7);
  const ytdGoalRev = goals.filter(g=>g.month<=ytdMonth).reduce((s,g)=>s+(g.revenue_goal||0),0);
  const crmFollowups = (crmR.data||[]).filter(l=>crmNeedsFollowup(l)).length;
  const pendingLeads = (pplLeadsR.data||[]).filter(l=>l.status==='pending').length;
  const extras = {mtdRev,curMonthKey,activeOrders,overdueOrders,dueSoon,ytdGoalRev,crmFollowups,pendingLeads,today,weekAhead};
  renderFinance(expR.data||[],spR.data||[],subR.data||[],pplR.data||[],mgR.data||[],mgOrdR.data||[],pplOrdR.data||[],from,next,spendLogR.data||[],agSp,{priorTotalRev,priorTotalExp,mgRevNext},extras);
}
function renderFinance(expenses,adSpend,subs,pplClients,mgClients,mgOrders,pplOrders,from,next,spendLog=[],agSp=0,prior={},extras={}) {
  const te=expenses.reduce((s,e)=>s+(e.amount||0),0);
  const activeSubs=subs.filter(s=>s.active);
  const ts=activeSubs.length>0?activeSubs.reduce((s,sub)=>s+(sub.monthly_cost||0),0):null;
  renderSubscriptionsTable(subs);
  // Spend and leads from campaign_spend_log (persists even after campaigns are deleted)
  const campSpend=spendLog.reduce((s,e)=>s+(e.spend||0),0);
  const campLeads=spendLog.reduce((s,e)=>s+(e.leads||0),0);
  // agSp is pre-computed in loadFinance as a period delta of the cumulative YTD ad_spend_daily rows
  const pplSp=campSpend;
  const pplLeadsTotal=campLeads;
  const metaCpl=(pplSp>0&&pplLeadsTotal>0)?'$'+(pplSp/pplLeadsTotal).toFixed(2):'-';
  const pplRevLog=pplOrders.reduce((s,o)=>s+((o.leads_qty||0)*(o.lead_price||0)),0);
  const pplRevClients=pplClients.reduce((s,c)=>s+((c.leads_delivered||0)*(c.lead_price||0)),0);
  const pplRev=pplRevLog>0?pplRevLog:pplRevClients;
  const mgRetainerRev=mgClients.reduce((s,c)=>{
    // Cash basis: attribute each active month's fee to the month it was paid.
    // Use prior.mgRevNext (end-of-year for YTD) so retainers paid this year for
    // upcoming months still feed into Total Revenue. Falls back to `next` for
    // monthly views where the upper bound matches the period.
    const mgUpper=prior.mgRevNext||next;
    return s+mgRetainerSum(c,m=>(!from||m+'-01'>=from)&&(!mgUpper||m+'-01'<mgUpper));
  },0);
  // Period-bound retainer (jan-to-today for YTD) - used only for the
  // run-rate annualisation so future-booked months don't artificially
  // inflate the projection.
  const mgRetainerRevPeriod=mgClients.reduce((s,c)=>{
    return s+mgRetainerSum(c,m=>(!from||m+'-01'>=from)&&(!next||m+'-01'<next));
  },0);
  const mgCustomRev=mgOrders.reduce((s,o)=>s+(o.amount||0),0);
  const mgTotalRev=mgRetainerRev+mgCustomRev;
  const tr=pplRev+mgTotalRev;
  const acTrue=pplClients.filter(c=>c.stage==='active_client'&&c.true_cpl>0);
  const trueCpl=acTrue.length?'$'+(acTrue.reduce((s,c)=>s+c.true_cpl,0)/acTrue.length).toFixed(2):'-';
  const totalExp=te+pplSp+agSp;
  const np=tr-totalExp,margin=tr>0?((np/tr)*100).toFixed(1):0;
  setText('fin-rev',fmt(tr));setText('fin-exp',fmt(totalExp));setText('fin-profit',fmt(np));
  $('fin-profit').className=`kval ${np>=0?'grn':'red'}`;
  setText('fin-margin',`${margin}% margin`);setText('fin-subs',ts!==null?fmt(ts):'-');
  setText('fin-ppl-spend',fmt(pplSp));setText('fin-ag-spend',fmt(agSp));setText('fin-mg-spend',mgTotalRev>0?fmt(mgTotalRev):'-');
  setText('fin-meta-cpl',metaCpl);setText('fin-true-cpl',trueCpl);
  setText('fin-ppl-rev',pplRev>0?fmt(pplRev):'-');setText('fin-ppl-margin',pplRev>0?fmt(pplRev-pplSp):'-');
  if ($('fin-mg-rev')) setText('fin-mg-rev',mgTotalRev>0?fmt(mgTotalRev):'-');
  if ($('fin-mg-retainer')) setText('fin-mg-retainer',mgRetainerRev>0?fmt(mgRetainerRev):'-');
  if ($('fin-mg-custom')) setText('fin-mg-custom',mgCustomRev>0?fmt(mgCustomRev):'-');
  // Trend arrows vs prior period
  function trendArrow(cur,prev,higherIsBetter=true) {
    if (prev === 0 || prev == null) return '';
    const pct=((cur-prev)/Math.abs(prev)*100);
    const up=pct>=0;
    const good=(higherIsBetter&&up)||(!higherIsBetter&&!up);
    const color=good?'var(--grn)':'var(--red)';
    const arrow=up?'↑':'↓';
    return `<span style="color:${color};font-weight:600">${arrow} ${Math.abs(pct).toFixed(1)}% vs prior</span>`;
  }
  if($('fin-rev-trend')) $('fin-rev-trend').innerHTML = trendArrow(tr,prior.priorTotalRev,true);
  if($('fin-exp-trend')) $('fin-exp-trend').innerHTML = trendArrow(totalExp,prior.priorTotalExp,false);
  // MRR / ARR / Run Rate
  // MRR = sum of management_fee for all active managed clients (same logic as Command Center).
  const mrr=mgClients.filter(c=>c.stage==='active'||c.stage==='onboarding').reduce((s,c)=>s+(c.management_fee||0),0);
  const arr = mrr * 12;
  // Monthly run rate: annualise current period revenue. Uses the
  // period-bound retainer total so future-booked retainer months don't
  // inflate the run-rate projection.
  const trPeriod = pplRev + mgRetainerRevPeriod + mgCustomRev;
  const periodDays = (new Date(next)-new Date(from))/(1000*60*60*24);
  const runRate = periodDays > 0 ? (trPeriod/periodDays)*30 : 0;
  if($('fin-mrr')) setText('fin-mrr', mrr>0?fmt(mrr):'-');
  if($('fin-arr')) setText('fin-arr', arr>0?fmt(arr):'-');
  if($('fin-run-rate')) setText('fin-run-rate', runRate>0?fmt(runRate):'-');
  if($('fin-run-rate-sub')) setText('fin-run-rate-sub', periodDays>0?`annualised from ${Math.round(periodDays)}d period`:'');
  // MTD Revenue
  const {mtdRev=0,activeOrders=[],overdueOrders=[],dueSoon=0,ytdGoalRev=0,crmFollowups=0,pendingLeads=0,today:_today=''} = extras;
  if($('fin-mtd-rev')) setText('fin-mtd-rev', mtdRev>0?fmt(mtdRev):'-');
  if($('fin-mtd-sub')) setText('fin-mtd-sub', (new Date().toISOString().slice(0,7))+' so far');
  // Clients section
  const activePpl = pplClients.filter(c=>c.stage==='active_client').length;
  const activeMg = mgClients.filter(c=>c.stage==='active'||c.stage==='onboarding').length;
  const curTodayStr = _today || new Date().toISOString().split('T')[0];
  const overduePayments = mgClients.filter(c=>(c.stage==='active'||c.stage==='onboarding')&&c.next_payment_date&&c.next_payment_date<curTodayStr).length;
  const reorderDue = pplClients.filter(c=>c.stage==='active_client'&&(c.total_leads_purchased||0)>0&&(c.leads_delivered||0)>0&&((c.leads_delivered/c.total_leads_purchased)>=0.75)).length;
  if($('fin-ppl-active')) setText('fin-ppl-active', activePpl||'-');
  if($('fin-mg-active-cnt')) setText('fin-mg-active-cnt', activeMg||'-');
  if($('fin-overdue-payments')) {
    setText('fin-overdue-payments', overduePayments||'-');
    $('fin-overdue-payments').className=`kval ${overduePayments>0?'red':'grn'}`;
  }
  if($('fin-reorder-due')) setText('fin-reorder-due', reorderDue||'-');
  // Lead SLA section
  if($('fin-sla-overdue')) {
    setText('fin-sla-overdue', overdueOrders.length||'-');
    $('fin-sla-overdue').className=`kval ${overdueOrders.length>0?'red':'grn'}`;
  }
  if($('fin-orders-active')) setText('fin-orders-active', activeOrders.length||'-');
  if($('fin-sla-week')) setText('fin-sla-week', dueSoon||'-');
  // Goals & Pipeline section
  if($('fin-ytd-goal-pct')) {
    if (ytdGoalRev > 0) {
      const pct = ((mtdRev / ytdGoalRev)*100).toFixed(0);
      setText('fin-ytd-goal-pct', pct+'%');
      $('fin-ytd-goal-pct').className=`kval ${+pct>=100?'grn':+pct>=75?'':'red'}`;
      if($('fin-ytd-goal-sub')) setText('fin-ytd-goal-sub', `MTD ${fmt(mtdRev)} of ${fmt(ytdGoalRev)} goal`);
    } else {
      setText('fin-ytd-goal-pct','-');
      if($('fin-ytd-goal-sub')) setText('fin-ytd-goal-sub','no goals set');
    }
  }
  if($('fin-followups')) {
    setText('fin-followups', crmFollowups||'-');
    $('fin-followups').className=`kval ${crmFollowups>0?'amb':''}`;
  }
  if($('fin-pending-leads')) setText('fin-pending-leads', pendingLeads||'-');
  // Overdue SLA detail list
  const slaListEl = $('fin-overdue-sla-list');
  if (slaListEl) {
    if (overdueOrders.length) {
      slaListEl.innerHTML = `<div class="sl" style="margin-bottom:8px">Overdue SLA Orders <div class="sl-line"></div></div>` +
        `<div class="twrap"><table><thead><tr><th>Client</th><th>Order Date</th><th>Qty</th><th>SLA Due</th><th>Days Overdue</th></tr></thead><tbody>` +
        overdueOrders.map(o=>{
          const days=Math.ceil((new Date(curTodayStr)-new Date(o.sla_due_date))/(1000*60*60*24));
          return `<tr><td><strong>${esc(o.clients?.company_name||'-')}</strong></td><td style="font-family:var(--mono);font-size:12px">${o.order_date||'-'}</td><td style="font-family:var(--mono)">${o.leads_qty}</td><td style="font-family:var(--mono);color:var(--red);font-weight:600">${o.sla_due_date}</td><td style="font-family:var(--mono);color:var(--red)">${days}d</td></tr>`;
        }).join('') + `</tbody></table></div>`;
    } else {
      slaListEl.innerHTML = '';
    }
  }
  const tb=$('exp-tbody');
  if (!expenses.length) { tb.innerHTML='<tr><td colspan="5" class="empty">No expenses for this period.</td></tr>'; }
  else { tb.innerHTML=expenses.map(e=>`<tr><td>${esc(e.category||'-')}</td><td>${esc(e.description||'-')}</td><td>${fmt(e.amount)}</td><td><span class="badge ${e.type==='fixed'?'bg-blu':'bg-amb'}">${e.type||'variable'}</span></td><td style="font-family:var(--mono);font-size:12px">${e.date||'-'}</td><td style="white-space:nowrap"><button class="btn btn-xs" onclick="editExpense('${esc(String(e.id))}')">Edit</button> <button class="btn btn-xs" style="color:var(--red)" onclick="deleteExpense('${esc(String(e.id))}')">Delete</button></td></tr>`).join(''); }
  renderRevenueChart(pplRev,mgRetainerRev,mgCustomRev,expenses,pplSp,agSp);renderCplChart(spendLog);
}
function renderSubscriptionsTable(subs) {
  const tb = $('subs-tbody');
  if (!tb) return;
  if (!subs.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">No subscriptions yet - add your tools & software costs.</td></tr>'; return; }
  tb.innerHTML = subs.map(s => `
    <tr>
      <td><strong>${esc(s.name||'-')}</strong></td>
      <td style="font-family:var(--mono)">${fmt(s.monthly_cost||0)}/mo</td>
      <td><button onclick="toggleSubActive('${esc(String(s.id))}',${!!s.active})" style="border:none;cursor:pointer;border-radius:3px;font-size:12px;padding:2px 8px;font-family:var(--mono);background:${s.active?'rgba(46,204,138,.12)':'rgba(255,69,96,.08)'};color:${s.active?'var(--grn)':'var(--red)'}">${s.active?'Active':'Inactive'}</button></td>
      <td><button class="btn btn-xs" style="color:var(--red)" onclick="deleteSub('${esc(String(s.id))}')">Delete</button></td>
    </tr>`).join('');
}
async function openAddSub() {
  const name = prompt('Subscription name (e.g. "Slack, Canva, Supabase"):');
  if (!name?.trim()) return;
  const costStr = prompt('Monthly cost ($):');
  const cost = parseFloat(costStr);
  if (isNaN(cost) || cost < 0) { toast('Invalid cost',true); return; }
  const {error} = await db.from('subscriptions').insert([{name:name.trim(),monthly_cost:cost,active:true,created_at:now()}]);
  if (error) { toast('Error: '+error.message,true); return; }
  toast('Subscription added ✓');
  loadFinance();
}
async function toggleSubActive(id, currentlyActive) {
  const {error} = await db.from('subscriptions').update({active:!currentlyActive}).eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  loadFinance();
}
async function deleteSub(id) {
  if (!confirm('Delete this subscription?')) return;
  const {error} = await db.from('subscriptions').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  toast('Subscription deleted');
  loadFinance();
}
let _editingExpenseId=null;
function openExpenseModal() {
  _editingExpenseId=null;
  const t=$('exp-modal-title'); if (t) t.textContent='Add Expense';
  ['exp-category','exp-description','exp-amount'].forEach(id=>{$(id).value='';});
  $('exp-type').value='fixed';
  $('exp-date').value=new Date().toISOString().split('T')[0];
  openModal('m-expense');
}
async function editExpense(id) {
  const {data,error}=await db.from('expenses').select('*').eq('id',id).maybeSingle();
  if (error||!data) { toast('Could not load expense',true); return; }
  _editingExpenseId=id;
  const t=$('exp-modal-title'); if (t) t.textContent='Edit Expense';
  $('exp-category').value=data.category||'';
  $('exp-description').value=data.description||'';
  $('exp-amount').value=data.amount!=null?data.amount:'';
  $('exp-type').value=data.type||'fixed';
  $('exp-date').value=data.date||new Date().toISOString().split('T')[0];
  openModal('m-expense');
}
async function saveExpense() {
  const category=$('exp-category').value.trim();
  const description=$('exp-description').value.trim();
  const amount=parseFloat($('exp-amount').value);
  const type=$('exp-type').value;
  const date=$('exp-date').value;
  if (!category) { toast('Category required',true); return; }
  if (isNaN(amount)||amount<=0) { toast('Valid amount required',true); return; }
  if (!date) { toast('Date required',true); return; }
  let error;
  if (_editingExpenseId) {
    ({error}=await db.from('expenses').update({category,description:description||null,amount,type,date}).eq('id',_editingExpenseId));
  } else {
    ({error}=await db.from('expenses').insert([{category,description:description||null,amount,type,date,created_at:now()}]));
  }
  if (error) { toast('Error: '+error.message,true); return; }
  _editingExpenseId=null;
  ['exp-category','exp-description','exp-amount','exp-date'].forEach(id=>{$(id).value='';});
  closeModal('m-expense');
  toast('Expense saved ✓');
  loadFinance();
}
async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  const {error}=await db.from('expenses').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  toast('Expense deleted');
  loadFinance();
}

/* ═══ CAMPAIGN SPEND LOG ═══ */
// Write (or overwrite) this month's sync data into campaign_spend_log so spend
// history survives campaign deletions and is accurate in financials.
async function writeSyncToSpendLog() {
  const campaigns = _campaignsCache.filter(c => c.id);
  if (!campaigns.length) return;
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
  const campaignIds = campaigns.map(c => c.id);
  // Batch delete all existing sync entries for these campaigns in this period, then batch insert
  await db.from('campaign_spend_log')
    .delete()
    .in('campaign_id', campaignIds)
    .eq('period', period)
    .eq('source', 'sync');
  const rows = campaigns.map(c => ({
    campaign_id:      c.id,
    campaign_name:    c.name,
    meta_campaign_id: c.meta_campaign_id,
    period,
    spend:            c.spend_mtd        || 0,
    leads:            c.leads_mtd        || 0,
    clicks:           c.clicks_mtd       || 0,
    impressions:      c.impressions_mtd  || 0,
    source:           'sync',
    updated_at:       now(),
  }));
  await db.from('campaign_spend_log').insert(rows);
  loadSpendLog();
}

async function loadSpendLog() {
  const tb = $('spend-log-tbody');
  if (!tb) return;
  const {data, error} = await db.from('campaign_spend_log')
    .select('*')
    .order('period', {ascending: false})
    .order('campaign_name');
  if (error) { tb.innerHTML=`<tr><td colspan="8" class="empty">Error: ${esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  if (!rows.length) { tb.innerHTML='<tr><td colspan="8" class="empty">No spend logged yet - run Sync Stats or add a manual entry.</td></tr>'; return; }
  const fmt$ = v => v ? '$'+Number(v).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2}) : '-';
  tb.innerHTML = rows.map(r => {
    const cpl = (r.leads||0) > 0 ? fmt$((r.spend||0)/r.leads) : '-';
    const srcBadge = r.source === 'sync'
      ? `<span style="font-family:var(--mono);font-size:12px;color:var(--grn)">sync</span>`
      : `<span style="font-family:var(--mono);font-size:12px;color:var(--amb)">manual</span>`;
    const delBtn = r.source === 'manual'
      ? `<button class="btn btn-xs" style="color:var(--red)" onclick="deleteSpendLogEntry('${esc(String(r.id))}')">Delete</button>`
      : `<span style="font-size:12px;color:var(--ink3)">-</span>`;
    return `<tr>
      <td><strong>${esc(r.campaign_name||'-')}</strong></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(r.period||'-')}</td>
      <td style="font-family:var(--mono)">${fmt$(r.spend)}</td>
      <td style="font-family:var(--mono)">${r.leads||'-'}</td>
      <td style="font-family:var(--mono)">${cpl}</td>
      <td>${srcBadge}</td>
      <td style="font-size:12px;color:var(--ink3)">${esc(r.notes||'-')}</td>
      <td>${delBtn}</td>
    </tr>`;
  }).join('');
}

function openManualSpendModal() {
  // Default to current month
  if (!$('msl-period').value) $('msl-period').value = new Date().toISOString().slice(0,7);
  openModal('m-manual-spend');
}

async function saveManualSpend() {
  const name   = $('msl-name').value.trim();
  const period = $('msl-period').value;
  const spend  = parseFloat($('msl-spend').value);
  const leads  = parseInt($('msl-leads').value) || 0;
  const notes  = $('msl-notes').value.trim();
  if (!name)   { toast('Campaign name required', true); return; }
  if (!period) { toast('Period required', true); return; }
  if (isNaN(spend) || spend < 0) { toast('Valid spend amount required', true); return; }
  const {error} = await db.from('campaign_spend_log').insert([{
    campaign_name: name,
    period,
    spend,
    leads,
    source: 'manual',
    notes: notes || null,
    updated_at: now(),
  }]);
  if (error) { toast('Error: '+error.message, true); return; }
  ['msl-name','msl-spend','msl-leads','msl-notes'].forEach(id => { $(id).value=''; });
  closeModal('m-manual-spend');
  toast('Spend logged ✓');
  loadSpendLog();
  loadFinance();
}

async function deleteSpendLogEntry(id) {
  if (!confirm('Delete this manual spend entry?')) return;
  const {error} = await db.from('campaign_spend_log').delete().eq('id', id);
  if (error) { toast('Error: '+error.message, true); return; }
  toast('Entry deleted');
  loadSpendLog();
  loadFinance();
}

/* ═══ GOAL BOARD ═══ */
async function loadGoals() {
  const year = $('goal-year')?.value || new Date().getFullYear();
  const priorYear = +year - 1;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const today = new Date();
  // The last month with actuals: this month in the current year, all of a past
  // year, none of a future one. Every month is listed so goals can be set ahead;
  // months still to come have no actuals and don't count towards the YTD.
  const curMonth = today.getFullYear() === +year ? today.getMonth() : +year < today.getFullYear() ? 11 : -1;

  // Load goals + actuals in parallel (including prior year for YoY)
  const [goalsR, pplOrdR, mgR, mgOrdR, expR, spendLogR, priorPplOrdR, priorMgOrdR, priorExpR, priorSpendLogR] = await Promise.all([
    db.from('monthly_goals').select('*').gte('month', `${year}-01`).lte('month', `${year}-12`).order('month'),
    db.from('ppl_order_log').select('leads_qty,lead_price,order_date').gte('order_date', `${year}-01-01`).lte('order_date', `${year}-12-31`),
    db.from('clients').select('id,company_name,management_fee,payments_made,stage,active_months,retainer_payment_dates,retainer_amounts').eq('type','managed'),
    db.from('managed_order_log').select('client_id,amount,order_date').gte('order_date', `${year}-01-01`).lte('order_date', `${year}-12-31`),
    db.from('expenses').select('amount,date').gte('date', `${year}-01-01`).lte('date', `${year}-12-31`),
    db.from('campaign_spend_log').select('period,spend').gte('period',`${year}-01`).lte('period',`${year}-12`),
    db.from('ppl_order_log').select('leads_qty,lead_price,order_date').gte('order_date', `${priorYear}-01-01`).lte('order_date', `${priorYear}-12-31`),
    db.from('managed_order_log').select('client_id,amount,order_date').gte('order_date', `${priorYear}-01-01`).lte('order_date', `${priorYear}-12-31`),
    db.from('expenses').select('amount,date').gte('date', `${priorYear}-01-01`).lte('date', `${priorYear}-12-31`),
    db.from('campaign_spend_log').select('period,spend').gte('period',`${priorYear}-01`).lte('period',`${priorYear}-12`),
  ]);

  const goals = goalsR.data || [];
  const goalMap = {};
  goals.forEach(g => { goalMap[g.month] = g; });

  const pplOrders = pplOrdR.data || [];
  const mgClients = mgR.data || [];
  const mgOrders = mgOrdR.data || [];
  const expenses = expR.data || [];
  const spendLog = spendLogR.data || [];
  // Build a per-month spend map from the spend log
  const spendByMonth = {};
  spendLog.forEach(e => { spendByMonth[e.period] = (spendByMonth[e.period] || 0) + (e.spend || 0); });

  // Build prior-year per-month revenue map for YoY
  const priorPplOrders = priorPplOrdR.data || [];
  const priorMgOrders = priorMgOrdR.data || [];
  const priorSpendLog = priorSpendLogR.data || [];
  const priorSpendByMonth = {};
  priorSpendLog.forEach(e => { priorSpendByMonth[e.period] = (priorSpendByMonth[e.period] || 0) + (e.spend || 0); });

  function priorMonthRev(m) {
    const key = `${priorYear}-${String(m+1).padStart(2,'0')}`;
    const from = `${key}-01`;
    const next = m === 11 ? `${+priorYear+1}-01-01` : `${priorYear}-${String(m+2).padStart(2,'0')}-01`;
    const ppl = priorPplOrders.filter(o=>o.order_date>=from&&o.order_date<next).reduce((s,o)=>s+((o.leads_qty||0)*(o.lead_price||0)),0);
    const mgRet = mgClients.reduce((s,c)=>{
      let months=[];try{months=JSON.parse(c.active_months||'[]');}catch(e){}
      return s+(months.filter(mo=>mo===key).length*(c.management_fee||0));
    },0);
    const mgCust = priorMgOrders.filter(o=>o.order_date>=from&&o.order_date<next).reduce((s,o)=>s+(o.amount||0),0);
    return ppl + mgRet + mgCust;
  }

  // Build monthly actuals
  const rows = [];
  let ytdRev = 0, ytdExp = 0, ytdGoalRev = 0, ytdPriorRev = 0;
  const monthsWithGoals = [];

  for (let m = 0; m < 12; m++) {
    const key = `${year}-${String(m+1).padStart(2,'0')}`;
    if (m > curMonth) {
      rows.push({ month: key, label: monthNames[m], future: true, rev: null, totalExp: null, profit: null, margin: null, priorRev: 0,
        goal: goalMap[key] || { revenue_goal: 0, margin_goal: 0, notes: '' } });
      continue;
    }
    const from = `${key}-01`;
    const next = m === 11 ? `${+year+1}-01-01` : `${year}-${String(m+2).padStart(2,'0')}-01`;

    // PPL revenue for this month
    const pplRev = pplOrders
      .filter(o => o.order_date >= from && o.order_date < next)
      .reduce((s, o) => s + ((o.leads_qty||0) * (o.lead_price||0)), 0);

    // Managed retainer revenue for this month (cash basis: attributed to the
    // month the retainer was paid, not the month it covers).
    const mgRetainer = mgClients.reduce((s, c) => {
      return s + mgPayments(c).filter(p => p.m === key).reduce((a, p) => a + p.amt, 0);
    }, 0);

    // Managed custom orders for this month
    const mgCustom = mgOrders
      .filter(o => o.order_date >= from && o.order_date < next)
      .reduce((s, o) => s + (o.amount || 0), 0);

    // Expenses for this month
    const monthExp = expenses
      .filter(e => e.date >= from && e.date < next)
      .reduce((s, e) => s + (e.amount || 0), 0);

    // Ad spend from campaign_spend_log - now available for all historical months
    const adSpend = spendByMonth[key] || 0;

    const rev = pplRev + mgRetainer + mgCustom;
    const totalExp = monthExp + adSpend;
    const profit = rev - totalExp;
    const margin = rev > 0 ? (profit / rev) * 100 : 0;
    const priorRev = priorMonthRev(m);

    const goal = goalMap[key] || { revenue_goal: 0, margin_goal: 0, notes: '' };

    ytdRev += rev;
    ytdExp += totalExp;
    ytdPriorRev += priorRev;
    if (goal.revenue_goal > 0) ytdGoalRev += goal.revenue_goal;
    if (goal.margin_goal > 0) monthsWithGoals.push(goal.margin_goal);

    rows.push({ month: key, label: monthNames[m], rev, totalExp, profit, margin, goal, priorRev });
  }

  // YTD KPIs
  const ytdProfit = ytdRev - ytdExp;
  const ytdMargin = ytdRev > 0 ? (ytdProfit / ytdRev) * 100 : 0;
  const avgGoalMargin = monthsWithGoals.length ? monthsWithGoals.reduce((a, b) => a + b, 0) / monthsWithGoals.length : 0;

  setText('goal-ytd-rev', fmt(ytdRev));
  $('goal-ytd-rev-sub').textContent = ytdGoalRev > 0 ? `${((ytdRev / ytdGoalRev) * 100).toFixed(0)}% of $${ytdGoalRev.toLocaleString()} goal` : 'no goals set';
  setText('goal-ytd-margin', ytdMargin.toFixed(1) + '%');
  $('goal-ytd-margin-sub').textContent = avgGoalMargin > 0 ? `goal: ${avgGoalMargin.toFixed(0)}%` : 'no margin goals set';
  setText('goal-ytd-profit', fmt(ytdProfit));
  $('goal-ytd-profit').className = `kval ${ytdProfit >= 0 ? 'grn' : 'red'}`;
  $('goal-ytd-profit-sub').textContent = `${ytdRev > 0 ? ytdMargin.toFixed(1) : '0'}% margin`;
  // YoY KPI
  if ($('goal-yoy-rev')) {
    const yoyPct = ytdPriorRev > 0 ? ((ytdRev - ytdPriorRev) / ytdPriorRev * 100) : null;
    const yoyEl = $('goal-yoy-rev');
    const yoySub = $('goal-yoy-rev-sub');
    if (yoyPct !== null) {
      yoyEl.textContent = (yoyPct >= 0 ? '↑ +' : '↓ ') + yoyPct.toFixed(1) + '%';
      yoyEl.className = `kval ${yoyPct >= 0 ? 'grn' : 'red'}`;
      yoySub.textContent = `vs ${priorYear} (${fmt(ytdPriorRev)})`;
    } else {
      yoyEl.textContent = '-';
      yoyEl.className = 'kval';
      yoySub.textContent = `no ${priorYear} data`;
    }
  }

  // Render table
  const tb = $('goal-tbody');
  tb.innerHTML = rows.map(r => {
    const revPctNum = r.goal.revenue_goal > 0 && !r.future ? (r.rev / r.goal.revenue_goal) * 100 : null;
    const revPct = revPctNum !== null ? revPctNum.toFixed(0) : '-';
    const revPctColor = revPctNum === null ? 'var(--ink3)' : revPctNum >= 100 ? 'var(--grn)' : revPctNum >= 75 ? 'var(--amb)' : 'var(--red)';
    const marginColor = r.goal.margin_goal > 0 && !r.future ? (r.margin >= r.goal.margin_goal ? 'var(--grn)' : r.margin >= r.goal.margin_goal * 0.75 ? 'var(--amb)' : 'var(--red)') : 'var(--ink3)';
    const yoyNum = r.priorRev > 0 && !r.future ? ((r.rev - r.priorRev) / r.priorRev * 100) : null;
    const dash = '<span style="color:var(--ink3)">-</span>';
    const yoyCell = yoyNum !== null
      ? `<span style="font-family:var(--mono);font-size:12px;font-weight:500;color:${yoyNum>=0?'var(--grn)':'var(--red)'}">${yoyNum>=0?'↑ +':'↓ '}${yoyNum.toFixed(1)}%</span>`
      : '<span style="color:var(--ink3)">-</span>';
    return `<tr>
      <td style="font-family:var(--mono);font-size:12px;font-weight:500">${r.label}</td>
      <td><input class="fi goal-input" data-month="${r.month}" data-field="revenue_goal" type="number" value="${r.goal.revenue_goal||''}" placeholder="-" style="width:90px;font-size:12px;padding:3px 6px;text-align:right"></td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:500">${r.future ? dash : fmt(r.rev)}</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:500;color:${revPctColor}">${revPct === '-' ? '-' : revPct + '%'}</td>
      <td>${yoyCell}</td>
      <td><input class="fi goal-input" data-month="${r.month}" data-field="margin_goal" type="number" value="${r.goal.margin_goal||''}" placeholder="-" style="width:70px;font-size:12px;padding:3px 6px;text-align:right" step="1" min="0" max="100">%</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:500;color:${marginColor}">${r.future ? dash : r.margin.toFixed(1) + '%'}</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:500;color:${r.profit>=0?'var(--grn)':'var(--red)'}">${r.future ? dash : fmt(r.profit)}</td>
      <td><input class="fi goal-input" data-month="${r.month}" data-field="notes" type="text" value="${esc(r.goal.notes||'')}" placeholder="-" style="width:120px;font-size:12px;padding:3px 6px"></td>
      <td><button class="btn btn-xs" onclick="saveGoal('${r.month}')">Save</button></td>
    </tr>`;
  }).join('');

  // Charts
  renderGoalCharts(rows);
}

async function saveGoal(month) {
  const inputs = document.querySelectorAll(`.goal-input[data-month="${month}"]`);
  const vals = {};
  inputs.forEach(inp => { vals[inp.dataset.field] = inp.dataset.field === 'notes' ? inp.value : (parseFloat(inp.value) || 0); });
  vals.updated_at = now();
  const { error } = await db.from('monthly_goals').upsert({ month, ...vals }, { onConflict: 'month' });
  if (error) { toast('Error saving goal: ' + error.message, true); return; }
  toast(`${month} goal saved ✓`);
}

function renderGoalCharts(rows) {
  const labels = rows.map(r => r.label);

  if (goalRevChart) goalRevChart.destroy();
  goalRevChart = new Chart($('chart-goal-rev').getContext('2d'), {
    type:'bar',
    data:{labels,datasets:[
      {label:'Goal',   data:rows.map(r=>r.goal.revenue_goal||0), backgroundColor:CHART.cat2, borderWidth:0, borderRadius:4, borderSkipped:false},
      {label:'Actual', data:rows.map(r=>r.rev),                  backgroundColor:CHART.cat1,  borderWidth:0, borderRadius:4, borderSkipped:false}
    ]},
    options: chartBase({
      plugins:{legend:chartLegend(),tooltip:{callbacks:{label:c=>' '+c.dataset.label+': $'+Math.round(c.parsed.y).toLocaleString()}}},
      scales:{y:{beginAtZero:true,ticks:{callback:v=>'$'+v.toLocaleString()}}}
    })
  });

  if (goalMarginChart) goalMarginChart.destroy();
  goalMarginChart = new Chart($('chart-goal-margin').getContext('2d'), {
    type:'line',
    data:{labels,datasets:[
      {label:'Goal %',   data:rows.map(r=>r.goal.margin_goal||0), borderColor:CHART.cat2, borderWidth:2, borderDash:[5,4], pointRadius:0, pointHoverRadius:5, fill:false, tension:.25},
      {label:'Actual %', data:rows.map(r=>r.margin==null?null:+r.margin.toFixed(1)),  borderColor:CHART.cat1, borderWidth:2, pointRadius:4, pointBackgroundColor:CHART.cat1, pointBorderColor:'#0f0f12', pointBorderWidth:2, fill:false, tension:.25}
    ]},
    options: chartBase({
      plugins:{legend:chartLegend(),tooltip:{callbacks:{label:c=>' '+c.dataset.label+': '+c.parsed.y+'%'}}},
      scales:{y:{beginAtZero:true,ticks:{callback:v=>v+'%'}}}
    })
  });
}

const CHART = {
  cat1:'#4f8fff', cat2:'#e35d8c',
  good:'#1fa971', warn:'#c8841b', crit:'#e8455c',
  // Marks use the solid validated steps. Alpha would composite them into a
  // different colour than the one that passed the checks, so it is only used
  // for hover, which carries no meaning.
  hover: hex => hex + 'cc'
};

function chartDefaults() {
  const dark=document.documentElement.getAttribute('data-theme')==='dark';
  return {grid:dark?'#1c1c22':'#e4e4ee',tick:dark?'#6b6b82':'#77778c'};
}

// Shared axis/legend/tooltip styling. Ticks were 9px and unreadable.
// Callers pass partial overrides; these are merged into the base rather than
// replacing whole branches, so an axis override cannot silently drop the
// shared colours, fonts and tick limits.
function deepMerge(base, over) {
  const out = {...base};
  for (const [k,v] of Object.entries(over||{})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

function chartBase(extra={}) {
  const {grid,tick}=chartDefaults();
  const font={family:"'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",size:11};
  return deepMerge({
    responsive:true, maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{
        backgroundColor:'#141417', borderColor:'#262630', borderWidth:1,
        titleColor:'#eeeef3', bodyColor:'#8a8aa0', padding:10,
        titleFont:{family:"'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",size:11}, bodyFont:font,
        displayColors:true, boxWidth:8, boxHeight:8
      }
    },
    scales:{
      x:{ticks:{color:tick,font,maxTicksLimit:12},grid:{display:false},border:{color:grid}},
      y:{ticks:{color:tick,font,maxTicksLimit:6},grid:{color:grid,drawTicks:false},border:{display:false}}
    }
  }, extra);
}

// A legend is required whenever more than one series is plotted.
function chartLegend() {
  const {tick}=chartDefaults();
  return {display:true,position:'bottom',labels:{color:tick,font:{family:"'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",size:11},boxWidth:8,boxHeight:8,usePointStyle:true,pointStyle:'circle',padding:14}};
}
// Churn month by month: of the clients we had at the start of a month, how
// many were lost during it, × 100. A client joins on client_since and is lost
// on churned_at (the day they were moved to churned). Paused clients are still
// clients. Someone who joined and left inside the same month isn't in that
// month's starting count, so they're shown beside "Lost" but not in the rate.
function monthlyChurn(clients) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const dated = clients.filter(c => c.client_since);
  if (!dated.length) return [];
  let [y, m] = dated.map(c => c.client_since).sort()[0].slice(0, 7).split('-').map(Number);
  const [ty, tm] = today.slice(0, 7).split('-').map(Number);
  const ym = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const out = [];
  while (y < ty || (y === ty && m <= tm)) {
    const start = ym(y, m);
    const label = new Date(start + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
    if (++m > 12) { m = 1; y++; }
    const end = ym(y, m);
    const lostIn = c => c.churned_at && c.churned_at >= start && c.churned_at < end;
    const atStart = dated.filter(c => c.client_since < start && (!c.churned_at || c.churned_at >= start));
    const joined = dated.filter(c => c.client_since >= start && c.client_since < end);
    const lost = atStart.filter(lostIn).length;
    out.push({
      start, label, atStart: atStart.length, joined: joined.length, lost,
      joinedLost: joined.filter(lostIn).length,
      rate: atStart.length ? lost / atStart.length * 100 : null,
      current: today < end,
    });
  }
  return out;
}

function renderMonthlyChurn(prefix, clients, currentChart) {
  const months = monthlyChurn(clients);
  const pct = r => r == null ? '-' : r.toFixed(1) + '%';
  const body = $(prefix + '-churn-months');
  const lastFull = [...months].reverse().find(mo => !mo.current);
  const now = months[months.length - 1];
  setText(prefix + '-churn-rate', lastFull ? pct(lastFull.rate) : '-');
  setText(prefix + '-churn-sub', lastFull
    ? `${lastFull.label}: ${lastFull.lost} of ${lastFull.atStart} lost${now?.current ? ` · ${now.label} so far ${pct(now.rate)}` : ''}`
    : 'lost ÷ clients at the start');
  if (body) {
    body.innerHTML = months.length ? [...months].reverse().map(mo => `<tr>
      <td style="font-family:var(--mono);font-size:12px">${esc(mo.label)}${mo.current ? ' <span style="color:var(--ink3)">so far</span>' : ''}</td>
      <td style="font-family:var(--mono)">${mo.atStart}</td>
      <td style="font-family:var(--mono);color:var(--grn)">${mo.joined || '-'}</td>
      <td style="font-family:var(--mono)">${mo.lost || '-'}${mo.joinedLost ? ` <span style="color:var(--ink3);font-size:12px" title="Joined and left in the same month, so not in this month's rate">+${mo.joinedLost} new</span>` : ''}</td>
      <td style="font-family:var(--mono);color:${mo.rate ? 'var(--red)' : 'var(--ink3)'}">${pct(mo.rate)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">No join or churn dates yet</td></tr>';
  }
  const canvas = $(`chart-${prefix}-churn-monthly`);
  if (currentChart) currentChart.destroy();
  if (!canvas || !months.length) return null;
  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: months.map(mo => mo.label + (mo.current ? '*' : '')),
      datasets: [{
        label: 'Churn', data: months.map(mo => mo.rate == null ? null : +mo.rate.toFixed(1)),
        backgroundColor: CHART.crit, hoverBackgroundColor: CHART.hover(CHART.crit),
        borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: .7, barPercentage: .8,
      }],
    },
    options: chartBase({
      plugins: { tooltip: { callbacks: {
        title: c => months[c[0].dataIndex].label + (months[c[0].dataIndex].current ? ' (so far)' : ''),
        label: c => { const mo = months[c.dataIndex]; return ` ${pct(mo.rate)}: ${mo.lost} of ${mo.atStart} lost`; },
      } } },
      scales: { x: { ticks: { maxRotation: 0 } }, y: { beginAtZero: true, ticks: { callback: v => v + '%' } } },
    }),
  });
}
function renderChurnChart(canvasId, active, paused, churned, currentChart) {
  const total = active + paused + churned;
  const canvas = $(canvasId); if (!canvas) return null;
  if (currentChart) currentChart.destroy();
  if (!total) return null;
  return new Chart(canvas.getContext('2d'), {
    type:'doughnut',
    data:{
      labels:['Active','Paused','Churned'],
      datasets:[{
        data:[active,paused,churned],
        backgroundColor:[CHART.good,CHART.warn,CHART.crit],
        borderColor:'#0f0f12', borderWidth:2, hoverOffset:6
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'64%',
      plugins:{
        legend:{display:true,position:'bottom',labels:{color:chartDefaults().tick,font:{family:"'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",size:11},boxWidth:8,boxHeight:8,usePointStyle:true,pointStyle:'circle',padding:12}},
        tooltip:{
          backgroundColor:'#141417',borderColor:'#262630',borderWidth:1,
          titleColor:'#eeeef3',bodyColor:'#8a8aa0',padding:10,
          callbacks:{label:c=>' '+c.label+': '+c.parsed+' ('+Math.round(c.parsed/total*100)+'%)'}
        }
      }
    }
  });
}
function renderChurnBreakdown(elId, active, paused, churned) {
  const el = $(elId); if (!el) return;
  const total = active + paused + churned;
  const pct = n => total > 0 ? (n / total * 100).toFixed(1) + '%' : '0%';
  const bar = (n, color) => `<div style="height:4px;border-radius:2px;background:${color};width:${total>0?Math.round(n/total*100):0}%;max-width:100%;min-width:${n>0?4:0}px;transition:width .3s"></div>`;
  const rows = [
    { label: 'Active', count: active, color: 'var(--grn)', barColor: '#2ecc8a' },
    { label: 'Paused',  count: paused,  color: 'var(--amb)', barColor: '#f5a623' },
    { label: 'Churned', count: churned, color: 'var(--red)', barColor: '#ff4560' },
  ];
  el.innerHTML = rows.map(r => `
    <div style="background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:10px 14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span style="font-family:var(--mono);font-size:12px;color:var(--ink2)">${r.label}</span>
        <span style="font-family:var(--mono);font-size:14px;font-weight:500;color:${r.color}">${r.count}</span>
      </div>
      <div style="background:var(--bd);border-radius:2px;height:4px;overflow:hidden">${bar(r.count, r.barColor)}</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink3);margin-top:4px">${pct(r.count)} of total</div>
    </div>`).join('') + (total ? `
    <div style="background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:10px 14px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-family:var(--mono);font-size:12px;color:var(--ink2)">Total (all-time)</span>
        <span style="font-family:var(--mono);font-size:14px;font-weight:500;color:var(--ink)">${total}</span>
      </div>
    </div>` : '');
}
function renderRevenueChart(pplRev,mgRetainerRev,mgCustomRev,expenses,pplAdSpend,agAdSpend) {
  const expTotal = expenses.reduce((sum,e)=>sum+(e.amount||0),0);
  const adTotal  = (pplAdSpend||0)+(agAdSpend||0);
  const totalRev = (pplRev||0)+(mgRetainerRev||0)+(mgCustomRev||0);
  const totalOut = adTotal+expTotal;

  // Totals are single numbers, so they read as figures rather than bars.
  const money = v => '$'+Math.round(v).toLocaleString();
  const net = totalRev-totalOut;
  const setTxt=(id,txt,cls)=>{const el=$(id); if(!el)return; el.textContent=txt; if(cls)el.className='kval '+cls;};
  setTxt('rev-stat-in',  money(totalRev), 'c-in');
  setTxt('rev-stat-out', money(totalOut), 'c-out');
  setTxt('rev-stat-net', money(net), net>=0?'grn':'red');

  const rows = [
    {label:'PPL',      full:'PPL revenue',      value:pplRev||0,        inflow:true},
    {label:'Retainer', full:'Managed retainer', value:mgRetainerRev||0, inflow:true},
    {label:'Custom',   full:'Custom orders',    value:mgCustomRev||0,   inflow:true},
    {label:'Ad spend', full:'Ad spend',         value:adTotal,          inflow:false},
    {label:'Expenses', full:'Expenses',         value:expTotal,         inflow:false}
  ];

  if (revChart) revChart.destroy();
  revChart = new Chart($('chart-rev').getContext('2d'), {
    type:'bar',
    data:{
      labels: rows.map(r=>r.label),
      datasets:[
        {label:'Money in',  data:rows.map(r=>r.inflow?r.value:null),  backgroundColor:CHART.cat1, borderWidth:0, borderRadius:4, borderSkipped:false, categoryPercentage:.7, barPercentage:.82},
        {label:'Money out', data:rows.map(r=>r.inflow?null:r.value),  backgroundColor:CHART.cat2, borderWidth:0, borderRadius:4, borderSkipped:false, categoryPercentage:.7, barPercentage:.82}
      ]
    },
    options: chartBase({
      plugins:{
        legend:chartLegend(),
        tooltip:{callbacks:{
          title:c=>rows[c[0].dataIndex].full,
          label:c=>c.parsed.y==null?null:' '+c.dataset.label+': $'+Math.round(c.parsed.y).toLocaleString()
        }}
      },
      scales:{
        x:{stacked:true,ticks:{maxRotation:0,autoSkip:false}},
        y:{stacked:true,beginAtZero:true,ticks:{callback:v=>'$'+v.toLocaleString()}}
      }
    })
  });
}
function renderCplChart(spendLog) {
  const withLeads = spendLog.filter(e=>(e.leads||0)>0)
    .map(e=>({name:(e.campaign_name||'?').slice(0,28), cpl:+((e.spend||0)/e.leads).toFixed(2)}))
    .sort((a,b)=>b.cpl-a.cpl);
  if (cplChart) cplChart.destroy();
  cplChart = new Chart($('chart-cpl').getContext('2d'), {
    type:'bar',
    data:{
      labels: withLeads.map(e=>e.name),
      datasets:[{
        label:'CPL',
        data: withLeads.map(e=>e.cpl),
        backgroundColor: CHART.cat1,
        borderWidth:0, borderRadius:4, borderSkipped:false, categoryPercentage:.62, barPercentage:.6
      }]
    },
    options: chartBase({
      indexAxis:'y',
      plugins:{tooltip:{callbacks:{label:c=>' $'+c.parsed.x.toFixed(2)+' per lead'}}},
      scales:{
        x:{beginAtZero:true,ticks:{callback:v=>'$'+v}},
        y:{grid:{display:false}}
      }
    })
  });
}

function switchCrmFilter(range, el) {
  curCrmRange = range;
  document.querySelectorAll('.crm-period-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const ci = $('crm-date'); ci.style.display = range === 'custom' ? 'inline-block' : 'none';
  $('crm-date-to').style.display = ci.style.display;
  if (range !== 'custom') loadCRM(true);
}
function getDateRange(range) {
  const today=new Date();const f=d=>d.toISOString().split('T')[0];
  if (range==='today') return {from:f(today),to:f(today)};
  if (range==='yesterday') {const y=new Date(today);y.setDate(y.getDate()-1);return {from:f(y),to:f(y)};}
  if (range==='7d') {const s=new Date(today);s.setDate(s.getDate()-6);return {from:f(s),to:f(today)};}
  if (range==='30d') {const s=new Date(today);s.setDate(s.getDate()-29);return {from:f(s),to:f(today)};}
  if (range==='ytd') {return {from:`${today.getFullYear()}-01-01`,to:f(today)};}
  if (range==='month') {return {from:f(today).slice(0,8)+'01',to:f(today)};}
  if (range==='lastmonth') {const e=new Date(today.getFullYear(),today.getMonth(),0);return {from:f(e).slice(0,8)+'01',to:f(e)};}
  if (range==='custom') {const v=$('crm-date').value, t=$('crm-date-to')?.value;return v?{from:v,to:t&&t>=v?t:v}:{from:f(today),to:f(today)};}
  return {from:f(today),to:f(today)};
}


let curFile = 'post-call-email.md';
let FILE_DEFAULTS = {};
