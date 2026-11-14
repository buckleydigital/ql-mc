'use strict';

// ── Cold outreach: niches, prospects, do-not-contact ──────────────────────
// Statuses in the order a prospect moves through them, with the words shown.
const OR_STATUS = [
  ['new', 'found'], ['enriched', 'enriched'], ['verified', 'verified'], ['qualified', 'ready for review'],
  ['queued', 'queued'], ['contacted', 'contacted'], ['replied', 'replied'], ['interested', 'interested'],
  ['converted', 'became a lead'], ['not_interested', 'not interested'], ['unsubscribed', 'unsubscribed'],
  ['bounced', 'bounced'], ['blocked', 'blocked'], ['rejected', 'not a fit'],
];
const OR_STATUS_LABEL = Object.fromEntries(OR_STATUS);
// Contacted or converted prospects are history; prospect_delete refuses them.
const OR_UNDELETABLE = ['contacted', 'replied', 'interested', 'not_interested', 'unsubscribed', 'bounced', 'converted'];
const OR_STATUS_COLOR = {
  qualified: 'var(--acc)', contacted: 'var(--acc)', replied: 'var(--amb)', interested: 'var(--grn)',
  converted: 'var(--grn)', blocked: 'var(--red)', bounced: 'var(--red)', unsubscribed: 'var(--red)',
};
let orNiches = [];
let orPrPage = 0;
let orPrTimer = null;
const orAttr = function (v) { return jmEsc(v).replace(/"/g, '&quot;'); };
const orDate = function (d) { return d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '-'; };

async function loadOutreach() {
  const host = $('or-niches');
  try {
    const { data, error } = await db.rpc('outreach_niche_list');
    if (error) throw error;
    orNiches = data || [];
  } catch (err) {
    host.innerHTML = '<div class="empty">Could not load niches: ' + jmEsc(err.message || err) + '</div>';
    return;
  }
  renderOutreachKpis();
  loadOutreachRuns();
  host.innerHTML = orNiches.map(function (n) {
    const c = n.counts || {};
    const total = Object.values(c).reduce(function (a, b) { return a + Number(b || 0); }, 0);
    const stats = total
      ? OR_STATUS.filter(function (s) { return c[s[0]]; }).map(function (s) { return c[s[0]] + ' ' + s[1]; }).join(' · ')
      : 'No prospects yet';
    return '<div class="or-niche' + (n.enabled ? ' on' : '') + '" id="or-card-' + n.key + '">' +
      '<div class="or-head">' +
        '<label class="or-name"><input type="checkbox" id="or-en-' + n.key + '"' + (n.enabled ? ' checked' : '') +
          ' onchange="$(\'or-card-' + n.key + '\').classList.toggle(\'on\',this.checked)">' +
          '<b style="font-size:14px">' + jmEsc(n.label) + '</b></label>' +
        '<span class="or-live">' + (n.enabled ? 'On' : 'Off') + '</span>' +
        '<label class="or-dt">per day<input class="fi" type="number" inputmode="numeric" min="0" max="300" id="or-dt-' + n.key + '" value="' + Number(n.daily_target) + '"></label>' +
      '</div>' +
      '<div class="or-stats">' + jmEsc(stats) + '</div>' +
      '<div class="or-grid">' +
        '<div class="frow" style="margin:0"><label class="flabel">Regions (blank = nationwide)</label>' +
          '<input class="fi" id="or-rg-' + n.key + '" value="' + orAttr((n.regions || []).join(', ')) + '" placeholder="QLD, Newcastle NSW"></div>' +
        '<div class="frow" style="margin:0"><label class="flabel">Search terms</label>' +
          '<input class="fi" id="or-st-' + n.key + '" value="' + orAttr((n.search_terms || []).join(', ')) + '"></div>' +
      '</div>' +
      '<div class="frow" style="margin:8px 0 0"><label class="flabel">Offer - what we pitch this niche, in plain words</label>' +
        '<textarea class="fi" id="or-of-' + n.key + '" rows="2" style="width:100%;resize:vertical" placeholder="e.g. Your own branded lead system for ' + orAttr(n.label.toLowerCase()) + ' - exclusive leads from your own ad accounts, live in 48 hours, no lock-in">' + jmEsc(n.offer || '') + '</textarea></div>' +
      '<div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<button class="btn btn-p btn-sm or-save" type="button" onclick="saveOutreachNiche(\'' + n.key + '\')">Save</button>' +
        '<span class="or-sub">Comma-separate regions and search terms.</span>' +
      '</div>' +
    '</div>';
  }).join('') || '<div class="empty">No niches set up.</div>';
}

// Finding costs money, so it runs only when pressed, never on a schedule.
let orRunPoll = null;
async function loadOutreachRuns() {
  const status = $('or-run-status'), btn = $('or-run-btn'), host = $('or-runs');
  if (!status) return;
  const { data, error } = await db.rpc('outreach_run_list', { p_limit: 5 });
  if (error) { status.textContent = 'Could not load runs: ' + error.message; return; }
  const runs = data || [];
  const going = runs.find(function (r) { return !r.finished_at && Date.now() - new Date(r.started_at).getTime() < 15 * 60000; });
  const today = new Date().toLocaleDateString('en-AU');
  const ranToday = runs.some(function (r) { return new Date(r.started_at).toLocaleDateString('en-AU') === today; });
  const live = orNiches.filter(function (n) { return n.enabled && n.daily_target > 0; });
  btn.disabled = !!going || !live.length;
  btn.textContent = going ? 'Running…' : (ranToday ? '▶ Run again' : "▶ Run today's search");
  status.textContent = going
    ? 'Running now - finding, reading websites and verifying. This page updates itself.'
    : !live.length ? 'Switch a niche on below to run a search.'
    : ranToday ? 'Already run today. Running again tops up any niche still short of its target.'
    : 'Not run today. Up to ' + live.reduce(function (a, n) { return a + Number(n.daily_target); }, 0) + ' new prospects across ' + live.length + ' niche' + (live.length > 1 ? 's' : '') + '.';
  host.innerHTML = runs.map(function (r) {
    const when = new Date(r.started_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const parts = [r.found + ' found', r.emails + ' with email', r.verified + ' verified'];
    if (r.qualified || r.not_fit) parts.push(r.qualified + ' ready for review', r.not_fit + ' not a fit');
    if (Number(r.ai_cost_usd) > 0) parts.push('AI US$' + Number(r.ai_cost_usd).toFixed(2));
    if (r.blocked) parts.push(r.blocked + ' blocked');
    if (r.invalid) parts.push(r.invalid + ' bad email');
    const errs = (r.errors || []).length;
    return '<div class="or-run-item"><span class="when">' + jmEsc(when) + '</span>' +
      '<span style="flex:1;min-width:180px">' + (r.finished_at ? '' : '<b style="color:var(--acc)">running · </b>') + jmEsc(parts.join(' · ')) + '</span>' +
      (errs ? '<span style="color:var(--amb)" title="' + orAttr((r.errors || []).join('\n')) + '">' + errs + ' problem' + (errs > 1 ? 's' : '') + '</span>' : '') +
    '</div>';
  }).join('');
  clearTimeout(orRunPoll);
  if (going && $('panel-outreach').classList.contains('active')) {
    orRunPoll = setTimeout(function () { loadOutreach(); }, 6000);
  }
}

async function runOutreachSearch() {
  const live = orNiches.filter(function (n) { return n.enabled && n.daily_target > 0; });
  if (!live.length) { toast('Switch a niche on first', true); return; }
  const n = live.reduce(function (a, x) { return a + Number(x.daily_target); }, 0);
  if (!confirm('Search for up to ' + n + ' new prospects in ' + live.map(function (x) { return x.label; }).join(', ') +
    '?\n\nCosts roughly US$1-2 for a full day (Google searches, email checks, and Claude scoring each one). Nothing is sent.')) return;
  const btn = $('or-run-btn');
  btn.disabled = true; btn.textContent = 'Starting…';
  const { error } = await db.rpc('outreach_run_now');
  if (error) { toast('Could not start: ' + error.message, true); btn.disabled = false; loadOutreachRuns(); return; }
  toast('Search started ✓');
  setTimeout(loadOutreach, 2500);
}

function renderOutreachKpis() {
  const live = orNiches.filter(function (n) { return n.enabled; });
  const sum = function (keys) {
    return orNiches.reduce(function (a, n) {
      const c = n.counts || {};
      return a + (keys ? keys : Object.keys(c)).reduce(function (b, k) { return b + Number(c[k] || 0); }, 0);
    }, 0);
  };
  const contacted = sum(['contacted', 'replied', 'interested', 'not_interested', 'unsubscribed', 'bounced', 'converted']);
  const replies = sum(['replied', 'interested', 'not_interested', 'converted']);
  setText('or-k-live', live.length);
  setText('or-k-live-sub', 'of ' + orNiches.length + ' niches');
  setText('or-k-target', live.reduce(function (a, n) { return a + Number(n.daily_target || 0); }, 0));
  setText('or-k-found', sum(null));
  setText('or-k-found-sub', sum(['qualified']) + ' ready for review');
  setText('or-k-replies', replies);
  setText('or-k-replies-sub', contacted ? Math.round(100 * replies / contacted) + '% of ' + contacted + ' contacted' : 'none contacted yet');
}

async function saveOutreachNiche(key) {
  const split = function (v) { return String(v || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); };
  const { error } = await db.rpc('outreach_niche_update', {
    p_key: key,
    p_enabled: $('or-en-' + key).checked,
    p_daily_target: parseInt($('or-dt-' + key).value, 10) || 0,
    p_regions: split($('or-rg-' + key).value),
    p_search_terms: split($('or-st-' + key).value),
    p_offer: $('or-of-' + key).value,
  });
  if (error) { toast('Could not save: ' + error.message, true); return; }
  toast('Saved ✓');
  loadOutreach();
}

function orPrSearch() {
  clearTimeout(orPrTimer);
  orPrTimer = setTimeout(function () { orPrPage = 0; loadProspects(); }, 300);
}

async function loadProspects() {
  const tb = $('or-pr-tbody');
  const nicheSel = $('or-pr-niche'), statusSel = $('or-pr-status');
  // Fill the filters once; the niche list may not be loaded yet.
  if (nicheSel.options.length <= 1) {
    if (!orNiches.length) {
      const { data } = await db.rpc('outreach_niche_list');
      orNiches = data || [];
    }
    nicheSel.innerHTML = '<option value="">All niches</option>' +
      orNiches.map(function (n) { return '<option value="' + orAttr(n.key) + '">' + jmEsc(n.label) + '</option>'; }).join('');
  }
  if (statusSel.options.length <= 1) {
    statusSel.innerHTML = '<option value="">Any status</option>' +
      OR_STATUS.map(function (s) { return '<option value="' + s[0] + '">' + jmEsc(s[1]) + '</option>'; }).join('');
  }
  const labels = Object.fromEntries(orNiches.map(function (n) { return [n.key, n.label]; }));
  try {
    const { data, error } = await db.rpc('prospect_list', {
      p_niche: nicheSel.value || null, p_status: statusSel.value || null, p_search: $('or-pr-q').value || null,
      p_limit: PAGE_SIZE, p_offset: orPrPage * PAGE_SIZE,
    });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      const filtered = nicheSel.value || statusSel.value || $('or-pr-q').value.trim();
      tb.innerHTML = '<tr><td colspan="6" class="empty">' + (filtered
        ? 'No prospects match.'
        : 'No prospects yet. QuoteLeadsAI starts finding them once a niche is switched on and finding is connected.') + '</td></tr>';
      $('or-pr-pager').innerHTML = '';
      return;
    }
    tb.innerHTML = rows.map(function (r) {
      const site = r.website ? '<div class="or-sub">' + jmEsc(r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</div>' : '';
      const who = r.contact_name ? '<div class="or-sub">' + jmEsc(r.contact_name + (r.contact_role ? ', ' + r.contact_role : '')) + '</div>' : '';
      const verdict = r.email_verdict ? ' <span class="or-sub">· ' + jmEsc(r.email_verdict) + '</span>' : '';
      const src = r.email_source_url ? '<div class="or-sub"><a href="' + orAttr(r.email_source_url) + '" target="_blank" rel="noopener" style="color:inherit">where it was published ↗</a></div>' : '';
      const place = [r.suburb, r.state].filter(Boolean).join(' ');
      const col = OR_STATUS_COLOR[r.status] || 'var(--ink2)';
      // Stage 3 writes "8/10: reason"; the score gets its own badge.
      const fit = r.fit_score == null ? '' :
        '<span class="or-fit' + (Number(r.fit_score) >= 6 ? ' good' : '') + '">' + Number(r.fit_score) + '/10</span> ';
      const why = String(r.status_reason || '').replace(/^\d+\/10:\s*/, '');
      return '<tr>' +
        '<td><strong>' + jmEsc(r.business_name) + '</strong>' + site + who + '</td>' +
        '<td>' + jmEsc(labels[r.niche_key] || r.niche_key) + '</td>' +
        '<td>' + (r.email ? '<span style="font-family:var(--mono);font-size:13px">' + jmEsc(r.email) + '</span>' + verdict + src : '<span class="or-sub">no email yet</span>') + '</td>' +
        '<td>' + jmEsc(place || '-') + '<div class="or-sub">found ' + orDate(r.found_at) + '</div></td>' +
        '<td>' + fit + '<span style="color:' + col + ';font-weight:500">' + jmEsc(OR_STATUS_LABEL[r.status] || r.status) + '</span>' +
          (why ? '<div class="or-sub">' + jmEsc(why) + '</div>' : '') + '</td>' +
        '<td style="text-align:right">' + (OR_UNDELETABLE.includes(r.status) ? '' :
          '<button class="btn btn-xs btn-red" type="button" onclick="deleteProspect(\'' + orAttr(r.id) + '\')" title="Delete this prospect">✕</button>') + '</td>' +
      '</tr>';
    }).join('');
    renderPager('or-pr-pager', orPrPage, Number(rows[0].total), function (p) { orPrPage = p; loadProspects(); });
  } catch (err) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">Could not load prospects: ' + jmEsc(err.message || err) + '</td></tr>';
  }
}

async function deleteProspect(id) {
  if (!confirm('Delete this prospect? It will be removed from the search results and cannot be undone.')) return;
  const { error } = await db.rpc('prospect_delete', { p_id: id });
  if (error) { toast('Could not delete: ' + error.message, true); return; }
  toast('Deleted ✓');
  loadProspects();
}

async function loadSuppressions() {
  const host = $('or-sup-list');
  try {
    const { data, error } = await db.rpc('suppression_list', { p_limit: 500 });
    if (error) throw error;
    const rows = data || [];
    host.innerHTML = rows.length
      ? rows.map(function (r) {
          return '<div class="or-sup-item">' +
            '<span class="v">' + jmEsc(r.value) + '</span>' +
            '<span style="color:var(--ink3)">' + jmEsc(r.kind) + '</span>' +
            '<span style="color:var(--ink2)">' + jmEsc(r.reason.replace(/_/g, ' ')) + '</span>' +
            (r.note ? '<span class="or-sub">' + jmEsc(r.note) + '</span>' : '') +
            '<span style="color:var(--ink3)">' + orDate(r.created_at) + '</span>' +
          '</div>';
        }).join('')
      : '<div class="empty">Nobody on the list yet.</div>';
  } catch (err) {
    host.innerHTML = '<div class="empty">Could not load the list: ' + jmEsc(err.message || err) + '</div>';
  }
}

async function addSuppression() {
  const value = $('or-sup-value').value.trim();
  if (!value) { toast('Enter an email, domain or phone', true); return; }
  const { error } = await db.rpc('suppression_add', {
    p_kind: $('or-sup-kind').value, p_value: value, p_note: $('or-sup-note').value.trim() || null,
  });
  if (error) { toast('Could not add: ' + error.message, true); return; }
  $('or-sup-value').value = ''; $('or-sup-note').value = '';
  toast('Added to do-not-contact ✓');
  loadSuppressions();
}

// ── His notes ───────────────────────────────────────────────────────────────
// What he used to text: new alerts and job results, now left in the panel.
// Checked every minute while the dashboard is open; a note stays at the top
// of the panel, and counted on the ◈ button, until you mark it seen.
let jvInboxTimer = null;
async function loadQuoteLeadsAIInbox() {
  clearTimeout(jvInboxTimer);
  if (typeof IS_REP !== 'undefined' && IS_REP) return;
  jvInboxTimer = setTimeout(loadQuoteLeadsAIInbox, 60000);
  const host = $('jv-inbox'), badge = $('jv-unread');
  if (!host || !badge) return;
  const { data, error } = await db.rpc('quoteleadsai_inbox', { p_limit: 20 });
  if (error) return;   // not an operator, or offline: show nothing
  const rows = (data || []).filter(function (n) { return !n.read_at; });
  const unread = rows.length ? Number(rows[0].unread) : 0;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.style.display = unread ? '' : 'none';
  if (!rows.length) { host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = '';
  host.innerHTML =
    '<div class="jv-inbox-head"><span style="flex:1">' + unread + ' new from QuoteLeadsAI</span>' +
      '<button class="btn btn-xs" type="button" onclick="markQuoteLeadsAIInbox(null)">Mark all seen</button></div>' +
    rows.map(function (n) {
      return '<div class="jv-note ' + jmEsc(n.tier) + '">' +
        '<div style="flex:1;min-width:0"><div class="t">' + jmEsc(n.body) + '</div>' +
          '<div class="w">' + (n.tier === 'job' ? 'Job · ' : n.tier === 'urgent' ? 'Urgent · ' : '') + jmEsc(fmtWhen(n.created_at)) + '</div></div>' +
        '<button class="btn btn-xs" type="button" title="Seen" onclick="markQuoteLeadsAIInbox([\'' + n.id + '\'])">✓</button>' +
      '</div>';
    }).join('');
}

async function markQuoteLeadsAIInbox(ids) {
  const { error } = await db.rpc('quoteleadsai_inbox_read', { p_ids: ids });
  if (error) { toast('Could not mark seen: ' + error.message, true); return; }
  loadQuoteLeadsAIInbox();
}

// ── Cold outreach: sending (stage 4) ──────────────────────────────────────
// outreach-send talks to Instantly; it is called with the signed-in session
// and checks the caller is an operator, like every outreach RPC.
async function orSend(action, extra) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error('Not logged in');
  const res = await fetch(_ep + '/functions/v1/outreach-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
    body: JSON.stringify(Object.assign({ action: action }, extra || {})),
  });
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok || body.ok === false) throw new Error(body.error || ('outreach-send ' + res.status));
  return body;
}

