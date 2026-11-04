'use strict';

const _ep = 'https://wmegoygrancfwxagqskh.supabase.co';
const _ak = 'sb_publishable_UHQNxVCjHJnFjssYwTiwcQ_3FYovX8I';
// Twilio inbound webhook URL is stored in business_settings.twilio_webhook_url
// (DB-only, editable in Twilio Settings) - never hardcoded here, so the app can
// never silently point a number at the wrong project.
function copyTwilioWebhook() {
  const v = (document.getElementById('ts-webhook-url')?.value || '').trim();
  if (!v) { toast('No webhook URL set', true); return; }
  navigator.clipboard.writeText(v).then(() => toast('Copied ✓'));
}
const AVG_WEEKS_PER_MONTH = 4.33; // average weeks in a month (52/12)
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

let db, currentUser;

// ── Loading bar ──
// Every request (Supabase queries, edge functions) goes through fetch, so
// wrapping it once covers the whole app. The bar waits 150ms before showing,
// so quick background refreshes don't flash it, creeps towards 90% while
// requests are open, then fills and fades when the last one finishes.
const QLProgress = (() => {
  let open = 0, width = 0, showTimer = null, creep = null, hideTimer = null;
  const bar = () => document.getElementById('ql-progress');
  const set = w => { width = w; const b = bar(); if (b) b.style.width = w + '%'; };
  function show() {
    const b = bar(); if (!b) return;
    clearTimeout(hideTimer);
    b.style.transition = 'none'; set(0); void b.offsetWidth; b.style.transition = '';
    b.classList.add('on'); set(18);
    clearInterval(creep);
    creep = setInterval(() => { if (width < 90) set(width + (90 - width) * 0.12); }, 220);
  }
  function finish() {
    clearTimeout(showTimer); showTimer = null;
    clearInterval(creep); creep = null;
    const b = bar(); if (!b || !b.classList.contains('on')) return;
    set(100);
    hideTimer = setTimeout(() => { b.classList.remove('on'); setTimeout(() => { if (!open) set(0); }, 350); }, 220);
  }
  return {
    start() { open++; if (open === 1 && !showTimer && !creep) showTimer = setTimeout(() => { showTimer = null; if (open) show(); }, 150); },
    done() { open = Math.max(0, open - 1); if (!open) finish(); },
  };
})();
if (window.fetch && !window.fetch.__ql) {
  const _fetch = window.fetch.bind(window);
  const tracked = (...args) => { QLProgress.start(); return _fetch(...args).finally(() => QLProgress.done()); };
  tracked.__ql = true;
  window.fetch = tracked;
}
let firstLoadDone = false;
let IS_REP = false;   // true when the logged-in account_type is 'sales_rep'

