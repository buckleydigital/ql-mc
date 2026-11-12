'use strict';

function buildKanban(containerId,stages,prefix) {
  $(containerId).innerHTML=stages.map(s=>`
    <div class="kcol" data-s="${s.id}">
      <div class="kcolh"><span class="kcoln">${s.label}</span><span class="kcnt" id="${prefix}c-${s.id}">0</span></div>
      <div class="kcards" id="${prefix}-col-${s.id}"
        ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="drop(event,'${prefix}','${s.id}')">
      </div>
    </div>`).join('');
}
let draggedId=null,draggedPrefix=null;
function initCardDrag(card,id,prefix) {
  // Reps may drag CRM leads to change stage (only) via a guarded RPC; they
  // cannot drag PPL/Managed client cards.
  if (IS_REP && prefix !== 'crm') return;
  card.draggable=true;
  card.addEventListener('dragstart',e=>{draggedId=id;draggedPrefix=prefix;card.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.stopPropagation();});
  card.addEventListener('dragend',()=>{card.classList.remove('dragging');document.querySelectorAll('.kcards').forEach(c=>c.classList.remove('drag-over'));});
}
function dragOver(e){e.preventDefault();e.currentTarget.classList.add('drag-over');}
function dragLeave(e){e.currentTarget.classList.remove('drag-over');}
async function drop(e,prefix,newStage) {
  e.preventDefault();e.currentTarget.classList.remove('drag-over');
  if (!draggedId||draggedPrefix!==prefix) return;
  if (IS_REP) {
    // Reps may only change the stage of their own CRM leads, via the guarded RPC.
    if (prefix !== 'crm') { draggedId=null;draggedPrefix=null; return; }
    const { error } = await db.rpc('rep_update_lead_stage', { p_lead_id: draggedId, p_stage: newStage });
    if (error) { toast('Move failed: ' + error.message, true); return; }
    toast('→ ' + stageLabel(newStage));
    draggedId=null;draggedPrefix=null;
    loadCRM();
    return;
  }
  const TABLE_MAP = { crm: 'leads', hiring: 'hiring_candidates' };
  const table = TABLE_MAP[prefix] || 'clients';
  const updateData={stage:newStage,updated_at:now()};
  if (prefix==='crm'&&['call_back','proposal','closed_won'].includes(newStage)) updateData.contactable=true;
  const {error}=await db.from(table).update(updateData).eq('id',draggedId);
  if (error) { toast('Move failed: '+error.message,true); return; }
  toast('→ ' + stageLabel(newStage));
  draggedId=null;draggedPrefix=null;
  if (prefix==='crm') loadCRM(); else if (prefix==='hiring') loadHiring(); else if (prefix==='ppl') loadPPL(); else loadManaged();
}

// One rule for "needs follow-up", shared by the Sales Pipeline banner, the
// bell and the Finance tile so they always count the same leads. They used to
// each have their own: the bell counted passed follow-up dates, the banner
// counted leads not contacted for 7 days, and the two lists barely overlapped.
// A lead needs it when it is open, not marked uncontactable, and either its
// follow-up date has come, or it has no follow-up date and has gone 7+ days
// without contact (or has never been contacted and was not marked
// contactable). A future follow-up date means it is scheduled, not overdue.
// Moving a lead to another stage pushes a today-or-past follow-up date
// forward (leads_push_followup in the database), so a lead just worked does
// not show as due.
const FOLLOWUP_STALE_DAYS = 7;
function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}
const sydneyDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(at));
function crmNeedsFollowup(l, today = sydneyToday()) {
  if (['closed_won','closed_lost','churned'].includes(l.stage)) return false;
  if (l.contactable === false) return false;
  // Contacted today means it has just been worked: a follow-up due today is
  // done, not outstanding. Overdue dates from before today still count.
  const contactedToday = l.last_contact && sydneyDate(l.last_contact) === today;
  if (l.next_followup) return l.next_followup < today || (l.next_followup === today && !contactedToday);
  if (!l.last_contact) return l.contactable !== true;
  return (Date.now() - new Date(l.last_contact)) / 86400000 >= FOLLOWUP_STALE_DAYS;
}
const CRM_FOLLOWUP_COLS = 'id,name,company,stage,next_followup,last_contact,contactable';

const CRM_STAGES=[{id:'new_lead',label:'New Lead'},{id:'no_answer',label:'No Answer'},{id:'call_back',label:'Booked'},{id:'proposal',label:'Proposal'},{id:'closed_won',label:'Closed Won'},{id:'closed_lost',label:'Closed Lost'}];
async function loadCRM(resetPage) {
  if (resetPage) crmPage = 0;

  // Always fetch the full pipeline for the kanban - no date filter, all stages.
  // Date-filtered leads go to the table/KPIs so users can report on a period
  // without losing visibility of deals created before that window.
  const pipelineQ = db.from('leads').select('*')
    .order('created_at', {ascending: false});

  let tableQ = db.from('leads').select('*').order('created_at', {ascending: false});
  if (curCrmRange) {
    const {from,to} = getDateRange(curCrmRange);
    const toNext = new Date(to); toNext.setDate(toNext.getDate()+1);
    tableQ = tableQ.gte('created_at', from+'T00:00:00').lt('created_at', toNext.toISOString().split('T')[0]+'T00:00:00');
  }

  const [pipelineR, tableR] = await Promise.all([pipelineQ, tableQ]);
  if (pipelineR.error) { $('crm-tbody').innerHTML=`<tr><td colspan="9" class="empty">Error: ${esc(pipelineR.error.message)}</td></tr>`; return; }
  if (tableR.error)    { $('crm-tbody').innerHTML=`<tr><td colspan="9" class="empty">Error: ${esc(tableR.error.message)}</td></tr>`; return; }

  crmPipelineLeads = pipelineR.data || [];
  // When no date filter is active the table shows the same full set as the kanban
  crmAllLeads = curCrmRange ? (tableR.data || []) : crmPipelineLeads;
  if (!IS_REP) populateCrmRepView();
  renderCRM();
  if (!IS_REP) loadCrmLtv().then(refreshSalesMetrics);
  if (IS_REP) loadRepStats();
}
