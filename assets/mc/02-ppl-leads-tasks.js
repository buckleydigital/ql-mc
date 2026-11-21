'use strict';

// ── Role-based UI ───────────────────────────────────────────────────────────
// Reps get a stripped-down dashboard: only the Sales Pipeline and Invoices
// nav items survive, and the admin "Sales Reps" panel is revealed only for
// full users. RLS does the real enforcement server-side; this is just the UI.
function applyRoleUI() {
  const repNav = $('rep-admin-nav');
  if (IS_REP) {
    document.querySelectorAll('.sb-nav .navbtn[data-panel]').forEach(b => {
      if (!REP_PANELS.has(b.dataset.panel)) b.style.display = 'none';
    });
    document.querySelectorAll('.bnav .bnbtn[data-panel]').forEach(b => {
      if (!REP_PANELS.has(b.dataset.panel)) b.style.display = 'none';
    });
    // Hide group labels / dividers that no longer head a visible button.
    document.querySelectorAll('.sb-group').forEach(g => {
      if (![...g.querySelectorAll('.navbtn[data-panel]')].some(b => b.style.display !== 'none')) g.style.display = 'none';
    });
    document.querySelectorAll('.sb-nav .sb-divider').forEach(d => d.style.display = 'none');
    if (repNav) repNav.style.display = 'none';
    document.querySelectorAll('.rep-stat-strip').forEach(e => e.style.display = '');
    document.querySelectorAll('.admin-only-field').forEach(e => e.style.display = 'none');
    // QuoteLeadsAI reads the whole business — revenue, spend, every client. Reps see
    // neither the button nor the panel, and quoteleadsai-chat refuses their token
    // as well, because a hidden button is not a restriction.
    const jvBtn = $('jv-btn'); if (jvBtn) jvBtn.style.display = 'none';
    JV.close();
    nav('crm');
  } else {
    if (repNav) repNav.style.display = '';
    const jvBtn = $('jv-btn'); if (jvBtn) jvBtn.style.display = '';
    document.querySelectorAll('.rep-stat-strip').forEach(e => e.style.display = 'none');
  }
}

// Reps only ever load the two panels they can see. We deliberately skip
// loadAll() (clients, finance, tasks, alerts…) so a rep's session never even
// queries the tables they're walled off from.
async function loadRepView() {
  await loadCRM();
}

function updateClock() {
  setText('clock', new Date().toLocaleTimeString('en-AU', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) + ' AEST');
}

function openModal(id)  { $(id).classList.add('open'); if(id==='m-ppl') refreshCampaignDropdowns(); if(id==='m-task'||id==='m-edit-task') loadTaskLeadDropdowns(); if(id==='m-add-ppl-campaign'){ $('pc-name').value='';$('pc-niche').value='';$('pc-area').value='';$('pc-status').value='active';$('pc-notes').value='';populatePcalMetaDropdown('pc-meta-link'); } }
function closeModal(id) { $(id).classList.remove('open'); }
document.addEventListener('click', e => { if (e.target.classList.contains('overlay')) e.target.classList.remove('open'); });

async function loadAll() {
  await Promise.all([loadTasks(), loadCRM(), loadPPL(), loadManaged(), loadHiring(), loadFinance()]);
  await loadTaskLeadDropdowns();
  loadFileNames(); loadFileContent();
  loadAlerts();
  loadQuoteLeadsAIInbox();
}

async function populateTestLeadNiches() {
  const sel = $('tl-niche');
  if (!sel) return;
  // Default niches shown when DB has no data yet
  const defaultNiches = ['solar_and_battery', 'battery_retrofit', 'aircon'];
  try {
    // ppl_leads is the dedicated distribution-leads table - no filter needed.
    const { data } = await db.from('ppl_leads')
      .select('lead_type')
      .not('lead_type', 'is', null)
      .limit(500);
    const dbNiches = [...new Set((data||[]).map(r => r.lead_type).filter(Boolean))];
    // Merge DB niches with defaults; DB values take precedence, defaults fill gaps
    const allNiches = [...new Set([...dbNiches, ...defaultNiches])].sort();
    const cur = sel.value;
    sel.innerHTML = allNiches.map(n => `<option value="${esc(n)}"${n===cur?' selected':''}>${esc(n.charAt(0).toUpperCase()+n.slice(1))}</option>`).join('');
  } catch(e) { /* keep existing options */ }
}

