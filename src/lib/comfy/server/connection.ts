/**
 * Reading a ComfyUI connection off an incoming request.
 *
 * The browser holds the user's engine settings (same as every other provider
 * key in Node Banana) and forwards them per request, so an API route never
 * needs server-side configuration to reach the right engine. Environment
 * variables act as a fallback for a headless / shared deployment.
 */

import {
  clampJobTimeoutMs,
  COMFY_HEADERS,
  COMFY_CLOUD_URL,
  COMFY_DEFAULT_JOB_TIMEOUT_MS,
} from "../settings";
import type { ComfyBackendMode, ComfyConnection } from "../types";

export class ComfyConfigError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ComfyConfigError";
    this.status = status;
  }
}

/**
 * Validate an engine base URL.
 *
 * Unlike {@link import("@/utils/urlValidation").validateMediaUrl}, private and
 * loopback addresses are *allowed* here: pointing at `127.0.0.1:8188` is the
 * entire purpose of local mode. The URL still comes from the user's own
 * settings, never from workflow content, so the check is limited to rejecting
 * non-HTTP schemes (`file:`, `gopher:`) that could reach outside the intended
 * transport.
 */
export function validateEngineUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ComfyConfigError(`"${raw}" is not a valid ComfyUI URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ComfyConfigError(`ComfyUI URL must be http or https, not ${parsed.protocol}`);
  }
  return raw.replace(/\/+$/, "");
}

function envConnection(): ComfyConnection | null {
  const mode = (process.env.COMFY_MODE as ComfyBackendMode | undefined) ?? "cloud";
  if (mode === "cloud") {
    const apiKey = process.env.COMFY_CLOUD_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      mode: "cloud",
      baseUrl: validateEngineUrl(process.env.COMFY_CLOUD_URL?.trim() || COMFY_CLOUD_URL),
      apiKey,
      useSdk: true,
      jobTimeoutMs: COMFY_DEFAULT_JOB_TIMEOUT_MS,
    };
  }
  const url = (mode === "local" ? process.env.COMFY_LOCAL_URL : process.env.COMFY_REMOTE_URL)?.trim();
  if (!url) return null;
  return {
    mode,
    baseUrl: validateEngineUrl(url),
    apiKey: process.env.COMFY_API_KEY?.trim() || null,
    useSdk: process.env.COMFY_API_V2 === "1",
    jobTimeoutMs: COMFY_DEFAULT_JOB_TIMEOUT_MS,
  };
}

/** A request may select an engine, but cannot select where server secrets go. */
function isEnvironmentEngine(baseUrl: string): boolean {
  const mode = process.env.COMFY_MODE ?? "cloud";
  const configuredUrl = mode === "cloud"
    ? process.env.COMFY_CLOUD_URL?.trim() || COMFY_CLOUD_URL
    : mode === "local"
      ? process.env.COMFY_LOCAL_URL?.trim()
      : process.env.COMFY_REMOTE_URL?.trim();
  if (!configuredUrl) return false;
  try {
    // Compare the entire endpoint, not just a hostname: separate Comfy tenants
    // can live under different path prefixes on the same reverse proxy.
    const canonical = (url: string) => new URL(url).href.replace(/\/+$/, "");
    return canonical(baseUrl) === canonical(configuredUrl);
  } catch {
    return false;
  }
}

function environmentApiKey(baseUrl: string): string | null {
  if (!isEnvironmentEngine(baseUrl)) return null;
  return (process.env.COMFY_MODE ?? "cloud") === "cloud"
    ? process.env.COMFY_CLOUD_API_KEY?.trim() || null
    : process.env.COMFY_API_KEY?.trim() || null;
}

/**
 * The engine this request targets.
 *
 * @throws {ComfyConfigError} when neither the request nor the environment
 * names a reachable engine — the message is shown to the user verbatim.
 */
export function connectionFromRequest(request: Request): ComfyConnection {
  const headers = request.headers;
  const rawMode = headers.get(COMFY_HEADERS.mode);
  const rawBaseUrl = headers.get(COMFY_HEADERS.baseUrl);

  if (!rawBaseUrl) {
    const fallback = envConnection();
    if (fallback) return fallback;
    throw new ComfyConfigError(
      "No ComfyUI engine is configured. Open Settings → ComfyUI to connect to Comfy Cloud or a local install."
    );
  }

  const mode: ComfyBackendMode =
    rawMode === "local" || rawMode === "remote" || rawMode === "cloud" ? rawMode : "cloud";
  const timeout = headers.get(COMFY_HEADERS.jobTimeout);
  const baseUrl = validateEngineUrl(rawBaseUrl);

  return {
    mode,
    baseUrl,
    // The browser holds the user's key; the env var is the fallback for a
    // headless deployment where no browser supplies one.
    apiKey: headers.get(COMFY_HEADERS.apiKey) || environmentApiKey(baseUrl),
    useSdk: headers.get(COMFY_HEADERS.apiV2) === "1",
    jobTimeoutMs: clampJobTimeoutMs(timeout),
  };
}

/**
 * The comfy.org key that authenticates **partner/API nodes inside a workflow**
 * (Gemini, Kling, …). Sent as `extra_data.api_key_comfy_org` alongside the
 * graph; without it those nodes fail with "Please login first to use this node"
 * even when the job itself is authorized.
 */
export function orgKeyFromRequest(request: Request, connection: ComfyConnection): string | null {
  return (
    request.headers.get(COMFY_HEADERS.orgKey) ||
    (isEnvironmentEngine(connection.baseUrl) ? process.env.COMFY_ORG_API_KEY?.trim() : null) ||
    connection.apiKey ||
    null
  );
}

/** Auth headers for a direct call to the engine's HTTP API. */
export function engineAuthHeaders(connection: ComfyConnection): Record<string, string> {
  if (!connection.apiKey) return {};
  // Comfy Cloud accepts either; a proxied v2 endpoint expects Bearer.
  return connection.useSdk
    ? { Authorization: `Bearer ${connection.apiKey}` }
    : { "X-API-Key": connection.apiKey };
}
