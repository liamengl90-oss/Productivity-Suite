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
  if (!S.tabs.find((t) => t.path === path)) S.tabs.push({ path, name: baseName(path), text: await api.read(path), dirty: false });
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
function loadVault(v) { S.tasks = null; S.gantt = null; S.root = v.root; S.tree = v.tree; $('vault-name').textContent = v.root; render(); }
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

function setView(v) { S.view = v; document.body.classList.toggle('view-tasks', v === 'tasks'); document.body.classList.toggle('view-gantt', v === 'gantt'); $('btn-tasks').classList.toggle('on', v === 'tasks'); $('btn-gantt').classList.toggle('on', v === 'gantt'); tip.hidden = true; }
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
