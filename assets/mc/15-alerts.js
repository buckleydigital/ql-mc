'use strict';

// Cleared alerts are saved in dismissed_alerts, shared by the whole team and
// kept across browsers. The key is built from the ids the alert covers, so
// clearing "2 orders overdue - A, B" stays cleared while it is still those two -
// but a third client going overdue changes the key and the alert comes back.
// Clearing hides what you have seen; it cannot hide something new.
let _dismissedAlerts = new Set();
// Before clears were shared they lived in each browser under this key.
const ALERT_DISMISS_KEY = 'ql_alerts_dismissed';
async function loadDismissedAlerts() {
  const {data, error} = await db.from('dismissed_alerts').select('key');
  if (error) { console.warn('dismissed_alerts:', error.message); return _dismissedAlerts; }
  const set = new Set((data || []).map(r => r.key));
  // Carry over anything this browser cleared the old way, once.
  try {
    const local = JSON.parse(localStorage.getItem(ALERT_DISMISS_KEY) || '[]');
    if (local.length) {
      const {error: upErr} = await db.from('dismissed_alerts').upsert(local.map(key => ({key})), {onConflict: 'key', ignoreDuplicates: true});
      if (!upErr) { local.forEach(k => set.add(k)); localStorage.removeItem(ALERT_DISMISS_KEY); }
    }
  } catch (_) {}
  return set;
}
async function saveDismissedAlerts(keys) {
  const {error} = await db.from('dismissed_alerts').upsert(keys.map(key => ({key})), {onConflict: 'key', ignoreDuplicates: true});
  if (error) toast('Could not save that: ' + error.message, true);
}
// Forget clears whose alert has gone (the payment came in, the order was
// delivered), so if the same thing happens again it alerts again.
async function pruneDismissedAlerts() {
  const live = new Set(_lastAlerts.map(a => a.key));
  const stale = [..._dismissedAlerts].filter(k => !live.has(k));
  if (!stale.length) return;
  const {error} = await db.from('dismissed_alerts').delete().in('key', stale);
  if (!error) stale.forEach(k => _dismissedAlerts.delete(k));
}

function buildAlertItems(overdueOrders, overduePayments, crmFollowups, dueSoonOrders, reportsDue = [], invoicesDue = [], perfReportsDue = []) {
  const items = [];
  const keyOf = (prefix, ids) => prefix + ':' + ids.map(String).sort().join(',');
  if (overdueOrders.length > 0) {
    const names = overdueOrders.map(o => o.clients?.company_name || 'Unknown').join(', ');
    items.push({type:'error', msg: `${overdueOrders.length} PPL order${overdueOrders.length>1?'s':''} past SLA due date - ${names}`, panel:'ppl',
      key: keyOf('sla', overdueOrders.map(o => o.id))});
  }
  if (overduePayments.length > 0) {
    // Naming them is the whole point: "1 managed client with overdue payment"
    // tells you there is a problem and then makes you go hunting for which.
    const names = overduePayments.map(c => c.company_name || 'Unknown').join(', ');
    items.push({type:'error', msg: `${overduePayments.length} managed client${overduePayments.length>1?'s':''} with overdue payment - ${names}`, panel:'managed',
      key: keyOf('pay', overduePayments.map(c => c.id))});
  }
  if (dueSoonOrders.length > 0) {
    const names = dueSoonOrders.map(o => o.clients?.company_name || 'Unknown').join(', ');
    items.push({type:'warn', msg: `${dueSoonOrders.length} PPL order${dueSoonOrders.length>1?'s':''} SLA due within 7 days - ${names}`, panel:'ppl',
      key: keyOf('soon', dueSoonOrders.map(o => o.id))});
  }
  if (crmFollowups.length > 0) {
    items.push({type:'warn', msg: `${crmFollowups.length} CRM lead${crmFollowups.length>1?'s':''} need follow-up`, panel:'crm',
      key: keyOf('crm', crmFollowups.map(l => l.id))});
  }
  // One alert per client, so clearing one when it's done doesn't bring the
  // others back. Clearing a report reminder means it's been sent.
  for (const c of reportsDue) {
    items.push({type:'warn', msg: `Send ${c.company_name || 'client'} their first month report - ads went live ${c.ads_first_live_date}`, panel:'managed',
      key: `report:${c.id}`});
  }
  // Keyed on the due date too, so next month's invoice is a new reminder.
  for (const c of invoicesDue) {
    items.push({type:'warn', msg: `Prepare invoice for ${c.company_name || 'client'} - next payment due ${c.next_payment_date}`, panel:'managed',
      key: `invoice:${c.id}:${c.next_payment_date}`});
  }
  for (const c of perfReportsDue) {
    items.push({type:'warn', msg: `Prepare ${c.company_name || 'client'}'s performance report - payment date ${c.next_payment_date}`, panel:'managed',
      key: `perf:${c.id}:${c.next_payment_date}`});
  }
  return items;
}

const visibleAlerts = () => _lastAlerts.filter(a => !_dismissedAlerts.has(a.key));

function dismissAlert(key) {
  _dismissedAlerts.add(key);
  updateAlertBadge(visibleAlerts().length);
  renderAlertTray();
  saveDismissedAlerts([key]);
}

