const $ = (id) => document.getElementById(id);
const S = { root: '', tree: [], tabs: [], active: null, open: new Set(), filter: '', target: null, range: null };
let saveTimer;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirOf = (p) => p.replace(/[\\/][^\\/]+$/, '');
const baseName = (p) => p.split(/[\\/]/).pop().replace(/\.md$/i, '');
const cur = () => S.tabs.find((t) => t.path === S.active);
const under = (p, src) => p === src || (p.startsWith(src) && /^[\\/]/.test(p.slice(src.length)));

/* ---------- markdown <-> editor ---------- */
const inl = (s) => esc(s)
  .replace(/&lt;span style="([\w\s:;,.'#%-]*)"&gt;/g, '<span style="$1">')
  .replace(/&lt;\/span&gt;/g, '</span>').replace(/&lt;(\/?)u&gt;/g, '<$1u>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
  .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>');

const taskHtml = (h, done, ind) =>
  `<div class="task${done ? ' done' : ''}" data-done="${done ? 1 : 0}" data-ind="${ind}" style="margin-left:${ind * 8}px"><span class="box" contenteditable="false"></span><span class="tx">${h || '<br>'}</span></div>`;
function taskEl(h, done, ind) { const d = document.createElement('div'); d.innerHTML = taskHtml(h, done, ind); return d.firstChild; }

function fromMd(src) {
  let h = '', ul = false, code = null;
  const endUl = () => { if (ul) { h += '</ul>'; ul = false; } };
  const pre = () => { h += `<pre class="code" data-lang="${code.lang}">${esc(code.txt.join('\n'))}</pre>`; code = null; };
  for (const ln of src.split('\n')) {
    let m;
    if (code) { if (/^```/.test(ln)) pre(); else code.txt.push(ln); continue; }
    if ((m = ln.match(/^```(.*)$/))) { endUl(); code = { lang: m[1].replace(/[^\w-]/g, ''), txt: [] }; continue; }
    if ((m = ln.match(/^(\s*)[-*] \[( |x|X)\] ?(.*)$/))) { endUl(); h += taskHtml(inl(m[3]), m[2] !== ' ', m[1].length); continue; }
    if ((m = ln.match(/^[-*] (.*)$/))) { if (!ul) { h += '<ul>'; ul = true; } h += `<li>${inl(m[1])}</li>`; continue; }
    endUl();
    if ((m = ln.match(/^(#{1,3}) (.*)$/))) { h += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; continue; }
    if ((m = ln.match(/^> ?(.*)$/))) { h += `<blockquote>${inl(m[1])}</blockquote>`; continue; }
    h += `<div>${inl(ln) || '<br>'}</div>`;
  }
  endUl(); if (code) pre();
  return h || '<div><br></div>';
}

const wrap = (m, i) => { const core = i.trim(); return core ? i.slice(0, i.length - i.trimStart().length) + m + core + m + i.slice(i.trimEnd().length) : i; };
function inlineMd(node) {
  let s = '';
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { s += c.nodeValue.replace(/\u00a0/g, ' '); return; }
    if (c.nodeType !== 1 || c.tagName === 'BR' || c.classList.contains('box')) return;
    const i = inlineMd(c), t = c.tagName;
    if (t === 'B' || t === 'STRONG') s += wrap('**', i);
    else if (t === 'I' || t === 'EM') s += wrap('*', i);
    else if (t === 'S' || t === 'STRIKE' || t === 'DEL') s += wrap('~~', i);
    else if (t === 'U') s += i ? `<u>${i}</u>` : '';
    else if (t === 'CODE') s += i ? '`' + i + '`' : '';
    else if (t === 'SPAN' && c.classList.contains('wl')) s += `[[${i}]]`;
    else if (t === 'SPAN') { const st = (c.getAttribute('style') || '').trim().replace(/"/g, "'"); s += st && i ? `<span style="${st}">${i}</span>` : i; }
    else s += i;
  });
  return s;
}
function toMd(ed) {
  const out = [];
  const blk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue.replace(/\u00a0/g, ' ')); return; }
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if (n.classList.contains('task')) { out.push(' '.repeat(+n.dataset.ind || 0) + `- [${n.dataset.done === '1' ? 'x' : ' '}] ` + inlineMd(n.querySelector('.tx'))); return; }
    if (/^H[1-3]$/.test(t)) { out.push('#'.repeat(+t[1]) + ' ' + inlineMd(n)); return; }
    if (t === 'UL') { n.querySelectorAll(':scope > li').forEach((li) => out.push('- ' + inlineMd(li))); return; }
    if (t === 'BLOCKQUOTE') { out.push('> ' + inlineMd(n)); return; }
    if (t === 'PRE') { out.push('```' + (n.dataset.lang || ''), n.textContent.replace(/\n$/, ''), '```'); return; }
    if (t === 'DIV' && [...n.children].some((c) => /^(DIV|H[1-3]|UL|BLOCKQUOTE|PRE)$/.test(c.tagName))) { n.childNodes.forEach(blk); return; }
    out.push(inlineMd(n));
  };
  ed.childNodes.forEach(blk);
  return out.join('\n');
}

/* ---------- library tree ---------- */
async function refreshTree() { S.tree = await api.tree(); renderTree(); }
const hasMatch = (d, f) => d.children.some((c) => (c.type === 'dir' ? hasMatch(c, f) : c.name.toLowerCase().includes(f)));

function renderTree() {
  const el = $('tree'); el.innerHTML = ''; const f = S.filter.toLowerCase();
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        if (f && !hasMatch(n, f)) continue;
        const open = !!f || S.open.has(n.path);
        const r = mk(n, depth, `<span class="chev">${open ? '▾' : '▸'}</span><span class="fi"></span><span class="nm">${esc(n.name)}</span>`, 'dir' + (S.target === n.path ? ' sel' : ''));
        r.onclick = () => { S.target = n.path; if (open && !f) S.open.delete(n.path); else S.open.add(n.path); renderTree(); };
        el.appendChild(r);
        if (open) walk(n.children, depth + 1);
      } else if (!f || n.name.toLowerCase().includes(f)) {
        const r = mk(n, depth, `<span class="ni"></span><span class="nm">${esc(n.name)}</span>`, n.path === S.active ? 'active' : '');
        r.onclick = () => openNote(n.path);
        el.appendChild(r);
      }
    }
  };
  walk(S.tree, 0);
  if (!el.children.length) el.innerHTML = `<div class="empty">${f ? 'No notes match.' : 'No notes yet. Press Ctrl+N.'}</div>`;
}

function mk(n, depth, html, cls) {
  const d = document.createElement('div');
  d.className = 'row ' + cls; d.dataset.path = n.path; d.draggable = true;
  d.style.paddingLeft = 8 + depth * 14 + (n.type === 'file' ? 14 : 0) + 'px'; d.innerHTML = html;
  const dest = n.type === 'dir' ? n.path : dirOf(n.path);
  d.ondragstart = (e) => { e.dataTransfer.setData('text/plain', n.path); e.dataTransfer.effectAllowed = 'move'; };
  d.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); d.classList.add('drop'); };
  d.ondragleave = () => d.classList.remove('drop');
  d.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); drop(e.dataTransfer.getData('text/plain'), dest); };
  d.oncontextmenu = (e) => { e.preventDefault(); menu(e, n, d); };
  return d;
}

const flush = () => Promise.all(S.tabs.filter((t) => t.dirty).map(saveNow));
function remap(src, np) {
  const f = (p) => (under(p, src) ? np + p.slice(src.length) : p);
  S.tabs.forEach((t) => { t.path = f(t.path); t.name = baseName(t.path); });
  if (S.active) S.active = f(S.active);
  if (S.target) S.target = f(S.target);
  S.open = new Set([...S.open].map(f));
}
async function drop(src, dest) {
  if (!src) return;
  await flush();
  const np = await api.move(src, dest);
  if (np !== src) { remap(src, np); S.open.add(dest); }
  await refreshTree(); renderTabs();
}

