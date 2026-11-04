'use strict';

function renderCRM() {
  let allLeads = crmAllLeads;           // table + KPIs (date-filtered)
  let pipeline = crmPipelineLeads;     // kanban + follow-up banner (always all active)
  // Owner "view as rep": scope the whole panel to one rep's assigned leads.
  if (!IS_REP && crmRepView) {
    allLeads = allLeads.filter(l => l.owner_id === crmRepView);
    pipeline = pipeline.filter(l => l.owner_id === crmRepView);
  }
  const rvStats = $('crm-repview-stats');
  if (rvStats) {
    if (!IS_REP && crmRepView) {
      const total = pipeline.length;
      const w  = pipeline.filter(l => l.stage === 'closed_won').length;
      const lo = pipeline.filter(l => l.stage === 'closed_lost' || l.stage === 'churned').length;
      const op = pipeline.filter(l => !['closed_won','closed_lost','churned'].includes(l.stage || '')).length;
      const dec = w + lo;
      const allPct = total ? Math.round(w/total*100)+'%' : '-';
      const decPct = dec ? Math.round(w/dec*100)+'%' : '-';
      rvStats.textContent = `Close rate ${allPct} (all) · ${decPct} (decided) · Won ${w} · Lost ${lo} · Open ${op} · ${total} leads`;
    } else { rvStats.textContent = ''; }
  }
  refreshSalesMetrics();
  const won=allLeads.filter(l=>l.stage==='closed_won').length;
  const lostAll=allLeads.filter(l=>l.stage==='closed_lost'||l.stage==='churned').length;
  const decidedAll=won+lostAll;
  setText('crm-total',allLeads.length);
  setText('crm-active',allLeads.filter(l=>!['closed_won','closed_lost'].includes(l.stage)).length);
  setText('crm-won',won);
  setText('crm-rate',allLeads.length>0?Math.round(won/allLeads.length*100)+'%':'-');
  setText('crm-rate-sub',decidedAll>0?Math.round(won/decidedAll*100)+'% of decided':'');
  // Average deal value of closes with a value entered (as entered, incl. GST),
  // Admin only: the card is hidden from reps.
  if (!IS_REP) {
    const valued = allLeads.filter(l => l.stage === 'closed_won' && Number(l.value) > 0);
    const avg = arr => arr.length ? arr.reduce((a, l) => a + Number(l.value), 0) / arr.length : 0;
    const money = v => '$' + Math.round(v).toLocaleString('en-AU');
    setText('crm-avgwon', valued.length ? money(avg(valued)) : '-');
    setText('crm-avgwon-sub', valued.length
      ? valued.length + ' closes · inc GST'
      : (won ? 'no values entered' : ''));
  }
  const _fuToday=sydneyToday();
  const staleLeads=pipeline.filter(l=>crmNeedsFollowup(l,_fuToday));
  const badge=$('crm-followup-badge'),banner=$('crm-followup-banner');
  if (badge){badge.textContent=staleLeads.length;badge.style.display=staleLeads.length>0?'inline':'none';}
  if (banner){
    if (staleLeads.length>0){
      banner.style.display='block';
      setText('crm-followup-count',staleLeads.length);
      const names=staleLeads.slice(0,4).map(l=>{
        const why=l.next_followup?'due '+l.next_followup:'follow-up due';
        return `${esc(l.name||l.company||'Unknown')} (${why})`;
      }).join(', ')+(staleLeads.length>4?` +${staleLeads.length-4} more`:'');
      setText('crm-followup-names',names);
    } else { banner.style.display='none'; }
  }
  const staleIds=new Set(staleLeads.map(l=>String(l.id)));
  if (crmSearch) {
    pipeline = pipeline.filter(crmMatches);
    allLeads = allLeads.filter(crmMatches);
  }
  setText('crm-search-count', crmSearch ? `${allLeads.length} match${allLeads.length===1?'':'es'}` : '');
  CRM_STAGES.forEach(s=>{
    const col=$('crm-col-'+s.id),cnt=$('crmc-'+s.id);
    const sl=pipeline.filter(l=>l.stage===s.id);
    if (cnt) cnt.textContent=sl.length;
    if (col) {
      sl.forEach(l => { LEAD_CACHE[l.id] = l; });
      col.innerHTML=sl.map(l=>{
        const isStale=staleIds.has(String(l.id));
        const cPill=l.contactable===true
          ?`<span class="kcard-cpill cp-yes">● contactable</span>`
          :l.contactable===false
          ?`<span class="kcard-cpill cp-no">● uncontactable</span>`
          :`<span class="kcard-cpill cp-unk">● not set</span>`;
        const cToggleYes=l.contactable===true
          ?`<button class="kcard-ctoggle" onclick="toggleContactable(event,'${esc(String(l.id))}',null)" title="Clear status">✓</button>`
          :`<button class="kcard-ctoggle" onclick="toggleContactable(event,'${esc(String(l.id))}',true)" title="Mark contactable">✓</button>`;
        const cToggleNo=l.contactable===false
          ?`<button class="kcard-ctoggle" onclick="toggleContactable(event,'${esc(String(l.id))}',null)" title="Clear status">✗</button>`
          :`<button class="kcard-ctoggle" onclick="toggleContactable(event,'${esc(String(l.id))}',false)" title="Mark uncontactable">✗</button>`;
        return `
        <div class="kcard" id="kc-crm-${esc(String(l.id))}" data-lead-id="${esc(String(l.id))}">
          <div class="kcard-name">${esc(l.name||'-')}</div>
          <div class="kcard-meta">${esc(l.company||'-')}</div>
          ${stageAgeLine(l)}
          ${l.phone?`<div class="kcard-phone">${esc(l.phone)}</div>`:''}
          <div style="display:flex;gap:4px;margin-top:3px;align-items:center">
            ${(!IS_REP && l.value)?`<span class="kcard-val">${fmt(l.value)}</span>`:''}
          </div>
          ${(!IS_REP && l.owner_id)?`<div class="kcard-meta" style="margin-top:2px;color:var(--acc);font-size:12px">▸ ${esc(repName(l.owner_id)||'assigned')}</div>`:''}
          <div class="kcard-contact-row">${cPill}${IS_REP?'':cToggleYes+cToggleNo}</div>
          ${isStale?`<div style="font-size:12px;color:var(--amb);font-family:var(--mono);margin-top:3px;display:flex;align-items:center;gap:8px">⚠ follow-up due<button class="kcard-ctoggle" style="width:auto;padding:0 8px;font-size:11px" onclick="markFollowupDone(event,'${esc(String(l.id))}')" title="Mark the follow-up done">Done</button></div>`:''}
        </div>`}).join('');
      col.querySelectorAll('.kcard').forEach(card=>{
        const id=card.dataset.leadId;
        initCardDrag(card,id,'crm');
        card.addEventListener('click',()=>{ if (LEAD_CACHE[id]) openEditLead(LEAD_CACHE[id]); });
      });
    }
  });
  const tb=$('crm-tbody');
  if (!allLeads.length) { tb.innerHTML=`<tr><td colspan="8" class="empty">${crmSearch?'No leads match your search.':'No leads yet.'}</td></tr>`; $('crm-pager').innerHTML=''; return; }
  allLeads.forEach(l => { LEAD_CACHE[l.id] = l; });
  const totalPages = Math.ceil(allLeads.length / PAGE_SIZE);
  if (crmPage >= totalPages) crmPage = totalPages - 1;
  const pageLeads = allLeads.slice(crmPage * PAGE_SIZE, (crmPage + 1) * PAGE_SIZE);
  tb.innerHTML=pageLeads.map(l=>{
    const ds=l.last_contact?Math.floor((Date.now()-new Date(l.last_contact))/(1000*86400)):null;
    const isStale=staleIds.has(String(l.id));
    const contactCell=l.last_contact
      ?`<span style="color:${isStale?'var(--amb)':'inherit'}">${new Date(l.last_contact).toLocaleDateString('en-AU')}${isStale?` <span style="font-size:12px;font-family:var(--mono)">(${ds}d)</span>`:''}</span>`
      :`<span style="color:${isStale?'var(--amb)':'var(--ink3)'}">-${isStale?' ⚠':''}</span>`;
    return `
    <tr style="cursor:pointer" data-lead-id="${esc(l.id)}" class="lead-row">
      <td><strong>${esc(l.name||'-')}</strong></td>
      <td>${esc(l.company||'-')}</td>
      <td><span class="badge ${stageBadge(l.stage)}">${stageLabel(l.stage)}</span></td>
      ${IS_REP?'':`<td>${l.value?'$'+Number(l.value).toLocaleString():'-'}</td>`}
      <td>${esc(l.source||'-')}</td>
      <td>${contactCell}</td>
      <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)">${esc(l.notes||'-')}</td>
      <td style="white-space:nowrap"><button class="btn btn-xs edit-lead-btn" data-lead-id="${esc(l.id)}" style="margin-right:4px">Edit</button>${l.phone?`<button class="btn btn-xs sales-sms-btn" data-lead-id="${esc(l.id)}" data-phone="${esc(l.phone)}" data-name="${esc(l.name||l.company||'')}">SMS</button>`:''}</td>
    </tr>`}).join('');
  tb.querySelectorAll('.lead-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('edit-lead-btn')) { e.stopPropagation(); return; }
      const id = row.dataset.leadId;
      if (LEAD_CACHE[id]) openEditLead(LEAD_CACHE[id]);
    });
  });
  tb.querySelectorAll('.edit-lead-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.leadId;
      if (LEAD_CACHE[id]) openEditLead(LEAD_CACHE[id]);
    });
  });
  tb.querySelectorAll('.sales-sms-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openSalesConvThread(btn.dataset.leadId, btn.dataset.name, btn.dataset.phone); });
  });
  renderPager('crm-pager', crmPage, allLeads.length, p => { crmPage = p; renderCRM(); });
}
/* ═══ SENT EMAILS ═══
   The log the send function writes, read back. RLS already decides what is
   visible: everything for a full user, their own leads for a rep - so this
   panel needs no role check of its own beyond what the query returns. */
