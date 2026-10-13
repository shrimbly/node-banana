// The GPU canvas (Settings › Canvas) paints nodes with HTML-in-Canvas, which
// Chromium 152 only has behind --enable-blink-features=CanvasDrawElement.
// The switch must be set before the app is ready, so the setting is kept
// here, in user data, and applies from the next launch.
// NODE_BANANA_GPU_CANVAS=1 turns the feature on for one run regardless.
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./files.cjs');

const FILE = 'gpu-canvas-v1.json';
const FEATURE = 'CanvasDrawElement';

function readGpuCanvasPreference(userData) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, FILE), 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

function writeGpuCanvasPreference(userData, enabled) {
  atomicWrite(path.join(userData, FILE), JSON.stringify({ enabled: enabled === true }));
}

/** Turns the feature on for this launch when asked; returns whether it is on. */
function applyGpuCanvasSwitch(commandLine, { userData, env = process.env }) {
  const active = env.NODE_BANANA_GPU_CANVAS === '1' || readGpuCanvasPreference(userData);
  if (!active) return false;
  const existing = commandLine.getSwitchValue('enable-blink-features');
  const features = existing ? existing.split(',').filter(Boolean) : [];
  if (!features.includes(FEATURE)) features.push(FEATURE);
  commandLine.appendSwitch('enable-blink-features', features.join(','));
  return true;
}

module.exports = { applyGpuCanvasSwitch, readGpuCanvasPreference, writeGpuCanvasPreference };
