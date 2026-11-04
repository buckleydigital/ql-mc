'use strict';

/* ═══ HIRING PIPELINE ═══
   The recruitment counterpart to the sales pipeline, and deliberately built
   the same way: one kanban of stages you drag candidates across, one table
   underneath, and the same edit-on-click modal. Candidates live in their own
   `hiring_candidates` table - they share almost no fields with a sales lead,
   and every rep-scoping policy on `leads` would need an exception for rows
   that are not leads. RLS keeps the whole board off a rep's session. */
const HIRING_STAGES=[
  {id:'applied',label:'Applied'},{id:'screening',label:'Screening'},
  {id:'interview',label:'Interview'},{id:'offer',label:'Offer'},
  {id:'hired',label:'Hired'},{id:'rejected',label:'Rejected'}
];
const HIRING_CLOSED=['hired','rejected'];
const HIRE_CACHE={};
function hireStageLabel(s){ return (HIRING_STAGES.find(h=>h.id===s)||{}).label || s || '-'; }
function hireStageBadge(s){
  return s==='hired'?'bg-grn':s==='rejected'?'bg-red':s==='offer'?'bg-vio'
        :s==='interview'?'bg-sky':s==='screening'?'bg-amb':'bg-blu';
}
async function loadHiring() {
  if (IS_REP) return;   // walled off server-side too; this just saves the query
  const {data,error}=await db.from('hiring_candidates').select('*').order('created_at',{ascending:false});
  if (error) { $('hiring-tbody').innerHTML=`<tr><td colspan="9" class="empty">Error: ${esc(error.message)}</td></tr>`; return; }
  renderHiring(data||[]);
}
function renderHiring(cands) {
  const open=cands.filter(c=>!HIRING_CLOSED.includes(c.stage));
  const hired=cands.filter(c=>c.stage==='hired');
  setText('hiring-open',open.length||'-');
  setText('hiring-interview',cands.filter(c=>c.stage==='interview').length||'-');
  setText('hiring-offer',cands.filter(c=>c.stage==='offer').length||'-');
  setText('hiring-hired',hired.length||'-');
  setText('hiring-rate-sub',cands.length?`${hired.length} of ${cands.length} candidates`:'');

  // Anyone still in play whose follow-up date has come and gone.
  const today=new Date().toISOString().split('T')[0];
  const due=open.filter(c=>c.next_followup && c.next_followup<=today);
  const banner=$('hiring-followup-banner');
  if (banner) {
    banner.style.display=due.length?'block':'none';
    setText('hiring-followup-count',due.length);
    setText('hiring-followup-names',due.slice(0,6).map(c=>c.name).join(' · ')+(due.length>6?` +${due.length-6} more`:''));
  }
  const dueIds=new Set(due.map(c=>String(c.id)));

  cands.forEach(c=>{ HIRE_CACHE[c.id]=c; });
  HIRING_STAGES.forEach(st=>{
    const col=$('hiring-col-'+st.id),cnt=$('hiringc-'+st.id);
    const list=cands.filter(c=>c.stage===st.id);
    if (cnt) cnt.textContent=list.length;
    if (!col) return;
    col.innerHTML=list.map(c=>`
      <div class="kcard" id="kc-hiring-${esc(String(c.id))}" data-cand-id="${esc(String(c.id))}">
        <div class="kcard-name">${esc(c.name||'-')}</div>
        <div class="kcard-meta">${esc(c.role||'-')}</div>
        ${c.phone?`<div class="kcard-phone">${esc(c.phone)}</div>`:''}
        <div style="display:flex;gap:4px;margin-top:3px;align-items:center">
          ${c.rating!=null?`<span style="font-size:12px;font-family:var(--mono);color:${c.rating>=8?'var(--grn)':c.rating>=5?'var(--amb)':'var(--red)'}">★ ${c.rating}/10</span>`:''}
          ${c.expected_salary?`<span class="kcard-val">${fmt(c.expected_salary)}</span>`:''}
        </div>
        ${c.source?`<div class="kcard-meta" style="margin-top:2px;font-size:12px">via ${esc(hireSourceLabel(c.source))}</div>`:''}
        ${dueIds.has(String(c.id))?`<div style="font-size:12px;color:var(--amb);font-family:var(--mono);margin-top:3px">⚠ follow-up due ${esc(c.next_followup)}</div>`:''}
      </div>`).join('');
    col.querySelectorAll('.kcard').forEach(card=>{
      const id=card.dataset.candId;
      initCardDrag(card,id,'hiring');
      card.addEventListener('click',()=>{ if (HIRE_CACHE[id]) openEditHire(HIRE_CACHE[id]); });
    });
  });

  const tb=$('hiring-tbody');
  if (!cands.length) { tb.innerHTML='<tr><td colspan="9" class="empty">No candidates yet.</td></tr>'; return; }
  const order=s=>HIRING_STAGES.findIndex(h=>h.id===s);
  tb.innerHTML=[...cands].sort((a,b)=>order(a.stage)-order(b.stage)).map(c=>`
    <tr class="cand-row" data-cand-id="${esc(String(c.id))}" style="cursor:pointer">
      <td><strong>${esc(c.name||'-')}</strong>${c.email?`<div style="font-size:12px;color:var(--ink3)">${esc(c.email)}</div>`:''}</td>
      <td>${esc(c.role||'-')}</td>
      <td><span class="badge ${hireStageBadge(c.stage)}">${esc(hireStageLabel(c.stage))}</span></td>
      <td>${c.rating!=null?c.rating+'/10':'-'}</td>
      <td>${c.expected_salary?fmt(c.expected_salary):'-'}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(c.available_from||'-')}</td>
      <td>${esc(hireSourceLabel(c.source))}</td>
      <td style="font-family:var(--mono);font-size:12px;color:${dueIds.has(String(c.id))?'var(--amb)':'var(--ink3)'}">${esc(c.next_followup||'-')}${dueIds.has(String(c.id))?' ⚠':''}</td>
      <td style="white-space:nowrap"><button class="btn btn-xs edit-cand-btn">Edit</button>${c.resume_url?` <a class="btn btn-xs" href="${esc(c.resume_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Resume</a>`:''}</td>
    </tr>`).join('');
  tb.querySelectorAll('.cand-row').forEach(row=>{
    row.addEventListener('click',()=>{ const c=HIRE_CACHE[row.dataset.candId]; if (c) openEditHire(c); });
  });
}
function hireSourceLabel(v) {
  return {seek:'Seek',indeed:'Indeed',linkedin:'LinkedIn',referral:'Referral',
          direct:'Direct / Website',recruiter:'Recruiter',other:'Other'}[v] || (v || '-');
}
function hireForm(prefix) {
  const num=id=>$(id).value!==''?parseFloat($(id).value):null;
  const int=id=>$(id).value!==''?parseInt($(id).value,10):null;
  return {
    name:$(prefix+'-name').value.trim(),
    role:$(prefix+'-role').value.trim()||null,
    email:$(prefix+'-email').value.trim()||null,
    phone:$(prefix+'-phone').value.trim()||null,
    stage:$(prefix+'-stage').value,
    source:$(prefix+'-source').value||null,
    expected_salary:num(prefix+'-salary'),
    available_from:$(prefix+'-available').value||null,
    rating:int(prefix+'-rating'),
    next_followup:$(prefix+'-followup').value||null,
    resume_url:$(prefix+'-resume').value.trim()||null,
    notes:$(prefix+'-notes').value.trim()||null
  };
}
async function saveHire() {
  const d=hireForm('h');
  if (!d.name) { toast('Candidate name required',true); return; }
  const {error}=await db.from('hiring_candidates').insert([d]);
  if (error) { toast('DB error: '+error.message,true); return; }
  ['h-name','h-role','h-email','h-phone','h-salary','h-available','h-rating','h-followup','h-resume','h-notes']
    .forEach(id=>{ if($(id))$(id).value=''; });
  setVal('h-stage','applied'); setVal('h-source','seek');
  closeModal('m-hire'); toast('Candidate saved ✓');
  loadHiring();
}
function openEditHire(c) {
  if (!c) return;
  setVal('eh-id',c.id);
  setVal('eh-name',c.name||'');
  setVal('eh-role',c.role||'');
  setVal('eh-email',c.email||'');
  setVal('eh-phone',c.phone||'');
  setVal('eh-stage',c.stage||'applied');
  setVal('eh-stage-orig',c.stage||'');
  setVal('eh-source',c.source||'other');
  setVal('eh-salary',c.expected_salary??'');
  setVal('eh-available',c.available_from||'');
  setVal('eh-rating',c.rating??'');
  setVal('eh-followup',c.next_followup||'');
  setVal('eh-resume',c.resume_url||'');
  setVal('eh-notes',c.notes||'');
  setText('edit-hire-sub',(c.name||'')+(c.role?' · '+c.role:''));
  syncHireToTeamBtn(c.stage);
  openModal('m-edit-hire');
}
// A hired candidate can be pushed onto the team roster in one click - only the
// non-rep roles live there, so a hired sales rep still gets a login created on
// the Sales Reps panel instead.
function syncHireToTeamBtn(stage) {
  const b=$('eh-to-team'); if (b) b.style.display = stage==='hired' ? '' : 'none';
}
// Maps the free-text "role applied for" onto a team_members role where it is
// obvious; anything else opens the modal on the default role to pick by hand.
function teamRoleFromText(txt) {
  const t=String(txt||'').toLowerCase();
  if (/(customer success|\bcsm\b)/.test(t))     return 'csm';
  if (/(media buy|\bbuyer\b|\bads? manager\b)/.test(t)) return 'media_buyer';
  if (/(ops|operations)/.test(t))              return 'ops_manager';
  if (/(tech|developer|engineer|cto)/.test(t)) return 'tech_lead';
  return '';
}
function hireToTeam() {
  const c=HIRE_CACHE[$('eh-id').value];
  if (!c) return;
  const role=teamRoleFromText($('eh-role').value||c.role);
  closeModal('m-edit-hire');
  nav('team');
  openCreateTeamModal({
    name:$('eh-name').value||c.name, email:$('eh-email').value||c.email,
    phone:$('eh-phone').value||c.phone, start_date:c.available_from||'',
    role, notes:'Hired from the pipeline'+(c.role?` as ${c.role}`:'')
  });
}
// Stage saves on the spot here too - same reasoning as the sales pipeline, and
// the same behaviour as dragging the card between columns.
let _hireStageSaving=false;
async function saveHireStageNow() {
  const sel=$('eh-stage'); if (!sel) return;
  const id=$('eh-id').value, stage=sel.value, prev=$('eh-stage-orig').value;
  if (!id || !stage || stage===prev || _hireStageSaving) return;
  _hireStageSaving=true; sel.disabled=true;
  const {error}=await db.from('hiring_candidates').update({stage,updated_at:now()}).eq('id',id);
  _hireStageSaving=false; sel.disabled=false;
  if (error) { sel.value=prev; toast('Stage not saved: '+error.message,true); return; }
  setVal('eh-stage-orig',stage);
  syncHireToTeamBtn(stage);
  toast('→ '+hireStageLabel(stage));
  loadHiring();
}
async function updateHire() {
  const id=$('eh-id').value;
  const d=hireForm('eh');
  if (!d.name) { toast('Candidate name required',true); return; }
  d.updated_at=now();
  const {error}=await db.from('hiring_candidates').update(d).eq('id',id);
  if (error) { toast('DB error: '+error.message,true); return; }
  setVal('eh-stage-orig',d.stage);
  closeModal('m-edit-hire'); loadHiring(); toast('Candidate updated ✓');
}
async function deleteHire() {
  if (!confirm('Delete this candidate?')) return;
  const {error}=await db.from('hiring_candidates').delete().eq('id',$('eh-id').value);
  if (error) { toast('DB error: '+error.message,true); return; }
  closeModal('m-edit-hire'); loadHiring(); toast('Candidate deleted');
}
