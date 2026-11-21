'use strict';

// ── Calendar: booked sales calls ────────────────────────────────────────────
// A week / day / month calendar of sales_calls, and the "Book the call" window
// that opens when a lead is dragged into Booked on the Sales Pipeline (and from
// any empty slot or a lead's card here).
//
// Times are shown in this browser's own timezone, like Google Calendar. The
// window also says what the time is for the prospect, from their state, which
// is the zone call-reminders writes their reminders in.
//
// Reminders are settings on the call (remind_us / remind_prospect); the
// database turns them into the reminders that go out and moves them whenever
// the call moves, so dragging a call to a new slot is all a reschedule needs.

const CAL_HOUR_PX = 48;                 // one hour in the week and day views
const CAL_SNAP_MIN = 15;
const CAL_STATE_TZ = { NSW:'Australia/Sydney', ACT:'Australia/Sydney', VIC:'Australia/Melbourne', TAS:'Australia/Hobart',
  QLD:'Australia/Brisbane', SA:'Australia/Adelaide', NT:'Australia/Darwin', WA:'Australia/Perth' };
const CAL_STATUS = { scheduled:'Booked', done:'Done', no_show:'No-show', cancelled:'Cancelled' };
const CAL_US_TIMES = [[1440,'1 day before'],[60,'1 hour before'],[15,'15 min before']];
const CAL_PROSPECT_TIMES = [[1440,'1 day before'],[120,'2 hours before'],[60,'1 hour before']];
const CAL_DEFAULT_US = { email:true, sms:false, minutes:[15] };
const CAL_DEFAULT_PROSPECT = { email:true, sms:true, minutes:[1440,60] };
const CAL_COLOURS = ['#4f8fff','#2ecc8a','#f5a623','#b47cff','#ff6b8b','#20c4c4','#e07a3f','#8fa3ff'];

let _cal = { view: (window.innerWidth < 760 ? 'day' : 'week'), anchor:new Date(), calls:[], showCancelled:false };
let CALL_BY_LEAD = {};                  // lead id -> its next scheduled call, for pipeline cards
let _calEdit = null;                    // the call or new booking in the window
let _calLeads = null;                   // leads for the window's picker

// ── Dates ──
const calDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const calAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const calWeekStart = d => { const x = calDay(d); const wd = (x.getDay() + 6) % 7; return calAddDays(x, -wd); }; // Monday
const calSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const calTime = d => d.toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true }).replace(/\s/g,'').replace(':00','').toLowerCase();
const calYmd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const calHm = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
const calColour = uid => { if (!uid) return 'var(--ink3)'; let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CAL_COLOURS[h % CAL_COLOURS.length]; };
const calWho = uid => (uid && typeof repName === 'function' && repName(uid)) || (currentUser && uid === currentUser.id ? 'Me' : (uid ? 'Owner' : 'Unassigned'));

function calRange() {
  const a = _cal.anchor;
  if (_cal.view === 'day') return [calDay(a), calAddDays(calDay(a), 1)];
  if (_cal.view === 'week') { const s = calWeekStart(a); return [s, calAddDays(s, 7)]; }
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const s = calWeekStart(first);
  return [s, calAddDays(s, 42)];
}

// ── Loading ──
async function loadCalendar() {
  if (!IS_REP && typeof _reps !== 'undefined' && !_reps.length && typeof ensureRepOptions === 'function') await ensureRepOptions().catch(() => {});
  const [from, to] = calRange();
  let q = db.from('sales_calls')
    .select('*, leads(id,name,company,phone,email,state,stage,owner_id,sms_opted_out)')
    .gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).order('starts_at');
  if (!_cal.showCancelled) q = q.neq('status', 'cancelled');
  const { data, error } = await q;
  if (error) { $('cal-body').innerHTML = `<div class="empty">Could not load calls: ${esc(error.message)}</div>`; return; }
  _cal.calls = data || [];
  renderCalendar();
}

// The next booked call for each lead, for the cards in Booked.
async function loadCallBadges() {
  const since = new Date(Date.now() - 12 * 3600e3).toISOString();
  const { data } = await db.from('sales_calls').select('id,lead_id,starts_at')
    .eq('status', 'scheduled').gte('starts_at', since).order('starts_at');
  CALL_BY_LEAD = {};
  (data || []).forEach(c => { if (!CALL_BY_LEAD[c.lead_id]) CALL_BY_LEAD[c.lead_id] = c; });
}

function callBadge(l) {
  const c = CALL_BY_LEAD[l.id];
  if (!c) return l.stage === 'call_back'
    ? `<button class="kcard-call none" onclick="event.stopPropagation();openBookCall({leadId:'${esc(String(l.id))}'})">No time booked · Book</button>` : '';
  const d = new Date(c.starts_at);
  const day = calSameDay(d, new Date()) ? 'Today' : calSameDay(d, calAddDays(new Date(), 1)) ? 'Tomorrow'
    : d.toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' });
  return `<button class="kcard-call" onclick="event.stopPropagation();openCallById('${esc(c.id)}')">Call ${esc(day)} ${esc(calTime(d))}</button>`;
}

