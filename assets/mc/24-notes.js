// Notes - free-form notes for the team running Mission Control, separate from
// Tasks (nothing is due, nothing gets ticked off). Stored in mc_notes; RLS
// keeps sales reps and lead buyers out.
let notesAll = [], notesOpenId = null, notesDirty = false;

async function loadNotes() {
  const { data, error } = await db.from('mc_notes').select('*')
    .order('pinned', { ascending: false }).order('updated_at', { ascending: false });
  if (error) { $('notes-list').innerHTML = '<div class="notes-empty">Could not load notes: ' + esc(error.message) + '</div>'; return; }
  notesAll = data || [];
  renderNotes();
}

function notesWhen(d) {
  const t = new Date(d), diff = (Date.now() - t) / 60000;
  if (diff < 1) return 'just now';
  if (diff < 60) return Math.round(diff) + 'm ago';
  if (diff < 1440) return Math.round(diff / 60) + 'h ago';
  return t.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function renderNotes() {
  const q = ($('notes-search').value || '').trim().toLowerCase();
  const list = notesAll.filter(n => !q || (n.title + ' ' + n.body).toLowerCase().includes(q));
  $('notes-count').textContent = notesAll.length;
  $('notes-list').innerHTML = list.length ? list.map(n => `
    <button type="button" class="note-card${n.id === notesOpenId ? ' on' : ''}" onclick="openNote('${n.id}')">
      <div class="note-t">${n.pinned ? '<span class="note-pin" title="Pinned">●</span>' : ''}${esc(n.title || 'Untitled')}</div>
      <div class="note-p">${esc((n.body || '').slice(0, 140)) || '<span style="opacity:.6">Empty note</span>'}</div>
      <div class="note-m">${esc(notesWhen(n.updated_at))}${n.created_by_email ? ' · ' + esc(n.created_by_email.split('@')[0]) : ''}</div>
    </button>`).join('')
    : `<div class="notes-empty">${q ? 'No notes match.' : 'No notes yet. Press <b>New note</b> to write one.'}</div>`;
  const n = notesAll.find(x => x.id === notesOpenId);
  $('notes-editor').style.display = n ? '' : 'none';
  $('notes-blank').style.display = n ? 'none' : '';
}

function notesConfirmLeave() {
  return !notesDirty || confirm('You have unsaved changes to this note. Leave without saving?');
}

function openNote(id) {
  if (id !== notesOpenId && !notesConfirmLeave()) return;
  const n = notesAll.find(x => x.id === id);
  if (!n) return;
  notesOpenId = id; notesDirty = false;
  $('note-title').value = n.title || '';
  $('note-body').value = n.body || '';
  $('note-pin-btn').textContent = n.pinned ? 'Unpin' : 'Pin';
  $('note-status').textContent = 'Last saved ' + notesWhen(n.updated_at);
  renderNotes();
  $('note-body').focus();
}

async function newNote() {
  if (!notesConfirmLeave()) return;
  const { data, error } = await db.from('mc_notes').insert({ title: '', body: '' }).select().single();
  if (error) { toast('Could not create a note: ' + error.message, true); return; }
  notesAll.unshift(data);
  notesDirty = false;
  openNote(data.id);
  $('note-title').focus();
}

async function saveNote(quiet) {
  const n = notesAll.find(x => x.id === notesOpenId);
  if (!n) return;
  const patch = { title: $('note-title').value.trim(), body: $('note-body').value, updated_at: new Date().toISOString() };
  $('note-status').textContent = 'Saving…';
  const { data, error } = await db.from('mc_notes').update(patch).eq('id', n.id).select().single();
  if (error) { $('note-status').textContent = 'Not saved'; toast('Could not save: ' + error.message, true); return; }
  Object.assign(n, data);
  notesDirty = false;
  notesAll.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.updated_at) - new Date(a.updated_at)));
  $('note-status').textContent = 'Saved';
  renderNotes();
  if (!quiet) toast('Note saved ✓');
}

async function togglePinNote() {
  const n = notesAll.find(x => x.id === notesOpenId);
  if (!n) return;
  const { error } = await db.from('mc_notes').update({ pinned: !n.pinned }).eq('id', n.id);
  if (error) { toast('Could not change it: ' + error.message, true); return; }
  n.pinned = !n.pinned;
  $('note-pin-btn').textContent = n.pinned ? 'Unpin' : 'Pin';
  notesAll.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.updated_at) - new Date(a.updated_at)));
  renderNotes();
}

async function deleteNote() {
  const n = notesAll.find(x => x.id === notesOpenId);
  if (!n || !confirm('Delete "' + (n.title || 'Untitled') + '"? This can\'t be undone.')) return;
  const { error } = await db.from('mc_notes').delete().eq('id', n.id);
  if (error) { toast('Could not delete: ' + error.message, true); return; }
  notesAll = notesAll.filter(x => x.id !== n.id);
  notesOpenId = null; notesDirty = false;
  renderNotes();
  toast('Note deleted');
}

document.addEventListener('input', (e) => {
  if (e.target && (e.target.id === 'note-title' || e.target.id === 'note-body')) {
    notesDirty = true; $('note-status').textContent = 'Unsaved changes';
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && $('panel-notes') && $('panel-notes').classList.contains('active') && notesOpenId) {
    e.preventDefault(); saveNote();
  }
});
window.addEventListener('beforeunload', (e) => { if (notesDirty) { e.preventDefault(); e.returnValue = ''; } });