function menu(e, n, row) {
  const m = $('ctx'); m.innerHTML = '';
  const add = (l, fn) => { const b = document.createElement('div'); b.textContent = l; b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  if (n.type === 'dir') { add('Rename', () => renameDir(n, row)); add('New note here', () => { S.target = n.path; newNote(); }); }
  add('Delete', async () => {
    if (!confirm(`Move "${n.name}" to the trash?`)) return;
    await flush(); await api.trash(n.path);
    S.tabs = S.tabs.filter((t) => !under(t.path, n.path));
    if (!cur()) S.active = S.tabs.length ? S.tabs[S.tabs.length - 1].path : null;
    await refreshTree(); renderTabs(); renderPane();
  });
  m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px'; m.hidden = false;
}

function renameDir(n, row) {
  const nm = row.querySelector('.nm'), i = document.createElement('input');
  i.className = 'rn'; i.value = n.name; nm.replaceWith(i); i.focus(); i.select();
  let done = false;
  const fin = async (ok) => {
    if (done) return; done = true;
    if (ok && i.value.trim() && i.value !== n.name) { await flush(); const np = await api.renameDir(n.path, i.value); if (np !== n.path) remap(n.path, np); }
    await refreshTree(); renderTabs();
  };
  i.onkeydown = (e) => { if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
  i.onblur = () => fin(true); i.onclick = (e) => e.stopPropagation();
}

/* ---------- tabs + notes ---------- */
async function openNote(path) {
  if (!S.tabs.find((t) => t.path === path)) {
    const text = await api.read(path);
    if (/^---\r?\n[\s\S]*?\btype: health\b[\s\S]*?\r?\n---/.test(text)) { const y = (text.match(/\nyear: (\d{4})/) || [])[1]; showHealth(y ? +y : null, true); return; }
    S.tabs.push({ path, name: baseName(path), text, dirty: false });
  }
  S.active = path; S.target = dirOf(path); render();
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

const FONTS = [['Sans', 'Segoe UI, sans-serif'], ['Serif', 'Georgia, serif'], ['Mono', 'Consolas, monospace'], ['Rounded', 'Trebuchet MS, sans-serif']];
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];

function renderPane() {
  const t = cur(), pane = $('pane'); S.range = null;
  if (!t) { pane.innerHTML = '<div class="hint">Open a note from the library, or press Ctrl+N.</div>'; return; }
  pane.innerHTML = `
    <div class="tools" id="tools">
      <select id="f-font" title="Font"><option value="">Font</option>${FONTS.map(([n, v]) => `<option value="${v}">${n}</option>`).join('')}</select>
      <select id="f-size" title="Size"><option value="">Size</option>${SIZES.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
      <span class="sep"></span>
      <button data-c="bold" title="Bold"><b>B</b></button><button data-c="italic" title="Italic"><i>I</i></button>
      <button data-c="underline" title="Underline"><u>U</u></button><button data-c="strike" title="Strikethrough"><s>S</s></button>
      <span class="sep"></span>
      <button data-c="h1" title="Heading">H1</button><button data-c="h2" title="Subheading">H2</button>
      <span class="sep"></span>
      <button data-c="ul" title="Bullet list">• List</button>
      <button data-c="task" class="tick" title="Tick box">☑ Tick box</button>
    </div>
    <div class="doc"><div class="sheet">
      <input class="title" id="title" value="${esc(t.name)}" spellcheck="false">
      <div class="ed" id="ed" contenteditable="true" spellcheck="true"></div>
    </div></div>`;
  const ed = $('ed'), tools = $('tools'), title = $('title');
  ed.innerHTML = fromMd(t.text);

  title.onkeydown = (e) => { if (e.key === 'Enter') { title.blur(); ed.focus(); } };
  title.onblur = async () => {
    const np = await api.rename(t.path, title.value);
    if (np !== t.path) { if (S.active === t.path) S.active = np; t.path = np; t.name = baseName(np); await refreshTree(); }
    title.value = t.name; renderTabs();
  };

  tools.onmousedown = (e) => { if (e.target.tagName !== 'SELECT') e.preventDefault(); };
  tools.onclick = (e) => { const b = e.target.closest('button'); if (b) cmd(b.dataset.c); };
  $('f-font').onchange = (e) => { applyStyle('fontFamily', e.target.value); e.target.value = ''; };
  $('f-size').onchange = (e) => { applyStyle('fontSize', e.target.value + 'px'); e.target.value = ''; };

  ed.addEventListener('input', changed);
  ed.addEventListener('keydown', keys);
  ed.addEventListener('drop', (e) => e.preventDefault());
  ed.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  ed.addEventListener('mousedown', (e) => {
    const b = e.target.closest && e.target.closest('.box'); if (!b) return;
    e.preventDefault(); const tk = b.parentElement, d = tk.dataset.done !== '1';
    tk.dataset.done = d ? '1' : '0'; tk.classList.toggle('done', d); changed();
  });

}

function changed() {
  const ed = $('ed'), t = cur(); if (!ed || !t) return;
  if (!ed.firstChild) { ed.innerHTML = '<div><br></div>'; caret(ed.firstChild, true); }
  t.text = toMd(ed); markDirty(t);
}
const markDirty = (t) => { if (!t.dirty) { t.dirty = true; renderTabs(); } clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(t), 600); };
async function saveNow(t) { await api.write(t.path, t.text); t.dirty = false; renderTabs(); }

/* ---------- editor commands ---------- */
document.addEventListener('selectionchange', () => {
  const ed = $('ed'), s = getSelection();
  if (ed && s.rangeCount && ed.contains(s.anchorNode)) S.range = s.getRangeAt(0).cloneRange();
});
function restoreSel() { if (S.range) { const s = getSelection(); s.removeAllRanges(); s.addRange(S.range); } }
function caret(el, start) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(!!start); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function closestIn(node, sel) { const e = node && (node.nodeType === 1 ? node : node.parentElement), c = e && e.closest(sel); return c && $('ed').contains(c) ? c : null; }
function blockOf() { let n = getSelection().anchorNode; const ed = $('ed'); while (n && n.parentNode !== ed) n = n.parentNode; return n; }

function cmd(c) {
  const ed = $('ed'); ed.focus(); restoreSel();
  if (c === 'bold' || c === 'italic' || c === 'underline') document.execCommand(c);
  else if (c === 'strike') document.execCommand('strikeThrough');
  else if (c === 'h1' || c === 'h2') { const b = blockOf(); document.execCommand('formatBlock', false, b && b.tagName && b.tagName.toLowerCase() === c ? 'div' : c); }
  else if (c === 'ul') document.execCommand('insertUnorderedList');
  else if (c === 'task') toggleTask();
  changed();
}
function toggleTask() {
  const b = blockOf(); if (!b || b.nodeType !== 1) return;
  if (b.classList.contains('task')) {
    const d = document.createElement('div'); d.innerHTML = b.querySelector('.tx').innerHTML || '<br>'; b.replaceWith(d); caret(d); return;
  }
  if (b.tagName === 'UL') { let last; [...b.children].forEach((li) => { last = taskEl(li.innerHTML, false, 0); b.before(last); }); b.remove(); caret(last.querySelector('.tx')); return; }
  const tk = taskEl(b.tagName === 'DIV' ? b.innerHTML : esc(b.textContent), false, 0);
  b.replaceWith(tk); caret(tk.querySelector('.tx'));
}
function applyStyle(prop, val) {
  const ed = $('ed'); restoreSel();
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed || !ed.contains(sel.anchorNode)) return;
  const r = sel.getRangeAt(0), sp = document.createElement('span');
  sp.style[prop] = val; sp.appendChild(r.extractContents());
  sp.querySelectorAll('span').forEach((s) => { s.style[prop] = ''; });
  r.insertNode(sp); const nr = document.createRange(); nr.selectNodeContents(sp); sel.removeAllRanges(); sel.addRange(nr);
  changed();
}
function keys(e) {
  const s = getSelection(); if (!s.rangeCount) return;
  const tk = closestIn(s.anchorNode, '.task'); if (!tk) return;
  const tx = tk.querySelector('.tx'), toPara = () => { const d = document.createElement('div'); d.innerHTML = tx.innerHTML || '<br>'; tk.replaceWith(d); caret(d, true); changed(); };
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!tx.textContent.trim()) { toPara(); return; }
    const r = document.createRange(); r.selectNodeContents(tx);
    if (tx.contains(s.anchorNode)) r.setStart(s.anchorNode, s.anchorOffset); else r.collapse(false);
    const frag = r.extractContents(), nt = taskEl('', false, +tk.dataset.ind || 0), nx = nt.querySelector('.tx');
    nx.innerHTML = ''; nx.appendChild(frag); if (!nx.textContent) nx.innerHTML = '<br>';
    if (!tx.textContent) tx.innerHTML = '<br>';
    tk.after(nt); caret(nx, true); changed();
  } else if (e.key === 'Backspace' && s.isCollapsed && tx.contains(s.anchorNode)) {
    const pre = document.createRange(); pre.selectNodeContents(tx); pre.setEnd(s.anchorNode, s.anchorOffset);
    if (!pre.toString()) { e.preventDefault(); toPara(); }
  }
}

/* ---------- app actions ---------- */
async function newNote() {
  const dir = S.target || S.root; S.open.add(dir);
  const p = await api.create(dir); await refreshTree(); await openNote(p);
  const ti = $('title'); ti.focus(); ti.select();
}
async function newFolder() {
  setView('notes');
  const dir = S.target || S.root; S.open.add(dir);
  const p = await api.createDir(dir); await refreshTree();
  const row = [...$('tree').children].find((r) => r.dataset.path === p);
  if (row) renameDir({ path: p, name: p.split(/[\\/]/).pop() }, row);
}
async function chooseVault() { const v = await api.chooseVault(); if (v) { S.tabs = []; S.active = null; S.target = null; S.open = new Set(); loadVault(v); } }
function loadVault(v) { S.tasks = null; S.gantt = null; P.loaded = false; S.root = v.root; S.tree = v.tree; $('vault-name').textContent = v.root; render(); }
function render() { setView('notes'); renderTabs(); renderTree(); renderPane(); }

$('btn-new').onclick = newNote; $('btn-dir').onclick = newFolder; $('btn-vault').onclick = chooseVault;
$('filter').oninput = (e) => { S.filter = e.target.value; renderTree(); };
$('tree').ondragover = (e) => e.preventDefault();
$('tree').ondrop = (e) => { e.preventDefault(); drop(e.dataTransfer.getData('text/plain'), S.root); };
document.addEventListener('click', () => { $('ctx').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return; const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); e.shiftKey ? newFolder() : newNote(); }
  else if (k === 'o') { e.preventDefault(); chooseVault(); }
  else if (k === 's') { e.preventDefault(); const t = cur(); if (t) saveNow(t); }
  else if (k === 'w') { e.preventDefault(); if (S.active) closeTab(S.active); }
});
window.addEventListener('beforeunload', () => S.tabs.forEach((t) => t.dirty && api.write(t.path, t.text)));

document.execCommand('defaultParagraphSeparator', false, 'div');
api.openVault().then((v) => { loadVault(v); const w = v.tree.find((n) => n.type === 'file'); if (w) openNote(w.path); });

/* ---------- daily tasks ---------- */
const PAL = ['#d62bd0', '#8b5cf6', '#22d3ee', '#fb7185', '#f59e0b', '#34d399'];
const uid = () => Math.random().toString(36).slice(2, 9);
const mv = (a, i, d) => { const j = i + d; if (j >= 0 && j < a.length) [a[i], a[j]] = [a[j], a[i]]; };
let tSave = null;
const tip = document.createElement('div'); tip.id = 't-tip'; tip.hidden = true; document.body.appendChild(tip);

function setView(v) { S.view = v; document.body.classList.toggle('view-tasks', v === 'tasks'); document.body.classList.toggle('view-gantt', v === 'gantt'); $('btn-tasks').classList.toggle('on', v === 'tasks'); $('btn-gantt').classList.toggle('on', v === 'gantt'); document.body.classList.toggle('view-pomo', v === 'pomo'); $('btn-pomo').classList.toggle('on', v === 'pomo'); document.body.classList.toggle('view-health', v === 'health'); $('btn-health').classList.toggle('on', v === 'health'); tip.hidden = true; }
function tSaveNow() { clearTimeout(tSave); tSave = null; if (S.tasks) api.saveTasks(JSON.stringify(S.tasks, null, 1)); }
function tChanged() { renderTasks(); clearTimeout(tSave); tSave = setTimeout(tSaveNow, 300); }
window.addEventListener('beforeunload', () => { if (tSave) tSaveNow(); });

async function showTasks() {
  if (S.view === 'tasks') { render(); return; }
  if (!S.tasks) {
    try { S.tasks = JSON.parse(await api.loadTasks()); } catch { S.tasks = null; }
    if (!S.tasks || !Array.isArray(S.tasks.categories)) S.tasks = { categories: [] };
  }
  setView('tasks'); renderTasks();
}

function ctxAt(e, items) {
  const m = $('ctx'); m.innerHTML = '';
  items.forEach((it) => {
    const b = document.createElement('div');
    if (!it) b.className = 'sp'; else { b.textContent = it[0]; if (it[2]) b.className = it[2]; b.onclick = () => { m.hidden = true; it[1](); }; }
    m.appendChild(b);
  });
  m.style.left = Math.min(e.clientX, innerWidth - 190) + 'px'; m.style.top = Math.min(e.clientY, innerHeight - items.length * 30 - 20) + 'px'; m.hidden = false;
}
function inlineEdit(span, value, save) {
  const i = document.createElement('input'); i.className = 't-edit'; i.value = value; span.replaceWith(i); i.focus(); i.select();
  let done = false;
  const fin = (ok) => { if (done) return; done = true; const v = i.value.trim(); if (ok && v && v !== value) save(v); else renderTasks(); };
  i.onkeydown = (e) => { if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
  i.onblur = () => fin(true);
}
function showTip(row, text) {
  tip.textContent = text; tip.hidden = false;
  const r = row.getBoundingClientRect(); let x = r.right + 10;
  if (x + tip.offsetWidth > innerWidth - 10) x = Math.max(10, r.left - tip.offsetWidth - 10);
  tip.style.left = x + 'px'; tip.style.top = r.top + 'px';
}
function noteModal(t) {
  const ov = document.createElement('div'); ov.className = 't-modal';
  ov.innerHTML = `<div class="t-card"><h3>Note</h3><div class="t-for">${esc(t.text)}</div><textarea placeholder="Write a note for this task…">${esc(t.note || '')}</textarea>
    <div class="t-actions">${t.note ? '<button data-a="del">Remove note</button>' : ''}<span></span><button data-a="x">Cancel</button><button class="primary" data-a="ok">Save</button></div></div>`;
  const ta = ov.querySelector('textarea'), close = () => ov.remove();
  const ok = () => { t.note = ta.value.trim(); close(); tChanged(); };
  ov.onclick = (e) => { if (e.target === ov) close(); const a = e.target.dataset && e.target.dataset.a; if (a === 'x') close(); if (a === 'ok') ok(); if (a === 'del') { t.note = ''; close(); tChanged(); } };
  ta.onkeydown = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.ctrlKey) ok(); };
  document.body.appendChild(ov); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

