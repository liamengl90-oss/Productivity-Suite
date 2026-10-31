const $ = (id) => document.getElementById(id);
const S = { root: '', tree: [], tabs: [], active: null, open: new Set(), filter: '' };
let saveTimer;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inl = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
  .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>');

function md(src) {
  const lines = src.split('\n'); let h = '', ul = false, code = false, para = [];
  const flushP = () => { if (para.length) { h += `<p>${inl(para.join(' '))}</p>`; para = []; } };
  const flushL = () => { if (ul) { h += '</ul>'; ul = false; } };
  lines.forEach((ln, i) => {
    if (/^```/.test(ln)) { flushP(); flushL(); h += code ? '</code></pre>' : '<pre><code>'; code = !code; return; }
    if (code) { h += esc(ln) + '\n'; return; }
    let m;
    if ((m = ln.match(/^\s*[-*] \[( |x|X)\] (.*)$/))) {
      flushP(); flushL(); const d = m[1] !== ' ';
      h += `<div class="task${d ? ' done' : ''}"><input type="checkbox" data-line="${i}"${d ? ' checked' : ''}><span>${inl(m[2])}</span></div>`; return;
    }
    if ((m = ln.match(/^\s*[-*] (.*)$/))) { flushP(); if (!ul) { h += '<ul>'; ul = true; } h += `<li>${inl(m[1])}</li>`; return; }
    flushL();
    if ((m = ln.match(/^(#{1,3}) (.*)$/))) { flushP(); h += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; return; }
    if (/^---+$/.test(ln)) { flushP(); h += '<hr>'; return; }
    if ((m = ln.match(/^> ?(.*)$/))) { flushP(); h += `<blockquote>${inl(m[1])}</blockquote>`; return; }
    if (!ln.trim()) { flushP(); return; }
    para.push(ln);
  });
  flushP(); flushL(); return h;
}

const cur = () => S.tabs.find((t) => t.path === S.active);
const baseName = (p) => p.split(/[\\/]/).pop().replace(/\.md$/i, '');

async function refreshTree() { S.tree = await api.tree(); renderTree(); }

function renderTree() {
  const el = $('tree'); el.innerHTML = ''; const f = S.filter.toLowerCase();
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        const kids = f ? hasMatch(n, f) : true; if (!kids) continue;
        const open = f || S.open.has(n.path);
        el.appendChild(row(n, depth, `<span class="chev">${open ? '▾' : '▸'}</span>${esc(n.name)}`, 'dir', () => { open && !f ? S.open.delete(n.path) : S.open.add(n.path); renderTree(); }));
        if (open) walk(n.children, depth + 1);
      } else if (!f || n.name.toLowerCase().includes(f)) {
        el.appendChild(row(n, depth, esc(n.name), n.path === S.active ? 'active' : '', () => openNote(n.path)));
      }
    }
  };
  walk(S.tree, 0);
  if (!el.children.length) el.innerHTML = `<div class="empty">${f ? 'No notes match.' : 'No notes yet. Press Ctrl+N.'}</div>`;
}
const hasMatch = (d, f) => d.children.some((c) => c.type === 'dir' ? hasMatch(c, f) : c.name.toLowerCase().includes(f));
function row(n, depth, html, cls, fn) {
  const d = document.createElement('div'); d.className = `row ${n.type === 'dir' ? 'dir' : ''} ${cls}`.trim();
  d.style.paddingLeft = 10 + depth * 14 + 'px'; d.innerHTML = html; d.onclick = fn; return d;
}

async function openNote(path) {
  if (!S.tabs.find((t) => t.path === path)) {
    S.tabs.push({ path, name: baseName(path), text: await api.read(path), dirty: false, mode: 'edit' });
  }
  S.active = path; render();
}

function closeTab(path) {
  const i = S.tabs.findIndex((t) => t.path === path); if (i < 0) return;
  if (S.tabs[i].dirty) saveNow(S.tabs[i]);
  S.tabs.splice(i, 1);
  if (S.active === path) S.active = S.tabs[Math.max(0, i - 1)]?.path || null;
  render();
}

function renderTabs() {
  const el = $('tabs'); el.innerHTML = '';
  for (const t of S.tabs) {
    const d = document.createElement('div'); d.className = 'tab' + (t.path === S.active ? ' on' : '');
    d.innerHTML = `${t.dirty ? '<i class="mod"></i>' : ''}<span>${esc(t.name)}</span><span class="x">×</span>`;
    d.onclick = () => { S.active = t.path; render(); };
    d.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(t.path); };
    el.appendChild(d);
  }
}

function renderPane() {
  const t = cur(), pane = $('pane');
  if (!t) { pane.innerHTML = '<div class="hint">Open a note from the library, or press Ctrl+N.</div>'; setStatus(); return; }
  pane.innerHTML = `
    <div class="bar"><div class="seg">
      <button id="m-edit" class="${t.mode === 'edit' ? 'on' : ''}">Edit</button>
      <button id="m-prev" class="${t.mode === 'preview' ? 'on' : ''}">Preview</button></div></div>
    <div class="doc"><div class="sheet">
      <input class="title" id="title" value="${esc(t.name)}" spellcheck="false">
      <div id="body"></div></div></div>`;
  $('m-edit').onclick = () => { t.mode = 'edit'; renderPane(); };
  $('m-prev').onclick = () => { t.mode = 'preview'; renderPane(); };
  const title = $('title');
  title.onkeydown = (e) => { if (e.key === 'Enter') title.blur(); };
  title.onblur = async () => {
    const np = await api.rename(t.path, title.value);
    if (np !== t.path) { if (S.active === t.path) S.active = np; t.path = np; t.name = baseName(np); await refreshTree(); }
    title.value = t.name; renderTabs();
  };
  const body = $('body');
  if (t.mode === 'edit') {
    body.innerHTML = '<textarea id="ed" spellcheck="false" placeholder="Start writing…"></textarea>';
    const ed = $('ed'); ed.value = t.text; fit(ed); ed.focus();
    ed.oninput = () => { t.text = ed.value; fit(ed); markDirty(t); };
    ed.onkeydown = (e) => editKeys(e, ed, t);
  } else {
    body.className = 'pv'; body.innerHTML = md(t.text) || '<p class="hint">Nothing here yet.</p>';
    body.onchange = (e) => {
      const ln = e.target.dataset?.line; if (ln === undefined) return;
      const a = t.text.split('\n'); a[ln] = a[ln].replace(/\[( |x|X)\]/, e.target.checked ? '[x]' : '[ ]');
      t.text = a.join('\n'); markDirty(t); body.innerHTML = md(t.text);
    };
  }
  setStatus();
}
const fit = (ed) => { ed.style.height = 'auto'; ed.style.height = Math.max(ed.scrollHeight, 420) + 'px'; };

function editKeys(e, ed, t) {
  if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); return; }
  if (e.key === 'Enter' && !e.shiftKey) {
    const pos = ed.selectionStart, ls = ed.value.lastIndexOf('\n', pos - 1) + 1, line = ed.value.slice(ls, pos);
    const m = line.match(/^(\s*[-*] )(\[[ xX]\] )?(.*)$/);
    if (m) {
      e.preventDefault();
      if (!m[3]) { ed.setSelectionRange(ls, pos); document.execCommand('insertText', false, ''); return; }
      document.execCommand('insertText', false, '\n' + m[1] + (m[2] ? '[ ] ' : ''));
    }
  }
}

function markDirty(t) { t.dirty = true; setStatus('Unsaved'); renderTabs(); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(t), 600); }
async function saveNow(t) { await api.write(t.path, t.text); t.dirty = false; renderTabs(); if (t.path === S.active) setStatus(); }

function setStatus(state) {
  const t = cur();
  $('st-state').textContent = state || (t ? (t.dirty ? 'Unsaved' : 'Saved') : 'Ready');
  $('st-words').textContent = t ? `${(t.text.trim().match(/\S+/g) || []).length} words` : '';
  $('st-mode').textContent = t ? (t.mode === 'edit' ? 'Editing' : 'Preview') : '';
}

function render() { renderTabs(); renderTree(); renderPane(); }

async function newNote() {
  const dir = cur() ? cur().path.replace(/[\\/][^\\/]+$/, '') : S.root;
  const p = await api.create(dir); await refreshTree(); await openNote(p);
  const ti = $('title'); ti.focus(); ti.select();
}
async function chooseVault() {
  const v = await api.chooseVault(); if (!v) return;
  S.tabs = []; S.active = null; loadVault(v);
}
function loadVault(v) { S.root = v.root; S.tree = v.tree; $('vault-name').textContent = v.root; render(); }

$('btn-new').onclick = newNote; $('btn-vault').onclick = chooseVault;
$('filter').oninput = (e) => { S.filter = e.target.value; renderTree(); };
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return; const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); newNote(); }
  else if (k === 'o') { e.preventDefault(); chooseVault(); }
  else if (k === 's') { e.preventDefault(); const t = cur(); if (t) saveNow(t); }
  else if (k === 'e') { e.preventDefault(); const t = cur(); if (t) { t.mode = t.mode === 'edit' ? 'preview' : 'edit'; renderPane(); } }
  else if (k === 'w') { e.preventDefault(); if (S.active) closeTab(S.active); }
});
window.addEventListener('beforeunload', () => S.tabs.forEach((t) => t.dirty && api.write(t.path, t.text)));

api.openVault().then(async (v) => { loadVault(v); const w = v.tree.find((n) => n.type === 'file'); if (w) openNote(w.path); });
