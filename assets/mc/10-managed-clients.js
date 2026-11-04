'use strict';

const MG_STAGES=[{id:'onboarding',label:'Onboarding'},{id:'active',label:'Active'},{id:'paused',label:'Paused'},{id:'churned',label:'Churned'}];
const MG_ONBOARDING_SUB_STAGES=['Paid & Signed','Form Filled','Meta/Google Access Granted','Assets Provided & Previews Pending','Previews Accepted'];
const MG_ACTIVE_STATUSES=['Ads Live','Ads Paused (Self Paused)','Ads Paused (Billing Issue)','Ads Scaling (+20% every 3-5 days)','Churned'];
// ─── Fulfilment (mirrored from ql-hq) ───────────────────────────────────────
// ql-hq owns fulfilment: its Team Panel is where CSMs, ops managers and media
// buyers actually work, so the steps and the audit trail live there and only the
// derived summary is mirrored onto `clients` (see 20260915000002). Read-only
// here by design - there is no control in this app that writes these columns,
// because two places writing the same state is how they end up disagreeing.
function fulfilChip(c) {
  // Nothing mirrored yet: either a client ql-hq has no company for, or the push
  // has not arrived. Saying nothing beats showing a confident 0/0.
  if (c.fulfilment_steps_total == null) return '';
  const settled = c.fulfilment_steps_settled || 0;
  const total   = c.fulfilment_steps_total   || 0;
  const blocked = c.fulfilment_blocked_count || 0;
  const due     = c.fulfilment_next_due ? new Date(c.fulfilment_next_due) : null;
  const overdue = due && due < new Date();
  const hrs     = overdue ? Math.floor((Date.now() - due.getTime()) / 3600000) : 0;
  const late    = hrs >= 48 ? Math.round(hrs / 24) + 'd late' : hrs + 'h late';
  const [col, bg, bd, txt] = blocked
    ? ['var(--red)', 'rgba(239,68,68,.1)', 'rgba(239,68,68,.25)', blocked + ' blocked']
    : overdue
      ? ['var(--amb)', 'rgba(245,158,11,.1)', 'rgba(245,158,11,.25)', late]
      : !c.fulfilment_next_step
        ? ['var(--grn)', 'rgba(16,185,129,.1)', 'rgba(16,185,129,.25)', 'onboarded']
        : ['var(--txt3)', 'rgba(160,160,184,.08)', 'var(--bd)', settled + '/' + total];
  return `<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:${col};background:${bg};border:1px solid ${bd};border-radius:3px;padding:1px 5px;display:inline-block">${esc(txt)}</div>`;
}

async function loadManaged() {
  const [{data,error},{data:orderData},{data:stuck,error:stuckErr}]=await Promise.all([
    db.from('clients').select('*').eq('type','managed').order('created_at',{ascending:false}),
    db.from('managed_order_log').select('*').order('order_date',{ascending:false}),
    // The definition of "stuck" lives in the fulfilment_stuck view, not here, so
    // this panel and anything added later cannot disagree about what it means.
    // It is security_invoker, so a sales rep reading it gets nothing.
    db.from('fulfilment_stuck').select('*').order('hours_overdue',{ascending:false})
  ]);
  if (error) { $('mg-tbody').innerHTML=`<tr><td colspan="10" class="empty">Error: ${esc(error.message)}</td></tr>`; return; }
  // Unpaid invoices past their due date, oldest per client: the card shows
  // these as overdue whatever the next payment date says, and a paid invoice
  // never does. Best effort: without them the card falls back to the date.
  try {
    const { data: inv } = await db.from('invoices').select('client_id, invoice_number, due_date, status')
      .eq('offer_type','managed').in('status',['sent','overdue']).lt('due_date', localDateStr()).order('due_date');
    const m = {}; (inv||[]).forEach(i => { if (i.client_id && !m[i.client_id]) m[i.client_id] = i; });
    UNPAID_INV = m;
  } catch (e) { UNPAID_INV = {}; }
  renderManaged(data||[], orderData||[]);
  renderFulfilStuck(stuck||[], stuckErr);
}

