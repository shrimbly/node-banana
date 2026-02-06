import { promises as fs } from "fs";
import path from "path";

const STORE_PATH = path.join(process.cwd(), "data", "openai-auth.json");
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_STORE_PATH = path.join(process.cwd(), "data", "auth.json");

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

const parseJwtExp = (token?: string) => {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");

  try {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const json = JSON.parse(decoded) as { exp?: number };
    return json.exp ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

const loadCodexTokens = async () => {
  try {
    const raw = await fs.readFile(CODEX_STORE_PATH, "utf8");
    const codex = JSON.parse(raw) as {
      openai?: {
        access?: string;
        refresh?: string;
        expires?: number;
        accountId?: string;
        idToken?: string;
      };
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        account_id?: string;
      };
      last_refresh?: string;
    };

    if (codex.openai?.access) {
      const now = Date.now();
      const createdAt = codex.last_refresh ? Date.parse(codex.last_refresh) : now;
      return {
        accessToken: codex.openai.access,
        refreshToken: codex.openai.refresh,
        expiresAt: codex.openai.expires ?? parseJwtExp(codex.openai.access),
        accountId: codex.openai.accountId,
        idToken: codex.openai.idToken,
        createdAt: Number.isNaN(createdAt) ? now : createdAt,
        updatedAt: now,
      } as OpenAIOAuthTokens;
    }

    if (codex.tokens?.access_token) {
      const now = Date.now();
      const createdAt = codex.last_refresh ? Date.parse(codex.last_refresh) : now;
      return {
        accessToken: codex.tokens.access_token,
        refreshToken: codex.tokens.refresh_token,
        idToken: codex.tokens.id_token,
        accountId: codex.tokens.account_id,
        expiresAt: parseJwtExp(codex.tokens.access_token),
        createdAt: Number.isNaN(createdAt) ? now : createdAt,
        updatedAt: now,
      } as OpenAIOAuthTokens;
    }

    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const importCodexTokensIfNeeded = async (force = false) => {
  const store = await readStore();
  if (!force && store.tokens?.accessToken) {
    return store.tokens;
  }

  const imported = await loadCodexTokens();
  if (!imported?.accessToken) {
    return null;
  }

  store.tokens = imported;
  await writeStore(store);
  return imported;
};

const writeStore = async (store: OpenAIOAuthStore) => {
  await ensureStoreDir();
  const payload = JSON.stringify(store, null, 2);
  await fs.writeFile(STORE_PATH, payload, "utf8");
};

export const getOAuthStatus = async () => {
  const tokens = await getOAuthTokens();
  const expiresAt = tokens?.expiresAt;
  const connected = Boolean(tokens?.accessToken);
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
  if (store.tokens?.accessToken) {
    const codex = await loadCodexTokens();
    if (codex?.accessToken && codex.accessToken !== store.tokens.accessToken) {
      const codexIsNewer = (codex.expiresAt ?? 0) > (store.tokens.expiresAt ?? 0);
      if (codexIsNewer || isTokenExpired(store.tokens)) {
        await setOAuthTokens(codex);
        return codex;
      }
    }

    if (!isTokenExpired(store.tokens)) {
      return store.tokens;
    }

    const imported = await importCodexTokensIfNeeded(true);
    return imported ?? store.tokens;
  }

  return await importCodexTokensIfNeeded();
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
