/**
 * Pure functions over edit documents, shared by the server and the browser:
 * reading a file's JSON, the sequence ⇄ editor draft, the media, the asset
 * snapshot, the summary and names. Nothing here reads the clock, the DOM or
 * the disk.
 */

import { baseName } from "@/components/assets/assetFormat";
import { assetName } from "@/lib/assets/name";
import { ASSET_ID_PATTERN, type AssetView } from "@/lib/assets/types";
import { compactAudioRows, sanitizeAudioClips } from "@/lib/stitch/audioClips";
import { draftDuration, readSequenceLayout, type StitchDraft } from "@/lib/stitch/draft";
import { sanitizeTimeline } from "@/lib/stitch/migrate";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import type { SourceDurations } from "@/lib/stitch/timeline";
import {
  EDIT_DEFAULT_NAME,
  EDIT_ID_PATTERN,
  EDIT_KIND,
  EDIT_NAME_MAX,
  EDIT_VERSION,
  type EditAssetSnapshot,
  type EditDocument,
  type EditRender,
  type EditSequence,
  type EditSummaryFields,
} from "./types";

/** Longest asset name or project label a snapshot keeps. */
const SNAPSHOT_TEXT_MAX = 255;
const MEDIA_SCAN_DEPTH = 16;

type Fields = Record<string, unknown>;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isFields = (value: unknown): value is Fields => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type ParsedEdit =
  | { ok: true; document: EditDocument }
  /** id: the file's id when it carries a valid one, so a request for it can say why it can't be opened. */
  | { ok: false; problem: "unreadable" | "newer"; name: string | null; id: string | null };

/** A file's parsed JSON as a document. "newer": version > 1 (never opened or written). "unreadable": anything else wrong. */
export function parseEditDocument(raw: unknown): ParsedEdit {
  const fields = isFields(raw) ? raw : {};
  const name = typeof fields.name === "string" ? normalizeEditName(fields.name) : null;
  const id = typeof fields.id === "string" && EDIT_ID_PATTERN.test(fields.id) ? fields.id : null;
  const fail = (problem: "unreadable" | "newer") => ({ ok: false as const, problem, name, id });
  if (!isFields(raw) || fields.kind !== EDIT_KIND) return fail("unreadable");
  if (finite(fields.version) && fields.version > EDIT_VERSION) return fail("newer");
  if (fields.version !== EDIT_VERSION || id === null || name === null) return fail("unreadable");
  if (!finite(fields.createdAt) || !finite(fields.updatedAt) || !isFields(fields.sequence)) return fail("unreadable");
  const sequence = sanitizeEditSequence(fields.sequence);
  const media = sanitizeEditMedia(fields.media, sequence);
  return {
    ok: true,
    document: {
      kind: EDIT_KIND,
      version: EDIT_VERSION,
      id,
      name,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      sequence,
      media,
      assets: sanitizeEditAssets(fields.assets, media),
      renders: sanitizeEditRenders(fields.renders),
      summary: sanitizeEditSummary(fields.summary, sequence),
    },
  };
}

/**
 * Sanitize a stored or sent sequence: sanitizeTimeline then keep asset sources only; the audio sanitizer without music
 * (rows compacted); loopCount 1|2|3 else 1; the layout as a non-legacy node reads it.
 */
export function sanitizeEditSequence(raw: unknown): EditSequence {
  const fields = isFields(raw) ? raw : {};
  return {
    timeline: sanitizeTimeline(fields.timeline).filter((clip) => clip.source.kind === "asset"),
    audioClips: sanitizeAudioClips(fields.audioClips, { allowMusic: false }),
    loopCount: fields.loopCount === 2 || fields.loopCount === 3 ? fields.loopCount : 1,
    sequenceLayout: readSequenceLayout(fields.sequenceLayout, false),
  };
}

export function emptyEditSequence(): EditSequence {
  return { timeline: [], audioClips: [], loopCount: 1, sequenceLayout: { ...DEFAULT_SEQUENCE_LAYOUT } };
}

/**
 * The editor's draft for an edit: the sequence, its media (sanitizeEditMedia: the sequence's assets when none is
 * given), and the node-only legacy audio at its neutral value.
 */
export function draftFromEditSequence(seq: EditSequence, media?: readonly string[]): StitchDraft {
  const clean = sanitizeEditSequence(seq);
  return { ...clean, legacyAudio: { curve: [], muted: false }, media: sanitizeEditMedia(media, clean) };
}