// ── Toolbar ──
function calSetView(v) { _cal.view = v; loadCalendar(); }
function calToday() { _cal.anchor = new Date(); loadCalendar(); }
function calStep(n) {
  const a = new Date(_cal.anchor);
  if (_cal.view === 'day') a.setDate(a.getDate() + n);
  else if (_cal.view === 'week') a.setDate(a.getDate() + 7 * n);
  else { a.setDate(1); a.setMonth(a.getMonth() + n); }
  _cal.anchor = a; loadCalendar();
}
function calToggleCancelled(on) { _cal.showCancelled = on; loadCalendar(); }

function calTitle() {
  const [s, e] = calRange();
  if (_cal.view === 'day') return _cal.anchor.toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  if (_cal.view === 'month') return _cal.anchor.toLocaleDateString('en-AU', { month:'long', year:'numeric' });
  const last = calAddDays(e, -1);
  const same = s.getMonth() === last.getMonth();
  return `${s.toLocaleDateString('en-AU', { day:'numeric', ...(same ? {} : { month:'short' }) })} – ${last.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' })}`;
}

function renderCalendar() {
  setText('cal-title', calTitle());
  document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.toggle('active', b.dataset.v === _cal.view));
  const up = _cal.calls.filter(c => c.status === 'scheduled' && new Date(c.starts_at) >= new Date());
  setText('cal-sub', up.length ? `${up.length} upcoming call${up.length === 1 ? '' : 's'} in view` : 'No upcoming calls in view');
  if (_cal.view === 'month') renderCalMonth(); else renderCalGrid();
}

// ── Week and day ──
function calLayout(dayCalls) {
  // Overlapping calls sit side by side, Google style: each cluster of
  // overlaps shares the width equally.
  const items = dayCalls.map(c => { const s = new Date(c.starts_at); return { c, s: s.getTime(), e: s.getTime() + (c.duration_min || 30) * 60e3 }; })
    .sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = 0;
  const flush = () => { const cols = []; cluster.forEach(it => { let i = cols.findIndex(end => end <= it.s); if (i < 0) { i = cols.length; cols.push(0); } cols[i] = it.e; it.col = i; }); cluster.forEach(it => it.cols = cols.length); cluster = []; };
  items.forEach(it => { if (cluster.length && it.s >= clusterEnd) flush(); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e); });
  flush();
  return items;
}

