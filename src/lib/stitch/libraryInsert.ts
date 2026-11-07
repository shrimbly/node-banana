import type { AssetView } from "@/lib/assets/types";
import type { StitchAudioClip } from "@/types";
import {
  audioRowCount,
  createAudioClip,
  normalizeAudioClips,
  overlapsOnRow,
  type AudioLengthOf,
  type AudioRowMap,
} from "./audioClips";
import type { AudioSectionLayout } from "./audioLayout";
import { draftDuration, type StitchDraft } from "./draft";
import {
  appendClips,
  createClip,
  END_EPSILON_SEC,
  isPlaced,
  layoutSpans,
  MAX_START_SEC,
  pinStarts,
  sourceKey,
  spanAtTime,
  spansEnd,
  type ClipSpan,
  type SourceDurations,
  type SourceKey,
} from "./timeline";
import type { TimeAxis } from "./timeAxis";
import { SNAP_THRESHOLD_PX } from "./trimDrag";

/**
 * Where a video or a sound from the library goes in an edit's timeline: at the playhead (a click on a tile) or where a
 * drag drops it, and the draft with it inserted. Pure: the Edit video view's pane and drag call these through
 * editorActions' addLibraryItemAt.
 */

export type LibraryItem = { assetId: string; kind: "video" | "audio"; durationSec: number | null };

export type LibraryDropTarget =
  /** Track: inserted before `index` (= length: appended). */
  | { lane: "clips"; mode: "track"; index: number }
  /** Stacked: a new row inserted at `row` (= length: the bottom), starting at startSec; every other clip pinned. */
  | { lane: "clips"; mode: "stacked"; startSec: number; row: number }
  /** Stacked, lined up, the playhead at or past the end (a click only): appended lined up, nothing pinned. */
  | { lane: "clips"; mode: "stackedAppend" }
  /** An audio row, or (newRow) a new row inserted at `row`. */
  | { lane: "audio"; startSec: number; row: number; newRow: boolean };

export const WAITING_FOR_CLIPS = "Waiting for the clips to load";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const usable = (sec: number | null | undefined): sec is number => typeof sec === "number" && Number.isFinite(sec) && sec > 0;

export function libraryItemOf(view: Pick<AssetView, "id" | "kind" | "durationSec">): LibraryItem | null {
  if (view.kind !== "video" && view.kind !== "audio") return null;
  return { assetId: view.id, kind: view.kind, durationSec: usable(view.durationSec) ? view.durationSec : null };
}

/**
 * The lengths to place with: the measured ones, then for each library clip not measured, its record's durationSec
 * (`lookup`, the editor's asset cache), then the edit's snapshot. A clip with none of the three is left out. The same
 * map when nothing is added.
 */
export function provisionalDurations(
  draft: Pick<StitchDraft, "timeline">,
  measured: SourceDurations,
  lookup: (assetId: string) => { durationSec?: number | null } | null | undefined,
  snapshot: Readonly<Record<string, { durationSec: number | null }>>,
): SourceDurations {
  let out: Map<SourceKey, number> | null = null;
  for (const clip of draft.timeline) {
    if (clip.source.kind !== "asset") continue;
    const key = sourceKey(clip.source);
    if (measured.has(key) || out?.has(key)) continue;
    const { assetId } = clip.source;
    const record = lookup(assetId)?.durationSec;
    const known = usable(record) ? record : Object.hasOwn(snapshot, assetId) ? snapshot[assetId].durationSec : null;
    if (!usable(known)) continue;
    out ??= new Map(measured);
    out.set(key, known);
  }
  return out ?? measured;
}

/**
 * Why an edit that pins a stack must wait, or null: not every clip has a start yet while some clip's media is still
 * loading, so the pins would come from a length the editor does not know yet. A Stacked paste or duplicate asks this.
 */
export function pinWaitsForLoading(draft: Pick<StitchDraft, "timeline">, loadingKeys: ReadonlySet<SourceKey>): string | null {
  if (draft.timeline.every((clip) => clip.startSec !== undefined)) return null;
  return draft.timeline.some((clip) => loadingKeys.has(sourceKey(clip.source))) ? WAITING_FOR_CLIPS : null;
}

/**
 * Why an add must wait, or null: a Stacked add that would pin the clips while one is loading (pinWaitsForLoading).
 * Track, audio and a lined-up append never wait.
 */
export function stackedAddBlocked(
  draft: Pick<StitchDraft, "timeline">,
  target: LibraryDropTarget,
  loadingKeys: ReadonlySet<SourceKey>,
): string | null {
  if (target.lane !== "clips" || target.mode !== "stacked") return null;
  return pinWaitsForLoading(draft, loadingKeys);
}

