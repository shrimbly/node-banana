import { describe, expect, it } from "vitest";
import { audioLengthOf, audioRowCount, createAudioClip } from "@/lib/stitch/audioClips";
import { draftSpans, type StitchDraft } from "@/lib/stitch/draft";
import { audioSectionLayout } from "@/lib/stitch/audioLayout";
import {
  insertLibraryItem,
  libraryDropAt,
  libraryItemOf,
  playheadTarget,
  provisionalDurations,
  stackedAddBlocked,
  WAITING_FOR_CLIPS,
  type LibraryDropGeometry,
  type LibraryItem,
} from "@/lib/stitch/libraryInsert";
import { createClip, isPlaced, sourceKey, type SourceDurations, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchTimelineClip } from "@/types";

const clip = (id: string, assetId: string, extra: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "asset", assetId }, { id, ...extra });

const TRACK = { mode: "track" as const, overlapSec: 1, crossfade: true };
const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };

function draftOf(timeline: StitchTimelineClip[], overrides: Partial<StitchDraft> = {}): StitchDraft {
  return {
    timeline,
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: TRACK,
    ...overrides,
  };
}

const lengths = (entries: Array<[string, number]>): SourceDurations =>
  new Map(entries.map(([assetId, sec]) => [`asset:${assetId}` as SourceKey, sec]));

/** a 4 s, b 6 s, c 5 s. */
const DURATIONS = lengths([
  ["a", 4],
  ["b", 6],
  ["c", 5],
]);
const video = (assetId = "n", durationSec: number | null = 3): LibraryItem => ({ assetId, kind: "video", durationSec });
const sound = (assetId = "s", durationSec: number | null = 2): LibraryItem => ({ assetId, kind: "audio", durationSec });
const noAudio = audioLengthOf(new Map(), () => null);
const abc = () => [clip("a", "a"), clip("b", "b"), clip("c", "c")];
const startsOf = (d: StitchDraft) => draftSpans(d, DURATIONS).map((span) => [span.clip.id, span.start]);

describe("playheadTarget: video in Track", () => {
  const d = draftOf(abc());

  it("goes after the clip under the playhead", () => {
    expect(playheadTarget(d, DURATIONS, 5, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 2 });
    expect(playheadTarget(d, DURATIONS, 0.5, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 1 });
  });

  it("goes before a clip when the playhead is exactly at its start", () => {
    expect(playheadTarget(d, DURATIONS, 4, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 1 });
    expect(playheadTarget(d, DURATIONS, 0, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 0 });
  });

  it("goes after a selected clip the playhead is at the start of (the one just added)", () => {
    expect(playheadTarget(d, DURATIONS, 4, video(), noAudio, new Set(["b"]))).toEqual({ lane: "clips", mode: "track", index: 2 });
    expect(playheadTarget(d, DURATIONS, 0, video(), noAudio, new Set(["a"]))).toEqual({ lane: "clips", mode: "track", index: 1 });
    expect(playheadTarget(d, DURATIONS, 4, video(), noAudio, new Set(["a"]))).toEqual({ lane: "clips", mode: "track", index: 1 });
  });

  it("is appended at or past the end, and into an empty timeline", () => {
    expect(playheadTarget(d, DURATIONS, 15, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 3 });
    expect(playheadTarget(d, DURATIONS, 40, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 3 });
    expect(playheadTarget(draftOf([]), DURATIONS, 0, video(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 0 });
  });
});

describe("playheadTarget: video in Stacked", () => {
  it("lined up, the playhead inside: a new bottom row at the playhead", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    expect(playheadTarget(d, DURATIONS, 2, video(), noAudio)).toEqual({ lane: "clips", mode: "stacked", startSec: 2, row: 3 });
  });

  it("lined up, the playhead at or past the end: appended lined up", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    // 4 + 6 + 5 less two 1 s overlaps
    expect(playheadTarget(d, DURATIONS, 13, video(), noAudio)).toEqual({ lane: "clips", mode: "stackedAppend" });
    expect(playheadTarget(d, DURATIONS, 20, video(), noAudio)).toEqual({ lane: "clips", mode: "stackedAppend" });
    expect(playheadTarget(draftOf([], { sequenceLayout: STACKED }), DURATIONS, 0, video(), noAudio)).toEqual({
      lane: "clips",
      mode: "stackedAppend",
    });
  });

  it("placed: always a new bottom row at the playhead, the end included", () => {
    const d = draftOf([clip("a", "a", { startSec: 0 }), clip("b", "b")], { sequenceLayout: STACKED });
    expect(playheadTarget(d, DURATIONS, 30, video(), noAudio)).toEqual({ lane: "clips", mode: "stacked", startSec: 30, row: 2 });
  });
});