// Who the homeowner gets calls from on the shared lead sites.
const OR_NICHE_PRO = { solar: 'installers', hvac: 'installers' };

/**
 * A sensible first draft for a niche that has no sequence yet. The email is
 * the ad: a plain, short opener (no personalised line), one difference, and a
 * small ask (the video), never a call request. Each email stays well under
 * 75 words.
 */
function defaultSequence(n) {
  const pro = OR_NICHE_PRO[n.key] || 'businesses';
  return [
    { subject: 'quick q about {company}', delay_days: 0,
      body: 'Hey {first_name},\n\nNeed more leads for {company}?\n\nWe run ads under your own brand, so every enquiry comes to you alone instead of being shared with three other ' + pro + ' on a quote site.\n\nI made a short video showing how it works. Want me to send it over?\n\n{sender}' },
    { subject: '', delay_days: 3,
      body: 'Hey {first_name},\n\nJust floating this back up. Happy to send the short video on how we would get {company} more leads. Just reply "send it".\n\n{sender}' },
    { subject: '', delay_days: 4,
      body: 'Hey {first_name},\n\nLast one from me. We run it for you for the first 30 days. If it isn\'t working by then, you walk away: no contract, and you keep everything we built.\n\nWant me to send the video?\n\n{sender}' },
  ];
}

