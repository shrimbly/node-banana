const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { createCredentialStore } = require('../lib/credentials.cjs');
test('encrypted updates, deletion tombstones and failures preserve credentials', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-keys-'));
  const key = randomBytes(32), iv = randomBytes(16);
  let available = true;
  const secure = {
    isEncryptionAvailable: () => available,
    encryptString: s => { const c = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([c.update(s), c.final()]); },
    decryptString: b => { const c = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([c.update(b), c.final()]).toString(); },
  };
  const encrypt = secure.encryptString;
  try {
    const store = createCredentialStore(temp, secure);
    store.write({ 'provider.gemini': 'test-secret-unique', 'comfy.remoteApiKey': 'another-secret' });
    const filename = path.join(temp, 'credentials-v1.json');
    const encrypted = fs.readFileSync(filename, 'utf8');
    assert.ok(!encrypted.includes('test-secret-unique'));
    assert.equal(createCredentialStore(temp, secure).read()['provider.gemini'], 'test-secret-unique');
    assert.equal(store.delete('provider.gemini')['provider.gemini'], null);
    const previous = fs.readFileSync(filename, 'utf8');
    available = false;
    assert.throws(() => store.write({ 'provider.kie': 'new' }), /unavailable/);
    assert.equal(fs.readFileSync(filename, 'utf8'), previous);
    available = true;
    secure.encryptString = () => { throw new Error('keychain locked'); };
    assert.throws(() => store.write({ 'provider.kie': 'new' }), /saved securely/);
    assert.equal(fs.readFileSync(filename, 'utf8'), previous);
    assert.throws(() => store.write({ arbitrary: 'nope' }), /Invalid/);
    fs.writeFileSync(filename, 'corrupt');
    // Only a decrypt failure is resettable; macOS reports a locked keychain instead.
    assert.throws(() => store.read(), error => /preserved/.test(error.message) && error.code === (process.platform === 'darwin' ? undefined : 'undecryptable'));
    // A reset keeps the unreadable file beside a fresh, writable store.
    secure.encryptString = encrypt;
    assert.deepEqual(store.reset(), {});
    assert.equal(fs.existsSync(filename), false);
    const kept = fs.readdirSync(temp).filter(name => name.startsWith('credentials-v1.unreadable-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(temp, kept[0]), 'utf8'), 'corrupt');
    assert.equal(store.write({ 'provider.kie': 'fresh' })['provider.kie'], 'fresh');
    assert.equal(createCredentialStore(temp, secure).read()['provider.kie'], 'fresh');
    assert.deepEqual(createCredentialStore(temp, secure).reset(), {});
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
