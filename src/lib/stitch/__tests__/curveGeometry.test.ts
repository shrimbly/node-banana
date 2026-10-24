import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import { dbToGain, gainToLevel } from "../curve";
import {
  COLLAPSED_CURVE,
  EXPANDED_CURVE,
  curvePolyline,
  distanceToPolyline,
  levelToY,
  pointerToPoint,
  yToLevel,
} from "../curveGeometry";
import { buildTimeAxis } from "../timeAxis";
import { clipSpans, createClip, type SourceDurations, type SourceKey } from "../timeline";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

/** 10 s at 10 px/s from x 16: x = 16 + 10·t. */
const plainAxis = () => buildTimeAxis(clipSpans([clip("a", "e1")], durations({ "edge:e1": 10 }), 0), 10);
/** 4 s, an empty slot (160px), then 6 s: the slot sits at t = 4, x 56..216. */
const slotAxis = () =>
  buildTimeAxis(
    clipSpans([clip("a", "e1"), clip("gap", "e2"), clip("b", "e3")], durations({ "edge:e1": 4, "edge:e3": 6 }), 0),
    10,
  );

describe("levelToY / yToLevel", () => {
  it("round-trips inside the line's span, for both lane sizes", () => {
    for (const m of [COLLAPSED_CURVE, EXPANDED_CURVE]) {
      for (const level of [0, 0.25, 0.5, 1]) expect(yToLevel(levelToY(level, m), m)).toBeCloseTo(level);
      expect(levelToY(0, m)).toBe(m.top);
      expect(levelToY(1, m)).toBe(m.top + m.span);
    }
  });

  it("clamps a pointer above 0 dB or below −∞", () => {
    expect(yToLevel(-20, EXPANDED_CURVE)).toBe(0);
    expect(yToLevel(500, EXPANDED_CURVE)).toBe(1);
    expect(levelToY(2, EXPANDED_CURVE)).toBe(EXPANDED_CURVE.top + EXPANDED_CURVE.span);
  });

  it("puts the −12 dB guide near the middle of the expanded block", () => {
    const y = levelToY(gainToLevel(dbToGain(-12)), EXPANDED_CURVE);
    expect(Math.abs(y - (EXPANDED_CURVE.top + EXPANDED_CURVE.span / 2))).toBeLessThan(1);
  });
});

