'use strict';

// ── Email Blast ─────────────────────────────────────────────────────────────
// A one-off custom email to pipeline leads picked by stage, niche and rep.
// Warm leads only: cold email to people who never enquired is Cold Outreach
// (Instantly), never this.
//
// The page only chooses who and what. The email-blast edge function decides
// who is actually emailed (do-not-contact, recently emailed, no address, the
// same address twice) and queues it; the quoteleadsai-outbox worker sends it a
// few at a time through send-sales-email, from the warm sales address, as each
// lead's rep, with an unsubscribe link. Preview is always the server's answer,
// so what you see is what will go.
let _ebLeads = [];        // every pipeline lead with what the filters need
let _ebPool = [];         // leads matching the filters
let _ebPreviewed = null;  // the inputs the last preview was for; Send needs a match

async function ebCall(action, payload = {}) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error('Not logged in');
  const res = await fetch(`${_ep}/functions/v1/email-blast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) throw Object.assign(new Error(out.error || ('email-blast ' + res.status)), { out });
  return out;
}

async function loadEmailBlast() {
  const box = $('eb-stages');
  if (box && !box.children.length) {
    box.innerHTML = CRM_STAGES.map(s =>
      `<label style="display:flex;gap:5px;align-items:center;cursor:pointer"><input type="checkbox" class="eb-stage" value="${esc(s.id)}" onchange="ebFilter()"> ${esc(s.label)}</label>`
    ).join('');
  }
  if (!_reps.length && typeof callRepEdge === 'function') {
    try { const r = await callRepEdge('list_reps'); _reps = r.reps || []; } catch (e) { /* rep filter just lists fewer */ }
  }
  const { data, error } = await db.from('leads').select('id,name,company,email,stage,niche,owner_id').range(0, 9999);
  if (error) { toast('Could not load leads: ' + error.message, true); return; }
  _ebLeads = data || [];

  const nsel = $('eb-niche'), nprev = nsel.value;
  const niches = [...new Set(_ebLeads.map(l => nicheKey(l.niche)).filter(Boolean))].sort();
  nsel.innerHTML = '<option value="">All niches</option>' + niches.map(n => `<option value="${esc(n)}">${esc(nicheName(n))}</option>`).join('');
  if (niches.includes(nprev)) nsel.value = nprev;

  const rsel = $('eb-rep'), rprev = rsel.value;
  rsel.innerHTML = '<option value="">All reps</option><option value="none">Unassigned</option>'
    + _reps.map(r => `<option value="${esc(r.user_id)}">${esc(r.name || r.email || '-')}</option>`).join('');
  if ([...rsel.options].some(o => o.value === rprev)) rsel.value = rprev;

  ebFilter();
  ebLoadRecent();
}

function ebFilter() {
  const stages = new Set([...document.querySelectorAll('.eb-stage:checked')].map(c => c.value));
  const niche = $('eb-niche').value, rep = $('eb-rep').value;
  _ebPool = _ebLeads.filter(l =>
    stages.has(l.stage) &&
    (!niche || nicheKey(l.niche) === niche) &&
    (!rep || (rep === 'none' ? !l.owner_id : l.owner_id === rep)));
  const xsel = $('eb-exclude');
  const keep = new Set([...xsel.selectedOptions].map(o => o.value));
  xsel.innerHTML = _ebPool.map(l =>
    `<option value="${esc(String(l.id))}"${keep.has(String(l.id)) ? ' selected' : ''}>${esc((l.name || l.company || '-') + (l.email ? ' · ' + l.email : ' · no email'))}</option>`
  ).join('');
  ebCount();
}

function ebChosen() {
  const out = new Set([...$('eb-exclude').selectedOptions].map(o => o.value));
  return _ebPool.filter(l => !out.has(String(l.id)));
}

function ebCount() {
  const chosen = ebChosen();
  setText('eb-count', chosen.length);
  const noEmail = chosen.filter(l => !(l.email || '').trim()).length;
  const left = _ebPool.length - chosen.length;
  const parts = [];
  if (left) parts.push(left + ' left out by hand');
  if (noEmail) parts.push(noEmail + ' with no email');
  setText('eb-count-note', parts.length ? '(' + parts.join(', ') + ')' : (_ebPool.length ? '' : 'tick at least one stage'));
  ebDirty();
}

function ebInputs() {
  return {
    lead_ids: ebChosen().map(l => String(l.id)),
    subject: $('eb-subject').value.trim(),
    body: $('eb-body').value.trim(),
    skip_recent_days: Number($('eb-skipdays').value),
  };
}

// Anything changed since the preview means the preview no longer describes
// what Send would do, so Send waits for a fresh one.
function ebDirty() {
  if (_ebPreviewed && JSON.stringify(ebInputs()) === _ebPreviewed) return;
  _ebPreviewed = null;
  const btn = $('eb-send-btn'); if (btn) btn.disabled = true;
  const pv = $('eb-preview'); if (pv && pv.style.display !== 'none') pv.style.opacity = '.45';
}

const EB_SKIP_LABELS = {
  no_email: 'no email address', do_not_contact: 'on the do-not-contact list', recently_emailed: 'emailed recently',
  already_queued: 'already waiting in another blast', same_email_twice: 'same email as another lead on the list',
};

async function ebPreview() {
  const inp = ebInputs();
  if (!inp.lead_ids.length) { toast('Tick at least one stage', true); return; }
  if (!inp.subject || !inp.body) { toast('Add a subject and a message', true); return; }
  const btn = $('eb-preview-btn'); btn.disabled = true; btn.textContent = 'Checking...';
  try {
    const r = await ebCall('preview', inp);
    _ebPreviewed = JSON.stringify(inp);
    const left = Object.entries(r.skipped || {}).filter(([, n]) => n)
      .map(([k, n]) => `<li>${n} ${esc(EB_SKIP_LABELS[k] || k.replace(/_/g, ' '))}${
        r.skipped_names?.[k]?.length ? ` <span style="color:var(--ink3)">(${esc(r.skipped_names[k].slice(0, 8).join(', '))}${n > 8 ? ', ...' : ''})</span>` : ''}</li>`).join('');
    const s = r.sample;
    $('eb-preview').style.opacity = '';
    $('eb-preview').style.display = '';
    $('eb-preview').innerHTML =
      `<div style="font-size:15px;margin-bottom:8px"><strong style="color:var(--acc);font-size:18px">${r.recipients}</strong> will get this email</div>` +
      (left ? `<div style="font-size:13px;color:var(--ink2);margin-bottom:10px">Left out:<ul style="margin:4px 0 0 18px">${left}</ul></div>` : '') +
      (s ? `<div style="font-size:12px;color:var(--ink3);margin-bottom:4px">As ${esc(s.name)} will see it:</div>
        <div style="background:var(--s2);border:1px solid var(--bd2);border-radius:var(--r);padding:12px 14px;font-size:13px;white-space:pre-wrap;color:var(--ink2)"><b>To:</b> ${esc(s.to)}\n<b>Subject:</b> ${esc(s.subject)}\n\n${esc(s.body)}\n\n<span style="color:var(--ink3)">--\nDon't want these emails? Unsubscribe</span></div>` : '');
    $('eb-send-btn').disabled = !r.recipients;
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Preview';
  }
}

