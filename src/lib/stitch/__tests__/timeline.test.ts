import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import { planSequence } from "../sequencePlan";
import {
  END_EPSILON_SEC,
  MIN_CLIP_SEC,
  appendClips,
  canSplitClipsAt,
  clampTrim,
  clearStarts,
  clipAtTime,
  clipLength,
  clipSpans,
  createClip,
  edgeIdsInOrder,
  inOverlap,
  isPlaced,
  layersAt,
  layoutSpans,
  MAX_START_SEC,
  moveClip,
  moveClipsBlock,
  moveClipStart,
  neighbourTarget,
  originalEdgeTarget,
  pinStarts,
  placeClip,
  placeClips,
  placedLayersAt,
  placedSpans,
  reanchorTime,
  removeClip,
  removeClips,
  resetTrim,
  resetTrimInPlace,
  resetTrims,
  runEndIndex,
  sequenceDuration,
  setEdgeAtPlayhead,
  shiftRows,
  snapTo,
  sourceKey,
  spanAtTime,
  spansAt,
  spansEnd,
  spansEnvelope,
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
} from "../timeline";

const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const assetClip = (id: string, assetId: string) => createClip({ kind: "asset", assetId }, { id });

function durations(entries: Record<string, number>): SourceDurations {
  return new Map(Object.entries(entries) as [SourceKey, number][]);
}

// Three clips of 5, 4 and 6 seconds: spans 0–5, 5–9, 9–15.
const three = () => [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
const threeDurations = durations({ "edge:e1": 5, "edge:e2": 4, "edge:e3": 6 });

describe("sourceKey and createClip", () => {
  it("keys edge and asset sources apart", () => {
    expect(sourceKey({ kind: "edge", edgeId: "e1" })).toBe("edge:e1");
    expect(sourceKey({ kind: "asset", assetId: "x" })).toBe("asset:x");
  });

  it("defaults to the whole source, unmuted, at full volume, with a generated id", () => {
    const clip = createClip({ kind: "edge", edgeId: "e1" });
    expect(clip).toMatchObject({ inSec: 0, outSec: null, muted: false, volume: 1 });
    expect(clip.id).toMatch(/^clip_[0-9a-f]{8}$/);
  });
});

describe("clipLength", () => {
  it("is 0 while the source duration is unknown", () => {
    expect(clipLength(edgeClip("a", "e1"), undefined)).toBe(0);
  });

  it("runs to the source's end when out is null", () => {
    expect(clipLength(edgeClip("a", "e1", { inSec: 1 }), 5)).toBe(4);
  });

  it("clamps an out past the source's end", () => {
    expect(clipLength(edgeClip("a", "e1", { inSec: 1, outSec: 9 }), 5)).toBe(4);
  });

  it("is 0 when in is past the source's end", () => {
    expect(clipLength(edgeClip("a", "e1", { inSec: 7 }), 5)).toBe(0);
  });

  it("is 0 under one output frame, as the encode drops such a clip, and keeps a clip of exactly one frame", () => {
    const shortened = edgeClip("a", "e1", { inSec: 4.99 });
    expect(clipLength(shortened, 5)).toBe(0);
    expect(planSequence([{ inSec: 4.99, outSec: null, sourceDuration: 5 }]).clips).toEqual([]);
    expect(clipLength(edgeClip("b", "e2"), 1 / 60)).toBe(1 / 60);
    expect(planSequence([{ inSec: 0, outSec: null, sourceDuration: 1 / 60 }]).clips).toHaveLength(1);
  });
});

describe("sequenceDuration and clipSpans", () => {
  it("sums the trimmed lengths", () => {
    const timeline = [edgeClip("a", "e1", { inSec: 1 }), edgeClip("b", "e2", { outSec: 2 }), edgeClip("c", "e3")];
    expect(sequenceDuration(timeline, threeDurations, 0)).toBe(4 + 2 + 6);
  });

  it("keeps zero-length spans in place", () => {
    const spans = clipSpans([edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, 0);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 5], [5, 5], [5, 11]]);
  });
});

describe("spanAtTime", () => {
  it("reads precomputed spans the way clipAtTime reads a timeline", () => {
    const spans = clipSpans(three(), threeDurations, 0);
    for (const t of [-1, 0, 4.99, 5, 9.5, 15, 99]) {
      expect(spanAtTime(spans, t)?.clip.id).toBe(clipAtTime(three(), threeDurations, t, 0)?.clip.id);
    }
    expect(spanAtTime(clipSpans([edgeClip("x", "missing")], threeDurations, 0), 0)).toBeNull();
  });
});

describe("clipAtTime", () => {
  it("returns the next clip at a boundary", () => {
    expect(clipAtTime(three(), threeDurations, 5, 0)?.clip.id).toBe("b");
  });

  it("skips zero-length spans", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")];
    expect(clipAtTime(timeline, threeDurations, 5, 0)?.clip.id).toBe("c");
  });

  it("gives the last clip at or past the end and the first before the start", () => {
    expect(clipAtTime(three(), threeDurations, 15, 0)?.clip.id).toBe("c");
    expect(clipAtTime(three(), threeDurations, 99, 0)?.clip.id).toBe("c");
    // An empty span at either end (a source not generated yet) is never the answer
    expect(clipAtTime([edgeClip("a", "e1"), edgeClip("x", "missing")], threeDurations, 99, 0)?.clip.id).toBe("a");
    expect(clipAtTime([edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, -1, 0)?.clip.id).toBe("c");
    expect(clipAtTime(three(), threeDurations, -1, 0)?.clip.id).toBe("a");
  });

  it("is null for an empty timeline or one with only empty clips", () => {
    expect(clipAtTime([], threeDurations, 0, 0)).toBeNull();
    expect(clipAtTime([edgeClip("x", "missing")], threeDurations, 0, 0)).toBeNull();
  });
});

