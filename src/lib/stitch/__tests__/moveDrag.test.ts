import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import {
  moveDragAt,
  moveRowAt,
  moveSnapText,
  moveTargets,
  ROW_HYSTERESIS_PX,
  WHERE_IT_WAS,
  type MoveDragStart,
  type MoveTarget,
} from "../moveDrag";
import { createClip, layoutSpans, type SourceDurations, type SourceKey } from "../timeline";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

const PPS = 64;
const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
// Clip 1 A [0,5), Clip 2 B [6,10.2), Clip 3 C [9.2,15.2), Clip 4 D [11,14.2)
const timeline = [
  clip("c1", "a", { startSec: 0 }),
  clip("c2", "b", { startSec: 6, inSec: 0.8 }),
  clip("c3", "c", { startSec: 9.2 }),
  clip("c4", "d", { startSec: 11, outSec: 3.2 }),
];
const d = durations({ "edge:a": 5, "edge:b": 5, "edge:c": 6, "edge:d": 5 });
const spans = layoutSpans(timeline, d, STACKED);

const target = (t: number, label: string, edge: MoveTarget["edge"] = "both", kind: MoveTarget["kind"] = "edge"): MoveTarget => ({
  t,
  kind,
  label,
  edge,
  row: null,
});
const start = (targets: readonly MoveTarget[], startSec = 11, lengthSec = 3.2): MoveDragStart => ({
  clipId: "c4",
  startSec,
  lengthSec,
  pointerX: 1000,
  pxPerSec: PPS,
  targets,
});
/** The pointer moved by dx seconds' worth of pixels. */
const at = (s: MoveDragStart, dxSec: number, snap = true) => moveDragAt(s, s.pointerX + dxSec * PPS, { snap });

describe("moveDragAt", () => {
  it("follows the pointer", () => {
    const r = at(start([]), 2.5);
    expect(r.startSec).toBeCloseTo(13.5, 9);
    expect(r.deltaSec).toBeCloseTo(2.5, 9);
    expect(r.snapped).toBeNull();
    expect(r.snappedEdge).toBeNull();
  });

  it("clamps at 0 and at 600", () => {
    expect(at(start([]), -20).startSec).toBe(0);
    expect(at(start([]), -20).deltaSec).toBe(-11);
    expect(at(start([]), 900).startSec).toBe(600);
  });

  it("snaps the start and the end to the playhead", () => {
    const playhead = target(14, "the playhead", "both", "playhead");
    const startSnap = at(start([playhead]), 3 - 3 / PPS);
    expect(startSnap.startSec).toBe(14);
    expect(startSnap.snappedEdge).toBe("start");
    const endSnap = at(start([target(20, "the playhead", "both", "playhead")]), 20 - 14.2 + 5 / PPS);
    expect(endSnap.startSec).toBeCloseTo(20 - 3.2, 9);
    expect(endSnap.snappedEdge).toBe("end");
    expect(at(start([playhead]), 3 - 9 / PPS).snapped).toBeNull();
  });

  it("breaks a tie by where it was, then the playhead, then the start edge", () => {
    const own = target(11, WHERE_IT_WAS, "start");
    const playhead = target(11, "the playhead", "both", "playhead");
    const edge = target(11, "Clip 3's start");
    expect(at(start([edge, playhead, own]), 2 / PPS).snapped).toBe(own);
    expect(at(start([edge, playhead]), 2 / PPS).snapped).toBe(playhead);
    // The same candidate start from a start edge and from an end edge: the start edge
    const endEdge = target(11 + 3.2, "Clip 1's end");
    const r = at(start([endEdge, edge]), 2 / PPS);
    expect(r.snapped).toBe(edge);
    expect(r.snappedEdge).toBe("start");
  });

  it("lets a closer target beat where it was on a vertical drag", () => {
    // 3 px of sideways drift, the playhead 3 px after the start: the playhead is nearer
    const own = target(11, WHERE_IT_WAS, "start");
    const playhead = target(11 + 3 / PPS, "the playhead", "both", "playhead");
    const r = at(start([own, playhead]), 3 / PPS);
    expect(r.snapped).toBe(playhead);
    expect(at(start([own, playhead]), 0.5 / PPS).snapped).toBe(own);
  });

  it("skips a target that would put the start below 0", () => {
    // The end edge meeting 3.18 would start the clip at −0.02, 0.03 s from the pointer: skipped, not clamped to 0
    const r = at(start([target(3.18, "Clip 1's end", "end")], 0.5), -0.49);
    expect(r.snapped).toBeNull();
    expect(r.startSec).toBeCloseTo(0.01, 9);
  });

  it("ignores targets with snapping off", () => {
    const r = at(start([target(14, "the playhead", "both", "playhead")]), 3 - 3 / PPS, false);
    expect(r.snapped).toBeNull();
    expect(r.startSec).toBeCloseTo(14 - 3 / PPS, 9);
  });

  it("tests only the start edge for an empty clip", () => {
    const s = start([target(20, "Clip 3's end")], 11, 0);
    expect(at(s, 9 - 2 / PPS).snappedEdge).toBe("start");
    expect(at(start([target(20, "Clip 3's end", "end")], 11, 0), 20 - 11 + 2 / PPS).snapped).toBeNull();
  });
});