// ── Impersonation: admin views the dashboard AS a rep, with real RLS-scoped
// data, then switches back. The admin session is stashed so we can restore it.
async function impersonateRep(repUserId, repName, btn) {
  if (!confirm(`View the dashboard exactly as ${repName || 'this rep'}?\n\nYou'll see their real, RLS-scoped data (only their own leads). You can switch back to your account anytime.`)) return;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const { data: { session: adminSession } } = await db.auth.getSession();
    if (!adminSession) throw new Error('No admin session');
    const res = await fetch(`${_ep}/functions/v1/impersonate-rep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminSession.access_token}`, 'apikey': _ak },
      body: JSON.stringify({ rep_user_id: repUserId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.session) throw new Error(data.error || `HTTP ${res.status}`);
    // Stash the admin session so we can come back, and flag who we're viewing as.
    sessionStorage.setItem('ql_admin_sess', JSON.stringify({ access_token: adminSession.access_token, refresh_token: adminSession.refresh_token }));
    sessionStorage.setItem('ql_imp_rep', repName || (data.rep && data.rep.email) || 'rep');
    const setErr = (await db.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token })).error;
    if (setErr) throw new Error(setErr.message);
    location.reload();
  } catch (e) {
    toast('Could not view as rep: ' + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

async function exitImpersonation() {
  const btn = $('imp-exit-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Switching…'; }
  try {
    const saved = JSON.parse(sessionStorage.getItem('ql_admin_sess') || 'null');
    sessionStorage.removeItem('ql_admin_sess');
    sessionStorage.removeItem('ql_imp_rep');
    if (saved && saved.refresh_token) {
      await db.auth.setSession({ access_token: saved.access_token, refresh_token: saved.refresh_token });
    }
  } catch (e) {}
  location.reload();
}
let revChart = null, cplChart = null, goalRevChart = null, goalMarginChart = null;
let pplChurnChart = null, mgChurnChart = null, pplChurnMonthly = null, mgChurnMonthly = null;
let curCrmRange = '';   // '' = no date filter → full pipeline visible by default

const _taskMap = new Map();

const LEAD_CACHE = {};
const CLIENT_CACHE = {};
let leadsPage = 0;
let leadsTotal = 0;
let crmPage = 0;
let crmAllLeads = [];       // date-filtered leads (table/KPIs)
let crmPipelineLeads = [];  // all active leads regardless of date (kanban)
let crmBizTotals = {};      // billed to date per business (loadCrmLtv), for the LTV metric
let crmRepView = '';        // owner-only: '' = everyone, else a rep's user_id

// Owner-only "view as rep": fill the selector from the loaded rep list.
function populateCrmRepView() {
  const sel = $('crm-rep-view'); if (!sel || IS_REP) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Everyone</option>' +
    _reps.map(r => `<option value="${esc(r.user_id)}">${esc(r.name || r.email)}${r.active ? '' : ' (inactive)'}</option>`).join('');
  sel.value = cur;
}
// Search narrows the kanban and the leads table only; the KPIs and follow-up
// banner keep counting the whole (date / rep filtered) pipeline.
let crmSearch = '';
let _crmSearchT = null;
function setCrmSearch(v) {
  clearTimeout(_crmSearchT);
  _crmSearchT = setTimeout(() => { crmSearch = v.trim().toLowerCase(); crmPage = 0; renderCRM(); }, 150);
}
function crmMatches(l) {
  if (!crmSearch) return true;
  const hay = [l.name, l.company, l.email, l.phone].filter(Boolean).join(' ').toLowerCase();
  if (hay.includes(crmSearch)) return true;
  // Phone numbers: match on digits so "0412 345" finds "0412345678".
  const qd = crmSearch.replace(/\D/g, '');
  return qd.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(qd);
}

// A rep never sees deal value or LTV, so picking one hides the button and
// re-masks both cards - the filtered view then matches what that rep sees.
function setCrmRepView(v) {
  crmRepView = v; crmPage = 0;
  const btn = $('crm-private-btn');
  if (btn) btn.style.display = v ? 'none' : '';
  if (v) {
    document.querySelectorAll('.kpi-private').forEach(k => k.classList.add('masked'));
    setText('crm-private-btn', 'Show deal value & LTV');
  }
  renderCRM();
}
const PAGE_SIZE = 50;
function renderPager(elId, page, total, onPage) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const el = $(elId);
  if (!el || pages <= 1) { if (el) el.innerHTML = ''; return; }
  const from = page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  el.innerHTML = `<button id="${elId}-prev" ${page===0?'disabled':''}>← Prev</button><span>${from}–${to} of ${total}</span><button id="${elId}-next" ${page>=pages-1?'disabled':''}>Next →</button>`;
  $(`${elId}-prev`).addEventListener('click', () => onPage(page - 1));
  $(`${elId}-next`).addEventListener('click', () => onPage(page + 1));
}

const $ = id => document.getElementById(id);
const setText = (id, v) => { const e = $(id); if (e) e.textContent = v; };
const setVal  = (id, v) => { const e = $(id); if (e) e.value = v ?? ''; };
const now  = () => new Date().toISOString();
const esc  = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt  = n => (!n && n !== 0) ? '-' : '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0,maximumFractionDigits:0});
// Today where the user is, not in UTC. toISOString() is UTC, so in AEST any
// time before 10am it returns yesterday - which would date a build fee logged
// at 9am to the day before, and mornings are exactly when deals get converted.
const localDateStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
const fmtCpl = n => n ? '$' + Number(n).toFixed(2) : '-';
// Australian timezones (IANA). Live/DST-aware; default is AEST (Brisbane).
const AU_TIMEZONES = [
  ['Australia/Brisbane',  'AEST - Brisbane (QLD)'],
  ['Australia/Sydney',    'AEST/AEDT - Sydney (NSW)'],
  ['Australia/Melbourne', 'AEST/AEDT - Melbourne (VIC)'],
  ['Australia/Hobart',    'AEST/AEDT - Hobart (TAS)'],
  ['Australia/Adelaide',  'ACST/ACDT - Adelaide (SA)'],
  ['Australia/Darwin',    'ACST - Darwin (NT)'],
  ['Australia/Perth',     'AWST - Perth (WA)'],
];
let _tz = localStorage.getItem('ql_tz') || 'Australia/Brisbane';
// NOTE: toLocaleString (not toLocaleDateString) so hour/minute options actually
// render - toLocaleDateString silently drops any time fields.
const fmtDate = (d, time) => {
  if (!d) return '-';
  const opts = time
    ? {day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12:true,timeZone:_tz}
    : {day:'numeric',month:'short',timeZone:_tz};
  return new Date(d).toLocaleString('en-AU', opts);
};
function setTimezone(tz) {
  _tz = tz;
  localStorage.setItem('ql_tz', tz);
  // Re-render whatever's on screen so the new zone applies immediately.
  try { if (typeof loadSalesConversations === 'function') loadSalesConversations(); } catch (e) {}
}
function initTimezoneSelect() {
  const sel = document.getElementById('tz-select');
  if (!sel) return;
  sel.innerHTML = AU_TIMEZONES.map(([v, l]) => `<option value="${v}"${v === _tz ? ' selected' : ''}>${l}</option>`).join('');
}
document.addEventListener('DOMContentLoaded', initTimezoneSelect);

function toast(msg, err = false) {
  const old = $('ql-toast'); if (old) old.remove();
  const t = document.createElement('div');
  t.id = 'ql-toast'; t.textContent = msg;
  t.style.cssText = `background:${err ? 'var(--s1)' : 'var(--acc)'};color:${err ? 'var(--red)' : '#fff'};border:1px solid ${err ? 'rgba(255,69,96,.3)' : 'transparent'};letter-spacing:.04em`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function stageBadge(s) {
  if (!s) return 'bg-gray';
  const l = s.toLowerCase();
  if (['active','active_client','closed_won'].includes(l)) return 'bg-grn';
  if (['churned','closed_lost'].includes(l)) return 'bg-red';
  if (['paused','no_answer'].includes(l)) return 'bg-amb';
  if (['onboarding','call_back'].includes(l)) return 'bg-vio';
  if (['proposal','proposal_sent'].includes(l)) return 'bg-sky';
  return 'bg-blu';
}
function stageLabel(s) {
  return {active_client:'Active',paused:'Paused',churned:'Churned',lead:'Lead',onboarding:'Onboarding',active:'Active',proposal_sent:'Proposal Sent',new_lead:'New Lead',no_answer:'No Answer',call_back:'Call-Back/Booked',proposal:'Proposal',closed_won:'Closed Won',closed_lost:'Closed Lost'}[s] || s;
}

// Shows what a click switches to: a sun in dark mode, a moon in light.
function paintThemeBtn(dark) {
  const b = $('theme-btn');
  b.innerHTML = dark ? '<svg viewBox="0 0 24 24"><path d="M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';
  b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  b.setAttribute('aria-label', b.title);
}

function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  paintThemeBtn(!dark);
  localStorage.setItem('ql-theme', dark ? 'light' : 'dark');
  if (revChart || cplChart) loadFinance();
  if (goalRevChart || goalMarginChart) loadGoals();
}

window.addEventListener('load', () => {
  const saved = localStorage.getItem('ql-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  paintThemeBtn(saved === 'dark');
  initSupabase();
  setInterval(updateClock, 1000);
  updateClock();
  $('task-date').textContent = new Date().toLocaleDateString('en-AU', {weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const sel = $('fin-month');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const n = new Date();
  const curYear = n.getFullYear();
  const ytdOpt = document.createElement('option');
  ytdOpt.value = `ytd-${curYear}`; ytdOpt.textContent = `${curYear} YTD`; ytdOpt.selected = true;
  sel.appendChild(ytdOpt);
  const START_YEAR = 2026, START_MONTH = 0;
  // Each earlier year in full, newest first.
  for (let y = curYear - 1; y >= START_YEAR; y--) {
    const opt = document.createElement('option');
    opt.value = `ytd-${y}`; opt.textContent = `${y} (full year)`;
    sel.appendChild(opt);
  }
  for (let i = 0; ; i++) {
    const d = new Date(n.getFullYear(), n.getMonth() - i, 1);
    if (d.getFullYear() < START_YEAR || (d.getFullYear() === START_YEAR && d.getMonth() < START_MONTH)) break;
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    sel.appendChild(opt);
  }
  $('crm-date').value = new Date().toISOString().split('T')[0];
  // Labels that name the year, so they move on each January.
  setText('crm-ytd-btn', `YTD ${curYear}`);
  setText('ppl-leads-sub', `Jan ${curYear} – now`);
  // Goal Board year selector
  const goalSel = $('goal-year');
  // Next year too, so its goals can be set before it starts.
  for (let y = curYear + 1; y >= 2026; y--) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y; if (y === curYear) opt.selected = true;
    goalSel.appendChild(opt);
  }
  buildKanban('crm-kanban', CRM_STAGES, 'crm');
  buildKanban('ppl-kanban', PPL_STAGES, 'ppl');
  buildKanban('mg-kanban',  MG_STAGES,  'mg');
  buildKanban('hiring-kanban', HIRING_STAGES, 'hiring');
  // PS kanban built on login (after auth determines account type)
});

function initSupabase() {
  try {
    if (!window.supabase) { $('login-error').textContent = 'Supabase library failed to load.'; return; }
    db = window.supabase.createClient(_ep, _ak);
    db.auth.onAuthStateChange((event, session) => {
      if (session) {
        if (session.user.app_metadata?.account_type === 'lead_buyer') {
          db.auth.signOut();
          $('login-error').textContent = 'Access denied. Please use the buyer portal to log in.';
          currentUser = null;
          $('login-screen').style.display = 'flex';
          $('app').classList.remove('visible');
          return;
        }
        currentUser = session.user;
        IS_REP = session.user.app_metadata?.account_type === 'sales_rep';
        setText('uname', currentUser.email.split('@')[0]);
        $('login-screen').style.display = 'none';
        $('app').classList.add('visible');

        // If we're impersonating a rep (session was swapped), surface the banner.
        const impName = sessionStorage.getItem('ql_imp_rep');
        if (impName && sessionStorage.getItem('ql_admin_sess')) {
          const bar = $('rep-preview-bar');
          const lbl = $('imp-rep-name');
          if (lbl) lbl.textContent = impName;
          if (bar) bar.style.display = 'flex';
        }

        applyRoleUI();
        // First load shows placeholders until everything is in; later auth
        // events (token refresh) reload quietly behind the top bar.
        const first = !firstLoadDone;
        firstLoadDone = true;
        if (first) document.body.classList.add('is-loading');
        Promise.resolve(IS_REP ? loadRepView() : loadRepCache().then(loadAll))
          .catch(() => {})
          .finally(() => {
            if (!first) return;
            document.body.classList.remove('is-loading');
            document.body.classList.add('just-loaded');
            setTimeout(() => document.body.classList.remove('just-loaded'), 600);
          });
        setTimeout(updateBnavPadding, 300);
      } else {
        currentUser = null;
        $('login-screen').style.display = 'flex';
        $('app').classList.remove('visible');
      }
    });
  } catch(e) { $('login-error').textContent = 'Init error: ' + e.message; }
}

async function doLogin() {
  const email = $('login-email').value.trim(), pass = $('login-password').value;
  const btn = $('login-btn'), err = $('login-error');
  if (!email || !pass) { err.textContent = 'Email and password required.'; return; }
  btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
  const { data, error } = await db.auth.signInWithPassword({email, password:pass});
  if (error) { err.textContent = error.message; btn.disabled = false; btn.textContent = 'Sign in →'; }
  else if (!data?.session) { err.textContent = 'Login failed.'; btn.disabled = false; btn.textContent = 'Sign in →'; }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && $('login-screen').style.display !== 'none') doLogin();
});
async function doLogout() { if (!confirm('Sign out?')) return; if (db) await db.auth.signOut(); }

// Panels a sales rep is allowed to open. Everything else is hidden + blocked.
// The Scoreboard is owner-only: business-wide numbers and the guardrails.
const REP_PANELS = new Set(['crm', 'invoices', 'sales-conv']);

function toggleClientBreakdown() {
  const el = $('ld-client-breakdown');
  const chevron = $('ld-client-chevron');
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  chevron.textContent = open ? '▶' : '▼';
}

// Panels that share one sidebar entry. The panels themselves are unchanged;
// they are just reached through a sub-tab instead of their own nav button.
const PANEL_GROUPS = {
  campaigns: {label:'Campaigns', members:[
    {panel:'campaigns', label:'Meta Campaigns'},
    {panel:'pcal',      label:'Campaign Action Log'},
    {panel:'cpl',       label:'Lead Gen & CPL', adminOnly:true}
  ]},
  finance: {label:'Financials', members:[
    {panel:'finance', label:'Financials'},
    {panel:'goals',   label:'Goal Board'}
  ]},
  // Managed Ads first: it is what Clients opens on, and a strip whose first tab
  // is not the one you landed on reads as a bug. The group key stays 'ppl'
  // because the sidebar button's data-panel matches on it.
  ppl: {label:'Clients', members:[
    {panel:'managed', label:'Managed Ads'},
    {panel:'ppl',     label:'PPL Clients'}
  ]},
  'sales-conv': {label:'Messaging', members:[
    {panel:'sales-conv', label:'Conversations'},
    {panel:'broadcast',  label:'Bulk SMS', adminOnly:true},
    {panel:'emailtpl',   label:'Email Templates', adminOnly:true},
    {panel:'sentmail',   label:'Sent Emails'}
  ]},
  outreach: {label:'Cold Outreach', members:[
    {panel:'outreach',           label:'Overview'},
    {panel:'outreach-prospects', label:'Prospects'},
    {panel:'outreach-batch',     label:"Today's Batch"},
    {panel:'outreach-sending',   label:'Sending'},
    {panel:'outreach-stats',     label:'Stats'},
    {panel:'outreach-dnc',       label:'Do Not Contact'}
  ]},
  salesreps: {label:'Team', members:[
    {panel:'salesreps', label:'Sales Reps'},
    {panel:'team',      label:'Team Members'},
    {panel:'payrates',  label:'Pay Rates'},
    {panel:'hiring',    label:'Hiring Pipeline'}
  ]}
};
// panel id -> the group that hosts it
const PANEL_GROUP_OF = Object.entries(PANEL_GROUPS).reduce((acc,[key,g]) => {
  g.members.forEach(m => acc[m.panel] = key); return acc;
}, {});

// Builds the strip once per panel and keeps the active state in sync.
function renderSubtabs(panel) {
  const groupKey = PANEL_GROUP_OF[panel];
  if (!groupKey) return;
  const group = PANEL_GROUPS[groupKey];
  const host = $('panel-' + panel);
  if (!host) return;
  let strip = host.querySelector(':scope > .subtabs');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'subtabs';
    const header = host.querySelector(':scope > .ph');
    header ? header.insertAdjacentElement('afterend', strip) : host.prepend(strip);
  }
  strip.innerHTML = group.members.map(m =>
    `<button class="subtab${m.panel===panel?' active':''}${m.adminOnly?' admin-only-field':''}" onclick="nav('${m.panel}')">${m.label}</button>`
  ).join('');
  // Reps never reach these panels, but keep the gate consistent with the rest.
  if (typeof IS_REP !== 'undefined' && IS_REP) {
    strip.querySelectorAll('.admin-only-field').forEach(e => e.style.display = 'none');
  }
}

