// Chromium tracing for canvas smoothness: what the perf runner records around
// its gestures, and what NODE_BANANA_PERF_TRACE records during real use. The
// categories are the smallest set that still carries frame presentation
// (PipelineReporter), input timing (EventLatency) and per-thread task time;
// broader sets grow traces by ~10 MB a second.
const PERF_TRACE_CATEGORIES = ['disabled-by-default-devtools.timeline.frame', 'input.scrolling', 'toplevel', 'blink.user_timing', '__metadata'];

// Runs in the page's main world. Marks the start of each pointer or wheel
// gesture with what it began on, and turns long animation frames into user
// timing measures named after their slowest script, so a trace shows which
// code a slow frame ran without DevTools attached. Entries are cleared as soon
// as they are written: the trace keeps them, the page must not.
const PAGE_PROBE = `(() => {
  if (window.__bananaPerfProbe) return;
  window.__bananaPerfProbe = true;
  const emit = (name, options) => {
    try { options ? performance.measure(name, options) : performance.mark(name); } catch {}
    performance.clearMarks(name); performance.clearMeasures(name);
  };
  const target = element => !(element instanceof Element) ? 'other'
    : element.closest('.react-flow__node') ? 'node-drag'
    : element.closest('.react-flow__edge') ? 'edge'
    : element.closest('.react-flow') ? 'pan' : 'other';
  addEventListener('pointerdown', event => emit('banana:auto ' + target(event.target)), { capture: true, passive: true });
  let lastWheel = -Infinity;
  addEventListener('wheel', event => {
    if (event.timeStamp - lastWheel > 250) emit('banana:auto ' + (event.ctrlKey || event.altKey || event.metaKey ? 'zoom' : 'wheel-pan'));
    lastWheel = event.timeStamp;
  }, { capture: true, passive: true });
  try {
    new PerformanceObserver(list => {
      for (const frame of list.getEntries()) {
        const script = [...(frame.scripts || [])].sort((a, b) => b.duration - a.duration)[0];
        const where = script ? [script.invokerType, script.invoker, (script.sourceURL || '').split('/').pop(), script.sourceFunctionName].filter(Boolean).join(' ') : 'rendering';
        emit('banana:loaf ' + where.slice(0, 160), { start: frame.startTime, duration: frame.duration });
      }
    }).observe({ type: 'long-animation-frame' });
  } catch {}
})();`;

// NODE_BANANA_PERF_TRACE=<dir>: trace the session from launch into a ring
// buffer holding about the last minute and a half, and write it to <dir> as
// the app quits. Use the app as normal, make it stutter, then quit; npm run
// perf:analyze reads the file. Nothing is recorded unless the variable is set.
function createSessionTrace({ dir, contentTracing, log = () => {} }) {
  let recording, saved = false;
  return {
    start() {
      recording = contentTracing.startRecording({ included_categories: PERF_TRACE_CATEGORIES, excluded_categories: ['*'],
        record_mode: 'record-continuously', trace_buffer_size_in_kb: 256 * 1024 }).catch(error => { log(error); recording = undefined; });
    },
    attach(contents) {
      contents.on('did-finish-load', () => { contents.executeJavaScript(PAGE_PROBE).catch(log); });
    },
    // For app.on('will-quit'): hold the quit once while the trace is written.
    willQuit(event, quit) {
      if (saved || !recording) return;
      event.preventDefault();
      saved = true;
      const file = require('node:path').join(dir, `node-banana-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      require('node:fs').mkdirSync(dir, { recursive: true });
      recording.then(() => contentTracing.stopRecording(file)).then(written => log(`Performance trace written to ${written}`), log).finally(quit);
    },
  };
}

module.exports = { PERF_TRACE_CATEGORIES, PAGE_PROBE, createSessionTrace };
