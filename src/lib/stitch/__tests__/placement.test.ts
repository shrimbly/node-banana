import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import {
  buildEnvelope,
  crossfadeCount,
  domOpacities,
  envelopeAt,
  gainPieceAt,
  gainPieces,
  gaps,
  hiddenUnits,
  isLive,
  liveRunsAt,
  MAX_START_SEC,
  overlapCount,
  pairOverlap,
  placedCardItems,
  resolveStarts,
  RUN_TOL_SEC,
  SLOT_SEC,
  weightPieces,
  type PlacedUnit,
  type StackEnvelope,
} from "../placement";
import { crossfadeGain, joinOverlaps } from "../stack";
import { clipSpans, createClip, layersAt, spansEnvelope, type ClipSpan, type SourceKey } from "../timeline";

// The model's cases and properties. Numbers come from the plan's simulations (plan-v3-sim: cases3, cases31, lined3,
// split3, cont3, props3, critic-gen3); the generators are ported with fixed seeds.

/** A named unit: [name, start, length, row, source = name, inSec = 0]. */
type Spec = [string, number, number, number, string?, number?];

interface Named {
  env: StackEnvelope;
  /** Unit index by name. */
  index: Record<string, number>;
  /** Name by unit index. */
  names: string[];
}

function named(specs: readonly Spec[], crossfade = true): Named {
  const units: PlacedUnit[] = specs.map(([, start, length, row, source, inSec]) => ({
    start,
    length,
    row,
    source: source ?? specs.find((s) => s[3] === row)![0],
    inSec: inSec ?? 0,
  }));
  const env = buildEnvelope(units, crossfade);
  const names = env.units.map((u) => specs.find((s) => s[3] === u.row)![0]);
  return { env, names, index: Object.fromEntries(names.map((name, i) => [name, i])) };
}

/** Weight and gain per name at t (pieces of one clip summed: weights add, gains add in power). */
function at(n: Named, t: number): Record<string, { w: number; g: number }> {
  const out: Record<string, { w: number; g: number }> = {};
  for (const layer of envelopeAt(n.env, t)) {
    const name = n.names[layer.unit];
    const was = out[name] ?? { w: 0, g: 0 };
    out[name] = { w: was.w + layer.weight, g: Math.hypot(was.g, layer.gain) };
  }
  return out;
}

const fadesOf = (n: Named, name: string) => n.env.fades[n.env.runOf[n.index[name]]];
const SLOT = SLOT_SEC;

function expectWeights(n: Named, t: number, expected: Record<string, [number, number?]>, digits = 4) {
  const got = at(n, t);
  for (const [name, [w, g]] of Object.entries(expected)) {
    expect(got[name]?.w ?? 0, `${name} weight at ${t}`).toBeCloseTo(w, digits);
    if (g !== undefined) expect(got[name]?.g ?? 0, `${name} gain at ${t}`).toBeCloseTo(g, digits);
  }
}

// Seeded generators: the simulations' LCG, and the critique's mulberry32.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit with a key: pieces of one split clip share it. */
interface Keyed extends PlacedUnit {
  key: string;
}

/** gen.mjs: random placed stacks, rows a permutation, some sources repeated, a third with one clip already split. */
function randomStack(rnd: () => number, maxN: number): Keyed[] {
  const n = 1 + Math.floor(rnd() * maxN);
  const clips: Array<Omit<Keyed, "row">> = [];
  for (let i = 0; i < n; i++) {
    const start = rnd() < 0.5 ? Math.round(rnd() * 80) / 10 : rnd() * 8;
    const length = rnd() < 0.5 ? 0.2 + Math.round(rnd() * 60) / 10 : 0.05 + rnd() * 6;
    const source = rnd() < 0.2 && i > 0 ? clips[Math.floor(rnd() * i)].source : `s${i}`;
    clips.push({ start, length, source, inSec: rnd() < 0.3 ? Math.round(rnd() * 20) / 10 : 0, key: `c${i}` });
  }
  const order = clips.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const units = order.map((ci, row) => ({ ...clips[ci], row }));
  if (rnd() < 0.3) {
    const x = Math.floor(rnd() * units.length);
    const X = units.find((u) => u.row === x)!;
    return splitAt(units, x, X.start + X.length * (0.3 + rnd() * 0.4));
  }
  return units;
}

/** Split the unit in row x at time t: X1 keeps its row, X2 goes in the row under it, rows below move down one. */
function splitAt(units: readonly Keyed[], x: number, t: number): Keyed[] {
  const X = units.find((u) => u.row === x)!;
  const cut = t - X.start;
  const out = units.map((u) => (u === X ? { ...u, length: cut } : { ...u, row: u.row > x ? u.row + 1 : u.row }));
  out.push({ start: t, length: X.length - cut, row: x + 1, source: X.source, inSec: X.inSec + cut, key: X.key });
  return out;
}

/** plan-v3-critic/gen.mjs: starts snapped to other edges or within ±2 slots of one, split pieces with sub-slot errors. */
function criticStack(rand: () => number, n: number, splitP: number): Keyed[] {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const units: Keyed[] = [];
  const edges = [0];
  for (let i = 0; i < n; i++) {
    const k = rand();
    const length =
      k < 0.4 ? Math.round(6 + rand() * 600) / 60 : k < 0.7 ? Math.round(1 + rand() * 80) / 10 : k < 0.8 ? (1 + Math.floor(rand() * 4)) / 60 : 0.05 + rand() * 9;
    let start: number;
    const m = rand();
    if (m < 0.35) start = pick(edges);
    else if (m < 0.5) start = Math.max(0, pick(edges) + (rand() - 0.5) * 4 * SLOT);
    else if (m < 0.6 && units.length) start = Math.max(0, pick(units).start + pick(units).length - length);
    else start = Math.round(rand() * 150) / 10;
    let source = pick(["A", "B", "C", "D", "E"]);
    let inSec = Math.round(rand() * 20) / 10;
    if (units.length && rand() < splitP) {
      const a = units[units.length - 1];
      const err = rand() < 0.5 ? 0 : (rand() - 0.5) * SLOT * 1.4;
      source = a.source;
      start = Math.max(0, a.start + a.length + err);
      inSec = a.inSec + a.length + (rand() < 0.5 ? err : (rand() - 0.5) * SLOT * 1.4);
    }
    units.push({ start, length, row: i, source, inSec, key: `c${i}` });
    edges.push(start, start + length);
  }
  return units;
}

/** Weight and gain per key at t, pieces of one clip counted as their clip. */
function byKey(env: StackEnvelope, units: readonly Keyed[], t: number): Map<string, { w: number; g2: number }> {
  const out = new Map<string, { w: number; g2: number }>();
  for (const layer of envelopeAt(env, t)) {
    const key = units.find((u) => u.row === env.units[layer.unit].row)!.key;
    const was = out.get(key) ?? { w: 0, g2: 0 };
    out.set(key, { w: was.w + layer.weight, g2: was.g2 + layer.gain * layer.gain });
  }
  return out;
}

function differs(a: Map<string, { w: number; g2: number }>, b: Map<string, { w: number; g2: number }>, tol: number) {
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key) ?? { w: 0, g2: 0 };
    const y = b.get(key) ?? { w: 0, g2: 0 };
    if (Math.abs(x.w - y.w) > tol || Math.abs(Math.sqrt(x.g2) - Math.sqrt(y.g2)) > tol) return true;
  }
  return false;
}

const loopEnd = (units: readonly PlacedUnit[]) => Math.max(0, ...units.map((u) => u.start + u.length));

