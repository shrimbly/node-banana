import crypto from "crypto";

const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const base64UrlEncode = (input: Buffer) =>
  input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const generateRandomString = (size = 32) => base64UrlEncode(crypto.randomBytes(size));

export const createCodeChallenge = (verifier: string) =>
  base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());

export const buildAuthUrl = (params: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  clientId?: string;
}) => {
  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId || DEFAULT_CLIENT_ID);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  url.searchParams.set("id_token_add_organizations", "true");
  return url.toString();
};

export const exchangeAuthorizationCode = async (params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId?: string;
}) => {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", params.code);
  body.set("redirect_uri", params.redirectUri);
  body.set("code_verifier", params.codeVerifier);
  body.set("client_id", params.clientId || DEFAULT_CLIENT_ID);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${detail}`);
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    token_type?: string;
  }>;
};

export const decodeJwtPayload = (token: string) => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");

  try {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
};