function toggleTestLeadFields() {
  const niche = document.getElementById('tl-niche').value;
  const isSolar = niche === 'solar' || niche === 'solar_and_battery' || niche === 'battery_retrofit';
  document.getElementById('tl-solar-fields').style.display = isSolar ? '' : 'none';
  document.getElementById('tl-custom-json-row').style.display = isSolar ? 'none' : '';
}

async function sendTestLead() {
  const btn = document.getElementById('tl-btn');
  const statusEl = document.getElementById('tl-status');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  statusEl.style.display = 'none';

  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Not logged in');

    const customDataRaw = document.getElementById('tl-custom').value.trim();
    const niche = document.getElementById('tl-niche').value;

    const payload = {
      name: document.getElementById('tl-name').value,
      email: document.getElementById('tl-email').value,
      phone: document.getElementById('tl-phone').value,
      postcode: document.getElementById('tl-postcode').value,
      niche: niche,
      custom_data: customDataRaw,
    };

    if (niche === 'solar') {
      payload.is_homeowner = document.getElementById('tl-homeowner').value === 'true';
      payload.avg_quarterly_bill = document.getElementById('tl-bill').value || null;
      payload.interested_in = document.getElementById('tl-interest').value;
      payload.purchase_timeline = document.getElementById('tl-timeline').value;
    } else {
      // Parse custom JSON and spread into payload
      const customJsonRaw = document.getElementById('tl-custom-json').value.trim();
      if (customJsonRaw) {
        try {
          const parsed = JSON.parse(customJsonRaw);
          Object.assign(payload, parsed);
        } catch (e) {
          throw new Error('Invalid JSON in Custom JSON field');
        }
      }
    }

    const res = await fetch(`${_ep}/functions/v1/submit-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);

    statusEl.style.background = '#d1fae5'; statusEl.style.color = '#065f46';
    statusEl.textContent = 'Lead sent! Refresh the table to see it appear.';
    statusEl.style.display = 'block';
    setTimeout(() => loadLeads(), 1500);
  } catch (err) {
    statusEl.style.background = '#fee2e2'; statusEl.style.color = '#991b1b';
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Test Lead';
  }
}

function updateSmsCounter() {
  const msg = $('sms-message')?.value || '';
  const counter = $('sms-counter');
  if (counter) {
    counter.textContent = msg.length + ' / 160';
    counter.style.color = msg.length > 160 ? 'var(--red)' : 'var(--ink3)';
  }
}

async function sendSms() {
  const btn = $('sms-send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Not logged in');
    const res = await fetch(`${_ep}/functions/v1/send-sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        to:      $('sms-lead-phone').value,
        message: $('sms-message').value,
        lead_id: $('sms-lead-id').value
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'SMS failed');
    closeModal('m-sms-lead');
    toast('SMS sent ✓');
  } catch (err) {
    toast('SMS failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send SMS';
  }
}

