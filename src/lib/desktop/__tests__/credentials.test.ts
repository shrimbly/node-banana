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
it('session-only saves retain old secrets while persisting new non-secret preferences', async () => {
  bridge(false);
  localStorage.setItem('node-banana-provider-settings', JSON.stringify({ providers: { gemini: { apiKey: 'old-secret', enabled: true } } }));
  const credentials = await import('../credentials');
  await expect(credentials.initializeDesktopCredentials()).rejects.toThrow();
  credentials.useSessionCredentials();
  const { getProviderSettings, saveProviderSettings } = await import('@/store/utils/localStorage');
  const settings = getProviderSettings();
  settings.providers.gemini.apiKey = 'new-session-secret';
  settings.providers.gemini.enabled = false;
  saveProviderSettings(settings);
  const saved = JSON.parse(localStorage.getItem('node-banana-provider-settings')!);
  expect(saved.providers.gemini.enabled).toBe(false);
  expect(saved.providers.gemini.apiKey).toBe('old-secret');
  expect(JSON.stringify(saved)).not.toContain('new-session-secret');
});

it('imports encrypted credentials into memory and keeps only non-secret preferences in localStorage', async () => {
  bridge();
  localStorage.setItem('node-banana-comfy-settings', JSON.stringify({ mode: 'local' }));
  const importEnvironment = vi.fn(async () => ({ ok: true, value: {
    cancelled: false, imported: ['GEMINI_API_KEY', 'COMFY_API_KEY'], skipped: [],
    credentials: { 'provider.gemini': 'imported-secret', 'comfy.remoteApiKey': 'comfy-imported-secret' },
    preferences: { mode: 'remote', remoteUsesApiV2: true },
  } }));
  Object.assign(window.nodeBananaDesktop!.credentials, { importEnvironment });
  const credentials = await import('../credentials');
  await credentials.importDesktopEnvironment();
  expect(credentials.desktopCredential('provider.gemini')).toBe('imported-secret');
  expect(credentials.desktopCredential('comfy.remoteApiKey')).toBe('comfy-imported-secret');
  expect(JSON.stringify(localStorage)).not.toContain('imported-secret');
  expect(JSON.parse(localStorage.getItem('node-banana-comfy-settings')!)).toEqual({ mode: 'local', remoteUsesApiV2: true });
  importEnvironment.mockResolvedValueOnce({ ok: false, error: 'Encryption unavailable' } as never);
  await expect(credentials.importDesktopEnvironment()).rejects.toThrow('Encryption unavailable');
  expect(credentials.desktopCredential('provider.gemini')).toBe('imported-secret');
});
