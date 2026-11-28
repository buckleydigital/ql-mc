'use strict';

// ── Cold outreach > Inboxes: Mission Control's own sending engine ─────────
// The mail engine (ql-backend/mc/mail-engine, a Cloudflare Worker running every
// minute) sends from these inboxes, reads their replies and warms them up; this
// screen adds them, tests them, sends a test sequence to yourself, and manages
// warm-up. Everything approved on Today's batch is sent from here.

let miInboxes = [];
let miJobTimer = null;

const miAgo = function (iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
  return Math.round(m / 1440) + ' days ago';
};
const miTime = function (iso) {
  return iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
};

async function loadInboxes() {
  const [listR, statR, nicheR] = await Promise.all([
    db.rpc('mail_inboxes_list'), db.rpc('mail_engine_status'), db.rpc('outreach_campaign_list'),
  ]);
  if (listR.error) { $('mi-list').innerHTML = '<div class="empty">Could not load the inboxes: ' + jmEsc(listR.error.message) + '</div>'; return; }
  miInboxes = listR.data || [];
  miRenderStatus(statR.data || {});
  miRenderList();
  miRenderRecent((statR.data || {}).recent || []);
  miLoadWarmup();

  const sel = $('mi-test-inbox');
  const keep = sel.value;
  sel.innerHTML = miInboxes.filter(function (i) { return i.has_password; }).map(function (i) {
    return '<option value="' + orAttr(i.id) + '">' + jmEsc(i.email) + (i.status === 'error' ? ' (connection error)' : '') + '</option>';
  }).join('') || '<option value="">Add an inbox first</option>';
  if (keep) sel.value = keep;
  const ns = $('mi-test-niche');
  const keepN = ns.value;
  ns.innerHTML = '<option value="">A simple 3-step test</option>' + (nicheR.data || []).filter(function (n) {
    return Array.isArray(n.sequence) && n.sequence.length;
  }).map(function (n) { return '<option value="' + orAttr(n.key) + '">' + jmEsc(n.label || n.key) + ' sequence</option>'; }).join('');
  ns.value = keepN;
}

function miRenderStatus(st) {
  const seen = st.worker_seen_at ? new Date(st.worker_seen_at).getTime() : 0;
  const alive = seen && Date.now() - seen < 10 * 60000 && !st.jobs_waiting;
  $('mi-status').innerHTML =
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span class="or-pill ' + (alive ? 'good' : 'bad') + '">' + (alive ? 'Engine running' : 'Engine not running') + '</span>' +
      '<span class="or-sub">' + (alive
        ? 'Last ran ' + miAgo(st.worker_seen_at) + '.'
        : (st.jobs_waiting ? 'Tests are waiting and nothing has picked them up. ' : '') + 'Nothing sends, reads replies or warms up until the ql-mail-engine Worker is running on Cloudflare.') + '</span>' +
    '</div>' +
    '<div class="or-sub" style="margin-top:10px">' + Number(st.active || 0) + ' in a sequence' + (st.due_now ? ', ' + Number(st.due_now) + ' due now' : '') +
      '. Sends Monday to Friday inside the Sending tab\'s window, each inbox 3-8 minutes apart and up to its daily limit.</div>';
}

