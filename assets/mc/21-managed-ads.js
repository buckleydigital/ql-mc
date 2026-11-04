'use strict';

// ── Managed Ads: launch and watch (managed-campaigns function) ──
async function managedCall(body) {
  const {data:{session}} = await db.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const res = await fetch(`${_ep}/functions/v1/managed-campaigns`, {method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`}, body:JSON.stringify(body)});
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}
const mEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mMoney = v => v == null ? '-' : '$' + Number(v).toFixed(2);
async function loadManagedAds() {
  const body = document.getElementById('managed-body');
  try {
    const {campaigns} = await managedCall({action:'list'});
    if (!campaigns.length) { body.innerHTML = '<tr><td colspan="10" style="color:var(--ink3)">No managed campaigns yet. They appear here once HQ builds one.</td></tr>'; return; }
    body.innerHTML = campaigns.map(c => {
      const acct = String(c.ad_account_id || '').replace(/^act_/, '');
      const live = c.status === 'ACTIVE';
      const issues = (c.issues || []).map(i => `<div style="color:${i.tier==='urgent'?'var(--red)':'var(--ink2)'}">${mEsc(i.kind)}</div>`).join('') || '<span style="color:var(--ink3)">-</span>';
      return `<tr>
        <td><strong>${mEsc(c.clients?.company_name || c.name)}</strong><div style="font-size:11px;color:var(--ink3)">${mEsc(c.name)}</div></td>
        <td>${live ? '<span style="color:var(--grn)">Live</span>' : 'Paused'}${c.effective_status && c.effective_status !== c.status ? `<div style="font-size:11px;color:var(--ink3)">${mEsc(c.effective_status)}</div>` : ''}</td>
        <td>${mMoney(c.daily_budget)}</td><td>${mMoney(c.spend_today)}</td><td>${mMoney(c.spend_7d)}</td>
        <td>${c.leads_7d ?? '-'}</td><td>${mMoney(c.cpl_7d)}</td>
        <td><input type="number" min="1" step="1" style="width:70px" value="${c.clients?.managed_cpl_target ?? ''}" placeholder="$" onchange="managedTarget('${c.client_id}',this.value)" ${c.client_id ? '' : 'disabled'}></td>
        <td style="font-size:12px">${issues}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="managedPreflight('${c.id}')">Pre-flight</button>
          ${live ? `<button class="btn btn-sm" onclick="managedPause('${c.id}')">Pause</button>` : `<button class="btn btn-p btn-sm" onclick="managedLaunch('${c.id}')">Launch</button>`}
          <a class="btn btn-sm" target="_blank" rel="noopener" href="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(acct)}&selected_campaign_ids=${encodeURIComponent(c.meta_campaign_id)}">Ads Manager</a>
        </td></tr>`;
    }).join('');
  } catch (e) { body.innerHTML = `<tr><td colspan="10" style="color:var(--red)">${mEsc(e.message)}</td></tr>`; }
}
function managedShowChecks(checks, title) {
  const col = {pass:'var(--grn)', warn:'var(--amb)', fail:'var(--red)'};
  document.getElementById('managed-preflight').innerHTML = `<div class="sl">${mEsc(title)} <div class="sl-line"></div></div>` +
    (checks || []).map(c => `<div style="font-size:13px;padding:3px 0"><strong style="color:${col[c.result]};text-transform:uppercase;font-family:var(--mono);font-size:11px">${c.result}</strong> ${mEsc(c.check)}: ${mEsc(c.detail)}</div>`).join('');
}
async function managedPreflight(id) {
  try { const r = await managedCall({action:'preflight', id}); managedShowChecks(r.checks, 'Pre-flight'); }
  catch (e) { toast(e.message, true); }
}
async function managedLaunch(id) {
  if (!confirm('Switch this campaign on? It starts spending the client\'s budget straight away.')) return;
  try {
    const r = await managedCall({action:'launch', id});
    managedShowChecks(r.checks, r.ok ? 'Launched' : 'Not launched');
    if (r.ok) toast('Campaign live' + (r.hq ? ` (${r.hq})` : '')); else toast(r.error || 'Pre-flight failed, see below', true);
    loadManagedAds();
  } catch (e) { toast(e.message, true); }
}
async function managedPause(id) {
  if (!confirm('Pause this campaign?')) return;
  try { const r = await managedCall({action:'pause', id}); r.ok ? toast('Paused') : toast(r.error, true); loadManagedAds(); }
  catch (e) { toast(e.message, true); }
}
async function managedTarget(clientId, value) {
  try { await managedCall({action:'set_target', client_id:clientId, cpl_target:value}); toast('CPL target saved'); }
  catch (e) { toast(e.message, true); }
}
