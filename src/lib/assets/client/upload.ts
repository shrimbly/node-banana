/**
 * Files the user adds from their computer, kept in the asset library as
 * uploads (`origin: "uploaded"`): Add media, in the Edit video view and in
 * an Edit Video node's editor, and a drop on the view's media pane. An
 * upload is recorded like a render, under the edit it came in through (its
 * id and name stand in for a workflow; no workflow snapshot, no project), or
 * under "Uploads" when it came in outside an edit (the node's editor). It
 * keeps the file's own name as its display name; the library names the file
 * on disk itself. Only formats the library stores are taken. The same file
 * added twice is two records sharing one file; an upload never shares one
 * with a generated or edited asset.
 */

import { MEDIA_TYPES, mediaTypeForExt, mediaTypeForMime, type MediaType } from "../mediaTypes";
import { ASSET_NAME_MAX, oneLineName } from "../name";
import type { AssetKind, AssetProducer, AssetRunContext, AssetView } from "../types";
import { patchAsset } from "./api";
import { newRunId } from "./ids";
import { recordAsset } from "./recorder";

export type UploadKind = Extract<AssetKind, "video" | "audio">;

/** The workflow an upload made outside an edit is listed under. */
export const UPLOADS_WORKFLOW_ID = "uploads";
const UPLOADS_WORKFLOW_NAME = "Uploads";

export const NOT_MEDIA_REASON = "Only video and audio files can be added.";
/** For video or audio in a format the library doesn't store (AVI, AIFF…). */
export const UNSUPPORTED_MEDIA_REASON = "The library can't keep that kind of video or audio.";
const UNREADABLE_REASON = "The file couldn't be read as video or audio.";

/** How long the browser gets to read a file's length and size before the upload goes without them. */
const MEASURE_TIMEOUT_MS = 3_000;

type UploadType = MediaType & { kind: UploadKind };

const isUploadType = (type: MediaType): type is UploadType => type.kind === "video" || type.kind === "audio";

/** The video and audio formats the library stores, as the file chooser's `accept`: by type and by extension. */
export const UPLOAD_ACCEPT = [
  ...new Set(
    MEDIA_TYPES.filter(isUploadType).flatMap((type) => [
      type.mime,
      ...[type.ext, ...(type.extAliases ?? [])].map((ext) => `.${ext}`),
    ]),
  ),
].join(",");

/** Common video and audio formats the library doesn't store, known by extension when the browser gives no type. */
const OTHER_MEDIA_EXTENSIONS = new Set([
  "avi", "mkv", "wmv", "asf", "flv", "f4v", "mpg", "mpeg", "m2ts", "mts", "vob", "3gp", "3g2", "ogv",
  "aif", "aiff", "aifc", "caf", "wma", "amr", "ac3",
]);

const extOf = (name: string) => /\.([^.]+)$/.exec(name)?.[1];

/**
 * The library's video or audio type for a file, by the file's type, else by its extension; null for anything else,
 * including video and audio in a format the library doesn't store (AVI, AIFF…).
 */
function uploadTypeOf(file: Pick<File, "name" | "type">): UploadType | null {
  const type = mediaTypeForMime(file.type) ?? mediaTypeForExt(extOf(file.name));
  return type && isUploadType(type) ? type : null;
}

/** Video or audio the library can keep, by the file's type, else by its extension; null for anything else. */
export function uploadKindOf(file: Pick<File, "name" | "type">): UploadKind | null {
  return uploadTypeOf(file)?.kind ?? null;
}

/**
 * What a file is to Add media: video or audio the library keeps, video or audio in a format it doesn't
 * ("unsupported": a video/ or audio/ type, or a common media extension such as .avi or .aiff), or anything else.
 */
export function uploadVerdict(file: Pick<File, "name" | "type">): UploadKind | "unsupported" | "other" {
  const kind = uploadKindOf(file);
  if (kind) return kind;
  const type = file.type.toLowerCase();
  if (type.startsWith("video/") || type.startsWith("audio/")) return "unsupported";
  return OTHER_MEDIA_EXTENSIONS.has(extOf(file.name)?.toLowerCase() ?? "") ? "unsupported" : "other";
}

export interface MeasuredMedia {
  durationSec?: number;
  width?: number;
  height?: number;
}

