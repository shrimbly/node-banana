const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, utilityProcess, safeStorage, screen } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecoveryStore } = require('./lib/recovery.cjs');
const { buildMenuTemplate } = require('./lib/menu.cjs');
const { importEnvironmentFile } = require('./lib/environment-import.cjs');
const { createCredentialStore } = require('./lib/credentials.cjs');
const { provisionRuntime } = require('./lib/runtime.cjs');
const { createDiagnostics, createRedactor } = require('./lib/diagnostics.cjs');
const { createBackend } = require('./lib/backend.cjs');
const { atomicWrite, atomicWriteAsync } = require('./lib/files.cjs');
const { visibleBounds } = require('./lib/window-state.cjs');
const { pickHostEnvironment } = require('./lib/env.cjs');
const { libraryEnv } = require('./lib/library.cjs');
const { createServerMessageHandler } = require('./lib/bridge-main.cjs');
const { UNLOAD_PROMPT } = require('./lib/unload-prompt.cjs');
const { createUpdates, createUnsupportedUpdates, createPreviewUpdater, readReleasesUrl } = require('./lib/updates.cjs');
let root = path.resolve(__dirname, '..');
let runtime, backend, window, credentialStore, recoveryStore, diagnostics, updates;
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
// app.getPath throws when the OS has no such folder (a bare Linux session).
function documentsDir() { try { return app.getPath('documents'); } catch { return undefined; } }
function openExternal(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(log); }
function allowedPermission(contents, permission, requestingURL) {
  if (!contents || contents !== window?.webContents) return false;
  try { if (new URL(requestingURL).origin !== origin) return false; } catch { return false; }
  return ['clipboard-read', 'clipboard-sanitized-write', 'deprecated-sync-clipboard-read', 'fullscreen'].includes(permission);
}
function sendStatus() { window?.webContents.send('desktop:backend-status', !!backend?.online()); }
function updateChanged(state) {
  window?.webContents.send('desktop:update-state', state);
  if (window || !state.manual) return;
  // Help → Check for Updates… with no window open: answer in a dialog instead.
  if (state.status === 'current') void message({ type: 'info', title: 'Node Banana', message: `Node Banana ${state.currentVersion} is up to date.` });
  else if (state.status === 'available') void message({ type: 'info', title: 'Node Banana', message: `Node Banana ${state.version} is available.`, detail: 'Open a window to download it, or view the release.', buttons: ['View Release', 'Later'], cancelId: 1 }).then(({ response }) => { if (response === 0 && state.url) openExternal(state.url); });
  else if (state.status === 'error') void message({ type: 'error', title: 'Node Banana', message: 'Could not check for updates.', detail: state.error });
}
function createUpdater() {
  const preview = process.env.NODE_BANANA_ELECTRON_PREVIEW_UPDATES;
  if (!app.isPackaged && preview) {
    // The notice, end to end, without a release: a pretend updater that
    // always finds the next version and "installs" it with a dialog.
    const updater = createPreviewUpdater({ currentVersion: app.getVersion(), fail: preview === 'fail',
      onInstall: version => void message({ type: 'info', title: 'Node Banana', message: `Preview update: Node Banana would restart into ${version} now.` }) });
    return createUpdates({ updater, userData: app.getPath('userData'), currentVersion: app.getVersion(), releasesUrl: 'https://github.com/shrimbly/node-banana/releases', log, onChange: updateChanged });
  }
  if (!app.isPackaged) return createUnsupportedUpdates(app.getVersion());
  try {
    // The app package has no dependencies of its own; electron-updater ships in
    // the bundled runtime's node_modules and is loaded from there.
    const { autoUpdater } = require(path.join(process.resourcesPath, 'runtime', 'node_modules', 'electron-updater'));
    return createUpdates({ updater: autoUpdater, userData: app.getPath('userData'), currentVersion: app.getVersion(), releasesUrl: readReleasesUrl(process.resourcesPath), log, onChange: updateChanged,
      // Test profiles never look for updates by themselves; Help → Check for Updates… still does.
      autoCheck: !process.env.NODE_BANANA_ELECTRON_USER_DATA });
  } catch (error) { log(error); return createUnsupportedUpdates(app.getVersion()); }
}
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
    // Both desktop platforms draw their own window controls over the tab strip.
    // Windows also hides the native menu bar (setMenuBarVisibility below, not
    // autoHideMenuBar, which would let a lone Alt press draw it over the
    // frameless window); the application menu stays installed so its
    // accelerators keep working.
    ...(process.platform === 'darwin' || process.platform === 'win32' ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  const current = window;
  let saveTimer;
  const boundsRecord = () => JSON.stringify({ version: 1, bounds: current.getNormalBounds(), maximized: current.isMaximized() });
  // While the window is being moved or resized the record is written off the
  // main thread and without fsync: losing it costs a window position, and a
  // synchronous write at every pause stalled the window on Windows. The one
  // on close is synchronous so it lands before the process quits.
  const saveBoundsSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (current.isDestroyed() || current.isFullScreen()) return;
      atomicWriteAsync(stateFile, boundsRecord(), { durable: false }).catch(log);
    }, 300);
  };
  const saveBounds = () => {
    clearTimeout(saveTimer);
    if (current.isDestroyed() || current.isFullScreen()) return;
    try { atomicWrite(stateFile, boundsRecord()); } catch (error) { log(error); }
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) current.on(event, saveBoundsSoon);
  current.on('close', saveBounds);
  if (saved?.maximized) current.maximize();
  // The renderer's maximise button swaps to a restore glyph from this state.
  const sendMaximized = () => { if (!current.isDestroyed()) current.webContents.send('desktop:window-maximized', current.isMaximized()); };
  for (const event of ['maximize', 'unmaximize']) current.on(event, sendMaximized);
  current.webContents.on('did-finish-load', sendMaximized);
  if (process.platform === 'win32') current.setMenuBarVisibility(false);
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
    const choice = dialog.showMessageBoxSync(current, { ...UNLOAD_PROMPT, buttons: [...UNLOAD_PROMPT.buttons] });
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
    ['recovery', ['read', 'write', 'assetChunk', 'readAsset', 'hydrate', 'discard'], () => recoveryStore],
    ['credentials', ['read', 'write', 'delete', 'reset'], () => credentialStore],
  ]) for (const operation of operations) ipcMain.handle(`desktop:${category}:${operation}`, async (event, value) => {
    if (!validCaller(event)) throw new Error('Unauthorized desktop request');
    try { return { ok: true, value: await getStore()[operation](value) }; }
    catch (error) {
      log(error);
      return category === 'credentials'
        ? { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) }
        : { ok: false, error: 'Recovery could not be read or saved. Check disk space and permissions, and save your workflows to disk.' };
    }
  });
  ipcMain.on('desktop:recovery:discardTab', (event, id) => {
    // Always reply, including rejection paths. This handler never calls back
    // into the renderer, which is waiting to finish closing its tab.
    if (!validCaller(event)) {
      event.returnValue = { ok: false, error: 'Unauthorized desktop request' };
      return;
    }
    try {
      const value = recoveryStore.discardTab(id);
      if (value?.warning) log(value.warning);
      event.returnValue = { ok: true, value };
    } catch (error) {
      log(error);
      event.returnValue = { ok: false, error: 'The tab could not close safely. Check disk space and permissions, then try again.' };
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
  for (const operation of ['state', 'check', 'download', 'install', 'skip', 'dismiss']) ipcMain.handle(`desktop:updates:${operation}`, event => {
    if (!validCaller(event)) throw new Error('Unauthorized desktop request');
    return operation === 'check' ? updates.check({ manual: true }) : updates[operation]();
  });
  ipcMain.on('desktop:window-action', (event, action) => {
    if (!validCaller(event)) return;
    switch (action) {
      case 'close': window.close(); break;
      case 'minimize': window.minimize(); break;
      case 'toggle-fullscreen': window.setFullScreen(!window.isFullScreen()); break;
      case 'toggle-maximize': if (window.isMaximized()) window.unmaximize(); else window.maximize(); break;
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
    updates = createUpdater();
    const serverMessage = createServerMessageHandler({ shell, dialog, fs, getWindow: () => window, log });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NODE_BANANA_ELECTRON_PORT must be a port number between 1 and 65535.');
    if (app.isPackaged) { runtime = await provisionRuntime(path.join(process.resourcesPath, 'runtime'), app.getPath('userData')); root = runtime.directory; }
    backend = createBackend({ fork: (...args) => utilityProcess.fork(...args),
      entry: app.isPackaged ? path.join(root, 'server.cjs') : path.join(__dirname, 'server.cjs'), diagnostics, onDisconnected: disconnected,
      options: () => ({ cwd: root, serviceName: 'Node Banana Server', stdio: 'pipe', env: {
        ...(app.isPackaged ? pickHostEnvironment() : process.env),
        NODE_ENV: dev ? 'development' : 'production', NODE_BANANA_ELECTRON: '1', NODE_BANANA_LOGS_DIR: app.getPath('logs'),
        NODE_BANANA_ELECTRON_PORT: String(port), NODE_BANANA_ELECTRON_TOKEN: token,
        // Where generations are saved (see lib/library.cjs). Only main knows the
        // Documents folder, and a test profile must never reach the real library.
        ...libraryEnv({ platform: process.platform, documentsDir: documentsDir(), homeDir: os.homedir(), userDataDir: app.getPath('userData'), processEnv: process.env }),
      } }),
      // The server's requests for native actions (lib/bridge-main.cjs). The
      // reply goes to the child that asked, which may have exited meanwhile.
      onMessage: async (message, child) => {
        const reply = await serverMessage(message);
        if (!reply) return;
        try { child.postMessage(reply); } catch (error) { log(error); }
      },
    });
    const localURLs = [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`];
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: localURLs }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Node-Banana-Desktop': token } });
    });
    session.defaultSession.setPermissionCheckHandler(allowedPermission);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedPermission(contents, permission, details.requestingUrl)));
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
      platform: process.platform,
      // File › Save: the page saves the workflow; Cmd/Ctrl+S works wherever focus is
      onSave: () => { if (window && !window.isDestroyed()) window.webContents.send('desktop:save-request'); },
      onCheckForUpdates: () => void updates.check({ manual: true }),
      onOpenLogs: openLogs,
      onRestartServer: () => void startWithRetry(),
      onRecoverEditor: () => { if (rendererCrashed && window) { rendererCrashed = false; window.reload(); } },
    })));
    if (await startWithRetry()) { await createWindow(); updates.start(); }
  }).catch(fail);
}
