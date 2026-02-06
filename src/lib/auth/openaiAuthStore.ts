import { promises as fs } from "fs";
import path from "path";

const STORE_PATH = path.join(process.cwd(), "data", "openai-auth.json");
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

export type OpenAIOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  accountId?: string;
  idToken?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type OpenAIOAuthHandshake = {
  state: string;
  codeVerifier: string;
  createdAt: number;
};

type OpenAIOAuthStore = {
  tokens?: OpenAIOAuthTokens;
  auth?: OpenAIOAuthHandshake;
};

type OpenAIRefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
};

const ensureStoreDir = async () => {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
};

const readStore = async (): Promise<OpenAIOAuthStore> => {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw) as OpenAIOAuthStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeStore = async (store: OpenAIOAuthStore) => {
  await ensureStoreDir();
  const payload = JSON.stringify(store, null, 2);
  await fs.writeFile(STORE_PATH, payload, "utf8");
};

export const getOAuthStatus = async () => {
  const store = await readStore();
  const expiresAt = store.tokens?.expiresAt;
  const connected = Boolean(store.tokens?.accessToken);
  const expired = expiresAt ? Date.now() >= expiresAt : false;
  return { connected, expiresAt, expired };
};

export const setOAuthHandshake = async (state: string, codeVerifier: string) => {
  const store = await readStore();
  store.auth = { state, codeVerifier, createdAt: Date.now() };
  await writeStore(store);
};

export const getOAuthHandshake = async () => {
  const store = await readStore();
  return store.auth ?? null;
};

export const clearOAuthHandshake = async () => {
  const store = await readStore();
  delete store.auth;
  await writeStore(store);
};

export const setOAuthTokens = async (tokens: OpenAIOAuthTokens) => {
  const store = await readStore();
  store.tokens = tokens;
  delete store.auth;
  await writeStore(store);
};

export const getOAuthTokens = async () => {
  const store = await readStore();
  return store.tokens ?? null;
};

export const clearOAuthTokens = async () => {
  const store = await readStore();
  delete store.tokens;
  await writeStore(store);
};

export const isTokenExpired = (tokens: OpenAIOAuthTokens | null, bufferSeconds = 60) => {
  if (!tokens?.expiresAt) {
    return false;
  }
  return Date.now() >= tokens.expiresAt - bufferSeconds * 1000;
};

export const refreshAccessToken = async (refreshToken: string, clientId: string) => {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", clientId);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} ${detail}`);
  }

  return (await response.json()) as OpenAIRefreshResponse;
};

export const buildTokenPayload = (response: OpenAIRefreshResponse, existing?: OpenAIOAuthTokens) => {
  const now = Date.now();
  const expiresAt = response.expires_in ? now + response.expires_in * 1000 : existing?.expiresAt;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? existing?.refreshToken,
    expiresAt,
    scope: response.scope ?? existing?.scope,
    idToken: response.id_token ?? existing?.idToken,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } as OpenAIOAuthTokens;
};
