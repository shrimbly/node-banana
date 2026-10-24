// GPU canvas runner. Opens the production Electron app, loads the stress workflow tiled to about 5,000 nodes (media by
// reference, as a saved workflow opens) and measures the phase 2 targets on
// real workflows: opening behind the loading screen, reopening from the disk
// cache, pans while painting, a change shown, painted against live nodes,
// image tiers and jumps, scene gestures, and input latency. Writes a JSON report. Runs unchanged on Windows and the Mac.
//
//   npm run build
//   node scripts/gpu-canvas.cjs --output gpu-canvas-mac.json
//
// --checks (open,reopen,pan,change,fidelity,tiers,scene,latency) picks checks.
// --copies N tiles the stress workflow N times (17 is about 5,100 nodes); --nodes N keeps the first N of them
// (tiling as many copies as that takes), and --hidden-edges hides every connection, as the FAB's button does.
// --input os (the default on Windows and the Mac) moves the real cursor at
// --hz (1000) in a maximised window: do not touch the mouse while it runs.
// --chromium-flags adds switches, e.g. "--no-sandbox --use-angle=swiftshader"
// on a Linux box with no GPU (run under xvfb-run).
// --live runs the browser path: HTML-in-Canvas off (NODE_BANANA_HTML_IN_CANVAS=0), as in a browser, where the
// painter copies its sheets into images (domSnapshot). --live-nodes also turns the painter off
// (node-banana-live-nodes), so the nodes in view are live components: its checks are open,reopen,pan,writes,scene,
// latency (the painter's change, fidelity and tiers do not apply). On either, the scene gestures run at each of
// --scene-zooms (fit,0.5,0.3 by default there; fit elsewhere), where a zoom is a fraction about the fitted view's centre.
// --fresh-paint also compares each node painted alone, bypassing the disk cache.
// --profile records a CPU profile of each gesture through Electron's own
// debugger (<output>/<label>.cpuprofile) and prints its heaviest functions.
// The debugger observes the page, so leave it off for comparisons.
// --scene-variants base,subtree,sheet,live,chrome,draw,navigator,groups,marquee,bare repeats the scene
// gestures with parts of the page taken away, to find what costs frames
// (draw keeps everything but the scene's drawing: the page's own costs on a slow GPU).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchElectron } = require('./lib/electron-driver.cjs');
const { PERF_TRACE_CATEGORIES, PAGE_PROBE } = require('../electron/lib/perf-trace.cjs');
const { readTrace, analyzeGestures, keepAnalyzed, formatReport } = require('./lib/trace-analysis.cjs');
const { createOsInput } = require('./lib/os-input.cjs');
const { strayElectron } = require('./lib/processes.cjs');

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const flag = name => process.argv.includes(name);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now();
const log = message => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const root = path.resolve(__dirname, '..');

// Gestures in page (css) pixels; o carries the start point and the room around it.
const GESTURES = {
  'pan-sweep': { path: (o, u) => ({ x: o.x + o.ax * Math.sin(u * Math.PI * 6) + 30 * u, y: o.y + o.ay * Math.sin(u * Math.PI * 4) }) },
  // The Mac's left drag on empty canvas, anywhere: a marquee (Shift held, so it is one on every platform).
  'marquee-sweep': { synthetic: true, modifiers: ['shift'], path: (o, u) => ({ x: o.x + o.ax * Math.sin(u * Math.PI * 6) + 30 * u, y: o.y + o.ay * Math.sin(u * Math.PI * 4) }) },
  'pan-wheel': { wheel: i => ({ dx: Math.floor(i / 50) % 2 ? -23 : 24, dy: 0 }) },
  // In and out about 4x each way, as a pinch or Ctrl+wheel does.
  'zoom-wheel': { synthetic: true, modifiers: ['control'], wheel: i => ({ dx: 0, dy: Math.floor(i / 60) % 2 ? -8 : 8 }) },
};

function schedule(gesture, origin, { hz, seconds }) {
  const n = Math.round(hz * seconds), interval = 1000 / hz, events = [];
  if (gesture.wheel) {
    events.push({ t: 0, type: 'move', x: origin.x, y: origin.y });
    for (let i = 0; i < n; i++) events.push({ t: 40 + i * interval, type: 'wheel', x: origin.x, y: origin.y, ...gesture.wheel(i), modifiers: gesture.modifiers });
    // The end marker is a small move: Chromium coalesces wheel events.
    events.push({ t: 60 + n * interval, type: 'move', x: origin.x + 3, y: origin.y + 3 });
    return events;
  }
  const modifiers = gesture.modifiers;
  events.push({ t: 0, type: 'move', x: origin.x, y: origin.y, modifiers }, { t: 40, type: 'down', x: origin.x, y: origin.y, modifiers });
  let point = origin;
  for (let i = 0; i < n; i++) {
    point = gesture.path(origin, (i + 1) / n, i);
    events.push({ t: 80 + i * interval, type: 'move', x: point.x, y: point.y, modifiers });
  }
  events.push({ t: 80 + n * interval + 20, type: 'up', x: point.x, y: point.y, modifiers });
  return events;
}