export type MeasureMedia = (file: File, kind: UploadKind) => Promise<MeasuredMedia>;

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The file's length (and a video's size) as a media element reads them from its metadata; nothing when it can't
 * within a few seconds. The server measures the file too, so these only stand in when it can't.
 */
export function measureMedia(file: File, kind: UploadKind): Promise<MeasuredMedia> {
  if (typeof document === "undefined") return Promise.resolve({});
  let url: string;
  try {
    url = URL.createObjectURL(file);
  } catch {
    return Promise.resolve({});
  }
  const element = document.createElement(kind);
  element.preload = "metadata";
  element.muted = true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({}), MEASURE_TIMEOUT_MS);
    function finish(measured: MeasuredMedia) {
      clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      try {
        element.load();
      } catch {
        // Releasing the decoder is a courtesy.
      }
      URL.revokeObjectURL(url);
      resolve(measured);
    }
    element.onloadedmetadata = () => {
      const measured: MeasuredMedia = {};
      const durationSec = positive(element.duration);
      if (durationSec) measured.durationSec = durationSec;
      if (element instanceof HTMLVideoElement) {
        const width = positive(element.videoWidth);
        const height = positive(element.videoHeight);
        if (width && height) Object.assign(measured, { width, height });
      }
      finish(measured);
    };
    element.onerror = () => finish({});
    element.src = url;
  });
}

/** The file's name as a display name: one line, at most 120 characters, its extension kept. */
function uploadName(fileName: string): string | undefined {
  const name = oneLineName(fileName).trim();
  if (name.length <= ASSET_NAME_MAX) return name || undefined;
  const ext = /\.[^.\s]{1,10}$/.exec(name)?.[0] ?? "";
  let head = name.slice(0, ASSET_NAME_MAX - ext.length);
  // Not half of an emoji
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}${ext}`;
}

export interface UploadContext {
  /** The edit the file came in through; without one it is listed under "Uploads". */
  editId?: string;
  editName?: string;
}

export interface UploadDeps {
  measure?: MeasureMedia;
}

/**
 * Records a video or audio file into the library and resolves with its record. Rejects with an Error whose
 * message says why, as a sentence: not video or audio in a format the library stores, the library refused or could
 * not take it, or bytes nothing can read. The recorder's own notice stays quiet; the caller tells the user. Bytes nothing can read are kept but
 * never listed, as for any recording; a file whose bytes are something else (a picture named `.mp4`) is put in
 * the Trash, so the library doesn't list what the user was told wasn't added.
 */
export async function recordUpload(file: File, context: UploadContext = {}, deps: UploadDeps = {}): Promise<AssetView> {
  const type = uploadTypeOf(file);
  if (!type) throw new Error(uploadVerdict(file) === "unsupported" ? UNSUPPORTED_MEDIA_REASON : NOT_MEDIA_REASON);
  const { kind } = type;
  const measured = await (deps.measure ?? measureMedia)(file, kind).catch((): MeasuredMedia => ({}));
  const { editId, editName } = context;
  const run: AssetRunContext = {
    runId: newRunId(),
    workflowId: editId ?? UPLOADS_WORKFLOW_ID,
    workflowName: editId ? (editName ?? null) : UPLOADS_WORKFLOW_NAME,
    projectDir: null,
    startedAt: Date.now(),
  };
  const producer: AssetProducer = editId
    ? { nodeId: editId, nodeType: "editProject", ...(editName ? { nodeTitle: editName } : {}), operation: "upload" }
    : { nodeId: "upload", nodeType: "upload", operation: "upload" };
  const handle = recordAsset(
    {
      kind,
      origin: "uploaded",
      media: file,
      // The library's own spelling, found from the extension when the browser gave no type
      mime: type.mime,
      name: uploadName(file.name),
      producer,
      ...measured,
    },
    run,
    { quiet: true },
  );
  const result = await handle.done;
  if (!result) throw new Error(await handle.failed);
  const { asset } = result;
  if (asset.unreadable) throw new Error(UNREADABLE_REASON);
  if (asset.kind !== "video" && asset.kind !== "audio") {
    await patchAsset(asset.id, { trashed: true }).catch(() => {});
    throw new Error(UNREADABLE_REASON);
  }
  return asset;
}
