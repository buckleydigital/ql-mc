'use strict';

function selectFile(filename, el) {
  document.querySelectorAll('.file-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
  curFile = filename;
  setText('file-editor-name', el.querySelector('.file-name')?.textContent || filename.replace(/\.md$/,''));
  paintFileTools();
  loadFileContent();
  // On a phone the editor sits under the list, so bring it into view.
  if (matchMedia('(max-width:700px)').matches) document.querySelector('#panel-files .file-editor')?.scrollIntoView({behavior:'smooth', block:'start'});
}

// SOPs are files people add themselves, saved as sop-<id>.md. Their name
// lives only in the title column; templates and scripts are built in.
const isSop = f => f.startsWith('sop-');
// Agreements (agreement-<id>.md) are the contracts sent to roles to sign.
// They work like SOPs - written here in Markdown, shown formatted - but stay
// in Mission Control: the Team Panel only reads sop- files.
const isAgr = f => f.startsWith('agreement-');
const isDoc = f => isSop(f) || isAgr(f);
const filesTabOf = f => isSop(f) ? 'sop' : isAgr(f) ? 'agr' : 'tmpl';

function showFilesTab(tab) {
  document.querySelectorAll('[data-files-tab]').forEach(b => b.classList.toggle('active', b.dataset.filesTab === tab));
  $('files-group-tmpl').style.display = tab === 'tmpl' ? '' : 'none';
  $('files-group-sop').style.display  = tab === 'sop'  ? '' : 'none';
  $('files-group-agr').style.display  = tab === 'agr'  ? '' : 'none';
}

// The client picker and Preview fill in template fields, so SOPs don't get
// them; only SOPs can be deleted.
function paintFileTools() {
  const sop = isSop(curFile), doc = isDoc(curFile);
  if (doc && _tmplPreviewOn) toggleTemplatePreview();
  $('tmpl-client-sel').style.display = doc ? 'none' : '';
  $('tmpl-preview-btn').style.display = doc ? 'none' : '';
  $('sop-del-btn').style.display = doc ? '' : 'none';
  $('sop-tools').style.display = sop ? '' : 'none';
  $('sop-edit-btn').style.display = '';
  _sopEditing = false;
  applySopMode();
  if (sop) loadSopMeta();
}

// SOPs open formatted, the way the Team Panel shows them; Edit switches to the
// Markdown. An empty SOP (a new one) opens straight in the editor.
let _sopEditing = false;
function applySopMode() {
  const ta = $('file-editor-ta'), view = $('sop-view'), btn = $('sop-edit-btn');
  if (!ta || !view) return;
  const doc = isDoc(curFile);
  const loading = ta.value === 'Loading…';
  const reading = !_sopEditing && (loading || ta.value.trim());
  if (reading) {
    // Templates fill in the chosen client while Preview is on.
    const client = !doc && _tmplPreviewOn ? (_tmplClients.find(c => String(c.id) === $('tmpl-client-sel')?.value) || null) : null;
    view.innerHTML = loading ? '<p style="color:var(--ink3)">Loading…</p>'
      : doc ? sopMarkdown(ta.value) : tmplRender(applyTemplateVars(ta.value, client));
  }
  view.style.display = reading ? '' : 'none';
  ta.style.display = reading ? 'none' : '';
  if (btn) btn.textContent = reading ? 'Edit' : 'View';
}
function toggleSopEdit() {
  _sopEditing = !_sopEditing;
  applySopMode();
  if (_sopEditing) $('file-editor-ta')?.focus();
}

// Same renderer as the Team Panel's SOPs (ql-hq team-panel.html): headings,
// **bold**, `code`, lists (one level of nesting) and | tables |. Escapes first.
function sopMarkdown(md) {
  const inline = (t) => esc(t).split(/(`[^`]*`)/g).map((part) => part.startsWith('`') && part.endsWith('`') && part.length > 1
    ? `<code>${part.slice(1, -1)}</code>`
    : part.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')).join('');
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let html = '', i = 0;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const lv = Math.min(m[1].length + 1, 5); html += `<h${lv}>${inline(m[2])}</h${lv}>`; i++; continue; }
    if (/^\s*-{3,}\s*$/.test(l)) { html += '<hr style="border:none;border-top:1px solid var(--bd);margin:14px 0">'; i++; continue; }
    if (isRow(l)) {
      const rows = []; while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
      const head = cells(rows[0]), body = rows.slice(rows[1] && /^[\s|:-]+$/.test(rows[1]) ? 2 : 1);
      html += '<div class="sop-tw"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const cur = lines[i];
        const sub = /^\s{2,}([-*]|\d+\.)\s+/.test(cur);
        const text = cur.replace(/^\s*([-*]|\d+\.)\s+/, '').trim();
        if (sub && items.length) (items[items.length - 1].sub ||= []).push(text);
        else if (/^\s{2,}\S/.test(cur) && !/^\s*([-*]|\d+\.)\s+/.test(cur) && items.length) items[items.length - 1].text += ' ' + cur.trim();
        else items.push({ text });
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>` + items.map((it) => `<li>${inline(it.text)}${it.sub ? '<ul>' + it.sub.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>' : ''}</li>`).join('') + `</${tag}>`;
      continue;
    }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s|\s*-{3,}\s*$)/.test(lines[i])) para.push(lines[i++].trim());
    html += `<p>${inline(para.join(' '))}</p>`;
  }
  return html;
}

