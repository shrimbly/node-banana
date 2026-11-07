import { describe, expect, it } from "vitest";
import type { StitchAudioClip, StitchAudioSource } from "@/types";
import {
  addAudioAt,
  audioClipLength,
  audioCurveShape,
  audioFadeIn,
  audioFadeOut,
  audioLengthOf,
  audioRowCount,
  audioSourceKey,
  audioSpans,
  compactAudioRows,
  copyAudioItems,
  createAudioClip,
  describeAudioChanges,
  dropMusicClips,
  duplicateAudioClips,
  followEndFades,
  heardRange,
  isLegacyAudio,
  isLegacyAudioShape,
  isUntouchedMusic,
  legacyCopy,
  legacyMusicClip,
  moveAudioClips,
  MUSIC_CLIP_ID,
  normalizeAudioClips,
  overlapsOnRow,
  pasteAudioClips,
  reconcileMusicClip,
  removeAudioClips,
  resetAudioTrim,
  sameAudioClips,
  sanitizeAudioClips,
  setAudioClipCurve,
  setAudioClipsMuted,
  splitAudioClipAt,
  trimAudioClip,
  type AudioDurations,
  type AudioSourceKey,
} from "../audioClips";
import { fadeIn, fadeOut, followEndFade } from "../curve";

const TONE: StitchAudioSource = { kind: "asset", assetId: "atone00000001" };
const RAIN: StitchAudioSource = { kind: "asset", assetId: "arain00000001" };
const music = (init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, ...init });
const tone = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip(TONE, { id, ...init });
const rain = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip(RAIN, { id, ...init });
const durations = (entries: Partial<Record<AudioSourceKey, number>>): AudioDurations =>
  new Map(Object.entries(entries) as [AudioSourceKey, number][]);
/** music 20 s, tone 3 s, rain 5 s. */
const D = durations({ music: 20, "asset:atone00000001": 3, "asset:arain00000001": 5 });
const lengthOf = audioLengthOf(D, () => null);
const ids = (clips: readonly StitchAudioClip[]) => clips.map((c) => c.id);
const at = (clips: readonly StitchAudioClip[], id: string) => clips.find((c) => c.id === id)!;

describe("sanitizeAudioClips", () => {
  it("drops bad sources and ids, coerces numbers and renames repeated ids", () => {
    const clips = sanitizeAudioClips([
      { id: "a", source: { kind: "asset", assetId: "../browse-directory?" }, row: 0 },
      { id: "b", source: { kind: "video" } },
      { source: TONE },
      null,
      { id: "t", source: TONE, row: 1.5, startSec: 900, inSec: -1, outSec: -2, muted: "yes", curve: [{ t: 2, gain: 3 }, { t: 1, gain: 0 }] },
      { id: "t", source: { kind: "music" }, row: 0, startSec: Number.NaN, inSec: 2, outSec: 1 },
    ]);
    expect(clips).toEqual([
      { id: "t", source: TONE, row: 0, startSec: 600, inSec: 0, outSec: null, muted: false, curve: [{ t: 1, gain: 0 }, { t: 2, gain: 1 }] },
      { id: "t~2", source: { kind: "music" }, row: 0, startSec: 0, inSec: 2, outSec: null, muted: false, curve: [] },
    ].sort((a, b) => a.startSec - b.startSec));
  });

  it("drops music when it is not allowed, compacts rows and sorts by row, start, id", () => {
    const raw = [
      tone("d", { row: 7 }),
      tone("c", { row: 3, startSec: 4 }),
      tone("b", { row: 3, startSec: 1 }),
      music({ row: 0 }),
    ];
    expect(sanitizeAudioClips(raw).map((c) => [c.id, c.row])).toEqual([
      [MUSIC_CLIP_ID, 0],
      ["b", 1],
      ["c", 1],
      ["d", 2],
    ]);
    expect(sanitizeAudioClips(raw, { allowMusic: false }).map((c) => [c.id, c.row])).toEqual([
      ["b", 0],
      ["c", 0],
      ["d", 1],
    ]);
    expect(sanitizeAudioClips("nope")).toEqual([]);
  });
});

