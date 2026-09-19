const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./files.cjs');
const credentialNames = new Set([
  ...['gemini', 'openai', 'anthropic', 'replicate', 'fal', 'kie', 'wavespeed'].map(id => `provider.${id}`),
  ...['cloudApiKey', 'remoteApiKey', 'comfyOrgApiKey', 'cloudUrl', 'localUrl', 'remoteUrl'].map(id => `comfy.${id}`),
]);
function validateCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credentials');
  for (const [key, secret] of Object.entries(value)) {
    if (!credentialNames.has(key) || (secret !== null && (typeof secret !== 'string' || secret.length > 16384))) throw new Error('Invalid credential field');
  }
  return value;
}
// macOS fails to decrypt while the login keychain is locked, which unlocking
// fixes. Elsewhere the encryption key itself has moved on and the file is lost.
const UNREADABLE = process.platform === 'darwin'
  ? 'Stored keys could not be decrypted. Unlock your login keychain and retry. Existing credentials have been preserved.'
  : 'Stored keys could not be decrypted: the system encryption key no longer matches the saved file, so they cannot be recovered. Reset stored keys to start again; the unreadable file is preserved beside the new one.';
function createCredentialStore(directory, safeStorage, onSecrets = () => {}) {
  const filename = path.join(directory, 'credentials-v1.json');
  function check() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure storage is unavailable. Unlock your login keychain and retry, or use keys for this session only.');
    }
  }
  function read() {
    check();
    if (!fs.existsSync(filename)) return {};
    try {
      const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (record.version !== 1 || typeof record.encrypted !== 'string') throw new Error();
      const value = validateCredentials(JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'))));
      onSecrets(Object.values(value));
      return value;
    } catch { throw new Error(UNREADABLE); }
  }
  // Undecryptable data is unrecoverable once the OS-level key has changed (seen
  // on Windows when Chromium regenerates its DPAPI-wrapped key). Keep the file
  // beside a fresh store rather than deleting it.
  function reset() {
    if (fs.existsSync(filename)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(filename, path.join(directory, `credentials-v1.unreadable-${stamp}.json`));
    }
    onSecrets([]);
    return {};
  }
  function write(patch) {
    validateCredentials(patch);
    const next = { ...read(), ...patch };
    onSecrets(Object.values(next));
    try {
      atomicWrite(filename, JSON.stringify({ version: 1, encrypted: safeStorage.encryptString(JSON.stringify(next)).toString('base64') }));
    } catch { throw new Error('Keys could not be saved securely. Check available disk space and keychain access, then retry. Existing credentials have been preserved.'); }
    return next;
  }
  return { read, write, reset, delete(name) {
    if (!credentialNames.has(name)) throw new Error('Invalid credential field');
    return write({ [name]: null }); // Tombstone prevents a repeat migration resurrecting a deleted key.
  } };
}
module.exports = { createCredentialStore, validateCredentials };
