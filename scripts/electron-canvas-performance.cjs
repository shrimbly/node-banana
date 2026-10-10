// Production-renderer benchmark. Uses a disposable Electron profile and a
// synthetic workflow; never runs generations or touches the user's session.
// npm run build && npm run electron:performance -- --media --output <dir>/canvas-before.json
//
// Each gesture is traced (electron/lib/perf-trace.cjs) and judged by what the
// screen presented: dropped frames, frame pacing and input-to-frame latency
// (scripts/lib/trace-analysis.cjs). The animation-frame callback figures are
// kept for comparison with older results; they miss compositor and GPU drops.
//
// --input synthetic (default) sends events from Electron's main process at
// 125 Hz in a 1440×900 window, as earlier recorded results did. --input os
// moves the real cursor through the OS at --hz (default 1000, a gaming mouse)
// in a maximised window, which is how the app is actually used; do not touch
// the mouse while it runs.
//
// The canvas is the generated grid (--nodes, --media), --fixture realistic
// (scripts/lib/perf-fixtures.cjs), or --workflow <file.json>, one of your own.
// --zoom sets the working zoom, --agent-open opens the agent panel and
// --tabs N holds N copies of the workflow in tabs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { _electron } = require('playwright-core');
const { PERF_TRACE_CATEGORIES, PAGE_PROBE } = require('../electron/lib/perf-trace.cjs');
const { readTrace, analyzeTrace, keepAnalyzed, selfTime, formatReport } = require('./lib/trace-analysis.cjs');
const { createOsInput } = require('./lib/os-input.cjs');
const { realisticWorkflow, fillRealisticMedia } = require('./lib/perf-fixtures.cjs');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(option('--app-root', path.join(__dirname, '..')));
// --detail adds the categories that say what each thread spent its time on.
// Traces then grow by hundreds of MB a second, so use it for diagnosis only.
const DETAIL_CATEGORIES = ['gpu', 'viz', 'cc', 'skia', 'blink', 'disabled-by-default-skia', 'disabled-by-default-gpu.service', 'devtools.timeline'];

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

// Gestures are schedules in page (CSS) pixels: { t ms, type, x, y, dx, dy }.
// rapid-* are the paths earlier results used. The sweeps and circles are what
// hands do: long fast flicks across most of the window, and continuous loops.
const GESTURES = {
  'rapid-drag': { target: 'node', path: (o, u) => ({ x: o.x + 240 * Math.sin(u * Math.PI * 12) + 20 * u, y: o.y + 100 * Math.sin(u * Math.PI * 8) }) },
  // The wheel pan's path for a drag: 24 px steps reversing every 50 events.
  'rapid-pan': { target: 'pane', path: (o, u, i) => { const step = Math.floor(i / 50), within = i % 50 + 1, size = o.ax / 25;
    return { x: o.x - o.ax + (step % 2 ? size * (50 - within) : size * within), y: o.y }; } },
  'drag-sweep': { target: 'node', path: (o, u) => ({ x: o.x + o.ax * Math.sin(u * Math.PI * 6) + 30 * u, y: o.y + o.ay * Math.sin(u * Math.PI * 4) }) },
  'drag-circle': { target: 'node', path: (o, u) => ({ x: o.x - o.r + o.r * Math.cos(u * Math.PI * 10) + 30 * u, y: o.y + o.r * Math.sin(u * Math.PI * 10) }) },
  'pan-sweep': { target: 'pane', path: (o, u) => ({ x: o.x + o.ax * Math.sin(u * Math.PI * 6) + 30 * u, y: o.y + o.ay * Math.sin(u * Math.PI * 4) }) },
  // The Mac pans with the wheel (trackpad): 24 px steps reversing every 50 events.
  'pan-wheel': { target: 'pane', wheel: i => Math.floor(i / 50) % 2 ? -23 : 24 },
};

function schedule(gesture, origin, { hz, seconds }) {
  const n = Math.round(hz * seconds), interval = 1000 / hz, events = [];
  if (gesture.wheel) {
    events.push({ t: 0, type: 'move', x: origin.x, y: origin.y });
    for (let i = 0; i < n; i++) events.push({ t: 40 + i * interval, type: 'wheel', x: origin.x, y: origin.y, dx: gesture.wheel(i), dy: 0 });
    // A distinct final vertical component is an ordered marker: Chromium may
    // still have queued or coalesced wheel events after the producer stops.
    events.push({ t: 40 + n * interval, type: 'wheel', x: origin.x, y: origin.y, dx: 0, dy: 1 });
    return events;
  }
  events.push({ t: 0, type: 'move', x: origin.x, y: origin.y }, { t: 40, type: 'down', x: origin.x, y: origin.y });
  let point = origin;
  for (let i = 0; i < n; i++) {
    point = gesture.path(origin, (i + 1) / n, i);
    events.push({ t: 80 + i * interval, type: 'move', x: point.x, y: point.y });
  }
  events.push({ t: 80 + n * interval + 20, type: 'up', x: point.x, y: point.y });
  return events;
}

