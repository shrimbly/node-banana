import { describe, it, expect, vi } from "vitest";
import type { VideoSample } from "mediabunny";
import { ClipReader, encodePlacedLoop, readerFrames, type PlacedClipSource } from "../clipReader";
import type { FrameBlender } from "../crossfadeFrames";
import { buildEnvelope, envelopeAt, SLOT_SEC, type PlacedUnit, type StackEnvelope } from "../placement";
import {
  maxVisibleLayers,
  nextBlendSlot,
  pictureSegments,
  readerRange,
  readerStart,
  routePlacement,
  segmentSlots,
  segmentsInLoop,
  segmentUnits,
  unitSlots,
  visibilityRuns,
  type Segment,
} from "../placedSchedule";
import { FrameSlotter, planSequence, secToSlot } from "../sequencePlan";
import { stackSequence } from "../stack";

// The placed encoder's plan. The configurations are the plan's §3.4.4 rows; the simulated encode runs the real walk
// (encodePlacedLoop and ClipReader) over fake decoders and checks every frame against Track's own slotter.

/** A named unit: [name, start, end, row, source = name, inSec = 0]. */
type Spec = [string, number, number, number, string?, number?];

function envOf(specs: readonly Spec[], crossfade = true): { env: StackEnvelope; names: string[] } {
  const units: PlacedUnit[] = specs.map(([name, start, end, row, source, inSec]) => ({
    start,
    length: end - start,
    row,
    source: source ?? name,
    inSec: inSec ?? 0,
  }));
  const env = buildEnvelope(units, crossfade);
  const names = env.units.map((u) => specs.find((s) => s[3] === u.row)![0]);
  return { env, names };
}

/** Segments as text: "solo A [0,4)", "blend A,B [4,5)" (bottom first), "black [5,6)". */
function describe_(specs: readonly Spec[], crossfade = true): string[] {
  const { env, names } = envOf(specs, crossfade);
  return pictureSegments(env).map((s) => {
    const span = `[${+s.fromSec.toFixed(4)},${+s.toSec.toFixed(4)})`;
    if (s.kind === "black") return `black ${span}`;
    if (s.kind === "solo") return `solo ${names[s.unit]} ${span}`;
    return `blend ${s.units.map((u) => names[u]).join(",")} ${span}`;
  });
}

