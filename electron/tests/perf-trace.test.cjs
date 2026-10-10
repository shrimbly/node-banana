const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSessionTrace, PAGE_PROBE, PERF_TRACE_CATEGORIES } = require('../lib/perf-trace.cjs');

function fakeTracing() {
  const calls = [];
  return { calls, startRecording: async options => { calls.push(['start', options]); }, stopRecording: async file => { calls.push(['stop', file]); return file; } };
}

test('the session trace records a ring buffer of the lean categories from launch', async () => {
  const contentTracing = fakeTracing();
  createSessionTrace({ dir: os.tmpdir(), contentTracing }).start();
  const [[kind, options]] = contentTracing.calls;
  assert.equal(kind, 'start');
  assert.deepEqual(options.included_categories, PERF_TRACE_CATEGORIES);
  assert.equal(options.record_mode, 'record-continuously');
});

test('quitting holds once while the trace is written into the folder, then quits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-trace-test-'));
  try {
    const contentTracing = fakeTracing();
    const trace = createSessionTrace({ dir: path.join(dir, 'traces'), contentTracing });
    trace.start();
    let prevented = 0, quits = 0;
    const event = { preventDefault: () => { prevented++; } };
    await new Promise(resolve => trace.willQuit(event, () => { quits++; resolve(); }));
    // The quit that follows passes straight through.
    trace.willQuit(event, () => { quits++; });
    assert.equal(prevented, 1);
    assert.equal(quits, 1);
    const [, file] = contentTracing.calls.find(([kind]) => kind === 'stop');
    assert.equal(path.dirname(file), path.join(dir, 'traces'));
    assert.match(path.basename(file), /^node-banana-.+\.json$/);
    assert.ok(fs.existsSync(path.join(dir, 'traces')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a session whose recording never started quits without waiting', () => {
  const trace = createSessionTrace({ dir: os.tmpdir(), contentTracing: fakeTracing() });
  let prevented = false;
  trace.willQuit({ preventDefault: () => { prevented = true; } }, () => assert.fail('quit is not deferred'));
  assert.equal(prevented, false);
});

test('each page load gets the gesture and long-frame probe', () => {
  const contents = new EventEmitter();
  const scripts = [];
  contents.executeJavaScript = async script => { scripts.push(script); };
  createSessionTrace({ dir: os.tmpdir(), contentTracing: fakeTracing() }).attach(contents);
  contents.emit('did-finish-load');
  contents.emit('did-finish-load');
  assert.deepEqual(scripts, [PAGE_PROBE, PAGE_PROBE]);
});
