import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import { clipSpans, createClip, placedSpans, type SourceDurations, type SourceKey } from "../timeline";
import {
  EMPTY_SLOT_PX,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  buildTimeAxis,
  DEFAULT_PX_PER_SEC,
  fitPxPerSec,
} from "../timeAxis";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

describe("buildTimeAxis", () => {
  it("maps time linearly from the origin when no clip is empty, and back", () => {
    const spans = clipSpans([clip("a", "e1"), clip("b", "e2")], durations({ "edge:e1": 5, "edge:e2": 4 }), 0);
    const axis = buildTimeAxis(spans, 64);
    expect(axis.timeToX(0)).toBe(16);
    expect(axis.timeToX(4.6)).toBeCloseTo(16 + 4.6 * 64);
    for (const t of [0, 1.25, 5, 8.9]) expect(axis.xToTime(axis.timeToX(t))).toBeCloseTo(t);
    expect(axis.clipBox(1)).toEqual({ x: 16 + 5 * 64, width: 4 * 64 });
    expect(axis.endX).toBe(16 + 9 * 64);
    expect(axis.slots).toEqual([]);
  });

  it("gives a clip with no length a 160px slot that shifts every later box", () => {
    // b has no duration (not generated yet): a slot at t = 5
    const spans = clipSpans([clip("a", "e1"), clip("b", "e2"), clip("c", "e3")], durations({ "edge:e1": 5, "edge:e3": 4 }), 0);
    const axis = buildTimeAxis(spans, 64);
    expect(axis.slots).toEqual([{ clipId: "b", index: 1, t: 5, x: 16 + 320, width: EMPTY_SLOT_PX }]);
    expect(axis.clipBox(1)).toEqual({ x: 336, width: EMPTY_SLOT_PX });
    expect(axis.clipBox(2)).toEqual({ x: 336 + 160, width: 256 });
    expect(axis.endX).toBe(16 + 9 * 64 + 160);
    // Every pixel of the slot reads as its time
    expect(axis.xToTime(336)).toBe(5);
    expect(axis.xToTime(336 + 80)).toBe(5);
    expect(axis.xToTime(336 + 159.5)).toBe(5);
    // Past the slot, time continues where it stopped
    expect(axis.xToTime(496 + 64)).toBeCloseTo(6);
    expect(axis.timeToX(6)).toBeCloseTo(496 + 64);
  });

  it("puts a playhead at a slot's time before the slot", () => {
    const spans = clipSpans([clip("a", "e1"), clip("b", "e2"), clip("c", "e3")], durations({ "edge:e1": 5, "edge:e3": 4 }), 0);
    const axis = buildTimeAxis(spans, 64);
    expect(axis.timeToX(5)).toBe(336);
    expect(axis.timeToX(5.001)).toBeGreaterThan(336 + 160);
  });

  it("starts the sequence after a leading slot", () => {
    const spans = clipSpans([clip("a", "e1"), clip("b", "e2")], durations({ "edge:e2": 2 }), 0);
    const axis = buildTimeAxis(spans, 100);
    expect(axis.clipBox(0)).toEqual({ x: 16, width: 160 });
    expect(axis.clipBox(1)).toEqual({ x: 176, width: 200 });
    expect(axis.timeToX(0)).toBe(16);
    expect(axis.xToTime(176 + 100)).toBeCloseTo(1);
  });
});

describe("buildTimeAxis on placed spans", () => {
  it("ends at the latest end of a clip with frames", () => {
    const spans = placedSpans(
      [clip("a", "e1", { startSec: 6 }), clip("b", "e2", { startSec: 0 }), clip("x", "e9", { startSec: 20 })],
      durations({ "edge:e1": 5, "edge:e2": 4 }),
      1,
    );
    const axis = buildTimeAxis(spans, 64, 16, 0);
    expect(axis.total).toBe(11);
    expect(axis.endX).toBe(16 + 11 * 64);
    expect(axis.clipBox(0)).toEqual({ x: 16 + 6 * 64, width: 5 * 64 });
  });
});

describe("fitPxPerSec", () => {
  it("fits the sequence and the slots into the lane, leaving the add slot's room", () => {
    // 1258px lane (a 1440px window), 18.4 s: (1258 − 16 − 76) / 18.4 ≈ 63.4
    expect(fitPxPerSec(18.4, 0, 1258)).toBeCloseTo((1258 - 16 - 76) / 18.4);
    expect(fitPxPerSec(4, 1, 1000)).toBeCloseTo((1000 - 16 - 76 - 160) / 4);
  });

  it("is clamped, and treats a sequence under a second as one second", () => {
    expect(fitPxPerSec(1, 0, 0)).toBe(MIN_PX_PER_SEC);
    expect(fitPxPerSec(600, 0, 1000)).toBe(MIN_PX_PER_SEC);
    expect(fitPxPerSec(0.1, 0, 5000)).toBe(MAX_PX_PER_SEC);
    expect(fitPxPerSec(0.5, 0, 300)).toBeCloseTo(300 - 92);
  });

  it("uses the default zoom when nothing has a length (an empty draft, or only slots)", () => {
    expect(fitPxPerSec(0, 0, 1258)).toBe(DEFAULT_PX_PER_SEC);
    expect(fitPxPerSec(0, 2, 1258)).toBe(DEFAULT_PX_PER_SEC);
    expect(fitPxPerSec(Number.NaN, 0, 300)).toBe(DEFAULT_PX_PER_SEC);
  });

  it("takes the lane's own origin, slot width and trailing room", () => {
    expect(fitPxPerSec(10, 1, 1000, { origin: 24, slotPx: 100, trailingPx: 40 })).toBeCloseTo((1000 - 24 - 40 - 100) / 10);
  });
});

describe("buildTimeAxis without slots", () => {
  it("records no slot and stays linear when slotPx is 0", () => {
    const spans = clipSpans(
      [clip("a", "e1"), clip("x", "missing"), clip("b", "e2")],
      durations({ "edge:e1": 5, "edge:e2": 4 }),
      0,
    );
    const axis = buildTimeAxis(spans, 64, 16, 0);
    expect(axis.slots).toEqual([]);
    expect(axis.timeToX(6)).toBe(16 + 6 * 64);
    expect(axis.xToTime(16 + 6 * 64)).toBe(6);
    expect(axis.endX).toBe(16 + 9 * 64);
    expect(axis.clipBox(2)).toEqual({ x: 16 + 5 * 64, width: 4 * 64 });

    const slotted = buildTimeAxis(spans, 64, 16, EMPTY_SLOT_PX);
    expect(slotted.slots).toHaveLength(1);
    expect(slotted.timeToX(6)).toBe(16 + 6 * 64 + EMPTY_SLOT_PX);
  });
});
