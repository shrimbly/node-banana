import { beforeEach, afterEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => { delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop; });
function bridge(ok = true) {
  let encrypted: Record<string, string | null> = { 'provider.openai': null };
  const write = vi.fn(async (patch: Record<string, string | null>) => {
    if (!ok) return { ok: false, error: 'Keychain locked' };
    encrypted = { ...encrypted, ...patch };
    return { ok: true, value: encrypted };
  });
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: { credentials: {
    read: vi.fn(async () => ({ ok: true, value: encrypted })), write,
  } } });
  return write;
}
it('migrates secrets only after secure write and respects deletion tombstones', async () => {
  const write = bridge();
  localStorage.setItem('node-banana-provider-settings', JSON.stringify({ providers: { gemini: { apiKey: 'legacy-gemini', enabled: true }, openai: { apiKey: 'deleted-key' } } }));
  localStorage.setItem('node-banana-comfy-settings', JSON.stringify({ cloudApiKey: 'comfy-secret', mode: 'cloud', remoteUrl: 'https://user:password@example.test' }));
  const credentials = await import('../credentials');
  await credentials.initializeDesktopCredentials();
  expect(write).toHaveBeenCalledOnce();
  expect(credentials.desktopCredential('provider.gemini')).toBe('legacy-gemini');
  expect(credentials.desktopCredential('provider.openai')).toBeNull();
  expect(localStorage.getItem('node-banana-provider-settings')).not.toContain('legacy-gemini');
  expect(localStorage.getItem('node-banana-comfy-settings')).not.toContain('comfy-secret');
  expect(localStorage.getItem('node-banana-comfy-settings')).not.toContain('password');
  expect(localStorage.getItem('node-banana-comfy-settings')).toContain('cloud');
});
it('failed migration preserves legacy and session edits never touch plaintext storage', async () => {
  bridge(false);
  const legacy = JSON.stringify({ providers: { gemini: { apiKey: 'old-secret' } } });
  localStorage.setItem('node-banana-provider-settings', legacy);
  const credentials = await import('../credentials');
  await expect(credentials.initializeDesktopCredentials()).rejects.toThrow('Keychain locked');
  expect(credentials.desktopCredentialsReady()).toBe(false);
  expect(localStorage.getItem('node-banana-provider-settings')).toBe(legacy);
  credentials.useSessionCredentials();
  credentials.saveDesktopCredentials({ 'provider.gemini': 'session-secret' });
  expect(credentials.desktopCredential('provider.gemini')).toBe('session-secret');
  expect(localStorage.getItem('node-banana-provider-settings')).toBe(legacy);
  expect(credentials.desktopCredentialsReady()).toBe(true);
});
