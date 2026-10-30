/**
 * Validation at the library's boundaries: ids and hashes before they reach a
 * path join, the media type allowlist, file names, and the sidecar scrub that
 * keeps records small and free of inline media.
 */

import path from "path";
import { isMediaExtension, mediaTypeForMime } from "../mediaTypes";
import { assetNameProblem, cleanAssetName } from "../name";
import {
  ASSET_ID_PATTERN,
  ASSET_KINDS,
  ASSET_ORIGINS,
  RUN_ID_PATTERN,
  SHA256_PATTERN,
  WORKFLOW_ID_PATTERN,
  type AssetBatch,
  type AssetKind,
  type AssetModelRef,
  type AssetPatch,
  type AssetProducer,
  type AssetRecord,
  type RecordAssetMeta,
} from "../types";
import { LibraryError } from "./errors";

export const MD5_PATTERN = /^[0-9a-f]{32}$/;

export function isAssetId(value: unknown): value is string {
  return typeof value === "string" && ASSET_ID_PATTERN.test(value);
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isMd5(value: unknown): value is string {
  return typeof value === "string" && MD5_PATTERN.test(value);
}

export function isWorkflowId(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_ID_PATTERN.test(value);
}

export function requireAssetId(value: unknown): string {
  if (!isAssetId(value)) throw new LibraryError("Invalid asset id", 400, "bad_request");
  return value;
}

export function requireRunId(value: unknown): string {
  if (!isRunId(value)) throw new LibraryError("Invalid run id", 400, "bad_request");
  return value;
}

export function requireSha256(value: unknown): string {
  if (!isSha256(value)) throw new LibraryError("Invalid content hash", 400, "bad_request");
  return value;
}

export function requireWorkflowId(value: unknown): string {
  if (!isWorkflowId(value)) throw new LibraryError("Invalid workflow id", 400, "bad_request");
  return value;
}

/* ------------------------------------------------------------------ */
/* Media types                                                         */
/* ------------------------------------------------------------------ */

// The list lives beside the types so the browser can check an upload against it too.
export {
  defaultMediaType,
  isMediaExtension,
  MEDIA_EXTENSIONS,
  MEDIA_TYPES,
  mediaTypeForExt,
  mediaTypeForMime,
  type MediaType,
} from "../mediaTypes";

/** Extension of a file name, lowercase, no dot ("" when none). */
export function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * A file name read from a sidecar, made safe to join into a folder: its
 * last path segment, which must carry a media extension and hold no NUL or
 * `:` (a Windows stream separator). Null when nothing usable is left.
 */
export function safeFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.split(/[\\/]/).pop() ?? "";
  if (!name || name === "." || name === ".." || name.length > 255 || /[\0:]/.test(name)) return null;
  return isMediaExtension(extOf(name)) ? name : null;
}

/** Extension of an URL's path, when it is a known media extension. */
export function mediaExtFromUrl(url: string): string | null {
  try {
    const ext = extOf(new URL(url).pathname.split("/").pop() ?? "");
    return ext && isMediaExtension(ext) ? ext : null;
  } catch {
    return null;
  }
}

/** A MIME type for snapshot media and posters: the allowlist, or a generic binary type. */
export function storageTypeForMime(mime: string | null | undefined): { mime: string; ext: string } {
  const type = mediaTypeForMime(mime);
  if (type) return { mime: type.mime, ext: type.ext };
  return { mime: "application/octet-stream", ext: "bin" };
}

/* ------------------------------------------------------------------ */
/* File names                                                          */
/* ------------------------------------------------------------------ */

/**
 * The prompt part of a project file name, exactly as /api/save-generation
 * has always built it, so project folders keep one naming scheme.
 */
export function legacyPromptSnippet(prompt: string | null | undefined): string {
  const snippet = (prompt ?? "")
    .slice(0, 30)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return snippet || "generation";
}

/** `<snippet>_<md5>.<ext>` — the legacy project file name; its stem is the carousel id. */
export function projectFileName(prompt: string | null | undefined, md5: string, ext: string): string {
  return `${legacyPromptSnippet(prompt)}_${md5}.${ext}`;
}