async function ebSend() {
  const inp = ebInputs();
  if (!_ebPreviewed || JSON.stringify(inp) !== _ebPreviewed) { toast('Something changed. Preview again first.', true); return; }
  const name = $('eb-name').value.trim();
  if (!name) { toast('Give the blast a name first', true); $('eb-name').focus(); return; }
  if (!confirm(`Send "${name}" now?\n\nIt goes out over the next few minutes, a few at a time. Leads left out in the preview are not emailed. This can't be undone.`)) return;
  const btn = $('eb-send-btn'); btn.disabled = true; btn.textContent = 'Queuing...';
  try {
    const r = await ebCall('send', { ...inp, name });
    toast(`Blast queued: ${r.recipients} emails sending now ✓`);
    _ebPreviewed = null;
    $('eb-preview').style.display = 'none';
    $('eb-name').value = ''; $('eb-subject').value = ''; $('eb-body').value = '';
    await ebLoadRecent();
    ebShowDetail(r.campaign_id);
  } catch (e) {
    toast(e.message || String(e), true);
    btn.disabled = false;
  } finally {
    btn.textContent = 'Send blast';
  }
}

async function ebLoadRecent() {
  const tb = $('eb-recent'); if (!tb) return;
  try {
    const r = await ebCall('recent');
    const rows = r.blasts || [];
    tb.innerHTML = rows.length ? rows.map(b => `<tr style="cursor:pointer" onclick="ebShowDetail('${esc(b.campaign_id)}')">
        <td>${esc(b.name || '-')}</td>
        <td style="white-space:nowrap">${esc(new Date(b.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</td>
        <td>${b.sent}</td><td>${b.waiting ? `<span style="color:var(--acc)">${b.waiting}</span>` : 0}</td>
        <td>${b.skipped}</td><td>${b.failed ? `<span style="color:var(--red)">${b.failed}</span>` : 0}</td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">No blasts yet</td></tr>';
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="6" class="empty">${esc(e.message || String(e))}</td></tr>`;
  }
}

let _ebPoll = null;
async function ebShowDetail(id) {
  clearTimeout(_ebPoll);
  const box = $('eb-detail'); if (!box) return;
  try {
    const r = await ebCall('status', { campaign_id: id });
    const probs = (r.problems || []).map(p =>
      `<tr><td>${esc(p.lead || '-')}</td><td>${esc(p.email || '')}</td><td>${esc(p.status)}</td><td style="color:var(--ink3)">${esc(p.why || '')}</td></tr>`).join('');
    box.innerHTML = `<div style="font-size:13px;margin-bottom:6px"><b>${esc(r.name || '')}</b>: ${r.sent} sent, ${r.waiting} waiting, ${r.skipped} left out, ${r.failed} failed of ${r.total}</div>` +
      (probs ? `<div class="twrap"><table><thead><tr><th>Lead</th><th>Email</th><th>Status</th><th>Why</th></tr></thead><tbody>${probs}</tbody></table></div>` : '');
    // Keep it ticking while it sends, as long as this page is open.
    if (r.waiting && $('panel-emailblast')?.classList.contains('active')) {
      _ebPoll = setTimeout(() => { ebShowDetail(id); ebLoadRecent(); }, 5000);
    }
  } catch (e) {
    box.textContent = e.message || String(e);
  }
}
