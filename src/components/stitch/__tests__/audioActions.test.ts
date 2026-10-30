import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { createAudioClip, moveAudioClips, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import { __resetAssetInfoForTests, getAssetInfo } from "@/lib/stitch/assetInfo";
import { fadeIn, fadeOut } from "@/lib/stitch/curve";
import type { StitchDraft } from "@/lib/stitch/draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { AssetView } from "@/lib/assets/types";
import type { StitchAudioClip, VolumePoint } from "@/types";
import {
  addLibraryClips,
  applyAudioFadeIn,
  applyAudioFadeOut,
  canEndAudioAtPlayhead,
  canFadeOutAudio,
  canMoveAudioRow,
  canSplitAudioAtPlayhead,
  editorAudioLengthOf,
  endSelectedAudioAtPlayhead,
  flattenAudioCurve,
  moveAudioClipsBody,
  moveSelectedAudioRow,
  nudgeAudioStartWell,
  nudgeSelectedAudio,
  openLibraryPicker,
  removeAudioCurvePoint,
  removeAudioSelection,
  resetSelectedAudioTrim,
  setAudioClipStart,
  setAudioEdgeAtPlayhead,
  setSelectedAudioMuted,
  splitSelectedAudioAtPlayhead,
  startSelectedAudioAtPlayhead,
  toggleAudioRowExpanded,
  toggleMusicMute,
  toggleRowMute,
  toggleSelectedAudioMute,
  trimSelectedAudio,
} from "../editorActions";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// The editor's audio actions over the real store: each one recipe of audioClips.ts, applied once.

const TONE = "atone00000001";
const RAIN = "arain00000001";
const store = () => useStitchEditorStore.getState();

const music = (init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, ...init });
const tone = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

/** Two 5 s video clips (a 10 s sequence), the music (20 s) on row 0 and a 3 s tone at 2 s on row 1. */
function openOn(audioClips: StitchAudioClip[] = [music(), tone("t", { row: 1, startSec: 2 })], extra: Partial<StitchDraft> = {}) {
  const draft: StitchDraft = {
    timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "a" }), createClip({ kind: "edge", edgeId: "e2" }, { id: "b" })],
    audioClips,
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
    ...extra,
  };
  store().open({ nodeId: "n1", draft, canvasGeneration: 1 });
  store().setDurations(
    new Map<SourceKey, number>([
      ["edge:e1", 5],
      ["edge:e2", 5],
    ]),
  );
  store().setAudioDurations(
    new Map([
      ["music", 20],
      [`asset:${TONE}`, 3],
    ]),
  );
}

const clips = () => store().draft!.audioClips;
const clip = (id: string) => clips().find((c) => c.id === id)!;
const select = (...ids: string[]) => store().select(audioSelectionOf({ clipId: ids[0], ...(ids.length > 1 ? { clipIds: ids } : {}) }));

beforeEach(() => {
  store().close();
  __resetAssetInfoForTests();
});
afterEach(() => store().close());

describe("adding audio from the library", () => {
  it("opens the picker for audio over a paused preview", () => {
    openOn();
    store().setPlaying(true);
    openLibraryPicker("audio");
    expect(store().pickerOpen).toBe("audio");
    expect(store().playing).toBe(false);
    openLibraryPicker();
    expect(store().pickerOpen).toBe("video");
  });

  it("puts each picked file on its own new row at the playhead, selects the first, closes the picker, one step", () => {
    openOn();
    store().setPlayhead(4.2);
    store().setPickerOpen("audio");
    addLibraryClips([
      { id: TONE, kind: "audio", durationSec: 3 },
      { id: RAIN, kind: "audio", durationSec: 8 },
    ] as AssetView[]);
    const added = clips().slice(2);
    expect(added.map((c) => [c.source, c.row, c.startSec])).toEqual([
      [{ kind: "asset", assetId: TONE }, 2, 4.2],
      [{ kind: "asset", assetId: RAIN }, 3, 4.2],
    ]);
    expect(store().selection).toEqual({ kind: "audio", clipId: added[0].id, point: null, onCurve: false });
    expect(store().pickerOpen).toBe(false);
    expect(store().past).toHaveLength(1);
    // The records are primed: the rain's length counts for overlap checks before any decode
    expect(getAssetInfo(RAIN)?.durationSec).toBe(8);
    expect(editorAudioLengthOf(store())(added[1])).toBe(8);
  });

  it("counts a length known neither way as reaching the end of time", () => {
    openOn([createAudioClip({ kind: "asset", assetId: RAIN }, { id: "r" })]);
    expect(editorAudioLengthOf(store())(clip("r"))).toBe(Infinity);
    expect(editorAudioLengthOf(store())(music({ inSec: 5 }))).toBe(15);
  });
});

