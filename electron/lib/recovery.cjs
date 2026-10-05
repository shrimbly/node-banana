const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWrite, atomicWriteAsync } = require('./files.cjs');
const MAX_SNAPSHOT = 256 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;
const MAX_ASSET = 256 * 1024 * 1024;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const ASSET_ID = /^[a-f0-9]{64}$/;
function validateSnapshot(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > 200) throw new Error('Invalid recovery checkpoint');
  const ids = new Set();
  for (const tab of value.tabs) {
    if (typeof tab.id !== 'string' || ids.has(tab.id) || !tab.snapshot || !Array.isArray(tab.snapshot.nodes) || !Array.isArray(tab.snapshot.edges)) throw new Error('Invalid recovery tab');
    ids.add(tab.id);
  }
  if (!ids.has(value.activeTabId)) throw new Error('Invalid active recovery tab');
  return value;
}
function assetReferences(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$recoveryAsset === 'string') { visit(value); return; }
  for (const child of Object.values(value)) assetReferences(child, visit);
}
function referencedAssets(snapshot) {
  const ids = new Set();
  assetReferences(snapshot, ref => ids.add(ref.$recoveryAsset));
  return ids;
}
function parseCheckpoint(bytes) {
  const record = JSON.parse(bytes);
  if (record.sha256 !== createHash('sha256').update(record.payload).digest('hex')) throw new Error('Damaged checkpoint');
  return validateSnapshot(JSON.parse(record.payload));
}
const signatureOf = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
// Every call that runs while the editor is in use (checkpoints, media
// transfers, collection) is asynchronous: the main process also routes the
// window's input, and a checkpoint written synchronously with fsync every few
// seconds stalled it, worst on Windows where each new file is scanned too.
// The markers that must commit in the renderer's own turn stay synchronous.
function createRecoveryStore(userData) {
  const directory = path.join(userData, 'recovery');
  const current = path.join(directory, 'checkpoint-v1.json');
  const previous = path.join(directory, 'checkpoint-v1.previous.json');
  const marker = path.join(directory, 'session-v1.json');
  const assetDirectory = path.join(directory, 'assets');
  const uploads = new Map();
  const pendingAssets = new Map();
  const verifiedAssets = new Map();
  // What each checkpoint file references, remembered from the write that
  // produced it and trusted while the file's stat signature still matches, so
  // a checkpoint is never read back, re-hashed and re-parsed just to keep its
  // media alive.
  const known = new Map();
  let closed = false;
  let acknowledged = false;
  let writing = Promise.resolve();
  function session() {
    try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return { clean: false, discarded: [] }; }
  }
  async function loadCheckpoint(filename) {
    const stat = await fsp.stat(filename, { bigint: true });
    if (stat.size > MAX_SNAPSHOT) throw new Error('Checkpoint too large');
    const snapshot = parseCheckpoint(await fsp.readFile(filename));
    known.set(filename, { signature: signatureOf(stat), assets: referencedAssets(snapshot) });
    return snapshot;
  }
  async function remember(filename, assets) {
    try { known.set(filename, { signature: signatureOf(await fsp.stat(filename, { bigint: true })), assets }); }
    catch { known.delete(filename); }
  }
  // The asset ids a checkpoint file references, null when there is no file.
  async function checkpointAssets(filename) {
    let stat;
    try { stat = await fsp.stat(filename, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { known.delete(filename); return null; } throw error; }
    const remembered = known.get(filename);
    if (remembered && remembered.signature === signatureOf(stat)) return remembered.assets;
    if (stat.size > MAX_SNAPSHOT) throw new Error('Checkpoint too large');
    const assets = referencedAssets(parseCheckpoint(await fsp.readFile(filename)));
    known.set(filename, { signature: signatureOf(stat), assets });
    return assets;
  }
  function assetPath(id) {
    if (!ASSET_ID.test(id)) throw new Error('Invalid recovery asset');
    return path.join(assetDirectory, id);
  }
  async function verifyAsset(ref) {
    if (typeof ref.mime !== 'string' || !MIME.test(ref.mime)) throw new Error('Invalid media type');
    const filename = assetPath(ref.$recoveryAsset);
    const stat = await fsp.stat(filename, { bigint: true });
    const size = Number(stat.size);
    if (size > MAX_ASSET) throw new Error('Recovery media too large');
    const signature = signatureOf(stat);
    if (verifiedAssets.get(ref.$recoveryAsset) === signature) return ref;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, size));
    const handle = await fsp.open(filename, 'r');
    try {
      for (let offset = 0; offset < size;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new Error('Incomplete recovery media');
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
    } finally { await handle.close(); }
    if (hash.digest('hex') !== ref.$recoveryAsset) throw new Error('Damaged recovery asset');
    verifiedAssets.set(ref.$recoveryAsset, signature);
    return ref;
  }
  async function syncDirectory(name) {
    if (process.platform === 'win32') return;
    const handle = await fsp.open(name, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function collectAssets() {
    const retained = new Set();
    for (const filename of [current, previous]) {
      // A checkpoint we cannot inspect may still need its assets. Wait until
      // it has been replaced successfully before collecting anything.
      let assets;
      try { assets = await checkpointAssets(filename); } catch { return; }
      for (const id of assets || []) retained.add(id);
    }
    const now = Date.now();
    for (const [id, created] of pendingAssets) {
      if (retained.has(id) || now - created > 60000) pendingAssets.delete(id);
      else retained.add(id); // An encoder may still be preparing its checkpoint.
    }
    for (const [id, upload] of uploads) {
      if (now - upload.updated > 60000 && !upload.busy) { uploads.delete(id); await fsp.rm(upload.filename, { force: true }); }
      else retained.add(path.basename(upload.filename));
    }
    let names;
    try { names = await fsp.readdir(assetDirectory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!retained.has(name) && (ASSET_ID.test(name) || name.endsWith('.tmp'))) {
        await fsp.rm(path.join(assetDirectory, name), { force: true });
        verifiedAssets.delete(name);
      }
    }
  }
  function filtered(snapshot, discarded) {
    snapshot.tabs = snapshot.tabs.filter(tab => !discarded.includes(tab.id));
    if (!snapshot.tabs.length) return null;
    if (!snapshot.tabs.some(tab => tab.id === snapshot.activeTabId)) snapshot.activeTabId = snapshot.tabs[0].id;
    return snapshot;
  }
  async function commit(snapshot) {
    if (closed) return false;
    validateSnapshot(snapshot);
    snapshot = filtered(snapshot, session().discarded || []);
    if (!snapshot) return false;
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload) > MAX_SNAPSHOT) throw new Error('Recovery is too large. Save your workflows to disk.');
    // Every referenced asset must already be safely on disk before publishing.
    const refs = new Map();
    assetReferences(snapshot, ref => { if (!refs.has(ref.$recoveryAsset)) refs.set(ref.$recoveryAsset, ref); });
    for (const ref of refs.values()) await verifyAsset(ref);
    // A valid current checkpoint becomes the previous one by rename: no copy,
    // no second fsync. A corrupt one is left to be replaced, so previous keeps
    // the last good checkpoint.
    let retiring = null;
    try { retiring = await checkpointAssets(current); } catch { /* Keep previous when current is corrupt. */ }
    if (retiring) {
      try { await fsp.rename(current, previous); }
      catch { await atomicWriteAsync(previous, await fsp.readFile(current)); } // A scanner may hold the file open.
      known.delete(current);
      await remember(previous, retiring);
    }
    await atomicWriteAsync(current, JSON.stringify({ sha256: createHash('sha256').update(payload).digest('hex'), payload }));
    await remember(current, new Set(refs.keys()));
    acknowledged = true;
    await collectAssets();
    return true;
  }
  return {
    async read() {
      // Reading begins a renderer session; abandoned uploads from the old
      // renderer must not keep assets or temporary files alive indefinitely.
      uploads.clear(); pendingAssets.clear(); verifiedAssets.clear(); known.clear();
      const state = session();
      const warnings = [];
      let snapshot = null;
      if (!state.clean) for (const filename of [current, previous]) {
        if (!fs.existsSync(filename)) continue;
        try { snapshot = filtered(await loadCheckpoint(filename), state.discarded || []); break; }
        catch { warnings.push('A damaged recovery checkpoint was skipped.'); }
      }
      if (state.clean) {
        for (const file of [current, previous]) fs.rmSync(file, { force: true });
        fs.rmSync(assetDirectory, { recursive: true, force: true });
        known.clear();
      }
      closed = false;
      acknowledged = !snapshot;
      atomicWrite(marker, JSON.stringify({ clean: false, discarded: state.clean ? [] : (state.discarded || []) }));
      try { await collectAssets(); } catch { warnings.push('Unused recovery media could not be removed. Check disk space and permissions.'); }
      return { snapshot, warnings };
    },
    write(snapshot) {
      // One checkpoint at a time, in order: the rotation assumes the files
      // are not moving underneath it.
      const run = writing.then(() => commit(snapshot));
      writing = run.catch(() => {});
      return run;
    },
    // Never send media-sized strings or buffers through main-process IPC.
    async assetChunk({ uploadId, offset, bytes, mime, done }) {
      if (!(bytes instanceof Uint8Array) || bytes.length > CHUNK_SIZE || !Number.isSafeInteger(offset) || offset < 0 || typeof mime !== 'string' || !MIME.test(mime)) throw new Error('Invalid recovery media chunk');
      // Abandoned transfers expire; neither disk usage nor open handles grow forever.
      const now = Date.now();
      for (const [id, upload] of uploads) if (now - upload.updated > 60000 && !upload.busy) {
        uploads.delete(id); await fsp.rm(upload.filename, { force: true });
      }
      let upload = uploads.get(uploadId);
      if (!uploadId && offset === 0) {
        if (uploads.size >= 4) throw new Error('Too many recovery media transfers');
        uploadId = randomUUID();
        const filename = path.join(assetDirectory, `${uploadId}.tmp`);
        await fsp.mkdir(assetDirectory, { recursive: true, mode: 0o700 });
        await fsp.writeFile(filename, '', { flag: 'wx', mode: 0o600 });
        upload = { filename, size: 0, hash: createHash('sha256'), mime, updated: now, busy: false };
        uploads.set(uploadId, upload);
      }
      // Chunks of one transfer arrive one after another; a second caller mid-chunk is a bug.
      if (!upload || upload.busy || upload.size !== offset || upload.mime !== mime) throw new Error('Invalid recovery media transfer');
      upload.busy = true;
      try {
        if (offset + bytes.length > MAX_ASSET) throw new Error('Recovery media too large');
        await fsp.appendFile(upload.filename, bytes);
        upload.hash.update(bytes); upload.size += bytes.length; upload.updated = Date.now();
        if (!done) { upload.busy = false; return { uploadId }; }
        const id = upload.hash.digest('hex');
        // Open read-write: on Windows fsync (FlushFileBuffers) needs write access
        // on the handle, and a read-only fd fails with EPERM.
        const handle = await fsp.open(upload.filename, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fsp.rename(upload.filename, assetPath(id));
        await syncDirectory(assetDirectory);
        uploads.delete(uploadId);
        pendingAssets.set(id, Date.now());
        return { asset: { $recoveryAsset: id, mime } };
      } catch (error) { uploads.delete(uploadId); await fsp.rm(upload.filename, { force: true }); throw error; }
    },
    async readAsset({ asset, offset }) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid media offset');
      const filename = assetPath(asset.$recoveryAsset);
      const size = (await fsp.stat(filename)).size;
      if (size > MAX_ASSET || offset > size) throw new Error('Invalid media size');
      const bytes = Buffer.alloc(Math.min(CHUNK_SIZE, size - offset));
      const handle = await fsp.open(filename, 'r');
      try {
        if ((await handle.read(bytes, 0, bytes.length, offset)).bytesRead !== bytes.length) throw new Error('Incomplete recovery media');
      } finally { await handle.close(); }
      return { bytes, size };
    },
    putAsset({ bytes, mime }) {
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ASSET || typeof mime !== 'string' || !MIME.test(mime)) throw new Error('Invalid recovery media');
      const id = createHash('sha256').update(bytes).digest('hex');
      const filename = assetPath(id);
      if (!fs.existsSync(filename)) atomicWrite(filename, bytes);
      pendingAssets.set(id, Date.now());
      return { $recoveryAsset: id, mime };
    },
    async hydrate(snapshot) {
      validateSnapshot(snapshot);
      const warnings = [];
      const verified = new Map();
      async function walk(value) {
        if (!value || typeof value !== 'object') return value;
        if (value.$recoveryAsset) {
          try {
            if (!verified.has(value.$recoveryAsset)) verified.set(value.$recoveryAsset, await verifyAsset(value));
            return verified.get(value.$recoveryAsset);
          }
          catch { warnings.push(`Missing or damaged recovery media: ${value.$recoveryAsset}`); return null; }
        }
        if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await walk(item)); return result; }
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = await walk(child);
        return result;
      }
      // Preserve external references while reporting unavailable files.
      for (const tab of snapshot.tabs) {
        const base = tab.snapshot.imageRefBasePath || tab.snapshot.saveDirectoryPath;
        if (!base || typeof base !== 'string') continue;
        const files = [];
        for (const folder of ['', 'inputs', 'generations', '.images']) {
          try { files.push(...await fsp.readdir(path.join(base, folder))); } catch { /* Not there. */ }
        }
        function checkRefs(value) {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (/Refs?$/.test(key)) {
              const refs = typeof child === 'string' ? [child] : child && typeof child === 'object' ? Object.values(child) : [];
              for (const ref of refs) if (typeof ref === 'string' && ref && !files.some(file => file.startsWith(`${ref}.`))) warnings.push(`External media is missing: ${ref} (${base})`);
            } else checkRefs(child);
          }
        }
        checkRefs(tab.snapshot.nodes);
      }
      return { snapshot: await walk(snapshot), warnings: [...new Set(warnings)] };
    },
    discardTab(id) {
      if (typeof id !== 'string' || id.length > 200) throw new Error('Invalid tab');
      const state = session();
      try {
        atomicWrite(marker, JSON.stringify({ ...state, discarded: [...new Set([...(state.discarded || []), id])] }));
      } catch (error) {
        if (!error.atomicWriteCommitted) throw error;
        // The marker already excludes this tab. Complete its closure instead
        // of leaving an open tab that future checkpoints cannot protect.
        return { warning: 'The tab closed, but its recovery discard could not be fully synced to disk. Check disk space and permissions.' };
      }
    },
    discard() {
      acknowledged = true;
      // The durable tombstone takes effect before deletion, even if removal fails.
      atomicWrite(marker, JSON.stringify({ clean: true, discarded: [] }));
      for (const file of [current, previous]) fs.rmSync(file, { force: true });
      fs.rmSync(assetDirectory, { recursive: true, force: true });
      uploads.clear(); pendingAssets.clear(); verifiedAssets.clear(); known.clear();
      atomicWrite(marker, JSON.stringify({ clean: false, discarded: [] }));
    },
    markClean(force = false) {
      // Closing the recovery prompt is not consent to discard the offered work.
      if (!force && !acknowledged && !session().clean && [current, previous].some(file => fs.existsSync(file))) return;
      closed = true;
      atomicWrite(marker, JSON.stringify({ clean: true, discarded: [] }));
    },
  };
}
module.exports = { createRecoveryStore, validateSnapshot };