describe("rows", () => {
  it("normalizes without renumbering, and keeps the same array when sorted", () => {
    const clips = [tone("a", { row: 2 }), tone("b", { row: 0 })];
    expect(normalizeAudioClips(clips).map((c) => c.row)).toEqual([0, 2]);
    const sorted = normalizeAudioClips(clips);
    expect(normalizeAudioClips(sorted)).toBe(sorted);
  });

  it("compacts with a row map, and compares compacted forms", () => {
    const clips = [tone("a", { row: 0 }), tone("b", { row: 2 })];
    const { clips: compacted, rowMap } = compactAudioRows(clips);
    expect(compacted.map((c) => c.row)).toEqual([0, 1]);
    expect(rowMap).toEqual([0, null, 1]);
    expect(compactAudioRows(compacted).clips).toBe(compacted);
    expect(sameAudioClips(clips, compacted)).toBe(true);
    expect(audioRowCount(clips)).toBe(3);
    expect(audioRowCount([])).toBe(0);
  });
});

describe("the legacy shape", () => {
  it("is no clips, or one untouched music clip with any curve and mute, on any row", () => {
    expect(isLegacyAudioShape([])).toBe(true);
    expect(isLegacyAudioShape([music({ curve: [{ t: 1, gain: 0.5 }], muted: true })])).toBe(true);
    expect(isLegacyAudioShape(compactAudioRows([music({ row: 1 })]).clips)).toBe(true);
    for (const patch of [{ startSec: 0.01 }, { inSec: 0.5 }, { outSec: 9 }]) {
      expect(isLegacyAudioShape([music(patch)])).toBe(false);
    }
    expect(isLegacyAudioShape([music(), tone("t", { row: 1 })])).toBe(false);
    expect(isLegacyAudioShape([tone("t")])).toBe(false);
    expect(isUntouchedMusic(music({ row: 3 }))).toBe(true);
  });

  it("reads absent audioClips as legacy", () => {
    expect(isLegacyAudio({})).toBe(true);
    expect(isLegacyAudio({ audioClips: [] })).toBe(false);
  });

  it("gives older builds the untouched music clip's curve and mute, else muted", () => {
    const curve = [{ t: 1, gain: 0.5 }];
    expect(legacyCopy([tone("t"), music({ row: 1, curve, muted: true })])).toEqual({ audioCurve: curve, audioMuted: true });
    expect(legacyCopy([music({ startSec: 1, curve })])).toEqual({ audioCurve: [], audioMuted: true });
    expect(legacyCopy([tone("t")])).toEqual({ audioCurve: [], audioMuted: true });
  });

  it("builds the music clip a legacy node reads as", () => {
    expect(legacyMusicClip([{ t: 0, gain: 1 }], true)).toEqual({
      id: MUSIC_CLIP_ID,
      source: { kind: "music" },
      row: 0,
      startSec: 0,
      inSec: 0,
      outSec: null,
      muted: true,
      curve: [{ t: 0, gain: 1 }],
    });
  });
});

describe("the music clip", () => {
  it("is added on row 0 when music is connected and none is stored, the others moved down a row", () => {
    const clips = [tone("t", { row: 0 }), rain("r", { row: 1 })];
    const next = reconcileMusicClip(clips, true);
    expect(next.map((c) => [c.id, c.row])).toEqual([
      [MUSIC_CLIP_ID, 0],
      ["t", 1],
      ["r", 2],
    ]);
    expect(next[0]).toEqual(music());
  });

  it("keeps stored music clips, never drops, and takes another id when audio:music is taken", () => {
    const stored = [music({ startSec: 3 })];
    expect(reconcileMusicClip(stored, true)).toBe(stored);
    expect(reconcileMusicClip(stored, false)).toBe(stored);
    const taken = [tone(MUSIC_CLIP_ID)];
    const next = reconcileMusicClip(taken, true);
    expect(next[0].source).toEqual({ kind: "music" });
    expect(next[0].id).not.toBe(MUSIC_CLIP_ID);
  });

  it("drops every music clip and compacts", () => {
    const clips = [music(), tone("t", { row: 1 })];
    expect(dropMusicClips(clips)).toEqual([tone("t", { row: 0 })]);
    const none = [tone("t")];
    expect(dropMusicClips(none)).toBe(none);
  });
});