describe("moving audio clips", () => {
  it("applies a drag's release once, and drops it when the audio changed under the drag", () => {
    openOn();
    const from = clips();
    const result = moveAudioClips(from, editorAudioLengthOf(store()), ["t"], 1, 0);
    moveAudioClipsBody(from, result);
    expect(clip("t").startSec).toBe(3);
    expect(store().past).toHaveLength(1);
    // A second release measured on the old clips writes nothing
    moveAudioClipsBody(from, moveAudioClips(from, editorAudioLengthOf(store()), ["t"], 2, 0));
    expect(clip("t").startSec).toBe(3);
    expect(store().past).toHaveLength(1);
  });

  it("nudges the selected clips a frame, in Track too; a held key is one step", () => {
    openOn();
    select("t");
    nudgeSelectedAudio(1, false, false);
    nudgeSelectedAudio(1, false, true);
    nudgeSelectedAudio(1, true, true);
    expect(clip("t").startSec).toBeCloseTo(2 + 12 / 60, 9);
    expect(store().past).toHaveLength(1);
    nudgeSelectedAudio(-1, false, false);
    expect(store().past).toHaveLength(2);
  });

  it("moves rows: down from the last makes a new row, up from the top does nothing, an overlap inserts a row", () => {
    openOn([music(), tone("t", { row: 1, startSec: 2 }), tone("u", { row: 2, startSec: 0 })]);
    select("u");
    expect(canMoveAudioRow(store(), 1)).toBe(true);
    moveSelectedAudioRow(1);
    expect(clip("u").row).toBe(3);
    select(MUSIC_CLIP_ID);
    expect(canMoveAudioRow(store(), -1)).toBe(false);
    const before = store().draft;
    moveSelectedAudioRow(-1);
    expect(store().draft).toBe(before);
    // The tone onto the music's row would overlap it: it goes onto a new row under row 0, the rows below move down
    store().setAudioExpandedRow(3);
    select("t");
    moveSelectedAudioRow(-1);
    expect(clips().map((c) => [c.id, c.row])).toEqual([
      [MUSIC_CLIP_ID, 0],
      ["t", 1],
      ["u", 4],
    ]);
    // The expanded row follows its row
    expect(store().audioExpandedRow).toBe(4);
  });

  it("sets a start from the well, [ and ], keeping the step a gesture key makes", () => {
    openOn();
    select("t");
    expect(nudgeAudioStartWell(1, false)).toBeCloseTo(2.1, 9);
    expect(nudgeAudioStartWell(1, true)).toBeCloseTo(3.1, 9);
    expect(store().past).toHaveLength(1);
    store().endGesture();
    store().setPlayhead(6);
    startSelectedAudioAtPlayhead();
    expect(clip("t").startSec).toBe(6);
    expect(canEndAudioAtPlayhead(store())).toBe(true);
    endSelectedAudioAtPlayhead();
    expect(clip("t").startSec).toBe(3);
    store().setPlayhead(1);
    expect(canEndAudioAtPlayhead(store())).toBe(false);
    endSelectedAudioAtPlayhead();
    expect(clip("t").startSec).toBe(3);
    setAudioClipStart("t", 0.5);
    expect(clip("t").startSec).toBe(0.5);
  });
});

describe("trimming and splitting audio clips", () => {
  it("trims with the sound in place, resets, and sets In and Out at the playhead", () => {
    openOn();
    select("t");
    trimSelectedAudio({ inSec: 1 });
    expect(clip("t")).toMatchObject({ inSec: 1, startSec: 3, outSec: null });
    resetSelectedAudioTrim();
    expect(clip("t")).toMatchObject({ inSec: 0, startSec: 2, outSec: null });
    store().setPlayhead(4);
    setAudioEdgeAtPlayhead("out");
    expect(clip("t")).toMatchObject({ inSec: 0, outSec: 2, startSec: 2 });
    store().setPlayhead(3);
    setAudioEdgeAtPlayhead("in");
    expect(clip("t")).toMatchObject({ inSec: 1, outSec: 2, startSec: 3 });
    // Outside the clip: nothing
    store().setPlayhead(8);
    const before = store().draft;
    setAudioEdgeAtPlayhead("in");
    expect(store().draft).toBe(before);
  });

  it("does not trim a clip whose length is not known yet", () => {
    openOn([createAudioClip({ kind: "asset", assetId: RAIN }, { id: "r" })]);
    select("r");
    const before = store().draft;
    trimSelectedAudio({ inSec: 1 });
    store().setPlayhead(1);
    setAudioEdgeAtPlayhead("out");
    expect(store().draft).toBe(before);
  });

  it("splits every selected clip under the playhead and selects the right pieces", () => {
    openOn();
    select(MUSIC_CLIP_ID, "t");
    store().setPlayhead(3);
    expect(canSplitAudioAtPlayhead(store())).toBe(true);
    splitSelectedAudioAtPlayhead();
    expect(store().past).toHaveLength(1);
    const rights = clips().filter((c) => c.startSec === 3);
    expect(rights.map((c) => [c.row, c.inSec])).toEqual([
      [0, 3],
      [1, 1],
    ]);
    expect(store().selection).toMatchObject({ kind: "audio", clipIds: rights.map((c) => c.id) });
    // Too near an end: refused
    select("t");
    store().setPlayhead(2.05);
    expect(canSplitAudioAtPlayhead(store())).toBe(false);
  });
});

