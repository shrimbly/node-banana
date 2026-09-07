const { contextBridge, ipcRenderer } = require('electron');

// Narrow capabilities on every desktop platform; never expose the IPC transport.
contextBridge.exposeInMainWorld('nodeBananaDesktop', {
  recovery: {
    read: () => ipcRenderer.invoke('desktop:recovery:read'),
    write: (value) => ipcRenderer.invoke('desktop:recovery:write', value),
    putAsset: (value) => ipcRenderer.invoke('desktop:recovery:putAsset', value),
    hydrate: (value) => ipcRenderer.invoke('desktop:recovery:hydrate', value),
    discardTab: (id) => ipcRenderer.invoke('desktop:recovery:discardTab', id),
    discard: () => ipcRenderer.invoke('desktop:recovery:discard'),
  },
  credentials: {
    read: () => ipcRenderer.invoke('desktop:credentials:read'),
    write: (value) => ipcRenderer.invoke('desktop:credentials:write', value),
    delete: (name) => ipcRenderer.invoke('desktop:credentials:delete', name),
  },
});
if (process.platform === 'darwin') {
  contextBridge.exposeInMainWorld('nodeBananaWindow', {
    close: () => ipcRenderer.send('desktop:window-action', 'close'),
    minimize: () => ipcRenderer.send('desktop:window-action', 'minimize'),
    toggleFullscreen: () => ipcRenderer.send('desktop:window-action', 'toggle-fullscreen'),
    toggleMaximize: () => ipcRenderer.send('desktop:window-action', 'toggle-maximize'),
  });
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktopPlatform = process.platform;
});
