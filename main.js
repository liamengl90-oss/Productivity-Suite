const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let win, root;
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const writeCfg = (c) => fs.writeFileSync(cfgFile(), JSON.stringify(c));
const inside = (p) => { const r = path.resolve(p); return r === root || r.startsWith(root + path.sep); };

function scan(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push({ type: 'dir', name: e.name, path: p, children: scan(p) });
    else if (e.name.toLowerCase().endsWith('.md')) out.push({ type: 'file', name: e.name.slice(0, -3), path: p });
  }
  return out.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

function openVault(dir) {
  root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.readdirSync(root).some((f) => f.endsWith('.md'))) {
    fs.writeFileSync(path.join(root, 'Welcome.md'),
      '# Welcome to Signal Path\n\nYour notes are plain markdown files in this folder.\n\n- [ ] Click a checkbox in preview mode\n- [ ] Press Ctrl+N for a new note\n- [x] Open the app\n');
  }
  writeCfg({ ...readCfg(), vault: root });
  return { root, tree: scan(root) };
}

ipcMain.handle('vault:open', () => openVault(readCfg().vault || path.join(app.getPath('documents'), 'Signal Path')));
ipcMain.handle('vault:choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : openVault(r.filePaths[0]);
});
ipcMain.handle('vault:tree', () => scan(root));
ipcMain.handle('note:read', (_, p) => (inside(p) ? fs.readFileSync(p, 'utf8') : ''));
ipcMain.handle('note:write', (_, p, text) => { if (inside(p)) fs.writeFileSync(p, text); });
ipcMain.handle('note:create', (_, dir) => {
  const d = dir && inside(dir) ? dir : root;
  let n = 1, p;
  do { p = path.join(d, n === 1 ? 'Untitled.md' : `Untitled ${n}.md`); n++; } while (fs.existsSync(p));
  fs.writeFileSync(p, '');
  return p;
});
const rename = (p, name, ext) => {
  const clean = name.replace(/[\\/:*?"<>|]/g, '').trim();
  if (!clean || !inside(p)) return p;
  const np = path.join(path.dirname(p), clean + ext);
  if (np === p || fs.existsSync(np)) return p;
  fs.renameSync(p, np);
  return np;
};
ipcMain.handle('note:rename', (_, p, name) => rename(p, name, '.md'));
ipcMain.handle('dir:rename', (_, p, name) => rename(p, name, ''));
ipcMain.handle('dir:create', (_, parent) => {
  const d = parent && inside(parent) ? parent : root;
  let n = 1, p;
  do { p = path.join(d, n === 1 ? 'New folder' : `New folder ${n}`); n++; } while (fs.existsSync(p));
  fs.mkdirSync(p);
  return p;
});
ipcMain.handle('fs:move', (_, src, destDir) => {
  if (!inside(src) || !inside(destDir)) return src;
  const s = path.resolve(src), d = path.resolve(destDir);
  if (s === root || d === s || d.startsWith(s + path.sep) || path.dirname(s) === d) return src;
  const np = path.join(d, path.basename(s));
  if (fs.existsSync(np)) return src;
  fs.renameSync(s, np);
  return np;
});
ipcMain.handle('fs:trash', async (_, p) => { if (inside(p) && path.resolve(p) !== root) await shell.trashItem(path.resolve(p)); });

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 720, minHeight: 460,
    backgroundColor: '#0c0d12', autoHideMenuBar: true, title: 'Signal Path',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