/** The inverse. Keeps asset sources only (an edit's draft has no other by construction) and compacts the audio rows. */
export function editSequenceFromDraft(draft: StitchDraft): EditSequence {
  return {
    timeline: draft.timeline.filter((clip) => clip.source.kind === "asset"),
    audioClips: compactAudioRows(draft.audioClips.filter((clip) => clip.source.kind === "asset")).clips,
    loopCount: draft.loopCount,
    sequenceLayout: { ...draft.sequenceLayout },
  };
}

/** Asset ids in use, unique, timeline order then audio order. */
export function editAssetIds(seq: Pick<EditSequence, "timeline" | "audioClips">): string[] {
  const ids = new Set<string>();
  for (const clip of seq.timeline) if (clip.source.kind === "asset") ids.add(clip.source.assetId);
  for (const clip of seq.audioClips) if (clip.source.kind === "asset") ids.add(clip.source.assetId);
  return [...ids];
}

/** `media`, then the asset ids the sequence uses that it lacks, in first-use order. */
function withSequenceAssets(media: readonly string[], seq: Pick<EditSequence, "timeline" | "audioClips">): string[] {
  const have = new Set(media);
  return [...media, ...editAssetIds(seq).filter((id) => !have.has(id))];
}

/**
 * A stored or sent media list: asset ids only, once each, in their order, then any asset the sequence uses that it
 * lacks. Not an array (a file saved before edits had media) → the sequence's assets in first-use order.
 */
export function sanitizeEditMedia(raw: unknown, seq: Pick<EditSequence, "timeline" | "audioClips">): string[] {
  if (!Array.isArray(raw)) return editAssetIds(seq);
  const ids = new Set<string>();
  for (const id of raw as unknown[]) if (typeof id === "string" && ASSET_ID_PATTERN.test(id)) ids.add(id);
  return withSequenceAssets([...ids], seq);
}

/** What a save sends as the edit's media: the draft's, with any asset its clips use that it lacks appended. */
export function editMediaOf(draft: Pick<StitchDraft, "media" | "timeline" | "audioClips">): string[] {
  return withSequenceAssets(draft.media ?? [], draft);
}

/**
 * An edit's draft whose media lacks an asset its clips use, with it appended (a clip added from anywhere brings its
 * asset into the edit). The same draft when nothing is missing, or for a node's draft (no media).
 */
export function coverEditMedia(draft: StitchDraft): StitchDraft {
  if (draft.media === undefined) return draft;
  const media = withSequenceAssets(draft.media, draft);
  return media.length === draft.media.length ? draft : { ...draft, media };
}

function snapshotFromView(view: AssetView, kind: EditAssetSnapshot["kind"]): EditAssetSnapshot {
  return {
    name: assetName(view),
    kind,
    project: view.workflow.projectPath ? baseName(view.workflow.projectPath) : null,
    durationSec: finite(view.durationSec) ? view.durationSec : null,
  };
}

/**
 * The snapshot to save: for each id in the edit's media, the library record's facts when the record is known, else
 * the previous snapshot's entry (unknown or gone). Ids no longer in it are dropped. Never invents an entry.
 */
export function snapshotEditAssets(
  ids: readonly string[],
  lookup: (id: string) => AssetView | null | undefined,
  previous: Record<string, EditAssetSnapshot>,
): Record<string, EditAssetSnapshot> {
  const out: Record<string, EditAssetSnapshot> = {};
  for (const id of ids) {
    const view = lookup(id);
    if (view && (view.kind === "video" || view.kind === "audio")) out[id] = snapshotFromView(view, view.kind);
    else if (Object.hasOwn(previous, id)) out[id] = previous[id];
  }
  return out;
}

/**
 * clipCount, audioClipCount; durationSec = draftDuration × loopCount; posterAssetId = the first video clip's asset.
 * The caller passes provisional lengths (the measured ones, then the records' and the snapshot's), never the bare
 * measured map, so a save made before the media is probed does not write 0 s or a short length.
 */
export function summarizeEdit(draft: StitchDraft, durations: SourceDurations): EditSummaryFields {
  return {
    clipCount: draft.timeline.length,
    audioClipCount: draft.audioClips.length,
    durationSec: roundMs(draftDuration(draft, durations) * draft.loopCount),
    posterAssetId: posterAssetId(draft.timeline),
  };
}

function posterAssetId(timeline: EditSequence["timeline"]): string | null {
  for (const clip of timeline) if (clip.source.kind === "asset") return clip.source.assetId;
  return null;
}

function roundMs(sec: number): number {
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) / 1000 : 0;
}

