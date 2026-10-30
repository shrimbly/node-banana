import {
  audioSelectionOf,
  pruneSelection,
  selectedAudioIds,
  selectedClipIds,
  selectIsMulti,
  useStitchEditorStore,
  type StitchEditorState,
} from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useEditProjectStore } from "@/store/editProjectStore";
import { flat, followEndFade, removePoint } from "@/lib/stitch/curve";
import { getAssetInfo, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { draftDuration, draftSpans, sameLayout, type StitchDraft } from "@/lib/stitch/draft";
import {
  addAudioAt,
  audioCurveShape,
  audioFadeIn,
  audioFadeOut,
  audioLengthOf,
  audioSpans,
  followEndFades,
  hasMusicClip,
  heardRange,
  moveAudioClips,
  removeAudioClips,
  resetAudioTrim,
  setAudioClipCurve,
  setAudioClipsMuted,
  splitAudioClipAt,
  trimAudioClip,
  type AudioLengthOf,
  type AudioRowMap,
  type AudioSpan,
} from "@/lib/stitch/audioClips";
import { clampOverlapSec, effectiveOverlapSec } from "@/lib/stitch/stack";
import { FRAME_RATE } from "@/lib/stitch/sequencePlan";
import {
  insertLibraryItem,
  libraryItemOf,
  playheadTarget,
  provisionalDurations,
  stackedAddBlocked,
  type LibraryDropTarget,
  type LibraryItem,
} from "@/lib/stitch/libraryInsert";
import type { LibraryKind } from "@/lib/stitch/libraryRequest";
import { makeSelection } from "@/lib/stitch/selection";
import {
  appendClips,
  canSplitClipsAt,
  clearStarts,
  createClip,
  inOverlap,
  isPlaced,
  layoutSpans,
  moveClip,
  moveClipsBlock,
  moveClipStart,
  pinStarts,
  placeClips,
  reanchorTime,
  removeClip,
  removeClips,
  resetTrim,
  resetTrimInPlace,
  resetTrims,
  setEdgeAtPlayhead,
  shiftRows,
  sourceKey,
  sourceTimeAt,
  spansAt,
  spansEnd,
  splitClipAt,
  splitClipsAt,
  topSpanAt,
  trimClip,
  trimClipInPlace,
  updateClipAudio,
  updateClipsAudio,
  type ClipSpan,
  type SourceDurations,
  type SourceKey,
} from "@/lib/stitch/timeline";
import type { AssetView } from "@/lib/assets/types";
import type {
  StitchAudioClip,
  StitchAudioSource,
  StitchClipSource,
  StitchSequenceLayout,
  StitchTimelineClip,
  VolumePoint,
} from "@/types";
import { commitStitchEdit } from "./commitStitchEdit";
import { liveFitZoom } from "./liveFitZoom";

/**
 * What the editor's keys, rail and transport do to its store. Each reads the
 * store at call time (draft, durations, playhead), so a key handler or a
 * button never acts on a stale render.
 */

const editor = () => useStitchEditorStore.getState();

/** One loop of the sequence, in seconds. */
function editorTotal(s: Pick<StitchEditorState, "draft" | "durations">): number {
  return s.draft ? draftDuration(s.draft, s.durations) : 0;
}

/** The lead of a clip selection: the clip a single-clip action acts on. */
function selectedClipId(s: StitchEditorState): string | null {
  return s.selection?.kind === "clip" ? s.selection.clipId : null;
}

const stackedOf = (s: StitchEditorState) => s.draft?.sequenceLayout.mode === "stacked";
/**
 * The stored Overlap, not the effective one: it places a stack's unpinned clips whatever the layout shows now (a
 * pinning edit made in Track would otherwise pin them as butted).
 */
const overlapOf = (s: StitchEditorState) => s.draft?.sequenceLayout.overlapSec ?? 0;
/** Stacked with a stored start: edits there pin every clip first, so none they do not edit moves. */
const placedOf = (s: StitchEditorState) => stackedOf(s) && isPlaced(s.draft?.timeline ?? []);

/** The selected clip's span as the draft lays it out, or null (also with several selected). */
function selectedSpan(s: StitchEditorState): ClipSpan | null {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || selectIsMulti(s)) return null;
  return draftSpans(s.draft, s.durations).find((span) => span.clip.id === clipId) ?? null;
}

/** The playhead as the lane draws it: a stored one past a sequence that got shorter sits at the end. */
export const drawnPlayhead = (s: StitchEditorState) => Math.min(s.playhead, editorTotal(s));

/** What Fit's px/s depends on in a timeline: the sequence's length and where each empty clip's slot starts. */
function fitInputs(spans: readonly ClipSpan[]): string {
  const slots = spans.filter((span) => span.length <= 0).map((span) => span.start);
  return [spansEnd(spans), ...slots.sort((a, b) => a - b)].join(",");
}

/**
 * Moves keep the zoom: in Fit, a move that would re-fit the lane (it changes the sequence's length, or moves an empty
 * clip's slot) first stores the px/s the lane drew it at, so the clip lands where it was drawn instead of the lane
 * re-fitting under it. Called before the apply, in the same handler. Nothing without a mounted timeline.
 */
export function keepZoom(s: StitchEditorState, timeline: readonly StitchTimelineClip[]): void {
  if (s.pxPerSec !== null || !s.draft) return;
  const pxPerSec = liveFitZoom.get();
  if (pxPerSec === null) return;
  const layout = s.draft.sequenceLayout;
  if (fitInputs(layoutSpans(timeline, s.durations, layout)) === fitInputs(draftSpans(s.draft, s.durations))) return;
  s.setZoom(pxPerSec);
}

export function togglePlay(): void {
  const s = editor();
  if (s.playing) s.setPlaying(false);
  else if (editorTotal(s) > 0) s.setPlaying(true);
}

export function play(): void {
  const s = editor();
  if (!s.playing && editorTotal(s) > 0) s.setPlaying(true);
}

export function pause(): void {
  editor().setPlaying(false);
}

/** J: one second back from the playhead as drawn (the store keeps one a shortened sequence no longer reaches). */
export function stepBack(): void {
  const s = editor();
  s.setPlayhead(Math.max(0, Math.min(s.playhead, editorTotal(s)) - 1));
}

export function goToStart(): void {
  editor().setPlayhead(0);
}

export function goToEnd(): void {
  const s = editor();
  s.setPlaying(false);
  s.setPlayhead(editorTotal(s));
}

/**
 * The split S makes now: the selected clip when the playhead is inside it, else the clip in front under it (the
 * earlier one in Track and a lined-up stack, the top row in a placed one).
 */
function splitOptions(s: StitchEditorState, layout: StitchSequenceLayout) {
  return { overlapSec: effectiveOverlapSec(layout), preferClipId: selectedClipId(s), layout };
}

/** S with several selected: whether some selected clip is under the playhead with room to split (no timeline copied). */
function canSplitGroup(s: StitchEditorState): boolean {
  if (!s.draft) return false;
  return canSplitClipsAt(draftSpans(s.draft, s.durations), s.playhead, new Set(selectedClipIds(s)), placedOf(s));
}