function renderCalGrid() {
  const [start] = calRange();
  const days = _cal.view === 'day' ? 1 : 7;
  const today = new Date();
  const head = Array.from({ length: days }, (_, i) => {
    const d = calAddDays(start, i);
    return `<div class="cal-dh${calSameDay(d, today) ? ' today' : ''}" onclick="_cal.anchor=new Date(${d.getTime()});calSetView('day')">
      <span>${d.toLocaleDateString('en-AU', { weekday:'short' })}</span><b>${d.getDate()}</b></div>`;
  }).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="cal-hr"><span>${h === 0 ? '' : calTime(new Date(2000,0,1,h))}</span></div>`).join('');
  const cols = Array.from({ length: days }, (_, i) => {
    const d = calAddDays(start, i);
    const dayCalls = _cal.calls.filter(c => calSameDay(new Date(c.starts_at), d));
    const evs = calLayout(dayCalls).map(({ c, s, e, col, cols }) => {
      const sd = new Date(s);
      const top = (sd.getHours() + sd.getMinutes() / 60) * CAL_HOUR_PX;
      const h = Math.max(((e - s) / 3600e3) * CAL_HOUR_PX - 2, 18);
      const lead = c.leads || {};
      return `<div class="cal-ev st-${esc(c.status)}" draggable="${c.status === 'scheduled'}" data-call="${esc(c.id)}"
        style="top:${top}px;height:${h}px;left:calc(${(col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px);--ev:${calColour(c.owner_id)}"
        onclick="event.stopPropagation();openCallById('${esc(c.id)}')" title="${esc(`${lead.name || ''} ${lead.company ? '· ' + lead.company : ''}`)}">
        ${h > 34 ? `<b>${esc(lead.name || 'Lead')}</b><span>${esc(calTime(sd))}${lead.company ? ' · ' + esc(lead.company) : ''}</span>`
          : `<b>${esc(lead.name || 'Lead')}<em>, ${esc(calTime(sd))}</em></b>`}</div>`;
    }).join('');
    const now = calSameDay(d, today) ? `<div class="cal-now" style="top:${(today.getHours() + today.getMinutes() / 60) * CAL_HOUR_PX}px"></div>` : '';
    return `<div class="cal-col" data-day="${d.getTime()}" ondragover="calDragOver(event)" ondrop="calDrop(event)" onclick="calSlotClick(event)">${evs}${now}</div>`;
  }).join('');

  const body = $('cal-body');
  const keep = body.querySelector('.cal-scroll')?.scrollTop;
  body.innerHTML = `<div class="cal-grid" style="--days:${days}">
      <div class="cal-head"><div class="cal-gutter"></div>${head}</div>
      <div class="cal-scroll"><div class="cal-rows" style="height:${24 * CAL_HOUR_PX}px"><div class="cal-hours">${hours}</div>${cols}</div></div>
    </div>`;
  const sc = body.querySelector('.cal-scroll');
  sc.scrollTop = keep != null ? keep : 7 * CAL_HOUR_PX;   // the working day in view
  body.querySelectorAll('.cal-ev[draggable="true"]').forEach(el => el.addEventListener('dragstart', ev => {
    ev.dataTransfer.setData('text/plain', el.dataset.call);
    ev.dataTransfer.effectAllowed = 'move';
    _cal.dragOffset = ev.clientY - el.getBoundingClientRect().top;
  }));
}

function calPointTime(ev, col, offset = 0) {
  const y = ev.clientY - col.getBoundingClientRect().top - offset;
  const mins = Math.max(0, Math.min(24 * 60 - CAL_SNAP_MIN, Math.round((y / CAL_HOUR_PX) * 60 / CAL_SNAP_MIN) * CAL_SNAP_MIN));
  const d = new Date(Number(col.dataset.day)); d.setMinutes(mins);
  return d;
}
function calDragOver(ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; }
async function calDrop(ev) {
  ev.preventDefault();
  const id = ev.dataTransfer.getData('text/plain');
  const c = _cal.calls.find(x => x.id === id);
  if (!c) return;
  const at = calPointTime(ev, ev.currentTarget, _cal.dragOffset || 0);
  if (at.getTime() === new Date(c.starts_at).getTime()) return;
  const { error } = await db.from('sales_calls').update({ starts_at: at.toISOString() }).eq('id', id);
  if (error) { toast('Could not move it: ' + error.message, true); return; }
  toast(`Moved to ${at.toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' })} ${calTime(at)}. Reminders moved with it.`);
  loadCalendar();
}
function calSlotClick(ev) {
  if (ev.target.closest('.cal-ev')) return;
  const at = calPointTime(ev, ev.currentTarget);
  at.setMinutes(Math.floor(at.getMinutes() / 30) * 30);
  openBookCall({ start: at });
}

// ── Month ──
function renderCalMonth() {
  const [start] = calRange();
  const month = _cal.anchor.getMonth(), today = new Date();
  const names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(n => `<div class="cal-mh">${n}</div>`).join('');
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = calAddDays(start, i);
    const dayCalls = _cal.calls.filter(c => calSameDay(new Date(c.starts_at), d));
    const shown = dayCalls.slice(0, 3).map(c => `<div class="cal-mev st-${esc(c.status)}" style="--ev:${calColour(c.owner_id)}" onclick="event.stopPropagation();openCallById('${esc(c.id)}')">
        <i></i>${esc(calTime(new Date(c.starts_at)))} ${esc((c.leads && c.leads.name) || 'Lead')}</div>`).join('');
    const more = dayCalls.length > 3 ? `<div class="cal-more">+${dayCalls.length - 3} more</div>` : '';
    return `<div class="cal-mc${d.getMonth() !== month ? ' out' : ''}${calSameDay(d, today) ? ' today' : ''}" onclick="_cal.anchor=new Date(${d.getTime()});calSetView('day')">
      <div class="cal-md">${d.getDate()}</div>${shown}${more}</div>`;
  }).join('');
  $('cal-body').innerHTML = `<div class="cal-month">${names}${cells}</div>`;
}