describe("clampTrim", () => {
  const clip = edgeClip("a", "e1");

  it("keeps In at least MIN before Out", () => {
    expect(clampTrim({ ...clip, outSec: 3 }, 5, { inSec: 4 })).toEqual({ inSec: 3 - MIN_CLIP_SEC, outSec: 3 });
  });

  it("keeps Out at least MIN after In and within the source", () => {
    expect(clampTrim({ ...clip, inSec: 2 }, 5, { outSec: 1 })).toEqual({ inSec: 2, outSec: 2 + MIN_CLIP_SEC });
    expect(clampTrim(clip, 5, { outSec: 7 })).toEqual({ inSec: 0, outSec: null });
  });

  it("stores an Out within EPS of the end as null", () => {
    expect(clampTrim(clip, 5, { outSec: 5 - END_EPSILON_SEC / 2 })).toEqual({ inSec: 0, outSec: null });
    expect(clampTrim(clip, 5, { outSec: 4.9 })).toEqual({ inSec: 0, outSec: 4.9 });
  });

  it("treats outSec null as the end and clamps a negative In", () => {
    expect(clampTrim({ ...clip, outSec: 3 }, 5, { outSec: null })).toEqual({ inSec: 0, outSec: null });
    expect(clampTrim(clip, 5, { inSec: -2 })).toEqual({ inSec: 0, outSec: null });
  });

  it("works without a known duration", () => {
    expect(clampTrim(clip, undefined, { inSec: 3 })).toEqual({ inSec: 3, outSec: null });
    expect(clampTrim({ ...clip, inSec: 2 }, undefined, { outSec: 1 })).toEqual({ inSec: 2, outSec: 2 + MIN_CLIP_SEC });
    expect(clampTrim({ ...clip, outSec: 2 }, undefined, { inSec: 5 })).toEqual({ inSec: 2 - MIN_CLIP_SEC, outSec: 2 });
  });

  it("gives the whole source when it is shorter than MIN", () => {
    expect(clampTrim({ ...clip, inSec: 0.02 }, MIN_CLIP_SEC / 2, { outSec: 0.03 })).toEqual({ inSec: 0, outSec: null });
  });
});

describe("timeline operations", () => {
  it("trimClip clamps and returns the same reference when nothing changes", () => {
    const timeline = three();
    const trimmed = trimClip(timeline, "b", threeDurations, { inSec: 1 });
    expect(trimmed).not.toBe(timeline);
    expect(trimmed[1]).toMatchObject({ inSec: 1, outSec: null });
    expect(trimClip(timeline, "b", threeDurations, { inSec: 0 })).toBe(timeline);
    expect(trimClip(timeline, "nope", threeDurations, { inSec: 1 })).toBe(timeline);
  });

  it("resetTrim clears In and Out", () => {
    const timeline = [edgeClip("a", "e1", { inSec: 1, outSec: 3 })];
    expect(resetTrim(timeline, "a")[0]).toMatchObject({ inSec: 0, outSec: null });
    const untouched = three();
    expect(resetTrim(untouched, "a")).toBe(untouched);
  });

  it("updateClipAudio sets mute and clamps volume", () => {
    const timeline = three();
    expect(updateClipAudio(timeline, "a", { muted: true, volume: 3 })[0]).toMatchObject({ muted: true, volume: 1 });
    expect(updateClipAudio(timeline, "a", { volume: -1 })[0].volume).toBe(0);
    expect(updateClipAudio(timeline, "a", { muted: false, volume: 1 })).toBe(timeline);
  });

  it("moveClip puts the clip at its final index", () => {
    const timeline = three();
    expect(moveClip(timeline, 0, 2).map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(moveClip(timeline, 2, 0).map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(moveClip(timeline, 1, 1)).toBe(timeline);
    expect(moveClip(timeline, 5, 0)).toBe(timeline);
    // Pointer maths on a zero-width lane gives NaN; nothing moves.
    expect(moveClip(timeline, 1, NaN)).toBe(timeline);
    expect(moveClip(timeline, NaN, 0)).toBe(timeline);
    expect(moveClip(timeline, 0, Infinity)).toBe(timeline);
  });

  it("removeClip reports an orphaned edge only when no piece of it is left", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("a2", "e1"), edgeClip("b", "e2"), assetClip("x", "asset1")];
    const first = removeClip(timeline, "a");
    expect(first.timeline.map((c) => c.id)).toEqual(["a2", "b", "x"]);
    expect(first.orphanedEdgeId).toBeNull();
    expect(removeClip(first.timeline, "a2").orphanedEdgeId).toBe("e1");
    expect(removeClip(timeline, "x").orphanedEdgeId).toBeNull();
    expect(removeClip(timeline, "nope").timeline).toBe(timeline);
  });

  it("appendClips adds at the end", () => {
    const timeline = three();
    expect(appendClips(timeline, [assetClip("x", "asset1")]).map((c) => c.id)).toEqual(["a", "b", "c", "x"]);
    expect(appendClips(timeline, [])).toBe(timeline);
  });

  it("edgeIdsInOrder lists each edge once, by first appearance", () => {
    const timeline = [edgeClip("b", "e2"), assetClip("x", "asset1"), edgeClip("a", "e1"), edgeClip("b2", "e2")];
    expect(edgeIdsInOrder(timeline)).toEqual(["e2", "e1"]);
  });
});