// The brief's lines for question 1 at 5,000 nodes.
function judge(summary, refreshHz) {
  const vsyncMs = 1000 / refreshHz;
  const checks = {
    presentedAtRefresh: summary.presentedFps >= 0.95 * refreshHz,
    p95WithinOneAndAHalfVsyncs: summary.frameMs.p95 != null && summary.frameMs.p95 <= 1.5 * vsyncMs,
    mainThreadAtMost30Pct: (summary.threads.rendererMain?.busyPct ?? 100) <= 30,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

// The stress workflow tiled `copies` times, its photos as files in the
// project's inputs/ folder and referenced the way a saved workflow opens them.
async function buildFixture(dir, copies, { keep = Infinity, hiddenEdges = false } = {}) {
  const sharp = require('sharp');
  const base = JSON.parse(await fs.readFile(path.join(root, 'examples/stress-workflow.json'), 'utf8'));
  const sources = (await fs.readdir(path.join(root, 'examples/sample-images'))).filter(name => /\.jpe?g$/i.test(name)).sort();
  await fs.mkdir(path.join(dir, 'inputs'), { recursive: true });
  const ids = [];
  for (const [k, name] of sources.entries()) {
    const id = `sample-${k}`;
    await sharp(path.join(root, 'examples/sample-images', name)).resize(1536, 1536, { fit: 'inside' }).jpeg({ quality: 88 }).toFile(path.join(dir, 'inputs', `${id}.jpg`));
    ids.push(id);
  }
  await fs.mkdir(path.join(dir, 'generations'), { recursive: true });
  await fs.copyFile(path.join(root, 'examples/sample-videos/clip.webm'), path.join(dir, 'generations', 'sample-video.webm'));
  const videoUrl = `/api/workflow-images?${new URLSearchParams({ workflowPath: dir, imageId: 'sample-video', raw: '1' })}`;
  const idFor = index => ids[index % ids.length];
  const mediaFor = index => `/api/workflow-images?${new URLSearchParams({ workflowPath: dir, imageId: ids[index % ids.length], raw: '1' })}`;
  let maxX = 0, maxY = 0;
  for (const node of base.nodes) {
    maxX = Math.max(maxX, node.position.x + Number(node.style?.width ?? node.width ?? 300));
    maxY = Math.max(maxY, node.position.y + 600);
  }
  for (const group of Object.values(base.groups ?? {})) {
    maxX = Math.max(maxX, group.position.x + group.size.width);
    maxY = Math.max(maxY, group.position.y + group.size.height);
  }
  const stepX = maxX + 800, stepY = maxY + 800, columns = 4;
  const nodes = [], edges = [], groups = {};
  let media = 0;
  for (let copy = 0; copy < copies; copy++) {
    const suffix = `~${copy}`, dx = (copy % columns) * stepX, dy = Math.floor(copy / columns) * stepY;
    const imageOf = new Map();
    for (const node of base.nodes) {
      const data = structuredClone(node.data);
      // Each reference carries its file's ref, as a saved workflow opens.
      if (node.type === 'imageInput') { data.imageRef = idFor(media); data.image = mediaFor(media++); data.filename = `reference-${media}.jpg`; imageOf.set(node.id, data.image); }
      else if (node.type === 'nanoBanana') { data.outputImageRef = idFor(media); data.outputImage = mediaFor(media++); data.status = 'complete'; imageOf.set(node.id, data.outputImage); }
      if (typeof data.groupId === 'string') data.groupId += suffix;
      nodes.push({ ...node, id: node.id + suffix, position: { x: node.position.x + dx, y: node.position.y + dy }, ...(node.groupId ? { groupId: node.groupId + suffix } : {}), data });
    }
    for (const edge of base.edges) edges.push({ ...edge, id: edge.id + suffix, source: edge.source + suffix, target: edge.target + suffix });
    for (const [id, group] of Object.entries(base.groups ?? {})) groups[id + suffix] = { ...group, id: id + suffix, name: `${group.name} (${copy + 1})`, position: { x: group.position.x + dx, y: group.position.y + dy } };
    const firstImage = new Map();
    for (const edge of base.edges) if (!firstImage.has(edge.target) && imageOf.has(edge.source)) firstImage.set(edge.target, edge.source);
    // Generate Video nodes hold the sample clip, and an Edit Video node stitches the first two.
    const videos = nodes.slice(nodes.length - base.nodes.length).filter(node => node.type === 'generateVideo');
    for (const node of videos) Object.assign(node.data, { outputVideo: videoUrl, outputVideoRef: 'sample-video', status: 'complete' });
    if (videos.length >= 2) {
      const [a, b] = videos, stitch = `videoStitch-fixture${suffix}`;
      nodes.push({ id: stitch, type: 'videoStitch', position: { x: a.position.x + 1000, y: a.position.y }, style: { width: 400, height: 280 },
        data: { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: 'idle', error: null, progress: 0, encoderSupported: null } });
      for (const [i, source] of [a, b].entries()) {
        edges.push({ id: `edge-${source.id}-${stitch}-video-${i}`, source: source.id, sourceHandle: 'video', target: stitch, targetHandle: `video-${i}`, data: { createdAt: 1756000000000 + i } });
      }
    }
    for (const node of nodes.slice(nodes.length - base.nodes.length)) {
      if (node.type !== 'output') continue;
      const source = firstImage.get(node.id.slice(0, -suffix.length));
      const image = source ? imageOf.get(source) : mediaFor(media++);
      Object.assign(node.data, { image, imageRef: new URLSearchParams(image.split('?')[1]).get('imageId'), contentType: 'image' });
    }
  }
  const kept = nodes.slice(0, keep), keptIds = new Set(kept.map(node => node.id));
  const keptEdges = edges.filter(edge => keptIds.has(edge.source) && keptIds.has(edge.target));
  if (hiddenEdges) for (const edge of keptEdges) edge.data = { ...edge.data, hidden: true };
  return { ...base, id: `gpu-canvas-${copies}`, name: `GPU canvas ${copies} copies`, directoryPath: dir, nodes: kept, edges: keptEdges, groups };
}

async function main() {
  // liveMode: no painter at all; browserPath: no HTML-in-Canvas.
  const liveMode = flag('--live-nodes');
  const browserPath = liveMode || flag('--live');
  const checks = option('--checks', liveMode ? 'open,reopen,pan,writes,scene,latency' : 'open,reopen,pan,change,fidelity,tiers,scene,latency').split(',');
  const keep = option('--nodes') ? Number(option('--nodes')) : Infinity;
  const copies = Number.isFinite(keep) ? Math.ceil(keep / 300) : Number(option('--copies', 17));
  const osInput = option('--input', ['win32', 'darwin'].includes(process.platform) ? 'os' : 'synthetic') === 'os' ? createOsInput() : undefined;
  assert.ok(!osInput || osInput.available, '--input os needs Windows or macOS');
  const hz = Number(option('--hz', osInput ? 1000 : 125));
  const seconds = Number(option('--seconds', 4));
  const flags = option('--chromium-flags', '').split(' ').filter(Boolean);
  const output = path.resolve(option('--output', path.join(os.tmpdir(), 'gpu-canvas.json')));
  const shots = output.replace(/\.json$/, '');
  await fs.mkdir(shots, { recursive: true });
  await fs.access(path.join(root, '.next/BUILD_ID')).catch(() => { throw new Error('Run npm run build first: the runner uses the production build.'); });
  const strays = strayElectron();
  if (strays.length && !flag('--allow-others')) throw new Error(`Electron is still running from a Node Banana checkout:\n${strays.map(p => `  ${p.pid} ${p.path}`).join('\n')}\nClose it (or pass --allow-others).`);

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-canvas-profile-'));
  const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-canvas-traces-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  log(`Building the fixture (${copies} copies)…`);
  const project = path.join(profile, 'project');
  const workflow = await buildFixture(project, copies, { keep, hiddenEdges: flag('--hidden-edges') });
  const workflowText = JSON.stringify(workflow);

  const report = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, input: osInput ? 'os' : 'synthetic', inputHz: hz,
    gestureMs: seconds * 1000, chromiumFlags: flags, mode: liveMode ? 'live' : browserPath ? 'snapshot' : 'painted', nodes: workflow.nodes.length, edges: workflow.edges.length };
  const save = () => fs.writeFile(output, JSON.stringify(report, null, 2));
  let app;
  try {
    log('Launching…');
    // --electron <binary> runs another Electron (one on a newer Chromium) on the same app.
    app = await launchElectron({ executable: option('--electron', require('electron')), args: [...flags, root], cwd: root,
      env: { ...process.env, NODE_BANANA_ELECTRON_USER_DATA: profile, NODE_BANANA_ELECTRON_PORT: String(port),
        ...(browserPath ? { NODE_BANANA_HTML_IN_CANVAS: '0' } : {}) } });
    const { page } = app;
    await app.run(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    await app.window();
    const windowOption = option('--window', osInput ? 'maximized' : '1440x900');
    const [width, height] = windowOption === 'maximized' ? [] : windowOption.split('x').map(Number);
    await app.run(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (width) { window.unmaximize(); window.setContentSize(width, height); window.center(); } else window.maximize();
      // Chromium stops producing frames for a covered window.
      window.setAlwaysOnTop(true);
      window.focus();
    }, { width, height });
    Object.assign(report, await app.run(({ app, screen, BrowserWindow }) => {
      const display = screen.getPrimaryDisplay(), window = BrowserWindow.getAllWindows()[0];
      return { gpu: app.getGPUFeatureStatus(), displayHz: display.displayFrequency, scaleFactor: display.scaleFactor, displaySize: display.size,
        windowContentSize: window.getContentSize(), versions: { electron: process.versions.electron, chrome: process.versions.chrome } };
    }));
    const gpuInfo = await app.run(({ app }) => app.getGPUInfo('basic')).catch(() => null);
    report.gpuDevice = gpuInfo?.gpuDevice?.find(device => device.active) ?? gpuInfo?.gpuDevice?.[0] ?? null;
    const geometry = await app.run(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      return { origin: process.platform === 'win32' ? screen.dipToScreenPoint({ x: bounds.x, y: bounds.y }) : { x: bounds.x, y: bounds.y }, scaleFactor: display.scaleFactor };
    });
    // No request leaves for a provider.
    await app.run(({ session }, port) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: [`http://127.0.0.1:${port}/api/*`] }, (details, callback) => {
        callback({ cancel: details.method === 'POST' && /\/api\/(generate|llm)/.test(details.url) });
      });
    }, port);

    // The page: the welcome dialog away, watchers installed.
    async function ready() {
      await app.run(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
      await delay(1500);
      // Linux with no keyring asks where keys go; the runner stores none.
      await page.click('Use for this session only', { optional: true, timeout: 5000 });
      // A reload looks like a crash to session recovery; reopening starts from an empty workspace.
      await page.click('Discard', { optional: true, timeout: 3000 });
      await page.waitFor(() => !!document.querySelector('[data-gpu-canvas]'), null, { timeout: 120000, message: 'the canvas' });
      await page.click('Close', { last: true, optional: true, timeout: 5000 });
      await page.click('Skip', { optional: true, timeout: 2000 });
      await page.key('Escape');
      await page.evaluate(PAGE_PROBE);
      await page.evaluate(() => {
        window.__perfErrors = [];
        addEventListener('error', event => { if (!/^ResizeObserver loop/.test(event.message)) window.__perfErrors.push(event.error?.stack ? String(event.error.stack).slice(0, 800) : event.message); });
        addEventListener('unhandledrejection', event => window.__perfErrors.push(String(event.reason?.message || event.reason)));
        window.confirm = () => true;
        window.__runnerInput = {};
        addEventListener('pointerup', event => { window.__runnerInput.up = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
        addEventListener('pointermove', event => { window.__runnerInput.move = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
        // A slow page delivers a gesture's wheels long after its last move: the runner waits them out.
        addEventListener('wheel', () => { window.__runnerWheelAt = performance.now(); }, { capture: true, passive: true });
      });
      const api = await page.waitFor(browser => !!window.__gpuCanvas && window.__gpuCanvas.info().htmlInCanvas === !browser, browserPath, { timeout: 30000,
        message: browserPath ? 'the GPU canvas without HTML-in-Canvas' : 'the GPU canvas with HTML-in-Canvas' }).catch(() => false);
      assert.ok(api, browserPath ? 'The GPU canvas did not start without HTML-in-Canvas' : 'The GPU canvas did not start with HTML-in-Canvas');
      // Live nodes alone: the page is told so, and loads again without its painter.
      if (liveMode && await page.evaluate(() => !!window.__gpuCanvas.painter())) {
        await page.evaluate(() => localStorage.setItem('node-banana-live-nodes', 'on'));
        return ready();
      }
    }
    // Drops the workflow on the canvas, as a user opening a saved one does.
    async function drop() {
      await page.evaluate(() => { window.__runnerText = []; });
      for (let i = 0; i < workflowText.length; i += 32 << 20) await page.evaluate(part => { window.__runnerText.push(part); }, workflowText.slice(i, i + (32 << 20)));
      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(window.__runnerText, 'gpu-canvas.json', { type: 'application/json' }));
        document.querySelector('[data-gpu-canvas]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 400, clientY: 300 }));
        delete window.__runnerText;
      });
    }
    // Opens the workflow and waits until the loading screen would be gone: the view sharp and every node at 1/8.
    async function openWorkflow(label) {
      const t0 = Date.now();
      // --probe prompt,imageInput: record the painter's sheet state for nodes of these types (in report.probe).
      if (option('--probe', '')) await page.evaluate(types => window.__gpuCanvas?.probe(types.split(',').map(t => `type:${t}`)), option('--probe', ''));
      await drop();
      await page.waitFor(n => window.__gpuCanvas?.nodeIds().length === n, workflow.nodes.length, { timeout: 120000, message: 'the workflow in the scene' });
      const loaded = Date.now();
      if (liveMode) return openLive(label, t0, loaded);
      let sawLoading = false;
      await page.waitFor(() => { const s = window.__gpuCanvas.painter(); return s && s.screenfulDone && s.painted >= s.total; }, null, { timeout: Number(option('--paint-timeout', 300000)), interval: 100,
        message: `${label}: every node painted` }).catch(error => { throw error; });
      const paintedMs = Date.now() - loaded;
      const status = await page.evaluate(() => window.__gpuCanvas.painter());
      // The loading screen goes with the render after the last paint: give it a moment before calling it stuck.
      const shownAfter = Date.now();
      sawLoading = await page.waitFor(() => !document.querySelector('[data-gpu-canvas] [role="status"]'), null, { timeout: 2000, interval: 50, message: 'the loading screen to go' }).then(() => false, () => true);
      const result = { loadMs: loaded - t0, paintedMs, loadingScreenStillUp: sawLoading, loadingScreenGoneMs: sawLoading ? null : Date.now() - shownAfter, status, stats: await page.evaluate(() => window.__gpuCanvas.stats.summary()) };
      log(`${label}: in the scene after ${result.loadMs} ms; screenful ${status.screenfulMs} ms, every node ${status.allMs} ms; ${status.cacheHits} cache hits, ${status.batches} batches`);
      return result;
    }

    // Live mode has no painter: opened is the view's nodes live with their images loaded, and the loading screen gone.
    async function openLive(label, t0, loaded) {
      // Nodes turn live a few per frame, so the view is live once the count has held for 300 ms (not counted in the time).
      await page.evaluate(() => { window.__runnerLiveSeen = { count: -1, at: 0 }; });
      await page.waitFor(() => {
        const live = window.__gpuCanvas.live();
        const seen = window.__runnerLiveSeen;
        if (live.length !== seen.count) { seen.count = live.length; seen.at = Date.now(); return false; }
        const nodes = [...document.querySelectorAll('[data-gpu-canvas-live] .react-flow__node')];
        return live.length > 0 && Date.now() - seen.at >= 300 && nodes.length >= live.length && nodes.every(n => [...n.querySelectorAll('img')].every(img => img.complete))
          && !document.querySelector('[data-gpu-canvas] [role="status"]');
      }, null, { timeout: Number(option('--paint-timeout', 300000)), interval: 50, message: `${label}: the view's nodes live` });
      const result = { loadMs: loaded - t0, viewLiveMs: Date.now() - 300 - loaded, live: await page.evaluate(() => window.__gpuCanvas.live().length),
        stats: await page.evaluate(() => window.__gpuCanvas.stats.summary()) };
      log(`${label}: in the scene after ${result.loadMs} ms; ${result.live} nodes live with their images ${result.viewLiveMs} ms later`);
      return result;
    }

    const devicePixelRatio = await page.evaluate(() => devicePixelRatio);
    const pageToScreen = process.platform === 'win32' ? devicePixelRatio : devicePixelRatio / geometry.scaleFactor;
    report.devicePixelRatio = devicePixelRatio;

    async function play(events, { synthetic } = {}) {
      if (osInput && !synthetic) return (await osInput.play(events.map(e => ({ ...e, x: geometry.origin.x + e.x * pageToScreen, y: geometry.origin.y + e.y * pageToScreen })))).sent;
      return app.run(async ({ BrowserWindow }, events) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const start = performance.now();
        let sent = 0, down = false;
        await new Promise(resolve => {
          const timer = setInterval(() => {
            while (sent < events.length && events[sent].t <= performance.now() - start) {
              const { type, x, y, dx, dy, modifiers = [] } = events[sent++];
              const at = { x: Math.round(x), y: Math.round(y) };
              if (type === 'wheel') contents.sendInputEvent({ type: 'mouseWheel', ...at, deltaX: dx, deltaY: dy, canScroll: true, modifiers });
              else if (type === 'down') { down = true; contents.sendInputEvent({ type: 'mouseDown', button: 'left', ...at, clickCount: 1, modifiers }); }
              else if (type === 'up') { down = false; contents.sendInputEvent({ type: 'mouseUp', button: 'left', ...at, clickCount: 1, modifiers }); }
              else contents.sendInputEvent({ type: 'mouseMove', ...(down ? { button: 'left' } : {}), modifiers: [...modifiers, ...(down ? ['leftButtonDown'] : [])], ...at });
            }
            if (sent === events.length) { clearInterval(timer); resolve(); }
          }, 4);
        });
        return sent;
      }, events);
    }
    // A point on empty canvas near the middle, with room to move around it.
    const emptyPoint = () => page.evaluate(() => {
      const cx = innerWidth / 2, cy = innerHeight / 2;
      const room = (x, y) => ({ ax: Math.max(40, Math.min(innerWidth * .3, x - 60, innerWidth - x - 60)), ay: Math.max(20, Math.min(innerHeight * .2, y - 60, innerHeight - y - 60)) });
      const free = (x, y) => window.__gpuCanvas ? !window.__gpuCanvas.nodeAt(x, y) : !document.elementFromPoint(x, y)?.closest('.react-flow__node');
      for (let radius = 0; radius < Math.min(cx, cy) - 60; radius += 4) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.max(.05, 4 / Math.max(radius, 1))) {
          const x = Math.round(cx + radius * Math.cos(angle)), y = Math.round(cy + radius * Math.sin(angle));
          if (free(x, y)) return { x, y, ...room(x, y) };
        }
      }
      return { x: 20, y: innerHeight - 20, ax: 10, ay: 10 };
    });
    // One traced gesture; its trace events go into `traced`.
    const debug = (method, params) => app.run(({ BrowserWindow }, { method, params }) => BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand(method, params), { method, params });
    if (flag('--profile')) {
      await app.run(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.debugger.attach('1.3'));
      await debug('Profiler.enable');
      await debug('Profiler.setSamplingInterval', { interval: 200 });
    }
    // The functions that took the most time of their own, from a CPU profile.
    function heaviest(profile, count = 15) {
      const byNode = new Map(profile.nodes.map(node => [node.id, node]));
      const self = new Map();
      const deltas = profile.timeDeltas;
      for (let i = 0; i < profile.samples.length; i++) {
        const { callFrame: f } = byNode.get(profile.samples[i]);
        const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + (deltas[i + 1] ?? 0) / 1000);
      }
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([fn, ms]) => ({ fn, ms: Math.round(ms), pct: Math.round(1000 * ms / total) / 10 }));
    }
    // Inclusive time per function over the samples inside the page-time windows, the profile's clock tied to the
    // page's by the nbCalibrate marker that started at `calibration`.
    function inclusiveWithin(profile, calibration, windows, count) {
      const byNode = new Map(profile.nodes.map(node => [node.id, node]));
      const parent = new Map();
      for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
      const key = ({ callFrame: f }) => `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
      const times = [];
      let t = profile.startTime;
      for (const delta of profile.timeDeltas) times.push(t += delta);
      const marked = profile.samples.findIndex(id => { for (let n = id; n !== undefined; n = parent.get(n)) if (byNode.get(n).callFrame.functionName === 'nbCalibrate') return true; return false; });
      if (marked < 0) return [];
      const offset = times[marked] / 1000 - calibration;
      const inside = ms => windows.some(([a, b]) => ms >= a && ms <= b);
      const total = new Map();
      for (let i = 0; i < profile.samples.length; i++) {
        if (!inside(times[i] / 1000 - offset)) continue;
        const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000, seen = new Set();
        for (let n = profile.samples[i]; n !== undefined; n = parent.get(n)) {
          const k = key(byNode.get(n));
          if (seen.has(k) || /^\((root|idle|program)\)/.test(k)) continue;
          seen.add(k);
          total.set(k, (total.get(k) ?? 0) + ms);
        }
      }
      return [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
    }
    async function measure(name, label, traced) {
      const spec = GESTURES[name];
      const origin = await emptyPoint();
      const events = schedule(spec, origin, { hz, seconds });
      if (flag('--profile')) await debug('Profiler.start');
      await app.run(({ contentTracing }, categories) => contentTracing.startRecording({ included_categories: categories, excluded_categories: ['*'] }), PERF_TRACE_CATEGORIES);
      await page.evaluate(label => { performance.mark(`banana:gesture ${label}`); window.__runnerInput = {}; window.__gpuCanvas?.stats.reset(); }, label);
      const sent = await play(events, { synthetic: spec.synthetic });
      const last = events.at(-1);
      await page.waitFor(({ type, x, y }) => { const seen = type === 'up' ? window.__runnerInput.up : window.__runnerInput.move;
        return seen && Math.abs(seen.x - x) <= 1.5 && Math.abs(seen.y - y) <= 1.5; }, last, { message: `${name} to reach the page` });
      await page.waitFor(() => !(performance.now() - (window.__runnerWheelAt ?? -Infinity) < 300), null, { timeout: 60000, interval: 50, message: `${name}'s wheels to arrive` });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const pageStats = await page.evaluate(() => window.__gpuCanvas?.stats.summary() ?? null);
      // A store write mid-gesture re-runs every selector over the graph: name them.
      const writes = Object.entries(pageStats?.storeWrites ?? {}).sort((a, b) => b[1] - a[1]);
      if (writes.length) log(`  ${label}: store writes ${writes.map(([what, n]) => `${n}× ${what}`).join(' | ')}`);
      let profileTop;
      if (flag('--profile')) {
        const { profile } = await debug('Profiler.stop');
        await fs.writeFile(path.join(shots, `${label}-${Date.now()}.cpuprofile`), JSON.stringify(profile));
        profileTop = heaviest(profile);
        log(`  ${label}: heaviest functions\n${profileTop.map(f => `    ${String(f.ms).padStart(6)} ms ${String(f.pct).padStart(5)}%  ${f.fn}`).join('\n')}`);
      }
      const traceFile = await app.run(({ contentTracing }, file) => contentTracing.stopRecording(file), path.join(traceDir, `${label}-${Date.now()}.json`));
      traced.push({ label, events: readTrace(traceFile).filter(keepAnalyzed) });
      await fs.rm(traceFile, { force: true });
      return { name, label, inputEvents: sent, input: spec.synthetic || !osInput ? 'synthetic' : 'os', pageStats, profileTop };
    }
    const traceResult = (traced, results) => {
      const trace = analyzeGestures(traced);
      console.log(`\n${formatReport(trace)}\n`);
      if (trace.untraced) log(`  not in the trace: ${JSON.stringify(trace.untraced)}`);
      const verdicts = Object.fromEntries(Object.entries(trace.summary).map(([label, summary]) => [label, judge(summary, report.displayHz || trace.refreshHz)]));
      return { trace, verdicts, results };
    };
    const checkErrors = async () => assert.deepEqual(await page.evaluate(() => window.__perfErrors), [], 'Page errors during the run');
    const processMemory = () => app.run(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, workingSetMB: Math.round(m.memory.workingSetSize / 1024) })));

    async function grab(rect) {
      return app.run(async ({ BrowserWindow }, rect) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
        globalThis.__grabs = globalThis.__grabs || [];
        globalThis.__grabs.push(image);
        return globalThis.__grabs.length - 1;
      }, rect);
    }
    async function compare(a, b, file) {
      return app.run(({ nativeImage }, { a, b, file }, require) => {
        const fs = require('node:fs');
        const A = globalThis.__grabs[a], B = globalThis.__grabs[b];
        const size = A.getSize(), pa = A.toBitmap(), pb = B.toBitmap();
        if (pa.length !== pb.length) return { error: `sizes differ: ${JSON.stringify(size)} vs ${JSON.stringify(B.getSize())}` };
        const diff = Buffer.alloc(pa.length);
        let within = 0, over10 = 0, total = 0, maxDiff = 0;
        for (let p = 0; p < pa.length; p += 4) {
          const d = Math.max(Math.abs(pa[p] - pb[p]), Math.abs(pa[p + 1] - pb[p + 1]), Math.abs(pa[p + 2] - pb[p + 2]));
          if (d <= 2) within++;
          if (d > 10) over10++;
          total += d;
          maxDiff = Math.max(maxDiff, d);
          const v = Math.min(255, d * 8);
          diff[p] = v; diff[p + 1] = v; diff[p + 2] = v; diff[p + 3] = 255;
        }
        fs.writeFileSync(`${file}-painted.png`, A.toPNG());
        fs.writeFileSync(`${file}-live.png`, B.toPNG());
        fs.writeFileSync(`${file}-diff.png`, nativeImage.createFromBitmap(diff, size).toPNG());
        const pixels = pa.length / 4;
        return { size, withinTwoLevelsPct: Math.round(within / pixels * 10000) / 100, overTenLevelsPct: Math.round(over10 / pixels * 10000) / 100, meanDiff: Math.round(total / pixels * 100) / 100, maxDiff };
      }, { a, b, file });
    }
    // A page promise with a deadline, so a hang names itself instead of stalling the driver.
    const inPage = async (label, fn, arg, timeout = 20000) => {
      const result = await page.evaluate(`Promise.race([(${fn})(${JSON.stringify(arg ?? null)}).then(v => ({ v })), new Promise(r => setTimeout(() => r({ timedOut: true }), ${timeout}))])`);
      if (result?.timedOut) {
        const state = await page.evaluate(() => ({ errors: window.__perfErrors, live: window.__gpuCanvas?.live(), layer: document.querySelectorAll('[data-gpu-canvas-live] .react-flow__node').length }));
        throw new Error(`Timed out after ${timeout} ms waiting for ${label}: ${JSON.stringify(state)}`);
      }
      return result?.v;
    };
    const section = async (name, fn) => {
      if (!checks.includes(name)) return;
      try { report[name] = await fn(); }
      catch (error) {
        const shown = await page.evaluate(() => document.body?.innerText.slice(0, 600)).catch(e => `(page unreadable: ${e.message})`);
        console.error(`The ${name} check failed: ${error.message}\nThe page showed: ${shown}`);
        report[name] = { error: error.message, shown };
      }
      await save();
    };
    // A view at 100% at the top-left of the first copy.
    const home = () => page.evaluate(() => window.__gpuCanvas.setView({ zoom: 1, x: 40, y: 80 }));

    await ready();
    report.canvas = await page.evaluate(() => window.__gpuCanvas.info());
    log(`GPU canvas up: ${liveMode ? 'live mode, no painter' : `${browserPath ? 'snapshot painter, ' : ''}${JSON.stringify(report.canvas.budget)}`}`);

    // Opening: the loading screen, the first paint.
    await section('open', async () => {
      const result = await openWorkflow('open');
      result.processes = await processMemory();
      await page.mouseMove(2, 2);
      await fs.writeFile(path.join(shots, 'open.png'), await page.screenshot());
      await checkErrors();
      return result;
    });

    // Reopening: a fresh page over the same disk cache.
    await section('reopen', async () => {
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 3000)));
      await ready();
      return openWorkflow('reopen');
    });
    if (!checks.includes('open') && !checks.includes('reopen')) await openWorkflow('open');

    // Pans while the view's tier is painting: a jump starts painting, then a pan begins.
    await section('pan', async () => {
      const traced = [], results = [];
      for (let round = 0; round < 3; round++) {
        await page.evaluate(round => { const v = window.__gpuCanvas.view(); window.__gpuCanvas.setView({ zoom: 1, x: v.x - 4000 - round * 3000, y: v.y - 1500 }); }, round);
        await delay(150);
        results.push(await measure('pan-sweep', `${liveMode ? 'pan-into-view' : 'pan-while-painting'}-${round + 1}`, traced));
        await delay(1000);
      }
      const result = traceResult(traced, results);
      result.yielded = await page.evaluate(() => window.__gpuCanvas.stats.summary().samples['painter.yielded'] ?? null);
      if (liveMode) result.live = await page.evaluate(() => window.__gpuCanvas.live().length);
      await checkErrors();
      return result;
    });

    // A store write at full graph size: a marquee selecting one node more each frame, as a Mac's left drag on
    // empty canvas does. Each write runs every store selector over the graph; the time to the next frame shows it.
    await section('writes', async () => {
      await page.evaluate(() => window.__gpuCanvas.fit());
      await delay(1500);
      if (flag('--profile')) await debug('Profiler.start');
      // Profile samples are matched to the writes by a busy marker of known page time.
      const calibration = flag('--profile') ? await page.evaluate(() => {
        const at = performance.now();
        (function nbCalibrate() { while (performance.now() - at < 30); })();
        return at;
      }) : null;
      const { ms, sync, windows, marquee, idle } = await page.evaluate(async () => {
        const ids = window.__gpuCanvas.nodeIds().slice(0, 40), times = [], sync = [], windows = [], marquee = [];
        const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
        // The write and the React work it schedules, without the wait for a frame (which on a software GPU is the
        // scene's draw, not the page's work)
        const task = () => new Promise(resolve => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0); });
        await frame();
        for (let k = 1; k <= ids.length; k++) {
          await frame();
          const t0 = performance.now();
          window.__gpuCanvas.select(ids.slice(0, k));
          sync.push(performance.now() - t0);
          await task();
          const t1 = performance.now();
          times.push(t1 - t0);
          windows.push([t0, t1]);
        }
        window.__gpuCanvas.select([]);
        // The same steps inside a marquee, which draws what it takes and makes it live only as it ends
        await frame();
        window.__gpuCanvas.marquee(true);
        for (let k = 1; k <= ids.length; k++) {
          await frame();
          const t0 = performance.now();
          window.__gpuCanvas.select(ids.slice(0, k));
          await task();
          const t1 = performance.now();
          marquee.push(t1 - t0);
          windows.push([t0, t1]);
        }
        window.__gpuCanvas.marquee(false);
        window.__gpuCanvas.select([]);
        // The same wait with no write: what the page does in that time anyway (the painter, a frame)
        const idle = [];
        for (let k = 1; k <= ids.length; k++) {
          await frame();
          const t0 = performance.now();
          await task();
          idle.push(performance.now() - t0);
        }
        return { ms: times, sync, windows, marquee, idle };
      });
      let profileTop;
      if (flag('--profile')) {
        const { profile } = await debug('Profiler.stop');
        await fs.writeFile(path.join(shots, `writes-${Date.now()}.cpuprofile`), JSON.stringify(profile));
        profileTop = inclusiveWithin(profile, calibration, windows.slice(0, ms.length), 40);
        const marqueeTop = inclusiveWithin(profile, calibration, windows.slice(ms.length), 40);
        log(`  writes: inclusive time inside the selection writes\n${profileTop.map(f => `    ${String(f.ms).padStart(6)} ms  ${f.fn}`).join('\n')}`);
        log(`  writes: inclusive time inside the marquee steps\n${marqueeTop.map(f => `    ${String(f.ms).padStart(6)} ms  ${f.fn}`).join('\n')}`);
      }
      const quantile = (list, q) => { const sorted = [...list].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10; };
      log(`  selection write and its renders: p50 ${quantile(ms, 0.5)} ms, p95 ${quantile(ms, 0.95)} ms over ${ms.length} writes; the write itself p50 ${quantile(sync, 0.5)} ms`);
      log(`  marquee step and its renders: p50 ${quantile(marquee, 0.5)} ms, p95 ${quantile(marquee, 0.95)} ms; the same wait with no write p50 ${quantile(idle, 0.5)} ms`);
      return { ms, sync, marquee, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), syncP50: quantile(sync, 0.5), marqueeP50: quantile(marquee, 0.5), marqueeP95: quantile(marquee, 0.95), idle, idleP50: quantile(idle, 0.5), profileTop };
    });

    // A change to a node not being edited, shown within 100 ms.
    await section('change', async () => {
      await home();
      await delay(1500);
      const prompts = await page.evaluate(() => window.__gpuCanvas.nodeIds().filter(id => {
        const r = window.__gpuCanvas.nodeRect(id);
        return r.type === 'prompt' && r.x > 0 && r.y > 0 && r.x + r.width < innerWidth && r.y + r.height < innerHeight;
      }).slice(0, 5));
      await page.evaluate(() => window.__gpuCanvas.stats.reset());
      for (const [k, id] of prompts.entries()) {
        await page.evaluate(({ id, k }) => window.__gpuCanvas.change(id, { prompt: `Changed while not being edited, take ${k + 1}: a lighthouse at dusk` }), { id, k });
        await delay(600);
        const status = await page.evaluate(() => ({ ...window.__gpuCanvas.painter(), shown: (window.__gpuCanvas.stats.samples['painter.changeToShownMs'] ?? []).length }));
        log(`  take ${k + 1}: ${status.shown} shown so far, ${status.queued} queued, ${status.running ? 'painting' : 'idle'}`);
      }
      const samples = await page.evaluate(() => window.__gpuCanvas.stats.samples['painter.changeToShownMs'] ?? []);
      const downstream = await page.evaluate(() => window.__gpuCanvas.stats.samples['painter.downstreamToShownMs'] ?? []);
      const painter = await page.evaluate(() => window.__gpuCanvas.stats.summary().samples);
      log(`change to shown: ${samples.map(Math.round).join(', ')} ms; what they feed: ${downstream.map(Math.round).join(', ')} ms`);
      return { prompts, changeToShownMs: samples, downstreamToShownMs: downstream, painter, pass: samples.length > 0 && samples.every(ms => ms <= 100) };
    });

    // Painted against live, one node of each type, at 100% on whole pixels.
    await section('fidelity', async () => {
      const sample = await page.evaluate(() => {
        const seen = new Map();
        for (const id of window.__gpuCanvas.nodeIds()) { const r = window.__gpuCanvas.nodeRect(id); if (!seen.has(r.type)) seen.set(r.type, id); }
        return [...seen.values()];
      });
      await fs.mkdir(path.join(shots, 'fidelity'), { recursive: true });
      if (option('--probe', '')) await page.evaluate(({ ids, types }) => window.__gpuCanvas.probe([...ids, ...types.split(',').map(t => `type:${t}`)]), { ids: sample, types: option('--probe', '') });
      const results = [];
      for (const id of sample) {
        await page.evaluate(id => { const c = window.__gpuCanvas, r = c.nodeRect(id), v = c.view(); c.setView({ zoom: 1, x: 240 - (r.x - v.x) / v.zoom, y: 160 - (r.y - v.y) / v.zoom }); }, id);
        await page.mouseMove(2, 2);
        await inPage('the live layer emptied', () => window.__gpuCanvas.setLive([]));
        await delay(300);
        await inPage(`${id} painted`, id => window.__gpuCanvas.paintNow(id), id);
        await delay(250);
        const rect = await page.evaluate(id => window.__gpuCanvas.paintRect(id), id);
        const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        const painted = await grab(box);
        const swapStarted = Date.now();
        await inPage(`${id} live`, id => window.__gpuCanvas.setLive([id]), id);
        const swapMs = Date.now() - swapStarted;
        await delay(250);
        // A live node can still be swapping its image (a thumbnail for the
        // full one, deferred while the page is busy): grab it once its images
        // have loaded and held the same source for 300 ms.
        await page.waitFor(id => {
          const node = [...document.querySelectorAll(`.react-flow__node[data-id="${CSS.escape(id)}"]`)].find(n => !n.closest('[data-gpu-canvas-sheet]'));
          const images = node ? [...node.querySelectorAll('img')] : [];
          const signature = images.map(img => `${img.currentSrc || img.src}|${img.complete}`).join('\n');
          const w = (window.__liveImages ??= {});
          if (w.id !== id || w.signature !== signature) Object.assign(w, { id, signature, since: performance.now() });
          return images.every(img => img.complete) && performance.now() - w.since >= 300;
        }, id, { message: `${id}'s live images to settle`, timeout: 5000 }).catch(() => log(`  ${id}: live images still changing after 5 s`));
        // A live video plays; its painted picture is the first frame.
        await page.evaluate(id => Promise.all([...document.querySelectorAll(`.react-flow__node[data-id="${CSS.escape(id)}"] video`)]
          .filter(video => !video.closest('[data-gpu-canvas-sheet]'))
          .map(video => new Promise(resolve => { video.pause(); if (video.currentTime === 0) return resolve(); video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 0; setTimeout(resolve, 2000); }))), id);
        await delay(150);
        const live = await grab(box);
        const type = await page.evaluate(id => window.__gpuCanvas.nodeRect(id).type, id);
        const compared = await compare(painted, live, path.join(shots, 'fidelity', type));
        if (flag('--fresh-paint')) {
          await inPage('the live layer emptied', () => window.__gpuCanvas.setLive([]));
          await inPage(`${id} repainted`, id => window.__gpuCanvas.repaint(id), id);
          await delay(250);
          compared.fresh = await compare(await grab(box), live, path.join(shots, 'fidelity', `${type}-fresh`));
        }
        // Photos resample a little differently on the sheet (a different decode or
        // thumbnail): many pixels a level or two off, almost none far off. A
        // misplaced or stale node puts whole edges and glyphs far off.
        const pass = compared.withinTwoLevelsPct >= 99.5 || (compared.overTenLevelsPct <= 0.5 && compared.meanDiff <= 1);
        results.push({ id, type, swapMs, ...compared, pass });
        log(`  ${type}: ${compared.withinTwoLevelsPct ?? compared.error}% of pixels within 2 levels, ${compared.overTenLevelsPct}% over 10, mean ${compared.meanDiff}${compared.fresh ? ` (painted alone: ${compared.fresh.withinTwoLevelsPct}%, ${compared.fresh.overTenLevelsPct}% over 10)` : ''}${pass ? '' : ' FAIL'}`);
      }
      await page.evaluate(() => window.__gpuCanvas.setLive([]));
      await checkErrors();
      const probe = option('--probe', '') ? await page.evaluate(() => window.__gpuCanvas.probeLog()) : undefined;
      return { results, probe, pass: results.every(r => r.pass) };
    });

    // Image tiers: 100% to 5% and back, then jumps; atlas memory and time until sharp.
    await section('tiers', async () => {
      await home();
      await page.mouseMove(2, 2);
      await delay(1500);
      const sharpWithin = Number(option('--sharp-timeout', 10000));
      const settleAt = async view => {
        const t0 = Date.now();
        await page.evaluate(view => window.__gpuCanvas.setView(view), view);
        let sharpness;
        for (;;) {
          sharpness = await page.evaluate(() => window.__gpuCanvas.sharpness());
          if (sharpness.sharp >= sharpness.visible || Date.now() - t0 > sharpWithin) break;
          await delay(16);
        }
        const status = await page.evaluate(() => window.__gpuCanvas.painter());
        return { view, sharpMs: sharpness.sharp >= sharpness.visible ? Date.now() - t0 : null, ...sharpness, atlasLayers: status.atlasLayers, atlasMB: status.atlasMB, evicted: status.evicted, atlasFull: status.atlasFull };
      };
      const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const view = await page.evaluate(() => window.__gpuCanvas.view());
      const center = { x: (width / 2 - view.x) / view.zoom, y: (height / 2 - view.y) / view.zoom };
      const about = zoom => ({ zoom, x: width / 2 - center.x * zoom, y: height / 2 - center.y * zoom });
      const steps = [], jumps = [];
      for (const [k, zoom] of [1, 0.5, 0.25, 0.1, 0.25, 0.5, 1].entries()) {
        const step = await settleAt(about(zoom));
        steps.push(step);
        if (k <= 3) await fs.writeFile(path.join(shots, `zoom-${Math.round(zoom * 100)}.png`), await page.screenshot());
        log(`  ${Math.round(zoom * 100)}%: ${step.sharp}/${step.visible} sharp at ${step.tier}x in ${step.sharpMs ?? `>${sharpWithin}`} ms`);
      }
      const bounds = await page.evaluate(() => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const c = window.__gpuCanvas, v = c.view();
        for (const id of c.nodeIds()) { const n = c.nodeRect(id); const x = (n.x - v.x) / v.zoom, y = (n.y - v.y) / v.zoom; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { x0, y0, x1, y1 }; });
      for (const zoom of [1, 0.25]) for (const to of [{ x: bounds.x1 - 1200, y: bounds.y1 - 800 }, { x: bounds.x0 + 400, y: bounds.y0 + 300 }, { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 }]) {
        await delay(300);
        const jump = await settleAt({ zoom, x: width / 2 - to.x * zoom, y: height / 2 - to.y * zoom });
        jumps.push(jump);
        log(`  jump at ${Math.round(zoom * 100)}%: ${jump.sharp}/${jump.visible} sharp in ${jump.sharpMs ?? `>${sharpWithin}`} ms`);
      }
      const summary = await page.evaluate(() => window.__gpuCanvas.stats.summary());
      for (const f of summary.longFrames ?? []) log(`  long frame: ${f.ms} ms, ending in "${f.phase}"`);
      for (const f of summary.loafs ?? []) log(`  long animation frame: ${f.ms} ms (blocking ${f.blockingMs}, render ${f.renderMs}, layout ${f.layoutMs}) in "${f.phase}"; scripts: ${f.scripts.map(s => `${s.ms} ms${s.layoutMs ? ` (layout ${s.layoutMs})` : ""} ${s.fn || s.invoker} ${s.at}`).join(' | ') || 'none'}`);
      const verdict = { atMost256MB: Math.max(...steps.map(s => s.atlasMB)) <= 256, jumpsSharpWithin500ms: jumps.every(j => j.sharpMs != null && j.sharpMs <= 500) };
      await checkErrors();
      return { steps, jumps, verdict: { ...verdict, pass: Object.values(verdict).every(Boolean) }, stats: summary };
    });

    // The scene: every node on screen, pans and zooms.
    const gestureNames = option('--gestures', ['pan-sweep', 'zoom-wheel', ...(process.platform === 'darwin' ? ['pan-wheel'] : [])].join(',')).split(',');
    await section('scene', async () => {
      // The scene's own frame rate: wait for the painter's background work to finish (pan-while-painting measures it busy).
      const idleStarted = Date.now();
      await page.waitFor(() => { const p = window.__gpuCanvas.painter(); return !p || (!p.running && p.queued === 0); }, null, { timeout: 180000, interval: 500, message: 'the painter to finish' })
        .then(() => log(`  painter idle after ${Date.now() - idleStarted} ms`), () => log('  painter still busy after 180 s'));
      // --scene-variants base,subtree,sheet,live,chrome,draw,bare: repeat the gestures with a part of the page taken away
      // (bare takes all of them; a+b takes both), to find what costs frames. Labels carry the variant.
      const variants = option('--scene-variants', 'base').split(',');
      const PARTS = { subtree: ['sheet', 'subtree'], sheet: ['sheet'], live: ['live'], chrome: ['chrome'], draw: ['draw'], navigator: ['navigator'], groups: ['groups'], marquee: ['marquee'], bare: ['sheet', 'subtree', 'live', 'chrome'] };
      const zooms = option('--scene-zooms', browserPath ? 'fit,0.5,0.3' : 'fit').split(',');
      const traced = [], results = [];
      for (const zoomSpec of zooms) for (const variant of variants) {
        const parts = variant.split('+').flatMap(v => PARTS[v] || []);
        await page.evaluate(parts => { for (const part of parts) window.__gpuCanvas.diagnose(part, false); }, parts);
        for (let round = 0; round < 2; round++) for (const name of gestureNames) {
          // Every gesture starts from the same place: nothing selected (a marquee leaves its nodes selected,
          // and selected nodes are live), the whole graph in view, and the view still there after the wait.
          for (let attempt = 0; attempt < 3; attempt++) {
            const fitted = await page.evaluate(zoom => {
              const c = window.__gpuCanvas;
              c.select([]);
              c.fit();
              if (zoom !== 'fit') {
                const v = c.view(), box = document.querySelector('[data-gpu-canvas]').getBoundingClientRect(), width = box.width, height = box.height, z = Number(zoom);
                // About the fitted view's centre, at that zoom.
                const cx = (width / 2 - v.x) / v.zoom, cy = (height / 2 - v.y) / v.zoom;
                c.setView({ zoom: z, x: width / 2 - cx * z, y: height / 2 - cy * z });
              }
              return c.view().zoom;
            }, zoomSpec);
            // What moves the view after it was set, should anything.
            await page.evaluate(() => { window.__viewMoves = []; window.__unwatchView = window.__gpuCanvas.watchView((view, fromFlow, stack) => {
              if (window.__viewMoves.length < 5) window.__viewMoves.push({ zoom: +view.zoom.toFixed(4), fromFlow, stack: stack.split('\n').slice(2, 10).map(l => l.trim()).join(' < ') });
            }); });
            await delay(1500);
            const { zoom, moves } = await page.evaluate(() => { window.__unwatchView(); return { zoom: window.__gpuCanvas.view().zoom, moves: window.__viewMoves }; });
            if (Math.abs(zoom - fitted) < 1e-6) break;
            log(`  ${name}: the view moved from ${fitted.toFixed(3)} to ${zoom.toFixed(3)} after fitting; fitting again`);
            for (const move of moves.slice(0, 1)) log(`    to ${move.zoom}${move.fromFlow ? ' following the live flow' : ''}: ${move.stack}`);
          }
          const at = zoomSpec === 'fit' ? '' : `@${zoomSpec}`;
          if (!round && name === gestureNames[0]) {
            // What the page keeps live at this view: those are what a pan moves besides the scene.
            const held = await page.evaluate(() => {
              const types = {};
              for (const id of window.__gpuCanvas.live()) { const t = window.__gpuCanvas.nodeRect(id)?.type ?? '?'; types[t] = (types[t] ?? 0) + 1; }
              const count = s => document.querySelectorAll(s).length;
              return { zoom: +window.__gpuCanvas.view().zoom.toFixed(3), types, nodes: count('.react-flow__node'), edges: count('.react-flow__edge'), canvases: count('canvas'), media: count('video, audio'), elements: count('*') };
            });
            log(`  live at ${variant}${at}: ${JSON.stringify(held)}`);
          }
          results.push(await measure(name, `${variant === 'base' ? name : `${name}:${variant}`}${at}`, traced));
        }
        if (variant === 'base') await fs.writeFile(path.join(shots, `fit${zoomSpec === 'fit' ? '' : `-${zoomSpec}`}.png`), await page.screenshot());
        await page.evaluate(parts => { for (const part of [...parts].reverse()) window.__gpuCanvas.diagnose(part, true); }, parts);
      }
      await checkErrors();
      return { ...traceResult(traced, results), info: await page.evaluate(() => window.__gpuCanvas.info()) };
    });

    // Input latency: a pan at 25%, where the most nodes are in view at full detail.
    await section('latency', async () => {
      const v = await page.evaluate(() => window.__gpuCanvas.view());
      await page.evaluate(v => window.__gpuCanvas.setView({ zoom: 0.25, x: v.x, y: v.y }), v);
      await delay(2000);
      const traced = [], results = [];
      for (let round = 0; round < 2; round++) results.push(await measure('pan-sweep', 'gpu-pan', traced));
      const trace = analyzeGestures(traced);
      console.log(`\n${formatReport(trace)}\n`);
      return { gpuCanvas: { trace: trace.summary, pageInputLatency: results.map(r => r.pageStats?.samples['input.latencyMs'] ?? null) } };
    });
    log(`Saved ${output}`);
  } catch (error) {
    // What the page and the app showed when it failed.
    if (app) {
      report.failure = { message: error.message, appOutput: app.output().slice(-6000),
        page: await app.page.evaluate(() => ({ url: location.href, text: document.body?.innerText.slice(0, 2000), errors: window.__perfErrors ?? null })).catch(e => String(e)) };
      console.error(`App output:\n${report.failure.appOutput}\nPage: ${JSON.stringify(report.failure.page, null, 2)}`);
    }
    throw error;
  } finally {
    await save().catch(() => {});
    if (app) {
      await app.close();
      for (let wait = 0; wait < 20 && strayElectron().length > strays.length; wait++) await delay(250);
    }
    const remove = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(error => console.warn(`Could not remove ${dir}: ${error.message}`));
    await remove(profile);
    await remove(traceDir);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
