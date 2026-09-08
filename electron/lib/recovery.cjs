const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWrite } = require('./files.cjs');
const MAX_SNAPSHOT = 256 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;
const MAX_ASSET = 256 * 1024 * 1024;
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
function createRecoveryStore(userData) {
  const directory = path.join(userData, 'recovery');
  const current = path.join(directory, 'checkpoint-v1.json');
  const previous = path.join(directory, 'checkpoint-v1.previous.json');
  const marker = path.join(directory, 'session-v1.json');
  const uploads = new Map();
  const pendingAssets = new Map();
  const verifiedAssets = new Map();
  let closed = false;
  let acknowledged = false;
  function session() {
    try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return { clean: false, discarded: [] }; }
  }
  function readCheckpoint(filename) {
    if (fs.statSync(filename).size > MAX_SNAPSHOT) throw new Error('Checkpoint too large');
    const bytes = fs.readFileSync(filename);
    const record = JSON.parse(bytes);
    if (record.sha256 !== createHash('sha256').update(record.payload).digest('hex')) throw new Error('Damaged checkpoint');
    return validateSnapshot(JSON.parse(record.payload));
  }
  function assetPath(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid recovery asset');
    return path.join(directory, 'assets', id);
  }
  function assetRead(ref) {
    if (typeof ref.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(ref.mime)) throw new Error('Invalid media type');
    const filename = assetPath(ref.$recoveryAsset);
    const stat = fs.statSync(filename, { bigint: true });
    const size = Number(stat.size);
    if (size > MAX_ASSET) throw new Error('Recovery media too large');
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (verifiedAssets.get(ref.$recoveryAsset) === signature) return ref;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, size));
    const fd = fs.openSync(filename, 'r');
    try {
      for (let offset = 0; offset < size;) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!count) throw new Error('Incomplete recovery media');
        hash.update(buffer.subarray(0, count)); offset += count;
      }
    } finally { fs.closeSync(fd); }
    if (hash.digest('hex') !== ref.$recoveryAsset) throw new Error('Damaged recovery asset');
    verifiedAssets.set(ref.$recoveryAsset, signature);
    return ref;
  }
  function collectAssets() {
    const retained = new Set();
    for (const filename of [current, previous]) {
      try { assetReferences(readCheckpoint(filename), ref => retained.add(ref.$recoveryAsset)); }
      catch (error) {
        // A checkpoint we cannot inspect may still need its assets. Wait until
        // it has been replaced successfully before collecting anything.
        if (error.code !== 'ENOENT') return;
      }
    }
    const now = Date.now();
    for (const [id, created] of pendingAssets) {
      if (retained.has(id) || now - created > 60000) pendingAssets.delete(id);
      else retained.add(id); // An encoder may still be preparing its checkpoint.
    }
    for (const [id, upload] of uploads) {
      if (now - upload.updated > 60000) { fs.rmSync(upload.filename, { force: true }); uploads.delete(id); }
      else retained.add(path.basename(upload.filename));
    }
    const assetDirectory = path.join(directory, 'assets');
    if (!fs.existsSync(assetDirectory)) return;
    for (const filename of fs.readdirSync(assetDirectory)) {
      if (!retained.has(filename) && (/^[a-f0-9]{64}$/.test(filename) || filename.endsWith('.tmp'))) {
        fs.rmSync(path.join(assetDirectory, filename), { force: true });
        verifiedAssets.delete(filename);
      }
    }
  }
  function filtered(snapshot, discarded) {
    snapshot.tabs = snapshot.tabs.filter(tab => !discarded.includes(tab.id));
    if (!snapshot.tabs.length) return null;
    if (!snapshot.tabs.some(tab => tab.id === snapshot.activeTabId)) snapshot.activeTabId = snapshot.tabs[0].id;
    return snapshot;
  }
  return {
    read() {
      // Reading begins a renderer session; abandoned uploads from the old
      // renderer must not keep assets or temporary files alive indefinitely.
      uploads.clear(); pendingAssets.clear(); verifiedAssets.clear();
      const state = session();
      const warnings = [];
      let snapshot = null;
      if (!state.clean) for (const filename of [current, previous]) {
        if (!fs.existsSync(filename)) continue;
        try { snapshot = filtered(readCheckpoint(filename), state.discarded || []); break; }
        catch { warnings.push('A damaged recovery checkpoint was skipped.'); }
      }
      if (state.clean) {
        for (const file of [current, previous]) fs.rmSync(file, { force: true });
        fs.rmSync(path.join(directory, 'assets'), { recursive: true, force: true });
      }
      closed = false;
      acknowledged = !snapshot;
      atomicWrite(marker, JSON.stringify({ clean: false, discarded: state.clean ? [] : (state.discarded || []) }));
      try { collectAssets(); } catch { warnings.push('Unused recovery media could not be removed. Check disk space and permissions.'); }
      return { snapshot, warnings };
    },
    write(snapshot) {
      if (closed) return false;
      validateSnapshot(snapshot);
      snapshot = filtered(snapshot, session().discarded || []);
      if (!snapshot) return false;
      const payload = JSON.stringify(snapshot);
      if (Buffer.byteLength(payload) > MAX_SNAPSHOT) throw new Error('Recovery is too large. Save your workflows to disk.');
      // Every referenced asset must already be safely on disk before publishing.
      const verified = new Set();
      assetReferences(snapshot, ref => { if (!verified.has(ref.$recoveryAsset)) { assetRead(ref); verified.add(ref.$recoveryAsset); } });
      let validCurrent = false;
      try { readCheckpoint(current); validCurrent = true; } catch { /* Keep previous when current is corrupt. */ }
      if (validCurrent) atomicWrite(previous, fs.readFileSync(current));
      atomicWrite(current, JSON.stringify({ sha256: createHash('sha256').update(payload).digest('hex'), payload }));
      acknowledged = true;
      collectAssets();
      return true;
    },
    // Never send media-sized strings or buffers through main-process IPC.
    assetChunk({ uploadId, offset, bytes, mime, done }) {
      if (!(bytes instanceof Uint8Array) || bytes.length > CHUNK_SIZE || !Number.isSafeInteger(offset) || offset < 0 || typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error('Invalid recovery media chunk');
      // Abandoned transfers expire; neither disk usage nor open handles grow forever.
      for (const [id, upload] of uploads) if (Date.now() - upload.updated > 60000) {
        fs.rmSync(upload.filename, { force: true }); uploads.delete(id);
      }
      let upload = uploads.get(uploadId);
      if (!uploadId && offset === 0) {
        if (uploads.size >= 4) throw new Error('Too many recovery media transfers');
        uploadId = randomUUID();
        const filename = path.join(directory, 'assets', `${uploadId}.tmp`);
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filename, '', { flag: 'wx', mode: 0o600 });
        upload = { filename, size: 0, hash: createHash('sha256'), mime, updated: Date.now() };
        uploads.set(uploadId, upload);
      }
      if (!upload || upload.size !== offset || upload.mime !== mime) throw new Error('Invalid recovery media transfer');
      try {
        if (offset + bytes.length > MAX_ASSET) throw new Error('Recovery media too large');
        fs.appendFileSync(upload.filename, bytes);
        upload.hash.update(bytes); upload.size += bytes.length; upload.updated = Date.now();
        if (!done) return { uploadId };
        const id = upload.hash.digest('hex');
        const fd = fs.openSync(upload.filename, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(upload.filename, assetPath(id));
        if (process.platform !== 'win32') {
          const dir = fs.openSync(path.dirname(upload.filename), 'r');
          try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        }
        uploads.delete(uploadId);
        pendingAssets.set(id, Date.now());
        return { asset: { $recoveryAsset: id, mime } };
      } catch (error) { fs.rmSync(upload.filename, { force: true }); uploads.delete(uploadId); throw error; }
    },
    readAsset({ asset, offset }) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid media offset');
      const filename = assetPath(asset.$recoveryAsset);
      const size = fs.statSync(filename).size;
      if (size > MAX_ASSET || offset > size) throw new Error('Invalid media size');
      const bytes = Buffer.alloc(Math.min(CHUNK_SIZE, size - offset));
      const fd = fs.openSync(filename, 'r');
      try {
        if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) throw new Error('Incomplete recovery media');
      } finally { fs.closeSync(fd); }
      return { bytes, size };
    },
    putAsset({ bytes, mime }) {
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ASSET || typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error('Invalid recovery media');
      const id = createHash('sha256').update(bytes).digest('hex');
      const filename = assetPath(id);
      if (!fs.existsSync(filename)) atomicWrite(filename, bytes);
      pendingAssets.set(id, Date.now());
      return { $recoveryAsset: id, mime };
    },
    hydrate(snapshot) {
      validateSnapshot(snapshot);
      const warnings = [];
      const verified = new Map();
      function walk(value) {
        if (!value || typeof value !== 'object') return value;
        if (value.$recoveryAsset) {
          try {
            if (!verified.has(value.$recoveryAsset)) verified.set(value.$recoveryAsset, assetRead(value));
            return verified.get(value.$recoveryAsset);
          }
          catch { warnings.push(`Missing or damaged recovery media: ${value.$recoveryAsset}`); return null; }
        }
        if (Array.isArray(value)) return value.map(walk);
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
      }
      // Preserve external references while reporting unavailable files.
      for (const tab of snapshot.tabs) {
        const base = tab.snapshot.imageRefBasePath || tab.snapshot.saveDirectoryPath;
        if (!base || typeof base !== 'string') continue;
        let files;
        try {
          files = ['', 'inputs', 'generations', '.images'].flatMap(folder => {
            try { return fs.readdirSync(path.join(base, folder)); } catch { return []; }
          });
        } catch { files = []; }
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
      return { snapshot: walk(snapshot), warnings: [...new Set(warnings)] };
    },
    discardTab(id) {
      if (typeof id !== 'string' || id.length > 200) throw new Error('Invalid tab');
      const state = session();
      atomicWrite(marker, JSON.stringify({ ...state, discarded: [...new Set([...(state.discarded || []), id])] }));
    },
    discard() {
      acknowledged = true;
      // The durable tombstone takes effect before deletion, even if removal fails.
      atomicWrite(marker, JSON.stringify({ clean: true, discarded: [] }));
      for (const file of [current, previous]) fs.rmSync(file, { force: true });
      fs.rmSync(path.join(directory, 'assets'), { recursive: true, force: true });
      uploads.clear(); pendingAssets.clear(); verifiedAssets.clear();
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