describe("moveTargets", () => {
  const targets = moveTargets(spans, "c4", 7, 1);

  it("offers the playhead, 0:00, where it was and every other clip's edges, with labels", () => {
    expect(targets.slice(0, 3)).toEqual([
      { t: 7, kind: "playhead", label: "the playhead", edge: "both", row: null },
      { t: 0, kind: "edge", label: "the start", edge: "start", row: null },
      { t: 11, kind: "edge", label: "where it was", edge: "start", row: 3 },
    ]);
    expect(targets).toContainEqual({ t: 0, kind: "edge", label: "Clip 1's start", edge: "both", row: 0 });
    expect(targets).toContainEqual({ t: 5, kind: "edge", label: "Clip 1's end", edge: "both", row: 0 });
    expect(targets.find((t) => t.label === "Clip 3's end")?.t).toBeCloseTo(15.2, 9);
    expect(targets.some((t) => t.label.startsWith("Clip 4"))).toBe(false);
  });

  it("offers an overlap with each other clip at its end less the pair overlap", () => {
    const overlap = targets.find((t) => t.label === "a 1.0 s overlap with Clip 3")!;
    expect(overlap.t).toBeCloseTo(14.2, 9);
    expect(overlap.edge).toBe("start");
    expect(overlap.row).toBe(2);
    // Clip 1 (A) and Clip 4 (D) are different sources; a pair capped at half a clip shows two decimals
    const short = layoutSpans([clip("x", "a", { startSec: 0, outSec: 1.5 }), clip("y", "b", { startSec: 3 })], d, STACKED);
    expect(moveTargets(short, "y", 0, 1).find((t) => t.label.startsWith("a "))?.label).toBe("a 0.75 s overlap with Clip 1");
  });

  it("offers no overlap with the same source", () => {
    const same = layoutSpans([clip("x", "a", { startSec: 0 }), clip("y", "a", { startSec: 6, inSec: 1 })], d, STACKED);
    expect(moveTargets(same, "y", 0, 1).some((t) => t.label.includes("overlap"))).toBe(false);
  });

  it("is empty for a clip that is not there", () => {
    expect(moveTargets(spans, "missing", 0, 1)).toEqual([]);
  });
});

describe("moveSnapText", () => {
  it("names the edge that snapped", () => {
    const playhead = target(14, "the playhead", "both", "playhead");
    expect(moveSnapText(at(start([playhead]), 3))).toBe("Snapped to the playhead");
    expect(moveSnapText(at(start([target(20, "Clip 3's start")]), 20 - 14.2))).toBe("End snapped to Clip 3's start");
    expect(moveSnapText(at(start([target(11, WHERE_IT_WAS, "start")]), 1 / PPS))).toBe("Snapped to where it was");
    expect(moveSnapText(at(start([]), 1))).toBeNull();
  });
});

