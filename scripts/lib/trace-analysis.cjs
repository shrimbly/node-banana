// Turns a Chromium trace (electron/lib/perf-trace.cjs categories) into what a
// person feels during a drag or pan: frames the screen actually presented,
// vsyncs missed while input was arriving, time from input to the frame that
// showed it, and which threads were busy. Animation-frame callback counts and
// CDP task totals miss compositor and GPU drops; presentation does not.
//
// Gestures are found from the input itself (drag moves and wheel events with
// no gap over gapMs), so real-use traces need no harness. A gesture is named by
// the last 'banana:gesture <name>' mark before it (the runner), or else the
// 'banana:auto <what>' mark the page probe writes on pointerdown/wheel.
const fs = require('node:fs');

const GESTURE_INPUT = new Set(['MOUSE_DRAGGED', 'MOUSE_WHEEL']);
const PRESENTED = new Set(['STATE_PRESENTED_ALL', 'STATE_PRESENTED_PARTIAL']);
const THREADS = {
  rendererMain: ['Renderer', 'CrRendererMain'],
  compositor: ['Renderer', 'Compositor'],
  browserMain: ['Browser', 'CrBrowserMain'],
  gpuMain: ['GPU Process', 'CrGpuMain'],
  viz: ['GPU Process', 'VizCompositorThread'],
  server: ['Utility', 'node.CrUtilityMain'],
};

function readTrace(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.traceEvents;
}

// Nearest rank: the tail percentiles that describe jank are never rounded down.
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] : null;
const round = (value, places = 2) => value == null ? null : Math.round(value * 10 ** places) / 10 ** places;
const median = values => percentile([...values].sort((a, b) => a - b), .5);

// Async spans reuse their local ids once closed, so a span's stages are the
// events with its id between its own begin and end, in time order.
function spans(events, pid, root) {
  const byId = new Map();
  for (const event of events) {
    if (event.pid !== pid || !event.id2 || (event.ph !== 'b' && event.ph !== 'e')) continue;
    const key = `${event.cat}|${event.id2.local ?? event.id2.global}`;
    (byId.get(key) || byId.set(key, []).get(key)).push(event);
  }
  const result = [];
  for (const list of byId.values()) {
    list.sort((a, b) => a.ts - b.ts || (a.ph === 'b' ? -1 : 1));
    let open;
    for (const event of list) {
      if (event.name === root && event.ph === 'b') open = { begin: event, stages: {} };
      else if (!open) continue;
      else if (event.name === root) { open.end = event.ts; result.push(open); open = undefined; }
      else (open.stages[event.name] ||= {})[event.ph] = event.ts;
    }
  }
  return result.sort((a, b) => a.begin.ts - b.begin.ts);
}

function threadIds(events) {
  const processes = new Map(), threads = [];
  for (const event of events) {
    if (event.ph !== 'M') continue;
    if (event.name === 'process_name') processes.set(event.pid, event.args?.name);
    if (event.name === 'thread_name') threads.push({ pid: event.pid, tid: event.tid, name: event.args?.name });
  }
  return { processes, threads };
}

// Merged task intervals per thread, so nested run loops are not counted twice.
function taskIntervals(events, wanted) {
  const byThread = new Map([...wanted].map(key => [key, []]));
  for (const event of events) {
    if (event.ph !== 'X' || event.name !== 'ThreadControllerImpl::RunTask') continue;
    byThread.get(`${event.pid}:${event.tid}`)?.push([event.ts, event.ts + (event.dur || 0)]);
  }
  for (const [key, list] of byThread) {
    list.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of list) {
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
    }
    byThread.set(key, merged);
  }
  return byThread;
}