describe("isLive", () => {
  it("has a nanosecond of slack on both sides", () => {
    expect(isLive(1, 2, 1)).toBe(true);
    expect(isLive(1, 2, 1 - 5e-10)).toBe(true);
    expect(isLive(1, 2, 1 - 2e-9)).toBe(false);
    expect(isLive(1, 2, 2 - 2e-9)).toBe(true);
    expect(isLive(1, 2, 2 - 5e-10)).toBe(false);
  });

  it("makes only the later clip live at an exact butt join, and leaves no instant in neither", () => {
    for (const t of [5 - 1e-9, 5 - 5e-10, 5, 5 + 5e-10]) {
      const a = isLive(0, 5, t);
      const b = isLive(5, 10, t);
      expect(a && b).toBe(false);
      expect(a || b).toBe(true);
    }
    expect(isLive(5, 10, 5)).toBe(true);
    expect(isLive(0, 5, 5)).toBe(false);
  });
});

describe("pairOverlap", () => {
  it("is joinOverlaps on the pair", () => {
    const a = { length: 5, source: "a" };
    const b = { length: 1.2, source: "b" };
    expect(pairOverlap(a, b, 1)).toBe(joinOverlaps([a, b], 1)[1]);
    expect(pairOverlap(a, b, 1)).toBeCloseTo(0.6, 9);
    expect(pairOverlap(a, { length: 5, source: "c" }, 1)).toBe(1);
  });

  it("is 0 for the same source", () => {
    expect(pairOverlap({ length: 5, source: "a" }, { length: 5, source: "a" }, 1)).toBe(0);
  });
});

describe("resolveStarts", () => {
  it("keeps stored starts, clamped to [0, MAX_START_SEC]", () => {
    expect(MAX_START_SEC).toBe(600);
    expect(
      resolveStarts(
        [
          { start: -1, length: 5, source: "a" },
          { start: 700, length: 5, source: "b" },
          { start: 3.25, length: 5, source: "c" },
        ],
        1,
      ),
    ).toEqual([0, 600, 3.25]);
  });

  it("starts an unpinned clip Overlap before the latest end above it", () => {
    expect(resolveStarts([{ length: 5, source: "a" }], 1)).toEqual([0]);
    expect(resolveStarts([{ start: 0, length: 5, source: "a" }, { length: 5, source: "b" }], 1)).toEqual([0, 4]);
    // Same source: a cut
    expect(resolveStarts([{ start: 0, length: 5, source: "a" }, { length: 5, source: "a" }], 1)).toEqual([0, 5]);
  });

  it("takes the latest end among the rows above, whichever row it is", () => {
    const starts = resolveStarts(
      [
        { start: 0, length: 12, source: "a" },
        { start: 2, length: 3, source: "b" },
        { length: 5, source: "c" },
      ],
      1,
    );
    expect(starts[2]).toBe(11);
  });

  it("puts an empty item at E and leaves E alone", () => {
    expect(
      resolveStarts(
        [
          { start: 0, length: 5, source: "a" },
          { length: 0, source: "x" },
          { length: 5, source: "b" },
        ],
        1,
      ),
    ).toEqual([0, 5, 4]);
  });

  it("applies Line up's run caps", () => {
    // A1 and A2 (one source, 2 s each) pinned at 0 and 2, B unpinned: the run is 4 s, so the overlap is 1.5, not A2's 1.0
    const starts = resolveStarts(
      [
        { start: 0, length: 2, source: "a" },
        { start: 2, length: 2, source: "a" },
        { length: 5, source: "b" },
      ],
      1.5,
    );
    expect(starts[2]).toBeCloseTo(2.5, 9);
  });

  it("ignores a stored start that is not finite", () => {
    expect(resolveStarts([{ start: Number.NaN, length: 5, source: "a" }], 1)).toEqual([0]);
  });
});

describe("buildEnvelope: runs", () => {
  const runsOf = (specs: Spec[]) => named(specs).env.runs.map((r) => r.units.length);

  it("joins split pieces in consecutive rows", () => {
    expect(runsOf([["X1", 0, 7, 0, "X", 0], ["X2", 7, 3, 1, "X", 7]])).toEqual([2]);
  });

  it("does not join them across another clip's row, and does across an empty clip", () => {
    expect(runsOf([["X1", 0, 7, 0, "X", 0], ["B", 2, 3, 1], ["X2", 7, 3, 2, "X", 7]])).toEqual([1, 1, 1]);
    // An empty clip is no unit: buildEnvelope never sees it
    const units: PlacedUnit[] = [
      { start: 0, length: 7, row: 0, source: "X", inSec: 0 },
      { start: 7, length: 0, row: 1, source: "E", inSec: 0 },
      { start: 7, length: 3, row: 2, source: "X", inSec: 7 },
    ];
    expect(buildEnvelope(units, true).runs.map((r) => r.units.length)).toEqual([2]);
  });

  it("does not join the same video restarting at In 0", () => {
    expect(runsOf([["A1", 0, 3, 0, "A", 0], ["A2", 3, 3, 1, "A", 0]])).toEqual([1, 1]);
  });

  it("joins within half a slot (RUN_TOL_SEC) of the join and the anchor", () => {
    expect(RUN_TOL_SEC).toBeCloseTo(1 / 120, 12);
    expect(runsOf([["X1", 0, 7, 0, "X", 0], ["X2", 7 + 1 / 240, 3, 1, "X", 7]])).toEqual([2]);
    expect(runsOf([["X1", 0, 7, 0, "X", 0], ["X2", 7 + 1 / 100, 3, 1, "X", 7]])).toEqual([1, 1]);
    expect(runsOf([["X1", 0, 7, 0, "X", 0], ["X2", 7, 3, 1, "X", 7 + 1 / 240]])).toEqual([2]);
    expect(runsOf([["X1", 0, 7, 0, "X", 0], ["X2", 7, 3, 1, "X", 7 + 1 / 100]])).toEqual([1, 1]);
  });

  it("lists runs in row order", () => {
    const n = named([["C", 4, 6, 2], ["A", 0, 5, 0], ["B", 2, 5, 1]]);
    expect(n.env.runs.map((r) => r.row)).toEqual([0, 1, 2]);
    expect(n.env.units.map((u) => u.row)).toEqual([0, 1, 2]);
  });
});

describe("buildEnvelope: the picture below", () => {
  it("bridges a gap under a slot between two lower clips", () => {
    const close = named([["F", 2, 5, 0], ["A", 0, 4.5, 1], ["C", 4.51, 5, 2]]);
    expect(close.env.pictureBelow[0]).toHaveLength(1);
    const apart = named([["F", 2, 5, 0], ["A", 0, 4.5, 1], ["C", 4.52, 5, 2]]);
    expect(apart.env.pictureBelow[0]).toHaveLength(2);
  });

  it("fades a front clip in over the picture below as a whole", () => {
    // Front [2,7), M [0,3), L [3,6): the picture below is [0,6), so the lead is 2: in over [2,4)
    const n = named([["F", 2, 5, 0], ["M", 0, 3, 1], ["L", 3, 3, 2]]);
    expect(fadesOf(n, "F").fadeIn).toBeCloseTo(2, 9);
    expect(at(n, 3.5).L.w).toBeCloseTo(0.25, 9);
    expect(at(n, 4.5).L?.w ?? 0).toBe(0);
  });
});

