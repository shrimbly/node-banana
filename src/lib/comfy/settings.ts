import { isDesktop, desktopCredential, desktopCredentialsMigrated, saveDesktopCredentials, comfySecretFields } from "@/lib/desktop/credentials";
import type { DesktopCredentials } from "@/types/desktop";
/**
 * ComfyUI backend settings.
 *
 * Node Banana can drive three surfaces: **Comfy Cloud** (the default — no GPU
 * required), a **local** ComfyUI on this machine, and a **remote** ComfyUI
 * elsewhere on the network. Settings live in localStorage next to the other
 * provider settings and are forwarded to the API routes per request, so
 * changing an endpoint takes effect without a restart.
 */

import type { ComfyBackendMode, ComfyConnection } from "./types";

export const COMFY_SETTINGS_KEY = "node-banana-comfy-settings";
export const COMFY_APPS_KEY = "node-banana-comfy-apps";

/** Comfy Cloud's hosted deployment. */
export const COMFY_CLOUD_URL = "https://cloud.comfy.org";
/** ComfyUI's default local port. */
export const COMFY_LOCAL_URL = "http://127.0.0.1:8188";

/**
 * How long to wait for one render before giving up.
 *
 * Thirty minutes, not fifteen, because video is the case that decides it.
 * Frame interpolation runs a model per pair of frames: a 2-second clip measured
 * 128-197s on Comfy Cloud, and an 8-second one — four times the frames — lands
 * either side of fifteen minutes before queue time is counted. The old default
 * cut those off mid-render, and cutting off is expensive: the job is cancelled,
 * so the GPU time is spent and nothing comes back.
 */
export const COMFY_DEFAULT_JOB_TIMEOUT_MS = 1_800_000; // 30 minutes
const MIN_JOB_TIMEOUT_MS = 60_000;
const MAX_JOB_TIMEOUT_MS = 3_600_000;

/**
 * A job timeout the user (or a request header) supplied, brought into range.
 *
 * Shared with the server side so the two cannot drift: a browser storing one
 * bound and a route enforcing another would cancel a render the settings pane
 * said was still allowed.
 */
export function clampJobTimeoutMs(value: unknown): number {
  // `Number(null)` and `Number("")` are both 0, and 0 is finite — so a header
  // that was never sent used to clamp to the *minimum* rather than fall back to
  // the default. A request without one then ran with a one-minute job timeout
  // instead of thirty, and every long render was cancelled mid-flight.
  if (value === null || value === undefined || value === "") {
    return COMFY_DEFAULT_JOB_TIMEOUT_MS;
  }
  const ms = Number(value);
  return Number.isFinite(ms)
    ? Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, ms))
    : COMFY_DEFAULT_JOB_TIMEOUT_MS;
}

export interface ComfySettings {
  /** Backend used for Comfy app nodes. Cloud is the default. */
  mode: ComfyBackendMode;
  /** Comfy Cloud API key (`comfyui-…`). */
  cloudApiKey: string | null;
  cloudUrl: string;
  /** Base URL of a ComfyUI running on this machine. */
  localUrl: string;
  /** Base URL of a ComfyUI elsewhere on the network. */
  remoteUrl: string;
  /** Optional key for a remote instance behind auth. */
  remoteApiKey: string | null;
  /**
   * Whether the local / remote endpoint speaks the Comfy API v2 (i.e. it is
   * `comfy-api-proxy` or a serverless deployment rather than stock ComfyUI).
   * Stock ComfyUI only has the legacy `/api/prompt` surface, which Node Banana
   * drives directly.
   */
  localUsesApiV2: boolean;
  remoteUsesApiV2: boolean;
  /**
   * comfy.org key used to authenticate **partner/API nodes inside a workflow**
   * (Gemini, Kling, …). Distinct from the key that authenticates you to the
   * server, though it is usually the same value. Falls back to the Cloud key.
   */
  comfyOrgApiKey: string | null;
  /** How long to keep waiting for one job before giving up. */
  jobTimeoutMs: number;
  /** Re-randomise seed widgets on every run so repeat runs vary. */
  randomizeSeeds: boolean;
}

export const defaultComfySettings: ComfySettings = {
  mode: "cloud",
  cloudApiKey: null,
  cloudUrl: COMFY_CLOUD_URL,
  localUrl: COMFY_LOCAL_URL,
  remoteUrl: "",
  remoteApiKey: null,
  localUsesApiV2: false,
  remoteUsesApiV2: false,
  comfyOrgApiKey: null,
  jobTimeoutMs: COMFY_DEFAULT_JOB_TIMEOUT_MS,
  randomizeSeeds: true,
};

/** Strip a trailing slash so `${base}/api/...` never doubles up. */
export function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Merge stored settings over the defaults, so new fields are never lost. */
export function normalizeComfySettings(raw: unknown): ComfySettings {
  if (!raw || typeof raw !== "object") return { ...defaultComfySettings };
  const stored = raw as Partial<ComfySettings>;
  const mode: ComfyBackendMode =
    stored.mode === "local" || stored.mode === "remote" || stored.mode === "cloud"
      ? stored.mode
      : defaultComfySettings.mode;
  return {
    ...defaultComfySettings,
    ...stored,
    mode,
    cloudUrl: trimTrailingSlash(stored.cloudUrl || COMFY_CLOUD_URL) || COMFY_CLOUD_URL,
    localUrl: trimTrailingSlash(stored.localUrl || COMFY_LOCAL_URL) || COMFY_LOCAL_URL,
    remoteUrl: trimTrailingSlash(stored.remoteUrl || ""),
    jobTimeoutMs: clampJobTimeoutMs(stored.jobTimeoutMs),
  };
}

