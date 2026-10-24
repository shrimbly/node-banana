import { describe, it, expect } from "vitest";
import { FrameSlotter, planSequence, type PlannedClip } from "../sequencePlan";
import {
  DEFAULT_SEQUENCE_LAYOUT,
  clampOverlapSec,
  clipFadeSamples,
  crossfadeGain,
  dissolveFrames,
  effectiveOverlapSec,
  floorToSlot,
  joinOverlaps,
  sharedCadence,
  cadenceRate,
  MIN_CADENCE_RATE,
  soloPass,
  stackSequence,
  type StackItem,
} from "../stack";

const item = (length: number, source: string): StackItem => ({ length, source });
const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;

/** Clips of these lengths, each its own whole source starting at 0. */
const planned = (...lengths: number[]) =>
  planSequence(lengths.map((sourceDuration) => ({ inSec: 0, outSec: null, sourceDuration }))).clips;

/** A deterministic PRNG (mulberry32), so the property tests never flake. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("clampOverlapSec, effectiveOverlapSec and floorToSlot", () => {
  it("clamps to 0–10 and rounds to 0.1 s; anything not finite is the default", () => {
    expect(clampOverlapSec(0.25)).toBe(0.3);
    expect(clampOverlapSec(1.04)).toBe(1);
    expect(clampOverlapSec(12)).toBe(10);
    expect(clampOverlapSec(-1)).toBe(0);
    expect(clampOverlapSec(Number.NaN)).toBe(1);
    expect(clampOverlapSec(Infinity)).toBe(1);
  });

  it("uses the overlap only when stacked", () => {
    expect(effectiveOverlapSec({ ...STACKED, overlapSec: 2 })).toBe(2);
    expect(effectiveOverlapSec({ ...STACKED, mode: "track", overlapSec: 2 })).toBe(0);
    expect(effectiveOverlapSec(DEFAULT_SEQUENCE_LAYOUT)).toBe(0);
  });

  it("rounds down to whole 60 fps slots", () => {
    expect(floorToSlot(1.3 / 2)).toBe(0.65);
    expect(floorToSlot(0.0125)).toBe(0);
    expect(floorToSlot(1 / 60)).toBe(1 / 60);
    expect(floorToSlot(Number.NaN)).toBe(0);
    expect(floorToSlot(-1)).toBe(0);
  });
});

describe("joinOverlaps", () => {
  it("overlaps every join by the setting", () => {
    expect(joinOverlaps([item(5, "a"), item(5, "b"), item(6, "c")], 1)).toEqual([0, 1, 1]);
  });

  it("caps a join at half of either clip, in whole slots", () => {
    expect(joinOverlaps([item(5, "a"), item(1.5, "b")], 3)).toEqual([0, 0.75]);
    expect(joinOverlaps([item(5, "a"), item(1.3, "b")], 3)).toEqual([0, 0.65]);
    expect(joinOverlaps([item(5, "a"), item(0.025, "b")], 3)).toEqual([0, 0]);
  });

  it("gives all zeros without an overlap", () => {
    const items = [item(5, "a"), item(5, "b")];
    for (const o of [0, Number.NaN, -1, -Infinity]) expect(joinOverlaps(items, o)).toEqual([0, 0]);
  });

  it("skips an empty clip: the clips either side of it are joined", () => {
    expect(joinOverlaps([item(5, "a"), item(0, "x"), item(5, "b")], 1)).toEqual([0, 0, 1]);
  });

  it("cuts between adjacent pieces of the same source", () => {
    expect(joinOverlaps([item(5, "a"), item(5, "a")], 1)).toEqual([0, 0]);
  });

  it("caps by the runs and by the touching pieces", () => {
    // A | B1 B2 | C: the run B is 5 s, but B1 alone is 1 s
    expect(joinOverlaps([item(5, "a"), item(1, "b"), item(4, "b"), item(5, "c")], 3)).toEqual([0, 1, 0, 2.5]);
  });

  it("does not change any overlap when a clip is split outside its overlaps", () => {
    expect(joinOverlaps([item(5, "a"), item(6, "b"), item(5, "c")], 1)).toEqual([0, 1, 1]);
    expect(joinOverlaps([item(5, "a"), item(2.5, "b"), item(3.5, "b"), item(5, "c")], 1)).toEqual([0, 1, 0, 1]);
  });

  it("steps an overlap down a slot when the float epsilon lifts it past a cap", () => {
    // 0.7 − 0.4 = 0.29999999999999993: half of it floors to 0.15 only through the epsilon, and 0.15 + 0.15 > the clip
    const len = 0.7 - 0.4;
    const o = joinOverlaps([item(5, "a"), item(len, "b"), item(5, "c")], 1);
    expect(o[1] + o[2]).toBeLessThanOrEqual(len);
    expect(o[1]).toBe(8 / 60);
    expect(o[2]).toBe(8 / 60);
  });

  it("never lets two overlaps sum past a run, or three clips play at once", () => {
    const next = random(9);
    for (let round = 0; round < 300; round++) {
      const count = 2 + Math.floor(next() * 7);
      const items = Array.from({ length: count }, () =>
        item(
          next() < 0.15
            ? 0
            : next() < 0.5
              ? next() * 6
              : // In and Out in tenths of a second: lengths whose halves sit a float hair under a slot boundary
                Math.floor(next() * 60) / 10 - Math.floor(next() * 30) / 10 || 0.1,
          "abc"[Math.floor(next() * 3)],
        ),
      );
      const overlapSec = next() * 4;
      const o = joinOverlaps(items, overlapSec);

      // Runs over the non-empty items: o_in + o_out <= the run, exactly
      const filled = items.map((it, i) => ({ ...it, i })).filter((it) => it.length > 0);
      let runStart = 0;
      for (let n = 1; n <= filled.length; n++) {
        if (n < filled.length && filled[n].source === filled[n - 1].source) continue;
        const run = filled.slice(runStart, n);
        const length = run.reduce((sum, it) => sum + it.length, 0);
        const oIn = o[run[0].i];
        const oOut = n < filled.length ? o[filled[n].i] : 0;
        expect(oIn + oOut).toBeLessThanOrEqual(length);
        runStart = n;
      }

      // Laid out as clipSpans does: never three live at once
      let cursor = 0;
      const spans = filled.map((it) => {
        const start = cursor - o[it.i];
        cursor = start + it.length;
        return { start, end: cursor };
      });
      const bounds = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
      for (let k = 1; k < bounds.length; k++) {
        const t = (bounds[k - 1] + bounds[k]) / 2;
        expect(spans.filter((s) => s.start <= t && t < s.end).length).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe("stackSequence", () => {
  const sources = ["a", "b", "c"];

  it("dissolves across each overlap, crossfade on", () => {
    const plan = stackSequence(planned(5, 5, 6), sources, { overlapSec: 1, crossfade: true });
    expect(plan.loopLength).toBe(14);
    expect(plan.clips.map((c) => c.seqStart)).toEqual([0, 4, 8]);
    expect(plan.clips.map((c) => [c.overlapIn, c.overlapOut])).toEqual([
      [0, 1],
      [1, 1],
      [1, 0],
    ]);
    expect(plan.clips.map((c) => [c.soloStart, c.soloEnd])).toEqual([
      [0, 4],
      [5, 8],
      [9, 14],
    ]);
    expect(plan.clips.map((c) => c.soloOrigin)).toEqual([0, 1, 1]);
    expect(plan.dissolves).toEqual([
      { outgoing: 0, incoming: 1, fromSec: 4, toSec: 5 },
      { outgoing: 1, incoming: 2, fromSec: 8, toSec: 9 },
    ]);
  });

  it("shares each boundary as one float, so the windows tile", () => {
    const plan = stackSequence(planned(5.1234, 4.777, 6.31), sources, { overlapSec: 1.3, crossfade: true });
    const [a, b, c] = plan.clips;
    const [ab, bc] = plan.dissolves;
    expect(Object.is(a.soloEnd, ab.fromSec)).toBe(true);
    expect(Object.is(ab.fromSec, b.seqStart)).toBe(true);
    expect(Object.is(ab.toSec, b.soloStart)).toBe(true);
    expect(Object.is(b.soloEnd, bc.fromSec)).toBe(true);
    expect(Object.is(bc.toSec, c.soloStart)).toBe(true);
    expect(Object.is(c.seqStart + c.length, plan.loopLength)).toBe(true);
  });

  it("keeps the earlier clip in front, crossfade off", () => {
    const plan = stackSequence(planned(5, 5, 6), sources, { overlapSec: 1, crossfade: false });
    expect(plan.clips.map((c) => [c.soloStart, c.soloEnd])).toEqual([
      [0, 5],
      [5, 9],
      [9, 14],
    ]);
    expect(plan.clips[1].soloOrigin).toBe(1);
    expect(plan.dissolves).toEqual([]);
    expect(plan.loopLength).toBe(14);
  });

  it("gives planSequence's windows without an overlap", () => {
    const base = planSequence([
      { inSec: 0.3, outSec: 4.1, sourceDuration: 5 },
      { inSec: 0, outSec: null, sourceDuration: 3.7 },
      { inSec: 1, outSec: 2.2, sourceDuration: 4 },
    ]);
    const plan = stackSequence(base.clips, sources, { overlapSec: 0, crossfade: true });
    expect(plan.loopLength).toBe(base.loopLength);
    plan.clips.forEach((c, k) => {
      expect(c.seqStart).toBe(base.clips[k].seqStart);
      expect(c.soloStart).toBe(base.clips[k].seqStart);
      expect(c.soloEnd).toBe(base.clips[k].seqStart + base.clips[k].length);
      expect(c.soloOrigin).toBe(base.clips[k].origin);
    });
    expect(plan.dissolves).toEqual([]);
  });

  it("leaves a middle clip with no solo window when its overlaps fill it", () => {
    const plan = stackSequence(planned(5, 2, 5), sources, { overlapSec: 1, crossfade: true });
    expect(plan.clips[1].soloStart).toBe(plan.clips[1].soloEnd);
    expect(plan.dissolves.map((d) => [d.fromSec, d.toSec])).toEqual([
      [4, 5],
      [5, 6],
    ]);
  });

  it("cuts between pieces of one source", () => {
    const plan = stackSequence(planned(5, 1, 4, 5), ["a", "b", "b", "c"], { overlapSec: 3, crossfade: true });
    expect(plan.clips.map((c) => c.overlapIn)).toEqual([0, 1, 0, 2.5]);
    expect(plan.dissolves.map((d) => [d.outgoing, d.incoming])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(plan.clips[2].soloStart).toBe(plan.clips[1].soloEnd);
  });
});

describe("sharedCadence", () => {
  const a = (frameRate: number | null) => ({ frameRate, firstTimestamp: 0.04 });

  it("takes the outgoing clip's cadence when the rates agree within 1 %", () => {
    expect(sharedCadence(a(24), { frameRate: 24 })).toEqual({ rate: 24, firstTimestamp: 0.04, incomingRate: 24, incomingFirstTimestamp: 0 });
    expect(sharedCadence(a(24), { frameRate: 24.1, firstTimestamp: 0.02 })).toEqual({
      rate: 24,
      firstTimestamp: 0.04,
      incomingRate: 24.1,
      incomingFirstTimestamp: 0.02,
    });
  });

  it("falls back to every slot otherwise", () => {
    expect(sharedCadence(a(24), { frameRate: 30 })).toBeNull();
    expect(sharedCadence(a(120), { frameRate: 120 })).toBeNull();
    expect(sharedCadence(a(null), { frameRate: 24 })).toBeNull();
    expect(sharedCadence(a(24), { frameRate: null })).toBeNull();
    expect(sharedCadence(a(0), { frameRate: 0 })).toBeNull();
  });

  it("blends a low-rate pair on every slot: a 0.2 fps one-frame still would have no frame inside the overlap", () => {
    expect(sharedCadence({ frameRate: 0.2, firstTimestamp: 0 }, { frameRate: 0.2, firstTimestamp: 0 })).toBeNull();
    expect(sharedCadence(a(1), { frameRate: 1 })).toBeNull();
    expect(sharedCadence(a(MIN_CADENCE_RATE), { frameRate: MIN_CADENCE_RATE })).not.toBeNull();
    const plan = stackSequence(planned(5, 5), ["a", "b"], { overlapSec: 1, crossfade: true });
    const cadence = sharedCadence({ frameRate: 0.2, firstTimestamp: 0 }, { frameRate: 0.2, firstTimestamp: 0 });
    expect(dissolveFrames(plan, plan.dissolves[0], 0, { fps: 60, cadence }).slots).toHaveLength(60);
  });
});

describe("cadenceRate", () => {
  it("measures the rate from the frame intervals when the last packet has no duration", () => {
    // 120 frames at 24 fps from 0.04 s; the packet span leaves the last interval out: 120 / (119 / 24)
    const skewed = 120 / (119 / 24);
    expect(cadenceRate(skewed, 0.04, { timestamp: 0.04 + 119 / 24, duration: 0 })).toBeCloseTo(24, 9);
  });

  it("keeps the average when the last packet has a duration, or none was read", () => {
    expect(cadenceRate(24, 0, { timestamp: 119 / 24, duration: 1 / 24 })).toBe(24);
    expect(cadenceRate(24, 0, null)).toBe(24);
    // One packet: nothing to measure between
    expect(cadenceRate(0.2, 0, { timestamp: 0, duration: 0 })).toBe(0.2);
  });

  it("is null when the rate is unknown", () => {
    expect(cadenceRate(0, 0, null)).toBeNull();
    expect(cadenceRate(Number.NaN, 0, null)).toBeNull();
  });
});

describe("dissolveFrames", () => {
  const plan = stackSequence(planned(5, 5, 6), ["a", "b", "c"], { overlapSec: 1, crossfade: true });
  const join = plan.dissolves[0];

  it("fills every slot of the overlap without a shared cadence", () => {
    const f = dissolveFrames(plan, join, 0);
    expect(f.slots).toEqual(Array.from({ length: 60 }, (_, i) => 240 + i));
    // Each side is looked up mid-slot, through its own solo window's slot mapping
    f.outgoingTimes.forEach((t, i) => expect(t).toBeCloseTo(4 + (i + 0.5) / 60, 6));
    f.incomingTimes.forEach((t, i) => expect(t).toBeCloseTo((i + 0.5) / 60, 6));
    expect(f.alphas[0]).toBeCloseTo(0.5 / 60, 12);
    expect(f.alphas[59]).toBeCloseTo(59.5 / 60, 12);

    const second = dissolveFrames(plan, join, plan.loopLength);
    expect(second.slots).toEqual(Array.from({ length: 60 }, (_, i) => 1080 + i));
    expect(second.outgoingTimes[0]).toBeCloseTo(4 + 0.5 / 60, 6);
  });

  it("follows the outgoing clip's frames at a shared cadence, on the slots the slotter gives them", () => {
    const cadence = { rate: 24, firstTimestamp: 0, incomingFirstTimestamp: 0 };
    for (const loop of [0, 1]) {
      const L = loop * plan.loopLength;
      const f = dissolveFrames(plan, join, L, { cadence });
      const slotter = new FrameSlotter();
      slotter.begin({ origin: plan.clips[0].soloOrigin, startSec: L + plan.clips[0].soloStart, length: 100 });
      const placed = Array.from({ length: 120 }, (_, j) => slotter.place(j / 24));
      expect(f.slots).toEqual(placed.slice(96, 120).map((t) => Math.round(t! * 60)));
      expect(f.slots).toHaveLength(24);
      f.outgoingTimes.forEach((t, k) => expect(t).toBeCloseTo((96 + k) / 24 + 1 / 48, 9));
      f.alphas.forEach((alpha, k) => expect(alpha).toBeCloseTo((k + 0.5) / 24, 9));
      // B's frames 0..23, the ones before frame 24, which its solo window puts on its first slot
      f.incomingTimes.forEach((t, k) => expect(t).toBeCloseTo(k / 24 + 1 / 48, 9));
    }
  });

  it("clamps both sides to their clip's In and Out", () => {
    // A starts its frames at 0.04; B1 is 1 s from 1.0 (its frames from 1.08) and overlaps by all of it (its run with B2 is 5 s)
    const a: PlannedClip = { index: 0, inSec: 0, outSec: 5, origin: 0.04, length: 5, seqStart: 0 };
    const b1: PlannedClip = { index: 1, inSec: 1, outSec: 2, origin: 1.08, length: 1, seqStart: 5 };
    const b2: PlannedClip = { index: 2, inSec: 2, outSec: 6, origin: 2, length: 4, seqStart: 6 };
    const stacked = stackSequence([a, b1, b2], ["a", "b", "b"], { overlapSec: 3, crossfade: true });
    expect(stacked.clips[1].overlapIn).toBe(1);
    for (const cadence of [null, { rate: 24, firstTimestamp: 0.04 }]) {
      const f = dissolveFrames(stacked, stacked.dissolves[0], 0, { cadence });
      expect(f.slots.length).toBeGreaterThan(0);
      expect(Math.min(...f.outgoingTimes)).toBeGreaterThanOrEqual(0.04);
      expect(Math.max(...f.outgoingTimes)).toBeLessThanOrEqual(5 - 1e-6);
      expect(Math.max(...f.outgoingTimes)).toBeCloseTo(5 - 1e-6, 9);
      expect(Math.min(...f.incomingTimes)).toBeGreaterThanOrEqual(1.08);
      expect(Math.min(...f.incomingTimes)).toBeLessThan(1.08 + 1 / 24);
      expect(Math.max(...f.incomingTimes)).toBe(2 - 1e-6);
    }
  });
});

describe("crossfadeGain", () => {
  it("runs equal power from end to end", () => {
    expect(crossfadeGain(0, "in")).toBe(0);
    expect(crossfadeGain(1, "in")).toBe(1);
    expect(crossfadeGain(0, "out")).toBe(1);
    expect(crossfadeGain(1, "out")).toBeCloseTo(0, 12);
    for (const x of [0.1, 0.25, 0.5, 0.9]) {
      expect(crossfadeGain(x, "in") ** 2 + crossfadeGain(x, "out") ** 2).toBeCloseTo(1, 12);
    }
  });

  it("clamps x", () => {
    expect(crossfadeGain(-1, "in")).toBe(0);
    expect(crossfadeGain(2, "out")).toBeCloseTo(0, 12);
    expect(crossfadeGain(Number.NaN, "in")).toBe(0);
  });
});

describe("clipFadeSamples", () => {
  it("fades the outgoing clip out over exactly the samples the next one fades in", () => {
    const plan = stackSequence(planned(5.0123, 3.3337, 4.777), ["a", "b", "c"], { overlapSec: 1.3, crossfade: true });
    for (const sr of [44100, 48000]) {
      for (let k = 0; k < plan.clips.length - 1; k++) {
        const a = plan.clips[k];
        const b = plan.clips[k + 1];
        const fadeA = clipFadeSamples(a, b.seqStart, sr);
        const fadeB = clipFadeSamples(b, plan.clips[k + 2]?.seqStart ?? null, sr);
        expect(Math.round(a.seqStart * sr) + fadeA.outStart).toBe(Math.round(b.seqStart * sr));
        expect(fadeA.outLength).toBe(fadeB.inLength);
        expect(fadeA.outLength).toBeGreaterThan(0);
      }
      const last = plan.clips[plan.clips.length - 1];
      expect(clipFadeSamples(last, null, sr).outLength).toBe(0);
    }
  });
});

describe("dissolve hand-offs (a simulated stacked encode)", () => {
  /** A synthetic constant-rate source: frames at first + j / fps for j < count. */
  interface Source {
    fps: number;
    first: number;
    count: number;
    /** The rate the probe reports for the cadence; fps when absent. */
    reported?: number;
  }
  const frameTimes = (s: Source) => Array.from({ length: s.count }, (_, j) => s.first + j / s.fps);
  const frameIndex = (s: Source, t: number) => Math.round((t - s.first) * s.fps);

  /** VideoSampleSink.samples(start, end) on an all-key-frame stream: the frame in effect at start, then every frame before end. */
  function samplesBetween(times: number[], start: number, end: number): number[] {
    const inEffect = times.filter((t) => t <= start).pop();
    const after = times.filter((t) => t > start && t < end);
    return inEffect === undefined ? after : [inEffect, ...after];
  }
  /** samplesAtTimestamps: the frame in effect at t, or null before the first. */
  const frameAt = (times: number[], t: number) => times.filter((x) => x <= t).pop() ?? null;

  interface Shown {
    slot: number;
    clip: string;
    frame: number;
    kind: string;
  }

  /** What each output slot shows, per clip, encoding as useStitchVideos does (solo runs, then each dissolve's claimed slots). */
  function encode(
    sources: Source[],
    clips: Array<{ inSec: number; outSec: number | null }>,
    opts: { overlapSec: number; crossfade: boolean; loops: number },
  ): Shown[] {
    const plan = planSequence(
      clips.map((c, i) => ({
        inSec: c.inSec,
        outSec: c.outSec,
        sourceDuration: sources[i].first + sources[i].count / sources[i].fps,
        firstTimestamp: sources[i].first,
      })),
    );
    const sp = stackSequence(plan.clips, plan.clips.map((p) => `#${p.index}`), opts);
    const slotter = new FrameSlotter(60);
    const shown: Shown[] = [];
    const dissolveFrom = new Map(sp.dissolves.map((d) => [d.outgoing, d]));
    for (let loop = 0; loop < opts.loops; loop++) {
      const L = loop * sp.loopLength;
      sp.clips.forEach((placed, k) => {
        const source = sources[placed.index];
        const times = frameTimes(source);
        const clip = `${loop}:${k}`;
        const solo = soloPass(placed, L, 60);
        if (solo) {
          slotter.beginRange({ origin: placed.soloOrigin, fromSec: solo.fromSec, toSec: solo.toSec });
          const put = (t: number) => {
            const at = slotter.place(t);
            if (at !== null) shown.push({ slot: Math.round(at * 60), clip, frame: frameIndex(source, t), kind: "solo" });
          };
          let held: number | null = null;
          for (const t of samplesBetween(times, solo.decodeFrom, solo.decodeTo)) {
            if (t < placed.soloOrigin) {
              held = t;
              continue;
            }
            if (held !== null && !slotter.takesFirstSlot(t)) put(held);
            held = null;
            put(t);
          }
          if (held !== null) put(held);
        }
        const d = dissolveFrom.get(k);
        if (!d) return;
        const a = sources[sp.clips[d.outgoing].index];
        const b = sources[sp.clips[d.incoming].index];
        const f = dissolveFrames(sp, d, L, {
          fps: 60,
          cadence: sharedCadence(
            { frameRate: a.reported ?? a.fps, firstTimestamp: a.first },
            { frameRate: b.reported ?? b.fps, firstTimestamp: b.first },
          ),
        });
        f.slots.forEach((slot, i) => {
          if (slotter.claim(slot) === null) return;
          const ta = frameAt(frameTimes(a), f.outgoingTimes[i]);
          const tb = frameAt(frameTimes(b), f.incomingTimes[i]);
          if (ta !== null) shown.push({ slot, clip: `${loop}:${d.outgoing}`, frame: frameIndex(a, ta), kind: "dissolve" });
          if (tb !== null) shown.push({ slot, clip: `${loop}:${d.incoming}`, frame: frameIndex(b, tb), kind: "dissolve" });
        });
      });
    }
    return shown;
  }

  /** Per clip: frames never go back or skip one; a 60 fps clip never shows one frame twice where solo and dissolve meet. */
  function problems(shown: Shown[], fpsOf: (clip: string) => number): string[] {
    const found: string[] = [];
    const last = new Map<string, Shown>();
    for (const s of shown) {
      const prev = last.get(s.clip);
      if (prev && prev.slot < s.slot) {
        if (s.frame < prev.frame) found.push(`${s.clip} went back ${prev.frame}→${s.frame} at slot ${s.slot}`);
        if (s.frame > prev.frame + 1) found.push(`${s.clip} skipped ${prev.frame}→${s.frame} at slot ${s.slot}`);
        if (fpsOf(s.clip) === 60 && s.frame === prev.frame && s.kind !== prev.kind) {
          found.push(`${s.clip} repeated ${s.frame} at slots ${prev.slot}, ${s.slot}`);
        }
      }
      last.set(s.clip, s);
    }
    return found;
  }

  const whole = (fps: number, seconds = 5): Source => ({ fps, first: 0, count: Math.round(fps * seconds) });

  it("shows every frame of an incoming clip after an Out trim off its frame grid", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (let i = 0; i < 200; i++) {
        const outSec = 4 + i / 200;
        const shown = encode([whole(fps), whole(fps)], [{ inSec: 0, outSec }, { inSec: 0, outSec: null }], {
          overlapSec: 1,
          crossfade: true,
          loops: 1,
        });
        expect(problems(shown, () => fps), `${fps} fps, Out ${outSec}`).toEqual([]);
      }
    }
  });

  it("shows every frame after an In trim off the frame grid, and between mixed rates", () => {
    for (const fps of [24, 30, 60]) {
      for (let i = 0; i < 200; i++) {
        const inSec = i / 200;
        const shown = encode([whole(fps), whole(fps)], [{ inSec: 0, outSec: null }, { inSec, outSec: null }], {
          overlapSec: 1,
          crossfade: true,
          loops: 1,
        });
        expect(problems(shown, () => fps), `${fps} fps, In ${inSec}`).toEqual([]);
      }
    }
    // 60 fps with a fractional In into 30 fps: no shared cadence, every slot
    const sources = [whole(60), whole(30)];
    const shown = encode(sources, [{ inSec: 0.7 / 60, outSec: null }, { inSec: 0, outSec: null }], {
      overlapSec: 1,
      crossfade: true,
      loops: 1,
    });
    expect(problems(shown, (clip) => sources[Number(clip.split(":")[1])].fps)).toEqual([]);
  });

  it("never skips, rewinds or doubles a frame across random rates, trims, first timestamps, covered clips and loops", () => {
    const next = random(17);
    const rates = [24, 25, 30, 60, 23.976, 29.97, 50];
    for (let trial = 0; trial < 400; trial++) {
      const count = 2 + Math.floor(next() * 4);
      const sources: Source[] = [];
      const clips: Array<{ inSec: number; outSec: number | null }> = [];
      for (let i = 0; i < count; i++) {
        const fps = rates[Math.floor(next() * rates.length)];
        // Some clips are short enough for their two overlaps to fill them
        const seconds = next() < 0.3 ? 1 + next() : 1 + next() * 4;
        const source = { fps, first: next() < 0.3 ? next() * 0.05 : 0, count: Math.floor(fps * seconds) };
        sources.push(source);
        const duration = source.first + source.count / fps;
        const inSec = next() < 0.5 ? next() * duration * 0.3 : 0;
        const outSec = next() < 0.5 ? inSec + (duration - inSec) * (0.5 + next() * 0.5) : null;
        clips.push({ inSec, outSec });
      }
      const overlapSec = Math.round((0.1 + next() * 2) * 10) / 10;
      const shown = encode(sources, clips, { overlapSec, crossfade: next() < 0.7, loops: 2 });
      const fpsOf = (clip: string) => sources[Number(clip.split(":")[1])].fps;
      expect(problems(shown, fpsOf), `trial ${trial}`).toEqual([]);
    }
  });

  it("never skips a frame at the hand-off when the last frame was stored without a duration (WebM)", () => {
    const next = random(29);
    const rates = [24, 25, 30];
    for (let trial = 0; trial < 300; trial++) {
      const sources: Source[] = [0, 1, 2].map(() => {
        const fps = rates[Math.floor(next() * rates.length)];
        const count = Math.floor(fps * (2 + next() * 3));
        // The packet span ends at the last frame's start: averagePacketRate = count / ((count − 1) / fps)
        const average = count / ((count - 1) / fps);
        return { fps, first: 0, count, reported: cadenceRate(average, 0, { timestamp: (count - 1) / fps, duration: 0 }) ?? undefined };
      });
      const clips = sources.map((src) => ({ inSec: next() < 0.5 ? (next() * src.count) / src.fps / 4 : 0, outSec: null }));
      const overlapSec = Math.round((0.1 + next() * 2) * 10) / 10;
      const shown = encode(sources, clips, { overlapSec, crossfade: true, loops: 1 });
      const fpsOf = (clip: string) => sources[Number(clip.split(":")[1])].fps;
      expect(problems(shown, fpsOf), `trial ${trial}`).toEqual([]);
    }
  });
});