async function loadLeads(resetPage) {
  if (resetPage) leadsPage = 0;
  const filter = $('ld-filter')?.value || 'all';
  const typeFilter = $('ld-type-filter')?.value || 'all';
  const clientFilter = $('ld-client-filter')?.value || 'all';

  // ppl_leads is the dedicated distribution-leads table - no filter needed.
  // Pull lead_type + assigned client to build the niche & client filter dropdowns.
  const nicheQ = db.from('ppl_leads').select('lead_type, assigned_client_id, clients(company_name)').limit(500);
  // Stats query - lightweight, all PPL rows, just status + lead_type + client info
  const statsQ = db.from('ppl_leads').select('status, lead_type, assigned_client_id, clients(company_name)');
  if (typeFilter !== 'all') statsQ.eq('lead_type', typeFilter);
  if (clientFilter !== 'all') statsQ.eq('assigned_client_id', clientFilter);
  // Table query - paginated, with server-side filter
  const tableQ = db.from('ppl_leads').select('*, clients(company_name)', {count:'exact'}).order('created_at', {ascending: false});
  if (filter !== 'all') tableQ.eq('status', filter);
  if (typeFilter !== 'all') tableQ.eq('lead_type', typeFilter);
  if (clientFilter !== 'all') tableQ.eq('assigned_client_id', clientFilter);
  tableQ.range(leadsPage * PAGE_SIZE, (leadsPage + 1) * PAGE_SIZE - 1);

  // Per-client figures come straight off the client card (Active Clients / PPL tab):
  // purchased, delivered and scrubbed are values we input there, not counts derived
  // from ppl_leads rows. Remaining = purchased − delivered + scrubbed, same as that tab.
  const clientCardsQ = db.from('clients')
    .select('id, company_name, stage, total_leads_purchased, leads_delivered, leads_scrubbed')
    .eq('type', 'ppl').not('stage', 'eq', 'churned').order('company_name');

  const [nicheR, statsR, tableR, clientCardsR] = await Promise.all([nicheQ, statsQ, tableQ, clientCardsQ]);

  const clientCards = clientCardsR.data || [];
  // Sum positive remaining balances only - over-delivered clients (✓ in the table) don't offset.
  const totalOutstanding = clientCards.reduce((sum, c) => {
    if (c.stage !== 'active_client') return sum;
    const rem = (c.total_leads_purchased || 0) - (c.leads_delivered || 0) + (c.leads_scrubbed || 0);
    return sum + Math.max(0, rem);
  }, 0);
  setText('ld-outstanding', clientCardsR.error ? '-' : totalOutstanding);

  // Rebuild niche filter options
  if (nicheR.data) {
    const niches = [...new Set(nicheR.data.map(r => r.lead_type).filter(Boolean))].sort();
    const sel = $('ld-type-filter');
    const curVal = sel.value;
    sel.innerHTML = '<option value="all">All Niches</option>' + niches.map(n => `<option value="${esc(n)}"${n===curVal?' selected':''}>${esc(n.charAt(0).toUpperCase()+n.slice(1))}</option>`).join('');

    // Rebuild client filter options from leads that have an assigned client
    const clientSel = $('ld-client-filter');
    if (clientSel) {
      const curClient = clientSel.value;
      const clientMapOpts = {};
      nicheR.data.forEach(r => {
        if (r.assigned_client_id) clientMapOpts[r.assigned_client_id] = r.clients?.company_name || 'Unknown Client';
      });
      const clientOpts = Object.entries(clientMapOpts).sort((a, b) => a[1].localeCompare(b[1]));
      clientSel.innerHTML = '<option value="all">All Clients</option>' + clientOpts.map(([id, name]) => `<option value="${esc(id)}"${id===curClient?' selected':''}>${esc(name)}</option>`).join('');
    }
  }

  if (statsR.error || tableR.error) {
    $('ld-tbody').innerHTML = `<tr><td colspan="15" class="empty">Error: ${esc((statsR.error||tableR.error).message)}</td></tr>`;
    return;
  }
  const all = statsR.data || [];
  leadsTotal = tableR.count || 0;

  setText('ld-total', all.length);
  setText('ld-pending', all.filter(l => l.status === 'pending').length);
  setText('ld-assigned', all.filter(l => l.status === 'assigned').length);
  setText('ld-delivered', all.filter(l => l.status === 'delivered').length);
  setText('ld-failed', all.filter(l => l.status === 'failed' || l.status === 'scrubbed').length);

  // "By Client" mirrors the client card values, filtered by the client dropdown.
  const breakdownRows = (clientFilter === 'all'
    ? clientCards
    : clientCards.filter(c => String(c.id) === String(clientFilter))
  ).map(c => {
    const purchased = c.total_leads_purchased || 0;
    const delivered = c.leads_delivered || 0;
    const scrubbed = c.leads_scrubbed || 0;
    return {name: c.company_name || 'Unknown Client', stage: c.stage, purchased, delivered, scrubbed,
            remaining: purchased - delivered + scrubbed};
  });
  $('ld-client-breakdown').innerHTML = clientCardsR.error
    ? `<div class="empty">Error: ${esc(clientCardsR.error.message)}</div>`
    : breakdownRows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--bd2)">
          <th style="text-align:left;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--ink3);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Client</th>
          <th style="text-align:right;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--ink3);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Purchased</th>
          <th style="text-align:right;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--ink3);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Delivered</th>
          <th style="text-align:right;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--ink3);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Scrubbed</th>
          <th style="text-align:right;padding:6px 10px;font-family:var(--mono);font-size:12px;color:var(--ink3);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Remaining</th>
        </tr></thead>
        <tbody>${breakdownRows.map(s => `
          <tr style="border-bottom:1px solid var(--bd)">
            <td style="padding:7px 10px;font-weight:600">${esc(s.name)}${s.stage !== 'active_client' ? ` <span class="badge ${stageBadge(s.stage)}">${stageLabel(s.stage)}</span>` : ''}</td>
            <td style="padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px">${s.purchased}</td>
            <td style="padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:var(--grn)">${s.delivered}</td>
            <td style="padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px${s.scrubbed ? ';color:var(--amb)' : ';color:var(--ink3)'}">${s.scrubbed}</td>
            <td style="padding:7px 10px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:500;color:${s.remaining > 0 ? 'var(--amb)' : 'var(--ink3)'}">${s.remaining > 0 ? s.remaining : '✓'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
    : '<div class="empty">No PPL clients yet.</div>';

  const rows = tableR.data || [];
  if (!rows.length) {
    $('ld-tbody').innerHTML = `<tr><td colspan="15" class="empty">No leads found.</td></tr>`;
    $('ld-pager').innerHTML = '';
    return;
  }
  const statusBadge = s => {
    const cls = {pending:'bg-amb',assigned:'bg-blu',delivered:'bg-grn',failed:'bg-red',scrubbed:'bg-gray'};
    return `<span class="badge ${cls[s]||'bg-gray'}">${esc(s||'unknown')}</span>`;
  };
  const nicheBadge = n => {
    if (!n) return '<span class="badge bg-gray">-</span>';
    return `<span class="badge bg-sky">${esc(n.charAt(0).toUpperCase()+n.slice(1))}</span>`;
  };
  $('ld-tbody').innerHTML = rows.map(l => `
    <tr>
      <td style="white-space:nowrap;font-family:var(--mono);font-size:12px;color:var(--ink3)">${fmtDate(l.created_at, true)}</td>
      <td>${nicheBadge(l.lead_type)}</td>
      <td><strong>${esc(l.name||'-')}</strong><br><span style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(l.email||'')}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(l.phone||'-')}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(l.postcode||'-')}</td>
      <td>${l.interested_in ? `<span class="badge bg-blu">${esc(l.interested_in.replace(/_/g,' '))}</span>` : '<span style="color:var(--ink3)">-</span>'}</td>
      <td style="font-family:var(--mono);font-size:12px">${l.avg_quarterly_bill ? esc(String(l.avg_quarterly_bill)) : '-'}</td>
      <td style="font-size:12px;color:var(--ink2);white-space:nowrap">${esc(l.purchase_timeline||'-')}</td>
      <td>${statusBadge(l.status)}</td>
      <td>${l.clients?.company_name ? `<strong>${esc(l.clients.company_name)}</strong>` : '<span style="color:var(--ink3)">-</span>'}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink3);white-space:nowrap">${fmtDate(l.delivered_at, false)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink3)">${esc(l.delivery_method||'-')}</td>
      <td><span class="badge bg-gray">${esc(l.source||'webhook')}</span></td>
      <td style="font-size:12px;color:var(--ink2);max-width:180px;white-space:pre-wrap;word-break:break-word">${esc(l.custom_fields||'')}</td>
      <td style="white-space:nowrap">
        <select class="fi" style="font-size:12px;padding:3px 6px;width:auto;font-family:var(--mono)" onchange="updateLeadStatus('${esc(l.id)}', this.value, this)">
          <option value="pending" ${l.status==='pending'?'selected':''}>Pending</option>
          <option value="assigned" ${l.status==='assigned'?'selected':''}>Assigned</option>
          <option value="delivered" ${l.status==='delivered'?'selected':''}>Delivered</option>
          <option value="scrubbed" ${l.status==='scrubbed'?'selected':''}>Scrubbed</option>
          <option value="failed" ${l.status==='failed'?'selected':''}>Failed</option>
        </select>
        ${l.phone ? `<button class="btn btn-xs sms-lead-btn" data-lead-id="${esc(l.id)}" data-phone="${esc(l.phone)}" data-name="${esc(l.name||'')}">SMS</button>` : ''}
        ${l.status === 'pending' ? `<button class="btn btn-xs recheck-lead-btn" data-lead-id="${esc(l.id)}" style="background:var(--amb-fill);color:#1c1416">Recheck</button>` : ''}
        ${l.status === 'assigned' ? `<button class="btn btn-xs deliver-lead-btn" data-lead-id="${esc(l.id)}" data-client="${esc(l.clients?.company_name||'')}" style="background:var(--grn-fill);color:#fff">Deliver →</button>` : ''}
        <button class="btn btn-xs dlogs-btn" data-lead-id="${esc(l.id)}" data-lead-name="${esc(l.name||'')}">📋 Logs</button>
      </td>
    </tr>`).join('');
  renderPager('ld-pager', leadsPage, leadsTotal, p => { leadsPage = p; loadLeads(); });
  // Attach SMS button listeners
  document.querySelectorAll('.sms-lead-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      $('sms-lead-id').value = btn.dataset.leadId;
      $('sms-lead-phone').value = btn.dataset.phone;
      $('sms-lead-info').textContent = (btn.dataset.name || '') + ' · ' + (btn.dataset.phone || '');
      $('sms-message').value = `Hi ${btn.dataset.name || ''}, `;
      updateSmsCounter();
      openModal('m-sms-lead');
    });
  });
  // Attach delivery log button listeners
  document.querySelectorAll('.dlogs-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openDeliveryLogs(btn.dataset.leadId, btn.dataset.leadName);
    });
  });
  // Attach recheck (assign) button listeners
  document.querySelectorAll('.recheck-lead-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      recheckLead(btn.dataset.leadId, btn);
    });
  });
  // Attach deliver button listeners (2nd step - actually sends)
  document.querySelectorAll('.deliver-lead-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deliverLead(btn.dataset.leadId, btn.dataset.client, btn);
    });
  });
  loadDeliveryLogOverview();
}

// STEP 1 - Recheck = match + assign ONLY. Nothing is sent, no counts move,
// no HQ forward. The operator reviews the matched client, then clicks Deliver.
async function recheckLead(leadId, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Not logged in');
    const res = await fetch(`${_ep}/functions/v1/recheck-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ lead_id: leadId, action: 'assign' }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Recheck failed');
    if (data.matched) {
      toast(`Assigned to ${data.client_name} - review, then click Deliver to send`);
    } else {
      toast('No matching client found for this postcode/niche yet', true);
      btn.disabled = false;
      btn.textContent = 'Recheck';
      return;
    }
    loadLeads();
  } catch (err) {
    toast('Recheck failed: ' + err.message, true);
    btn.disabled = false;
    btn.textContent = 'Recheck';
  }
}