function clearAllAlerts() {
  const keys = _lastAlerts.map(a => a.key);
  keys.forEach(k => _dismissedAlerts.add(k));
  updateAlertBadge(0);
  renderAlertTray();
  saveDismissedAlerts(keys);
}

function updateAlertBadge(count) {
  const badge = $('alert-tray-badge');
  if (badge) { badge.textContent=count; badge.style.display=count>0?'':'none'; }
}

function toggleAlertTray() {
  const tray = $('alert-tray');
  if (!tray) return;
  const open = tray.style.display !== 'none';
  tray.style.display = open ? 'none' : 'block';
  if (!open) renderAlertTray();
}

function renderAlertTray() {
  const body = $('alert-tray-body'); if (!body) return;
  const shown = visibleAlerts();
  // Cleared means gone. No count of hidden items and no way back - if you have
  // decided you are done with an alert, being reminded that you dismissed it is
  // just the same alert wearing a smaller font.
  //
  // It is still not permanent in the way deleting a row would be, and that is
  // deliberate: the dismissal is keyed on the ids the alert covers, so clearing
  // "2 orders overdue - A, B" stays cleared for exactly those two. A third
  // client going overdue is a different key and comes back. You can silence
  // what you have seen; you cannot silence what has not happened yet.
  if (!shown.length) {
    body.innerHTML = '<div style="color:var(--grn);font-size:13px">✓ All clear - no active alerts.</div>';
    return;
  }
  body.innerHTML = shown.map(a=>`<div style="margin-bottom:8px;padding:8px 10px;background:${a.type==='error'?'rgba(255,69,96,.08)':'rgba(245,166,35,.07)'};border:1px solid ${a.type==='error'?'rgba(255,69,96,.25)':'rgba(245,166,35,.25)'};border-radius:var(--r);font-size:12px;display:flex;align-items:center;gap:8px"><span style="color:${a.type==='error'?'var(--red)':'var(--amb)'}">⚠</span><span style="flex:1">${esc(a.msg)}</span><button class="btn btn-xs" onclick="nav('${a.panel}',document.querySelector('[data-panel=\\'${a.panel}\\']'));toggleAlertTray()" style="font-size:12px" title="Go to it">→</button><button class="btn btn-xs" onclick="dismissAlert('${esc(a.key)}')" style="font-size:12px" title="Clear this alert">✕</button></div>`).join('')
    + `<div style="margin-top:4px">
         <button class="btn btn-xs" onclick="clearAllAlerts()" style="font-size:12px">Clear all</button>
       </div>`;
}

async function loadAlerts() {
  // Sydney's date, not UTC's, so morning reminders aren't a day behind.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const weekAhead = new Date(Date.now() + MS_PER_WEEK).toISOString().split('T')[0];
  const [slaR, mgR, crmR, dueSoonR] = await Promise.all([
    db.from('ppl_order_log').select('id,client_id,sla_due_date,clients(company_name)').eq('status','in_progress').lte('sla_due_date',today).not('sla_due_date','is',null),
    db.from('clients').select('id,stage,next_payment_date,company_name,ads_first_live_date,active_months').eq('type','managed'),
    db.from('leads').select(CRM_FOLLOWUP_COLS).not('stage','in','(closed_won,closed_lost,churned)'),
    db.from('ppl_order_log').select('id,client_id,sla_due_date,clients(company_name)').eq('status','in_progress').gt('sla_due_date',today).lte('sla_due_date',weekAhead).not('sla_due_date','is',null),
  ]);
  const overdueOrders = slaR.data||[];
  // The rows, not a count - an alert that cannot name the client makes you go
  // looking for it, which is most of the work it was supposed to save.
  const overduePayments = (mgR.data||[]).filter(c=>c.stage==='active'&&c.next_payment_date&&c.next_payment_date<today);
  const dueSoonOrders = dueSoonR.data||[];
  const crmFollowups = (crmR.data||[]).filter(l=>crmNeedsFollowup(l));
  // Managed clients: first month report 30 days after ads go live (shown until
  // day 60 so a late one still gets caught), a prepare-invoice reminder from 7
  // days before each payment date, and a performance report on the payment
  // date (kept for 3 days so a quiet day doesn't lose it). The last two match
  // the tasks create_billing_reminder_tasks() adds each morning, and are for
  // admins only.
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().split('T')[0]; };
  const activeMg = (mgR.data||[]).filter(c=>c.stage==='active');
  const reportsDue = activeMg.filter(c=>c.ads_first_live_date&&addDays(c.ads_first_live_date,30)<=today&&today<addDays(c.ads_first_live_date,60));
  const billing = IS_REP ? [] : activeMg.filter(c=>c.next_payment_date);
  const invoicesDue = billing.filter(c=>addDays(c.next_payment_date,-7)<=today&&today<=c.next_payment_date);
  const perfReportsDue = billing.filter(c=>c.next_payment_date<=today&&today<=addDays(c.next_payment_date,3));
  _lastAlerts = buildAlertItems(overdueOrders, overduePayments, crmFollowups, dueSoonOrders, reportsDue, invoicesDue, perfReportsDue);
  _dismissedAlerts = await loadDismissedAlerts();
  // Only prune off a complete picture: a failed query would make every alert
  // it feeds look resolved and wipe their clears.
  if (![slaR, mgR, crmR, dueSoonR].some(r => r.error)) await pruneDismissedAlerts();
  updateAlertBadge(visibleAlerts().length);
}