// Webhook auth has three shapes and each needs different fields:
//   none      - nothing
//   header    - the credential their CRM issued us, under a header they name
//   signature - our own secret, which we generate and they verify
// Fires a sample lead at whatever is currently typed in the webhook fields,
// so a URL can be tested before the client record is saved.
async function sendTestLead(prefix) {
  const url = $(prefix + '-client-webhook')?.value.trim();
  const out = $(prefix + '-test-result');
  const btn = $(prefix + '-test-btn');
  const show = (msg, colour) => { if (out) { out.innerHTML = msg; out.style.color = colour; } };

  if (!url) { show('Enter a webhook URL above first.', 'var(--amb)'); return; }

  const mode = $(prefix + '-webhook-auth')?.value || 'none';
  const cred = $(prefix + '-webhook-secret')?.value.trim() || '';

  btn.disabled = true; btn.textContent = 'Sending…';
  show('', 'var(--ink3)');
  try {
    const { data: sess } = await db.auth.getSession();
    const res = await fetch(`${_ep}/functions/v1/send-test-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sess?.session?.access_token}` },
      body: JSON.stringify({
        url,
        niche: $(prefix + '-test-niche')?.value || 'solar',
        auth_mode: mode,
        auth_header: $(prefix + '-webhook-header')?.value.trim() || 'Authorization',
        secret: cred
      })
    });
    const data = await res.json();
    if (data.error) { show('✕ ' + esc(data.error), 'var(--red)'); return; }
    if (data.ok) {
      const hdrs = (data.sent_headers || []).length ? ' · sent ' + data.sent_headers.map(esc).join(', ') : ' · no auth headers';
      show('✓ Delivered — HTTP ' + data.status + esc(hdrs) + '<br><span style="color:var(--ink3)">The client can now map the fields on their side.</span>', 'var(--grn)');
    } else {
      show('✕ Failed — ' + (data.status ? 'HTTP ' + data.status + ': ' : '') + esc(String(data.response || '').slice(0, 200)), 'var(--red)');
    }
  } catch (e) {
    show('✕ ' + esc(e.message || 'Request failed'), 'var(--red)');
  } finally {
    btn.disabled = false; btn.textContent = 'Send test lead';
  }
}