// ── The booking window ──
function calEnsureModal() {
  if ($('m-call')) return;
  const chips = (group, list) => list.map(([m, label]) => `<label class="cal-chip"><input type="checkbox" data-rem="${group}" value="${m}"><span>${label}</span></label>`).join('');
  document.body.insertAdjacentHTML('beforeend', `
<div class="overlay" id="m-call">
  <div class="modal" style="max-width:520px">
    <h2 id="mc-title">Book the call</h2><div class="msub" id="mc-sub"></div>
    <div class="frow" id="mc-lead-row"><label class="flabel">Lead</label>
      <input class="fi" id="mc-lead-q" placeholder="Search name, company or phone" oninput="calLeadSearch(this.value)" autocomplete="off">
      <div id="mc-lead-list" class="cal-lead-list"></div></div>
    <div class="g2" style="display:grid;grid-template-columns:1fr 1fr 110px;gap:10px">
      <div class="frow"><label class="flabel">Day</label><input class="fi" id="mc-date" type="date" onchange="calWhenHint()"></div>
      <div class="frow"><label class="flabel">Time</label><input class="fi" id="mc-time" type="time" step="900" onchange="calWhenHint()"></div>
      <div class="frow"><label class="flabel">Length</label><select class="fs" id="mc-dur">
        <option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">1.5 hours</option></select></div>
    </div>
    <div id="mc-when" class="cal-hint"></div>
    <div class="frow admin-only-field" id="mc-owner-row"><label class="flabel">Who's taking the call</label><select class="fs" id="mc-owner"></select></div>
    <div class="frow"><label class="flabel">Notes <span style="font-weight:400;color:var(--ink3)">(optional)</span></label>
      <textarea class="fta" id="mc-notes" rows="2" placeholder="e.g. Wants to talk about batteries. Spouse on the call."></textarea></div>

    <div class="cal-rem">
      <label class="cal-rem-h"><input type="checkbox" id="mc-us-on" onchange="calRemToggle()"> Remind us</label>
      <div class="cal-rem-b" id="mc-us-b">
        <div class="cal-rem-ch"><label><input type="checkbox" id="mc-us-email"> Email <span id="mc-us-email-to"></span></label>
          <label><input type="checkbox" id="mc-us-sms"> Text the business mobile</label></div>
        <div class="cal-chips">${chips('us', CAL_US_TIMES)}</div>
      </div>
    </div>
    <div class="cal-rem">
      <label class="cal-rem-h"><input type="checkbox" id="mc-pr-on" onchange="calRemToggle()"> Remind the prospect</label>
      <div class="cal-rem-b" id="mc-pr-b">
        <div class="cal-rem-ch"><label><input type="checkbox" id="mc-pr-email"> Email <span id="mc-pr-email-to"></span></label>
          <label><input type="checkbox" id="mc-pr-sms"> Text <span id="mc-pr-sms-to"></span></label></div>
        <div class="cal-chips">${chips('prospect', CAL_PROSPECT_TIMES)}</div>
        <div class="cal-hint" style="margin-top:6px">In their own time, from their state. A reminder whose time has already passed is skipped.</div>
      </div>
    </div>

    <div id="mc-status-row" class="cal-status-row"></div>
    <div class="macts">
      <button class="btn" id="mc-cancel" onclick="calCloseBooking()">Cancel</button>
      <button class="btn btn-p" id="mc-save" onclick="calSaveBooking()">Book call</button>
    </div>
  </div>
</div>`);
}

async function calLoadLeads() {
  if (_calLeads) return _calLeads;
  const { data } = await db.from('leads').select('id,name,company,phone,email,state,stage,owner_id,sms_opted_out')
    .not('stage', 'in', '(closed_won,closed_lost)').order('created_at', { ascending:false }).limit(1000);
  _calLeads = data || [];
  return _calLeads;
}
function calLeadSearch(q) {
  const box = $('mc-lead-list');
  const s = q.trim().toLowerCase(), digits = s.replace(/\D/g, '');
  if (!s) { box.innerHTML = ''; return; }
  const hits = (_calLeads || []).filter(l => `${l.name || ''} ${l.company || ''}`.toLowerCase().includes(s)
    || (digits.length > 3 && String(l.phone || '').replace(/\D/g, '').includes(digits))).slice(0, 8);
  box.innerHTML = hits.length ? hits.map(l => `<button type="button" onclick="calPickLead('${esc(l.id)}')"><b>${esc(l.name || '-')}</b> <span>${esc(l.company || '')}${l.stage ? ' · ' + esc(stageLabel(l.stage)) : ''}</span></button>`).join('')
    : '<div class="cal-hint" style="padding:6px 2px">No open lead matches.</div>';
}
function calPickLead(id) {
  const l = (_calLeads || []).find(x => x.id === id) || LEAD_CACHE[id];
  if (!l) return;
  _calEdit.lead = l; _calEdit.lead_id = l.id;
  if (!IS_REP && l.owner_id && !_calEdit.id) $('mc-owner').value = l.owner_id;
  $('mc-lead-list').innerHTML = '';
  $('mc-lead-q').value = `${l.name || ''}${l.company ? ' · ' + l.company : ''}`;
  calFillLeadBits();
}

function calFillLeadBits() {
  const l = _calEdit.lead || {};
  setText('mc-sub', l.name ? `${l.name}${l.company ? ' · ' + l.company : ''}${l.phone ? ' · ' + l.phone : ''}` : 'Pick the lead and a time');
  setText('mc-pr-email-to', l.email ? `(${l.email})` : '(no email on file)');
  setText('mc-pr-sms-to', l.sms_opted_out ? '(opted out of texts)' : l.phone ? `(${l.phone})` : '(no phone on file)');
  $('mc-pr-email').disabled = !l.email;
  $('mc-pr-sms').disabled = !l.phone || !!l.sms_opted_out;
  if (!l.email) $('mc-pr-email').checked = false;
  if (!l.phone || l.sms_opted_out) $('mc-pr-sms').checked = false;
  calWhenHint();
}

function calRemToggle() {
  $('mc-us-b').classList.toggle('off', !$('mc-us-on').checked);
  $('mc-pr-b').classList.toggle('off', !$('mc-pr-on').checked);
}

