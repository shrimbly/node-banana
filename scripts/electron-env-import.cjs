const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { _electron } = require('playwright-core');
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-env-acceptance-'));
  const profile = path.join(temp, 'profile');
  const envFile = path.join(temp, '.env.local');
  const source = 'GEMINI_API_KEY=synthetic-env-import-gemini\nOPENAI_API_KEY=do-not-overwrite\nCOMFY_API_KEY=synthetic-env-import-comfy\nCOMFY_MODE=remote\nCOMFY_REMOTE_URL=https://example.test\nDATABASE_PASSWORD=never-import-this\n';
  await fs.writeFile(envFile, source, { mode: 0o600 });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let app, child, page;
  async function launch() {
    app = await _electron.launch({ executablePath: path.resolve('dist-electron/mac-arm64/Node Banana.app/Contents/MacOS/Node Banana'), cwd: temp, timeout: 120000,
      env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir(), NODE_BANANA_ELECTRON_USER_DATA: profile, NODE_BANANA_ELECTRON_PORT: String(port) } });
    child = app.process();
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, envFile);
    page = await app.firstWindow({ timeout: 120000 });
    page.setDefaultTimeout(30000);
    await page.locator('.react-flow').waitFor();
  }
  try {
    await launch();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.evaluate(() => window.nodeBananaDesktop.credentials.write({ 'provider.openai': 'keep-existing-key' }));
    await page.getByRole('button', { name: 'Import from .env', exact: true }).click();
    await page.getByText('Imported 3 credential fields and saved securely. Kept 1 existing values.', { exact: true }).waitFor();
    const values = await page.evaluate(async () => ({ saved: await window.nodeBananaDesktop.credentials.read(), local: Object.values(localStorage) }));
    assert.equal(values.saved.value['provider.gemini'], 'synthetic-env-import-gemini');
    assert.equal(values.saved.value['provider.openai'], 'keep-existing-key');
    assert.equal(values.saved.value['comfy.remoteApiKey'], 'synthetic-env-import-comfy');
    assert.ok(!JSON.stringify(values.local).includes('synthetic-env-import'));
    assert.ok(!JSON.stringify(values).includes('never-import-this'));
    const fieldValues = await page.locator('input[type="password"]').evaluateAll(inputs => inputs.map(input => input.value));
    assert.ok(fieldValues.includes('synthetic-env-import-gemini'), 'Imported key not shown in renderer settings');
    const ciphertext = await fs.readFile(path.join(profile, 'credentials-v1.json'), 'utf8');
    assert.ok(!ciphertext.includes('synthetic-env-import'));
    assert.equal(await fs.readFile(envFile, 'utf8'), source);
    console.log('PASS: native .env import updates settings, encrypts keys, preserves existing keys/source and excludes unrelated variables');
    await page.getByRole('button', { name: 'Import from .env', exact: true }).click();
    await page.getByText('No new credentials found. Existing values were kept.', { exact: true }).waitFor();
    await app.evaluate(({ safeStorage }) => { global.__originalEncryption = safeStorage.isEncryptionAvailable; safeStorage.isEncryptionAvailable = () => false; });
    await page.getByRole('button', { name: 'Import from .env', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Secure storage is unavailable' }).waitFor();
    assert.equal(await fs.readFile(path.join(profile, 'credentials-v1.json'), 'utf8'), ciphertext);
    await app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = global.__originalEncryption; });
    await app.close(); child = undefined;
    await launch();
    const restored = await page.evaluate(() => window.nodeBananaDesktop.credentials.read());
    assert.equal(restored.value['provider.gemini'], 'synthetic-env-import-gemini');
    assert.equal(restored.value['provider.openai'], 'keep-existing-key');
    console.log('PASS: repeated import, encryption failure and app restart preserve credentials');
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    assert.equal((await page.evaluate(() => window.nodeBananaDesktop.credentials.importEnvironment())).value.cancelled, true);
    console.log('PASS: native picker cancellation is harmless');
    await app.close(); child = undefined;
    for (const filename of await fs.readdir(path.join(profile, 'logs'))) {
      if (filename.startsWith('desktop.log')) assert.ok(!(await fs.readFile(path.join(profile, 'logs', filename), 'utf8')).includes('synthetic-env-import'));
    }
    console.log('PASS: import secrets absent from diagnostics');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
