'use strict';

// ── Bulk SMS / Broadcast ────────────────────────────────────────────────────
// Personalised SMS to sales-pipeline leads by stage. Excludes no-phone AND
// opted-out leads. Appends "Reply STOP to opt out". Sends via send-sms (which
// also hard-blocks opted-out), logging each into sales_sms_log so replies thread
// into Sales Conversations.
let _bcLeads = [];            // eligible pool (stage + has phone + not opted out)
let _bcExcluded = new Set();  // ids manually excluded
let _bcNoPhone = 0, _bcAutoOptedOut = 0;
function bcFirstName(l){ return ((l.name||'').trim().split(/\s+/)[0]) || 'there'; }
function bcEffective(){ return _bcLeads.filter(l=>!_bcExcluded.has(String(l.id))); }
function loadBroadcast(){
  const sel=$('bc-stage');
  if(sel && sel.options.length<=1){
    CRM_STAGES.forEach(s=>{ const o=document.createElement('option'); o.value=s.id; o.textContent=s.label; sel.appendChild(o); });
  }
  updateBroadcastCount();
}
async function updateBroadcastCount(){
  const stage=$('bc-stage')?.value||'all';
  let q=db.from('leads').select('id,name,phone,stage,sms_opted_out');
  if(stage!=='all') q=q.eq('stage',stage);
  const {data,error}=await q;
  if(error){ toast('Failed to load leads',true); return; }
  const all=data||[];
  const withPhone=all.filter(l=>l.phone&&String(l.phone).trim());
  _bcLeads=withPhone.filter(l=>!l.sms_opted_out);
  _bcNoPhone=all.length-withPhone.length;
  _bcAutoOptedOut=withPhone.length-_bcLeads.length;
  // Preview-as selector
  const psel=$('bc-preview-lead');
  if(psel){
    const prev=psel.value;
    psel.innerHTML='<option value="">First recipient</option>'+_bcLeads.map(l=>`<option value="${esc(String(l.id))}">${esc(l.name||l.phone||'-')}</option>`).join('');
    if(prev && _bcLeads.some(l=>String(l.id)===prev)) psel.value=prev;
  }
  // Exclude selector - keep only still-eligible manual excludes
  const xsel=$('bc-exclude');
  if(xsel){
    const keep=new Set([..._bcExcluded].filter(id=>_bcLeads.some(l=>String(l.id)===id)));
    xsel.innerHTML=_bcLeads.map(l=>`<option value="${esc(String(l.id))}"${keep.has(String(l.id))?' selected':''}>${esc(l.name||l.phone||'-')}</option>`).join('');
    _bcExcluded=keep;
  }
  renderBcCount();
}
function updateExcluded(){
  const xsel=$('bc-exclude');
  _bcExcluded=new Set(xsel?[...xsel.selectedOptions].map(o=>o.value):[]);
  renderBcCount();
}
function renderBcCount(){
  const eff=bcEffective();
  setText('bc-count', eff.length);
  const exEl=$('bc-excluded');
  if(exEl){ const parts=[]; if(_bcNoPhone)parts.push(_bcNoPhone+' no phone'); if(_bcAutoOptedOut)parts.push(_bcAutoOptedOut+' opted out'); if(_bcExcluded.size)parts.push(_bcExcluded.size+' manually excluded'); exEl.textContent=parts.length?'('+parts.join(', ')+' excluded)':''; }
  updateBroadcastPreview();
}
function updateBroadcastPreview(){
  const raw=$('bc-message')?.value||'';
  const pv=$('bc-preview'); const btn=$('bc-send');
  const eff=bcEffective();
  if(!raw.trim()){ if(pv)pv.textContent='Type a message to see a preview…'; if(btn)btn.disabled=true; return; }
  const selId=$('bc-preview-lead')?.value;
  const sample=(selId && _bcLeads.find(l=>String(l.id)===selId)) || eff[0] || _bcLeads[0];
  const name=sample?bcFirstName(sample):'there';
  if(pv)pv.textContent=raw.replace(/\{\{\s*first_name\s*\}\}/gi,name)+'\n\nReply STOP to opt out';
  if(btn)btn.disabled=eff.length===0;
}
async function sendBroadcast(){
  const raw=($('bc-message')?.value||'').trim();
  if(!raw){ toast('Enter a message first',true); return; }
  const leads=bcEffective();
  if(!leads.length){ toast('No recipients',true); return; }
  if(!confirm(`Send this SMS to ${leads.length} lead(s)?\n\nOpted-out, no-phone, and manually excluded leads are not included.`)) return;
  const btn=$('bc-send'); btn.disabled=true;
  const prog=$('bc-progress'); if(prog) prog.style.display='';
  const {data:{session}}=await db.auth.getSession();
  if(!session){ toast('Not logged in',true); btn.disabled=false; return; }
  let sent=0,failed=0,skipped=0;
  for(let i=0;i<leads.length;i++){
    const l=leads[i];
    const msg=raw.replace(/\{\{\s*first_name\s*\}\}/gi,bcFirstName(l))+'\n\nReply STOP to opt out';
    if(prog) prog.textContent=`Sending ${i+1} / ${leads.length}…  (${sent} sent, ${failed} failed${skipped?', '+skipped+' skipped':''})`;
    try{
      const res=await fetch(`${_ep}/functions/v1/send-sms`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({to:l.phone,message:msg,lead_id:l.id,source:'sales'})});
      const d=await res.json().catch(()=>({}));
      if(res.status===409){ skipped++; }
      else if(res.ok&&d.success){ sent++; } else { failed++; }
    }catch{ failed++; }
    await new Promise(r=>setTimeout(r,350));
  }
  // Switch the AI SMS agent OFF for every lead we just bulk-messaged, so it
  // never auto-replies to their responses (the toggle lives in ql-hq). Fire-and-
  // forget: the bulk send itself already succeeded, so a failure here is non-fatal.
  try{
    await fetch(`${_ep}/functions/v1/sync-to-hq`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},body:JSON.stringify({action:'disable_ai',leads:leads.map(l=>({phone:l.phone,name:l.name||''}))})});
  }catch(e){ /* non-fatal */ }
  if(prog) prog.textContent=`Done - ${sent} sent, ${failed} failed${skipped?', '+skipped+' skipped (opted out, or already sent this message)':''}.`;
  btn.disabled=false;
  toast(`Bulk SMS complete: ${sent} sent, ${failed} failed`);
  updateBroadcastCount();
}