function miRenderList() {
  const host = $('mi-list');
  if (!miInboxes.length) {
    host.innerHTML = '<div class="or-sub" style="line-height:1.6">No inboxes yet. Add each sending inbox (Mailpool for now) with its SMTP and IMAP details, test the connection, then Start sending.</div>';
    return;
  }
  host.innerHTML = miInboxes.map(function (i) {
    const cls = i.status === 'active' ? 'good' : i.status === 'error' ? 'bad' : 'warn';
    return '<div class="or-acct" style="align-items:flex-start">' +
      '<div style="flex:1;min-width:220px">' +
        '<div class="e">' + jmEsc(i.email) + '</div>' +
        '<div class="or-sub" style="margin-top:3px">' + jmEsc(i.sender_name || 'no sender name') + ' · ' +
          Number(i.sent_today) + '/' + Number(i.daily_limit) + ' today · ' + Number(i.sent_7d) + ' sent, ' + Number(i.replies_7d) + ' replies, ' + Number(i.bounces_7d) + ' bounces (7 days)' +
          (i.active_enrolments ? ' · ' + Number(i.active_enrolments) + ' in a sequence' : '') + '</div>' +
        '<div class="or-sub" style="margin-top:3px">Connection ' + (i.last_ok_at ? 'tested ' + miAgo(i.last_ok_at) : 'not tested yet') +
          ' · replies read ' + miAgo(i.imap_checked_at) + '</div>' +
        (i.last_error ? '<div class="or-sub" style="margin-top:3px;color:var(--red)">' + jmEsc(i.last_error) + '</div>' : '') +
        '<div class="or-sub" id="mi-conn-' + orAttr(i.id) + '" style="margin-top:3px"></div>' +
      '</div>' +
      '<span class="or-pill ' + cls + '">' + jmEsc(i.status) + '</span>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn btn-sm" type="button" onclick="miTestConnection(\'' + orAttr(i.id) + '\')">Test connection</button>' +
        (i.status === 'active'
          ? '<button class="btn btn-sm" type="button" onclick="miSetStatus(\'' + orAttr(i.id) + '\',\'paused\')">Pause</button>'
          : '<button class="btn btn-sm" type="button" onclick="miSetStatus(\'' + orAttr(i.id) + '\',\'active\')">Start sending</button>') +
        '<button class="btn btn-sm" type="button" onclick="miEdit(\'' + orAttr(i.id) + '\')">Edit</button>' +
        '<button class="btn btn-sm" type="button" onclick="miDelete(\'' + orAttr(i.id) + '\')" style="color:var(--red)">Remove</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function miRenderRecent(rows) {
  const host = $('mi-recent');
  if (!rows.length) { host.innerHTML = '<div class="empty">Nothing sent or received yet.</div>'; return; }
  const word = { sent: 'Sent', reply: 'Reply', bounce: 'Bounced', auto_reply: 'Auto-reply', unsubscribe: 'Unsubscribe', unmatched: 'Other' };
  host.innerHTML = rows.slice(0, 40).map(function (r) {
    const bad = (r.kind === 'sent' && r.detail) || r.kind === 'bounce' || r.kind === 'unsubscribe';
    const good = r.kind === 'reply' && r.label === 'interested';
    return '<div class="or-run-item">' +
      '<span class="when">' + jmEsc(miTime(r.at)) + '</span>' +
      '<span class="or-pill ' + (bad ? 'bad' : good ? 'good' : '') + '">' + jmEsc(word[r.kind] || r.kind) + (r.label ? ' · ' + jmEsc(r.label.replace(/_/g, ' ')) : '') + (r.test ? ' · test' : '') + '</span>' +
      '<span style="font-family:var(--mono)">' + jmEsc(r.who || '') + '</span>' +
      '<span>' + jmEsc(r.subject || '') + '</span>' +
      (r.detail ? '<span class="or-sub"' + (r.kind === 'sent' ? ' style="color:var(--red)"' : '') + '>' + jmEsc(r.detail) + '</span>' : '') +
    '</div>';
  }).join('');
}

function miEdit(id) {
  const form = $('mi-form');
  if (id === false) { form.style.display = 'none'; $('mi-add-btn').style.display = ''; return; }
  const i = id ? miInboxes.find(function (x) { return x.id === id; }) : null;
  setVal('mi-id', i ? i.id : '');
  setVal('mi-email', i ? i.email : '');
  setVal('mi-sender', i ? i.sender_name : '');
  setVal('mi-user', i && i.username !== i.email ? i.username : '');
  setVal('mi-pass', '');
  $('mi-pass-label').textContent = i ? 'Password (blank keeps the saved one)' : 'Password';
  setVal('mi-smtp-host', i ? i.smtp_host : '');
  setVal('mi-smtp-port', i ? String(i.smtp_port) : '465');
  setVal('mi-imap-host', i ? i.imap_host : '');
  setVal('mi-imap-port', i ? i.imap_port : 993);
  setVal('mi-limit', i ? i.daily_limit : 20);
  form.style.display = '';
  $('mi-add-btn').style.display = 'none';
  $('mi-email').focus();
}

async function miSave() {
  const id = $('mi-id').value;
  const email = $('mi-email').value.trim();
  const pass = $('mi-pass').value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter the inbox email address', true); return; }
  if (!$('mi-smtp-host').value.trim() || !$('mi-imap-host').value.trim()) { toast('Enter the SMTP and IMAP servers', true); return; }
  if (!id && !pass) { toast('Enter the inbox password', true); return; }
  const smtpPort = Number($('mi-smtp-port').value);
  const p = {
    email: email, sender_name: $('mi-sender').value.trim(), username: $('mi-user').value.trim() || email,
    smtp_host: $('mi-smtp-host').value.trim(), smtp_port: smtpPort, smtp_secure: smtpPort === 465,
    imap_host: $('mi-imap-host').value.trim(), imap_port: Number($('mi-imap-port').value) || 993, imap_secure: true,
    daily_limit: Math.max(1, Math.min(100, Number($('mi-limit').value) || 20)),
  };
  if (id) p.id = id;
  if (pass) p.password = pass;
  const { data, error } = await db.rpc('mail_inbox_save', { p: p });
  setVal('mi-pass', '');
  if (error) { toast('Could not save the inbox: ' + error.message, true); return; }
  miEdit(false);
  toast('Inbox saved ✓ - testing the connection');
  await loadInboxes();
  miTestConnection(data || id);
}

async function miSetStatus(id, status) {
  const i = miInboxes.find(function (x) { return x.id === id; });
  if (status === 'active' && i && !i.last_ok_at) { toast('Test the connection first', true); return; }
  const { error } = await db.rpc('mail_inbox_save', { p: { id: id, status: status } });
  if (error) { toast('Could not change it: ' + error.message, true); return; }
  toast(status === 'active' ? 'Sending from it ✓' : 'Paused ✓');
  loadInboxes();
}

async function miDelete(id) {
  const i = miInboxes.find(function (x) { return x.id === id; });
  if (!confirm('Remove ' + (i ? i.email : 'this inbox') + '? Its sequences stop and its saved password is deleted. What it sent stays in the history.')) return;
  const { error } = await db.rpc('mail_inbox_delete', { p_id: id });
  if (error) { toast('Could not remove it: ' + error.message, true); return; }
  toast('Removed ✓');
  loadInboxes();
}

async function miSetShare(v) {
  const { error } = await db.rpc('mail_engine_share_set', { p_share: Number(v) });
  if (error) { toast('Could not save: ' + error.message, true); return; }
  toast(Number(v) ? v + '% of each batch now sends from here ✓' : 'All sending back on Instantly ✓');
}

/** Waits for a worker job, calling back with its state each time it changes. */
async function miWatchJob(id, onUpdate, untilDone) {
  clearTimeout(miJobTimer);
  const started = Date.now();
  const tick = async function () {
    const { data } = await db.rpc('mail_job_get', { p_id: id });
    const keepGoing = data && onUpdate(data, Date.now() - started) !== false;
    if (keepGoing && Date.now() - started < (untilDone ? 120000 : 3 * 3600000)) miJobTimer = setTimeout(tick, untilDone ? 2000 : 8000);
  };
  tick();
}

async function miTestConnection(id) {
  const out = $('mi-conn-' + id);
  if (out) out.textContent = 'Testing…';
  const { data, error } = await db.rpc('mail_job_create', { p_kind: 'test_connection', p_payload: { inbox_id: id } });
  if (error) { toast('Could not start the test: ' + error.message, true); return; }
  miWatchJob(data, function (j, ms) {
    const el = $('mi-conn-' + id);
    if (j.status === 'pending' || j.status === 'running') {
      if (el) el.textContent = ms > 30000 && j.status === 'pending' ? 'Waiting for the mail worker - is it running?' : 'Testing…';
      return true;
    }
    if (j.status === 'error') { toast('Test failed: ' + ((j.result || {}).error || ''), true); loadInboxes(); return false; }
    const r = j.result || {};
    toast(r.ok ? 'Connected ✓ - sending and reading both work' : 'Not connected - see the inbox for why', !r.ok);
    loadInboxes().then(function () {
      const e2 = $('mi-conn-' + id);
      if (e2) e2.innerHTML = 'Sending (SMTP): <b style="color:' + (r.smtp === 'ok' ? 'var(--grn)' : 'var(--red)') + '">' + jmEsc(r.smtp) + '</b> · Reading (IMAP): <b style="color:' + (r.imap === 'ok' ? 'var(--grn)' : 'var(--red)') + '">' + jmEsc(r.imap) + '</b>';
    });
    return false;
  }, true);
}

async function miTestSequence() {
  const to = $('mi-test-to').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { toast('Enter the address to send the test to', true); return; }
  if (miInboxes.some(function (i) { return i.email === to.toLowerCase(); })) { toast('Use an address that is not one of the sending inboxes', true); return; }
  const inbox = $('mi-test-inbox').value;
  if (!inbox) { toast('Add an inbox first', true); return; }
  const { data, error } = await db.rpc('mail_job_create', { p_kind: 'test_sequence', p_payload: {
    to_email: to, inbox_id: inbox, niche_key: $('mi-test-niche').value || null,
    minutes_between: Math.max(1, Math.min(60, Number($('mi-test-mins').value) || 3)),
  } });
  if (error) { toast('Could not start the test: ' + error.message, true); return; }
  toast('Test started - step 1 goes in a few seconds');
  miWatchJob(data, miRenderTest, false);
}

function miRenderTest(j, ms) {
  const host = $('mi-test-out');
  if (!host) return false;
  if (j.status === 'pending' || j.status === 'running') {
    host.innerHTML = '<div class="or-sub">' + (ms > 30000 && j.status === 'pending' ? 'Waiting for the mail worker - is it running?' : 'Starting…') + '</div>';
    return true;
  }
  if (j.status === 'error') { host.innerHTML = '<div class="or-sub" style="color:var(--red)">' + jmEsc((j.result || {}).error || 'The test failed') + '</div>'; return false; }
  const e = j.enrolment || {};
  const sends = j.sends || [];
  const inbound = j.inbound || [];
  const done = e.status && e.status !== 'active';
  const what = {
    active: 'Running', finished: 'Finished: every step sent, no reply seen', replied: 'Stopped: your reply was picked up',
    unsubscribed: 'Stopped: unsubscribe picked up', bounced: 'Stopped: bounced', failed: 'Failed', stopped: 'Stopped',
  };
  host.innerHTML =
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">' +
      '<span class="or-pill ' + (e.status === 'active' ? 'warn' : e.status === 'failed' || e.status === 'bounced' ? 'bad' : 'good') + '">' + jmEsc(what[e.status] || e.status || '') + '</span>' +
      '<span class="or-sub">' + jmEsc((j.result || {}).from || '') + ' → ' + jmEsc(e.to_email || '') + ' · ' + sends.filter(function (s) { return !s.error; }).length + ' of ' + Number(e.steps || 0) + ' sent' +
        (e.status === 'active' && e.next_send_at ? ' · next ' + jmEsc(miTime(e.next_send_at)) : '') + '</span>' +
    '</div>' +
    (e.last_error ? '<div class="or-sub" style="color:var(--red);margin-bottom:6px">' + jmEsc(e.last_error) + '</div>' : '') +
    sends.map(function (s) {
      return '<div class="or-run-item"><span class="when">' + jmEsc(miTime(s.sent_at)) + '</span><span class="or-pill' + (s.error ? ' bad' : '') + '">Step ' + (Number(s.step) + 1) + '</span><span>' + jmEsc(s.subject || '') + '</span>' +
        (s.error ? '<span class="or-sub" style="color:var(--red)">' + jmEsc(s.error) + '</span>' : '') + '</div>';
    }).join('') +
    inbound.map(function (m) {
      return '<div class="or-run-item"><span class="when">' + jmEsc(miTime(m.received_at)) + '</span><span class="or-pill ' + (m.label === 'interested' ? 'good' : m.kind === 'bounce' || m.kind === 'unsubscribe' ? 'bad' : 'warn') + '">' +
        jmEsc(m.kind.replace(/_/g, ' ')) + (m.label ? ' · AI: ' + jmEsc(m.label.replace(/_/g, ' ')) : '') + '</span><span>' + jmEsc(m.body || '') + '</span><span class="or-sub">' + jmEsc(m.handled || '') + '</span></div>';
    }).join('') +
    (!done ? '<div class="or-sub" style="margin-top:6px">Replies are read every 30 seconds while a test runs.</div>' : '');
  // Keep watching a little after it stops, in case the reply is still being read.
  return !done || inbound.length === 0 && e.status === 'finished' && ms < 20 * 60000;
}


// ── Warm-up ─────────────────────────────────────────────────────────────────
async function miLoadWarmup() {
  const { data, error } = await db.rpc('mail_warmup_view');
  if (error) { $('mi-seeds').innerHTML = '<div class="empty">' + jmEsc(error.message) + '</div>'; return; }
  const seeds = (data && data.seeds) || [], rows = (data && data.inboxes) || [];
  $('mi-seeds').innerHTML = seeds.length ? seeds.map(function (s) {
    return '<div class="or-acct">' +
      '<span class="e" style="flex:1">' + jmEsc(s.email) + '</span>' +
      (s.last_error ? '<span class="or-sub" style="color:var(--red)">' + jmEsc(s.last_error) + '</span>' : '') +
      '<span class="or-pill ' + (s.warmup ? 'good' : 'warn') + '">' + (s.warmup ? 'on' : 'off') + '</span>' +
      '<button class="btn btn-sm" type="button" onclick="miSeedToggle(\'' + orAttr(s.id) + '\',' + (!s.warmup) + ')">' + (s.warmup ? 'Turn off' : 'Turn on') + '</button>' +
      '<button class="btn btn-sm" type="button" style="color:var(--red)" onclick="miSeedDelete(\'' + orAttr(s.id) + '\')">Remove</button>' +
    '</div>';
  }).join('') : '<div class="or-sub">No warm-up accounts yet. Add 2-3 Gmail addresses: until then inboxes only warm up with each other.</div>';
  $('mi-warm').innerHTML = rows.length ? '<div class="twrap"><table><thead><tr>' +
    '<th style="text-align:left">Inbox</th><th>Today</th><th>Landed in inbox (7 days)</th><th>Spam</th><th>Missing</th><th>Replies back</th><th></th></tr></thead><tbody>' +
    rows.map(function (w) {
      const seen = Number(w.inbox_7d) + Number(w.spam_7d) + Number(w.missing_7d);
      const pct = seen ? Math.round((Number(w.inbox_7d) / seen) * 100) : null;
      return '<tr><td style="font-family:var(--mono)">' + jmEsc(w.email) + '</td>' +
        '<td style="text-align:center">' + Number(w.sent_today) + '/' + Number(w.warm_daily) + '</td>' +
        '<td style="text-align:center">' + (pct === null ? '<span class="or-sub">-</span>' : '<span class="or-pill ' + (pct >= 90 ? 'good' : pct >= 70 ? 'warn' : 'bad') + '">' + pct + '%</span>') + '</td>' +
        '<td style="text-align:center">' + Number(w.spam_7d) + '</td><td style="text-align:center">' + Number(w.missing_7d) + '</td><td style="text-align:center">' + Number(w.replies_7d) + '</td>' +
        '<td style="text-align:right"><button class="btn btn-sm" type="button" onclick="miWarmToggle(\'' + orAttr(w.id) + '\',' + (!w.warmup) + ')">' + (w.warmup ? 'Pause warm-up' : 'Resume warm-up') + '</button></td></tr>';
    }).join('') + '</tbody></table></div>' : '';
}

function miSeedForm(show) {
  $('mi-seed-form').style.display = show ? '' : 'none';
  if (show) { $('mi-seed-email').value = ''; $('mi-seed-pass').value = ''; $('mi-seed-email').focus(); }
}

async function miSeedSave() {
  const email = $('mi-seed-email').value.trim(), pass = $('mi-seed-pass').value.replace(/\s+/g, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !pass) { toast('Enter the Gmail address and its app password', true); return; }
  const { error } = await db.rpc('mail_seed_save', { p: { label: 'Gmail', email: email, imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com', password: pass } });
  if (error) { toast('Could not save: ' + error.message, true); return; }
  toast('Warm-up account added ✓');
  miSeedForm(false); miLoadWarmup();
}

async function miSeedToggle(id, on) {
  const { error } = await db.rpc('mail_seed_save', { p: { id: id, warmup: on } });
  if (error) { toast(error.message, true); return; }
  miLoadWarmup();
}

async function miSeedDelete(id) {
  if (!confirm('Remove this warm-up account? Its password is deleted too.')) return;
  const { error } = await db.rpc('mail_seed_delete', { p_id: id });
  if (error) { toast(error.message, true); return; }
  miLoadWarmup();
}

async function miWarmToggle(id, on) {
  const { error } = await db.rpc('mail_warmup_set', { p_inbox: id, p_on: on });
  if (error) { toast(error.message, true); return; }
  miLoadWarmup();
}