describe("lengths and spans", () => {
  it("takes the decoded length, else the record's, else Infinity", () => {
    const byRecord = audioLengthOf(durations({ music: 20 }), (clip) => (clip.source.kind === "asset" && clip.id === "r" ? 4 : null));
    expect(byRecord(music({ inSec: 2 }))).toBe(18);
    expect(byRecord(tone("r", { inSec: 1, outSec: 3 }))).toBe(2);
    expect(byRecord(tone("x"))).toBe(Infinity);
    // Both known: the decoded length wins over the record's
    expect(audioLengthOf(durations({ "asset:atone00000001": 3 }), () => 9)(tone("t"))).toBe(3);
    expect(audioClipLength(tone("x"), undefined)).toBe(0);
  });

  it("counts an Infinity neighbour as overlapping anything after its start", () => {
    const unknown = audioLengthOf(new Map(), () => null);
    const clips = [tone("a", { startSec: 2 })];
    expect(overlapsOnRow(clips, unknown, 0, 500, 1, new Set())).toBe(true);
    expect(overlapsOnRow(clips, unknown, 0, 0, 2, new Set())).toBe(false);
    expect(overlapsOnRow(clips, unknown, 1, 500, 1, new Set())).toBe(false);
    expect(overlapsOnRow(clips, unknown, 0, 500, 1, new Set(["a"]))).toBe(false);
  });

  it("draws unknown lengths as 0, and hears the part inside the loop", () => {
    const spans = audioSpans([tone("t", { startSec: 8.5 }), rain("r", { startSec: 12 }), createAudioClip({ kind: "asset", assetId: "anone00000001" }, { id: "n" })], D);
    expect(spans.map((s) => s.length)).toEqual([3, 5, 0]);
    expect(heardRange(spans[0], 10)).toEqual({ fromSrc: 0, toSrc: 1.5 });
    expect(heardRange(spans[1], 10)).toBeNull();
    expect(heardRange(spans[2], 10)).toBeNull();
    expect(heardRange(audioSpans([music({ inSec: 1, outSec: 4, startSec: 5 })], D)[0], 10)).toEqual({ fromSrc: 1, toSrc: 4 });
  });
});

