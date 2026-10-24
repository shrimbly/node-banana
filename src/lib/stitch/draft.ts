import type { StitchAudioClip, StitchSequenceLayout, StitchTimelineClip, VideoStitchNodeData, VolumePoint } from "@/types";
import {
  compactAudioRows,
  describeAudioChanges,
  isLegacyAudio,
  isLegacyAudioShape,
  legacyCopy,
  legacyMusicClip,
  reconcileMusicClip,
  sameAudioClips,
  sanitizeAudioClips,
} from "./audioClips";
import { sameCurve, sortCurve } from "./curve";
import { counted } from "./labels";
import { isLegacyStitch, migrateStitchTimeline, reconcileTimelineWithEdges, sanitizeTimeline } from "./migrate";
import { clampOverlapSec, DEFAULT_SEQUENCE_LAYOUT } from "./stack";
import {
  edgeIdsInOrder,
  isPlaced,
  layoutSpans,
  sourceKey,
  spansEnd,
  type ClipSpan,
  type SourceDurations,
} from "./timeline";

/**
 * Everything the Stitch editor edits, read from a node the same way by the
 * card, the editor and the executor: migrated if legacy, then reconciled
 * against the live edges.
 */
export interface StitchDraft {
  timeline: StitchTimelineClip[];
  audioClips: StitchAudioClip[];
  /**
   * The node's audioCurve and audioMuted when it is read as legacy (no audioClips key): written back by Done only when
   * the audio is legacy-shaped with no music clip. On a node that stores audioClips they are a copy for older builds,
   * never read back: { curve: [], muted: false }.
   */
  legacyAudio: { curve: VolumePoint[]; muted: boolean };
  loopCount: 1 | 2 | 3;
  sequenceLayout: StitchSequenceLayout;
  /**
   * An edit project's media: the asset ids that belong to the edit, in the order they were added, every one its clips
   * use among them. Undefined in a node's draft, which never writes it.
   */
  media?: string[];
}

/** What made a clip in this editing session, for the discard sheet: a paste, a duplicate, or (for a clip gone) a cut. */
export type ClipOrigin = "pasted" | "duplicated" | "cut";

export interface StitchReadContext {
  liveEdgeIds: readonly string[];
  hasMusic: boolean;
}

function readLoopCount(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

/**
 * Not an object → DEFAULT_SEQUENCE_LAYOUT. mode "stacked" only when raw.mode === "stacked" and the node is not legacy
 * (a legacy node always reads as Track, keeping the values); overlapSec via clampOverlapSec when finite, else the
 * default; crossfade = raw.crossfade !== false.
 */
export function readSequenceLayout(raw: unknown, legacy: boolean): StitchSequenceLayout {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SEQUENCE_LAYOUT };
  const { mode, overlapSec, crossfade } = raw as Record<string, unknown>;
  return {
    mode: mode === "stacked" && !legacy ? "stacked" : "track",
    overlapSec:
      typeof overlapSec === "number" && Number.isFinite(overlapSec)
        ? clampOverlapSec(overlapSec)
        : DEFAULT_SEQUENCE_LAYOUT.overlapSec,
    crossfade: crossfade !== false,
  };
}

export function sameLayout(a: StitchSequenceLayout, b: StitchSequenceLayout): boolean {
  return a.mode === b.mode && a.overlapSec === b.overlapSec && a.crossfade === b.crossfade;
}

/** The draft's spans as its layout lays them out (layoutSpans: Track, lined up or placed). */
export function draftSpans(
  d: Pick<StitchDraft, "timeline" | "sequenceLayout">,
  durations: SourceDurations,
): ClipSpan[] {
  return layoutSpans(d.timeline, durations, d.sequenceLayout);
}

/** One loop of the draft: the latest end of a non-empty clip (spansEnd). */
export function draftDuration(d: Pick<StitchDraft, "timeline" | "sequenceLayout">, durations: SourceDurations): number {
  return spansEnd(draftSpans(d, durations));
}