/** Some selected clip plays at the playhead, whether or not it is far enough from its ends to split. */
function selectedUnderPlayhead(s: StitchEditorState): boolean {
  if (!s.draft) return false;
  const ids = new Set(selectedClipIds(s));
  return spansAt(draftSpans(s.draft, s.durations), s.playhead).some((span) => ids.has(span.clip.id));
}

/** Whether S would split something now. */
export function canSplitAtPlayhead(s: StitchEditorState): boolean {
  if (!s.draft) return false;
  if (selectIsMulti(s)) return canSplitGroup(s);
  const opts = splitOptions(s, s.draft.sequenceLayout);
  return splitClipAt(s.draft.timeline, s.durations, s.playhead, () => "probe", opts) !== null;
}

/**
 * A selector of the draft, its durations, the selection and the playhead, worked out again only when one of them
 * changes: a store calls every selector on every change of anything (the playhead while playing among them), and
 * these lay the sequence out.
 */
function onPlayhead<T>(select: (s: StitchEditorState) => T): (s: StitchEditorState) => T {
  let last: { draft: unknown; durations: unknown; selection: unknown; playhead: number; value: T } | null = null;
  return (s) => {
    if (
      last &&
      last.draft === s.draft &&
      last.durations === s.durations &&
      last.selection === s.selection &&
      last.playhead === s.playhead
    ) {
      return last.value;
    }
    const value = select(s);
    last = { draft: s.draft, durations: s.durations, selection: s.selection, playhead: s.playhead, value };
    return value;
  };
}

/** The rail's Split: S would split, and the clip it would cut is the one the rail shows. */
export const canSplitSelectedAtPlayhead = onPlayhead((s: StitchEditorState): boolean => {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId) return false;
  if (selectIsMulti(s)) return canSplitGroup(s);
  return topSpanAt(draftSpans(s.draft, s.durations), s.playhead, clipId)?.clip.id === clipId && canSplitAtPlayhead(s);
});

/**
 * Why Split is off, when the reason is not obvious: two clips play under the playhead in a lined-up stack, whose
 * split would re-sequence it. A placed stack splits there too (the pieces stay one run, so nothing changes).
 */
export const splitBlockedReason = onPlayhead((s: StitchEditorState): string | null => {
  if (!s.draft) return null;
  const overlap =
    stackedOf(s) && !placedOf(s) && inOverlap(draftSpans(s.draft, s.durations), s.playhead)
      ? "Move the playhead out of the overlap to split"
      : null;
  if (selectIsMulti(s)) return overlap ?? (selectedUnderPlayhead(s) ? null : "No selected clip is under the playhead");
  return overlap;
});

/**
 * S: splits the clip under the playhead and selects its right piece. With several selected, every selected clip under
 * it splits and the right pieces become the selection. A placed stack is pinned first, in the same step.
 */
export function splitAtPlayhead(): void {
  const s = editor();
  if (!s.draft) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  if (selectIsMulti(s)) {
    const split = splitClipsAt(timeline, s.durations, s.playhead, selectedClipIds(s), { layout: s.draft.sequenceLayout });
    if (!split) return;
    s.apply((d) => ({ ...d, timeline: split.timeline }));
    const order = split.timeline.map((c) => c.id);
    editor().select(makeSelection(order, split.rightIds, split.rightIds[0]));
    return;
  }
  const result = splitClipAt(timeline, s.durations, s.playhead, undefined, splitOptions(s, s.draft.sequenceLayout));
  if (!result) return;
  s.apply((d) => ({ ...d, timeline: result.timeline }));
  editor().select({ kind: "clip", clipId: result.rightId });
}

/**
 * I / O: the selected clip's In or Out at the playhead, when the playhead is inside it. In Stacked the frames stay
 * where they are (trimClipInPlace), so I starts the clip at the playhead.
 */
export function setEdgeAtPlayheadForSelection(edge: "in" | "out"): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || selectIsMulti(s)) return;
  if (!stackedOf(s)) {
    const overlap = effectiveOverlapSec(s.draft.sequenceLayout);
    const timeline = setEdgeAtPlayhead(s.draft.timeline, s.durations, clipId, edge, s.playhead, overlap);
    if (timeline) s.apply((d) => ({ ...d, timeline }));
    return;
  }
  const span = selectedSpan(s);
  const t = s.playhead;
  if (!span || span.length === 0 || !Number.isFinite(t) || t < span.start || t > span.end) return;
  if (edge === "out" ? t <= span.start : t >= span.end) return;
  const at = sourceTimeAt(span, t);
  const timeline = trimClipInPlace(
    s.draft.timeline,
    clipId,
    s.durations,
    edge === "in" ? { inSec: at } : { outSec: at },
    overlapOf(s),
  );
  s.apply((d) => ({ ...d, timeline }));
}

/**
 * Removes the listed clips in one step (⌫ and ⌘X with several selected): a lined-up stack closes up, a placed one is
 * pinned first, so nothing else moves. The clip now at the first removed index takes the selection. Returns the ids
 * removed.
 */
export function removeClipsById(ids: readonly string[]): string[] {
  const s = editor();
  if (!s.draft) return [];
  const wanted = new Set(ids);
  const index = s.draft.timeline.findIndex((c) => wanted.has(c.id));
  if (index === -1) return [];
  const removed = s.draft.timeline.filter((c) => wanted.has(c.id)).map((c) => c.id);
  const from = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const { timeline } = removeClips(from, wanted);
  s.apply((d) => ({ ...d, timeline }));
  const neighbour = timeline[Math.min(index, timeline.length - 1)];
  editor().select(neighbour ? { kind: "clip", clipId: neighbour.id } : null);
  return removed;
}

/**
 * ⌫: the selected clip, or the selected curve point. The neighbour takes the clip's selection. A lined-up stack
 * closes up; a placed one is pinned first, so nothing else moves. With several selected, all of them.
 */
export function removeSelection(): void {
  const s = editor();
  if (!s.draft) return;
  if (s.selection?.kind === "audio") return removeAudioSelection();
  if (selectIsMulti(s)) {
    editor().untagCut(removeClipsById(selectedClipIds(s)));
    return;
  }
  const clipId = selectedClipId(s);
  if (!clipId) return;
  const index = s.draft.timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return;
  const from = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const { timeline } = removeClip(from, clipId);
  s.apply((d) => ({ ...d, timeline }));
  const after = editor();
  after.untagCut([clipId]);
  const neighbour = timeline[Math.min(index, timeline.length - 1)];
  after.select(neighbour ? { kind: "clip", clipId: neighbour.id } : null);
}

/** ⌥M. With several selected: all muted, or all unmuted when every one already is muted. */
export function toggleSelectedClipMute(): void {
  const s = editor();
  if (selectIsMulti(s)) {
    const ids = new Set(selectedClipIds(s));
    const muted = !(s.draft?.timeline.filter((c) => ids.has(c.id)).every((c) => c.muted) ?? false);
    s.apply((d) => ({ ...d, timeline: updateClipsAudio(d.timeline, ids, { muted }) }));
    return;
  }
  const clipId = selectedClipId(s);
  const clip = s.draft?.timeline.find((c) => c.id === clipId);
  if (!clip) return;
  s.apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clip.id, { muted: !clip.muted }) }));
}