describe("moveAudioClips", () => {
  const clips = normalizeAudioClips([music(), tone("t", { row: 1, startSec: 2 }), rain("r", { row: 1, startSec: 6 })]);

  it("moves in time and across rows, the group keeping its spacing", () => {
    const { clips: next, newRow, insertedAfter } = moveAudioClips(clips, lengthOf, ["t", "r"], 1.5, 1);
    expect([at(next, "t").startSec, at(next, "t").row, at(next, "r").startSec, at(next, "r").row]).toEqual([3.5, 2, 7.5, 2]);
    expect(newRow).toBe(true);
    // Appended through the strip, not inserted
    expect(insertedAfter).toBeNull();
  });

  it("clamps at 0:00 and 10:00, keeping the spacing", () => {
    const early = moveAudioClips(clips, lengthOf, ["t", "r"], -10, 0).clips;
    expect([at(early, "t").startSec, at(early, "r").startSec]).toEqual([0, 4]);
    const late = moveAudioClips(clips, lengthOf, ["t", "r"], 1000, 0).clips;
    expect([at(late, "t").startSec, at(late, "r").startSec]).toEqual([596, 600]);
  });

  it("puts a move that would overlap onto new rows under the target row, shifting the rows below", () => {
    const three = normalizeAudioClips([...clips, tone("u", { row: 2, startSec: 0 })]);
    // t (2–5) onto row 0 over the music
    const { clips: next, rowMap, newRow, insertedAfter } = moveAudioClips(three, lengthOf, ["t"], 0, -1);
    expect(at(next, "t").row).toBe(1);
    expect(at(next, "r").row).toBe(2);
    expect(at(next, "u").row).toBe(3);
    expect(rowMap).toEqual([0, 2, 3]);
    expect(newRow).toBe(true);
    expect(insertedAfter).toBe(0);
  });

  it("puts a blocked group that reaches the append slot under the last row, with no empty row between", () => {
    const rows = normalizeAudioClips([tone("a"), tone("b", { row: 1, startSec: 10 }), tone("c", { row: 1, startSec: 0 })]);
    const { clips: next, insertedAfter } = moveAudioClips(rows, () => 5, ["a", "b"], 0, 1);
    expect(next.map((c) => [c.id, c.row])).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
    expect(insertedAfter).toBe(1);
  });

  it("keeps a row the move empties, and appends past the last row through the strip", () => {
    const solo = normalizeAudioClips([music(), tone("t", { row: 1, startSec: 2 }), rain("r", { row: 2, startSec: 0 })]);
    const emptied = moveAudioClips(solo, lengthOf, ["t"], 0, 2).clips;
    expect(at(emptied, "t").row).toBe(3);
    expect(emptied.some((c) => c.row === 1)).toBe(false);
    expect(audioRowCount(emptied)).toBe(4);
    // No further than one past the last row
    expect(at(moveAudioClips(solo, lengthOf, ["t"], 0, 9).clips, "t").row).toBe(3);
  });

  it("returns the same array for a move back to where it began", () => {
    expect(moveAudioClips(clips, lengthOf, ["t"], 0, 0).clips).toBe(clips);
    expect(moveAudioClips(clips, lengthOf, ["nope"], 1, 1).clips).toBe(clips);
  });
});

describe("trims", () => {
  const clips = normalizeAudioClips([tone("a", { startSec: 1 }), rain("b", { startSec: 6 })]);

  it("keeps the sound in place on an In trim: the start moves with it", () => {
    const next = trimAudioClip(clips, D, "a", { inSec: 0.5 });
    expect(at(next, "a")).toMatchObject({ inSec: 0.5, startSec: 1.5, outSec: null });
  });

  it("never takes the start before 0:00 or into the previous clip", () => {
    const early = trimAudioClip([tone("a", { startSec: 1, inSec: 2 })], D, "a", { inSec: 0 });
    expect(at(early, "a")).toMatchObject({ inSec: 1, startSec: 0 });
    const behind = normalizeAudioClips([tone("a", { startSec: 0 }), rain("b", { startSec: 4, inSec: 2 })]);
    expect(at(trimAudioClip(behind, D, "b", { inSec: 0 }), "b")).toMatchObject({ inSec: 1, startSec: 3 });
  });

  it("stops the Out at the source's end and at the next clip, keeps 0.1 s, and stores the end as null", () => {
    expect(at(trimAudioClip(clips, D, "a", { outSec: 2 }), "a").outSec).toBe(2);
    expect(at(trimAudioClip(clips, D, "a", { outSec: 0 }), "a").outSec).toBeCloseTo(0.1);
    expect(at(trimAudioClip(clips, D, "a", { outSec: 2.998 }), "a").outSec).toBeNull();
    const tight = normalizeAudioClips([rain("a", { startSec: 0, outSec: 2 }), tone("b", { startSec: 3 })]);
    expect(at(trimAudioClip(tight, D, "a", { outSec: null }), "a").outSec).toBe(3);
    // The next clip leaves room to 5 s: only the 3 s source stops it
    expect(at(trimAudioClip(clips, D, "a", { outSec: 4.5 }), "a").outSec).toBeNull();
  });

  it("stops the In 0.1 s before the Out", () => {
    expect(at(trimAudioClip(clips, D, "a", { inSec: 2.95 }), "a").inSec).toBeCloseTo(2.9, 12);
  });

  it("does nothing while the length is unknown, and resets to the whole file", () => {
    expect(trimAudioClip(clips, new Map(), "a", { inSec: 1 })).toBe(clips);
    const trimmed = normalizeAudioClips([tone("a", { startSec: 2, inSec: 1, outSec: 2 })]);
    expect(at(resetAudioTrim(trimmed, D, "a"), "a")).toMatchObject({ inSec: 0, outSec: null, startSec: 1 });
  });
});

