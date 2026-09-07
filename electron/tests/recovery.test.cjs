const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRecoveryStore } = require('../lib/recovery.cjs');
const snapshot = (text, media) => ({ version: 1, activeTabId: 'two', tabs: ['one', 'two'].map(id => ({ id, snapshot: { nodes: [{ id, data: { text, media } }], edges: [] } })) });
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
    assert.equal(store.hydrate(recovered.snapshot).snapshot.tabs[0].snapshot.nodes[0].data.media, 'data:video/mp4;base64,bWVkaWE=');
    store.discardTab('one');
    store.write(snapshot('late-inflight-write', asset));
    assert.deepEqual(store.read().snapshot.tabs.map(t => t.id), ['two']);
    fs.rmSync(path.join(temp, 'recovery/assets', asset.$recoveryAsset));
    assert.throws(() => store.write(snapshot('missing asset', asset)));
    assert.equal(store.hydrate(store.read().snapshot).warnings.length, 1);
    store.markClean();
    assert.equal(store.write(snapshot('late write')), false);
    assert.equal(createRecoveryStore(temp).read().snapshot, null);
    store.discard();
    assert.equal(createRecoveryStore(temp).read().snapshot, null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