function slug(value: string, max: number): string {
  return value
    .toLowerCase()
    .slice(0, max)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The descriptive part of a library file name: the prompt, else the edit operation, else the kind. */
export function librarySnippet(meta: Pick<RecordAssetMeta, "prompt" | "producer" | "kind">): string {
  const fromPrompt = meta.prompt ? slug(meta.prompt, 30) : "";
  if (fromPrompt) return fromPrompt;
  const fromOperation = meta.producer.operation ? slug(meta.producer.operation, 30) : "";
  return fromOperation || meta.kind;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DD` in local time. */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `HHMMSS` in local time. */
export function localTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** `HHMMSS_<snippet>_<sha8>.<ext>`: sorts by time in Finder and Explorer within a day folder. */
export function libraryFileName(
  meta: Pick<RecordAssetMeta, "prompt" | "producer" | "kind" | "createdAt">,
  sha256: string,
  ext: string,
): string {
  return `${localTime(meta.createdAt)}_${librarySnippet(meta)}_${sha256.slice(0, 8)}.${ext}`;
}

/* ------------------------------------------------------------------ */
/* Paths from the client                                               */
/* ------------------------------------------------------------------ */

/** The longest project folder path the client may send. */
export const MAX_PROJECT_DIR_LENGTH = 1024;

/**
 * Normalises a project folder sent by the client. `path.resolve` fixes the
 * mixed separators the store builds on Windows (`C:\p/x`), a trailing
 * separator, and `.` segments; `..` is refused outright rather than resolved.
 * `what` names the folder in the refusals.
 */
export function normaliseProjectDir(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
  what = "project folder",
): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_PROJECT_DIR_LENGTH || value.includes("\0")) {
    throw new LibraryError(`Invalid ${what}`, 400, "bad_request");
  }
  if (value.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new LibraryError(`The ${what} must not contain '..'`, 400, "bad_request");
  }
  if (!api.isAbsolute(value)) {
    throw new LibraryError(`The ${what} must be an absolute path`, 400, "bad_request");
  }
  return api.resolve(value);
}

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

export const MAX_TAGS = 64;
export const MAX_TAG_LENGTH = 64;

/** Trimmed, whitespace-collapsed, de-duplicated case-insensitively (first spelling wins). */
export function normaliseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || tag.startsWith("data:") || tag.startsWith("blob:")) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/* ------------------------------------------------------------------ */
/* Sidecar scrub                                                       */
/* ------------------------------------------------------------------ */

export const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_PROMPT_LENGTH = 16 * 1024;
const MAX_STRING_LENGTH = 2 * 1024;
const MAX_PARAM_DEPTH = 8;
const MAX_PARAM_ARRAY = 256;

function isInlineMedia(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("blob:");
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Undefined means "drop this value". */
function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return isInlineMedia(value) ? undefined : clip(value, MAX_STRING_LENGTH);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "number" && !Number.isFinite(value) ? undefined : value;
  }
  if (depth >= MAX_PARAM_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_PARAM_ARRAY)) {
      const scrubbed = scrubValue(item, depth + 1);
      if (scrubbed !== undefined) out.push(scrubbed);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.length > 256) continue;
      const scrubbed = scrubValue(item, depth + 1);
      if (scrubbed !== undefined) out[key] = scrubbed;
    }
    return out;
  }
  return undefined;
}

function scrubString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || isInlineMedia(value)) return undefined;
  return clip(value, max);
}

/**
 * Bounds a record before it is written or held in memory: no data:/blob:
 * strings anywhere, prompt ≤ 16 KB, other strings ≤ 2 KB, and at most 64 KB
 * serialised — `parameters` are dropped when the rest would not fit.
 */
export function scrubRecord(record: AssetRecord): AssetRecord {
  const out: AssetRecord = { ...record, tags: normaliseTags(record.tags) };
  const prompt = scrubString(record.prompt, MAX_PROMPT_LENGTH);
  if (prompt === undefined) delete out.prompt;
  else out.prompt = prompt;
  for (const key of ["aspectRatio", "resolution"] as const) {
    const value = scrubString(record[key], MAX_STRING_LENGTH);
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  out.filename = clip(record.filename, MAX_STRING_LENGTH);
  const name = cleanAssetName(record.name);
  if (name === undefined) delete out.name;
  else out.name = name;
  out.workflowName =
    record.workflowName === null ? null : (scrubString(record.workflowName, MAX_STRING_LENGTH) ?? null);
  if (record.model) {
    const model: AssetModelRef = {
      provider: scrubString(record.model.provider, 256) ?? "",
      modelId: scrubString(record.model.modelId, 512) ?? "",
    };
    const displayName = scrubString(record.model.displayName, 512);
    if (displayName) model.displayName = displayName;
    out.model = model;
  }
  out.producer = scrubProducer(record.producer);
  const batch = scrubBatch(record.batch);
  if (batch) out.batch = batch;
  else delete out.batch;
  if (record.parameters !== undefined) {
    const parameters = scrubValue(record.parameters, 0);
    if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
      out.parameters = parameters as Record<string, unknown>;
    } else {
      delete out.parameters;
    }
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_SIDECAR_BYTES) delete out.parameters;
  return out;
}

function scrubProducer(producer: AssetProducer): AssetProducer {
  const out: AssetProducer = {
    nodeId: scrubString(producer.nodeId, 256) ?? "",
    nodeType: scrubString(producer.nodeType, 128) ?? "",
  };
  const nodeTitle = scrubString(producer.nodeTitle, 256);
  if (nodeTitle) out.nodeTitle = nodeTitle;
  const operation = scrubString(producer.operation, 128);
  if (operation) out.operation = operation;
  const outputHandle = scrubString(producer.outputHandle, 256);
  if (outputHandle) out.outputHandle = outputHandle;
  if (typeof producer.batchIndex === "number" && Number.isInteger(producer.batchIndex) && producer.batchIndex >= 0) {
    out.batchIndex = producer.batchIndex;
  }
  return out;
}

/** A batch tag that holds up (an id, 1 ≤ index ≤ count ≤ 1000), else undefined. */
function scrubBatch(value: unknown): AssetBatch | undefined {
  if (!isRecord(value)) return undefined;
  const id = scrubString(value.id, 128);
  const { index, count } = value;
  if (!id || !Number.isInteger(index) || !Number.isInteger(count)) return undefined;
  if ((index as number) < 1 || (count as number) < (index as number) || (count as number) > 1000) return undefined;
  return { id, index: index as number, count: count as number };
}

/* ------------------------------------------------------------------ */
/* Request bodies                                                      */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new LibraryError(`${field} must be a string`, 400, "bad_request");
  return value;
}

function optionalPositive(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LibraryError(`${field} must be a positive number`, 400, "bad_request");
  }
  return value;
}

/** Earliest `createdAt` accepted from a client (2020-01-01); later clamps to now. */
const MIN_CREATED_AT = Date.UTC(2020, 0, 1);

/** Checks a RecordAssetMeta from the client and returns a clean copy. */
export function validateRecordMeta(value: unknown, now: number = Date.now()): RecordAssetMeta {
  if (!isRecord(value)) throw new LibraryError("meta is required", 400, "bad_request");
  const id = requireAssetId(value.id);
  if (!(ASSET_KINDS as readonly unknown[]).includes(value.kind)) {
    throw new LibraryError("Invalid kind", 400, "bad_request");
  }
  if (!(ASSET_ORIGINS as readonly unknown[]).includes(value.origin)) {
    throw new LibraryError("Invalid origin", 400, "bad_request");
  }
  const producer = value.producer;
  if (!isRecord(producer) || typeof producer.nodeId !== "string" || typeof producer.nodeType !== "string") {
    throw new LibraryError("producer.nodeId and producer.nodeType are required", 400, "bad_request");
  }
  const workflowId = requireWorkflowId(value.workflowId);
  const runId = requireRunId(value.runId);
  const workflowName = value.workflowName === null || value.workflowName === undefined
    ? null
    : optionalString(value.workflowName, "workflowName") ?? null;

  let createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : now;
  if (createdAt < MIN_CREATED_AT || createdAt > now + 24 * 60 * 60 * 1000) createdAt = now;

  const meta: RecordAssetMeta = {
    id,
    kind: value.kind as AssetKind,
    origin: value.origin as RecordAssetMeta["origin"],
    createdAt: Math.floor(createdAt),
    producer: scrubProducer(producer as unknown as AssetProducer),
    workflowId,
    workflowName: workflowName === null ? null : clip(workflowName, MAX_STRING_LENGTH),
    runId,
  };
  const mime = optionalString(value.mime, "mime");
  if (mime) meta.mime = clip(mime, 128);
  const name = optionalString(value.name, "name");
  if (name !== undefined) {
    const problem = assetNameProblem(name);
    if (problem) throw new LibraryError(problem.replace(/\.$/, ""), 400, "bad_request");
    if (name.trim()) meta.name = name.trim();
  }
  const prompt = optionalString(value.prompt, "prompt");
  if (prompt) meta.prompt = prompt;
  if (value.model !== undefined && value.model !== null) {
    if (!isRecord(value.model) || typeof value.model.modelId !== "string") {
      throw new LibraryError("model.modelId is required", 400, "bad_request");
    }
    meta.model = {
      provider: typeof value.model.provider === "string" ? value.model.provider : "",
      modelId: value.model.modelId,
      ...(typeof value.model.displayName === "string" ? { displayName: value.model.displayName } : {}),
    };
  }
  if (isRecord(value.parameters)) meta.parameters = value.parameters;
  const aspectRatio = optionalString(value.aspectRatio, "aspectRatio");
  if (aspectRatio) meta.aspectRatio = aspectRatio;
  const resolution = optionalString(value.resolution, "resolution");
  if (resolution) meta.resolution = resolution;
  if (isRecord(value.cost) && typeof value.cost.amount === "number" && Number.isFinite(value.cost.amount)) {
    meta.cost = { amount: value.cost.amount, currency: "USD", estimated: value.cost.estimated === true };
  }
  if (value.projectDir !== undefined && value.projectDir !== null && value.projectDir !== "") {
    if (typeof value.projectDir !== "string") throw new LibraryError("projectDir must be a string", 400, "bad_request");
    meta.projectDir = value.projectDir;
  }
  const width = optionalPositive(value.width, "width");
  const height = optionalPositive(value.height, "height");
  if (width && height) {
    meta.width = Math.round(width);
    meta.height = Math.round(height);
  }
  const durationSec = optionalPositive(value.durationSec, "durationSec");
  if (durationSec) meta.durationSec = durationSec;
  const tags = normaliseTags(value.tags);
  if (tags.length) meta.tags = tags;
  const batch = scrubBatch(value.batch);
  if (batch) meta.batch = batch;
  return meta;
}

/** Checks an AssetPatch body. */
export function validatePatch(value: unknown): AssetPatch {
  if (!isRecord(value)) throw new LibraryError("Invalid patch", 400, "bad_request");
  const patch: AssetPatch = {};
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) throw new LibraryError("tags must be a list", 400, "bad_request");
    patch.tags = normaliseTags(value.tags);
  }
  if (value.favorite !== undefined) {
    if (typeof value.favorite !== "boolean") throw new LibraryError("favorite must be true or false", 400, "bad_request");
    patch.favorite = value.favorite;
  }
  if (value.trashed !== undefined) {
    if (typeof value.trashed !== "boolean") throw new LibraryError("trashed must be true or false", 400, "bad_request");
    patch.trashed = value.trashed;
  }
  if (value.name !== undefined) {
    if (typeof value.name !== "string") throw new LibraryError("name must be a string", 400, "bad_request");
    const problem = assetNameProblem(value.name);
    if (problem) throw new LibraryError(problem.replace(/\.$/, ""), 400, "bad_request");
    patch.name = value.name.trim();
  }
  return patch;
}