describe("splitClipAt", () => {
  it("cuts the clip under t into two pieces", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("b", "e2", { inSec: 0.5, outSec: 3.5, muted: true, volume: 0.4 })];
    const result = splitClipAt(timeline, threeDurations, 6, () => "new");
    expect(result).not.toBeNull();
    expect(result!.leftId).toBe("b");
    expect(result!.rightId).toBe("new");
    expect(result!.timeline.map((c) => c.id)).toEqual(["a", "b", "new"]);
    expect(result!.timeline[1]).toMatchObject({ inSec: 0.5, outSec: 1.5, muted: true, volume: 0.4 });
    expect(result!.timeline[2]).toMatchObject({ inSec: 1.5, outSec: 3.5, muted: true, volume: 0.4 });
  });

  it("keeps null as the right piece's Out", () => {
    const result = splitClipAt(three(), threeDurations, 2, () => "new");
    expect(result!.timeline[1]).toMatchObject({ id: "new", inSec: 2, outSec: null });
  });

  it("refuses within MIN of an edge and in an empty timeline", () => {
    expect(splitClipAt(three(), threeDurations, 5 + MIN_CLIP_SEC / 2)).toBeNull();
    expect(splitClipAt(three(), threeDurations, 5 - MIN_CLIP_SEC / 2)).toBeNull();
    expect(splitClipAt([edgeClip("x", "missing")], threeDurations, 0)).toBeNull();
  });

  it("refuses a time that is not finite", () => {
    expect(splitClipAt(three(), threeDurations, NaN)).toBeNull();
    expect(splitClipAt(three(), threeDurations, Infinity)).toBeNull();
  });
});

describe("setEdgeAtPlayhead", () => {
  it("sets In or Out to the source time under the playhead", () => {
    const timeline = three();
    const withIn = setEdgeAtPlayhead(timeline, threeDurations, "b", "in", 6, 0);
    expect(withIn).not.toBe(timeline);
    expect(withIn![1]).toMatchObject({ inSec: 1, outSec: null });
    const withOut = setEdgeAtPlayhead(timeline, threeDurations, "b", "out", 7, 0);
    expect(withOut![1]).toMatchObject({ inSec: 0, outSec: 2 });
  });

  it("is null when the playhead is outside the clip", () => {
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 12, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "missing", "in", 6, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", NaN, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", Infinity, 0)).toBeNull();
  });

  it("is null for Out at the clip's start and In at its end", () => {
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", 5, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 9, 0)).toBeNull();
    // The near boundary still counts
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", 9, 0)![1]).toMatchObject({ inSec: 0 });
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 5, 0)![1]).toMatchObject({ inSec: 0 });
  });
});

describe("snapTo", () => {
  const playhead = { t: 4, kind: "playhead" as const, label: "the playhead" };
  const edge = { t: 5, kind: "edge" as const, label: "Clip 2" };

  it("snaps inside the threshold, inclusively", () => {
    expect(snapTo(4.1, [playhead], 0.1)).toEqual({ value: 4, target: playhead });
    // Exactly at the threshold (0.5 is exact in floating point)
    expect(snapTo(4.5, [playhead], 0.5)).toEqual({ value: 4, target: playhead });
  });

  it("leaves the value alone outside it", () => {
    expect(snapTo(4.3, [playhead], 0.1)).toEqual({ value: 4.3, target: null });
  });

  it("picks the nearest of two", () => {
    expect(snapTo(4.8, [playhead, edge], 1).target).toBe(edge);
  });

  it("gives a tie to the playhead", () => {
    expect(snapTo(4.5, [edge, playhead], 1).target).toBe(playhead);
  });
});