function calWhenHint() {
  const el = $('mc-when'); if (!el) return;
  const at = calReadWhen();
  const l = (_calEdit && _calEdit.lead) || {};
  if (!at) { el.textContent = ''; return; }
  const tz = CAL_STATE_TZ[String(l.state || '').toUpperCase()];
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const theirs = tz ? at.toLocaleString('en-AU', { timeZone: tz, weekday:'short', hour:'numeric', minute:'2-digit', hour12:true }).replace(/\s(?=[ap]m)/i, '').replace(/[AP]M$/, m => m.toLowerCase()) : '';
  const past = at < new Date();
  el.innerHTML = (past ? '<span style="color:var(--amb)">That time has passed. </span>' : '')
    + (tz && tz !== mine ? `That's <b>${esc(theirs)}</b> for them in ${esc(l.state)}.` : '');
}

function calReadWhen() {
  const d = $('mc-date').value, t = $('mc-time').value;
  if (!d || !t) return null;
  const at = new Date(`${d}T${t}`);
  return isNaN(at) ? null : at;
}

function calSetRem(prefix, group, cfg, on) {
  $(`mc-${prefix}-on`).checked = on;
  $(`mc-${prefix}-email`).checked = !!cfg.email;
  $(`mc-${prefix}-sms`).checked = !!cfg.sms;
  document.querySelectorAll(`[data-rem="${group}"]`).forEach(cb => cb.checked = (cfg.minutes || []).includes(Number(cb.value)));
}
function calGetRem(prefix, group) {
  if (!$(`mc-${prefix}-on`).checked) return {};
  const minutes = [...document.querySelectorAll(`[data-rem="${group}"]:checked`)].map(cb => Number(cb.value));
  const smsEl = $(`mc-${prefix}-sms`);
  const smsShown = smsEl.closest('label').style.display !== 'none';
  const out = { email: $(`mc-${prefix}-email`).checked && !$(`mc-${prefix}-email`).disabled, sms: smsShown && smsEl.checked && !smsEl.disabled, minutes };
  return (out.email || out.sms) && minutes.length ? out : {};
}
const calRemOn = r => !!(r && (r.email || r.sms) && (r.minutes || []).length);

/**
 * Open the window. opts: { leadId } to book for a lead, { start } for an empty
 * slot, { call } to edit one, fromDrag when it opened because a card was just
 * dropped into Booked (then "Cancel" reads "Not now": the lead stays in Booked).
 */
async function openBookCall(opts = {}) {
  calEnsureModal();
  await calLoadLeads();
  const call = opts.call || null;
  let lead = call ? call.leads : null;
  if (!lead && opts.leadId) lead = LEAD_CACHE[opts.leadId] || _calLeads.find(l => l.id === opts.leadId) || null;
  if (!lead && opts.leadId) { const { data } = await db.from('leads').select('id,name,company,phone,email,state,stage,owner_id,sms_opted_out').eq('id', opts.leadId).maybeSingle(); lead = data; }
  _calEdit = { id: call ? call.id : null, lead_id: lead ? lead.id : null, lead, fromDrag: !!opts.fromDrag, status: call ? call.status : 'scheduled' };

  setText('mc-title', call ? 'Booked call' : 'Book the call');
  $('mc-lead-row').style.display = lead ? 'none' : '';
  $('mc-lead-q').value = ''; $('mc-lead-list').innerHTML = '';

  // When: the call's time, the slot clicked, else the next half hour.
  let at = call ? new Date(call.starts_at) : opts.start ? new Date(opts.start) : null;
  if (!at) { at = new Date(); at.setMinutes(at.getMinutes() < 30 ? 30 : 60, 0, 0); }
  $('mc-date').value = calYmd(at); $('mc-time').value = calHm(at);
  $('mc-dur').value = String(call ? call.duration_min : 30);
  $('mc-notes').value = call ? (call.notes || '') : '';

  // Who takes it: a rep books their own; the owner can pick anyone.
  const owner = $('mc-owner');
  const reps = (typeof _reps !== 'undefined' ? _reps : []).filter(r => r.active !== false);
  owner.innerHTML = `<option value="${esc(currentUser.id)}">Me</option>` + reps.filter(r => r.user_id !== currentUser.id)
    .map(r => `<option value="${esc(r.user_id)}">${esc(r.name || r.email)}</option>`).join('');
  owner.value = (call && call.owner_id) || (lead && lead.owner_id) || currentUser.id;
  if (!owner.value) owner.value = currentUser.id;
  const usTo = IS_REP ? 'you' : (repName(owner.value) || 'you');
  setText('mc-us-email-to', `(${usTo})`);
  owner.onchange = () => setText('mc-us-email-to', `(${repName(owner.value) || 'you'})`);

  // A rep always takes their own calls, and the business mobile is the owner's.
  $('mc-owner-row').style.display = IS_REP ? 'none' : '';
  $('mc-us-sms').closest('label').style.display = IS_REP ? 'none' : '';
  calSetRem('us', 'us', call ? call.remind_us : CAL_DEFAULT_US, call ? calRemOn(call.remind_us) : true);
  calSetRem('pr', 'prospect', call ? call.remind_prospect : CAL_DEFAULT_PROSPECT, call ? calRemOn(call.remind_prospect) : true);
  calRemToggle();
  calFillLeadBits();

  // Status buttons for an existing call.
  $('mc-status-row').innerHTML = call ? `
    <span class="cal-hint">Status: <b>${esc(CAL_STATUS[call.status] || call.status)}</b></span>
    ${call.status !== 'done' ? `<button class="btn btn-xs" onclick="calSetStatus('done')">Mark done</button>` : ''}
    ${call.status !== 'no_show' ? `<button class="btn btn-xs" onclick="calSetStatus('no_show')">No-show</button>` : ''}
    ${call.status !== 'cancelled' ? `<button class="btn btn-xs btn-red" onclick="calSetStatus('cancelled')">Cancel call</button>` : `<button class="btn btn-xs" onclick="calSetStatus('scheduled')">Restore</button>`}
    ${lead ? `<button class="btn btn-xs" onclick="calOpenLead()">Open lead</button>` : ''}` : '';
  setText('mc-cancel', opts.fromDrag ? 'Not now' : call ? 'Close' : 'Cancel');
  setText('mc-save', call ? 'Save changes' : 'Book call');
  openModal('m-call');
}