/**
 * Where a click adds at the playhead.
 * - Video in Track: after the clip under the playhead, before it when the playhead is exactly at its start (unless
 *   that clip is selected: a clip just added is, so clicks in a row keep their order), appended past the end.
 * - Video in Stacked, lined up, the playhead at or past the end (an empty timeline too): appended lined up.
 * - Video in Stacked otherwise: a new bottom row starting at the playhead.
 * - Audio: the first row with room at the playhead for the sound's length (unknown: to the end), else a new bottom row.
 */
export function playheadTarget(
  draft: StitchDraft,
  durations: SourceDurations,
  playhead: number,
  item: LibraryItem,
  audioLengthOf: AudioLengthOf,
  selectedClipIds: ReadonlySet<string> = new Set(),
): LibraryDropTarget {
  const at = clamp(Number.isFinite(playhead) ? playhead : 0, 0, MAX_START_SEC);
  if (item.kind === "audio") {
    const length = item.durationSec ?? Infinity;
    const rows = audioRowCount(draft.audioClips);
    for (let row = 0; row < rows; row++) {
      if (!overlapsOnRow(draft.audioClips, audioLengthOf, row, at, length, new Set())) {
        return { lane: "audio", startSec: at, row, newRow: false };
      }
    }
    return { lane: "audio", startSec: at, row: rows, newRow: true };
  }
  const { timeline, sequenceLayout: layout } = draft;
  if (layout.mode === "stacked") {
    if (!isPlaced(timeline) && at >= draftDuration(draft, durations) - END_EPSILON_SEC) {
      return { lane: "clips", mode: "stackedAppend" };
    }
    return { lane: "clips", mode: "stacked", startSec: at, row: timeline.length };
  }
  const spans = layoutSpans(timeline, durations, layout);
  const span = at >= spansEnd(spans) - END_EPSILON_SEC ? null : spanAtTime(spans, at);
  if (!span) return { lane: "clips", mode: "track", index: timeline.length };
  const startsHere = (sp: ClipSpan) => Math.abs(at - sp.start) <= END_EPSILON_SEC;
  // Where a crossfade overlaps two clips the playhead is under both: the selected one decides
  const selected = spans.find((sp) => selectedClipIds.has(sp.clip.id) && startsHere(sp));
  if (selected) return { lane: "clips", mode: "track", index: selected.index + 1 };
  return { lane: "clips", mode: "track", index: startsHere(span) ? span.index : span.index + 1 };
}

/**
 * The draft with the item inserted at the target, the new clip's id, and (an audio row inserted) how the audio rows
 * moved. Track: inserted at index, nothing else changes. stackedAppend: appended, nothing pinned. Stacked: every clip
 * pinned where `durations` shows it (pass provisionalDurations), then the new row. Audio: on the row, or a new row
 * inserted there (the rows under it move down one). An item of the wrong kind for the lane changes nothing.
 */
export function insertLibraryItem(
  draft: StitchDraft,
  durations: SourceDurations,
  item: LibraryItem,
  target: LibraryDropTarget,
): { draft: StitchDraft; clipId: string | null; rowMap: AudioRowMap | null } {
  const unchanged = { draft, clipId: null, rowMap: null };
  if ((target.lane === "audio") !== (item.kind === "audio")) return unchanged;
  const source = { kind: "asset" as const, assetId: item.assetId };

  if (target.lane === "audio") {
    const rows = audioRowCount(draft.audioClips);
    const row = clamp(Math.trunc(target.row), 0, target.newRow ? rows : Math.max(0, rows - 1));
    let clips: StitchAudioClip[] = draft.audioClips;
    let rowMap: AudioRowMap | null = null;
    if (target.newRow && row < rows) {
      rowMap = Array.from({ length: rows }, (_, r) => (r < row ? r : r + 1));
      clips = clips.map((clip) => (clip.row >= row ? { ...clip, row: clip.row + 1 } : clip));
    }
    const added = createAudioClip(source, { row, startSec: clamp(target.startSec, 0, MAX_START_SEC) });
    return { draft: { ...draft, audioClips: normalizeAudioClips([...clips, added]) }, clipId: added.id, rowMap };
  }

  const { timeline, sequenceLayout: layout } = draft;
  if (target.mode === "track") {
    const clip = createClip(source);
    const index = clamp(Math.trunc(target.index), 0, timeline.length);
    return { draft: { ...draft, timeline: [...timeline.slice(0, index), clip, ...timeline.slice(index)] }, clipId: clip.id, rowMap: null };
  }
  if (target.mode === "stackedAppend") {
    const clip = createClip(source);
    return { draft: { ...draft, timeline: appendClips(timeline, [clip]) }, clipId: clip.id, rowMap: null };
  }
  const pinned = pinStarts(timeline, durations, layout.overlapSec);
  const clip = createClip(source, { startSec: clamp(target.startSec, 0, MAX_START_SEC) });
  const row = clamp(Math.trunc(target.row), 0, pinned.length);
  return { draft: { ...draft, timeline: [...pinned.slice(0, row), clip, ...pinned.slice(row)] }, clipId: clip.id, rowMap: null };
}

