const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const production = process.argv.includes('--production');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'node-banana-electron-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let desktop;
  const launch = async () => {
    const instance = await electron.launch({
      args: [root, ...(production ? [] : ['--dev'])],
      cwd: root,
      env: { ...process.env, NODE_BANANA_ELECTRON_PORT: String(port), NODE_BANANA_ELECTRON_USER_DATA: path.join(temp, 'profile') },
      timeout: 120_000,
    });
    // Only the isolated smoke-test process has native dialogs stubbed.
    await instance.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
      dialog.showErrorBox = (title, content) => { console.error(title, content); };
    });
    return instance;
  };
  try {
    desktop = await launch();
    const page = await desktop.firstWindow({ timeout: 120_000 });
    // Electron's native close confirmation can close the CDP session before
    // Playwright acknowledges the underlying beforeunload dialog.
    page.on('dialog', (dialog) => { dialog.accept().catch(() => {}); });
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.react-flow').waitFor();
    assert.equal(new URL(page.url()).origin, origin);
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), {
      require: 'undefined', process: 'undefined',
    });
    console.log('PASS: Electron renders the editor in a sandboxed window');

    if (!production) {
      const hmrMessage = await page.evaluate(() => new Promise((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/_next/webpack-hmr`);
        const timeout = setTimeout(() => { socket.close(); reject(new Error('No HMR response')); }, 10_000);
        socket.onmessage = ({ data }) => { clearTimeout(timeout); socket.close(); resolve(data); };
        socket.onerror = () => { clearTimeout(timeout); socket.close(); reject(new Error('HMR connection failed')); };
      }));
      assert.ok(hmrMessage);
      console.log('PASS: the development hot-reload WebSocket connects');
    }

    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 100 } });
    const initialNodes = await page.locator('.react-flow__node').count();
    await page.keyboard.press('Shift+P');
    const prompt = page.getByPlaceholder('Describe what to generate...').last();
    await prompt.fill('Electron smoke test prompt');
    assert.equal(await page.locator('.react-flow__node').count(), initialNodes + 1);
    console.log('PASS: keyboard shortcut adds a node and its prompt is editable');
    const clipboardPermission = await page.evaluate(async () => {
      return (await navigator.permissions.query({ name: 'clipboard-read' })).state;
    });
    assert.equal(clipboardPermission, 'granted');
    console.log('PASS: clipboard access is available to the editor');

    const directory = path.join(temp, 'workflow');
    await fs.mkdir(directory);
    await desktop.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, directory);
    const folder = await page.evaluate(async () => (await fetch('/api/browse-directory')).json());
    assert.equal(folder.path, directory);
    assert.equal(folder.success, true);
    await desktop.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/browse-directory')).json()).cancelled), true);
    console.log('PASS: native folder picker bridge handles selection and cancellation');

    const workflow = {
      version: 1,
      nodes: [{ id: 'desktop-prompt', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: await prompt.inputValue() } }],
      edges: [],
    };
    const result = await page.evaluate(async ({ directory, workflow }) => {
      const saved = await (await fetch('/api/workflow', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directoryPath: directory, filename: 'desktop-smoke', workflow }),
      })).json();
      const loaded = await (await fetch(`/api/workflow?path=${encodeURIComponent(directory)}&load=true`)).json();
      const envStatus = await fetch('/api/env-status');
      return { saved, loaded, envStatus: envStatus.status };
    }, { directory, workflow });
    assert.equal(result.saved.success, true, JSON.stringify(result.saved));
    assert.deepEqual(result.loaded.workflow, workflow);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'desktop-smoke.json'), 'utf8')), workflow);
    assert.equal(result.envStatus, 200);
    assert.equal((await fetch(`${origin}/api/env-status`)).status, 403);
    console.log('PASS: local APIs save/load a workflow; requests outside Electron are rejected');

    await page.evaluate(() => localStorage.setItem('node-banana-electron-smoke', 'persisted'));
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click({ clickCount: 5, delay: 100 });
    await fs.mkdir(path.join(root, '.scratch'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.scratch', `electron-${production ? 'production' : 'dev'}.png`) });
    assert.deepEqual(errors, [], 'Renderer errors');
    await desktop.close();
    desktop = undefined;
    await assert.rejects(fetch(origin), 'The desktop server should stop when Electron quits');
    console.log('PASS: quitting Electron stops its server');

    desktop = await launch();
    const reopened = await desktop.firstWindow({ timeout: 120_000 });
    await reopened.locator('.react-flow').waitFor({ timeout: 60_000 });
    assert.equal(await reopened.evaluate(() => localStorage.getItem('node-banana-electron-smoke')), 'persisted');
    assert.equal(await reopened.evaluate(() => localStorage.getItem('node-banana-ftux-completed')), 'true');
    console.log('PASS: desktop settings survive a full restart');
  } finally {
    if (desktop) await desktop.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
