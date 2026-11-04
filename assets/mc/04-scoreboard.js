'use strict';

// ── How long a lead has been where it is ────────────────────────────────────
const DAY_MS = 86400000;
const daysSince = ts => ts ? Math.max(0, Math.floor((Date.now() - new Date(ts)) / DAY_MS)) : null;
// When it reached its current stage: the won or lost date for a closed lead,
// else the last stage change, else when it came in.
const stageSince = l => (l.stage === 'closed_won' && l.won_at) || (l.stage === 'closed_lost' && l.lost_at) || l.stage_changed_at || l.created_at;
function stageAgeLine(l) {
  if (l.stage === 'closed_won' && l.won_at) {
    const d = Math.max(0, Math.round((new Date(l.won_at) - new Date(l.created_at)) / DAY_MS));
    return `<div class="kcard-meta" style="font-size:12px;font-family:var(--mono);color:var(--grn)">won in ${d}d</div>`;
  }
  if (l.stage === 'closed_lost') return '';
  const inStage = daysSince(stageSince(l)), total = daysSince(l.created_at);
  return `<div class="kcard-meta" style="font-size:12px;font-family:var(--mono);color:var(--ink3)">${inStage}d in stage · ${total}d since lead</div>`;
}

// ── Sales metrics for the chosen period ─────────────────────────────────────
// Each counts what happened in the period: leads that came in, offers sent,
// sales won. A sales rep sees their own leads and never anything about ad
// spend. The owner viewing as a rep sees that rep's share of the spend (the
// spend × their leads ÷ all leads), from pipeline_spend. Revenue is the deal
// value as recorded, incl. GST; gross profit takes the GST off first.
let smSpendCache = {};
async function pipelineSpend(from, to) {
  const k = `${from || ''}:${to || ''}`;
  if (!smSpendCache[k]) {
    smSpendCache[k] = db.rpc('pipeline_spend', { p_from: from || null, p_to: to || null })
      .then(({ data, error }) => error ? null : (data || [])[0] || null);
  }
  return smSpendCache[k];
}
// Every lead (not just those created in the period: an offer or sale in it may
// be from an older lead), scoped to the rep being viewed.
let sbRange = 'month', sbRep = '';
function refreshSalesMetrics() { loadAdInsights(); return renderSalesMetrics(sbRep ? (crmPipelineLeads || []).filter(l => l.owner_id === sbRep) : (crmPipelineLeads || [])); }
function sbDateRange() {
  if (!sbRange) return null;
  if (sbRange !== 'custom') return getDateRange(sbRange);
  const f = $('sb-date').value, t = $('sb-date-to').value;
  if (!f) return getDateRange('month');
  return { from: f, to: t && t >= f ? t : f };
}
function switchSbPeriod(range, el) {
  sbRange = range;
  document.querySelectorAll('.sb-period-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const show = range === 'custom' ? 'inline-block' : 'none';
  $('sb-date').style.display = show; $('sb-date-to').style.display = show;
  refreshSalesMetrics();
}
// The Scoreboard reads the same leads the pipeline does; it loads them if the
// pipeline hasn't been opened yet.
async function loadScoreboard() {
  if (!crmPipelineLeads.length) await loadCRM();
  const src = $('crm-rep-view'), dst = $('sb-rep');
  if (!IS_REP && src && dst && dst.options.length < 2) { dst.innerHTML = src.innerHTML; dst.value = sbRep; }
  if (!IS_REP && !Object.keys(crmBizTotals).length) await loadCrmLtv();
  refreshSalesMetrics();
  loadGuardrails(false);
}

// ── Meta ads ────────────────────────────────────────────────────────────────
// Straight from Meta by agency-spend-sync each morning, per campaign and ad,
// for the Scoreboard's period. Owner only, like every spend figure.
let _adsReq = 0;
async function loadAdInsights() {
  if (IS_REP || !$('ads-body')) return;
  const req = ++_adsReq;
  const r = sbDateRange();
  const { data, error } = await db.rpc('ad_insights_report', { p_from: r?.from || null, p_to: r?.to || null });
  if (req !== _adsReq) return;
  if (error) { $('ads-body').innerHTML = `<div class="empty" style="color:var(--red)">${esc(error.message)}</div>`; return; }
  renderAdInsights(data || {});
}
function renderAdInsights(d) {
  const money = v => v == null ? '-' : '$' + Number(v).toLocaleString('en-AU', { minimumFractionDigits: Number(v) < 100 ? 2 : 0, maximumFractionDigits: Number(v) < 100 ? 2 : 0 });
  const num = v => v == null ? '-' : Number(v).toLocaleString('en-AU');
  const pct = v => v == null ? '-' : v + '%';
  const when = d.synced_at ? new Date(d.synced_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  setText('ads-sub', when ? `from Meta, synced ${when}` : '');
  if (!d.account_id) {
    $('ads-body').innerHTML = `<div class="empty" style="text-align:left;line-height:1.6">Add the QuoteLeads ad account ID under <strong>Guardrail settings</strong> below and press Save. Spend, clicks, cost per click, click rate, cost per 1,000 views and leads then come straight from Meta every morning, for each campaign and ad.</div>`;
    return;
  }
  const err = d.error ? `<div style="font-size:12px;color:var(--red);margin-bottom:8px">${esc(d.error)}</div>` : '';
  if (!d.has_data) {
    $('ads-body').innerHTML = err + `<div class="empty">${when ? 'No ad activity in this period.' : 'Not synced yet - press Sync spend now under Guardrail settings.'}</div>`;
    return;
  }
  const t = d.total || {};
  const card = (label, v, sub = '') => `<div class="kpi"><div class="klabel">${label}</div><div class="kval">${v}</div><div class="ksub">${sub}</div></div>`;
  const cards = `<div class="kg c4 mb4">
    ${card('Spend', money(t.spend))}${card('Impressions', num(t.impressions), 'cost per 1,000: ' + money(t.cpm))}
    ${card('Clicks', num(t.clicks), 'click rate ' + pct(t.ctr) + ' · ' + money(t.cpc) + ' a click')}
    ${card('Meta leads', num(t.leads), t.cpl != null ? money(t.cpl) + ' a lead' : 'Meta counted none')}</div>`;
  const row = (x, isAd) => `<tr${isAd ? ' style="font-size:12px"' : ' style="font-weight:600"'}>
      <td style="${isAd ? 'padding-left:22px;' : ''}white-space:normal;min-width:200px">${esc((isAd ? x.ad_name : x.campaign_name) || '(unnamed)')}${isAd && x.adset_name ? `<div style="color:var(--ink3);font-weight:400">${esc(x.adset_name)}</div>` : ''}</td>
      <td style="font-family:var(--mono)">${money(x.spend)}</td><td style="font-family:var(--mono)">${num(x.impressions)}</td>
      <td style="font-family:var(--mono)">${num(x.clicks)}</td><td style="font-family:var(--mono)">${pct(x.ctr)}</td>
      <td style="font-family:var(--mono)">${money(x.cpc)}</td><td style="font-family:var(--mono)">${money(x.cpm)}</td>
      <td style="font-family:var(--mono)">${num(x.leads)}</td><td style="font-family:var(--mono)">${money(x.cpl)}</td></tr>`;
  const rows = (d.campaigns || []).map(c => row(c, false) + (c.ads || []).map(a => row(a, true)).join('')).join('');
  $('ads-body').innerHTML = err + cards + `<div class="twrap"><table><thead><tr><th>Campaign / ad</th><th>Spend</th><th>Impressions</th><th>Clicks</th><th>Click rate</th><th>Cost per click</th><th>Per 1,000</th><th>Meta leads</th><th>Cost per lead</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="font-size:12px;color:var(--ink3);margin-top:6px">Meta leads are what Meta counted (form submits and website leads), not what reached the pipeline. Today shows from tomorrow morning.</div>`;
}

// ── Guardrails ──────────────────────────────────────────────────────────────
// Graded in the database (guardrail_metrics), so the Scoreboard, the morning
// digest and QuoteLeadsAI's alerts always agree. Owner only.
let grData = null;
const GR_LEVEL = {
  green: ['bg-grn', 'Green'], watch: ['bg-gray', 'Watch'], warning: ['bg-amb', 'Amber'],
  breach: ['bg-red', 'Red'], no_data: ['bg-gray', 'No data'], off: ['bg-gray', 'Off'],
};
const GR_SIGNAL = {
  green: ['var(--grn)', 'Green: scale 20 to 25%'],
  amber: ['var(--amb)', 'Amber: hold spend and fix'],
  red: ['var(--red)', 'Red: pause scaling'],
};
function grFmt(m, v) {
  if (v == null || v === '') return '-';
  const u = m.unit || '';
  return u === '$' ? '$' + v : v + (u ? (u.startsWith('%') ? u : ' ' + u) : '');
}
async function loadGuardrails(refresh) {
  if (IS_REP || !$('gr-body')) return;
  const { data, error } = await db.rpc('guardrail_report', { p_refresh: !!refresh });
  if (error) { $('gr-body').innerHTML = `<tr><td colspan="6" class="empty" style="color:var(--red)">Error: ${esc(error.message)}</td></tr>`; return; }
  grData = data;
  renderGuardrails();
  if (refresh) toast('Guardrails re-checked');
}
function renderGuardrails() {
  const d = grData; if (!d) return;
  const ms = d.metrics || [];
  const red = ms.filter(m => m.level === 'breach').length, amber = ms.filter(m => m.level === 'warning').length;
  const sig = GR_SIGNAL[d.signal] || GR_SIGNAL.green;
  const snap = d.snapshot;
  setText('gr-sub', snap ? `morning digest ${new Date(snap.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'no digest yet');
  $('gr-signal').innerHTML = `<div style="padding:12px 16px;border-radius:var(--r2);border:1px solid ${sig[0]};background:var(--s1);margin-bottom:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <strong style="color:${sig[0]};font-size:15px">${sig[1]}</strong>
    <span style="font-size:12px;color:var(--ink3)">${red} red · ${amber} amber, right now. Amber and red go to QuoteLeadsAI each morning; speed-to-lead and spend pacing as they happen. Each Monday: the weekly review.</span></div>`;
  $('gr-body').innerHTML = ms.map(m => {
    const [cls, word] = GR_LEVEL[m.level] || GR_LEVEL.no_data;
    const lines = `${m.dir === 'low' ? '≥' : '≤'}${grFmt(m, m.green)} · ${m.dir === 'low' ? '<' : '>'}${grFmt(m, m.warn)} · ${m.breach == null ? '-' : (m.dir === 'low' ? '<' : '>') + grFmt(m, m.breach)}`;
    return `<tr style="${m.level === 'off' ? 'opacity:.5' : ''}">
      <td style="font-weight:600;white-space:nowrap">${esc(m.label)}${m.realtime ? ' <span class="badge bg-gray" title="Checked every 15 minutes">live</span>' : ''}</td>
      <td style="font-family:var(--mono);white-space:nowrap">${esc(m.display || '-')}</td>
      <td><span class="badge ${cls}">${word}</span></td>
      <td style="font-family:var(--mono);font-size:12px;white-space:nowrap">${esc(lines)}</td>
      <td style="font-size:12px;color:var(--ink2);min-width:220px;white-space:normal">${esc(m.detail || '')}</td>
      <td style="font-size:12px;min-width:220px;white-space:normal"><strong>${esc(m.owner || '')}</strong>${m.action ? ': ' + esc(m.action) : ''}</td>
    </tr>`;
  }).join('');
  const cac = ms.find(m => m.key === 'cohort_cac');
  const money = v => v == null ? '-' : '$' + Math.round(Number(v)).toLocaleString('en-AU');
  $('gr-cohorts').innerHTML = (cac?.cohorts || []).length ? cac.cohorts.map(c => `<tr style="${c.leads < 5 ? 'opacity:.55' : ''}">
      <td style="font-family:var(--mono)">${new Date(c.week + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
      <td style="font-family:var(--mono)">${c.leads}</td><td style="font-family:var(--mono)">${c.sales}</td>
      <td style="font-family:var(--mono)">${c.spend == null ? 'not synced' : money(c.spend)}</td>
      <td style="font-family:var(--mono)">${c.cac != null ? money(c.cac) : c.spend > 0 ? 'no sales' : '-'}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No week is 21 days old yet</td></tr>';
  renderGuardrailSettings();
}
function renderGuardrailSettings() {
  const d = grData, st = d.settings || {}, mm = st.metrics || {};
  const inp = (id, v, w = 70, type = 'number') => `<input class="fi" id="${id}" type="${type}" value="${v == null ? '' : esc(String(v))}" style="width:${w}px;font-size:12px;padding:5px 8px">`;
  $('gr-settings').innerHTML = `
    <div id="gr-spend" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;align-items:center;padding:10px 12px;border:1px solid var(--bd);border-radius:var(--r2)"></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;align-items:center">
      <label>Planned ad spend a day $ ${inp('gr-plan-spend', st.plan_daily_spend, 90)}</label>
      <label>Planned leads a week ${inp('gr-plan-leads', st.plan_weekly_leads, 80)}</label>
      <span style="color:var(--ink3)">Spend pacing and lead volume need these.</span>
    </div>
    <div class="twrap mb4"><table><thead><tr><th>On</th><th>Metric</th><th>Green</th><th>Amber past</th><th>Red past</th><th>Owner</th><th>Action</th></tr></thead><tbody>
    ${(d.metrics || []).map(x => [x.key, mm[x.key]]).filter(([, m]) => m).map(([k, m]) => `<tr>
      <td><input type="checkbox" id="gr-on-${k}" ${m.on !== false ? 'checked' : ''}></td>
      <td style="font-size:12px;white-space:nowrap">${esc(m.label)} <span style="color:var(--ink3)">(${esc(m.unit || 'count')}, ${m.dir === 'low' ? 'lower is worse' : 'higher is worse'})</span></td>
      <td>${inp('gr-green-' + k, m.green)}</td><td>${inp('gr-warn-' + k, m.warn)}</td><td>${inp('gr-breach-' + k, m.breach)}</td>
      <td>${inp('gr-owner-' + k, m.owner, 110, 'text')}</td><td>${inp('gr-action-' + k, m.action, 320, 'text')}</td></tr>`).join('')}
    </tbody></table></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="btn btn-p btn-sm" onclick="saveGuardrailSettings()">Save guardrails</button>
    <button class="btn btn-sm" onclick="resetGuardrailSettings()">Back to defaults</button>
    <span style="font-size:12px;color:var(--ink3)">Leave Red empty for a warning-only line.</span></div>`;
  loadSpendSync();
}
// The QuoteLeads ad account's daily spend, pulled from Meta each morning
// (agency-spend-sync). Every spend figure on the Scoreboard adds these days up.
async function loadSpendSync() {
  const el = $('gr-spend'); if (!el) return;
  const { data: bs } = await db.from('business_settings').select('agency_ad_account_id, agency_spend_synced_at, agency_spend_error').limit(1).maybeSingle();
  const when = bs?.agency_spend_synced_at ? new Date(bs.agency_spend_synced_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  el.innerHTML = `<strong>Daily ad spend from Meta</strong>
    <label>QuoteLeads ad account ID <input class="fi" id="gr-acct" value="${esc(bs?.agency_ad_account_id || '')}" placeholder="act_1234567890" style="width:170px;font-size:12px;padding:5px 8px"></label>
    <button class="btn btn-sm" onclick="saveSpendAccount()">Save</button>
    <button class="btn btn-sm" onclick="syncSpendNow(false)">Sync spend now</button>
    <button class="btn btn-sm" onclick="syncSpendNow(true)" title="Re-fetch every day since 1 January">Re-fetch the year</button>
    <span style="color:${bs?.agency_spend_error ? 'var(--red)' : 'var(--ink3)'}">${bs?.agency_spend_error ? esc(bs.agency_spend_error) : when ? `Last synced ${when}. Runs every morning at 7:05.` : 'Not synced yet.'}</span>`;
}
async function saveSpendAccount() {
  const v = $('gr-acct').value.trim().replace(/^act_/, '');
  if (v && !/^\d+$/.test(v)) { toast('The ad account ID is the number after act_', true); return; }
  const existing = await db.from('business_settings').select('id').limit(1).single();
  if (!existing.data) { toast('Save Business Settings once first', true); return; }
  const { error } = await db.from('business_settings').update({ agency_ad_account_id: v || null, updated_at: now() }).eq('id', existing.data.id);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Ad account saved ✓');
  if (v) await syncSpendNow(false); else loadSpendSync();
}
async function syncSpendNow(backfill) {
  toast(backfill ? 'Fetching every day since 1 January…' : 'Syncing spend…');
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(`${_ep}/functions/v1/agency-spend-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ backfill }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { toast('Spend sync failed: ' + (out.error || res.status), true); loadAdInsights(); }
  else { toast(`Spend synced: ${out.days} days, ${out.since} to ${out.until}`); smSpendCache = {}; refreshSalesMetrics(); loadGuardrails(false); }
  loadSpendSync();
}
// Only what differs from the defaults is stored, so a better default later
// still reaches every line nobody changed.
async function saveGuardrailSettings() {
  const def = (grData.defaults || {}).metrics || {};
  const num = id => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
  const out = { metrics: {} };
  const ps = num('gr-plan-spend'), pl = num('gr-plan-leads');
  if (ps != null) out.plan_daily_spend = ps;
  if (pl != null) out.plan_weekly_leads = pl;
  for (const k of Object.keys(def)) {
    const now = { on: $('gr-on-' + k).checked, green: num('gr-green-' + k), warn: num('gr-warn-' + k), breach: num('gr-breach-' + k),
      owner: $('gr-owner-' + k).value.trim(), action: $('gr-action-' + k).value.trim() };
    if ([now.green, now.warn, now.breach].some(v => v != null && !isFinite(v))) { toast(`${def[k].label}: lines must be numbers`, true); return; }
    const diff = {};
    for (const [f, v] of Object.entries(now)) if (JSON.stringify(v) !== JSON.stringify(def[k][f] ?? null)) diff[f] = v;
    if (Object.keys(diff).length) out.metrics[k] = diff;
  }
  await writeGuardrails(out);
}
async function resetGuardrailSettings() {
  if (!confirm('Put every guardrail line, owner and action back to the defaults? The spend and lead plans are kept.')) return;
  const st = grData.settings || {};
  const out = { metrics: {} };
  if (st.plan_daily_spend != null) out.plan_daily_spend = st.plan_daily_spend;
  if (st.plan_weekly_leads != null) out.plan_weekly_leads = st.plan_weekly_leads;
  await writeGuardrails(out);
}
async function writeGuardrails(value) {
  const existing = await db.from('business_settings').select('id').limit(1).single();
  if (!existing.data) { toast('Save Business Settings once first', true); return; }
  const { error } = await db.from('business_settings').update({ guardrails: value, updated_at: now() }).eq('id', existing.data.id);
  if (error) { toast('Error: ' + error.message, true); return; }
  toast('Guardrails saved ✓');
  // Re-grade today's digest against the new lines.
  await loadGuardrails(true);
}
async function renderSalesMetrics(leads) {
  const el = $('sales-metrics'); if (!el) return;
  const range = sbDateRange();
  const inRange = ts => { if (!ts) return false; if (!range) return true; const d = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); return d >= range.from && d <= range.to; };
  const came = leads.filter(l => inRange(l.created_at));
  const contactable = came.filter(l => l.contactable === true).length;
  const offers = leads.filter(l => inRange(l.offer_sent_at)).length;
  const sales = leads.filter(l => l.stage === 'closed_won' && inRange(l.won_at || l.stage_changed_at));
  const revenue = sales.reduce((a, l) => a + Number(l.value || 0), 0);
  const days = sales.filter(l => l.won_at).map(l => (new Date(l.won_at) - new Date(l.created_at)) / DAY_MS);
  const sp = IS_REP ? null : await pipelineSpend(range?.from, range?.to);
  const scoped = !!sbRep;
  let spend = sp ? Number(sp.spend) : null;
  if (spend != null && scoped) spend = sp.leads_total ? spend * came.length / Number(sp.leads_total) : 0;
  // LTV: what the business has been billed in total, where we can see it (not
  // for reps), else the deal value.
  const ltvs = sales.map(l => {
    const biz = String(l.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return (!IS_REP && biz && crmBizTotals[biz]) || Number(l.value || 0);
  }).filter(v => v > 0);
  const per = (a, b) => b ? a / b : null;
  const money = v => v == null || !isFinite(v) ? '-' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-AU', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 });
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '';
  const n = v => v == null ? '-' : v.toLocaleString('en-AU');
  const gp = sales.length && spend != null ? (revenue / 1.1 - spend) / sales.length : null;
  // Anything built on ad spend, and client lifetime value: a rep sees neither.
  const SPEND_CARDS = ['Spent on Ads', 'Return on Ad Spend', 'Cost per Lead', 'Cost per Offer Sent', 'CAC', 'Avg Gross Profit', 'Average LTV'];
  const cards = [
    ['Lead Volume', n(came.length), 'came in', 'blu'],
    ['Contactable', n(contactable), pct(contactable, came.length) && pct(contactable, came.length) + ' of leads', ''],
    ['Sent Offer', n(offers), pct(offers, contactable) && pct(offers, contactable) + ' of contactable', ''],
    ['Sales', n(sales.length), pct(sales.length, offers) && pct(sales.length, offers) + ' of offers', 'grn'],
    ['Revenue', money(revenue), 'incl. GST', 'grn'],
    ['Spent on Ads', money(spend), scoped ? 'share for these leads' : 'QuoteLeads ad account', ''],
    ['Return on Ad Spend', spend ? (revenue / spend).toFixed(2) + 'x' : '-', 'revenue ÷ ad spend', ''],
    ['Cost per Lead', money(per(spend, came.length)), '', ''],
    ['Value per Lead', money(per(revenue, came.length)), 'revenue ÷ leads', ''],
    ['Average LTV', money(per(ltvs.reduce((a, v) => a + v, 0), ltvs.length)), IS_REP ? 'deal value' : 'billed to date, per client won', 'grn'],
    ['AOV', money(per(revenue, sales.length)), 'revenue ÷ sales', ''],
    ['Cost per Offer Sent', money(per(spend, offers)), '', ''],
    ['CAC', money(per(spend, sales.length)), 'ad spend ÷ sales', ''],
    ['Avg Gross Profit', money(gp), 'per sale: revenue ex GST less ad spend', gp != null && gp < 0 ? 'red' : 'grn'],
    ['Avg Days to Sale', days.length ? (days.reduce((a, d) => a + d, 0) / days.length).toFixed(1) : '-', 'lead in → won', ''],
  ];
  // Three rows: how leads move, what they're worth, what they cost.
  const GROUPS = [
    ['Funnel', ['Lead Volume', 'Contactable', 'Sent Offer', 'Sales', 'Avg Days to Sale']],
    ['Money', ['Revenue', 'Spent on Ads', 'Return on Ad Spend', 'AOV', 'Average LTV', 'Avg Gross Profit']],
    ['Unit economics', ['Cost per Lead', 'Value per Lead', 'Cost per Offer Sent', 'CAC']],
  ];
  const card = ([label, val, sub, cls]) =>
    `<div class="kpi"><div class="klabel">${label}</div><div class="kval ${cls}">${val}</div>${sub ? `<div class="ksub">${esc(sub)}</div>` : ''}</div>`;
  el.innerHTML = GROUPS.map(([title, names]) => {
    const row = names.map(nm => cards.find(c => c[0] === nm)).filter(c => c && (!IS_REP || !SPEND_CARDS.includes(c[0])));
    return row.length ? `<div style="font-size:12px;font-weight:600;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px">${title}</div><div class="kg kg-fit mb4">${row.map(card).join('')}</div>` : '';
  }).join('');
  const scope = IS_REP ? 'your leads' : sbRep ? `${repName(sbRep) || 'rep'}'s leads` : 'all leads';
  const stale = !IS_REP && sp?.spend_updated ? ` · ad spend to ${new Date(sp.spend_updated + 'T00:00:00').toLocaleDateString('en-AU')}` : '';
  setText('sm-scope', `${range ? `${range.from} to ${range.to}` : 'all time'} · ${scope}${stale}`);
  // Open pipeline: how many in each stage and how long they've sat there.
  const age = $('sm-stage-age');
  if (age) {
    age.innerHTML = CRM_STAGES.filter(s => !['closed_won', 'closed_lost'].includes(s.id)).map(s => {
      const inIt = leads.filter(l => l.stage === s.id);
      if (!inIt.length) return '';
      const avg = inIt.reduce((a, l) => a + daysSince(stageSince(l)), 0) / inIt.length;
      const oldest = Math.max(...inIt.map(l => daysSince(stageSince(l))));
      return `<span style="font-size:12px;font-family:var(--mono);background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:4px 10px">${esc(s.label)}: ${inIt.length} · avg ${avg.toFixed(0)}d in stage · oldest ${oldest}d</span>`;
    }).join('');
  }
}

// Average lifetime value per BUSINESS, all time - the same sums as Financials:
// a managed client's logged orders (build fee, setup...) plus months active x
// management fee, and a PPL client's lead orders (leads x price). A business
// with more than one client record (managed and PPL, or entered twice) is one
// business: its records are added together, matched on company name ignoring
// case, spaces and punctuation. Businesses with nothing billed are left out.
// It is only as complete as the records: a managed month not ticked is a
// month not counted. Admin only.
// The Avg Won Deal and Avg Client LTV cards start hidden on every load; the
// button beside "View as rep" shows or hides both.
function togglePrivateKpis() {
  let shown = false;
  document.querySelectorAll('.kpi-private').forEach(k => { shown = !k.classList.toggle('masked'); });
  setText('crm-private-btn', shown ? 'Hide deal value & LTV' : 'Show deal value & LTV');
}

async function loadCrmLtv() {
  const [cR, pR, mR] = await Promise.all([
    db.from('clients').select('id,type,company_name,management_fee,active_months,retainer_payment_dates,retainer_amounts'),
    db.from('ppl_order_log').select('client_id,leads_qty,lead_price'),
    db.from('managed_order_log').select('client_id,amount'),
  ]);
  if (cR.error || pR.error || mR.error) { setText('crm-ltv', '-'); setText('crm-ltv-sub', 'could not load'); return; }
  const bizOf = {}, total = {};
  (cR.data || []).forEach(c => {
    const biz = String(c.company_name || c.id).toLowerCase().replace(/[^a-z0-9]/g, '') || c.id;
    bizOf[c.id] = biz;
    if (c.type === 'managed') {
      total[biz] = (total[biz] || 0) + mgPayments(c).reduce((a, p) => a + p.amt, 0);
    }
  });
  const add = (clientId, v) => { const biz = bizOf[clientId]; if (biz && v) total[biz] = (total[biz] || 0) + Number(v); };
  (pR.data || []).forEach(o => add(o.client_id, (o.leads_qty || 0) * (o.lead_price || 0)));
  (mR.data || []).forEach(o => add(o.client_id, o.amount || 0));
  const billed = Object.keys(total).filter(b => total[b] > 0);
  crmBizTotals = total;
  const avg = arr => arr.length ? arr.reduce((a, b) => a + total[b], 0) / arr.length : 0;
  const money = v => '$' + Math.round(v).toLocaleString('en-AU');
  setText('crm-ltv', billed.length ? money(avg(billed)) : '-');
  setText('crm-ltv-sub', billed.length
    ? billed.length + ' businesses'
    : 'no billed clients yet');
}

// Rep performance strip: close rate and open leads.
// All data here is already RLS-scoped to the rep's own assigned leads.
function loadRepStats() {
  const leads = crmPipelineLeads || [];
  const CLOSED = ['closed_won', 'closed_lost', 'churned'];
  const won = leads.filter(l => l.stage === 'closed_won').length;
  const lost = leads.filter(l => l.stage === 'closed_lost' || l.stage === 'churned').length;
  const open = leads.filter(l => !CLOSED.includes(l.stage || '')).length;
  const total = leads.length;
  const decided = won + lost;
  setText('rep-close', total ? Math.round(won / total * 100) + '%' : '-');
  setText('rep-close-sub', decided ? Math.round(won / decided * 100) + '% of decided' : '');
  setText('rep-open', open);
  repMoneyStats(leads);
}
// The rep's own money for this calendar month (Sydney): deals they won this
// month, ex GST, and what they earn on them. Builds pay the SOP rate for
// their commission role; pay-per-lead deals pay the Business Settings rate.
let _myRates = null;
async function repMoneyStats(leads) {
  if (!_myRates) {
    const { data } = await db.rpc('my_commission_rates');
    _myRates = data || {};
  }
  const tz = { timeZone: 'Australia/Sydney' };
  const month = new Date().toLocaleDateString('en-CA', tz).slice(0, 7);
  const inMonth = ts => ts && new Date(ts).toLocaleDateString('en-CA', tz).slice(0, 7) === month;
  const won = leads.filter(l => l.stage === 'closed_won' && inMonth(l.won_at || l.stage_changed_at));
  const exGst = v => Number(v || 0) / 1.1;
  const cash = won.reduce((a, l) => a + exGst(l.value), 0);
  const came = leads.filter(l => inMonth(l.created_at)).length;
  const r = _myRates || {};
  let comm = 0, unknown = false;
  won.forEach(l => {
    if (l.lead_type === 'ppl') {
      const base = r.ppl_base === 'inc' ? Number(l.value || 0) : exGst(l.value);
      comm += base * Number(r.ppl_pct || 0) / 100;
    } else if (r.build_pct != null) comm += exGst(l.value) * Number(r.build_pct) / 100;
    else unknown = true;
  });
  const money = v => '$' + Math.round(v).toLocaleString('en-AU');
  setText('rep-comm', unknown && !comm ? '-' : money(comm));
  setText('rep-comm-sub', unknown ? 'ask your manager to set your commission role' : `this month · ${won.length} deal${won.length === 1 ? '' : 's'}`);
  setText('rep-cash', money(cash));
  setText('rep-rpl', came ? money(cash / came) : '-');
  setText('rep-rpl-sub', `this month · ${came} lead${came === 1 ? '' : 's'} in`);
  setText('rep-avg', won.length ? money(cash / won.length) : '-');
}
