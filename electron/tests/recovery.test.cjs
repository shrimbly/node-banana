const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRecoveryStore } = require('../lib/recovery.cjs');
const snapshot = (text, media) => ({ version: 1, activeTabId: 'two', tabs: ['one', 'two'].map(id => ({ id, snapshot: { nodes: [{ id, data: { text, media } }], edges: [] } })) });
// atomicWrite never fsyncs the directory on Windows, so the failure this test
// simulates cannot occur there.
test('reports a committed discard after directory fsync failure so the renderer completes closure', { skip: process.platform === 'win32' && 'directory fsync is skipped on Windows' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-discard-sync-'));
  const original = fs.fsyncSync;
  try {
    const store = createRecoveryStore(temp);
    await store.read(); await store.write(snapshot('unsaved'));
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('Directory sync failed'), { code: 'EIO' }); return original(fd); };
    const result = store.discardTab('one');
    assert.match(result.warning, /could not be fully synced/);
    fs.fsyncSync = original;
    assert.deepEqual((await createRecoveryStore(temp).read()).snapshot.tabs.map(tab => tab.id), ['two']);
  } finally { fs.fsyncSync = original; fs.rmSync(temp, { recursive: true, force: true }); }
});
test('collects obsolete media while preserving both checkpoints and unfinished encodes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-collect-'));
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const a = store.putAsset({ bytes: Buffer.from('first'), mime: 'image/png' });
    await store.write(snapshot('a', a));
    const b = store.putAsset({ bytes: Buffer.from('second'), mime: 'image/png' });
    await store.write(snapshot('b', b));
    const filename = asset => path.join(temp, 'recovery/assets', asset.$recoveryAsset);
    const pending = store.putAsset({ bytes: Buffer.from('encoding'), mime: 'image/png' });
    await store.assetChunk({ offset: 0, bytes: Buffer.from('uploading'), mime: 'video/mp4', done: false });
    assert.ok(fs.existsSync(filename(a)), 'Previous checkpoint still owns a');
    await store.write(snapshot('empty'));
    assert.equal(fs.existsSync(filename(a)), false);
    assert.ok(fs.existsSync(filename(b)), 'Previous checkpoint still owns b');
    assert.ok(fs.existsSync(filename(pending)), 'Uncommitted encode remains available');
    assert.ok(fs.readdirSync(path.join(temp, 'recovery/assets')).some(name => name.endsWith('.tmp')));
    await store.write(snapshot('empty again'));
    assert.equal(fs.existsSync(filename(b)), false);
    await createRecoveryStore(temp).read();
    assert.deepEqual(fs.readdirSync(path.join(temp, 'recovery/assets')), [], 'New renderer collects abandoned encodes and uploads');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('reuses verified unchanged media and rechecks modified files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-verified-'));
  const original = fsp.open;
  let assetOpens = 0;
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const asset = store.putAsset({ bytes: Buffer.from('original'), mime: 'image/png' });
    await store.write(snapshot('one', asset));
    // Count only the asset being opened for hashing, not checkpoint writes.
    fsp.open = (...args) => { if (String(args[0]).endsWith(asset.$recoveryAsset)) assetOpens++; return original(...args); };
    await store.write(snapshot('two', asset));
    assert.equal(assetOpens, 0, 'Unchanged asset was not hashed again');
    fs.writeFileSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset), 'modified');
    await assert.rejects(store.write(snapshot('three', asset)), /Damaged recovery asset/);
    assert.ok(assetOpens > 0);
    assert.equal((await createRecoveryStore(temp).read()).snapshot.tabs[0].snapshot.nodes[0].data.text, 'two');
  } finally { fsp.open = original; fs.rmSync(temp, { recursive: true, force: true }); }
});

test('a failed checkpoint commit never collects media needed by either valid checkpoint', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-collect-failure-'));
  const original = fsp.rename;
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const asset = store.putAsset({ bytes: Buffer.from('preserve'), mime: 'image/png' });
    await store.write(snapshot('previous', asset));
    await store.write(snapshot('current', asset));
    fsp.rename = async (from, to) => { if (to.endsWith('checkpoint-v1.json')) throw new Error('Interrupted commit'); return original(from, to); };
    await assert.rejects(store.write(snapshot('empty')), /Interrupted commit/);
    assert.ok(fs.existsSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset)));
    fsp.rename = original;
    const recovered = (await createRecoveryStore(temp).read()).snapshot;
    assert.equal(recovered.tabs[0].snapshot.nodes[0].data.text, 'current');
    assert.deepEqual((await store.hydrate(recovered)).warnings, []);
  } finally { fsp.rename = original; fs.rmSync(temp, { recursive: true, force: true }); }
});

test('a checkpoint that cannot be rotated is copied instead, and both stay readable', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-rotate-'));
  const original = fsp.rename;
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    await store.write(snapshot('first'));
    fsp.rename = async (from, to) => { if (from.endsWith('checkpoint-v1.json') && to.endsWith('checkpoint-v1.previous.json')) throw Object.assign(new Error('Held open'), { code: 'EPERM' }); return original(from, to); };
    await store.write(snapshot('second'));
    fs.rmSync(path.join(temp, 'recovery/checkpoint-v1.json'));
    assert.equal((await createRecoveryStore(temp).read()).snapshot.tabs[0].snapshot.nodes[0].data.text, 'first');
  } finally { fsp.rename = original; fs.rmSync(temp, { recursive: true, force: true }); }
});

