import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import { clipSpans, createClip, type SourceDurations, type SourceKey } from "../timeline";
import { buildTimeAxis } from "../timeAxis";
import {
  insetBox,
  laneBoxes,
  liveSpans,
  MIN_DRAWN_PX,
  stackedBoxes,
  trimEdgeX,
  type LaneTrim,
} from "../laneLayout";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

// 64 px/s from x 16: Clip 1 (0–5, out 5 of a 6 s source), Clip 2 (5–9, In 1 of 5), Clip 3 (9–12)
const PPS = 64;
const timeline = [clip("c1", "e1", { outSec: 5 }), clip("c2", "e2", { inSec: 1 }), clip("c3", "e3")];
const spans = clipSpans(timeline, durations({ "edge:e1": 6, "edge:e2": 5, "edge:e3": 3 }), 0);
const axis = buildTimeAxis(spans, PPS);
const trim = (clipId: string, edge: "in" | "out", result: LaneTrim["result"]): LaneTrim => ({ clipId, edge, result });

describe("laneBoxes", () => {
  it("lays the clips end to end at rest", () => {
    const boxes = laneBoxes(axis, spans, null);
    expect(boxes.map((b) => [b.x, b.width])).toEqual([
      [16, 320],
      [336, 256],
      [592, 192],
    ]);
    expect(boxes[1].inSec).toBe(1);
  });

  it("pushes the later clips live while an Out lengthens", () => {
    const boxes = laneBoxes(axis, spans, trim("c1", "out", { inSec: 0, lengthSec: 5.5, deltaSec: 0.5, edgeSeqTime: 5.5 }));
    expect(boxes[0]).toEqual({ x: 16, width: 5.5 * PPS, inSec: 0, lengthSec: 5.5 });
    expect(boxes[1].x).toBe(336 + 32);
    expect(boxes[2].x).toBe(592 + 32);
  });

  it("holds the later clips in place while an Out shortens (they close up on release)", () => {
    const boxes = laneBoxes(axis, spans, trim("c1", "out", { inSec: 0, lengthSec: 4, deltaSec: -1, edgeSeqTime: 4 }));
    expect(boxes[0].width).toBe(4 * PPS);
    expect(boxes[1].x).toBe(336);
    expect(boxes[2].x).toBe(592);
  });

  it("moves the left edge with a shortening In and leaves the later clips alone", () => {
    const boxes = laneBoxes(axis, spans, trim("c2", "in", { inSec: 1.5, lengthSec: 3.5, deltaSec: -0.5, edgeSeqTime: 5.5 }));
    expect(boxes[0]).toEqual(laneBoxes(axis, spans, null)[0]);
    expect(boxes[1]).toEqual({ x: 336 + 32, width: 3.5 * PPS, inSec: 1.5, lengthSec: 3.5 });
    expect(boxes[2].x).toBe(592);
    expect(trimEdgeX(boxes[1], "in")).toBe(368);
  });

  it("draws a lengthening In as release leaves it: its left held, the later clips pushed", () => {
    const boxes = laneBoxes(axis, spans, trim("c2", "in", { inSec: 0.5, lengthSec: 4.5, deltaSec: 0.5, edgeSeqTime: 4.5 }));
    expect(boxes[0].x + boxes[0].width).toBe(336);
    expect(boxes[1]).toEqual({ x: 336, width: 4.5 * PPS, inSec: 0.5, lengthSec: 4.5 });
    expect(boxes[2].x).toBe(592 + 32);
    expect(trimEdgeX(boxes[1], "in")).toBe(336);
    expect(trimEdgeX(boxes[1], "out")).toBe(336 + 288);
  });
});

describe("insetBox", () => {
  it("insets 1px on each side shared with another clip: the boards' 2px between neighbours", () => {
    expect(insetBox({ x: 16, width: 320 }, 0, 3)).toEqual({ x: 16, width: 319 });
    expect(insetBox({ x: 336, width: 256 }, 1, 3)).toEqual({ x: 337, width: 254 });
    expect(insetBox({ x: 592, width: 192 }, 2, 3)).toEqual({ x: 593, width: 191 });
    // The gap between the first two as drawn
    expect(337 - (16 + 319)).toBe(2);
  });

  it("keeps a very short clip pressable: at least 4px, centred on its place", () => {
    // 0.1 s at 30 px/s is 3px: the insets alone would leave 1px
    expect(insetBox({ x: 100, width: 3 }, 1, 3)).toEqual({ x: 99.5, width: MIN_DRAWN_PX });
    expect(insetBox({ x: 100, width: 5 }, 1, 3)).toEqual({ x: 100.5, width: MIN_DRAWN_PX });
    expect(insetBox({ x: 100, width: 6 }, 1, 3)).toEqual({ x: 101, width: 4 });
  });
});

describe("liveSpans", () => {
  it("is the spans themselves at rest and while an edge shortens", () => {
    expect(liveSpans(spans, null)).toBe(spans);
    expect(liveSpans(spans, trim("c1", "out", { inSec: 0, lengthSec: 4, deltaSec: -1, edgeSeqTime: 4 }))).toBe(spans);
  });

  it("gives the lengthened clip its new length and pushes the later ones, as release leaves them", () => {
    const live = liveSpans(spans, trim("c2", "in", { inSec: 0.5, lengthSec: 4.5, deltaSec: 0.5, edgeSeqTime: 4.5 }));
    expect(live.map((s) => [s.start, s.end, s.length])).toEqual([
      [0, 5, 5],
      [5, 9.5, 4.5],
      [9.5, 12.5, 3],
    ]);
    // A slot after the edge moves with the clips: the axis built from them puts a time past it further right
    const withSlot = clipSpans([clip("a", "e1", { outSec: 3 }), clip("b", "none"), clip("c", "e3")], durations({ "edge:e1": 6, "edge:e3": 3 }), 0);
    const pushed = liveSpans(withSlot, trim("a", "out", { inSec: 0, lengthSec: 4, deltaSec: 1, edgeSeqTime: 4 }));
    expect(buildTimeAxis(pushed, PPS).timeToX(4)).toBe(16 + 4 * PPS);
    expect(buildTimeAxis(withSlot, PPS).timeToX(4)).toBe(16 + 4 * PPS + 160);
  });
});

describe("stackedBoxes", () => {
  it("draws each clip from its own start on a linear axis, empty clips as a slot", () => {
    // Clip 1 0–5, an empty clip at 5, Clip 2 4–8 (In 1 of 5), Clip 3 0.02 s at 8 (too short to overlap)
    const stackedTimeline = [clip("c1", "e1"), clip("x", "missing"), clip("c2", "e2", { inSec: 1 }), clip("c3", "e4")];
    const stacked = clipSpans(stackedTimeline, durations({ "edge:e1": 5, "edge:e2": 5, "edge:e4": 0.02 }), 1);
    const linear = buildTimeAxis(stacked, PPS, 16, 0);
    const boxes = stackedBoxes(linear, stacked);
    expect(boxes.map((b) => [b.x, b.width])).toEqual([
      [16, 320],
      [16 + 5 * PPS, 160],
      [16 + 4 * PPS, 4 * PPS],
      [16 + 8 * PPS, MIN_DRAWN_PX],
    ]);
    expect(boxes[2]).toMatchObject({ inSec: 1, lengthSec: 4 });
    expect(stackedBoxes(linear, stacked, 100)[1].width).toBe(100);
  });
});
