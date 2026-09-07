const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
function createRedactor() {
  const secrets = new Set();
  return {
    add(values) { for (const value of values) if (typeof value === 'string' && value.length) secrets.add(value); },
    values: () => [...secrets],
    redact(value) {
      let text = String(value);
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
      return text
        .replace(/(bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
        .replace(/((?:api[_-]?key|token|secret|password|authorization|x-comfy-org-key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    },
  };
}
function createDiagnostics(directory, redactor = createRedactor(), maxBytes = 2 * 1024 * 1024) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'desktop.log');
  function write(source, value) {
    try {
      const line = `${new Date().toISOString()} [${source}] ${redactor.redact(value)}\n`;
      const bounded = Buffer.from(line).subarray(0, maxBytes);
      if (fs.existsSync(filename) && fs.statSync(filename).size + bounded.length > maxBytes) {
        fs.rmSync(`${filename}.3`, { force: true });
        for (let index = 2; index >= 1; index--) if (fs.existsSync(`${filename}.${index}`)) fs.renameSync(`${filename}.${index}`, `${filename}.${index + 1}`);
        fs.renameSync(filename, `${filename}.1`);
      }
      fs.appendFileSync(filename, bounded, { mode: 0o600 });
    } catch { /* A full disk must not turn diagnostics into another crash. */ }
  }
  function pipe(stream, source) {
    if (!stream) return;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    stream.on('data', chunk => {
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        write(source, pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
      // Drop pathological unterminated records instead of splitting a secret.
      if (pending.length > maxBytes) pending = '[Oversized diagnostic record omitted]';
    });
    stream.on('end', () => { pending += decoder.end(); if (pending) write(source, pending); });
  }
  return { write, pipe, redactor };
}
module.exports = { createRedactor, createDiagnostics };