function analyzeTrace(events, { gapMs = 250, minInputs = 8 } = {}) {
  const { processes, threads } = threadIds(events);
  const latencyCount = new Map();
  for (const event of events) if (event.name === 'EventLatency' && event.ph === 'b') latencyCount.set(event.pid, (latencyCount.get(event.pid) || 0) + 1);
  const renderer = [...latencyCount].filter(([pid]) => processes.get(pid) === 'Renderer').sort((a, b) => b[1] - a[1])[0]?.[0];
  if (renderer == null) throw new Error('The trace has no input latency events from a renderer. Was it recorded with electron/lib/perf-trace.cjs categories while the canvas received input?');
  const frames = spans(events, renderer, 'PipelineReporter').map(span => {
    const report = span.begin.args?.frame_reporter || {};
    return { begin: span.begin.ts, end: span.end, state: report.state, host: report.layer_tree_host_id,
      commit: span.stages.SendBeginMainFrameToCommit?.e ?? span.stages.Commit?.e,
      checkerboarded: !!(report.checkerboarded_needs_raster || report.checkerboarded_needs_record || report.has_missing_content) };
  });
  if (!frames.length) throw new Error('The trace has no PipelineReporter frames. Record with the disabled-by-default-devtools.timeline.frame category.');
  // A renderer can host more than one compositor; the canvas is the busiest.
  const hostCounts = new Map();
  for (const frame of frames) hostCounts.set(frame.host, (hostCounts.get(frame.host) || 0) + 1);
  const host = [...hostCounts].sort((a, b) => b[1] - a[1])[0][0];
  const canvasFrames = frames.filter(frame => frame.host === host);
  const presented = canvasFrames.filter(frame => PRESENTED.has(frame.state)).sort((a, b) => a.end - b.end);
  const committed = presented.filter(frame => frame.commit != null).sort((a, b) => a.commit - b.commit);
  const inputs = spans(events, renderer, 'EventLatency').map(span => {
    const latency = span.begin.args?.event_latency || {};
    return { type: latency.event_type, generated: span.begin.ts, handled: span.stages.RendererMainProcessing?.e ?? span.end, vsyncMs: latency.vsync_interval_ms };
  });
  const vsyncMs = median(inputs.map(input => input.vsyncMs).filter(Number.isFinite)) || median(presented.slice(1).map((frame, i) => (frame.end - presented[i].end) / 1000));
  const marks = events.filter(event => event.cat === 'blink.user_timing' && event.ph === 'I' && /^banana:(gesture|auto) /.test(event.name))
    .map(event => ({ ts: event.ts, explicit: event.name.startsWith('banana:gesture '), label: event.name.replace(/^banana:(gesture|auto) /, '') })).sort((a, b) => a.ts - b.ts);
  // Long animation frames arrive as user timing measures, back-dated to the
  // frame's start, each named after its slowest script.
  const longFrames = [], openFrames = new Map();
  const measures = events.filter(event => event.cat === 'blink.user_timing' && (event.ph === 'b' || event.ph === 'e') && event.name?.startsWith('banana:loaf '));
  for (const event of measures.sort((a, b) => a.ts - b.ts)) {
    const key = `${event.pid}|${event.id2?.local ?? event.id2?.global ?? event.id}|${event.name}`;
    if (event.ph === 'b') openFrames.set(key, event.ts);
    else if (openFrames.has(key)) { longFrames.push({ ts: openFrames.get(key), end: event.ts, name: event.name.slice('banana:loaf '.length) }); openFrames.delete(key); }
  }
  const threadKeys = new Map();
  for (const [name, [processName, threadName]] of Object.entries(THREADS)) {
    const pids = [...processes].filter(([, value]) => value === processName).map(([pid]) => pid);
    const pid = name === 'rendererMain' || name === 'compositor' ? renderer : pids[0];
    const thread = threads.find(t => t.pid === pid && t.name === threadName) || threads.find(t => pids.includes(t.pid) && t.name === threadName);
    if (thread) threadKeys.set(name, `${thread.pid}:${thread.tid}`);
  }
  const tasks = taskIntervals(events, new Set(threadKeys.values()));

  const gestureInputs = inputs.filter(input => GESTURE_INPUT.has(input.type));
  const gestures = [];
  for (const input of gestureInputs) {
    const current = gestures.at(-1);
    if (current && (input.generated - current.inputs.at(-1).generated) / 1000 <= gapMs) current.inputs.push(input);
    else gestures.push({ inputs: [input] });
  }
  let previousEnd = -Infinity;
  const measured = [];
  for (const gesture of gestures.filter(g => g.inputs.length >= minInputs)) {
    const start = gesture.inputs[0].generated, last = gesture.inputs.at(-1).generated;
    const end = last + vsyncMs * 2000;
    const named = marks.filter(mark => mark.ts > previousEnd && mark.ts <= start + 50_000);
    previousEnd = last;
    const label = (named.filter(mark => mark.explicit).at(-1) || named.at(-1))?.label || gesture.inputs[0].type.toLowerCase();
    measured.push(measureWindow({ label, start, end, last, inputs: gesture.inputs, canvasFrames, presented, committed, vsyncMs, tasks, threadKeys, longFrames }));
  }
  const byLabel = {};
  for (const gesture of measured) (byLabel[gesture.label] ||= []).push(gesture);
  return {
    vsyncMs: round(vsyncMs), refreshHz: round(1000 / vsyncMs, 1),
    gestures: measured.map(strip),
    summary: Object.fromEntries(Object.entries(byLabel).map(([label, list]) => [label, strip(combine(label, list, vsyncMs))])),
  };
}