describe("removing audio clips and curve points", () => {
  it("removes the selected clips, closes the rows up, selects the neighbour and collapses a removed expanded row", () => {
    openOn([music(), tone("t", { row: 1, startSec: 2 }), tone("u", { row: 2, startSec: 0 })]);
    store().tagClips(["t"], "cut");
    store().setAudioExpandedRow(1);
    select("t");
    removeAudioSelection();
    expect(clips().map((c) => [c.id, c.row])).toEqual([
      [MUSIC_CLIP_ID, 0],
      ["u", 1],
    ]);
    expect(store().selection).toEqual({ kind: "audio", clipId: "u", point: null, onCurve: false });
    expect(store().audioExpandedRow).toBeNull();
    // Removed by ⌫, not cut
    expect(store().clipOrigins.has("t")).toBe(false);
  });

  it("follows the expanded row when a removal closes up the rows above it", () => {
    openOn([music(), tone("t", { row: 1, startSec: 2 }), tone("u", { row: 2, startSec: 0 })]);
    store().setAudioExpandedRow(2);
    select(MUSIC_CLIP_ID);
    removeAudioSelection();
    expect(store().audioExpandedRow).toBe(1);
  });

  it("removes the selected point and selects the one before it, so a second ⌫ removes the next point, never the clip", () => {
    const curve: VolumePoint[] = [
      { t: 0, gain: 1 },
      { t: 1, gain: 0.5 },
      { t: 2, gain: 0.25 },
    ];
    openOn([music({ curve })]);
    store().setAudioExpandedRow(0);
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true));
    removeAudioSelection();
    expect(clip(MUSIC_CLIP_ID).curve).toEqual([curve[0], curve[2]]);
    expect(store().selection).toEqual({ kind: "audio", clipId: MUSIC_CLIP_ID, point: 0, onCurve: true });
    removeAudioSelection();
    expect(clip(MUSIC_CLIP_ID).curve).toEqual([curve[2]]);
    // The point after it, once none is before
    expect(store().selection).toMatchObject({ point: 0 });
    removeAudioSelection();
    expect(clip(MUSIC_CLIP_ID).curve).toEqual([]);
    expect(store().selection).toMatchObject({ point: null, onCurve: true });
    // onCurve: ⌫ removes nothing more, not the clip
    removeAudioSelection();
    expect(clips()).toHaveLength(1);
    expect(store().past).toHaveLength(3);
  });

  it("a double-click's removal selects the point before it the same way", () => {
    const curve: VolumePoint[] = [
      { t: 0, gain: 1 },
      { t: 1, gain: 0.5 },
    ];
    openOn([music({ curve })]);
    removeAudioCurvePoint(MUSIC_CLIP_ID, 1);
    expect(store().selection).toEqual({ kind: "audio", clipId: MUSIC_CLIP_ID, point: 0, onCurve: true });
  });

  it("removes no point of a muted clip: it draws no curve", () => {
    openOn([music({ curve: [{ t: 1, gain: 0.5 }], muted: true })]);
    store().setAudioExpandedRow(0);
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 0, true));
    removeAudioSelection();
    expect(clip(MUSIC_CLIP_ID).curve).toHaveLength(1);
  });

  it("removes the clip, not a curve point, once the lead's row is collapsed", () => {
    const curve: VolumePoint[] = [
      { t: 0, gain: 1 },
      { t: 1, gain: 0.5 },
    ];
    // Collapsed by the lead's own toggle: the point and the curve press are forgotten
    openOn([music({ curve }), tone("t", { row: 1, startSec: 2 })]);
    toggleAudioRowExpanded(0);
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true));
    toggleAudioRowExpanded(0);
    expect(store().selection).toEqual({ kind: "audio", clipId: MUSIC_CLIP_ID, point: null, onCurve: false });
    removeAudioSelection();
    expect(clips().map((c) => c.id)).toEqual(["t"]);

    // Another row's toggle expands: the same
    openOn([music({ curve }), tone("t", { row: 1, startSec: 2 })]);
    toggleAudioRowExpanded(0);
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true));
    toggleAudioRowExpanded(1);
    expect(store().selection).toMatchObject({ point: null, onCurve: false });

    // A point left on a lead whose row is not expanded (any other way) is not removed either
    openOn([music({ curve }), tone("t", { row: 1, startSec: 2 })]);
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true));
    removeAudioSelection();
    expect(clips().map((c) => c.id)).toEqual(["t"]);
    expect(store().past).toHaveLength(1);
  });
});

