'use strict';

const PPL_STAGES=[{id:'active_client',label:'Active'},{id:'paused',label:'Paused'},{id:'churned',label:'Churned'}];
async function loadPPL() {
  const yr = new Date().getFullYear()+'-01-01';
  const [clientsR, ytdR, campR] = await Promise.all([
    db.from('clients').select('*').eq('type','ppl').order('created_at',{ascending:false}),
    db.from('ppl_order_log').select('leads_qty').gte('order_date',yr),
    db.from('meta_campaigns').select('meta_campaign_id,spend_mtd,leads_mtd'),
  ]);
  if (clientsR.error) { $('ppl-tbody').innerHTML=`<tr><td colspan="12" class="empty">Error: ${esc(clientsR.error.message)}</td></tr>`; return; }
  const ytdLeads = (ytdR.data||[]).reduce((s,r)=>s+(r.leads_qty||0),0);
  renderPPL(clientsR.data||[], ytdLeads, campR.data||[]);
}
function renderPPL(clients, ytdLeads=0, campaigns=[]) {
  setText('ppl-active',clients.filter(c=>c.stage==='active_client').length);
  setText('ppl-leads',ytdLeads);
  // CPL = campaign spend / campaign leads (both from Meta)
  const totalCampSpend=campaigns.reduce((s,c)=>s+(c.spend_mtd||0),0);
  const totalCampLeads=campaigns.reduce((s,c)=>s+(c.leads_mtd||0),0);
  setText('ppl-meta-cpl',totalCampSpend>0&&totalCampLeads>0?'$'+(totalCampSpend/totalCampLeads).toFixed(2):'-');
  const ac=clients.filter(c=>c.stage==='active_client'&&(c.true_cpl||0)>0);
  setText('ppl-true-cpl',ac.length?'$'+(ac.reduce((s,c)=>s+(c.true_cpl||0),0)/ac.length).toFixed(2):'-');
  const dueClients=clients.filter(c=>c.stage==='active_client'&&c.total_leads_purchased>0&&(c.leads_delivered||0)/c.total_leads_purchased>=0.75);
  setText('ppl-reorder-count',dueClients.length||'-');
  // Churn metrics
  const pplActive=clients.filter(c=>c.stage==='active_client').length;
  const pplPaused=clients.filter(c=>c.stage==='paused').length;
  const pplChurned=clients.filter(c=>c.stage==='churned').length;
  const pplTotal=clients.length;
  setText('ppl-total',pplTotal||'-');
  pplChurnMonthly=renderMonthlyChurn('ppl',clients.filter(c=>['active_client','paused','churned'].includes(c.stage)),pplChurnMonthly);
  setText('ppl-retention-rate',pplTotal>0?((pplActive+pplPaused)/pplTotal*100).toFixed(1)+'%':'-');
  pplChurnChart=renderChurnChart('chart-ppl-churn',pplActive,pplPaused,pplChurned,pplChurnChart);
  renderChurnBreakdown('ppl-churn-breakdown',pplActive,pplPaused,pplChurned);
  PPL_STAGES.forEach(s=>{
    const col=$('ppl-col-'+s.id),cnt=$('pplc-'+s.id);
    const sl=clients.filter(c=>c.stage===s.id);
    if (cnt) cnt.textContent=sl.length;
    if (col) {
      sl.forEach(c => { CLIENT_CACHE[c.id] = c; });
      col.innerHTML=sl.map(c=>{
        const cplAlert=c.true_cpl&&c.lead_price?(c.true_cpl>=c.lead_price?'danger':c.true_cpl>=c.lead_price*0.85?'warning':null):null;
        const dueReorder=c.stage==='active_client'&&c.total_leads_purchased>0&&(c.leads_delivered||0)/c.total_leads_purchased>=0.75;
        return `
        <div class="kcard" id="kc-ppl-${esc(String(c.id))}" data-client-id="${esc(String(c.id))}" data-client-type="ppl">
          <div class="kcard-name">${esc(c.company_name)}</div>
          <div class="kcard-meta">${esc(c.niche||'')} · ${c.leads_delivered||0} delivered · ${c.total_leads_purchased||0} purchased</div>
          ${c.cx_score!=null?`<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:${c.cx_score>=8?'var(--grn)':c.cx_score>=5?'var(--amb)':'var(--red)'}">CX ${c.cx_score}/10</div>`:''}
          ${c.phone?`<div class="kcard-phone">${esc(c.phone)}</div>`:''}
          ${c.meta_cpl?`<div class="kcard-val">CPL $${Number(c.meta_cpl).toFixed(2)}</div>`:''}
          ${c.weekly_cap||c.monthly_cap?`<div style="font-size:12px;color:var(--ink3);font-family:var(--mono);margin-top:2px">${c.weekly_cap?'W: '+c.weekly_cap+'/wk':''}${c.weekly_cap&&c.monthly_cap?' · ':''}${c.monthly_cap?'M: '+c.monthly_cap+'/mo':''}</div>`:''}
          ${c.meta_cap_paused?'<div style="font-size:12px;color:var(--red);font-family:var(--mono);margin-top:2px">⏸ Meta campaigns paused (cap hit)</div>':''}
          ${cplAlert==='danger'?'<div style="font-size:12px;color:var(--red);font-family:var(--mono);margin-top:3px">⚠ margin lost - true CPL exceeds sell price</div>':cplAlert==='warning'?'<div style="font-size:12px;color:var(--amb);font-family:var(--mono);margin-top:3px">⚠ low margin - true CPL near sell price</div>':''}
          ${dueReorder?'<div style="font-size:12px;color:var(--amb);font-family:var(--mono);margin-top:2px">↻ due for reorder</div>':''}
        </div>`}).join('');
      col.querySelectorAll('.kcard').forEach(card=>{
        const id=card.dataset.clientId;
        initCardDrag(card,id,'ppl');
        card.addEventListener('click',()=>{ if (CLIENT_CACHE[id]) openEditClient('ppl',CLIENT_CACHE[id]); });
      });
    }
  });
  const tb=$('ppl-tbody');
  if (!clients.length) { tb.innerHTML='<tr><td colspan="13" class="empty">No PPL clients yet.</td></tr>'; return; }
  clients.forEach(c => { CLIENT_CACHE[c.id] = c; });
  const stageOrder=s=>s==='active_client'?0:s==='paused'?1:2;
  tb.innerHTML=[...clients].sort((a,b)=>stageOrder(a.stage)-stageOrder(b.stage)).map(c=>{
    const leadsRem=(c.total_leads_purchased||0)-(c.leads_delivered||0)+(c.leads_scrubbed||0);
    const balRem=leadsRem*(c.lead_price||0);
    const reordBadge=c.has_reordered
      ?`<button class="badge bg-grn order-log-toggle" data-client-id="${esc(String(c.id))}" style="cursor:pointer;border:none;background:rgba(46,204,138,.12);color:var(--grn);padding:2px 7px;border-radius:3px;font-size:12px;font-family:var(--mono)">Yes ▾</button>`
      :`<span style="font-family:var(--mono);font-size:12px;color:var(--ink3)">No</span>`;
    const cplAlert=c.true_cpl&&c.lead_price?(c.true_cpl>=c.lead_price?'danger':c.true_cpl>=c.lead_price*0.85?'warning':null):null;
    const marginBadge=cplAlert==='danger'?` <span style="color:var(--red);font-size:12px;font-family:var(--mono)">⚠ losing</span>`:cplAlert==='warning'?` <span style="color:var(--amb);font-size:12px;font-family:var(--mono)">⚠ low</span>`:'';
    const dueReorder=c.stage==='active_client'&&c.total_leads_purchased>0&&(c.leads_delivered||0)/c.total_leads_purchased>=0.75;
    const scrubNote=(c.leads_scrubbed||0)>0?` <span style="font-size:12px;color:var(--amb);font-family:var(--mono)" title="${c.leads_scrubbed} scrubbed">✂${c.leads_scrubbed}</span>`:'';
    const remHtml=leadsRem>0?`${leadsRem}${scrubNote}${dueReorder?' <span style="font-size:12px;color:var(--amb);font-family:var(--mono)">↻</span>':''}`:'✓';
    return `
    <tr data-client-id="${esc(String(c.id))}" data-client-type="ppl" class="client-row" style="cursor:pointer">
      <td><strong>${esc(c.company_name)}</strong></td>
      <td><span class="badge ${stageBadge(c.stage)}">${stageLabel(c.stage)}</span></td>
      <td style="font-family:var(--mono);font-size:12px;color:${c.cx_score!=null?(c.cx_score>=8?'var(--grn)':c.cx_score>=5?'var(--amb)':'var(--red)'):'var(--ink3)'}">${c.cx_score!=null?c.cx_score+'/10':'-'}</td>
      <td>${esc(c.niche||'-')}</td>
      <td>${c.leads_mtd||0}</td>
      <td style="color:var(--grn);font-weight:500">${c.leads_delivered||0}</td>
      <td>${c.total_leads_purchased||0}</td>
      <td style="color:${leadsRem>0?'var(--amb)':'var(--ink3)'};font-weight:500">${remHtml}</td>
      <td>${fmtCpl(c.lead_price)}${marginBadge}</td>
      <td style="color:${balRem>0?'var(--red)':'var(--grn)'};font-weight:500">${balRem>0?fmt(balRem):'-'}</td>
      <td>${c.pct_sold?Number(c.pct_sold).toFixed(1)+'%':'-'}</td>
      <td>${reordBadge}</td>
      <td style="white-space:nowrap"><button class="btn btn-xs action-log-btn" data-client-id="${esc(String(c.id))}" data-client-name="${esc(c.company_name)}" style="margin-right:4px">Log</button><button class="btn btn-xs client-edit-btn" data-client-id="${esc(String(c.id))}" data-client-type="ppl">Edit</button></td>
    </tr>
    <tr id="ol-row-${esc(String(c.id))}" style="display:none">
      <td colspan="13" style="padding:0;border-top:none">
        <div id="ol-cell-${esc(String(c.id))}" style="padding:10px 14px;background:var(--s2);border-bottom:1px solid var(--bd);font-family:var(--mono);font-size:12px">Loading…</div>
      </td>
    </tr>`}).join('');
  tb.querySelectorAll('.client-row').forEach(row=>{
    row.addEventListener('click',e=>{
      if (e.target.classList.contains('client-edit-btn')||e.target.classList.contains('order-log-toggle')||e.target.classList.contains('action-log-btn')) return;
      const id=row.dataset.clientId,type=row.dataset.clientType;
      if (CLIENT_CACHE[id]) openEditClient(type,CLIENT_CACHE[id]);
    });
  });
  tb.querySelectorAll('.client-edit-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const id=btn.dataset.clientId,type=btn.dataset.clientType;
      if (CLIENT_CACHE[id]) openEditClient(type,CLIENT_CACHE[id]);
    });
  });
  tb.querySelectorAll('.order-log-toggle').forEach(btn=>{
    btn.addEventListener('click',e=>{ e.stopPropagation(); toggleInlineOrderLog(btn.dataset.clientId); });
  });
  tb.querySelectorAll('.action-log-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{ e.stopPropagation(); openActionLog(btn.dataset.clientId, btn.dataset.clientName); });
  });
}
