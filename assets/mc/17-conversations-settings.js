'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// CONVERSATIONS - SMS inbox (inbound + outbound) grouped by lead
// ══════════════════════════════════════════════════════════════════════════════

let _convWebhookUrl = '';
function copyConvWebhook() {
  if (_convWebhookUrl) navigator.clipboard.writeText(_convWebhookUrl).then(() => toast('Copied ✓'));
}

async function loadConversations() {
  const tbody = $('conv-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';

  // Fetch webhook URL from business_settings (authenticated, never in page source)
  try {
    const { data: biz } = await db.from('business_settings').select('twilio_webhook_url').limit(1).maybeSingle();
    _convWebhookUrl = biz?.twilio_webhook_url || '';
    const display = $('conv-webhook-display');
    if (display) {
      display.textContent = _convWebhookUrl || 'Not set - save via ⚙ Twilio Settings';
      display.style.color = _convWebhookUrl ? 'var(--acc)' : 'var(--ink3)';
    }
  } catch (_) {}

  try {
    // Pull all SMS log entries joined with lead info, ordered newest first
    const { data, error } = await db
      .from('lead_sms_log')
      .select('*, ppl_leads(name, phone)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Only real PPL conversations (rows tied to a ppl_lead). Rows with a null
    // lead_id are stray inbound messages from numbers that are not PPL leads
    // (e.g. an agency reply that was mis-delivered here instead of ql-hq); they
    // must not be grouped/opened or the thread view passes "" as a uuid and errors.
    const rows = (data || []).filter(r => r.lead_id);

    // Group by lead_id
    const byLead = {};
    rows.forEach(r => {
      if (!byLead[r.lead_id]) {
        byLead[r.lead_id] = {
          lead_id: r.lead_id,
          name: r.ppl_leads?.name || '-',
          phone: r.ppl_leads?.phone || r.to_number || '-',
          messages: [],
        };
      }
      byLead[r.lead_id].messages.push(r);
    });

    const threads = Object.values(byLead);
    const totalInbound  = rows.filter(r => (r.direction || 'outbound') === 'inbound').length;
    const totalOutbound = rows.filter(r => (r.direction || 'outbound') === 'outbound').length;

    setText('conv-threads',       threads.length);
    setText('conv-inbound-count', totalInbound);
    setText('conv-outbound-count', totalOutbound);

    // Update sidebar badge (inbound messages with no outbound reply after them)
    const badge = $('conv-unread-badge');
    if (badge) {
      if (totalInbound > 0) {
        badge.textContent = totalInbound;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    if (!threads.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty">No SMS conversations yet. Send an SMS from PPL Lead Distribution to start a thread.</td></tr>';
      return;
    }

    if (tbody) {
      tbody.innerHTML = threads.map(t => {
        const lastMsg = t.messages[0];
        const lastBody = lastMsg ? (lastMsg.message || '').substring(0, 60) + (lastMsg.message?.length > 60 ? '…' : '') : '-';
        const lastTime = lastMsg ? fmtDate(lastMsg.created_at, true) : '-';
        const inCount  = t.messages.filter(m => (m.direction || 'outbound') === 'inbound').length;
        const outCount = t.messages.filter(m => (m.direction || 'outbound') === 'outbound').length;
        const dirBadge = inCount > 0
          ? `<span class="badge bg-blu" style="font-size:12px">${inCount} in</span> `
          : '';
        return `<tr>
          <td><strong>${esc(t.name)}</strong></td>
          <td style="font-family:var(--mono);font-size:12px">${esc(t.phone)}</td>
          <td style="font-family:var(--mono);font-size:12px">${dirBadge}<span style="color:var(--ink3)">${outCount} out</span></td>
          <td style="font-size:12px;color:var(--ink2);max-width:220px;white-space:pre-wrap;word-break:break-word">${esc(lastBody)}</td>
          <td style="font-family:var(--mono);font-size:12px;color:var(--ink3);white-space:nowrap">${lastTime}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-xs" onclick="openConvThread('${esc(t.lead_id)}','${esc(t.name)}','${esc(t.phone)}')">View Thread</button>
            <button class="btn btn-xs" onclick="deleteConversation('${esc(t.lead_id)}','${esc(t.name)}')" style="background:var(--red-fill);color:#fff">Delete</button>
          </td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty" style="color:var(--red)">Error: ${esc(err.message)}</td></tr>`;
  }
}

async function deleteConversation(leadId, name) {
  if (!confirm(`Delete the entire conversation with ${name || 'this lead'}?\n\nThis permanently removes all SMS messages in this thread.`)) return;
  const { error } = await db.from('lead_sms_log').delete().eq('lead_id', leadId);
  if (error) { toast('Delete failed: ' + error.message, true); return; }
  toast('Conversation deleted ✓');
  loadConversations();
}

async function loadSalesConversations() {
  const tbody = $('sales-conv-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';

  try {
    const { data: biz } = await db.from('business_settings').select('twilio_webhook_url').limit(1).maybeSingle();
    const webhookUrl = biz?.twilio_webhook_url || '';
    const display = $('sales-conv-webhook-display');
    if (display) {
      display.textContent = webhookUrl || 'Not set - save via ⚙ Twilio Settings';
      display.style.color = webhookUrl ? 'var(--acc)' : 'var(--ink3)';
    }
  } catch (_) {}

  try {
    const { data, error } = await db
      .from('sales_sms_log')
      .select('*, leads(name, phone, sms_opted_out)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows = data || [];

    const byLead = {};
    rows.forEach(r => {
      if (!byLead[r.lead_id]) {
        byLead[r.lead_id] = {
          lead_id: r.lead_id,
          name: r.leads?.name || '-',
          phone: r.leads?.phone || r.to_number || '-',
          optedOut: r.leads?.sms_opted_out === true,
          messages: [],
        };
      }
      byLead[r.lead_id].messages.push(r);
    });

    const threads = Object.values(byLead);
    const totalInbound  = rows.filter(r => (r.direction || 'outbound') === 'inbound').length;
    const totalOutbound = rows.filter(r => (r.direction || 'outbound') === 'outbound').length;

    setText('sales-conv-threads',       threads.length);
    setText('sales-conv-inbound-count', totalInbound);
    setText('sales-conv-outbound-count', totalOutbound);

    if (!threads.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty">No SMS conversations yet. Send an SMS from a sales pipeline lead to start a thread.</td></tr>';
      return;
    }

    if (tbody) {
      tbody.innerHTML = threads.map(t => {
        const lastMsg = t.messages[0];
        const lastBody = lastMsg ? (lastMsg.message || '').substring(0, 60) + (lastMsg.message?.length > 60 ? '…' : '') : '-';
        const lastTime = lastMsg ? fmtDate(lastMsg.created_at, true) : '-';
        const inCount  = t.messages.filter(m => (m.direction || 'outbound') === 'inbound').length;
        const outCount = t.messages.filter(m => (m.direction || 'outbound') === 'outbound').length;
        const dirBadge = inCount > 0 ? `<span class="badge bg-blu" style="font-size:12px">${inCount} in</span> ` : '';
        const stopBadge = t.optedOut ? ' <span class="badge bg-red" style="font-size:12px" title="Replied STOP - do not SMS">STOP</span>' : '';
        return `<tr${t.optedOut ? ' style="opacity:.72"' : ''}>
          <td><strong>${esc(t.name)}</strong>${stopBadge}</td>
          <td style="font-family:var(--mono);font-size:12px">${esc(t.phone)}</td>
          <td style="font-family:var(--mono);font-size:12px">${dirBadge}<span style="color:var(--ink3)">${outCount} out</span></td>
          <td style="font-size:12px;color:var(--ink2);max-width:220px;white-space:pre-wrap;word-break:break-word">${esc(lastBody)}</td>
          <td style="font-family:var(--mono);font-size:12px;color:var(--ink3);white-space:nowrap">${lastTime}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-xs" onclick="openSalesConvThread('${esc(t.lead_id)}','${esc(t.name)}','${esc(t.phone)}')">View Thread</button>
            ${IS_REP ? '' : `<button class="btn btn-xs" onclick="deleteSalesConversation('${esc(t.lead_id)}','${esc(t.name)}')" style="background:var(--red-fill);color:#fff">Delete</button>`}
          </td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty" style="color:var(--red)">Error loading sales conversations: ${esc(err.message)}</td></tr>`;
  }
}

async function deleteSalesConversation(leadId, name) {
  if (!confirm(`Delete the entire conversation with ${name || 'this lead'}?\n\nThis permanently removes all SMS messages in this thread.`)) return;
  const { error } = await db.from('sales_sms_log').delete().eq('lead_id', leadId);
  if (error) { toast('Delete failed: ' + error.message, true); return; }
  toast('Conversation deleted ✓');
  loadSalesConversations();
}

function copySalesConvWebhook() {
  const url = $('sales-conv-webhook-display')?.textContent || '';
  if (!url || url === 'Not set - save via ⚙ Twilio Settings') { toast('No webhook URL set', true); return; }
  navigator.clipboard.writeText(url).then(() => toast('Webhook URL copied')).catch(() => toast('Copy failed', true));
}

async function openSalesConvThread(leadId, leadName, leadPhone) {
  $('conv-thread-lead-id').value  = leadId;
  $('conv-thread-phone').value    = leadPhone;
  $('conv-thread-name').value     = leadName;
  $('conv-thread-source').value   = 'sales';
  // Reps are view-only: hide the reply box + send button in sales threads.
  if ($('conv-reply-wrap')) $('conv-reply-wrap').style.display = IS_REP ? 'none' : '';
  if ($('conv-reply-btn'))  $('conv-reply-btn').style.display  = IS_REP ? 'none' : '';
  $('conv-thread-title').textContent = leadName || 'Conversation';
  $('conv-thread-sub').textContent = leadPhone || '';
  $('conv-reply-body').value = '';
  updateConvReplyCounter();

  const container = $('conv-thread-messages');
  container.innerHTML = '<div class="empty">Loading…</div>';
  openModal('m-conv-thread');

  try {
    const { data, error } = await db
      .from('sales_sms_log')
      .select('*')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const msgs = data || [];
    container.innerHTML = msgs.length
      ? msgs.map(m => {
          const isIn = (m.direction || 'outbound') === 'inbound';
          return `<div style="display:flex;flex-direction:column;align-items:${isIn ? 'flex-start' : 'flex-end'}">
            <div style="max-width:80%;background:${isIn ? 'var(--s2)' : 'var(--acc)'};color:${isIn ? 'var(--ink)' : '#fff'};border-radius:10px;padding:8px 12px;font-size:13px">${esc(m.message || '')}</div>
            <div style="font-size:12px;color:var(--ink3);margin-top:2px">${isIn ? 'Inbound' : 'Outbound'} · ${fmtDate(m.created_at, true)}</div>
          </div>`;
        }).join('')
      : '<div class="empty">No messages yet.</div>';
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<div class="empty" style="color:var(--red)">Error: ${esc(err.message)}</div>`;
  }
}

async function openConvThread(leadId, leadName, leadPhone) {
  if (!leadId) { toast('This message is not linked to a PPL lead, so it has no thread.'); return; }
  $('conv-thread-lead-id').value  = leadId;
  $('conv-thread-phone').value    = leadPhone;
  $('conv-thread-name').value     = leadName;
  $('conv-thread-source').value   = 'ppl';
  // PPL threads are full-user only; ensure the reply box is visible.
  if ($('conv-reply-wrap')) $('conv-reply-wrap').style.display = '';
  if ($('conv-reply-btn'))  $('conv-reply-btn').style.display  = '';
  $('conv-thread-title').textContent = leadName || 'Conversation';
  $('conv-thread-sub').textContent = leadPhone || '';
  $('conv-reply-body').value = '';
  updateConvReplyCounter();

  const container = $('conv-thread-messages');
  container.innerHTML = '<div class="empty">Loading…</div>';
  openModal('m-conv-thread');

  const { data, error } = await db
    .from('lead_sms_log')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });

  if (error) {
    container.innerHTML = `<div class="empty" style="color:var(--red)">Error: ${esc(error.message)}</div>`;
    return;
  }

  const msgs = data || [];
  if (!msgs.length) {
    container.innerHTML = '<div class="empty">No messages yet.</div>';
    return;
  }

  container.innerHTML = msgs.map(m => {
    const isInbound = (m.direction || 'outbound') === 'inbound';
    const align    = isInbound ? 'flex-start' : 'flex-end';
    const bubbleBg = isInbound ? 'var(--s3)' : 'var(--acc)';
    const bubbleClr= isInbound ? 'var(--ink)' : '#fff';
    const label    = isInbound ? 'Lead' : (m.sent_by || 'You');
    const time     = fmtDate(m.created_at, true);
    return `<div style="display:flex;flex-direction:column;align-items:${align};gap:2px;max-width:100%">
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink3);padding:0 4px">${esc(label)} · ${time}</div>
      <div style="background:${bubbleBg};color:${bubbleClr};border-radius:10px;padding:8px 12px;max-width:82%;font-size:13px;line-height:1.5;word-break:break-word">${esc(m.message || '')}</div>
    </div>`;
  }).join('');

  // Scroll to bottom of thread
  container.scrollTop = container.scrollHeight;
}

function updateConvReplyCounter() {
  const body = $('conv-reply-body')?.value || '';
  const el = $('conv-reply-counter');
  if (el) {
    el.textContent = body.length + ' / 160';
    el.style.color = body.length > 160 ? 'var(--red)' : 'var(--ink3)';
  }
}

async function sendConvReply() {
  const btn    = $('conv-reply-btn');
  const body   = $('conv-reply-body').value.trim();
  const phone  = $('conv-thread-phone').value;
  const leadId = $('conv-thread-lead-id').value;
  const source = $('conv-thread-source').value || 'ppl';
  if (!body) { toast('Enter a message first', true); return; }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Not logged in');
    const res = await fetch(`${_ep}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ to: phone, message: body, lead_id: leadId, source })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'SMS failed');
    toast('Reply sent ✓');
    $('conv-reply-body').value = '';
    updateConvReplyCounter();
    const name = $('conv-thread-name').value;
    if (source === 'sales') {
      await openSalesConvThread(leadId, name, phone);
      loadSalesConversations();
    } else {
      await openConvThread(leadId, name, phone);
      loadConversations();
    }
  } catch (err) {
    toast('Send failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Reply';
  }
}

// ── Twilio Settings (standalone modal, also reachable from Conversations panel) ──

// ── AI SMS Agent (the agency's own agent, stored on ql-hq) ─────────────────
// Read and written through the existing callHq helper, so this uses the same
// sync-to-hq path as every other cross-product call rather than a second one.
// The rep check is server-side; the button is also behind admin-only-field, but
// a hidden button is not a restriction.
let _agentCfg = null;

async function openAgentSettings() {
  openModal('m-agent-settings');
  $('ag-loading').style.display = '';
  $('ag-body').style.display = 'none';
  try {
    const out = await callHq('get_sms_agent_config', {});
    _agentCfg = out.config || {};
    const c = _agentCfg;
    $('ag-sub').textContent = (c.agent_name || 'The agent') +
      ' · replies to sales-pipeline leads' + (c.twilio_number ? ' from ' + c.twilio_number : '');
    setVal('ag-name', c.agent_name || '');
    setVal('ag-max-words', c.max_sms_words != null ? c.max_sms_words : '');
    setVal('ag-delay', c.reply_delay_seconds != null ? c.reply_delay_seconds : '');
    setVal('ag-followup-days', c.days_until_followup != null ? c.days_until_followup : '');
    setVal('ag-welcome', c.welcome_message || '');
    setVal('ag-followup', c.followup_message || '');
    setVal('ag-ooh-msg', c.out_of_hours_msg || '');
    setVal('ag-prompt', c.system_prompt || '');
    $('ag-active').checked = c.is_active === true;
    $('ag-auto-reply').checked = c.auto_reply === true;
    $('ag-nurture').checked = c.ai_nurture_enabled === true;
    $('ag-ooh').checked = c.out_of_hours_only === true;
    $('ag-updated').textContent = c.updated_at ? 'Last saved ' + fmtDate(c.updated_at, true) : '';
    updateAgentPromptCount();
    $('ag-prompt').oninput = updateAgentPromptCount;
    $('ag-loading').style.display = 'none';
    $('ag-body').style.display = '';
  } catch (err) {
    $('ag-loading').textContent = 'Could not load the agent: ' + err.message;
  }
}

function updateAgentPromptCount() {
  const n = ($('ag-prompt').value || '').length;
  $('ag-prompt-count').textContent = n.toLocaleString() + ' characters';
}

async function saveAgentSettings() {
  const btn = $('ag-save-btn');
  const prompt = $('ag-prompt').value.trim();
  // Saving an empty prompt would leave the agent with no brief at all, which is
  // worse than any wording. Blocked rather than silently accepted.
  if (!prompt) { toast('The system prompt cannot be empty', true); return; }
  if ($('ag-active').checked && !_agentCfg.is_active &&
      !confirm('Switch the agent on? It will start texting new sales-pipeline leads.')) return;

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : parseInt(v, 10); };
    const patch = {
      agent_name:          $('ag-name').value.trim(),
      system_prompt:       prompt,
      welcome_message:     $('ag-welcome').value.trim(),
      followup_message:    $('ag-followup').value.trim(),
      out_of_hours_msg:    $('ag-ooh-msg').value.trim(),
      is_active:           $('ag-active').checked,
      auto_reply:          $('ag-auto-reply').checked,
      ai_nurture_enabled:  $('ag-nurture').checked,
      out_of_hours_only:   $('ag-ooh').checked,
    };
    const mw = num('ag-max-words');       if (mw !== undefined) patch.max_sms_words = mw;
    const dl = num('ag-delay');           if (dl !== undefined) patch.reply_delay_seconds = dl;
    const fd = num('ag-followup-days');   if (fd !== undefined) patch.days_until_followup = fd;

    await callHq('update_sms_agent_config', { patch });

    // Write the mirror through immediately. jarvis-notify refreshes it every
    // 15 minutes anyway, but until it does QuoteLeadsAI would still be reasoning
    // about the old setting - and the one moment you are most likely to ask
    // him about Don is just after changing him. Best effort: the save itself
    // has already succeeded, so a failed mirror write must not report failure.
    try {
      const { data: bs } = await db.from('business_settings').select('id').limit(1).maybeSingle();
      if (bs?.id) {
        await db.from('business_settings').update({
          don_enabled:   patch.auto_reply === true,
          don_active:    patch.is_active === true,
          don_synced_at: new Date().toISOString(),
        }).eq('id', bs.id);
      }
    } catch (e) { console.warn('Don mirror write-through failed:', e); }

    toast('Agent saved ✓');
    closeModal('m-agent-settings');
  } catch (err) {
    toast('Save failed: ' + err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ── QuoteLeadsAI settings ────────────────────────────────────────────────────────
// His own screen, opened from his own panel. What he watches and when he may
// interrupt is not a Twilio concern; SMS is just the channel he reaches you on.
const JARVIS_WATCH_LABELS = {
  proposal_cold:      'Proposals going cold',
  followup_overdue:   'Follow-up dates gone past',
  don_off:            'AI SMS off while leads wait',
  fulfilment_overdue: 'Onboarding past its SLA',
  fulfilment_blocked: 'Fulfilment blocked',
};

// The device's own voices. getVoices() is famously empty on first call, so if
// it comes back empty the list is rebuilt when the browser fires the event.
function fillWebVoicePicker() {
  const sel = $('js-web-voice');
  if (!sel || typeof JV === 'undefined' || !JV.listVoices) return;
  const voices = JV.listVoices();
  let saved = null;
  try { saved = localStorage.getItem('jv-voice'); } catch (_) {}
  const auto = JV.currentVoice();
  sel.innerHTML = '<option value="">Auto' + (auto ? ' - currently ' + esc(auto) : '') + '</option>'
    + voices.map(v => `<option value="${esc(v.name)}"${v.name === saved ? ' selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  if (!voices.length) {
    sel.innerHTML = '<option value="">No voices available on this device</option>';
    if (window.speechSynthesis) {
      speechSynthesis.addEventListener('voiceschanged', fillWebVoicePicker, { once: true });
    }
  }
  // Applied on change rather than on Save: this is a per-device browser
  // preference, not part of the settings row that Save writes to the database.
  sel.onchange = () => { JV.setVoiceByName(sel.value); JV.sampleVoice(); };
}

async function openJarvisSettings() {
  fillWebVoicePicker();
  const s = await loadBizSettings();
  setVal('js-brief', s.jarvis_content_brief || '');
  setVal('js-number', s.jarvis_notify_number || '');
  $('js-enabled').checked = s.jarvis_notify_enabled === true;
  $('js-call-enabled').checked = s.jarvis_call_enabled === true;
  setVal('js-quiet-start', String(s.jarvis_quiet_start || '20:00').slice(0, 5));
  setVal('js-quiet-end', String(s.jarvis_quiet_end || '07:30').slice(0, 5));
  setVal('js-cap', s.jarvis_daily_sms_cap == null ? 10 : s.jarvis_daily_sms_cap);
  setVal('js-call-cap', s.jarvis_call_cap == null ? 3 : s.jarvis_call_cap);
  setVal('js-model', s.jarvis_model || 'claude-opus-5-5');
  const cv = s.jarvis_call_voice || 'Polly.Brian-Neural';
  const cvSel = $('js-call-voice');
  if (!Array.prototype.some.call(cvSel.options, function (o) { return o.value === cv; })) cvSel.add(new Option(cv, cv));
  cvSel.value = cv;
  $('js-main-number').textContent = s.twilio_from_number || '(not set)';
  // A zone set by hand is added rather than silently falling back, so opening
  // and saving this form cannot quietly relocate someone.
  const tz = s.jarvis_timezone || 'Australia/Sydney';
  const tzSel = $('js-tz');
  if (!Array.prototype.some.call(tzSel.options, function (o) { return o.value === tz; })) {
    tzSel.add(new Option(tz, tz));
  }
  tzSel.value = tz;
  openModal('m-jarvis-settings');
  loadJarvisStatus();
  loadJarvisSpend();
}

// Counts only - jarvis_events itself stays unreadable from the browser.
async function loadJarvisStatus() {
  const host = $('js-watch');
  try {
    const { data, error } = await db.rpc('jarvis_status');
    if (error) throw error;
    const byKind = (data && data.open_by_kind) || {};
    const rows = Object.keys(JARVIS_WATCH_LABELS).map(function (k) {
      const n = byKind[k] || 0;
      return '<div style="display:flex;justify-content:space-between;gap:12px">' +
        '<span>' + JARVIS_WATCH_LABELS[k] + '</span>' +
        '<b style="color:' + (n ? 'var(--amb)' : 'var(--ink3)') + '">' + n + '</b></div>';
    }).join('');
    const queued = (data && data.queued) || 0;
    const last = data && data.last_sent_at;
    const foot = '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);color:var(--ink3)">' +
      (queued
        ? '<b style="color:var(--amb)">' + queued + '</b> waiting for his next check.'
        : 'Nothing waiting.') +
      (last ? ' Last told you ' + fmtWhen(last) + '.' : '') +
      '</div>';
    host.innerHTML = rows + foot;
  } catch (err) {
    host.textContent = 'Could not load status: ' + (err.message || err);
  }
}

// ── Posts ──────────────────────────────────────────────────────────────────
// Drafts, approvals and "posted" ticks go through gated RPCs; the images are
// public files in the jarvis-content bucket so they open on a phone.
const JP_STATUS = {
  draft:    { label: 'Waiting for you', tone: 'var(--amb)' },
  approved: { label: 'Approved - ready to post', tone: 'var(--acc)' },
  posted:   { label: 'Posted', tone: 'var(--grn)' },
};
let jpPosts = [];
