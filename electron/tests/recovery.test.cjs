const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRecoveryStore } = require('../lib/recovery.cjs');
const snapshot = (text, media) => ({ version: 1, activeTabId: 'two', tabs: ['one', 'two'].map(id => ({ id, snapshot: { nodes: [{ id, data: { text, media } }], edges: [] } })) });
// atomicWrite never fsyncs the directory on Windows, so the failure this test
// simulates cannot occur there.
test('reports a committed discard after directory fsync failure so the renderer completes closure', { skip: process.platform === 'win32' && 'directory fsync is skipped on Windows' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-discard-sync-'));
  const original = fs.fsyncSync;
  try {
    const store = createRecoveryStore(temp);
    store.read(); store.write(snapshot('unsaved'));
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' }); return original(fd); };
    const result = store.discardTab('one');
    assert.match(result.warning, /could not be fully synced/);
    fs.fsyncSync = original;
    assert.deepEqual(createRecoveryStore(temp).read().snapshot.tabs.map(tab => tab.id), ['two']);
  } finally { fs.fsyncSync = original; fs.rmSync(temp, { recursive: true, force: true }); }
});
test('collects obsolete media while preserving both checkpoints and unfinished encodes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-collect-'));
  try {
    const store = createRecoveryStore(temp);
    store.read();
    const a = store.putAsset({ bytes: Buffer.from('first'), mime: 'image/png' });
    store.write(snapshot('a', a));
    const b = store.putAsset({ bytes: Buffer.from('second'), mime: 'image/png' });
    store.write(snapshot('b', b));
    const filename = asset => path.join(temp, 'recovery/assets', asset.$recoveryAsset);
    const pending = store.putAsset({ bytes: Buffer.from('encoding'), mime: 'image/png' });
    store.assetChunk({ offset: 0, bytes: Buffer.from('uploading'), mime: 'video/mp4', done: false });
    assert.ok(fs.existsSync(filename(a)), 'Previous checkpoint still owns a');
    store.write(snapshot('empty'));
    assert.equal(fs.existsSync(filename(a)), false);
    assert.ok(fs.existsSync(filename(b)), 'Previous checkpoint still owns b');
    assert.ok(fs.existsSync(filename(pending)), 'Uncommitted encode remains available');
    assert.ok(fs.readdirSync(path.join(temp, 'recovery/assets')).some(name => name.endsWith('.tmp')));
    store.write(snapshot('empty again'));
    assert.equal(fs.existsSync(filename(b)), false);
    createRecoveryStore(temp).read();
    assert.deepEqual(fs.readdirSync(path.join(temp, 'recovery/assets')), [], 'New renderer collects abandoned encodes and uploads');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('reuses verified unchanged media and rechecks modified files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-verified-'));
  const original = fs.readSync;
  let assetReads = 0;
  fs.readSync = (...args) => { assetReads++; return original(...args); };
  try {
    const store = createRecoveryStore(temp);
    store.read();
    const asset = store.putAsset({ bytes: Buffer.from('original'), mime: 'image/png' });
    store.write(snapshot('one', asset));
    // readFileSync may use readSync too; count only asset-sized buffers.
    fs.readSync = (...args) => { if (args[1].length === 8) assetReads++; return original(...args); };
    assetReads = 0;
    store.write(snapshot('two', asset));
    assert.equal(assetReads, 0, 'Unchanged asset was not hashed again');
    fs.writeFileSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset), 'modified');
    assert.throws(() => store.write(snapshot('three', asset)), /Damaged recovery asset/);
    assert.ok(assetReads > 0);
    assert.equal(createRecoveryStore(temp).read().snapshot.tabs[0].snapshot.nodes[0].data.text, 'two');
  } finally { fs.readSync = original; fs.rmSync(temp, { recursive: true, force: true }); }
});

