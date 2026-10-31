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
  const dir = S.target || S.root; S.open.add(dir);
  const p = await api.createDir(dir); await refreshTree();
  const row = [...$('tree').children].find((r) => r.dataset.path === p);
  if (row) renameDir({ path: p, name: p.split(/[\\/]/).pop() }, row);
}
async function chooseVault() { const v = await api.chooseVault(); if (v) { S.tabs = []; S.active = null; S.target = null; S.open = new Set(); loadVault(v); } }
function loadVault(v) { S.root = v.root; S.tree = v.tree; $('vault-name').textContent = v.root; render(); }
function render() { renderTabs(); renderTree(); renderPane(); }

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
