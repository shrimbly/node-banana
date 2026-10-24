import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import {
  clipSpans,
  createClip,
  neighbourTarget,
  type SnapTarget,
  type SourceDurations,
  type SourceKey,
} from "../timeline";
import { buildTimeAxis } from "../timeAxis";
import { trimDragAt, trimTargets, type TrimDragStart } from "../trimDrag";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

// Trim.png at 120 px/s: Clip 1 (0–4), Clip 2 (5 s source, In 0.8: 4–8.2), Clip 3 (8.2–14.2), Clip 4 (14.2–17.2)
const PPS = 120;
const timeline = [clip("c1", "e1"), clip("c2", "e2", { inSec: 0.8 }), clip("c3", "e3"), clip("c4", "e4")];
const lengths = durations({ "edge:e1": 4, "edge:e2": 5, "edge:e3": 6, "edge:e4": 3 });
const spans = clipSpans(timeline, lengths, 0);
const playhead = (t: number): SnapTarget => ({ t, kind: "playhead", label: "the playhead" });

/** A drag on clip 2's edge, pressed at x = 1000 (the press point does not matter, only the travel). */
function start(edge: "in" | "out", playheadAt = 20): TrimDragStart {
  const targets: SnapTarget[] = [playhead(playheadAt)];
  const neighbour = neighbourTarget(spans, "c2", edge);
  if (neighbour) targets.push(neighbour);
  return { span: spans[1], edge, sourceDuration: 5, pointerX: 1000, pxPerSec: PPS, targets };
}
const at = (s: TrimDragStart, dxSec: number, snap = true) => trimDragAt(s, s.pointerX + dxSec * PPS, { snap });

