import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PARKED_KEYS,
  STITCH_HISTORY_LIMIT,
  TRANSIENT_KEYS,
  sessionKeys,
  selectCanRedo,
  selectCanUndo,
  selectIsDirty,
  selectIsMulti,
  audioSelectionOf,
  selectedAudioIds,
  selectedClipIds,
  useStitchEditorStore,
} from "@/store/stitchEditorStore";
import { draftSpans, type StitchDraft } from "@/lib/stitch/draft";
import { envelopeAt } from "@/lib/stitch/placement";
import {
  createClip,
  placeClip,
  removeClip,
  spansEnvelope,
  updateClipAudio,
  type SourceKey,
} from "@/lib/stitch/timeline";
import { addPoint, fadeOut, flat } from "@/lib/stitch/curve";
import { createAudioClip, legacyMusicClip, setAudioClipCurve, type AudioSourceKey } from "@/lib/stitch/audioClips";
import { DEFAULT_SEQUENCE_LAYOUT as TRACK_LAYOUT } from "@/lib/stitch/stack";
import {
  addLibraryClips,
  canEndAtPlayhead,
  canLineUp,
  canMoveRow,
  canSplitAtPlayhead,
  canSplitSelectedAtPlayhead,
  canStartAtPlayhead,
  endSelectedAtPlayhead,
  lineUpClips,
  moveClipBody,
  moveClipRows,
  moveClipsBody,
  moveClipsTo,
  moveSelectedRow,
  nudgeSelectedClip,
  nudgeStartWell,
  removeSelection,
  resetSelectedTrim,
  setClipStart,
  setCrossfade,
  setEdgeAtPlayheadForSelection,
  setOverlapSec,
  setSelectedClipsMuted,
  setSequenceMode,
  splitAtPlayhead,
  splitBlockedReason,
  startSelectedAtPlayhead,
  toggleSelectedClipMute,
  trimSelected,
} from "@/components/stitch/editorActions";
import { clearStarts, placeClips } from "@/lib/stitch/timeline";
import { liveFitZoom } from "@/components/stitch/liveFitZoom";
import type { AssetView } from "@/lib/assets/types";
import type { StitchTimelineClip } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const clipA = createClip({ kind: "edge", edgeId: "e1" }, { id: "a" });
const clipB = createClip({ kind: "asset", assetId: "x" }, { id: "b", inSec: 1 });

function makeDraft(overrides: Partial<StitchDraft> = {}): StitchDraft {
  return {
    timeline: [clipA, clipB],
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: TRACK_LAYOUT,
    ...overrides,
  };
}

const store = () => useStitchEditorStore.getState();
const openOn = (draft: StitchDraft = makeDraft()) => store().open({ nodeId: "s1", draft, canvasGeneration: 3 });
const mute = (clipId: string) => (d: StitchDraft) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { muted: true }) });
const setLoop = (loopCount: 1 | 2 | 3) => (d: StitchDraft) => ({ ...d, loopCount });