/** Snapshot entries for the given ids (the edit's media), each field checked; anything else is dropped. */
export function sanitizeEditAssets(raw: unknown, ids: readonly string[]): Record<string, EditAssetSnapshot> {
  const out: Record<string, EditAssetSnapshot> = {};
  if (!isFields(raw)) return out;
  for (const id of ids) {
    const entry = Object.hasOwn(raw, id) ? raw[id] : undefined;
    if (!isFields(entry) || typeof entry.name !== "string" || (entry.kind !== "video" && entry.kind !== "audio")) continue;
    out[id] = {
      name: entry.name.slice(0, SNAPSHOT_TEXT_MAX),
      kind: entry.kind,
      project: typeof entry.project === "string" ? entry.project.slice(0, SNAPSHOT_TEXT_MAX) : null,
      durationSec: finite(entry.durationSec) && entry.durationSec >= 0 ? entry.durationSec : null,
    };
  }
  return out;
}

/** Valid renders, one per asset (the first kept), oldest first. */
export function sanitizeEditRenders(raw: unknown): EditRender[] {
  if (!Array.isArray(raw)) return [];
  const byAsset = new Map<string, EditRender>();
  for (const entry of raw as unknown[]) {
    const render = readRender(entry);
    if (render && !byAsset.has(render.assetId)) byAsset.set(render.assetId, render);
  }
  return [...byAsset.values()].sort((a, b) => a.renderedAt - b.renderedAt);
}

export function readRender(raw: unknown): EditRender | null {
  if (!isFields(raw) || typeof raw.assetId !== "string" || !ASSET_ID_PATTERN.test(raw.assetId)) return null;
  if (!finite(raw.renderedAt) || raw.renderedAt < 0) return null;
  return {
    assetId: raw.assetId,
    renderedAt: raw.renderedAt,
    durationSec: finite(raw.durationSec) && raw.durationSec >= 0 ? raw.durationSec : null,
  };
}

/** The stored renders plus the sent ones not already there (by assetId), oldest first. */
export function mergeEditRenders(stored: readonly EditRender[], sent: readonly EditRender[]): EditRender[] {
  return sanitizeEditRenders([...stored, ...sent]);
}

/** The counts and poster follow the sequence; only the length, which the browser measures, comes from `raw`. */
export function sanitizeEditSummary(raw: unknown, seq: EditSequence): EditSummaryFields {
  const durationSec = isFields(raw) ? raw.durationSec : undefined;
  return {
    clipCount: seq.timeline.length,
    audioClipCount: seq.audioClips.length,
    durationSec: finite(durationSec) ? roundMs(durationSec) : 0,
    posterAssetId: posterAssetId(seq.timeline),
  };
}

/** The first `max` UTF-16 units of `value`, less a surrogate pair's first half the cut would leave alone. */
function cutUnits(value: string, max: number): string {
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Trim, collapse whitespace, NFC, cut to EDIT_NAME_MAX; empty → EDIT_DEFAULT_NAME. */
export function normalizeEditName(input: string): string {
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const name = clean(cutUnits(clean(String(input ?? "").normalize("NFC")), EDIT_NAME_MAX));
  return name || EDIT_DEFAULT_NAME;
}

/** `base` cut so `suffix` fits in EDIT_NAME_MAX. */
function withSuffix(base: string, suffix: string): string {
  return `${cutUnits(base, EDIT_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

/** The first of base, "base 2", "base 3", … whose key is not in taken (keys compare file names, case-insensitively). */
export function firstFreeName(base: string, taken: ReadonlySet<string>, toKey: (name: string) => string): string {
  if (!taken.has(toKey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(base, ` ${n}`);
    if (!taken.has(toKey(candidate))) return candidate;
  }
}

/** "<name> copy"; firstFreeName then numbers it ("<name> copy 2", …). */
export function copyName(name: string): string {
  return withSuffix(name, " copy");
}

/**
 * A data: or blob: URL: "data:" then a media type or straight to its data, "blob:" then the origin's scheme. Not just
 * the word, so an edit may be called "Data: Q3".
 */
const MEDIA_URL = /^\s*(data:([a-z]+\/[a-z0-9.+-]+)?[;,]|blob:[a-z][a-z0-9+.-]*:)/i;

/** Any string anywhere in value, keys included, that is a data: or blob: URL (looked for down to 16 levels). */
export function containsMediaString(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return MEDIA_URL.test(value);
  if (depth >= MEDIA_SCAN_DEPTH || !value || typeof value !== "object") return false;
  const children = Array.isArray(value) ? value : [...Object.keys(value), ...Object.values(value)];
  return children.some((child) => containsMediaString(child, depth + 1));
}