// STEP 2 - Deliver = actually send the assigned lead (email/SMS/webhook + HQ
// forward + delivered-count increment). This is the only step that contacts
// anyone, so a wrong match can be caught at the assign step before this runs.
async function deliverLead(leadId, clientName, btn) {
  if (!confirm(`Deliver this lead to ${clientName || 'the assigned client'}?\n\nThis sends the lead and bumps their delivered count. Make sure it's the right client.`)) return;
  btn.disabled = true;
  btn.textContent = 'Delivering…';
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new Error('Not logged in');
    const res = await fetch(`${_ep}/functions/v1/recheck-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ lead_id: leadId, action: 'deliver' }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Deliver failed');
    if (data.delivered) {
      toast(`Delivered to ${data.client_name || clientName} ✓`);
    } else {
      toast(`Delivery failed: ${data.delivery_error || 'unknown error'}`, true);
      btn.disabled = false;
      btn.textContent = 'Deliver →';
      return;
    }
    loadLeads();
  } catch (err) {
    toast('Deliver failed: ' + err.message, true);
    btn.disabled = false;
    btn.textContent = 'Deliver →';
  }
}
async function updateLeadStatus(leadId, newStatus, selectEl) {
  const prev = Array.from(selectEl.options).find(o => o.defaultSelected)?.value || selectEl.value;
  selectEl.disabled = true;
  let error;
  if (newStatus === 'delivered') {
    ({error} = await db.rpc('mark_lead_delivered', {p_lead_id: leadId, p_note: 'Manually marked delivered'}));
  } else if (newStatus === 'scrubbed') {
    ({error} = await db.rpc('mark_lead_scrubbed', {p_lead_id: leadId}));
    if (!error) {
      const {data:_sd0}=await db.auth.getSession();
      if(_sd0?.session)fetch(`${_ep}/functions/v1/sync-to-hq`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${_sd0.session.access_token}`},body:JSON.stringify({action:'scrub',lead_id:leadId})}).catch(e=>console.warn('sync-to-hq scrub:',e));
    }
  } else {
    ({error} = await db.from('ppl_leads').update({status: newStatus, updated_at: new Date().toISOString()}).eq('id', leadId));
  }
  selectEl.disabled = false;
  if (error) {
    alert('Failed to update status: ' + error.message);
    for (const opt of selectEl.options) opt.selected = opt.value === prev;
    return;
  }
  loadLeads();
}