let _sentMail = [], _sentFilter = '', _sentPage = 0;
async function loadSentEmails() {
  const { data, error } = await db
    .from('sales_email_log')
    .select('id,lead_id,kind,to_email,reply_to,subject,body,sent_by,sent_at')
    .order('sent_at', { ascending: false })
    .limit(500);
  if (error) { $('sm-tbody').innerHTML = `<tr><td colspan="7" class="empty">Error: ${esc(error.message)}</td></tr>`; return; }
  _sentMail = data || [];

  // Lead names, so the table reads like a pipeline rather than a mail log.
  const ids = [...new Set(_sentMail.map(r => r.lead_id).filter(Boolean))];
  if (ids.length) {
    const { data: leads } = await db.from('leads').select('id,name,company').in('id', ids);
    (leads || []).forEach(l => { LEAD_CACHE[l.id] = { ...(LEAD_CACHE[l.id] || {}), ...l }; });
  }
  if (!IS_REP && !_reps.length) await ensureRepOptions();
  _sentPage = 0;
  renderSentEmails();
}
function setSentFilter(kind, btn) {
  _sentFilter = kind; _sentPage = 0;
  document.querySelectorAll('.sm-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderSentEmails();
}
function renderSentEmails() {
  const week = Date.now() - 7 * 86400000;
  setText('sm-total', _sentMail.length || '-');
  setText('sm-info', _sentMail.filter(r => r.kind === 'info' || r.kind === 'info_5k').length || '-');
  setText('sm-followup', _sentMail.filter(r => r.kind === 'followup').length || '-');
  setText('sm-week', _sentMail.filter(r => new Date(r.sent_at).getTime() >= week).length || '-');

  const rows = _sentFilter ? _sentMail.filter(r => r.kind === _sentFilter) : _sentMail;
  const tb = $('sm-tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">Nothing sent yet.</td></tr>'; $('sm-pager').innerHTML = ''; return; }
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  if (_sentPage >= pages) _sentPage = pages - 1;
  const page = rows.slice(_sentPage * PAGE_SIZE, (_sentPage + 1) * PAGE_SIZE);

  tb.innerHTML = page.map(r => {
    const l = LEAD_CACHE[r.lead_id] || {};
    const who = _reps.find(x => x.user_id === r.sent_by);
    return `<tr>
      <td style="font-family:var(--mono);font-size:12px;white-space:nowrap">${new Date(r.sent_at).toLocaleString('en-AU', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
      <td><strong>${esc(l.name || '-')}</strong>${l.company ? `<div style="font-size:12px;color:var(--ink3)">${esc(l.company)}</div>` : ''}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(r.to_email)}</td>
      <td>${emailKindBadge(r.kind)}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject)}</td>
      <td style="font-size:12px;color:var(--ink2)">${esc(who ? (who.name || who.email) : (r.reply_to || '-'))}</td>
      <td><button class="btn btn-xs" onclick="viewSentEmail('${esc(r.id)}')">View</button></td>
    </tr>`;
  }).join('');
  renderPager('sm-pager', _sentPage, rows.length, p => { _sentPage = p; renderSentEmails(); });
}
function emailKindBadge(kind) {
  const label = ({info:'2.5K offer', info_5k:'5K offer', followup:'Follow-up', no_answer:'No answer', campaign:'Campaign'})[kind] || kind;
  return `<span class="badge ${kind === 'info' ? 'bg-blu' : kind === 'no_answer' ? 'bg-amb' : 'bg-vio'}">${esc(label)}</span>`;
}
function viewSentEmail(id) {
  const r = _sentMail.find(x => x.id === id) || _leadMail.find(x => x.id === id); if (!r) return;
  const l = LEAD_CACHE[r.lead_id] || {};
  setText('sm-sub', (l.name || '') + (l.company ? ' · ' + l.company : '') + ' · ' + new Date(r.sent_at).toLocaleString('en-AU'));
  setVal('sm-v-to', r.to_email);
  setVal('sm-v-replyto', r.reply_to || '-');
  setVal('sm-v-subject', r.subject);
  setVal('sm-v-body', r.body);
  $('m-sent-email').classList.toggle('stacked', $('m-lead-emails').classList.contains('open'));
  openModal('m-sent-email');
}

// Every email sent to one lead, from the Edit Lead modal. Same log and the same
// RLS as the Sent Emails panel, so a rep only ever sees their own leads' mail.
let _leadMail = [];
async function openLeadEmails() {
  const id = $('el-id').value;
  const l = LEAD_CACHE[id] || {};
  setVal('le-lead-id', id);
  setText('le-sub', (l.name || '') + (l.company ? ' · ' + l.company : '') + (l.email ? ' · ' + l.email : ''));
  $('le-tbody').innerHTML = '<tr><td colspan="5" class="empty">Loading...</td></tr>';
  closeModal('m-edit-lead');
  $('m-lead-emails').classList.add('stacked');
  openModal('m-lead-emails');

  const { data, error } = await db
    .from('sales_email_log')
    .select('id,lead_id,kind,to_email,reply_to,subject,body,sent_by,sent_at')
    .eq('lead_id', id)
    .order('sent_at', { ascending: false });
  if (error) { $('le-tbody').innerHTML = `<tr><td colspan="5" class="empty">Error: ${esc(error.message)}</td></tr>`; return; }
  _leadMail = data || [];
  if (!IS_REP && !_reps.length) await ensureRepOptions();
  if (!_leadMail.length) { $('le-tbody').innerHTML = '<tr><td colspan="5" class="empty">No emails sent to this lead yet.</td></tr>'; return; }
  $('le-tbody').innerHTML = _leadMail.map(r => {
    const who = _reps.find(x => x.user_id === r.sent_by);
    return `<tr>
      <td style="font-family:var(--mono);font-size:12px;white-space:nowrap">${new Date(r.sent_at).toLocaleString('en-AU', {day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
      <td>${emailKindBadge(r.kind)}</td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject)}</td>
      <td style="font-size:12px;color:var(--ink2)">${esc(who ? (who.name || who.email) : (r.reply_to || '-'))}</td>
      <td><button class="btn btn-xs" onclick="viewSentEmail('${esc(r.id)}')">View</button></td>
    </tr>`;
  }).join('');
}
// Closing the list returns you to the lead you opened it from.
function closeLeadEmails() {
  const id = $('le-lead-id').value;
  closeModal('m-lead-emails');
  const l = LEAD_CACHE[id];
  if (l) openEditLead(l);
}

/* ═══ SALES EMAILS ═══
   Two templates, shared across the team, merged against the lead when a rep
   opens the draft. The rep can edit the draft for that one lead; the template
   is untouched. send-sales-email does the sending, the ownership check, the
   once-only guard and the stamp on the lead - none of which a browser should
   be trusted with. */
let _emailTpls = null;

// Jeff Jones → Jeff. Anything that is only a company name stays whole, because
// "Hi Apex Solar Group" reads better than "Hi Apex".
function firstName(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return n.split(/\s+/)[0];
}
// Placeholders with no value are dropped along with the space they leave, so a
// missing company never shows up as "Following up - ".
function mergeTemplate(text, vals) {
  return String(text || '')
    .replace(/\{(first_name|company_name|rep_name|rep_email)\}/g, (_, k) => vals[k] || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/ -\s*$/gm, '')
    .trim();
}
// Templates by niche. sales_email_templates is the default every niche gets;
// sales_email_template_niches holds a niche's own version of any of the three.
// Niches are matched in lower case, so "Solar" on a lead finds "solar".
const TPL_KINDS = ['info', 'info_5k', 'followup'];
const nicheKey = n => String(n || '').trim().toLowerCase();
const NICHE_NAMES = { hvac: 'HVAC', ev: 'EV', ev_charger: 'EV Charger' };
const nicheName = n => !n ? 'All niches' : NICHE_NAMES[n] || String(n).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
async function ensureEmailTemplates() {
  if (_emailTpls) return _emailTpls;
  const [b, n, l] = await Promise.all([
    db.from('sales_email_templates').select('kind,subject,body,updated_at'),
    db.from('sales_email_template_niches').select('kind,niche,subject,body,updated_at'),
    db.from('leads').select('niche').not('niche', 'is', null).limit(5000),
  ]);
  const err = b.error || n.error;
  if (err) { toast('Could not load templates: ' + err.message, true); return null; }
  const base = {}, niches = {};
  (b.data || []).forEach(t => { base[t.kind] = t; });
  (n.data || []).forEach(t => { (niches[t.niche] ??= {})[t.kind] = t; });
  const leadNiches = [...new Set((l.data || []).map(r => nicheKey(r.niche)).filter(Boolean))];
  _emailTpls = { base, niches, leadNiches };
  return _emailTpls;
}
// The version a lead in this niche gets: its niche's own, else the default.
function pickTemplate(tpls, kind, niche) {
  const k = nicheKey(niche);
  return (k && tpls.niches[k]?.[kind]) || tpls.base[kind] || null;
}
function knownNiches(tpls) {
  return [...new Set([...Object.keys(tpls.niches), ...tpls.leadNiches, ..._tplExtraNiches])].sort();
}
// For the Niche box on a lead: every niche we have templates for or have seen.
async function fillNicheList() {
  const tpls = await ensureEmailTemplates(); if (!tpls) return;
  const dl = $('niche-list');
  if (dl) dl.innerHTML = knownNiches(tpls).map(n => `<option value="${esc(n)}">`).join('');
}
let _tplNiche = '';          // the niche being edited; '' is the default
let _tplExtraNiches = [];    // added here but not saved yet
async function loadEmailTemplates(fromSelect) {
  if (fromSelect === true) _tplNiche = $('tpl-niche').value;
  else { _emailTpls = null; loadNoAnswerEmail(); }
  const tpls = await ensureEmailTemplates(); if (!tpls) return;
  const list = knownNiches(tpls);
  if (_tplNiche && !list.includes(_tplNiche)) list.push(_tplNiche);
  $('tpl-niche').innerHTML = '<option value="">All niches (default)</option>'
    + list.map(n => `<option value="${esc(n)}">${esc(nicheName(n))}${tpls.niches[n] ? '' : ' (uses the default)'}</option>`).join('');
  $('tpl-niche').value = _tplNiche;
  const own = _tplNiche ? (tpls.niches[_tplNiche] || {}) : tpls.base;
  TPL_KINDS.forEach(k => {
    const t = own[k] || tpls.base[k];
    setVal('tpl-' + k + '-subject', t?.subject || '');
    setVal('tpl-' + k + '-body', t?.body || '');
    setText('tpl-' + k + '-note', _tplNiche && !own[k]
      ? `Showing the default. Save to give ${nicheName(_tplNiche)} its own version.`
      : t?.updated_at ? 'Last saved ' + new Date(t.updated_at).toLocaleString('en-AU') : '');
  });
  setText('tpl-niche-note', _tplNiche
    ? `Leads with the niche ${nicheName(_tplNiche)} get these. An email ${nicheName(_tplNiche)} has no version of uses the default.`
    : 'The default: what every lead gets unless its niche has its own version. Set a lead\'s niche on the lead.');
  $('tpl-niche-del').style.display = _tplNiche && tpls.niches[_tplNiche] ? '' : 'none';
}
function addTemplateNiche() {
  const k = nicheKey($('tpl-niche-new').value).replace(/[^a-z0-9 +&_-]/g, '').replace(/\s+/g, ' ').trim();
  if (!k) { toast('Type the niche first, e.g. roofing', true); return; }
  if (!_tplExtraNiches.includes(k)) _tplExtraNiches.push(k);
  setVal('tpl-niche-new', '');
  _tplNiche = k;
  loadEmailTemplates(false);
  toast(`Now editing ${nicheName(k)}. Change the emails and save each one.`);
}
async function deleteTemplateNiche() {
  if (!_tplNiche) return;
  if (!confirm(`Delete the ${nicheName(_tplNiche)} versions? Leads in ${nicheName(_tplNiche)} will get the default emails.`)) return;
  const { error } = await db.from('sales_email_template_niches').delete().eq('niche', _tplNiche);
  if (error) { toast('Error: ' + error.message, true); return; }
  _tplExtraNiches = _tplExtraNiches.filter(n => n !== _tplNiche);
  _tplNiche = '';
  loadEmailTemplates(false);
  toast('Deleted ✓');
}
// The automatic no-answer follow-ups live in business_settings, not
// sales_email_templates: they have their own on/off and days, and only
// pipeline-no-answer-email sends them. Day 1, 3, 7 and 10, a text and an email.
const NA_DAYS = [1, 3, 7, 10];
async function loadNoAnswerEmail() {
  const {data, error} = await db.from('business_settings')
    .select('no_answer_email_enabled,no_answer_followups').limit(1).maybeSingle();
  if (error || !data) return;
  $('tpl-na-enabled').checked = !!data.no_answer_email_enabled;
  const steps = Array.isArray(data.no_answer_followups) ? data.no_answer_followups : [];
  $('tpl-na-steps').innerHTML = NA_DAYS.map(d => {
    const st = steps.find(x => Number(x.day) === d) || {};
    return `<div style="border:1px solid var(--bd);border-radius:var(--r);padding:12px 14px;margin-bottom:12px">
      <div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--acc);margin-bottom:8px">DAY ${d}</div>
      <div class="frow"><label class="flabel">Text <span id="tpl-na-sms-count-${d}" style="font-weight:400;color:var(--ink3)"></span></label><textarea class="fta" id="tpl-na-sms-${d}" style="min-height:64px" maxlength="440" oninput="setText('tpl-na-sms-count-${d}', this.value.length + ' / 440 characters')">${esc(st.sms || '')}</textarea></div>
      <div class="frow"><label class="flabel">Email subject</label><input class="fi" id="tpl-na-subject-${d}" value="${esc(st.subject || '')}"></div>
      <div class="frow"><label class="flabel">Email</label><textarea class="fta" id="tpl-na-email-${d}" style="min-height:150px;line-height:1.6">${esc(st.email || '')}</textarea></div>
    </div>`;
  }).join('');
}
async function saveNoAnswerEmail() {
  const steps = NA_DAYS.map(d => ({
    day: d,
    sms: $('tpl-na-sms-' + d).value.trim(),
    subject: $('tpl-na-subject-' + d).value.trim(),
    email: $('tpl-na-email-' + d).value.trim(),
  }));
  const half = steps.find(st => !!st.subject !== !!st.email);
  if (half) { toast(`Day ${half.day}: give the email both a subject and a body, or leave both blank`, true); return; }
  if (!steps.some(st => st.sms || st.email)) { toast('Write at least one text or email', true); return; }
  const existing = await db.from('business_settings').select('id').limit(1).single();
  if (!existing.data) { toast('Save Business Settings once first', true); return; }
  const {error} = await db.from('business_settings').update({
    no_answer_email_enabled: $('tpl-na-enabled').checked, no_answer_followups: steps, updated_at: now(),
  }).eq('id', existing.data.id);
  if (error) { toast('Error: ' + error.message, true); return; }
  setText('tpl-na-note', 'Last saved just now');
  toast('No-answer follow-ups saved ✓');
}
async function saveEmailTemplate(kind) {
  const subject = $('tpl-' + kind + '-subject').value.trim();
  const body    = $('tpl-' + kind + '-body').value;
  if (!subject || !body.trim()) { toast('Subject and body are required', true); return; }
  const { data: { session } } = await db.auth.getSession();
  const row = { subject, body, updated_at: now(), updated_by: session?.user?.id || null };
  const { error } = _tplNiche
    ? await db.from('sales_email_template_niches').upsert({ kind, niche: _tplNiche, ...row }, { onConflict: 'kind,niche' })
    : await db.from('sales_email_templates').update(row).eq('kind', kind);
  if (error) { toast('Error: ' + error.message, true); return; }
  _emailTpls = null;
  await loadEmailTemplates(false);
  setText('tpl-' + kind + '-note', 'Last saved just now');
  toast(_tplNiche ? `Saved for ${nicheName(_tplNiche)} ✓` : 'Template saved ✓');
}

// Button state on the Edit Lead modal. Sent is sent - the greyed-out label is
// driven by the lead row, so it survives a refresh and another rep's send.
function renderLeadEmailButtons(l) {
  const info = $('el-send-info'), fup = $('el-send-followup'), note = $('el-email-note');
  if (!info) return;
  const hasEmail = !!(l.email || '').trim();
  const infoSent = !!l.info_sent_at, fupSent = !!l.followup_sent_at, fiveSent = !!l.info_5k_sent_at;

  // One offer per lead: once either has gone, both are greyed out.
  const offerSent = infoSent || fiveSent;
  info.textContent = infoSent ? '2.5K Offer Sent' : 'Send 2.5K Offer';
  info.disabled = offerSent || !hasEmail;
  info.style.opacity = info.disabled ? '.5' : '';
  info.style.cursor = info.disabled ? 'default' : '';
  const five = $('el-send-5k');
  if (five) {
    five.textContent = fiveSent ? '5K Offer Sent' : 'Send 5K Offer';
    five.disabled = offerSent || !hasEmail;
    five.style.opacity = five.disabled ? '.5' : '';
    five.style.cursor = five.disabled ? 'default' : '';
  }

  // Always offered, whether or not the info email went through this dashboard -
  // the ones sent by hand still need following up.
  fup.style.display = '';
  fup.textContent = fupSent ? 'Follow Up Sent' : 'Follow Up';
  fup.disabled = fupSent || !hasEmail;
  fup.style.opacity = fup.disabled ? '.5' : '';
  fup.style.cursor = fup.disabled ? 'default' : '';

  const when = d => new Date(d).toLocaleDateString('en-AU');
  const parts = [];
  if (infoSent) parts.push('2.5K offer sent ' + when(l.info_sent_at));
  if (fiveSent) parts.push('5K offer sent ' + when(l.info_5k_sent_at));
  if (fupSent) parts.push('Follow-up sent ' + when(l.followup_sent_at));
  if (l.no_answer_email_sent_at) parts.push('No-answer email sent ' + when(l.no_answer_email_sent_at));
  note.textContent = !hasEmail ? 'No email address on this lead' : parts.join(' · ');

  const sent = $('el-sent-emails');
  if (sent) {
    sent.textContent = 'Sent emails';
    db.from('sales_email_log').select('id', { count: 'exact', head: true }).eq('lead_id', l.id)
      .then(({ count }) => { if ($('el-id').value === l.id && count != null) sent.textContent = 'Sent emails (' + count + ')'; });
  }
}

const SEND_TITLES = { info: 'Send 2.5K Offer', info_5k: 'Send 5K Offer', followup: 'Send Follow-Up' };
// The draft being sent: the raw template, so it can be re-filled when an admin
// changes who it is sent as, and whether it has been edited since.
let _seDraft = null;

// Who an email goes out as: their name for {rep_name} and the signature, their
// address for {rep_email} and the reply-to. Reps can read their own row.
async function sendAsIdentity(userId, session) {
  let r = _reps.find(x => x.user_id === userId);
  if (!r) {
    const { data } = await db.from('sales_reps').select('user_id,name,email,reply_to_email').eq('user_id', userId).maybeSingle();
    r = data;
  }
  const isMe = userId === session?.user?.id;
  return {
    name:  r?.name || (isMe ? session?.user?.user_metadata?.name : '') || '',
    email: r?.reply_to_email || r?.email || (isMe ? session?.user?.email : '') || '',
  };
}

// The From name: the one in Business Settings with {rep_name} filled in, or
// "{rep_name} at QuoteLeads". With no rep name, just the rest of it.
let _salesFromNameTpl = null;
function fromNameFor(repName) {
  const t = String(_salesFromNameTpl || '').trim() || '{rep_name} at QuoteLeads';
  return repName ? t.replace(/\{rep_name\}/g, repName)
    : (t.replace(/\{rep_name\}\s*(at\s+)?/gi, '').replace(/\s{2,}/g, ' ').replace(/^[\s|,:\-]+/, '').trim() || 'QuoteLeads');
}
function fillSendDraft(identity) {
  _seDraft.identity = identity;
  const { tpl, lead } = _seDraft;
  const vals = {
    first_name:   firstName(lead.name),
    company_name: (lead.company || '').trim(),
    rep_name:     identity.name,
    rep_email:    identity.email,
  };
  setVal('se-replyto', vals.rep_email || '');
  setVal('se-fromname', fromNameFor(identity.name));
  setVal('se-subject', mergeTemplate(tpl.subject, vals));
  setVal('se-body', mergeTemplate(tpl.body, vals));
  _seDraft.edited = false;
}

async function openSendEmail(kind) {
  const id = $('el-id').value;
  const lead = LEAD_CACHE[id];
  if (!lead) { toast('Open the lead again', true); return; }
  if (!(lead.email || '').trim()) { toast('This lead has no email address', true); return; }
  const tpls = await ensureEmailTemplates(); if (!tpls) return;
  const tpl = pickTemplate(tpls, kind, lead.niche);
  if (!tpl) { toast('No ' + kind + ' template saved yet', true); return; }
  // Which version: the lead's niche if it has one of this email, else the
  // default. Any niche with a version of it can be picked instead.
  const lk = nicheKey(lead.niche);
  const withKind = Object.keys(tpls.niches).filter(n => tpls.niches[n][kind]).sort();
  $('se-niche').innerHTML = '<option value="">Default (all niches)</option>'
    + withKind.map(n => `<option value="${esc(n)}">${esc(nicheName(n))}</option>`).join('');
  $('se-niche').value = withKind.includes(lk) ? lk : '';
  if (_salesFromNameTpl === null) {
    const { data: bs } = await db.from('business_settings').select('sales_from_name').limit(1).maybeSingle();
    _salesFromNameTpl = bs?.sales_from_name || '';
  }

  const { data: { session } } = await db.auth.getSession();
  const myId = session?.user?.id;
  // Admins choose who it goes out as, starting with the lead's rep so an
  // assigned lead is never sent under a blank name. A rep is always themselves.
  let sendAs = myId;
  const fromRow = $('se-from-row');
  if (!IS_REP) {
    const reps = _reps.filter(r => r.active !== false);
    if (lead.owner_id && reps.some(r => r.user_id === lead.owner_id)) sendAs = lead.owner_id;
    const sel = $('se-from');
    sel.innerHTML = reps.map(r => `<option value="${esc(r.user_id)}">${esc(r.name || r.email)}</option>`).join('')
      + (reps.some(r => r.user_id === myId) ? '' : `<option value="${esc(myId)}">Me (${esc(session?.user?.email || '')})</option>`);
    sel.value = sendAs;
    fromRow.style.display = '';
  } else {
    fromRow.style.display = 'none';
  }

  _seDraft = { tpl, lead, kind, niche: $('se-niche').value, edited: false };
  fillSendDraft(await sendAsIdentity(sendAs, session));

  setVal('se-lead-id', id);
  setVal('se-kind', kind);
  setVal('se-to', lead.email);
  setText('se-title', SEND_TITLES[kind] || 'Send Email');
  setText('se-sub', (lead.name || '') + (lead.company ? ' · ' + lead.company : ''));
  const btn = $('se-send'); btn.disabled = false; btn.textContent = 'Send email';
  closeModal('m-edit-lead');
  $('m-send-email').classList.add('stacked');
  openModal('m-send-email');
}

async function changeSendAs() {
  if (!_seDraft) return;
  const { data: { session } } = await db.auth.getSession();
  const identity = await sendAsIdentity($('se-from').value, session);
  if (_seDraft.edited) {
    _seDraft.identity = identity;
    setVal('se-replyto', identity.email || '');
    setVal('se-fromname', fromNameFor(identity.name));
    toast('You edited the message, so the signature was left as is. Check it before sending.', true);
    return;
  }
  fillSendDraft(identity);
}
// Another niche's version of the same email. Edits to the draft are lost, so ask.
async function changeSendNiche() {
  if (!_seDraft) return;
  const tpls = await ensureEmailTemplates(); if (!tpls) return;
  const n = $('se-niche').value;
  const tpl = n ? tpls.niches[n]?.[_seDraft.kind] : tpls.base[_seDraft.kind];
  if (!tpl) return;
  if (_seDraft.edited && !confirm('Swap to the ' + (n ? nicheName(n) : 'default') + ' version? Your edits to this draft will be lost.')) {
    $('se-niche').value = _seDraft.niche ?? '';
    return;
  }
  _seDraft.tpl = tpl;
  _seDraft.niche = n;
  fillSendDraft(_seDraft.identity || { name: '', email: '' });
}
// Closing the draft returns you to the lead you opened it from.
function closeSendEmail() {
  const id = $('se-lead-id').value;
  closeModal('m-send-email');
  const l = LEAD_CACHE[id];
  if (l) openEditLead(l);
}

async function sendSalesEmail() {
  const btn = $('se-send');
  const id = $('se-lead-id').value, kind = $('se-kind').value;
  const subject = $('se-subject').value.trim(), body = $('se-body').value.trim();
  if (!subject || !body) { toast('Subject and message are required', true); return; }
  const fromName = $('se-fromname').value.replace(/[<>"]/g, '').trim();
  const replyTo = $('se-replyto').value.trim();
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(replyTo)) { toast('The reply-to address does not look right', true); return; }

  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch(`${_ep}/functions/v1/send-sales-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ lead_id: id, kind, subject, body, from_name: fromName, reply_to: replyTo,
        ...(IS_REP ? {} : { send_as: $('se-from').value }) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { toast(out.error || 'Could not send', true); btn.disabled = false; btn.textContent = 'Send email'; return; }

    // Reflect the send locally so the buttons are right the moment the modal
    // closes, rather than waiting on the reload behind it.
    const l = LEAD_CACHE[id];
    if (l) {
      const at = out.sent_at || now();
      if (kind === 'info') l.info_sent_at = at;
      else if (kind === 'info_5k') l.info_5k_sent_at = at;
      else l.followup_sent_at = at;
      renderLeadEmailButtons(l);
    }
    closeSendEmail();
    toast(({ info: '2.5K offer sent ✓', info_5k: '5K offer sent ✓' })[kind] || 'Follow-up sent ✓');
    loadCRM();
  } catch (e) {
    toast('Could not send: ' + (e.message || e), true);
    btn.disabled = false; btn.textContent = 'Send email';
  }
}

/* ═══ WON LEAD → QUOTELEADSHQ CLIENT ═══
   Creating the account emails the client their password-setup link, so it is
   behind an explicit button and a confirm rather than the stage change: a
   mis-dragged card must not be able to email a customer. The lead carries
   hq_company_id once it is done, which is what stops a second account - not
   the disabled button, which only knows about one browser tab. */
let _hqVas = null;
function renderHqRow() {
  const row = $('el-hq-row'); if (!row) return;
  const l = LEAD_CACHE[$('el-id').value] || {};
  const stage = $('el-stage').value;
  const show = !IS_REP && stage === 'closed_won';
  row.style.display = show ? '' : 'none';
  if (!show) return;

  const created = !!l.hq_company_id;
  const assigned = !!l.hq_va_user_id;
  const btn = $('el-hq-create'), sel = $('el-hq-va'), asg = $('el-hq-assign'), note = $('el-hq-note');

  btn.textContent = created ? 'HQ Account Created' : 'Create HQ account';
  btn.disabled = created || !(l.email || '').trim();
  btn.style.opacity = btn.disabled ? '.5' : '';
  sel.style.display = created ? '' : 'none';
  asg.style.display = created ? '' : 'none';
  if (created) { ensureHqVaOptions(); sel.value = l.hq_va_user_id || ''; }

  const when = d => d ? new Date(d).toLocaleDateString('en-AU') : '';
  note.textContent = !(l.email || '').trim()
    ? 'Add an email address before creating the account'
    : !created
      ? 'Creates their QuoteLeadsHQ login and emails them a password-setup link.'
      : assigned
        ? `Account created ${when(l.hq_account_created_at)} · VA assigned ${when(l.hq_va_assigned_at)}`
        : `Account created ${when(l.hq_account_created_at)} · assign a VA and they get an email to check scope and introduce themselves`;
}

async function callHq(action, payload) {
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(`${_ep}/functions/v1/sync-to-hq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'ql-hq call failed');
  return out;
}

async function ensureHqVaOptions() {
  const sel = $('el-hq-va'); if (!sel) return;
  if (_hqVas) return;
  try {
    const out = await callHq('list_vas', {});
    _hqVas = out.vas || [];
    const cur = sel.value;
    sel.innerHTML = '<option value="">Assign a VA…</option>' +
      _hqVas.map(v => `<option value="${esc(v.id)}">${esc(v.name || v.id)} (${v.assigned})</option>`).join('');
    sel.value = cur;
  } catch (e) { /* leave the picker empty; the note explains the state */ }
}

async function createHqAccount() {
  const id = $('el-id').value, l = LEAD_CACHE[id] || {};
  if (!confirm(`Create a QuoteLeadsHQ account for ${l.name || 'this lead'}?\n\n${l.email} will be emailed a link to set their password.`)) return;
  const btn = $('el-hq-create');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const out = await callHq('create_hq_account', { lead_id: id });
    l.hq_company_id = out.company_id;
    l.hq_account_created_at = now();
    renderHqRow();
    toast(out.existing ? 'Linked to their existing HQ account ✓' : 'HQ account created ✓');
    loadCRM();
  } catch (e) {
    toast(e.message, true);
    renderHqRow();
  }
}

async function assignHqVa() {
  const id = $('el-id').value, vaId = $('el-hq-va').value;
  if (!vaId) { toast('Pick a VA first', true); return; }
  const asg = $('el-hq-assign');
  asg.disabled = true; asg.textContent = 'Assigning...';
  try {
    const out = await callHq('assign_va', { lead_id: id, va_user_id: vaId });
    const l = LEAD_CACHE[id] || {};
    l.hq_va_user_id = vaId; l.hq_va_assigned_at = now();
    toast(out.notified ? 'VA assigned and notified ✓' : 'VA assigned ✓');
  } catch (e) {
    toast(e.message, true);
  }
  asg.disabled = false; asg.textContent = 'Assign';
  renderHqRow();
}

function checkConvertBanner() {
  // Converting a lead spins up a client record - out of scope for reps.
  const stage = $('el-stage').value;
  $('convert-banner').style.display = (!IS_REP && stage === 'closed_won') ? 'block' : 'none';
  renderHqRow();
}
// Stage saves the moment it is picked - the same write dragging the card
// between kanban columns makes, so the two routes behave alike. Everything
// else in this modal still waits for Save changes; only the stage jumps the
// queue, because it is the one field both reps and admins open a lead purely
// to flip, and making them confirm it twice was friction with nothing behind
// it. Nothing the user has typed into the other fields is written here.
let _stageSaving = false;
async function saveStageNow() {
  const sel = $('el-stage'); if (!sel) return;
  const id = $('el-id').value;
  const stage = sel.value;
  const prev = $('el-stage-orig').value;
  if (!id || !stage || stage === prev || _stageSaving) return;

  _stageSaving = true; sel.disabled = true;
  let error;
  if (IS_REP) {
    // Reps write through the guarded RPC - the leads UPDATE policy blocks them
    // outright, exactly as it does on the Save changes path and on drag.
    ({ error } = await db.rpc('rep_update_lead_stage', { p_lead_id: id, p_stage: stage }));
  } else {
    const upd = { stage, updated_at: now() };
    if (['call_back','proposal','closed_won'].includes(stage)) upd.contactable = true;
    if (prev === 'closed_won') upd.lead_type = null;
    ({ error } = await db.from('leads').update(upd).eq('id', id));
  }
  _stageSaving = false; sel.disabled = false;

  if (error) {
    // Put the dropdown back where it was, so it never shows a stage the row
    // does not have.
    sel.value = prev; checkConvertBanner();
    toast('Stage not saved: ' + error.message, true);
    return;
  }
  setVal('el-stage-orig', stage);
  // Mirror the auto-contactable the write just made, so a later Save changes
  // from the still-open modal does not put a stale value back.
  if (['call_back','proposal','closed_won'].includes(stage)) setVal('el-contactable','true');
  // The move can push the follow-up date forward (leads_push_followup: 2 days
  // for Proposal). Show the new date, or Save changes writes the old one back
  // and the lead shows "follow-up due" straight away.
  // Moving out of New Lead also logs a contact (leads_contacted_on_first_move),
  // so pick up the new last-contacted date and count as well.
  const { data: fu } = await db.from('leads').select('next_followup,last_contact,contact_count').eq('id', id).maybeSingle();
  if (fu && $('el-id').value === id) {
    setVal('el-next-followup', fu.next_followup || '');
    const lc = fu.last_contact ? sydneyDate(fu.last_contact) : '';
    setVal('el-last-contact', lc); setVal('el-last-contact-orig', lc);
    setVal('el-contact-count-orig', String(fu.contact_count || 0));
  }
  toast('→ ' + stageLabel(stage));
  loadCRM();
}
function openEditLead(l) {
  setVal('el-id',l.id);setVal('el-name',l.name);setVal('el-company',l.company);
  setVal('el-email',l.email);setVal('el-phone',l.phone);setVal('el-niche',l.niche||'');fillNicheList();
  // Legacy stages (onboarding / proposal_sent) predate the six
  // kanban columns and are still on real rows. Setting a <select> to a value it
  // has no option for leaves it blank, and saving would then write an empty
  // stage - so carry the current value in as an option and let it round-trip.
  const stageSel = $('el-stage');
  if (stageSel) {
    stageSel.querySelectorAll('option[data-legacy]').forEach(o => o.remove());
    if (l.stage && !Array.from(stageSel.options).some(o => o.value === l.stage)) {
      const o = document.createElement('option');
      o.value = l.stage; o.textContent = stageLabel(l.stage); o.dataset.legacy = '1';
      stageSel.appendChild(o);
    }
  }
  setVal('el-stage',l.stage);
  setVal('el-stage-orig',l.stage||'');
  setVal('el-value',l.value);
  setVal('el-source',l.source);setVal('el-notes',l.notes);
  setVal('el-contactable',l.contactable===true?'true':l.contactable===false?'false':'');
  // Sydney date: the UTC one is the day before for any morning contact.
  const lc = l.last_contact ? sydneyDate(l.last_contact) : '';
  setVal('el-last-contact', lc);
  setVal('el-last-contact-orig', lc);
  setVal('el-contact-count-orig', l.contact_count != null ? String(l.contact_count) : '0');
  setVal('el-next-followup', l.next_followup || '');
  setText('edit-lead-sub',(l.name||'')+(l.company?' · '+l.company:''));
  if (!IS_REP) ensureRepOptions().then(() => setVal('el-owner', l.owner_id || ''));
  // Reps view lead details read-only apart from Stage, which they may change
  // here as well as by dragging the card (drag needs a mouse - on a phone the
  // modal is the only way).
  ['el-name','el-company','el-email','el-phone','el-source','el-notes','el-contactable','el-last-contact','el-next-followup'].forEach(id => {
    const e = $(id); if (e) e.disabled = IS_REP;
  });
  const saveBtn = $('el-save');
  // Reps only have the stage to change and it has already saved itself by the
  // time they reach the button, so it closes rather than promising a save.
  if (saveBtn) saveBtn.textContent = IS_REP ? 'Done' : 'Save changes';
  checkConvertBanner();
  renderHqRow();
  renderLeadEmailButtons(l);
  openModal('m-edit-lead');
}

// Fill the Edit-Lead owner dropdown with the current sales reps (admin only).
async function ensureRepOptions() {
  if (IS_REP) return;
  const sel = $('el-owner'); if (!sel) return;
  if (!_reps.length) {
    try { const r = await callRepEdge('list_reps'); _reps = r.reps || []; } catch (e) { /* leave unassigned-only */ }
  }
  const cur = sel.value;
  sel.innerHTML = '<option value="">- Unassigned</option>' +
    _reps.map(r => `<option value="${r.user_id}">${esc(r.name || r.email)}${r.active ? '' : ' (inactive)'}</option>`).join('');
  sel.value = cur;
}
// Ticks off a "follow-up due" flag: logs the contact and clears the follow-up
// date (mark_followup_done), so the card's flag goes. Reps can do their own.
async function markFollowupDone(e,id) {
  e.stopPropagation();
  const {error}=await db.rpc('mark_followup_done',{p_lead:id});
  if (error) { toast('Error: '+error.message,true); return; }
  toast('Follow-up done ✓');
  loadCRM();
}
async function toggleContactable(e,id,value) {
  e.stopPropagation();
  if (IS_REP) return;   // reps are view-only
  const {error}=await db.from('leads').update({contactable:value,updated_at:now()}).eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  loadCRM();
}
async function convertLead(targetType) {
  const id = $('el-id').value;
  const name = $('el-name').value.trim();
  const company = $('el-company').value.trim();
  const email = $('el-email').value.trim();
  const phone = $('el-phone').value.trim();
  const value = parseFloat($('el-value').value) || 0;
  await db.from('leads').update({stage:'closed_won',lead_type:targetType,updated_at:now()}).eq('id',id);
  let clientData;
  if (targetType === 'ppl') {
    clientData = {type:'ppl',company_name:company||name,contact_name:name,email,phone,lead_price:0,stage:'active_client',created_at:now()};
  } else {
    // management_fee is the monthly retainer and drives MRR, so it starts at 0
    // and is set on the client once the real recurring figure is agreed. The
    // build fee below is a one-off and belongs in the order log instead.
    clientData = {type:'managed',company_name:company||name,contact_name:name,email,phone,management_fee:0,stage:'active',created_at:now()};
  }
  // The new client's id comes back so the build fee can be logged against it.
  const {data: created, error} = await db.from('clients').insert([clientData]).select('id').single();
  if (error) { toast('Client creation failed: '+error.message, true); return; }

  // The build fee is a one-off, so it is logged as a custom order rather than
  // left sitting in the lead record where nothing bills from it. It is NOT
  // written to management_fee: that field is the monthly retainer and feeds
  // MRR, so a one-off charge landing there would count itself as recurring
  // revenue every month forever, on top of this order.
  let feeLogged = false;
  if (targetType === 'managed' && value > 0 && created?.id) {
    const {error: ordErr} = await db.from('managed_order_log').insert([{
      client_id: created.id,
      description: 'Build Fee',
      amount: value,
      order_date: localDateStr(),
      created_at: now(),
    }]);
    // Best effort: the client exists either way, and failing the whole
    // conversion over the log line would leave a half-converted lead behind.
    if (ordErr) toast('Client created, but the build fee did not log: '+ordErr.message, true);
    else feeLogged = true;
  }

  closeModal('m-edit-lead');
  toast(targetType === 'ppl'
    ? '✓ Moved to PPL Clients'
    : `✓ Moved to Managed Ads${feeLogged ? ` - ${fmt(value)} build fee logged` : ''}`);
  loadCRM();
  if (targetType==='ppl') loadPPL(); else loadManaged();
  setTimeout(() => {
    const target = targetType === 'ppl' ? 'ppl' : 'managed';
    const btn = document.querySelector(`[data-panel="${target}"]`);
    nav(target, btn);
  }, 800);
}
async function updateLead() {
  const id=$('el-id').value;
  const stage=$('el-stage').value;
  if (IS_REP) {
    // Stage and nothing else, and the dropdown saves on change, so there is
    // usually nothing left to write by the time the button is pressed.
    if (stage === $('el-stage-orig').value) { closeModal('m-edit-lead'); return; }
    // Enforced server-side, not here: the leads UPDATE policy blocks reps
    // outright, so this guarded RPC is the only write they can make - it
    // re-checks that the caller is a rep who owns the lead.
    const {error}=await db.rpc('rep_update_lead_stage',{p_lead_id:id,p_stage:stage});
    if (error) { toast('Error: '+error.message,true); return; }
    closeModal('m-edit-lead'); loadCRM(); toast('→ '+stageLabel(stage));
    return;
  }
  const cRaw=$('el-contactable').value;
  const autoContactable=['call_back','proposal','closed_won'].includes(stage);
  const contactable=autoContactable?true:cRaw==='true'?true:cRaw==='false'?false:null;
  const newLastContact = $('el-last-contact').value || null;
  const origLastContact = $('el-last-contact-orig').value || null;
  const origCount = parseInt($('el-contact-count-orig').value||'0', 10) || 0;
  const contactIncrement = (newLastContact && (!origLastContact || newLastContact > origLastContact)) ? 1 : 0;
  // Last Contacted is written only when it was changed, so Save never
  // rewrites a stored time as midnight. Today means now; another day, midday.
  const lastContactPatch = newLastContact === origLastContact ? {} : {
    last_contact: !newLastContact ? null
      : newLastContact === sydneyToday() ? new Date().toISOString()
      : newLastContact + 'T12:00:00+10:00' };
  const d={name:$('el-name').value.trim(),company:$('el-company').value.trim(),niche:$('el-niche').value.trim(),email:$('el-email').value.trim(),phone:$('el-phone').value.trim(),stage,value:parseFloat($('el-value').value)||null,source:$('el-source').value,notes:$('el-notes').value.trim(),contactable,...lastContactPatch,next_followup:$('el-next-followup').value||null,contact_count:origCount+contactIncrement,updated_at:now()};
  // Only full users can (re)assign a lead's owner; reps can't touch it.
  if (!IS_REP) d.owner_id = $('el-owner').value || null;
  if (!d.name) { toast('Name required',true); return; }
  const {error}=await db.from('leads').update(d).eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  closeModal('m-edit-lead'); loadCRM(); toast('Lead updated ✓');
}
async function deleteLead() {
  if (!confirm('Delete this lead?')) return;
  const {error}=await db.from('leads').delete().eq('id',$('el-id').value);
  if (error) { toast('Error: '+error.message,true); return; }
  closeModal('m-edit-lead'); loadCRM(); toast('Lead deleted');
}
async function saveLead() {
  const name=$('l-name').value.trim();
  if (!name) { toast('Contact name required',true); return; }
  const {data,error}=await db.rpc('add_lead',{
    p_name:name,
    p_company:$('l-company').value.trim()||null,
    p_email:$('l-email').value.trim()||null,
    p_phone:$('l-phone').value.trim()||null,
    p_stage:$('l-stage').value,
    p_lead_type:'managed',
    p_value:parseFloat($('l-value').value)||null,
    p_source:$('l-source').value||null,
    p_notes:$('l-notes').value.trim()||null,
  });
  if (error) { toast('DB error: '+error.message,true); return; }
  if (data?.duplicate) { toast('A lead with that name and contact already exists',true); return; }
  ['l-name','l-company','l-email','l-phone','l-value','l-notes'].forEach(id=>{$(id).value='';});
  setVal('l-stage','new_lead');
  closeModal('m-lead'); loadCRM(); toast('Lead saved ✓');
}