function measureWindow({ label, start, end, last, inputs, canvasFrames, presented, committed, vsyncMs, tasks, threadKeys, longFrames }) {
  const durationMs = (last - start) / 1000;
  const inWindow = canvasFrames.filter(frame => frame.begin >= start && frame.begin <= end);
  const shown = presented.filter(frame => frame.end >= start && frame.end <= end);
  const intervals = shown.slice(1).map((frame, i) => (frame.end - shown[i].end) / 1000);
  // The frame that showed an input is the first presented frame committed
  // after the main thread handled it; one later than 250 ms showed nothing.
  const latencies = [];
  let unanswered = 0;
  for (const input of inputs) {
    let low = 0, high = committed.length;
    while (low < high) { const mid = (low + high) >> 1; if (committed[mid].commit < input.handled) low = mid + 1; else high = mid; }
    const frame = committed[low];
    if (frame && frame.end - input.generated <= 250_000) latencies.push((frame.end - input.generated) / 1000); else unanswered++;
  }
  const threads = {};
  for (const [name, key] of threadKeys) {
    let busy = 0, longest = 0, over16 = 0, over50 = 0;
    for (const [taskStart, taskEnd] of tasks.get(key) || []) {
      if (taskEnd < start || taskStart > end) continue;
      busy += Math.min(taskEnd, end) - Math.max(taskStart, start);
      const ms = (taskEnd - taskStart) / 1000;
      longest = Math.max(longest, ms);
      if (ms > 16) over16++;
      if (ms > 50) over50++;
    }
    threads[name] = { busyMs: busy / 1000, longestTaskMs: longest, tasksOver16ms: over16, tasksOver50ms: over50 };
  }
  return { label, durationMs, windowMs: (end - start) / 1000, inputs: inputs.length, intervals, latencies, unanswered, threads,
    frames: count(inWindow), presented: shown.length,
    longFrames: longFrames.filter(frame => frame.end != null && frame.end >= start && frame.ts <= end).map(frame => ({ ms: (frame.end - frame.ts) / 1000, name: frame.name })),
    vsyncMs };
}

function count(frames) {
  const states = { presented: 0, partial: 0, dropped: 0, noUpdate: 0, checkerboarded: 0 };
  for (const frame of frames) {
    if (frame.state === 'STATE_PRESENTED_ALL') states.presented++;
    else if (frame.state === 'STATE_PRESENTED_PARTIAL') states.partial++;
    else if (frame.state === 'STATE_DROPPED') states.dropped++;
    else if (frame.state === 'STATE_NO_UPDATE_DESIRED') states.noUpdate++;
    if (frame.checkerboarded) states.checkerboarded++;
  }
  return states;
}