async function openCallById(id) {
  let c = _cal.calls.find(x => x.id === id);
  if (!c) {
    const { data, error } = await db.from('sales_calls')
      .select('*, leads(id,name,company,phone,email,state,stage,owner_id,sms_opted_out)').eq('id', id).maybeSingle();
    if (error || !data) { toast('Could not open that call', true); return; }
    c = data;
  }
  openBookCall({ call: c });
}

function calCloseBooking() {
  closeModal('m-call');
  if (_calEdit && _calEdit.fromDrag && !_calEdit.id) toast('Left in Booked with no time. Book it from the card when you know.');
  _calEdit = null;
}

async function calSaveBooking() {
  const e = _calEdit; if (!e) return;
  if (!e.lead_id) { toast('Pick the lead first', true); return; }
  const at = calReadWhen();
  if (!at) { toast('Pick a day and a time', true); return; }
  if (!e.id && at < new Date(Date.now() - 5 * 60e3) && !confirm('That time has already passed. Book it anyway?')) return;
  const row = {
    lead_id: e.lead_id,
    owner_id: IS_REP ? currentUser.id : ($('mc-owner').value || currentUser.id),
    starts_at: at.toISOString(),
    duration_min: Number($('mc-dur').value) || 30,
    notes: $('mc-notes').value.trim() || null,
    remind_us: calGetRem('us', 'us'),
    remind_prospect: calGetRem('pr', 'prospect'),
  };
  const btn = $('mc-save'); btn.disabled = true;
  const { error } = e.id
    ? await db.from('sales_calls').update(row).eq('id', e.id)
    : await db.from('sales_calls').insert([{ ...row, status: 'scheduled' }]);
  btn.disabled = false;
  if (error) { toast('Could not save: ' + error.message, true); return; }
  // A call booked for a lead that isn't in Booked yet moves it there.
  const lead = e.lead || {};
  if (!e.id && lead.stage && !['call_back','proposal','closed_won','closed_lost'].includes(lead.stage)) {
    if (IS_REP) await db.rpc('rep_update_lead_stage', { p_lead_id: e.lead_id, p_stage: 'call_back' });
    else await db.from('leads').update({ stage: 'call_back', contactable: true, updated_at: now() }).eq('id', e.lead_id);
  }
  const rem = [calRemOn(row.remind_us) ? 'us' : '', calRemOn(row.remind_prospect) ? 'the prospect' : ''].filter(Boolean);
  toast(`${e.id ? 'Call updated' : 'Call booked'} for ${at.toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' })} ${calTime(at)}${rem.length ? `. Reminders for ${rem.join(' and ')}.` : '. No reminders.'}`);
  closeModal('m-call'); _calEdit = null; _calLeads = null;
  calAfterChange();
}

async function calSetStatus(status) {
  const e = _calEdit; if (!e || !e.id) return;
  if (status === 'cancelled' && !confirm('Cancel this call? Any reminders not yet sent are cancelled too.')) return;
  const { error } = await db.from('sales_calls').update({ status }).eq('id', e.id);
  if (error) { toast('Could not update: ' + error.message, true); return; }
  toast({ done:'Marked done', no_show:'Marked no-show', cancelled:'Call cancelled', scheduled:'Call restored' }[status]);
  closeModal('m-call'); _calEdit = null;
  calAfterChange();
}

function calOpenLead() {
  const id = _calEdit && _calEdit.lead_id;
  closeModal('m-call'); _calEdit = null;
  const l = LEAD_CACHE[id];
  if (l && typeof openEditLead === 'function') openEditLead(l); else nav('crm');
}

function calAfterChange() {
  if ($('panel-calendar') && $('panel-calendar').classList.contains('active')) loadCalendar();
  if ($('panel-crm') && $('panel-crm').classList.contains('active') && typeof loadCRM === 'function') loadCRM();
}