function renderTasks() {
  tip.hidden = true;
  const el = $('tasks'), T = S.tasks, old = el.querySelector('.t-board');
  const sl = old ? old.scrollLeft : 0, st = old ? old.scrollTop : 0;
  const all = T.categories.flatMap((c) => c.tasks), done = all.filter((t) => t.done).length, pct = all.length ? Math.round(done / all.length * 100) : 0;
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  el.innerHTML = `<div class="t-head"><div><h1>Daily tasks</h1><div class="t-sub">${T.categories.length ? `${date} · ${done} of ${all.length} done` : 'Add a category to build your routine'}</div></div>
    <div class="t-prog" title="${pct}%"><i style="width:${pct}%"></i></div><button id="t-reset">Uncheck all</button></div><div class="t-board"></div>`;
  $('t-reset').onclick = () => { all.forEach((t) => { t.done = false; }); tChanged(); };
  const board = el.querySelector('.t-board');
  T.categories.forEach((c, ci) => board.appendChild(colEl(c, ci)));
  board.appendChild(ghostCol());
  board.scrollLeft = sl; board.scrollTop = st;
  if (S.focusAdd) { const i = el.querySelector(`.t-add[data-cat="${S.focusAdd}"]`); if (i) i.focus(); S.focusAdd = null; }
}

function colEl(c, ci) {
  const T = S.tasks, d = document.createElement('section'); d.className = 't-col'; d.style.setProperty('--c', PAL[c.color % PAL.length]);
  const n = c.tasks.filter((t) => t.done).length, p = c.tasks.length ? n / c.tasks.length * 100 : 0;
  d.innerHTML = `<header class="t-ch"><span class="t-name">${esc(c.name)}</span><span class="t-count">${n}/${c.tasks.length}</span><button class="t-more" title="Category options">⋯</button></header><div class="t-bar"><i style="width:${p}%"></i></div><div class="t-list"></div>`;
  const catMenu = (e) => ctxAt(e, [
    ['Rename', () => inlineEdit(d.querySelector('.t-name'), c.name, (v) => { c.name = v; tChanged(); })],
    ['Change color', () => { c.color = (c.color + 1) % PAL.length; tChanged(); }],
    ['Uncheck all', () => { c.tasks.forEach((t) => { t.done = false; }); tChanged(); }],
    ci > 0 && ['Move left', () => { mv(T.categories, ci, -1); tChanged(); }],
    ci < T.categories.length - 1 && ['Move right', () => { mv(T.categories, ci, 1); tChanged(); }],
    null,
    ['Delete category', () => { if (c.tasks.length && !confirm(`Delete "${c.name}" and its ${c.tasks.length} tasks?`)) return; T.categories.splice(ci, 1); tChanged(); }, 'danger'],
  ].filter((x) => x !== false));
  d.querySelector('.t-ch').oncontextmenu = (e) => { e.preventDefault(); catMenu(e); };
  d.querySelector('.t-more').onclick = (e) => { e.stopPropagation(); catMenu(e); };

  const list = d.querySelector('.t-list');
  c.tasks.forEach((t, ti) => {
    const r = document.createElement('div'); r.className = 't-row' + (t.done ? ' done' : '') + (t.note ? ' has-note' : '');
    r.innerHTML = `<span class="t-box"></span><span class="t-text">${esc(t.text)}</span>`;
    const rename = () => inlineEdit(r.querySelector('.t-text'), t.text, (v) => { t.text = v; tChanged(); });
    r.querySelector('.t-box').onclick = () => { t.done = !t.done; tChanged(); };
    r.querySelector('.t-text').ondblclick = rename;
    if (t.note) { r.onmouseenter = () => showTip(r, t.note); r.onmouseleave = () => { tip.hidden = true; }; }
    r.oncontextmenu = (e) => {
      e.preventDefault(); tip.hidden = true;
      ctxAt(e, [
        [t.note ? 'Edit note' : 'Add note', () => noteModal(t)],
        ['Rename', rename],
        ti > 0 && ['Move up', () => { mv(c.tasks, ti, -1); tChanged(); }],
        ti < c.tasks.length - 1 && ['Move down', () => { mv(c.tasks, ti, 1); tChanged(); }],
        null,
        ['Delete task', () => { c.tasks.splice(ti, 1); tChanged(); }, 'danger'],
      ].filter((x) => x !== false));
    };
    list.appendChild(r);
  });
  const add = document.createElement('input'); add.className = 't-add'; add.placeholder = '+ Add task'; add.dataset.cat = c.id;
  add.onkeydown = (e) => { if (e.key === 'Enter' && add.value.trim()) { c.tasks.push({ id: uid(), text: add.value.trim(), done: false, note: '' }); S.focusAdd = c.id; tChanged(); } };
  d.appendChild(add);
  return d;
}