test('a failed checkpoint commit never collects media needed by either valid checkpoint', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-collect-failure-'));
  const original = fs.renameSync;
  try {
    const store = createRecoveryStore(temp);
    store.read();
    const asset = store.putAsset({ bytes: Buffer.from('preserve'), mime: 'image/png' });
    store.write(snapshot('previous', asset));
    store.write(snapshot('current', asset));
    fs.renameSync = (from, to) => { if (to.endsWith('checkpoint-v1.json')) throw new Error('Interrupted commit'); return original(from, to); };
    assert.throws(() => store.write(snapshot('empty')), /Interrupted commit/);
    assert.ok(fs.existsSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset)));
    fs.renameSync = original;
    const recovered = createRecoveryStore(temp).read().snapshot;
    assert.equal(recovered.tabs[0].snapshot.nodes[0].data.text, 'current');
    assert.deepEqual(store.hydrate(recovered).warnings, []);
  } finally { fs.renameSync = original; fs.rmSync(temp, { recursive: true, force: true }); }
});
test('recovers previous checkpoint, durable assets and discards across interrupted writes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-recovery-'));
  try {
    const store = createRecoveryStore(temp);
    assert.equal(store.read().snapshot, null);
    const asset = store.putAsset({ bytes: Buffer.from('media'), mime: 'video/mp4' });
    store.write(snapshot('first', asset));
    store.write(snapshot('second', asset));
    fs.writeFileSync(path.join(temp, 'recovery/checkpoint-v1.json'), 'interrupted');
    fs.writeFileSync(path.join(temp, 'recovery/checkpoint-v1.json.abandoned.tmp'), 'ignored');
    const recovered = createRecoveryStore(temp).read();
    assert.equal(recovered.snapshot.tabs[0].snapshot.nodes[0].data.text, 'first');
    assert.equal(recovered.warnings.length, 1);
    assert.deepEqual(store.hydrate(recovered.snapshot).snapshot.tabs[0].snapshot.nodes[0].data.media, asset);
    assert.equal(store.readAsset({ asset, offset: 0 }).bytes.toString(), 'media');
    store.discardTab('one');
    store.write(snapshot('late-inflight-write', asset));
    assert.deepEqual(store.read().snapshot.tabs.map(t => t.id), ['two']);
    fs.rmSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset));
    assert.throws(() => store.write(snapshot('missing asset', asset)));
    assert.equal(store.hydrate(store.read().snapshot).warnings.length, 1);
    store.markClean();
    assert.ok(createRecoveryStore(temp).read().snapshot, 'Closing an unanswered recovery prompt preserves it');
    store.write(snapshot('restored and acknowledged'));
    store.markClean();
    assert.equal(store.write(snapshot('late write')), false);
    assert.equal(createRecoveryStore(temp).read().snapshot, null);
    store.discard();
    assert.equal(createRecoveryStore(temp).read().snapshot, null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('explicit discard wins even before a restored session checkpoints again', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-discard-'));
  try {
    const store = createRecoveryStore(temp);
    store.read(); store.write(snapshot('unsaved'));
    const next = createRecoveryStore(temp);
    assert.ok(next.read().snapshot);
    next.markClean(true);
    assert.equal(createRecoveryStore(temp).read().snapshot, null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('missing external media is reported without removing its reference', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-external-media-'));
  try {
    const store = createRecoveryStore(temp);
    const value = snapshot('external');
    value.tabs[0].snapshot.saveDirectoryPath = temp;
    value.tabs[0].snapshot.nodes[0].data.imageRef = 'missing-image';
    const recovered = store.hydrate(value);
    assert.equal(recovered.snapshot.tabs[0].snapshot.nodes[0].data.imageRef, 'missing-image');
    assert.ok(recovered.warnings.some(warning => warning.includes('External media is missing: missing-image')));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('transfers media in bounded ordered chunks and never expands checkpoint IPC', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-media-chunks-'));
  try {
    const store = createRecoveryStore(temp);
    store.read();
    const first = Buffer.alloc(1024 * 1024, 42);
    const { uploadId } = store.assetChunk({ offset: 0, bytes: first, mime: 'video/mp4', done: false });
    assert.throws(() => store.assetChunk({ uploadId, offset: 1, bytes: first, mime: 'video/mp4', done: false }));
    assert.throws(() => store.assetChunk({ offset: 0, bytes: Buffer.alloc(first.length + 1), mime: 'video/mp4', done: true }));
    const { asset } = store.assetChunk({ uploadId, offset: first.length, bytes: Buffer.from('tail'), mime: 'video/mp4', done: true });
    store.write(snapshot('chunked', asset));
    assert.deepEqual(store.hydrate(store.read().snapshot).snapshot.tabs[0].snapshot.nodes[0].data.media, asset);
    const readFirst = store.readAsset({ asset, offset: 0 });
    assert.equal(readFirst.size, first.length + 4);
    assert.deepEqual(readFirst.bytes, first);
    assert.equal(store.readAsset({ asset, offset: first.length }).bytes.toString(), 'tail');
    assert.throws(() => store.readAsset({ asset, offset: -1 }));
    assert.throws(() => store.readAsset({ asset: { $recoveryAsset: '../escape' }, offset: 0 }));
    assert.ok(fs.statSync(path.join(temp, 'recovery/checkpoint-v1.json')).size < 2000);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