let orSender = null;
let orCampaigns = [];

/** The email as a prospect would read it (the footer is added by Instantly sync). */
function renderEmail(text, p) {
  return String(text || '')
    .replace(/\{first_name\}/g, (p && p.contact_name) || 'there')
    .replace(/\{company\}/g, (p && p.business_name) || 'your business')
    .replace(/\{suburb\}/g, (p && p.suburb) || 'your area')
    .replace(/\{opener\}/g, (p && p.opener) || '')
    .replace(/\{sender\}/g, 'Jay'); // the sending inbox's first name (James, Jay or Will)
}
function senderFooter() {
  const s = orSender || {};
  return '\n\n--\n' + (s.business_name || 'QuoteLeads') + ' · ' + (s.postal_address || '[contact details]') +
    '\nNot for you? Reply "unsubscribe" and you will not hear from us again.';
}

async function loadSending() {
  const [setR, campR] = await Promise.all([db.rpc('outreach_settings_get'), db.rpc('outreach_campaign_list')]);
  if (setR.error) { toast('Could not load sending settings: ' + setR.error.message, true); return; }
  orSender = setR.data || {};
  orCampaigns = campR.data || [];
  setVal('os-name', orSender.sender_name || '');
  setVal('os-biz', orSender.business_name || 'QuoteLeads');
  setVal('os-addr', orSender.postal_address || '');
  setVal('os-from', orSender.send_from || '08:30');
  setVal('os-to', orSender.send_to || '16:30');
  setVal('os-tz', orSender.timezone || 'Australia/Brisbane');
  setVal('os-limit', orSender.daily_limit || 30);
  renderSequences();
  loadOutreachEvents();
  loadConnection();
}

async function loadConnection() {
  const host = $('or-conn');
  host.innerHTML = '<div class="empty">Checking Instantly…</div>';
  let st;
  try { st = await orSend('status'); }
  catch (err) { host.innerHTML = '<div class="empty" style="color:var(--red)">' + jmEsc(err.message) + '</div>'; return; }
  const accts = st.accounts || [];
  const pill = function (t) {
    const cls = /active|warming/.test(t) ? 'good' : /paused|maintenance/.test(t) ? 'warn' : 'bad';
    return '<span class="or-pill ' + cls + '">' + jmEsc(t) + '</span>';
  };
  host.innerHTML =
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
      '<span class="or-pill good">Connected</span><b>' + jmEsc(st.workspace || 'Instantly') + '</b>' +
      '<span class="or-sub">' + (st.webhook ? 'Replies and bounces report back here.' : 'Reporting back is set up on the first Sync.') + '</span></div>' +
    (accts.length
      ? '<div class="or-sub" style="margin-bottom:4px">Tick the inboxes that send. Only warmed inboxes should send - give new ones 2-3 weeks.</div>' +
        accts.map(function (a) {
          return '<label class="or-acct"><input type="checkbox" class="os-acct" value="' + orAttr(a.email) + '"' + (a.selected ? ' checked' : '') + ' style="width:18px;height:18px;margin:0">' +
            '<span class="e">' + jmEsc(a.email) + '</span>' + pill(a.state) + pill(a.warmup) +
            (a.warmup_score != null ? '<span class="or-sub">warm-up score ' + Number(a.warmup_score) + '</span>' : '') + '</label>';
        }).join('')
      : '<div class="or-sub" style="line-height:1.6">No inboxes in Instantly yet. Add your sending inboxes there (Email Accounts → Add), turn warm-up on, and they will appear here to tick.</div>');
}

async function saveSender() {
  const accounts = Array.prototype.map.call(document.querySelectorAll('.os-acct:checked'), function (c) { return c.value; });
  const patch = {
    sender_name: $('os-name').value, business_name: $('os-biz').value, postal_address: $('os-addr').value,
    send_from: $('os-from').value, send_to: $('os-to').value, timezone: $('os-tz').value,
    daily_limit: parseInt($('os-limit').value, 10) || 30,
  };
  if (document.querySelectorAll('.os-acct').length) patch.sending_accounts = accounts;
  const { error } = await db.rpc('outreach_settings_update', { p: patch });
  if (error) { toast('Could not save: ' + error.message, true); return; }
  toast('Sender saved ✓ - press Sync to update Instantly');
  const { data } = await db.rpc('outreach_settings_get'); orSender = data || orSender;
}

function seqStepsFor(n) {
  const steps = Array.isArray(n.sequence) && n.sequence.length ? n.sequence : defaultSequence(n);
  return steps.map(function (s) { return { subject: s.subject || '', body: s.body || '', delay_days: Number(s.delay_days || 0) }; });
}