/**
 * legacy: migrateStitchTimeline (it already includes the live edges).
 * otherwise: reconcileTimelineWithEdges(sanitizeTimeline(data.timeline), live, { muteNew }), where
 *   muteNew = ctx.hasMusic && at least one edge clip survives reconciliation && every such clip is muted
 *   (a video connected later to a node whose clips are all muted under music follows them, so the mix stays uniform).
 * Audio: without audioClips, the music (when connected) as one clip with audioCurve and audioMuted; with them, the
 * stored clips with a music clip added on row 0 when music is connected and none is stored.
 */
export function readStitchDraft(
  data: Pick<
    VideoStitchNodeData,
    "timeline" | "clipOrder" | "audioCurve" | "audioMuted" | "audioClips" | "loopCount" | "sequenceLayout"
  >,
  ctx: StitchReadContext,
): StitchDraft {
  let timeline: StitchTimelineClip[];
  const legacy = isLegacyStitch(data);
  if (legacy) {
    timeline = migrateStitchTimeline(data, ctx);
  } else {
    const stored = sanitizeTimeline(data.timeline);
    const live = new Set(ctx.liveEdgeIds);
    const edgeClips = stored.filter((c) => c.source.kind === "edge" && live.has(c.source.edgeId));
    const muteNew = ctx.hasMusic && edgeClips.length > 0 && edgeClips.every((c) => c.muted);
    timeline = reconcileTimelineWithEdges(stored, ctx.liveEdgeIds, { muteNew }).timeline;
  }
  let audioClips: StitchAudioClip[];
  let legacyAudio: StitchDraft["legacyAudio"];
  if (isLegacyAudio(data)) {
    legacyAudio = { curve: sortCurve(data.audioCurve), muted: data.audioMuted === true };
    audioClips = ctx.hasMusic ? [legacyMusicClip(legacyAudio.curve, legacyAudio.muted)] : [];
  } else {
    legacyAudio = { curve: [], muted: false };
    audioClips = reconcileMusicClip(sanitizeAudioClips(data.audioClips), ctx.hasMusic);
  }
  return {
    timeline,
    audioClips,
    legacyAudio,
    loopCount: readLoopCount(data.loopCount),
    sequenceLayout: readSequenceLayout(data.sequenceLayout, legacy),
  };
}

/** The music's curve and mute: the first music clip's, else legacyAudio's (a legacy node without music connected). */
export function musicAudio(d: Pick<StitchDraft, "audioClips" | "legacyAudio">): { curve: VolumePoint[]; muted: boolean } {
  const music = d.audioClips.find((clip) => clip.source.kind === "music");
  return music ? { curve: music.curve, muted: music.muted } : d.legacyAudio;
}

function sameClip(a: StitchTimelineClip, b: StitchTimelineClip): boolean {
  const sameSource =
    a.source.kind === "edge"
      ? b.source.kind === "edge" && a.source.edgeId === b.source.edgeId
      : b.source.kind === "asset" && a.source.assetId === b.source.assetId;
  return (
    sameSource &&
    a.id === b.id &&
    a.inSec === b.inSec &&
    a.outSec === b.outSec &&
    a.muted === b.muted &&
    a.volume === b.volume &&
    a.startSec === b.startSec
  );
}

/**
 * Whether legacyAudio can reach the node: draftPatch writes it only when there is no audio clip. A Save re-reads a
 * legacy node's edited music into legacyAudio, so it would differ from the draft's while both hold the music clip.
 */
function legacyAudioCounts(a: StitchDraft, b: StitchDraft): boolean {
  return a.audioClips.length === 0 && b.audioClips.length === 0;
}

function sameMedia(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  return a !== undefined && b !== undefined && a.length === b.length && a.every((id, i) => id === b[i]);
}

export function sameDraft(a: StitchDraft, b: StitchDraft): boolean {
  return (
    a.loopCount === b.loopCount &&
    sameMedia(a.media, b.media) &&
    sameLayout(a.sequenceLayout, b.sequenceLayout) &&
    a.timeline.length === b.timeline.length &&
    a.timeline.every((clip, i) => sameClip(clip, b.timeline[i])) &&
    sameAudioClips(a.audioClips, b.audioClips) &&
    (!legacyAudioCounts(a, b) ||
      (a.legacyAudio.muted === b.legacyAudio.muted && sameCurve(a.legacyAudio.curve, b.legacyAudio.curve)))
  );
}