export function setClipMuted(clipId: string, muted: boolean): void {
  editor().apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { muted }) }));
}

/** The rail's Clip audio On or Off with several selected: every selected clip, one step (none when all already are). */
export function setSelectedClipsMuted(muted: boolean): void {
  const s = editor();
  const ids = new Set(selectedClipIds(s));
  if (ids.size === 0) return;
  s.apply((d) => ({ ...d, timeline: updateClipsAudio(d.timeline, ids, { muted }) }));
}

/**
 * M with no audio clip selected: every music clip muted, or unmuted when all are. With no music clip, a legacy
 * node's music mute can only be turned off: muting music that is not there would be left out silently by a later
 * connection.
 */
export function toggleMusicMute(): void {
  const s = editor();
  if (!s.draft) return;
  if (hasMusicClip(s.draft.audioClips)) {
    const music = s.draft.audioClips.filter((c) => c.source.kind === "music");
    const muted = !music.every((c) => c.muted);
    s.apply((d) => ({ ...d, audioClips: setAudioClipsMuted(d.audioClips, new Set(music.map((c) => c.id)), muted) }));
    forgetPointOfMutedLead();
    return;
  }
  if (s.draft.legacyAudio.muted) s.apply((d) => ({ ...d, legacyAudio: { ...d.legacyAudio, muted: false } }));
}

/**
 * Clamped by trimClip; an unchanged value is no step. In Stacked the frames stay where they are: an In change moves
 * the start by as much, never before 0:00 (trimClipInPlace, which pins).
 */
export function trimSelected(patch: { inSec?: number; outSec?: number | null }): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!clipId || selectIsMulti(s)) return;
  const stacked = stackedOf(s);
  const overlapSec = overlapOf(s);
  s.apply((d) => ({
    ...d,
    timeline: stacked
      ? trimClipInPlace(d.timeline, clipId, s.durations, patch, overlapSec)
      : trimClip(d.timeline, clipId, s.durations, patch),
  }));
}

/**
 * In Stacked the start moves back by the old In, clamped at 0:00 (resetTrimInPlace, which pins). With several
 * selected, every trimmed one, in one step.
 */
export function resetSelectedTrim(): void {
  const s = editor();
  if (selectIsMulti(s)) {
    const ids = new Set(selectedClipIds(s));
    s.apply((d) => ({ ...d, timeline: resetTrims(d.timeline, s.durations, ids, d.sequenceLayout) }));
    return;
  }
  const clipId = selectedClipId(s);
  if (!clipId) return;
  const stacked = stackedOf(s);
  const overlapSec = overlapOf(s);
  s.apply((d) => ({
    ...d,
    timeline: stacked ? resetTrimInPlace(d.timeline, clipId, s.durations, overlapSec) : resetTrim(d.timeline, clipId),
  }));
}

/** Per slider tick: the ticks of one drag (or one run of arrow keys) are one undo step until endGesture. */
export function setClipVolume(clipId: string, volume: number): void {
  editor().apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { volume }) }), {
    gestureKey: `volume:${clipId}`,
  });
}

export function setLoopCount(n: 1 | 2 | 3): void {
  editor().apply((d) => ({ ...d, loopCount: n }));
}

/** A fade out ending on the old end follows the new end, on every audio clip and on a legacy node's music curve. */
function followEnd(d: StitchDraft, oldTotal: number, newTotal: number): StitchDraft {
  return {
    ...d,
    audioClips: followEndFades(d.audioClips, oldTotal, newTotal),
    legacyAudio: { ...d.legacyAudio, curve: followEndFade(d.legacyAudio.curve, oldTotal, newTotal) },
  };
}

/**
 * A new layout, as one undo step (or one gesture's): a fade out ending on the old end follows the new end
 * (followEndFade), and the playhead stays on the same frame of the same clip (reanchorTime). Pausing is the
 * modal's: it pauses on any change of the Track/Stacked flag, undo and redo included.
 */
function applyLayout(layout: StitchSequenceLayout, opts?: { gestureKey?: string; timeline?: StitchTimelineClip[] }): void {
  const s = editor();
  if (!s.draft || sameLayout(s.draft.sequenceLayout, layout)) return;
  const timeline = opts?.timeline ?? s.draft.timeline;
  const before = draftSpans(s.draft, s.durations);
  const after = draftSpans({ timeline, sequenceLayout: layout }, s.durations);
  const oldTotal = draftDuration(s.draft, s.durations);
  const newTotal = spansEnd(after);
  s.apply(
    (d) => ({ ...followEnd(d, oldTotal, newTotal), timeline, sequenceLayout: layout }),
    opts?.gestureKey !== undefined ? { gestureKey: opts.gestureKey } : undefined,
  );
  editor().setPlayhead(reanchorTime(before, after, s.playhead, selectedClipId(s)));
}

/** Track | Stacked. The overlap and the crossfade are kept either way. */
export function setSequenceMode(mode: StitchSequenceLayout["mode"]): void {
  const layout = editor().draft?.sequenceLayout;
  if (layout) applyLayout({ ...layout, mode });
}

/**
 * Clamped to 0–10 s in 0.1 s steps; an unchanged value is no step. opts.gesture coalesces ↑/↓ nudges until endGesture.
 * A lined-up stack moves with it. A placed one is first pinned at the old Overlap, in the same step, so it moves
 * nothing: Overlap then only says where new clips go and how Line up spaces the clips.
 */
export function setOverlapSec(seconds: number, opts?: { gesture?: boolean }): void {
  const s = editor();
  const layout = s.draft?.sequenceLayout;
  if (!s.draft || !layout) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, layout.overlapSec) : undefined;
  applyLayout(
    { ...layout, overlapSec: clampOverlapSec(seconds) },
    { ...(opts?.gesture ? { gestureKey: "overlap" } : {}), ...(timeline ? { timeline } : {}) },
  );
}

export function setCrossfade(on: boolean): void {
  const layout = editor().draft?.sequenceLayout;
  if (layout) applyLayout({ ...layout, crossfade: on });
}

/**
 * A row move without time (the row header drag, ⌥↑ ⌥↓, the menu's row items): Track and a lined-up stack re-sequence
 * from the new order; a placed stack is pinned first, so every clip keeps its start.
 */
export function moveClipTo(clipId: string, toIndex: number): void {
  const s = editor();
  const from = s.draft?.timeline.findIndex((c) => c.id === clipId) ?? -1;
  if (!s.draft || from === -1) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const moved = moveClip(timeline, from, toIndex);
  // Pinning alone is no row move
  if (moved === timeline) return;
  s.apply((d) => ({ ...d, timeline: moved }));
}

