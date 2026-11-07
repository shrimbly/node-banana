import { describe, it, expect } from "vitest";
import type { VolumePoint } from "@/types";
import {
  DB_GUIDES,
  MIN_POINT_GAP_SEC,
  addPoint,
  dbToGain,
  fadeIn,
  fadeInRange,
  fadeOut,
  fadeOutRange,
  flat,
  followEndFade,
  formatDb,
  gainAt,
  gainToDb,
  gainToLevel,
  levelToGain,
  movePoint,
  offsetCurve,
  removePoint,
  sameCurve,
  sortCurve,
} from "../curve";

const dip: VolumePoint[] = [
  { t: 0, gain: 1 },
  { t: 2, gain: 0 },
  { t: 4, gain: 1 },
];

describe("sortCurve", () => {
  it("drops bad points, clamps gain, sorts, and keeps the last of a repeated t", () => {
    const raw = [
      { t: 3, gain: 2 },
      { t: -1, gain: 0.5 },
      { t: Number.NaN, gain: 0.5 },
      { t: 1, gain: 0.2 },
      { t: 1, gain: 0.7 },
      null,
    ] as unknown as VolumePoint[];
    expect(sortCurve(raw)).toEqual([
      { t: 1, gain: 0.7 },
      { t: 3, gain: 1 },
    ]);
    expect(sortCurve(undefined)).toEqual([]);
  });
});

describe("gainAt", () => {
  it("is 1 for an empty curve", () => {
    expect(gainAt([], 3)).toBe(1);
  });

  it("holds the ends before the first point and after the last", () => {
    const curve = [{ t: 1, gain: 0.5 }, { t: 3, gain: 0.25 }];
    expect(gainAt(curve, 0)).toBe(0.5);
    expect(gainAt(curve, 9)).toBe(0.25);
  });

  it("is exact at the points", () => {
    expect(gainAt(dip, 0)).toBe(1);
    expect(gainAt(dip, 2)).toBe(0);
    expect(gainAt(dip, 4)).toBe(1);
  });

  it("interpolates in level, so halfway between 0 and 1 is 0.25", () => {
    expect(gainAt(dip, 1)).toBeCloseTo(0.25, 10);
    expect(gainAt(dip, 3)).toBeCloseTo(0.25, 10);
  });
});

describe("levels and dB", () => {
  it("puts −12 dB on the middle of the lane", () => {
    expect(gainToLevel(dbToGain(-12))).toBeCloseTo(0.5, 2);
  });

  it("maps level and gain both ways", () => {
    expect(gainToLevel(1)).toBe(0);
    expect(gainToLevel(0)).toBe(1);
    expect(levelToGain(gainToLevel(0.3))).toBeCloseTo(0.3, 10);
  });

  it("round-trips gain and dB", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(gainToDb(0.5))).toBeCloseTo(0.5, 10);
  });

  it("formats dB with a true minus sign", () => {
    expect(formatDb(1)).toBe("0.0 dB");
    expect(formatDb(dbToGain(-6))).toBe("−6.0 dB");
    expect(formatDb(0)).toBe("−∞ dB");
    expect(DB_GUIDES.map((g) => g.label)).toEqual(["0 dB", "−12", "−∞"]);
  });
});

