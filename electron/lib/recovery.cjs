const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./files.cjs');
const MAX_SNAPSHOT = 256 * 1024 * 1024;
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
  let closed = false;
  let acknowledged = false;
  function session() {
    try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return { clean: false, discarded: [] }; }
  }
  function readCheckpoint(filename) {
    const bytes = fs.readFileSync(filename);
    if (bytes.length > MAX_SNAPSHOT) throw new Error('Checkpoint too large');
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
    const bytes = fs.readFileSync(assetPath(ref.$recoveryAsset));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.$recoveryAsset) throw new Error('Damaged recovery asset');
    return bytes;
  }
  function filtered(snapshot, discarded) {
    snapshot.tabs = snapshot.tabs.filter(tab => !discarded.includes(tab.id));
    if (!snapshot.tabs.length) return null;
    if (!snapshot.tabs.some(tab => tab.id === snapshot.activeTabId)) snapshot.activeTabId = snapshot.tabs[0].id;
    return snapshot;
  }
  return {
    read() {
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
      assetReferences(snapshot, assetRead);
      let validCurrent = false;
      try { readCheckpoint(current); validCurrent = true; } catch { /* Keep previous when current is corrupt. */ }
      if (validCurrent) atomicWrite(previous, fs.readFileSync(current));
      atomicWrite(current, JSON.stringify({ sha256: createHash('sha256').update(payload).digest('hex'), payload }));
      acknowledged = true;
      return true;
    },
    putAsset({ bytes, mime }) {
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ASSET || typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error('Invalid recovery media');
      const id = createHash('sha256').update(bytes).digest('hex');
      const filename = assetPath(id);
      if (!fs.existsSync(filename)) atomicWrite(filename, bytes);
      return { $recoveryAsset: id, mime };
    },
    hydrate(snapshot) {
      validateSnapshot(snapshot);
      const warnings = [];
      function walk(value) {
        if (!value || typeof value !== 'object') return value;
        if (value.$recoveryAsset) {
          try { return `data:${value.mime};base64,${assetRead(value).toString('base64')}`; }
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
      atomicWrite(marker, JSON.stringify({ clean: false, discarded: [] }));
    },
    markClean() {
      // Closing the recovery prompt is not consent to discard the offered work.
      if (!acknowledged && !session().clean && [current, previous].some(file => fs.existsSync(file))) return;
      closed = true;
      atomicWrite(marker, JSON.stringify({ clean: true, discarded: [] }));
    },
  };
}
module.exports = { createRecoveryStore, validateSnapshot };