describe("neighbourTarget", () => {
  it("gives the next clip's start for an Out and the previous clip's end for an In", () => {
    const spans = clipSpans(three(), threeDurations, 0);
    expect(neighbourTarget(spans, "a", "out")).toEqual({ t: 5, kind: "edge", label: "Clip 2" });
    expect(neighbourTarget(spans, "c", "in")).toEqual({ t: 9, kind: "edge", label: "Clip 2" });
  });

  it("is null at the sequence's ends", () => {
    const spans = clipSpans(three(), threeDurations, 0);
    expect(neighbourTarget(spans, "c", "out")).toBeNull();
    expect(neighbourTarget(spans, "a", "in")).toBeNull();
  });

  it("skips empty clips", () => {
    const spans = clipSpans([edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, 0);
    expect(neighbourTarget(spans, "a", "out")).toEqual({ t: 5, kind: "edge", label: "Clip 3" });
    expect(neighbourTarget(spans, "c", "in")).toEqual({ t: 5, kind: "edge", label: "Clip 1" });
  });
});

describe("Stacked: overlapped spans", () => {
  // Clips of 5, 5 and 6 s at a 1 s overlap: 0–5, 4–9, 8–14
  const stackDurations = durations({ "edge:e1": 5, "edge:e2": 5, "edge:e3": 6 });
  const stacked = () => clipSpans(three(), stackDurations, 1);
  const butted = () => clipSpans(three(), stackDurations, 0);
  const ids = (spans: readonly ClipSpan[]) => spans.map((s) => s.clip.id);

  it("starts each clip the overlap before the previous one ends", () => {
    const spans = stacked();
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [4, 9],
      [8, 14],
    ]);
    expect(spans.map((s) => [s.overlapIn, s.overlapOut])).toEqual([
      [0, 1],
      [1, 1],
      [1, 0],
    ]);
    expect(sequenceDuration(three(), stackDurations, 1)).toBe(14);
    expect(sequenceDuration([], stackDurations, 1)).toBe(0);
  });

  it("overlaps the clips either side of an empty one", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("b", "e2")];
    const spans = clipSpans(timeline, stackDurations, 1);
    expect(spans.map((s) => [s.start, s.end, s.overlapIn, s.overlapOut])).toEqual([
      [0, 5, 0, 1],
      [5, 5, 0, 0],
      [4, 9, 1, 0],
    ]);
  });

  it("gives today's spans with no overlap, and for a call without one", () => {
    const twoArgs = clipSpans as unknown as (t: StitchTimelineClip[], d: SourceDurations) => ClipSpan[];
    expect(twoArgs(three(), threeDurations)).toEqual(clipSpans(three(), threeDurations, 0));
    expect(butted().map((s) => [s.start, s.end, s.overlapIn, s.overlapOut])).toEqual([
      [0, 5, 0, 0],
      [5, 10, 0, 0],
      [10, 16, 0, 0],
    ]);
  });

  it("finds the clips at an instant, earlier first, and the one the editor means", () => {
    const spans = stacked();
    expect(ids(spansAt(spans, 4.5))).toEqual(["a", "b"]);
    expect(ids(spansAt(spans, 3))).toEqual(["a"]);
    expect(spansAt(spans, 14)).toEqual([]);
    expect(topSpanAt(spans, 4.5)?.clip.id).toBe("a");
    expect(topSpanAt(spans, 4.5, "b")?.clip.id).toBe("b");
    expect(topSpanAt(spans, 4.5, "c")?.clip.id).toBe("a");
    expect(topSpanAt(spans, 6, "a")?.clip.id).toBe("b");
    expect(topSpanAt(spans, 99)?.clip.id).toBe("c");
    expect(inOverlap(spans, 4.5)).toBe(true);
    expect(inOverlap(spans, 6)).toBe(false);
    expect(clipAtTime(three(), stackDurations, 4.5, 1, "b")?.clip.id).toBe("b");
    expect(clipAtTime(three(), stackDurations, 4.5, 1)?.clip.id).toBe("a");
  });

  it("layers the preview", () => {
    const one = layersAt(butted(), 6, true);
    expect(one.map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([["b", 1, 1]]);

    const p = 0.25;
    const fade = layersAt(stacked(), 4 + p, true);
    expect(fade.map((l) => l.span.clip.id)).toEqual(["a", "b"]);
    expect(fade[0].opacity).toBe(1);
    expect(fade[0].gain).toBeCloseTo(Math.cos((p * Math.PI) / 2), 12);
    expect(fade[1].opacity).toBeCloseTo(p, 12);
    expect(fade[1].gain).toBeCloseTo(Math.sin((p * Math.PI) / 2), 12);

    const cut = layersAt(stacked(), 4 + p, false);
    expect(cut.map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([
      ["a", 1, 1],
      ["b", 0, 1],
    ]);

    expect(layersAt(clipSpans([edgeClip("x", "missing")], stackDurations, 1), 0, true)).toEqual([]);
  });

  it("re-anchors a time on the same clip and frame", () => {
    expect(reanchorTime(butted(), stacked(), 6)).toBe(5);
    expect(reanchorTime(stacked(), butted(), 5)).toBe(6);
    expect(reanchorTime(butted(), stacked(), 16)).toBe(14);
    expect(reanchorTime(butted(), stacked(), 99)).toBe(14);
    expect(reanchorTime(stacked(), butted(), 4.5)).toBe(4.5);
    expect(reanchorTime(stacked(), butted(), 4.5, "b")).toBe(5.5);
  });

  it("splits only outside an overlap, and moves nothing", () => {
    const opts = { overlapSec: 1 };
    expect(splitClipAt(three(), stackDurations, 4.5, () => "new", opts)).toBeNull();
    expect(splitClipAt(three(), stackDurations, 4.5, () => "new", { ...opts, preferClipId: "b" })).toBeNull();
    expect(splitClipAt(three(), stackDurations, 5 + MIN_CLIP_SEC / 2, () => "new", opts)).toBeNull();
    expect(splitClipAt(three(), stackDurations, 8 - MIN_CLIP_SEC / 2, () => "new", opts)).toBeNull();

    const result = splitClipAt(three(), stackDurations, 6, () => "new", { ...opts, preferClipId: "a" });
    expect(result!.leftId).toBe("b");
    expect(result!.timeline[1]).toMatchObject({ id: "b", inSec: 0, outSec: 2 });
    expect(result!.timeline[2]).toMatchObject({ id: "new", inSec: 2, outSec: null });
    const after = clipSpans(result!.timeline, stackDurations, 1);
    expect(after.map((s) => s.start)).toEqual([0, 4, 6, 8]);
    expect(sequenceDuration(result!.timeline, stackDurations, 1)).toBe(14);
  });

  it("sets an edge at a playhead inside the clip's overlapped span", () => {
    expect(setEdgeAtPlayhead(three(), stackDurations, "b", "in", 4.5, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), stackDurations, "b", "in", 4.5, 1)![1]).toMatchObject({ inSec: 0.5 });
  });

  it("offers the dragged edge's own start as a snap target", () => {
    const b = stacked()[1];
    expect(originalEdgeTarget(b, "out")).toEqual({ t: 9, kind: "edge", label: "the original length" });
    expect(originalEdgeTarget(b, "in")).toEqual({ t: 4, kind: "edge", label: "the original length" });
  });
});

