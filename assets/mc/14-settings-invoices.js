'use strict';

let QL_LOGO_B64 = null;
fetch('./quoteleads-logo-white.png').then(r=>r.blob()).then(b=>{
  const rd=new FileReader(); rd.onload=e=>{QL_LOGO_B64=e.target.result;}; rd.readAsDataURL(b);
}).catch(()=>{});

async function loadBizSettings() {
  try {
    const {data} = await db.from('business_settings').select('*').limit(1).maybeSingle();
    return data || {};
  } catch(_) { return {}; }
}

async function openBizSettingsModal() {
  const s = await loadBizSettings();
  setVal('bs-name', s.business_name || '');
  setVal('bs-abn', s.abn || '');
  setVal('bs-bsb', s.bsb || '');
  setVal('bs-accnum', s.account_number || '');
  setVal('bs-accname', s.account_name || '');
  setVal('bs-payid', s.payid || '');
  setVal('bs-notes', s.default_notes || '');
  setVal('bs-sales-from', s.sales_from_email || '');
  setVal('bs-sales-from-name', s.sales_from_name || '');
  setVal('bs-sales-replyto', s.sales_reply_to_email || '');
  setVal('bs-twilio-from', s.twilio_from_number || '');
  setVal('bs-target-margin', s.target_margin_pct ?? '');
  setVal('bs-dud-rate', s.dud_rate_pct ?? '');
  setVal('bs-stripe-fee', s.stripe_fee_pct ?? '');
  setVal('bs-gst-rate', s.gst_rate_pct ?? '');
  setVal('bs-rep-commission', s.rep_commission_pct ?? '');
  setVal('bs-stripe-fixed', s.stripe_fee_fixed ?? '');
  setVal('bs-price-includes-gst', s.price_includes_gst === true ? '1' : '0');
  setVal('bs-commission-base', s.commission_base || 'ex');
  setVal('bs-meta-dataset', s.meta_dataset_id || '');
  setVal('bs-meta-token', '');
  setText('bs-meta-status', '');
  openModal('m-biz-settings');
}