/** The lanes as the Timeline draws them now, for a drop under the pointer. */
export interface LibraryDropGeometry {
  stacked: boolean;
  axis: Pick<TimeAxis, "xToTime" | "pxPerSec">;
  /** Track's clip boxes at rest, in lane content x. */
  boxes: ReadonlyArray<{ x: number; width: number }>;
  /** Stacked's one row per clip, px. */
  rowHeight: number;
  /** The ruler's height: Stacked's rows start under it in the content. */
  ruler: number;
  /** The audio section's top in the lanes' visible box (it is pinned to their bottom). */
  sectionTop: number;
  audioLayout: AudioSectionLayout;
  /** How far the audio rows are scrolled inside their view. */
  audioScroll: number;
  /** Times a start snaps to within SNAP_THRESHOLD_PX: the playhead, the clips' starts and ends. */
  snapTimes: readonly number[];
}

/** Where under the pointer: x in the lane content; y in the lanes' visible box and in their content (rows scrolled). */
export interface LibraryDropPoint {
  x: number;
  viewY: number;
  contentY: number;
  snap: boolean;
}

function snapStart(t: number, times: readonly number[], pxPerSec: number): number {
  let best = t;
  let bestPx = SNAP_THRESHOLD_PX;
  for (const time of times) {
    const px = Math.abs(time - t) * pxPerSec;
    if (px <= bestPx) {
      best = time;
      bestPx = px;
    }
  }
  return best;
}

/**
 * Where a library item dropped at this point goes, or null over no lane that takes it: a video over the clip rows
 * (Track: before the first box whose middle is right of the pointer; Stacked: a new row at the row boundary nearest
 * the pointer, starting at the pointer's time), a sound over the audio rows (that row, or a new row under it when the
 * sound would overlap a clip there; the strip under the rows adds a new bottom row). Starts snap when `snap`.
 */
export function libraryDropAt(
  draft: StitchDraft,
  item: LibraryItem,
  point: LibraryDropPoint,
  g: LibraryDropGeometry,
  audioLengthOf: AudioLengthOf,
): LibraryDropTarget | null {
  const overAudio = point.viewY >= g.sectionTop;
  const timeAt = () => {
    const raw = clamp(g.axis.xToTime(point.x), 0, MAX_START_SEC);
    return point.snap ? clamp(snapStart(raw, g.snapTimes, g.axis.pxPerSec), 0, MAX_START_SEC) : raw;
  };
  if (item.kind === "audio") {
    if (!overAudio) return null;
    const rows = audioRowCount(draft.audioClips);
    const startSec = timeAt();
    const inView = point.viewY - g.sectionTop;
    if (inView >= g.audioLayout.viewHeight || rows === 0) return { lane: "audio", startSec, row: rows, newRow: true };
    const y = inView + g.audioScroll;
    let row = g.audioLayout.rowTops.findIndex((top, r) => y >= top && y < top + g.audioLayout.rowHeights[r]);
    if (row === -1) row = rows - 1;
    if (row >= rows) return { lane: "audio", startSec, row: rows, newRow: true };
    const length = item.durationSec ?? Infinity;
    if (overlapsOnRow(draft.audioClips, audioLengthOf, row, startSec, length, new Set())) {
      return { lane: "audio", startSec, row: row + 1, newRow: true };
    }
    return { lane: "audio", startSec, row, newRow: false };
  }
  if (overAudio) return null;
  const { timeline } = draft;
  if (!g.stacked) {
    const index = g.boxes.findIndex((box) => box.x + box.width / 2 > point.x);
    return { lane: "clips", mode: "track", index: index === -1 ? timeline.length : Math.min(index, timeline.length) };
  }
  const row = clamp(Math.round((point.contentY - g.ruler) / g.rowHeight), 0, timeline.length);
  return { lane: "clips", mode: "stacked", startSec: timeAt(), row };
}