function renderFulfilStuck(rows, err) {
  const tb=$('mg-stuck-tbody'); if(!tb) return;
  // A missing view means the migration has not run yet. Say that rather than
  // showing an empty table that reads as "nothing is stuck".
  if (err) { tb.innerHTML=`<tr><td colspan="5" class="empty">Fulfilment mirror not available yet (${esc(err.message)})</td></tr>`; return; }
  if (!rows.length) { tb.innerHTML='<tr><td colspan="5" class="empty">Nothing overdue or blocked.</td></tr>'; return; }
  tb.innerHTML=rows.map(r=>{
    const hrs=r.hours_overdue||0;
    const late=hrs<=0?'-':hrs>=48?Math.round(hrs/24)+'d':hrs+'h';
    const step=(r.fulfilment_next_step||'').replace(/_/g,' ');
    return `<tr data-client-id="${esc(String(r.client_id))}" data-client-type="managed" style="cursor:pointer">
      <td><b>${esc(r.company_name||'(no name)')}</b></td>
      <td>${esc(r.onboarding_sub_stage||r.stage||'-')}</td>
      <td>${esc(step||'-')}</td>
      <td style="color:${hrs>0?'var(--amb)':'var(--txt3)'};font-family:var(--mono)">${esc(late)}</td>
      <td style="color:${r.fulfilment_blocked_count?'var(--red)':'var(--txt3)'};font-family:var(--mono)">${r.fulfilment_blocked_count||0}</td>
      <td style="font-family:var(--mono)">${r.fulfilment_steps_settled||0}/${r.fulfilment_steps_total||0}</td>
    </tr>`;
  }).join('');
  // Same click-through as every other managed table: CLIENT_CACHE is populated
  // by renderManaged, which runs just before this, so the row is already there.
  tb.querySelectorAll('tr[data-client-id]').forEach(tr=>{
    tr.addEventListener('click',()=>{
      const c=CLIENT_CACHE[tr.dataset.clientId];
      if (c) openEditClient('managed',c);
    });
  });
}
function renderManaged(clients, orderLog=[]) {
  setText('mg-active',clients.filter(c=>c.stage==='active').length);
  setText('mg-spend',fmt(clients.reduce((s,c)=>s+(c.spend_mtd||0),0)));
  // Mgmt Fee Revenue: active + onboarding clients both count toward MRR
  setText('mg-fees',fmt(
    clients.filter(c=>c.stage==='active'||c.stage==='onboarding').reduce((s,c)=>s+(c.management_fee||0),0)
  ));
  const ac=clients.filter(c=>c.cpl_7d_avg>0);
  setText('mg-cpl',ac.length?'$'+(ac.reduce((s,c)=>s+c.cpl_7d_avg,0)/ac.length).toFixed(2):'-');
  // Churn metrics
  const mgOnboarding=clients.filter(c=>c.stage==='onboarding').length;
  const mgActive=clients.filter(c=>c.stage==='active').length;
  const mgPaused=clients.filter(c=>c.stage==='paused').length;
  const mgChurned=clients.filter(c=>c.stage==='churned').length;
  const mgTotal=clients.length;
  setText('mg-total',mgTotal||'-');
  mgChurnMonthly=renderMonthlyChurn('mg',clients.filter(c=>['onboarding','active','paused','churned'].includes(c.stage)),mgChurnMonthly);
  setText('mg-retention-rate',mgTotal>0?((mgOnboarding+mgActive+mgPaused)/mgTotal*100).toFixed(1)+'%':'-');
  // Onboarding counts as Active here. A client being built is a client we have,
  // not a third state the reader has to reconcile.
  //
  // It was not only a labelling choice. Both renderers divide by the three
  // numbers they are handed and label that sum "Total (all-time)", so with
  // onboarding passed to neither, four clients were absent from the panel
  // entirely - not a slice, not the total. The figure read "88.9% churned" off
  // a population of 9 while the churn-rate metric beside it read 61.5% off the
  // real 13, and nothing on screen explained why two numbers about the same
  // clients disagreed.
  //
  // Deliberately only the managed side: PPL has no onboarding stage, and these
  // two renderers are shared, so folding it in at the call site keeps the PPL
  // chart honest.
  const mgLive=mgActive+mgOnboarding;
  mgChurnChart=renderChurnChart('chart-mg-churn',mgLive,mgPaused,mgChurned,mgChurnChart);
  renderChurnBreakdown('mg-churn-breakdown',mgLive,mgPaused,mgChurned);
  MG_STAGES.forEach(s=>{
    const col=$('mg-col-'+s.id),cnt=$('mgc-'+s.id);
    const sl=clients.filter(c=>c.stage===s.id);
    if (cnt) cnt.textContent=sl.length;
    if (col) {
      sl.forEach(c => { CLIENT_CACHE[c.id] = c; });
      col.innerHTML=sl.map(c=>`
        <div class="kcard" id="kc-mg-${esc(String(c.id))}" data-client-id="${esc(String(c.id))}" data-client-type="managed">
          <div class="kcard-name">${esc(c.company_name)}</div>
          ${c.stage==='onboarding'&&c.onboarding_sub_stage?`<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:var(--vio);background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.25);border-radius:3px;padding:1px 5px;display:inline-block">${esc(c.onboarding_sub_stage)}</div>`:''}
          ${c.stage==='onboarding'?fulfilChip(c):''}
          ${c.stage==='active'&&c.active_status?`<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:${c.active_status.startsWith('Ads Live')||c.active_status.startsWith('Ads Scaling')?'var(--grn)':c.active_status.startsWith('Churned')?'var(--red)':'var(--amb)'};background:${c.active_status.startsWith('Ads Live')||c.active_status.startsWith('Ads Scaling')?'rgba(16,185,129,.1)':c.active_status.startsWith('Churned')?'rgba(239,68,68,.1)':'rgba(245,158,11,.1)'};border:1px solid ${c.active_status.startsWith('Ads Live')||c.active_status.startsWith('Ads Scaling')?'rgba(16,185,129,.25)':c.active_status.startsWith('Churned')?'rgba(239,68,68,.25)':'rgba(245,158,11,.25)'};border-radius:3px;padding:1px 5px;display:inline-block">${esc(c.active_status)}</div>`:''}
          <div class="kcard-meta">${fmt(c.spend_mtd||0)} MTD</div>
          ${c.cx_score!=null?`<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:${c.cx_score>=8?'var(--grn)':c.cx_score>=5?'var(--amb)':'var(--red)'}">CX ${c.cx_score}/10</div>`:''}
          ${c.phone?`<div class="kcard-phone">${esc(c.phone)}</div>`:''}
          ${c.management_fee?`<div class="kcard-val">${fmt(c.management_fee)}/mo fee</div>`:''}
          ${c.stage==='churned'||(c.active_status||'').startsWith('Churned')?'':(UNPAID_INV[c.id]?unpaidChip(UNPAID_INV[c.id]):nextPayChip(c.next_payment_date))}
        </div>`).join('');
      col.querySelectorAll('.kcard').forEach(card=>{
        const id=card.dataset.clientId;
        initCardDrag(card,id,'mg');
        card.addEventListener('click',()=>{ if (CLIENT_CACHE[id]) openEditClient('managed',CLIENT_CACHE[id]); });
      });
    }
  });
  const tb=$('mg-tbody');
  if (!clients.length) { tb.innerHTML='<tr><td colspan="10" class="empty">No managed clients yet.</td></tr>'; return; }
  clients.forEach(c => { CLIENT_CACHE[c.id] = c; });
  tb.innerHTML=clients.map(c=>`
    <tr style="cursor:pointer" data-client-id="${esc(String(c.id))}" data-client-type="managed" class="client-row">
      <td><strong>${esc(c.company_name)}</strong></td>
      <td><span class="badge ${stageBadge(c.stage)}">${stageLabel(c.stage)}</span></td>
      <td style="font-family:var(--mono);font-size:12px;color:${c.cx_score!=null?(c.cx_score>=8?'var(--grn)':c.cx_score>=5?'var(--amb)':'var(--red)'):'var(--ink3)'}">${c.cx_score!=null?c.cx_score+'/10':'-'}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink2)">${esc(c.ad_account_id||'-')}</td>
      <td>${fmt(c.spend_mtd||0)}</td>
      <td>${fmtCpl(c.cpl_today)}</td>
      <td>${fmtCpl(c.cpl_7d_avg)}</td>
      <td>${c.leads_mtd||0}</td>
      <td>${fmt(c.management_fee||0)}</td>
      <td style="white-space:nowrap"><button class="btn btn-xs action-log-btn" data-client-id="${esc(String(c.id))}" data-client-name="${esc(c.company_name)}" style="margin-right:4px">Log</button><button class="btn btn-xs client-edit-btn" data-client-id="${esc(String(c.id))}" data-client-type="managed">Edit</button></td>
    </tr>`).join('');
  tb.querySelectorAll('.client-row').forEach(row=>{
    row.addEventListener('click',e=>{
      if (e.target.classList.contains('client-edit-btn')||e.target.classList.contains('action-log-btn')) return;
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
  tb.querySelectorAll('.action-log-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{ e.stopPropagation(); openActionLog(btn.dataset.clientId, btn.dataset.clientName); });
  });
  renderManagedPayments(clients, orderLog);
}
async function openEditClient(type,c) {
  if (type==='ppl') {
    setVal('ep-id',c.id);setVal('ep-co',c.company_name);setVal('ep-cn',c.contact_name);
    setVal('ep-em',c.email);setVal('ep-ph',c.phone);setVal('ep-niche',c.niche);
    setVal('ep-active-niches',Array.isArray(c.active_niches)?c.active_niches.join(', '):'');
    setVal('ep-price',c.lead_price);setVal('ep-meta-cpl',c.meta_cpl||'');setVal('ep-pct',c.pct_sold);
    setVal('ep-ld',c.leads_delivered||0);setVal('ep-tlp',c.total_leads_purchased||0);setVal('ep-scrubbed',c.leads_scrubbed||0);_prevScrubbed=c.leads_scrubbed||0;setVal('ep-total-gen',c.total_leads_generated||'');
    setVal('ep-stage',c.stage||'active_client');loadChurnedField('ep',c);setVal('ep-cx',c.cx_score!=null?c.cx_score:'');setVal('ep-notes',c.notes);
    const epPc=Array.isArray(c.postcodes)?c.postcodes.join(', '):(c.postcodes||'');
    setVal('ep-postcodes',epPc);
    setVal('ep-weekly-cap',c.weekly_cap!=null?c.weekly_cap:'');
    setVal('ep-monthly-cap',c.monthly_cap!=null?c.monthly_cap:'');
    await refreshCampaignDropdowns();setCheckedCampaigns('ep-campaign-picker',c.meta_campaign_ids||[]);
    const capStatusEl=$('ep-meta-cap-status');
    if(capStatusEl){if(c.meta_cap_paused){capStatusEl.innerHTML=`<div style="background:var(--red-dim);border:1px solid var(--red);border-radius:var(--r);padding:8px 10px;margin:6px 0;font-family:var(--mono);font-size:12px;color:var(--red)">⚠ Campaigns paused - ${esc(c.meta_cap_pause_reason||'cap hit')}<br><span style="color:var(--ink3);font-size:12px">${c.meta_cap_paused_at?'at '+new Date(c.meta_cap_paused_at).toLocaleString():''}</span><br><button class="btn btn-xs" style="margin-top:6px" onclick="metaUnpauseClient('${c.id}')">Unpause campaigns</button></div>`;}else{capStatusEl.innerHTML='';}}
    setVal('ep-delivery-method',c.delivery_method||'email');
    setVal('ep-delivery-email',c.delivery_email||'');
    setVal('ep-delivery-phone',c.delivery_phone||'');
    try{if($('ep-custom-fields')){const _cf=c.custom_fields||{};$('ep-custom-fields').value=_cf._text!=null?_cf._text:(Object.keys(_cf).length?JSON.stringify(_cf,null,2):'');}}catch(e){}
    setVal('ep-ql-hq-id',c.ql_hq_company_id||'');
    setVal('ep-has-ql-account',c.has_quoteleads_platform_account?'true':'false');
    setVal('ep-hq-bearer-token',c.hq_bearer_token||'');
    setVal('ep-client-webhook',c.client_webhook||'');
    setVal('ep-webhook-auth',c.webhook_auth_mode||(c.webhook_auth_enabled?'signature':'none'));
    setVal('ep-webhook-header',c.webhook_auth_header||'');
    setVal('ep-webhook-secret',c.webhook_secret||'');
    toggleWebhookSecret('ep');
    setVal('ep-has-custom-integration',c.has_custom_integration?'true':'false');
    toggleDeliveryFields('ep');
    setText('edit-ppl-sub',c.company_name||'');
    updatePplCalc();
    setVal('ep-ord-price',c.lead_price||'');
    setVal('ep-ord-date',new Date().toISOString().split('T')[0]);
    loadPplOrderLog(c.id);
    openModal('m-edit-ppl');
  } else {
    setVal('em-id',c.id);setVal('em-co',c.company_name);setVal('em-cn',c.contact_name);
    setVal('em-em',c.email);setVal('em-ph',c.phone);setVal('em-acc',c.ad_account_id);
    setVal('em-budget',c.monthly_budget);setVal('em-fee',c.management_fee);
    const mgStage=['onboarding','active','paused','churned'].includes(c.stage)?c.stage:'active';
    setVal('em-stage',mgStage);
    loadChurnedField('em',c);
    setVal('em-onboarding-sub-stage',c.onboarding_sub_stage||'');
    setVal('em-active-status',c.active_status||'');
    // Once ql-hq is mirroring fulfilment for this client, IT owns the onboarding
    // sub-stage: the value is derived from the actual steps and is overwritten
    // on every push. Editing it here would look like it worked and then silently
    // revert, so the control is locked with an explanation rather than left to
    // lie. active_status stays editable - that one is ql-mc's, and ql-hq only
    // ever fills it when it is empty.
    _mgFulfilMirrored = !!c.fulfilment_synced_at;
    const subSel = $('em-onboarding-sub-stage');
    if (subSel) {
      subSel.disabled = _mgFulfilMirrored;
      subSel.title = _mgFulfilMirrored
        ? 'Set automatically from the fulfilment checklist in the QuoteLeadsHQ Team Panel'
        : '';
    }
    const subNote = $('em-sub-stage-note');
    if (subNote) {
      subNote.style.display = _mgFulfilMirrored ? '' : 'none';
      subNote.textContent = _mgFulfilMirrored
        ? 'Set from the fulfilment checklist in the Team Panel · ' +
          (c.fulfilment_steps_settled || 0) + '/' + (c.fulfilment_steps_total || 0) + ' steps'
        : '';
    }
    updateMgSubStageVisibility();
    setVal('em-cx',c.cx_score!=null?c.cx_score:'');
    // Start date and ads first live date are the same fact; the two inputs
    // mirror each other, so fill whichever is empty from the other.
    setVal('em-start',c.start_date||c.ads_first_live_date||'');
    setVal('em-ads-live',c.ads_first_live_date||c.start_date||'');
    setVal('em-last-pay',c.last_payment_date||'');
    setVal('em-next-pay',c.next_payment_date||'');
    // Set in the Team Panel. Automatic = card charged by Stripe on the payment
    // date, so no invoice is drafted for this client.
    setText('em-billing-mode', c.billing_mode==='automatic'
      ? 'Automatic (card) · Stripe charges on the payment date, no invoice is drafted · change in the Team Panel'
      : 'Manual (invoice) · drafted 7 days before the payment date · change in the Team Panel');
    if ((c.ads_first_live_date || c.last_payment_date) && !c.next_payment_date) calcNextPayment();
    $('em-reminders-paused').checked=!!c.billing_reminders_paused;
    renderClientCsms(c);
    setVal('em-payments-made',c.payments_made||0);
    setVal('em-guarantee-terms',c.guarantee_terms||'');
    setVal('em-guarantee-start',c.guarantee_start||'');
    setVal('em-guarantee-end',c.guarantee_end||'');
    $('em-guarantee-meta').textContent = c.guarantee_set_at
      ? 'Last set by ' + (c.guarantee_set_by || 'someone') + ' on ' + new Date(c.guarantee_set_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})
      : '';
    syncGuaranteeFields();
    setVal('em-notes',c.notes);
    setVal('em-client-webhook',c.client_webhook||'');
    setVal('em-webhook-auth',c.webhook_auth_mode||(c.webhook_auth_enabled?'signature':'none'));
    setVal('em-webhook-header',c.webhook_auth_header||'');
    setVal('em-webhook-secret',c.webhook_secret||'');
    toggleWebhookSecret('em');
    setVal('em-has-custom-integration',c.has_custom_integration?'true':'false');
    setVal('em-ord-date',new Date().toISOString().split('T')[0]);
    setText('edit-mg-sub',c.company_name||'');
    renderMonthPicker(c.active_months||'[]');
    loadManagedOrderLog(c.id);
    openModal('m-edit-managed');
  }
}
// "Next payment 14 Oct" on a managed card: red once it is overdue, amber in the
// last three days, otherwise muted. Dates are YYYY-MM-DD in local time.
let UNPAID_INV = {};
function unpaidChip(inv) {
  const label=new Date(inv.due_date+'T00:00:00').toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  return `<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:var(--red)">${esc((inv.invoice_number||'Invoice')+' overdue since '+label)}</div>`;
}
function nextPayChip(d) {
  if (!d) return '';
  const due=new Date(d+'T00:00:00');
  if (isNaN(due)) return '';
  const today=new Date(); today.setHours(0,0,0,0);
  const days=Math.round((due-today)/86400000);
  const label=due.toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  const col=days<0?'var(--red)':days<=3?'var(--amb)':'var(--ink3)';
  const when=days<0?`overdue since ${label}`:days===0?'due today':`next payment ${label}`;
  return `<div style="font-size:12px;font-family:var(--mono);margin-top:2px;color:${col}">${esc(when)}</div>`;
}
// The churn date shows only for a churned client: a client moved to churned
// gets today's date from the database, and an existing one can be corrected.
// Sent only when the client row has the column, so saving works either side of
// the migration.
function loadChurnedField(prefix, c) {
  const el = $(prefix + '-churned'); if (!el) return;
  el.value = c.churned_at || '';
  el.dataset.has = 'churned_at' in c ? '1' : '';
  el.dataset.was = c.stage === 'churned' ? '1' : '';
  toggleChurnedRow(prefix);
}
function toggleChurnedRow(prefix) {
  const row = $(prefix + '-churned-row'), el = $(prefix + '-churned');
  const churned = $(prefix + '-stage')?.value === 'churned';
  if (row) row.style.display = churned && el?.dataset.has && el?.dataset.was ? '' : 'none';
}
function churnedPatch(prefix) {
  const el = $(prefix + '-churned');
  if (!el?.dataset.has || !el.dataset.was || $(prefix + '-stage')?.value !== 'churned') return {};
  return { churned_at: el.value || null };
}
function updateMgSubStageVisibility() {
  const stage=$('em-stage')?.value;
  const onbRow=$('em-onboarding-sub-row');
  const actRow=$('em-active-status-row');
  if (onbRow) onbRow.style.display=stage==='onboarding'?'':'none';
  if (actRow) actRow.style.display=stage==='active'?'':'none';
  toggleChurnedRow('em');
  // An active managed client is "Ads Live" unless another status was chosen.
  const st=$('em-active-status');
  if (stage==='active' && st && !st.value) st.value='Ads Live';
}
function toggleDeliveryFields(prefix) {
  const method = $(prefix === 'ep' ? 'ep-delivery-method' : 'ppl-delivery-method')?.value || 'email';
  // Derived from the method name so a new combination cannot leave a field
  // hidden, which would silently drop the address or number it needs.
  const showEmail = method.startsWith('email');
  const showPhone = method.includes('phone');
  const showCrm   = method.includes('crm');
  const emailRow = $(prefix + '-dm-email-row');
  const phoneRow = $(prefix + '-dm-phone-row');
  const crmRow   = $(prefix + '-dm-crm-row');
  if (emailRow) emailRow.style.display = showEmail ? '' : 'none';
  if (phoneRow) phoneRow.style.display = showPhone ? '' : 'none';
  if (crmRow)   crmRow.style.display   = showCrm   ? '' : 'none';
}
let _prevScrubbed=0;function updatePplCalc() {
  const price=parseFloat($('ep-price')?.value)||0;
  const ld=parseInt($('ep-ld')?.value)||0;
  const tlp=parseInt($('ep-tlp')?.value)||0;
  const scrubbed=parseInt($('ep-scrubbed')?.value)||0;
  const scrubbedDiff=scrubbed-_prevScrubbed;
  if(scrubbedDiff!==0){
    const newLd=Math.max(0,ld-scrubbedDiff);
    $('ep-ld').value=newLd;
    _prevScrubbed=scrubbed;
  }
  const currentLd=parseInt($('ep-ld')?.value)||0;
  const rem=tlp-currentLd;const bal=rem*price;
  const remEl=$('ep-leads-rem');const balEl=$('ep-bal-rem');const scrubNote=$('ep-scrub-note');
  if (remEl) remEl.textContent=rem>=0?rem:'0';
  if (scrubNote) scrubNote.textContent=scrubbed>0?` (${scrubbed} scrubbed)`:'';
  if (balEl) balEl.textContent=bal>0?'$'+Number(bal).toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0}):(rem<=0?'Delivered ✓':'-');
  if (balEl) balEl.style.color=bal>0?'var(--red)':'var(--grn)';
}
async function updateClient(type) {
  let id,d;
  if (type==='ppl') {
    id=$('ep-id').value;
    const _ld=parseInt($('ep-ld').value)||0;const _tlp=parseInt($('ep-tlp').value)||0;const _scrubbed=parseInt($('ep-scrubbed').value)||0;const _price=parseFloat($('ep-price').value)||0;const _balCalc=(_tlp-_ld)*_price;
    const _metaCpl=parseFloat($('ep-meta-cpl').value)||null;
    const _postcodes=$('ep-postcodes').value.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    const _cfRaw=$('ep-custom-fields').value.trim();const _customFields=_cfRaw?{_text:_cfRaw}:{};
    const _weeklyCap=$('ep-weekly-cap').value!==''?parseInt($('ep-weekly-cap').value):null;
    const _monthlyCap=$('ep-monthly-cap').value!==''?parseInt($('ep-monthly-cap').value):null;
    const _epMetaCampaignIds=getCheckedCampaigns('ep-campaign-picker');
    const _activeNiches=$('ep-active-niches').value.split(',').map(s=>s.trim()).filter(Boolean);
    d={company_name:$('ep-co').value.trim(),contact_name:$('ep-cn').value.trim(),email:$('ep-em').value.trim(),phone:$('ep-ph').value.trim(),niche:$('ep-niche').value,active_niches:_activeNiches,lead_price:_price,meta_cpl:_metaCpl,balance:_balCalc>=0?_balCalc:0,leads_delivered:_ld,total_leads_purchased:_tlp,leads_scrubbed:_scrubbed,stage:$('ep-stage').value,...churnedPatch('ep'),cx_score:$('ep-cx').value!==''?parseInt($('ep-cx').value):null,notes:$('ep-notes').value.trim(),postcodes:_postcodes,weekly_cap:_weeklyCap,monthly_cap:_monthlyCap,meta_campaign_ids:_epMetaCampaignIds.length?_epMetaCampaignIds:null,delivery_method:$('ep-delivery-method').value,delivery_email:$('ep-delivery-email').value.trim()||null,delivery_phone:$('ep-delivery-phone').value.trim()||null,custom_fields:_customFields,ql_hq_company_id:$('ep-ql-hq-id').value.trim()||null,has_quoteleads_platform_account:$('ep-has-ql-account').value==='true',hq_bearer_token:$('ep-hq-bearer-token').value.trim()||null,client_webhook:$('ep-client-webhook').value.trim()||null,webhook_auth_mode:(($('ep-webhook-auth').value!=='none'&&$('ep-webhook-secret').value.trim())?$('ep-webhook-auth').value:'none'),webhook_auth_header:($('ep-webhook-auth').value==='header'?($('ep-webhook-header').value.trim()||'Authorization'):null),webhook_auth_enabled:$('ep-webhook-auth').value==='signature'&&!!$('ep-webhook-secret').value.trim(),webhook_secret:$('ep-webhook-secret').value.trim()||null,has_custom_integration:$('ep-has-custom-integration').value==='true',meta_cap_paused:false,meta_cap_paused_at:null,meta_cap_pause_reason:null,updated_at:now()};
    const {count:deliveredCount}=await db.from('ppl_order_log').select('id',{count:'exact',head:true}).eq('client_id',id).eq('status','delivered');
    if (!(deliveredCount>0)) d.pct_sold=parseFloat($('ep-pct').value)||null;
    if (!d.company_name) { toast('Company name required',true); return; }
  } else {
    id=$('em-id').value;
    const _activeMo=getActiveMgMonths();
    // Cash-basis attribution: stamp newly-toggled months with today's date (the
    // month the payment was received), preserving dates for already-active months.
    let _prevPayDates={};try{_prevPayDates=JSON.parse((CLIENT_CACHE[id]&&CLIENT_CACHE[id].retainer_payment_dates)||'{}');}catch(e){}
    const _todayStr=new Date().toISOString().split('T')[0];
    const _payDates={};_activeMo.forEach(m=>{_payDates[m]=(_prevPayDates&&_prevPayDates[m])||_todayStr;});
    const _emStage=$('em-stage').value;
    d={company_name:$('em-co').value.trim(),contact_name:$('em-cn').value.trim(),email:$('em-em').value.trim(),phone:$('em-ph').value.trim(),ad_account_id:$('em-acc').value.trim(),monthly_budget:parseFloat($('em-budget').value)||0,management_fee:parseFloat($('em-fee').value)||0,payments_made:_activeMo.length,active_months:JSON.stringify(_activeMo),retainer_payment_dates:JSON.stringify(_payDates),stage:_emStage,billing_reminders_paused:$('em-reminders-paused').checked,...churnedPatch('em'),...(_mgFulfilMirrored?{}:{onboarding_sub_stage:_emStage==='onboarding'?($('em-onboarding-sub-stage').value||null):null}),active_status:_emStage==='active'?($('em-active-status').value||'Ads Live'):null,cx_score:$('em-cx').value!==''?parseInt($('em-cx').value):null,start_date:$('em-start').value||null,ads_first_live_date:$('em-ads-live').value||null,last_payment_date:$('em-last-pay').value||null,next_payment_date:$('em-next-pay').value||null,notes:$('em-notes').value.trim(),...guaranteePatch(id),client_webhook:$('em-client-webhook').value.trim()||null,webhook_auth_mode:(($('em-webhook-auth').value!=='none'&&$('em-webhook-secret').value.trim())?$('em-webhook-auth').value:'none'),webhook_auth_header:($('em-webhook-auth').value==='header'?($('em-webhook-header').value.trim()||'Authorization'):null),webhook_auth_enabled:$('em-webhook-auth').value==='signature'&&!!$('em-webhook-secret').value.trim(),webhook_secret:$('em-webhook-secret').value.trim()||null,has_custom_integration:$('em-has-custom-integration').value==='true',updated_at:now()};
    if (!d.company_name) { toast('Company name required',true); return; }
    if (d.guarantee_start && d.guarantee_end && d.guarantee_end < d.guarantee_start) { toast('Guarantee ends before it starts',true); return; }
  }
  const {error}=await db.from('clients').update(d).eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  if (type==='ppl' && d.ql_hq_company_id) {
    const {data:_sd1}=await db.auth.getSession();
    if(_sd1?.session)fetch(`${_ep}/functions/v1/sync-to-hq`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${_sd1.session.access_token}`},body:JSON.stringify({ql_hq_company_id:d.ql_hq_company_id,email:d.delivery_email,sms_number:d.delivery_phone,webhook_url:d.client_webhook,postcodes:d.postcodes})}).catch(e=>console.warn('sync-to-hq:',e));
  }
  // Marking a managed client "Ads Live" here ticks the ads_live step on their
  // fulfilment checklist in the ql-hq Team Panel. Sent when the status changes,
  // and again on any save while ql-hq still reports onboarding steps
  // outstanding, so a push that failed last time is retried. ql-hq ignores it if
  // the step is already done. Best effort: the save above has already landed.
  if (type!=='ppl' && d.active_status==='Ads Live') {
    const _prevC=CLIENT_CACHE[id]||{};
    if (_prevC.ql_hq_company_id && (_prevC.active_status!=='Ads Live' || _prevC.fulfilment_next_step)) {
      callHq('mark_ads_live',{client_id:id})
        .then(out=>{ if(out.updated) toast('Team Panel fulfilment moved to Ads live ✓'); })
        .catch(e=>{ console.warn('mark_ads_live:',e); toast('Saved, but the Team Panel was not updated: '+e.message,true); });
    }
  }
  closeModal(type==='ppl'?'m-edit-ppl':'m-edit-managed');
  if (type==='ppl') { loadPPL(); }
  else {
    loadManaged();
    // Also refresh Finance so any retainer-month toggle changes immediately
    // flow into the Total Revenue / Retainer Revenue calculations.
    loadFinance();
  }
  toast('Client updated ✓');
}
async function deleteClient(type) {
  if (!confirm('Delete this client?')) return;
  const id=type==='ppl'?$('ep-id').value:$('em-id').value;
  const {error}=await db.from('clients').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  closeModal(type==='ppl'?'m-edit-ppl':'m-edit-managed');
  type==='ppl'?loadPPL():loadManaged(); toast('Client deleted');
}
// CSM on a managed client: who is assigned to it in ql-hq (team_assignments).
// Whoever is on it gets the "client has paid, send us your invoice" task in the
// Team Panel when an invoice is marked paid. Assign and remove save straight
// away; they don't wait for the Save button.
let _csmTeam = null;
async function loadCsmTeam(force) {
  if (_csmTeam && !force) return _csmTeam;
  const out = await callHq('list_vas', {});
  _csmTeam = out.vas || [];
  return _csmTeam;
}
async function renderClientCsms(c) {
  const list = $('em-csm-list'), sel = $('em-csm-pick'), add = $('em-csm-add');
  if (!list) return;
  const hqId = c && c.ql_hq_company_id;
  if (!hqId) {
    list.textContent = 'No QuoteLeadsHQ account linked to this client yet.';
    sel.disabled = true; add.disabled = true; return;
  }
  list.textContent = 'Loading…'; sel.disabled = false; add.disabled = false;
  try {
    const team = await loadCsmTeam(true);
    if (($('em-id').value || '') !== String(c.id)) return; // another client opened meanwhile
    const on = team.filter(v => (v.company_ids || []).includes(hqId));
    list.innerHTML = on.length
      ? on.map(v => `<span class="badge bg-blu" style="display:inline-flex;gap:6px;align-items:center">${esc(v.name || 'Team member')}<button type="button" class="btn btn-xs" style="padding:0 6px;min-height:0" title="Remove from this client" onclick="removeClientCsm('${esc(v.id)}')">✕</button></span>`).join('')
      : 'Nobody assigned yet.';
    sel.innerHTML = '<option value="">Assign a team member…</option>' +
      team.filter(v => !on.includes(v)).map(v => `<option value="${esc(v.id)}">${esc(v.name || v.id)} (${v.assigned} client${v.assigned === 1 ? '' : 's'})</option>`).join('');
  } catch (e) { list.textContent = 'Could not load the team: ' + e.message; }
}
async function addClientCsm() {
  const c = CLIENT_CACHE[$('em-id').value]; const vaId = $('em-csm-pick').value;
  if (!c || !vaId) { toast('Pick a team member first', true); return; }
  const btn = $('em-csm-add'); btn.disabled = true; btn.textContent = 'Assigning…';
  try {
    const out = await callHq('assign_client_va', { client_id: c.id, va_user_id: vaId });
    toast(out.notified ? 'Assigned and emailed ✓' : 'Assigned ✓');
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = 'Assign';
  renderClientCsms(c);
}
async function removeClientCsm(vaId) {
  const c = CLIENT_CACHE[$('em-id').value]; if (!c) return;
  if (!confirm('Take this team member off ' + (c.company_name || 'this client') + '?')) return;
  try { await callHq('unassign_client_va', { client_id: c.id, va_user_id: vaId }); toast('Removed ✓'); }
  catch (e) { toast(e.message, true); }
  renderClientCsms(c);
}

// Guarantee in the client modal: free text (empty = none) plus its dates.
const STD_GUARANTEE = '10 quote-ready leads in the first 30 days, or the next month of management is free and we keep going until they have them (up to 60 extra days). Terms: quoteleads.com.au/10-lead-guarantee';
function addDaysIso(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function syncGuaranteeFields() {
  const has = !!$('em-guarantee-terms').value.trim();
  $('em-guarantee-dates').style.display = has ? 'flex' : 'none';
  $('em-guarantee-meta').style.display = has && $('em-guarantee-meta').textContent ? '' : 'none';
  if (has && !$('em-guarantee-start').value && $('em-ads-live').value) $('em-guarantee-start').value = $('em-ads-live').value;
}
function guaranteePatch(id) {
  const terms = $('em-guarantee-terms').value.trim() || null;
  const start = terms ? ($('em-guarantee-start').value || null) : null;
  const end = terms ? ($('em-guarantee-end').value || null) : null;
  const type = terms ? (terms === STD_GUARANTEE ? 'quote_ready_10' : 'custom') : null;
  const prev = (typeof CLIENT_CACHE !== 'undefined' && CLIENT_CACHE[id]) || {};
  const changed = (prev.guarantee_terms || null) !== terms || (prev.guarantee_start || null) !== start || (prev.guarantee_end || null) !== end;
  const out = { guarantee_type: type, guarantee_terms: terms, guarantee_start: start, guarantee_end: end };
  if (changed) {
    out.guarantee_set_by = (currentUser && currentUser.email) || 'Mission Control';
    out.guarantee_set_at = new Date().toISOString();
  }
  return out;
}

async function saveClient(type) {
  let d;
  if (type==='ppl') {
    const _pplPostcodes=$('ppl-postcodes').value.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    const _pplCfRaw=$('ppl-custom-fields')?.value.trim()||'';const _pplCf=_pplCfRaw?{_text:_pplCfRaw}:{};
    const _pplWeeklyCap=$('ppl-weekly-cap')?.value!==''?parseInt($('ppl-weekly-cap').value)||null:null;
    const _pplMonthlyCap=$('ppl-monthly-cap')?.value!==''?parseInt($('ppl-monthly-cap').value)||null:null;
    const _pplMetaCampaignIds=getCheckedCampaigns('ppl-campaign-picker');
    d={type:'ppl',company_name:$('ppl-co').value.trim(),contact_name:$('ppl-cn').value.trim(),email:$('ppl-em').value.trim(),niche:$('ppl-niche').value,lead_price:parseFloat($('ppl-price').value)||0,meta_cpl:parseFloat($('ppl-meta-cpl').value)||null,leads_delivered:parseInt($('ppl-ld').value)||0,total_leads_purchased:parseInt($('ppl-tlp').value)||0,leads_scrubbed:parseInt($('ppl-scrubbed').value)||0,stage:$('ppl-stage').value,cx_score:$('ppl-cx').value!==''?parseInt($('ppl-cx').value):null,postcodes:_pplPostcodes,weekly_cap:_pplWeeklyCap,monthly_cap:_pplMonthlyCap,meta_campaign_ids:_pplMetaCampaignIds.length?_pplMetaCampaignIds:null,delivery_method:$('ppl-delivery-method').value,delivery_email:$('ppl-delivery-email').value.trim()||null,delivery_phone:$('ppl-delivery-phone').value.trim()||null,custom_fields:_pplCf,ql_hq_company_id:$('ppl-ql-hq-id').value.trim()||null,has_quoteleads_platform_account:$('ppl-has-ql-account').value==='true',hq_bearer_token:$('ppl-hq-bearer-token').value.trim()||null,created_at:now()};
    if (!d.company_name) { toast('Company name required',true); return; }
  } else {
    d={type:'managed',company_name:$('mg-co').value.trim(),contact_name:$('mg-cn').value.trim(),email:$('mg-em').value.trim(),ad_account_id:$('mg-acc').value.trim(),monthly_budget:parseFloat($('mg-budget').value)||0,management_fee:parseFloat($('mg-fee').value)||0,stage:$('mg-stage').value,cx_score:$('mg-cx').value!==''?parseInt($('mg-cx').value):null,start_date:$('mg-start').value||null,ads_first_live_date:$('mg-ads-live').value||null,last_payment_date:$('mg-last-pay').value||null,next_payment_date:$('mg-next-pay').value||null,created_at:now()};
    if (!d.company_name) { toast('Company name required',true); return; }
  }
  const {error}=await db.from('clients').insert([d]);
  if (error) { toast('DB error: '+error.message,true); return; }
  if (type==='ppl' && d.ql_hq_company_id) {
    const {data:_sd2}=await db.auth.getSession();
    if(_sd2?.session)fetch(`${_ep}/functions/v1/sync-to-hq`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${_sd2.session.access_token}`},body:JSON.stringify({ql_hq_company_id:d.ql_hq_company_id,email:d.delivery_email,sms_number:d.delivery_phone,webhook_url:null,postcodes:d.postcodes})}).catch(e=>console.warn('sync-to-hq:',e));
  }
  if (type==='ppl') {['ppl-co','ppl-cn','ppl-em','ppl-price','ppl-meta-cpl','ppl-ld','ppl-tlp','ppl-scrubbed','ppl-postcodes','ppl-delivery-email','ppl-delivery-phone','ppl-ql-hq-id','ppl-hq-bearer-token'].forEach(id=>{if($(id))$(id).value='';});setCheckedCampaigns('ppl-campaign-picker',[]);}
  else ['mg-co','mg-cn','mg-em','mg-acc','mg-budget','mg-fee','mg-start','mg-last-pay','mg-next-pay'].forEach(id=>{$(id).value='';});
  closeModal('m-'+type); toast('Client saved ✓');
  type==='ppl'?loadPPL():loadManaged();
}