describe("pictureSegments", () => {
  it.each<[string, Spec[], boolean, string[]]>([
    ["1 gap", [["A", 0, 5, 0], ["B", 6, 11, 1]], true, ["solo A [0,5)", "black [5,6)", "solo B [6,11)"]],
    ["4 neighbours", [["A", 0, 5, 0], ["B", 4, 9, 1]], true, ["solo A [0,4)", "blend B,A [4,5)", "solo B [5,9)"]],
    ["4 neighbours, B in front", [["B", 4, 9, 0], ["A", 0, 5, 1]], true, ["solo A [0,4)", "blend A,B [4,5)", "solo B [5,9)"]],
    ["5 long overlap", [["A", 0, 5, 0], ["B", 1, 6, 1]], true, ["solo A [0,4)", "blend B,A [4,5)", "solo B [5,6)"]],
    ["5 long overlap, B in front", [["B", 1, 6, 0], ["A", 0, 5, 1]], true, ["solo A [0,1)", "blend A,B [1,2)", "solo B [2,6)"]],
    ["6 front clip inside", [["B", 3, 5, 0], ["A", 0, 10, 1]], true, ["solo A [0,3)", "blend A,B [3,5)", "solo A [5,10)"]],
    ["6b lower clip inside", [["A", 0, 10, 0], ["B", 3, 5, 1]], true, ["solo A [0,10)"]],
    ["9 equal starts", [["B", 0, 3, 0], ["A", 0, 10, 1]], true, ["blend A,B [0,3)", "solo A [3,10)"]],
    ["9b equal starts, swapped", [["A", 0, 10, 0], ["B", 0, 3, 1]], true, ["solo A [0,10)"]],
    ["11 front starts later", [["B", 2, 7, 0], ["A", 0, 5, 1]], true, ["solo A [0,2)", "blend A,B [2,4)", "solo B [4,7)"]],
    ["11 off", [["B", 2, 7, 0], ["A", 0, 5, 1]], false, ["solo A [0,2)", "solo B [2,7)"]],
    ["12 front ends first", [["A", 0, 5, 0], ["B", 2, 7, 1]], true, ["solo A [0,3)", "blend B,A [3,5)", "solo B [5,7)"]],
    [
      "13 chained",
      [["A", 0, 6, 0], ["B", 2, 8, 1], ["C", 4, 10, 2]],
      true,
      ["solo A [0,2)", "blend B,A [2,6)", "blend C,B [6,8)", "solo C [8,10)"],
    ],
    [
      "13r chained, later on top",
      [["C", 4, 10, 0], ["B", 2, 8, 1], ["A", 0, 6, 2]],
      true,
      ["solo A [0,2)", "blend A,B [2,4)", "blend B,C [4,8)", "solo C [8,10)"],
    ],
    [
      "14 nested",
      [["C", 4, 8, 0], ["B", 2, 6, 1], ["A", 0, 10, 2]],
      true,
      ["solo A [0,2)", "blend A,B [2,4)", "blend A,B,C [4,6)", "blend A,C [6,8)", "solo A [8,10)"],
    ],
    [
      "14b a front clip over a gap",
      [["F", 2, 7, 0], ["A", 0, 4, 1], ["C", 5, 10, 2]],
      true,
      ["solo A [0,2)", "blend A,F [2,4)", "solo F [4,5)", "blend C,F [5,7)", "solo C [7,10)"],
    ],
    [
      "17c a split inside an overlap",
      [["X1", 4, 4.5, 0, "X"], ["X2", 4.5, 9, 1, "X", 0.5], ["A", 0, 5, 2]],
      true,
      ["solo A [0,4)", "blend A,X1 [4,4.5)", "blend A,X2 [4.5,5)", "solo X2 [5,9)"],
    ],
    ["20 a gap under a slot is dropped", [["A", 0, 5, 0], ["B", 5.01, 10.01, 1]], true, ["solo A [0,5)", "solo B [5.01,10.01)"]],
  ])("row %s", (_label, specs, crossfade, expected) => {
    expect(describe_(specs, crossfade)).toEqual(expected);
  });

  it("row 20b: the held clip blends under the front clip across the bridged gap, never the front clip alone", () => {
    const specs: Spec[] = [["F", 2, 7, 0], ["A", 0, 5, 1], ["C", 5.01, 10, 2]];
    expect(describe_(specs)).toEqual(["solo A [0,2)", "blend A,F [2,5.01)", "blend C,F [5.01,7)", "solo C [7,10)"]);
    const { env, names } = envOf(specs);
    const runs = visibilityRuns(pictureSegments(env), env.units.length, 0);
    // A's run covers slot 300, the gap's slot
    expect(runs[names.indexOf("A")]).toEqual([{ n0: 0, n1: 301 }]);
  });

  it("keeps a leading gap under a slot in loop 0 only", () => {
    const { env } = envOf([["A", 0.01, 5, 0]]);
    const segments = pictureSegments(env);
    expect(segments.map((s) => s.kind)).toEqual(["black", "solo"]);
    expect(segmentsInLoop(segments, 0)).toBe(segments);
    expect(segmentsInLoop(segments, 1).map((s) => s.kind)).toEqual(["solo"]);
    // A gap of a slot or more repeats each loop
    const wide = pictureSegments(envOf([["A", 1, 5, 0]]).env);
    expect(segmentsInLoop(wide, 2)).toBe(wide);
  });

  it("merges neighbours that show the same", () => {
    // B's fade in [3,4) and out [4,5) are one blend; an empty interval never splits a solo
    expect(describe_([["B", 3, 5, 0], ["A", 0, 10, 1]])).toHaveLength(3);
    expect(describe_([["A", 0, 5, 0], ["B", 5, 10, 1], ["C", 1, 9, 2]], false)).toEqual(["solo A [0,5)", "solo B [5,10)"]);
  });

  it("tiles [0, loopLength) in seconds and the slot grid at loop 0 and loop 2", () => {
    const { env } = envOf([["C", 4, 8.3, 0], ["B", 2.2, 6, 1], ["A", 0, 10.05, 2], ["D", 11, 12.5, 3]]);
    const segments = pictureSegments(env);
    expect(segments[0].fromSec).toBe(0);
    expect(segments[segments.length - 1].toSec).toBe(env.loopLength);
    segments.forEach((s, i) => {
      if (i > 0) expect(s.fromSec).toBe(segments[i - 1].toSec);
    });
    for (const loop of [0, 2]) {
      const L = loop * env.loopLength;
      const slots = segments.map((s) => segmentSlots(s, L));
      expect(slots[0].n0).toBe(secToSlot(L));
      expect(slots[slots.length - 1].n1).toBe(secToSlot(L + env.loopLength));
      slots.forEach((s, i) => {
        if (i > 0) expect(s.n0).toBe(slots[i - 1].n1);
      });
    }
  });
});

