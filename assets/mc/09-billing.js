'use strict';

// ── Lead Gen & CPL editor ──────────────────────────────────────────────────
// One row per active PPL client. Edit Leads Generated + Meta CPL, hit Save.
// True CPL = Meta CPL / (Sold / Generated). Same maths as the old per-order
// popup, just done on one page. Sold = leads the client purchased.
async function loadCplEditorPanel(){
  const tb=$('cpl-editor-tbody');
  if(tb) tb.innerHTML='<tr><td colspan="10" class="empty">Loading…</td></tr>';
  const {data,error}=await db.from('clients').select('*').eq('type','ppl').in('stage',['active_client','paused','churned']).order('company_name');
  if(error){ if(tb) tb.innerHTML='<tr><td colspan="10" class="empty">Failed to load.</td></tr>'; return; }
  (data||[]).forEach(c=>{ CLIENT_CACHE[c.id]=c; });
  renderCplEditor(data||[]);
}
function renderCplEditor(clients){
  const tb=$('cpl-editor-tbody');
  if(!tb) return;
  const rows=(clients||[]).filter(c=>c.type!=='managed'&&['active_client','paused','churned'].includes(c.stage));
  if(!rows.length){ tb.innerHTML='<tr><td colspan="10" class="empty">No PPL clients.</td></tr>'; renderCplStats(); return; }
  tb.innerHTML=rows.map(c=>{
    const id=esc(String(c.id));
    const sold=Number(c.total_leads_purchased)||0;
    const price=Number(c.lead_price)||0;
    const gen=c.total_leads_generated!=null?c.total_leads_generated:'';
    const mcpl=c.meta_cpl!=null?c.meta_cpl:'';
    return `<tr id="cpl-row-${id}" data-sold="${sold}" data-price="${price}">
      <td><strong>${esc(c.company_name)}</strong></td>
      <td><span class="badge ${stageBadge(c.stage)}">${stageLabel(c.stage)}</span></td>
      <td style="font-family:var(--mono)">${sold}</td>
      <td><input class="fi cpl-gen" type="number" min="0" step="1" value="${gen}" oninput="recalcCplRow('${id}')" style="width:88px;padding:3px 6px"></td>
      <td><input class="fi cpl-mcpl" type="number" min="0" step="0.01" value="${mcpl}" oninput="recalcCplRow('${id}')" style="width:88px;padding:3px 6px"></td>
      <td class="cpl-pct" style="font-family:var(--mono)">-</td>
      <td class="cpl-true" style="font-family:var(--mono);color:var(--blu)">-</td>
      <td style="font-family:var(--mono)">${fmtCpl(c.lead_price)}</td>
      <td class="cpl-margin" style="font-family:var(--mono)">-</td>
      <td><button class="btn btn-xs btn-p" onclick="saveCplRow('${id}',this)">Save</button></td>
    </tr>`;
  }).join('');
  rows.forEach(c=>recalcCplRow(String(c.id)));
}
function recalcCplRow(id){
  const row=document.getElementById('cpl-row-'+id);
  if(!row) return;
  const sold=Number(row.dataset.sold)||0;
  const price=Number(row.dataset.price)||0;
  const gen=parseFloat(row.querySelector('.cpl-gen').value)||0;
  const mcpl=parseFloat(row.querySelector('.cpl-mcpl').value)||0;
  const pct=gen>0?(sold/gen*100):null;
  const trueCpl=(pct&&mcpl)?(mcpl/(pct/100)):null;
  const margin=(trueCpl!=null&&price)?(price-trueCpl):null;
  row.querySelector('.cpl-pct').textContent=pct!=null?pct.toFixed(1)+'%':'-';
  row.querySelector('.cpl-true').textContent=trueCpl!=null?'$'+trueCpl.toFixed(2):'-';
  const mEl=row.querySelector('.cpl-margin');
  if(margin!=null){ mEl.textContent='$'+margin.toFixed(2); mEl.style.color=margin>=0?'var(--grn)':'var(--red)'; }
  else { mEl.textContent='-'; mEl.style.color=''; }
  renderCplStats();
}
// Aggregate KPIs under the CPL table - computed live from the current row values.
function renderCplStats(){
  const rows=document.querySelectorAll('#cpl-editor-tbody tr[id^="cpl-row-"]');
  let mcplSum=0,mcplN=0,trueSum=0,trueN=0,marginSum=0,marginN=0,pctSum=0,pctN=0,genTot=0,soldTot=0;
  rows.forEach(row=>{
    const sold=Number(row.dataset.sold)||0;
    const price=Number(row.dataset.price)||0;
    const gen=parseFloat(row.querySelector('.cpl-gen').value)||0;
    const mcpl=parseFloat(row.querySelector('.cpl-mcpl').value)||0;
    genTot+=gen; soldTot+=sold;
    if(mcpl>0){ mcplSum+=mcpl; mcplN++; }
    const pct=gen>0?(sold/gen*100):null;
    if(pct!=null){ pctSum+=pct; pctN++; }
    const trueCpl=(pct&&mcpl)?(mcpl/(pct/100)):null;
    if(trueCpl!=null){ trueSum+=trueCpl; trueN++; }
    const margin=(trueCpl!=null&&price)?(price-trueCpl):null;
    if(margin!=null){ marginSum+=margin; marginN++; }
  });
  setText('cpl-avg-meta', mcplN?'$'+(mcplSum/mcplN).toFixed(2):'-');
  setText('cpl-avg-true', trueN?'$'+(trueSum/trueN).toFixed(2):'-');
  const me=$('cpl-avg-margin');
  if(me){ if(marginN){ const am=marginSum/marginN; me.textContent='$'+am.toFixed(2); me.style.color=am>=0?'var(--grn)':'var(--red)'; } else { me.textContent='-'; me.style.color=''; } }
  setText('cpl-avg-pct', pctN?(pctSum/pctN).toFixed(1)+'%':'-');
  setText('cpl-total-gen', genTot?genTot.toLocaleString():'-');
  setText('cpl-total-sold', soldTot?soldTot.toLocaleString():'-');
}
async function saveCplRow(id, btn){
  const row=document.getElementById('cpl-row-'+id);
  if(!row) return;
  const sold=Number(row.dataset.sold)||0;
  const genRaw=row.querySelector('.cpl-gen').value.trim();
  const mcplRaw=row.querySelector('.cpl-mcpl').value.trim();
  const gen=genRaw===''?null:parseInt(genRaw,10);
  const mcpl=mcplRaw===''?null:parseFloat(mcplRaw);
  if(gen!=null&&(isNaN(gen)||gen<0)){ toast('Leads generated must be a whole number',true); return; }
  if(mcpl!=null&&(isNaN(mcpl)||mcpl<0)){ toast('Meta CPL must be a valid number',true); return; }
  const pct=(gen&&gen>0)?(sold/gen*100):null;
  const trueCpl=(pct&&mcpl)?(mcpl/(pct/100)):null;
  const upd={total_leads_generated:gen,meta_cpl:mcpl,pct_sold:pct!=null?Number(pct.toFixed(1)):null,true_cpl:trueCpl!=null?Number(trueCpl.toFixed(2)):null,updated_at:now()};
  btn.disabled=true; const orig=btn.textContent; btn.textContent='Saving…';
  const {error}=await db.from('clients').update(upd).eq('id',id);
  btn.disabled=false; btn.textContent=orig;
  if(error){ toast('Error: '+error.message,true); return; }
  if(CLIENT_CACHE[id]){ CLIENT_CACHE[id].total_leads_generated=gen; CLIENT_CACHE[id].meta_cpl=mcpl; CLIENT_CACHE[id].pct_sold=upd.pct_sold; CLIENT_CACHE[id].true_cpl=upd.true_cpl; }
  toast('CPL updated ✓');
}