// ── Availability: the public Book a call page ───────────────────────────────
// quoteleads.com.au/book-a-call offers times from booking_settings: the hours
// per weekday below, minus anything already on this calendar (with the buffer
// either side), at least the notice ahead and up to the days ahead. A booking
// lands here as a call with these reminders, and the lead goes into Booked.
const BOOK_URL = 'https://quoteleads.com.au/book-a-call';
const AV_DAYS = [['mon','Monday'],['tue','Tuesday'],['wed','Wednesday'],['thu','Thursday'],['fri','Friday'],['sat','Saturday'],['sun','Sunday']];
const AV_TZ = [['Australia/Brisbane','Brisbane (AEST, no daylight saving)'],['Australia/Sydney','Sydney / Melbourne / Canberra'],['Australia/Adelaide','Adelaide'],['Australia/Perth','Perth'],['Australia/Darwin','Darwin'],['Australia/Hobart','Hobart']];
let _av = null;

function avRangeRow(day, r) {
  return `<div class="av-range"><input class="fi" type="time" step="900" value="${esc(r[0])}" data-av-from="${day}">
    <span class="cal-hint">to</span><input class="fi" type="time" step="900" value="${esc(r[1])}" data-av-to="${day}">
    <button class="btn btn-xs" type="button" onclick="this.parentElement.remove()" title="Remove">✕</button></div>`;
}
function avDayHtml(day, label, ranges) {
  return `<div class="av-day" data-av-day="${day}">
    <label class="av-dname"><input type="checkbox" ${ranges.length ? 'checked' : ''} onchange="avToggleDay('${day}', this.checked)"> ${label}</label>
    <div class="av-ranges" id="av-r-${day}">${ranges.map(r => avRangeRow(day, r)).join('') || '<span class="cal-hint av-none">Unavailable</span>'}</div>
    <button class="btn btn-xs av-add" type="button" onclick="avAddRange('${day}')" ${ranges.length ? '' : 'style="visibility:hidden"'}>+ Hours</button>
  </div>`;
}
function avToggleDay(day, on) {
  const box = $('av-r-' + day);
  box.innerHTML = on ? avRangeRow(day, ['09:00', '17:00']) : '<span class="cal-hint av-none">Unavailable</span>';
  box.parentElement.querySelector('.av-add').style.visibility = on ? '' : 'hidden';
}
function avAddRange(day) {
  const box = $('av-r-' + day);
  const none = box.querySelector('.av-none'); if (none) none.remove();
  box.insertAdjacentHTML('beforeend', avRangeRow(day, ['13:00', '17:00']));
}

