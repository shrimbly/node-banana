/**
 * The media types the library stores: what it will write or serve, by MIME
 * and by extension. Shared by the server library (`server/validate.ts`
 * re-exports it) and the browser, which turns away an upload in any other
 * format before sending it.
 */

import type { AssetKind } from "./types";

export interface MediaType {
  ext: string;
  mime: string;
  kind: AssetKind;
  /** Other MIME spellings seen in the wild (data: URLs, provider headers). */
  aliases?: string[];
  /** Other extensions for the same format. */
  extAliases?: string[];
}

/**
 * Everything the library will write or serve. An extension may appear under
 * two kinds when the container carries either (mp4/m4a, webm), so pick with
 * {@link mediaTypeForExt} and a kind rather than by extension alone.
 */
export const MEDIA_TYPES: readonly MediaType[] = [
  { ext: "png", mime: "image/png", kind: "image", aliases: ["image/apng"] },
  { ext: "jpg", mime: "image/jpeg", kind: "image", aliases: ["image/jpg", "image/pjpeg"], extAliases: ["jpeg"] },
  { ext: "gif", mime: "image/gif", kind: "image" },
  { ext: "webp", mime: "image/webp", kind: "image" },
  { ext: "svg", mime: "image/svg+xml", kind: "image", aliases: ["image/svg"] },
  { ext: "avif", mime: "image/avif", kind: "image" },
  {
    ext: "heic",
    mime: "image/heic",
    kind: "image",
    aliases: ["image/heif", "image/heic-sequence", "image/heif-sequence"],
    extAliases: ["heif"],
  },
  { ext: "mp4", mime: "video/mp4", kind: "video", aliases: ["video/x-m4v", "video/m4v"], extAliases: ["m4v"] },
  { ext: "webm", mime: "video/webm", kind: "video" },
  { ext: "mov", mime: "video/quicktime", kind: "video", aliases: ["video/mov"] },
  { ext: "mp3", mime: "audio/mpeg", kind: "audio", aliases: ["audio/mp3", "audio/mpeg3", "audio/x-mp3", "audio/x-mpeg"] },
  { ext: "wav", mime: "audio/wav", kind: "audio", aliases: ["audio/x-wav", "audio/wave", "audio/vnd.wave"] },
  { ext: "ogg", mime: "audio/ogg", kind: "audio", aliases: ["application/ogg", "audio/opus"], extAliases: ["oga", "opus"] },
  { ext: "flac", mime: "audio/flac", kind: "audio", aliases: ["audio/x-flac"] },
  { ext: "aac", mime: "audio/aac", kind: "audio", aliases: ["audio/x-aac", "audio/aacp"] },
  { ext: "m4a", mime: "audio/mp4", kind: "audio", aliases: ["audio/x-m4a", "audio/m4a"] },
  { ext: "webm", mime: "audio/webm", kind: "audio" },
  { ext: "glb", mime: "model/gltf-binary", kind: "3d" },
  { ext: "gltf", mime: "model/gltf+json", kind: "3d" },
  { ext: "obj", mime: "model/obj", kind: "3d" },
  { ext: "fbx", mime: "model/fbx", kind: "3d", aliases: ["application/fbx"] },
  { ext: "stl", mime: "model/stl", kind: "3d", aliases: ["application/sla", "model/x.stl-binary", "model/x.stl-ascii"] },
  { ext: "usdz", mime: "model/vnd.usdz+zip", kind: "3d", aliases: ["model/vnd.pixar.usd", "model/usd"] },
];

const DEFAULT_TYPE_BY_KIND: Record<AssetKind, string> = {
  image: "png",
  video: "mp4",
  audio: "mp3",
  "3d": "glb",
};

/** Every extension the library treats as media (lowercase, no dot). */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(
  MEDIA_TYPES.flatMap((type) => [type.ext, ...(type.extAliases ?? [])]),
);

function cleanMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** The media type for a MIME string (parameters ignored), or null when it is not allowlisted. */
export function mediaTypeForMime(mime: string | null | undefined): MediaType | null {
  if (!mime) return null;
  const clean = cleanMime(mime);
  return MEDIA_TYPES.find((type) => type.mime === clean || type.aliases?.includes(clean)) ?? null;
}

/** The media type for an extension. `kind` picks between containers that carry either. */
export function mediaTypeForExt(ext: string | null | undefined, kind?: AssetKind): MediaType | null {
  if (!ext) return null;
  const clean = ext.replace(/^\./, "").toLowerCase();
  const matches = MEDIA_TYPES.filter((type) => type.ext === clean || type.extAliases?.includes(clean));
  if (matches.length === 0) return null;
  return (kind && matches.find((type) => type.kind === kind)) || matches[0];
}

export function defaultMediaType(kind: AssetKind): MediaType {
  return mediaTypeForExt(DEFAULT_TYPE_BY_KIND[kind], kind)!;
}

export function isMediaExtension(ext: string): boolean {
  return MEDIA_EXTENSIONS.has(ext.replace(/^\./, "").toLowerCase());
}
