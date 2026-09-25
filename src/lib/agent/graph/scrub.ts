/**
 * Keeping media and oversized values out of what the agent sees.
 *
 * The snapshot is sent every turn and ends up in the model's context, so no
 * base64, data: or blob: URL may ever reach it. Values that had to be cut are
 * replaced with visible markers, and the draft refuses to write back an object
 * that still carries one (it would overwrite the user's real value).
 */

export const MEDIA_PLACEHOLDER = "[media omitted]";
export const OMITTED_PREFIX = "[omitted:";
export const TRUNCATED_MARKER = "… [truncated:";

/** Default cap for free text shown to the agent (the rest stays on the canvas). */
export const LONG_TEXT_LIMIT = 4000;
/**
 * Prompt and template text travel whole up to this length (the longest text a
 * setting accepts), so the draft can edit them without losing anything; only
 * what the model is shown is cut.
 */
export const FULL_TEXT_LIMIT = 50_000;
/** The shortest excerpt of a prompt the agent is shown (the per-turn canvas block). */
export const SHORTEST_TEXT_VIEW = 300;
/** Cap for strings nested inside settings objects (ComfyUI params, model parameters). */
export const NESTED_TEXT_LIMIT = 8000;
const MAX_ARRAY_ITEMS = 200;
const MAX_DEPTH = 8;
const BASE64_RUN = /^[A-Za-z0-9+/=\r\n]+$/;

/** data:/blob: URLs and long base64 runs. */
export function isMediaString(value: string): boolean {
  const head = value.slice(0, 5).toLowerCase();
  if (head === "data:" || head === "blob:") return true;
  return value.length > 1000 && !value.includes(" ") && BASE64_RUN.test(value.slice(0, 4000));
}

/** First `limit` characters, with a marker saying how much is left out. */
export function capText(text: string, limit: number = LONG_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${TRUNCATED_MARKER} ${text.length - limit} more characters; the full text is on the canvas]`;
}

export function isTruncatedText(value: unknown): boolean {
  return typeof value === "string" && value.includes(TRUNCATED_MARKER);
}

/** The length of the text before it was cut (the marker says how much is missing). */
export function fullTextLength(value: string): number {
  const at = value.indexOf(TRUNCATED_MARKER);
  if (at === -1) return value.length;
  const more = value.slice(at + TRUNCATED_MARKER.length).match(/^\s*(\d+)/);
  return at + (more ? Number(more[1]) : 0);
}

/** Whether a string carries any placeholder the agent's views put in place of real content (in any case). */
export function containsMarker(value: string): boolean {
  const lower = value.toLowerCase();
  return value.includes(TRUNCATED_MARKER) || lower.includes(OMITTED_PREFIX) || lower.includes(MEDIA_PLACEHOLDER);
}

/**
 * Recursively replaces media strings, caps long strings and long arrays, and
 * drops functions/undefined. Plain JSON in, plain JSON out.
 */
export function scrubDeep(value: unknown, stringLimit: number = NESTED_TEXT_LIMIT, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (isMediaString(value)) return MEDIA_PLACEHOLDER;
    if (value.length > stringLimit) return `${OMITTED_PREFIX} ${value.length} characters]`;
    return value;
  }
  if (depth >= MAX_DEPTH) return `${OMITTED_PREFIX} nested too deep]`;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubDeep(item, stringLimit, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`${OMITTED_PREFIX} ${value.length - MAX_ARRAY_ITEMS} more items]`);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || typeof entry === "function") continue;
      out[key] = scrubDeep(entry, stringLimit, depth + 1);
    }
    return out;
  }
  return null;
}

/** Whether a value (at any depth) carries a placeholder from `scrubDeep`. */
export function containsOmitted(value: unknown): boolean {
  if (typeof value === "string") return value === MEDIA_PLACEHOLDER || value.startsWith(OMITTED_PREFIX) || isTruncatedText(value);
  if (Array.isArray(value)) return value.some(containsOmitted);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsOmitted);
  return false;
}

/**
 * Final safety net: replaces every media string at any depth and changes
 * nothing else (no caps, so large canvases keep all their nodes).
 */
export function stripMedia<T>(value: T): T {
  if (typeof value === "string") return (isMediaString(value) ? MEDIA_PLACEHOLDER : value) as T;
  if (Array.isArray(value)) return value.map((item) => stripMedia(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined && typeof entry !== "function") out[key] = stripMedia(entry);
    }
    return out as T;
  }
  return value;
}

/** True when a data:/blob:/base64 string survives anywhere. */
export function containsMedia(value: unknown): boolean {
  if (typeof value === "string") return isMediaString(value);
  if (Array.isArray(value)) return value.some(containsMedia);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsMedia);
  return false;
}

/** Deep copy of JSON-like data. */
export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) out[key] = cloneJson(entry);
  }
  return out as T;
}
