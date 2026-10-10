const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTrace, keepAnalyzed } = require('../../scripts/lib/trace-analysis.cjs');

// A hand-built trace on a 10 ms vsync (times in µs). Renderer pid 1, browser
// pid 2, GPU pid 3. Input every 5 ms; frame k begins at 1000 + 10000k, commits
// 4 ms later and is presented 8 ms after it began. Frame 5 is dropped and
// frame 7 is presented partially.
const RENDERER = 1, MAIN = 10, COMPOSITOR = 11;
function metadata() {
  return [
    { ph: 'M', name: 'process_name', pid: RENDERER, args: { name: 'Renderer' } },
    { ph: 'M', name: 'process_name', pid: 2, args: { name: 'Browser' } },
    { ph: 'M', name: 'process_name', pid: 3, args: { name: 'GPU Process' } },
    { ph: 'M', name: 'thread_name', pid: RENDERER, tid: MAIN, args: { name: 'CrRendererMain' } },
    { ph: 'M', name: 'thread_name', pid: RENDERER, tid: COMPOSITOR, args: { name: 'Compositor' } },
    { ph: 'M', name: 'thread_name', pid: 2, tid: 20, args: { name: 'CrBrowserMain' } },
    { ph: 'M', name: 'thread_name', pid: 3, tid: 30, args: { name: 'CrGpuMain' } },
  ];
}
const INPUT = 'cc,benchmark,input,input.scrolling', FRAME = 'cc,benchmark,disabled-by-default-devtools.timeline.frame';
function input(ts, id, type = 'MOUSE_DRAGGED') {
  // Ids are reused once a span closes, as Chromium does.
  const id2 = { local: `0x${id}` };
  return [
    { ph: 'b', cat: INPUT, name: 'EventLatency', pid: RENDERER, tid: COMPOSITOR, ts, id2, args: { event_latency: { event_type: type, vsync_interval_ms: 10 } } },
    { ph: 'b', cat: INPUT, name: 'RendererMainProcessing', pid: RENDERER, tid: MAIN, ts: ts + 1000, id2 },
    { ph: 'e', cat: INPUT, name: 'RendererMainProcessing', pid: RENDERER, tid: MAIN, ts: ts + 2000, id2 },
    { ph: 'e', cat: INPUT, name: 'EventLatency', pid: RENDERER, tid: MAIN, ts: ts + 2100, id2 },
  ];
}
function frame(k, state = 'STATE_PRESENTED_ALL', host = 1) {
  const begin = 1000 + 10000 * k, id2 = { local: `0x${host}${k % 2}` };
  return [
    { ph: 'b', cat: FRAME, name: 'PipelineReporter', pid: RENDERER, tid: COMPOSITOR, ts: begin, id2, args: { frame_reporter: { state, layer_tree_host_id: host } } },
    { ph: 'b', cat: FRAME, name: 'SendBeginMainFrameToCommit', pid: RENDERER, tid: COMPOSITOR, ts: begin + 1000, id2 },
    { ph: 'e', cat: FRAME, name: 'SendBeginMainFrameToCommit', pid: RENDERER, tid: COMPOSITOR, ts: begin + 4000, id2 },
    { ph: 'e', cat: FRAME, name: 'PipelineReporter', pid: RENDERER, tid: COMPOSITOR, ts: begin + 8000, id2 },
  ];
}
const task = (ts, ms, tid = MAIN, pid = RENDERER) => ({ ph: 'X', cat: 'toplevel', name: 'ThreadControllerImpl::RunTask', pid, tid, ts, dur: ms * 1000 });
const mark = (ts, name) => ({ ph: 'I', cat: 'blink.user_timing', name, pid: RENDERER, tid: MAIN, ts });

function trace() {
  const events = metadata();
  events.push(mark(900, 'banana:gesture drag'));
  for (let i = 0; i < 20; i++) events.push(...input(1000 + 5000 * i, i % 3));
  for (let k = 0; k < 12; k++) events.push(...frame(k, k === 5 ? 'STATE_DROPPED' : k === 7 ? 'STATE_PRESENTED_PARTIAL' : 'STATE_PRESENTED_ALL'));
  events.push(...frame(3, 'STATE_PRESENTED_ALL', 2));
  events.push(task(10000, 5), task(11000, 1), task(20000, 60), task(30000, 20, 20, 2));
  events.push({ ph: 'b', cat: 'blink.user_timing', name: 'banana:loaf event-listener DIV.onmousemove', pid: RENDERER, tid: MAIN, ts: 20000, id2: { local: '0x9' } });
  events.push({ ph: 'e', cat: 'blink.user_timing', name: 'banana:loaf event-listener DIV.onmousemove', pid: RENDERER, tid: MAIN, ts: 80000, id2: { local: '0x9' } });
  return events;
}

