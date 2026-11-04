'use strict';

let _campPeriod = localStorage.getItem('camp_period') || 'mtd';

function setCampPeriod(p) {
  _campPeriod = p;
  localStorage.setItem('camp_period', p);
  document.querySelectorAll('.camp-period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));
  // Update column header
  const labels = { '7d': 'Spend 7D', '30d': 'Spend 30D', 'mtd': 'Spend MTD', 'ytd': 'Spend YTD' };
  const th = $('th-spend');
  if (th) th.textContent = labels[p] || 'Spend';
  // Show loading state in table
  const tb=$('mc-tbody');
  if(tb) tb.innerHTML='<tr><td colspan="10" style="text-align:center;font-size:12px;color:var(--ink3);padding:12px">Syncing '+( labels[p]||p)+' data from Meta…</td></tr>';
  syncCampaignInsights();
}

// Restore saved period on load
(function restoreCampPeriod() {
  const labels = { '7d': 'Spend 7D', '30d': 'Spend 30D', 'mtd': 'Spend MTD', 'ytd': 'Spend YTD' };
  document.querySelectorAll('.camp-period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === _campPeriod));
  const th = $('th-spend');
  if (th) th.textContent = labels[_campPeriod] || 'Spend MTD';
})();

let _syncingCampaigns=false;
async function syncCampaignInsights() {
  if(_syncingCampaigns) return;
  _syncingCampaigns=true;
  const btn=$('mc-sync-btn');
  if(btn){btn.disabled=true;btn.textContent='Syncing…';}
  try {
    const {data:{session}}=await db.auth.getSession();
    if(!session) throw new Error('Not logged in');
    const res=await fetch(`${_ep}/functions/v1/meta-campaign-insights`,{method:'POST',headers:{'Authorization':'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify({period:_campPeriod})});
    if(!res.ok){const txt=await res.text();throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);}
    const d=await res.json();
    if(d.error) throw new Error(d.error);
    if(d.message&&!d.synced){toast(d.message);loadCampaigns();return;}
    toast(`Synced ${d.synced||0} campaign(s)${d.failed?' · '+d.failed+' failed':''}`);
    await loadCampaigns();
    await writeSyncToSpendLog(); // persist spend to spend log so history survives campaign deletions
    loadPPL(); // refresh client CPL from campaign rollup
  } catch(e){toast('Sync error: '+(e instanceof Error?e.message:String(e)),true);loadCampaigns();}
  finally{_syncingCampaigns=false;if(btn){btn.disabled=false;btn.textContent='Sync Stats';}}
}

async function inlineToggleCampaign(id, metaCampaignId, newAction) {
  const btn=$('toggle-'+id);
  if(btn){btn.disabled=true;btn.textContent='…';}
  const results=await metaToggleCampaigns([metaCampaignId],newAction);
  if(results&&results.length&&results[0].success){
    await db.from('meta_campaigns').update({status:newAction,updated_at:now()}).eq('id',id);
    toast(`Campaign ${newAction==='PAUSED'?'paused':'resumed'} on Meta`);
    loadCampaigns();
  } else {
    toast('Toggle failed - '+(results?.[0]?.error||'unknown error'),true);
    if(btn){btn.disabled=false;btn.textContent=newAction==='PAUSED'?'Pause':'Resume';}
  }
}

/* ═══ META TOKEN REFRESH TRACKING ═══ */
const META_TOKEN_START = new Date('2026-03-01');
const META_TOKEN_INITIAL_DAYS = 60;
const META_TOKEN_RENEWAL_DAYS = 59;

function renderMetaTokenBanner() {
  const daysEl = $('meta-token-days');
  const unitEl = $('meta-token-unit');
  const lastEl = $('meta-token-last');
  const banner = $('meta-token-banner');
  if (!daysEl || !banner) return;

  const refreshedAt = localStorage.getItem('meta_token_refreshed_at');
  let daysRemaining, lastLabel;

  if (refreshedAt) {
    const refreshedDate = new Date(refreshedAt);
    const daysSince = Math.floor((Date.now() - refreshedDate.getTime()) / (1000 * 86400));
    daysRemaining = META_TOKEN_RENEWAL_DAYS - daysSince;
    lastLabel = 'Last refreshed: ' + refreshedDate.toLocaleDateString('en-AU', {day:'2-digit',month:'short',year:'numeric'});
  } else {
    const daysSince = Math.floor((Date.now() - META_TOKEN_START.getTime()) / (1000 * 86400));
    daysRemaining = META_TOKEN_INITIAL_DAYS - daysSince;
    lastLabel = 'Token issued: 01/03/26';
  }

  daysEl.textContent = Math.max(daysRemaining, 0);

  if (daysRemaining <= 0) {
    daysEl.style.color = 'var(--red)';
    unitEl.textContent = 'days - OVERDUE';
    banner.style.borderColor = 'var(--red)';
    banner.style.background = 'rgba(239,68,68,0.06)';
  } else if (daysRemaining <= 7) {
    daysEl.style.color = 'var(--amb)';
    unitEl.textContent = 'days remaining';
    banner.style.borderColor = 'var(--amb)';
    banner.style.background = 'rgba(245,158,11,0.06)';
  } else {
    daysEl.style.color = 'var(--grn)';
    unitEl.textContent = 'days remaining';
    banner.style.borderColor = 'var(--bd)';
    banner.style.background = '';
  }

  if (lastEl) lastEl.textContent = '· ' + lastLabel;
}

function markMetaTokenRefreshed() {
  const today = new Date().toISOString().split('T')[0];
  localStorage.setItem('meta_token_refreshed_at', today);
  renderMetaTokenBanner();
  toast('Meta token refresh recorded - next refresh in ' + META_TOKEN_RENEWAL_DAYS + ' days ✓');
}

/* ═══ META AD ACCOUNTS + CAMPAIGNS MANAGEMENT ═══ */
let _adAccountsCache=[];

async function loadAdAccounts(){
  const {data}=await db.from('meta_ad_accounts').select('*').order('label');
  _adAccountsCache=data||[];
  renderAdAccountsList();
  populateAdAccountDropdowns();
}
function renderAdAccountsList(){
  const el=$('ad-accounts-list');if(!el)return;
  if(!_adAccountsCache.length){el.innerHTML='<span style="font-size:12px;color:var(--ink3)">No ad accounts yet - add one below</span>';return;}
  el.innerHTML=_adAccountsCache.map(a=>`<div style="display:inline-flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--br);border-radius:6px;padding:5px 10px;font-size:12px">
    <strong>${esc(a.label)}</strong> <span style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(a.account_id)}</span>
    <button class="btn btn-xs" style="color:var(--red);padding:0 4px" onclick="removeAdAccount('${a.id}')" title="Remove">×</button>
  </div>`).join('');
}
async function addAdAccount(){
  const accountId=$('aa-account-id').value.trim();
  const label=$('aa-label').value.trim();
  if(!accountId){toast('Account ID required (e.g. act_123456)',true);return;}
  if(!label){toast('Label required',true);return;}
  const {error}=await db.from('meta_ad_accounts').insert([{account_id:accountId,label}]);
  if(error){toast('Error: '+error.message,true);return;}
  $('aa-account-id').value='';$('aa-label').value='';
  toast('Ad account added ✓');loadAdAccounts();
}
async function removeAdAccount(id){
  if(!confirm('Remove this ad account?')) return;
  const {error}=await db.from('meta_ad_accounts').delete().eq('id',id);
  if(error){toast('Error: '+error.message,true);return;}
  toast('Ad account removed');loadAdAccounts();
}
function populateAdAccountDropdowns(){
  ['mc-ad-account','emc-ad-account'].forEach(selId=>{
    const sel=$(selId);if(!sel)return;
    const cur=sel.value;
    sel.innerHTML='<option value="">- Select -</option>'+_adAccountsCache.map(a=>`<option value="${esc(a.account_id)}">${esc(a.label)} (${esc(a.account_id)})</option>`).join('');
    if(cur) sel.value=cur;
  });
}
function adAccountLabel(accId){
  const a=_adAccountsCache.find(x=>x.account_id===accId);
  return a?a.label:accId||'-';
}

let _campaignsCache=[];
async function loadCampaigns() {
  await loadAdAccounts();
  const [campaignsRes,clientsRes]=await Promise.all([
    db.from('meta_campaigns').select('*').order('name'),
    db.from('clients').select('id,company_name,meta_campaign_ids').eq('type','ppl').not('meta_campaign_ids','is',null),
  ]);
  const campaigns=campaignsRes.data||[];
  const clients=clientsRes.data||[];
  _campaignsCache=campaigns;

  // Build reverse map: meta_campaign_id → client names
  const cidToClients={};
  for(const c of clients){
    for(const mid of (c.meta_campaign_ids||[])){
      if(!cidToClients[mid]) cidToClients[mid]=[];
      cidToClients[mid].push(c.company_name);
    }
  }

  // Build area map for campaigns
  const allAreaIds=[...new Set(campaigns.flatMap(c=>c.area_ids||[]))];
  let areaMap={};
  if(allAreaIds.length){
    const {data:areas}=await db.from('ppl_lead_areas').select('id,label').in('id',allAreaIds);
    if(areas) areas.forEach(a=>{areaMap[a.id]=a.label;});
  }

  // KPIs
  setText('mc-total',campaigns.length||'-');
  setText('mc-active',campaigns.filter(c=>c.status==='ACTIVE').length||'0');
  setText('mc-paused',campaigns.filter(c=>c.status==='PAUSED').length||'0');

  // Campaigns table
  const tb=$('mc-tbody');
  if(!campaigns.length){
    tb.innerHTML='<tr><td colspan="10" class="empty">No campaigns yet</td></tr>';
  } else {
  const fmt$=v=>v?'$'+Number(v).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2}):'-';
  const fmtN=v=>v?Number(v).toLocaleString('en-AU'):'-';
  const synced=campaigns.some(c=>c.last_synced_at);
  tb.innerHTML=campaigns.map(c=>{
    const linked=(cidToClients[c.meta_campaign_id]||[]).join(', ')||'<span style="color:var(--ink3)">none</span>';
    const isActive=c.status==='ACTIVE';
    const statusColor=isActive?'var(--grn)':'var(--red)';
    const toggleLabel=isActive?'Pause':'Resume';
    const toggleAction=isActive?'PAUSED':'ACTIVE';
    return `<tr>
      <td><strong>${esc(c.name)}</strong><div style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(c.meta_campaign_id)}</div></td>
      <td style="font-size:12px">${esc(adAccountLabel(c.ad_account_id))}</td>
      <td>
        <span style="color:${statusColor};font-family:var(--mono);font-size:12px;font-weight:600">${c.status}</span>${c.cost_paused?`<span title="${esc(c.cost_pause_reason||'')}" style="margin-left:6px;font-family:var(--mono);font-size:12px;color:var(--red);background:rgba(255,69,96,.1);padding:1px 6px;border-radius:3px">COST CUT-OFF</span>`:''}
        <button class="btn btn-xs" style="margin-left:6px;font-size:12px" id="toggle-${c.id}" onclick="inlineToggleCampaign('${c.id}','${esc(c.meta_campaign_id)}','${toggleAction}')">${toggleLabel}</button>
      </td>
      <td style="font-family:var(--mono);font-size:12px">${fmt$(c.spend_mtd)}</td>
      <td style="font-family:var(--mono);font-size:12px">${fmtN(c.leads_mtd)}</td>
      <td style="font-family:var(--mono);font-size:12px">${(c.leads_mtd||0)>0?fmt$((c.spend_mtd||0)/(c.leads_mtd||1)):'-'}</td>
      <td style="font-family:var(--mono);font-size:12px">${fmtN(c.clicks_mtd)}</td>
      <td style="font-size:12px">${linked}</td>
      <td style="font-size:12px">${(c.area_ids||[]).map(aid=>esc(areaMap[aid]||'?')).join(', ')||'<span style="color:var(--ink3)">-</span>'}</td>
      <td><button class="btn btn-xs" onclick="editCampaign('${c.id}')">Edit</button></td>
    </tr>`;
  }).join('');
  if(!synced){$('mc-tbody').insertAdjacentHTML('afterbegin','<tr><td colspan="10" style="text-align:center;font-size:12px;color:var(--ink3);padding:8px">Stats not synced yet - click <strong>Sync Stats</strong> to pull live data from Meta</td></tr>');}
  }

  // Manual Spend Log renders independently - always load it, even when there
  // are no campaigns, so it never stays stuck on "Loading…".
  loadSpendLog();
}

async function saveCampaign() {
  const name=$('mc-name').value.trim();
  const adAccount=$('mc-ad-account').value;
  const metaId=$('mc-meta-id').value.trim();
  const notes=$('mc-notes').value.trim();
  if(!name){toast('Campaign name required',true);return;}
  if(!adAccount){toast('Select an ad account',true);return;}
  if(!metaId){toast('Meta Campaign ID required',true);return;}
  const {error}=await db.from('meta_campaigns').insert([{name,ad_account_id:adAccount,meta_campaign_id:metaId,notes:notes||null}]);
  if(error){toast('Error: '+error.message,true);return;}
  ['mc-name','mc-meta-id','mc-notes'].forEach(id=>{$(id).value='';});$('mc-ad-account').value='';
  closeModal('m-add-campaign');toast('Campaign added ✓');loadCampaigns();
  refreshCampaignDropdowns();
}

async function editCampaign(id) {
  const c=_campaignsCache.find(x=>x.id===id);
  if(!c) return;
  populateAdAccountDropdowns();
  setVal('emc-id',c.id);setVal('emc-name',c.name);setVal('emc-ad-account',c.ad_account_id||'');setVal('emc-meta-id',c.meta_campaign_id);
  setVal('emc-status',c.status);setVal('emc-notes',c.notes||'');
  const toggleBtn=$('emc-toggle-btn');
  if(toggleBtn){toggleBtn.textContent=c.status==='ACTIVE'?'Pause on Meta':'Resume on Meta';}
  $('edit-mc-sub').textContent=c.meta_campaign_id;
  // Populate client picker
  const {data:allClients}=await db.from('clients').select('id,company_name,meta_campaign_ids').eq('type','ppl').order('company_name');
  const clientPicker=$('emc-client-picker');
  if(clientPicker&&allClients){
    const linkedSet=new Set(allClients.filter(cl=>(cl.meta_campaign_ids||[]).includes(c.meta_campaign_id)).map(cl=>cl.id));
    clientPicker.innerHTML=allClients.map(cl=>`<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" value="${esc(String(cl.id))}" ${linkedSet.has(cl.id)?'checked':''} style="margin:0">
      ${esc(cl.company_name||'Unnamed')}
    </label>`).join('')||'<span style="font-size:12px;color:var(--ink3)">No PPL clients yet</span>';
  }
  // Populate area picker
  const areaIds=c.area_ids||[];
  const {data:allAreas}=await db.from('ppl_lead_areas').select('id,label,client_id,client_ids').order('label');
  const picker=$('emc-area-picker');
  if(picker&&allAreas){
    const selSet=new Set(areaIds);
    picker.innerHTML=allAreas.map(a=>{
      const cName=a.client_ids&&a.client_ids.length?a.client_ids.map(cid=>mapClientDataMap[String(cid)]?.company_name||'').filter(Boolean).join(', '):mapClientDataMap[String(a.client_id)]?.company_name||'';
      return `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
        <input type="checkbox" value="${esc(String(a.id))}" ${selSet.has(a.id)?'checked':''} style="margin:0">
        ${esc(a.label)}${cName?' <span style="font-size:12px;color:var(--ink3)">('+esc(cName)+')</span>':''}
      </label>`;
    }).join('')||'<span style="font-size:12px;color:var(--ink3)">No areas yet - draw on the PPL map first</span>';
  }
  openModal('m-edit-campaign');
}

async function updateCampaign() {
  const id=$('emc-id').value;
  const metaCampaignId=$('emc-meta-id').value.trim();
  const newAreaIds=[...$('emc-area-picker').querySelectorAll('input[type=checkbox]:checked')].map(cb=>cb.value);
  const oldCamp=_campaignsCache.find(c=>c.id===id);
  const oldAreaIds=oldCamp?.area_ids||[];
  const d={name:$('emc-name').value.trim(),ad_account_id:$('emc-ad-account').value,meta_campaign_id:metaCampaignId,status:$('emc-status').value,notes:$('emc-notes').value.trim()||null,area_ids:newAreaIds,updated_at:now()};
  if(!d.name){toast('Name required',true);return;}
  const {error}=await db.from('meta_campaigns').update(d).eq('id',id);
  if(error){toast('Error: '+error.message,true);return;}
  // Sync area side: add/remove this campaign's meta_campaign_id
  const removed=oldAreaIds.filter(aid=>!newAreaIds.includes(aid));
  const added=newAreaIds.filter(aid=>!oldAreaIds.includes(aid));
  for(const aid of removed){
    const {data:area}=await db.from('ppl_lead_areas').select('meta_campaign_ids').eq('id',aid).single();
    if(area) await db.from('ppl_lead_areas').update({meta_campaign_ids:(area.meta_campaign_ids||[]).filter(m=>m!==metaCampaignId)}).eq('id',aid);
  }
  for(const aid of added){
    const {data:area}=await db.from('ppl_lead_areas').select('meta_campaign_ids').eq('id',aid).single();
    if(area){const existing=area.meta_campaign_ids||[];if(!existing.includes(metaCampaignId)) await db.from('ppl_lead_areas').update({meta_campaign_ids:[...existing,metaCampaignId]}).eq('id',aid);}
  }
  // Sync client linkages
  const checkedClientIds=new Set([...$('emc-client-picker').querySelectorAll('input[type=checkbox]:checked')].map(cb=>cb.value));
  const allClientCbs=[...$('emc-client-picker').querySelectorAll('input[type=checkbox]')].map(cb=>cb.value);
  for(const cid of allClientCbs){
    const {data:cl}=await db.from('clients').select('meta_campaign_ids').eq('id',cid).single();
    if(!cl) continue;
    const existing=cl.meta_campaign_ids||[];
    if(checkedClientIds.has(cid)){
      if(!existing.includes(metaCampaignId)){
        await db.from('clients').update({meta_campaign_ids:[...existing,metaCampaignId],updated_at:now()}).eq('id',cid);
      }
    } else {
      if(existing.includes(metaCampaignId)){
        await db.from('clients').update({meta_campaign_ids:existing.filter(m=>m!==metaCampaignId),updated_at:now()}).eq('id',cid);
      }
    }
  }
  closeModal('m-edit-campaign');toast('Campaign updated ✓');loadCampaigns();
  refreshCampaignDropdowns();
}

async function deleteCampaign() {
  if(!confirm('Delete this campaign? This will not affect Meta - it only removes it from this dashboard.')) return;
  const id=$('emc-id').value;
  const {error}=await db.from('meta_campaigns').delete().eq('id',id);
  if(error){toast('Error: '+error.message,true);return;}
  closeModal('m-edit-campaign');toast('Campaign deleted');loadCampaigns();
  refreshCampaignDropdowns();
}

async function toggleCampaignFromModal() {
  const metaId=$('emc-meta-id').value.trim();
  const currentStatus=$('emc-status').value;
  const newAction=currentStatus==='ACTIVE'?'PAUSED':'ACTIVE';
  const btn=$('emc-toggle-btn');
  if(btn){btn.disabled=true;btn.textContent='Working…';}
  const results=await metaToggleCampaigns([metaId],newAction);
  if(results&&results.length&&results[0].success){
    $('emc-status').value=newAction;
    await db.from('meta_campaigns').update({status:newAction,updated_at:now()}).eq('id',$('emc-id').value);
    toast(`Campaign ${newAction==='PAUSED'?'paused':'resumed'} on Meta ✓`);
    if(btn){btn.textContent=newAction==='ACTIVE'?'Pause on Meta':'Resume on Meta';}
  } else {
    toast('Failed - '+(results?.[0]?.error||'unknown error'),true);
  }
  if(btn) btn.disabled=false;
  loadCampaigns();
}

/* ═══ CAMPAIGN DROPDOWNS FOR CLIENT FORMS ═══ */
async function refreshCampaignDropdowns() {
  const {data}=await db.from('meta_campaigns').select('id,name,meta_campaign_id,ad_account_id,status').order('ad_account_id,name');
  const campaigns=data||[];
  _campaignsCache=campaigns;
  // Group by ad account
  const grouped={};
  for(const c of campaigns){
    const key=c.ad_account_id||'unassigned';
    if(!grouped[key]) grouped[key]=[];
    grouped[key].push(c);
  }
  // Update all campaign picker containers
  ['ppl-campaign-picker','ep-campaign-picker'].forEach(pickerId=>{
    const el=$(pickerId);
    if(!el) return;
    const checked=getCheckedCampaigns(pickerId);
    if(!campaigns.length){el.innerHTML='<span style="font-size:12px;color:var(--ink3)">No campaigns yet - add one in Meta Campaigns</span>';return;}
    let html='';
    for(const [accId,cmpList] of Object.entries(grouped)){
      html+=`<div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink3);margin:6px 0 3px;text-transform:uppercase;letter-spacing:.05em">${esc(adAccountLabel(accId))}</div>`;
      html+=cmpList.map(c=>{
        const isChecked=checked.includes(c.meta_campaign_id)?'checked':'';
        const dot=c.status==='ACTIVE'?'<span style="color:var(--grn)">●</span>':'<span style="color:var(--red)">●</span>';
        return `<label style="display:flex;align-items:center;gap:6px;padding:3px 0 3px 8px;font-size:12px;cursor:pointer">
          <input type="checkbox" value="${esc(c.meta_campaign_id)}" ${isChecked} style="margin:0">
          ${dot} <span>${esc(c.name)}</span> <span style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(c.meta_campaign_id)}</span>
        </label>`;
      }).join('');
    }
    el.innerHTML=html;
  });
}

function getCheckedCampaigns(pickerId) {
  const el=$(pickerId);
  if(!el) return [];
  return [...el.querySelectorAll('input[type=checkbox]:checked')].map(cb=>cb.value);
}

function setCheckedCampaigns(pickerId, metaIds) {
  const el=$(pickerId);
  if(!el) return;
  el.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.checked=(metaIds||[]).includes(cb.value);
  });
}