function toggleWebhookSecret(prefix) {
  const mode = $(prefix + '-webhook-auth')?.value || 'none';
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };

  show(prefix + '-webhook-secret-row', mode !== 'none');
  show(prefix + '-webhook-header-row', mode === 'header');
  show(prefix + '-webhook-gen', mode === 'signature');

  const label = $(prefix + '-webhook-secret-label');
  const input = $(prefix + '-webhook-secret');
  const hint  = $(prefix + '-webhook-hint');

  if (mode === 'header') {
    if (label) label.textContent = 'Their Credential';
    if (input) input.placeholder = 'Bearer abc123…';
    if (hint) hint.innerHTML = 'Paste exactly what their CRM expects as the header value, including any ' +
      '<span style="font-family:var(--mono)">Bearer</span> prefix. We send it verbatim and never log it.';
  } else if (mode === 'signature') {
    if (label) label.textContent = 'Our Secret';
    if (input) input.placeholder = 'whsec_…';
    if (hint) hint.innerHTML = 'Sent as <span style="font-family:var(--mono)">X-QuoteLeads-Secret</span>, plus an ' +
      'HMAC-SHA256 of <span style="font-family:var(--mono)">timestamp + "." + body</span> as ' +
      '<span style="font-family:var(--mono)">X-QuoteLeads-Signature</span>. Give this value to the client so they can verify the request came from us.';
    if (input && !input.value.trim()) genWebhookSecret(prefix);
  } else if (hint) {
    hint.textContent = '';
  }
}