describe("stitchEditorStore", () => {
  beforeEach(() => {
    store().close();
    store().setSnap(true);
    store().setSoundOn(true);
  });

  it("seeds the initial draft, the draft and the first clip's selection on open", () => {
    const draft = makeDraft();
    openOn(draft);
    const s = store();
    expect(s.isOpen).toBe(true);
    expect(s.nodeId).toBe("s1");
    expect(s.canvasGeneration).toBe(3);
    expect(s.initial).toBe(draft);
    expect(s.draft).toBe(draft);
    expect(s.selection).toEqual({ kind: "clip", clipId: "a" });
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.playhead).toBe(0);
    expect(s.pxPerSec).toBeNull();
    expect(s.discardOpen).toBe(false);
    expect(s.pickerOpen).toBe(false);
  });

  it("selects nothing when the sequence is empty", () => {
    openOn(makeDraft({ timeline: [] }));
    expect(store().selection).toBeNull();
  });

  it("pushes a step for a change and none for a no-op or an equal copy", () => {
    openOn();
    store().apply(mute("a"));
    expect(store().past).toHaveLength(1);
    expect(store().draft!.timeline[0].muted).toBe(true);

    store().apply((d) => d);
    store().apply((d) => ({ ...d, timeline: [...d.timeline] }));
    store().apply(setLoop(1));
    expect(store().past).toHaveLength(1);
  });

  it("forgets a selected point when another gesture changes the lead's curve", () => {
    const music = { ...legacyMusicClip([{ t: 0, gain: 1 }, { t: 4, gain: 0.5 }], false) };
    const tone = createAudioClip({ kind: "asset", assetId: "tone" }, { id: "tone", row: 1, curve: [{ t: 0, gain: 1 }] });
    openOn(makeDraft({ audioClips: [music, tone] }));
    store().select(audioSelectionOf({ clipId: music.id }, 1, true));
    store().apply(setLoop(2));
    expect(store().selection).toMatchObject({ kind: "audio", point: 1 });
    // Another clip's curve leaves the lead's point
    store().apply((d) => ({ ...d, audioClips: setAudioClipCurve(d.audioClips, "tone", [{ t: 1, gain: 0.5 }]) }));
    expect(store().selection).toMatchObject({ kind: "audio", point: 1 });
    store().apply((d) => ({
      ...d,
      audioClips: setAudioClipCurve(d.audioClips, music.id, addPoint(d.audioClips[0].curve, 2, 0.2).curve),
    }));
    expect(store().selection).toEqual({ kind: "audio", clipId: music.id, point: null, onCurve: true });
  });

  it("forgets a selected point on undo and on redo", () => {
    const music = legacyMusicClip([{ t: 0, gain: 1 }], false);
    openOn(makeDraft({ audioClips: [music] }));
    store().apply((d) => ({ ...d, audioClips: setAudioClipCurve(d.audioClips, music.id, flat()) }));
    store().select(audioSelectionOf({ clipId: music.id }, 0));
    store().undo();
    expect(store().selection).toEqual({ kind: "audio", clipId: music.id, point: null, onCurve: false });
    store().select(audioSelectionOf({ clipId: music.id }, 0));
    store().redo();
    expect(store().selection).toEqual({ kind: "audio", clipId: music.id, point: null, onCurve: false });
  });

  it("drops audio clips an undo takes away from the selection, the first left leading", () => {
    const a1 = createAudioClip({ kind: "asset", assetId: "t1" }, { id: "a1" });
    const a2 = createAudioClip({ kind: "asset", assetId: "t2" }, { id: "a2", row: 1 });
    const a3 = createAudioClip({ kind: "asset", assetId: "t3" }, { id: "a3", row: 2 });
    openOn(makeDraft({ audioClips: [a1] }));
    store().apply((d) => ({ ...d, audioClips: [a1, a2, a3] }));
    store().select({ ...audioSelectionOf({ clipId: "a3", clipIds: ["a1", "a2", "a3"], anchorId: "a2" }) });
    store().undo();
    expect(store().selection).toEqual({ kind: "audio", clipId: "a1", point: null, onCurve: false });
    store().select(audioSelectionOf({ clipId: "a1" }));
    const before = store().selection;
    store().redo();
    // Nothing went: the same selection object
    expect(store().selection).toBe(before);
    store().select(audioSelectionOf({ clipId: "a2" }));
    store().undo();
    expect(store().selection).toBeNull();
  });

  it("takes a move that empties an audio row as an edit, though the draft still reads as unchanged", () => {
    const a1 = createAudioClip({ kind: "asset", assetId: "t1" }, { id: "a1" });
    const a2 = createAudioClip({ kind: "asset", assetId: "t2" }, { id: "a2", row: 1 });
    openOn(makeDraft({ audioClips: [a1, a2] }));
    store().apply((d) => ({ ...d, audioClips: [a1, { ...a2, row: 2 }] }));
    expect(store().past).toHaveLength(1);
    expect(store().draft!.audioClips[1].row).toBe(2);
    expect(selectIsDirty(store())).toBe(false);
  });

  it("collapses an expanded row that an undo or redo takes away, and keeps one that stays", () => {
    const a1 = createAudioClip({ kind: "asset", assetId: "t1" }, { id: "a1" });
    const a2 = createAudioClip({ kind: "asset", assetId: "t2" }, { id: "a2", row: 1 });
    openOn(makeDraft({ audioClips: [a1] }));
    store().apply((d) => ({ ...d, audioClips: [a1, a2] }));
    store().setAudioExpandedRow(1);
    store().undo();
    expect(store().audioExpandedRow).toBeNull();
    store().setAudioExpandedRow(0);
    store().redo();
    expect(store().audioExpandedRow).toBe(0);
    // Not undoable: the row stays expanded across history moves that keep it
    store().undo();
    expect(store().audioExpandedRow).toBe(0);
  });

  it("keeps the music edge from open, updates it on markSaved when given, and resets the audio session on close", () => {
    store().open({ nodeId: "s1", draft: makeDraft(), canvasGeneration: 3, musicEdgeIdAtOpen: "eM" });
    expect(store().musicEdgeIdAtOpen).toBe("eM");
    store().markSaved(makeDraft());
    expect(store().musicEdgeIdAtOpen).toBe("eM");
    store().markSaved(makeDraft(), "eM2");
    expect(store().musicEdgeIdAtOpen).toBe("eM2");
    store().markSaved(makeDraft(), null);
    expect(store().musicEdgeIdAtOpen).toBeNull();

    store().setAudioDurations(new Map([["music", 20]]));
    store().setAudioExpandedRow(0);
    store().setPickerOpen("audio");
    expect(store().pickerOpen).toBe("audio");
    store().close();
    const s = store();
    expect(s.audioDurations.size).toBe(0);
    expect(s.audioExpandedRow).toBeNull();
    expect(s.musicEdgeIdAtOpen).toBeNull();
    expect(s.pickerOpen).toBe(false);
    openOn();
    expect(store().musicEdgeIdAtOpen).toBeNull();
  });

  it("selectedAudioIds gives the audio selection's ids in audio order, and nothing for a clip selection", () => {
    const a1 = createAudioClip({ kind: "asset", assetId: "t1" }, { id: "a1" });
    const a2 = createAudioClip({ kind: "asset", assetId: "t2" }, { id: "a2", row: 1 });
    openOn(makeDraft({ audioClips: [a1, a2] }));
    store().select(audioSelectionOf({ clipId: "a2", clipIds: ["a2", "a1", "gone"] }));
    expect(selectedAudioIds(store())).toEqual(["a1", "a2"]);
    expect(selectedClipIds(store())).toEqual([]);
    store().select({ kind: "clip", clipId: "a" });
    expect(selectedAudioIds(store())).toEqual([]);
  });

  it("coalesces a gesture into one step, and endGesture starts a new one", () => {
    openOn();
    const volume = (v: number) => (d: StitchDraft) => ({ ...d, timeline: updateClipAudio(d.timeline, "a", { volume: v }) });
    store().apply(volume(0.9), { gestureKey: "volume:a" });
    store().apply(volume(0.8), { gestureKey: "volume:a" });
    store().apply(volume(0.7), { gestureKey: "volume:a" });
    expect(store().past).toHaveLength(1);
    expect(store().draft!.timeline[0].volume).toBe(0.7);

    store().endGesture();
    store().apply(volume(0.6), { gestureKey: "volume:a" });
    expect(store().past).toHaveLength(2);

    store().undo();
    expect(store().draft!.timeline[0].volume).toBe(0.7);
    store().undo();
    expect(store().draft!.timeline[0].volume).toBe(1);
  });

  it("starts a new step after an undo in the middle of a gesture, so the next tick can be undone", () => {
    openOn();
    const volume = (v: number) => (d: StitchDraft) => ({ ...d, timeline: updateClipAudio(d.timeline, "a", { volume: v }) });
    store().apply(volume(0.9), { gestureKey: "volume:a" });
    store().apply(volume(0.8), { gestureKey: "volume:a" });
    // ⌘Z while the slider is still held, then its next tick
    store().undo();
    store().apply(volume(0.7), { gestureKey: "volume:a" });
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(store().draft!.timeline[0].volume).toBe(1);
  });

  it("round-trips undo and redo, and a new change clears what could be redone", () => {
    const draft = makeDraft();
    openOn(draft);
    store().apply(mute("a"));
    const muted = store().draft;
    store().apply(setLoop(3));

    store().undo();
    expect(store().draft).toBe(muted);
    store().undo();
    expect(store().draft).toBe(draft);
    expect(selectCanUndo(store())).toBe(false);
    expect(selectCanRedo(store())).toBe(true);

    store().redo();
    expect(store().draft).toBe(muted);
    store().apply(mute("b"));
    expect(selectCanRedo(store())).toBe(false);
    expect(store().future).toEqual([]);
  });

  it("keeps at most STITCH_HISTORY_LIMIT steps", () => {
    openOn();
    for (let i = 0; i < STITCH_HISTORY_LIMIT + 20; i++) {
      store().apply((d) => ({ ...d, legacyAudio: { ...d.legacyAudio, curve: [{ t: i + 1, gain: 1 }] } }));
    }
    expect(store().past).toHaveLength(STITCH_HISTORY_LIMIT);
    // The oldest steps are the ones dropped
    expect(store().past[0].legacyAudio.curve[0].t).toBe(20);
    expect(store().past.at(-1)!.legacyAudio.curve[0].t).toBe(STITCH_HISTORY_LIMIT + 19);
    store().undo();
    expect(store().draft!.legacyAudio.curve[0].t).toBe(STITCH_HISTORY_LIMIT + 19);
    // Redo at the cap keeps the newest steps too
    store().redo();
    expect(store().draft!.legacyAudio.curve[0].t).toBe(STITCH_HISTORY_LIMIT + 20);
    expect(store().past).toHaveLength(STITCH_HISTORY_LIMIT);
    expect(store().past[0].legacyAudio.curve[0].t).toBe(20);
  });

  it("is not dirty once undone back to the draft it opened with", () => {
    openOn();
    expect(selectIsDirty(store())).toBe(false);
    store().apply(mute("a"));
    expect(selectIsDirty(store())).toBe(true);
    store().undo();
    expect(selectIsDirty(store())).toBe(false);
  });

  it("drops a clip selection whose clip an undo or redo takes away", () => {
    openOn(makeDraft({ timeline: [clipA] }));
    store().apply((d) => ({ ...d, timeline: [...d.timeline, clipB] }));
    store().select({ kind: "clip", clipId: "b" });
    store().undo();
    expect(store().selection).toBeNull();

    store().redo();
    store().select({ kind: "clip", clipId: "b" });
    store().apply((d) => ({ ...d, timeline: removeClip(d.timeline, "a").timeline }));
    store().select({ kind: "clip", clipId: "b" });
    store().undo();
    expect(store().selection).toEqual({ kind: "clip", clipId: "b" });
    store().select({ kind: "clip", clipId: "a" });
    store().redo();
    expect(store().selection).toBeNull();
  });

  it("resets on close but keeps snap and sound", () => {
    openOn();
    store().apply(mute("a"));
    store().setSnap(false);
    store().setSoundOn(false);
    store().setPlayhead(4);
    store().setZoom(120);
    store().setDiscardOpen(true);
    store().close();
    const s = store();
    expect(s.isOpen).toBe(false);
    expect(s.nodeId).toBeNull();
    expect(s.draft).toBeNull();
    expect(s.initial).toBeNull();
    expect(s.past).toEqual([]);
    expect(s.playhead).toBe(0);
    expect(s.pxPerSec).toBeNull();
    expect(s.discardOpen).toBe(false);
    expect(s.snap).toBe(false);
    expect(s.soundOn).toBe(false);
  });

  it("keeps the loading set when its keys are the same, and drops it on close", () => {
    openOn();
    const keys = new Set<SourceKey>(["edge:e1"]);
    store().setClipsLoading(keys);
    store().setClipsLoading(new Set(keys));
    expect(store().clipsLoading).toBe(keys);
    store().close();
    expect(store().clipsLoading.size).toBe(0);
  });

  it("clamps the playhead at 0", () => {
    openOn();
    store().setPlayhead(-2);
    expect(store().playhead).toBe(0);
  });
});

