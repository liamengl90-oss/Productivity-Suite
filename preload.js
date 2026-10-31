const { contextBridge, ipcRenderer } = require('electron');
const call = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('api', {
  openVault: call('vault:open'), chooseVault: call('vault:choose'), tree: call('vault:tree'),
  read: call('note:read'), write: call('note:write'), create: call('note:create'), rename: call('note:rename'),
});
