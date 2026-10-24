const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyGpuCanvasSwitches } = require('../lib/gpu-canvas.cjs');

function commandLine(initial = {}) {
  const switches = { ...initial };
  return { switches, getSwitchValue: name => switches[name] ?? '', appendSwitch: (name, value = '') => { switches[name] = value; } };
}

test('HTML-in-Canvas is on, beside any other Blink feature', () => {
  const line = commandLine({ 'enable-blink-features': 'Other' });
  assert.equal(applyGpuCanvasSwitches(line, { env: {} }), true);
  assert.equal(line.switches['enable-blink-features'], 'Other,CanvasDrawElement');
});

test('WebGL may fall back to SwiftShader, so a machine without a usable GPU still gets a canvas', () => {
  const line = commandLine();
  applyGpuCanvasSwitches(line, { env: {} });
  assert.ok('enable-unsafe-swiftshader' in line.switches);
});

test('NODE_BANANA_HTML_IN_CANVAS=0 turns HTML-in-Canvas off for one run (Chromium 158 has it on by default), and keeps the software fallback', () => {
  const line = commandLine();
  assert.equal(applyGpuCanvasSwitches(line, { env: { NODE_BANANA_HTML_IN_CANVAS: '0' } }), false);
  assert.deepEqual(Object.keys(line.switches), ['enable-unsafe-swiftshader', 'disable-blink-features']);
  assert.equal(line.switches['disable-blink-features'], 'CanvasDrawElement');
});