describe("stitchEditorStore: the sequence layout", () => {
  // a: 5 s; b: 6 s from 1 s, so 5 s. Track 0–5, 5–10; Stacked at 1.0 s 0–5, 4–9
  const DURATIONS = new Map<SourceKey, number>([
    ["edge:e1", 5],
    ["asset:x", 6],
  ]);
  const layout = () => store().draft!.sequenceLayout;

  beforeEach(() => {
    store().close();
    openOn();
    store().setDurations(DURATIONS);
  });

  it("makes each setter one undo step", () => {
    setSequenceMode("stacked");
    expect(store().past).toHaveLength(1);
    setOverlapSec(2);
    expect(store().past).toHaveLength(2);
    setCrossfade(false);
    expect(store().past).toHaveLength(3);
    expect(layout()).toEqual({ mode: "stacked", overlapSec: 2, crossfade: false });
    store().undo();
    expect(layout()).toEqual({ mode: "stacked", overlapSec: 2, crossfade: true });
    store().undo();
    store().undo();
    expect(layout()).toEqual(TRACK_LAYOUT);
  });

  it("takes no step for an overlap that is already stored, rounded or clamped", () => {
    setOverlapSec(1);
    setOverlapSec(1.04);
    expect(store().past).toHaveLength(0);
    setOverlapSec(12);
    expect(layout().overlapSec).toBe(10);
    setOverlapSec(11);
    expect(store().past).toHaveLength(1);
  });

  it("keeps the overlap and the crossfade when switching back to Track", () => {
    setSequenceMode("stacked");
    setOverlapSec(2.5);
    setCrossfade(false);
    setSequenceMode("track");
    expect(layout()).toEqual({ mode: "track", overlapSec: 2.5, crossfade: false });
  });

  it("moves a fade out with the end in the same step, and undo puts both back", () => {
    store().apply((d) => ({ ...d, legacyAudio: { ...d.legacyAudio, curve: fadeOut(d.legacyAudio.curve, 10) } }));
    const steps = store().past.length;
    setSequenceMode("stacked");
    expect(store().past).toHaveLength(steps + 1);
    expect(store().draft!.legacyAudio.curve).toEqual([
      { t: 8, gain: 1 },
      { t: 9, gain: 0 },
    ]);
    store().undo();
    expect(layout().mode).toBe("track");
    expect(store().draft!.legacyAudio.curve).toEqual([
      { t: 9, gain: 1 },
      { t: 10, gain: 0 },
    ]);
  });

  it("keeps the playhead on the same frame of the same clip", () => {
    // 2 s into b
    store().setPlayhead(7);
    setSequenceMode("stacked");
    expect(store().playhead).toBe(6);
    setOverlapSec(2);
    expect(store().playhead).toBe(5);
    setSequenceMode("track");
    expect(store().playhead).toBe(7);
    // Undo leaves it where it is
    store().undo();
    expect(store().playhead).toBe(7);
  });

  it("makes a run of Overlap nudges one step, until the gesture ends", () => {
    setSequenceMode("stacked");
    const steps = store().past.length;
    setOverlapSec(1.1, { gesture: true });
    setOverlapSec(1.2, { gesture: true });
    setOverlapSec(1.3, { gesture: true });
    expect(store().past).toHaveLength(steps + 1);
    expect(layout().overlapSec).toBe(1.3);
    store().endGesture();
    setOverlapSec(1.4, { gesture: true });
    expect(store().past).toHaveLength(steps + 2);
    store().undo();
    store().undo();
    expect(layout().overlapSec).toBe(1);
  });
});