describe("trimDragAt", () => {
  it("shortens an Out by 0.8 s: delta −0.80, the crossed part as the ghost", () => {
    const r = at(start("out"), -0.8);
    expect(r.outSec).toBeCloseTo(4.2);
    expect(r.inSec).toBe(0.8);
    expect(r.deltaSec).toBeCloseTo(-0.8);
    expect(r.lengthSec).toBeCloseTo(3.4);
    expect(r.edgeSeqTime).toBeCloseTo(7.4);
    expect(r.edgeSourceTime).toBeCloseTo(4.2);
    expect(r.ghost?.fromSec).toBeCloseTo(7.4);
    expect(r.ghost?.toSec).toBeCloseTo(8.2);
    expect(r.snapped).toBeNull();
  });

  it("snaps the edge to the playhead within 8px, and not with snapping off (Shift)", () => {
    // Playhead at 7.42; the edge would land at 7.4 (2.4px away)
    const s = start("out", 7.42);
    const snapped = at(s, -0.8);
    expect(snapped.edgeSeqTime).toBeCloseTo(7.42);
    expect(snapped.snapped?.kind).toBe("playhead");
    expect(snapped.outSec).toBeCloseTo(4.22);
    const free = at(s, -0.8, false);
    expect(free.edgeSeqTime).toBeCloseTo(7.4);
    expect(free.snapped).toBeNull();
    // 10px away is too far
    expect(at(s, -0.8 - 10 / PPS + 0.02).snapped).toBeNull();
  });

  it("snaps back onto Clip 3 within 8px of the drag-start edge, from either side, with no change", () => {
    const s = start("out");
    for (const dx of [-6 / PPS, 6 / PPS]) {
      const r = at(s, dx);
      expect(r.snapped).toEqual({ t: 8.2, kind: "edge", label: "Clip 3" });
      expect(r.deltaSec).toBeCloseTo(0);
      expect(r.ghost).toBeNull();
      expect(r.outSec).toBeNull();
    }
  });

  it("does not snap a lengthening Out to the later clips' starting ends (they move with it)", () => {
    // Clip 2 on a 30 s source, trimmed to 0.8–5 (4–8.2 as above): its Out can run past Clip 3's (14.2) and Clip 4's (17.2) drag-start ends
    const longTimeline = [clip("c1", "e1"), clip("c2", "e2", { inSec: 0.8, outSec: 5 }), clip("c3", "e3"), clip("c4", "e4")];
    const long = clipSpans(longTimeline, durations({ "edge:e1": 4, "edge:e2": 30, "edge:e3": 6, "edge:e4": 3 }), 0);
    expect(long[1].end).toBeCloseTo(8.2);
    expect(long[2].end).toBeCloseTo(14.2);
    expect(long[3].end).toBeCloseTo(17.2);
    const s: TrimDragStart = {
      ...start("out"),
      span: long[1],
      sourceDuration: 30,
      targets: trimTargets(long, "c2", "out", 40),
    };
    for (const t of [14.2, 17.2]) {
      const r = trimDragAt(s, s.pointerX + (t - long[1].end + 2 / PPS) * PPS, { snap: true });
      expect(r.deltaSec).toBeGreaterThan(0);
      expect(r.ghost).toBeNull();
      expect(r.snapped).toBeNull();
      expect(r.edgeSeqTime).toBeCloseTo(t + 2 / PPS);
    }
  });

  it("targets only the playhead and the one neighbouring edge", () => {
    expect(trimTargets(spans, "c2", "out", 3)).toEqual([
      { t: 3, kind: "playhead", label: "the playhead" },
      { t: 8.2, kind: "edge", label: "Clip 3" },
    ]);
    expect(trimTargets(spans, "c2", "in", 3)).toEqual([
      { t: 3, kind: "playhead", label: "the playhead" },
      { t: 4, kind: "edge", label: "Clip 1" },
    ]);
    // The sequence's outer ends have no neighbour
    expect(trimTargets(spans, "c1", "in", 0)).toHaveLength(1);
    expect(trimTargets(spans, "c4", "out", 0)).toHaveLength(1);
  });

  it("gives the clip's own In and Out back exactly when the edge has not moved", () => {
    // A clip that is not first, with a numeric Out: (start + length) − start is not always the length in floats
    const noisy = [clip("c1", "e1"), clip("c2", "e2", { inSec: 0, outSec: 1.3 })];
    const ns = clipSpans(noisy, durations({ "edge:e1": 5, "edge:e2": 4 }), 0);
    for (const edge of ["in", "out"] as const) {
      const s: TrimDragStart = { span: ns[1], edge, sourceDuration: 4, pointerX: 500, pxPerSec: 64, targets: trimTargets(ns, "c2", edge, 0) };
      for (const snap of [true, false]) {
        const r = trimDragAt(s, 500, { snap });
        expect(r.inSec).toBe(0);
        expect(r.outSec).toBe(1.3);
        expect(r.deltaSec).toBe(0);
      }
    }
  });

  it("moves an In edge and the In together, and keeps the clip's start", () => {
    const r = at(start("in"), 0.5);
    expect(r.inSec).toBeCloseTo(1.3);
    expect(r.edgeSeqTime).toBeCloseTo(4.5);
    expect(r.edgeSourceTime).toBeCloseTo(1.3);
    expect(r.deltaSec).toBeCloseTo(-0.5);
    expect(r.ghost?.fromSec).toBeCloseTo(4);
    expect(r.ghost?.toSec).toBeCloseTo(4.5);
    // Lengthening the In shows no ghost and runs back toward the source's start
    const back = at(start("in"), -0.5);
    expect(back.inSec).toBeCloseTo(0.3);
    expect(back.edgeSeqTime).toBeCloseTo(3.5);
    expect(back.deltaSec).toBeCloseTo(0.5);
    expect(back.ghost).toBeNull();
  });

  it("holds the shortest length and stops at the source's ends", () => {
    const short = at(start("out"), -10);
    expect(short.lengthSec).toBeCloseTo(0.1);
    expect(short.outSec).toBeCloseTo(0.9);
    const long = at(start("out"), 3);
    expect(long.outSec).toBeNull();
    expect(long.lengthSec).toBeCloseTo(4.2);
    expect(long.deltaSec).toBeCloseTo(0);
    const early = at(start("in"), -3);
    expect(early.inSec).toBe(0);
    expect(early.edgeSeqTime).toBeCloseTo(3.2);
  });

  it("drops a snap that the trim limits pulled away from its target", () => {
    // The playhead sits past the source's end: the edge stops at 8.2, not at 8.24
    const r = at(start("out", 8.24), 0.04);
    expect(r.edgeSeqTime).toBeCloseTo(8.2);
    expect(r.snapped?.kind).not.toBe("playhead");
  });

  it("counts no time for an empty slot a lengthening In crosses, so it meets the playhead where it is drawn", () => {
    // Clip 1 (0–5), Clip 2 not generated (a slot at 5 s), Clip 3 with In 2 of a 6 s source; the playhead at 4 s
    const slotted = [clip("c1", "e1"), clip("c2", "e2"), clip("c3", "e3", { inSec: 2 })];
    const ss = clipSpans(slotted, durations({ "edge:e1": 5, "edge:e3": 6 }), 0);
    const axis = buildTimeAxis(ss, 64);
    const s: TrimDragStart = {
      span: ss[2],
      edge: "in",
      sourceDuration: 6,
      pointerX: axis.clipBox(2).x,
      pxPerSec: 64,
      xToTime: axis.xToTime,
      targets: trimTargets(ss, "c3", "in", 4),
    };
    // Anywhere over the slot is the clip's own start: no change
    expect(trimDragAt(s, axis.clipBox(1).x + 100, { snap: false }).deltaSec).toBe(0);
    // On the playhead line it snaps there, an In of 1 s
    const r = trimDragAt(s, axis.timeToX(4), { snap: true });
    expect(r.snapped?.kind).toBe("playhead");
    expect(r.inSec).toBeCloseTo(1);
    expect(r.deltaSec).toBeCloseTo(1);
  });
});