// Whether our Meta token can reach the saved dataset, and what meta-capi has
// sent to it in 30 days. Reads what's saved, so save a changed ID first.
async function checkMetaCapi() {
  setText('bs-meta-status', 'Checking…');
  const { data: { session } } = await db.auth.getSession();
  const r = await fetch(`${_ep}/functions/v1/meta-capi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
    body: JSON.stringify({ action: 'state' }),
  }).then(x => x.json()).catch(e => ({ error: String(e) }));
  if (r.error) { setText('bs-meta-status', 'Could not check: ' + r.error); return; }
  if (!r.dataset_id) { setText('bs-meta-status', 'Off: no dataset ID saved.'); return; }
  const n = r.last_30_days || {};
  setText('bs-meta-status', (r.reachable
      ? `Connected to ${r.dataset_name || r.dataset_id}.`
      : `Not connected: ${r.problem}. Generate a new token for pixel ${r.dataset_id} in Events Manager and paste it above.`) +
    ` ${n.sent || 0} event(s) sent in 30 days (bookings, proposals, sales)` + (n.held ? `, ${n.held} held until it can reach the dataset` : '') +
    (n.failed ? `, ${n.failed} not accepted${r.last_error ? ` (${r.last_error})` : ''}.` : '.'));
}

async function saveBizSettings() {
  _salesFromNameTpl = null;
  const payload = {
    business_name: $('bs-name').value.trim(),
    abn: $('bs-abn').value.trim(),
    bsb: $('bs-bsb').value.trim(),
    account_number: $('bs-accnum').value.trim(),
    account_name: $('bs-accname').value.trim(),
    payid: $('bs-payid').value.trim(),
    default_notes: $('bs-notes').value.trim(),
    twilio_from_number: $('bs-twilio-from').value.trim() || null,
    sales_from_email: $('bs-sales-from').value.trim() || null,
    sales_from_name: $('bs-sales-from-name').value.replace(/[<>"]/g, '').trim() || null,
    sales_reply_to_email: $('bs-sales-replyto').value.trim() || null,
    target_margin_pct: $('bs-target-margin').value !== '' ? parseFloat($('bs-target-margin').value) : null,
    dud_rate_pct: parseFloat($('bs-dud-rate').value) || 0,
    stripe_fee_pct: parseFloat($('bs-stripe-fee').value) || 0,
    gst_rate_pct: parseFloat($('bs-gst-rate').value) || 10,
    rep_commission_pct: parseFloat($('bs-rep-commission').value) || 0,
    stripe_fee_fixed: parseFloat($('bs-stripe-fixed').value) || 0.30,
    price_includes_gst: $('bs-price-includes-gst').value === '1',
    commission_base: $('bs-commission-base').value,
    meta_dataset_id: $('bs-meta-dataset').value.replace(/\s/g, '') || null,
    updated_at: new Date().toISOString()
  };
  if (payload.meta_dataset_id && !/^\d{6,20}$/.test(payload.meta_dataset_id)) { alert('The Meta pixel ID is the number from Events Manager, digits only.'); return; }
  // The token goes to the vault, never into business_settings.
  const capiToken = $('bs-meta-token').value.trim();
  if (capiToken) {
    const { error: tokErr } = await db.rpc('set_meta_capi_token', { p_token: capiToken });
    if (tokErr) { alert('Error saving the Conversions API token: ' + tokErr.message); return; }
  }
  const existing = await db.from('business_settings').select('id').limit(1).single();
  let error;
  if (existing.data) {
    ({error} = await db.from('business_settings').update(payload).eq('id', existing.data.id));
  } else {
    ({error} = await db.from('business_settings').insert(payload));
  }
  if (error) { alert('Error saving: ' + error.message); return; }
  _cplSettings = payload.target_margin_pct == null ? null
    : { margin: payload.target_margin_pct, dud: payload.dud_rate_pct, stripe: payload.stripe_fee_pct,
        gstRate: payload.gst_rate_pct, priceIncludesGst: payload.price_includes_gst === true,
        repCommission: payload.rep_commission_pct, commissionBase: payload.commission_base,
        stripeFixed: payload.stripe_fee_fixed };
  closeModal('m-biz-settings');
}

// --- Invoice line items ---
let invLineCount = 0;
function addInvLine(desc, qty, price) {
  const idx = invLineCount++;
  const div = document.createElement('div');
  div.className = 'inv-line';
  div.id = 'inv-line-' + idx;
  div.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
  div.innerHTML = `
    <input class="fi" placeholder="Description" style="flex:3" value="${esc(desc||'')}" data-field="desc">
    <input class="fi" type="number" placeholder="Qty" style="flex:0.7;min-width:60px" value="${qty||''}" data-field="qty" oninput="recalcInvoice()">
    <input class="fi" type="number" placeholder="Unit $" style="flex:0.9;min-width:80px" value="${price||''}" data-field="price" oninput="recalcInvoice()">
    <span style="font-family:var(--mono);font-size:12px;min-width:70px;text-align:right" data-field="total">$0.00</span>
    <button class="btn btn-xs" style="color:var(--red);padding:2px 6px" onclick="this.parentElement.remove();recalcInvoice()">✕</button>`;
  $('inv-lines').appendChild(div);
  recalcInvoice();
}

function getInvLines() {
  const lines = [];
  document.querySelectorAll('.inv-line').forEach(div => {
    const desc = div.querySelector('[data-field="desc"]').value.trim();
    const qty = parseFloat(div.querySelector('[data-field="qty"]').value) || 0;
    const price = parseFloat(div.querySelector('[data-field="price"]').value) || 0;
    lines.push({description: desc, qty, unit_price: price, line_total: qty * price});
  });
  return lines;
}

function recalcInvoice() {
  const lines = getInvLines();
  document.querySelectorAll('.inv-line').forEach((div, i) => {
    if (lines[i]) div.querySelector('[data-field="total"]').textContent = '$' + lines[i].line_total.toFixed(2);
  });
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const gstType = $('inv-gst').value;
  let gst, total;
  if (gstType === 'exclusive') {
    gst = subtotal * 0.1;
    total = subtotal + gst;
  } else {
    total = subtotal;
    gst = subtotal / 11;
  }
  $('inv-subtotal').textContent = '$' + subtotal.toFixed(2);
  $('inv-gst-amt').textContent = '$' + gst.toFixed(2);
  $('inv-total-amt').textContent = '$' + total.toFixed(2);
}

// --- Open invoice modal ---
async function openInvoiceModal(clientId, offerType) {
  invLineCount = 0;
  $('inv-lines').innerHTML = '';
  setVal('inv-id', '');
  $('inv-modal-title').textContent = 'New Invoice';
  $('inv-modal-sub').textContent = '';
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  setVal('inv-date', today);
  setVal('inv-due', due);
  setVal('inv-gst', 'exclusive');
  setVal('inv-period-start', '');
  setVal('inv-period-end', '');
  setVal('inv-vertical', '');
  setVal('inv-payment-details', 'PayID: contact@quoteleads.com.au');

  // Load business settings for default notes
  const biz = await loadBizSettings();
  setVal('inv-notes', biz.default_notes || '');

  // Populate client / lead dropdown
  const [{data: clients}, {data: pipelineLeads}] = await Promise.all([
    db.from('clients').select('id,company_name,type,niche,lead_price,management_fee,contact_name,email').order('company_name'),
    db.from('leads').select(IS_REP ? 'id,name,company,email,lead_type' : 'id,name,company,email,lead_type,value').neq('stage','closed_lost').order('name')
  ]);
  const sel = $('inv-client');
  const pplClients = (clients||[]).filter(c => c.type === 'ppl');
  const mgClients  = (clients||[]).filter(c => c.type === 'managed');
  let html = '<option value="">- Select client or lead -</option>';
  if (pplClients.length) {
    html += '<optgroup label="PPL Clients">' +
      pplClients.map(c => `<option value="${esc(String(c.id))}" data-source="client" data-type="${esc(c.type||'')}" data-niche="${esc(c.niche||'')}" data-lead-price="${c.lead_price||0}" data-fee="${c.management_fee||0}" data-contact="${esc(c.contact_name||'')}" data-email="${esc(c.email||'')}">${esc(c.company_name)}</option>`).join('') +
      '</optgroup>';
  }
  if (mgClients.length) {
    html += '<optgroup label="Managed Clients">' +
      mgClients.map(c => `<option value="${esc(String(c.id))}" data-source="client" data-type="${esc(c.type||'')}" data-niche="${esc(c.niche||'')}" data-lead-price="${c.lead_price||0}" data-fee="${c.management_fee||0}" data-contact="${esc(c.contact_name||'')}" data-email="${esc(c.email||'')}">${esc(c.company_name)}</option>`).join('') +
      '</optgroup>';
  }
  if ((pipelineLeads||[]).length) {
    html += '<optgroup label="Sales Pipeline Leads">' +
      pipelineLeads.map(l => {
        const display = l.company ? `${esc(l.name||'')} - ${esc(l.company)}` : esc(l.name||'Lead');
        return `<option value="lead:${esc(String(l.id))}" data-source="lead" data-type="${esc(l.lead_type||'ppl')}" data-niche="" data-lead-price="0" data-fee="${l.value||0}" data-contact="${esc(l.name||'')}" data-email="${esc(l.email||'')}" data-company="${esc(l.company||'')}">${display}</option>`;
      }).join('') +
      '</optgroup>';
  }
  sel.innerHTML = html;

  if (clientId) {
    sel.value = String(clientId);
    onInvClientChange();
    if (offerType) setVal('inv-offer-type', offerType);
  } else {
    addInvLine();
  }
  openModal('m-invoice');
}

function onInvClientChange() {
  const opt = $('inv-client').selectedOptions[0];
  if (!opt || !opt.value) return;
  const isLead = opt.dataset.source === 'lead';
  const type = opt.dataset.type;
  setVal('inv-offer-type', type === 'managed' ? 'managed' : 'ppl');
  setVal('inv-vertical', opt.dataset.niche || '');
  const displayName = isLead
    ? (opt.dataset.company ? `${opt.dataset.contact} - ${opt.dataset.company}` : opt.dataset.contact)
    : opt.textContent;
  $('inv-modal-sub').textContent = displayName;

  // Clear existing lines and pre-fill
  invLineCount = 0;
  $('inv-lines').innerHTML = '';
  if (isLead) {
    // Pipeline lead: pre-fill with its build fee if one is entered (never
    // loaded for reps, who cannot see deal values).
    const dealVal = parseFloat(opt.dataset.fee) || 0;
    addInvLine(type === 'managed' ? 'Managed Advertising - Build Fee' : 'Pay-Per-Lead Services', 1, dealVal);
  } else if (type === 'managed') {
    // management_fee includes GST ($660 = $600 + GST); the line is ex GST.
    addInvLine('Managed Advertising - Monthly Retainer', 1, Math.round((parseFloat(opt.dataset.fee) || 0) / 1.1 * 100) / 100);
  } else {
    // PPL client: try to get latest order qty
    prefillPplLine(opt.value, parseFloat(opt.dataset.leadPrice) || 0, opt.dataset.niche || '');
  }
}

async function prefillPplLine(clientId, leadPrice, niche) {
  const {data} = await db.from('ppl_order_log').select('leads_qty').eq('client_id', clientId).order('order_date', {ascending: false}).limit(1);
  const qty = data?.[0]?.leads_qty || 0;
  addInvLine(`${qty} x Exclusive ${niche} Leads`, qty, leadPrice);
}

// --- Generate invoice from client edit modals ---
async function generateInvoiceFromClient(type) {
  let clientId;
  if (type === 'ppl') {
    clientId = $('ep-id').value;
    closeModal('m-edit-ppl');
  } else {
    clientId = $('em-id').value;
    closeModal('m-edit-managed');
  }
  await openInvoiceModal(clientId, type);
}

// --- Save invoice ---
async function saveInvoice(andDownload) {
  const selVal = $('inv-client').value;
  if (!selVal) { alert('Please select a client or lead.'); return; }
  const opt = $('inv-client').selectedOptions[0];
  const isLead = opt.dataset.source === 'lead';
  const clientId = isLead ? null : selVal;
  const lines = getInvLines();
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const gstType = $('inv-gst').value;
  const gst = gstType === 'exclusive' ? subtotal * 0.1 : subtotal / 11;
  const total = gstType === 'exclusive' ? subtotal + gst : subtotal;

  // Derive display name: for leads use contact + company; for clients use option text
  const clientName = isLead
    ? (opt.dataset.company ? `${opt.dataset.contact} - ${opt.dataset.company}` : opt.dataset.contact || opt.textContent.trim())
    : opt.textContent.trim();

  const payload = {
    client_id: clientId,
    client_name: clientName,
    client_email: opt.dataset.email || '',
    offer_type: $('inv-offer-type').value,
    vertical: $('inv-vertical').value.trim(),
    delivery_period_start: $('inv-period-start').value || null,
    delivery_period_end: $('inv-period-end').value || null,
    line_items: lines,
    subtotal, gst_type: gstType, gst_amount: gst, total,
    payment_details: $('inv-payment-details').value.trim(),
    notes: $('inv-notes').value.trim(),
    status: 'draft',
    invoice_date: $('inv-date').value || new Date().toISOString().slice(0, 10),
    due_date: $('inv-due').value || null,
    updated_at: new Date().toISOString()
  };

  const existingId = $('inv-id').value;
  let result;
  if (existingId) {
    result = await db.from('invoices').update(payload).eq('id', existingId).select().single();
  } else {
    result = await db.from('invoices').insert(payload).select().single();
  }
  if (result.error) { alert('Error: ' + result.error.message); return; }
  closeModal('m-invoice');
  loadInvoices();
  if (andDownload) downloadInvoicePDF(result.data);
}

async function saveAndDownloadInvoice() { await saveInvoice(true); }

// --- Load / render invoice list ---
async function loadInvoices() {
  const {data, error} = await db.from('invoices').select('*').order('created_at', {ascending: false});
  if (error) { $('inv-tbody').innerHTML = `<tr><td colspan="8" class="empty">Error: ${esc(error.message)}</td></tr>`; return; }
  const all = data || [];
  setText('inv-total', all.length);
  setText('inv-draft', all.filter(i => i.status === 'draft').length);
  setText('inv-sent', all.filter(i => i.status === 'sent' || i.status === 'overdue').length);
  setText('inv-paid', all.filter(i => i.status === 'paid').length);
  if (!all.length) { $('inv-tbody').innerHTML = '<tr><td colspan="8" class="empty">No invoices yet.</td></tr>'; return; }
  const statusCls = {draft:'bg-gray',sent:'bg-blu',overdue:'bg-red',paid:'bg-grn'};
  $('inv-tbody').innerHTML = all.map(inv => `
    <tr>
      <td style="font-family:var(--mono);font-size:12px">${esc(inv.invoice_number||'-')}</td>
      <td><strong>${esc(inv.client_name||'-')}</strong></td>
      <td><span class="badge ${inv.offer_type==='managed'?'bg-amb':'bg-blu'}">${inv.offer_type==='managed'?'Managed':'PPL'}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${inv.invoice_date||'-'}</td>
      <td style="font-family:var(--mono);font-size:12px">${inv.due_date||'-'}</td>
      <td style="font-family:var(--mono);font-weight:600">$${Number(inv.total||0).toLocaleString('en-AU',{minimumFractionDigits:2})}</td>
      <td><span class="badge ${statusCls[inv.status]||'bg-gray'}"${inv.sent_at?` title="Sent to ${esc(inv.sent_to||'')} on ${esc(new Date(inv.sent_at).toLocaleString('en-AU'))}"`:''}>${esc(inv.status||'draft')}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-xs" onclick="editInvoice('${esc(String(inv.id))}')">Edit</button>
        <button class="btn btn-xs" onclick="redownloadInvoice('${esc(String(inv.id))}')">PDF</button>
        <button class="btn btn-xs" style="color:var(--blu)" onclick="openSendInvoice('${esc(String(inv.id))}')">${inv.sent_at?'Resend':'Send'}</button>
        <button class="btn btn-xs" style="color:var(--grn)" onclick="downloadReceiptPDF('${esc(String(inv.id))}')">Receipt</button>
        ${inv.status!=='paid'?`<button class="btn btn-xs" style="color:var(--grn);border-color:rgba(46,204,138,.35)" onclick="markInvoicePaid('${esc(String(inv.id))}')">Paid</button>`:(IS_REP?'':`<button class="btn btn-xs" style="color:var(--amb)" title="Marked paid by mistake? Put it back to unpaid" onclick="undoInvoicePaid('${esc(String(inv.id))}','${esc(inv.invoice_number||'')}')">Undo paid</button>`)}
        <button class="btn btn-xs" style="color:var(--red)" onclick="deleteInvoice('${esc(String(inv.id))}','${esc(inv.invoice_number||'')}')">Del</button>
      </td>
    </tr>`).join('');
}

async function markInvoicePaid(id) {
  const {error} = await db.from('invoices').update({status:'paid', updated_at: new Date().toISOString()}).eq('id', id);
  if (error) { alert(error.message); return; }
  loadInvoices();
  // Paid also ticks the month and moves the next payment date (database
  // trigger), so the client cards change too.
  if (typeof loadManaged === 'function') loadManaged();
}

// Marked paid by mistake: the database puts the invoice back to sent/overdue,
// unticks the month on the client, resets its payment dates, and withdraws
// the CSM's "send us your invoice" task (emailing them to hold off if they
// were already told). Operators only.
async function undoInvoicePaid(id, num) {
  if (!confirm('Undo paid on ' + (num || 'this invoice') + '?\n\nIt goes back to unpaid, the month is unticked on the client, and their CSM is told to hold off on invoicing.')) return;
  const {data, error} = await db.rpc('undo_invoice_paid', { p_invoice_id: id });
  if (error) { alert(error.message); return; }
  toast((num || 'Invoice') + ' is back to ' + ((data && data.status) || 'unpaid') + ' ✓');
  loadInvoices();
  if (typeof loadManaged === 'function') loadManaged();
}

async function deleteInvoice(id, num) {
  if (!confirm('Delete invoice ' + (num || '') + '? This cannot be undone.')) return;
  const {error} = await db.from('invoices').delete().eq('id', id);
  if (error) { alert(error.message); return; }
  loadInvoices();
}

async function editInvoice(id) {
  const {data: inv} = await db.from('invoices').select('*').eq('id', id).single();
  if (!inv) return;
  await openInvoiceModal();
  // Fill in fields after modal is open
  setVal('inv-id', inv.id);
  $('inv-modal-title').textContent = 'Edit ' + (inv.invoice_number || 'Invoice');
  $('inv-modal-sub').textContent = inv.client_name || '';
  setVal('inv-date', inv.invoice_date || '');
  setVal('inv-due', inv.due_date || '');
  setVal('inv-gst', inv.gst_type || 'exclusive');
  setVal('inv-vertical', inv.vertical || '');
  setVal('inv-offer-type', inv.offer_type || 'ppl');
  setVal('inv-period-start', inv.delivery_period_start || '');
  setVal('inv-period-end', inv.delivery_period_end || '');
  setVal('inv-payment-details', inv.payment_details || 'PayID: contact@quoteleads.com.au');
  setVal('inv-notes', inv.notes || '');
  // Set client dropdown
  if (inv.client_id) $('inv-client').value = String(inv.client_id);
  // Rebuild lines
  invLineCount = 0;
  $('inv-lines').innerHTML = '';
  (inv.line_items || []).forEach(li => addInvLine(li.description, li.qty, li.unit_price));
  recalcInvoice();
}

async function redownloadInvoice(id) {
  const {data: inv} = await db.from('invoices').select('*').eq('id', id).single();
  if (!inv) return;
  downloadInvoicePDF(inv);
}

// --- Send invoice by email (send-invoice edge function) ---
// A preview first: nothing goes until Send is pressed in the modal.
async function openSendInvoice(id) {
  const {data: inv} = await db.from('invoices').select('*').eq('id', id).single();
  if (!inv) { alert('Could not load that invoice.'); return; }
  const [biz, cl] = await Promise.all([
    loadBizSettings(),
    inv.client_id ? db.from('clients').select('contact_name,email').eq('id', inv.client_id).maybeSingle() : Promise.resolve({data: null}),
  ]);
  const c = cl.data || {};
  const first = String(c.contact_name || '').trim().split(/\s+/)[0];
  const money = '$' + Number(inv.total || 0).toLocaleString('en-AU', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const due = inv.due_date ? new Date(inv.due_date + 'T00:00:00').toLocaleDateString('en-AU', {day: 'numeric', month: 'long', year: 'numeric'}) : '';
  const from = biz.business_name || 'QuoteLeads';
  setVal('si-id', inv.id);
  $('si-sub').textContent = (inv.invoice_number || 'Invoice') + ' - ' + (inv.client_name || '') + (inv.sent_at ? ' (already sent to ' + (inv.sent_to || '') + ')' : '');
  setVal('si-to', inv.client_email || c.email || '');
  setVal('si-subject', 'Invoice ' + (inv.invoice_number || '') + ' from ' + from);
  setVal('si-message',
    'Hi ' + (first || 'there') + ',\n\n' +
    'Please find attached invoice ' + (inv.invoice_number || '') + ' for ' + money + (inv.gst_type === 'exclusive' ? ' including GST' : '') + (due ? ', due ' + due : '') + '.\n\n' +
    'Payment details are on the invoice. Any questions, just reply to this email.\n\n' +
    'Thanks,\n' + from);
  openModal('m-send-invoice');
}

async function sendInvoice() {
  const id = $('si-id').value;
  const to = $('si-to').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(to)) { alert('Enter the email address to send it to.'); return; }
  const btn = $('si-send');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const {data: inv} = await db.from('invoices').select('*').eq('id', id).single();
    if (!inv) throw new Error('Could not load that invoice.');
    const pdf = await downloadInvoicePDF(inv, false, true);
    const {data: {session}} = await db.auth.getSession();
    if (!session) throw new Error('Not logged in');
    const res = await fetch(_ep + '/functions/v1/send-invoice', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token},
      body: JSON.stringify({invoice_id: id, to, subject: $('si-subject').value.trim(), message: $('si-message').value.trim(), pdf_base64: pdf}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || ('send-invoice ' + res.status));
    closeModal('m-send-invoice');
    toast('Invoice sent to ' + body.to + ' ✓');
    loadInvoices();
  } catch (e) {
    alert('Not sent: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    btn.disabled = false; btn.textContent = 'Send';
  }
}

async function downloadReceiptPDF(id) {
  const {data: inv} = await db.from('invoices').select('*').eq('id', id).single();
  if (!inv) { alert('Could not load invoice data. Please try again.'); return; }
  downloadInvoicePDF(inv, true);
}

// --- PDF Generation ---
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Failed to load script: ' + src));
    document.head.appendChild(s);
  });
}
async function ensureJsPDF() {
  if (window.jspdf?.jsPDF) return;
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
  if (!window.jspdf?.jsPDF) throw new Error('Failed to load jsPDF library');
}

// Trims the logo's transparent margin so it can sit snugly in the header pill.
let QL_LOGO_TRIM = null;
async function trimmedLogo() {
  if (QL_LOGO_TRIM || !QL_LOGO_B64) return QL_LOGO_TRIM;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = QL_LOGO_B64; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (px[(y * c.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 <= x0) return null;
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  QL_LOGO_TRIM = { data: o.toDataURL('image/png'), ratio: o.width / o.height };
  return QL_LOGO_TRIM;
}

// What a management invoice covers, listed under the totals.
const INVOICE_INCLUDED = {
  managed: [
    '30 days of active ad campaign management',
    'Ongoing Meta ad optimisation (budget, audiences, creatives)',
    'A/B testing and performance adjustments',
    'Monthly performance report',
    'Lead quality monitoring and CRM pipeline review',
  ],
};
// Not in business_settings, so kept here with the rest of the invoice layout.
const INVOICE_FROM_LINES = ['contact@quoteleads.com.au', 'quoteleads.com.au'];

async function downloadInvoicePDF(inv, isReceipt, asBase64) {
  try {
  const biz = await loadBizSettings();
  await ensureJsPDF();
  const {jsPDF} = window.jspdf;
  const doc = new jsPDF({unit: 'mm', format: 'a4'});
  const pw = 210, ph = 297, mx = 15, rx = pw - mx, col2 = 105;
  const INK = [22, 27, 45], GREY = [140, 146, 158], BLUE = [47, 111, 235], RULE = [232, 235, 240];
  const NAVY = isReceipt ? [22, 140, 96] : [22, 27, 45];
  // The standard PDF fonts cover Latin-1 plus dashes and curly quotes; anything
  // else would print as junk.
  const clean = v => String(v ?? '').replace(/[^\x20-\x7E -ÿ–—‘’“”\n]/g, ' ');
  const money = n => '$' + Number(n || 0).toLocaleString('en-AU', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const day = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', {day: 'numeric', month: 'short', year: 'numeric'}) : '-';
  // jsPDF's right alignment ignores letter spacing, so measure it ourselves.
  const spacedRight = (t, xr, y, cs) => { doc.setCharSpace(0); const w = doc.getTextWidth(t) + cs * (t.length - 1); doc.setCharSpace(cs); doc.text(t, xr - w, y); doc.setCharSpace(0); };
  const label = (t, x, y, opts) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...BLUE); doc.setCharSpace(0.45); doc.text(t, x, y, opts); doc.setCharSpace(0); };
  const text = (t, x, y, size, rgb, bold, opts) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...rgb); doc.text(clean(t), x, y, opts); };

  // Bill-to details beyond what the invoice row keeps: contact name and phone.
  let client = null;
  if (inv.client_id) {
    const {data} = await db.from('clients').select('company_name,contact_name,phone,email').eq('id', inv.client_id).maybeSingle();
    client = data;
  }
  const company = client?.company_name || inv.client_name || '-';
  const billName = client?.contact_name && !String(inv.client_name || '').includes(client.contact_name)
    ? `${client.contact_name} – ${company}` : (inv.client_name || company);
  const billLines = [inv.client_email || client?.email, client?.phone].filter(Boolean);

  // Header: logo pill, document type and ABN.
  const logo = await trimmedLogo().catch(() => null);
  doc.setFillColor(0, 0, 0);
  doc.roundedRect(mx, 12.5, 38, 12.5, 2.6, 2.6, 'F');
  if (logo) {
    const h = 5.6, w = Math.min(30, h * logo.ratio);
    try { doc.addImage(logo.data, 'PNG', mx + (38 - w) / 2, 12.5 + (12.5 - h) / 2, w, h); } catch (e) {}
  } else {
    text('quoteleads', mx + 19, 20.6, 12, [255, 255, 255], true, {align: 'center'});
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...BLUE);
  spacedRight(isReceipt ? 'TAX RECEIPT' : 'TAX INVOICE', rx, 17, 0.6);
  if (biz.abn) {
    const abn = String(biz.abn).replace(/\s/g, '').replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
    text('ABN ' + abn, rx, 22, 8, GREY, false, {align: 'right'});
  }
  doc.setDrawColor(...BLUE); doc.setLineWidth(0.7); doc.line(mx, 30.7, rx, 30.7);

  // Title, number and dates.
  text(isReceipt ? 'RECEIPT' : 'INVOICE', mx - 0.6, 51, 40, INK, true);
  const num = String(inv.invoice_number || '').match(/(\d+)\s*$/);
  text('#' + (num ? num[1] : (inv.invoice_number || '')), mx, 59, 12.5, BLUE, true);
  const dateLabel = (t, y) => { doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...GREY); spacedRight(t, rx, y, 0.45); };
  dateLabel(isReceipt ? 'RECEIPT DATE' : 'ISSUE DATE', 42);
  text(day(inv.invoice_date), rx, 48, 12.5, INK, true, {align: 'right'});
  dateLabel(isReceipt ? 'PAID' : 'DUE', 56.5);
  text(isReceipt ? day(inv.invoice_date) : day(inv.due_date), rx, 62.5, 12.5, INK, true, {align: 'right'});

  // From / Bill to.
  label('FROM', mx, 76);
  label(isReceipt ? 'RECEIVED FROM' : 'BILL TO', col2, 76);
  text(biz.business_name || 'QuoteLeads', mx, 84, 12, INK, true);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  const billWrap = doc.splitTextToSize(clean(billName), rx - col2);
  text(billWrap, col2, 84, 12, INK, true);
  let fy = 90.8, by = 90.8 + (billWrap.length - 1) * 5.2;
  INVOICE_FROM_LINES.forEach(l => { text(l, mx, fy, 9.5, GREY); fy += 6.3; });
  billLines.forEach(l => { text(l, col2, by, 9.5, GREY); by += 6.3; });
  let y = Math.max(fy, by) + 4;

  // Line items.
  doc.setFillColor(...INK); doc.rect(mx, y, rx - mx, 13.5, 'F');
  text('Description', mx + 5.8, y + 8.4, 10, [255, 255, 255], true);
  text('Amount (AUD)', rx - 5.8, y + 8.4, 10, [255, 255, 255], true, {align: 'right'});
  y += 13.5;
  const period = inv.delivery_period_start && inv.delivery_period_end
    ? ` (${new Date(inv.delivery_period_start + 'T00:00:00').toLocaleDateString('en-AU', {day: 'numeric', month: 'short'})} – ${day(inv.delivery_period_end)})` : '';
  const items = inv.line_items || [];
  items.forEach((li, i) => {
    let d = clean(li.description || '');
    if (Number(li.qty) > 1) d += ` (${li.qty} × ${money(li.unit_price)})`;
    if (period && items.length === 1 && !d.includes('(')) d += period;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const wrap = doc.splitTextToSize(d, rx - mx - 45);
    const h = Math.max(14.3, 8 + wrap.length * 4.6);
    if (y + h > 250) { doc.addPage(); y = 20; }
    text(wrap, mx + 5.8, y + 8.6, 10, INK);
    text(money(li.line_total), rx - 5.8, y + 8.6, 10, INK, false, {align: 'right'});
    doc.setDrawColor(...RULE); doc.setLineWidth(0.25); doc.line(mx, y + h, rx, y + h);
    y += h;
  });
  // GST row, then the total box on the right half.
  doc.setFillColor(245, 247, 250); doc.rect(mx, y, rx - mx, 14.3, 'F');
  text(inv.gst_type === 'inclusive' ? 'GST (10%, included)' : 'GST (10%)', mx + 5.8, y + 8.6, 10, INK);
  text(money(inv.gst_amount), rx - 5.8, y + 8.6, 10, INK, false, {align: 'right'});
  y += 14.3;
  doc.setFillColor(...NAVY); doc.rect(col2, y, rx - col2, 30, 'F');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(200, 205, 215); doc.setCharSpace(0.5);
  doc.text(isReceipt ? 'AMOUNT PAID' : 'TOTAL DUE', col2 + 6.2, y + 9.5); doc.setCharSpace(0);
  text(money(inv.total), col2 + 6.2, y + 21, 25, [255, 255, 255], true);
  text('AUD', rx - 6.2, y + 22, 11, isReceipt ? [255, 255, 255] : BLUE, true, {align: 'right'});
  y += 30 + 10;

  // What's included (management invoices) and any longer notes.
  const included = INVOICE_INCLUDED[inv.offer_type] || [];
  const notes = clean(inv.notes || '').trim();
  const footerNote = notes && notes.length <= 90 && !notes.includes('\n') ? notes : 'Thank you for your business.';
  const ensure = need => { if (y + need > 278) { doc.addPage(); y = 20; } };
  if (included.length) {
    ensure(10 + included.length * 7.7);
    label("WHAT'S INCLUDED", mx, y); y += 8.5;
    included.forEach(t => {
      doc.setDrawColor(...GREY); doc.setLineWidth(0.3);
      doc.line(mx + 1, y - 1.2, mx + 4.2, y - 1.2); doc.line(mx + 3.1, y - 2.2, mx + 4.2, y - 1.2); doc.line(mx + 3.1, y - 0.2, mx + 4.2, y - 1.2);
      text(t, mx + 7.2, y, 10.5, INK); y += 7.7;
    });
    y += 3;
  }
  if (notes && notes !== footerNote) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(notes, rx - mx);
    ensure(10 + lines.length * 5);
    label('NOTES', mx, y); y += 7;
    text(lines, mx, y, 10, INK); y += lines.length * 5 + 4;
  }

  // Payment details, or the paid confirmation on a receipt.
  if (isReceipt) {
    ensure(14);
    label('PAYMENT', mx, y); y += 7.5;
    text('Payment received in full. Thank you!', mx, y, 10.5, [22, 140, 96], true);
  } else {
    let rows;
    if (inv.payment_details) {
      rows = inv.payment_details.split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => { const m = l.match(/^([^:]{1,24}):\s*(.+)$/); return m ? [m[1], m[2]] : ['', l]; });
    } else {
      rows = [['PayID', biz.payid], ['BSB', biz.bsb], ['Account', biz.account_number]].filter(r => r[1]);
    }
    if (rows.length) {
      ensure(10 + rows.length * 6.8);
      label('PAYMENT DETAILS', mx, y); y += 8.6;
      rows.forEach(([k, v]) => {
        if (k) text(k, mx, y, 10.5, INK, true);
        text(v, k ? mx + 24.8 : mx, y, 10.5, INK); y += 6.8;
      });
    }
  }

  // PAID watermark on receipts, then the footer bar on every page.
  if (isReceipt) {
    doc.saveGraphicsState(); doc.setGState(new doc.GState({opacity: 0.08}));
    text('PAID', pw / 2, ph / 2 + 20, 90, [22, 140, 96], true, {align: 'center', angle: 30});
    doc.restoreGraphicsState();
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFillColor(...INK); doc.rect(0, 282, pw, 15, 'F');
    // "Thank you for your business.  ·  quoteleads.com.au", centred as one line.
    const site = 'quoteleads.com.au', sep = '   \u00B7   ';
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    const noteW = doc.getTextWidth(clean(footerNote) + sep);
    doc.setFont('helvetica', 'bold');
    const fx = (pw - noteW - doc.getTextWidth(site)) / 2;
    text(footerNote + sep, fx, 290.6, 9.5, [200, 205, 215]);
    text(site, fx + noteW, 290.6, 9.5, [124, 170, 255], true);
  }

  // The Send button attaches the same file the PDF button downloads.
  if (asBase64) return doc.output('datauristring').split(',')[1];
  const filePrefix = isReceipt ? 'receipt-' : '';
  doc.save(filePrefix + (inv.invoice_number || 'invoice') + '.pdf');
  } catch(e) {
    console.error('PDF generation error:', e);
    if (asBase64) throw e;
    alert('PDF generation failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}

let _lastAlerts = [];
