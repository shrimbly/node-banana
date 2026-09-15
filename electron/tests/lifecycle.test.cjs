const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackend } = require('../lib/backend.cjs');
const { createDiagnostics, createRedactor } = require('../lib/diagnostics.cjs');
const { visibleBounds } = require('../lib/window-state.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('startup failure, concurrent retry, crash and stop leave only one child', async () => {
  const children = [], disconnected = [];
  const fork = () => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
    child.postMessage = () => {};
    children.push(child); return child;
  };
  const backend = createBackend({ fork, options: () => ({}), entry: '', diagnostics: { pipe() {} }, onMessage() {}, onDisconnected: code => disconnected.push(code), timeoutMs: 1000 });
  const failed = backend.start(); await tick();
  children[0].emit('message', { type: 'error', code: 'EADDRINUSE', message: 'occupied' });
  await assert.rejects(failed, { code: 'EADDRINUSE' });
  assert.equal(children[0].killed, true);
  const first = backend.start(), second = backend.start(); await tick();
  assert.equal(children.length, 2);
  children[1].emit('message', { type: 'ready' });
  await Promise.all([first, second]);
  children[1].emit('exit', 7);
  assert.deepEqual(disconnected, [7]);
  assert.equal(backend.online(), false);
  const restart = backend.start(); await tick(); children[2].emit('message', { type: 'ready' }); await restart;
  await backend.stop();
  assert.deepEqual(disconnected, [7]);
});
test('startup timeout kills the incomplete backend', async () => {
  const child = new EventEmitter();
  child.kill = () => setImmediate(() => child.emit('exit', 0));
  const backend = createBackend({ fork: () => child, options: () => ({}), entry: '', diagnostics: { pipe() {} }, onMessage() {}, onDisconnected() {}, timeoutMs: 10 });
  await assert.rejects(backend.start(), /did not start/);
  assert.equal(backend.online(), false);
});
test('logs redact split secrets and rotate with bounded storage', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-log-'));
  try {
    const redactor = createRedactor(); redactor.add(['secret-split-across-chunks']);
    const logs = createDiagnostics(temp, redactor, 256);
    const failed = new PassThrough();
    logs.pipe(failed, 'backend');
    assert.doesNotThrow(() => failed.emit('error', new Error('Connection reset: secret-split-across-chunks')));
    const errorLog = fs.readFileSync(path.join(temp, 'desktop.log'), 'utf8');
    assert.match(errorLog, /Diagnostic stream error: Connection reset: \[REDACTED\]/);
    assert.ok(!errorLog.includes('secret-split-across-chunks'));
    const stream = new PassThrough(); logs.pipe(stream, 'backend');
    stream.write('key secret-split-'); stream.end('across-chunks\n'); await tick();
    assert.ok(!fs.readFileSync(path.join(temp, 'desktop.log'), 'utf8').includes('secret-split'));
    for (let i = 0; i < 20; i++) logs.write('test', `Bearer abc123 password=my-password ${'a'.repeat(100)}`);
    const files = fs.readdirSync(temp);
    assert.equal(files.length, 4);
    for (const file of files) {
      const value = fs.readFileSync(path.join(temp, file), 'utf8');
      assert.ok(Buffer.byteLength(value) <= 256);
      assert.ok(!value.includes('abc123') && !value.includes('my-password'));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('window bounds fit a remaining display after a monitor is removed', () => {
  const primary = { workArea: { x: 0, y: 25, width: 1280, height: 775 } };
  assert.deepEqual(visibleBounds({ x: 5000, y: -2000, width: 1800, height: 1200 }, [primary], primary), { x: 0, y: 25, width: 1280, height: 775 });
});