/**
 * Several clips' rows by rowDelta, keeping their spacing (the Stacked header group drag, ⌥↑ ⌥↓): a placed stack is
 * pinned first, so every clip keeps its start. One step; none when the group is already at that edge.
 */
export function moveClipRows(ids: readonly string[], rowDelta: number): void {
  const s = editor();
  if (!s.draft) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const moved = shiftRows(timeline, new Set(ids), rowDelta);
  if (moved === timeline) return;
  s.apply((d) => ({ ...d, timeline: moved }));
}

/** The Track block drag's release: the listed clips as one run before the toIndex-th other clip, in their order. */
export function moveClipsTo(ids: readonly string[], toIndex: number): void {
  const s = editor();
  if (!s.draft) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const moved = moveClipsBlock(timeline, new Set(ids), toIndex);
  if (moved === timeline) return;
  s.apply((d) => ({ ...d, timeline: moved }));
}

/** ⌥↑ / ⌥↓ and the menu: whether the selected clip, or every selected one, has a row to go to (Stacked). */
export function canMoveRow(s: StitchEditorState, dir: 1 | -1): boolean {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || !stackedOf(s)) return false;
  if (selectIsMulti(s)) {
    const ids = new Set(selectedClipIds(s));
    const indices = s.draft.timeline.flatMap((c, i) => (ids.has(c.id) ? [i] : []));
    return indices[0] + dir >= 0 && indices[indices.length - 1] + dir < s.draft.timeline.length;
  }
  const index = s.draft.timeline.findIndex((c) => c.id === clipId);
  return index !== -1 && index + dir >= 0 && index + dir < s.draft.timeline.length;
}

/** ⌥↑ / ⌥↓: the selected clip, or every selected one, one row up or down (Stacked; nothing in Track). */
export function moveSelectedRow(dir: 1 | -1): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || !canMoveRow(s, dir)) return;
  if (selectIsMulti(s)) return moveClipRows(selectedClipIds(s), dir);
  moveClipTo(clipId, s.draft.timeline.findIndex((c) => c.id === clipId) + dir);
}

// Placing clips in time (Stacked). Every one pins the stack and keeps the zoom; Track has no start to set.

/**
 * The clip starts at `sec` (clamped to 0–10 min): the typed Start, the nudges, [ and ]. One undo step, or one per
 * gesture with opts.gestureKey; an unchanged start is no step. Nothing in Track.
 */
export function setClipStart(clipId: string, sec: number, opts?: { gestureKey?: string }): void {
  const s = editor();
  if (!s.draft || !stackedOf(s) || !Number.isFinite(sec) || selectIsMulti(s)) return;
  const timeline = moveClipStart(s.draft.timeline, s.durations, clipId, sec, overlapOf(s));
  if (timeline === s.draft.timeline) return;
  keepZoom(s, timeline);
  s.apply((d) => ({ ...d, timeline }), opts);
}

/**
 * A body drag's release: applies exactly the timeline the drag drew (placeClip: the clip's new start and row, every
 * clip pinned), as one undo step. Never re-sequences, in a lined-up stack too.
 */
export function moveClipBody(clipId: string, timeline: StitchTimelineClip[]): void {
  const s = editor();
  if (!s.draft || !stackedOf(s) || timeline === s.draft.timeline) return;
  if (!timeline.some((c) => c.id === clipId)) return;
  keepZoom(s, timeline);
  s.apply((d) => ({ ...d, timeline }));
}

/**
 * A group body drag's release: the timeline it drew (placeClips: every selected clip moved by one time and one row
 * delta, every clip pinned), as one undo step.
 */
export function moveClipsBody(ids: readonly string[], timeline: StitchTimelineClip[]): void {
  const s = editor();
  if (!s.draft || !stackedOf(s) || timeline === s.draft.timeline) return;
  if (!ids.every((id) => timeline.some((c) => c.id === id))) return;
  keepZoom(s, timeline);
  s.apply((d) => ({ ...d, timeline }));
}

/** One output frame: the encoder's grid. */
const NUDGE_SEC = 1 / FRAME_RATE;
const BIG_NUDGE_FRAMES = 10;
const START_STEP_SEC = 0.1;
const BIG_START_STEP_SEC = 1;

/**
 * ⌥← / ⌥→: one output frame (⇧: ten). A held key's repeats join its first press's undo step. With several selected,
 * all of them, their spacing kept and the group stopped at 0:00 and 10:00.
 */
export function nudgeSelectedClip(dir: 1 | -1, big: boolean, repeat: boolean): void {
  const s = editor();
  if (selectIsMulti(s)) {
    if (!s.draft || !stackedOf(s)) return;
    if (!repeat) s.endGesture();
    const ids = selectedClipIds(s);
    const step = (big ? BIG_NUDGE_FRAMES : 1) * NUDGE_SEC;
    const timeline = placeClips(s.draft.timeline, s.durations, new Set(ids), dir * step, 0, overlapOf(s));
    if (timeline === s.draft.timeline) return;
    keepZoom(s, timeline);
    s.apply((d) => ({ ...d, timeline }), { gestureKey: `nudge:${ids.join(",")}` });
    return;
  }
  const span = stackedOf(s) ? selectedSpan(s) : null;
  if (!span) return;
  // A new press is a new undo step, even right after the last one
  if (!repeat) s.endGesture();
  const step = (big ? BIG_NUDGE_FRAMES : 1) * NUDGE_SEC;
  setClipStart(span.clip.id, span.start + dir * step, { gestureKey: `nudge:${span.clip.id}` });
}

/**
 * ↑ / ↓ in the Start well: 0.1 s (⇧: 1 s), one undo step until the well is left (its blur ends the gesture). Returns
 * the start now stored, or null when nothing changed.
 */
export function nudgeStartWell(dir: 1 | -1, big: boolean): number | null {
  const s = editor();
  const span = stackedOf(s) ? selectedSpan(s) : null;
  if (!span) return null;
  const before = s.draft?.timeline;
  setClipStart(span.clip.id, span.start + dir * (big ? BIG_START_STEP_SEC : START_STEP_SEC), {
    gestureKey: `start:${span.clip.id}`,
  });
  const after = editor();
  if (after.draft?.timeline === before) return null;
  return selectedSpan(after)?.start ?? null;
}

/** [ and the menu: the selected clip can start at the playhead (Stacked). */
export function canStartAtPlayhead(s: StitchEditorState): boolean {
  return stackedOf(s) && selectedSpan(s) !== null;
}

/** ] and the menu: the selected clip can end at the playhead, which needs as much time before it as the clip lasts. */
export function canEndAtPlayhead(s: StitchEditorState): boolean {
  const span = stackedOf(s) ? selectedSpan(s) : null;
  return span !== null && drawnPlayhead(s) - span.length >= -1e-9;
}

/** [: the selected clip starts at the playhead. */
export function startSelectedAtPlayhead(): void {
  const s = editor();
  const span = canStartAtPlayhead(s) ? selectedSpan(s) : null;
  if (span) setClipStart(span.clip.id, drawnPlayhead(s));
}