async function openAvailability() {
  const { data, error } = await db.from('booking_settings').select('*').eq('id', 1).maybeSingle();
  if (error || !data) return toast('Could not load availability: ' + (error ? error.message : 'not set up'));
  _av = data;
  $('m-avail') && $('m-avail').remove();
  const reps = (typeof _reps !== 'undefined' ? _reps : []).filter(r => r.active !== false && r.user_id !== currentUser.id);
  const chips = (group, list, cfg) => list.map(([m, label]) => `<label class="cal-chip"><input type="checkbox" data-av-rem="${group}" value="${m}" ${(cfg.minutes || []).includes(m) ? 'checked' : ''}><span>${label}</span></label>`).join('');
  const ru = data.remind_us || {}, rp = data.remind_prospect || {};
  document.body.insertAdjacentHTML('beforeend', `
<div class="overlay" id="m-avail">
  <div class="modal" style="max-width:640px">
    <h2>Availability</h2>
    <div class="msub">The times people can book on the Book a call page. Anything already on this calendar is blocked out automatically.</div>
    <div class="av-link">
      <label class="av-dname"><input type="checkbox" id="av-on" ${data.enabled ? 'checked' : ''}> Booking page open</label>
      <code>${BOOK_URL}</code>
      <button class="btn btn-xs" type="button" onclick="navigator.clipboard.writeText('${BOOK_URL}').then(()=>toast('Link copied'))">Copy link</button>
      <a class="btn btn-xs" href="${BOOK_URL}" target="_blank" rel="noopener">Open</a>
    </div>
    <div class="frow"><label class="flabel">Timezone for these hours</label><select class="fs" id="av-tz">${AV_TZ.map(([v, l]) => `<option value="${v}" ${data.timezone === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="av-week">${AV_DAYS.map(([d, l]) => avDayHtml(d, l, (data.weekly || {})[d] || [])).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px">
      <div class="frow"><label class="flabel">Call length</label><select class="fs" id="av-len">${[15,20,30,45,60].map(m => `<option value="${m}" ${data.slot_minutes === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div>
      <div class="frow"><label class="flabel">Gap between calls</label><select class="fs" id="av-buf">${[0,5,10,15,30].map(m => `<option value="${m}" ${data.buffer_minutes === m ? 'selected' : ''}>${m ? m + ' min' : 'None'}</option>`).join('')}</select></div>
      <div class="frow"><label class="flabel">Minimum notice</label><select class="fs" id="av-notice">${[[0,'None'],[1,'1 hour'],[2,'2 hours'],[4,'4 hours'],[12,'12 hours'],[24,'1 day'],[48,'2 days']].map(([h, l]) => `<option value="${h}" ${data.min_notice_hours === h ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="frow"><label class="flabel">Book up to</label><select class="fs" id="av-ahead">${[7,14,21,30,60].map(d => `<option value="${d}" ${data.days_ahead === d ? 'selected' : ''}>${d} days ahead</option>`).join('')}</select></div>
    </div>
    <div class="frow"><label class="flabel">Days off <span style="font-weight:400;color:var(--ink3)">(holidays, leave)</span></label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input class="fi" type="date" id="av-off-d" style="max-width:180px"><button class="btn btn-xs" type="button" onclick="avAddOff()">Add day off</button></div>
      <div id="av-off" class="av-offs"></div></div>
    <div class="frow"><label class="flabel">Who takes calls booked online</label><select class="fs" id="av-owner">
      <option value="${esc(currentUser.id)}">Me</option>${reps.map(r => `<option value="${esc(r.user_id)}" ${data.owner_id === r.user_id ? 'selected' : ''}>${esc(r.name || r.email)}</option>`).join('')}</select></div>
    <div class="cal-rem"><div class="cal-rem-h">Remind us</div><div class="cal-rem-b">
      <div class="cal-rem-ch"><label><input type="checkbox" id="av-us-email" ${ru.email ? 'checked' : ''}> Email whoever takes it</label><label><input type="checkbox" id="av-us-sms" ${ru.sms ? 'checked' : ''}> Text the business mobile</label></div>
      <div class="cal-chips">${chips('us', CAL_US_TIMES, ru)}</div></div></div>
    <div class="cal-rem"><div class="cal-rem-h">Remind the prospect</div><div class="cal-rem-b">
      <div class="cal-rem-ch"><label><input type="checkbox" id="av-pr-email" ${rp.email ? 'checked' : ''}> Email</label><label><input type="checkbox" id="av-pr-sms" ${rp.sms ? 'checked' : ''}> Text</label></div>
      <div class="cal-chips">${chips('prospect', CAL_PROSPECT_TIMES, rp)}</div>
      <div class="cal-hint" style="margin-top:6px">They also get a confirmation email the moment they book.</div></div></div>
    <div class="macts"><button class="btn" onclick="closeModal('m-avail')">Cancel</button><button class="btn btn-p" id="av-save" onclick="saveAvailability()">Save availability</button></div>
  </div>
</div>`);
  $('av-owner').value = data.owner_id || currentUser.id;
  _av.offs = [...(data.blocked_dates || [])];
  avRenderOff();
  openModal('m-avail');
}
function avRenderOff() {
  const today = calYmd(new Date());
  _av.offs = _av.offs.filter(d => d >= today).sort();
  $('av-off').innerHTML = _av.offs.map(d => `<span class="av-chip">${new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' })}<button type="button" onclick="_av.offs=_av.offs.filter(x=>x!=='${d}');avRenderOff()">×</button></span>`).join('') || '<span class="cal-hint">None</span>';
}
function avAddOff() { const d = $('av-off-d').value; if (d && !_av.offs.includes(d)) { _av.offs.push(d); avRenderOff(); } $('av-off-d').value = ''; }

async function saveAvailability() {
  const weekly = {};
  for (const [d] of AV_DAYS) {
    const froms = [...document.querySelectorAll(`[data-av-from="${d}"]`)], tos = [...document.querySelectorAll(`[data-av-to="${d}"]`)];
    const ranges = froms.map((f, i) => [f.value, tos[i].value]).filter(([a, b]) => a && b);
    for (const [a, b] of ranges) if (a >= b) return toast(`${AV_DAYS.find(x => x[0] === d)[1]}: the end time must be after the start.`);
    weekly[d] = ranges.sort();
  }
  const rem = (g, email, sms) => ({ email: $(email).checked, sms: $(sms).checked,
    minutes: [...document.querySelectorAll(`[data-av-rem="${g}"]:checked`)].map(x => Number(x.value)) });
  const patch = {
    enabled: $('av-on').checked, timezone: $('av-tz').value, weekly,
    slot_minutes: Number($('av-len').value), buffer_minutes: Number($('av-buf').value),
    min_notice_hours: Number($('av-notice').value), days_ahead: Number($('av-ahead').value),
    blocked_dates: _av.offs, owner_id: $('av-owner').value || null,
    remind_us: rem('us', 'av-us-email', 'av-us-sms'), remind_prospect: rem('prospect', 'av-pr-email', 'av-pr-sms'),
    updated_at: new Date().toISOString(),
  };
  const btn = $('av-save'); btn.disabled = true;
  const { error } = await db.from('booking_settings').update(patch).eq('id', 1);
  btn.disabled = false;
  if (error) return toast('Could not save: ' + error.message);
  closeModal('m-avail');
  toast(patch.enabled ? 'Availability saved. The booking page shows the new times now.' : 'Saved. The booking page is closed.');
}