describe("stitchEditorStore: placing clips in Stacked", () => {
  // a: 5 s; b: 6 s from 1 s, so 5 s; c: 4 s. Lined up at 1.0 s: a 0–5, b 4–9, c 8–12
  const DURATIONS = new Map<SourceKey, number>([
    ["edge:e1", 5],
    ["asset:x", 6],
    ["edge:e2", 4],
  ]);
  const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;
  const clipC = createClip({ kind: "edge", edgeId: "e2" }, { id: "c" });

  const spans = () => draftSpans(store().draft!, store().durations);
  const starts = () => spans().map((span) => span.start);
  const ids = () => store().draft!.timeline.map((clip) => clip.id);
  const stored = () => Object.fromEntries(store().draft!.timeline.map((clip) => [clip.id, clip.startSec]));
  const steps = () => store().past.length;
  const selectClip = (clipId: string) => store().select({ kind: "clip", clipId });
  const openStack = (timeline: StitchTimelineClip[] = [clipA, clipB, clipC], layout: StitchDraft["sequenceLayout"] = STACKED) => {
    store().close();
    openOn(makeDraft({ timeline, sequenceLayout: layout }));
    store().setDurations(DURATIONS);
  };
  /** Each clip's share of the picture at t, the pieces of a split counted as the clip they came from. */
  const weightsById = (t: number, pieceOf: Record<string, string> = {}) => {
    const all = spans();
    const env = spansEnvelope(all, store().draft!.sequenceLayout.crossfade);
    const out: Record<string, number> = {};
    for (const layer of envelopeAt(env, t)) {
      const id = all[env.units[layer.unit].row].clip.id;
      const key = pieceOf[id] ?? id;
      out[key] = (out[key] ?? 0) + layer.weight;
    }
    return out;
  };

  beforeEach(() => {
    openStack();
    liveFitZoom.set(null);
  });

  it("sets a start in one step that pins every clip, and takes no step for an unchanged start", () => {
    setClipStart("b", 4);
    expect(steps()).toBe(0);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });

    setClipStart("b", 6);
    expect(steps()).toBe(1);
    expect(stored()).toEqual({ a: 0, b: 6, c: 8 });
    expect(starts()).toEqual([0, 6, 8]);
    setClipStart("b", 6);
    setClipStart("a", 0);
    expect(steps()).toBe(1);

    setClipStart("b", 700);
    expect(stored().b).toBe(600);
    setClipStart("b", -3);
    expect(stored().b).toBe(0);
    store().undo();
    store().undo();
    store().undo();
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
  });

  it("does nothing to a start in Track", () => {
    openStack(undefined, TRACK_LAYOUT);
    selectClip("b");
    setClipStart("b", 6);
    nudgeSelectedClip(1, false, false);
    startSelectedAtPlayhead();
    moveSelectedRow(-1);
    expect(steps()).toBe(0);
    expect(nudgeStartWell(1, false)).toBeNull();
  });

  it("nudges a frame per press, each press one step, a held key's repeats joining it", () => {
    selectClip("b");
    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, false);
    expect(steps()).toBe(3);
    expect(spans()[1].start).toBeCloseTo(4 + 3 / 60, 9);

    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, true);
    nudgeSelectedClip(1, false, true);
    expect(steps()).toBe(4);
    expect(spans()[1].start).toBeCloseTo(4 + 6 / 60, 9);

    nudgeSelectedClip(-1, true, false);
    expect(steps()).toBe(5);
    expect(spans()[1].start).toBeCloseTo(4 - 4 / 60, 9);
    expect(stored().a).toBe(0);
    expect(stored().c).toBe(8);
  });

  it("steps the Start well by 0.1 s, one undo step until it is left, and ⇧ by 1 s", () => {
    selectClip("b");
    expect(nudgeStartWell(1, false)).toBeCloseTo(4.1, 9);
    expect(nudgeStartWell(1, false)).toBeCloseTo(4.2, 9);
    expect(nudgeStartWell(1, false)).toBeCloseTo(4.3, 9);
    expect(steps()).toBe(1);
    store().endGesture();
    expect(nudgeStartWell(1, true)).toBeCloseTo(5.3, 9);
    expect(steps()).toBe(2);
    // At 0:00 nothing moves
    setClipStart("b", 0);
    store().endGesture();
    expect(nudgeStartWell(-1, false)).toBeNull();
  });

  it("moves a row with ⌥↑: a placed stack keeps every start, a lined-up one re-sequences", () => {
    selectClip("c");
    expect(canMoveRow(store(), 1)).toBe(false);
    expect(canMoveRow(store(), -1)).toBe(true);
    moveSelectedRow(-1);
    expect(ids()).toEqual(["a", "c", "b"]);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
    // c 4–8, then b 7–12
    expect(starts()).toEqual([0, 4, 7]);

    openStack();
    setClipStart("c", 10);
    selectClip("c");
    moveSelectedRow(-1);
    expect(steps()).toBe(2);
    expect(ids()).toEqual(["a", "c", "b"]);
    expect(starts()).toEqual([0, 10, 4]);
    selectClip("a");
    expect(canMoveRow(store(), -1)).toBe(false);
  });

  it("applies a body drag as one step: the new start and row together, every clip pinned, nothing re-sequenced", () => {
    const drawn = placeClip(store().draft!.timeline, DURATIONS, "c", 3, 0, 1);
    moveClipBody("c", drawn);
    expect(steps()).toBe(1);
    expect(ids()).toEqual(["c", "a", "b"]);
    expect(stored()).toEqual({ c: 3, a: 0, b: 4 });
    expect(store().draft!.timeline).toBe(drawn);
    store().undo();
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
    // A drag back to where it began writes nothing
    moveClipBody("c", store().draft!.timeline);
    expect(steps()).toBe(0);
  });

  it("puts the start or the end at the playhead with [ and ]", () => {
    selectClip("b");
    store().setPlayhead(2);
    startSelectedAtPlayhead();
    expect(spans()[1].start).toBe(2);
    store().setPlayhead(10);
    endSelectedAtPlayhead();
    expect(spans()[1].start).toBe(5);
    expect(steps()).toBe(2);
    // b lasts 5 s: it cannot end at 3 s
    store().setPlayhead(3);
    expect(canEndAtPlayhead(store())).toBe(false);
    endSelectedAtPlayhead();
    expect(steps()).toBe(2);
  });

  it("lines up the clips in one step: starts dropped, an end fade moved, the playhead on the same frame", () => {
    expect(canLineUp(store())).toBe(false);
    setClipStart("c", 9);
    expect(canLineUp(store())).toBe(true);
    store().apply((d) => ({ ...d, legacyAudio: { ...d.legacyAudio, curve: fadeOut(d.legacyAudio.curve, 13) } }));
    selectClip("c");
    store().setPlayhead(10);
    const before = steps();

    lineUpClips();
    expect(steps()).toBe(before + 1);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
    expect(starts()).toEqual([0, 4, 8]);
    expect(store().draft!.legacyAudio.curve.at(-1)).toEqual({ t: 12, gain: 0 });
    expect(store().playhead).toBe(9);

    store().undo();
    expect(stored()).toEqual({ a: 0, b: 4, c: 9 });
  });

  it("trims in place in Stacked: every trim pins, the frames stay where they were", () => {
    selectClip("b");
    trimSelected({ inSec: 2 });
    expect(steps()).toBe(1);
    // b's frames stay put: In +1 s, start +1 s; c does not ripple to 7
    expect(stored()).toEqual({ a: 0, b: 5, c: 8 });
    trimSelected({ outSec: 5 });
    expect(spans()[1]).toMatchObject({ start: 5, end: 8 });

    store().setPlayhead(6);
    setEdgeAtPlayheadForSelection("in");
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 3, startSec: 6 });
    store().setPlayhead(7);
    setEdgeAtPlayheadForSelection("out");
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 3, outSec: 4, startSec: 6 });
    expect(stored().c).toBe(8);
  });

  it("resets a trim in place, the start back by the old In and never before 0:00", () => {
    selectClip("b");
    resetSelectedTrim();
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 0, outSec: null, startSec: 3 });
    trimSelected({ inSec: 2 });
    setClipStart("b", 1);
    resetSelectedTrim();
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 0, startSec: 0 });
  });

  it("removes a clip from a placed stack without moving the others; a lined-up one closes up", () => {
    selectClip("a");
    removeSelection();
    expect(starts()).toEqual([0, 4]);

    openStack();
    setClipStart("c", 10);
    selectClip("a");
    removeSelection();
    expect(ids()).toEqual(["b", "c"]);
    expect(starts()).toEqual([4, 10]);
  });

  it("refuses a split inside a lined-up overlap, with commit 9's reason", () => {
    store().setPlayhead(4.5);
    expect(splitBlockedReason(store())).toBe("Move the playhead out of the overlap to split");
    expect(canSplitAtPlayhead(store())).toBe(false);
    splitAtPlayhead();
    expect(steps()).toBe(0);
  });

  it.each([true, false])("splits a placed clip inside an overlap and changes no weight (Crossfade %s)", (crossfade) => {
    setCrossfade(crossfade);
    setClipStart("c", 7);
    selectClip("b");
    store().setPlayhead(8);
    expect(splitBlockedReason(store())).toBeNull();
    expect(canSplitAtPlayhead(store())).toBe(true);
    const instants = Array.from({ length: 50 }, (_, i) => (i * 11) / 50 + 0.013);
    const before = instants.map((t) => weightsById(t));
    const stepsBefore = steps();

    splitAtPlayhead();
    expect(steps()).toBe(stepsBefore + 1);
    const timeline = store().draft!.timeline;
    expect(timeline).toHaveLength(4);
    const right = timeline[2];
    expect(right.startSec).toBe(8);
    expect(store().selection).toEqual({ kind: "clip", clipId: right.id });
    const after = instants.map((t) => weightsById(t, { [right.id]: "b" }));
    after.forEach((weights, i) => {
      for (const id of new Set([...Object.keys(weights), ...Object.keys(before[i])])) {
        expect(weights[id] ?? 0).toBeCloseTo(before[i][id] ?? 0, 9);
      }
    });
  });

  it("adds library clips to a placed stack unpinned, Overlap before the latest end, with the playhead there", () => {
    setClipStart("c", 10);
    addLibraryClips([{ id: "n1", durationSec: 3 }] as AssetView[]);
    const added = store().draft!.timeline[3];
    expect(added.startSec).toBeUndefined();
    // c ends at 14
    expect(store().playhead).toBe(13);
  });

  it("changes Overlap in a placed stack without moving any clip, in one step", () => {
    setClipStart("c", 10);
    addLibraryClips([{ id: "n1", durationSec: 3 }, { id: "n2", durationSec: 2 }] as AssetView[]);
    store().setDurations(
      new Map<SourceKey, number>([...DURATIONS, ["asset:n1", 3], ["asset:n2", 2]]),
    );
    const was = starts();
    expect(was).toEqual([0, 4, 10, 13, 15]);
    const before = steps();
    setOverlapSec(2);
    expect(steps()).toBe(before + 1);
    expect(starts()).toEqual(was);
    expect(store().draft!.sequenceLayout.overlapSec).toBe(2);
    expect(Object.values(stored())).toEqual([0, 4, 10, 13, 15]);
    store().undo();
    expect(store().draft!.timeline[3].startSec).toBeUndefined();
  });

  it("leaves a stored start alone in Track trims and through layout switches", () => {
    const placedB = { ...clipB, startSec: 6 };
    openStack([clipA, placedB, clipC], TRACK_LAYOUT);
    selectClip("b");
    trimSelected({ inSec: 2 });
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 2, startSec: 6 });
    setSequenceMode("stacked");
    expect(stored()).toEqual({ a: undefined, b: 6, c: undefined });
    setCrossfade(false);
    setSequenceMode("track");
    expect(stored()).toEqual({ a: undefined, b: 6, c: undefined });
  });

  it("keeps the zoom in Fit when a move lengthens the sequence, and not otherwise", () => {
    liveFitZoom.set(40);
    setClipStart("b", 5);
    expect(store().pxPerSec).toBeNull();
    setClipStart("c", 10);
    expect(store().pxPerSec).toBe(40);

    store().setZoom(null);
    const drawn = placeClip(store().draft!.timeline, DURATIONS, "c", 12, 2, 1);
    moveClipBody("c", drawn);
    expect(store().pxPerSec).toBe(40);

    // A chosen zoom stays as it is
    store().setZoom(80);
    setClipStart("c", 20);
    expect(store().pxPerSec).toBe(80);
  });
});

