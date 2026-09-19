const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { importEnvironmentFile } = require('../lib/environment-import.cjs');

test('imports only supported values, preserves existing keys, and never evaluates shell syntax', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-env-import-'));
  const filename = path.join(directory, '.env.local');
  const source = `export GEMINI_API_KEY="test-gemini#equals=value"\nOPENAI_API_KEY=new-openai\nFAL_API_KEY='$(touch unwanted)'\nREPLICATE_API_KEY=your_replicate_api_key_here\nDATABASE_PASSWORD=unrelated-secret\nCOMFY_REMOTE_URL="https://user:pass@example.test"\nCOMFY_API_KEY=remote-secret\nCOMFY_MODE=remote\nCOMFY_API_V2=1\n`;
  fs.writeFileSync(filename, source);
  let saved = { 'provider.openai': 'existing-openai', 'provider.gemini': null };
  try {
    const result = importEnvironmentFile(filename, { read: () => saved, write: patch => (saved = { ...saved, ...patch }) });
    assert.equal(saved['provider.gemini'], 'test-gemini#equals=value');
    assert.equal(saved['provider.openai'], 'existing-openai');
    assert.equal(saved['provider.fal'], '$(touch unwanted)');
    assert.equal(saved['comfy.remoteUrl'], 'https://user:pass@example.test');
    assert.ok(!JSON.stringify(saved).includes('unrelated-secret'));
    assert.ok(!Object.hasOwn(saved, 'provider.replicate'));
    assert.deepEqual(result.skipped, ['OPENAI_API_KEY']);
    assert.deepEqual(result.preferences, { mode: 'remote', remoteUsesApiV2: true });
    assert.equal(fs.readFileSync(filename, 'utf8'), source);
    const again = importEnvironmentFile(filename, { read: () => saved, write: () => { throw new Error('Unexpected write'); } });
    assert.equal(again.imported.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed secure writes preserve the source and invalid files never reach storage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-env-failure-'));
  const filename = path.join(directory, '.env');
  fs.writeFileSync(filename, 'KIE_API_KEY=test-only-secret');
  try {
    assert.throws(() => importEnvironmentFile(filename, { read: () => ({}), write: () => { throw new Error('Secure storage unavailable'); } }), /Secure storage unavailable/);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'KIE_API_KEY=test-only-secret');
    fs.writeFileSync(filename, Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => importEnvironmentFile(filename, {}), /smaller than 1 MB/);
    assert.throws(() => importEnvironmentFile(directory, {}), /readable/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