describe("segmentSlots and visibilityRuns", () => {
  it("skips a segment with no slot in one loop only, and joins the runs around it there", () => {
    // A loop of 300.5 slots: B's segment [1.0, 1.0125) owns slot 60 in loop 0 and no slot in loop 1
    const loopLength = 300.5 / 60;
    const { env, names } = envOf([["B", 1, 1.0125, 0], ["A", 0, loopLength, 1]], false);
    const segments = pictureSegments(env);
    const b = segments.find((s) => s.kind === "solo" && names[s.unit] === "B")!;
    expect(segmentSlots(b, 0)).toEqual({ n0: 60, n1: 61 });
    const L1 = env.loopLength;
    const { n0, n1 } = segmentSlots(b, L1);
    expect(n1 - n0).toBe(0);
    const a = names.indexOf("A");
    const loop0 = visibilityRuns(segments, env.units.length, 0);
    const loop1 = visibilityRuns(segments, env.units.length, L1);
    expect(loop0[a]).toEqual([{ n0: 0, n1: 60 }, { n0: 61, n1: secToSlot(env.loopLength) }]);
    expect(loop1[names.indexOf("B")]).toEqual([]);
    expect(loop1[a]).toEqual([{ n0: secToSlot(L1), n1: secToSlot(2 * L1) }]);
  });

  it("gives a clip hidden in the middle two runs per loop", () => {
    // F [2,8) over L [0,10): lead 2 and trail 2, so F is opaque over [4,6) and L hidden there
    const { env, names } = envOf([["F", 2, 8, 0], ["L", 0, 10, 1]]);
    const segments = pictureSegments(env);
    const l = names.indexOf("L");
    expect(visibilityRuns(segments, env.units.length, 0)[l]).toEqual([
      { n0: 0, n1: 240 },
      { n0: 360, n1: 600 },
    ]);
    expect(visibilityRuns(segments, env.units.length, env.loopLength)[l]).toEqual([
      { n0: 600, n1: 840 },
      { n0: 960, n1: 1200 },
    ]);
  });

  it("counts the most layers any segment shows", () => {
    expect(maxVisibleLayers(pictureSegments(envOf([["C", 4, 8, 0], ["B", 2, 6, 1], ["A", 0, 10, 2]]).env))).toBe(3);
    // placed-five: five visible over [4,5)
    const five: Spec[] = [
      ["C", 4, 10, 0],
      ["B1", 3.5, 8.5, 1, "B"],
      ["A1", 3, 8, 2, "A"],
      ["B2", 2.5, 7.5, 3, "B"],
      ["A2", 0, 5, 4, "A"],
    ];
    expect(maxVisibleLayers(pictureSegments(envOf(five).env))).toBe(5);
    // placed-gop1080-eight: eight visible over [2.8, 3.2)
    const eight: Spec[] = [2.8, 2.6, 2.4, 2.2, 2.0, 1.8, 1.6, 0].map((s, i) => [`${i}`, s, s + 5, i, i % 2 ? "A" : "B"]);
    expect(maxVisibleLayers(pictureSegments(envOf(eight).env))).toBe(8);
    // Crossfade off shows the top clip alone
    expect(maxVisibleLayers(pictureSegments(envOf(eight, false).env))).toBe(1);
  });

  it("names each segment's units, bottom first", () => {
    expect(segmentUnits({ kind: "black", fromSec: 0, toSec: 1 })).toEqual([]);
    expect(segmentUnits({ kind: "solo", unit: 2, fromSec: 0, toSec: 1 })).toEqual([2]);
    expect(segmentUnits({ kind: "blend", units: [3, 1], fromSec: 0, toSec: 1 })).toEqual([3, 1]);
  });
});

describe("readerRange and nextBlendSlot", () => {
  const clip = { inSec: 0.5, outSec: 4, origin: 0.5 };

  it("reads from In when the run starts on the anchor, else from the earliest time on its first slot", () => {
    expect(readerRange(clip, 120, { n0: 120, n1: 180 })).toEqual({ from: 0.5, to: 0.5 + 60.5 / 60 });
    const later = readerRange(clip, 120, { n0: 150, n1: 400 });
    expect(later.from).toBeCloseTo(0.5 + 29.5 / 60, 12);
    // Never past Out
    expect(later.to).toBe(4);
    // A run in the held tail, past the last frame before Out, starts at Out
    expect(readerRange(clip, 120, { n0: 340, n1: 345 })).toEqual({ from: 4, to: 4 });
  });

  it("starts a partway reader a slot before the slot of the frame in effect, never before In", () => {
    const from = 0.5 + 29.5 / 60;
    // In effect: a frame on slot 149 (the run starts on 150): from the earliest time on 148
    expect(readerStart(from, 0.5 + 28.8 / 60, clip, 120)).toBeCloseTo(0.5 + 27.5 / 60, 12);
    // A frame held from slot 140 (a clip's tail, a long gap): from 139
    expect(readerStart(from, 0.5 + 20 / 60, clip, 120)).toBeCloseTo(0.5 + 18.5 / 60, 12);
    // A frame before the origin: from In
    expect(readerStart(from, 0.2, clip, 120)).toBe(0.5);
    // Unknown, or a reader from In: as it was
    expect(readerStart(from, null, clip, 120)).toBe(from);
    expect(readerStart(0.5, 0.4, clip, 120)).toBe(0.5);
  });

  it("writes on the next change, at least every 3 slots, every slot without a rate, never past the end", () => {
    expect(nextBlendSlot(10, 12, 100, false)).toBe(12);
    expect(nextBlendSlot(10, 40, 100, false)).toBe(13);
    expect(nextBlendSlot(10, Infinity, 100, false)).toBe(13);
    expect(nextBlendSlot(10, 10, 100, false)).toBe(11);
    expect(nextBlendSlot(10, 40, 100, true)).toBe(11);
    expect(nextBlendSlot(10, 40, 12, false)).toBe(12);
  });
});

