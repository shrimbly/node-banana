// The GPU canvas paints nodes with HTML-in-Canvas, which Chromium 152 only
// has behind --enable-blink-features=CanvasDrawElement. It is the desktop
// app's canvas by default; Settings › Canvas can go back to the classic
// canvas, which also leaves the feature off. The switch must be set before
// the app is ready, so the choice is kept here, in user data, and applies
// from the next launch.
// NODE_BANANA_GPU_CANVAS=1 or =0 turns the feature on or off for one run
// regardless (runners use it).
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./files.cjs');

const FILE = 'gpu-canvas-v1.json';
const FEATURE = 'CanvasDrawElement';

/** On unless the classic canvas was chosen (an unreadable file counts as no choice). */
function readGpuCanvasPreference(userData) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, FILE), 'utf8')).enabled !== false;
  } catch {
    return true;
  }
}

function writeGpuCanvasPreference(userData, enabled) {
  atomicWrite(path.join(userData, FILE), JSON.stringify({ enabled: enabled === true }));
}

/** Turns the feature on for this launch unless the classic canvas was chosen; returns whether it is on. */
function applyGpuCanvasSwitch(commandLine, { userData, env = process.env }) {
  const forced = env.NODE_BANANA_GPU_CANVAS;
  const active = forced === '1' ? true : forced === '0' ? false : readGpuCanvasPreference(userData);
  if (!active) return false;
  const existing = commandLine.getSwitchValue('enable-blink-features');
  const features = existing ? existing.split(',').filter(Boolean) : [];
  if (!features.includes(FEATURE)) features.push(FEATURE);
  commandLine.appendSwitch('enable-blink-features', features.join(','));
  return true;
}

module.exports = { applyGpuCanvasSwitch, readGpuCanvasPreference, writeGpuCanvasPreference };
