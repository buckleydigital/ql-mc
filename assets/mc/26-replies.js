'use strict';

// ── Cold outreach > Replies ─────────────────────────────────────────────────
// Every conversation the own engine has: the list on the left, the thread on
// the right, and a reply box. Replies go out from the same inbox, in the same
// thread (a send_reply job the mail engine picks up within a minute).

let rpFilterNow = 'all';
let rpOpen = null;
let rpTimer = null;

const RP_LABEL = {
  interested: ['Interested', 'good'], not_interested: ['Not interested', 'bad'], wrong_person: ['Wrong person', 'warn'],
  other: ['Replied', ''], auto_reply: ['Auto-reply', ''], unsubscribe: ['Unsubscribed', 'bad'], bounce: ['Bounced', 'bad'],
};
const rpWhen = function (iso) {
  if (!iso) return '';
  const d = new Date(iso), today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
};
const rpPill = function (kind, label) {
  const k = kind === 'reply' ? (label || 'other') : kind;
  const v = RP_LABEL[k] || [k, ''];
  return '<span class="or-pill ' + v[1] + '">' + jmEsc(v[0]) + '</span>';
};

function rpFilter(f) {
  rpFilterNow = f;
  document.querySelectorAll('#rp-filters button').forEach(function (b) { b.classList.toggle('btn-p', b.dataset.f === f); });
  loadReplies();
}

async function loadReplies() {
  const host = $('rp-list');
  const { data, error } = await db.rpc('mail_threads', { p_filter: rpFilterNow, p_limit: 200 });
  if (error) { host.innerHTML = '<div class="empty">' + jmEsc(error.message) + '</div>'; return; }
  const rows = data || [];
  host.innerHTML = rows.length ? rows.map(function (t) {
    const name = t.business_name || t.to_email;
    return '<div class="rp-item' + (rpOpen === t.enrolment_id ? ' on' : '') + '" onclick="rpShow(\'' + orAttr(t.enrolment_id) + '\')">' +
      '<div class="top">' + (Number(t.unread) ? '<span class="rp-dot" title="Unread"></span>' : '') +
        '<span class="nm">' + jmEsc(name) + (t.test ? ' <span class="or-sub">(test)</span>' : '') + '</span>' +
        '<span class="or-sub">' + jmEsc(rpWhen(t.last_at)) + '</span></div>' +
      '<div style="margin-top:4px;display:flex;gap:6px;align-items:center">' + rpPill(t.last_kind, t.last_label) +
        '<span class="or-sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + jmEsc(t.to_email) + '</span></div>' +
      '<div class="sn">' + jmEsc(t.last_snippet || '') + '</div>' +
    '</div>';
  }).join('') : '<div class="empty">' + (rpFilterNow === 'all' ? 'No replies yet. They show here as soon as someone writes back.' : 'Nothing here.') + '</div>';
  if (rpOpen && !rows.some(function (t) { return t.enrolment_id === rpOpen; })) rpOpen = null;
  if (!rpTimer) rpTimer = setInterval(function () { if ($('panel-outreach-replies') && $('panel-outreach-replies').classList.contains('active')) loadReplies(); }, 30000);
}

async function rpShow(id) {
  rpOpen = id;
  document.querySelectorAll('.rp-item').forEach(function (el) { el.classList.toggle('on', el.getAttribute('onclick').indexOf(id) >= 0); });
  const host = $('rp-thread');
  host.innerHTML = '<div class="empty">Loading…</div>';
  const { data: t, error } = await db.rpc('mail_thread', { p_enrolment: id });
  if (error) { host.innerHTML = '<div class="empty">' + jmEsc(error.message) + '</div>'; return; }
  const draft = (rpDrafts[id] || '');
  host.innerHTML =
    '<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:1;min-width:200px"><b style="font-size:15px">' + jmEsc(t.business_name || t.to_email) + '</b>' +
        '<div class="or-sub">' + jmEsc([t.contact_name, t.to_email, t.suburb].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="or-sub">Via ' + jmEsc(t.inbox_email || '?') + (t.website ? ' · <a href="' + orAttr(t.website) + '" target="_blank" rel="noopener" style="color:var(--acc)">website</a>' : '') +
          (t.lead_id ? ' · in the Sales Pipeline' : '') + '</div></div>' +
      (t.prospect_status ? '<span class="or-pill">' + jmEsc(String(t.prospect_status).replace(/_/g, ' ')) + '</span>' : '') +
    '</div>' +
    (t.messages || []).map(function (m) {
      const out = m.dir === 'out';
      return '<div class="rp-msg ' + (out ? 'out' : 'in') + '"><div class="hd"><b>' + (out ? (m.kind === 'reply' ? 'You replied' : 'We sent') : 'They wrote') + '</b>' +
        (out ? '' : rpPill(m.kind, m.label)) + '<span>' + jmEsc(rpWhen(m.at)) + '</span>' +
        (m.error ? '<span style="color:var(--red)">failed: ' + jmEsc(m.error) + '</span>' : '') + '</div>' +
        (m.subject ? '<div style="font-weight:600;font-size:13px;margin-bottom:4px">' + jmEsc(m.subject) + '</div>' : '') +
        '<div class="bd">' + jmEsc(m.body || '') + '</div></div>';
    }).join('') +
    (Number(t.pending_replies) ? '<div class="or-sub" style="margin:8px 0">Your reply is on its way (the engine sends within a minute).</div>' : '') +
    '<div style="margin-top:12px;border-top:1px solid var(--bd);padding-top:12px">' +
      '<textarea class="fi" id="rp-body" rows="5" placeholder="Write your reply. Your first name and the usual footer are added." oninput="rpDrafts[\'' + orAttr(id) + '\']=this.value"' +
        (t.status === 'unsubscribed' || t.prospect_status === 'unsubscribed' ? ' disabled' : '') + '>' + jmEsc(draft) + '</textarea>' +
      '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">' +
        (t.status === 'unsubscribed' || t.prospect_status === 'unsubscribed'
          ? '<span class="or-sub">They asked not to be contacted, so replying is off.</span>'
          : '<button class="btn btn-p btn-sm" type="button" id="rp-send" onclick="rpSend(\'' + orAttr(id) + '\')">Send reply</button>' +
            '<span class="or-sub">From ' + jmEsc(t.inbox_email || '') + ', in this thread.</span>') +
      '</div></div>';
  // Opening marks it read: refresh the list's dots.
  loadReplies();
}

const rpDrafts = {};

async function rpSend(id) {
  const body = ($('rp-body').value || '').trim();
  if (body.length < 2) { toast('Write a reply first', true); return; }
  const btn = $('rp-send'); btn.disabled = true; btn.textContent = 'Sending…';
  const { error } = await db.rpc('mail_reply_send', { p_enrolment: id, p_body: body });
  if (error) { toast('Could not send: ' + error.message, true); btn.disabled = false; btn.textContent = 'Send reply'; return; }
  delete rpDrafts[id];
  toast('Reply queued ✓ - goes out within a minute');
  rpShow(id);
  setTimeout(function () { if (rpOpen === id) rpShow(id); }, 75000);
}
