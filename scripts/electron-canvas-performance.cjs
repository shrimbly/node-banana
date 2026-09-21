// Production-renderer benchmark. Uses a disposable Electron profile and a
// synthetic workflow; never runs generations or touches the user's session.
// npm run build && node scripts/electron-canvas-performance.cjs --output /tmp/canvas-before.json
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { _electron } = require('playwright-core');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(option('--app-root', path.join(__dirname, '..')));

function fixture(count) {
  const nodes = [], edges = [];
  for (let i = 0; i < count; i++) {
    const type = i % 3 === 0 ? 'prompt' : i % 3 === 1 ? 'nanoBanana' : 'output';
    nodes.push({ id: `perf-${i}`, type, position: { x: (i % 12) * 370, y: Math.floor(i / 12) * 420 },
      data: type === 'prompt' ? { prompt: `Performance fixture ${i}`, customTitle: `Prompt ${i}` }
        : type === 'nanoBanana' ? { model: 'nano-banana', status: 'idle', outputImage: null, aspectRatio: '1:1', resolution: '1K' }
        : { image: null }, style: { width: 300 } });
    if (i % 3 !== 0) edges.push({ id: `edge-${i}`, source: `perf-${i - 1}`, target: `perf-${i}`,
      sourceHandle: i % 3 === 1 ? 'text' : 'image', targetHandle: i % 3 === 1 ? 'text' : 'image', type: 'editable', data: {} });
  }
  return { version: 1, name: 'Canvas performance fixture', nodes, edges, groups: {} };
}

