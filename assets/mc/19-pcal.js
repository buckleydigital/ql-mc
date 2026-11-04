'use strict';

// ── Client Campaign Action Logs (PCAL) ─────────────────────────────────────
// True once ql-hq is mirroring fulfilment for the open client, which makes it
// the owner of onboarding_sub_stage.
let _mgFulfilMirrored = false;
let _pcalFilter = 'all';
let _pcalCampaigns = [];

function filterPcal(f, btn) {
  _pcalFilter = f;
  document.querySelectorAll('.pcal-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPcalTable();
}

async function loadPcal() {
  const [campRes, logRes, metaRes] = await Promise.all([
    db.from('ppl_campaigns').select('*, meta_campaigns(name)').order('created_at', { ascending: false }),
    db.from('ppl_campaign_action_log').select('*, ppl_campaigns(name)').order('logged_at', { ascending: false }).limit(50),
    db.from('meta_campaigns').select('id, name').order('name')
  ]);
  _pcalCampaigns = campRes.data || [];
  const total = _pcalCampaigns.length;
  const active = _pcalCampaigns.filter(c => c.status === 'active').length;
  const paused = _pcalCampaigns.filter(c => c.status === 'paused').length;
  $('pcal-total').textContent = total;
  $('pcal-active').textContent = active;
  $('pcal-paused').textContent = paused;
  renderPcalTable();
  renderPcalLog(logRes.data || []);
  _pcalMetaCampaigns = metaRes.data || [];
}

let _pcalMetaCampaigns = [];

function pcalStatusBadge(s) {
  const colors = { active: 'var(--grn)', paused: 'var(--amb)', nuked: 'var(--red)' };
  const c = colors[s] || 'var(--ink3)';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;background:${c}22;color:${c};border:1px solid ${c}44">${esc(s)}</span>`;
}

function renderPcalTable() {
  const filtered = _pcalFilter === 'all' ? _pcalCampaigns : _pcalCampaigns.filter(c => c.status === _pcalFilter);
  const tbody = $('pcal-tbody');
  if (!filtered.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty">No ${_pcalFilter === 'all' ? '' : _pcalFilter + ' '}campaigns.</td></tr>`; return; }
  tbody.innerHTML = filtered.map(c => {
    const metaName = c.meta_campaigns?.name || '-';
    return `<tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td>${esc(c.niche || '-')}</td>
      <td>${esc(c.area || '-')}</td>
      <td>${pcalStatusBadge(c.status)}</td>
      <td style="font-size:12px">${esc(metaName)}</td>
      <td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.notes || '')}">${esc(c.notes || '-')}</td>
      <td style="font-size:12px;color:var(--ink3)">${fmtDate(c.updated_at)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-xs" onclick="openPcalLog('${c.id}','${esc(c.name)}')">Log</button>
        <button class="btn btn-xs" onclick="editPplCampaign('${c.id}')">Edit</button>
        <button class="btn btn-xs btn-red" onclick="deletePplCampaignRow('${c.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function renderPcalLog(logs) {
  const tbody = $('pcal-log-tbody');
  if (!logs.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No actions logged yet.</td></tr>'; return; }
  tbody.innerHTML = logs.map(l => `<tr>
    <td style="font-size:12px;color:var(--ink3);white-space:nowrap">${fmtDate(l.logged_at, true)}</td>
    <td style="font-size:12px">${esc(l.ppl_campaigns?.name || '-')}</td>
    <td><span style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--ink3)">${esc(l.action_type)}</span></td>
    <td style="font-size:13px">${esc(l.details || '-')}</td>
  </tr>`).join('');
}



function populatePcalMetaDropdown(selectId) {
  const sel = $(selectId);
  const current = sel.value;
  sel.innerHTML = '<option value="">- None -</option>' + _pcalMetaCampaigns.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  if (current) sel.value = current;
}

async function savePplCampaign() {
  const name = $('pc-name').value.trim();
  if (!name) { toast('Campaign name required', true); return; }
  const d = {
    name,
    niche: $('pc-niche').value.trim() || null,
    area: $('pc-area').value.trim() || null,
    status: $('pc-status').value,
    meta_campaign_id: $('pc-meta-link').value || null,
    notes: $('pc-notes').value.trim() || null
  };
  const { error } = await db.from('ppl_campaigns').insert([d]);
  if (error) { toast('Error: ' + error.message, true); return; }
  closeModal('m-add-ppl-campaign');
  toast('Campaign created');
  loadPcal();
}

async function editPplCampaign(id) {
  const c = _pcalCampaigns.find(x => x.id === id);
  if (!c) return;
  populatePcalMetaDropdown('epc-meta-link');
  $('epc-id').value = c.id;
  $('epc-name').value = c.name || '';
  $('epc-niche').value = c.niche || '';
  $('epc-area').value = c.area || '';
  $('epc-status').value = c.status || 'active';
  $('epc-meta-link').value = c.meta_campaign_id || '';
  $('epc-notes').value = c.notes || '';
  $('epc-sub').textContent = c.name;
  openModal('m-edit-ppl-campaign');
}

async function updatePplCampaign() {
  const id = $('epc-id').value;
  const oldCamp = _pcalCampaigns.find(x => x.id === id);
  const newStatus = $('epc-status').value;
  const d = {
    name: $('epc-name').value.trim(),
    niche: $('epc-niche').value.trim() || null,
    area: $('epc-area').value.trim() || null,
    status: newStatus,
    meta_campaign_id: $('epc-meta-link').value || null,
    notes: $('epc-notes').value.trim() || null,
    updated_at: new Date().toISOString()
  };
  if (!d.name) { toast('Campaign name required', true); return; }
  const { error } = await db.from('ppl_campaigns').update(d).eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  if (oldCamp && oldCamp.status !== newStatus) {
    await db.from('ppl_campaign_action_log').insert([{ campaign_id: id, action_type: 'status_change', details: `${oldCamp.status} → ${newStatus}` }]);
  }
  closeModal('m-edit-ppl-campaign');
  toast('Campaign updated');
  loadPcal();
}

async function deletePplCampaign() {
  const id = $('epc-id').value;
  const name = $('epc-name').value;
  if (!confirm(`Delete campaign "${name}"? This will also remove all action log entries.`)) return;
  const { error } = await db.from('ppl_campaigns').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  closeModal('m-edit-ppl-campaign');
  toast('Campaign deleted');
  loadPcal();
}

async function deletePplCampaignRow(id) {
  const c = _pcalCampaigns.find(x => x.id === id);
  const name = c ? c.name : 'this campaign';
  if (!confirm(`Delete campaign "${name}"? This will also remove all action log entries.`)) return;
  const { error } = await db.from('ppl_campaigns').delete().eq('id', id);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Campaign deleted');
  loadPcal();
}

async function clearAllPcalActions() {
  if (!confirm('Clear all logged actions? This cannot be undone and does not delete the campaigns themselves.')) return;
  const { error } = await db.from('ppl_campaign_action_log').delete().not('id', 'is', null);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Action log cleared');
  loadPcal();
}

async function openPcalLog(campaignId, campaignName) {
  $('pcal-modal-title').textContent = campaignName;
  $('pcal-modal-campaign-id').value = campaignId;
  $('pcal-action-type').value = 'note';
  $('pcal-action-details').value = '';
  openModal('m-pcal-log');
  await refreshPcalLog(campaignId);
}

async function refreshPcalLog(campaignId) {
  $('pcal-modal-body').innerHTML = '<div class="empty">Loading…</div>';
  const { data } = await db.from('ppl_campaign_action_log').select('*').eq('campaign_id', campaignId).order('logged_at', { ascending: false }).limit(100);
  const logs = data || [];
  if (!logs.length) { $('pcal-modal-body').innerHTML = '<div class="empty">No actions logged yet.</div>'; return; }
  $('pcal-modal-body').innerHTML = '<div style="max-height:340px;overflow-y:auto">' + logs.map(l => `
    <div style="padding:8px 0;border-bottom:1px solid var(--bd);font-size:13px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600;text-transform:uppercase;font-size:12px;color:var(--ink3)">${esc(l.action_type)}</span>
        <span style="font-size:12px;color:var(--ink3)">${fmtDate(l.logged_at, true)}</span>
      </div>
      <div style="margin-top:4px">${esc(l.details || '-')}</div>
    </div>`).join('') + '</div>';
}

async function addPcalEntry() {
  const campaignId = $('pcal-modal-campaign-id').value;
  const details = $('pcal-action-details').value.trim();
  if (!details) { toast('Add some details', true); return; }
  const { error } = await db.from('ppl_campaign_action_log').insert([{
    campaign_id: campaignId,
    action_type: $('pcal-action-type').value,
    details
  }]);
  if (error) { toast('Error: ' + error.message, true); return; }
  await db.from('ppl_campaigns').update({ updated_at: new Date().toISOString() }).eq('id', campaignId);
  $('pcal-action-details').value = '';
  toast('Logged ✓');
  refreshPcalLog(campaignId);
  loadPcal();
}
