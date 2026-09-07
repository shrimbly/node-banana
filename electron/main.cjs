const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, utilityProcess, safeStorage, screen } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRecoveryStore } = require('./lib/recovery.cjs');
const { importEnvironmentFile } = require('./lib/environment-import.cjs');
const { createCredentialStore } = require('./lib/credentials.cjs');
const { provisionRuntime } = require('./lib/runtime.cjs');
const { createDiagnostics, createRedactor } = require('./lib/diagnostics.cjs');
const { createBackend } = require('./lib/backend.cjs');
const { atomicWrite } = require('./lib/files.cjs');
const { visibleBounds } = require('./lib/window-state.cjs');
let root = path.resolve(__dirname, '..');
let runtime, backend, window, credentialStore, recoveryStore, diagnostics;
let quitting = false, rendererCrashed = false, starting;
const dev = !app.isPackaged && process.argv.includes('--dev');
const port = Number(process.env.NODE_BANANA_ELECTRON_PORT || 47831);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const redactor = createRedactor();
redactor.add([token]);

app.setName('Node Banana');
app.setPath('userData', process.env.NODE_BANANA_ELECTRON_USER_DATA || path.join(app.getPath('appData'), 'Node Banana'));
// Test profiles must not pollute the normal application's diagnostics.
app.setAppLogsPath(process.env.NODE_BANANA_ELECTRON_USER_DATA ? path.join(app.getPath('userData'), 'logs') : undefined);
function validCaller(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}
function log(error) { diagnostics?.write('main', error?.stack || error?.message || String(error)); }
async function openLogs() { await shell.openPath(app.getPath('logs')); }
function message(options) { return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options); }
async function fail(error) {
  if (quitting) return;
  log(error);
  const { response } = await message({ type: 'error', title: 'Node Banana could not start', message: redactor.redact(error.message || error), detail: 'Open the application logs for details.', buttons: ['Open Logs', 'Quit'], cancelId: 1 });
  if (response === 0) await openLogs();
  app.quit();
}
function openExternal(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(log); }
function allowedPermission(contents, permission, requestingURL) {
  if (!contents || contents !== window?.webContents) return false;
  try { if (new URL(requestingURL).origin !== origin) return false; } catch { return false; }
  return ['clipboard-read', 'clipboard-sanitized-write', 'deprecated-sync-clipboard-read', 'fullscreen'].includes(permission);
}
function sendStatus() { window?.webContents.send('desktop:backend-status', !!backend?.online()); }
async function startWithRetry() {
  if (starting) return starting;
  starting = (async () => {
    while (!quitting) {
      try {
        await backend.start();
        backend.post({ type: 'secrets', values: redactor.values() });
        await runtime?.markSuccessful();
        sendStatus();
        return true;
      } catch (error) {
        log(error); sendStatus();
        const occupied = error.code === 'EADDRINUSE';
        const { response } = await message({ type: 'error', title: 'Node Banana local server',
          message: occupied ? `Port ${port} is occupied by another process.` : 'The local server could not start.',
          detail: occupied ? 'Close the other app using this port, then choose Retry. Node Banana keeps the same address so your preferences remain available.' : redactor.redact(error.message),
          buttons: ['Retry', 'Open Logs', 'Quit'], defaultId: 0, cancelId: 2 });
        if (response === 1) { await openLogs(); continue; }
        if (response === 2) { app.quit(); return false; }
      }
    }
    return false;
  })().finally(() => { starting = undefined; });
  return starting;
}
async function disconnected(code) {
  sendStatus(); log(`Backend exited ${code}`);
  if (quitting || !window) return;
  const { response } = await message({ type: 'warning', title: 'Node Banana server stopped',
    message: 'The local server stopped. Your editor is still open.',
    detail: 'New executions are disabled. Restart the server to continue. Remote jobs may still be running; restarting does not resubmit requests.',
    buttons: ['Restart Server', 'Open Logs', 'Keep Editing'], defaultId: 0, cancelId: 2 });
  if (response === 0) await startWithRetry();
  if (response === 1) await openLogs();
}
async function createWindow() {
  if (window) return;
  rendererCrashed = false;
  const stateFile = path.join(app.getPath('userData'), 'window-v1.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const bounds = visibleBounds(saved?.bounds, screen.getAllDisplays(), screen.getPrimaryDisplay());
  window = new BrowserWindow({ title: 'Node Banana', ...bounds,
    minWidth: Math.min(900, bounds.width), minHeight: Math.min(600, bounds.height), backgroundColor: '#0f0f0f', show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  const current = window;
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    if (current.isDestroyed() || current.isFullScreen()) return;
    try { atomicWrite(stateFile, JSON.stringify({ version: 1, bounds: current.getNormalBounds(), maximized: current.isMaximized() })); } catch (error) { log(error); }
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) current.on(event, () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 300); });
  current.on('close', saveBounds);
  if (saved?.maximized) current.maximize();
  if (process.platform === 'darwin') {
    current.setWindowButtonVisibility(false);
    current.on('enter-full-screen', () => current.setWindowButtonVisibility(false));
    current.on('leave-full-screen', () => current.setWindowButtonVisibility(false));
  }
  current.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  current.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === origin) return; } catch {}
    event.preventDefault(); openExternal(url);
  });
  current.webContents.on('will-attach-webview', event => event.preventDefault());
  current.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(current, { type: 'question', buttons: ['Keep editing', 'Discard and close'], defaultId: 0, cancelId: 0, message: 'Close without saving your workflows?' });
    if (choice === 1) {
      try { recoveryStore.markClean(true); event.preventDefault(); } catch (error) { log(error); quitting = false; }
    } else quitting = false;
  });
  current.webContents.on('render-process-gone', async (_event, details) => {
    rendererCrashed = true;
    log(`Renderer stopped: ${details.reason}`);
    if (quitting) return;
    const { response } = await message({ type: 'error', title: 'Node Banana editor stopped', message: 'The editor stopped unexpectedly.', detail: 'Recover the editor to restore the latest checkpoint. Remote jobs are not resubmitted.', buttons: ['Recover Editor', 'Open Logs', 'Quit'], cancelId: 2 });
    if (response === 1) { await openLogs(); return; }
    if (response === 2) { app.quit(); return; }
    if (!backend.online() && !await startWithRetry()) return;
    rendererCrashed = false;
    current.reload();
  });
  current.once('ready-to-show', () => current.show());
  current.webContents.on('did-finish-load', sendStatus);
  current.on('closed', () => {
    clearTimeout(saveTimer);
    if (!rendererCrashed) { try { recoveryStore.markClean(); } catch (error) { log(error); } }
    window = undefined;
  });
  await current.loadURL(origin);
  log('Desktop window ready');
}
function registerBridge() {
  for (const [category, operations, getStore] of [
    ['recovery', ['read', 'write', 'assetChunk', 'readAsset', 'hydrate', 'discardTab', 'discard'], () => recoveryStore],
    ['credentials', ['read', 'write', 'delete'], () => credentialStore],
  ]) for (const operation of operations) ipcMain.handle(`desktop:${category}:${operation}`, (event, value) => {
    if (!validCaller(event)) throw new Error('Unauthorized desktop request');
    try { return { ok: true, value: getStore()[operation](value) }; }
    catch (error) {
      log(error);
      return { ok: false, error: category === 'credentials' ? error.message : 'Recovery could not be read or saved. Check disk space and permissions, and save your workflows to disk.' };
    }
  });
  let importingEnvironment = false;
  ipcMain.handle('desktop:credentials:import-environment', async event => {
    if (!validCaller(event)) throw new Error('Unauthorized desktop request');
    if (importingEnvironment) return { ok: false, error: 'An environment import is already open.' };
    importingEnvironment = true;
    try {
      const selected = await dialog.showOpenDialog(window, { title: 'Import provider settings from .env', buttonLabel: 'Import', properties: ['openFile', 'showHiddenFiles'] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: { cancelled: true } };
      if (!validCaller(event)) throw new Error('The editor changed while choosing a file. Try importing again.');
      return { ok: true, value: importEnvironmentFile(selected.filePaths[0], credentialStore) };
    } catch (error) {
      // Parser/file errors must never echo the file's contents into diagnostics.
      return { ok: false, error: error.message || 'Environment settings could not be imported securely.' };
    } finally { importingEnvironment = false; }
  });
  ipcMain.handle('desktop:backend-state', event => { if (!validCaller(event)) throw new Error('Unauthorized desktop request'); return backend.online(); });
  ipcMain.handle('desktop:restart-backend', event => { if (!validCaller(event)) throw new Error('Unauthorized desktop request'); return startWithRetry(); });
  ipcMain.handle('desktop:open-logs', event => { if (!validCaller(event)) throw new Error('Unauthorized desktop request'); return openLogs(); });
  ipcMain.on('desktop:window-action', (event, action) => {
    if (!validCaller(event)) return;
    switch (action) {
      case 'close': window.close(); break;
      case 'minimize': window.minimize(); break;
      case 'toggle-fullscreen': window.setFullScreen(!window.isFullScreen()); break;
      case 'toggle-maximize': window.isMaximized() ? window.unmaximize() : window.maximize(); break;
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  registerBridge();
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => backend?.kill());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!window && backend?.online()) createWindow().catch(fail); });
  process.on('uncaughtException', error => { void fail(error); });
  process.on('unhandledRejection', log);
  app.whenReady().then(async () => {
    diagnostics = createDiagnostics(app.getPath('logs'), redactor);
    credentialStore = createCredentialStore(app.getPath('userData'), safeStorage, values => {
      redactor.add(values); backend?.post({ type: 'secrets', values });
    });
    recoveryStore = createRecoveryStore(app.getPath('userData'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NODE_BANANA_ELECTRON_PORT must be a port number between 1 and 65535.');
    if (app.isPackaged) { runtime = await provisionRuntime(path.join(process.resourcesPath, 'runtime'), app.getPath('userData')); root = runtime.directory; }
    backend = createBackend({ fork: (...args) => utilityProcess.fork(...args),
      entry: app.isPackaged ? path.join(root, 'server.cjs') : path.join(__dirname, 'server.cjs'), diagnostics, onDisconnected: disconnected,
      options: () => ({ cwd: root, serviceName: 'Node Banana Server', stdio: 'pipe', env: {
        ...(app.isPackaged ? Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]])) : process.env),
        NODE_ENV: dev ? 'development' : 'production', NODE_BANANA_ELECTRON: '1', NODE_BANANA_LOGS_DIR: app.getPath('logs'),
        NODE_BANANA_ELECTRON_PORT: String(port), NODE_BANANA_ELECTRON_TOKEN: token,
      } }),
      onMessage: async (message, child) => {
        if (message.type !== 'choose-directory') return;
        try {
          const result = await dialog.showOpenDialog(window, { title: 'Select a folder to save workflows', properties: ['openDirectory', 'createDirectory'] });
          child.postMessage({ id: message.id, result: { success: true, cancelled: result.canceled, path: result.filePaths[0] || null } });
        } catch { child.postMessage({ id: message.id, result: { success: false, error: 'The folder picker could not open.' } }); }
      },
    });
    const localURLs = [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`];
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: localURLs }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Node-Banana-Desktop': token } });
    });
    session.defaultSession.setPermissionCheckHandler(allowedPermission);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedPermission(contents, permission, details.requestingUrl)));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      { label: 'Help', submenu: [{ label: 'Open Logs', click: openLogs }, { label: 'Restart Local Server', click: () => void startWithRetry() }, { label: 'Recover Editor', click: () => { if (rendererCrashed && window) { rendererCrashed = false; window.reload(); } } }] },
    ]));
    if (await startWithRetry()) await createWindow();
  }).catch(fail);
}