describe("stitchEditorStore: several clips", () => {
  const clipC = createClip({ kind: "edge", edgeId: "e2" }, { id: "c" });
  const clipD = createClip({ kind: "asset", assetId: "y" }, { id: "d" });
  const ids = () => store().draft!.timeline.map((clip) => clip.id);
  const steps = () => store().past.length;
  const group = (...clipIds: string[]) =>
    store().select({ kind: "clip", clipId: clipIds[0], clipIds });

  beforeEach(() => {
    store().close();
    openOn(makeDraft({ timeline: [clipA, clipB, clipC, clipD] }));
  });

  it("drops the clips an undo or redo takes away; the first that remains leads when the lead went", () => {
    store().apply((d) => ({ ...d, timeline: d.timeline.slice(0, 2) }));
    store().undo();
    store().select({ kind: "clip", clipId: "c", clipIds: ["a", "b", "c"], anchorId: "b" });
    store().redo();
    expect(store().selection).toEqual({ kind: "clip", clipId: "a", clipIds: ["a", "b"], anchorId: "b" });
    store().undo();
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "d"], anchorId: "d" });
    store().redo();
    expect(store().selection).toEqual({ kind: "clip", clipId: "a" });
    store().undo();
    store().select({ kind: "clip", clipId: "c", clipIds: ["c", "d"] });
    store().redo();
    expect(store().selection).toBeNull();
  });

  it("keeps a selection that an undo leaves whole as it was", () => {
    store().apply(mute("a"));
    const selection = { kind: "clip", clipId: "b", clipIds: ["a", "b"], anchorId: "a" } as const;
    store().select(selection);
    store().undo();
    expect(store().selection).toBe(selection);
  });

  it("lists the selected ids in timeline order, none for an audio selection", () => {
    store().select({ kind: "clip", clipId: "b", clipIds: ["d", "b", "x"] });
    expect(selectedClipIds(store())).toEqual(["b", "d"]);
    expect(selectIsMulti(store())).toBe(true);
    store().select({ kind: "clip", clipId: "b" });
    expect(selectedClipIds(store())).toEqual(["b"]);
    expect(selectIsMulti(store())).toBe(false);
    store().select(audioSelectionOf({ clipId: "m" }));
    expect(selectedClipIds(store())).toEqual([]);
  });

  it("tags clips outside the history, each keeping its first tag, and forgets them with the session", () => {
    const before = store().clipOrigins;
    store().tagClips(["p1", "p2"], "pasted");
    store().tagClips(["p1", "a"], "cut");
    expect([...store().clipOrigins]).toEqual([
      ["p1", "pasted"],
      ["p2", "pasted"],
      ["a", "cut"],
    ]);
    expect(store().clipOrigins).not.toBe(before);
    const tagged = store().clipOrigins;
    store().tagClips(["a"], "duplicated");
    expect(store().clipOrigins).toBe(tagged);
    store().apply(mute("b"));
    store().undo();
    expect(store().clipOrigins).toBe(tagged);
    store().close();
    expect(store().clipOrigins.size).toBe(0);
    store().tagClips(["q"], "duplicated");
    store().open({ nodeId: "s2", draft: makeDraft(), canvasGeneration: 4 });
    expect(store().clipOrigins.size).toBe(0);
  });

  it("forgets a cut tag when the clip, brought back by undo, is removed another way", () => {
    store().select({ kind: "clip", clipId: "b" });
    store().tagClips(["b", "p"], "pasted");
    store().tagClips(["a", "b"], "cut");
    removeSelection();
    expect([...store().clipOrigins]).toEqual([
      ["b", "pasted"],
      ["p", "pasted"],
      ["a", "cut"],
    ]);
    store().select({ kind: "clip", clipId: "a" });
    removeSelection();
    expect(store().clipOrigins.has("a")).toBe(false);
    store().tagClips(["c"], "cut");
    store().select({ kind: "clip", clipId: "c", clipIds: ["c", "d"] });
    removeSelection();
    expect(store().clipOrigins.has("c")).toBe(false);
  });

  it("removes every selected clip in one step; the clip now at the first removed index is selected", () => {
    group("b", "c");
    removeSelection();
    expect(ids()).toEqual(["a", "d"]);
    expect(steps()).toBe(1);
    expect(store().selection).toEqual({ kind: "clip", clipId: "d" });
    store().undo();
    expect(ids()).toEqual(["a", "b", "c", "d"]);
    group("c", "d");
    removeSelection();
    expect(store().selection).toEqual({ kind: "clip", clipId: "b" });
  });

  it("mutes a mixed selection, and unmutes one that is all muted, each one step", () => {
    store().apply(mute("a"));
    group("a", "c");
    toggleSelectedClipMute();
    expect(store().draft!.timeline.map((c) => c.muted)).toEqual([true, false, true, false]);
    toggleSelectedClipMute();
    expect(store().draft!.timeline.map((c) => c.muted)).toEqual([false, false, false, false]);
    expect(steps()).toBe(3);
    setSelectedClipsMuted(false);
    expect(steps()).toBe(3);
    setSelectedClipsMuted(true);
    expect(store().draft!.timeline.map((c) => c.muted)).toEqual([true, false, true, false]);
    expect(steps()).toBe(4);
  });

  it("leaves trims, Start, In and Out alone with several selected", () => {
    store().setDurations(new Map<SourceKey, number>([["edge:e1", 5]]));
    group("a", "b");
    const before = store().draft;
    trimSelected({ inSec: 1 });
    setEdgeAtPlayheadForSelection("in");
    setSequenceMode("stacked");
    const stacked = store().draft;
    setClipStart("a", 3);
    startSelectedAtPlayhead();
    expect(canStartAtPlayhead(store())).toBe(false);
    expect(nudgeStartWell(1, false)).toBeNull();
    expect(store().draft).toBe(stacked);
    expect(stacked!.timeline).toBe(before!.timeline);
  });

  it("moves a block in Track, its order kept", () => {
    moveClipsTo(["a", "c"], 2);
    expect(ids()).toEqual(["b", "d", "a", "c"]);
    expect(steps()).toBe(1);
    moveClipsTo(["a", "c"], 2);
    expect(steps()).toBe(1);
  });
});