/** ]: the selected clip ends at the playhead; nothing when it would have to start before 0:00. */
export function endSelectedAtPlayhead(): void {
  const s = editor();
  const span = canEndAtPlayhead(s) ? selectedSpan(s) : null;
  if (span) setClipStart(span.clip.id, Math.max(0, drawnPlayhead(s) - span.length));
}

/** Line up is offered once some clip has been placed. */
export function canLineUp(s: StitchEditorState): boolean {
  return placedOf(s);
}

/**
 * Line up: every placement dropped, so the clips start Overlap before the one above ends, as one undo step. A fade
 * out ending on the old end follows the new end, and the playhead stays on the same frame of the same clip.
 */
export function lineUpClips(): void {
  const s = editor();
  if (!s.draft || !canLineUp(s)) return;
  const timeline = clearStarts(s.draft.timeline);
  const before = draftSpans(s.draft, s.durations);
  const after = draftSpans({ timeline, sequenceLayout: s.draft.sequenceLayout }, s.durations);
  const oldTotal = spansEnd(before);
  const newTotal = spansEnd(after);
  s.apply((d) => ({ ...followEnd(d, oldTotal, newTotal), timeline }));
  editor().setPlayhead(reanchorTime(before, after, s.playhead, selectedClipId(s)));
}

/**
 * Add media (the library picker) over a paused preview, its kind filter set to video (the Clips track's +, the slot
 * after the last clip and the empty lane), audio (the audio strip's +) or both (the media pane's Add media). The
 * same in the dialog and in the view.
 */
export function openLibraryPicker(kind: LibraryKind = "video"): void {
  const s = editor();
  if (!s.draft) return;
  s.setPlaying(false);
  s.openMenu(null);
  s.setPickerOpen(kind);
}

/**
 * The lengths a library add, paste or duplicate places with: measured, else the clip's record, else (an edit
 * project) the open edit's snapshot.
 */
export function placementDurations(s: StitchEditorState): SourceDurations {
  const open = s.editId !== null ? useEditProjectStore.getState().open : null;
  return provisionalDurations(s.draft ?? { timeline: [] }, s.durations, getAssetInfo, open?.id === s.editId ? open.assets : {});
}

function playheadTargetOf(s: StitchEditorState, item: LibraryItem): LibraryDropTarget | null {
  if (!s.draft) return null;
  const selected = new Set(selectedClipIds(s));
  return playheadTarget(s.draft, placementDurations(s), drawnPlayhead(s), item, editorAudioLengthOf(s), selected);
}

/** Where a click on this library item adds it now (at the playhead). */
export function libraryPlayheadTarget(item: LibraryItem): LibraryDropTarget | null {
  return playheadTargetOf(editor(), item);
}

/**
 * Why a library item cannot be added at the playhead now ("Waiting for the clips to load"), or null. The state
 * defaults to the store's own; the pane passes it from its selector.
 */
export function libraryAddBlockedReason(item: LibraryItem, s: StitchEditorState = editor()): string | null {
  const target = playheadTargetOf(s, item);
  return s.draft && target ? stackedAddBlocked(s.draft, target, s.clipsLoading) : null;
}

/**
 * The media pane's add: one video or sound at the target (the playhead's when none is given: a click), as one undo
 * step. The new clip is selected and the playhead goes to its start. A Stacked add that would pin while a clip is
 * still loading does nothing. Returns the new clip's id, or null when nothing was added.
 */
export function addLibraryItemAt(view: AssetView, target?: LibraryDropTarget | null): string | null {
  const s = editor();
  const item = libraryItemOf(view);
  if (!s.draft || !item) return null;
  const at = target ?? libraryPlayheadTarget(item);
  if (!at || stackedAddBlocked(s.draft, at, s.clipsLoading)) return null;
  primeAssetInfo([view]);
  const durations = placementDurations(s);
  const inserted = insertLibraryItem(s.draft, durations, item, at);
  const clipId = inserted.clipId;
  if (clipId === null) return null;
  s.openMenu(null);
  s.apply(() => inserted.draft);
  if (item.kind === "audio") {
    if (inserted.rowMap) remapExpandedRow(inserted.rowMap);
    selectAudioClips([clipId]);
    const clip = inserted.draft.audioClips.find((c) => c.id === clipId);
    editor().setPlayhead(clip?.startSec ?? drawnPlayhead(s));
    return clipId;
  }
  const withNew = new Map(durations);
  if (item.durationSec !== null) withNew.set(sourceKey({ kind: "asset", assetId: item.assetId }), item.durationSec);
  const span = draftSpans(inserted.draft, withNew).find((sp) => sp.clip.id === clipId);
  editor().select({ kind: "clip", clipId });
  editor().setPlayhead(span?.start ?? drawnPlayhead(s));
  return clipId;
}

/**
 * The picker's Add in the dialog, as one undo step: one clip per picked video, in the order they were picked, after
 * the last clip, and one per picked sound, each on its own new row at the bottom, starting at the playhead the user
 * saw. The first new video clip is selected with the playhead at its start (the first sound when no video was
 * picked), and the picker closes. The records go to the asset cache so the clips are labelled (and the sounds'
 * lengths known for overlap checks) at once; the clips themselves hold only the ids.
 */
export function addLibraryClips(views: readonly AssetView[]): void {
  const s = editor();
  if (!s.draft || views.length === 0) return;
  primeAssetInfo(views);
  const videos = views.filter((view) => view.kind !== "audio");
  const sounds = views.filter((view) => view.kind === "audio");
  const clips = videos.map((view) => createClip({ kind: "asset", assetId: view.id }));
  const audio =
    sounds.length > 0
      ? addAudioAt(
          s.draft.audioClips,
          sounds.map((view): StitchAudioSource => ({ kind: "asset", assetId: view.id })),
          drawnPlayhead(s),
        )
      : null;
  s.apply((d) => ({
    ...d,
    timeline: clips.length > 0 ? appendClips(d.timeline, clips) : d.timeline,
    audioClips: audio ? audio.clips : d.audioClips,
  }));
  if (clips.length === 0) {
    if (audio) selectAudioClips(audio.ids.slice(0, 1));
    editor().setPickerOpen(false);
    return;
  }
  const after = editor();
  // In Stacked the first new clip starts under the last one: place it with the records' lengths, which the
  // editor has not measured yet
  const provisional = new Map<SourceKey, number>(after.durations);
  for (const view of videos) {
    const key = sourceKey({ kind: "asset", assetId: view.id });
    if (!provisional.has(key) && typeof view.durationSec === "number") provisional.set(key, view.durationSec);
  }
  const first = after.draft ? draftSpans(after.draft, provisional).find((span) => span.clip.id === clips[0].id) : undefined;
  after.select({ kind: "clip", clipId: clips[0].id });
  after.setPlayhead(first?.start ?? editorTotal(s));
  after.setPickerOpen(false);
}

// An edit project's media (the Edit video view's pane): the assets that belong to the edit, used on the timeline or
// not. They ride in the draft, so each change is one undo step and is saved with the edit; a node's draft has none.