describe("Stacked: placed clips", () => {
  // A 5 s, B 5 s, C 6 s; lined up at Overlap 1: 0–5, 4–9, 8–14
  const d = durations({ "edge:e1": 5, "edge:e2": 5, "edge:e3": 6 });
  const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
  const TRACK = { ...STACKED, mode: "track" as const };
  const lined = () => [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
  const starts = (spans: readonly ClipSpan[]) => spans.map((s) => s.start);

  it("lays out Track, lined-up and placed stacks", () => {
    const placed = [edgeClip("a", "e1", { startSec: 2 }), edgeClip("b", "e2"), edgeClip("c", "e3", { startSec: 0 })];
    expect(starts(layoutSpans(placed, d, TRACK))).toEqual([0, 5, 10]);
    expect(layoutSpans(lined(), d, STACKED)).toEqual(clipSpans(lined(), d, 1));
    const spans = layoutSpans(placed, d, STACKED);
    expect(spans).toEqual(placedSpans(placed, d, 1));
    expect(starts(spans)).toEqual([2, 6, 0]);
    expect(spans.every((s) => s.overlapIn === 0 && s.overlapOut === 0)).toBe(true);
    expect(isPlaced(placed)).toBe(true);
    expect(isPlaced(lined())).toBe(false);
  });

  it("measures the loop to the latest end of a clip with frames", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("x", "missing", { startSec: 20 })];
    const spans = layoutSpans(timeline, d, STACKED);
    expect(spansEnd(spans)).toBe(5);
    expect(topSpanAt(spans, 7)?.clip.id).toBe("a");
    expect(spansEnd([])).toBe(0);
    expect(sequenceDuration(lined(), d, 1)).toBe(14);
    // Out of order in rows: the latest end, not the last span's
    expect(spansEnd(placedSpans([edgeClip("a", "e1", { startSec: 9 }), edgeClip("b", "e2", { startSec: 0 })], d, 1))).toBe(14);
  });

  it("finds no clip in a gap, and the clip that ends last past the end", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 2 }), edgeClip("b", "e2", { startSec: 8 })];
    const spans = layoutSpans(timeline, d, STACKED);
    expect(topSpanAt(spans, 7.5)).toBeNull();
    expect(topSpanAt(spans, 1)).toBeNull();
    expect(topSpanAt(spans, 13)?.clip.id).toBe("b");
    expect(topSpanAt(spans, 20)?.clip.id).toBe("b");
    expect(topSpanAt(spans, -1)?.clip.id).toBe("a");
    // The top row is in front where two play
    const over = layoutSpans([edgeClip("a", "e1", { startSec: 6 }), edgeClip("b", "e2", { startSec: 4 })], d, STACKED);
    expect(topSpanAt(over, 7)?.clip.id).toBe("a");
    expect(topSpanAt(over, 7, "b")?.clip.id).toBe("b");
    // Rows out of time order: the latest-ending span past the end
    const late = layoutSpans([edgeClip("a", "e1", { startSec: 2 }), edgeClip("x", "missing", { startSec: 30 }), edgeClip("b", "e2", { startSec: 0 })], d, STACKED);
    expect(topSpanAt(late, 7)?.clip.id).toBe("a");
  });

  it("re-anchors a time in a gap where it is, clamped to the new end", () => {
    const before = layoutSpans([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 8 })], d, STACKED);
    const after = layoutSpans([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 1 })], d, STACKED);
    expect(reanchorTime(before, before, 6.5)).toBe(6.5);
    expect(reanchorTime(before, after, 6.5)).toBe(6);
    expect(reanchorTime(before, after, 9)).toBe(2);
  });

  it("builds one envelope per spans array and flag", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0, inSec: 1 }), edgeClip("x", "missing"), edgeClip("b", "e2", { startSec: 4 })];
    const spans = layoutSpans(timeline, durations({ "edge:e1": 6, "edge:e2": 5 }), STACKED);
    const env = spansEnvelope(spans, true);
    expect(env.units).toEqual([
      { start: 0, length: 5, row: 0, source: "edge:e1", inSec: 1 },
      { start: 4, length: 5, row: 2, source: "edge:e2", inSec: 0 },
    ]);
    expect(spansEnvelope(spans, true)).toBe(env);
    expect(spansEnvelope(spans, false)).not.toBe(env);
    expect(spansEnvelope(spans, false).crossfade).toBe(false);
    expect(spansEnvelope([...spans], true)).not.toBe(env);
  });

  it("pins every start as drawn", () => {
    const pinned = pinStarts(lined(), d, 1);
    expect(pinned.map((c) => c.startSec)).toEqual([0, 4, 8]);
    expect(pinStarts(pinned, d, 1)).toBe(pinned);
    const mixed = [edgeClip("a", "e1", { startSec: 3 }), edgeClip("b", "e2"), edgeClip("c", "e3", { startSec: 0 })];
    const resolved = pinStarts(mixed, d, 1);
    expect(resolved.map((c) => c.startSec)).toEqual([3, 7, 0]);
    expect(resolved[0]).toBe(mixed[0]);
  });

  it("clears every start", () => {
    const pinned = pinStarts(lined(), d, 1);
    const cleared = clearStarts(pinned);
    expect(cleared.some((c) => "startSec" in c)).toBe(false);
    expect(cleared).toEqual(lined());
    const none = lined();
    expect(clearStarts(none)).toBe(none);
  });

  it("moves one clip's start, pinning the rest", () => {
    const timeline = lined();
    const moved = moveClipStart(timeline, d, "b", 6.5, 1);
    expect(moved.map((c) => c.startSec)).toEqual([0, 6.5, 8]);
    expect(moveClipStart(timeline, d, "b", -2, 1)[1].startSec).toBe(0);
    expect(moveClipStart(timeline, d, "b", 900, 1)[1].startSec).toBe(MAX_START_SEC);
    expect(moveClipStart(timeline, d, "b", 4, 1)).toBe(timeline);
    expect(moveClipStart(moved, d, "b", 6.5, 1)).toBe(moved);
    expect(moveClipStart(timeline, d, "missing", 3, 1)).toBe(timeline);
    expect(moveClipStart(timeline, d, "b", Number.NaN, 1)).toBe(timeline);
  });

  it("places a clip in time and row in one result", () => {
    const timeline = lined();
    const placed = placeClip(timeline, d, "c", 2, 0, 1);
    expect(placed.map((c) => [c.id, c.startSec])).toEqual([
      ["c", 2],
      ["a", 0],
      ["b", 4],
    ]);
    // A row change alone pins and keeps every start: a lined-up stack does not re-sequence
    const rowOnly = placeClip(timeline, d, "a", 0, 2, 1);
    expect(rowOnly.map((c) => [c.id, c.startSec])).toEqual([
      ["b", 4],
      ["c", 8],
      ["a", 0],
    ]);
    expect(placeClip(timeline, d, "c", 8, 2, 1)).toBe(timeline);
    expect(placeClip(timeline, d, "c", 8, 9, 1)).toBe(timeline);
    expect(placeClip(timeline, d, "missing", 8, 0, 1)).toBe(timeline);
  });

  it("trims with the frames fixed in time", () => {
    const timeline = lined();
    const later = trimClipInPlace(timeline, "b", d, { inSec: 1 }, 1);
    expect(later[1]).toMatchObject({ inSec: 1, startSec: 5 });
    expect(later[0].startSec).toBe(0);
    expect(later[2].startSec).toBe(8);
    const out = trimClipInPlace(timeline, "b", d, { outSec: 3 }, 1);
    expect(out[1]).toMatchObject({ outSec: 3, startSec: 4 });
    // The In stops where the clip would start before 0:00
    const atZero = [edgeClip("a", "e1", { startSec: 0.5, inSec: 2 })];
    expect(trimClipInPlace(atZero, "a", d, { inSec: 0 }, 1)[0]).toMatchObject({ inSec: 1.5, startSec: 0 });
    expect(trimClipInPlace(timeline, "b", d, { inSec: 0 }, 1)).toBe(timeline);
    expect(trimClipInPlace(timeline, "missing", d, { inSec: 1 }, 1)).toBe(timeline);
  });

  it("resets a trim, moving the start back by the In, clamped at 0:00", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 3, inSec: 1, outSec: 4 }), edgeClip("b", "e2", { startSec: 0.5, inSec: 0.8 })];
    const reset = resetTrimInPlace(timeline, "a", d, 1);
    expect(reset[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: null });
    expect(resetTrimInPlace(timeline, "b", d, 1)[1]).toMatchObject({ startSec: 0, inSec: 0, outSec: null });
    expect(resetTrimInPlace(reset, "a", d, 1)).toBe(reset);
  });

  it("splits a placed clip anywhere but a gap, the right piece in the next row at the playhead", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 4 }), edgeClip("c", "e3", { startSec: 12 })];
    const result = splitClipAt(timeline, d, 4.5, () => "new", { layout: STACKED });
    expect(result!.timeline.map((c) => [c.id, c.startSec, c.inSec, c.outSec])).toEqual([
      ["a", 0, 0, 4.5],
      ["new", 4.5, 4.5, null],
      ["b", 4, 0, null],
      ["c", 12, 0, null],
    ]);
    expect(splitClipAt(timeline, d, 4.5, () => "new", { layout: STACKED, preferClipId: "b" })!.timeline[2]).toMatchObject({
      id: "new",
      startSec: 4.5,
      inSec: 0.5,
    });
    expect(splitClipAt(timeline, d, 10, () => "new", { layout: STACKED })).toBeNull();
    expect(splitClipAt(timeline, d, MIN_CLIP_SEC / 2, () => "new", { layout: STACKED })).toBeNull();
    expect(splitClipAt(timeline, d, 9 - MIN_CLIP_SEC / 2, () => "new", { layout: STACKED, preferClipId: "b" })).toBeNull();
    // Lined up keeps commit 9's refusal inside an overlap
    expect(splitClipAt(lined(), d, 4.5, () => "new", { layout: STACKED })).toBeNull();
  });

  it("splits a placed clip in Track where its frames were", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 7, inSec: 0.5 }), edgeClip("b", "e2")];
    const result = splitClipAt(timeline, d, 2, () => "new", { layout: TRACK });
    expect(result!.timeline[1]).toMatchObject({ id: "new", inSec: 2.5, startSec: 9 });
    expect(result!.timeline[0]).toMatchObject({ id: "a", startSec: 7, outSec: 2.5 });
  });

  it("layers the placed preview", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 4 }), edgeClip("c", "e3", { startSec: 10 })];
    const spans = layoutSpans(timeline, d, STACKED);
    // In row order, the stage's DOM order: a (row 0, in front, fading out) holds 0.75 of the picture, b 0.25
    const fade = placedLayersAt(spans, 4.25, true);
    expect(fade.map((l) => l.span.clip.id)).toEqual(["a", "b"]);
    expect(fade[0].opacity).toBe(1);
    expect(fade[1].opacity).toBeCloseTo(0.25, 9);
    expect(fade[0].gain).toBeCloseTo(Math.cos((0.25 * Math.PI) / 2), 9);
    expect(placedLayersAt(spans, 9.5, true)).toEqual([]);
    const end = placedLayersAt(spans, 99, true);
    expect(end.map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([["c", 1, 1]]);
    expect(placedLayersAt(spans, 4.25, false).map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([
      ["a", 1, 1],
      ["b", 0, 1],
    ]);
  });

  it("holds the frame across a placed gap under a slot, as the encode does", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 5.01 })];
    const spans = layoutSpans(timeline, d, STACKED);
    expect(placedLayersAt(spans, 5.005, true).map((l) => [l.span.clip.id, l.opacity])).toEqual([["a", 1]]);
    expect(placedLayersAt(spans, 5.005, false).map((l) => [l.span.clip.id, l.opacity])).toEqual([["a", 1]]);
    // A gap of a slot or more is black
    const wide = layoutSpans([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 5.02 })], d, STACKED);
    expect(placedLayersAt(wide, 5.01, true)).toEqual([]);
  });

  it("keeps a start through createClip", () => {
    expect(edgeClip("a", "e1", { startSec: 3 }).startSec).toBe(3);
    expect("startSec" in edgeClip("a", "e1")).toBe(false);
  });
});