function ghostCol() {
  const g = document.createElement('button'); g.className = 't-ghost'; g.innerHTML = '<span>+</span> Add category';
  g.onclick = () => {
    const i = document.createElement('input'); i.className = 't-ghost-in'; i.placeholder = 'Category name'; g.replaceWith(i); i.focus();
    let done = false;
    const fin = (ok) => {
      if (done) return; done = true; const v = i.value.trim();
      if (ok && v) { const c = { id: uid(), name: v, color: S.tasks.categories.length % PAL.length, tasks: [] }; S.tasks.categories.push(c); S.focusAdd = c.id; tChanged(); } else renderTasks();
    };
    i.onkeydown = (e) => { if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
    i.onblur = () => fin(!!i.value.trim());
  };
  return g;
}
$('btn-tasks').onclick = showTasks;

/* ---------- gantt ---------- */
const RH = 36, LW = 320, ZOOM = { day: 36, week: 14, month: 5 };
const G = { zoom: 'day', drag: null, hover: null, save: null, focusAdd: null, lo: null, hi: null, lockLo: null, lockHi: null };
const pad2 = (n) => String(n).padStart(2, '0');
const dn = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const ds = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const todayN = () => { const d = new Date(); return dn(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); };
const fmtD = (n) => new Date(n * 864e5).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const gTasks = () => S.gantt.groups.flatMap((g) => g.tasks);
const gFind = (id) => gTasks().find((t) => t.id === id);
const gGroup = (id) => S.gantt.groups.find((g) => g.id === id);
const gGroupOf = (tid) => S.gantt.groups.find((g) => g.tasks.some((t) => t.id === tid));
const gColor = (g) => PAL[g.color % PAL.length];
const gSpan = (g) => (g.tasks.length ? [Math.min(...g.tasks.map((t) => dn(t.start))), Math.max(...g.tasks.map((t) => dn(t.end)))] : null);

function gSaveNow() { clearTimeout(G.save); G.save = null; if (S.gantt) api.saveData('Gantt.gantt.json', JSON.stringify(S.gantt, null, 1)); }
function gChanged() { renderGantt(); clearTimeout(G.save); G.save = setTimeout(gSaveNow, 300); }
window.addEventListener('beforeunload', () => { if (G.save) gSaveNow(); });

/* a task may never start before its predecessors finish; pushing forward cascades to dependents */
function cascade(id, depth = 0) {
  if (depth > 60) return;
  const t = gFind(id), end = dn(t.end);
  gTasks().forEach((s) => {
    if (!s.deps.includes(id)) return;
    const ss = dn(s.start);
    if (ss <= end) { const dur = dn(s.end) - ss; s.start = ds(end + 1); s.end = ds(end + 1 + dur); cascade(s.id, depth + 1); }
  });
}
function descendants(id, out = new Set()) {
  gTasks().forEach((s) => { if (s.deps.includes(id) && !out.has(s.id)) { out.add(s.id); descendants(s.id, out); } });
  return out;
}

async function showGantt() {
  if (S.view === 'gantt') { render(); return; }
  if (!S.gantt) {
    try { S.gantt = JSON.parse(await api.loadData('Gantt.gantt.json')); } catch { S.gantt = null; }
    if (!S.gantt || !Array.isArray(S.gantt.groups)) S.gantt = { groups: [] };
    S.gantt.groups.forEach((g) => g.tasks.forEach((t) => { t.deps = t.deps || []; t.progress = t.progress || 0; }));
  }
  setView('gantt'); renderGantt(true);
}

function renderGantt(toToday) {
  tip.hidden = true; G.hover = null;
  const el = $('gantt'), D = S.gantt, ppd = ZOOM[G.zoom], old = el.querySelector('.g-scroll');
  const sl = old ? old.scrollLeft : 0, st = old ? old.scrollTop : 0;
  const all = gTasks(), tn = todayN();
  const pct = all.length ? Math.round(all.reduce((a, t) => a + (t.progress || 0), 0) / all.length) : 0;
  let html = `<div class="t-head"><div><h1>Gantt</h1><div class="t-sub">${all.length} task${all.length === 1 ? '' : 's'} · ${pct}% complete · drag bars to move, drag edges to resize</div></div>
    <div class="g-tools"><div class="seg">${['day', 'week', 'month'].map((z) => `<button data-act="z-${z}" class="${G.zoom === z ? 'on' : ''}">${z[0].toUpperCase() + z.slice(1)}</button>`).join('')}</div>
    <button data-act="today">Today</button><button class="g-primary" data-act="addproj">+ Project</button></div></div>`;
  if (!D.groups.length) {
    el.innerHTML = html + `<div class="g-empty"><h2>Plan something big</h2><p>Create a project, add tasks, then drag the bars to schedule them. Link tasks together and the chart reshuffles itself when dates move.</p><button class="g-primary" data-act="addproj">+ Add project</button> <button data-act="example">Load example</button></div>`;
    return;
  }
  let lo = Math.min(tn, ...all.map((t) => dn(t.start))) - 10, hi = Math.max(tn, ...all.map((t) => dn(t.end))) + 45;
  if (G.drag && G.lockLo != null) { lo = G.lockLo; hi = Math.max(G.lockHi, hi); } else lo -= ((lo + 3) % 7 + 7) % 7;
  hi = Math.max(hi, lo + 90);
  const prevLo = G.lo; G.lo = lo; G.hi = hi;
  const W = (hi - lo + 1) * ppd, x = (n) => (n - lo) * ppd;

  let mo = '', dy = '', segStart = lo, key = ds(lo).slice(0, 7);
  for (let n = lo; n <= hi + 1; n++) {
    const k = n <= hi ? ds(n).slice(0, 7) : '';
    if (k !== key) {
      const label = new Date(segStart * 864e5).toLocaleDateString(undefined, { month: ppd >= 14 ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
      mo += `<div class="g-mo" style="left:${x(segStart)}px;width:${(n - segStart) * ppd}px">${label}</div>`; segStart = n; key = k;
    }
  }
  let we = '';
  for (let n = lo; n <= hi; n++) {
    const wd = (n + 3) % 7, d = new Date(n * 864e5).getUTCDate();
    if (ppd >= 28) dy += `<div class="g-dy${wd >= 5 ? ' we' : ''}${n === tn ? ' td' : ''}" style="left:${x(n)}px;width:${ppd}px">${d}<small>${'MTWTFSS'[wd]}</small></div>`;
    else if (ppd >= 10 && wd === 0) dy += `<div class="g-dy wk" style="left:${x(n)}px;width:${7 * ppd}px">${d}</div>`;
    if (ppd >= 10 && wd >= 5) we += `<div class="g-we" style="left:${x(n)}px;width:${ppd}px"></div>`;
  }

  const R = [];
  D.groups.forEach((g) => { R.push({ k: 'g', g }); if (!g.collapsed) { g.tasks.forEach((t) => R.push({ k: 't', g, t })); R.push({ k: 'a', g }); } });
  const ri = {}; R.forEach((r, i) => { if (r.k === 't') ri[r.t.id] = i; });
  let list = '', plot = '', bars = '', svg = '';
  R.forEach((r, i) => {
    const c = gColor(r.g), top = i * RH;
    if (r.k === 'g') {
      const g = r.g, n = g.tasks.filter((t) => t.progress >= 100).length, sp = gSpan(g);
      list += `<div class="g-r g-grow" data-gid="${g.id}" style="--c:${c}"><span class="g-chev">${g.collapsed ? '▸' : '▾'}</span><span class="g-dot"></span><span class="g-nm">${esc(g.name)}</span><span class="g-cnt">${n}/${g.tasks.length}</span><button class="g-more" data-act="gmenu" title="Project options">⋯</button></div>`;
      plot += `<div class="g-gbg" style="top:${top}px;height:${RH}px;--c:${c}"></div>`;
      if (sp) bars += `<div class="g-sum" style="left:${x(sp[0])}px;width:${(sp[1] - sp[0] + 1) * ppd}px;top:${top + 13}px;--c:${c}"></div>`;
    } else if (r.k === 't') {
      const t = r.t, s = dn(t.start), e = dn(t.end), w = (e - s + 1) * ppd, p = Math.max(0, Math.min(100, t.progress || 0));
      list += `<div class="g-r g-trow${p >= 100 ? ' done' : ''}" data-id="${t.id}" style="--c:${c}"><span class="g-nm">${esc(t.name)}</span><span class="g-dt">${fmtD(s)} – ${fmtD(e)}</span></div>`;
      bars += `<div class="g-bar${p >= 100 ? ' done' : ''}" data-id="${t.id}" style="left:${x(s)}px;width:${w}px;top:${top + 7}px;height:${RH - 14}px;--c:${c}"><i class="g-fill" style="width:${p}%"></i><span class="g-bl">${w > 50 ? p + '%' : ''}</span><b class="g-h g-h-l"></b><b class="g-h g-h-r"></b></div>`;
    } else {
      list += `<div class="g-r g-arow" style="--c:${c}"><input class="g-add" data-gid="${r.g.id}" placeholder="+ Add task"></div>`;
    }
  });
  list += `<div class="g-r g-arow"><button class="g-addp" data-act="addproj">+ Add project</button></div>`;
  R.forEach((r) => {
    if (r.k !== 't') return;
    r.t.deps.forEach((pid) => {
      const p = gFind(pid); if (!p || ri[pid] === undefined) return;
      const x1 = x(dn(p.end) + 1), y1 = ri[pid] * RH + RH / 2, x2 = x(dn(r.t.start)), y2 = ri[r.t.id] * RH + RH / 2;
      svg += `<path d="M${x1} ${y1} C${x1 + 26} ${y1} ${x2 - 26} ${y2} ${x2 - 3} ${y2}"/><path class="ah" d="M${x2} ${y2} l-7 -4 v8 z"/>`;
    });
  });
  const gw = ppd >= 28 ? ppd : 7 * ppd;
  html += `<div class="g-scroll"><div class="g-inner" style="width:${LW + W}px">
    <div class="g-hdr"><div class="g-corner">Projects &amp; tasks</div><div class="g-scale" style="width:${W}px">${mo}${dy}<i class="g-tf" style="left:${x(tn) + ppd / 2}px"></i></div></div>
    <div class="g-rows"><div class="g-list">${list}</div>
      <div class="g-plot" style="width:${W}px;height:${(R.length + 1) * RH}px;background-size:${gw}px 100%,100% ${RH}px">${plot}${we}<svg class="g-svg" width="${W}" height="${(R.length + 1) * RH}">${svg}</svg>${bars}<i class="g-today" style="left:${x(tn) + ppd / 2}px"></i></div></div></div></div>`;
  el.innerHTML = html;

  const sc = el.querySelector('.g-scroll');
  if (toToday) sc.scrollLeft = Math.max(0, x(tn) - 240);
  else { sc.scrollLeft = sl + (prevLo != null ? (prevLo - lo) * ppd : 0); sc.scrollTop = st; }
  if (G.focusAdd) { const i = el.querySelector(`.g-add[data-gid="${G.focusAdd}"]`); if (i) i.focus({ preventScroll: true }); G.focusAdd = null; }
}

function gEdit(span, value, save) {
  const i = document.createElement('input'); i.className = 't-edit'; i.value = value; span.replaceWith(i); i.focus(); i.select();
  let done = false;
  const fin = (ok) => { if (done) return; done = true; const v = i.value.trim(); if (ok && v && v !== value) save(v); else renderGantt(); };
  i.onkeydown = (e) => { if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
  i.onblur = () => fin(true);
}
function renameTask(id) { const t = gFind(id), nm = $('gantt').querySelector(`.g-trow[data-id="${id}"] .g-nm`); if (nm) gEdit(nm, t.name, (v) => { t.name = v; gChanged(); }); }
function renameGroup(id) { const g = gGroup(id), nm = $('gantt').querySelector(`.g-grow[data-gid="${id}"] .g-nm`); if (nm) gEdit(nm, g.name, (v) => { g.name = v; gChanged(); }); }
function addProject() {
  const g = { id: uid(), name: 'New project', color: S.gantt.groups.length % PAL.length, collapsed: false, tasks: [] };
  S.gantt.groups.push(g); gChanged(); renameGroup(g.id);
}
function addTask(gid, name) {
  const g = gGroup(gid), last = g.tasks[g.tasks.length - 1], s = last ? dn(last.end) + 1 : todayN();
  g.tasks.push({ id: uid(), name, start: ds(s), end: ds(s + 2), progress: 0, deps: [], note: '' });
  G.focusAdd = gid; gChanged();
}
function delTask(id) {
  const g = gGroupOf(id); g.tasks = g.tasks.filter((t) => t.id !== id);
  gTasks().forEach((t) => { t.deps = t.deps.filter((d) => d !== id); }); gChanged();
}
function loadExample() {
  const t0 = todayN(), mk = (name, off, len, p, deps = []) => ({ id: uid(), name, start: ds(t0 + off), end: ds(t0 + off + len - 1), progress: p, deps, note: '' });
  const a = mk('Write script', 0, 3, 100), b = mk('Record footage', 3, 2, 60, [a.id]), c = mk('Edit video', 5, 4, 20, [b.id]), d = mk('Design thumbnail', 5, 2, 0, [b.id]), e = mk('Publish & promote', 9, 2, 0, [c.id, d.id]);
  S.gantt.groups.push({ id: uid(), name: 'Video launch', color: 0, collapsed: false, tasks: [a, b, c, d, e] }); gChanged();
}
function scrollToday() { const sc = $('gantt').querySelector('.g-scroll'); if (sc) sc.scrollTo({ left: Math.max(0, (todayN() - G.lo) * ZOOM[G.zoom] - 240), behavior: 'smooth' }); }

function taskMenu(e, id) {
  const t = gFind(id), g = gGroupOf(id), i = g.tasks.indexOf(t);
  ctxAt(e, [
    ['Edit details…', () => taskModal(t)],
    ['Rename', () => renameTask(id)],
    t.progress < 100 ? ['Mark complete', () => { t.progress = 100; gChanged(); }] : ['Reset progress', () => { t.progress = 0; gChanged(); }],
    i > 0 && ['Move up', () => { mv(g.tasks, i, -1); gChanged(); }],
    i < g.tasks.length - 1 && ['Move down', () => { mv(g.tasks, i, 1); gChanged(); }],
    null,
    ['Delete task', () => delTask(id), 'danger'],
  ].filter((x) => x !== false));
}
function groupMenu(e, gid) {
  const D = S.gantt, g = gGroup(gid), i = D.groups.indexOf(g);
  ctxAt(e, [
    ['Rename', () => renameGroup(gid)],
    ['Add task', () => { g.collapsed = false; G.focusAdd = gid; gChanged(); }],
    ['Change color', () => { g.color = (g.color + 1) % PAL.length; gChanged(); }],
    i > 0 && ['Move up', () => { mv(D.groups, i, -1); gChanged(); }],
    i < D.groups.length - 1 && ['Move down', () => { mv(D.groups, i, 1); gChanged(); }],
    null,
    ['Delete project', () => {
      if (g.tasks.length && !confirm(`Delete "${g.name}" and its ${g.tasks.length} tasks?`)) return;
      const ids = new Set(g.tasks.map((t) => t.id)); D.groups.splice(i, 1);
      gTasks().forEach((t) => { t.deps = t.deps.filter((d) => !ids.has(d)); }); gChanged();
    }, 'danger'],
  ].filter((x) => x !== false));
}

function taskModal(t) {
  const bad = descendants(t.id); bad.add(t.id);
  const cands = S.gantt.groups.flatMap((g) => g.tasks.filter((s) => !bad.has(s.id)).map((s) => ({ s, g })));
  const ov = document.createElement('div'); ov.className = 't-modal';
  ov.innerHTML = `<div class="t-card g-card"><h3>Task details</h3>
    <div class="g-f"><label>Name</label><input class="g-in" id="gm-n" value="${esc(t.name).replace(/"/g, '&quot;')}"></div>
    <div class="g-row"><div class="g-f"><label>Start</label><input type="date" class="g-in" id="gm-s" value="${t.start}"></div><div class="g-f"><label>End</label><input type="date" class="g-in" id="gm-e" value="${t.end}"></div></div>
    <div class="g-f"><label>Progress <b id="gm-pv">${t.progress}%</b></label><input type="range" min="0" max="100" step="5" id="gm-p" value="${t.progress}"></div>
    <div class="g-f"><label>Starts after</label><div class="g-deps">${cands.length ? cands.map(({ s, g }) => `<label><input type="checkbox" value="${s.id}"${t.deps.includes(s.id) ? ' checked' : ''}><span>${esc(g.name)} · ${esc(s.name)}</span></label>`).join('') : '<span class="g-none">No other tasks yet</span>'}</div></div>
    <div class="g-f"><label>Notes</label><textarea id="gm-t">${esc(t.note || '')}</textarea></div>
    <div class="t-actions"><button data-a="del">Delete</button><span></span><button data-a="x">Cancel</button><button class="primary" data-a="ok">Save</button></div></div>`;
  const close = () => ov.remove(), q = (id) => ov.querySelector('#' + id);
  q('gm-p').oninput = () => { q('gm-pv').textContent = q('gm-p').value + '%'; };
  const ok = () => {
    let s = q('gm-s').value && dn(q('gm-s').value), e = q('gm-e').value && dn(q('gm-e').value);
    if (!s || !e) return;
    if (e < s) [s, e] = [e, s];
    t.name = q('gm-n').value.trim() || t.name; t.progress = +q('gm-p').value; t.note = q('gm-t').value.trim();
    t.deps = [...ov.querySelectorAll('.g-deps input:checked')].map((c) => c.value);
    t.deps.forEach((pid) => { const need = dn(gFind(pid).end) + 1; if (s < need) { e += need - s; s = need; } });
    t.start = ds(s); t.end = ds(e); cascade(t.id); close(); gChanged();
  };
  ov.onclick = (e) => {
    if (e.target === ov) close();
    const a = e.target.dataset && e.target.dataset.a;
    if (a === 'x') close(); if (a === 'ok') ok(); if (a === 'del') { close(); delTask(t.id); }
  };
  ov.onkeydown = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.ctrlKey) ok(); };
  document.body.appendChild(ov); q('gm-n').focus(); q('gm-n').select();
}

function gTip(b, text) {
  tip.textContent = text; tip.hidden = false;
  const r = b.getBoundingClientRect(); let y = r.bottom + 6;
  if (y + tip.offsetHeight > innerHeight - 10) y = r.top - tip.offsetHeight - 6;
  tip.style.left = Math.max(10, Math.min(r.left, innerWidth - tip.offsetWidth - 10)) + 'px'; tip.style.top = y + 'px';
}

const gEl = $('gantt');
gEl.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) {
    const act = a.dataset.act;
    if (act.startsWith('z-')) { G.zoom = act.slice(2); renderGantt(true); }
    else if (act === 'today') scrollToday();
    else if (act === 'addproj') addProject();
    else if (act === 'example') loadExample();
    else if (act === 'gmenu') { e.stopPropagation(); groupMenu(e, a.closest('.g-r').dataset.gid); }
    return;
  }
  if (e.target.closest('.g-chev')) { const g = gGroup(e.target.closest('.g-grow').dataset.gid); g.collapsed = !g.collapsed; gChanged(); }
});
gEl.addEventListener('dblclick', (e) => {
  const bar = e.target.closest('.g-bar'); if (bar) { taskModal(gFind(bar.dataset.id)); return; }
  const nm = e.target.closest('.g-nm'); if (!nm) return;
  const row = nm.closest('.g-r');
  if (row.dataset.id) renameTask(row.dataset.id); else if (row.classList.contains('g-grow')) renameGroup(row.dataset.gid);
});
gEl.addEventListener('contextmenu', (e) => {
  const bar = e.target.closest('.g-bar'), tr = e.target.closest('.g-trow'), gr = e.target.closest('.g-grow');
  const id = (bar && bar.dataset.id) || (tr && tr.dataset.id);
  if (id) { e.preventDefault(); taskMenu(e, id); } else if (gr) { e.preventDefault(); groupMenu(e, gr.dataset.gid); }
});
gEl.addEventListener('keydown', (e) => {
  const i = e.target;
  if (i.classList && i.classList.contains('g-add') && e.key === 'Enter' && i.value.trim()) addTask(i.dataset.gid, i.value.trim());
});
gEl.addEventListener('mouseover', (e) => {
  if (G.drag) return;
  const b = e.target.closest('.g-bar'); if (b === G.hover) return;
  G.hover = b; if (!b) { tip.hidden = true; return; }
  const t = gFind(b.dataset.id); if (!t) return;
  const s = dn(t.start), en = dn(t.end);
  gTip(b, `${t.name}\n${fmtD(s)} → ${fmtD(en)} · ${en - s + 1} day${en > s ? 's' : ''}\n${t.progress}% complete` + (t.note ? `\n\n${t.note}` : ''));
});
gEl.addEventListener('mousedown', (e) => {
  const b = e.target.closest('.g-bar'); if (!b || e.button !== 0) return;
  const t = gFind(b.dataset.id); if (!t) return;
  e.preventDefault(); tip.hidden = true;
  const mode = e.target.classList.contains('g-h-l') ? 'l' : e.target.classList.contains('g-h-r') ? 'r' : 'move';
  G.drag = { id: t.id, mode, x0: e.clientX, s0: dn(t.start), e0: dn(t.end), last: 0, moved: false };
  G.lockLo = G.lo; G.lockHi = G.hi; document.body.classList.add('g-drag');
});
document.addEventListener('mousemove', (e) => {
  const k = G.drag; if (!k) return;
  const d = Math.round((e.clientX - k.x0) / ZOOM[G.zoom]); if (d === k.last) return;
  k.last = d; k.moved = true;
  const t = gFind(k.id), minS = Math.max(G.lockLo, ...t.deps.map((id) => { const p = gFind(id); return p ? dn(p.end) + 1 : -Infinity; }));
  let s = k.s0, en = k.e0;
  if (k.mode === 'move') { const dd = Math.max(d, minS - s); s += dd; en += dd; }
  else if (k.mode === 'l') s = Math.max(Math.min(s + d, en), minS);
  else en = Math.max(en + d, s);
  t.start = ds(s); t.end = ds(en); cascade(t.id); renderGantt();
});
document.addEventListener('mouseup', () => {
  const k = G.drag; if (!k) return;
  G.drag = null; G.lockLo = G.lockHi = null; document.body.classList.remove('g-drag');
  if (k.moved) { renderGantt(); clearTimeout(G.save); G.save = setTimeout(gSaveNow, 300); }
});
$('btn-gantt').onclick = showGantt;