/**
 * Add media: the videos and sounds not already in the edit's media, appended in the order given, as one undo step.
 * Nothing goes on the timeline. The records go to the asset cache so the media is labelled at once. Returns the ids
 * added; none outside an edit.
 */
export function addMediaItems(views: readonly AssetView[]): string[] {
  const s = editor();
  const media = s.draft?.media;
  if (!s.draft || media === undefined) return [];
  const playable = views.filter((view) => view.kind === "video" || view.kind === "audio");
  primeAssetInfo(playable);
  const added = [...new Set(playable.map((view) => view.id))].filter((id) => !media.includes(id));
  if (added.length === 0) return [];
  s.apply((d) => ({ ...d, media: [...(d.media ?? []), ...added] }));
  return added;
}

const usesAsset = (source: StitchClipSource | StitchAudioSource, assetId: string) =>
  source.kind === "asset" && source.assetId === assetId;

/** How many clips, video and audio, use the asset. */
export function mediaUseCount(draft: Pick<StitchDraft, "timeline" | "audioClips">, assetId: string): number {
  return (
    draft.timeline.filter((clip) => usesAsset(clip.source, assetId)).length +
    draft.audioClips.filter((clip) => usesAsset(clip.source, assetId)).length
  );
}

/**
 * Remove from edit: the asset leaves the edit's media and every clip that uses it goes with it, video and audio, as
 * one undo step (the library keeps the file). A lined-up stack closes up; a placed one is pinned first, so nothing
 * else moves. The selection keeps the clips that remain. Returns whether the edit changed.
 */
export function removeMediaItem(assetId: string): boolean {
  const s = editor();
  const draft = s.draft;
  if (!draft || draft.media === undefined) return false;
  const videoIds = new Set(draft.timeline.filter((clip) => usesAsset(clip.source, assetId)).map((clip) => clip.id));
  const audioIds = new Set(draft.audioClips.filter((clip) => usesAsset(clip.source, assetId)).map((clip) => clip.id));
  if (!draft.media.includes(assetId) && videoIds.size === 0 && audioIds.size === 0) return false;
  let timeline = draft.timeline;
  if (videoIds.size > 0) {
    const from = placedOf(s) ? pinStarts(draft.timeline, s.durations, overlapOf(s)) : draft.timeline;
    timeline = removeClips(from, videoIds).timeline;
  }
  const audio = removeAudioClips(draft.audioClips, audioIds);
  const media = draft.media.filter((id) => id !== assetId);
  s.apply((d) => ({ ...d, timeline, audioClips: audio.clips, media }));
  if (audioIds.size > 0) remapExpandedRow(audio.rowMap);
  const gone = new Set([...videoIds, ...audioIds]);
  editor().untagCut([...gone]);
  // A selection that held some of them keeps the rest, as after an undo; one that held none is left alone
  const after = editor();
  const selection = after.selection;
  if (after.draft && selection && [selection.clipId, ...(selection.clipIds ?? [])].some((id) => gone.has(id))) {
    after.select(pruneSelection(selection, after.draft));
  }
  return true;
}

/** The node an edge clip comes from, or null (an asset clip, or an edge that is gone). */
function clipSourceNodeId(clipId: string): string | null {
  const clip = editor().draft?.timeline.find((c) => c.id === clipId);
  if (clip?.source.kind !== "edge") return null;
  const edgeId = clip.source.edgeId;
  return useWorkflowStore.getState().edges.find((e) => e.id === edgeId)?.source ?? null;
}

/** Whether Reveal source node has a node to go to: an edge clip whose source node the editor knows. */
export function canRevealSource(
  clip: Pick<StitchTimelineClip, "source">,
  view: { sourceNodeId?: string | null } | undefined,
): boolean {
  return clip.source.kind === "edge" && Boolean(view?.sourceNodeId);
}

/** Reveal source node: Done, then the canvas centres on the node (it leaves the editor, so the edits are kept). */
export function revealSelectedSource(): void {
  if (selectIsMulti(editor())) return;
  const clipId = selectedClipId(editor());
  const sourceNodeId = clipId ? clipSourceNodeId(clipId) : null;
  if (!sourceNodeId) return;
  if (commitStitchEdit() === "gone") return;
  useWorkflowStore.getState().setNavigationTarget(sourceNodeId);
}

// Audio clips. Each action reads the store, calls one recipe of audioClips.ts and applies once; a recipe that
// renumbers rows hands back a row map, which the expanded row follows.

/** The single selected audio clip, or null (none, a video selection, or several). */
function singleAudioClip(s: StitchEditorState): StitchAudioClip | null {
  const ids = selectedAudioIds(s);
  if (!s.draft || ids.length !== 1) return null;
  return s.draft.audioClips.find((c) => c.id === ids[0]) ?? null;
}

/** The single selected audio clip's span; an unknown length is 0. */
function singleAudioSpan(s: StitchEditorState): AudioSpan | null {
  const clip = singleAudioClip(s);
  return clip ? audioSpans([clip], s.audioDurations)[0] : null;
}

/** A clip's length for overlap checks: decoded, else its library record's, else Infinity (never placed over). */
export function editorAudioLengthOf(s: Pick<StitchEditorState, "audioDurations">): AudioLengthOf {
  return audioLengthOf(s.audioDurations, (clip) =>
    clip.source.kind === "asset" ? (getAssetInfo(clip.source.assetId)?.durationSec ?? null) : null,
  );
}

/** After a recipe that renumbered rows: the expanded row follows its row, and collapses when its row is gone. */
export function remapExpandedRow(rowMap: AudioRowMap): void {
  const s = editor();
  const row = s.audioExpandedRow;
  if (row === null || row >= rowMap.length) return;
  const next = rowMap[row] ?? null;
  if (next !== row) s.setAudioExpandedRow(next);
}

/** Selects these audio clips (none: nothing selected), `lead` leading, else the first in audio order. */
export function selectAudioClips(ids: readonly string[], lead?: string): void {
  const s = editor();
  const selection = s.draft ? makeSelection(s.draft.audioClips.map((c) => c.id), ids, lead ?? ids[0]) : null;
  s.select(selection ? audioSelectionOf(selection) : null);
}

/** A muted lead draws no curve, so no point of it stays selected. */
function forgetPointOfMutedLead(): void {
  const s = editor();
  const selection = s.selection;
  if (selection?.kind !== "audio" || selection.point === null) return;
  if (s.draft?.audioClips.find((c) => c.id === selection.clipId)?.muted) s.select({ ...selection, point: null });
}

/**
 * A body drag's release: the clips it drew (moveAudioClips over the clips at the press), as one undo step. Dropped
 * when the draft's audio changed under the drag.
 */
export function moveAudioClipsBody(
  from: readonly StitchAudioClip[],
  next: { clips: StitchAudioClip[]; rowMap: AudioRowMap },
): void {
  const s = editor();
  if (!s.draft || s.draft.audioClips !== from || next.clips === from) return;
  s.apply((d) => ({ ...d, audioClips: next.clips }));
  remapExpandedRow(next.rowMap);
}