describe("routePlacement", () => {
  const plans = planSequence([
    { inSec: 0, outSec: null, sourceDuration: 5 },
    { inSec: 0, outSec: null, sourceDuration: 5 },
  ]).clips;
  const sources = ["a", "b"];
  const placement = (overlapSec: number) => ({ crossfade: true, overlapSec });

  it("keeps today's rule without a placement", () => {
    expect(routePlacement(plans, sources, [0, 3], null, null)).toEqual({ kind: "track" });
    expect(routePlacement(plans, sources, [], null, { overlapSec: 1, crossfade: true })).toEqual({ kind: "derived" });
    // A stack of cuts is Track
    expect(routePlacement(plans, ["a", "a"], [], null, { overlapSec: 1, crossfade: true })).toEqual({ kind: "track" });
  });

  it("routes starts equal to Track's to Track, and starts equal to the lined-up layout to the commit-9 branch", () => {
    expect(routePlacement(plans, sources, [0, 5], placement(1), { overlapSec: 1, crossfade: true })).toEqual({ kind: "track" });
    expect(routePlacement(plans, sources, [0, 4], placement(1), { overlapSec: 1, crossfade: true })).toEqual({ kind: "derived" });
    // An unpinned clip resolves to the lined-up layout
    expect(routePlacement(plans, sources, [0, undefined], placement(1), null)).toEqual({ kind: "derived" });
    expect(routePlacement(plans, sources, [undefined, undefined], placement(0), null)).toEqual({ kind: "track" });
  });

  it("never routes to the commit-9 branch with Overlap 0, and a start 1e-6 off is placed", () => {
    expect(routePlacement(plans, sources, [0, 4], placement(0), null)).toEqual({ kind: "placed", starts: [0, 4] });
    expect(routePlacement(plans, sources, [0, 4 + 1e-6], placement(1), null)).toEqual({ kind: "placed", starts: [0, 4 + 1e-6] });
    expect(routePlacement(plans, sources, [0, 5 + 1e-6], placement(1), null)).toEqual({ kind: "placed", starts: [0, 5 + 1e-6] });
    expect(routePlacement(plans, sources, [4, 0], placement(1), null)).toEqual({ kind: "placed", starts: [4, 0] });
  });

  it("matches stackSequence's own layout exactly when it routes derived", () => {
    const three = planSequence([2, 6, 3].map((d) => ({ inSec: 0, outSec: null, sourceDuration: d }))).clips;
    const derived = stackSequence(three, ["a", "b", "c"], { overlapSec: 1.5, crossfade: true });
    const starts = derived.clips.map((c) => c.seqStart);
    expect(routePlacement(three, ["a", "b", "c"], starts, placement(1.5), null)).toEqual({ kind: "derived" });
  });
});

// ---- A simulated placed encode: the real walk over fake decoders ----

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

/** A synthetic source: its frame times, in decode order. */
interface FakeSource {
  id: string;
  times: number[];
  /** The rate the probe reports; null when unknown. */
  rate: number | null;
  duration: number;
}

interface FakeFrame {
  source: string;
  index: number;
  timestamp: number;
  of?: FakeFrame;
  close: () => void;
  clone: () => FakeFrame;
  setTimestamp: (t: number) => void;
  setDuration: (d: number) => void;
  codedWidth: number;
  codedHeight: number;
  format: string;
  colorSpace: Record<string, unknown>;
}

/** Every fake frame not yet closed, and every decoder not yet returned. */
class Ledger {
  open = new Set<FakeFrame>();
  decoders = new Set<object>();
  frame(source: string, index: number, timestamp: number, of?: FakeFrame): FakeFrame {
    const f: FakeFrame = {
      source,
      index,
      timestamp,
      of,
      codedWidth: 64,
      codedHeight: 36,
      format: "NV12",
      colorSpace: {},
      close: () => {
        this.open.delete(f);
      },
      clone: () => this.frame(source, index, f.timestamp, f.of ?? f),
      setTimestamp: (t) => {
        f.timestamp = t;
      },
      setDuration: () => {},
    };
    this.open.add(f);
    return f;
  }
  /** samples(from, to) on an all-key-frame stream: the frame in effect at from, then every frame before to. */
  samples(src: FakeSource, from: number, to: number): AsyncIterator<VideoSample, void, unknown> {
    const inEffect = src.times.reduce((found, t, i) => (t <= from ? i : found), -1);
    const indices = src.times.flatMap((t, i) => (i === inEffect || (t > from && t < to) ? [i] : []));
    const handle = {};
    this.decoders.add(handle);
    const make = (i: number) => this.frame(src.id, i, src.times[i]) as unknown as VideoSample;
    const stop = () => this.decoders.delete(handle);
    async function* run() {
      try {
        for (const i of indices) yield make(i);
      } finally {
        stop();
      }
    }
    return run();
  }
}

interface SimUnit {
  source: FakeSource;
  inSec: number;
  outSec: number;
  start: number;
}

interface Written {
  slot: number;
  kind: "black" | "frame" | "composite";
  /** Per unit shown: the frame index (null when its layer had no frame). */
  shows: Map<number, number | null>;
  /** A composite's weight per unit, as the walk passed it to composite(). */
  weights?: Map<number, number>;
}

