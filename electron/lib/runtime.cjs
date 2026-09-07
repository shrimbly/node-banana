const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./files.cjs');

async function provisionRuntime(source, userData) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'runtime.json'), 'utf8'));
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.buildId)) throw new Error('Invalid runtime build ID');
  const runtimes = path.join(userData, 'runtimes');
  const target = path.join(runtimes, manifest.buildId);
  await fs.mkdir(runtimes, { recursive: true, mode: 0o700 });
  // A completed directory is published only after the entire copy succeeds.
  try { await fs.access(path.join(target, 'runtime.json')); }
  catch {
    const staging = path.join(runtimes, `.provision-${randomUUID()}`);
    try {
      await fs.cp(source, staging, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      await fs.rename(staging, target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  return { directory: target, async markSuccessful() {
    let previous;
    try { previous = JSON.parse(await fs.readFile(path.join(runtimes, 'active.json'), 'utf8')).current; } catch {}
    atomicWrite(path.join(runtimes, 'active.json'), JSON.stringify({ current: manifest.buildId, previous }));
    for (const entry of await fs.readdir(runtimes, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== manifest.buildId && entry.name !== previous) {
        await fs.rm(path.join(runtimes, entry.name), { recursive: true, force: true });
      }
    }
  } };
}
module.exports = { provisionRuntime };