/**
 * An edge drag's release: the clip's In or Out as drawn (trimAudioClip over the clips at the press), one undo step.
 * Dropped when the audio changed under the drag.
 */
export function trimAudioClipBody(
  from: readonly StitchAudioClip[],
  clipId: string,
  patch: { inSec?: number; outSec?: number | null },
): void {
  const s = editor();
  if (!s.draft || s.draft.audioClips !== from) return;
  s.apply((d) => ({ ...d, audioClips: trimAudioClip(d.audioClips, s.audioDurations, clipId, patch) }));
}

/** The selected audio clips by a time and a row delta (moveAudioClips: an overlap sends them onto new rows). */
function moveSelectedAudio(deltaSec: number, deltaRow: number, opts?: { gestureKey?: string }): void {
  const s = editor();
  const ids = selectedAudioIds(s);
  if (!s.draft || ids.length === 0) return;
  const result = moveAudioClips(s.draft.audioClips, editorAudioLengthOf(s), ids, deltaSec, deltaRow);
  if (result.clips === s.draft.audioClips) return;
  s.apply((d) => ({ ...d, audioClips: result.clips }), opts);
  remapExpandedRow(result.rowMap);
}

/** ⌥← / ⌥→ with audio selected: one output frame (⇧: ten), in Track too. A held key's repeats are one undo step. */
export function nudgeSelectedAudio(dir: 1 | -1, big: boolean, repeat: boolean): void {
  const s = editor();
  const ids = selectedAudioIds(s);
  if (ids.length === 0) return;
  if (!repeat) s.endGesture();
  moveSelectedAudio(dir * (big ? BIG_NUDGE_FRAMES : 1) * NUDGE_SEC, 0, { gestureKey: `audio-nudge:${ids.join(",")}` });
}

/** ⌥↑ / ⌥↓ and the menu: whether the selected audio clips have a row to go to (down always: a new row). */
export function canMoveAudioRow(s: StitchEditorState, dir: 1 | -1): boolean {
  const ids = new Set(selectedAudioIds(s));
  if (!s.draft || ids.size === 0) return false;
  return dir === 1 || s.draft.audioClips.every((c) => !ids.has(c.id) || c.row > 0);
}

/** ⌥↑ / ⌥↓ with audio selected: one row up or down; down from the last row makes a new row. */
export function moveSelectedAudioRow(dir: 1 | -1): void {
  moveSelectedAudio(0, dir);
}

/** The clip starts at `sec`: the Start well, [ and ]. One undo step, or one per gesture with opts.gestureKey. */
export function setAudioClipStart(clipId: string, sec: number, opts?: { gestureKey?: string }): void {
  const s = editor();
  const clip = s.draft?.audioClips.find((c) => c.id === clipId);
  if (!s.draft || !clip || !Number.isFinite(sec)) return;
  const result = moveAudioClips(s.draft.audioClips, editorAudioLengthOf(s), [clipId], sec - clip.startSec, 0);
  if (result.clips === s.draft.audioClips) return;
  s.apply((d) => ({ ...d, audioClips: result.clips }), opts);
  remapExpandedRow(result.rowMap);
}

/**
 * ↑ / ↓ in the audio rail's Start well: 0.1 s (⇧: 1 s), one undo step until the well is left. Returns the start now
 * stored, or null when nothing changed.
 */
export function nudgeAudioStartWell(dir: 1 | -1, big: boolean): number | null {
  const s = editor();
  const clip = singleAudioClip(s);
  if (!clip) return null;
  const before = s.draft?.audioClips;
  setAudioClipStart(clip.id, clip.startSec + dir * (big ? BIG_START_STEP_SEC : START_STEP_SEC), {
    gestureKey: `audio-start:${clip.id}`,
  });
  const after = editor();
  if (after.draft?.audioClips === before) return null;
  return after.draft?.audioClips.find((c) => c.id === clip.id)?.startSec ?? null;
}

/** [ and the menu, with audio selected: one audio clip is selected. */
export function canStartAudioAtPlayhead(s: StitchEditorState): boolean {
  return singleAudioClip(s) !== null;
}

/** ] and the menu: the selected audio clip's length is known and fits before the playhead. */
export function canEndAudioAtPlayhead(s: StitchEditorState): boolean {
  const clip = singleAudioClip(s);
  if (!clip) return false;
  const length = editorAudioLengthOf(s)(clip);
  return Number.isFinite(length) && drawnPlayhead(s) - length >= -1e-9;
}

/** [ with audio selected: the clip starts at the playhead. */
export function startSelectedAudioAtPlayhead(): void {
  const s = editor();
  const clip = singleAudioClip(s);
  if (clip) setAudioClipStart(clip.id, drawnPlayhead(s));
}

/** ] with audio selected: the clip ends at the playhead; nothing when it would have to start before 0:00. */
export function endSelectedAudioAtPlayhead(): void {
  const s = editor();
  const clip = canEndAudioAtPlayhead(s) ? singleAudioClip(s) : null;
  if (clip) setAudioClipStart(clip.id, Math.max(0, drawnPlayhead(s) - editorAudioLengthOf(s)(clip)));
}

/** The rail's In and Out: the single selected audio clip, its sound kept in place (trimAudioClip). */
export function trimSelectedAudio(patch: { inSec?: number; outSec?: number | null }): void {
  const s = editor();
  const clip = singleAudioClip(s);
  if (!clip) return;
  s.apply((d) => ({ ...d, audioClips: trimAudioClip(d.audioClips, s.audioDurations, clip.id, patch) }));
}

/** Reset trim: the whole file again, the sound kept in place. */
export function resetSelectedAudioTrim(): void {
  const s = editor();
  const clip = singleAudioClip(s);
  if (!clip) return;
  s.apply((d) => ({ ...d, audioClips: resetAudioTrim(d.audioClips, s.audioDurations, clip.id) }));
}

/** I / O with audio selected: the clip's In or Out at the playhead, when the playhead is inside it. */
export function setAudioEdgeAtPlayhead(edge: "in" | "out"): void {
  const s = editor();
  const span = singleAudioSpan(s);
  const t = drawnPlayhead(s);
  if (!span || span.length <= 0 || t < span.start || t > span.end) return;
  if (edge === "out" ? t <= span.start : t >= span.end) return;
  const at = span.clip.inSec + (t - span.start);
  trimSelectedAudio(edge === "in" ? { inSec: at } : { outSec: at });
}

/** The cuts S would make: every selected audio clip under the playhead with room to split, in audio order. */
function audioSplits(s: StitchEditorState): { clips: StitchAudioClip[]; rightIds: string[] } | null {
  if (!s.draft) return null;
  const t = drawnPlayhead(s);
  let clips = s.draft.audioClips;
  const rightIds: string[] = [];
  for (const id of selectedAudioIds(s)) {
    const split = splitAudioClipAt(clips, s.audioDurations, id, t);
    if (!split) continue;
    clips = split.clips;
    rightIds.push(split.rightId);
  }
  return rightIds.length > 0 ? { clips, rightIds } : null;
}