describe("curvePolyline", () => {
  it("runs from x(0) to x(seq), flat at 0 dB for an empty curve", () => {
    expect(curvePolyline([], 10, plainAxis(), EXPANDED_CURVE)).toEqual([
      { x: 16, y: 16 },
      { x: 116, y: 16 },
    ]);
  });

  it("has a vertex at each point inside the sequence, and ends on the level a point past the end gives", () => {
    const curve = [
      { t: 0, gain: 0 },
      { t: 2, gain: 1 },
      { t: 20, gain: 0 },
    ];
    const poly = curvePolyline(curve, 10, plainAxis(), EXPANDED_CURVE);
    expect(poly.map((v) => v.x)).toEqual([16, 36, 116]);
    expect(poly[0].y).toBe(106);
    expect(poly[1].y).toBe(16);
    // Halfway in level from t = 2 to t = 20 at t = 10: 8/18 of the way down
    expect(poly[2].y).toBeCloseTo(16 + (8 / 18) * 90);
  });

  it("runs flat across a slot, at the level of its instant", () => {
    const curve = [
      { t: 0, gain: 1 },
      { t: 8, gain: 0 },
    ];
    const poly = curvePolyline(curve, 10, slotAxis(), EXPANDED_CURVE);
    // x(0), slot entry 56 and exit 216, the point at 8 (16 + 80 + 160), x(10)
    expect(poly.map((v) => v.x)).toEqual([16, 56, 216, 256, 276]);
    expect(poly[1].y).toBeCloseTo(16 + 0.5 * 90);
    expect(poly[2].y).toBe(poly[1].y);
    expect(poly[3].y).toBe(106);
    expect(poly[4].y).toBe(106);
  });

  it("puts a point at a slot's instant before the slot's flat run, so the line never folds back", () => {
    // A click on the line over the slot adds a point at exactly t = 4 (pointerToPoint)
    const curve = [
      { t: 0, gain: 1 },
      { t: 4, gain: 0.25 },
      { t: 10, gain: 1 },
    ];
    const poly = curvePolyline(curve, 10, slotAxis(), EXPANDED_CURVE);
    const xs = poly.map((v) => v.x);
    expect(xs).toEqual([16, 56, 56, 216, 276]);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    const level = levelToY(gainToLevel(0.25), EXPANDED_CURVE);
    expect(poly[1].y).toBeCloseTo(level);
    expect(poly[2].y).toBeCloseTo(level);
    expect(poly[3].y).toBeCloseTo(level);
  });

  it("draws nothing for a sequence with no length", () => {
    expect(curvePolyline([{ t: 0, gain: 1 }], 0, plainAxis(), EXPANDED_CURVE)).toEqual([]);
  });

  it("gives the same vertices with the default window spelled out", () => {
    const curve = [
      { t: 0, gain: 1 },
      { t: 4, gain: 0.25 },
      { t: 8, gain: 0 },
    ];
    for (const axis of [plainAxis(), slotAxis()]) {
      expect(curvePolyline(curve, 10, axis, EXPANDED_CURVE, { offset: 0, from: 0, to: 10 })).toEqual(
        curvePolyline(curve, 10, axis, EXPANDED_CURVE),
      );
    }
  });

  it("draws a window of the curve's own clock, shifted by its offset", () => {
    // A clip with In 1 that starts at 3 s: source t sits at sequence t − (1 − 3) = t + 2
    const curve = [
      { t: 0, gain: 0 },
      { t: 2, gain: 1 },
      { t: 3, gain: 0.25 },
      { t: 9, gain: 0 },
    ];
    const poly = curvePolyline(curve, 10, plainAxis(), EXPANDED_CURVE, { offset: -2, from: 1, to: 4 });
    // from 1 → seq 3 (x 46), the points at 2 and 3 (x 56, 66), to 4 → seq 6 (x 76)
    expect(poly.map((v) => v.x)).toEqual([46, 56, 66, 76]);
    expect(poly[0].y).toBeCloseTo(16 + 0.5 * 90);
    expect(poly[1].y).toBe(16);
    expect(poly[2].y).toBe(levelToY(gainToLevel(0.25), EXPANDED_CURVE));
  });

  it("draws nothing for an empty window", () => {
    expect(curvePolyline([], 10, plainAxis(), EXPANDED_CURVE, { offset: 0, from: 3, to: 3 })).toEqual([]);
  });
});

describe("distanceToPolyline", () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  it("measures to the nearest segment, including its ends", () => {
    expect(distanceToPolyline({ x: 5, y: 3 }, poly)).toBeCloseTo(3);
    expect(distanceToPolyline({ x: 13, y: 5 }, poly)).toBeCloseTo(3);
    expect(distanceToPolyline({ x: -3, y: -4 }, poly)).toBeCloseTo(5);
  });
  it("handles a lone vertex and no vertices", () => {
    expect(distanceToPolyline({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBeCloseTo(5);
    expect(distanceToPolyline({ x: 3, y: 4 }, [])).toBe(Infinity);
  });
});

describe("pointerToPoint", () => {
  it("reads time from x and gain from y", () => {
    const p = pointerToPoint(66, 16 + 45, plainAxis(), EXPANDED_CURVE, 10);
    expect(p.t).toBeCloseTo(5);
    expect(p.gain).toBeCloseTo(0.25);
  });

  it("clamps time to the sequence and gain to 0..1", () => {
    expect(pointerToPoint(-100, -50, plainAxis(), EXPANDED_CURVE, 10)).toEqual({ t: 0, gain: 1 });
    expect(pointerToPoint(5000, 500, plainAxis(), EXPANDED_CURVE, 10)).toEqual({ t: 10, gain: 0 });
  });

  it("reads a pointer inside a slot as the slot's instant", () => {
    expect(pointerToPoint(150, 16, slotAxis(), EXPANDED_CURVE, 10).t).toBe(4);
  });

  it("reads time in the window's clock, clamped to it", () => {
    const window = { offset: -2, from: 1, to: 4 };
    // x 56 is sequence 4 s, source 2 s
    expect(pointerToPoint(56, 16, plainAxis(), EXPANDED_CURVE, 10, window).t).toBeCloseTo(2);
    expect(pointerToPoint(-100, 16, plainAxis(), EXPANDED_CURVE, 10, window).t).toBe(1);
    expect(pointerToPoint(5000, 16, plainAxis(), EXPANDED_CURVE, 10, window).t).toBe(4);
  });
});