/* ---------- pomodoro ---------- */
const P = {
  cfg: { focus: 25, short: 5, long: 15, rounds: 4, autoBreak: true, autoFocus: false, sound: true, notify: true },
  mode: 'focus', total: 1500, left: 1500, running: false, endAt: 0, round: 1, task: '', stats: {},
  tick: null, loaded: false, lit: -1, save: null,
};
const LIM = { focus: [1, 120], short: [1, 60], long: [1, 90], rounds: [2, 12] };
const MODES = { focus: 'Focus', short: 'Short break', long: 'Long break' };
const CIRC = 2 * Math.PI * 148;
const mmss = (s) => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
const pk = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const pSaveSoon = () => { clearTimeout(P.save); P.save = setTimeout(() => api.saveData('Pomodoro.pomo.json', JSON.stringify({ cfg: P.cfg, stats: P.stats })), 400); };

async function showPomo() {
  if (S.view === 'pomo') { render(); return; }
  if (!P.loaded) {
    try { const d = JSON.parse(await api.loadData('Pomodoro.pomo.json')); Object.assign(P.cfg, d.cfg || {}); P.stats = d.stats || {}; } catch { /* first run */ }
    P.loaded = true;
    if (!P.running && P.left === P.total) { P.total = P.left = P.cfg[P.mode] * 60; }
  }
  setView('pomo'); renderPomo();
}

function chime() {
  if (!P.cfg.sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), t0 = ctx.currentTime;
    [[659.25, 0], [783.99, 0.2], [1046.5, 0.4]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + t); g.gain.linearRampToValueAtTime(0.18, t0 + t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 1.3);
      o.connect(g); g.connect(ctx.destination); o.start(t0 + t); o.stop(t0 + t + 1.4);
    });
    setTimeout(() => ctx.close(), 2500);
  } catch { /* no audio */ }
}
function notify(title, body) { if (P.cfg.notify && 'Notification' in window) { try { new Notification(title, { body, silent: true }); } catch { /* ignore */ } } }

function start() {
  if (P.running) return;
  if (P.left <= 0) P.left = P.total;
  P.running = true; P.endAt = Date.now() + P.left * 1000;
  clearInterval(P.tick); P.tick = setInterval(ptick, 250); renderPomo();
}
function pause() {
  if (!P.running) return;
  P.left = Math.max(0, Math.ceil((P.endAt - Date.now()) / 1000)); clearInterval(P.tick); P.running = false; renderPomo();
}
function resetT() { clearInterval(P.tick); P.running = false; P.left = P.total; renderPomo(); }
function ptick() {
  P.left = Math.max(0, Math.ceil((P.endAt - Date.now()) / 1000));
  if (P.left <= 0) finish(); else updPomo();
}
function finish() {
  clearInterval(P.tick); P.running = false; chime();
  if (P.mode === 'focus') notify('Focus complete', P.round >= P.cfg.rounds ? 'Great work. Time for a long break.' : 'Nice one. Take a short break.');
  else notify('Break over', 'Ready to focus?');
  advance(true);
}
function setMode(m, auto) {
  clearInterval(P.tick); P.running = false; P.mode = m; P.total = P.left = P.cfg[m] * 60;
  renderPomo(); if (auto) start();
}
function advance(record) {
  const wasFocus = P.mode === 'focus';
  if (wasFocus && record) { const k = pk(new Date()), s = P.stats[k] || (P.stats[k] = { n: 0, min: 0 }); s.n++; s.min += P.cfg.focus; pSaveSoon(); }
  let next;
  if (wasFocus) next = P.round >= P.cfg.rounds ? 'long' : 'short';
  else { P.round = P.mode === 'long' ? 1 : P.round + 1; next = 'focus'; }
  setMode(next, record && (wasFocus ? P.cfg.autoBreak : P.cfg.autoFocus));
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M6 6l8.5 6L6 18zM16 6h2v12h-2z"/></svg>',
};

