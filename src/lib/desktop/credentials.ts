import type { CredentialName, DesktopCredentials } from '@/types/desktop';

const PROVIDERS = 'node-banana-provider-settings';
const COMFY = 'node-banana-comfy-settings';
export const comfySecretFields = ['cloudApiKey', 'remoteApiKey', 'comfyOrgApiKey', 'cloudUrl', 'localUrl', 'remoteUrl'] as const;
let memory: DesktopCredentials = {};
let initialized = false;
let migrated = false;
let sessionOnly = false;
let initialization: Promise<void> | undefined;
let writes = Promise.resolve();
const pending: DesktopCredentials = {};

export const isDesktop = () => typeof window !== 'undefined' && !!window.nodeBananaDesktop;
export const desktopCredentialsReady = () => !isDesktop() || initialized;
export const desktopCredential = (name: CredentialName) => memory[name];
export const desktopCredentialsMigrated = () => migrated;

function stored(key: string) {
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) : {};
}
function legacyCredentials(): DesktopCredentials {
  const result: DesktopCredentials = {};
  for (const [id, config] of Object.entries(stored(PROVIDERS).providers || {})) {
    if ((config as { apiKey?: string }).apiKey) result[`provider.${id}` as CredentialName] = (config as { apiKey: string }).apiKey;
  }
  const comfy = stored(COMFY);
  for (const key of comfySecretFields) if (comfy[key]) result[`comfy.${key}`] = comfy[key];
  return result;
}
function scrubLegacy() {
  const providers = stored(PROVIDERS);
  for (const config of Object.values(providers.providers || {})) delete (config as { apiKey?: string }).apiKey;
  const comfy = stored(COMFY);
  for (const key of comfySecretFields) delete comfy[key];
  localStorage.setItem(PROVIDERS, JSON.stringify(providers));
  localStorage.setItem(COMFY, JSON.stringify(comfy));
  migrated = true;
}
function report(error: string) {
  initialization = undefined;
  window.dispatchEvent(new CustomEvent('desktop-credential-error', { detail: error }));
}
export function initializeDesktopCredentials(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    const legacy = legacyCredentials();
    memory = { ...legacy, ...memory };
    const bridge = window.nodeBananaDesktop!.credentials;
    const result = await bridge.read();
    if (!result.ok) throw new Error(result.error);
    // Encrypted values (including deletion tombstones) always win over old storage.
    const merged = { ...legacy, ...result.value, ...pending };
    const persisted = await bridge.write(merged);
    if (!persisted.ok) throw new Error(persisted.error);
    memory = persisted.value;
    scrubLegacy();
    for (const key of Object.keys(pending)) delete pending[key as CredentialName];
    initialized = true;
    sessionOnly = false;
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}
export function useSessionCredentials() {
  sessionOnly = true;
  initialized = true;
}
export function saveDesktopCredentials(patch: DesktopCredentials) {
  Object.assign(memory, patch);
  Object.assign(pending, patch);
  if (sessionOnly) return;
  // Serialize patches so rapid updates/deletes cannot finish out of order.
  writes = writes.then(async () => {
    const result = await window.nodeBananaDesktop!.credentials.write(patch);
    if (!result.ok) throw new Error(result.error);
    for (const [key, value] of Object.entries(patch)) {
      if (pending[key as CredentialName] === value) delete pending[key as CredentialName];
    }
  }).catch(error => report(error instanceof Error ? error.message : 'Keys could not be saved securely.'));
}


export async function importDesktopEnvironment() {
  await initializeDesktopCredentials();
  await writes;
  const result = await window.nodeBananaDesktop!.credentials.importEnvironment();
  if (!result.ok) throw new Error(result.error);
  if (result.value.cancelled) return result.value;
  // Edits made while the picker was open still win in renderer memory.
  memory = { ...result.value.credentials, ...pending };
  const comfy = stored(COMFY);
  for (const [key, value] of Object.entries(result.value.preferences)) {
    if (comfy[key] === undefined) comfy[key] = value;
  }
  localStorage.setItem(COMFY, JSON.stringify(comfy));
  return result.value;
}