async function main() {
  const count = Number(option('--nodes', 240));
  const rounds = Number(option('--rounds', 3));
  const detail = process.argv.includes('--detail');
  const inputMode = option('--input', 'synthetic');
  const hz = Number(option('--hz', inputMode === 'os' ? 1000 : 125));
  const seconds = Number(option('--seconds', 4));
  const windowOption = option('--window', inputMode === 'os' ? 'maximized' : '1440x900');
  const executable = option('--executable');
  const fixtureName = option('--fixture', 'synthetic');
  const workflowFile = option('--workflow');
  const zoom = Number(option('--zoom', 45));
  const tabs = Number(option('--tabs', 1));
  const gestureNames = (option('--gestures') || (inputMode === 'os'
    ? ['drag-sweep', 'drag-circle', process.platform === 'darwin' ? 'pan-wheel' : 'pan-sweep']
    : ['rapid-drag', process.platform === 'darwin' ? 'pan-wheel' : 'rapid-pan']).join(',')).split(',');
  assert.ok(Number.isInteger(count) && count >= 12);
  assert.ok(Number.isInteger(rounds) && rounds > 0);
  assert.ok(['synthetic', 'os'].includes(inputMode), '--input is synthetic or os');
  assert.ok(hz > 0 && seconds > 0 && zoom > 0 && Number.isInteger(tabs) && tabs > 0);
  assert.ok(['synthetic', 'realistic'].includes(fixtureName), '--fixture is synthetic or realistic');
  for (const name of gestureNames) assert.ok(GESTURES[name], `Unknown gesture ${name}; one of ${Object.keys(GESTURES).join(', ')}`);
  const osInput = inputMode === 'os' ? createOsInput() : undefined;
  assert.ok(!osInput || osInput.available, '--input os needs Windows or macOS');
  const output = path.resolve(option('--output', path.join(os.tmpdir(), 'banana-canvas-performance.json')));
  const traceDir = process.argv.includes('--keep-traces') ? output.replace(/\.json$/, '') + '-traces' : await fs.mkdtemp(path.join(os.tmpdir(), 'banana-canvas-traces-'));
  await fs.mkdir(traceDir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-canvas-perf-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let app;
  try {
    if (!executable) await fs.access(path.join(root, ".next/BUILD_ID"));
    app = await _electron.launch({ ...(executable ? { executablePath: executable, args: [] } : { args: [root], cwd: root }), timeout: 120000,
      env: { ...process.env, NODE_BANANA_ELECTRON_USER_DATA: profile, NODE_BANANA_ELECTRON_PORT: String(port) } });
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    const page = await app.firstWindow({ timeout: 120000 });
    const [width, height] = windowOption === 'maximized' ? [] : windowOption.split('x').map(Number);
    // On top for the whole run: Chromium stops producing frames for a
    // covered window, which would stall the run or flatter its numbers.
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (width) { window.unmaximize(); window.setContentSize(width, height); window.center(); } else window.maximize();
      window.setAlwaysOnTop(true);
      window.focus();
    }, { width, height });
    await delay(500);
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
    // The workflow goes in the way a user's does: dropped on the canvas as a
    // file. It stays in the page, media and all, for further tabs.
    await page.evaluate(() => {
      window.__perfDrop = (overrides = {}) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([JSON.stringify({ ...window.__perfWorkflow, ...overrides })], 'canvas-performance.json', { type: 'application/json' }));
        document.querySelector('.react-flow').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      };
    });
    console.log('Loading the workflow…');
    let workflow;
    if (workflowFile) {
      workflow = JSON.parse(await fs.readFile(workflowFile, 'utf8'));
      // Saved media refs hydrate from the workflow's folder.
      workflow.directoryPath ||= path.dirname(path.resolve(workflowFile));
      await page.evaluate(workflow => { window.__perfWorkflow = workflow; window.__perfDrop(); }, workflow);
    } else if (fixtureName === 'realistic') {
      const input = await realisticWorkflow(root);
      await page.evaluate(input => { window.__perfFixture = input; }, input);
      // Filled in the page: the media never comes back over CDP.
      await page.evaluate(`(async () => {
        window.__perfWorkflow = await (${fillRealisticMedia})(window.__perfFixture);
        delete window.__perfFixture;
        window.__perfDrop();
      })()`);
      workflow = input.workflow;
    } else {
      workflow = fixture(count);
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
      window.__perfWorkflow = workflow;
      window.__perfDrop();
      }, { workflow, media: process.argv.includes('--media') });
    }
    const nodeCount = workflow.nodes.length, workflowName = workflow.name || 'Untitled';
    await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length === count, nodeCount, { timeout: 120000 });
    // Further tabs hold copies of the workflow, as when several are open.
    for (let tab = 2; tab <= tabs; tab++) {
      await page.getByRole('button', { name: 'New tab', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 0);
      const closeWelcome = page.getByRole('button', { name: 'Close', exact: true }).last();
      if (await closeWelcome.isVisible()) await closeWelcome.click();
      await page.evaluate(overrides => window.__perfDrop(overrides), { id: `${workflow.id || 'perf'}-${tab}`, name: `${workflowName} ${tab}` });
      await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length === count, nodeCount, { timeout: 120000 });
    }
    if (tabs > 1) {
      await page.getByRole('tab').filter({ hasText: workflowName }).first().click();
      await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length === count, nodeCount);
    }
    await page.getByRole('button', { name: 'Fit view', exact: true }).click();
    await delay(700);
    // Keep a representative working zoom, with both visible and culled nodes.
    while (Number((await page.getByLabel('Zoom level').textContent()).replace('%', '')) < zoom) {
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await delay(150);
    }
    if (process.argv.includes('--agent-open')) await page.getByRole('button', { name: /^(Open agent|Agent — )/ }).click();
    await delay(1500);
    await page.evaluate(PAGE_PROBE);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.evaluate(() => {
      window.__canvasInput = {};
      // Chromium sends synthetic moves when content shifts under a still
      // cursor, so the release is kept apart from the latest move.
      window.addEventListener('mouseup', event => { window.__canvasInput.up = { x: event.clientX, y: event.clientY }; }, { passive: true, capture: true });
      document.addEventListener('wheel', event => { if (event.deltaY !== 0) window.__canvasInput.wheelEnded = true; }, { passive: true, capture: true });
    });
    const readMetrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const results = [];
    const traced = [];
    const lateness = [];
    let detailTimes;
    if (process.argv.includes('--profile')) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    async function measure(name, action) {
      const categories = detail ? [...PERF_TRACE_CATEGORIES, ...DETAIL_CATEGORIES] : PERF_TRACE_CATEGORIES;
      await app.evaluate(({ contentTracing }, categories) => contentTracing.startRecording({ included_categories: categories, excluded_categories: ['*'] }), categories);
      await page.evaluate(name => {
        performance.mark(`banana:gesture ${name}`);
        window.__canvasFrames = { times: [], running: true };
        const tick = time => { const state = window.__canvasFrames; if (state.running) { state.times.push(time); requestAnimationFrame(tick); } };
        requestAnimationFrame(tick);
      }, name);
      const before = await readMetrics();
      const inputEvents = await action();
      const after = await readMetrics();
      const frames = await page.evaluate(() => { window.__canvasFrames.running = false; return window.__canvasFrames.times; });
      const traceFile = await app.evaluate(({ contentTracing }, file) => contentTracing.stopRecording(file), path.join(traceDir, `${name}-${results.length + 1}.json`));
      const events = readTrace(traceFile);
      if (detail && !detailTimes) detailTimes = selfTime(events);
      for (const event of events) if (keepAnalyzed(event)) traced.push(event);
      if (!process.argv.includes('--keep-traces')) await fs.rm(traceFile, { force: true });
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
    // Page pixels to the units each player needs. Windows SendInput takes
    // physical screen pixels; the Mac's CGEvent takes points.
    const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      return { origin: process.platform === 'win32' ? screen.dipToScreenPoint({ x: bounds.x, y: bounds.y }) : { x: bounds.x, y: bounds.y }, scaleFactor: display.scaleFactor };
    });
    const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    const pageToScreen = process.platform === 'win32' ? devicePixelRatio : devicePixelRatio / geometry.scaleFactor;
    // Synthetic input is produced from Electron's main process without
    // awaiting the renderer: awaiting page.mouse.move serializes input behind
    // slow frames and hides precisely the stalls this benchmark exposes.
    // Main-process timers tick every ~15.6 ms on Windows, so events arrive
    // there in bursts at that cadence.
    async function play(events) {
      if (osInput) {
        const result = await osInput.play(events.map(e => ({ ...e, x: geometry.origin.x + e.x * pageToScreen, y: geometry.origin.y + e.y * pageToScreen })));
        lateness.push(result.worstLateMs);
        return result.sent;
      }
      return app.evaluate(async ({ BrowserWindow }, events) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const start = performance.now();
        let sent = 0, down = false;
        await new Promise(resolve => {
          const timer = setInterval(() => {
            while (sent < events.length && events[sent].t <= performance.now() - start) {
              const { type, x, y, dx, dy } = events[sent++];
              const at = { x: Math.round(x), y: Math.round(y) };
              if (type === 'wheel') contents.sendInputEvent({ type: 'mouseWheel', ...at, deltaX: dx, deltaY: dy, canScroll: true });
              else if (type === 'down') { down = true; contents.sendInputEvent({ type: 'mouseDown', button: 'left', ...at, clickCount: 1 }); }
              else if (type === 'up') { down = false; contents.sendInputEvent({ type: 'mouseUp', button: 'left', ...at, clickCount: 1 }); }
              else contents.sendInputEvent({ type: 'mouseMove', ...(down ? { button: 'left', modifiers: ['leftButtonDown'] } : {}), ...at });
            }
            if (sent === events.length) { clearInterval(timer); resolve(); }
          }, 4);
        });
        return sent;
      }, events);
    }
    async function gesture(events) {
      await page.evaluate(() => { window.__canvasInput = {}; });
      const sent = await play(events);
      const last = events.at(-1);
      // The page saw the gesture end: the wheel marker, or the button release where it was sent.
      await page.waitForFunction(({ type, x, y }) => type === 'wheel' ? window.__canvasInput.wheelEnded
        : window.__canvasInput.up && Math.abs(window.__canvasInput.up.x - x) <= 2 && Math.abs(window.__canvasInput.up.y - y) <= 2, last);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return sent;
    }
    // Where each kind of gesture starts, near the middle of the canvas so
    // sweeps have room either side, keeping clear of the tab strip and the
    // bottom bar.
    const target = kind => page.evaluate(kind => {
      const cx = innerWidth / 2, cy = innerHeight / 2;
      const room = (x, y) => ({ ax: Math.max(40, Math.min(innerWidth * .3, x - 60, innerWidth - x - 60)), ay: Math.max(20, Math.min(innerHeight * .15, y - 140, innerHeight - y - 140)),
        r: Math.max(30, Math.min(innerWidth, innerHeight) * .18) });
      if (kind === 'node') {
        // A point that drags the node: on it, and not on a field, handle or button.
        // Generate nodes come first so the default canvas drags what it always has.
        let best;
        for (const element of document.querySelectorAll('.react-flow__node')) {
          const box = element.getBoundingClientRect();
          if (box.x < 150 || box.y < 180 || box.right > innerWidth - 250 || box.bottom > innerHeight - 250) continue;
          const point = [40, box.height / 2, box.height / 4, box.height * .75].map(dy => ({ x: box.x + box.width / 2, y: box.y + dy })).find(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return hit && element.contains(hit) && !hit.closest('.nodrag, input, textarea, select, button, [contenteditable="true"], .react-flow__handle');
          });
          if (!point) continue;
          const distance = Math.hypot(point.x - cx, point.y - cy) + (element.classList.contains('react-flow__node-nanoBanana') ? 0 : 1e5);
          if (!best || distance < best.distance) best = { ...point, distance, id: element.dataset.id, transform: element.style.transform };
        }
        return best && { ...best, ...room(best.x, best.y) };
      }
      for (let radius = 0; radius < Math.min(cx, cy) - 100; radius += 6) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.max(.05, 6 / Math.max(radius, 1))) {
          const x = Math.round(cx + radius * Math.cos(angle)), y = Math.round(cy + radius * Math.sin(angle));
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y, ...room(x, y) };
        }
      }
    }, kind);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    if (osInput) {
      console.log('Driving the real mouse: do not touch it until the run finishes.');
      await delay(3000);
    }
    console.log(`Measuring ${rounds} round(s) of ${gestureNames.join(', ')}…`);
    await page.mouse.move(Math.round((await page.evaluate(() => innerWidth)) * .7), 40);
    await delay(300);
    await page.screenshot({ path: output.replace(/\.json$/, '') + '.png' });
    let lastDrag;
    for (let round = 0; round < rounds; round++) {
      for (const name of gestureNames) {
        const spec = GESTURES[name];
        const origin = await target(spec.target);
        assert.ok(origin, `No ${spec.target === 'node' ? 'visible node to drag' : 'empty pane to pan from'} for ${name}`);
        const events = schedule(spec, origin, { hz, seconds });
        const viewportBefore = await page.locator('.react-flow__viewport').evaluate(el => el.style.transform);
        await measure(name, () => gesture(events));
        await delay(200);
        if (spec.target === 'node') {
          const moved = await page.locator(`.react-flow__node[data-id="${origin.id}"]`).evaluate(el => el.style.transform);
          assert.notEqual(moved, origin.transform, `${name} did not move the node`);
          lastDrag = { ...origin, moved };
        } else {
          assert.equal(await page.locator('.react-flow__node').count(), nodeCount, 'Panning lost node wrappers');
          assert.notEqual(await page.locator('.react-flow__viewport').evaluate(el => el.style.transform), viewportBefore, `${name} did not move the viewport`);
        }
      }
    }
    // Interaction checks run after the measured intervals.
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    if (lastDrag) {
      // Undo every drag since the last one and redo it; only the last drag's
      // own move must round-trip.
      await page.keyboard.press(`${modifier}+z`);
      await page.waitForFunction(({ id, moved }) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.style.transform !== moved, lastDrag);
      await page.keyboard.press(`${modifier}+Shift+z`);
      await page.waitForFunction(({ id, moved }) => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.style.transform === moved, lastDrag);
    }
    await delay(800);
    const savedViewport = await page.locator('.react-flow__viewport').evaluate(el => el.style.transform);
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 0);
    const closeWelcome = page.getByRole('button', { name: 'Close', exact: true }).last();
    if (await closeWelcome.isVisible()) await closeWelcome.click();
    await page.getByRole('tab').filter({ hasText: workflowName }).first().click();
    await page.waitForFunction(count => document.querySelectorAll('.react-flow__node').length === count, nodeCount);
    await page.waitForFunction(expected => document.querySelector('.react-flow__viewport')?.style.transform === expected, savedViewport, { timeout: 5000 });
    assert.equal(await page.locator('.react-flow__node [role="alert"]').count(), 0, 'Node failed to render');
    assert.deepEqual(pageErrors, [], 'Renderer errors during interaction');
    console.log('PASS: drag/pan gestures, undo/redo and tab viewport restoration');
    if (process.argv.includes('--profile')) {
      const { profile: cpuProfile } = await cdp.send('Profiler.stop');
      await fs.writeFile(output.replace(/\.json$/, '') + '.cpuprofile', JSON.stringify(cpuProfile));
    }
    const trace = analyzeTrace(traced);
    const environment = await app.evaluate(({ app, screen, BrowserWindow }) => {
      const display = screen.getPrimaryDisplay(), window = BrowserWindow.getAllWindows()[0];
      return { gpu: app.getGPUFeatureStatus(), displayHz: display.displayFrequency, scaleFactor: display.scaleFactor,
        displaySize: display.size, windowContentSize: window.getContentSize(), maximized: window.isMaximized(), packaged: app.isPackaged, versions: process.versions };
    });
    const workload = workflowFile ? `workflow:${path.basename(workflowFile)}` : fixtureName === 'realistic' ? 'realistic' : process.argv.includes('--media') ? 'images-1024px' : 'empty-nodes';
    const report = { workload, zoom, tabs, agentOpen: process.argv.includes('--agent-open'), input: inputMode, inputHz: hz, gestureDurationMs: seconds * 1000, gestures: gestureNames,
      ...(osInput ? { osInputWorstLateMs: Math.max(...lateness) } : {}), nodes: nodeCount, edges: workflow.edges.length, rounds,
      platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, ...environment, trace, ...(detailTimes ? { detail: detailTimes } : {}), results };
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(`\n${formatReport(trace)}`);
    if (detailTimes) for (const [thread, { totalMs, top }] of Object.entries(detailTimes)) console.log(`\n${thread}: ${totalMs} ms\n${top.map(t => `  ${String(t.ms).padStart(8)} ms  ${t.name}`).join('\n')}`);
    console.log(`\nSaved ${output}`);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, { recursive: true, force: true });
    if (!process.argv.includes('--keep-traces')) await fs.rm(traceDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