async function openDeliveryLogs(leadId, leadName) {
  $('dlogs-modal-title').textContent = leadName || leadId;
  $('dlogs-modal-body').innerHTML = '<div class="empty">Loading…</div>';
  openModal('m-delivery-logs');
  const { data, error } = await db
    .from('lead_delivery_log')
    .select('*')
    .eq('lead_id', leadId)
    .order('delivered_at', { ascending: false, nullsFirst: false });
  if (error) {
    $('dlogs-modal-body').innerHTML = `<div class="empty" style="color:var(--red)">Error: ${esc(error.message)}</div>`;
    return;
  }
  if (!data || !data.length) {
    $('dlogs-modal-body').innerHTML = '<div class="empty">No delivery attempts logged yet.</div>';
    return;
  }
  const methodIcon = m => ({ email: '✉️', sms: '💬', webhook: '🔗', crm: '🔗' })[m] || '📤';
  const statusBadge = s => s === 'delivered'
    ? '<span class="badge bg-grn">delivered</span>'
    : `<span class="badge bg-red">${esc(s || 'failed')}</span>`;
  const fmtTs = ts => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  $('dlogs-modal-body').innerHTML = data.map(entry => `
    <div style="border:1px solid var(--bd2);border-radius:var(--r2);padding:12px 14px;margin-bottom:8px;background:var(--s2)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:15px">${methodIcon(entry.method)}</span>
        <strong style="font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.05em">${esc(entry.method || '-')}</strong>
        ${statusBadge(entry.status)}
        <span style="font-family:var(--mono);font-size:12px;color:var(--ink3);margin-left:auto">${fmtTs(entry.delivered_at || entry.created_at)}</span>
      </div>
      ${entry.destination ? `<div style="font-family:var(--mono);font-size:12px;color:var(--ink2);margin-bottom:6px;word-break:break-all">→ ${esc(entry.destination)}</div>` : ''}
      ${entry.message_preview ? `<div style="background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:8px 10px;font-family:var(--mono);font-size:12px;color:var(--ink);white-space:pre-wrap;word-break:break-word;margin-bottom:6px">${esc(entry.message_preview)}</div>` : ''}
      ${entry.response_code != null ? `<div style="font-family:var(--mono);font-size:12px;color:${entry.status === 'delivered' ? 'var(--grn)' : 'var(--red)'}">HTTP ${entry.response_code}${entry.response_body ? ' · ' + esc(String(entry.response_body).slice(0, 300)) : ''}</div>` : ''}
    </div>`).join('');
}

