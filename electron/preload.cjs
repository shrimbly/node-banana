const { contextBridge, ipcRenderer } = require('electron');

// Narrow capabilities on every desktop platform; never expose the IPC transport.
contextBridge.exposeInMainWorld('nodeBananaDesktop', {
  backend: {
    state: () => ipcRenderer.invoke('desktop:backend-state'),
    restart: () => ipcRenderer.invoke('desktop:restart-backend'),
    onStatus: (callback) => {
      const listener = (_event, online) => callback(online);
      ipcRenderer.on('desktop:backend-status', listener);
      return () => ipcRenderer.removeListener('desktop:backend-status', listener);
    },
  },
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  recovery: {
    read: () => ipcRenderer.invoke('desktop:recovery:read'),
    write: (value) => ipcRenderer.invoke('desktop:recovery:write', value),
    putAsset: async ({ bytes, mime }) => {
      if (!(bytes instanceof Uint8Array) || bytes.length > 256 * 1024 * 1024) return { ok: false, error: 'Recovery media is too large. Save your workflow to disk.' };
      let uploadId;
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < bytes.length || offset === 0; offset += chunkSize) {
        const result = await ipcRenderer.invoke('desktop:recovery:assetChunk', {
          uploadId, offset, bytes: bytes.slice(offset, offset + chunkSize), mime, done: offset + chunkSize >= bytes.length,
        });
        if (!result.ok) return result;
        if (result.value.asset) return { ok: true, value: result.value.asset };
        uploadId = result.value.uploadId;
      }
    },
    readAsset: (value) => ipcRenderer.invoke('desktop:recovery:readAsset', value),
    hydrate: (value) => ipcRenderer.invoke('desktop:recovery:hydrate', value),
    // Only the small discard marker is synchronous: the store must commit the
    // close in the same renderer turn as its busy check and durable discard.
    discardTab: (id) => ipcRenderer.sendSync('desktop:recovery:discardTab', id),
    discard: () => ipcRenderer.invoke('desktop:recovery:discard'),
  },
  credentials: {
    importEnvironment: () => ipcRenderer.invoke('desktop:credentials:import-environment'),
    read: () => ipcRenderer.invoke('desktop:credentials:read'),
    write: (value) => ipcRenderer.invoke('desktop:credentials:write', value),
    delete: (name) => ipcRenderer.invoke('desktop:credentials:delete', name),
    reset: () => ipcRenderer.invoke('desktop:credentials:reset'),
  },
});
// Platforms whose window controls are drawn by the renderer.
if (process.platform === 'darwin' || process.platform === 'win32') {
  contextBridge.exposeInMainWorld('nodeBananaWindow', {
    close: () => ipcRenderer.send('desktop:window-action', 'close'),
    minimize: () => ipcRenderer.send('desktop:window-action', 'minimize'),
    toggleFullscreen: () => ipcRenderer.send('desktop:window-action', 'toggle-fullscreen'),
    toggleMaximize: () => ipcRenderer.send('desktop:window-action', 'toggle-maximize'),
    onMaximized: (callback) => {
      const listener = (_event, maximized) => callback(maximized);
      ipcRenderer.on('desktop:window-maximized', listener);
      return () => ipcRenderer.removeListener('desktop:window-maximized', listener);
    },
  });
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktopPlatform = process.platform;
});
