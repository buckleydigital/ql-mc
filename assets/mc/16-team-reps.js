'use strict';

// ════════════════════════════════════════════════════════════════════════════
// SALES REPS - admin panel (full users only; reps never reach this code path)
// ════════════════════════════════════════════════════════════════════════════
let _reps = [];

// Populate the rep cache so the pipeline can show owner names (admin only).
async function loadRepCache() {
  if (IS_REP) return;
  try { const r = await callRepEdge('list_reps'); _reps = r.reps || []; } catch (e) { /* ignore */ }
}
function repName(uid) {
  if (!uid) return '';
  const r = _reps.find(x => x.user_id === uid);
  return r ? (r.name || r.email || 'rep') : '';
}

async function callRepEdge(action, payload = {}) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error('Not logged in');
  const res = await fetch(`${_ep}/functions/v1/sales-rep-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

// ── Team members (CSM / Ops Manager / Tech Lead / Media Buyer) ──────────────
// The roles that are not sales reps. A rep is an auth account with its own
// scoped view of the dashboard, so it lives in auth.users and is managed
// through the service-role edge function. These four are people we track but
// who never log in, so they are a plain `team_members` row and go straight
// through PostgREST like any other admin table.
const TEAM_ROLES = [
  {id:'csm',          label:'CSM',          badge:'bg-blu'},
  {id:'ops_manager',  label:'Ops Manager',  badge:'bg-vio'},
  {id:'tech_lead',    label:'Tech Lead',    badge:'bg-sky'},
  {id:'media_buyer',  label:'Media Buyer',  badge:'bg-amb'}
];
let _team = [];
function teamRoleLabel(r){ return (TEAM_ROLES.find(t=>t.id===r)||{}).label || r || '-'; }
function teamRoleBadge(r){ return (TEAM_ROLES.find(t=>t.id===r)||{}).badge || 'bg-gray'; }

// Every role dropdown in the app is built from TEAM_ROLES so adding a role is
// a one-line change here (plus the CHECK constraint on the table).
function fillTeamRoleSelects() {
  const opts = TEAM_ROLES.map(t=>`<option value="${t.id}">${esc(t.label)}</option>`).join('');
  ['tm-role','etm-role'].forEach(id=>{ const e=$(id); if (e) e.innerHTML=opts; });
  const f=$('team-filter-role');
  if (f) f.innerHTML='<option value="">All roles</option>'+opts;
}

// Pay rates are free-text role types, so we offer them as a dropdown rather
// than a foreign key - a member can also sit on no rate at all.
async function fillTeamPayRateSelects(selected) {
  const {data} = await db.from('pay_rates').select('role_type').order('role_type');
  const roles=[...new Set((data||[]).map(r=>r.role_type).filter(Boolean))];
  if (selected && !roles.includes(selected)) roles.push(selected);
  const opts='<option value="">- none -</option>'+roles.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('');
  ['tm-payrate','etm-payrate'].forEach(id=>{ const e=$(id); if (e) e.innerHTML=opts; });
}

async function loadTeam() {
  if (IS_REP) return;   // walled off by RLS too; this just saves the query
  const tb=$('team-tbody');
  if (tb) tb.innerHTML='<tr><td colspan="8" class="empty">Loading...</td></tr>';
  fillTeamRoleSelects();
  const [{data,error}] = await Promise.all([
    db.from('team_members').select('*').order('created_at',{ascending:false}),
    fillTeamPayRateSelects()
  ]);
  if (error) { if (tb) tb.innerHTML=`<tr><td colspan="8" class="empty" style="color:var(--red)">Error: ${esc(error.message)}</td></tr>`; return; }
  _team=data||[];
  renderTeam();
}

function renderTeam() {
  const roleFilter=$('team-filter-role')?.value||'';
  const activeOnly=$('team-filter-active')?.checked;
  TEAM_ROLES.forEach(t=>{
    const all=_team.filter(m=>m.role===t.id);
    const active=all.filter(m=>m.active);
    setText('team-kpi-'+t.id, all.length||'-');
    setText('team-kpi-'+t.id+'-sub', all.length ? `${active.length} active` : '');
  });
  const rows=_team.filter(m=>(!roleFilter||m.role===roleFilter)&&(!activeOnly||m.active));
  const tb=$('team-tbody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML=`<tr><td colspan="8" class="empty">${_team.length?'No members match that filter.':'No team members yet. Click “New Member” to add one.'}</td></tr>`;
    return;
  }
  const order=r=>TEAM_ROLES.findIndex(t=>t.id===r);
  tb.innerHTML=[...rows].sort((a,b)=>order(a.role)-order(b.role)||String(a.name).localeCompare(String(b.name))).map(m=>`
    <tr class="team-row" data-team-id="${esc(String(m.id))}" style="cursor:pointer">
      <td><strong>${esc(m.name||'-')}</strong></td>
      <td><span class="badge ${teamRoleBadge(m.role)}">${esc(teamRoleLabel(m.role))}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(m.email||'-')}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(m.phone||'-')}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(m.start_date||'-')}</td>
      <td>${esc(m.pay_rate_role||'-')}</td>
      <td>${m.active?'<span class="badge bg-grn">Active</span>':'<span class="badge bg-gray">Inactive</span>'}</td>
      <td style="white-space:nowrap"><button class="btn btn-xs edit-team-btn">Edit</button></td>
    </tr>`).join('');
  tb.querySelectorAll('.team-row').forEach(row=>{
    row.addEventListener('click',()=>openTeamEdit(row.dataset.teamId));
  });
}

function teamForm(prefix) {
  return {
    name:$(prefix+'-name').value.trim(),
    role:$(prefix+'-role').value,
    email:$(prefix+'-email').value.trim()||null,
    phone:$(prefix+'-phone').value.trim()||null,
    start_date:$(prefix+'-start').value||null,
    pay_rate_role:$(prefix+'-payrate').value||null,
    notes:$(prefix+'-notes').value.trim()||null
  };
}

// `role` and `name` may be pre-filled when a hired candidate is promoted onto
// the roster straight from the hiring pipeline.
async function openCreateTeamModal(prefill = {}) {
  fillTeamRoleSelects();
  await fillTeamPayRateSelects();
  setVal('tm-name',prefill.name||''); setVal('tm-email',prefill.email||'');
  setVal('tm-phone',prefill.phone||''); setVal('tm-start',prefill.start_date||'');
  setVal('tm-payrate',''); setVal('tm-notes',prefill.notes||'');
  setVal('tm-role',prefill.role||TEAM_ROLES[0].id);
  openModal('m-team');
}
async function saveTeamMember() {
  const d=teamForm('tm');
  if (!d.name) { toast('Name required',true); return; }
  const {error}=await db.from('team_members').insert([d]);
  if (error) { toast('DB error: '+error.message,true); return; }
  closeModal('m-team'); toast('Team member added ✓');
  loadTeam();
}

async function openTeamEdit(id) {
  const m=_team.find(x=>String(x.id)===String(id));
  if (!m) return;
  fillTeamRoleSelects();
  await fillTeamPayRateSelects(m.pay_rate_role);
  setVal('etm-id',m.id);
  setVal('etm-name',m.name||'');
  setVal('etm-role',m.role||TEAM_ROLES[0].id);
  setVal('etm-email',m.email||'');
  setVal('etm-phone',m.phone||'');
  setVal('etm-start',m.start_date||'');
  setVal('etm-payrate',m.pay_rate_role||'');
  setVal('etm-active',m.active?'true':'false');
  setVal('etm-notes',m.notes||'');
  setText('team-edit-sub',(m.name||'')+' · '+teamRoleLabel(m.role));
  openModal('m-team-edit');
}
async function updateTeamMember() {
  const id=$('etm-id').value;
  const d=teamForm('etm');
  if (!d.name) { toast('Name required',true); return; }
  d.active=$('etm-active').value==='true';
  d.updated_at=now();
  const {error}=await db.from('team_members').update(d).eq('id',id);
  if (error) { toast('DB error: '+error.message,true); return; }
  closeModal('m-team-edit'); toast('Team member updated ✓');
  loadTeam();
}
async function deleteTeamMember() {
  const id=$('etm-id').value;
  const m=_team.find(x=>String(x.id)===String(id));
  if (!confirm(`Delete ${m?.name||'this team member'} from the roster?`)) return;
  const {error}=await db.from('team_members').delete().eq('id',id);
  if (error) { toast('DB error: '+error.message,true); return; }
  closeModal('m-team-edit'); toast('Team member deleted');
  loadTeam();
}

// ── Pay Rates (owner-only; RLS blocks reps) ─────────────────────────────────
function onPayRateTypeChange() {
  const commission = $('pr-type').value === 'commission';
  setText('pr-amount-label', commission ? 'Amount (%)' : 'Amount ($)');
  const inp = $('pr-amount'); if (inp) inp.placeholder = commission ? 'e.g. 10' : 'e.g. 1500';
}
async function loadPayRates() {
  const tb = $('payrates-tbody');
  if (tb) tb.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
  const { data, error } = await db.from('pay_rates').select('*').order('created_at', { ascending: true });
  if (error) { if (tb) tb.innerHTML = `<tr><td colspan="4" class="empty" style="color:var(--red)">Error: ${esc(error.message)}</td></tr>`; return; }
  const rows = data || [];
  if (!rows.length) { if (tb) tb.innerHTML = '<tr><td colspan="4" class="empty">No pay rates yet.</td></tr>'; return; }
  if (tb) tb.innerHTML = rows.map(r => {
    const commission = r.rate_type === 'commission';
    const amt = commission ? Number(r.amount) + '%' : '$' + Number(r.amount).toLocaleString('en-AU');
    const pill = `<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px;font-weight:600;background:${commission ? 'rgba(71,151,255,.12);color:var(--acc)' : 'rgba(52,199,89,.12);color:var(--grn)'}">${commission ? 'Commission' : 'Fixed'}</span>`;
    return `<tr>
      <td><strong>${esc(r.role_type)}</strong></td>
      <td>${pill}</td>
      <td style="font-family:var(--mono)">${amt}</td>
      <td style="white-space:nowrap"><button class="btn btn-xs" onclick="deletePayRate('${esc(String(r.id))}','${esc(r.role_type)}')" style="background:var(--red-fill);color:#fff">Delete</button></td>
    </tr>`;
  }).join('');
}
async function addPayRate() {
  const role = $('pr-role').value.trim();
  const type = $('pr-type').value;
  const amount = parseFloat($('pr-amount').value);
  if (!role) { toast('Enter a role type', true); return; }
  if (isNaN(amount) || amount < 0) { toast('Enter a valid amount', true); return; }
  const { error } = await db.from('pay_rates').insert([{ role_type: role, rate_type: type, amount }]);
  if (error) { toast('Error: ' + error.message, true); return; }
  $('pr-role').value = ''; $('pr-amount').value = '';
  toast('Pay rate added ✓');
  loadPayRates();
}
async function deletePayRate(id, role) {
  if (!confirm(`Delete the pay rate for "${role || 'this role'}"?`)) return;
  const { error } = await db.from('pay_rates').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, true); return; }
  toast('Deleted ✓');
  loadPayRates();
}