export function getComfySettings(): ComfySettings {
  if (typeof window === "undefined") return { ...defaultComfySettings };
  try {
    const stored = localStorage.getItem(COMFY_SETTINGS_KEY);
    const preferences = stored ? JSON.parse(stored) : {};
    if (isDesktop()) for (const key of comfySecretFields) preferences[key] = desktopCredential(`comfy.${key}`) ?? null;
    return normalizeComfySettings(preferences);
  } catch {
    return { ...defaultComfySettings };
  }
}

/** Fired on `window` after the settings are saved, so stores that mirror a field can refresh. */
export const COMFY_SETTINGS_CHANGED_EVENT = "node-banana:comfy-settings-changed";

export function saveComfySettings(settings: ComfySettings): void {
  if (typeof window === "undefined") return;
  const preferences = { ...normalizeComfySettings(settings) } as Partial<ComfySettings>;
  if (isDesktop()) {
    const secrets: DesktopCredentials = {};
    for (const key of comfySecretFields) { secrets[`comfy.${key}`] = preferences[key] ?? null; delete preferences[key]; }
    saveDesktopCredentials(secrets);
    if (!desktopCredentialsMigrated()) {
      const legacy = localStorage.getItem(COMFY_SETTINGS_KEY);
      const saved = legacy ? JSON.parse(legacy) : {};
      for (const key of comfySecretFields) if (saved[key] !== undefined) preferences[key] = saved[key];
    }
    localStorage.setItem(COMFY_SETTINGS_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new Event(COMFY_SETTINGS_CHANGED_EVENT));
    window.dispatchEvent(new Event(COMFY_SETTINGS_CHANGED_EVENT));
    return;
  }
  localStorage.setItem(COMFY_SETTINGS_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new Event(COMFY_SETTINGS_CHANGED_EVENT));
}

/* ── connection resolution ─────────────────────────────────────── */

/** The endpoint the current mode points at, or null when it is unconfigured. */
export function resolveComfyConnection(settings: ComfySettings): ComfyConnection | null {
  const jobTimeoutMs = settings.jobTimeoutMs;
  if (settings.mode === "cloud") {
    const baseUrl = settings.cloudUrl || COMFY_CLOUD_URL;
    if (!settings.cloudApiKey) return null;
    return { mode: "cloud", baseUrl, apiKey: settings.cloudApiKey, useSdk: true, jobTimeoutMs };
  }
  if (settings.mode === "local") {
    if (!settings.localUrl) return null;
    return {
      mode: "local",
      baseUrl: settings.localUrl,
      apiKey: null,
      useSdk: settings.localUsesApiV2,
      jobTimeoutMs,
    };
  }
  if (!settings.remoteUrl) return null;
  return {
    mode: "remote",
    baseUrl: settings.remoteUrl,
    apiKey: settings.remoteApiKey || null,
    useSdk: settings.remoteUsesApiV2,
    jobTimeoutMs,
  };
}

/** Why the current mode cannot run, in words the settings panel can show. */
export function comfyConfigError(settings: ComfySettings): string | null {
  if (settings.mode === "cloud" && !settings.cloudApiKey) {
    return "Add a Comfy Cloud API key to run workflows in the cloud.";
  }
  if (settings.mode === "local" && !settings.localUrl) {
    return "Set the URL of your local ComfyUI (usually http://127.0.0.1:8188).";
  }
  if (settings.mode === "remote" && !settings.remoteUrl) {
    return "Set the URL of your remote ComfyUI.";
  }
  return null;
}

/* ── request headers ───────────────────────────────────────────── */

export const COMFY_HEADERS = {
  mode: "X-Comfy-Mode",
  baseUrl: "X-Comfy-Base-Url",
  apiKey: "X-Comfy-Api-Key",
  orgKey: "X-Comfy-Org-Key",
  apiV2: "X-Comfy-Api-V2",
  jobTimeout: "X-Comfy-Job-Timeout",
} as const;

/**
 * Headers carrying the user's ComfyUI connection to an API route.
 *
 * Keys are held client-side (like every other provider key in Node Banana) and
 * forwarded per request rather than read from the server environment, so a user
 * can point at a different engine without touching `.env.local`.
 */
export function buildComfyHeaders(
  settings: ComfySettings,
  extra: Record<string, string> = {}
): Record<string, string> {
  const connection = resolveComfyConnection(settings);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (!connection) return headers;
  headers[COMFY_HEADERS.mode] = connection.mode;
  headers[COMFY_HEADERS.baseUrl] = connection.baseUrl;
  headers[COMFY_HEADERS.apiV2] = connection.useSdk ? "1" : "0";
  headers[COMFY_HEADERS.jobTimeout] = String(connection.jobTimeoutMs);
  if (connection.apiKey) headers[COMFY_HEADERS.apiKey] = connection.apiKey;
  const orgKey = settings.comfyOrgApiKey || settings.cloudApiKey;
  if (orgKey) headers[COMFY_HEADERS.orgKey] = orgKey;
  return headers;
}