describe("editing points", () => {
  it("addPoint inserts in order, returns its index, and lands on the line by default", () => {
    const { curve, index } = addPoint(dip, 1);
    expect(index).toBe(1);
    expect(curve.map((p) => p.t)).toEqual([0, 1, 2, 4]);
    expect(curve[1].gain).toBeCloseTo(0.25, 10);
    expect(addPoint([], 2, 0.5)).toEqual({ curve: [{ t: 2, gain: 0.5 }], index: 0 });
  });

  it("addPoint adds nothing at a time that is not finite, and reads a bad gain from the line", () => {
    expect(addPoint(dip, NaN)).toEqual({ curve: dip, index: -1 });
    expect(addPoint(dip, Infinity, 0.5)).toEqual({ curve: dip, index: -1 });
    expect(addPoint(dip, 1, NaN).curve[1].gain).toBeCloseTo(0.25, 10);
  });

  it("movePoint keeps the point's own time or gain where the new one is not finite", () => {
    expect(movePoint(dip, 1, NaN, 0.5)[1]).toEqual({ t: 2, gain: 0.5 });
    expect(movePoint(dip, 1, 3, NaN)[1]).toEqual({ t: 3, gain: 0 });
    expect(movePoint(dip, 1, Infinity, -Infinity)[1]).toEqual({ t: 2, gain: 0 });
  });

  it("offset and fades leave the curve alone for values that are not finite", () => {
    expect(offsetCurve(dip, NaN, 4)).toEqual(dip);
    expect(fadeIn(dip, Infinity)).toEqual(dip);
    expect(fadeOut(dip, NaN)).toEqual(dip);
    expect(fadeIn(dip, 4, NaN)[1]).toEqual({ t: 1, gain: expect.any(Number) });
    expect(gainToLevel(NaN)).toBe(1);
    expect(gainAt(dip, NaN)).toBe(dip[0].gain);
  });

  it("addPoint replaces a point closer than the minimum gap", () => {
    const { curve, index } = addPoint(dip, 2 + MIN_POINT_GAP_SEC / 2, 0.5);
    expect(curve).toEqual([dip[0], { t: 2 + MIN_POINT_GAP_SEC / 2, gain: 0.5 }, dip[2]]);
    expect(index).toBe(1);
  });

  it("movePoint stays between its neighbours and clamps gain", () => {
    const moved = movePoint(dip, 1, 9, 2);
    expect(moved[1]).toEqual({ t: 4 - MIN_POINT_GAP_SEC, gain: 1 });
    expect(movePoint(dip, 1, -5, -1)[1]).toEqual({ t: MIN_POINT_GAP_SEC, gain: 0 });
    expect(movePoint(dip, 0, -5, 0.5)[0]).toEqual({ t: 0, gain: 0.5 });
  });

  it("movePoint keeps the curve sorted when its neighbours are closer than the gap", () => {
    const close: VolumePoint[] = [
      { t: 1, gain: 1 },
      { t: 1.004, gain: 1 },
      { t: 1.008, gain: 1 },
    ];
    for (const t of [0, 1.004, 2]) {
      const moved = movePoint(close, 1, t, 0.25).map((p) => p.t);
      expect(moved).toEqual([...moved].sort((a, b) => a - b));
    }
    // A drag that does not move leaves the point where it is
    expect(movePoint(close, 1, 1.004, 0.25)[1]).toEqual({ t: 1.004, gain: 0.25 });
    expect(movePoint([{ t: 0.983, gain: 1 }, { t: 1, gain: 1 }, { t: 1.003, gain: 1 }], 1, 1, 1)[1].t).toBe(1);
  });

  it("removePoint drops one point", () => {
    expect(removePoint(dip, 1)).toEqual([dip[0], dip[2]]);
  });

  it("offsetCurve shifts every point's level and turns an empty curve into a flat line", () => {
    const shifted = offsetCurve([{ t: 0, gain: 1 }, { t: 2, gain: 0.25 }], 0.25, 4);
    expect(shifted[0].gain).toBeCloseTo(levelToGain(0.25), 10);
    expect(shifted[1].gain).toBeCloseTo(levelToGain(0.75), 10);
    expect(offsetCurve([], 0.5, 4)).toEqual([{ t: 0, gain: 0.25 }, { t: 4, gain: 0.25 }]);
    expect(offsetCurve([{ t: 0, gain: 0 }], -1, 4)).toEqual([{ t: 0, gain: 1 }]);
  });
});

describe("quick buttons", () => {
  it("fadeIn starts at silence and meets the old line after the fade", () => {
    const curve = [{ t: 0.5, gain: 0.3 }, { t: 3, gain: 0.5 }];
    const faded = fadeIn(curve, 10);
    expect(faded[0]).toEqual({ t: 0, gain: 0 });
    expect(faded[1].t).toBe(1);
    expect(faded[1].gain).toBeCloseTo(gainAt(curve, 1), 10);
    expect(faded[2]).toEqual({ t: 3, gain: 0.5 });
    expect(faded).toHaveLength(3);
  });

  it("fadeOut ends at silence and drops the points inside the fade", () => {
    const faded = fadeOut(dip, 4);
    expect(faded).toEqual([{ t: 0, gain: 1 }, { t: 2, gain: 0 }, { t: 3, gain: gainAt(dip, 3) }, { t: 4, gain: 0 }]);
  });

  it("clamps the fade to half the sequence", () => {
    expect(fadeIn([], 1)[1].t).toBe(0.5);
    expect(fadeOut([], 1)[0].t).toBe(0.5);
  });

  it("leaves the curve alone for an empty sequence", () => {
    expect(fadeIn(dip, 0)).toEqual(dip);
    expect(fadeOut(dip, 0)).toEqual(dip);
  });

  it("fadeInRange and fadeOutRange from 0 are fadeIn and fadeOut", () => {
    const curve = [{ t: 0.5, gain: 0.3 }, { t: 3, gain: 0.5 }];
    for (const c of [curve, dip, []]) {
      for (const seq of [10, 4, 1, 0, NaN, Infinity]) {
        expect(fadeInRange(c, 0, seq)).toEqual(fadeIn(c, seq));
        expect(fadeOutRange(c, 0, seq)).toEqual(fadeOut(c, seq));
        expect(fadeInRange(c, 0, seq, 0.25)).toEqual(fadeIn(c, seq, 0.25));
        expect(fadeOutRange(c, 0, seq, 0.25)).toEqual(fadeOut(c, seq, 0.25));
      }
    }
  });

  it("fades a range: from its start, to its end, at most half of it", () => {
    expect(fadeInRange(dip, 1, 5)).toEqual([{ t: 1, gain: 0 }, { t: 2, gain: 0 }, { t: 4, gain: 1 }]);
    expect(fadeOutRange([], 1, 5)).toEqual([{ t: 4, gain: 1 }, { t: 5, gain: 0 }]);
    expect(fadeInRange([], 2, 3)).toEqual([{ t: 2, gain: 0 }, { t: 2.5, gain: 1 }]);
    expect(fadeOutRange(dip, 3, 3)).toEqual(dip);
  });

  it("flat is the empty curve", () => {
    expect(flat()).toEqual([]);
  });
});