function renderPomo() {
  const el = $('pomo'), c = P.cfg; el.dataset.mode = P.mode; P.lit = -1;
  const today = pk(new Date()), st = P.stats[today] || { n: 0, min: 0 };
  const done = P.mode === 'focus' ? P.round - 1 : P.round;
  const dots = Array.from({ length: c.rounds }, (_, i) => `<i class="p-dot${i < done ? ' on' : ''}${P.mode === 'focus' && i === P.round - 1 ? ' cur' : ''}"></i>`).join('');
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 - 90) * Math.PI / 180, r1 = i % 5 === 0 ? 166 : 171, r2 = 187;
    ticks += `<line class="p-tk${i % 5 === 0 ? ' m' : ''}" x1="${(200 + r1 * Math.cos(a)).toFixed(1)}" y1="${(200 + r1 * Math.sin(a)).toFixed(1)}" x2="${(200 + r2 * Math.cos(a)).toFixed(1)}" y2="${(200 + r2 * Math.sin(a)).toFixed(1)}"/>`;
  }
  const step = (k, label, unit) => `<div class="p-row"><span>${label}</span><div class="p-step"><button data-k="${k}" data-d="-1">−</button><b>${c[k]}${unit}</b><button data-k="${k}" data-d="1">+</button></div></div>`;
  const sw = (k, label) => `<div class="p-row"><span>${label}</span><button class="p-sw${c[k] ? ' on' : ''}" data-t="${k}"><i></i></button></div>`;
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return { d, n: (P.stats[pk(d)] || { n: 0 }).n }; });
  const mx = Math.max(1, ...days.map((x) => x.n));
  const week = days.map((x, i) => `<div class="p-col"><i class="p-bar${x.n ? '' : ' empty'}${i === 6 ? ' today' : ''}" style="height:${x.n ? Math.max(6, x.n / mx * 52) : 3}px" title="${x.n} session${x.n === 1 ? '' : 's'}"></i><small>${'SMTWTFS'[x.d.getDay()]}</small></div>`).join('');
  el.innerHTML = `
    <div class="t-head"><div><h1>Pomodoro</h1><div class="t-sub">Today · ${st.n} session${st.n === 1 ? '' : 's'} · ${st.min} min of focus</div></div></div>
    <div class="p-wrap">
      <div class="p-stage">
        <div class="seg p-modes">${Object.entries(MODES).map(([m, l]) => `<button data-m="${m}" class="${P.mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="p-ring">
          <svg viewBox="0 0 400 400"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--pa)"/><stop offset="1" style="stop-color:var(--pb)"/></linearGradient></defs>
            <circle class="p-inner" cx="200" cy="200" r="124"/>${ticks}
            <circle class="p-track" cx="200" cy="200" r="148"/>
            <circle class="p-prog" id="p-prog" cx="200" cy="200" r="148" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/></svg>
          <div class="p-center"><div class="p-lab">${MODES[P.mode]}</div><div class="p-time" id="p-time">${mmss(P.left)}</div><div class="p-dots">${dots}</div></div>
        </div>
        <div class="p-ctrl"><button class="p-btn" id="p-reset" title="Reset">${ICON.reset}</button><button class="p-go" id="p-go" title="Start / pause (Space)">${P.running ? ICON.pause : ICON.play}</button><button class="p-btn" id="p-skip" title="Skip to next">${ICON.skip}</button></div>
        <input class="p-task" placeholder="What are you focusing on?" value="${esc(P.task).replace(/"/g, '&quot;')}" spellcheck="false">
      </div>
      <aside class="p-side">
        <div class="p-card"><h3>Timer</h3>${step('focus', 'Focus', ' min')}${step('short', 'Short break', ' min')}${step('long', 'Long break', ' min')}${step('rounds', 'Rounds before long break', '')}</div>
        <div class="p-card"><h3>Automation &amp; alerts</h3>${sw('autoBreak', 'Auto-start breaks')}${sw('autoFocus', 'Auto-start focus')}${sw('sound', 'Chime when done')}${sw('notify', 'Desktop notification')}</div>
        <div class="p-card"><h3>Your focus</h3><div class="p-stats"><div class="p-stat"><b>${st.n}</b><small>sessions today</small></div><div class="p-stat"><b>${st.min}</b><small>minutes today</small></div></div><div class="p-week">${week}</div></div>
      </aside>
    </div>`;
  updPomo();
}

function updPomo() {
  const t = $('p-time'), frac = P.total ? 1 - P.left / P.total : 0;
  if (t) {
    t.textContent = mmss(P.left);
    $('p-prog').style.strokeDashoffset = CIRC * (1 - frac);
    const n = Math.floor(frac * 60);
    if (n !== P.lit) { P.lit = n; $('pomo').querySelectorAll('.p-tk').forEach((k, i) => k.classList.toggle('on', i < n)); }
  }
  $('btn-pomo').textContent = P.running ? `● ${mmss(P.left)}` : 'Pomodoro';
  document.title = P.running ? `${mmss(P.left)} · ${MODES[P.mode]}` : 'Signal Path';
}

$('pomo').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.m) setMode(b.dataset.m, false);
  else if (b.dataset.k) {
    const k = b.dataset.k, [lo, hi] = LIM[k];
    P.cfg[k] = Math.max(lo, Math.min(hi, P.cfg[k] + +b.dataset.d));
    if (!P.running && P.left === P.total) P.total = P.left = P.cfg[P.mode] * 60;
    if (k === 'rounds') P.round = Math.min(P.round, P.cfg.rounds);
    pSaveSoon(); renderPomo();
  } else if (b.dataset.t) { const k = b.dataset.t; P.cfg[k] = !P.cfg[k]; if (k === 'sound' && P.cfg.sound) chime(); pSaveSoon(); renderPomo(); }
  else if (b.id === 'p-go') { if (P.running) pause(); else start(); }
  else if (b.id === 'p-reset') resetT();
  else if (b.id === 'p-skip') advance(false);
});
$('pomo').addEventListener('input', (e) => { if (e.target.classList.contains('p-task')) P.task = e.target.value; });
document.addEventListener('keydown', (e) => {
  if (S.view !== 'pomo' || e.code !== 'Space' || /INPUT|TEXTAREA|BUTTON|SELECT/.test(e.target.tagName)) return;
  e.preventDefault(); if (P.running) pause(); else start();
});
window.addEventListener('beforeunload', () => { if (P.save) { clearTimeout(P.save); api.saveData('Pomodoro.pomo.json', JSON.stringify({ cfg: P.cfg, stats: P.stats })); } });
$('btn-pomo').onclick = showPomo;


/* ---------- health ---------- */
/* health:data:start */
const HK = [
  { k: 'weight', name: 'Weight', color: '#22d3ee', dur: false },
  { k: 'cal', name: 'Calories', color: '#f59e0b', dur: false },
  { k: 'pro', name: 'Protein', color: '#d62bd0', dur: false },
  { k: 'card', name: 'Cardio', color: '#34d399', dur: true },
  { k: 'sleep', name: 'Sleep', color: '#8b5cf6', dur: true },
  { k: 'steps', name: 'Steps', color: '#fb7185', dur: false },
];
const HD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DK = ['weight', 'cal', 'pro', 'card', 'sleep'];
const OK = ['weight', 'cal', 'pro', 'card', 'steps', 'sleep'];
const DUR = new Set(['card', 'sleep']);
const H = { year: new Date().getFullYear(), w: [], meat: [], sel: 0, range: 'all', show: { weight: true, cal: true }, saveT: null, created: false, loaded: false, geo: null };
const mon = (n) => new Date(n * 864e5).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const dayLbl = (n) => `${mon(n)} ${new Date(n * 864e5).getUTCDate()}`;
const fmtDur = (m) => { if (m == null) return ''; m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
function parseDur(s) {
  s = String(s == null ? '' : s).trim().toLowerCase(); if (!s) return null; let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m?(?:in)?)?$/))) return Math.round(+m[1] * 60 + (+m[2] || 0));
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:ins?)?$/))) return Math.round(+m[1]);
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(+s);
  return null;
}
const parseNum = (s) => { const v = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
const rd = (k, s) => (DUR.has(k) ? parseDur(s) : parseNum(s));
const inStr = (k, v) => (v == null ? '' : DUR.has(k) ? fmtDur(v) : String(v));
const cell = (k, v, round) => (v == null ? '' : DUR.has(k) ? fmtDur(v) : k === 'weight' ? String(round ? Math.round(v * 10) / 10 : v) : String(round ? Math.round(v) : v));
const fmtVal = (k, v) => (v == null ? '' : DUR.has(k) ? fmtDur(v) : k === 'weight' ? v.toFixed(1) : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const pipe = (s) => String(s || '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avgOf = (a) => (a.length ? sum(a) / a.length : null);
const vals = (w, k) => w.days.map((d) => d[k]).filter((v) => v != null);

function genWeeks(year) {
  const j1 = dn(`${year}-01-01`), j31 = dn(`${year}-12-31`), s0 = j1 - ((j1 + 3) % 7), out = [];
  for (let s = s0, i = 1; s <= j31; s += 7, i++) {
    const ms = [...new Set(Array.from({ length: 7 }, (_, d) => mon(s + d)))];
    out.push({ n: i, start: s, months: ms.join(' · '), mid: mon(s + 3), days: Array.from({ length: 7 }, () => ({})), ov: {} });
  }
  return out;
}
function toMdH() {
  let o = `---\ntype: health\nyear: ${H.year}\n---\n# Health ${H.year}\n\nWeight in lb. Cardio and sleep are shown as hours and minutes. Weeks run Monday to Sunday, and week 1 is the week that contains 1 January.\n\n## Year overview\n| Week | Dates | Months | Weight | Calories | Protein | Cardio | Steps | Sleep |\n|---|---|---|---|---|---|---|---|---|\n`;
  H.w.forEach((w) => { o += `| ${w.n} | ${dayLbl(w.start)} – ${dayLbl(w.start + 6)} | ${w.months} | ${OK.map((k) => cell(k, w.ov[k])).join(' | ')} |\n`; });
  o += '\n## Meat schedule\n| Day | Meat | Notes |\n|---|---|---|\n';
  H.meat.forEach((m, i) => { o += `| ${HD[i]} | ${pipe(m.meat)} | ${pipe(m.notes)} |\n`; });
  const logged = H.w.filter((w) => w.days.some((d) => DK.some((k) => d[k] != null)));
  if (logged.length) {
    o += '\n## Daily logs\n';
    logged.forEach((w) => {
      o += `\n### Week ${w.n} · ${dayLbl(w.start)} – ${dayLbl(w.start + 6)}\n| Day | Weight | Calories | Protein | Cardio | Sleep |\n|---|---|---|---|---|---|\n`;
      w.days.forEach((d, i) => { o += `| ${HD[i]} | ${DK.map((k) => cell(k, d[k])).join(' | ')} |\n`; });
      o += `| **Average** | ${DK.map((k) => cell(k, avgOf(vals(w, k)), true)).join(' | ')} |\n`;
      o += `| **Total** | ${DK.map((k) => (k === 'weight' ? '' : cell(k, vals(w, k).length ? sum(vals(w, k)) : null))).join(' | ')} |\n`;
    });
  }
  return o;
}
function fromMdH(text) {
  let sec = '', wk = null;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, ''));
  for (const l of text.split(/\r?\n/)) {
    let m;
    if ((m = l.match(/^## (.+)/))) { sec = m[1].trim().toLowerCase(); wk = null; continue; }
    if ((m = l.match(/^### Week (\d+)/))) { wk = H.w.find((w) => w.n === +m[1]) || null; continue; }
    if (!l.startsWith('|')) continue;
    const c = cells(l);
    if (sec === 'year overview') { const w = H.w.find((x) => x.n === +c[0]); if (w) OK.forEach((k, i) => { w.ov[k] = rd(k, c[3 + i]); }); }
    else if (sec === 'meat schedule') { const i = HD.indexOf(c[0]); if (i >= 0) H.meat[i] = { meat: c[1] || '', notes: c[2] || '' }; }
    else if (sec === 'daily logs' && wk) { const i = HD.indexOf(c[0]); if (i >= 0) DK.forEach((k, j) => { wk.days[i][k] = rd(k, c[1 + j]); }); }
  }
}
/* health:data:end */

async function showHealth(year, force) {
  if (S.view === 'health' && year == null && !force) { render(); return; }
  if (H.saveT) await hSaveNow();
  await loadHealth(year == null ? (H.loaded ? H.year : new Date().getFullYear()) : year);
  setView('health'); renderHealth();
}
async function loadHealth(year) {
  H.year = year; H.w = genWeeks(year); H.meat = HD.map(() => ({ meat: '', notes: '' }));
  const text = await api.healthLoad(year); H.created = !!text; if (text) fromMdH(text);
  const t = todayN(), ci = H.w.findIndex((w) => t >= w.start && t <= w.start + 6);
  H.sel = ci >= 0 ? ci : 0; H.loaded = true;
}
function hSaveSoon() { clearTimeout(H.saveT); H.saveT = setTimeout(hSaveNow, 500); }
async function hSaveNow() { clearTimeout(H.saveT); H.saveT = null; await api.healthSave(H.year, toMdH()); if (!H.created) { H.created = true; refreshTree(); } }
window.addEventListener('beforeunload', () => { if (H.saveT) api.healthSave(H.year, toMdH()); });

const ovSeries = (k) => H.w.map((w) => (w.ov[k] == null ? null : w.ov[k]));
const hasData = (w) => OK.some((k) => w.ov[k] != null);
const lastIdx = () => { let L = -1; H.w.forEach((w, i) => { if (hasData(w)) L = i; }); return L; };
const lastN = (k, n) => ovSeries(k).filter((v) => v != null).slice(-n);

function renderHealth() {
  const el = $('health');
  el.innerHTML = `<div class="t-head"><div><h1>Health</h1><div class="t-sub" id="h-sub"></div></div>
    <div class="g-tools"><button data-h="prev">‹</button><b class="h-yr">${H.year}</b><button data-h="next">›</button></div></div>
    <div class="h-scroll"><div class="h-stats" id="h-stats"></div><div class="p-card" id="h-main"></div><div class="h-grid" id="h-minis"></div>
      <div class="h-cols"><div class="h-colL"><div class="p-card" id="h-daily"></div><div class="p-card" id="h-meat"></div></div><div class="p-card h-colR" id="h-year"></div></div></div>`;
  hCharts(); renderHDaily(); renderHMeat(); renderHYear();
}
function hCharts() {
  const n = H.w.filter(hasData).length;
  $('h-sub').textContent = `${H.year} · ${n} of ${H.w.length} weeks logged`;
  renderHStats(); renderHMain(); renderHMinis();
}

function spark(v, color) {
  if (v.length < 2) return '<svg class="h-spark" viewBox="0 0 120 34"></svg>';
  const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1, id = 'sg' + color.slice(1);
  const d = 'M' + v.map((x, i) => `${(4 + i * (112 / (v.length - 1))).toFixed(1)} ${(30 - ((x - mn) / r) * 26).toFixed(1)}`).join(' L');
  return `<svg class="h-spark" viewBox="0 0 120 34"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${d} L116 34 L4 34 Z" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function renderHStats() {
  $('h-stats').innerHTML = HK.filter((x) => x.k !== 'steps').map((x) => {
    const all = lastN(x.k, 99), recent = all.slice(-4); let big = '', sub = 'No data yet';
    if (all.length) {
      if (x.k === 'weight') { const d = all[all.length - 1] - all[0]; big = fmtVal('weight', all[all.length - 1]) + '<em>lb</em>'; sub = all.length > 1 ? `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)} lb since first entry` : 'First entry'; }
      else { big = fmtVal(x.k, avgOf(recent)) + (x.k === 'cal' ? '<em>kcal</em>' : x.k === 'pro' ? '<em>g</em>' : ''); sub = x.k === 'sleep' ? 'avg per night, last 4 weeks' : x.k === 'card' ? 'avg per week, last 4 weeks' : 'avg, last 4 weeks'; }
    }
    return `<div class="h-stat" style="--c:${x.color}"><small>${x.name}</small><b>${big || '–'}</b><small>${sub}</small>${spark(all.slice(-12), x.color)}</div>`;
  }).join('');
}

function visibleIdx() {
  const n = H.w.length, L = Math.max(lastIdx(), 0), first = H.w.findIndex(hasData);
  if (H.range === 'year') return [...Array(n).keys()];
  if (H.range === '12') { const len = Math.min(12, L + 1); return Array.from({ length: len }, (_, i) => L - len + 1 + i); }
  const a = first < 0 ? 0 : first, b = Math.min(n - 1, Math.max(L, a + 7));
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
function smooth(p) {
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}
function segments(pts, X, Y) {
  const out = []; let seg = [];
  pts.forEach((p) => { if (p) seg.push([X(p[0]), Y(p[1])]); else { if (seg.length) out.push(seg); seg = []; } });
  if (seg.length) out.push(seg);
  return out;
}
function chartSVG(idx, act) {
  const Wd = 900, Ht = 310, L = 60, R = 60, T = 16, Bm = 46, pw = Wd - L - R, ph = Ht - T - Bm, n = idx.length;
  const X = (j) => L + (n === 1 ? pw / 2 : (j / (n - 1)) * pw), bottom = T + ph;
  let defs = '', body = '', axes = '', grid = '';
  for (let g = 0; g <= 4; g++) { const y = T + (g / 4) * ph; grid += `<line x1="${L}" x2="${Wd - R}" y1="${y}" y2="${y}" class="h-grid-l"/>`; }
  const used = [];
  act.forEach((s) => {
    const pts = idx.map((i, j) => (H.w[i].ov[s.k] == null ? null : [j, H.w[i].ov[s.k]])), vs = pts.filter(Boolean).map((p) => p[1]);
    if (!vs.length) return;
    let mn = Math.min(...vs), mx = Math.max(...vs); const pad = (mx - mn || Math.abs(mx) * 0.1 || 1) * 0.14; mn -= pad; mx += pad;
    const Y = (v) => T + (1 - (v - mn) / (mx - mn)) * ph, first = used.length === 0;
    used.push({ s, pts, Y, mn, mx });
    defs += `<linearGradient id="ag-${s.k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".30"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
    segments(pts, X, Y).forEach((seg) => {
      if (seg.length > 1) {
        if (first) body += `<path d="${smooth(seg)} L${seg[seg.length - 1][0].toFixed(1)} ${bottom} L${seg[0][0].toFixed(1)} ${bottom} Z" fill="url(#ag-${s.k})"/>`;
        body += `<path d="${smooth(seg)}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linecap="round" style="filter:drop-shadow(0 0 5px ${s.color})"/>`;
      }
      if (n <= 30 || seg.length === 1) seg.forEach((p) => { body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${s.color}"/>`; });
    });
  });
  [[used[0], 'start', L - 10], [used[1], 'end', Wd - R + 10]].forEach(([u, anchor, x]) => {
    if (!u) return;
    for (let g = 0; g <= 4; g++) { const v = u.mn + (1 - g / 4) * (u.mx - u.mn); axes += `<text x="${x}" y="${T + (g / 4) * ph + 4}" text-anchor="${anchor === 'start' ? 'end' : 'start'}" fill="${u.s.color}" class="h-ax">${fmtVal(u.s.k, v)}</text>`; }
  });
  const step = n > 26 ? 4 : n > 12 ? 2 : 1; let xl = '';
  idx.forEach((i, j) => { if (j % step === 0) xl += `<text x="${X(j).toFixed(1)}" y="${Ht - 24}" text-anchor="middle" class="h-ax">W${H.w[i].n}</text><text x="${X(j).toFixed(1)}" y="${Ht - 9}" text-anchor="middle" class="h-ax dim">${H.w[i].mid}</text>`; });
  H.geo = { X, n, L, pw, Wd, used, top: T, bottom };
  return `<div class="h-chart"><svg viewBox="0 0 ${Wd} ${Ht}"><defs>${defs}</defs>${grid}${body}${axes}${xl}<line id="h-vl" y1="${T}" y2="${bottom}" class="h-vl" style="display:none"/>${used.map((u) => `<circle id="h-dot-${u.s.k}" r="5" fill="${u.s.color}" stroke="#0a0a0f" stroke-width="2" style="display:none"/>`).join('')}</svg><div class="h-tip"></div></div>`;
}
function bindHover(idx) {
  const box = $('h-main').querySelector('.h-chart'), svg = box.querySelector('svg'), tp = box.querySelector('.h-tip'), g = H.geo, vl = $('h-vl');
  box.onmousemove = (e) => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * (g.Wd / r.width);
    const j = g.n === 1 ? 0 : Math.max(0, Math.min(g.n - 1, Math.round(((x - g.L) / g.pw) * (g.n - 1)))), w = H.w[idx[j]], gx = g.X(j);
    vl.setAttribute('x1', gx); vl.setAttribute('x2', gx); vl.style.display = '';
    let rows = '';
    g.used.forEach((u) => {
      const dot = $('h-dot-' + u.s.k), v = u.pts[j] ? u.pts[j][1] : null;
      if (v == null) { dot.style.display = 'none'; return; }
      dot.setAttribute('cx', gx); dot.setAttribute('cy', u.Y(v)); dot.style.display = '';
      rows += `<div><i style="background:${u.s.color}"></i>${u.s.name} <b>${fmtVal(u.s.k, v)}</b></div>`;
    });
    tp.innerHTML = `<strong>Week ${w.n} · ${dayLbl(w.start)} – ${dayLbl(w.start + 6)}</strong>${rows || '<div class="dim">No data</div>'}`; tp.style.display = 'block';
    const px = (gx / g.Wd) * r.width; tp.style.left = (px > r.width - 230 ? px - tp.offsetWidth - 14 : px + 14) + 'px';
  };
  box.onmouseleave = () => { tp.style.display = 'none'; vl.style.display = 'none'; g.used.forEach((u) => { $('h-dot-' + u.s.k).style.display = 'none'; }); };
}
function renderHMain() {
  const idx = visibleIdx(), act = HK.filter((x) => H.show[x.k]), el = $('h-main');
  const chips = HK.map((x) => `<button class="h-chip${H.show[x.k] ? ' on' : ''}" data-h="tog" data-k="${x.k}" style="--c:${x.color}"><i></i>${x.name}</button>`).join('');
  const rng = [['all', 'All data'], ['12', 'Last 12 weeks'], ['year', 'Full year']].map(([v, l]) => `<button data-h="range" data-v="${v}" class="${H.range === v ? 'on' : ''}">${l}</button>`).join('');
  const has = act.some((x) => idx.some((i) => H.w[i].ov[x.k] != null));
  el.innerHTML = `<div class="h-ch"><h3>Trends</h3><div class="h-chips">${chips}</div><div class="seg">${rng}</div></div>` +
    (has ? chartSVG(idx, act) : `<div class="h-empty">${act.length ? 'Add weekly values in the year table below and your trends will show up here.' : 'Switch on at least one measure above.'}</div>`);
  if (has) bindHover(idx);
}

function bars(v, labels, color, fmt, line) {
  const w = 440, h = 170, L = 40, B = 24, T = 10, n = v.length, step = (w - L - 6) / Math.max(n, 1), bw = Math.max(3, Math.min(26, step * 0.6)), mx = Math.max(...v.filter((x) => x != null), 1), ph = h - T - B, id = 'bg' + color.slice(1);
  let s = `<svg viewBox="0 0 ${w} ${h}" class="h-svg"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".25"/></linearGradient></defs>`;
  for (let g = 0; g <= 2; g++) { const y = T + (g / 2) * ph; s += `<line x1="${L}" x2="${w - 4}" y1="${y}" y2="${y}" class="h-grid-l"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="h-ax">${fmt(mx * (1 - g / 2))}</text>`; }
  v.forEach((x, i) => {
    const cx = L + step * i + step / 2;
    if (x != null) { const bh = (x / mx) * ph; s += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(T + ph - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="url(#${id})" style="filter:drop-shadow(0 0 4px ${color}66)"><title>${labels[i]} · ${fmt(x)}</title></rect>`; }
    if (n <= 14 || i % Math.ceil(n / 12) === 0) s += `<text x="${cx.toFixed(1)}" y="${h - 7}" text-anchor="middle" class="h-ax">${labels[i]}</text>`;
  });
  if (line) {
    const lv = line.v.filter((x) => x != null);
    if (lv.length) {
      const mn = Math.min(...lv), hi = Math.max(...lv), r = hi - mn || 1, pts = line.v.map((x, i) => (x == null ? null : [i, x]));
      segments(pts, (i) => L + step * i + step / 2, (x) => T + 6 + (1 - (x - mn) / r) * (ph - 12)).forEach((seg) => {
        if (seg.length > 1) s += `<path d="${smooth(seg)}" fill="none" stroke="${line.color}" stroke-width="2" style="filter:drop-shadow(0 0 4px ${line.color})"/>`;
        seg.forEach((p) => { s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${line.color}"/>`; });
      });
    }
  }
  return s + '</svg>';
}
function renderHMinis() {
  const idx = visibleIdx().slice(-26), lab = idx.map((i) => 'W' + H.w[i].n), cur = H.w[H.sel], t = todayN();
  const wk = (k) => idx.map((i) => (H.w[i].ov[k] == null ? null : H.w[i].ov[k]));
  const dayV = (k) => cur.days.map((d) => (d[k] == null ? null : d[k]));
  const hrs = (m) => (m < 60 ? Math.round(m) + 'm' : (m / 60).toFixed(m % 60 ? 1 : 0) + 'h');
  const heat = H.w.map((w) => `<i class="h-cell${hasData(w) ? ' on' : ''}${t >= w.start && t <= w.start + 6 ? ' cur' : ''}" title="Week ${w.n} · ${dayLbl(w.start)} – ${dayLbl(w.start + 6)}${hasData(w) ? '' : ' · nothing logged'}"></i>`).join('');
  $('h-minis').innerHTML = `
    <div class="p-card"><div class="h-ch"><h3>Sleep per night</h3></div>${bars(wk('sleep'), lab, '#8b5cf6', hrs)}</div>
    <div class="p-card"><div class="h-ch"><h3>Cardio per week</h3></div>${bars(wk('card'), lab, '#34d399', hrs)}</div>
    <div class="p-card"><div class="h-ch"><h3>Week ${cur.n} · calories <small class="dim">with weight</small></h3></div>${bars(dayV('cal'), HD, '#f59e0b', (x) => String(Math.round(x)), { v: dayV('weight'), color: '#22d3ee' })}</div>
    <div class="p-card"><div class="h-ch"><h3>Weeks logged</h3></div><div class="h-heat">${heat}</div></div>`;
}