async function main() {
  const count = Number(option('--nodes', 240));
  const rounds = Number(option('--rounds', 3));
  assert.ok(Number.isInteger(count) && count >= 12);
  assert.ok(Number.isInteger(rounds) && rounds > 0);
  const output = path.resolve(option('--output', path.join(os.tmpdir(), 'banana-canvas-performance.json')));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-canvas-perf-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let app;
  try {
    await fs.access(path.join(root, ".next/BUILD_ID"));
    app = await _electron.launch({ args: [root], cwd: root, timeout: 120000,
      env: { ...process.env, NODE_BANANA_ELECTRON_USER_DATA: profile, NODE_BANANA_ELECTRON_PORT: String(port) } });
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    const page = await app.firstWindow({ timeout: 120000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    page.setDefaultTimeout(30000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept().catch(() => {}));
    await page.route('**/api/**', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await page.locator('.react-flow').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible()) await skip.click();
    await page.keyboard.press('Escape');
    await page.evaluate(({ workflow, media }) => {
      if (media) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext('2d');
        for (let i = 0; i < workflow.nodes.length; i++) {
          const node = workflow.nodes[i];
          if (node.type === 'prompt') continue;
          const gradient = context.createLinearGradient(0, 0, 1024, 1024);
          gradient.addColorStop(0, `hsl(${i * 37 % 360} 65% 45%)`);
          gradient.addColorStop(1, `hsl(${(i * 37 + 80) % 360} 70% 15%)`);
          context.fillStyle = gradient;
          context.fillRect(0, 0, 1024, 1024);
          context.fillStyle = '#ffffff';
          context.font = '80px sans-serif';
          context.fillText(`Fixture ${i}`, 80, 530);
          const image = canvas.toDataURL('image/jpeg', .85);
          if (node.type === 'nanoBanana') node.data.outputImage = image;
          else node.data.image = image;
        }
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(workflow)], 'canvas-performance.json', { type: 'application/json' }));
      document.querySelector('.react-flow').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, { workflow: fixture(count), media: process.argv.includes('--media') });
    await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length === count, count);
    await page.getByRole('button', { name: 'Fit view', exact: true }).click();
    await delay(700);
    // Keep a representative working zoom, with both visible and culled nodes.
    while (Number((await page.getByLabel('Zoom level').textContent()).replace('%', '')) < 45) {
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await delay(150);
    }
    await delay(1500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.evaluate(() => {
      window.__canvasInput = {};
      window.addEventListener('mousemove', event => { window.__canvasInput.mouse = { x: event.clientX, y: event.clientY }; }, { passive: true, capture: true });
      document.addEventListener('wheel', event => { if (event.deltaY !== 0) window.__canvasInput.wheelEnded = true; }, { passive: true, capture: true });
    });
    const readMetrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const results = [];
    if (process.argv.includes('--profile')) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    async function measure(name, action) {
      await page.evaluate(() => {
        window.__canvasFrames = { times: [], running: true };
        const tick = time => { const state = window.__canvasFrames; if (state.running) { state.times.push(time); requestAnimationFrame(tick); } };
        requestAnimationFrame(tick);
      });
      const before = await readMetrics();
      const inputEvents = await action();
      const after = await readMetrics();
      const frames = await page.evaluate(() => { window.__canvasFrames.running = false; return window.__canvasFrames.times; });
      const intervals = frames.slice(1).map((time, i) => time - frames[i]).sort((a, b) => a - b);
      const percentile = p => Math.round((intervals[Math.floor((intervals.length - 1) * p)] || 0) * 100) / 100;
      const seconds = (frames.at(-1) - frames[0]) / 1000;
      const result = { name, inputEvents, durationMs: Math.round(seconds * 1000), fps: Math.round((frames.length - 1) / seconds * 10) / 10,
        frameMsP50: percentile(.5), frameMsP95: percentile(.95), frameMsMax: percentile(1),
        framesOver25ms: intervals.filter(ms => ms > 25).length,
        scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
        layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
        styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
        taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000) };
      results.push(result); console.log(JSON.stringify(result));
      await delay(350);
    }
    // Drive native input from the main process independently of renderer/CDP
    // acknowledgements. Awaiting page.mouse.move serializes input behind slow
    // frames and hides precisely the stalls this benchmark needs to expose.
    async function gesture(kind, origin) {
      await page.evaluate(() => { window.__canvasInput = {}; });
      const sent = await app.evaluate(async ({ BrowserWindow }, { kind, origin }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const start = performance.now();
        let sent = 0;
        await new Promise(resolve => {
          const timer = setInterval(() => {
            const due = Math.min(500, Math.floor((performance.now() - start) / 8));
            // Catch up after main-process timer jitter so before/after runs
            // receive the same 500 events and the same motion path.
            while (sent < due) {
              sent++;
              const t = sent / 500;
              if (kind === 'drag') {
                contents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'],
                  x: Math.round(origin.x + 240 * Math.sin(t * Math.PI * 12) + 20 * t),
                  y: Math.round(origin.y + 100 * Math.sin(t * Math.PI * 8)) });
              } else {
                contents.sendInputEvent({ type: 'mouseWheel', x: 1100, y: 120,
                  deltaX: Math.floor((sent - 1) / 50) % 2 ? -23 : 24, deltaY: 0, canScroll: true });
              }
            }
            if (sent === 500) { clearInterval(timer); resolve(); }
          }, 8);
        });
        // A distinct final wheel component is an ordered marker. Chromium may
        // still have queued/coalesced wheel events after the producer stops.
        if (kind === 'pan') contents.sendInputEvent({ type: 'mouseWheel', x: 1100, y: 120, deltaX: 0, deltaY: 1, canScroll: true });
        return sent;
      }, { kind, origin });
      await page.waitForFunction(({ kind, origin }) => kind === 'pan'
        ? window.__canvasInput.wheelEnded
        : window.__canvasInput.mouse?.x === Math.round(origin.x + 20) && window.__canvasInput.mouse?.y === Math.round(origin.y), { kind, origin });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return sent;
    }
    await page.mouse.move(1000, 40);
    await delay(300);
    await page.screenshot({ path: output.replace(/\.json$/, '') + '.png' });
    let lastDrag;
    for (let round = 0; round < rounds; round++) {
      const node = await page.evaluate(() => {
        for (const element of document.querySelectorAll('.react-flow__node-nanoBanana')) {
          const box = element.getBoundingClientRect();
          if (box.x > 150 && box.y > 180 && box.right < innerWidth - 250 && box.bottom < innerHeight - 250) {
            return { id: element.dataset.id, x: box.x + box.width / 2, y: box.y + 40, transform: element.style.transform };
          }
        }
      });
      assert.ok(node, 'No visible node available to drag');
      await page.mouse.move(node.x, node.y);
      await page.mouse.down();
      await measure('rapid-drag', () => gesture('drag', node));
      await page.mouse.up();
      const moved = await page.locator(`.react-flow__node[data-id="${node.id}"]`).evaluate(el => el.style.transform);
      assert.notEqual(moved, node.transform, 'Node drag did not change its position');
      lastDrag = { ...node, moved };
      const viewportBefore = await page.locator('.react-flow__viewport').evaluate(el => el.style.transform);
      await page.mouse.move(1100, 120);
      await measure('rapid-pan', () => gesture('pan'));
      await delay(200);
      assert.equal(await page.locator('.react-flow__node').count(), count, 'Panning lost node wrappers');
      assert.notEqual(await page.locator('.react-flow__viewport').evaluate(el => el.style.transform), viewportBefore, 'Wheel pan did not move the viewport');
    }
    // Interaction checks run after the measured intervals.
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+z`);
    await page.waitForFunction(({ id, transform }) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.style.transform === transform, lastDrag);
    await page.keyboard.press(`${modifier}+Shift+z`);
    await page.waitForFunction(({ id, moved }) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.style.transform === moved, lastDrag);
    await delay(800);
    const savedViewport = await page.locator('.react-flow__viewport').evaluate(el => el.style.transform);
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 0);
    const closeWelcome = page.getByRole('button', { name: 'Close', exact: true }).last();
    if (await closeWelcome.isVisible()) await closeWelcome.click();
    await page.getByRole('tab').filter({ hasText: 'Canvas performance fixture' }).click();
    await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length === count, count);
    await page.waitForFunction(expected => document.querySelector('.react-flow__viewport')?.style.transform === expected, savedViewport, { timeout: 5000 });
    assert.equal(await page.locator('.react-flow__node [role="alert"]').count(), 0, 'Node failed to render');
    assert.deepEqual(pageErrors, [], 'Renderer errors during interaction');
    console.log('PASS: rapid drag/pan, undo/redo and tab viewport restoration');
    if (process.argv.includes('--profile')) {
      const { profile: cpuProfile } = await cdp.send('Profiler.stop');
      await fs.writeFile(output.replace(/\.json$/, '') + '.cpuprofile', JSON.stringify(cpuProfile));
    }
    const report = { workload: process.argv.includes('--media') ? 'images-1024px' : 'empty-nodes', inputHz: 125, gestureDurationMs: 4000, nodes: count, edges: fixture(count).edges.length, rounds, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
      versions: await app.evaluate(() => process.versions), results };
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Saved ${output}`);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
