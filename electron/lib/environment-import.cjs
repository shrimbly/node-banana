const fs = require('node:fs');
const { parseEnv } = require('node:util');
const { validateCredentials } = require('./credentials.cjs');
const fields = {
  GEMINI_API_KEY: 'provider.gemini', OPENAI_API_KEY: 'provider.openai', ANTHROPIC_API_KEY: 'provider.anthropic',
  REPLICATE_API_KEY: 'provider.replicate', FAL_API_KEY: 'provider.fal', KIE_API_KEY: 'provider.kie', WAVESPEED_API_KEY: 'provider.wavespeed',
  COMFY_CLOUD_API_KEY: 'comfy.cloudApiKey', COMFY_API_KEY: 'comfy.remoteApiKey', COMFY_ORG_API_KEY: 'comfy.comfyOrgApiKey',
  COMFY_CLOUD_URL: 'comfy.cloudUrl', COMFY_LOCAL_URL: 'comfy.localUrl', COMFY_REMOTE_URL: 'comfy.remoteUrl',
};
function importEnvironmentFile(filename, store) {
  let env;
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    // Parse as data: never source a shell script or alter process.env.
    env = parseEnv(fs.readFileSync(filename, 'utf8'));
  } catch { throw new Error('Choose a readable .env file smaller than 1 MB. The source file was not changed.'); }
  const current = store.read();
  const patch = {}, imported = [], skipped = [];
  for (const [variable, field] of Object.entries(fields)) {
    const value = env[variable]?.trim();
    if (!value || /^your_.*(?:here|key)$/i.test(value)) continue;
    if (current[field]) { skipped.push(variable); continue; }
    patch[field] = value; imported.push(variable);
  }
  const preferences = {};
  if (['cloud', 'local', 'remote'].includes(env.COMFY_MODE)) preferences.mode = env.COMFY_MODE;
  if (['0', '1'].includes(env.COMFY_API_V2)) {
    if (env.COMFY_MODE === 'local') preferences.localUsesApiV2 = env.COMFY_API_V2 === '1';
    if (env.COMFY_MODE === 'remote') preferences.remoteUsesApiV2 = env.COMFY_API_V2 === '1';
  }
  validateCredentials(patch);
  // Commit credentials before releasing anything to the renderer. Encryption or
  // disk failures leave both the source and the previous credentials intact.
  const credentials = imported.length ? store.write(patch) : current;
  return { cancelled: false, imported, skipped, credentials, preferences };
}
module.exports = { importEnvironmentFile };