describe("trimTargets", () => {
  it("offers the neighbouring edge in Track", () => {
    expect(trimTargets(spans, "c2", "out", 20)).toEqual([playhead(20), neighbourTarget(spans, "c2", "out")]);
  });

  it("offers the playhead, 0:00 (In only), the other clips' edges and the edge's own start in Stacked", () => {
    const stacked = clipSpans(timeline, lengths, 1);
    const edgesOf = (index: number) => [
      { t: stacked[index].start, kind: "edge", label: `Clip ${index + 1}'s start` },
      { t: stacked[index].end, kind: "edge", label: `Clip ${index + 1}'s end` },
    ];
    expect(trimTargets(stacked, "c2", "out", 20, "stacked")).toEqual([
      playhead(20),
      ...edgesOf(0),
      ...edgesOf(2),
      ...edgesOf(3),
      { t: stacked[1].end, kind: "edge", label: "the original length" },
    ]);
    expect(trimTargets(stacked, "c2", "in", 20, "stacked")).toEqual([
      playhead(20),
      { t: 0, kind: "edge", label: "the start" },
      ...edgesOf(0),
      ...edgesOf(2),
      ...edgesOf(3),
      { t: stacked[1].start, kind: "edge", label: "the original length" },
    ]);
    expect(trimTargets(stacked, "missing", "out", 20, "stacked")).toEqual([
      playhead(20),
      ...edgesOf(0),
      ...edgesOf(1),
      ...edgesOf(2),
      ...edgesOf(3),
    ]);
  });

  it("leaves empty clips out of the Stacked targets", () => {
    const withEmpty = [...timeline, clip("c5", "e-none")];
    const stacked = clipSpans(withEmpty, lengths, 1);
    expect(trimTargets(stacked, "c2", "out", 20, "stacked").some((t) => t.label.startsWith("Clip 5"))).toBe(false);
  });
});

describe("trimDragAt, Stacked", () => {
  // A 5 s and B 5 s (In 1) at Overlap 1: B runs 4–9
  const pair = [clip("a", "ea"), clip("b", "eb", { inSec: 1 })];
  const pairLengths = durations({ "edge:ea": 5, "edge:eb": 6 });
  const laid = clipSpans(pair, pairLengths, 1);
  const inStart = (playheadAt: number, minInSec?: number): TrimDragStart => ({
    span: laid[1],
    edge: "in",
    sourceDuration: 6,
    pointerX: 1000,
    pxPerSec: PPS,
    targets: trimTargets(laid, "b", "in", playheadAt, "stacked"),
    minInSec,
  });

  it("puts an In edge at the new start: the frames stay where they are", () => {
    const r = at(inStart(20), 0.5);
    expect(r.inSec).toBeCloseTo(1.5);
    expect(r.edgeSeqTime).toBeCloseTo(4.5);
    const back = at(inStart(20), -0.6);
    expect(back.inSec).toBeCloseTo(0.4);
    expect(back.edgeSeqTime).toBeCloseTo(3.4);
  });

  it("stops the start at 0:00 with minInSec", () => {
    // B at 4 with In 1: the In can reach 0 (start 3) without it; with minInSec = 1 − 4 = −3 it is not what stops it
    expect(at(inStart(20, -3), -2).inSec).toBe(0);
    // As for a clip at 0.5 with In 1: minInSec = 1 − 0.5, so the In stops at 0.5 and the edge 0.5 s before the start
    const r = at(inStart(20, 0.5), -0.9, false);
    expect(r.inSec).toBeCloseTo(0.5);
    expect(r.edgeSeqTime).toBeCloseTo(laid[1].start - 0.5);
  });

  it("snaps an In edge to the playhead", () => {
    const r = at(inStart(4.3), 0.3 + 3 / PPS);
    expect(r.snapped?.kind).toBe("playhead");
    expect(r.edgeSeqTime).toBeCloseTo(4.3, 9);
    expect(r.inSec).toBeCloseTo(1.3, 9);
  });

  it("snaps an In edge to another clip's end", () => {
    // A ends at 5: B's In edge 2px past it
    const r = at(inStart(20), 1 + 2 / PPS);
    expect(r.snapped?.label).toBe("Clip 1's end");
    expect(r.edgeSeqTime).toBeCloseTo(5, 9);
  });
});