describe("splitAudioClipAt", () => {
  const curve = [{ t: 0, gain: 0 }, { t: 1, gain: 1 }, { t: 2.5, gain: 0.2 }];
  const clips = [music({ startSec: 2.0123, inSec: 0.5, outSec: 9, curve })];

  it("cuts one clip into two on its row, both keeping the whole curve", () => {
    const result = splitAudioClipAt(clips, D, MUSIC_CLIP_ID, 4.37, "right")!;
    const [left, right] = result.clips;
    expect(result.rightId).toBe("right");
    expect(left).toMatchObject({ id: MUSIC_CLIP_ID, inSec: 0.5, startSec: 2.0123, row: 0 });
    expect(right).toMatchObject({ id: "right", outSec: 9, startSec: 4.37, row: 0 });
    expect(left.outSec).toBeCloseTo(0.5 + 4.37 - 2.0123, 12);
    expect(right.inSec).toBe(left.outSec);
    expect(left.curve).toEqual(curve);
    expect(right.curve).toEqual(curve);
    expect(right.startSec - right.inSec).toBeCloseTo(left.startSec - left.inSec, 12);
  });

  it("keeps start − In exact for round numbers", () => {
    const [left, right] = splitAudioClipAt([tone("a", { startSec: 2, inSec: 0.5 })], D, "a", 3, "b")!.clips;
    expect(right.startSec - right.inSec).toBe(left.startSec - left.inSec);
  });

  it("refuses within 0.1 s of an end, outside the clip, and without a length", () => {
    expect(splitAudioClipAt(clips, D, MUSIC_CLIP_ID, 2.05)).toBeNull();
    expect(splitAudioClipAt(clips, D, MUSIC_CLIP_ID, 2.0123 + 8.45)).toBeNull();
    expect(splitAudioClipAt(clips, D, MUSIC_CLIP_ID, 20)).toBeNull();
    expect(splitAudioClipAt([tone("a")], new Map(), "a", 1)).toBeNull();
  });
});

describe("remove, mute, curve", () => {
  it("removes and compacts, with the row map", () => {
    const clips = normalizeAudioClips([music(), tone("t", { row: 1 }), rain("r", { row: 2 })]);
    const { clips: next, rowMap } = removeAudioClips(clips, new Set(["t"]));
    expect(next.map((c) => [c.id, c.row])).toEqual([
      [MUSIC_CLIP_ID, 0],
      ["r", 1],
    ]);
    expect(rowMap).toEqual([0, null, 1]);
    expect(removeAudioClips(clips, new Set(["x"])).clips).toBe(clips);
  });

  it("mutes and sets curves, the same array when nothing changes", () => {
    const clips = [music(), tone("t", { row: 1, muted: true })];
    expect(setAudioClipsMuted(clips, new Set(["t"]), true)).toBe(clips);
    expect(setAudioClipsMuted(clips, new Set([MUSIC_CLIP_ID, "t"]), true).every((c) => c.muted)).toBe(true);
    expect(setAudioClipCurve(clips, "t", [])).toBe(clips);
    expect(at(setAudioClipCurve(clips, "t", [{ t: 2, gain: 0.5 }, { t: 1, gain: 1 }]), "t").curve).toEqual([
      { t: 1, gain: 1 },
      { t: 2, gain: 0.5 },
    ]);
  });
});

