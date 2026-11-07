/**
 * What a file is, and how big: magic-byte sniffing, pure-JS image dimensions
 * (PNG, JPEG, GIF, WebP, SVG), and a mediabunny probe for video and audio.
 * Nothing here decodes pixels.
 */

import { promises as fs } from "fs";
import type { AssetKind } from "../types";
import { sniffFamily } from "@/utils/mediaSniff";
import { errnoCode } from "./errors";
import { defaultMediaType, mediaTypeForExt, mediaTypeForMime, type MediaType } from "./validate";

/* ------------------------------------------------------------------ */
/* Sniffing                                                            */
/* ------------------------------------------------------------------ */

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.length >= end ? buf.toString("latin1", start, end) : "";
}

/**
 * The format families a file's first bytes prove, most specific first (the
 * shared sniffer in `src/utils/mediaSniff.ts`, so the save routes agree).
 */
export { sniffFamily };

export interface DecidedType extends MediaType {
  /** The bytes proved the format (as opposed to trusting a hint). */
  sniffed: boolean;
  /** Neither the bytes nor a hint named the format: it is the kind's default. */
  assumed?: true;
}

/**
 * The type to store a file as. Bytes win over hints; within a container that
 * can hold either, the declared kind picks (an audio-only mp4 is m4a). A
 * zip is only usdz when a 3D kind or hint says so. With no proof, the client's
 * MIME hint, then the URL's extension, then the kind's default.
 */
export function decideMediaType(input: {
  head: Buffer;
  kind: AssetKind;
  hintMime?: string | null;
  hintExt?: string | null;
}): DecidedType {
  const family = sniffFamily(input.head);
  const hinted = mediaTypeForMime(input.hintMime) ?? mediaTypeForExt(input.hintExt, input.kind);
  if (family) {
    const candidates = family
      .map((ext) => mediaTypeForExt(ext, input.kind))
      .filter((type): type is MediaType => type !== null);
    const zipOnlyFor3d = family[0] === "usdz" && input.kind !== "3d" && hinted?.ext !== "usdz";
    if (candidates.length && !zipOnlyFor3d) {
      const sameKind = candidates.find((type) => type.kind === input.kind);
      return { ...(sameKind ?? candidates[0]), sniffed: true };
    }
  }
  if (hinted) return { ...hinted, sniffed: false };
  return { ...defaultMediaType(input.kind), sniffed: false, assumed: true };
}

/* ------------------------------------------------------------------ */
/* Image dimensions                                                    */
/* ------------------------------------------------------------------ */

export interface Dimensions {
  width: number;
  height: number;
}

function valid(width: number, height: number): Dimensions | null {
  return width > 0 && height > 0 && width < 1_000_000 && height < 1_000_000 ? { width, height } : null;
}