function calcActiveMonths(startDate) {
  if (!startDate) return '-';
  const start = new Date(startDate + 'T00:00:00');
  const now = new Date();
  const months = (now.getFullYear()-start.getFullYear())*12+(now.getMonth()-start.getMonth());
  return months <= 0 ? '< 1 mo' : months + ' mo';
}
function calcNextPayment() {
  const adsLive = $('em-ads-live')?.value;
  const lastPay = $('em-last-pay')?.value;
  const v = adsLive || lastPay;
  if (!v) return;
  const d = new Date(v+'T00:00:00'); d.setDate(d.getDate()+30);
  setVal('em-next-pay', d.toISOString().split('T')[0]);
}
const _MG_MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Every year from 2026 (or the client's earliest ticked month) to this one,
// newest first. Saving keeps exactly the months shown here, so every year a
// client has months in must be on screen, or saving would drop them.
const _MG_FIRST_YEAR=2026;
function renderMonthPicker(activeMonthsJson){
  let active=[];
  try{active=JSON.parse(activeMonthsJson||'[]');}catch(e){}
  if(!Array.isArray(active)) active=[];
  const c=$('em-month-picker'); if(!c) return;
  const years=active.map(k=>+String(k).slice(0,4)).filter(Boolean);
  const from=Math.min(_MG_FIRST_YEAR,...years), to=Math.max(new Date().getFullYear(),...years);
  const rows=[];
  for(let y=to;y>=from;y--){
    rows.push(`<div><div style="font-family:var(--mono);font-size:12px;color:var(--ink3);margin-bottom:3px">${y}</div><div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px">${_MG_MONTHS.map((m,i)=>{
      const key=`${y}-${String(i+1).padStart(2,'0')}`;
      const on=active.includes(key);
      return `<button type="button" onclick="toggleMgMonth('${key}',this)" data-month="${key}" data-on="${on?'1':'0'}" style="font-family:var(--mono);font-size:12px;padding:5px 2px;border-radius:4px;border:1px solid ${on?'var(--acc)':'var(--bd)'};background:${on?'rgba(79,143,255,.15)':'var(--s2)'};color:${on?'var(--acc)':'var(--ink3)'};cursor:pointer;transition:all .14s;text-align:center">${m}</button>`;
    }).join('')}</div></div>`);
  }
  c.innerHTML=rows.join('');
  updateMgMonthSummary();
}
function toggleMgMonth(key,btn){
  const on=btn.dataset.on==='1';
  btn.dataset.on=on?'0':'1';
  btn.style.border=`1px solid ${on?'var(--bd)':'var(--acc)'}`;
  btn.style.background=on?'var(--s2)':'rgba(79,143,255,.15)';
  btn.style.color=on?'var(--ink3)':'var(--acc)';
  updateMgMonthSummary();
}
function updateMgMonthSummary(){
  const months=getActiveMgMonths();
  const fee=parseFloat($('em-fee')?.value)||0;
  const el=$('em-month-summary'); if(!el) return;
  const y=String(new Date().getFullYear()), thisYear=months.filter(m=>m.startsWith(y)).length;
  setText('em-month-summary',`${months.length} month${months.length!==1?'s':''} active · ${fmt(months.length*fee)} retainer revenue all time · ${thisYear} this year (${fmt(thisYear*fee)})`);
}
function getActiveMgMonths(){
  const btns=$('em-month-picker')?.querySelectorAll('button')||[];
  return [...btns].filter(b=>b.dataset.on==='1').map(b=>b.dataset.month);
}
// Cash-basis retainer attribution: returns one "YYYY-MM" per active month for a
// managed client, mapped to the month the retainer was *paid* (recorded when the
// month was toggled on) rather than the month it covers. Falls back to the
// covered month for legacy rows that have no recorded payment date.
// What each paid month actually brought in, on the same cash basis: one
// {m: "YYYY-MM" paid in, amt} per active month. The amount is what was really
// paid for that month (retainer_amounts: the invoice total, or the Stripe
// charge), falling back to the client's management fee for a month ticked by
// hand. Rates vary, so the fee alone over- or under-counts.
function mgPayments(client){
  let months=[];try{months=JSON.parse(client.active_months||'[]');}catch(e){}
  let pd={};try{pd=JSON.parse(client.retainer_payment_dates||'{}');}catch(e){}
  let am={};try{am=typeof client.retainer_amounts==='string'?JSON.parse(client.retainer_amounts||'{}'):(client.retainer_amounts||{});}catch(e){}
  const fee=Number(client.management_fee||0);
  return months.map(m=>({m:(pd&&pd[m])?String(pd[m]).slice(0,7):m, amt:(am&&am[m]!=null&&isFinite(Number(am[m])))?Number(am[m]):fee}));
}
// Sum of mgPayments in the months that pass `keep`; clients with no month
// list at all fall back to payments_made x fee, as before.
function mgRetainerSum(client, keep){
  if (client.active_months==null) return (client.payments_made||0)*(client.management_fee||0);
  return mgPayments(client).filter(p=>keep(p.m)).reduce((a,p)=>a+p.amt,0);
}
function mgPaymentMonths(client){
  let months=[];try{months=JSON.parse(client.active_months||'[]');}catch(e){}
  let pd={};try{pd=JSON.parse(client.retainer_payment_dates||'{}');}catch(e){}
  return months.map(m=>(pd&&pd[m])?String(pd[m]).slice(0,7):m);
}
function calcNextPaymentNew() {
  const adsLive = $('mg-ads-live')?.value;
  const lastPay = $('mg-last-pay')?.value;
  const v = adsLive || lastPay;
  if (!v) return;
  const d = new Date(v+'T00:00:00'); d.setDate(d.getDate()+30);
  setVal('mg-next-pay', d.toISOString().split('T')[0]);
}
function renderManagedPayments(clients, orderLog=[]) {
  const tb = $('mg-payment-tbody'); if (!tb) return;
  const active = clients.filter(c => c.stage === 'active' || c.stage === 'onboarding');
  if (!active.length) { tb.innerHTML='<tr><td colspan="10" class="empty">No active or onboarding managed clients.</td></tr>'; return; }
  const today = new Date().toISOString().split('T')[0];
  tb.innerHTML = active.map(c => {
    const np = c.next_payment_date;
    const overdue = np && np < today;
    const paysMade = c.payments_made || 0;
    const fee = c.management_fee || 0;
    const retainerTotal = c.active_months!=null ? mgPayments(c).reduce((a,p)=>a+p.amt,0) : paysMade * fee;
    const customOrders = orderLog.filter(o => o.client_id === c.id).reduce((s,o) => s + (o.amount||0), 0);
    const lifetime = retainerTotal + customOrders;
    return `<tr style="cursor:pointer" data-client-id="${esc(String(c.id))}" data-client-type="managed" class="client-row">
      <td><strong>${esc(c.company_name)}</strong></td>
      <td style="font-family:var(--mono);font-size:12px">${c.start_date||'-'}</td>
      <td style="font-family:var(--mono);font-weight:600;color:var(--acc)">${paysMade}</td>
      <td style="font-family:var(--mono)">${fee>0?fmt(fee):'-'}</td>
      <td style="font-family:var(--mono);color:var(--grn)">${retainerTotal>0?fmt(retainerTotal):'-'}</td>
      <td style="font-family:var(--mono);color:var(--acc)">${customOrders>0?fmt(customOrders):'-'}</td>
      <td style="font-family:var(--mono);font-weight:700;color:var(--grn)">${lifetime>0?fmt(lifetime):'-'}</td>
      <td style="font-family:var(--mono);font-size:12px">${c.last_payment_date||'-'}</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:${overdue?'600':'400'};color:${overdue?'var(--red)':np?'var(--grn)':'var(--ink3)'}">${np?(np+(overdue?' ⚠ Overdue':'')):'-'}</td>
      <td><button class="btn btn-xs" onclick="logRetainerPayment(${c.id})">+ Payment</button></td>
    </tr>`;
  }).join('');
  tb.querySelectorAll('.client-row').forEach(row=>{
    row.addEventListener('click',e=>{
      if (e.target.closest('button')) return;
      const id=row.dataset.clientId; if(CLIENT_CACHE[id]) openEditClient('managed',CLIENT_CACHE[id]);
    });
  });
}

async function loadManagedOrderLog(clientId) {
  const el=$('em-order-log'); if(!el) return;
  el.textContent='Loading…';
  const {data,error}=await db.from('managed_order_log').select('*').eq('client_id',clientId).order('order_date',{ascending:false});
  if (error) { el.textContent='Error loading orders.'; return; }
  el.innerHTML=renderManagedOrderLogTable(data||[], clientId);
}
function renderManagedOrderLogTable(data, clientId) {
  if (!data.length) return '<div style="color:var(--ink3);padding:4px 0">No custom orders logged yet.</div>';
  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="font-size:12px;color:var(--ink3);text-transform:uppercase;letter-spacing:.05em">
      <th style="text-align:left;padding:3px 6px;font-weight:500">Date</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Description</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Amount</th>
      <th></th>
    </tr></thead>
    <tbody>${data.map(o=>`<tr style="border-top:1px solid var(--bd)">
      <td style="padding:4px 6px;color:var(--ink2)">${o.order_date||'-'}</td>
      <td style="padding:4px 6px;color:var(--ink)">${esc(o.description||'-')}</td>
      <td style="padding:4px 6px;color:var(--grn);font-weight:600">${o.amount?fmt(o.amount):'-'}</td>
      <td style="padding:4px 6px"><button class="btn btn-xs btn-red" onclick="deleteManagedOrder('${esc(o.id)}','${esc(clientId)}')">✕</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}
async function logManagedOrder() {
  const clientId=$('em-id').value;
  const desc=$('em-ord-desc').value.trim();
  const amount=parseFloat($('em-ord-amount').value)||0;
  const date=$('em-ord-date').value||localDateStr();
  if (!desc) { toast('Description required',true); return; }
  if (!amount) { toast('Amount required',true); return; }
  const {error}=await db.from('managed_order_log').insert([{client_id:clientId,description:desc,amount,order_date:date,created_at:now()}]);
  if (error) { toast('Error: '+error.message,true); return; }
  $('em-ord-desc').value='';$('em-ord-amount').value='';
  toast('Order logged ✓');
  loadManagedOrderLog(clientId);
  loadManaged();
}
async function deleteManagedOrder(orderId, clientId) {
  if (!confirm('Delete this order?')) return;
  const {error}=await db.from('managed_order_log').delete().eq('id',orderId);
  if (error) { toast('Error: '+error.message,true); return; }
  toast('Order deleted');
  loadManagedOrderLog(clientId);
  loadManaged();
}
async function logRetainerPayment(clientId) {
  const c=CLIENT_CACHE[clientId]; if (!c) return;
  const today=new Date().toISOString().split('T')[0];
  const monthKey=today.slice(0,7); // YYYY-MM
  let months=[];
  try{months=JSON.parse(c.active_months||'[]');}catch(e){}
  if (months.includes(monthKey)) {
    toast(`${monthKey} retainer already logged`,true);
    return;
  }
  months.push(monthKey);
  months.sort();
  const newCount=months.length;
  // Record the payment date for this month so Finance attributes the fee to the
  // month it was received (cash basis). Here covered month == payment month.
  let payDates={};try{payDates=JSON.parse(c.retainer_payment_dates||'{}');}catch(e){}
  payDates[monthKey]=today;
  const {error}=await db.from('clients').update({payments_made:newCount,active_months:JSON.stringify(months),retainer_payment_dates:JSON.stringify(payDates),last_payment_date:today,updated_at:now()}).eq('id',clientId);
  if (error) { toast('Error: '+error.message,true); return; }
  // Keep cache in sync so subsequent clicks see the updated month list before reload completes.
  c.payments_made=newCount;
  c.active_months=JSON.stringify(months);
  c.retainer_payment_dates=JSON.stringify(payDates);
  c.last_payment_date=today;
  toast(`Payment #${newCount} logged ✓`);
  loadManaged();
  // Refresh Finance so Retainer Revenue / Total Revenue / MRR pick up the new month.
  loadFinance();
}

// Cost cut-off: the most Meta can charge per lead and still leave the target
// margin of the price ex GST, after paying the rep commission, replacing duds
// and paying Stripe. Same formula as maxCplFor in meta-cost-check.
//
//   price ex-GST by default (priceIncludesGst = false):
//     revenue = price, gross = price x (1 + gst rate)
//   price includes GST (priceIncludesGst = true):
//     revenue = price / (1 + gst rate), gross = price
//   commission = commission base x rep commission %, base is revenue ex-GST
//     by default ('ex') so a 15% commission on a $100 lead is $15, not $15 + GST
//   max CPL = (revenue - commission - stripe - margin kept) / (1 + dud rate)
//
// price is the $/lead listed; Meta spend has no GST.
function maxCplFor(price, s) {
  const gst = s.gstRate / 100
  const gross = s.priceIncludesGst ? price : price * (1 + gst)
  const revenue = s.priceIncludesGst ? price / (1 + gst) : price
  const base = s.commissionBase === 'inc' ? gross : revenue
  const rep = base * s.repCommission / 100
  const stripe = gross * s.stripe / 100 + (s.stripeFixed || 0)
  const kept = revenue * s.margin / 100
  return Math.max(0, (revenue - rep - stripe - kept) / (1 + s.dud / 100))
}
// Merge business settings with an order's own commission override (null =
// fall back to business default).
function orderSettings(s, order) {
  if (!s) s = { margin: 30, dud: 12, stripe: 1.75, gstRate: 10, priceIncludesGst: false, repCommission: 15, commissionBase: 'ex', stripeFixed: 0.30 };
  if (!order) return s;
  return {
    ...s,
    repCommission: order.repCommission != null ? order.repCommission : s.repCommission,
    commissionBase: order.commissionBase || s.commissionBase,
  };
}
let _cplSettings;
async function ensureCplSettings() {
  if (_cplSettings !== undefined) return;
  const {data} = await db.from('business_settings').select('target_margin_pct,dud_rate_pct,stripe_fee_pct,gst_rate_pct,price_includes_gst,rep_commission_pct,commission_base,stripe_fee_fixed').limit(1).maybeSingle();
  _cplSettings = data?.target_margin_pct == null ? null
    : { margin: Number(data.target_margin_pct), dud: Number(data.dud_rate_pct || 0), stripe: Number(data.stripe_fee_pct || 0),
        gstRate: Number(data.gst_rate_pct || 10), priceIncludesGst: data.price_includes_gst === true,
        repCommission: Number(data.rep_commission_pct || 0), commissionBase: data.commission_base || 'ex',
        stripeFixed: Number(data.stripe_fee_fixed || 0) };
}
async function openCplCalc() {
  _cplSettings = undefined;
  await ensureCplSettings();
  const s = _cplSettings || { margin: 30, dud: 12, stripe: 1.75, gstRate: 10, priceIncludesGst: false, repCommission: 15, commissionBase: 'ex', stripeFixed: 0.30 };
  if ($('cc-price').value === '') setVal('cc-price', 88);
  setVal('cc-margin', s.margin);
  setVal('cc-dud', s.dud);
  setVal('cc-stripe', s.stripe);
  setVal('cc-gst', s.gstRate);
  setVal('cc-price-inc-gst', s.priceIncludesGst ? '1' : '0');
  setVal('cc-rep-commission', s.repCommission);
  setVal('cc-commission-base', s.commissionBase);
  setVal('cc-stripe-fixed', s.stripeFixed);
  calcCpl();
  openModal('m-cpl-calc');
}
function calcCpl() {
  const num = (id) => parseFloat($(id).value) || 0;
  const price = num('cc-price');
  const s = {
    margin: num('cc-margin'), dud: num('cc-dud'), stripe: num('cc-stripe'),
    gstRate: num('cc-gst'), priceIncludesGst: $('cc-price-inc-gst').value === '1',
    repCommission: num('cc-rep-commission'), commissionBase: $('cc-commission-base').value,
    stripeFixed: num('cc-stripe-fixed'),
  };
  const m = (n) => '$' + n.toFixed(2);
  const gst = s.gstRate / 100;
  const gross = s.priceIncludesGst ? price : price * (1 + gst);
  const revenue = s.priceIncludesGst ? price / (1 + gst) : price;
  const gstAmount = gross - revenue;
  const base = s.commissionBase === 'inc' ? gross : revenue;
  const rep = base * s.repCommission / 100;
  const stripe = gross * s.stripe / 100 + s.stripeFixed;
  const kept = revenue * s.margin / 100;
  const max = maxCplFor(price, s);
  const line = (k, v, strong) => `<div style="display:flex;justify-content:space-between;padding:2px 0${strong ? ';font-weight:700;color:var(--ink)' : ';color:var(--ink2)'}"><span>${k}</span><span>${v}</span></div>`;
  $('cc-out').innerHTML = !price ? '<span style="color:var(--ink3)">Enter a price per lead.</span>' :
    line('Price listed', m(price)) +
    line(s.priceIncludesGst ? 'GST included in price' : 'GST on top of price', m(s.priceIncludesGst ? gstAmount : 0)) +
    line('Revenue ex GST', m(revenue)) +
    line(`Rep commission (${s.repCommission}% on ${s.commissionBase === 'inc' ? 'payment incl GST' : 'revenue ex GST'})`, '−' + m(rep)) +
    line(`Stripe fee (${s.stripe}% + ${m(s.stripeFixed)} fixed)`, '−' + m(stripe)) +
    line(`Margin kept (${s.margin}% of revenue ex GST)`, '−' + m(kept)) +
    line(`Left for ads (${(1 + s.dud / 100).toFixed(2)} leads per sale)`, m(max * (1 + s.dud / 100))) +
    `<div style="border-top:1px solid var(--bd);margin:6px 0"></div>` + line('Max Meta cost per lead', m(max), true);
  const actual = num('cc-actual');
  if (!price || !actual) { $('cc-actual-out').innerHTML = ''; return; }
  const cost = actual * (1 + s.dud / 100) + stripe;
  const profit = revenue - rep - cost;
  const pct = revenue > 0 ? profit / revenue * 100 : 0;
  const ok = actual <= max;
  $('cc-actual-out').innerHTML = line('Cost per paid lead (inc duds and Stripe)', m(cost)) + line('Profit per lead', m(profit)) +
    `<div style="margin-top:4px;font-weight:700;color:${ok ? 'var(--grn)' : 'var(--red)'}">${pct.toFixed(1)}% margin · ${ok ? 'under the max, keeps running' : 'over the max, gets cut off'}</div>`;
}
function orderMaxCplCell(o, delivered) {
  const own = o.max_cpl != null;
  const s = orderSettings(_cplSettings, o);
  const max = own ? Number(o.max_cpl)
    : (_cplSettings && o.lead_price) ? maxCplFor(Number(o.lead_price), s) : null;
  if (max === null) return '-';
  const breached = o.cpl_breached_at && !delivered;
  const orderComm = o.rep_commission_pct != null ? o.rep_commission_pct : s.repCommission;
  const orderBase = o.commission_base || s.commissionBase;
  const title = breached ? `Recent cost per lead is over this order's max (since ${o.cpl_breached_at.slice(0,10)})`
    : own ? 'Set on this order' : `Default: leaves ${s.margin}% margin after ${orderComm}% rep commission (${orderBase === 'inc' ? 'payment incl GST' : 'revenue ex GST'}), ${s.dud}% duds and ${s.stripe}% Stripe, on a ${s.priceIncludesGst ? 'GST-inclusive' : 'ex-GST'} lead price`;
  return `<span title="${esc(title)}" style="color:${breached?'var(--red)':own?'var(--ink2)':'var(--ink3)'}">${breached?'⚠ ':''}$${max.toFixed(0)}${own?'':' <span style="font-size:11px">default</span>'}</span>`;
}
function renderOrderLogTable(data, clientId) {
  if (!data.length) return '<div style="color:var(--ink3);padding:4px 0">No orders logged yet.</div>';
  const today = new Date().toISOString().split('T')[0];
  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="font-size:12px;color:var(--ink3);text-transform:uppercase;letter-spacing:.05em">
      <th style="text-align:left;padding:3px 6px;font-weight:500">Date</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Sold</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Generated</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">% Sold</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">$/Lead</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Meta CPL</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Max CPL</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">SLA Due</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Status</th>
      <th style="text-align:left;padding:3px 6px;font-weight:500">Notes</th>
      <th></th>
    </tr></thead>
    <tbody>${data.map(o=>{
      const pct = (o.leads_generated&&o.leads_qty) ? (o.leads_qty/o.leads_generated*100).toFixed(0)+'%' : '-';
      const delivered = o.status==='delivered';
      const statusBadge = delivered
        ? `<span style="font-family:var(--mono);font-size:12px;color:var(--grn);background:rgba(46,204,138,.1);padding:1px 6px;border-radius:3px">Delivered</span>`
        : `<span style="font-family:var(--mono);font-size:12px;color:var(--amb);background:rgba(245,166,35,.1);padding:1px 6px;border-radius:3px">In Progress</span>`;
      const action = delivered ? '' : `<button class="btn btn-xs" onclick="markOrderDelivered('${esc(o.id)}','${esc(clientId||o.client_id)}')">Mark Delivered</button>`;
      const slaOverdue = !delivered && o.sla_due_date && o.sla_due_date < today;
      const slaBadge = !o.sla_due_date ? '-'
        : delivered ? `<span style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${o.sla_due_date}</span>`
        : slaOverdue ? `<span style="font-family:var(--mono);font-size:12px;color:var(--red);font-weight:600">⚠ ${o.sla_due_date}</span>`
        : `<span style="font-family:var(--mono);font-size:12px;color:var(--grn)">${o.sla_due_date}</span>`;
      return `<tr style="border-top:1px solid var(--bd)${slaOverdue?' background:rgba(255,69,96,.04)':''}">
        <td style="padding:4px 6px;color:var(--ink2)">${o.order_date||'-'}</td>
        <td style="padding:4px 6px;font-weight:600;color:var(--ink)">${o.leads_qty}</td>
        <td style="padding:4px 6px;color:var(--ink2)">${o.leads_generated||'-'}</td>
        <td style="padding:4px 6px;color:${delivered?'var(--acc)':'var(--ink3)'}">${pct}</td>
        <td style="padding:4px 6px;color:var(--grn)">${o.lead_price?'$'+Number(o.lead_price).toFixed(0):'-'}</td>
        <td style="padding:4px 6px;color:var(--ink3);font-family:var(--mono)">${o.meta_cpl?'$'+Number(o.meta_cpl).toFixed(2):'-'}</td>
        <td style="padding:4px 6px;font-family:var(--mono)">${orderMaxCplCell(o, delivered)}</td>
        <td style="padding:4px 6px">${slaBadge}</td>
        <td style="padding:4px 6px">${statusBadge}</td>
        <td style="padding:4px 6px;color:var(--ink3)">${esc(o.notes||'-')}</td>
        <td style="padding:4px 6px;display:flex;gap:4px">${action}<button class="btn btn-xs" onclick="editPplOrder('${esc(o.id)}','${esc(clientId||o.client_id)}')">Edit</button><button class="btn btn-xs btn-red" onclick="deletePplOrder('${esc(o.id)}','${esc(clientId||o.client_id)}')">✕</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}
async function loadPplOrderLog(clientId) {
  const el = $('ep-order-log'); if (!el) return;
  el.innerHTML='Loading…';
  const [{data}] = await Promise.all([
    db.from('ppl_order_log').select('*').eq('client_id',clientId).order('order_date',{ascending:false}),
    ensureCplSettings(),
  ]);
  el.innerHTML = renderOrderLogTable(data||[], clientId);
}
async function deletePplOrder(orderId, clientId) {
  if (!confirm('Delete this order?')) return;
  const {error}=await db.from('ppl_order_log').delete().eq('id',orderId);
  if (error) { toast('Error: '+error.message,true); return; }
  toast('Order deleted');
  loadPplOrderLog(clientId);
  loadPPL();
}
async function editPplOrder(orderId, clientId) {
  const {data,error}=await db.from('ppl_order_log').select('*').eq('id',orderId).maybeSingle();
  if (error||!data) { toast('Could not load order',true); return; }
  setVal('epo-id',data.id);
  setVal('epo-client-id',clientId);
  setVal('epo-date',data.order_date||'');
  setVal('epo-qty',data.leads_qty||'');
  setVal('epo-gen',data.leads_generated||'');
  setVal('epo-price',data.lead_price||'');
  setVal('epo-rep-commission',data.rep_commission_pct==null?'':data.rep_commission_pct);
  setVal('epo-commission-base',data.commission_base||'');
  setVal('epo-meta-cpl',data.meta_cpl||'');
  setVal('epo-max-cpl',data.max_cpl??'');
  setVal('epo-status',data.status||'in_progress');
  setVal('epo-notes',data.notes||'');
  setVal('epo-purchase-date',data.purchase_date||'');
  setVal('epo-sla-due',data.sla_due_date||'');
  openModal('m-edit-ppl-order');
}
async function updatePplOrder() {
  const orderId=$('epo-id').value;
  const clientId=$('epo-client-id').value;
  const qty=parseInt($('epo-qty').value)||0;
  const gen=$('epo-gen').value!==''?parseInt($('epo-gen').value):null;
  const price=$('epo-price').value!==''?parseFloat($('epo-price').value):null;
  const repCommission=$('epo-rep-commission').value!==''?parseFloat($('epo-rep-commission').value):null;
  const commissionBase=$('epo-commission-base').value||null;
  const metaCpl=$('epo-meta-cpl').value!==''?parseFloat($('epo-meta-cpl').value):null;
  const maxCpl=$('epo-max-cpl').value!==''?parseFloat($('epo-max-cpl').value):null;
  const status=$('epo-status').value;
  const notes=$('epo-notes').value.trim();
  const date=$('epo-date').value||null;
  if (!qty) { toast('Leads sold qty required',true); return; }
  const upd={leads_qty:qty,status,notes,order_date:date};
  if (price!==null) upd.lead_price=price;
  upd.rep_commission_pct=repCommission;
  upd.commission_base=commissionBase;
  if (gen!==null) upd.leads_generated=gen; else upd.leads_generated=null;
  if (metaCpl!==null) upd.meta_cpl=metaCpl; else upd.meta_cpl=null;
  upd.max_cpl=maxCpl;
  const purchaseDate=$('epo-purchase-date').value||null;
  const slaDue=$('epo-sla-due').value||null;
  upd.purchase_date=purchaseDate;
  upd.sla_due_date=slaDue;
  const {error}=await db.from('ppl_order_log').update(upd).eq('id',orderId);
  if (error) { toast('Error: '+error.message,true); return; }
  await recalcPplClient(clientId);
  toast('Order updated ✓');
  closeModal('m-edit-ppl-order');
  loadPplOrderLog(clientId);
  const cell=$('ol-cell-'+clientId);
  if (cell&&$('ol-row-'+clientId)?.style.display!=='none') {
    const {data}=await db.from('ppl_order_log').select('*').eq('client_id',clientId).order('order_date',{ascending:false});
    cell.innerHTML=renderOrderLogTable(data||[],clientId);
  }
  loadPPL();
}
async function toggleInlineOrderLog(clientId) {
  const row=$('ol-row-'+clientId), cell=$('ol-cell-'+clientId);
  if (!row) return;
  const open = row.style.display!=='none';
  row.style.display = open ? 'none' : '';
  if (!open) {
    cell.innerHTML='Loading…';
    await ensureCplSettings();
    const {data} = await db.from('ppl_order_log').select('*').eq('client_id',clientId).order('order_date',{ascending:false});
    cell.innerHTML = renderOrderLogTable(data||[], clientId);
  }
}
async function recalcPplClient(clientId) {
  const [{data:orders},{data:client}] = await Promise.all([
    db.from('ppl_order_log').select('leads_qty,leads_generated').eq('client_id',clientId).eq('status','delivered'),
    db.from('clients').select('meta_cpl').eq('id',clientId).maybeSingle()
  ]);
  const totalSold=(orders||[]).reduce((s,r)=>s+(r.leads_qty||0),0);
  const totalGen=(orders||[]).reduce((s,r)=>s+(r.leads_generated||0),0);
  const pctSold=totalGen>0?(totalSold/totalGen*100):null;
  const metaCpl=client?.meta_cpl;
  const trueCpl=(pctSold&&metaCpl)?metaCpl/(pctSold/100):null;
  const upd={updated_at:now()};
  if (pctSold!==null) upd.pct_sold=Number(pctSold.toFixed(1));
  if (trueCpl!==null) upd.true_cpl=Number(trueCpl.toFixed(2));
  if (totalGen>0) upd.total_leads_generated=totalGen;
  await db.from('clients').update(upd).eq('id',clientId);
  const tgEl=$('ep-total-gen');
  if (tgEl&&totalGen>0) tgEl.value=totalGen;
}
async function markOrderDelivered(orderId, clientId) {
  const gen=prompt('How many leads were generated to fulfill this order?');
  if (gen===null) return;
  const leadsGenerated=parseInt(gen)||0;
  if (!leadsGenerated) { toast('Enter a valid number',true); return; }
  const {error}=await db.from('ppl_order_log').update({status:'delivered',leads_generated:leadsGenerated}).eq('id',orderId);
  if (error) { toast('Error: '+error.message,true); return; }
  await recalcPplClient(clientId);
  toast('Delivered - % sold & True CPL updated ✓');
  loadPplOrderLog(clientId);
  const cell=$('ol-cell-'+clientId);
  if (cell&&$('ol-row-'+clientId)?.style.display!=='none') {
    const {data}=await db.from('ppl_order_log').select('*').eq('client_id',clientId).order('order_date',{ascending:false});
    cell.innerHTML=renderOrderLogTable(data||[],clientId);
  }
  loadPPL();
}
async function logPplOrder() {
  const clientId=$('ep-id').value;
  const qty=parseInt($('ep-ord-qty').value)||0;
  const gen=parseInt($('ep-ord-gen').value)||0;
  const price=parseFloat($('ep-ord-price').value)||0;
  const repCommission=$('ep-ord-rep-commission').value!==''?parseFloat($('ep-ord-rep-commission').value):null;
  const metaCpl=parseFloat($('ep-ord-meta-cpl').value)||null;
  const maxCpl=parseFloat($('ep-ord-max-cpl').value)||null;
  const date=$('ep-ord-date').value||new Date().toISOString().split('T')[0];
  const purchaseDate=$('ep-ord-purchase-date').value||null;
  const slaDue=$('ep-ord-sla-due').value||null;
  const status=$('ep-ord-status').value||'in_progress';
  const notes=$('ep-ord-notes').value.trim();
  if (!qty) { toast('Enter lead quantity',true); return; }
  const row={client_id:clientId,leads_qty:qty,lead_price:price,rep_commission_pct:repCommission,notes,order_date:date,status,created_at:now()};
  if (gen) row.leads_generated=gen;
  if (metaCpl) row.meta_cpl=metaCpl;
  if (maxCpl) row.max_cpl=maxCpl;
  if (purchaseDate) row.purchase_date=purchaseDate;
  if (slaDue) row.sla_due_date=slaDue;
  const {error:insErr}=await db.from('ppl_order_log').insert([row]);
  if (insErr) { toast('Error: '+insErr.message,true); return; }
  const {count}=await db.from('ppl_order_log').select('id',{count:'exact',head:true}).eq('client_id',clientId);
  const client=CLIENT_CACHE[clientId];
  const newTotal=(client?.total_leads_purchased||0)+qty;
  await db.from('clients').update({total_leads_purchased:newTotal,has_reordered:(count||0)>=2,updated_at:now()}).eq('id',clientId);
  if (status==='delivered'&&gen) await recalcPplClient(clientId);
  toast('Order logged ✓');
  $('ep-ord-qty').value='';$('ep-ord-gen').value='';$('ep-ord-price').value='';$('ep-ord-rep-commission').value='';$('ep-ord-meta-cpl').value='';$('ep-ord-max-cpl').value='';$('ep-ord-notes').value='';$('ep-ord-status').value='in_progress';$('ep-ord-purchase-date').value='';$('ep-ord-sla-due').value='';
  loadPplOrderLog(clientId);
  loadPPL();
}
