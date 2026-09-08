// Regression for media-heavy workflows: real loading, checkpointing and crash
// recovery in a disposable profile. No provider requests or workflow writes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright-core');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
async function until(check, message, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(250); }
  throw new Error(message);
}
async function main() {
  const workflowFile = option('--workflow');
  if (!workflowFile) throw new Error('Pass --workflow /absolute/path/to/workflow.json');
  const contents = await fs.readFile(workflowFile);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const before = digest(contents);
  const workflow = JSON.parse(contents);
  workflow.directoryPath = path.dirname(path.resolve(workflowFile));
  const expectedNodes = workflow.nodes.length;
  const executable = path.resolve(option('--executable') || 'dist-electron/mac-arm64/Node Banana.app/Contents/MacOS/Node Banana');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-large-workflow-'));
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  let app, child, page;
  const submissions = [];
  const read = async () => {
    try { return JSON.parse(JSON.parse(await fs.readFile(path.join(profile, 'recovery/checkpoint-v1.json'), 'utf8')).payload); }
    catch { return null; }
  };
  const attach = async () => {
    app = await _electron.launch({ executablePath: executable, cwd: os.tmpdir(), timeout: 120000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir(), NODE_BANANA_ELECTRON_USER_DATA: profile, NODE_BANANA_ELECTRON_PORT: String(port) } });
    child = app.process();
    child.stderr.on('data', data => { if (/OOM|FATAL|heap out of memory/i.test(String(data))) process.stderr.write(data); });
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
    page = await app.firstWindow({ timeout: 120000 });
    page.setDefaultTimeout(90000);
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/api/**', route => {
      const request = route.request();
      if (request.method() === 'POST' && !request.url().includes('/api/load-generation')) {
        if (/\/api\/(generate|llm)/.test(request.url())) submissions.push(request.url());
        return route.abort();
      }
      return route.continue();
    });
  };
  const crash = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
    }
    child = undefined;
    await until(async () => { try { await fetch(`http://127.0.0.1:${port}`); return false; } catch { return true; } }, 'Backend survived app exit');
  };
  try {
    const fixture = path.join(profile, 'workflow-fixture.json');
    await fs.writeFile(fixture, JSON.stringify(workflow));
    await attach();
    await page.locator('.react-flow').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Escape');
    // Supply the file by path so embedded media never travels through CDP's
    // size-limited JSON transport. Exercise the same File/drop path as the UI.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.id = 'large-workflow-fixture'; input.hidden = true;
      document.body.appendChild(input);
    });
    await page.locator('#large-workflow-fixture').setInputFiles(fixture);
    await page.evaluate(() => {
      const input = document.querySelector('#large-workflow-fixture');
      const transfer = new DataTransfer();
      transfer.items.add(input.files[0]);
      document.querySelector('.react-flow').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 400, clientY: 300 }));
      input.remove();
    });
    try {
      await until(async () => (await read())?.tabs[0]?.snapshot.nodes.length === expectedNodes, 'Loaded workflow did not checkpoint');
    } catch (error) {
      console.error('Load diagnostics:', {
        expectedNodes,
        renderedNodes: await page.locator('.react-flow__node').count(),
        checkpointNodes: (await read())?.tabs.map(tab => tab.snapshot.nodes.length),
        recoveryNotice: await page.locator('[role="status"]').allTextContents(),
      });
      throw error;
    }
    const checkpoint = await read();
    assert.ok(JSON.stringify(checkpoint).includes('$recoveryAsset'), 'Fixture must contain recoverable media');
    assert.ok(!JSON.stringify(checkpoint).includes('data:video/'), 'Video payload leaked into checkpoint');
    const media = await fs.readdir(path.join(profile, 'recovery/assets'));
    const mediaSizes = await Promise.all(media.filter(name => !name.endsWith('.tmp')).map(async name => (await fs.stat(path.join(profile, 'recovery/assets', name))).size));
    const checkpointBytes = (await fs.stat(path.join(profile, 'recovery/checkpoint-v1.json'))).size;
    console.log(`PASS: ${expectedNodes} nodes loaded; checkpoint ${checkpointBytes} bytes; ${mediaSizes.length} assets, ${mediaSizes.reduce((a, b) => a + b, 0)} bytes`);
    const prompt = page.getByPlaceholder('Describe what to generate...').first();
    await prompt.fill('Large workflow recovery regression');
    await until(async () => JSON.stringify(await read()).includes('Large workflow recovery regression'), 'Edit did not checkpoint');
    await delay(10000);
    assert.equal(await page.locator('.react-flow__node').count(), expectedNodes);
    console.log('PASS: editor stays responsive through subsequent checkpoints');
    await crash();
    await attach();
    await page.getByRole('button', { name: 'Restore Session', exact: true }).click();
    await until(async () => await page.locator('.react-flow__node').count() === expectedNodes, 'Recovery did not restore all nodes');
    assert.equal(await page.getByPlaceholder('Describe what to generate...').first().inputValue(), 'Large workflow recovery regression');
    await until(async () => (await read())?.savedAt > checkpoint.savedAt, 'Restored workflow did not checkpoint again');
    assert.equal(submissions.length, 0);
    assert.equal(digest(await fs.readFile(workflowFile)), before);
    console.log('PASS: app crash restores the full workflow and latest edit without submitting jobs or changing the original file');
  } finally {
    await crash();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
