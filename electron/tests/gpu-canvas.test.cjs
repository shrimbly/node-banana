const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyGpuCanvasSwitch, readGpuCanvasPreference, writeGpuCanvasPreference } = require('../lib/gpu-canvas.cjs');

function commandLine(initial = {}) {
  const switches = { ...initial };
  return { switches, getSwitchValue: name => switches[name] ?? '', appendSwitch: (name, value) => { switches[name] = value; } };
}

test('the GPU canvas is on by default', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gpu-canvas-'));
  assert.equal(readGpuCanvasPreference(userData), true);
  const line = commandLine({ 'enable-blink-features': 'Other' });
  assert.equal(applyGpuCanvasSwitch(line, { userData, env: {} }), true);
  assert.equal(line.switches['enable-blink-features'], 'Other,CanvasDrawElement');
});

test('choosing the classic canvas leaves the feature off from the next launch', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gpu-canvas-'));
  writeGpuCanvasPreference(userData, false);
  const off = commandLine();
  assert.equal(applyGpuCanvasSwitch(off, { userData, env: {} }), false);
  assert.deepEqual(off.switches, {});
  writeGpuCanvasPreference(userData, true);
  assert.equal(applyGpuCanvasSwitch(commandLine(), { userData, env: {} }), true);
});

test('an unreadable setting counts as no choice', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gpu-canvas-'));
  fs.writeFileSync(path.join(userData, 'gpu-canvas-v1.json'), '{');
  assert.equal(readGpuCanvasPreference(userData), true);
});

test('NODE_BANANA_GPU_CANVAS turns it on or off for one run', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gpu-canvas-'));
  writeGpuCanvasPreference(userData, false);
  const on = commandLine();
  assert.equal(applyGpuCanvasSwitch(on, { userData, env: { NODE_BANANA_GPU_CANVAS: '1' } }), true);
  assert.equal(on.switches['enable-blink-features'], 'CanvasDrawElement');
  writeGpuCanvasPreference(userData, true);
  const off = commandLine();
  assert.equal(applyGpuCanvasSwitch(off, { userData, env: { NODE_BANANA_GPU_CANVAS: '0' } }), false);
  assert.deepEqual(off.switches, {});
});
