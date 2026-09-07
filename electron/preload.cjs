const { contextBridge, ipcRenderer } = require('electron');

// Expose only window actions, never the IPC transport or Node APIs.
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