async function openActionLog(clientId, clientName) {
  $('al-client-id').value = clientId;
  $('al-modal-title').textContent = clientName || clientId;
  $('al-modal-body').innerHTML = '<div class="empty">Loading…</div>';
  $('al-notes').value = '';
  openModal('m-action-log');
  await refreshActionLog(clientId);
}
async function refreshActionLog(clientId) {
  const { data, error } = await db
    .from('client_action_log')
    .select('*')
    .eq('client_id', clientId)
    .order('logged_at', { ascending: false });
  if (error) {
    $('al-modal-body').innerHTML = `<div class="empty" style="color:var(--red)">Error: ${esc(error.message)}</div>`;
    return;
  }
  if (!data || !data.length) {
    $('al-modal-body').innerHTML = '<div class="empty">No actions logged yet.</div>';
    return;
  }
  const typeIcon = t => ({ call: '📞', email: '✉️', meeting: '🤝', note: '📝', other: '📌' })[t] || '📌';
  const fmtTs = ts => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  $('al-modal-body').innerHTML = data.map(entry => `
    <div style="border:1px solid var(--bd2);border-radius:var(--r2);padding:10px 14px;margin-bottom:8px;background:var(--s2)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:14px">${typeIcon(entry.action_type)}</span>
        <strong style="font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.05em">${esc(entry.action_type || '-')}</strong>
        <span style="font-family:var(--mono);font-size:12px;color:var(--ink3);margin-left:auto">${fmtTs(entry.logged_at)}</span>
      </div>
      ${entry.notes ? `<div style="margin-top:6px;font-size:13px;color:var(--ink)">${esc(entry.notes)}</div>` : ''}
    </div>`).join('');
}
async function addActionLogEntry() {
  const clientId = $('al-client-id').value;
  const type = $('al-type').value;
  const notes = $('al-notes').value.trim();
  if (!notes) { toast('Please enter a note', true); return; }
  const { error } = await db.from('client_action_log').insert({ client_id: clientId, action_type: type, notes });
  if (error) { toast('Error: ' + error.message, true); return; }
  $('al-notes').value = '';
  toast('Action logged');
  await refreshActionLog(clientId);
}

