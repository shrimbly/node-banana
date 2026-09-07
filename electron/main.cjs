const { app, BrowserWindow, dialog, Menu, session, shell, utilityProcess } = require('electron');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dev = process.argv.includes('--dev');
const port = Number(process.env.NODE_BANANA_ELECTRON_PORT || 47831);
const token = randomBytes(32).toString('hex');
let backend;
let window;
let origin;
let quitting = false;

app.setName('Node Banana');
app.setPath('userData', process.env.NODE_BANANA_ELECTRON_USER_DATA || path.join(app.getPath('appData'), 'Node Banana'));

function fail(error) {
  if (quitting) return;
  console.error('[electron]', error);
  dialog.showErrorBox('Node Banana could not start', String(error.message || error));
  app.quit();
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(console.error);
}

function allowedPermission(contents, permission, requestingURL) {
  if (!contents || contents !== window?.webContents) return false;
  try {
    if (new URL(requestingURL).origin !== origin) return false;
  } catch {
    return false;
  }
  return ['clipboard-read', 'clipboard-sanitized-write', 'deprecated-sync-clipboard-read', 'fullscreen'].includes(permission);
}

async function createWindow() {
  window = new BrowserWindow({
    title: 'Node Banana',
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['Keep editing', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      message: 'Close without saving your workflow?',
    });
    if (choice === 1) event.preventDefault();
    else quitting = false;
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = undefined; });
  await window.loadURL(origin);
  console.log('[electron] Desktop window ready');
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The local server did not start within 120 seconds. Check the terminal for details.')), 120_000);
    backend = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
      cwd: root,
      serviceName: 'Node Banana Server',
      env: {
        ...process.env,
        NODE_ENV: dev ? 'development' : 'production',
        NODE_BANANA_ELECTRON: '1',
        NODE_BANANA_ELECTRON_PORT: String(port),
        NODE_BANANA_ELECTRON_TOKEN: token,
      },
    });
    backend.on('message', async (message) => {
      if (message.type === 'ready') {
        clearTimeout(timeout);
        resolve(message.origin);
      } else if (message.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(message.message));
      } else if (message.type === 'choose-directory') {
        try {
          const result = await dialog.showOpenDialog(window, {
            title: 'Select a folder to save workflows',
            properties: ['openDirectory', 'createDirectory'],
          });
          backend?.postMessage({ id: message.id, result: {
            success: true, cancelled: result.canceled, path: result.filePaths[0] || null,
          } });
        } catch (error) {
          backend?.postMessage({ id: message.id, result: { success: false, error: error.message } });
        }
      }
    });
    backend.on('exit', (code) => {
      clearTimeout(timeout);
      backend = undefined;
      if (!quitting) {
        const error = new Error(`The local server stopped (exit ${code}). Restart Node Banana; see the terminal for details.`);
        if (origin) fail(error);
        else reject(error);
      }
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('before-quit', () => { quitting = true; });
  // will-quit runs only after windows have accepted closing (including unsaved work).
  app.on('will-quit', () => { backend?.kill(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!window && origin) createWindow().catch(fail);
  });
  app.whenReady().then(async () => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('NODE_BANANA_ELECTRON_PORT must be a port number between 1 and 65535.');
    }
    origin = await startBackend();
    const localURLs = [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`];
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: localURLs }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Node-Banana-Desktop': token } });
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      return allowedPermission(contents, permission, requestingOrigin);
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(allowedPermission(contents, permission, details.requestingUrl));
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
    await createWindow();
  }).catch(fail);
}