describe("add, copy, paste, duplicate", () => {
  const clips = normalizeAudioClips([music(), tone("t", { row: 1, startSec: 2 })]);

  it("adds each source on a new row at the bottom, at the playhead, or all on a given row", () => {
    const { clips: next, ids: added } = addAudioAt(clips, [TONE, RAIN], 4.2);
    expect(added).toHaveLength(2);
    expect(added.map((id) => [at(next, id).row, at(next, id).startSec])).toEqual([
      [2, 4.2],
      [3, 4.2],
    ]);
    const onRow = addAudioAt(clips, [RAIN], -3, { row: 1 });
    expect(at(onRow.clips, onRow.ids[0])).toMatchObject({ row: 1, startSec: 0 });
  });

  it("copies with offsets from the earliest start and the top row", () => {
    const items = copyAudioItems(clips, ["t", MUSIC_CLIP_ID]);
    expect(items.map((i) => [i.offsetSec, i.rowOffset, i.track])).toEqual([
      [0, 0, "audio"],
      [2, 1, "audio"],
    ]);
    expect(copyAudioItems(clips, [])).toEqual([]);
  });

  it("pastes on new rows under the last, the first at the playhead, the spacing kept", () => {
    const items = copyAudioItems(clips, [MUSIC_CLIP_ID, "t"]);
    const { clips: next, ids: pasted } = pasteAudioClips(clips, items, 5);
    expect(pasted.map((id) => [at(next, id).row, at(next, id).startSec])).toEqual([
      [2, 5],
      [3, 7],
    ]);
    expect(at(next, pasted[1]).source).toEqual(TONE);
  });

  it("duplicates on the same rows from the latest end when every copy fits", () => {
    const pair = normalizeAudioClips([tone("a", { startSec: 0 }), rain("b", { row: 1, startSec: 1 })]);
    const { clips: next, ids: copies, rowMap } = duplicateAudioClips(pair, lengthOf, ["a", "b"]);
    // latest end: b at 1 + 5 = 6
    expect(copies.map((id) => [at(next, id).row, at(next, id).startSec])).toEqual([
      [0, 6],
      [1, 7],
    ]);
    expect(rowMap).toEqual([0, 1]);
  });

  it("duplicates onto new rows under the lowest selected row when one copy would overlap or has no known length", () => {
    const blocked = normalizeAudioClips([tone("a", { startSec: 0 }), rain("b", { startSec: 3 }), tone("c", { row: 1 })]);
    const result = duplicateAudioClips(blocked, lengthOf, ["a"]);
    expect(at(result.clips, result.ids[0])).toMatchObject({ row: 1, startSec: 3 });
    expect(at(result.clips, "c").row).toBe(2);
    expect(result.rowMap).toEqual([0, 2]);

    const unknown = audioLengthOf(new Map(), () => null);
    const lone = [tone("a", { startSec: 2 })];
    const copy = duplicateAudioClips(lone, unknown, ["a"]);
    expect(at(copy.clips, copy.ids[0]).row).toBe(1);
  });

  it("never puts a copy at its original's time", () => {
    const one = [tone("a", { startSec: 2 })];
    const { clips: next, ids: copies } = duplicateAudioClips(one, lengthOf, ["a"]);
    expect(at(next, copies[0]).startSec).toBe(5);
  });
});

