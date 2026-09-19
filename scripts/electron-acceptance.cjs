// Packaged acceptance uses a copied installation, empty environment and an
// isolated profile. Native dialogs are stubbed only through Playwright's main
// process debugger; the distributed app has no testing backdoor.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright-core');
const { checkWindowControls, checkStartupWindowControls } = require('./electron-smoke.cjs');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const supplied = process.argv.indexOf('--executable');
const executable = supplied >= 0 ? path.resolve(process.argv[supplied + 1]) : path.join(root, 'dist-electron/mac-arm64/Node Banana.app/Contents/MacOS/Node Banana');
const secret = 'node-banana-acceptance-secret-UNIQUE-73915';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
async function digestTree(directory) {
  const hash = createHash('sha256');
  async function walk(base) {
    for (const entry of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(base, entry.name);
      hash.update(path.relative(directory, file));
      assert.ok(!['test', 'tests', '__tests__', 'fixtures', 'coverage'].includes(entry.name), `Test artifacts in bundle: ${file}`);
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(file);
        assert.ok(!path.isAbsolute(target) && !path.relative(directory, path.resolve(base, target)).startsWith('..'), `Nonportable symlink: ${file}`);
        hash.update(target);
      } else if (entry.isDirectory()) await walk(file);
      else {
        assert.ok(!entry.name.startsWith('.env'), `Environment file in bundle: ${file}`);
        const bytes = await fs.readFile(file);
        assert.ok(!bytes.includes(Buffer.from(secret)), 'Test secret in installed bundle');
        hash.update(bytes);
      }
    }
  }
  await walk(directory); return hash.digest('hex');
}
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-installed-'));
  const installed = path.join(temp, 'Applications/Node Banana.app');
  const profile = path.join(temp, 'profile');
  const appSource = path.resolve(executable, '../../..');
  let desktop, page;
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const launch = async () => {
    const instance = await electron.launch({ executablePath: path.join(installed, 'Contents/MacOS/Node Banana'), args: [], cwd: temp,
      env: { ...env, NODE_BANANA_ELECTRON_PORT: String(port), NODE_BANANA_ELECTRON_USER_DATA: profile }, timeout: 120000 });
    await instance.evaluate(({ dialog }) => {
      global.__acceptanceDialogs = [];
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        global.__acceptanceDialogs.push(options);
        if (options.buttons?.includes('Retry')) {
          return new Promise(resolve => { global.__acceptanceRetry = resolve; });
        }
        return { response: options.buttons?.includes('Keep Editing') ? 2 : 0 };
      };
      dialog.showMessageBoxSync = (...args) => args.at(-1).buttons?.includes('Discard and close') ? 1 : 0;
    });
    return instance;
  };
  const attach = async instance => {
    const window = await instance.firstWindow({ timeout: 120000 });
    window.setDefaultTimeout(30000);
    window.on('dialog', dialog => dialog.accept().catch(() => {}));
    return window;
  };
  const checkpoint = async () => {
    try { return JSON.parse(JSON.parse(await fs.readFile(path.join(profile, 'recovery/checkpoint-v1.json'), 'utf8')).payload); }
    catch { return null; }
  };
  const crash = async () => {
    const process = desktop.process();
    process.kill('SIGKILL');
    await new Promise(resolve => process.once('exit', resolve));
    desktop = undefined;
    await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false; } catch { return true; } }, 'Backend survived its parent crash');
  };
  try {
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await run('ditto', [appSource, installed]);
    const before = await digestTree(installed);
    desktop = await launch();
    await until(() => desktop.evaluate(() => global.__acceptanceDialogs.some(d => d.message.includes('occupied'))), 'No actionable occupied-port dialog', 120000);
    const conflict = await desktop.evaluate(() => global.__acceptanceDialogs.at(-1));
    assert.deepEqual(conflict.buttons, ['Retry', 'Open Logs', 'Quit']);
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
    await new Promise(resolve => occupied.close(resolve));
    await desktop.evaluate(() => global.__acceptanceRetry({ response: 0 }));
    page = await attach(desktop);
    await page.locator('.react-flow').waitFor();
    console.log('PASS: copied installation starts independently; occupied port offers Retry/Open Logs/Quit and retries on the same origin');
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Escape');
    await checkWindowControls(desktop, page);
    const assets = await page.evaluate(async () => {
      const optimized = await fetch('/_next/image?url=%2Fbanana_icon.png&w=64&q=75');
      const status = await (await fetch('/api/env-status')).json();
      return { optimized: optimized.status, mime: optimized.headers.get('content-type'), status };
    });
    assert.equal(assets.optimized, 200);
    assert.ok(assets.mime.startsWith('image/'));
    assert.ok(!JSON.stringify(assets.status).includes(':true'), 'Developer provider environment reached the packaged backend');
    console.log('PASS: public assets and native sharp image processing work without provider environment variables');

    await page.evaluate(secret => {
      localStorage.setItem('node-banana-provider-settings', JSON.stringify({ providers: { gemini: { apiKey: secret, enabled: true } } }));
      localStorage.setItem('node-banana-comfy-settings', JSON.stringify({ mode: 'cloud', cloudApiKey: secret, remoteApiKey: secret, comfyOrgApiKey: secret }));
    }, secret);
    await page.reload();
    await page.getByRole('button', { name: 'Restore Session', exact: true }).click();
    await page.locator('.react-flow').waitFor();
    const migrated = await page.evaluate(async secret => ({ credentials: await window.nodeBananaDesktop.credentials.read(), plaintext: Object.values(localStorage).some(value => value.includes(secret)) }), secret);
    assert.equal(migrated.credentials.value['provider.gemini'], secret);
    assert.equal(migrated.plaintext, false);
    await page.evaluate(async () => {
      await window.nodeBananaDesktop.credentials.write({ 'provider.kie': 'updated-test-key' });
      await window.nodeBananaDesktop.credentials.delete('provider.kie');
    });
    const denied = await desktop.evaluate(async ({ BrowserWindow, app }) => {
      const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: `${app.getAppPath()}/electron/preload.cjs` } });
      try {
        await probe.loadURL('data:text/html,Bridge probe');
        return await probe.webContents.executeJavaScript('window.nodeBananaDesktop.credentials.read().then(() => false, () => true)');
      } finally { probe.destroy(); }
    });
    assert.equal(denied, true, 'An unrelated window was granted credential access');
    const credentialFile = path.join(profile, 'credentials-v1.json');
    const encrypted = await fs.readFile(credentialFile, 'utf8');
    assert.ok(!encrypted.includes(secret));
    await desktop.evaluate(({ safeStorage }) => { global.__encryptionAvailable = safeStorage.isEncryptionAvailable; safeStorage.isEncryptionAvailable = () => false; });
    const failure = await page.evaluate(() => window.nodeBananaDesktop.credentials.write({ 'provider.gemini': 'never-persist-plaintext' }));
    assert.equal(failure.ok, false);
    assert.equal(await fs.readFile(credentialFile, 'utf8'), encrypted);
    await desktop.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = global.__encryptionAvailable; });
    // Force provider error diagnostics with a synthetic key, exercising an actual outbound request.
    const provider = await page.evaluate(async () => {
      const key = (await window.nodeBananaDesktop.credentials.read()).value['provider.gemini'];
      const response = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gemini-API-Key': key }, body: JSON.stringify({ provider: 'google', model: 'gemini-2.5-flash', prompt: 'Reply with OK.', maxTokens: 16 }) });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(provider.body.success, false);
    assert.match(provider.body.error, /API_KEY_INVALID|API key not valid|invalid api key/i, 'Expected an actual provider authentication rejection, not a local or network failure');
    console.log('PASS: credentials migrate, encrypt, update/delete and preserve ciphertext on encryption failure; provider error path responds');

    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('Shift+P');
    await page.getByPlaceholder('Describe what to generate...').fill('Recovery first tab');
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('Shift+P');
    await page.getByPlaceholder('Describe what to generate...').fill('Recovery second tab');
    await until(async () => (await checkpoint())?.tabs.length === 2 && JSON.stringify(await checkpoint()).includes('Recovery second tab'), 'Two edited tabs were not checkpointed');
    // The close cancellation must leave both the window and recovery armed.
    await desktop.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBoxSync = () => 0; BrowserWindow.getAllWindows()[0].close(); });
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'recovery/session-v1.json'), 'utf8')).clean, false);
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = (...args) => args.at(-1).buttons?.includes('Discard and close') ? 1 : 0; });
    const pid = await desktop.evaluate(({ app }) => app.getAppMetrics().find(p => p.name === 'Node Banana Server').pid);
    process.kill(pid, 'SIGKILL');
    await page.getByText('Local server disconnected.', { exact: false }).waitFor();
    assert.equal(await page.getByPlaceholder('Describe what to generate...').inputValue(), 'Recovery second tab');
    await page.getByRole('button', { name: 'Restart Server', exact: true }).click();
    await until(() => page.evaluate(() => window.nodeBananaDesktop.backend.state()), 'Backend did not restart');
    assert.equal(await desktop.evaluate(({ app }) => app.getAppMetrics().filter(p => p.name === 'Node Banana Server').length), 1);
    assert.equal(await page.getByPlaceholder('Describe what to generate...').inputValue(), 'Recovery second tab');
    console.log('PASS: cancelled closure preserves recovery; backend crash/restart retains both tabs and starts one replacement');

    const seeded = await checkpoint();
    const imageBytes = [...await fs.readFile(path.join(root, 'public/banana_icon.png'))];
    const asset = await page.evaluate(async bytes => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const durable = await (await fetch(url)).blob();
      const result = await window.nodeBananaDesktop.recovery.putAsset({ bytes: new Uint8Array(await durable.arrayBuffer()), mime: durable.type });
      URL.revokeObjectURL(url);
      return result.value;
    }, imageBytes);
    const firstTab = seeded.tabs[0].snapshot;
    firstTab.incurredCost = 12.34;
    firstTab.canvasViewport = { x: 120, y: -90, zoom: 0.85 };
    firstTab.viewedCommentNodeIds = ['recovered-comment'];
    firstTab.nodes.push({ id: 'recovery-image', type: 'imageInput', position: { x: 400, y: 0 }, data: { image: asset, filename: 'recovered.png', dimensions: { width: 256, height: 256 } } });
    firstTab.nodes.push({ id: 'interrupted-generation', type: 'nanoBanana', position: { x: 800, y: 0 }, data: {
      inputImages: [], inputPrompt: null, outputImage: null, aspectRatio: '1:1', resolution: '1K', model: 'nano-banana-pro',
      selectedModel: { provider: 'gemini', modelId: 'nano-banana-pro', displayName: 'Nano Banana Pro' },
      useGoogleSearch: false, useImageSearch: false, status: 'loading', error: null, imageHistory: [], selectedHistoryIndex: 0,
    } });
    firstTab.edges.push({ id: 'recovered-edge', source: firstTab.nodes[0].id, sourceHandle: 'text', target: 'interrupted-generation', targetHandle: 'text' });
    assert.equal((await page.evaluate(value => window.nodeBananaDesktop.recovery.write(value), seeded)).ok, true);
    await crash();
    desktop = await launch(); page = await attach(desktop);
    await page.getByRole('button', { name: 'Restore Session', exact: true }).waitFor();
    await checkStartupWindowControls(desktop, page);
    const submissions = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(generate|llm)/.test(request.url())) submissions.push(request.url()); });
    await page.getByRole('button', { name: 'Restore Session', exact: true }).click();
    await page.locator('.react-flow').waitFor();
    assert.equal(await page.locator('.desktop-startup-drag-region').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('desktop-credential-error', { detail: 'Acceptance credential write failure' })));
    await page.getByRole('dialog', { name: 'Credential storage' }).waitFor();
    await checkStartupWindowControls(desktop, page);
    await page.getByRole('button', { name: 'Retry secure storage' }).click();
    await page.getByRole('dialog', { name: 'Credential storage' }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('tab').count(), 2);
    assert.equal(await page.getByPlaceholder('Describe what to generate...').inputValue(), 'Recovery second tab');
    await page.getByRole('tab').first().click();
    assert.equal(await page.getByPlaceholder('Describe what to generate...').inputValue(), 'Recovery first tab');
    await page.locator('[data-id="recovery-image"] img').waitFor();
    assert.equal(await page.locator('[data-id="recovery-image"] img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    await until(async () => (await checkpoint())?.tabs[0].snapshot.nodes.find(node => node.id === 'interrupted-generation')?.data.status === 'error', 'Interrupted node was not stopped');
    const restored = (await checkpoint()).tabs[0].snapshot;
    assert.equal(restored.incurredCost, 12.34);
    assert.equal(restored.edges.length, 1);
    assert.deepEqual(restored.viewedCommentNodeIds, ['recovered-comment']);
    assert.equal(submissions.length, 0);
    console.log('PASS: media assets, connections, incurred costs and stopped generation state recover without submissions');
    const reloadedKeys = await page.evaluate(() => window.nodeBananaDesktop.credentials.read());
    assert.equal(reloadedKeys.value['provider.gemini'], secret);
    assert.equal(reloadedKeys.value['provider.kie'], null);
    console.log('PASS: app crash restores multiple unsaved tabs in order and encrypted credentials survive restart');

    // Exercise renderer crash recovery without killing the healthy backend.
    await page.getByPlaceholder('Describe what to generate...').fill('Renderer recovery edit');
    await until(async () => JSON.stringify(await checkpoint()).includes('Renderer recovery edit'), 'Renderer edit not checkpointed');
    // Playwright permanently marks a crashed Page as unusable. Observe the
    // replacement renderer through Electron until recovery finishes, then
    // attach a fresh debugging session on the next launch.
    await desktop.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.once('did-finish-load', () => resolve(true));
      contents.forcefullyCrashRenderer();
    }));
    await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Restore Session')`
    )), 'Renderer did not offer recovery');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Restore Session').click()`
    ));
    await until(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('textarea')).some(input => input.value === 'Renderer recovery edit')`
    )), 'Renderer did not restore its checkpoint');
    console.log('PASS: renderer crash offers recovery and restores checkpointed edits');
    await crash(); desktop = await launch(); page = await attach(desktop);
    await page.getByRole('button', { name: 'Restore Session', exact: true }).click();
    await page.locator('.react-flow').waitFor();

    // A discarded tab must not return even if the next checkpoint has not landed.
    await page.getByRole('tab').first().hover();
    await page.getByRole('tab').first().getByRole('button', { name: /^Close /, includeHidden: true }).evaluate(button => button.click());
    await until(async () => await page.getByRole('tab').count() === 1, 'Tab did not close');
    await crash(); desktop = await launch(); page = await attach(desktop);
    await page.getByRole('button', { name: 'Restore Session', exact: true }).click();
    await page.locator('.react-flow').waitFor();
    assert.equal(await page.getByRole('tab').count(), 1);
    assert.equal(await page.getByPlaceholder('Describe what to generate...').inputValue(), 'Recovery second tab');
    await desktop.close(); desktop = undefined;
    desktop = await launch(); page = await attach(desktop); await page.locator('.react-flow').waitFor();
    assert.equal(await page.getByRole('tab').count(), 1);
    assert.equal(await page.locator('.react-flow__node').count(), 0);
    await desktop.close(); desktop = undefined;
    console.log('PASS: discarded tabs and explicitly discarded window edits never return');
    const after = await digestTree(installed);
    assert.equal(after, before, 'Installed app was modified');
    for (const filename of await fs.readdir(path.join(profile, 'logs'))) {
      if (!filename.startsWith('desktop.log') && !filename.startsWith('session-')) continue;
      assert.ok(!(await fs.readFile(path.join(profile, 'logs', filename), 'utf8')).includes(secret), 'Plaintext key in logs');
    }
    console.log('PASS: installed bundle stays byte-for-byte unchanged and logs contain no plaintext test keys');
    console.log('PASS: packaged acceptance complete');
  } finally {
    if (desktop) { desktop.process().kill('SIGKILL'); }
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    if (process.env.NODE_BANANA_KEEP_ACCEPTANCE === '1') console.log(`Acceptance files: ${temp}`);
    else await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