function pngDimensions(buf: Buffer): Dimensions | null {
  if (buf.length < 24 || ascii(buf, 12, 16) !== "IHDR") return null;
  return valid(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

function gifDimensions(buf: Buffer): Dimensions | null {
  if (buf.length < 10) return null;
  return valid(buf.readUInt16LE(6), buf.readUInt16LE(8));
}

function webpDimensions(buf: Buffer): Dimensions | null {
  if (buf.length < 30) return null;
  const chunk = ascii(buf, 12, 16);
  if (chunk === "VP8X") {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return valid(width, height);
  }
  if (chunk === "VP8 ") {
    // Key frame start code 9d 01 2a, then 14-bit width/height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return valid(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

/** EXIF orientation from an APP1 segment (1 when absent). 5–8 swap width and height. */
function exifOrientation(segment: Buffer): number {
  if (ascii(segment, 0, 6) !== "Exif\0\0") return 1;
  const tiff = segment.subarray(6);
  if (tiff.length < 8) return 1;
  const little = ascii(tiff, 0, 2) === "II";
  const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

/** Walks JPEG markers to the first SOF; null when it is beyond the buffer. */
function jpegDimensions(buf: Buffer): Dimensions | null {
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && offset + 4 + length - 2 <= buf.length) {
      orientation = exifOrientation(buf.subarray(offset + 4, offset + 2 + length)) || 1;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return orientation >= 5 && orientation <= 8 ? valid(height, width) : valid(width, height);
    }
    if (marker === 0xda || marker === 0xd9) return null;
    offset += 2 + length;
  }
  return null;
}

function svgLength(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value);
  return match ? Math.round(parseFloat(match[1])) : null;
}

function svgDimensions(buf: Buffer): Dimensions | null {
  const text = buf.toString("utf8", 0, Math.min(buf.length, 8192));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const width = svgLength(attr("width"));
  const height = svgLength(attr("height"));
  if (width && height) return valid(width, height);
  const viewBox = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    return valid(Math.round(viewBox[2]), Math.round(viewBox[3]));
  }
  return null;
}

/** Pixel size of an image from its leading bytes, orientation applied for JPEG. */
export function imageDimensions(buf: Buffer, ext: string): Dimensions | null {
  try {
    switch (ext) {
      case "png":
        return pngDimensions(buf);
      case "jpg":
        return jpegDimensions(buf);
      case "gif":
        return gifDimensions(buf);
      case "webp":
        return webpDimensions(buf);
      case "svg":
        return svgDimensions(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Reads up to `bytes` from the start of a file. */
export async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Image dimensions from the head we already have, re-reading up to 2 MB of
 * the file for a JPEG whose metadata pushes the frame header further in.
 */
export async function imageDimensionsFromFile(file: string, ext: string, head?: Buffer): Promise<Dimensions | null> {
  const first = head ?? (await readHead(file, 64 * 1024).catch(() => Buffer.alloc(0)));
  const quick = imageDimensions(first, ext);
  if (quick || ext !== "jpg") return quick;
  const more = await readHead(file, 2 * 1024 * 1024).catch(() => null);
  return more ? imageDimensions(more, ext) : null;
}

/* ------------------------------------------------------------------ */
/* Video and audio probing                                             */
/* ------------------------------------------------------------------ */

export interface ProbeResult {
  width?: number;
  height?: number;
  durationSec?: number;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Dimensions and duration of a video or audio file via mediabunny, which
 * parses containers in plain Node (it cannot decode frames here). The input
 * is always disposed, so no file handle outlives the probe — a leaked handle
 * blocks renames and deletes on Windows. Never throws.
 */
export async function probeAudioVideo(
  source: { path: string } | { buffer: Uint8Array },
  kind: AssetKind,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  if (kind !== "video" && kind !== "audio") return {};
  let input: import("mediabunny").Input | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { Input, ALL_FORMATS, BufferSource, FilePathSource } = await import("mediabunny");
    const created = new Input({
      source: "path" in source ? new FilePathSource(source.path) : new BufferSource(source.buffer),
      formats: ALL_FORMATS,
    });
    input = created;
    const work = (async (): Promise<ProbeResult> => {
      const result: ProbeResult = {};
      if (kind === "video") {
        const track = await created.getPrimaryVideoTrack();
        if (track && track.displayWidth > 0 && track.displayHeight > 0) {
          result.width = track.displayWidth;
          result.height = track.displayHeight;
        }
      }
      const duration = await created.computeDuration();
      if (Number.isFinite(duration) && duration > 0) result.durationSec = Math.round(duration * 1000) / 1000;
      return result;
    })();
    work.catch(() => {});
    const timeout = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(() => resolve({}), timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    try {
      input?.dispose();
    } catch {
      // Already disposed.
    }
  }
}

/**
 * Whether mediabunny knows the container at all. `unreadable` only when it
 * read the bytes and no format it has can open them; a file it could not
 * read (missing, locked, offline), a probe that ran out of time, or any
 * other failure is `unknown`. The input is always disposed. Never throws.
 */
export async function probeContainer(
  file: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<"readable" | "unreadable" | "unknown"> {
  let input: import("mediabunny").Input | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { Input, ALL_FORMATS, FilePathSource } = await import("mediabunny");
    const created = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    input = created;
    const work = created.getFormat().then(
      () => "readable" as const,
      (error: unknown) =>
        error instanceof Error && !errnoCode(error) && /unsupported or unrecognizable format/i.test(error.message)
          ? ("unreadable" as const)
          : ("unknown" as const),
    );
    const timeout = new Promise<"unknown">((resolve) => {
      timer = setTimeout(() => resolve("unknown"), timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    try {
      input?.dispose();
    } catch {
      // Already disposed.
    }
  }
}