function renderHDaily() {
  const w = H.w[H.sel], el = $('h-daily');
  const rows = HD.map((d, i) => `<tr><td class="dn">${d}<small>${new Date((w.start + i) * 864e5).getUTCDate()}</small></td>${DK.map((k) => `<td><input class="h-in" data-s="d" data-r="${i}" data-c="${k}" value="${inStr(k, w.days[i][k])}" placeholder="–"></td>`).join('')}</tr>`).join('');
  el.innerHTML = `<div class="h-ch"><h3>Week log</h3><div class="h-wk"><button data-h="wprev">‹</button><span>Week ${w.n} · ${dayLbl(w.start)} – ${dayLbl(w.start + 6)}</span><button data-h="wnext">›</button></div></div>
    <table class="h-tbl"><thead><tr><th>Day</th><th>Weight</th><th>Calories</th><th>Protein</th><th>Cardio</th><th>Sleep</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td>Average</td>${DK.map((k) => `<td id="h-avg-${k}"></td>`).join('')}</tr><tr><td>Total</td>${DK.map((k) => `<td id="h-tot-${k}"></td>`).join('')}</tr></tfoot></table>
    <div class="h-actions"><button data-h="fill" title="Writes this week's average weight, calories, protein and sleep, and total cardio, into the year table">Copy to year table</button><span class="h-hint">Cardio and sleep accept 7h 30m, 7:30 or plain minutes.</span></div>`;
  hFoot();
}
function hFoot() {
  const w = H.w[H.sel];
  DK.forEach((k) => { const v = vals(w, k); $('h-avg-' + k).textContent = v.length ? cell(k, avgOf(v), true) : ''; $('h-tot-' + k).textContent = k === 'weight' || !v.length ? '' : cell(k, sum(v)); });
}
function renderHMeat() {
  $('h-meat').innerHTML = `<div class="h-ch"><h3>Meat schedule</h3></div><table class="h-tbl"><thead><tr><th>Day</th><th>Meat</th><th>Notes</th></tr></thead><tbody>${HD.map((d, i) => `<tr><td class="dn">${d}</td><td><input class="h-in" data-s="m" data-r="${i}" data-c="meat" value="${esc(H.meat[i].meat).replace(/"/g, '&quot;')}"></td><td><input class="h-in" data-s="m" data-r="${i}" data-c="notes" value="${esc(H.meat[i].notes).replace(/"/g, '&quot;')}"></td></tr>`).join('')}</tbody></table>`;
}
function renderHYear() {
  const t = todayN(), names = { weight: 'Weight', cal: 'Calories', pro: 'Protein', card: 'Cardio', steps: 'Steps', sleep: 'Sleep' };
  const rows = H.w.map((w, i) => `<tr data-wi="${i}" class="m${new Date((w.start + 3) * 864e5).getUTCMonth() % 2}${i === H.sel ? ' sel' : ''}${t >= w.start && t <= w.start + 6 ? ' now' : ''}"><td class="wk">${w.n}</td><td class="dt">${dayLbl(w.start)} – ${dayLbl(w.start + 6)}<small>${w.months}</small></td>${OK.map((k) => `<td><input class="h-in" data-s="o" data-r="${i}" data-c="${k}" value="${inStr(k, w.ov[k])}" placeholder="–"></td>`).join('')}</tr>`).join('');
  $('h-year').innerHTML = `<div class="h-ch"><h3>Year overview</h3><span class="h-hint">Typed in by hand. Nothing here is filled in for you.</span></div>
    <div class="h-yscroll"><table class="h-tbl h-ytbl"><thead><tr><th>Wk</th><th>Dates</th>${OK.map((k) => `<th>${names[k]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const sel = $('h-year').querySelector('tr.sel'); if (sel) sel.scrollIntoView({ block: 'center' });
}
function hSelect(i) {
  H.sel = Math.max(0, Math.min(H.w.length - 1, i));
  const y = $('h-year'); y.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel')); const row = y.querySelector(`tr[data-wi="${H.sel}"]`); if (row) row.classList.add('sel');
  renderHDaily(); renderHMinis();
}

const hEl = $('health');
hEl.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-wi]');
  if (tr && e.target.closest('td.wk, td.dt')) { hSelect(+tr.dataset.wi); return; }
  const b = e.target.closest('button'); if (!b || !b.dataset.h) return; const a = b.dataset.h;
  if (a === 'prev' || a === 'next') { if (H.saveT) await hSaveNow(); await loadHealth(H.year + (a === 'next' ? 1 : -1)); renderHealth(); }
  else if (a === 'tog') { H.show[b.dataset.k] = !H.show[b.dataset.k]; renderHMain(); }
  else if (a === 'range') { H.range = b.dataset.v; renderHMain(); renderHMinis(); }
  else if (a === 'wprev') hSelect(H.sel - 1);
  else if (a === 'wnext') hSelect(H.sel + 1);
  else if (a === 'fill') {
    const w = H.w[H.sel], f = {};
    ['weight', 'cal', 'pro', 'sleep'].forEach((k) => { const v = vals(w, k); if (v.length) f[k] = k === 'weight' ? Math.round(avgOf(v) * 10) / 10 : Math.round(avgOf(v)); });
    const c = vals(w, 'card'); if (c.length) f.card = sum(c);
    if (!Object.keys(f).length) return;
    if (Object.keys(f).some((k) => w.ov[k] != null) && !confirm(`Replace the values already in week ${w.n} of the year table?`)) return;
    Object.assign(w.ov, f);
    Object.keys(f).forEach((k) => { const i = hEl.querySelector(`input[data-s="o"][data-r="${H.sel}"][data-c="${k}"]`); if (i) i.value = inStr(k, f[k]); });
    hCharts(); hSaveSoon();
  }
});
hEl.addEventListener('change', (e) => {
  const i = e.target; if (!i.classList.contains('h-in')) return;
  const s = i.dataset.s, k = i.dataset.c, r = +i.dataset.r;
  if (s === 'm') { H.meat[r][k] = i.value.trim(); hSaveSoon(); return; }
  const raw = i.value.trim(), v = raw === '' ? null : rd(k, raw), tgt = s === 'd' ? H.w[H.sel].days[r] : H.w[r].ov;
  if (raw !== '' && v == null) { i.classList.add('bad'); i.value = inStr(k, tgt[k]); setTimeout(() => i.classList.remove('bad'), 900); return; }
  tgt[k] = v; i.value = inStr(k, v);
  if (s === 'd') { hFoot(); renderHMinis(); } else hCharts();
  hSaveSoon();
});
hEl.addEventListener('keydown', (e) => {
  const i = e.target; if (e.key !== 'Enter' || !i.classList || !i.classList.contains('h-in')) return;
  const nx = hEl.querySelector(`input[data-s="${i.dataset.s}"][data-c="${i.dataset.c}"][data-r="${+i.dataset.r + 1}"]`);
  i.blur(); if (nx) nx.focus();
});
$('btn-health').onclick = () => showHealth();