describe("fades", () => {
  const curve = [{ t: 0.5, gain: 0.3 }, { t: 3, gain: 0.5 }];

  it("equals fadeIn and fadeOut over the sequence on the legacy music clip", () => {
    const clip = legacyMusicClip(curve, false);
    const span = audioSpans([clip], D)[0];
    expect(audioFadeIn(clip, span, 10)).toEqual(fadeIn(curve, 10));
    expect(audioFadeOut(clip, span, 10)).toEqual(fadeOut(curve, 10));
  });

  it("sits at In and at the heard end on a trimmed clip, in source seconds", () => {
    const clip = music({ inSec: 1, outSec: 4, startSec: 5, curve: [] });
    const span = audioSpans([clip], D)[0];
    expect(audioFadeIn(clip, span, 10)).toEqual([{ t: 1, gain: 0 }, { t: 2, gain: 1 }]);
    expect(audioFadeOut(clip, span, 10)).toEqual([{ t: 3, gain: 1 }, { t: 4, gain: 0 }]);
    // Cut by the loop's end at 7: heard 1..3
    expect(audioFadeOut(clip, span, 7)).toEqual([{ t: 2, gain: 1 }, { t: 3, gain: 0 }]);
  });

  it("fades the music's own end when it is shorter than the sequence", () => {
    const clip = music();
    const span = audioSpans([clip], durations({ music: 6 }))[0];
    expect(audioFadeOut(clip, span, 10)).toEqual([{ t: 5, gain: 1 }, { t: 6, gain: 0 }]);
  });

  it("fades in without a length, and leaves Fade out until the length is known", () => {
    const clip = tone("x", { startSec: 2, inSec: 1 });
    const span = audioSpans([clip], new Map())[0];
    expect(audioFadeIn(clip, span, 10)).toEqual([{ t: 1, gain: 0 }, { t: 2, gain: 1 }]);
    expect(audioFadeOut(clip, span, 10)).toEqual([]);
  });

  it("reads the curve's shapes over the part that is heard", () => {
    // The 3 s tone at 2 s, under a 10 s loop
    const shape = (clip: StitchAudioClip, loop = 10) => audioCurveShape(clip, audioSpans([clip], D)[0], loop);
    const plain = tone("t", { startSec: 2 });
    expect(shape(plain)).toEqual({ flat: true, fadeIn: false, fadeOut: false });
    const span = audioSpans([plain], D)[0];
    const faded = { ...plain, curve: audioFadeOut(plain, span, 10) };
    const both = { ...faded, curve: audioFadeIn(faded, audioSpans([faded], D)[0], 10) };
    expect(shape(both)).toEqual({ flat: false, fadeIn: true, fadeOut: true });
    // A drawn curve that starts from silence reads as a fade in
    expect(shape({ ...plain, curve: [{ t: 0, gain: 0 }, { t: 2, gain: 0.5 }] })).toEqual({ flat: false, fadeIn: true, fadeOut: false });
  });

  it("does not count a fade a split or a trim has cut away", () => {
    const plain = tone("t", { startSec: 2 });
    const inOnly = { ...plain, curve: audioFadeIn(plain, audioSpans([plain], D)[0], 10) };
    const shape = (clip: StitchAudioClip, loop = 10) => audioCurveShape(clip, audioSpans([clip], D)[0], loop);
    // Split 1.5 s in (past the 1 s ramp): both pieces keep the curve, but only the left one starts from silence
    const split = splitAudioClipAt([inOnly], D, "t", 3.5, "r")!;
    expect(shape(at(split.clips, "t")).fadeIn).toBe(true);
    expect(shape(at(split.clips, "r"))).toEqual({ flat: false, fadeIn: false, fadeOut: false });
    // In trimmed past the ramp: heard from 1.2 s, at full volume
    const trimmedIn = trimAudioClip([inOnly], D, "t", { inSec: 1.2 });
    expect(shape(at(trimmedIn, "t")).fadeIn).toBe(false);
    // A fade out, then Out trimmed earlier: the heard part ends before the silence
    const outOnly = { ...plain, curve: audioFadeOut(plain, audioSpans([plain], D)[0], 10) };
    expect(shape(outOnly).fadeOut).toBe(true);
    const trimmedOut = trimAudioClip([outOnly], D, "t", { outSec: 2.5 });
    expect(shape(at(trimmedOut, "t")).fadeOut).toBe(false);
    // The loop ending inside the clip cuts the heard part short too
    expect(shape(outOnly, 4).fadeOut).toBe(false);
    // Out trimmed back to the end: heard again
    expect(shape(at(trimAudioClip(trimmedOut, D, "t", { outSec: null }), "t")).fadeOut).toBe(true);
  });

  it("follows the end with followEndFade on the legacy music clip, and leaves a clip that starts after the old end", () => {
    const faded = fadeOut([], 10);
    const clips = [legacyMusicClip(faded, false), tone("late", { row: 1, startSec: 11, curve: fadeOut([], 3) })];
    const next = followEndFades(clips, 10, 12);
    expect(next[0].curve).toEqual(followEndFade(faded, 10, 12));
    expect(next[1]).toBe(clips[1]);
    expect(followEndFades(clips, 10, 10)).toBe(clips);
  });

  it("follows the end in a moved clip's own clock", () => {
    // Starts at 4 with In 1: the sequence end 10 is source 7
    const clip = music({ startSec: 4, inSec: 1, curve: [{ t: 6, gain: 1 }, { t: 7, gain: 0 }] });
    expect(followEndFades([clip], 10, 8)[0].curve).toEqual([{ t: 4, gain: 1 }, { t: 5, gain: 0 }]);
  });
});