test('a gesture is judged by how often the screen showed the canvas move', () => {
  const report = analyzeTrace(trace());
  assert.equal(report.vsyncMs, 10);
  assert.equal(report.gestures.length, 1);
  const drag = report.summary.drag;
  assert.equal(drag.inputs, 20);
  // 12 reports began in the window; the second compositor's frame is ignored.
  assert.deepEqual(drag.reports, { presented: 10, partial: 1, dropped: 1, noUpdate: 0, checkerboarded: 0 });
  // Input spanned 10.5 vsyncs; 9 of them showed the move. The partly
  // presented frame showed none of it.
  assert.equal(drag.droppedPct, 14.3);
  assert.deepEqual(drag.frameMs, { p50: 10, p95: 20, p99: 20, max: 20 });
  assert.equal(drag.missedVsyncs, 2);
  assert.equal(drag.jankyFrames, 2);
  assert.equal(drag.inputLimited, false);
});

test('input latency runs to the first presented frame committed after the input was handled', () => {
  const { latencyMs } = analyzeTrace(trace()).summary.drag;
  // Inputs handled before a commit show 8 ms later, the others 13 ms later;
  // the four whose frame was dropped or partial wait 10 ms longer.
  assert.deepEqual(latencyMs, { p50: 13, p95: 23, max: 23, unanswered: 0 });
});

test('thread time merges nested tasks and keeps to the gesture window', () => {
  const { threads, longFrames } = analyzeTrace(trace()).summary.drag;
  assert.deepEqual(threads.rendererMain, { busyPct: 56.5, longestTaskMs: 60, tasksOver16ms: 1, tasksOver50ms: 1 });
  assert.deepEqual(threads.browserMain, { busyPct: 17.4, longestTaskMs: 20, tasksOver16ms: 1, tasksOver50ms: 0 });
  assert.deepEqual(longFrames, { count: 1, totalMs: 60, worst: [{ ms: 60, name: 'event-listener DIV.onmousemove' }] });
});

test('gestures split at input gaps, short ones are ignored, and the page probe names unmarked ones', () => {
  const events = metadata();
  for (let i = 0; i < 10; i++) events.push(...input(1000 + 5000 * i, i % 2));
  // 300 ms later: a pointerdown the probe saw on the pane.
  events.push(mark(345000, 'banana:auto pan'));
  for (let i = 0; i < 10; i++) events.push(...input(346000 + 5000 * i, i % 2));
  // A short wheel flick is not a gesture.
  for (let i = 0; i < 4; i++) events.push(...input(900000 + 5000 * i, i % 2, 'MOUSE_WHEEL'));
  for (let k = 0; k < 100; k++) events.push(...frame(k));
  const report = analyzeTrace(events);
  assert.deepEqual(report.gestures.map(g => [g.label, g.inputs]), [['mouse_dragged', 10], ['pan', 10]]);
});

test('reports forked while the main thread was busy do not count as the canvas moving', () => {
  const events = metadata();
  events.push(mark(900, 'banana:gesture drag'));
  for (let i = 0; i < 20; i++) events.push(...input(1000 + 5000 * i, i % 3));
  const report = (k, state, extra = {}) => {
    const begin = 1000 + 10000 * k, id2 = { local: `0x${k}${extra.frame_type ? 'f' : ''}` };
    return [
      { ph: 'b', cat: FRAME, name: 'PipelineReporter', pid: RENDERER, tid: COMPOSITOR, ts: begin, id2, args: { frame_reporter: { state, layer_tree_host_id: 1, frame_source: 7, frame_sequence: k, ...extra } } },
      { ph: 'e', cat: FRAME, name: 'PipelineReporter', pid: RENDERER, tid: COMPOSITOR, ts: begin + (extra.frame_type ? 6000 : 8000), id2 },
    ];
  };
  // Every vsync shows fully; every other one also has a forked partial report
  // that reached the screen first, without the main thread's update.
  for (let k = 0; k < 12; k++) {
    events.push(...report(k, 'STATE_PRESENTED_ALL'));
    if (k % 2) events.push(...report(k, 'STATE_PRESENTED_PARTIAL', { frame_type: 'FORKED' }));
  }
  const drag = analyzeTrace(events).summary.drag;
  assert.deepEqual(drag.reports, { presented: 12, partial: 6, dropped: 0, noUpdate: 0, checkerboarded: 0 });
  // Only the full reports moved the canvas, every 10 ms.
  assert.deepEqual([drag.frameMs.p50, drag.frameMs.max], [10, 10]);
  assert.equal(drag.droppedPct, 0);
  assert.ok(drag.vsyncsPresentedPct <= 100);
});

test('the filtered trace gives the same report, and a trace without input says why', () => {
  const events = trace();
  assert.deepEqual(analyzeTrace(events.filter(keepAnalyzed)), analyzeTrace(events));
  assert.throws(() => analyzeTrace(metadata()), /no input latency events/);
});