/**
 * What Done writes: timeline, the audio, loopCount, sequenceLayout, clipOrder = edgeIdsInOrder(timeline).
 * commitStitchEdit leaves sequenceLayout out when the node's stored value already reads as it.
 *
 * Audio, rows compacted: legacy-shaped (none, or one untouched music clip) → audioClips undefined (the node keeps or
 * goes back to no audioClips), audioCurve and audioMuted from the music clip, else from legacyAudio. Otherwise
 * audioClips, with audioCurve and audioMuted as legacyCopy gives them for older builds.
 */
export function draftPatch(
  d: StitchDraft,
): Required<Pick<VideoStitchNodeData, "timeline" | "audioCurve" | "audioMuted" | "sequenceLayout">> &
  Pick<VideoStitchNodeData, "loopCount" | "clipOrder"> & { audioClips: StitchAudioClip[] | undefined } {
  const audioClips = compactAudioRows(d.audioClips).clips;
  const audio = isLegacyAudioShape(audioClips)
    ? {
        audioClips: undefined,
        audioCurve: audioClips[0]?.curve ?? d.legacyAudio.curve,
        audioMuted: audioClips[0]?.muted ?? d.legacyAudio.muted,
      }
    : { audioClips, ...legacyCopy(audioClips) };
  return {
    timeline: d.timeline,
    ...audio,
    loopCount: d.loopCount,
    sequenceLayout: { ...d.sequenceLayout },
    clipOrder: edgeIdsInOrder(d.timeline),
  };
}

function joinWithAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Whether a clip's only trim change is the cut its split pieces start at: In
 * unchanged, and pieces of the same source chained from its new Out to its
 * old one (a split keeps the id on the left piece and moves its Out).
 */
function onlySplit(was: StitchTimelineClip, clip: StitchTimelineClip, pieces: readonly StitchTimelineClip[]): boolean {
  if (was.inSec !== clip.inSec || clip.outSec === was.outSec || clip.outSec === null) return false;
  const key = sourceKey(clip.source);
  const left = pieces.filter((p) => sourceKey(p.source) === key);
  let cursor: number | null = clip.outSec;
  while (cursor !== was.outSec) {
    const at = cursor;
    const index = left.findIndex((p) => p.inSec === at);
    if (index === -1) return false;
    cursor = left[index].outSec;
    left.splice(index, 1);
    if (cursor === null && was.outSec !== null) return false;
  }
  return true;
}

/** Clips with a start in the draft whose frames' anchor (start − In) differs from the one they had in `initial`. */
function movedClips(initial: StitchDraft, draft: StitchDraft, durations: SourceDurations): number {
  const spans = layoutSpans(initial.timeline, durations, { ...initial.sequenceLayout, mode: "stacked" });
  const anchorBefore = new Map(spans.map((span) => [span.clip.id, span.start - span.clip.inSec]));
  return draft.timeline.filter((clip) => {
    const was = anchorBefore.get(clip.id);
    return clip.startSec !== undefined && was !== undefined && Math.abs(clip.startSec - clip.inSec - was) > 1e-9;
  }).length;
}

/** The layout's parts of the discard sheet's sentence, saying which way each changed. */
function layoutChanges(was: StitchSequenceLayout, now: StitchSequenceLayout): string[] {
  const parts: string[] = [];
  if (was.mode !== now.mode) parts.push(now.mode === "stacked" ? "the switch to Stacked" : "the switch to Track");
  if (was.overlapSec !== now.overlapSec) parts.push("the overlap");
  if (was.crossfade !== now.crossfade) parts.push(now.crossfade ? "turning the crossfade on" : "turning the crossfade off");
  return parts;
}