async function loadReps() {
  try {
    const [repsRes, cfgRes, unassignedRes] = await Promise.all([
      callRepEdge('list_reps'),
      callRepEdge('get_config'),
      db.from('leads').select('id', { count: 'exact', head: true }).is('owner_id', null),
    ]);
    const enabled = cfgRes.auto_assign_enabled === true;
    _repCfg = {
      mode: cfgRes.auto_assign_mode || 'least_busy',
      pool: cfgRes.round_robin_pool || [],
      house_email: cfgRes.house_email || HOUSE_EMAIL,
    };
    $('rep-autoassign').checked = enabled;
    renderReps(repsRes.reps || [], unassignedRes.count || 0);
    // Restore the mode + target state after renderReps populates the options.
    setVal('rep-assign-mode', _repCfg.mode);
    if (cfgRes.auto_assign_rep_id) setVal('rep-assign-target', cfgRes.auto_assign_rep_id);
    renderAssignControls(enabled);
  } catch (e) {
    $('rep-tbody').innerHTML = `<tr><td colspan="10" class="empty" style="color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
  }
}

function renderReps(reps, unassigned) {
  _reps = reps;
  // Rebuild the target-rep dropdown (active reps only).
  const sel = $('rep-assign-target');
  const prev = sel ? sel.value : '';
  if (sel) {
    sel.innerHTML = '<option value="">Pick a rep...</option>' +
      reps.filter(r => r.active).map(r =>
        `<option value="${esc(r.user_id)}">${esc(r.name || r.email)}</option>`
      ).join('');
    if (prev) sel.value = prev;
  }
  renderRoundRobinPool(reps);
  setText('rep-kpi-total', reps.length);
  setText('rep-kpi-active', reps.filter(r => r.active).length);
  setText('rep-kpi-assigned', reps.reduce((s, r) => s + (r.assigned || 0), 0));
  setText('rep-kpi-unassigned', unassigned);
  if (!reps.length) { $('rep-tbody').innerHTML = '<tr><td colspan="9" class="empty">No sales reps yet. Click “New Rep” to create one.</td></tr>'; return; }
  $('rep-tbody').innerHTML = reps.map(r => {
    const status = r.active ? '<span class="badge bg-grn">Active</span>' : '<span class="badge bg-gray">Inactive</span>';
    const close  = r.close_rate  == null ? '-' : r.close_rate  + '%';
    // JS-string + HTML-attribute safe (esc doesn't cover the apostrophe).
    const safeName = esc(String(r.name || r.email || 'rep').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
    return `<tr>
      <td>${esc(r.name || '-')}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(r.email || '-')}</td>
      <td style="font-family:var(--mono);font-size:12px">${r.reply_to_email ? esc(r.reply_to_email) : `<span style="color:var(--ink3)">${esc(r.email || '-')}</span>`}</td>
      <td>${status}</td>
      <td>${r.assigned || 0}</td>
      <td>${r.open || 0}</td>
      <td class="grn">${r.won || 0}</td>
      <td>${close}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-xs" onclick="impersonateRep('${r.user_id}','${safeName}',this)" title="View the dashboard exactly as this rep, then switch back">👁 View as</button>
        <button class="btn btn-xs" onclick="openRepEdit('${r.user_id}')">Edit</button>
        <button class="btn btn-xs" onclick="openRepPassword('${r.user_id}')">Password</button>
        <button class="btn btn-xs" onclick="toggleRepActive('${r.user_id}',${!r.active})">${r.active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-xs" style="color:var(--red)" onclick="deleteRep('${r.user_id}')">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function openCreateRepModal() {
  setVal('rep-name', ''); setVal('rep-email', ''); setVal('rep-pass', ''); setVal('rep-replyto', '');
  openModal('m-rep');
}
async function createRep() {
  const name = $('rep-name').value.trim();
  const email = $('rep-email').value.trim();
  const password = $('rep-pass').value;
  const replyTo = $('rep-replyto').value.trim();
  if (!email || !password) { toast('Email and password required', true); return; }
  if (password.length < 8) { toast('Password must be at least 8 characters', true); return; }
  try {
    await callRepEdge('create_rep', { name, email, password, reply_to_email: replyTo });
    closeModal('m-rep'); toast('Rep created ✓'); loadReps();
  } catch (e) { toast('Error: ' + e.message, true); }
}

function openRepEdit(uid) {
  const r = _reps.find(x => x.user_id === uid);
  if (!r) return;
  setVal('rep-edit-uid', uid);
  setVal('rep-edit-name', r.name || '');
  setVal('rep-edit-replyto', r.reply_to_email || '');
  setText('rep-edit-sub', r.email || '');
  setVal('rep-edit-role', '');
  db.rpc('rep_commission_roles').then(({ data }) => {
    const row = (data || []).find(x => x.user_id === uid);
    if ($('rep-edit-uid').value === uid) setVal('rep-edit-role', (row && row.commission_role) || '');
  });
  openModal('m-rep-edit');
}
async function saveRepEdit() {
  const user_id = $('rep-edit-uid').value;
  const name = $('rep-edit-name').value.trim();
  const reply_to_email = $('rep-edit-replyto').value.trim();
  try {
    await callRepEdge('update_rep', { user_id, name, reply_to_email });
    const { error: roleErr } = await db.rpc('set_rep_commission_role', { p_user_id: user_id, p_role: $('rep-edit-role').value || null });
    if (roleErr) throw roleErr;
    closeModal('m-rep-edit'); toast('Rep updated ✓'); loadReps();
  } catch (e) { toast('Error: ' + e.message, true); }
}

function openRepPassword(uid) {
  const r = _reps.find(x => x.user_id === uid);
  $('rep-pass-uid').value = uid;
  setText('rep-pass-sub', r ? (r.name || r.email) : '');
  setVal('rep-pass-new', '');
  openModal('m-rep-pass');
}
async function saveRepPassword() {
  const uid = $('rep-pass-uid').value;
  const password = $('rep-pass-new').value;
  if (password.length < 8) { toast('Password must be at least 8 characters', true); return; }
  try {
    await callRepEdge('set_password', { user_id: uid, password });
    closeModal('m-rep-pass'); toast('Password updated ✓');
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function toggleRepActive(uid, active) {
  try {
    await callRepEdge('set_active', { user_id: uid, active });
    toast(active ? 'Rep enabled' : 'Rep disabled - open leads returned to pool');
    loadReps();
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function deleteRep(uid) {
  const r = _reps.find(x => x.user_id === uid);
  const label = r ? (r.name || r.email) : 'this rep';
  if (!confirm(`Delete ${label}?\n\nTheir login is removed and any assigned leads return to the unassigned pool. This cannot be undone.`)) return;
  try { await callRepEdge('delete_rep', { user_id: uid }); toast('Rep deleted'); loadReps(); }
  catch (e) { toast('Error: ' + e.message, true); }
}

// The round-robin pool is an ordered list of who takes the next lead. Entries
// are rep user_ids plus HOUSE — the main QuoteLeads account, whose turn leaves
// the lead unassigned so only the admin sees it.
const HOUSE = 'house';
const HOUSE_EMAIL = 'contact@quoteleads.com.au';
let _repCfg = { mode: 'least_busy', pool: [], house_email: HOUSE_EMAIL };

function renderRoundRobinPool(reps) {
  const box = $('rep-rr-pool');
  if (!box) return;
  const inPool = new Set(_repCfg.pool || []);
  const entries = (reps || []).filter(r => r.active)
    .map(r => ({ id: r.user_id, label: r.name || r.email, sub: r.name ? r.email : '' }));
  entries.push({ id: HOUSE, label: 'Main account', sub: _repCfg.house_email || HOUSE_EMAIL, house: true });
  box.innerHTML = entries.map(e => `
    <label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer">
      <input type="checkbox" class="rep-rr-cb" value="${esc(e.id)}" ${inPool.has(e.id) ? 'checked' : ''}
             onchange="saveAutoAssign()" style="width:14px;height:14px;cursor:pointer">
      <span>${esc(e.label)}${e.sub ? `<span style="color:var(--ink3)"> · ${esc(e.sub)}</span>` : ''}${
        e.house ? '<span style="color:var(--ink3)"> · goes to no rep, admin only</span>' : ''}</span>
    </label>`).join('');
  if (!entries.length) box.innerHTML = '<span style="font-size:13px;color:var(--ink3)">No active reps yet.</span>';
}

// Pool order = the order shown on screen, so the rotation is what you read.
function currentPool() {
  return Array.from(document.querySelectorAll('.rep-rr-cb'))
    .filter(cb => cb.checked).map(cb => cb.value);
}

function renderAssignControls(enabled) {
  const mode = $('rep-assign-mode').value;
  $('rep-assign-mode-wrap').style.display = enabled ? 'flex' : 'none';
  $('rep-assign-target-wrap').style.display = enabled && mode === 'fixed' ? 'flex' : 'none';
  $('rep-rr-wrap').style.display = enabled && mode === 'round_robin' ? 'block' : 'none';
}

function onAutoAssignToggle() {
  renderAssignControls($('rep-autoassign').checked);
  saveAutoAssign();
}

function onAssignModeChange() {
  renderAssignControls($('rep-autoassign').checked);
  saveAutoAssign();
}

async function saveAutoAssign() {
  const enabled = $('rep-autoassign').checked;
  const mode = $('rep-assign-mode').value;
  const repId = mode === 'fixed' ? ($('rep-assign-target').value || null) : null;
  const pool = mode === 'round_robin' ? currentPool() : (_repCfg.pool || []);
  // Don't save a half-configured mode — the server rejects it anyway, and the
  // picker is already on screen for them to finish.
  if (enabled && mode === 'round_robin' && !pool.length) {
    toast('Tick who should be in the round-robin pool', true); return;
  }
  if (enabled && mode === 'fixed' && !repId) {
    toast('Pick the rep new leads should go to', true); return;
  }
  try {
    const res = await callRepEdge('set_config', {
      auto_assign_enabled: enabled,
      auto_assign_rep_id: repId,
      auto_assign_mode: mode,
      round_robin_pool: pool,
    });
    _repCfg.mode = res.auto_assign_mode || mode;
    _repCfg.pool = res.round_robin_pool || pool;
    toast('Auto-assign ' + (enabled ? 'on → ' + assignModeLabel(mode, repId, pool) : 'off'));
  } catch (e) {
    toast('Error: ' + e.message, true);
    loadReps();
  }
}

function assignModeLabel(mode, repId, pool) {
  if (mode === 'fixed') return (_reps || []).find(r => r.user_id === repId)?.name || 'selected rep';
  if (mode === 'round_robin') {
    const n = (pool || []).length;
    return `round robin across ${n} slot${n === 1 ? '' : 's'}`;
  }
  return 'least-busy rep';
}

async function autoAssignNow() {
  try {
    const r = await callRepEdge('auto_assign_now');
    const house = r.house ? `, ${r.house} left with the main account` : '';
    toast(`Assigned ${r.assigned} lead${r.assigned === 1 ? '' : 's'}${house}`);
    loadReps();
  } catch (e) { toast('Error: ' + e.message, true); }
}