describe("sameCurve", () => {
  it("compares within a small epsilon", () => {
    expect(sameCurve(dip, dip.map((p) => ({ t: p.t + 1e-9, gain: p.gain })))).toBe(true);
    expect(sameCurve(dip, dip.slice(1))).toBe(false);
    expect(sameCurve(dip, [dip[0], { t: 2, gain: 0.1 }, dip[2]])).toBe(false);
  });
});

describe("followEndFade", () => {
  const faded: VolumePoint[] = [
    { t: 0, gain: 1 },
    { t: 15, gain: 0.5 },
    { t: 16, gain: 0 },
  ];

  it("moves a fade out that ends at the end with it, shorter or longer", () => {
    expect(followEndFade(faded, 16, 14)).toEqual([
      { t: 0, gain: 1 },
      { t: 13, gain: 0.5 },
      { t: 14, gain: 0 },
    ]);
    expect(followEndFade(faded, 16, 18)).toEqual([
      { t: 0, gain: 1 },
      { t: 17, gain: 0.5 },
      { t: 18, gain: 0 },
    ]);
  });

  it("restores the curve on the way back", () => {
    const awkward: VolumePoint[] = [
      { t: 0.3, gain: 0.8 },
      { t: 14.123, gain: 0.7 },
      { t: 15.123, gain: 0 },
    ];
    const there = followEndFade(awkward, 15.123, 13.456);
    expect(sameCurve(followEndFade(there, 13.456, 15.123), awkward)).toBe(true);
  });

  it("leaves a curve alone unless it ends at gain 0 on the old end", () => {
    const loud = faded.map((p, i) => (i === 2 ? { ...p, gain: 0.2 } : p));
    expect(followEndFade(loud, 16, 14)).toEqual(loud);
    expect(followEndFade(faded, 18, 14)).toEqual(faded);
    expect(followEndFade(faded, 16 + 1 / 120, 14)[2].t).toBeCloseTo(14 - 1 / 120, 9);
    expect(followEndFade([{ t: 16, gain: 0 }], 16, 14)).toEqual([{ t: 16, gain: 0 }]);
    expect(followEndFade(faded, 16, 16)).toEqual(faded);
    expect(followEndFade(faded, 16, Number.NaN)).toEqual(faded);
    expect(followEndFade(faded, 0, 14)).toEqual(faded);
  });

  it("leaves it alone when the moved points would collide with the one before", () => {
    // The second-to-last point would land at 0, or within the gap of the first
    expect(followEndFade(faded, 16, 1)).toEqual(faded);
    expect(followEndFade(faded, 16, 1 + MIN_POINT_GAP_SEC / 2)).toEqual(faded);
    expect(followEndFade(faded, 16, 1 + 2 * MIN_POINT_GAP_SEC)[1].t).toBeCloseTo(2 * MIN_POINT_GAP_SEC, 9);
    expect(
      followEndFade(
        [
          { t: 1, gain: 0.5 },
          { t: 2, gain: 0 },
        ],
        2,
        0.5,
      ),
    ).toEqual([
      { t: 1, gain: 0.5 },
      { t: 2, gain: 0 },
    ]);
  });
});