async function loadDeliveryLogOverview() {
  const tbody = $('dlogs-tbody');
  if (!tbody) return;
  const { data, error } = await db
    .from('lead_delivery_log')
    .select('*, ppl_leads(name, phone), clients(company_name)')
    .order('delivered_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty" style="color:var(--red)">Error: ${esc(error.message)}</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No delivery attempts yet.</td></tr>';
    return;
  }
  const methodBadge = m => {
    const cls = { email: 'bg-blu', sms: 'bg-sky', webhook: 'bg-gray', crm: 'bg-gray' };
    return `<span class="badge ${cls[m] || 'bg-gray'}">${esc(m || '-')}</span>`;
  };
  const statusBadge = s => s === 'delivered'
    ? '<span class="badge bg-grn">✓ delivered</span>'
    : `<span class="badge bg-red">✗ ${esc(s || 'failed')}</span>`;
  const fmtTs = ts => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  tbody.innerHTML = data.map(entry => `
    <tr>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink3);white-space:nowrap">${fmtTs(entry.delivered_at || entry.created_at)}</td>
      <td><strong style="font-size:12px">${esc(entry.ppl_leads?.name || '-')}</strong></td>
      <td style="font-size:12px;color:var(--ink2)">${esc(entry.clients?.company_name || '-')}</td>
      <td>${methodBadge(entry.method)}</td>
      <td>${statusBadge(entry.status)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink2);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(entry.destination || '')}">${esc(entry.destination || '-')}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(entry.message_preview || '')}">${esc(entry.message_preview ? (entry.message_preview.length > 80 ? entry.message_preview.slice(0, 77) + '…' : entry.message_preview) : '-')}</td>
      <td style="font-family:var(--mono);font-size:12px;color:${entry.status === 'delivered' ? 'var(--grn)' : 'var(--red)'}">${entry.response_code != null ? entry.response_code : '-'}</td>
    </tr>`).join('');
}

async function loadTaskLeadDropdowns() {
  const [leadsR, clientsR] = await Promise.all([
    db.from('leads').select('id,name,company,stage').or('stage.is.null,stage.not.in.(closed_won,closed_lost)').order('name'),
    db.from('clients').select('id,company_name,type,stage').in('stage',['active_client','active']).order('company_name')
  ]);
  const opts = ['<option value="">- No link -</option>'];
  if (leadsR.data?.length) {
    opts.push('<optgroup label="Sales Pipeline">');
    leadsR.data.forEach(l=>opts.push(`<option value="lead:${esc(l.id)}">[Sales] ${esc(l.name||l.company||'Lead')}</option>`));
    opts.push('</optgroup>');
  }
  if (clientsR.data?.length) {
    const ppl=clientsR.data.filter(c=>c.type==='ppl'||c.type==='ppl_managed');
    const mg=clientsR.data.filter(c=>c.type==='managed'||c.type==='ppl_managed');
    if (ppl.length) {opts.push('<optgroup label="PPL Clients">');ppl.forEach(c=>opts.push(`<option value="client:${esc(c.id)}">[${c.type==='ppl_managed'?'PPL+M':'PPL'}] ${esc(c.company_name)}</option>`));opts.push('</optgroup>');}
    if (mg.length) {opts.push('<optgroup label="Managed Ads">');mg.forEach(c=>opts.push(`<option value="client:${esc(c.id)}">[${c.type==='ppl_managed'?'PPL+M':'Managed'}] ${esc(c.company_name)}</option>`));opts.push('</optgroup>');}
  }
  const html = opts.join('');
  const newSel = $('t-linked-lead');
  const editSel = $('et-linked-lead');
  if (newSel) newSel.innerHTML = html;
  if (editSel) editSel.innerHTML = html;
}