describe("the hold across a bridged gap", () => {
  const specs: Spec[] = [["F", 2, 5, 0], ["A", 0, 5, 1], ["C", 5.01, 4.99, 2]];

  it("keeps the clip that played before the gap under the clip above", () => {
    const n = named(specs);
    const expected = [0.675, 0.669, 0.664, 0.658, 0.653];
    expected.forEach((w, i) => {
      expect(at(n, (298 + i + 0.5) / 60).F.w).toBeCloseTo(w, 3);
    });
    const slot300 = envelopeAt(n.env, 300.5 / 60);
    expect(slot300.map((l) => n.names[l.unit])).toEqual(["A", "F"]);
    expect(slot300[0].held).toBe(true);
    expect(slot300[1].gain).toBeCloseTo(0.864, 3);
    expect(slot300.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 12);
  });

  it("holds nothing with no clip above the gap", () => {
    const n = named([["A", 0, 5, 0], ["C", 5.01, 4.99, 1]]);
    expect(envelopeAt(n.env, 300.5 / 60)).toEqual([]);
  });

  it("holds again under a held clip (two bridged gaps, one under the other)", () => {
    // At 5.001: F alone, A ended at 5 over a 2 ms gap; under A, D ended at 4.995 over a 7 ms gap
    const n = named([["F", 2, 6, 0], ["A", 0, 5, 1], ["D", 0, 4.995, 2], ["E", 5.002, 5, 3]]);
    const layers = envelopeAt(n.env, 5.001);
    expect(layers.map((l) => n.names[l.unit])).toEqual(["D", "A", "F"]);
    expect(layers.filter((l) => l.held).map((l) => n.names[l.unit])).toEqual(["D", "A"]);
    expect(layers.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 12);
    const raw = liveRunsAt(n.env, 5.001);
    expect(raw[raw.length - 1].alpha).toBeCloseTo(1, 12);
  });
});