function renderSequences() {
  const host = $('or-seqs');
  host.innerHTML = orCampaigns.map(function (n) {
    const steps = seqStepsFor(n);
    const written = Array.isArray(n.sequence) && n.sequence.length;
    const state = n.sequence_approved_at
      ? '<span class="or-pill good">Approved</span>'
      : written ? '<span class="or-pill warn">Draft - not approved</span>' : '<span class="or-pill">Suggested draft</span>';
    const camp = n.instantly_campaign_id
      ? '<span class="or-pill ' + (n.campaign_state === 'active' ? 'good' : 'warn') + '">Instantly: ' + jmEsc(n.campaign_state || 'synced') + '</span>'
      : '<span class="or-pill">Not in Instantly yet</span>';
    const auto = n.auto_followups !== false;
    const stats = n.contacted ? (n.contacted + ' emailed · ' + n.replied + ' replied · ' + n.interested + ' interested' + (n.queued ? ' · ' + n.queued + ' queued' : '')) : (n.queued ? n.queued + ' queued' : 'Nobody emailed yet');
    return '<div class="or-niche' + (n.sequence_approved_at ? ' on' : '') + '" data-seq="' + orAttr(n.key) + '">' +
      '<div class="or-head"><b style="font-size:14px;flex:1">' + jmEsc(n.label) + '</b>' + state + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center">' + camp + '<span class="or-sub">' + jmEsc(stats) + '</span></div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin:10px 0 0;text-transform:none;letter-spacing:0;font-size:13px;cursor:pointer">' +
        '<input type="checkbox" class="sq-auto" style="width:18px;height:18px;margin:0"' + (auto ? ' checked' : '') + ' onchange="seqFollowups(\'' + n.key + '\',this.checked)">' +
        '<span>Send follow-ups automatically</span>' +
        (auto ? '' : '<span class="or-pill warn">First email only</span>') +
      '</label>' +
      (auto || steps.length < 2 ? '' : '<div class="or-sub" style="margin-top:4px">Only Email 1 is sent. The follow-ups below are kept for when you switch this back on.</div>') +
      steps.map(function (st, i) {
        return '<div class="or-step-ed" data-i="' + i + '"' + (i && !auto ? ' style="opacity:.5"' : '') + '>' +
          '<div class="hd"><span style="flex:1">Email ' + (i + 1) + '</span>' +
            (i ? '<label style="margin:0;text-transform:none;letter-spacing:0">wait <input class="fi sq-delay" type="number" inputmode="numeric" min="1" max="30" value="' + (st.delay_days || 3) + '" style="width:58px;display:inline-block;padding:4px 6px"> days</label>' : '') +
            (steps.length > 1 ? '<button class="btn btn-xs" type="button" title="Remove this email" onclick="seqRemove(\'' + n.key + '\',' + i + ')">✕</button>' : '') +
          '</div>' +
          '<input class="fi sq-subject" placeholder="' + (i ? 'Blank = reply in the same thread' : 'Subject') + '" value="' + orAttr(st.subject) + '">' +
          '<textarea class="fi sq-body" rows="7" style="margin-top:6px">' + jmEsc(st.body) + '</textarea>' +
        '</div>';
      }).join('') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        (steps.length < 4 ? '<button class="btn btn-sm" type="button" onclick="seqAdd(\'' + n.key + '\')">+ Email</button>' : '') +
        '<button class="btn btn-sm" type="button" onclick="seqPreview(\'' + n.key + '\')">Preview</button>' +
        '<button class="btn btn-sm" type="button" onclick="seqSave(\'' + n.key + '\',false)">Save draft</button>' +
        '<button class="btn btn-p btn-sm" type="button" onclick="seqSave(\'' + n.key + '\',true)">Approve</button>' +
        (n.instantly_campaign_id ? (n.campaign_state === 'active'
          ? '<button class="btn btn-sm" type="button" onclick="campaignState(\'' + n.key + '\',\'pause\')">Pause sending</button>'
          : '<button class="btn btn-sm" type="button" onclick="campaignState(\'' + n.key + '\',\'resume\')">Resume sending</button>') : '') +
      '</div>' +
      '<div class="or-preview" id="sq-prev-' + n.key + '" style="display:none"></div>' +
    '</div>';
  }).join('') || '<div class="empty">No niches.</div>';
}

function readSteps(key) {
  const card = document.querySelector('[data-seq="' + key + '"]');
  return Array.prototype.map.call(card.querySelectorAll('.or-step-ed'), function (el, i) {
    const d = el.querySelector('.sq-delay');
    return { subject: el.querySelector('.sq-subject').value.trim(), body: el.querySelector('.sq-body').value.trim(), delay_days: i ? (parseInt(d && d.value, 10) || 3) : 0 };
  });
}
function seqKeep(key, steps) {
  const n = orCampaigns.find(function (c) { return c.key === key; });
  n.sequence = steps; n.sequence_approved_at = null;
  renderSequences();
}
function seqAdd(key) {
  const steps = readSteps(key);
  steps.push({ subject: '', delay_days: 3, body: 'Hi {first_name},\n\n\n\n{sender}' });
  seqKeep(key, steps);
}
function seqRemove(key, i) {
  const steps = readSteps(key); steps.splice(i, 1); seqKeep(key, steps);
}
async function seqPreview(key) {
  const box = $('sq-prev-' + key);
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  const { data } = await db.rpc('outreach_batch_candidates', { p_limit: 50 });
  const sample = (data || []).find(function (p) { return p.niche_key === key; }) ||
    { contact_name: 'Sam', business_name: 'Example Solar Co', suburb: 'Maroochydore' };
  const n = orCampaigns.find(function (c) { return c.key === key; });
  const all = readSteps(key);
  const steps = n && n.auto_followups === false ? all.slice(0, 1) : all;
  let day = 0;
  box.textContent = steps.map(function (st, i) {
    day += i ? st.delay_days : 0;
    return '── Email ' + (i + 1) + (i ? ' · day ' + day : ' · day 0') + ' ──\nSubject: ' + (st.subject ? renderEmail(st.subject, sample) : '(same thread)') +
      '\n\n' + renderEmail(st.body, sample) + senderFooter();
  }).join('\n\n\n');
  box.style.display = '';
}
async function seqSave(key, approve) {
  const steps = readSteps(key);
  const { error } = await db.rpc('outreach_sequence_save', { p_key: key, p_steps: steps, p_approve: !!approve });
  if (error) { toast('Could not save: ' + error.message, true); return; }
  toast(approve ? 'Approved ✓ - press Sync to Instantly' : 'Draft saved');
  const { data } = await db.rpc('outreach_campaign_list'); orCampaigns = data || orCampaigns;
  renderSequences();
}

// Follow-ups on or off for a niche. Only Email 1 reaches Instantly while off;
// the copy is untouched, so approval stands. Unsaved edits are kept on screen.
async function seqFollowups(key, on) {
  const n = orCampaigns.find(function (c) { return c.key === key; });
  const steps = readSteps(key);
  const { error } = await db.rpc('outreach_followups_set', { p_key: key, p_on: !!on });
  if (error) { toast('Could not save: ' + error.message, true); renderSequences(); return; }
  if (n) {
    n.auto_followups = !!on;
    if (JSON.stringify(steps) !== JSON.stringify(seqStepsFor(n))) n.sequence = steps;
  }
  renderSequences();
  toast((on ? 'Follow-ups on' : 'First email only') + ' ✓ - press Sync to update Instantly');
}

async function syncInstantly() {
  const btn = $('or-sync-btn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const r = await orSend('sync');
    const lines = Object.keys(r.campaigns || {}).map(function (k) {
      const n = orCampaigns.find(function (c) { return c.key === k; });
      return (n ? n.label : k) + ': ' + r.campaigns[k];
    });
    toast('Synced ✓ ' + (lines.length ? lines.join(' · ') : 'no approved sequences yet'));
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '⇅ Sync to Instantly';
    loadSending();
  }
}

async function campaignState(key, to) {
  try { await orSend(to, { niche: key }); toast(to === 'pause' ? 'Sending paused' : 'Sending resumed'); }
  catch (err) { toast(err.message, true); }
  const { data } = await db.rpc('outreach_campaign_list'); orCampaigns = data || orCampaigns;
  renderSequences();
}

async function loadOutreachEvents() {
  const host = $('or-events');
  const { data, error } = await db.rpc('outreach_event_list', { p_limit: 40 });
  if (error) { host.innerHTML = '<div class="empty">' + jmEsc(error.message) + '</div>'; return; }
  const rows = data || [];
  host.innerHTML = rows.length ? rows.map(function (e) {
    return '<div class="or-sup-item" style="flex-wrap:wrap">' +
      '<span class="or-sub" style="min-width:90px">' + jmEsc(fmtWhen(e.received_at)) + '</span>' +
      '<b style="font-size:13px">' + jmEsc(String(e.event_type).replace(/_/g, ' ')) + '</b>' +
      '<span style="flex:1;min-width:160px">' + jmEsc(e.business_name || e.lead_email || '') + '</span>' +
      '<span class="or-sub">' + jmEsc(e.handled || '') + '</span>' +
      (e.body && /repl/.test(e.event_type) ? '<div class="or-preview" style="flex-basis:100%;margin-top:4px">' + jmEsc(e.body) + '</div>' : '') +
    '</div>';
  }).join('') : '<div class="empty">Nothing yet. Sends, replies, bounces and unsubscribes show here once campaigns run.</div>';
}

// ── Today's batch ─────────────────────────────────────────────────────────
let orBatch = [];
// The result of the last Approve & send, kept on the page: the toast is gone
// in three seconds and the approved businesses leave the list, which read as
// "nothing happened".
let orLastApproval = '';

// When Instantly will next send, in words. Campaigns send Monday to Friday
// between send_from and send_to in the sender's timezone (campaignBody in
// outreach-send), so an approval outside those hours waits for the next one.
function orNextSendText(s) {
  const tz = (s && s.timezone) || 'Australia/Brisbane';
  const from = (s && s.send_from) || '08:30', to = (s && s.send_to) || '16:30';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(function (x) { return [x.type, x.value]; }));
  const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let d = NAMES.findIndex(function (n) { return n.slice(0, 3) === p.weekday.slice(0, 3); });
  const now = p.hour + ':' + p.minute;
  const isWeekday = function (x) { return x >= 1 && x <= 5; };
  const fmt = function (hm) {
    let [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
  };
  const place = tz.split('/').pop().replace(/_/g, ' ') + ' time';
  if (isWeekday(d) && now >= from && now < to) return 'Instantly is sending now, until ' + fmt(to) + ' ' + place;
  let ahead = 0;
  if (!(isWeekday(d) && now < from)) { do { d = (d + 1) % 7; ahead++; } while (!isWeekday(d)); }
  const when = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow (' + NAMES[d] + ')' : NAMES[d];
  return 'first emails go out ' + when + ' from ' + fmt(from) + ' ' + place + ' (Instantly sends Mon to Fri, ' + fmt(from) + ' to ' + fmt(to) + ')';
}