test('checkpoints are not read back to keep their media, and a replaced file is read again', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-known-'));
  const original = fsp.readFile;
  let checkpointReads = 0;
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const asset = store.putAsset({ bytes: Buffer.from('kept'), mime: 'image/png' });
    await store.write(snapshot('one', asset));
    fsp.readFile = (...args) => { if (/checkpoint-v1/.test(String(args[0]))) checkpointReads++; return original(...args); };
    await store.write(snapshot('two', asset));
    await store.write(snapshot('three', asset));
    assert.equal(checkpointReads, 0, 'Writing never re-reads a checkpoint this store wrote');
    // Another writer replaces the current checkpoint: its media must be found by reading it.
    const other = createRecoveryStore(temp);
    await other.read();
    const late = other.putAsset({ bytes: Buffer.from('late'), mime: 'image/png' });
    await other.write(snapshot('other', late));
    await store.write(snapshot('four'));
    assert.ok(checkpointReads > 0);
    assert.ok(fs.existsSync(path.join(temp, 'recovery/assets', late.$recoveryAsset)), 'Previous checkpoint still owns the other writer\'s media');
  } finally { fsp.readFile = original; fs.rmSync(temp, { recursive: true, force: true }); }
});

test('recovers previous checkpoint, durable assets and discards across interrupted writes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-recovery-'));
  try {
    const store = createRecoveryStore(temp);
    assert.equal((await store.read()).snapshot, null);
    const asset = store.putAsset({ bytes: Buffer.from('media'), mime: 'video/mp4' });
    await store.write(snapshot('first', asset));
    await store.write(snapshot('second', asset));
    fs.writeFileSync(path.join(temp, 'recovery/checkpoint-v1.json'), 'interrupted');
    fs.writeFileSync(path.join(temp, 'recovery/checkpoint-v1.json.abandoned.tmp'), 'ignored');
    const recovered = await createRecoveryStore(temp).read();
    assert.equal(recovered.snapshot.tabs[0].snapshot.nodes[0].data.text, 'first');
    assert.equal(recovered.warnings.length, 1);
    assert.deepEqual((await store.hydrate(recovered.snapshot)).snapshot.tabs[0].snapshot.nodes[0].data.media, asset);
    assert.equal((await store.readAsset({ asset, offset: 0 })).bytes.toString(), 'media');
    store.discardTab('one');
    await store.write(snapshot('late-inflight-write', asset));
    assert.deepEqual((await store.read()).snapshot.tabs.map(t => t.id), ['two']);
    fs.rmSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset));
    await assert.rejects(store.write(snapshot('missing asset', asset)));
    assert.equal((await store.hydrate((await store.read()).snapshot)).warnings.length, 1);
    store.markClean();
    assert.ok((await createRecoveryStore(temp).read()).snapshot, 'Closing an unanswered recovery prompt preserves it');
    await store.write(snapshot('restored and acknowledged'));
    store.markClean();
    assert.equal(await store.write(snapshot('late write')), false);
    assert.equal((await createRecoveryStore(temp).read()).snapshot, null);
    store.discard();
    assert.equal((await createRecoveryStore(temp).read()).snapshot, null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('explicit discard wins even before a restored session checkpoints again', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-discard-'));
  try {
    const store = createRecoveryStore(temp);
    await store.read(); await store.write(snapshot('unsaved'));
    const next = createRecoveryStore(temp);
    assert.ok((await next.read()).snapshot);
    next.markClean(true);
    assert.equal((await createRecoveryStore(temp).read()).snapshot, null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('missing external media is reported without removing its reference', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-external-'));
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const value = snapshot('refs');
    value.tabs[0].snapshot.saveDirectoryPath = temp;
    value.tabs[0].snapshot.nodes[0].data.imageRef = 'missing-image';
    const { snapshot: hydrated, warnings } = await store.hydrate(value);
    assert.equal(hydrated.tabs[0].snapshot.nodes[0].data.imageRef, 'missing-image');
    assert.match(warnings[0], /External media is missing: missing-image/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('transfers media in bounded ordered chunks and never expands checkpoint IPC', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-media-chunks-'));
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const first = Buffer.alloc(1024 * 1024, 42);
    const { uploadId } = await store.assetChunk({ offset: 0, bytes: first, mime: 'video/mp4', done: false });
    await assert.rejects(store.assetChunk({ uploadId, offset: 1, bytes: first, mime: 'video/mp4', done: false }));
    await assert.rejects(store.assetChunk({ offset: 0, bytes: Buffer.alloc(first.length + 1), mime: 'video/mp4', done: true }));
    const { asset } = await store.assetChunk({ uploadId, offset: first.length, bytes: Buffer.from('tail'), mime: 'video/mp4', done: true });
    await store.write(snapshot('chunked', asset));
    assert.deepEqual((await store.hydrate((await store.read()).snapshot)).snapshot.tabs[0].snapshot.nodes[0].data.media, asset);
    const readFirst = await store.readAsset({ asset, offset: 0 });
    assert.equal(readFirst.size, first.length + 4);
    assert.deepEqual(readFirst.bytes, first);
    assert.equal((await store.readAsset({ asset, offset: first.length })).bytes.toString(), 'tail');
    await assert.rejects(store.readAsset({ asset, offset: -1 }));
    await assert.rejects(store.readAsset({ asset: { $recoveryAsset: '../escape' }, offset: 0 }));
    assert.ok(fs.statSync(path.join(temp, 'recovery/checkpoint-v1.json')).size < 2000);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('checkpoints queue in order while a slow one is still being written', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-queue-'));
  try {
    const store = createRecoveryStore(temp);
    await store.read();
    const results = await Promise.all([store.write(snapshot('one')), store.write(snapshot('two')), store.write(snapshot('three'))]);
    assert.deepEqual(results, [true, true, true]);
    const read = await createRecoveryStore(temp).read();
    assert.equal(read.warnings.length, 0);
    assert.equal(read.snapshot.tabs[0].snapshot.nodes[0].data.text, 'three');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
