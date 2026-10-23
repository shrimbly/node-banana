// Chromium switches the GPU canvas needs, set before the app is ready.
//
// HTML-in-Canvas (CanvasDrawElement) lets the canvas paint nodes into
// textures; Chromium 152 has it only behind --enable-blink-features (it is on
// by default by Chromium 158). Without it the canvas still runs, with the
// nodes in view live instead of painted. NODE_BANANA_HTML_IN_CANVAS=0 turns it
// off for one run (to try that mode).
//
// --enable-unsafe-swiftshader lets WebGL fall back to SwiftShader, Chromium's
// CPU renderer, where the GPU is missing or blocklisted. Chromium no longer
// does that by itself, and the canvas cannot draw without WebGL2. A real GPU
// is still used whenever there is one.
const FEATURE = 'CanvasDrawElement';

/** Returns whether HTML-in-Canvas is on for this launch. */
function applyGpuCanvasSwitches(commandLine, { env = process.env } = {}) {
  commandLine.appendSwitch('enable-unsafe-swiftshader');
  if (env.NODE_BANANA_HTML_IN_CANVAS === '0') {
    commandLine.appendSwitch('disable-blink-features', FEATURE);
    return false;
  }
  const existing = commandLine.getSwitchValue('enable-blink-features');
  const features = existing ? existing.split(',').filter(Boolean) : [];
  if (!features.includes(FEATURE)) features.push(FEATURE);
  commandLine.appendSwitch('enable-blink-features', features.join(','));
  return true;
}

module.exports = { applyGpuCanvasSwitches };