// Templates and scripts are plain text written to be copied into an email or
// read on a call, so they aren't Markdown. This reads their own conventions
// and lays them out like a SOP, without changing the saved text: a Subject
// line, ━━━ CAPS ━━━ section banners, numbered script steps, short Title Case
// subheadings, "You:" with the lines to say, the prospect's objections,
// stage directions, bullet and numbered lists, {{fields}} / [fields] as chips,
// and links.
function tmplRender(text) {
  const inline = (t) => esc(t)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(\{\{[^}]+\}\}|\[[A-Z][^\]]{0,40}\])/g, '<span class="tr-var">$1</span>');
  const L = String(text || '').replace(/\r/g, '').split('\n');
  const blank = (k) => k < 0 || k >= L.length || !L[k].trim();
  const num = (l) => { const m = (l || '').match(/^\s*(\d{1,2})[.)]\s+\S/); return m ? +m[1] : null; };
  const isRule = (l) => /^\s*[━—─_=\-]{6,}\s*$/.test(l || '');
  const isQuote = (l) => /^\s*["“]/.test(l || '');
  const isYou = (l) => /^\s*you:\s*$/i.test(l || '');
  const isBullet = (l) => /^\s*[•●▪\-*✓✔]\s+/.test(l || '');
  const isCaps = (l) => { const t = (l || '').trim(); return t.length > 2 && t.length < 70 && /[A-Z]{3}/.test(t) && t === t.toUpperCase() && !/^https?:/i.test(t); };
  const greeting = /^(hi|hey|hello|dear|cheers|thanks|thank you|kind regards|regards|speak soon|best)\b/i;
  const isTitle = (l) => {
    const t = (l || '').trim();
    if (!t || t.length > 60 || /[.,!?"”]$/.test(t) || isQuote(t) || greeting.test(t) || /https?:|@|\{\{/.test(t)) return false;
    const words = t.replace(/[–—:()]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 9) return false;
    const caps = words.filter((w) => /^[A-Z0-9$]/.test(w)).length;
    return caps / words.length >= 0.6;
  };
  let html = '', i = 0, inScript = false;
  // The first non-empty line may be the email's subject.
  while (i < L.length && blank(i)) i++;
  const sm = (L[i] || '').match(/^\s*subject:\s*(.+)$/i);
  if (sm) { html += `<div class="tr-subject"><span>Subject</span>${inline(sm[1])}</div>`; i++; }
  else if (isTitle(L[i]) && blank(i + 1)) { html += `<h2>${inline(L[i].trim())}</h2>`; i++; }
  while (i < L.length) {
    const l = L[i], t = l.trim();
    if (!t) { i++; continue; }
    // ━━━ / CAPS / ━━━ banner, or a lone rule.
    if (isRule(l)) {
      let j = i + 1; while (j < L.length && blank(j)) j++;
      if (j < L.length && isCaps(L[j])) {
        html += `<h3 class="tr-sec">${inline(L[j].trim().replace(/:$/, ''))}</h3>`;
        i = j + 1; if (isRule(L[i])) i++;
      } else { html += '<hr class="tr-hr">'; i++; }
      continue;
    }
    if (isCaps(l)) { html += `<h3 class="tr-sec">${inline(t.replace(/:$/, ''))}</h3>`; i++; continue; }
    // A numbered script step: on its own, not followed by the next number.
    const n = num(l);
    if (n != null && blank(i - 1) && num(L[i + 1]) !== n + 1 && t.length <= 110 && !isQuote(t.replace(/^\d+[.)]\s+/, ''))) {
      html += `<h3 class="tr-step"><span>${n}</span>${inline(t.replace(/^\d+[.)]\s+/, ''))}</h3>`;
      inScript = true; i++; continue;
    }
    // A short Title Case line that starts a section ("Current Business",
    // "Option 1 – Pay Per Lead", "Investment: Standard").
    if (isTitle(l) && (blank(i - 1) || /<\/h3>$/.test(html) || isYou(L[i + 1]))) {
      html += `<h4 class="tr-sub">${inline(t.replace(/:$/, ''))}</h4>`; i++; continue;
    }
    // "You:" and the lines to say, with any directions in between.
    if (isYou(l)) {
      inScript = true;
      let body = ''; i++;
      while (i < L.length && !blank(i) && !isYou(L[i]) && !(isQuote(L[i]) && isYou(L[i + 1]))) {
        const x = L[i].trim();
        if (isTitle(x) && isYou(L[i + 1])) break;
        if (isQuote(x)) {
          // A quote can run over several lines until its closing mark.
          let q = x; while (!/["”]\s*$/.test(q) && i + 1 < L.length && !blank(i + 1)) q += '\n' + L[++i].trim();
          body += `<div class="tr-line">${inline(q.replace(/^["“]|["”]$/g, '')).replace(/\n/g, '<br>')}</div>`;
        } else if (isBullet(x)) {
          body += `<div class="tr-line tr-li">${inline(x.replace(/^[•●▪\-*✓✔]\s+/, ''))}</div>`;
        } else if (num(x) != null) {
          body += `<div class="tr-dir"><b>${num(x)}.</b> ${inline(x.replace(/^\d+[.)]\s+/, ''))}</div>`;
        } else {
          body += `<div class="tr-dir">${inline(x)}</div>`;
        }
        i++;
      }
      html += `<div class="tr-you"><div class="tr-who">You</div>${body}</div>`;
      continue;
    }
    // What the prospect says, just before "You:".
    if (isQuote(l) && (isYou(L[i + 1]) || (isTitle(L[i + 1]) && isYou(L[i + 2])))) {
      html += `<div class="tr-them"><div class="tr-who">They say</div>${inline(t.replace(/^["“]|["”]$/g, ''))}</div>`; i++; continue;
    }
    // Lists: bullets, or numbered items (a numbered item can carry lines under it).
    if (isBullet(l) || n != null) {
      const ordered = !isBullet(l);
      const items = [];
      while (i < L.length && !blank(i)) {
        const x = L[i].trim();
        if (ordered ? num(x) != null : isBullet(x)) items.push({ n: num(x), t: x.replace(ordered ? /^\d+[.)]\s+/ : /^[•●▪\-*✓✔]\s+/, ''), sub: [] });
        else if (items.length && (ordered || /^\s{2,}/.test(L[i]))) items[items.length - 1].sub.push(x);
        else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag} class="tr-list">` + items.map((it) => `<li${it.n != null ? ` value="${it.n}"` : ''}>${inline(it.t)}${it.sub.map((x) => `<div class="${isQuote(x) ? 'tr-line' : 'tr-dir'}">${inline(x.replace(/^["“]|["”]$/g, ''))}</div>`).join('')}</li>`).join('') + `</${tag}>`;
      continue;
    }
    // Inside a script, a lone instruction ("Let them explain.", "Then:").
    if (inScript && !isQuote(l) && t.length < 90 && blank(i + 1) === false && isYou(L[i + 1]) === false && /:$|^(let|then|if|note|depending|address|before|explain)\b/i.test(t)) {
      html += `<div class="tr-dir">${inline(t)}</div>`; i++; continue;
    }
    // A paragraph: its line breaks are kept, as they are in an email.
    const para = [];
    while (i < L.length && !blank(i) && !isRule(L[i]) && !isYou(L[i]) && !(para.length && (isBullet(L[i]) || isCaps(L[i]) || (num(L[i]) != null && para.length && /:$/.test(para[para.length - 1]))))) para.push(L[i++].trim());
    html += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return html;
}

// ── SOP PDFs and Team Panel access ──
// A SOP can carry a PDF (private sop-files bucket) and says which ql-hq Team
// Panel roles may read it (agent_files.access_roles; empty = admins only).
// The Team Panel reads them through sync-from-hq's list_sops.
let _sopMeta = null;
async function loadSopMeta() {
  const file = curFile;
  const {data} = await db.from('agent_files').select('id,pdf_path,access_roles').eq('agent','docs').eq('filename',file).maybeSingle();
  if (file !== curFile) return;
  _sopMeta = data || null;
  const path = data && data.pdf_path;
  $('sop-pdf-state').textContent = path ? path.split('/').pop() : 'none attached';
  $('sop-pdf-view').style.display = path ? '' : 'none';
  $('sop-pdf-del').style.display = path ? '' : 'none';
  $('sop-pdf-up').textContent = path ? 'Replace PDF' : 'Upload PDF';
  const roles = (data && data.access_roles) || [];
  document.querySelectorAll('.sop-role').forEach(cb => cb.checked = roles.includes(cb.value));
}
function sopPdfPath(filename, file) {
  const safe = (file.name || 'sop.pdf').replace(/\.pdf$/i,'').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'sop';
  return filename.replace(/\.md$/,'') + '/' + Date.now().toString(36) + '-' + safe + '.pdf';
}
function checkPdf(file) {
  if (!file) return false;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast('That file is not a PDF', true); return false; }
  if (file.size > 25 * 1024 * 1024) { toast('PDFs can be up to 25 MB', true); return false; }
  return true;
}
async function uploadSopPdf(input) {
  const file = input.files && input.files[0]; input.value = '';
  if (!checkPdf(file) || !isSop(curFile)) return;
  const filename = curFile, path = sopPdfPath(filename, file);
  $('sop-pdf-state').textContent = 'Uploading…';
  const {error} = await db.storage.from('sop-files').upload(path, file, {contentType:'application/pdf', upsert:false});
  if (error) { toast('Upload failed: '+error.message, true); loadSopMeta(); return; }
  const old = _sopMeta && _sopMeta.pdf_path;
  const {error: e2} = await db.from('agent_files').update({pdf_path:path, updated_at:now()}).eq('agent','docs').eq('filename',filename);
  if (e2) { toast('Could not attach the PDF: '+e2.message, true); return; }
  if (old && old !== path) await db.storage.from('sop-files').remove([old]);
  toast('PDF attached ✓');
  loadSopMeta();
}
async function newSopFromPdf(input) {
  const file = input.files && input.files[0]; input.value = '';
  if (!checkPdf(file) || !db) return;
  const filename = 'sop-' + Date.now().toString(36) + '.md';
  const title = (file.name || 'SOP').replace(/\.pdf$/i,'').replace(/[_-]+/g,' ').trim().slice(0,80) || 'New SOP';
  const path = sopPdfPath(filename, file);
  const {error} = await db.storage.from('sop-files').upload(path, file, {contentType:'application/pdf', upsert:false});
  if (error) { toast('Upload failed: '+error.message, true); return; }
  const {error: e2} = await db.from('agent_files').insert({agent:'docs', filename, title, content:'', pdf_path:path, updated_at:now()});
  if (e2) { toast('Could not add the SOP: '+e2.message, true); await db.storage.from('sop-files').remove([path]); return; }
  curFile = filename;
  await loadFileNames();
  showFilesTab('sop');
  const el = document.querySelector(`.file-item[data-file="${CSS.escape(filename)}"]`);
  if (el) selectFile(filename, el);
  toast('SOP added. Tick who can see it in the Team Panel.');
}
async function viewSopPdf() {
  const path = _sopMeta && _sopMeta.pdf_path; if (!path) return;
  const w = window.open('', '_blank');
  const {data, error} = await db.storage.from('sop-files').createSignedUrl(path, 600);
  if (error || !data) { if (w) w.close(); toast('Could not open the PDF', true); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}
async function removeSopPdf() {
  const path = _sopMeta && _sopMeta.pdf_path; if (!path) return;
  if (!confirm('Remove the PDF from this SOP?')) return;
  const {error} = await db.from('agent_files').update({pdf_path:null, updated_at:now()}).eq('agent','docs').eq('filename',curFile);
  if (error) { toast('Could not remove it: '+error.message, true); return; }
  await db.storage.from('sop-files').remove([path]);
  toast('PDF removed');
  loadSopMeta();
}
async function saveSopRoles() {
  if (!isSop(curFile)) return;
  const roles = [...document.querySelectorAll('.sop-role')].filter(cb => cb.checked).map(cb => cb.value);
  const {error} = await db.from('agent_files').update({access_roles:roles}).eq('agent','docs').eq('filename',curFile);
  if (error) { toast('Could not save: '+error.message, true); loadSopMeta(); return; }
  toast(roles.length ? 'Team Panel access saved ✓' : 'Saved: admins only');
}

function renderSops(rows) {
  const paint = (listId, test, untitled, empty) => {
    const list = $(listId);
    if (!list) return;
    const mine = rows.filter(r => test(r.filename)).sort((a,b) => (a.title||'').localeCompare(b.title||''));
    list.innerHTML = mine.length ? mine.map(r =>
      `<div class="file-item${r.filename===curFile?' active':''}" data-file="${esc(r.filename)}">` +
      `<div class="file-name" data-builtin="">${esc(r.title || untitled)}</div>` +
      `<div class="file-desc" data-builtin="">${esc(r.description || '')}</div></div>`).join('')
      : `<div class="files-empty">${empty}</div>`;
    list.querySelectorAll('.file-item').forEach(el => el.onclick = () => selectFile(el.dataset.file, el));
  };
  paint('sop-list', isSop, 'Untitled SOP', 'No SOPs yet. Add one to write down how something is done.');
  paint('agr-list', isAgr, 'Untitled agreement', 'No agreements yet. Add the contracts you send closers, media buyers and other roles to sign.');
}

async function newSop() {
  if (!db) return;
  const filename = 'sop-' + Date.now().toString(36) + '.md';
  const {error} = await db.from('agent_files').insert({agent:'docs', filename, title:'New SOP', content:'# New SOP\n\n## Purpose\n\n## Steps\n1. \n', updated_at:now()});
  if (error) { toast('Could not add SOP: '+error.message, true); return; }
  curFile = filename;
  await loadFileNames();
  const el = document.querySelector(`.file-item[data-file="${CSS.escape(filename)}"]`);
  if (el) { selectFile(filename, el); renameFile(); }
}

async function newAgreement() {
  if (!db) return;
  const filename = 'agreement-' + Date.now().toString(36) + '.md';
  const content = '# New agreement\n\n**Role:** \n\n**Between:** QuoteLeads and \n\n## Scope of work\n\n## Payment\n\n## Term and termination\n\n## Confidentiality\n\n## Signatures\n\n| | Name | Signature | Date |\n|---|---|---|---|\n| QuoteLeads | | | |\n| Contractor | | | |\n';
  const {error} = await db.from('agent_files').insert({agent:'docs', filename, title:'New agreement', content, updated_at:now()});
  if (error) { toast('Could not add agreement: '+error.message, true); return; }
  curFile = filename;
  await loadFileNames();
  showFilesTab('agr');
  const el = document.querySelector(`.file-item[data-file="${CSS.escape(filename)}"]`);
  if (el) { selectFile(filename, el); renameFile(); }
}

async function deleteSop() {
  if (!isDoc(curFile)) return;
  const name = $('file-editor-name').textContent;
  if (!confirm(`Delete the ${isAgr(curFile) ? 'agreement' : 'SOP'} "${name}"? This can't be undone.`)) return;
  const pdf = _sopMeta && _sopMeta.pdf_path;
  const {error} = await db.from('agent_files').delete().eq('agent','docs').eq('filename',curFile);
  if (error) { toast('Delete failed: '+error.message, true); return; }
  if (pdf) await db.storage.from('sop-files').remove([pdf]);
  toast('Deleted ✓');
  const next = document.querySelector(`#${isAgr(curFile) ? 'agr' : 'sop'}-list .file-item:not(.active)`) || document.querySelector('#files-group-tmpl .file-item');
  await loadFileNames();
  const el = next && document.querySelector(`.file-item[data-file="${CSS.escape(next.dataset.file)}"]`);
  if (el) { showFilesTab(filesTabOf(el.dataset.file)); selectFile(el.dataset.file, el); }
}

// Names shown in the list. The filename is the key the content is saved
// under and never changes; a rename only sets title and description.
async function loadFileNames() {
  if (!db) return;
  const {data,error} = await db.from('agent_files').select('filename,title,description').eq('agent','docs');
  if (error) return;
  renderSops(data || []);
  for (const r of data || []) {
    const item = document.querySelector(`.file-item[data-file="${CSS.escape(r.filename)}"]`);
    if (!item) continue;
    const nm = item.querySelector('.file-name'), ds = item.querySelector('.file-desc');
    nm.dataset.builtin ??= nm.textContent; ds.dataset.builtin ??= ds.textContent;
    nm.textContent = r.title || nm.dataset.builtin;
    ds.textContent = r.description || ds.dataset.builtin;
    if (r.filename === curFile) setText('file-editor-name', nm.textContent);
  }
}

function renameFile() {
  const item = document.querySelector(`.file-item[data-file="${CSS.escape(curFile)}"]`);
  if (!item || item.querySelector('.file-rename')) return;
  showFilesTab(filesTabOf(curFile));
  const nm = item.querySelector('.file-name'), ds = item.querySelector('.file-desc');
  const form = document.createElement('div');
  form.className = 'file-rename';
  form.onclick = e => e.stopPropagation();
  form.innerHTML = '<input class="fr-name" maxlength="80" placeholder="Name"><input class="fr-desc" maxlength="120" placeholder="Description (optional)">' +
    '<div><button class="btn btn-xs fr-cancel">Cancel</button><button class="btn btn-xs btn-p fr-save">Save</button></div>';
  form.querySelector('.fr-name').value = nm.textContent;
  form.querySelector('.fr-desc').value = ds.textContent;
  nm.style.display = ds.style.display = 'none';
  item.appendChild(form);
  const close = () => { form.remove(); nm.style.display = ds.style.display = ''; };
  const save = async () => {
    const title = form.querySelector('.fr-name').value.trim();
    const description = form.querySelector('.fr-desc').value.trim();
    if (!title) { toast('Give it a name', true); return; }
    // Blank or unchanged-from-built-in means "use the built-in one".
    // SOPs have no built-in name, so theirs is always stored.
    const row = isDoc(curFile) ? { title, description: description || null } : {
                  title: title === (nm.dataset.builtin ?? nm.textContent) ? null : title,
                  description: description && description !== (ds.dataset.builtin ?? ds.textContent) ? description : null };
    const {data:existing} = await db.from('agent_files').select('id').eq('agent','docs').eq('filename',curFile).maybeSingle();
    const {error} = existing
      ? await db.from('agent_files').update(row).eq('id', existing.id)
      : await db.from('agent_files').insert({agent:'docs', filename:curFile, content:$('file-editor-ta').value, updated_at:now(), ...row});
    if (error) { toast('Rename failed: '+error.message, true); return; }
    nm.dataset.builtin ??= nm.textContent; ds.dataset.builtin ??= ds.textContent;
    nm.textContent = title;
    ds.textContent = description || ds.dataset.builtin;
    setText('file-editor-name', title);
    close();
    toast('Renamed ✓');
  };
  form.querySelector('.fr-cancel').onclick = close;
  form.querySelector('.fr-save').onclick = save;
  form.querySelectorAll('input').forEach(i => i.onkeydown = e => {
    if (e.key === 'Enter') save(); else if (e.key === 'Escape') close();
  });
  form.querySelector('.fr-name').select();
  item.scrollIntoView({behavior:'smooth', block:'nearest'});
}
async function loadFileContent() {
  if (!db) return;
  const ta = $('file-editor-ta');
  if (!ta) return;
  ta.value = 'Loading…';
  const {data,error} = await db.from('agent_files').select('content').eq('agent','docs').eq('filename',curFile).maybeSingle();
  if (error || !data) { ta.value = FILE_DEFAULTS[curFile] || ''; applySopMode(); return; }
  ta.value = data.content || FILE_DEFAULTS[curFile] || '';
  applySopMode();
}
async function saveFileContent() {
  const ta = $('file-editor-ta');
  if (!ta) return;
  const content = ta.value;
  const {error} = await db.from('agent_files').upsert({agent:'docs',filename:curFile,content,updated_at:now()},{onConflict:'agent,filename'});
  if (error) { toast('Save failed: '+error.message, true); return; }
  toast('Saved ✓ - '+curFile);
  // Back to the formatted view, showing what was just saved.
  _sopEditing = false; applySopMode();
}

let _tmplClients = [], _tmplPreviewOn = false;
async function loadTemplateClientDropdown() {
  if (_tmplClients.length) return;
  const {data} = await db.from('clients').select('id,company_name,contact_name,niche,lead_price,total_leads_purchased,leads_delivered,type').in('stage',['active_client','active']).order('company_name');
  _tmplClients = data || [];
  const sel = $('tmpl-client-sel');
  if (!sel) return;
  sel.innerHTML = '<option value="">- Preview with client -</option>' +
    _tmplClients.map(c=>`<option value="${esc(String(c.id))}">${esc(c.company_name)} [${c.type==='ppl'?'PPL':c.type==='ppl_managed'?'PPL+M':'Managed'}]</option>`).join('');
}
function applyTemplateVars(text, client) {
  if (!client) return text;
  return text
    .replace(/\{\{client_name\}\}/gi, client.company_name||'')
    .replace(/\{\{contact_name\}\}/gi, client.contact_name||'')
    .replace(/\{\{niche\}\}/gi, client.niche||'')
    .replace(/\{\{lead_price\}\}/gi, client.lead_price?'$'+client.lead_price:'')
    .replace(/\{\{leads_purchased\}\}/gi, client.total_leads_purchased||'')
    .replace(/\{\{leads_delivered\}\}/gi, client.leads_delivered||'');
}
function updateTemplatePreview() {
  if (_tmplPreviewOn) applySopMode();
}
// Preview shows the formatted template with the chosen client's details in.
function toggleTemplatePreview() {
  const sel=$('tmpl-client-sel'),btn=$('tmpl-preview-btn');
  if (!sel) return;
  if (!_tmplPreviewOn && !sel.value) { toast('Select a client to preview',true); return; }
  _tmplPreviewOn = !_tmplPreviewOn;
  if (_tmplPreviewOn) _sopEditing = false;
  if (btn) btn.textContent = _tmplPreviewOn ? 'Hide preview' : 'Preview';
  applySopMode();
}