/** Plans the units as planSequence would, builds the envelope and runs the real walk for every loop. */
async function simulate(units: readonly SimUnit[], crossfade: boolean, loops: number) {
  const ledger = new Ledger();
  const planned = units.map((u) => {
    const first = u.source.times[0] ?? 0;
    return { inSec: u.inSec, outSec: u.outSec, origin: Math.max(u.inSec, first), length: u.outSec - u.inSec };
  });
  const env = buildEnvelope(
    units.map((u, k) => ({ start: u.start, length: planned[k].length, row: k, source: u.source.id, inSec: u.inSec })),
    crossfade,
  );
  const segments = pictureSegments(env);
  const slotter = new FrameSlotter(60);
  const written: Written[] = [];
  const unitOfFrame = (frame: FakeFrame, layers: number[]) => layers.find((u) => units[u].source.id === frame.source);
  let current: Segment | null = null;
  const blender: FrameBlender = {
    blend: vi.fn(),
    composite: vi.fn(async (layers: ReadonlyArray<{ sample: VideoSample | null; weight: number }>, timestamp: number) => {
      const units_ = current && current.kind === "blend" ? current.units : [];
      const shows = new Map<number, number | null>();
      const weights = new Map<number, number>();
      layers.forEach((layer, k) => {
        shows.set(units_[k], (layer.sample as unknown as FakeFrame | null)?.index ?? null);
        weights.set(units_[k], layer.weight);
      });
      const out = ledger.frame("composite", -1, timestamp);
      Object.assign(out, { shows, weights });
      return out as unknown as VideoSample;
    }),
    black: vi.fn((timestamp: number) => {
      const out = ledger.frame("black", -1, timestamp);
      return out as unknown as VideoSample;
    }),
  };
  const sources: PlacedClipSource[] = units.map((u, k) => ({
    inSec: planned[k].inSec,
    outSec: planned[k].outSec,
    origin: planned[k].origin,
    frameRate: u.source.rate,
    // As openClipReader opens one: the frame in effect at a partway start is looked up first (a packet's timestamp)
    open: (range, window) =>
      new ClipReader(
        readerFrames(
          range,
          window,
          planned[k].inSec,
          async (sec) => {
            const i = u.source.times.reduce((found, t, j) => (t <= sec ? j : found), -1);
            return i === -1 ? null : u.source.times[i];
          },
          (from, to) => ({ [Symbol.asyncIterator]: () => ledger.samples(u.source, from, to) }),
        ),
        window,
      ),
  }));
  const state = { ref: null, blender: null };
  const opened: Array<{ loop: number; unit: number }> = [];
  for (let loop = 0; loop < loops; loop++) {
    await encodePlacedLoop({
      env,
      segments: segmentsInLoop(segments, loop),
      loop,
      sources: sources.map((s, unit) => ({
        ...s,
        open: (range, window) => {
          opened.push({ loop, unit });
          return s.open(range, window);
        },
      })),
      state,
      fallbackRef: { width: 64, height: 36 },
      makeBlender: () => blender,
      claim: (slot) => slotter.claim(slot),
      add: async (sample) => {
        const f = sample as unknown as FakeFrame & { shows?: Map<number, number | null>; weights?: Map<number, number> };
        const slot = Math.round(f.timestamp * 60);
        if (f.source === "black") written.push({ slot, kind: "black", shows: new Map() });
        else if (f.source === "composite") written.push({ slot, kind: "composite", shows: f.shows!, weights: f.weights });
        else {
          const unit = current && current.kind === "solo" ? current.unit : unitOfFrame(f, []);
          written.push({ slot, kind: "frame", shows: new Map([[unit!, f.index]]) });
        }
      },
      report: (segment) => {
        current = segment;
      },
      failure: (_unit, error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }
  return { env, segments, written, ledger, opened, blender };
}

/** What Track's own slotter puts on each slot for unit k in the loop at L: [slot, frame index], from In to Out. */
function trackFrames(env: StackEnvelope, unit: SimUnit, k: number, L: number): Array<[number, number]> {
  const src = unit.source;
  const origin = Math.max(unit.inSec, src.times[0] ?? 0);
  const { anchor, end } = unitSlots(env, k, L);
  const slotter = new FrameSlotter(60);
  slotter.beginRange({ origin, fromSec: anchor / 60, toSec: end / 60 });
  const out: Array<[number, number]> = [];
  const put = (i: number) => {
    const at = slotter.place(src.times[i]);
    if (at !== null) out.push([Math.round(at * 60), i]);
  };
  const inEffect = src.times.reduce((found, t, i) => (t <= unit.inSec ? i : found), -1);
  const stream = src.times.flatMap((t, i) => (i === inEffect || (t > unit.inSec && t < unit.outSec) ? [i] : []));
  let held: number | null = null;
  for (const i of stream) {
    if (src.times[i] < origin) {
      held = i;
      continue;
    }
    if (held !== null && !slotter.takesFirstSlot(src.times[i])) put(held);
    held = null;
    put(i);
  }
  if (held !== null) put(held);
  return out;
}

/** Every rule of the walk, for one simulated encode; returns the problems found. */
function problems(units: readonly SimUnit[], result: Awaited<ReturnType<typeof simulate>>, loops: number): string[] {
  const { env, segments, written, ledger } = result;
  const found: string[] = [];
  if (ledger.open.size > 0) found.push(`${ledger.open.size} frames left open`);
  if (ledger.decoders.size > 0) found.push(`${ledger.decoders.size} decoders not returned`);
  written.forEach((w, i) => {
    if (i > 0 && !(w.slot > written[i - 1].slot)) found.push(`slot ${w.slot} after ${written[i - 1].slot}`);
  });
  const writtenAt = new Map(written.map((w) => [w.slot, w]));
  for (let loop = 0; loop < loops; loop++) {
    const L = loop * env.loopLength;
    const segs = segmentsInLoop(segments, loop).filter((s) => {
      const { n0, n1 } = segmentSlots(s, L);
      return n1 > n0;
    });
    const expected = units.map((u, k) => trackFrames(env, u, k, L));
    const frameOn = (k: number, n: number) => {
      let found_: number | null = null;
      for (const [slot, i] of expected[k]) if (slot <= n) found_ = i;
      return found_;
    };
    const lastShown = new Map<number, { slot: number; index: number; run: number }>();
    const runs = visibilityRuns(segs, env.units.length, L);
    const runOf = (k: number, n: number) => runs[k].findIndex((r) => r.n0 <= n && n < r.n1);
    segs.forEach((segment, si) => {
      const { n0, n1 } = segmentSlots(segment, L);
      if (si > 0) {
        const before = segmentSlots(segs[si - 1], L).n1;
        // Only a dropped black under a slot may leave a slot between segments
        if (n0 !== before && !(n0 - before === 1)) found.push(`loop ${loop}: slots ${before}..${n0} unowned`);
      }
      if (!writtenAt.has(n0)) found.push(`loop ${loop}: segment ${segment.kind} at ${n0} not written on its first slot`);
      // Visible units have a share of the picture between every two breakpoints of the segment; the other live ones none
      const visible = segmentUnits(segment);
      const cuts = [segment.fromSec, ...env.breakpoints.filter((b) => b > segment.fromSec + 1e-9 && b < segment.toSec - 1e-9), segment.toSec];
      for (let c = 0; c + 1 < cuts.length; c++) {
        const mid = (cuts[c] + cuts[c + 1]) / 2;
        const weights = new Map(envelopeAt(env, mid).map((layer) => [layer.unit, layer.weight]));
        visible.forEach((u) => {
          if (!((weights.get(u) ?? 0) > 0)) found.push(`loop ${loop}: unit ${u} visible at ${mid} with weight 0`);
        });
        weights.forEach((w, u) => {
          if (!visible.includes(u) && w > 1e-9) found.push(`loop ${loop}: unit ${u} hidden at ${mid} with weight ${w}`);
        });
      }
      const inside = written.filter((w) => w.slot >= n0 && w.slot < n1);
      if (segment.kind === "blend") {
        inside.forEach((w, i) => {
          const next = inside[i + 1]?.slot ?? n1;
          if (next - w.slot > 3) found.push(`loop ${loop}: blend writes ${w.slot} then ${next}`);
          // Its weights are the envelope's at the middle of the frame's display interval, in this loop, kept inside the
          // segment, on the segment's units; they make up the whole picture
          const at = Math.min(Math.max((w.slot + next) / 2 / 60 - L, segment.fromSec), segment.toSec - 2e-9);
          const want = new Map(envelopeAt(env, at).map((layer) => [layer.unit, layer.weight]));
          let sum = 0;
          for (const u of visible) {
            const got = w.weights?.get(u) ?? 0;
            sum += got;
            if (Math.abs(got - (want.get(u) ?? 0)) > 1e-9) found.push(`loop ${loop}: unit ${u} weighs ${got} on ${w.slot}, envelope ${want.get(u) ?? 0}`);
          }
          if (Math.abs(sum - 1) > 1e-6) found.push(`loop ${loop}: weights on ${w.slot} sum to ${sum}`);
        });
      }
      for (const w of inside) {
        if (segment.kind === "black" ? w.kind !== "black" : w.kind === "black") found.push(`loop ${loop}: ${w.kind} at ${w.slot} in ${segment.kind}`);
        for (const u of visible) {
          const shown = w.shows.get(u);
          const want = frameOn(u, w.slot);
          if ((shown ?? null) !== want) found.push(`loop ${loop}: unit ${u} shows ${shown} on ${w.slot}, Track's slotter ${want}`);
          if (shown === undefined || shown === null) continue;
          const position = expected[u].findIndex(([, i]) => i === shown);
          const prev = lastShown.get(u);
          const run = runOf(u, w.slot);
          if (prev && position < prev.index) found.push(`loop ${loop}: unit ${u} went back at ${w.slot}`);
          if (prev && prev.run === run && position > prev.index + 1) found.push(`loop ${loop}: unit ${u} skipped at ${w.slot}`);
          lastShown.set(u, { slot: w.slot, index: position, run });
        }
      }
    });
  }
  return found;
}

const RATES = [1, 10, 23.976, 24, 25, 30, 60];

/** Sources above 60 fps put two frames on one slot; with jitter, timestamps are uneven by up to ±0.2 of a frame. */
interface SourceMix {
  rates: readonly number[];
  jitter: number;
}
const PLAIN: SourceMix = { rates: RATES, jitter: 0 };

function randomSource(rnd: () => number, id: string, mix: SourceMix = PLAIN): FakeSource {
  const fps = mix.rates[Math.floor(rnd() * mix.rates.length)];
  const first = rnd() < 0.3 ? rnd() * 0.05 : 0;
  const count = Math.max(2, Math.floor(fps * (1 + rnd() * 5)));
  const times = Array.from({ length: count }, (_, j) => first + (j + (j > 0 ? (rnd() - 0.5) * 2 * mix.jitter : 0)) / fps);
  return { id, times, rate: rnd() < 0.05 ? null : fps, duration: first + count / fps };
}

/** One random placed stack: trims, gaps (some under a slot), insides, near-misses of a fraction of a slot, split runs. */
function randomCase(rnd: () => number, mix: SourceMix = PLAIN): { units: SimUnit[]; crossfade: boolean; loops: number } {
  const count = 2 + Math.floor(rnd() * 4);
  const grid = rnd() < 0.5 ? 1 / 120 : 0;
  const q = (x: number) => (grid ? Math.round(x / grid) * grid : x);
  const units: SimUnit[] = [];
  for (let k = 0; k < count; k++) {
    const prev = units[k - 1];
    if (prev && rnd() < 0.2 && prev.outSec < prev.source.duration - 0.3) {
      // The next piece of a split, its join off by under half a slot
      const miss = (rnd() - 0.5) * 0.9 * SLOT_SEC;
      const inSec = prev.outSec + (rnd() - 0.5) * 0.9 * SLOT_SEC * 0.5;
      const start = prev.start + (prev.outSec - prev.inSec) + miss;
      const outSec = Math.min(prev.source.duration, inSec + 0.3 + rnd() * 2);
      if (outSec - inSec > 1 / 60 && inSec > 0) {
        units.push({ source: prev.source, inSec, outSec, start: Math.max(0, start) });
        continue;
      }
    }
    const source = randomSource(rnd, `s${k}`, mix);
    const inSec = rnd() < 0.5 ? q(rnd() * source.duration * 0.3) : 0;
    let outSec = rnd() < 0.5 ? q(inSec + (source.duration - inSec) * (0.5 + rnd() * 0.5)) : source.duration;
    outSec = Math.min(outSec, source.duration);
    if (outSec - inSec < 2 / 60) outSec = source.duration;
    const length = outSec - inSec;
    let start: number;
    const other = units[Math.floor(rnd() * units.length)];
    const pick = rnd();
    if (!other || pick < 0.35) start = q(rnd() * 6);
    else if (pick < 0.55) start = Math.max(0, other.start + (other.outSec - other.inSec) + (rnd() - 0.5) * 2 * SLOT_SEC);
    else if (pick < 0.7) start = Math.max(0, other.start + (rnd() - 0.5) * 2 * SLOT_SEC);
    else if (pick < 0.85) start = Math.max(0, other.start + (other.outSec - other.inSec) - length + (rnd() - 0.5) * 2 * SLOT_SEC);
    else start = q(other.start + rnd() * (other.outSec - other.inSec));
    units.push({ source, inSec, outSec, start });
  }
  return { units, crossfade: rnd() < 0.7, loops: 1 + Math.floor(rnd() * 3) };
}

describe("a simulated placed encode", () => {
  it("shows Track's frame on every written slot, writes every segment's first slot and never leaks a frame, over 400 seeded stacks", async () => {
    const rnd = mulberry32(41);
    let blends = 0;
    for (let trial = 0; trial < 400; trial++) {
      const { units, crossfade, loops } = randomCase(rnd);
      const result = await simulate(units, crossfade, loops);
      blends += result.segments.filter((s) => s.kind === "blend").length;
      expect(problems(units, result, loops), `trial ${trial}`).toEqual([]);
    }
    expect(blends).toBeGreaterThan(200);
  });

  it("shows Track's frame where a clip shows again, from sources above 60 fps or with uneven timestamps, over 1000 seeded stacks", async () => {
    // Two frames on one slot: Track keeps the first, and a reader opened partway in must count that slot's frames as Track
    // does, also when the frame in effect is held (a clip's tail), and never count one past Out. Trials 28, 432 and 924
    // of this seed failed while a reader started on its run's first slot
    const rnd = mulberry32(99);
    for (let trial = 0; trial < 1000; trial++) {
      const mix: SourceMix = trial % 2 === 0 ? { rates: [90, 120, 240], jitter: 0 } : { rates: [24, 30, 60, 90, 120], jitter: 0.2 };
      const { units, crossfade, loops } = randomCase(rnd, mix);
      const result = await simulate(units, crossfade, loops);
      expect(problems(units, result, loops), `trial ${trial}`).toEqual([]);
    }
  }, 30_000);

  it("opens one decoder per visibility run per loop", async () => {
    const source = (id: string): FakeSource => ({ id, times: Array.from({ length: 240 }, (_, j) => j / 24), rate: 24, duration: 10 });
    // F [2,8) over L [0,10): L is hidden over [4,6), so it is read twice per loop
    const units: SimUnit[] = [
      { source: source("F"), inSec: 0, outSec: 6, start: 2 },
      { source: source("L"), inSec: 0, outSec: 10, start: 0 },
    ];
    const result = await simulate(units, true, 2);
    expect(problems(units, result, 2)).toEqual([]);
    expect(result.opened).toEqual([
      { loop: 0, unit: 1 },
      { loop: 0, unit: 0 },
      { loop: 0, unit: 1 },
      { loop: 1, unit: 1 },
      { loop: 1, unit: 0 },
      { loop: 1, unit: 1 },
    ]);
  });

  it("holds the lower clip's last frame across a bridged gap under a fading front clip (row 20b)", async () => {
    const at24 = (id: string, seconds: number): FakeSource => ({
      id,
      times: Array.from({ length: seconds * 24 }, (_, j) => j / 24),
      rate: 24,
      duration: seconds,
    });
    const units: SimUnit[] = [
      { source: at24("F", 5), inSec: 0, outSec: 5, start: 2 },
      { source: at24("A", 5), inSec: 0, outSec: 5, start: 0 },
      { source: at24("C", 5), inSec: 0, outSec: 4.99, start: 5.01 },
    ];
    const result = await simulate(units, true, 1);
    expect(problems(units, result, 1)).toEqual([]);
    const slot300 = result.written.find((w) => w.slot === 300)!;
    expect(slot300.kind).toBe("composite");
    // A's last frame, under F
    expect(slot300.shows.get(1)).toBe(119);
    expect(slot300.shows.has(0)).toBe(true);
  });

  it("keeps a lower clip's share on the last slot of a blend that ends on a half slot", async () => {
    const source = (id: string, fps: number, count: number): FakeSource => ({
      id,
      times: Array.from({ length: count }, (_, j) => j / fps),
      rate: fps,
      duration: count / fps,
    });
    // A, 121 frames at 24 fps, ends at 297.5 slots, butt against C, both under F fading in and out over [2,7)
    const units: SimUnit[] = [
      { source: source("F", 30, 150), inSec: 0, outSec: 5, start: 2 },
      { source: source("A", 24, 121), inSec: 0, outSec: 121 / 24, start: 0 },
      { source: source("C", 24, 144), inSec: 0, outSec: 10 - 121 / 24, start: 121 / 24 },
    ];
    const result = await simulate(units, true, 1);
    expect(problems(units, result, 1)).toEqual([]);
    const last = result.written.filter((w) => w.kind === "composite" && w.shows.has(1)).at(-1)!;
    expect(last.slot).toBe(302);
    // Not F alone at full: A keeps about a third of the picture
    expect(last.weights!.get(1)).toBeGreaterThan(0.3);
    expect(last.weights!.get(0)).toBeLessThan(0.7);
  });

  it("asks for the file's first frame in the reference's own format when a blend opens it, and only that one", async () => {
    const at24 = (id: string, seconds: number): FakeSource => ({
      id,
      times: Array.from({ length: seconds * 24 }, (_, j) => j / 24),
      rate: 24,
      duration: seconds,
    });
    // B 0–3 over A 0–10: B starts at full and fades out from 0, so the loop opens on a blend
    const units: SimUnit[] = [
      { source: at24("B", 3), inSec: 0, outSec: 3, start: 0 },
      { source: at24("A", 10), inSec: 0, outSec: 10, start: 0 },
    ];
    const result = await simulate(units, true, 2);
    expect(problems(units, result, 2)).toEqual([]);
    expect(result.written[0]).toMatchObject({ slot: 0, kind: "composite" });
    const opts = vi.mocked(result.blender.composite).mock.calls.map((call) => call[3]);
    expect(opts[0]).toEqual({ inRefFormat: true });
    expect(opts.slice(1).every((o) => o?.inRefFormat === false)).toBe(true);
    expect(opts.length).toBeGreaterThan(10);
  });

  it("weighs a dissolve in the second loop as in the first", async () => {
    const at24 = (id: string): FakeSource => ({ id, times: Array.from({ length: 120 }, (_, j) => j / 24), rate: 24, duration: 5 });
    // A [0,5) in front of B [4,9): a dissolve over [4,5) in each 9 s loop
    const units: SimUnit[] = [
      { source: at24("A"), inSec: 0, outSec: 5, start: 0 },
      { source: at24("B"), inSec: 0, outSec: 5, start: 4 },
    ];
    const result = await simulate(units, true, 2);
    expect(problems(units, result, 2)).toEqual([]);
    const shares = (from: number, to: number) =>
      result.written.filter((w) => w.kind === "composite" && w.slot >= from && w.slot < to).map((w) => w.weights!.get(1)!);
    const first = shares(240, 300);
    const second = shares(540 + 240, 540 + 300);
    expect(second.length).toBe(first.length);
    second.forEach((share, i) => expect(share).toBeCloseTo(first[i], 9));
    expect(Math.max(...second)).toBeGreaterThan(0.9);
  });

  it("writes a blend at least every 3 slots while a source holds one frame for 2 s", async () => {
    // B shows one frame from 0.5 s to 2.5 s
    const holder: FakeSource = { id: "B", times: [0, 0.5, 2.5, 3], rate: 24, duration: 3.5 };
    const steady: FakeSource = { id: "A", times: Array.from({ length: 12 }, (_, j) => j / 2), rate: 24, duration: 6 };
    const units: SimUnit[] = [
      { source: holder, inSec: 0, outSec: 3.5, start: 1 },
      { source: steady, inSec: 0, outSec: 6, start: 0 },
    ];
    const result = await simulate(units, true, 1);
    expect(problems(units, result, 1)).toEqual([]);
    const blends = result.segments.filter((s) => s.kind === "blend");
    expect(blends).toHaveLength(2);
    for (const blend of blends) {
      const { n0, n1 } = segmentSlots(blend, 0);
      const slots = result.written.filter((w) => w.slot >= n0 && w.slot < n1).map((w) => w.slot);
      expect(slots[0]).toBe(n0);
      expect(slots.length).toBeGreaterThanOrEqual(Math.ceil((n1 - n0) / 3));
      slots.forEach((slot, i) => {
        if (i > 0) expect(slot - slots[i - 1]).toBeLessThanOrEqual(3);
      });
    }
  });

  it("starts a loop that opens on black with one black frame per gap, after reading the first visible clip's frame", async () => {
    const at24 = (id: string): FakeSource => ({ id, times: Array.from({ length: 120 }, (_, j) => j / 24), rate: 24, duration: 5 });
    const units: SimUnit[] = [
      { source: at24("A"), inSec: 0, outSec: 5, start: 1 },
      { source: at24("B"), inSec: 0, outSec: 5, start: 7 },
    ];
    const result = await simulate(units, true, 2);
    expect(problems(units, result, 2)).toEqual([]);
    expect(result.written.filter((w) => w.kind === "black").map((w) => w.slot)).toEqual([0, 360, 720, 1080]);
  });
});
