const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { provisionRuntime } = require('../lib/runtime.cjs');
test('runtime is atomically provisioned and previous successful build survives updates', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-runtime-'));
  try {
    const source = path.join(temp, 'bundle');
    const user = path.join(temp, 'user');
    await fs.mkdir(source);
    for (const buildId of ['one', 'two', 'three']) {
      await fs.writeFile(path.join(source, 'runtime.json'), JSON.stringify({ buildId }));
      await fs.writeFile(path.join(source, 'asset'), buildId);
      const runtime = await provisionRuntime(source, user);
      assert.equal(await fs.readFile(path.join(runtime.directory, 'asset'), 'utf8'), buildId);
      if (buildId === 'two') await fs.access(path.join(user, 'runtimes/one/asset'));
      await runtime.markSuccessful();
    }
    assert.deepEqual((await fs.readdir(path.join(user, 'runtimes'))).sort(), ['active.json', 'three', 'two']);
    assert.equal(await fs.readFile(path.join(source, 'asset'), 'utf8'), 'three');
    for (const buildId of ['../escape', '.', '..', null, 123]) {
      await fs.writeFile(path.join(source, 'runtime.json'), JSON.stringify({ buildId }));
      await assert.rejects(provisionRuntime(source, user), /Invalid/);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