function genWebhookSecret(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const el = $(prefix + '-webhook-secret');
  if (el) el.value = 'whsec_' + hex;
}

function nav(panel, el) {
  if (IS_REP && !REP_PANELS.has(panel)) panel = 'crm';
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $('panel-' + panel).classList.add('active');
  document.querySelectorAll('.navbtn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.bnbtn').forEach(b => b.classList.remove('active'));
  // A grouped panel keeps its group's sidebar button lit.
  const navKey = PANEL_GROUP_OF[panel] || panel;
  document.querySelectorAll(`[data-panel="${navKey}"]`).forEach(b => b.classList.add('active'));
  renderSubtabs(panel);
  if (panel === 'files') { loadFileNames(); loadFileContent(); loadTemplateClientDropdown(); }
  if (panel === 'cpl') loadCplEditorPanel();
  if (panel === 'broadcast') loadBroadcast();
  if (panel === 'pcal') loadPcal();
  if (panel === 'campaigns') { loadCampaigns(); renderMetaTokenBanner(); }
  if (panel === 'mads') loadManagedAds();
  if (panel === 'leads') loadLeads();
  if (panel === 'sales-conv') loadSalesConversations();
  if (panel === 'invoices') loadInvoices();
  if (panel === 'goals') loadGoals();
  if (panel === 'scoreboard') loadScoreboard();
  if (panel === 'emailtpl') loadEmailTemplates();
  if (panel === 'sentmail') loadSentEmails();
  if (panel === 'hiring') loadHiring();
  if (panel === 'salesreps') loadReps();
  if (panel === 'team') loadTeam();
  if (panel === 'payrates') loadPayRates();
  if (panel === 'outreach') loadOutreach();
  if (panel === 'outreach-prospects') loadProspects();
  if (panel === 'outreach-dnc') loadSuppressions();
  if (panel === 'outreach-batch') loadBatch();
  if (panel === 'outreach-sending') loadSending();
  if (panel === 'outreach-stats') loadOutreachStats();
}
