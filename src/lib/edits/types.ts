/**
 * Edit projects: the Edit video view's documents. One JSON file per edit,
 * `<Node Banana folder>/Edits/<name>.nbedit`, outside any workflow project,
 * holding the sequence with media by asset library id only. Shared by the
 * server module, the routes and the browser; no Node or DOM imports.
 */

import type { StitchAudioClip, StitchSequenceLayout, StitchTimelineClip } from "@/types";

export const EDIT_KIND = "node-banana-edit";
export const EDIT_VERSION = 1;
export const EDIT_FILE_EXT = ".nbedit";
/** "ed" + base36 time + 10 random base36: also a valid asset-library workflow id. */
export const EDIT_ID_PATTERN = /^ed[0-9a-z]{12,32}$/;
export const EDIT_NAME_MAX = 80;
export const EDIT_DEFAULT_NAME = "Untitled edit";
/** The largest edit file the server reads or writes. */
export const EDIT_BODY_LIMIT = 1024 * 1024;

export interface EditSequence {
  /** Every clip's source is { kind: "asset" }. */
  timeline: StitchTimelineClip[];
  /** Every source is { kind: "asset" }; rows compacted. */
  audioClips: StitchAudioClip[];
  loopCount: 1 | 2 | 3;
  sequenceLayout: StitchSequenceLayout;
}

/** What the library said about an asset when the edit was last saved, so a clip the library lost can still be named. */
export interface EditAssetSnapshot {
  /** The asset's display name when saved. */
  name: string;
  kind: "video" | "audio";
  /** The project folder's name; null when the asset is in no project. */
  project: string | null;
  durationSec: number | null;
}

export interface EditRender {
  assetId: string;
  renderedAt: number;
  durationSec: number | null;
}

export interface EditSummaryFields {
  clipCount: number;
  audioClipCount: number;
  /** One loop × loopCount, seconds, as the editor measured it at save. */
  durationSec: number;
  /** The first video clip's asset, for the poster; null with no clip. */
  posterAssetId: string | null;
}

export interface EditDocument {
  kind: typeof EDIT_KIND;
  version: typeof EDIT_VERSION;
  id: string;
  name: string;
  createdAt: number;
  /** Content or name changed; strictly increasing per file. A render added does not change it. */
  updatedAt: number;
  sequence: EditSequence;
  /** The assets that belong to the edit, in the order they were added; every asset the sequence uses is in it. */
  media: string[];
  /** Keyed by the ids in media; an item whose library record was never read has no entry. */
  assets: Record<string, EditAssetSnapshot>;
  renders: EditRender[];
  summary: EditSummaryFields;
}

export interface EditSummary extends EditSummaryFields {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  renderCount: number;
  fileName: string;
  /** Read from the library record of posterAssetId; null when it has none or is gone. */
  poster: { sha256: string; hasPoster: boolean } | null;
}

export interface EditListProblem {
  fileName: string;
  /**
   * unreadable: not an edit file this build can read. newer: saved by a newer version of Node Banana.
   * duplicate: carries the id of another edit (a copy made in Finder or Explorer).
   */
  problem: "unreadable" | "newer" | "duplicate";
  /** From the file when it could be read that far. */
  name: string | null;
}

export interface EditList {
  /** Newest updatedAt first. */
  edits: EditSummary[];
  problems: EditListProblem[];
  /** The Edits folder's absolute path (it may not exist yet). */
  folder: string;
}

export interface CreateEditRequest {
  /** Normalised; a name whose file is taken gets the next free one ("Untitled edit 2"). */
  name?: string;
  /** Duplicate: copy that edit's sequence, media, assets and summary (not its renders), named "<name> copy". */
  from?: string;
  /** "Save as a new edit" after a save found the edit gone. */
  sequence?: EditSequence;
  /** Absent = the sequence's assets. */
  media?: string[];
  assets?: Record<string, EditAssetSnapshot>;
  summary?: EditSummaryFields;
  /**
   * "Make it a separate edit": the file name (in the Edits folder) of a file listed as a "duplicate" problem. The
   * server gives that file a fresh id and answers with its document. No other field.
   */
  separate?: string;
}

export interface SaveEditRequest {
  baseUpdatedAt: number;
  /** true only for the conflict's "Keep mine": overwrite whatever is there (a missing edit still answers 404). */
  force?: boolean;
  sequence: EditSequence;
  /** Ids that are not asset ids are dropped, and the sequence's assets are added when missing. */
  media: string[];
  assets: Record<string, EditAssetSnapshot>;
  summary: EditSummaryFields;
  /** Merged with the stored ones by assetId. */
  renders: EditRender[];
}

export type PatchEditRequest = { op: "rename"; name: string } | { op: "addRender"; render: EditRender };

export interface EditDocumentResponse {
  document: EditDocument;
}
export interface PatchEditResponse {
  document: EditDocument;
  previousUpdatedAt: number;
}
export interface EditConflictBody {
  error: string;
  code: "conflict";
  current: EditDocument;
}

export const EDIT_ROUTES = {
  /** GET EditList; POST CreateEditRequest → 201 EditDocumentResponse. */
  list: "/api/edits",
  /** GET, PUT SaveEditRequest, PATCH PatchEditRequest → EditDocumentResponse / PatchEditResponse; DELETE → { ok }. */
  edit: (id: string) => `/api/edits/${encodeURIComponent(id)}`,
  /** POST → { ok: true }. */
  reveal: (id: string) => `/api/edits/${encodeURIComponent(id)}/reveal`,
  /** POST → { ok: true }; creates the Edits folder when needed. */
  folderReveal: "/api/edits/folder/reveal",
} as const;