describe("fades: every configuration", () => {
  const fades = (specs: Spec[], name: string, crossfade = true) => fadesOf(named(specs, crossfade), name);
  const expectFades = (specs: Spec[], name: string, fadeIn: number, fadeOut: number) => {
    const f = fades(specs, name);
    expect(f.fadeIn, `${name} in`).toBeCloseTo(fadeIn, 4);
    expect(f.fadeOut, `${name} out`).toBeCloseTo(fadeOut, 4);
  };

  it("1 gap, 2 touch, 3 an overlap under a slot: no fades", () => {
    for (const specs of [
      [["A", 0, 5, 0], ["B", 6, 5, 1]],
      [["A", 0, 5, 0], ["B", 5, 5, 1]],
      [["A", 0, 5, 0], ["B", 4.99, 5, 1]],
      [["B", 4.99, 5, 0], ["A", 0, 5, 1]],
    ] as Spec[][]) {
      const n = named(specs);
      expect(n.env.fades.every((f) => f.fadeIn === 0 && f.fadeOut === 0)).toBe(true);
    }
  });

  it("4 neighbours, 5 an overlap longer than half a clip, both row orders", () => {
    expectFades([["A", 0, 5, 0], ["B", 4, 5, 1]], "A", 0, 1);
    expectFades([["B", 4, 5, 0], ["A", 0, 5, 1]], "B", 1, 0);
    expectFades([["A", 0, 5, 0], ["B", 1, 5, 1]], "A", 0, 1);
    expectFades([["B", 1, 5, 0], ["A", 0, 5, 1]], "B", 1, 0);
  });

  it("6, 7 and 7c: a front clip inside the picture below, scaled to fit", () => {
    expectFades([["B", 3, 2, 0], ["A", 0, 10, 1]], "B", 1, 1);
    expectFades([["B", 7, 2.5, 0], ["A", 0, 10, 1]], "B", 2.0833, 0.4167);
    expectFades([["B", 0.5, 2.5, 0], ["A", 0, 10, 1]], "B", 0.4167, 2.0833);
  });

  it("6b, 9b, 10: a lower clip under a longer front one makes no fade", () => {
    for (const specs of [
      [["A", 0, 10, 0], ["B", 3, 2, 1]],
      [["A", 0, 10, 0], ["B", 0, 3, 1]],
      [["A", 2, 5, 0], ["B", 2, 5, 1]],
    ] as Spec[][]) {
      expect(named(specs).env.fades.every((f) => f.fadeIn === 0 && f.fadeOut === 0)).toBe(true);
    }
  });

  it("9, 11, 12: equal starts and the lead and trail caps", () => {
    expectFades([["B", 0, 3, 0], ["A", 0, 10, 1]], "B", 0, 3);
    expectFades([["B", 2, 5, 0], ["A", 0, 5, 1]], "B", 2, 0);
    expectFades([["A", 0, 5, 0], ["B", 2, 5, 1]], "A", 0, 2);
  });

  it("13, 13r, 14: three clips", () => {
    const thirteen: Spec[] = [["A", 0, 6, 0], ["B", 2, 6, 1], ["C", 4, 6, 2]];
    expectFades(thirteen, "A", 0, 4);
    expectFades(thirteen, "B", 0, 2);
    const reversed: Spec[] = [["C", 4, 6, 0], ["B", 2, 6, 1], ["A", 0, 6, 2]];
    expectFades(reversed, "C", 4, 0);
    expectFades(reversed, "B", 2, 0);
    const nested: Spec[] = [["C", 4, 4, 0], ["B", 2, 4, 1], ["A", 0, 10, 2]];
    expectFades(nested, "C", 2.6667, 1.3333);
    expectFades(nested, "B", 1.3333, 2.6667);
  });

  it("14b: a front clip over two lower clips with a gap between them", () => {
    const specs: Spec[] = [["F", 2, 5, 0], ["A", 0, 4, 1], ["C", 5, 5, 2]];
    expectFades(specs, "F", 2, 2);
    expect(at(named(specs), 4.5)).toEqual({ F: { w: 1, g: 1 } });
  });

  it("15, 15b, 16: the same video twice, and split pieces", () => {
    expectFades([["A1", 0, 5, 0, "A", 0], ["A2", 2.5, 5, 1, "A", 0]], "A1", 0, 2.5);
    const restart = named([["A1", 0, 3, 0, "A", 0], ["A2", 3, 3, 1, "A", 0]]);
    expect(restart.env.runs).toHaveLength(2);
    const split = named([["X1", 0, 3, 0, "X", 0], ["X2", 3, 3, 1, "X", 3]]);
    expect(split.env.runs).toHaveLength(1);
    expect(split.env.fades[0]).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it("17b, 17c: a split run keeps the fades of the clip", () => {
    const whole = named([["X", 0, 10, 0], ["L", 4, 10, 1]]);
    const split = named([["X1", 0, 7, 0, "X", 0], ["X2", 7, 3, 1, "X", 7], ["L", 4, 10, 2]]);
    expect(split.env.fades[0]).toEqual(whole.env.fades[0]);
    expect(split.env.fades[0].fadeOut).toBeCloseTo(4, 9);
    const inside = named([["X1", 4, 0.5, 0, "X", 0], ["X2", 4.5, 4.5, 1, "X", 0.5], ["A", 0, 5, 2]]);
    expect(inside.env.fades[0].fadeIn).toBeCloseTo(1, 9);
    expectWeights(inside, 4.25, { X1: [0.25] });
    expectWeights(inside, 4.75, { X2: [0.75] });
  });

  it("18: an empty clip is no unit", () => {
    const env = buildEnvelope([{ start: 3, length: 0, row: 0, source: "E", inSec: 0 }], true);
    expect(env.units).toHaveLength(0);
    expect(env.loopLength).toBe(0);
  });

  it("20, 21: a gap or a trail under a slot", () => {
    const gap = named([["A", 0, 5, 0], ["B", 5.01, 5, 1]]);
    expect(gaps(gap.env)).toEqual([]);
    expect(envelopeAt(gap.env, 5.005)).toEqual([]);
    const trail = named([["A", 0, 5, 0], ["B", 0.01, 5, 1]]);
    expect(trail.env.fades.every((f) => f.fadeIn === 0 && f.fadeOut === 0)).toBe(true);
    expectWeights(trail, 4, { A: [1, 1], B: [0, 0] });
    expectWeights(trail, 5.005, { B: [1, 1] });
  });

  it("is all zeros with Crossfade off", () => {
    const n = named([["A", 0, 5, 0], ["B", 4, 5, 1]], false);
    expect(n.env.fades).toEqual([
      { fadeIn: 0, fadeOut: 0 },
      { fadeIn: 0, fadeOut: 0 },
    ]);
    expect(n.env.pictureBelow).toEqual([[], []]);
  });

  it("changes nothing at the crossings of the caps", () => {
    // Row 11: B's start at A's start ± 1e-6; row 12: B's end at A's end ± 1e-6
    const near = (a: Spec[], b: Spec[], name: string) => {
      const x = fades(a, name);
      const y = fades(b, name);
      expect(Math.abs(x.fadeIn - y.fadeIn)).toBeLessThan(1e-5);
      expect(Math.abs(x.fadeOut - y.fadeOut)).toBeLessThan(1e-5);
    };
    near([["B", 1e-6, 5, 0], ["A", 0, 5, 1]], [["B", -1e-6, 5, 0], ["A", 0, 5, 1]], "B");
    near([["B", 2, 3 + 1e-6, 0], ["A", 0, 5, 1]], [["B", 2, 3 - 1e-6, 0], ["A", 0, 5, 1]], "B");
    near([["A", 0, 5, 0], ["B", 2, 3 + 1e-6, 1]], [["A", 0, 5, 0], ["B", 2, 3 - 1e-6, 1]], "A");
    // Row 6 with B's end at A's end − 1e-6: (min(ℓ, lead), 0)
    const f = fades([["B", 8, 2 - 1e-6, 0], ["A", 0, 10, 1]], "B");
    expect(f.fadeIn).toBeCloseTo(2 - 1e-6, 5);
    expect(f.fadeOut).toBe(0);
  });
});

describe("envelopeAt", () => {
  it("gives the table's weights and gains", () => {
    expectWeights(named([["A", 0, 5, 0], ["B", 4, 5, 1]]), 4.5, { A: [0.5, 0.7071], B: [0.5, 0.7071] });
    expectWeights(named([["A", 0, 5, 0], ["B", 1, 5, 1]]), 3, { A: [1, 1], B: [0, 0] });
    expectWeights(named([["A", 0, 5, 0], ["B", 1, 5, 1]]), 4.5, { A: [0.5, 0.7071], B: [0.5, 0.7071] });
    expectWeights(named([["B", 1, 5, 0], ["A", 0, 5, 1]]), 1.5, { B: [0.5, 0.7071], A: [0.5, 0.7071] });
    const deep = named([["B", 3, 2, 0], ["A", 0, 10, 1]]);
    expectWeights(deep, 3.5, { B: [0.5, 0.7071], A: [0.5, 0.7071] });
    expectWeights(deep, 4, { B: [1, 1], A: [0, 0] });
    expectWeights(named([["B", 7, 2.5, 0], ["A", 0, 10, 1]]), 8, { B: [0.48, 0.6845], A: [0.52, 0.729] });
    expectWeights(named([["B", 7, 2.5, 0], ["A", 0, 10, 1]]), 9.25, { B: [0.6, 0.809], A: [0.4, 0.5878] });
    expectWeights(named([["B", 0.5, 2.5, 0], ["A", 0, 10, 1]]), 1, { B: [0.96, 0.998], A: [0.04, 0.0628] });
    expectWeights(named([["B", 0, 3, 0], ["A", 0, 10, 1]]), 1.5, { B: [0.5, 0.7071], A: [0.5, 0.7071] });
    expectWeights(named([["B", 2, 5, 0], ["A", 0, 5, 1]]), 3, { B: [0.5, 0.7071], A: [0.5, 0.7071] });
    expectWeights(named([["B", 2, 5, 0], ["A", 0, 5, 1]]), 4.5, { B: [1, 1], A: [0, 0] });
    expectWeights(named([["A", 0, 5, 0], ["B", 2, 5, 1]]), 2.5, { A: [1, 1], B: [0, 0] });
    expectWeights(named([["A", 0, 5, 0], ["B", 2, 5, 1]]), 4, { A: [0.5, 0.7071], B: [0.5, 0.7071] });
    const thirteen = named([["A", 0, 6, 0], ["B", 2, 6, 1], ["C", 4, 6, 2]]);
    expectWeights(thirteen, 5, { A: [0.25, 0.3827], B: [0.75, 0.9239], C: [0, 0] });
    expectWeights(thirteen, 7, { B: [0.5, 0.7071], C: [0.5, 0.7071] });
    const reversed = named([["C", 4, 6, 0], ["B", 2, 6, 1], ["A", 0, 6, 2]]);
    expectWeights(reversed, 3, { B: [0.5, 0.7071], A: [0.5, 0.7071] });
    expectWeights(reversed, 5, { C: [0.25, 0.3827], B: [0.75, 0.9239], A: [0, 0] });
    expectWeights(reversed, 7, { C: [0.75, 0.9239], B: [0.25, 0.3827] });
    const nested = named([["C", 4, 4, 0], ["B", 2, 4, 1], ["A", 0, 10, 2]]);
    expectWeights(nested, 3, { B: [0.75, 0.9239], A: [0.25, 0.3827] });
    expectWeights(nested, 5, { C: [0.375, 0.5556], B: [0.2344, 0.4619], A: [0.3906, 0.6913] });
    expectWeights(nested, 7, { C: [0.75, 0.9239], A: [0.25, 0.3827] });
  });

  it("hides and silences a lower clip under a longer front one; Off hears it", () => {
    for (const specs of [
      [["A", 0, 10, 0], ["B", 3, 2, 1]],
      [["A", 0, 10, 0], ["B", 0, 3, 1]],
      [["A", 2, 5, 0], ["B", 2, 5, 1]],
    ] as Spec[][]) {
      const on = named(specs);
      const off = named(specs, false);
      const b = on.env.units[on.index.B];
      for (let k = 0; k < 40; k++) {
        const t = b.start + (b.length * (k + 0.5)) / 40;
        expect(at(on, t).B).toEqual({ w: 0, g: 0 });
        expect(at(off, t).B).toEqual({ w: 0, g: 1 });
      }
    }
  });

  it("lists layers bottom first", () => {
    const n = named([["A", 0, 6, 0], ["B", 2, 6, 1], ["C", 4, 6, 2]]);
    expect(envelopeAt(n.env, 5).map((l) => n.names[l.unit])).toEqual(["C", "B", "A"]);
    const off = named([["A", 0, 6, 0], ["B", 2, 6, 1], ["C", 4, 6, 2]], false);
    expect(envelopeAt(off.env, 5).map((l) => [off.names[l.unit], l.weight, l.gain])).toEqual([
      ["C", 0, 1],
      ["B", 0, 1],
      ["A", 1, 1],
    ]);
  });

  it("is empty in a gap and outside the loop", () => {
    const n = named([["A", 0, 5, 0], ["B", 6, 5, 1]]);
    expect(envelopeAt(n.env, 5.5)).toEqual([]);
    expect(envelopeAt(n.env, 11)).toEqual([]);
    expect(envelopeAt(n.env, -1)).toEqual([]);
  });

  it("keeps every α in [0, 1]", () => {
    const rnd = lcg(3);
    for (let i = 0; i < 200; i++) {
      const units = randomStack(rnd, 6);
      const env = buildEnvelope(units, true);
      for (let t = -0.5; t < env.loopLength + 0.5; t += 0.07) {
        for (const layer of envelopeAt(env, t)) {
          expect(layer.alpha).toBeGreaterThanOrEqual(0);
          expect(layer.alpha).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("reduces to commit 9 for two clips", () => {
    // Front A fading out over B: weights (1 − p, p), gains (cos pπ/2, sin pπ/2), p = (t − s_B) / fo_A
    const n = named([["A", 0, 5, 0], ["B", 3.5, 5, 1]]);
    const fo = fadesOf(n, "A").fadeOut;
    expect(fo).toBeCloseTo(1.5, 9);
    for (let t = 3.5; t < 5; t += 0.01) {
      const p = (t - 3.5) / fo;
      expectWeights(n, t, { A: [1 - p, crossfadeGain(p, "out")], B: [p, crossfadeGain(p, "in")] }, 9);
    }
  });
});

describe("property (d): weights sum to 1, Σγ² = 1, never over black", () => {
  function check(units: readonly PlacedUnit[], times: readonly number[]) {
    let live = 0;
    for (const crossfade of [true, false]) {
      const env = buildEnvelope(units, crossfade);
      for (const t of times) {
        const layers = envelopeAt(env, t);
        if (layers.length === 0) continue;
        live++;
        const w = layers.reduce((s, l) => s + l.weight, 0);
        if (Math.abs(w - 1) > 1e-9) throw new Error(`weights sum to ${w} at ${t}: ${JSON.stringify(units)}`);
        if (!crossfade) continue;
        const g2 = layers.reduce((s, l) => s + l.gain * l.gain, 0);
        if (Math.abs(g2 - 1) > 1e-9) throw new Error(`Σγ² = ${g2} at ${t}: ${JSON.stringify(units)}`);
        const raw = liveRunsAt(env, t);
        const bottom = raw[raw.length - 1].alpha;
        if (bottom < 1 - 1e-9) throw new Error(`bottom α ${bottom} at ${t}: ${JSON.stringify(units)}`);
      }
    }
    return live;
  }

  it("holds on 2,000 seeded random placements of 1–9 units, a quarter with sub-slot gaps and overlaps", () => {
    const rnd = lcg(77);
    let live = 0;
    for (let i = 0; i < 2000; i++) {
      const units = randomStack(rnd, 9);
      if (rnd() < 0.25 && units.length > 1) units[1].start = Math.max(0, units[0].start + units[0].length + (rnd() - 0.5) * 2 * SLOT);
      const end = loopEnd(units);
      const times: number[] = [];
      for (let g = 0; g <= 150; g++) times.push((end * g) / 150);
      units.forEach((u) => times.push(u.start + 1e-7, u.start + u.length - 1e-7));
      live += check(units, times);
    }
    expect(live).toBeGreaterThan(200_000);
  });

  it("holds on the critique's generator (up to 12 units, snapped and near-snapped starts)", () => {
    const rand = mulberry32(3);
    let live = 0;
    for (let i = 0; i < 800; i++) {
      const units = criticStack(rand, 1 + Math.floor(rand() * 12), 0.25);
      const end = loopEnd(units);
      const times: number[] = [];
      for (let k = 0; k < 150; k++) times.push((end * (k + rand())) / 150);
      live += check(units, times);
    }
    expect(live).toBeGreaterThan(100_000);
  });
});

describe("property (a): lined-up layouts reduce to commit 9", () => {
  /** The weights layersAt implies (its opacities stack bottom first, in its order). */
  function commit9(spans: ClipSpan[], t: number, crossfade: boolean): Map<number, { w: number; g: number }> {
    const layers = layersAt(spans, t, crossfade);
    const out = new Map<number, { w: number; g: number }>();
    layers.forEach((layer, k) => {
      const above = layers.slice(k + 1).reduce((rest, l) => rest * (1 - l.opacity), 1);
      out.set(layer.span.index, { w: layer.opacity * above, g: layer.gain });
    });
    return out;
  }

  function placed(spans: ClipSpan[], t: number, crossfade: boolean): Map<number, { w: number; g: number }> {
    const env = spansEnvelope(spans, crossfade);
    const out = new Map<number, { w: number; g: number }>();
    for (const layer of envelopeAt(env, t)) out.set(env.units[layer.unit].row, { w: layer.weight, g: layer.gain });
    return out;
  }

  function mismatch(spans: ClipSpan[], crossfade: boolean): number | null {
    const bounds = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
    const end = bounds[bounds.length - 1];
    const times: number[] = [];
    for (let g = 0; g <= 60; g++) times.push((end * g) / 60);
    bounds.forEach((b, i) => {
      if (b < 0 || b >= end) return;
      times.push(b + 2e-7, b + 1e-3, (b + bounds[i + 1]) / 2, bounds[i + 1] - 2e-7);
    });
    for (const t of times) {
      if (bounds.some((b) => Math.abs(b - t) <= 1e-7)) continue;
      const a = commit9(spans, t, crossfade);
      const b = placed(spans, t, crossfade);
      for (const row of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(row) ?? { w: 0, g: 0 };
        const y = b.get(row) ?? { w: 0, g: 0 };
        if (Math.abs(x.w - y.w) > 1e-6 || Math.abs(x.g - y.g) > 1e-6) return t;
      }
    }
    return null;
  }

  const spansOf = (items: Array<{ length: number; source: string; inSec: number }>, overlapSec: number) => {
    const timeline = items.map((item, i) =>
      createClip({ kind: "edge", edgeId: item.source }, { id: `c${i}`, inSec: item.inSec, outSec: item.inSec + item.length }),
    );
    const durations = new Map(items.map((item) => [`edge:${item.source}` as SourceKey, 10_000]));
    return clipSpans(timeline, durations, overlapSec);
  };

  it("matches layersAt on 20,000 seeded layouts, Crossfade on and off", () => {
    const rnd = lcg(11);
    let checked = 0;
    for (let trial = 0; trial < 20_000; trial++) {
      const count = 2 + Math.floor(rnd() * 7);
      const items: Array<{ length: number; source: string; inSec: number }> = [];
      const inOf = new Map<string, number>();
      let src = 0;
      for (let i = 0; i < count; i++) {
        if (rnd() < 0.08) {
          items.push({ length: 0, source: `e${i}`, inSec: 0 });
          continue;
        }
        if (rnd() < 0.5) src++;
        const r = rnd();
        const length =
          r < 0.4 ? Math.round(rnd() * 40 + 6) / 60 : r < 0.85 ? Math.round((0.1 + rnd() * 5) * 10) / 10 : Math.round(1 + rnd() * 5) / 60;
        const source = `s${src}`;
        const inSec = rnd() < 0.5 ? (inOf.get(source) ?? 0) : 0;
        inOf.set(source, inSec + length);
        items.push({ length, source, inSec });
      }
      const overlapSec = Math.round(rnd() * 30) / 10;
      const spans = spansOf(items, overlapSec);
      if (!spans.some((s) => s.length > 0)) continue;
      checked++;
      for (const crossfade of [true, false]) {
        const t = mismatch(spans, crossfade);
        if (t !== null) throw new Error(`differs at ${t} (crossfade ${crossfade}, O ${overlapSec}): ${JSON.stringify(items)}`);
      }
    }
    expect(checked).toBeGreaterThan(19_000);
  });

  it("matches on the named cases", () => {
    // A 4.0 s split at 3.5, then B, Overlap 1.0: B starts with A2
    const split = spansOf(
      [
        { length: 3.5, source: "a", inSec: 0 },
        { length: 0.5, source: "a", inSec: 3.5 },
        { length: 5, source: "b", inSec: 0 },
      ],
      1,
    );
    expect(split[2].start).toBeCloseTo(split[1].start, 9);
    // A short piece restarting at In 0 inside the next overlap: the clip above fades out over it and the next
    const restart = spansOf(
      [
        { length: 5, source: "x", inSec: 0 },
        { length: 0.3, source: "a", inSec: 0 },
        { length: 4, source: "a", inSec: 0 },
      ],
      1,
    );
    expect(restart[1].start).toBeCloseTo(4.7, 9);
    const shortLast = spansOf(
      [
        { length: 4, source: "a", inSec: 0 },
        { length: 0.3, source: "a", inSec: 0 },
        { length: 5, source: "b", inSec: 0 },
      ],
      1,
    );
    for (const spans of [split, restart, shortLast]) {
      for (const crossfade of [true, false]) expect(mismatch(spans, crossfade)).toBeNull();
    }
  });
});

describe("property (b): a split changes nothing", () => {
  function changed(units: Keyed[], crossfade: boolean, rnd: () => number): boolean {
    const X = units[Math.floor(rnd() * units.length)];
    if (X.length < 0.25) return false;
    const t = X.start + 0.1 + rnd() * (X.length - 0.2);
    const after = splitAt(units, X.row, t);
    const before = buildEnvelope(units, crossfade);
    const split = buildEnvelope(after, crossfade);
    const end = loopEnd(units);
    const times: number[] = [];
    for (let g = 0; g < 500; g++) times.push((end * g) / 500 + 1e-7);
    for (const e of units.flatMap((u) => [u.start, u.start + u.length]).concat([t])) times.push(e - 1e-6, e + 1e-6);
    return times.some((tt) => differs(byKey(before, units, tt), byKey(split, after, tt), 1e-9));
  }

  it("on 3,000 random placements per mode, inside overlaps too", () => {
    for (const crossfade of [true, false]) {
      const rnd = lcg(5);
      let changes = 0;
      for (let trial = 0; trial < 3000; trial++) if (changed(randomStack(rnd, 7), crossfade, rnd)) changes++;
      expect(changes, `crossfade ${crossfade}`).toBe(0);
    }
  });

  it("17b: X over L, split at 7", () => {
    const units: Keyed[] = [
      { start: 0, length: 10, row: 0, source: "X", inSec: 0, key: "X" },
      { start: 4, length: 10, row: 1, source: "L", inSec: 0, key: "L" },
    ];
    const after = splitAt(units, 0, 7);
    for (const crossfade of [true, false]) {
      const a = buildEnvelope(units, crossfade);
      const b = buildEnvelope(after, crossfade);
      for (let t = 0; t < 14; t += 0.01) expect(differs(byKey(a, units, t), byKey(b, after, t), 1e-9)).toBe(false);
    }
  });
});

describe("property (c): continuity", () => {
  const D = 1e-4;
  const structure = (env: StackEnvelope) =>
    JSON.stringify([env.runs.map((r) => r.units.map((u) => env.units[u].row)), env.pictureBelow.map((p) => p.length)]);
  /**
   * Whether the move crosses a sub-slot switch: a run join or a bridge changes, or a fade appears or vanishes at about
   * a slot (or is one the inside rule gave the whole run to). A fade that vanishes from seconds is no switch: a jump.
   */
  function switched(a: StackEnvelope, b: StackEnvelope): boolean {
    if (structure(a) !== structure(b)) return true;
    return a.fades.some((fa, k) => {
      const fb = b.fades[k];
      const length = a.runs[k].end - a.runs[k].start;
      const flip = (x: number, y: number, other: number) =>
        (x === 0) !== (y === 0) && (Math.max(x, y) < 1.5 * SLOT || Math.abs(Math.max(x, y) + other - length) < 1e-3);
      return flip(fa.fadeIn, fb.fadeIn, Math.max(fa.fadeOut, fb.fadeOut)) || flip(fa.fadeOut, fb.fadeOut, Math.max(fa.fadeIn, fb.fadeIn));
    });
  }
  const knees = (env: StackEnvelope) =>
    env.runs
      .flatMap((r, k) => [r.start, r.end, r.start + env.fades[k].fadeIn, r.end - env.fades[k].fadeOut])
      .concat(env.units.flatMap((u) => [u.start, u.start + u.length]));
  const weightsByKey = (env: StackEnvelope, units: Keyed[], t: number) =>
    new Map([...byKey(env, units, t)].map(([k, v]) => [k, v.w]));

  /** The largest weight change away from the knees, scaled as the bound: null when a sub-slot switch happened. */
  function jump(units: Keyed[], moved: Keyed[], crossfade: boolean): number | null {
    const a = buildEnvelope(units, crossfade);
    const b = buildEnvelope(moved, crossfade);
    if (switched(a, b)) return null;
    const fades = [...a.fades, ...b.fades].flatMap((f) => [f.fadeIn, f.fadeOut]).filter((f) => f > 0);
    const shortest = Math.min(1, ...fades);
    const kn = [...knees(a), ...knees(b)];
    const end = Math.max(loopEnd(units), loopEnd(moved));
    let most = 0;
    for (let g = 0; g <= 600; g++) {
      const t = (end * g) / 600;
      if (kn.some((k) => Math.abs(k - t) < 3 * D)) continue;
      const x = weightsByKey(a, units, t);
      const y = weightsByKey(b, moved, t);
      for (const key of new Set([...x.keys(), ...y.keys()])) most = Math.max(most, Math.abs((x.get(key) ?? 0) - (y.get(key) ?? 0)));
    }
    return (most * shortest) / D / (4 * (units.length + 1));
  }

  it("moves 3,000 clips by 0.1 ms, most of them across another clip's edge, without a jump", () => {
    for (const crossfade of [true, false]) {
      const rnd = lcg(29);
      let moves = 0;
      for (let trial = 0; trial < 3000; trial++) {
        const units = randomStack(rnd, 6);
        const u = units[Math.floor(rnd() * units.length)];
        if (units.length > 1 && rnd() < 0.8) {
          const others = units.filter((x) => x !== u);
          const v = others[Math.floor(rnd() * others.length)];
          const target = rnd() < 0.5 ? v.start : v.start + v.length;
          const s = (rnd() < 0.5 ? target : target - u.length) - D / 2;
          if (s < 0) continue;
          u.start = s;
        }
        const moved = units.map((x) => (x === u ? { ...x, start: x.start + D } : x));
        const ratio = jump(units, moved, crossfade);
        moves++;
        if (ratio !== null && ratio > 1) throw new Error(`jump ×${ratio} (crossfade ${crossfade}): ${JSON.stringify(units)}`);
      }
      expect(moves).toBeGreaterThan(2000);
    }
  });

  it("holds on the critique's generator, a fifth of the moves aimed at a threshold", () => {
    const rand = mulberry32(5);
    let moves = 0;
    let switches = 0;
    for (let n = 0; n < 2000; n++) {
      const units = criticStack(rand, 1 + Math.floor(rand() * 8), 0.3);
      const m = units[Math.floor(rand() * units.length)];
      const others = units.filter((u) => u !== m);
      let base = m.start;
      if (others.length && rand() < 0.75) {
        const o = others[Math.floor(rand() * others.length)];
        const target = rand() < 0.5 ? o.start : o.start + o.length;
        base = rand() < 0.5 ? target : target - m.length;
      }
      if (others.length && rand() < 0.2) base += (rand() < 0.5 ? 0.5 : 1) * SLOT * (rand() < 0.5 ? 1 : -1);
      if (base - D / 2 < 0) continue;
      const before = units.map((u) => (u === m ? { ...u, start: base - D / 2 } : u));
      const after = units.map((u) => (u === m ? { ...u, start: base + D / 2 } : u));
      const ratio = jump(before, after, true);
      moves++;
      if (ratio === null) switches++;
      else if (ratio > 1) throw new Error(`jump ×${ratio}: ${JSON.stringify(before)} moved ${m.key}`);
    }
    expect(moves).toBeGreaterThan(1500);
    expect(switches).toBeGreaterThan(0);
  });

  it("rows 11 and 12 with B's start crossing A's start; a split piece nudged by 1/240 s keeps its run", () => {
    const pair = (bStart: number, bRow: number): Keyed[] => [
      { start: bStart, length: 5, row: bRow, source: "B", inSec: 0, key: "B" },
      { start: 2, length: 5, row: 1 - bRow, source: "A", inSec: 0, key: "A" },
    ];
    for (const row of [0, 1]) {
      const ratio = jump(pair(2 - D / 2, row), pair(2 + D / 2, row), true);
      expect(ratio === null || ratio <= 1).toBe(true);
    }
    const pieces: Keyed[] = [
      { start: 0, length: 7, row: 0, source: "X", inSec: 0, key: "X" },
      { start: 7, length: 3, row: 1, source: "X", inSec: 7, key: "X" },
      { start: 4, length: 10, row: 2, source: "L", inSec: 0, key: "L" },
    ];
    const nudged = pieces.map((u) => (u.row === 1 ? { ...u, start: 7 + 1 / 240 } : u));
    expect(buildEnvelope(nudged, true).runs).toHaveLength(2);
    expect(buildEnvelope(nudged, true).runs[0].units).toHaveLength(2);
  });
});

describe("both sides of each threshold", () => {
  const xOverL = (x2Start: number, x1Length = 7): Spec[] => [
    ["X1", 0, x1Length, 0, "X", 0],
    ["X2", x2Start, 3, 1, "X", 7],
    ["L", 4, 10, 2],
  ];

  it("a run join at half a slot", () => {
    const kept = named(xOverL(7 + 0.49 * SLOT));
    expect(kept.env.runs).toHaveLength(2);
    expectWeights(kept, 5, { X1: [1] }, 3);
    expectWeights(kept, 8.5, { X2: [0.378] }, 3);
    const broken = named(xOverL(7 + 0.51 * SLOT));
    expect(broken.env.runs).toHaveLength(3);
    expectWeights(broken, 5, { X1: [0.667] }, 3);
    expectWeights(broken, 8.5, { X2: [0.994] }, 3);
    expectWeights(named(xOverL(7 + SLOT)), 8.5, { X2: [0.989] }, 3);
    const trimmed = named(xOverL(7, 7 - SLOT));
    expectWeights(trimmed, 5, { X1: [0.665] }, 3);
    expectWeights(trimmed, 8.5, { X2: [1] }, 3);
  });

  it("a bridge at one slot", () => {
    const bridge = (g: number) => named([["F", 2, 5, 0], ["A", 0, 4.5, 1], ["C", 4.5 + g * SLOT, 5.5 - g * SLOT, 2]]);
    const under = bridge(0.99);
    expect(fadesOf(under, "F").fadeOut).toBeCloseTo(3, 3);
    expectWeights(under, 4.25, { F: [0.917] }, 3);
    expectWeights(under, 5.5, { F: [0.5] }, 3);
    const over = bridge(1.01);
    expect(fadesOf(over, "F").fadeOut).toBeCloseTo(2.483, 3);
    expectWeights(over, 4.25, { F: [1] }, 3);
    expectWeights(over, 5.5, { F: [0.604] }, 3);
  });

  it("a fade crossing one slot changes weights only within that slot before A's end", () => {
    const trail = (d: number) => named([["A", 0, 5, 0], ["B", d * SLOT, 5, 1]]);
    const under = trail(0.99);
    const over = trail(1.01);
    expect(fadesOf(under, "A").fadeOut).toBe(0);
    expect(fadesOf(over, "A").fadeOut).toBeCloseTo(1.01 * SLOT, 9);
    for (let t = 0.05; t < 10; t += 0.01) {
      if (t > 5 - 1.01 * SLOT - 1e-6 && t < 5 + 1e-6) continue;
      const x = at(under, t);
      const y = at(over, t);
      for (const name of ["A", "B"]) expect(Math.abs((x[name]?.w ?? 0) - (y[name]?.w ?? 0))).toBeLessThan(1e-9);
    }
  });
});

describe("domOpacities", () => {
  it("turns weights into stacked CSS opacities, bottom first", () => {
    expect(domOpacities([0.75, 0.25])).toEqual([1, 0.25]);
    const three = domOpacities([2 / 7, 4 / 7, 1 / 7]);
    expect(three[0]).toBeCloseTo(1, 12);
    expect(three[1]).toBeCloseTo(2 / 3, 12);
    expect(three[2]).toBeCloseTo(1 / 7, 12);
    expect(domOpacities([0, 0])).toEqual([0, 0]);
  });
});

describe("gaps", () => {
  it("lists a leading and a middle gap", () => {
    const n = named([["A", 1, 4, 0], ["B", 6, 5, 1]]);
    expect(gaps(n.env)).toEqual([
      { fromSec: 0, toSec: 1 },
      { fromSec: 5, toSec: 6 },
    ]);
  });

  it("finds none in a lined-up layout, and leaves out a gap under a slot", () => {
    const timeline = [
      createClip({ kind: "edge", edgeId: "a" }, { id: "a" }),
      createClip({ kind: "edge", edgeId: "b" }, { id: "b" }),
    ];
    const spans = clipSpans(timeline, new Map([["edge:a", 5], ["edge:b", 5]] as Array<[SourceKey, number]>), 1);
    expect(gaps(spansEnvelope(spans, true))).toEqual([]);
    expect(gaps(named([["A", 0, 5, 0], ["B", 5.01, 5, 1]]).env)).toEqual([]);
  });
});

// §7.2's board: Clip 1 A [0,5); Clip 2 B (In 0.8) [6,10.2); Clip 3 C [9.2,15.2); Clip 4 A (Out 3.2) [11,14.2)
const board: Spec[] = [
  ["Clip 1", 0, 5, 0, "A", 0],
  ["Clip 2", 6, 4.2, 1, "B", 0.8],
  ["Clip 3", 9.2, 6, 2, "C", 0],
  ["Clip 4", 11, 3.2, 3, "A", 0],
];
// The same board with Clip 4 moved up a row
const boardUp: Spec[] = [
  ["Clip 1", 0, 5, 0, "A", 0],
  ["Clip 2", 6, 4.2, 1, "B", 0.8],
  ["Clip 4", 11, 3.2, 2, "A", 0],
  ["Clip 3", 9.2, 6, 3, "C", 0],
];

describe("weightPieces", () => {
  const shape = (pieces: ReturnType<typeof weightPieces>) =>
    pieces.map((p) => {
      const from = +p.fromSec.toFixed(3);
      const to = +p.toSec.toFixed(3);
      if (p.kind === "ramp") return ["ramp", from, to, +p.from.toFixed(3), +p.to.toFixed(3)];
      if (p.kind === "hidden") return ["hidden", from, to, p.coveredByRow];
      return ["curve", from, to];
    });

  it("draws neighbours as one ramp each", () => {
    const n = named([["A", 0, 5, 0], ["B", 4, 5, 1]]);
    expect(shape(weightPieces(n.env, n.index.A))).toEqual([["ramp", 4, 5, 1, 0]]);
    expect(shape(weightPieces(n.env, n.index.B))).toEqual([["ramp", 0, 1, 0, 1]]);
  });

  it("draws a deep insert and the clip under it as two wedges each", () => {
    const n = named([["B", 3, 2, 0], ["A", 0, 10, 1]]);
    expect(shape(weightPieces(n.env, n.index.B))).toEqual([
      ["ramp", 0, 1, 0, 1],
      ["ramp", 1, 2, 1, 0],
    ]);
    expect(shape(weightPieces(n.env, n.index.A))).toEqual([
      ["ramp", 3, 4, 1, 0],
      ["ramp", 4, 5, 0, 1],
    ]);
  });

  it("marks a hidden clip with the row that covers it", () => {
    const n = named([["A", 0, 10, 0], ["B", 3, 2, 1]]);
    expect(shape(weightPieces(n.env, n.index.B))).toEqual([["hidden", 0, 2, 0]]);
    const twelve = named([["A", 0, 5, 0], ["B", 2, 5, 1]]);
    expect(shape(weightPieces(twelve.env, twelve.index.B))).toEqual([
      ["hidden", 0, 1, 0],
      ["ramp", 1, 3, 0, 1],
    ]);
    const off = named([["B", 2, 5, 0], ["A", 0, 5, 1]], false);
    expect(shape(weightPieces(off.env, off.index.A))).toEqual([["hidden", 2, 5, 0]]);
  });

  it("draws the header-dragged board as release leaves it", () => {
    const n = named(boardUp);
    expect(shape(weightPieces(n.env, n.index["Clip 3"]))).toEqual([
      ["ramp", 0, 1, 0, 1],
      ["ramp", 1.8, 3.6, 1, 0],
      ["hidden", 3.6, 4, 2],
      ["ramp", 4, 5, 0, 1],
    ]);
    expect(shape(weightPieces(n.env, n.index["Clip 4"]))).toEqual([
      ["ramp", 0, 1.8, 0, 1],
      ["ramp", 2.2, 3.2, 1, 0],
    ]);
  });

  it("draws a curve where two clips above fade at once, with at most 17 points", () => {
    const n = named([["C", 4, 4, 0], ["B", 2, 4, 1], ["A", 0, 10, 2]]);
    const pieces = weightPieces(n.env, n.index.A, 480);
    expect(shape(pieces).map((p) => p[0])).toEqual(["ramp", "ramp", "curve", "ramp", "ramp"]);
    const curve = pieces[2];
    expect(curve.kind === "curve" && [curve.fromSec, curve.toSec]).toEqual([4, 6]);
    if (curve.kind === "curve") {
      expect(curve.points.length).toBeLessThanOrEqual(17);
      expect(curve.points.length).toBeGreaterThanOrEqual(2);
      for (const [sec, w] of curve.points) expect(w).toBeCloseTo(at(n, sec).A.w, 9);
    }
    const coarse = weightPieces(n.env, n.index.A, 8)[2];
    expect(coarse.kind === "curve" && coarse.points.length).toBe(5);
  });
});

describe("counts and hidden clips", () => {
  const count = (specs: Spec[], crossfade = true) => {
    const n = named(specs, crossfade);
    return { fades: crossfadeCount(n.env), overlaps: overlapCount(n.env), hidden: hiddenUnits(n.env).map((u) => n.names[u]) };
  };

  it("counts fades and overlaps", () => {
    expect(count([["A", 0, 5, 0], ["B", 4, 5, 1]])).toMatchObject({ fades: 1, overlaps: 1 });
    expect(count([["B", 3, 2, 0], ["A", 0, 10, 1]])).toMatchObject({ fades: 2, overlaps: 1 });
    expect(count([["A", 0, 6, 0], ["B", 2, 6, 1], ["C", 4, 6, 2]])).toMatchObject({ fades: 2, overlaps: 3 });
    expect(count([["C", 4, 4, 0], ["B", 2, 4, 1], ["A", 0, 10, 2]])).toMatchObject({ fades: 4, overlaps: 3 });
    expect(count([["A", 0, 10, 0], ["B", 3, 2, 1]])).toMatchObject({ fades: 0, overlaps: 1 });
    expect(count([["A", 0, 5, 0], ["B", 5, 5, 1]])).toMatchObject({ fades: 0, overlaps: 0 });
    expect(count([["A", 0, 5, 0], ["B", 4.99, 5, 1]])).toMatchObject({ fades: 0, overlaps: 0 });
    expect(count([["X1", 0, 3, 0, "X", 0], ["X2", 3, 3, 1, "X", 3]])).toMatchObject({ fades: 0, overlaps: 0 });
    expect(count(board)).toMatchObject({ fades: 1, overlaps: 2 });
    expect(count([["A", 0, 5, 0], ["B", 4, 5, 1]], false)).toMatchObject({ fades: 0, overlaps: 1 });
  });

  it("names the clips hidden over their whole span", () => {
    expect(count([["A", 0, 10, 0], ["B", 3, 2, 1]]).hidden).toEqual(["B"]);
    expect(count([["A", 0, 10, 0], ["B", 0, 3, 1]]).hidden).toEqual(["B"]);
    expect(count([["A", 2, 5, 0], ["B", 2, 5, 1]]).hidden).toEqual(["B"]);
    expect(count([["B", 2, 5, 0], ["A", 0, 5, 1]]).hidden).toEqual([]);
    expect(count(board).hidden).toEqual(["Clip 4"]);
    expect(count(board, false).hidden).toEqual(["Clip 4"]);
  });
});

describe("gainPieces", () => {
  it("is constant outside fades and matches envelopeAt inside them", () => {
    const rnd = lcg(19);
    let varying = 0;
    for (let i = 0; i < 150; i++) {
      const env = buildEnvelope(randomStack(rnd, 6), true);
      env.units.forEach((u, unit) => {
        const pieces = gainPieces(env, unit);
        expect(pieces[0].fromSec).toBe(u.start);
        expect(pieces[pieces.length - 1].toSec).toBe(u.start + u.length);
        for (const piece of pieces) {
          if (!("gain" in piece)) varying++;
          for (let k = 0; k < 100; k++) {
            const t = piece.fromSec + ((piece.toSec - piece.fromSec) * (k + 0.5)) / 100;
            const layer = envelopeAt(env, t).find((l) => l.unit === unit && !l.held);
            expect(Math.abs(gainPieceAt(piece, t) - (layer?.gain ?? 0))).toBeLessThan(1e-9);
          }
        }
      });
    }
    expect(varying).toBeGreaterThan(50);
  });

  it("is one piece of gain 1 with Crossfade off", () => {
    const n = named([["A", 0, 5, 0], ["B", 4, 5, 1]], false);
    expect(gainPieces(n.env, n.index.B)).toEqual([{ fromSec: 4, toSec: 9, gain: 1 }]);
  });
});

describe("placedCardItems", () => {
  it("gives the card's items", () => {
    expect(placedCardItems(named(board).env)).toEqual(["1 crossfade", "1 gap"]);
    expect(placedCardItems(named(board, false).env)).toEqual(["2 overlaps", "1 gap"]);
    expect(placedCardItems(named([["C", 4, 4, 0], ["B", 2, 4, 1], ["A", 0, 10, 2]]).env)).toEqual(["4 crossfades"]);
    expect(placedCardItems(named([["A", 0, 5, 0], ["B", 7, 5, 1], ["C", 13, 1, 2]]).env)).toEqual(["2 gaps"]);
    expect(placedCardItems(named([["A", 0, 5, 0], ["B", 4, 5, 1]], false).env)).toEqual(["1 overlap"]);
  });
});

describe("spansEnvelope over a timeline", () => {
  it("is the envelope of the non-empty spans", () => {
    const timeline: StitchTimelineClip[] = [
      createClip({ kind: "edge", edgeId: "a" }, { id: "a", inSec: 0.5 }),
      createClip({ kind: "edge", edgeId: "x" }, { id: "x" }),
      createClip({ kind: "asset", assetId: "asset-1" }, { id: "b" }),
    ];
    const spans = clipSpans(timeline, new Map([["edge:a", 5.5], ["asset:asset-1", 5]] as Array<[SourceKey, number]>), 1);
    const env = spansEnvelope(spans, true);
    expect(env.units).toEqual([
      { start: 0, length: 5, row: 0, source: "edge:a", inSec: 0.5 },
      { start: 4, length: 5, row: 2, source: "asset:asset-1", inSec: 0 },
    ]);
  });
});