describe("playheadTarget: audio", () => {
  const lengthOf = audioLengthOf(new Map([["asset:s1", 4]]), () => null);
  const withAudio = (row: number, startSec: number) =>
    draftOf(abc(), { audioClips: [createAudioClip({ kind: "asset", assetId: "s1" }, { id: "x", row, startSec })] });

  it("takes the first row with room for the sound at the playhead", () => {
    expect(playheadTarget(withAudio(0, 0), DURATIONS, 5, sound(), lengthOf)).toEqual({
      lane: "audio",
      startSec: 5,
      row: 0,
      newRow: false,
    });
  });

  it("opens a new row when the sound would overlap", () => {
    expect(playheadTarget(withAudio(0, 0), DURATIONS, 1, sound(), lengthOf)).toEqual({
      lane: "audio",
      startSec: 1,
      row: 1,
      newRow: true,
    });
    // Unknown length: it runs to the end, so a clip later on the row is in the way
    expect(playheadTarget(withAudio(0, 8), DURATIONS, 1, sound("s", null), lengthOf)).toMatchObject({ row: 1, newRow: true });
  });

  it("opens the first row of an edit with no audio", () => {
    expect(playheadTarget(draftOf([]), DURATIONS, 0, sound(), noAudio)).toEqual({ lane: "audio", startSec: 0, row: 0, newRow: true });
  });
});

describe("insertLibraryItem", () => {
  it("Track: inserts at the index and changes nothing else", () => {
    const d = draftOf(abc());
    const { draft, clipId } = insertLibraryItem(d, DURATIONS, video("n"), { lane: "clips", mode: "track", index: 1 });
    expect(draft.timeline.map((c) => c.id)).toEqual(["a", clipId, "b", "c"]);
    expect(draft.timeline[1]).toMatchObject({ source: { kind: "asset", assetId: "n" }, inSec: 0, outSec: null });
    expect(draft.timeline[1]).not.toHaveProperty("startSec");
    expect(draft.timeline.filter((c) => c.id !== clipId)).toEqual(d.timeline);
  });

  it("stackedAppend: appended with no start anywhere, so the stack stays lined up", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    const { draft } = insertLibraryItem(d, DURATIONS, video(), { lane: "clips", mode: "stackedAppend" });
    expect(draft.timeline).toHaveLength(4);
    expect(isPlaced(draft.timeline)).toBe(false);
  });

  it("Stacked: pins every clip where it showed, then a new row starting at the time", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    const before = startsOf(d);
    const { draft, clipId } = insertLibraryItem(d, DURATIONS, video("n"), { lane: "clips", mode: "stacked", startSec: 2, row: 3 });
    expect(draft.timeline.map((c) => c.id)).toEqual(["a", "b", "c", clipId]);
    expect(draft.timeline.slice(0, 3).map((c) => [c.id, c.startSec])).toEqual(before);
    expect(draft.timeline[3].startSec).toBe(2);
    expect(startsOf({ ...draft, timeline: draft.timeline.slice(0, 3) })).toEqual(before);
    // Trims untouched
    expect(draft.timeline.slice(0, 3).map((c) => [c.inSec, c.outSec])).toEqual(d.timeline.map((c) => [c.inSec, c.outSec]));
  });

  it("Stacked: a row in the middle keeps the others' order", () => {
    const d = draftOf([clip("a", "a", { startSec: 0 }), clip("b", "b", { startSec: 3 })], { sequenceLayout: STACKED });
    const { draft, clipId } = insertLibraryItem(d, DURATIONS, video(), { lane: "clips", mode: "stacked", startSec: 7, row: 1 });
    expect(draft.timeline.map((c) => [c.id, c.startSec])).toEqual([
      ["a", 0],
      [clipId, 7],
      ["b", 3],
    ]);
  });

  it("audio: on a row, or on a new row inserted there with the rows under it moved down", () => {
    const d = draftOf([], {
      audioClips: [
        createAudioClip({ kind: "asset", assetId: "s1" }, { id: "x", row: 0, startSec: 0 }),
        createAudioClip({ kind: "asset", assetId: "s2" }, { id: "y", row: 1, startSec: 0 }),
      ],
    });
    const onRow = insertLibraryItem(d, DURATIONS, sound("z"), { lane: "audio", startSec: 9, row: 1, newRow: false });
    expect(onRow.draft.audioClips.find((c) => c.id === onRow.clipId)).toMatchObject({ row: 1, startSec: 9, source: { assetId: "z" } });
    expect(onRow.rowMap).toBeNull();

    const inserted = insertLibraryItem(d, DURATIONS, sound("z"), { lane: "audio", startSec: 2, row: 1, newRow: true });
    expect(inserted.draft.audioClips.map((c) => [c.id === inserted.clipId ? "new" : c.id, c.row])).toEqual([
      ["x", 0],
      ["new", 1],
      ["y", 2],
    ]);
    expect(inserted.rowMap).toEqual([0, 2]);
    expect(audioRowCount(inserted.draft.audioClips)).toBe(3);

    const bottom = insertLibraryItem(d, DURATIONS, sound("z"), { lane: "audio", startSec: 0, row: 2, newRow: true });
    expect(bottom.rowMap).toBeNull();
    expect(bottom.draft.audioClips.find((c) => c.id === bottom.clipId)?.row).toBe(2);
  });

  it("refuses an item of the wrong kind for the lane", () => {
    const d = draftOf(abc());
    expect(insertLibraryItem(d, DURATIONS, sound(), { lane: "clips", mode: "track", index: 0 })).toEqual({
      draft: d,
      clipId: null,
      rowMap: null,
    });
    expect(insertLibraryItem(d, DURATIONS, video(), { lane: "audio", startSec: 0, row: 0, newRow: true }).clipId).toBeNull();
  });
});