describe("moveRowAt", () => {
  const ROW = 52;

  it("keeps the row until the centre is more than half a row and 4 px past its middle", () => {
    expect(ROW_HYSTERESIS_PX).toBe(4);
    expect(moveRowAt(1, 29, 1, 4, ROW)).toBe(1);
    expect(moveRowAt(1, 30, 1, 4, ROW)).toBe(1);
    expect(moveRowAt(1, 31, 1, 4, ROW)).toBe(2);
  });

  it("holds the new row on the way back until it strays as far", () => {
    expect(moveRowAt(1, 22, 2, 4, ROW)).toBe(2);
    expect(moveRowAt(1, 21, 2, 4, ROW)).toBe(1);
    expect(moveRowAt(1, -31, 1, 4, ROW)).toBe(0);
  });

  it("is clamped to the first and last rows", () => {
    expect(moveRowAt(0, -400, 0, 4, ROW)).toBe(0);
    expect(moveRowAt(3, 400, 3, 4, ROW)).toBe(3);
    expect(moveRowAt(1, 9 * ROW, 1, 4, ROW)).toBe(3);
  });

  it("keeps the current row for a dy that is not finite", () => {
    expect(moveRowAt(1, Number.NaN, 2, 4, ROW)).toBe(2);
    expect(moveRowAt(1, Infinity, 1, 4, ROW)).toBe(1);
  });
});

describe("moveTargets with a group, and moveDragAt's bounds", () => {
  it("gives no targets for the excluded clips", () => {
    const all = moveTargets(spans, "c4", 3, 1);
    const without = moveTargets(spans, "c4", 3, 1, new Set(["c4", "c3"]));
    expect(all.some((t) => t.row === 2)).toBe(true);
    expect(without.some((t) => t.row === 2)).toBe(false);
    expect(without).toEqual(all.filter((t) => t.row !== 2));
  });

  it("gives today's targets with no exclusions", () => {
    for (const id of ["c1", "c2", "c3", "c4"]) {
      expect(moveTargets(spans, id, 7, 1, new Set())).toEqual(moveTargets(spans, id, 7, 1));
    }
  });

  it("skips a candidate outside the bounds and clamps to them", () => {
    const edge = target(9, "Clip 3's start", "start");
    const bounded: MoveDragStart = { ...start([edge]), minStartSec: 9.5, maxStartSec: 12 };
    // Without bounds the start snaps to 9; with them that candidate is skipped and the start clamps to 9.5
    expect(at(start([edge]), -2 + 2 / PPS).startSec).toBe(9);
    const low = at(bounded, -2 + 2 / PPS);
    expect(low.startSec).toBe(9.5);
    expect(low.snapped).toBeNull();
    expect(at(bounded, 5).startSec).toBe(12);
    const high = target(13, "Clip 2's end", "start");
    expect(at({ ...start([high]), maxStartSec: 12.5 }, 2 - 2 / PPS).snapped).toBeNull();
    expect(at({ ...start([high]), maxStartSec: 13 }, 2 - 2 / PPS).snapped).toBe(high);
  });

  it("gives today's results without bounds", () => {
    const targets = moveTargets(spans, "c4", 14, 1);
    for (let dx = -12; dx <= 12; dx += 0.37) {
      for (const snap of [true, false]) {
        const plain = start(targets);
        const defaults: MoveDragStart = { ...plain, minStartSec: undefined, maxStartSec: undefined };
        expect(moveDragAt(defaults, plain.pointerX + dx * PPS, { snap })).toEqual(
          moveDragAt(plain, plain.pointerX + dx * PPS, { snap }),
        );
        expect(moveDragAt({ ...plain, minStartSec: 0 }, plain.pointerX + dx * PPS, { snap })).toEqual(
          moveDragAt(plain, plain.pointerX + dx * PPS, { snap }),
        );
      }
    }
  });
});