async function loadBatch() {
  const host = $('or-batch-list'), note = $('or-batch-note');
  const [candR, campR, setR] = await Promise.all([
    db.rpc('outreach_batch_candidates', { p_limit: 300 }), db.rpc('outreach_campaign_list'), db.rpc('outreach_settings_get'),
  ]);
  if (candR.error) { host.innerHTML = '<div class="empty">' + jmEsc(candR.error.message) + '</div>'; return; }
  orBatch = candR.data || [];
  orCampaigns = campR.data || [];
  orSender = setR.data || orSender;
  if (!orNiches.length) { const nr = await db.rpc('outreach_niche_list'); orNiches = nr.data || []; }
  const byKey = Object.fromEntries(orCampaigns.map(function (c) { return [c.key, c]; }));
  const targets = Object.fromEntries((orNiches.length ? orNiches : []).map(function (n) { return [n.key, Number(n.daily_target || 25)]; }));
  const ready = orCampaigns.filter(function (c) { return c.sequence_approved_at && c.instantly_campaign_id; });
  note.innerHTML = ready.length
    ? 'Sending for: ' + ready.map(function (c) { return '<b>' + jmEsc(c.label) + '</b>'; }).join(', ') + '. Each niche\'s best ' +
      'prospects are ticked up to its daily target.'
    : 'No niche is ready to send yet: write and approve its sequence, then Sync, on the <a href="#" onclick="nav(\'outreach-sending\');return false" style="color:var(--acc)">Sending</a> tab.';
  if (orLastApproval) {
    note.innerHTML = '<div style="margin-bottom:8px;padding:8px 10px;border:1px solid var(--line,rgba(127,127,127,.25));border-radius:var(--r);color:var(--ink)"><b>Last approval:</b> ' +
      jmEsc(orLastApproval) + '</div>' + note.innerHTML;
  }
  if (!orBatch.length) {
    host.innerHTML = '<div class="empty">Nobody ready for review. Run today\'s search on the Overview tab.</div>';
    $('or-batch-bar').style.display = 'none';
    return;
  }
  const taken = {};
  host.innerHTML = orBatch.map(function (p) {
    const c = byKey[p.niche_key] || {};
    taken[p.niche_key] = (taken[p.niche_key] || 0) + 1;
    const on = p.sequence_ready && taken[p.niche_key] <= (targets[p.niche_key] || 25);
    const first = (Array.isArray(c.sequence) && c.sequence[0]) || null;
    return '<div class="or-bitem' + (p.sequence_ready ? '' : ' off') + '" data-id="' + p.id + '">' +
      '<input type="checkbox" class="ob-pick" value="' + p.id + '"' + (on ? ' checked' : '') + (p.sequence_ready ? '' : ' disabled') + ' onchange="batchCount()">' +
      '<div class="main">' +
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">' +
          '<span class="or-fit' + (Number(p.fit_score) >= 6 ? ' good' : '') + '">' + Number(p.fit_score || 0) + '/10</span>' +
          '<strong>' + jmEsc(p.business_name) + '</strong>' +
          '<span class="or-sub">' + jmEsc([c.label, [p.suburb, p.state].filter(Boolean).join(' ')].filter(Boolean).join(' · ')) + '</span>' +
        '</div>' +
        '<div class="or-sub" style="margin-top:2px">' + jmEsc(p.email || '') + (p.contact_name ? ' · ' + jmEsc(p.contact_name) : '') +
          (p.email_source_url ? ' · <a href="' + orAttr(p.email_source_url) + '" target="_blank" rel="noopener" style="color:inherit">published here ↗</a>' : '') + '</div>' +
        '<div class="or-sub" style="margin-top:2px">' + jmEsc(String(p.status_reason || '').replace(/^\d+\/10:\s*/, '')) + '</div>' +
        (first ? '<button class="btn btn-xs" type="button" style="margin-top:6px" onclick="batchPreview(\'' + p.id + '\')">Preview email</button><div class="or-preview" id="ob-prev-' + p.id + '" style="display:none"></div>' : '') +
      '</div></div>';
  }).join('');
  $('or-batch-bar').style.display = '';
  batchCount();
}

function batchCount() {
  const n = document.querySelectorAll('.ob-pick:checked').length;
  setText('or-batch-count', n + ' selected');
  $('or-batch-btn').disabled = !n;
  $('or-batch-btn').textContent = n ? 'Approve & send ' + n : 'Approve & send';
}
function batchSelect(on) {
  document.querySelectorAll('.ob-pick:not(:disabled)').forEach(function (c) { c.checked = on; });
  batchCount();
}
async function saveOpener(id, v) {
  const { error } = await db.rpc('prospect_set_opener', { p_id: id, p_opener: v });
  if (error) { toast('Could not save the line: ' + error.message, true); return; }
  const p = orBatch.find(function (x) { return x.id === id; }); if (p) p.opener = v;
}
function batchPreview(id) {
  const box = $('ob-prev-' + id);
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  const p = orBatch.find(function (x) { return x.id === id; });
  const c = orCampaigns.find(function (x) { return x.key === p.niche_key; });
  const st = c.sequence[0];
  box.textContent = 'Subject: ' + renderEmail(st.subject, p) + '\n\n' + renderEmail(st.body, p) + senderFooter();
  box.style.display = '';
}

async function approveBatch() {
  const ids = Array.prototype.map.call(document.querySelectorAll('.ob-pick:checked'), function (c) { return c.value; });
  if (!ids.length) return;
  if (!confirm('Send the sequence to ' + ids.length + ' business' + (ids.length === 1 ? '' : 'es') + '?\n\n' +
    'Each is checked once more against the do-not-contact list, the pipeline and your clients. The first emails go out through Instantly over your sending hours.')) return;
  const btn = $('or-batch-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const { data, error } = await db.rpc('outreach_batch_approve', { p_ids: ids });
    if (error) throw error;
    const skipped = (data && data.skipped) || [];
    let msg = (data.queued || 0) + ' approved';
    if (data.queued) {
      const r = await orSend('push');
      const res = r.results || {};
      const uploaded = Object.values(res).reduce(function (a, v) { return a + (typeof v === 'object' && v ? Number(v.uploaded || 0) : 0); }, 0);
      const problems = Object.keys(res).filter(function (k) { return typeof res[k] === 'string'; }).map(function (k) { return k + ': ' + res[k]; });
      msg += ' · ' + uploaded + ' in Instantly' + (problems.length ? ' · ' + problems.join('; ') : '');
      if (uploaded) msg += ' · ' + orNextSendText(orSender);
    }
    if (skipped.length) msg += ' · ' + skipped.length + ' skipped (' + skipped.slice(0, 3).map(function (s) { return s.business + ': ' + s.reason; }).join('; ') + (skipped.length > 3 ? '…' : '') + ')';
    toast(msg);
    orLastApproval = msg;
  } catch (err) {
    toast('Could not send: ' + (err.message || err), true);
    orLastApproval = 'Could not send: ' + (err.message || err);
  } finally {
    loadBatch();
  }
}

// ── Cold outreach: stats ──────────────────────────────────────────────────
let ostChart = null;
let ostDaily = [];
const ostPct = function (a, b) { return b ? Math.round((1000 * a) / b) / 10 + '%' : '-'; };
const ostMoney = function (v) { return '$' + Math.round(Number(v || 0)).toLocaleString('en-AU'); };