describe("provisionalDurations", () => {
  const d = draftOf([clip("a", "a"), clip("b", "b"), clip("c", "c"), clip("d", "d")]);

  it("takes the measured length, then the record's, then the snapshot's", () => {
    const measured = lengths([["a", 4]]);
    const records: Record<string, { durationSec: number | null }> = { a: { durationSec: 99 }, b: { durationSec: 6 }, c: { durationSec: null } };
    const snapshot = { b: { durationSec: 77 }, c: { durationSec: 5 } };
    const out = provisionalDurations(d, measured, (id) => records[id], snapshot);
    expect(out.get(sourceKey({ kind: "asset", assetId: "a" }))).toBe(4);
    expect(out.get(sourceKey({ kind: "asset", assetId: "b" }))).toBe(6);
    expect(out.get(sourceKey({ kind: "asset", assetId: "c" }))).toBe(5);
    expect(out.has(sourceKey({ kind: "asset", assetId: "d" }))).toBe(false);
  });

  it("gives a missing clip its record's or snapshot's length, never 0 when either is known", () => {
    const gone = provisionalDurations(d, new Map(), (id) => (id === "a" ? null : undefined), { a: { durationSec: 4 } });
    expect(gone.get("asset:a")).toBe(4);
    const pinned = insertLibraryItem(
      draftOf([clip("a", "a"), clip("b", "b")], { sequenceLayout: STACKED }),
      provisionalDurations(draftOf([clip("a", "a"), clip("b", "b")]), new Map(), () => null, { a: { durationSec: 4 }, b: { durationSec: 6 } }),
      video(),
      { lane: "clips", mode: "stacked", startSec: 0, row: 2 },
    );
    // b starts 1 s before a's 4 s end, not at 0
    expect(pinned.draft.timeline.map((c) => c.startSec)).toEqual([0, 3, 0]);
  });

  it("is the measured map itself when nothing needs adding", () => {
    const measured = lengths([["a", 4], ["b", 6], ["c", 5], ["d", 1]]);
    expect(provisionalDurations(d, measured, () => null, {})).toBe(measured);
  });
});

describe("stackedAddBlocked", () => {
  const loading = new Set<SourceKey>(["asset:b"]);
  const stackedTarget = { lane: "clips" as const, mode: "stacked" as const, startSec: 2, row: 3 };

  it("waits while a clip is loading and the add would pin", () => {
    expect(stackedAddBlocked(draftOf(abc(), { sequenceLayout: STACKED }), stackedTarget, loading)).toBe(WAITING_FOR_CLIPS);
  });

  it("does not wait once every clip has loaded, or when every clip already has a start", () => {
    expect(stackedAddBlocked(draftOf(abc(), { sequenceLayout: STACKED }), stackedTarget, new Set())).toBeNull();
    const placed = abc().map((c, i) => ({ ...c, startSec: i * 2 }));
    expect(stackedAddBlocked(draftOf(placed, { sequenceLayout: STACKED }), stackedTarget, loading)).toBeNull();
  });

  it("never holds back Track, audio or a lined-up append", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    expect(stackedAddBlocked(d, { lane: "clips", mode: "track", index: 0 }, loading)).toBeNull();
    expect(stackedAddBlocked(d, { lane: "clips", mode: "stackedAppend" }, loading)).toBeNull();
    expect(stackedAddBlocked(d, { lane: "audio", startSec: 0, row: 0, newRow: true }, loading)).toBeNull();
  });
});

describe("libraryItemOf", () => {
  it("takes videos and sounds with a usable length", () => {
    expect(libraryItemOf({ id: "v", kind: "video", durationSec: 5 })).toEqual({ assetId: "v", kind: "video", durationSec: 5 });
    expect(libraryItemOf({ id: "s", kind: "audio", durationSec: undefined })).toEqual({ assetId: "s", kind: "audio", durationSec: null });
    expect(libraryItemOf({ id: "i", kind: "image", durationSec: undefined })).toBeNull();
  });
});