function combine(label, list, vsyncMs) {
  const threads = {};
  for (const gesture of list) for (const [name, stats] of Object.entries(gesture.threads)) {
    const total = threads[name] ||= { busyMs: 0, longestTaskMs: 0, tasksOver16ms: 0, tasksOver50ms: 0 };
    total.busyMs += stats.busyMs; total.longestTaskMs = Math.max(total.longestTaskMs, stats.longestTaskMs);
    total.tasksOver16ms += stats.tasksOver16ms; total.tasksOver50ms += stats.tasksOver50ms;
  }
  const frames = { presented: 0, partial: 0, dropped: 0, noUpdate: 0, checkerboarded: 0 };
  for (const gesture of list) for (const key of Object.keys(frames)) frames[key] += gesture.frames[key];
  return { label, gestures: list.length, durationMs: list.reduce((sum, g) => sum + g.durationMs, 0), windowMs: list.reduce((sum, g) => sum + g.windowMs, 0),
    inputs: list.reduce((sum, g) => sum + g.inputs, 0), presented: list.reduce((sum, g) => sum + g.presented, 0),
    intervals: list.flatMap(g => g.intervals), latencies: list.flatMap(g => g.latencies), unanswered: list.reduce((sum, g) => sum + g.unanswered, 0),
    frames, threads, longFrames: list.flatMap(g => g.longFrames), vsyncMs };
}

// Raw samples become the figures a report compares.
function strip(window) {
  const intervals = [...window.intervals].sort((a, b) => a - b);
  const latencies = [...window.latencies].sort((a, b) => a - b);
  const { vsyncMs } = window;
  const missed = window.intervals.reduce((sum, ms) => sum + Math.max(0, Math.round(ms / vsyncMs) - 1), 0);
  const threads = Object.fromEntries(Object.entries(window.threads).map(([name, stats]) => [name, {
    busyPct: round(stats.busyMs / window.windowMs * 100, 1), longestTaskMs: round(stats.longestTaskMs, 1), tasksOver16ms: stats.tasksOver16ms, tasksOver50ms: stats.tasksOver50ms }]));
  const longFrames = [...window.longFrames].sort((a, b) => b.ms - a.ms);
  return {
    label: window.label, ...(window.gestures ? { gestures: window.gestures } : {}),
    durationMs: round(window.durationMs, 0), inputs: window.inputs, inputHz: round(window.inputs / (window.durationMs / 1000), 0),
    // Below the display rate some vsyncs have no new input, so misses are expected.
    inputLimited: window.inputs / (window.durationMs / 1000) < 1.2 * 1000 / vsyncMs,
    // Chromium's own smoothness measure: of the frames that had an update to
    // show, the share that missed their vsync entirely or showed it partly.
    droppedPct: round((window.frames.dropped + window.frames.partial) / Math.max(1, window.frames.presented + window.frames.partial + window.frames.dropped) * 100, 1),
    presentedFps: round(window.presented / (window.windowMs / 1000), 1),
    vsyncsPresentedPct: round(window.presented / (window.windowMs / vsyncMs) * 100, 1),
    missedVsyncs: missed, jankyFrames: window.intervals.filter(ms => ms > vsyncMs * 1.5).length,
    frameMs: { p50: round(percentile(intervals, .5)), p95: round(percentile(intervals, .95)), p99: round(percentile(intervals, .99)), max: round(intervals.at(-1)) },
    latencyMs: { p50: round(percentile(latencies, .5), 1), p95: round(percentile(latencies, .95), 1), max: round(latencies.at(-1), 1), unanswered: window.unanswered },
    frames: window.frames, threads,
    longFrames: { count: longFrames.length, totalMs: round(longFrames.reduce((sum, f) => sum + f.ms, 0), 0), worst: longFrames.slice(0, 5).map(f => ({ ms: round(f.ms, 0), name: f.name })) },
  };
}