async function loadOutreachStats() {
  const raw = $('ost-days').value;
  const days = raw ? parseInt(raw, 10) : null;
  const [fR, dR, sR] = await Promise.all([
    db.rpc('outreach_funnel', { p_days: days }),
    db.rpc('outreach_daily', { p_days: days || 90 }),
    db.rpc('outreach_spend', { p_days: days }),
  ]);
  if (fR.error) { $('ost-funnel-body').innerHTML = '<tr><td colspan="10" class="empty">' + jmEsc(fR.error.message) + '</td></tr>'; return; }
  const rows = fR.data || [];
  const sum = function (k) { return rows.reduce(function (a, r) { return a + Number(r[k] || 0); }, 0); };
  const T = { found: sum('found'), emailed: sum('emailed'), replied: sum('replied'), interested: sum('interested'), won: sum('won'), won_value: sum('won_value'), qualified: sum('qualified') };

  setText('ost-emailed', T.emailed);
  setText('ost-emailed-sub', T.qualified + ' qualified · ' + T.found + ' found');
  setText('ost-reply', T.emailed ? ostPct(T.replied, T.emailed) : '-');
  setText('ost-reply-sub', T.replied + ' replied');
  setText('ost-int', T.interested);
  setText('ost-int-sub', T.emailed ? ostPct(T.interested, T.emailed) + ' of emailed' : 'none yet');
  setText('ost-won', T.won);
  setText('ost-won-sub', T.won ? ostMoney(T.won_value) + ' closed' : 'none yet');

  const cell = function (n, of) {
    return '<td>' + Number(n) + (of != null && Number(of) ? '<div class="or-sub">' + ostPct(n, of) + '</div>' : '') + '</td>';
  };
  $('ost-funnel-body').innerHTML = rows.map(function (r) {
    return '<tr><td><strong>' + jmEsc(r.label) + '</strong></td>' +
      cell(r.found) + cell(r.with_email, r.found) + cell(r.verified, r.with_email) + cell(r.qualified, r.verified) +
      cell(r.emailed, r.qualified) + cell(r.replied, r.emailed) + cell(r.interested, r.emailed) +
      '<td>' + Number(r.won) + (Number(r.won) ? '<div class="or-sub">' + ostMoney(r.won_value) + '</div>' : '') + '</td>' +
      '<td>' + Number(r.bounced) + (Number(r.emailed) ? '<div class="or-sub" style="color:' + (r.bounced / r.emailed > 0.03 ? 'var(--red)' : 'var(--ink3)') + '">' + ostPct(r.bounced, r.emailed) + '</div>' : '') + '</td></tr>';
  }).join('') || '<tr><td colspan="10" class="empty">No niches.</td></tr>';

  ostDaily = dR.data || [];
  drawOutreachDaily();

  const sp = sR.data || {};
  $('ost-spend').innerHTML = '<div class="or-sub" style="line-height:1.7">' +
    Number(sp.runs || 0) + ' searches run · ' + Number(sp.searches || 0) + ' Google searches · ' +
    Number(sp.verified || 0) + ' emails checked · AI scoring US$' + Number(sp.ai_cost_usd || 0).toFixed(2) +
    (T.interested ? ' · about US$' + (Number(sp.ai_cost_usd || 0) / T.interested).toFixed(2) + ' of AI per interested reply' : '') + '</div>';

  loadInstantlyStats(days);
}

function drawOutreachDaily() {
  const canvas = $('chart-outreach-daily');
  if (!canvas || typeof Chart === 'undefined') return;
  if (ostChart) ostChart.destroy();
  const labels = ostDaily.map(function (d) { return new Date(d.day + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); });
  ostChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Emailed', data: ostDaily.map(function (d) { return Number(d.emailed); }), backgroundColor: CHART.cat1, hoverBackgroundColor: CHART.hover(CHART.cat1), borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: .7, barPercentage: .82 },
        { label: 'Replies', data: ostDaily.map(function (d) { return Number(d.replies); }), backgroundColor: CHART.cat2, hoverBackgroundColor: CHART.hover(CHART.cat2), borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: .7, barPercentage: .82 },
      ],
    },
    options: chartBase({ plugins: { legend: chartLegend() }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }),
  });
  $('ost-daily-table').innerHTML = '<div class="twrap" style="margin-top:10px;max-height:260px;overflow-y:auto"><table><thead><tr><th>Day</th><th>Emailed</th><th>Replies</th><th>Interested</th></tr></thead><tbody>' +
    ostDaily.slice().reverse().map(function (d) { return '<tr><td>' + jmEsc(d.day) + '</td><td>' + Number(d.emailed) + '</td><td>' + Number(d.replies) + '</td><td>' + Number(d.interested) + '</td></tr>'; }).join('') +
    '</tbody></table></div>';
}

function toggleDailyTable() {
  const t = $('ost-daily-table'), c = $('ost-chart-wrap'), b = $('ost-tbl-btn');
  const showTable = t.style.display === 'none';
  t.style.display = showTable ? '' : 'none';
  c.style.display = showTable ? 'none' : '';
  b.textContent = showTable ? 'Chart' : 'Table';
}

async function loadInstantlyStats(days) {
  const host = $('ost-instantly');
  host.innerHTML = '<div class="empty">Asking Instantly…</div>';
  setText('ost-sent', '…');
  let r;
  try { r = await orSend('stats', { days: days }); }
  catch (err) {
    host.innerHTML = '<div class="empty" style="color:var(--red)">' + jmEsc(err.message) + '</div>';
    setText('ost-sent', '-'); setText('ost-sent-sub', 'Instantly unavailable');
    return;
  }
  const camps = r.campaigns || [], accts = r.accounts || [];
  // Every email Instantly has sent across all campaigns, follow-ups included,
  // for the selected period. "Businesses Emailed" counts each business once.
  const sentTotal = camps.reduce(function (a, c) { return a + Number(c.sent || 0); }, 0);
  const reached = camps.reduce(function (a, c) { return a + Number(c.contacted || 0); }, 0);
  setText('ost-sent', sentTotal);
  setText('ost-sent-sub', 'incl. follow-ups · to ' + reached + ' business' + (reached === 1 ? '' : 'es'));
  const pill = function (t) {
    const cls = /active|warming/.test(t) ? 'good' : /paused|draft|maintenance|completed/.test(t) ? 'warn' : 'bad';
    return '<span class="or-pill ' + cls + '">' + jmEsc(t) + '</span>';
  };
  host.innerHTML =
    (camps.length
      ? camps.map(function (c) {
          const bounce = c.contacted ? c.bounced / c.contacted : 0;
          return '<div class="or-acct"><b style="min-width:130px">' + jmEsc(c.label) + '</b>' + pill(c.state) +
            '<span class="or-sub" style="flex:1;min-width:220px">' + Number(c.sent) + ' emails sent to ' + Number(c.contacted) + ' · ' +
              Number(c.replies) + ' replies (' + ostPct(c.replies, c.contacted) + ') · ' + Number(c.unsubscribed) + ' unsubscribed · ' +
              '<span style="color:' + (bounce > 0.03 ? 'var(--red)' : 'inherit') + '">' + Number(c.bounced) + ' bounced (' + ostPct(c.bounced, c.contacted) + ')</span>' +
              (c.opportunities ? ' · ' + Number(c.opportunities) + ' opportunities' : '') + '</span></div>';
        }).join('')
      : '<div class="or-sub">No campaigns yet - they appear here after the first Sync on the Sending tab.</div>') +
    '<div class="or-sub" style="margin:10px 0 6px">A niche pauses itself if more than 3% of a week\'s emails bounce (once 20 have gone), and QuoteLeadsAI tells you.</div>' +
    (accts.length
      ? accts.map(function (a) {
          return '<div class="or-acct"><span class="e">' + jmEsc(a.email) + '</span>' + pill(a.state) + pill(a.warmup) +
            (a.warmup_score != null ? '<span class="or-sub">warm-up score ' + Number(a.warmup_score) + '</span>' : '') + '</div>';
        }).join('')
      : '<div class="or-sub">No inboxes connected in Instantly yet.</div>');
}

async function openQuoteLeadsAIPosts() {
  openModal('m-quoteleadsai-posts');
  await loadQuoteLeadsAIPosts();
}

