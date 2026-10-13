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

test('the GPU canvas switch follows the saved setting, from the next launch', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gpu-canvas-'));
  assert.equal(readGpuCanvasPreference(userData), false);
  const off = commandLine();
  assert.equal(applyGpuCanvasSwitch(off, { userData, env: {} }), false);
  assert.deepEqual(off.switches, {});
  writeGpuCanvasPreference(userData, true);
  const on = commandLine({ 'enable-blink-features': 'Other' });
  assert.equal(applyGpuCanvasSwitch(on, { userData, env: {} }), true);
  assert.equal(on.switches['enable-blink-features'], 'Other,CanvasDrawElement');
});

test('NODE_BANANA_GPU_CANVAS=1 turns it on for one run', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gpu-canvas-'));
  const line = commandLine();
  assert.equal(applyGpuCanvasSwitch(line, { userData, env: { NODE_BANANA_GPU_CANVAS: '1' } }), true);
  assert.equal(line.switches['enable-blink-features'], 'CanvasDrawElement');
});