// Only what analyzeTrace reads, so several gestures' traces fit in memory.
function keepAnalyzed(event) {
  return event.ph === 'M' || event.cat === 'blink.user_timing' || event.name === 'ThreadControllerImpl::RunTask'
    || (!!event.id2 && (event.ph === 'b' || event.ph === 'e') && (event.cat.includes('timeline.frame') || event.cat.includes('input')));
}

// Exclusive time per event name on each named thread. Only meaningful for
// traces recorded with the detail categories (gpu, skia, blink and so on).
function selfTime(events, threadNames = ['CrGpuMain', 'VizCompositorThread', 'CrRendererMain', 'Compositor', 'CrBrowserMain'], top = 12) {
  const { processes, threads } = threadIds(events);
  const label = new Map(threads.filter(t => threadNames.includes(t.name)).map(t => [`${t.pid}:${t.tid}`, `${processes.get(t.pid)}/${t.name}`]));
  const byThread = new Map();
  for (const event of events) {
    const key = label.get(`${event.pid}:${event.tid}`);
    if (key && event.ph === 'X' && event.dur != null) (byThread.get(key) || byThread.set(key, []).get(key)).push(event);
  }
  const result = {};
  for (const [thread, list] of byThread) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const self = new Map(), stack = [];
    for (const event of list) {
      while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop();
      const parent = stack.at(-1);
      if (parent) self.set(parent.name, (self.get(parent.name) || 0) - Math.min(event.dur, parent.ts + parent.dur - event.ts));
      self.set(event.name, (self.get(event.name) || 0) + event.dur);
      stack.push(event);
    }
    const total = [...self.values()].reduce((sum, value) => sum + value, 0);
    result[thread] = { totalMs: round(total / 1000, 0), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, us]) => ({ ms: round(us / 1000, 1), name: name.slice(0, 120) })) };
  }
  return result;
}

function formatReport(report) {
  const lines = [`Display: ${report.refreshHz} Hz (vsync ${report.vsyncMs} ms)`, ''];
  const row = (label, s) => [label.padEnd(18), String(s.gestures ?? 1).padStart(3), String(s.inputHz).padStart(6), `${s.droppedPct}%`.padStart(7),
    String(s.presentedFps).padStart(7), `${s.vsyncsPresentedPct}%`.padStart(7),
    String(s.frameMs.p95).padStart(7), String(s.frameMs.max).padStart(7), String(s.latencyMs.p50).padStart(7), String(s.latencyMs.p95).padStart(7),
    `${s.threads.rendererMain?.busyPct ?? '-'}%`.padStart(7), `${s.threads.browserMain?.busyPct ?? '-'}%`.padStart(7), `${s.threads.gpuMain?.busyPct ?? '-'}%`.padStart(7),
    String(s.longFrames.count).padStart(5), s.inputLimited ? ' input-limited' : ''].join(' ');
  lines.push(['gesture'.padEnd(18), '  n', 'in Hz', 'drop%', 'pres/s', 'vsync%', 'p95 ms', 'max ms', 'lat p50', 'lat p95', 'render', 'browser', 'gpu', 'LoAF'].join(' '));
  for (const [label, summary] of Object.entries(report.summary)) lines.push(row(label, summary));
  const worst = Object.values(report.summary).flatMap(s => s.longFrames.worst.map(f => ({ ...f, label: s.label }))).sort((a, b) => b.ms - a.ms).slice(0, 8);
  if (worst.length) lines.push('', 'Longest animation frames:', ...worst.map(f => `  ${String(f.ms).padStart(5)} ms  ${f.label.padEnd(14)} ${f.name}`));
  return lines.join('\n');
}

module.exports = { readTrace, analyzeTrace, keepAnalyzed, selfTime, formatReport };