describe("describeAudioChanges", () => {
  const initial = normalizeAudioClips([music(), tone("t", { row: 1, startSec: 2 }), rain("r", { row: 2, startSec: 0 })]);

  it("names each kind of change", () => {
    const cases: Array<[StitchAudioClip[], string[], Map<string, "pasted" | "duplicated" | "cut">?]> = [
      [[...initial, createAudioClip({ kind: "asset", assetId: "anew000000001" }, { id: "n", row: 3 })], ["an added audio clip"]],
      [[...initial, tone("p", { row: 3 })], ["a pasted audio clip"], new Map([["p", "pasted" as const]])],
      [[...initial, tone("d", { row: 3 })], ["a duplicated audio clip"], new Map([["d", "duplicated" as const]])],
      [initial.filter((c) => c.id !== "r"), ["a removed audio clip"]],
      [initial.filter((c) => c.id !== "r"), ["a cut audio clip"], new Map([["r", "cut" as const]])],
      [initial.map((c) => (c.id === "t" ? { ...c, startSec: 3 } : c)), ["a moved audio clip"]],
      [initial.map((c) => (c.id === "t" ? { ...c, row: 2 } : c)), ["a moved audio clip"]],
      [initial.map((c) => (c.id === "t" ? { ...c, inSec: 0.5, startSec: 2.5 } : c)), ["a trimmed audio clip"]],
      [splitAudioClipAt(initial, D, "t", 3, "t2")!.clips, ["an audio split"]],
      [initial.map((c) => (c.id === "t" ? { ...c, muted: true } : c)), ["a muted audio clip"]],
      [initial.map((c) => (c.id === "t" ? { ...c, curve: [{ t: 0, gain: 0.5 }] } : c)), ["the volume curve"]],
      [initial.map((c) => ({ ...c, curve: [{ t: 0, gain: 0.5 }] })).slice(0, 2), ["a removed audio clip", "two volume curves"]],
      [initial.map((c) => (c.id === MUSIC_CLIP_ID ? c : { ...c, startSec: c.startSec + 1 })), ["two moved audio clips"]],
    ];
    for (const [draft, parts, origins] of cases) {
      expect(describeAudioChanges(initial, draft, origins)).toEqual(parts);
    }
  });

  it("names an unmuted clip, and sees nothing in a row closed up by a removal", () => {
    const muted = initial.map((c) => (c.id === "t" ? { ...c, muted: true } : c));
    expect(describeAudioChanges(muted, initial)).toEqual(["an unmuted audio clip"]);
    const closed = removeAudioClips(initial, new Set(["t"])).clips;
    expect(describeAudioChanges(initial, closed)).toEqual(["a removed audio clip"]);
    expect(describeAudioChanges(initial, initial)).toEqual([]);
  });
});

it("keys sources as the waveform cache and the durations do", () => {
  expect(audioSourceKey({ kind: "music" })).toBe("music");
  expect(audioSourceKey(TONE)).toBe("asset:atone00000001");
  expect(ids([tone("a")])).toEqual(["a"]);
});