async function loadTasks() {
  const {data, error} = await db.from('tasks').select('*').order('created_at', {ascending:false});
  if (error) { $('task-list').innerHTML = '<div class="empty">Error: ' + esc(error.message) + '</div>'; return; }
  renderTaskList('task-list', data||[]);
  setText('task-count', (data||[]).filter(t => !t.done).length);
}
function renderTaskList(id, list) {
  const el = $(id);
  if (!list.length) { el.innerHTML = '<div style="padding:8px 0;font-size:12px;color:var(--ink3);font-family:var(--mono)">No tasks.</div>'; return; }
  list.forEach(t => _taskMap.set(String(t.id), t));
  el.innerHTML = list.map(t => `
    <div class="task-item ${t.done ? 'done' : ''}" id="ti-${t.id}">
      <div class="tcb" data-task-id="${t.id}" data-done="${t.done ? '1' : '0'}">${t.done ? '✓' : ''}</div>
      <div class="task-body" data-task-id="${t.id}" style="cursor:pointer">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          <span class="tag ${t.priority==='urgent'?'tag-urgent':t.priority==='low'?'tag-low':'tag-normal'}">${esc(t.priority || 'normal')}</span>
          ${t.linked_name ? `<span class="tag" style="background:rgba(245,166,35,.07);color:var(--amb);border:1px solid rgba(245,166,35,.2);max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${esc(t.linked_name)}">⇢ ${esc(t.linked_name.replace(/^\[.*?\]\s*/,''))}</span>` : ''}
        </div>
      </div>
    </div>`).join('');
  el.querySelectorAll('.tcb[data-task-id]').forEach(cb => {
    cb.addEventListener('click', () => toggleTask(cb.dataset.taskId, cb.dataset.done === '1'));
  });
  el.querySelectorAll('.task-body[data-task-id]').forEach(body => {
    body.addEventListener('click', () => openEditTask(_taskMap.get(body.dataset.taskId)));
  });
}
function openEditTask(t) {
  setVal('et-id',t.id);setVal('et-title',t.title);
  setVal('et-priority',t.priority);setVal('et-notes',t.notes);
  openModal('m-edit-task');
  loadTaskLeadDropdowns().then(() => setVal('et-linked-lead', t.linked_ref||''));
}
async function updateTask() {
  const id = $('et-id').value;
  const linkedRef=$('et-linked-lead').value||null;
  const linkedName=$('et-linked-lead').options[$('et-linked-lead').selectedIndex]?.text||null;
  const d = {title:$('et-title').value.trim(),priority:$('et-priority').value,notes:$('et-notes').value,linked_ref:linkedRef,linked_name:linkedRef?linkedName:null,updated_at:now()};
  if (!d.title) { toast('Title required',true); return; }
  const {error} = await db.from('tasks').update(d).eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  closeModal('m-edit-task'); loadTasks(); toast('Task updated ✓');
}
async function deleteTask() {
  if (!confirm('Delete this task?')) return;
  const id = $('et-id').value;
  const {error} = await db.from('tasks').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  closeModal('m-edit-task'); loadTasks(); toast('Task deleted');
}
async function toggleTask(id, currentDone) {
  const {error} = await db.from('tasks').update({done:!currentDone,updated_at:now()}).eq('id',id);
  if (error) { toast('Error: '+error.message,true); return; }
  loadTasks();
}
async function quickAdd() {
  const inp = $('q-task'), title = inp.value.trim();
  if (!title) return;
  const {error} = await db.from('tasks').insert([{title,priority:'normal',done:false,created_at:now()}]);
  if (error) { toast('DB error: '+error.message,true); return; }
  inp.value=''; loadTasks();
}
async function addTask() {
  const title=$('t-title').value.trim(),priority=$('t-priority').value,notes=$('t-notes').value;
  const linkedRef=$('t-linked-lead').value||null;
  const linkedName=linkedRef?$('t-linked-lead').options[$('t-linked-lead').selectedIndex]?.text:null;
  if (!title) { toast('Title required',true); return; }
  const {error} = await db.from('tasks').insert([{title,priority,notes,linked_ref:linkedRef,linked_name:linkedRef?linkedName:null,done:false,created_at:now()}]);
  if (error) { toast('DB error: '+error.message,true); return; }
  $('t-title').value=''; $('t-notes').value=''; if($('t-linked-lead'))$('t-linked-lead').value='';
  closeModal('m-task'); loadTasks(); toast('Task created ✓');
}