describe("libraryDropAt", () => {
  // 10 px a second from x 16; clip rows 52 px under a 24 px ruler; the audio section's top 200 px down the lanes
  const PPS = 10;
  const ORIGIN = 16;
  const axis = { pxPerSec: PPS, xToTime: (x: number) => (x - ORIGIN) / PPS };
  const geometry = (overrides: Partial<LibraryDropGeometry> = {}): LibraryDropGeometry => ({
    stacked: false,
    axis,
    // Track's boxes for a 4 s, 6 s and 5 s clip
    boxes: [
      { x: 16, width: 40 },
      { x: 56, width: 60 },
      { x: 116, width: 50 },
    ],
    rowHeight: 52,
    ruler: 24,
    sectionTop: 200,
    audioLayout: audioSectionLayout(1, null),
    audioScroll: 0,
    snapTimes: [],
    ...overrides,
  });
  const at = (x: number, viewY: number, contentY = viewY, snap = false) => ({ x, viewY, contentY, snap });

  it("Track: before the first box whose middle is right of the pointer", () => {
    const d = draftOf(abc());
    expect(libraryDropAt(d, video(), at(20, 60), geometry(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 0 });
    expect(libraryDropAt(d, video(), at(40, 60), geometry(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 1 });
    expect(libraryDropAt(d, video(), at(150, 60), geometry(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 3 });
    expect(libraryDropAt(d, video(), at(900, 60), geometry(), noAudio)).toEqual({ lane: "clips", mode: "track", index: 3 });
  });

  it("Stacked: a new row at the nearest row boundary, starting at the pointer's time", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    const g = geometry({ stacked: true });
    // Row 1's upper half → before row 1; its lower half → after it
    expect(libraryDropAt(d, video(), at(46, 0, 24 + 52 + 10), g, noAudio)).toEqual({ lane: "clips", mode: "stacked", startSec: 3, row: 1 });
    expect(libraryDropAt(d, video(), at(46, 0, 24 + 52 + 40), g, noAudio)).toEqual({ lane: "clips", mode: "stacked", startSec: 3, row: 2 });
    // Under the last row: the bottom; left of 0:00: 0:00
    expect(libraryDropAt(d, video(), at(0, 0, 900), g, noAudio)).toEqual({ lane: "clips", mode: "stacked", startSec: 0, row: 3 });
  });

  it("snaps a start within 8 px of the playhead or a clip's edge, only when asked", () => {
    const d = draftOf(abc(), { sequenceLayout: STACKED });
    const g = geometry({ stacked: true, snapTimes: [4, 10] });
    expect(libraryDropAt(d, video(), at(16 + 37, 0, 40, true), g, noAudio)).toMatchObject({ startSec: 4 });
    expect(libraryDropAt(d, video(), at(16 + 37, 0, 40, false), g, noAudio)).toMatchObject({ startSec: 3.7 });
    expect(libraryDropAt(d, video(), at(16 + 70, 0, 40, true), g, noAudio)).toMatchObject({ startSec: 7 });
  });

  it("a video never drops on the audio rows, a sound never on the clip rows", () => {
    const d = draftOf(abc());
    expect(libraryDropAt(d, video(), at(40, 210), geometry(), noAudio)).toBeNull();
    expect(libraryDropAt(d, sound(), at(40, 60), geometry(), noAudio)).toBeNull();
  });

  it("a sound goes on the row under the pointer, under it when it would overlap there, or a new row from the strip", () => {
    const d = draftOf(abc(), {
      audioClips: [createAudioClip({ kind: "asset", assetId: "m" }, { id: "s1", row: 0, startSec: 0 })],
    });
    const lengthOf = audioLengthOf(new Map([["asset:m", 2]]), () => null);
    const g = geometry({ audioLayout: audioSectionLayout(1, null) });
    // Over row 0 after the 2 s sound: on it
    expect(libraryDropAt(d, sound("n", 2), at(16 + 30, 210), g, lengthOf)).toEqual({ lane: "audio", startSec: 3, row: 0, newRow: false });
    // Over it: a new row under it
    expect(libraryDropAt(d, sound("n", 2), at(16 + 5, 210), g, lengthOf)).toEqual({ lane: "audio", startSec: 0.5, row: 1, newRow: true });
    // The strip under the rows (64 px of rows): a new bottom row
    expect(libraryDropAt(d, sound("n", 2), at(16 + 30, 200 + 64 + 4), g, lengthOf)).toEqual({ lane: "audio", startSec: 3, row: 1, newRow: true });
    // No audio yet: the first row
    expect(libraryDropAt(draftOf(abc()), sound(), at(16, 210), g, noAudio)).toEqual({ lane: "audio", startSec: 0, row: 0, newRow: true });
  });
});
