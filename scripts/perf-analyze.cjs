// Reports canvas smoothness from a Chromium trace: one written by
// NODE_BANANA_PERF_TRACE during real use, or kept by the perf runner
// (--keep-traces). See docs/canvas-performance.md.
//   npm run perf:analyze -- <trace.json> [--json <report.json>]
const fs = require('node:fs');
const { readTrace, analyzeTrace, formatReport } = require('./lib/trace-analysis.cjs');

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('Usage: npm run perf:analyze -- <trace.json> [--json <report.json>]');
  process.exit(1);
}
const report = analyzeTrace(readTrace(file));
console.log(formatReport(report));
const json = process.argv.indexOf('--json');
if (json > 0) {
  fs.writeFileSync(process.argv[json + 1], JSON.stringify(report, null, 2));
  console.log(`\nSaved ${process.argv[json + 1]}`);
}