/* ═══ META GRAPH API - CAMPAIGN TOGGLE ═══ */
async function metaUnpauseClient(clientId) {
  if(!confirm('Unpause all Meta campaigns for this client?')) return;
  try {
    const {data:client}=await db.from('clients').select('meta_campaign_ids,company_name').eq('id',clientId).single();
    if(!client||!client.meta_campaign_ids||!client.meta_campaign_ids.length) {toast('No campaign IDs',true);return;}
    const {data:{session}}=await db.auth.getSession();
    if(!session) throw new Error('Not authenticated');
    const res=await fetch(`${_ep}/functions/v1/meta-campaign-toggle`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({campaign_ids:client.meta_campaign_ids,action:'ACTIVE'})});
    const data=await res.json();
    if(!res.ok||data.error) throw new Error(data.error||'Unpause failed');
    await db.from('clients').update({meta_cap_paused:false,meta_cap_paused_at:null,meta_cap_pause_reason:null,updated_at:now()}).eq('id',clientId);
    toast(`Campaigns unpaused for ${client.company_name} ✓`);
    loadPPL();
  } catch(e){toast('Unpause error: '+e.message,true);}
}
async function metaToggleCampaigns(campaignIds, action) {
  try {
    const {data:{session}}=await db.auth.getSession();
    if(!session) throw new Error('Not authenticated');
    const res=await fetch(`${_ep}/functions/v1/meta-campaign-toggle`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({campaign_ids:campaignIds,action:action})});
    const data=await res.json();
    if(!res.ok||data.error) throw new Error(data.error||'Toggle failed');
    return data.results;
  } catch(e){toast('Meta API error: '+e.message,true);return null;}
}
