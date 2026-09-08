const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Sync is deliberate for small main-process records and close/discard markers.
// fsync the file before rename; readers see either the old or the new record.
function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let fd, committed = false;
  try {
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, filename);
      committed = true;
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(filename), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  } catch (error) {
    // A rename has already changed the live record even if directory fsync
    // subsequently fails. Callers must not assume the old value is intact.
    if (committed) error.atomicWriteCommitted = true;
    throw error;
  }
}
module.exports = { atomicWrite };
