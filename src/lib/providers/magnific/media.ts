/**
 * Media for Magnific requests, server side.
 *
 * A field takes base64, a URL, or either (bindings.ts reads which from the
 * API description). The app holds data URLs and the http URLs of earlier
 * outputs, and has nowhere public to put a file, so a field that wants a
 * URL gets one from Magnific's own upload step:
 *
 *   POST /v1/ai/uploads/request-url  { files: [{ content_type }] }
 *     → { files: [{ upload_url, headers, asset_url, … }] }
 *   PUT  upload_url  (the bytes, with every header it named)
 *
 * `asset_url` is then usable wherever a URL is accepted, for a day.
 */
import { createHash } from "crypto";

import { validateMediaUrl } from "@/utils/urlValidation";
import { parseDataUrl } from "../comfyRouter/media";
import type { ComfyMediaValue } from "../comfyRouter/template";
import { MAGNIFIC_API_BASE, magnificHeaders } from "./api";
import type { MagnificInput } from "./bindings";

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
/** An image a field takes either way goes inline up to this size; above it, as an upload. */
export const INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** An upload's URL lasts a day; the same bytes reuse it for a while. */
const UPLOAD_REUSE_MS = 6 * 60 * 60 * 1000;

interface Decoded {
  bytes: Buffer;
  mime: string;
}

/** The types the upload step accepts. */
const UPLOAD_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/wav", "audio/mp4", "audio/webm", "audio/ogg",
]);

/** Other spellings of those types, as browsers and providers write them. */
const TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "video/x-m4v": "video/mp4",
};

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
};

export function normaliseType(mime: string): string {
  const plain = mime.split(";")[0]!.trim().toLowerCase();
  return TYPE_ALIASES[plain] ?? plain;
}

function typeFromUrl(url: string): string | undefined {
  try {
    const extension = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    return extension ? EXTENSION_TYPES[extension] : undefined;
  } catch {
    return undefined;
  }
}

async function download(url: string): Promise<Decoded> {
  const check = validateMediaUrl(url);
  if (!check.valid) throw new Error(`Invalid media URL: ${check.error}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Could not fetch an input (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("An input is larger than 200MB");
  const mime = normaliseType(response.headers.get("content-type") || "") || typeFromUrl(url) || "application/octet-stream";
  return { bytes, mime };
}

const uploads = new Map<string, { url: string; until: number }>();

/** Forget remembered uploads (tests). */
export function clearMagnificUploads(): void {
  uploads.clear();
}

interface UploadSlot {
  upload_url?: string;
  asset_url?: string;
  headers?: Record<string, string>;
  asset_url_expires_in?: number;
}

/**
 * Put a file with Magnific and return the URL its models can read it at.
 * The same bytes within a few hours reuse the first upload.
 */
export async function uploadToMagnific(apiKey: string, media: Decoded): Promise<string> {
  const type = normaliseType(media.mime);
  if (!UPLOAD_TYPES.has(type)) throw new Error(`Magnific cannot take a ${type || "file of unknown type"} as an input`);

  const hash = createHash("sha256").update(media.bytes).digest("hex");
  const cached = uploads.get(hash);
  if (cached && Date.now() < cached.until) return cached.url;

  const slotResponse = await fetch(`${MAGNIFIC_API_BASE}/uploads/request-url`, {
    method: "POST",
    headers: magnificHeaders(apiKey, true),
    body: JSON.stringify({ files: [{ content_type: type }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!slotResponse.ok) throw new Error(`Magnific refused the upload of an input (${slotResponse.status})`);
  const answer = (await slotResponse.json()) as { files?: UploadSlot[]; data?: { files?: UploadSlot[] } };
  const slot = (answer.files ?? answer.data?.files)?.[0];
  if (!slot?.upload_url || !slot.asset_url) throw new Error("Magnific returned no upload URL for an input");
  const check = validateMediaUrl(slot.upload_url);
  if (!check.valid || !slot.upload_url.startsWith("https://")) throw new Error("Magnific returned an upload URL the app will not use");

  // The returned headers are part of the URL's signature: all of them are sent.
  const put = await fetch(slot.upload_url, {
    method: "PUT",
    headers: { "Content-Type": type, ...(slot.headers ?? {}) },
    body: new Uint8Array(media.bytes),
    signal: AbortSignal.timeout(180_000),
  });
  if (!put.ok) throw new Error(`Upload of an input to Magnific failed (${put.status})`);

  const lifetime = typeof slot.asset_url_expires_in === "number" ? (slot.asset_url_expires_in * 1000) / 2 : UPLOAD_REUSE_MS;
  uploads.set(hash, { url: slot.asset_url, until: Date.now() + Math.min(lifetime, UPLOAD_REUSE_MS) });
  return slot.asset_url;
}

/** The bytes a data URL holds, counted without decoding it. */
function dataUrlBytes(value: string): number {
  const comma = value.indexOf(",");
  return comma === -1 ? 0 : Math.floor(((value.length - comma - 1) * 3) / 4);
}

/**
 * How a handle's media go in this request. A field that takes either gets
 * small images inline, the dependable way, and anything larger, any video
 * or audio, and anything already at a URL, by URL.
 */
export function chooseEncoding(handle: MagnificInput, values: string[]): "base64" | "url" {
  if (handle.encoding === "base64" || handle.encoding === "url") return handle.encoding;
  if (handle.type !== "image") return "url";
  const inline = values.every((value) => value.startsWith("data:") && dataUrlBytes(value) <= INLINE_IMAGE_BYTES);
  return inline ? "base64" : "url";
}

/**
 * One value the app holds, encoded the way its field wants it. `needsMime`
 * also learns a URL's type, for requests that name it beside the file.
 */
export async function encodeMagnificMedia(
  value: string,
  encoding: "base64" | "url",
  apiKey: string,
  options: { needsMime?: boolean } = {}
): Promise<ComfyMediaValue> {
  const isRemote = /^https?:\/\//.test(value);
  if (isRemote && encoding === "url") {
    const known = typeFromUrl(value);
    if (!options.needsMime || known) return { url: value, ...(known ? { mime: known } : {}) };
    return { url: value, mime: (await download(value)).mime };
  }

  const decoded = isRemote ? await download(value) : parseDataUrl(value);
  if (!decoded) throw new Error("An input is neither a data URL nor an http URL");
  const mime = normaliseType(decoded.mime);
  const base64 = decoded.bytes.toString("base64");
  const out: ComfyMediaValue = { mime, base64, dataUrl: `data:${mime};base64,${base64}` };
  if (encoding === "url") out.url = await uploadToMagnific(apiKey, decoded);
  return out;
}