async function loadQuoteLeadsAIPosts() {
  const host = $('jp-body');
  try {
    const { data, error } = await db.rpc('quoteleadsai_post_list', { p_limit: 40 });
    if (error) throw error;
    jpPosts = data || [];
    if (!jpPosts.length) {
      host.innerHTML = '<div style="color:var(--ink3);font-size:13px;padding:6px 0">No posts yet. Ask QuoteLeadsAI: "draft a post about how fast our leads land".</div>';
      return;
    }
    host.innerHTML = jpPosts.map(function (p) {
      const st = JP_STATUS[p.status] || { label: p.status, tone: 'var(--ink3)' };
      const facts = (p.facts || []).map(function (f) {
        return '<li>' + jmEsc(f.claim) + ' <span style="color:var(--ink3)">(' + jmEsc(f.source) + ')</span></li>';
      }).join('');
      const img = p.image_url
        ? '<a href="' + jmEsc(p.image_url) + '" target="_blank" rel="noopener"><img src="' + jmEsc(p.image_url) + '" alt="" style="width:100%;border-radius:8px;border:1px solid var(--bd);display:block"></a>'
        : '<div style="aspect-ratio:4/5;border:1px dashed var(--bd);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--ink3)">No image</div>';
      const editable = p.status === 'draft' || p.status === 'approved';
      const btns = [];
      if (p.status === 'draft') {
        btns.push('<button class="btn btn-p btn-xs" type="button" onclick="approveQuoteLeadsAIPost(\'' + p.id + '\')">Approve</button>');
        btns.push('<button class="btn btn-xs" type="button" onclick="setQuoteLeadsAIPostStatus(\'' + p.id + '\',\'rejected\')">Reject</button>');
      } else {
        if (p.status === 'approved') btns.push('<button class="btn btn-xs" type="button" onclick="approveQuoteLeadsAIPost(\'' + p.id + '\')">Save caption</button>');
        btns.push('<button class="btn btn-xs" type="button" onclick="copyQuoteLeadsAIPost(\'' + p.id + '\')">Copy caption</button>');
        if (p.image_url) btns.push('<button class="btn btn-xs" type="button" onclick="downloadQuoteLeadsAIPost(\'' + p.id + '\')">Download image</button>');
        if (p.status === 'approved') btns.push('<button class="btn btn-p btn-xs" type="button" onclick="setQuoteLeadsAIPostStatus(\'' + p.id + '\',\'posted\')">Mark as posted</button>');
      }
      return '<div style="display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--bd)">' +
        '<div>' + img + '</div>' +
        '<div style="min-width:0">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;margin-bottom:6px">' +
            '<b style="color:' + st.tone + '">' + st.label + '</b>' +
            (p.editor_score != null ? '<span style="color:var(--ink3);font-family:var(--mono)">editor ' + p.editor_score + '/10</span>' : '') +
            '<span style="color:var(--ink3)">' + new Date(p.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + '</span>' +
          '</div>' +
          '<textarea class="fi" id="jp-cap-' + p.id + '" rows="7" maxlength="2200" style="width:100%;resize:vertical;font-size:13px;line-height:1.5"' + (editable ? '' : ' readonly') + '>' + jmEsc(p.caption) + '</textarea>' +
          (facts ? '<details style="margin-top:6px;font-size:12px;color:var(--ink2)"><summary style="cursor:pointer;color:var(--ink3)">Facts behind it</summary><ul style="margin:6px 0 0 16px;line-height:1.6">' + facts + '</ul></details>' : '') +
          (p.editor_notes ? '<details style="margin-top:6px;font-size:12px;color:var(--ink2)"' + (/^Editor: could be stronger/.test(p.editor_notes) ? ' open' : '') + '><summary style="cursor:pointer;color:var(--ink3)">Editor\'s notes</summary><div style="margin-top:6px;line-height:1.6;white-space:pre-wrap">' + jmEsc(p.editor_notes) + '</div></details>' : '') +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' + btns.join('') + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    host.textContent = 'Could not load posts: ' + (err.message || err);
  }
}

async function approveQuoteLeadsAIPost(id) {
  const box = $('jp-cap-' + id);
  const { error } = await db.rpc('quoteleadsai_post_approve', { p_id: id, p_caption: box ? box.value : null });
  if (error) { toast('Could not approve: ' + error.message, true); return; }
  toast('Approved ✓ - copy the caption and save the image to post it');
  loadQuoteLeadsAIPosts();
}

async function setQuoteLeadsAIPostStatus(id, status) {
  if (status === 'rejected' && !confirm('Reject this draft?')) return;
  const { error } = await db.rpc('quoteleadsai_post_set_status', { p_id: id, p_status: status });
  if (error) { toast('Could not update: ' + error.message, true); return; }
  if (status === 'posted') toast('Marked as posted ✓');
  loadQuoteLeadsAIPosts();
}

async function copyQuoteLeadsAIPost(id) {
  const box = $('jp-cap-' + id);
  try {
    await navigator.clipboard.writeText(box ? box.value : '');
    toast('Caption copied ✓');
  } catch (_) {
    if (box) { box.removeAttribute('readonly'); box.select(); }
    toast('Select all and copy', true);
  }
}

// Fetched as a blob: the download attribute is ignored across origins, and
// the images live on the storage domain.
async function downloadQuoteLeadsAIPost(id) {
  const p = jpPosts.find(function (x) { return x.id === id; });
  if (!p || !p.image_url) return;
  try {
    const blob = await (await fetch(p.image_url)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'quoteleads-post-' + id.slice(0, 8) + '.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  } catch (_) {
    window.open(p.image_url, '_blank', 'noopener');
  }
}

// ── What he knows ──────────────────────────────────────────────────────────
// Memories and jobs live in service-role-only tables; these RPCs are the one
// door in, gated to the people who run the business.
const JM_REPEAT = { once: 'once', daily: 'every day', weekdays: 'weekdays', weekly: 'every week', monthly: 'every month' };
let jmMemories = [];

function jmEsc(t) { const d = document.createElement('div'); d.textContent = String(t == null ? '' : t); return d.innerHTML; }

async function openQuoteLeadsAIMind() {
  openModal('m-quoteleadsai-mind');
  await Promise.all([loadQuoteLeadsAIJobs(), loadQuoteLeadsAIMemories()]);
}

async function loadQuoteLeadsAIJobs() {
  const host = $('jm-jobs');
  try {
    const { data, error } = await db.rpc('quoteleadsai_job_list');
    if (error) throw error;
    const jobs = data || [];
    if (!jobs.length) {
      host.innerHTML = '<div style="padding:6px 0">Nothing scheduled. Try "every weekday at 8, text me the numbers".</div>';
      return;
    }
    host.innerHTML = jobs.map(function (j) {
      const next = j.next_run_at
        ? new Date(j.next_run_at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
        : '—';
      return '<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--bd)">' +
        '<div style="flex:1;min-width:0">' +
          '<div><b style="color:var(--ink)">' + jmEsc(j.title) + '</b> <span style="font-family:var(--mono);font-size:12px">' +
            jmEsc(JM_REPEAT[j.repeat] || j.repeat) + ' · next ' + jmEsc(next) + '</span></div>' +
          '<div style="margin-top:2px;line-height:1.5;word-break:break-word">' + jmEsc(j.instruction) + '</div>' +
          (j.last_result ? '<div style="margin-top:3px;font-size:12px;line-height:1.5;word-break:break-word">Last: ' + jmEsc(j.last_result.slice(0, 200)) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-xs" type="button" onclick="cancelQuoteLeadsAIJob(\'' + j.id + '\')">Cancel</button>' +
      '</div>';
    }).join('');
  } catch (err) {
    host.textContent = 'Could not load jobs: ' + (err.message || err);
  }
}

async function cancelQuoteLeadsAIJob(id) {
  if (!confirm('Cancel this scheduled job?')) return;
  const { error } = await db.rpc('quoteleadsai_job_cancel', { p_id: id });
  if (error) { toast('Could not cancel: ' + error.message, true); return; }
  loadQuoteLeadsAIJobs();
}

async function loadQuoteLeadsAIMemories() {
  const host = $('jm-mems');
  try {
    const { data, error } = await db.rpc('quoteleadsai_memory_list');
    if (error) throw error;
    jmMemories = data || [];
    if (!jmMemories.length) {
      host.innerHTML = '<div style="padding:6px 0">Nothing yet.</div>';
      return;
    }
    host.innerHTML = jmMemories.map(function (m) {
      return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--bd)">' +
        '<input class="fi" style="flex:1;font-size:13px" maxlength="1000" value="' + jmEsc(m.content).replace(/"/g, '&quot;') + '" ' +
          'data-id="' + m.id + '" onchange="saveQuoteLeadsAIMemory(this.dataset.id, this.value)">' +
        '<button class="btn btn-xs" type="button" title="Forget" onclick="deleteQuoteLeadsAIMemory(\'' + m.id + '\')">✕</button>' +
      '</div>';
    }).join('');
  } catch (err) {
    host.textContent = 'Could not load memories: ' + (err.message || err);
  }
}

async function saveQuoteLeadsAIMemory(id, value) {
  const text = String(id ? value : $('jm-new').value).trim();
  if (!text) return;
  const { error } = await db.rpc('quoteleadsai_memory_save', { p_id: id || null, p_content: text });
  if (error) { toast('Could not save: ' + error.message, true); return; }
  if (!id) $('jm-new').value = '';
  toast(id ? 'Updated ✓' : 'QuoteLeadsAI will remember that ✓');
  loadQuoteLeadsAIMemories();
}

async function deleteQuoteLeadsAIMemory(id) {
  const m = jmMemories.find(function (x) { return x.id === id; });
  if (!confirm('Forget "' + (m ? m.content.slice(0, 80) : 'this') + '"?')) return;
  const { error } = await db.rpc('quoteleadsai_memory_delete', { p_id: id });
  if (error) { toast('Could not delete: ' + error.message, true); return; }
  loadQuoteLeadsAIMemories();
}

// Spend, as sums from quoteleadsai_usage_summary() - the rows themselves stay
// unreadable from the browser, same as quoteleadsai_events.
async function loadQuoteLeadsAISpend() {
  const host = $('js-spend');
  if (!host) return;
  const usd = function (n) {
    n = Number(n || 0);
    return 'US$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.1 ? 3 : 2 });
  };
  const row = function (label, value, sub) {
    return '<div style="display:flex;justify-content:space-between;gap:12px">' +
      '<span>' + label + '</span><span><b style="color:var(--ink)">' + value + '</b>' +
      (sub ? ' <span style="color:var(--ink3)">' + sub + '</span>' : '') + '</span></div>';
  };
  const qs = function (n) { n = Number(n || 0); return n + ' question' + (n === 1 ? '' : 's'); };
  try {
    const tz = ($('js-tz') && $('js-tz').value) || 'Australia/Sydney';
    const { data, error } = await db.rpc('quoteleadsai_usage_summary', { p_tz: tz });
    if (error) throw error;
    const d = data || {};
    const m = d.month || {}, t = d.today || {}, l = d.last_month || {}, a = d.all_time || {};
    if (!a.questions) { host.textContent = 'Nothing yet - costs are recorded from now on.'; return; }
    host.innerHTML =
      row('Today', usd(t.cost_usd), qs(t.questions)) +
      row('This month', usd(m.cost_usd), qs(m.questions)) +
      row('Average per question', usd(m.avg_per_question)) +
      row('Web searches this month', String(m.web_searches || 0)) +
      row('Last month', usd(l.cost_usd), qs(l.questions)) +
      '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);color:var(--ink3)">' +
      usd(a.cost_usd) + ' in total since ' + new Date(a.since).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + '.</div>';
  } catch (err) {
    host.textContent = 'Could not load spend: ' + (err.message || err);
  }
}

function fmtWhen(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
}

// ── QuoteLeadsAI action log ──────────────────────────────────────────────────────
// Four tables read as one sequence. The union and the authorisation both live
// in quoteleadsai_action_log(); this only has to decide what a row looks like.
//
// The rows are held in memory after loading so the filter is instant and does
// not re-query - it is at most a few hundred rows, and a log you can flick
// through is one you will actually read.
let _jlRows = [];

const QUOTELEADSAI_LOG_KINDS = {
  spotted:        { icon: '\u25CB', label: 'Spotted',      tone: 'var(--ink3)' },
  told_you:       { icon: '\u25C9', label: 'Told you',     tone: 'var(--acc)'  },
  texted_you:     { icon: '\u2709', label: 'Texted you',   tone: 'var(--acc)'  },
  called_you:     { icon: '\u260E', label: 'Called you',   tone: 'var(--acc)'  },
  you_said:       { icon: '\u203A', label: 'You said',     tone: 'var(--ink2)' },
  he_replied:     { icon: '\u25C8', label: 'He replied',   tone: 'var(--ink2)' },
  emailed_client: { icon: '\u2192', label: 'Emailed client', tone: 'var(--grn)' },
};

async function openQuoteLeadsAILog() {
  openModal('m-quoteleadsai-log');
  await loadQuoteLeadsAILog();
}

async function loadQuoteLeadsAILog() {
  const host = $('jl-body');
  host.innerHTML = '<div style="color:var(--ink3);font-size:13px">Loading\u2026</div>';
  try {
    const { data, error } = await db.rpc('quoteleadsai_action_log', { p_limit: 200 });
    if (error) throw error;
    _jlRows = data || [];
    renderQuoteLeadsAILog();
  } catch (err) {
    _jlRows = [];
    host.textContent = 'Could not load the log: ' + (err.message || err);
  }
}

function renderQuoteLeadsAILog() {
  const host = $('jl-body');
  const mode = $('jl-filter').value;

  // "Spotted" is the noisiest kind by a wide margin - one scan can raise a
  // dozen at the same second - so the default view hides it. What he DID is
  // the question this screen exists to answer; what he merely noticed is
  // already the settings panel's job.
  const rows = _jlRows.filter(function (r) {
    if (mode === 'client') return r.kind === 'emailed_client';
    if (mode === 'acted')  return r.kind !== 'spotted';
    return true;
  });

  if (!rows.length) {
    host.innerHTML = '<div style="color:var(--ink3);font-size:13px;padding:10px 0">' +
      (mode === 'client'
        ? 'He has not emailed a client yet.'
        : 'Nothing recorded yet. He logs as he goes, so this fills itself in.') +
      '</div>';
    return;
  }

  host.innerHTML = rows.map(function (r) {
    const k = QUOTELEADSAI_LOG_KINDS[r.kind] || { icon: '\u00B7', label: r.kind, tone: 'var(--ink3)' };
    const failed = r.status === 'failed';
    const when = new Date(r.at);

    // A failed row outranks its kind's colour: the whole reason to show it is
    // that something did not happen.
    const tone = failed ? 'var(--red)' : k.tone;
    const head = '<span style="color:' + tone + ';font-weight:600">' + k.icon + ' ' + esc(k.label) + '</span>' +
      (r.subject ? '<span style="color:var(--ink2)"> \u2014 ' + esc(r.subject) + '</span>' : '') +
      (failed ? '<span style="color:var(--red);font-size:12px;font-family:var(--mono)"> FAILED</span>' : '');

    const detail = r.detail
      ? '<div style="color:var(--ink3);font-size:12px;line-height:1.55;margin-top:3px;' +
        'white-space:pre-wrap;word-break:break-word">' + esc(r.detail) + '</div>'
      : '';

    // The error text, when there is one, is the most useful string on the row.
    const errText = (r.ref && r.ref.error) ? String(r.ref.error) : '';
    const errLine = failed && errText
      ? '<div style="color:var(--red);font-size:12px;font-family:var(--mono);margin-top:3px;' +
        'word-break:break-all">' + esc(errText.slice(0, 200)) + '</div>'
      : '';

    return '<div style="padding:9px 0;border-bottom:1px solid var(--bd)">' +
      '<div style="display:flex;gap:10px;align-items:baseline">' +
        '<div style="flex:1;min-width:0;font-size:13px">' + head + '</div>' +
        '<div style="font-family:var(--mono);font-size:12px;color:var(--ink3);white-space:nowrap" ' +
          'title="' + esc(when.toLocaleString()) + '">' + esc(fmtWhen(r.at)) + '</div>' +
      '</div>' + detail + errLine + '</div>';
  }).join('');
}

async function saveQuoteLeadsAISettings() {
  const btn = $('js-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    // Texts or calls switched on against a number that cannot receive them is
    // a setting that looks saved and then silently never fires.
    const raw = $('js-number').value.trim();
    const textOn = $('js-enabled').checked;
    const callOn = $('js-call-enabled').checked;
    if ((textOn || callOn) && !/^(\+?61|0)4[0-9\s\-().]{8,}$/.test(raw)) {
      throw new Error('Enter a valid Australian mobile, or switch texts and calls off.');
    }
    const num = function (id, lo, hi, dflt) {
      const n = parseInt($(id).value, 10);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    const patch = {
      quoteleadsai_content_brief: $('js-brief').value.trim() || null,
      quoteleadsai_timezone: $('js-tz').value || 'Australia/Sydney',
      quoteleadsai_notify_number: raw || null,
      quoteleadsai_notify_enabled: textOn,
      quoteleadsai_call_enabled: callOn,
      quoteleadsai_quiet_start: $('js-quiet-start').value || '20:00',
      quoteleadsai_quiet_end: $('js-quiet-end').value || '07:30',
      quoteleadsai_daily_sms_cap: num('js-cap', 0, 100, 10),
      quoteleadsai_call_cap: num('js-call-cap', 0, 20, 3),
      quoteleadsai_call_voice: $('js-call-voice').value || 'Polly.Brian-Neural',
      quoteleadsai_model: $('js-model').value || null,
    };

    const existing = await db.from('business_settings').select('id').limit(1).single();
    let error;
    if (existing.data) {
      ({ error } = await db.from('business_settings')
        .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', existing.data.id));
    } else {
      ({ error } = await db.from('business_settings').insert(patch));
    }
    if (error) throw error;
    toast(textOn || callOn ? 'QuoteLeadsAI will reach you on your phone ✓' : 'QuoteLeadsAI saved - panel only');
    closeModal('m-quoteleadsai-settings');
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

async function openTwilioSettings() {
  const s = await loadBizSettings();
  setVal('ts-from-number', s.twilio_from_number || '');
  setVal('ts-webhook-url', s.twilio_webhook_url || '');
  // Times come back as HH:MM:SS; <input type="time"> wants HH:MM.
  openModal('m-twilio-settings');
}

async function saveTwilioSettings() {
  const btn = $('ts-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const fromNum = $('ts-from-number').value.trim() || null;
    const webhookUrl = $('ts-webhook-url').value.trim() || null;

    const patch = { twilio_from_number: fromNum, twilio_webhook_url: webhookUrl };

    const existing = await db.from('business_settings').select('id').limit(1).single();
    let error;
    if (existing.data) {
      ({ error } = await db.from('business_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', existing.data.id));
    } else {
      ({ error } = await db.from('business_settings').insert(patch));
    }
    if (error) throw error;
    toast('Twilio settings saved ✓');
    closeModal('m-twilio-settings');
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}