describe("group operations", () => {
  const ids = (timeline: readonly StitchTimelineClip[]) => timeline.map((c) => c.id);
  const set = (...clipIds: string[]) => new Set(clipIds);
  const five = () => ["a", "b", "c", "d", "e"].map((id) => edgeClip(id, `e-${id}`));

  const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
  const TRACK = { ...STACKED, mode: "track" as const };
  // Clip 1 A [0,5), Clip 2 B [6,10.2), Clip 3 C [9.2,15.2), Clip 4 D [11,14.2)
  const board = () => [
    edgeClip("c1", "a", { startSec: 0 }),
    edgeClip("c2", "b", { startSec: 6, inSec: 0.8 }),
    edgeClip("c3", "c", { startSec: 9.2 }),
    edgeClip("c4", "d", { startSec: 11, outSec: 3.2 }),
  ];
  const boardDurations = durations({ "edge:a": 5, "edge:b": 5, "edge:c": 6, "edge:d": 5 });
  const startsOf = (timeline: StitchTimelineClip[]) =>
    Object.fromEntries(layoutSpans(timeline, boardDurations, STACKED).map((span) => [span.clip.id, span.start]));

  it("removeClips removes every listed clip and reports edges no clip references any more", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("a2", "e1"), assetClip("x", "asset1")];
    const first = removeClips(timeline, set("a", "b", "x"));
    expect(ids(first.timeline)).toEqual(["a2"]);
    expect(first.orphanedEdgeIds).toEqual(["e2"]);
    expect(removeClips(timeline, set("a", "a2")).orphanedEdgeIds).toEqual(["e1"]);
    const none = removeClips(timeline, set("nope"));
    expect(none.timeline).toBe(timeline);
    expect(none.orphanedEdgeIds).toEqual([]);
  });

  it("updateClipsAudio changes every listed clip, and nothing else", () => {
    const timeline = three();
    const muted = updateClipsAudio(timeline, set("a", "c"), { muted: true });
    expect(muted.map((c) => c.muted)).toEqual([true, false, true]);
    expect(muted[1]).toBe(timeline[1]);
    expect(updateClipsAudio(timeline, set("a", "b"), { volume: 3 }).map((c) => c.volume)).toEqual([1, 1, 1]);
    expect(updateClipsAudio(timeline, set("a", "b"), { muted: false })).toBe(timeline);
  });

  it("moveClipsBlock equals moveClip for one clip", () => {
    const timeline = five();
    for (let from = 0; from < 5; from++) {
      for (let to = -1; to <= 5; to++) {
        expect(ids(moveClipsBlock(timeline, set(timeline[from].id), to))).toEqual(ids(moveClip(timeline, from, to)));
      }
    }
  });

  it("moveClipsBlock moves a non-contiguous selection as one run, in its order", () => {
    const timeline = five().slice(0, 4);
    expect(ids(moveClipsBlock(timeline, set("c", "a"), 0))).toEqual(["a", "c", "b", "d"]);
    expect(ids(moveClipsBlock(timeline, set("a", "c"), 1))).toEqual(["b", "a", "c", "d"]);
    expect(ids(moveClipsBlock(timeline, set("a", "c"), 2))).toEqual(["b", "d", "a", "c"]);
    expect(ids(moveClipsBlock(timeline, set("a", "c"), 9))).toEqual(["b", "d", "a", "c"]);
    expect(moveClipsBlock(timeline, set("a", "b"), 0)).toBe(timeline);
    expect(moveClipsBlock(timeline, set("a", "c"), NaN)).toBe(timeline);
    expect(moveClipsBlock(timeline, set("nope"), 1)).toBe(timeline);
  });

  it("shiftRows keeps the spacing, stops at both ends and keeps the others' order", () => {
    const timeline = five();
    expect(ids(shiftRows(timeline, set("a", "c"), 1))).toEqual(["b", "a", "d", "c", "e"]);
    expect(ids(shiftRows(timeline, set("a", "c"), 5))).toEqual(["b", "d", "a", "e", "c"]);
    expect(ids(shiftRows(timeline, set("b", "e"), -1))).toEqual(["b", "a", "c", "e", "d"]);
    expect(shiftRows(timeline, set("a", "c"), -1)).toBe(timeline);
    expect(shiftRows(timeline, set("c", "e"), 2)).toBe(timeline);
    expect(shiftRows(timeline, set("a", "c"), 0)).toBe(timeline);
    expect(shiftRows(timeline, set("a", "c"), NaN)).toBe(timeline);
  });

  it("placeClips moves the group by one time and one row delta, keeping its offsets", () => {
    const moved = placeClips(board(), boardDurations, set("c2", "c3"), 2, 1, 1);
    expect(ids(moved)).toEqual(["c1", "c4", "c2", "c3"]);
    const starts = startsOf(moved);
    expect(starts.c1).toBe(0);
    expect(starts.c4).toBe(11);
    expect(starts.c2).toBeCloseTo(8, 9);
    expect(starts.c3).toBeCloseTo(11.2, 9);
  });

  it("placeClips stops the group at 0:00 and 10:00 as a whole", () => {
    const early = startsOf(placeClips(board(), boardDurations, set("c2", "c3"), -100, 0, 1));
    expect(early.c2).toBe(0);
    expect(early.c3).toBeCloseTo(3.2, 9);
    const late = startsOf(placeClips(board(), boardDurations, set("c2", "c3"), 1000, 0, 1));
    expect(late.c3).toBe(MAX_START_SEC);
    expect(late.c2).toBeCloseTo(MAX_START_SEC - 3.2, 9);
  });

  it("placeClips pins a lined-up stack, so the clips it does not move keep their starts", () => {
    const lined = [edgeClip("a", "a"), edgeClip("b", "b"), edgeClip("c", "c")];
    const before = startsOf(lined);
    const moved = placeClips(lined, boardDurations, set("b"), 1, 0, 1);
    expect(moved.every((c) => c.startSec !== undefined)).toBe(true);
    const after = startsOf(moved);
    expect(after.a).toBe(before.a);
    expect(after.c).toBe(before.c);
    expect(after.b).toBeCloseTo(before.b + 1, 9);
  });

  it("placeClips returns the same array, unpinned, when neither time nor row changes", () => {
    const lined = [edgeClip("a", "a"), edgeClip("b", "b")];
    expect(placeClips(lined, boardDurations, set("a", "b"), 0, 0, 1)).toBe(lined);
    expect(placeClips(lined, boardDurations, set("a", "b"), 0, 1, 1)).toBe(lined);
    expect(placeClips(lined, boardDurations, set("a"), -3, 0, 1)).toBe(lined);
    expect(placeClips(lined, boardDurations, set("nope"), 2, 1, 1)).toBe(lined);
    // A row change alone still pins
    const rows = placeClips([...lined, edgeClip("c", "c")], boardDurations, set("a"), 0, 1, 1);
    expect(ids(rows)).toEqual(["b", "a", "c"]);
    expect(rows.every((c) => c.startSec !== undefined)).toBe(true);
  });

  it("splitClipsAt splits every selected clip under the playhead in a placed stack", () => {
    let n = 0;
    const result = splitClipsAt(board(), boardDurations, 10, ["c3", "c2"], { layout: STACKED, makeId: () => `r${++n}` });
    expect(result).not.toBeNull();
    expect(result!.rightIds).toEqual(["r1", "r2"]);
    expect(ids(result!.timeline)).toEqual(["c1", "c2", "r1", "c3", "r2", "c4"]);
  });

  it("splitClipsAt never cuts an unselected clip in front", () => {
    const result = splitClipsAt(board(), boardDurations, 10, ["c3", "c4"], { layout: STACKED, makeId: () => "r" });
    expect(ids(result!.timeline)).toEqual(["c1", "c2", "c3", "r", "c4"]);
    expect(result!.rightIds).toEqual(["r"]);
    expect(splitClipsAt(board(), boardDurations, 10, ["c1", "c4"], { layout: STACKED })).toBeNull();
  });

  it("splitClipsAt refuses inside a lined-up overlap", () => {
    // Lined up at Overlap 1: a 0–5, b 4–9, c 8–14
    const lined = [edgeClip("a", "a"), edgeClip("b", "b"), edgeClip("c", "c")];
    expect(splitClipsAt(lined, boardDurations, 4.5, ["a", "b"], { layout: STACKED })).toBeNull();
    const outside = splitClipsAt(lined, boardDurations, 6, ["a", "b", "c"], { layout: STACKED, makeId: () => "r" });
    expect(outside!.rightIds).toEqual(["r"]);
    expect(ids(outside!.timeline)).toEqual(["a", "b", "r", "c"]);
  });

  it("canSplitClipsAt agrees with splitClipsAt", () => {
    const cases: Array<{ name: string; timeline: StitchTimelineClip[]; layout: typeof STACKED | typeof TRACK }> = [
      { name: "track", timeline: board().map((c) => ({ ...c, startSec: undefined })), layout: TRACK },
      { name: "lined up", timeline: [edgeClip("c1", "a"), edgeClip("c2", "b"), edgeClip("c3", "c")], layout: STACKED },
      { name: "placed", timeline: board(), layout: STACKED },
    ];
    const selections = [["c1"], ["c2"], ["c1", "c3"], ["c2", "c3"], ["c3", "c4"], ["c1", "c2", "c3", "c4"]];
    const times = [-1, 0, 0.05, 0.1, 2.5, 4, 4.5, 4.95, 5, 5.05, 6, 6.05, 8.5, 9.2, 9.25, 10, 10.15, 11, 12, 14.2, 15.15, 15.2, 20];
    for (const { name, timeline, layout } of cases) {
      const spans = layoutSpans(timeline, boardDurations, layout);
      const placed = layout.mode === "stacked" && isPlaced(timeline);
      for (const selection of selections) {
        for (const t of [...times, NaN, Infinity]) {
          const can = canSplitClipsAt(spans, t, new Set(selection), placed);
          const did = splitClipsAt(timeline, boardDurations, t, selection, { layout }) !== null;
          expect({ name, selection, t, can }).toEqual({ name, selection, t, can: did });
        }
      }
    }
  });

  it("resetTrims resets every selected trimmed clip, in place in Stacked", () => {
    const track = [edgeClip("a", "e1", { inSec: 1 }), edgeClip("b", "e2", { outSec: 2 }), edgeClip("c", "e3", { inSec: 2 })];
    const reset = resetTrims(track, threeDurations, set("a", "b"), TRACK);
    expect(reset.map((c) => [c.inSec, c.outSec])).toEqual([
      [0, null],
      [0, null],
      [2, null],
    ]);
    const untouched = three();
    expect(resetTrims(untouched, threeDurations, set("a", "b"), TRACK)).toBe(untouched);
    const stacked = resetTrims(board(), boardDurations, set("c2", "c4"), STACKED);
    const starts = startsOf(stacked);
    expect(starts.c2).toBeCloseTo(5.2, 9);
    expect(starts.c4).toBe(11);
    expect(starts.c3).toBe(9.2);
    expect(stacked.find((c) => c.id === "c4")).toMatchObject({ inSec: 0, outSec: null });
    const untrimmed = board().filter((c) => c.id === "c1" || c.id === "c3");
    expect(resetTrims(untrimmed, boardDurations, set("c1", "c3"), STACKED)).toBe(untrimmed);
  });

  it("runEndIndex finds the last row of a split's run", () => {
    const d = durations({ "edge:e1": 5, "edge:e2": 5 });
    const split = [
      edgeClip("a1", "e1", { startSec: 0, outSec: 3 }),
      edgeClip("a2", "e1", { startSec: 3, inSec: 3 }),
      edgeClip("b", "e2", { startSec: 1.5 }),
    ];
    const spans = layoutSpans(split, d, STACKED);
    expect(runEndIndex(spans, 0)).toBe(1);
    expect(runEndIndex(spans, 1)).toBe(1);
    expect(runEndIndex(spans, 2)).toBe(2);
    expect(runEndIndex(spans, -1)).toBe(-1);
    expect(runEndIndex(spans, 3)).toBe(3);
    // An empty clip's row is its own; one between the pieces does not end the run
    const gapped = [split[0], edgeClip("x", "missing", { startSec: 2 }), split[1], split[2]];
    const gappedSpans = layoutSpans(gapped, d, STACKED);
    expect(runEndIndex(gappedSpans, 1)).toBe(1);
    expect(runEndIndex(gappedSpans, 0)).toBe(2);
  });
});