/** Whether S would split a selected audio clip now. */
export function canSplitAudioAtPlayhead(s: StitchEditorState): boolean {
  return audioSplits(s) !== null;
}

/** S with audio selected: every selected audio clip under the playhead splits; the right pieces are selected. */
export function splitSelectedAudioAtPlayhead(): void {
  const s = editor();
  const split = audioSplits(s);
  if (!split) return;
  s.apply((d) => ({ ...d, audioClips: split.clips }));
  selectAudioClips(split.rightIds);
}

/**
 * Removes the listed audio clips in one step, the rows closing up. The clip now at the first removed place (audio
 * order) takes the selection. Returns the ids removed.
 */
export function removeAudioClipsById(ids: readonly string[]): string[] {
  const s = editor();
  if (!s.draft) return [];
  const wanted = new Set(ids);
  const index = s.draft.audioClips.findIndex((c) => wanted.has(c.id));
  if (index === -1) return [];
  const removed = s.draft.audioClips.filter((c) => wanted.has(c.id)).map((c) => c.id);
  const { clips, rowMap } = removeAudioClips(s.draft.audioClips, wanted);
  s.apply((d) => ({ ...d, audioClips: clips }));
  remapExpandedRow(rowMap);
  const neighbour = clips[Math.min(index, clips.length - 1)];
  editor().select(neighbour ? audioSelectionOf({ clipId: neighbour.id }) : null);
  return removed;
}

/**
 * ⌫ with audio selected: the selected curve point if there is one; else nothing while the last press was on the
 * curve (onCurve); else every selected audio clip.
 */
export function removeAudioSelection(): void {
  const s = editor();
  const selection = s.selection;
  if (selection?.kind !== "audio") return;
  // A point or a curve press counts only while the lead's curve is drawn for editing (its row expanded)
  const leadRow = s.draft?.audioClips.find((c) => c.id === selection.clipId)?.row;
  if (leadRow === s.audioExpandedRow) {
    if (selection.point !== null) return removeSelectedPoint();
    if (selection.onCurve) return;
  }
  editor().untagCut(removeAudioClipsById(selectedAudioIds(s)));
}

/** ⌫ with a curve point selected: removeAudioCurvePoint on the lead. */
export function removeSelectedPoint(): void {
  const selection = editor().selection;
  if (selection?.kind === "audio" && selection.point !== null) removeAudioCurvePoint(selection.clipId, selection.point);
}

/**
 * One point off a clip's curve (⌫, a double-click). The point before it is selected next, else the one after, so a
 * second ⌫ removes the next point and never the clip. Not on a muted clip: it draws no curve.
 */
export function removeAudioCurvePoint(clipId: string, index: number): void {
  const s = editor();
  const clip = s.draft?.audioClips.find((c) => c.id === clipId);
  if (!clip || clip.muted || index < 0 || index >= clip.curve.length) return;
  const curve = removePoint(clip.curve, index);
  s.apply((d) => ({ ...d, audioClips: setAudioClipCurve(d.audioClips, clipId, curve) }));
  const point = index > 0 ? index - 1 : curve.length > 0 ? 0 : null;
  editor().select(audioSelectionOf({ clipId }, point, true));
}

/** M or ⌥M with audio selected, and the menu's Mute: all muted, or all unmuted when every one already is. */
export function toggleSelectedAudioMute(): void {
  const s = editor();
  const ids = new Set(selectedAudioIds(s));
  if (!s.draft || ids.size === 0) return;
  setSelectedAudioMuted(!s.draft.audioClips.filter((c) => ids.has(c.id)).every((c) => c.muted));
}

/** The rail's Sound switch, and its Mute N clips or Unmute N clips: every selected audio clip, one step. */
export function setSelectedAudioMuted(muted: boolean): void {
  const s = editor();
  const ids = new Set(selectedAudioIds(s));
  if (ids.size === 0) return;
  s.apply((d) => ({ ...d, audioClips: setAudioClipsMuted(d.audioClips, ids, muted) }));
  forgetPointOfMutedLead();
}

/** A row header's mute: every clip on the row, unmuted when all already are muted. */
export function toggleRowMute(row: number): void {
  const s = editor();
  const onRow = s.draft?.audioClips.filter((c) => c.row === row) ?? [];
  if (onRow.length === 0) return;
  const muted = !onRow.every((c) => c.muted);
  s.apply((d) => ({ ...d, audioClips: setAudioClipsMuted(d.audioClips, new Set(onRow.map((c) => c.id)), muted) }));
  forgetPointOfMutedLead();
}

/** One curve gesture's result on an audio clip (a point added, moved or removed, the line moved), one undo step. */
export function setAudioCurve(clipId: string, curve: VolumePoint[]): void {
  editor().apply((d) => ({ ...d, audioClips: setAudioClipCurve(d.audioClips, clipId, curve) }));
}

/** The rail's Fade in, Fade out and Flat on the single selected audio clip: over the part one loop hears (D15). */
function setSingleAudioCurve(curveOf: (span: AudioSpan, loopSec: number) => VolumePoint[]): void {
  const s = editor();
  const span = singleAudioSpan(s);
  if (!span) return;
  setAudioCurve(span.clip.id, curveOf(span, editorTotal(s)));
}

export function applyAudioFadeIn(): void {
  setSingleAudioCurve((span, loopSec) => audioFadeIn(span.clip, span, loopSec));
}

export function applyAudioFadeOut(): void {
  setSingleAudioCurve((span, loopSec) => audioFadeOut(span.clip, span, loopSec));
}

export function flattenAudioCurve(): void {
  setSingleAudioCurve(() => flat());
}

const NO_SHAPE = { flat: false, fadeIn: false, fadeOut: false } as const;

/**
 * The rail's Volume shapes pressed for the single selected audio clip: what its curve does over the part one loop
 * hears (audioCurveShape). None without one. A new object each call: read it with useShallow.
 */
export function selectedAudioCurveShape(s: StitchEditorState): { flat: boolean; fadeIn: boolean; fadeOut: boolean } {
  const span = singleAudioSpan(s);
  return span ? audioCurveShape(span.clip, span, editorTotal(s)) : NO_SHAPE;
}

/** Fade out needs the part one loop hears, so it waits for the file's length. */
export function canFadeOutAudio(s: StitchEditorState): boolean {
  const span = singleAudioSpan(s);
  return span !== null && heardRange(span, editorTotal(s)) !== null;
}

/**
 * A row header's volume-line toggle: that row expanded, or collapsed when it already is. Not an undo step. A lead
 * whose row stops being the expanded one draws no editable curve, so its point and curve press are forgotten.
 */
export function toggleAudioRowExpanded(row: number): void {
  const s = editor();
  const expanded = s.audioExpandedRow === row ? null : row;
  s.setAudioExpandedRow(expanded);
  const selection = s.selection;
  if (selection?.kind !== "audio" || (selection.point === null && !selection.onCurve)) return;
  if (s.draft?.audioClips.find((c) => c.id === selection.clipId)?.row !== expanded) {
    s.select({ ...selection, point: null, onCurve: false });
  }
}