/**
 * The discard sheet's sentence: what Cancel would lose, by kind, matching
 * clips by id. "Two trims, a new order and the volume curve will be lost.
 * The node keeps what it had." A new clip of a source that was already in
 * the sequence is a split; one of a new source was added. The Out a split
 * gives its left piece is part of the split, not a trim.
 *
 * A clip placed in the draft whose frames moved (its start less its In, the
 * stored start in `initial` or else where the stacked layout put it, with
 * these durations) is a moved clip: pinning alone, and an In trim that keeps
 * the frames where they were, are not. Dropping every placement is "lining up
 * the clips" instead.
 *
 * `origins` names clips by what made them: an added clip tagged "pasted" or
 * "duplicated" is a pasted or duplicated clip (never a split, though its
 * source is in the sequence), and a removed clip tagged "cut" is a cut clip.
 *
 * Audio clips are named by describeAudioChanges; a legacy node's music curve and mute without music connected, as
 * "the volume curve" and "the music mute".
 */
export function describeDraftChanges(
  initial: StitchDraft,
  draft: StitchDraft,
  durations: SourceDurations = new Map(),
  origins: ReadonlyMap<string, ClipOrigin> = new Map(),
): string {
  const before = new Map(initial.timeline.map((c) => [c.id, c]));
  const after = new Map(draft.timeline.map((c) => [c.id, c]));
  const sourcesBefore = new Set(initial.timeline.map((c) => sourceKey(c.source)));
  const fresh = draft.timeline.filter((c) => !before.has(c.id));
  const pasted = fresh.filter((c) => origins.get(c.id) === "pasted").length;
  const duplicated = fresh.filter((c) => origins.get(c.id) === "duplicated").length;
  const added = fresh.filter((c) => origins.get(c.id) !== "pasted" && origins.get(c.id) !== "duplicated");
  const pieces = added.filter((c) => sourcesBefore.has(sourceKey(c.source)));

  let trims = 0;
  let muted = 0;
  let unmuted = 0;
  let volumes = 0;
  for (const clip of draft.timeline) {
    const was = before.get(clip.id);
    if (!was) continue;
    if ((was.inSec !== clip.inSec || was.outSec !== clip.outSec) && !onlySplit(was, clip, pieces)) trims++;
    if (!was.muted && clip.muted) muted++;
    if (was.muted && !clip.muted) unmuted++;
    if (was.volume !== clip.volume) volumes++;
  }
  const splits = pieces.length;
  const gone = initial.timeline.filter((c) => !after.has(c.id));
  const cut = gone.filter((c) => origins.get(c.id) === "cut").length;
  const removed = gone.length - cut;
  const commonBefore = initial.timeline.filter((c) => after.has(c.id)).map((c) => c.id);
  const commonAfter = draft.timeline.filter((c) => before.has(c.id)).map((c) => c.id);
  const reordered = commonBefore.some((id, i) => id !== commonAfter[i]);
  const linedUp = isPlaced(initial.timeline) && !isPlaced(draft.timeline);
  const moved = linedUp ? 0 : movedClips(initial, draft, durations);

  const parts = [
    counted(trims, "a trim", "trims"),
    reordered ? "a new order" : null,
    linedUp ? "lining up the clips" : counted(moved, "a moved clip", "moved clips"),
    counted(splits, "a split", "splits"),
    counted(muted, "a muted clip", "muted clips"),
    counted(unmuted, "an unmuted clip", "unmuted clips"),
    counted(volumes, "a clip volume", "clip volumes"),
    counted(added.length - splits, "an added clip", "added clips"),
    counted(pasted, "a pasted clip", "pasted clips"),
    counted(duplicated, "a duplicated clip", "duplicated clips"),
    counted(removed, "a removed clip", "removed clips"),
    counted(cut, "a cut clip", "cut clips"),
    ...describeAudioChanges(initial.audioClips, draft.audioClips, origins),
    !legacyAudioCounts(initial, draft) || sameCurve(initial.legacyAudio.curve, draft.legacyAudio.curve)
      ? null
      : "the volume curve",
    !legacyAudioCounts(initial, draft) || initial.legacyAudio.muted === draft.legacyAudio.muted ? null : "the music mute",
    initial.loopCount === draft.loopCount ? null : "the loop count",
    ...layoutChanges(initial.sequenceLayout, draft.sequenceLayout),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return "Your changes will be lost. The node keeps what it had.";
  const list = joinWithAnd(parts);
  return `${list[0].toUpperCase()}${list.slice(1)} will be lost. The node keeps what it had.`;
}