describe("muting audio", () => {
  it("M with audio selected mutes them all, or unmutes when all are muted, forgetting a point of a muted lead", () => {
    openOn([music({ curve: [{ t: 1, gain: 0.5 }] }), tone("t", { row: 1, muted: true })]);
    store().select({ ...audioSelectionOf({ clipId: MUSIC_CLIP_ID, clipIds: [MUSIC_CLIP_ID, "t"] }), point: 0 });
    toggleSelectedAudioMute();
    expect(clips().map((c) => c.muted)).toEqual([true, true]);
    expect(store().selection).toMatchObject({ point: null });
    toggleSelectedAudioMute();
    expect(clips().map((c) => c.muted)).toEqual([false, false]);
    setSelectedAudioMuted(false);
    expect(store().past).toHaveLength(2);
  });

  it("M with nothing of the audio selected mutes every music clip; without one it can only unmute a legacy node", () => {
    openOn([music(), tone("t", { row: 1 }), music({ id: "m2", row: 2 })]);
    toggleMusicMute();
    expect(clips().map((c) => [c.id, c.muted])).toEqual([
      [MUSIC_CLIP_ID, true],
      ["t", false],
      ["m2", true],
    ]);
    toggleMusicMute();
    expect(clips().every((c) => !c.muted)).toBe(true);

    openOn([], { legacyAudio: { curve: [], muted: false } });
    toggleMusicMute();
    expect(store().draft!.legacyAudio.muted).toBe(false);
    expect(store().past).toHaveLength(0);
    openOn([], { legacyAudio: { curve: [], muted: true } });
    toggleMusicMute();
    expect(store().draft!.legacyAudio.muted).toBe(false);
  });

  it("a row header's mute mutes every clip on the row, unmuting when all are", () => {
    openOn([music(), tone("t", { startSec: 0, row: 1 }), tone("u", { startSec: 5, row: 1, muted: true })]);
    toggleRowMute(1);
    expect(clips().map((c) => c.muted)).toEqual([false, true, true]);
    toggleRowMute(1);
    expect(clips().map((c) => c.muted)).toEqual([false, false, false]);
    const before = store().draft;
    toggleRowMute(5);
    expect(store().draft).toBe(before);
  });
});

describe("audio curves", () => {
  it("fades the legacy music clip as the single track did, over one loop", () => {
    openOn([music()]);
    select(MUSIC_CLIP_ID);
    applyAudioFadeIn();
    expect(clip(MUSIC_CLIP_ID).curve).toEqual(fadeIn([], 10));
    applyAudioFadeOut();
    expect(clip(MUSIC_CLIP_ID).curve).toEqual(fadeOut(fadeIn([], 10), 10));
    flattenAudioCurve();
    expect(clip(MUSIC_CLIP_ID).curve).toEqual([]);
    expect(store().past).toHaveLength(3);
  });

  it("waits for the length before a fade out on a clip that plays to its file's end", () => {
    openOn([createAudioClip({ kind: "asset", assetId: RAIN }, { id: "r" })]);
    select("r");
    expect(canFadeOutAudio(store())).toBe(false);
    applyAudioFadeOut();
    expect(clip("r").curve).toEqual([]);
    // Fade in does not wait
    applyAudioFadeIn();
    expect(clip("r").curve).not.toEqual([]);
    store().setAudioDurations(new Map([[`asset:${RAIN}`, 4]]));
    expect(canFadeOutAudio(store())).toBe(true);
  });

  it("expands one row at a time by its header's toggle, outside the history", () => {
    openOn();
    toggleAudioRowExpanded(1);
    expect(store().audioExpandedRow).toBe(1);
    toggleAudioRowExpanded(0);
    expect(store().audioExpandedRow).toBe(0);
    toggleAudioRowExpanded(0);
    expect(store().audioExpandedRow).toBeNull();
    expect(store().past).toHaveLength(0);
  });
});