describe("stitchEditorStore: several clips in Stacked", () => {
  // Clip 1 A [0,5), Clip 2 B [6,10.2), Clip 3 C [9.2,15.2), Clip 4 D [11,14.2)
  const DURATIONS = new Map<SourceKey, number>([
    ["edge:a", 5],
    ["edge:b", 5],
    ["edge:c", 6],
    ["edge:d", 5],
  ]);
  const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;
  const board = () => [
    createClip({ kind: "edge", edgeId: "a" }, { id: "c1", startSec: 0 }),
    createClip({ kind: "edge", edgeId: "b" }, { id: "c2", startSec: 6, inSec: 0.8 }),
    createClip({ kind: "edge", edgeId: "c" }, { id: "c3", startSec: 9.2 }),
    createClip({ kind: "edge", edgeId: "d" }, { id: "c4", startSec: 11, outSec: 3.2 }),
  ];
  const ids = () => store().draft!.timeline.map((clip) => clip.id);
  const steps = () => store().past.length;
  const startOf = (clipId: string) => draftSpans(store().draft!, store().durations).find((s) => s.clip.id === clipId)!.start;
  const group = (...clipIds: string[]) => store().select({ kind: "clip", clipId: clipIds[0], clipIds });
  const open = (timeline: StitchTimelineClip[] = board()) => {
    store().close();
    openOn(makeDraft({ timeline, sequenceLayout: STACKED }));
    store().setDurations(DURATIONS);
  };

  beforeEach(() => {
    open();
    liveFitZoom.set(null);
  });

  it("removes a group from a placed stack without moving the others", () => {
    group("c2", "c3");
    removeSelection();
    expect(ids()).toEqual(["c1", "c4"]);
    expect(startOf("c4")).toBe(11);
    expect(store().selection).toEqual({ kind: "clip", clipId: "c4" });
  });

  it("nudges a group a frame per press, its offsets kept, a held key's repeats joining one step", () => {
    group("c2", "c3");
    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, true);
    expect(startOf("c2")).toBeCloseTo(6 + 2 / 60, 9);
    expect(startOf("c3")).toBeCloseTo(9.2 + 2 / 60, 9);
    expect(startOf("c1")).toBe(0);
    expect(steps()).toBe(1);
    nudgeSelectedClip(-1, true, false);
    expect(startOf("c2")).toBeCloseTo(6 - 8 / 60, 9);
    expect(steps()).toBe(2);
    group("c1", "c2");
    nudgeSelectedClip(-1, false, false);
    expect(steps()).toBe(2);
  });

  it("splits every selected clip under the playhead and selects the right pieces, in one step", () => {
    group("c1", "c2", "c3");
    store().setPlayhead(10);
    expect(canSplitAtPlayhead(store())).toBe(true);
    expect(canSplitSelectedAtPlayhead(store())).toBe(true);
    expect(splitBlockedReason(store())).toBeNull();
    splitAtPlayhead();
    expect(steps()).toBe(1);
    expect(ids()).toHaveLength(6);
    const selection = store().selection;
    expect(selection?.kind === "clip" && selection.clipIds).toEqual([ids()[2], ids()[4]]);
    expect(selection?.kind === "clip" && selection.clipId).toBe(ids()[2]);
  });

  it("says when no selected clip is under the playhead, and then splits nothing", () => {
    group("c2", "c3");
    store().setPlayhead(3);
    expect(canSplitAtPlayhead(store())).toBe(false);
    expect(splitBlockedReason(store())).toBe("No selected clip is under the playhead");
    splitAtPlayhead();
    expect(steps()).toBe(0);
  });

  it("gives no reason when a selected clip is under the playhead but too near its start to split", () => {
    group("c2", "c3");
    store().setPlayhead(6.02);
    expect(canSplitAtPlayhead(store())).toBe(false);
    expect(splitBlockedReason(store())).toBeNull();
  });

  it("gives the overlap's reason in a lined-up stack", () => {
    open(clearStarts(board()));
    group("c1", "c2");
    // Lined up at Overlap 1: c1 0–5, c2 4–8.2
    store().setPlayhead(4.5);
    expect(splitBlockedReason(store())).toBe("Move the playhead out of the overlap to split");
  });

  it("resets every selected trim in one step, the frames in place", () => {
    group("c2", "c3", "c4");
    resetSelectedTrim();
    expect(steps()).toBe(1);
    expect(startOf("c2")).toBeCloseTo(5.2, 9);
    expect(startOf("c4")).toBe(11);
    expect(store().draft!.timeline.map((c) => [c.inSec, c.outSec])).toEqual([
      [0, null],
      [0, null],
      [0, null],
      [0, null],
    ]);
  });

  it("moves a group a row with ⌥↓, keeping the starts, and stops at the bottom", () => {
    group("c1", "c3");
    expect(canMoveRow(store(), -1)).toBe(false);
    expect(canMoveRow(store(), 1)).toBe(true);
    moveSelectedRow(1);
    expect(ids()).toEqual(["c2", "c1", "c4", "c3"]);
    expect(startOf("c3")).toBe(9.2);
    expect(steps()).toBe(1);
    expect(canMoveRow(store(), 1)).toBe(false);
    moveSelectedRow(1);
    expect(steps()).toBe(1);
    moveClipRows(["c1", "c3"], -5);
    expect(ids()).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("applies a group drag's timeline as one step", () => {
    const drawn = placeClips(store().draft!.timeline, DURATIONS, new Set(["c2", "c3"]), 2, 1, 1);
    moveClipsBody(["c2", "c3"], drawn);
    expect(steps()).toBe(1);
    expect(ids()).toEqual(["c1", "c4", "c2", "c3"]);
    expect(startOf("c2")).toBeCloseTo(8, 9);
    moveClipsBody(["c2", "gone"], drawn);
    expect(steps()).toBe(1);
  });
});

describe("stitchEditorStore: edit project sessions", () => {
  const assetClip = (id: string, assetId: string) => createClip({ kind: "asset", assetId }, { id });
  const editDraft = () => makeDraft({ timeline: [assetClip("v1", "a1"), assetClip("v2", "a2")] });
  const openEdit = (draft = editDraft()) => store().openEdit({ editId: "ed0123456789ab", draft });

  beforeEach(() => store().close());

  it("T-STORE-1 openEdit sets editId, not nodeId, and selects the first clip", () => {
    openEdit();
    const s = store();
    expect(s.isOpen).toBe(true);
    expect(s.editId).toBe("ed0123456789ab");
    expect(s.nodeId).toBeNull();
    expect(s.canvasGeneration).toBeNull();
    expect(s.selection).toEqual({ kind: "clip", clipId: "v1" });
    openOn();
    expect(store().nodeId).not.toBeNull();
    expect(store().editId).toBeNull();
  });

  it("T-STORE-2 park then restore gives the session back, undo included", () => {
    openEdit();
    store().apply((d) => ({ ...d, loopCount: 2 }));
    store().apply((d) => ({ ...d, loopCount: 3 }));
    store().undo();
    store().select({ kind: "clip", clipId: "v2" });
    store().setPlayhead(4.2);
    store().setZoom(80);
    store().setDurations(new Map<SourceKey, number>([["asset:a1", 5]]));
    store().setAudioExpandedRow(0);
    store().setAudioDurations(new Map<AudioSourceKey, number>([["asset:m1", 7]]));
    store().tagClips(["v2"], "pasted");
    const before = store();

    const parked = store().park();
    expect(parked).not.toBeNull();
    expect(store().isOpen).toBe(false);
    expect(store().editId).toBeNull();

    store().restore(parked!);
    const s = store();
    expect(s.isOpen).toBe(true);
    expect(s.nodeId).toBeNull();
    for (const key of PARKED_KEYS) expect(s[key]).toBe(before[key]);
    // By value too, outside PARKED_KEYS: a field moved to TRANSIENT_KEYS would leave the loop above and still pass it
    expect(s.selection).toEqual({ kind: "clip", clipId: "v2" });
    expect(s.playhead).toBe(4.2);
    expect(s.pxPerSec).toBe(80);
    expect(s.durations.get("asset:a1")).toBe(5);
    expect(s.audioDurations.get("asset:m1")).toBe(7);
    expect(s.audioExpandedRow).toBe(0);
    expect(s.past).toHaveLength(1);
    expect(s.future).toHaveLength(1);
    expect(s.initial).toBe(before.initial);
    expect(s.clipOrigins.get("v2")).toBe("pasted");
    expect(s.draft!.loopCount).toBe(2);
    store().undo();
    expect(store().draft!.loopCount).toBe(1);
    store().redo();
    store().redo();
    expect(store().draft!.loopCount).toBe(3);
  });

  it("T-STORE-3 every session field is parked or transient, never both", () => {
    const parked = new Set<string>(PARKED_KEYS);
    const transient = new Set<string>(TRANSIENT_KEYS);
    expect([...parked].filter((key) => transient.has(key))).toEqual([]);
    expect(sessionKeys().filter((key) => !parked.has(key) && !transient.has(key))).toEqual([]);
    expect([...parked, ...transient].sort()).toEqual(sessionKeys().sort());
  });

  it("T-STORE-4 park cancels a drag and stops playing; it leaves a node session alone and returns null", () => {
    const cancel = vi.fn();
    openEdit();
    store().setPlaying(true);
    store().setCancelGesture(cancel);
    const parked = store().park();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(store().playing).toBe(false);
    expect(store().cancelGesture).toBeNull();
    expect(parked).not.toHaveProperty("playing");

    openOn();
    store().setPlaying(true);
    expect(store().park()).toBeNull();
    expect(store().isOpen).toBe(true);
    expect(store().playing).toBe(true);
    store().close();
    expect(store().park()).toBeNull();
  });

  it("takes the asset of a clip added any way into the edit's media, in the same undo step", () => {
    openEdit(makeDraft({ timeline: [assetClip("v1", "a1")], media: ["a1", "a9"] }));
    store().apply((d) => ({
      ...d,
      timeline: [...d.timeline, assetClip("v2", "a2"), assetClip("v3", "a1")],
      audioClips: [createAudioClip({ kind: "asset", assetId: "m1" }, { id: "s1" })],
    }));
    expect(store().draft!.media).toEqual(["a1", "a9", "a2", "m1"]);
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(store().draft!.media).toEqual(["a1", "a9"]);
    store().redo();
    expect(store().draft!.media).toEqual(["a1", "a9", "a2", "m1"]);
    // Taking a clip away leaves its asset in the media
    store().apply((d) => ({ ...d, timeline: d.timeline.slice(0, 1) }));
    expect(store().draft!.media).toEqual(["a1", "a9", "a2", "m1"]);
  });

  it("counts a change to the media alone as an undo step that makes the edit dirty", () => {
    openEdit(makeDraft({ timeline: [assetClip("v1", "a1")], media: ["a1"] }));
    store().apply((d) => ({ ...d, media: [...(d.media ?? []), "a9"] }));
    expect(store().past).toHaveLength(1);
    expect(selectIsDirty(store())).toBe(true);
    store().undo();
    expect(selectIsDirty(store())).toBe(false);
  });

  it("gives a node's draft no media", () => {
    openOn();
    store().apply((d) => ({ ...d, timeline: [...d.timeline, assetClip("n", "a5")] }));
    expect(store().draft).not.toHaveProperty("media");
    expect(store().past).toHaveLength(1);
  });

  it("setEditId moves an edit session to another edit and never touches a node session", () => {
    openEdit();
    store().setEditId("ed9999999999zz");
    expect(store().editId).toBe("ed9999999999zz");
    openOn();
    store().setEditId("ed9999999999zz");
    expect(store().editId).toBeNull();
  });

  it("open keeps the video edges the draft referenced; markSaved does not move them", () => {
    openOn();
    expect(store().edgeIdsAtOpen).toEqual(["e1"]);
    store().markSaved(makeDraft({ timeline: [clipA, createClip({ kind: "edge", edgeId: "e9" }, { id: "n" })] }));
    expect(store().edgeIdsAtOpen).toEqual(["e1"]);
  });
});
