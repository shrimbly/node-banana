import { describe, it, expect } from "vitest";
import { FRAME_RATE, FrameSlotter, planSequence, secToSlot, videoTrackDuration } from "../sequencePlan";

describe("planSequence", () => {
  it("plays a clip without Out to its video's end", () => {
    const { clips, loopLength } = planSequence([{ inSec: 1, outSec: null, sourceDuration: 5 }]);
    expect(clips).toEqual([{ index: 0, inSec: 1, outSec: 5, origin: 1, length: 4, seqStart: 0 }]);
    expect(loopLength).toBe(4);
  });

  it("clamps an Out past the video's end", () => {
    expect(planSequence([{ inSec: 0, outSec: 9, sourceDuration: 5 }]).clips[0]).toMatchObject({ outSec: 5, length: 5 });
  });

  it("drops a clip whose In is at or past its Out", () => {
    const { clips, loopLength } = planSequence([
      { inSec: 3, outSec: 2, sourceDuration: 5 },
      { inSec: 0, outSec: 2, sourceDuration: 5 },
    ]);
    expect(clips).toEqual([{ index: 1, inSec: 0, outSec: 2, origin: 0, length: 2, seqStart: 0 }]);
    expect(loopLength).toBe(2);
  });

  it("butts the clips together", () => {
    const { clips, loopLength } = planSequence([
      { inSec: 0, outSec: 2, sourceDuration: 5 },
      { inSec: 0.8, outSec: 5, sourceDuration: 5 },
      { inSec: 0, outSec: null, sourceDuration: 3 },
    ]);
    expect(clips.map((c) => c.seqStart)).toEqual([0, 2, expect.closeTo(6.2, 9)]);
    expect(loopLength).toBeCloseTo(9.2, 9);
  });

  it("reads both tracks from the video's first timestamp", () => {
    expect(planSequence([{ inSec: 0, outSec: null, sourceDuration: 5, firstTimestamp: 0.04 }]).clips[0]).toMatchObject({
      origin: 0.04,
      length: 5,
    });
    expect(planSequence([{ inSec: 1, outSec: null, sourceDuration: 5, firstTimestamp: 0.04 }]).clips[0].origin).toBe(1);
  });

  it("skips a clip trimmed past its source's end, and the next one does not move", () => {
    const { clips } = planSequence([
      { inSec: 0, outSec: 2, sourceDuration: 2 },
      { inSec: 6, outSec: null, sourceDuration: 4 },
      { inSec: 0, outSec: 1, sourceDuration: 3 },
    ]);
    expect(clips.map((c) => [c.index, c.seqStart])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it("gives an empty source no time", () => {
    expect(planSequence([{ inSec: 0, outSec: null, sourceDuration: 0 }])).toEqual({ clips: [], loopLength: 0 });
  });
});

/** A 24 fps source's frame timestamps from `from` (the frame in effect there) up to `to`. */
function frames24(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.floor(from * 24); i / 24 < to; i++) out.push(i / 24);
  return out;
}

describe("FrameSlotter", () => {
  it("places a trimmed clip's frames at their own offsets from its join", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0.8, startSec: 5, length: 4.2 });
    const placed = frames24(0.8, 5).map((ts) => slotter.place(ts));
    expect(placed[0]).toBe(5);
    for (const [i, ts] of frames24(0.8, 5).entries()) {
      if (i === 0) continue;
      // On the grid, within half a slot of the frame's own offset
      expect(Math.abs(placed[i]! - (5 + ts - 0.8))).toBeLessThanOrEqual(1 / (2 * FRAME_RATE) + 1e-9);
      expect(Number.isInteger(Math.round(placed[i]! * FRAME_RATE * 1e6) / 1e6)).toBe(true);
    }
    expect(placed.every((t) => t !== null && t < 9.2)).toBe(true);
  });

  it("offsets the second loop by the loop's length", () => {
    const slotter = new FrameSlotter();
    const loopLength = 2;
    const firsts: Array<number | null> = [];
    for (let loop = 0; loop < 2; loop++) {
      slotter.begin({ origin: 0, startSec: loop * loopLength, length: 2 });
      const placed = frames24(0, 2).map((ts) => slotter.place(ts));
      firsts.push(placed[0]);
    }
    expect(firsts).toEqual([0, 2]);
  });

  it("drops a second frame on the same slot", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0, startSec: 0, length: 1 });
    // 120 fps: frames 1 and 2 both round to slot 1
    expect(slotter.place(0)).toBe(0);
    expect(slotter.place(1 / 120)).toBeCloseTo(1 / 60, 9);
    expect(slotter.place(2 / 120)).toBeNull();
    expect(slotter.place(3 / 120)).toBeCloseTo(2 / 60, 9);
  });

  it("drops frames past the clip's window", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0, startSec: 0, length: 0.5 });
    expect(slotter.place(0.49)).not.toBeNull();
    expect(slotter.place(0.5)).toBeNull();
  });

  it("puts the first frame of a clip whose video starts late on its join", () => {
    const [planned] = planSequence([{ inSec: 0, outSec: null, sourceDuration: 2, firstTimestamp: 0.04 }]).clips;
    const slotter = new FrameSlotter();
    slotter.begin({ origin: planned.origin, startSec: 3, length: planned.length });
    expect(slotter.place(0.04)).toBe(3);
  });

  it("puts the frame in effect before In on the join", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0.8, startSec: 0, length: 1 });
    expect(slotter.place(0.79)).toBe(0);
  });

  it("tells whether a frame would take the window's first slot, without placing it", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0.035, startSec: 0, length: 1 });
    // 1/24 s is 0.0067 s after In: under half a slot, so it lands on the join
    expect(slotter.takesFirstSlot(1 / 24)).toBe(true);
    expect(slotter.takesFirstSlot(2 / 24)).toBe(false);
    expect(slotter.place(1 / 24)).toBe(0);
  });

  it("drops no 60 fps frame when a clip starts on a half slot", () => {
    // 121 frames at 24 fps last 121/24 s: 302.5 slots, so the next clip starts on a half slot
    const { clips } = planSequence([
      { inSec: 0, outSec: null, sourceDuration: 121 / 24 },
      { inSec: 0, outSec: null, sourceDuration: 5 },
    ]);
    const slotter = new FrameSlotter();
    for (const loop of [0, 1]) {
      const loopLength = clips[0].length + clips[1].length;
      slotter.begin({ origin: clips[0].origin, startSec: loop * loopLength, length: clips[0].length });
      for (let i = 0; i < 121; i++) slotter.place(i / 24);
      slotter.begin({ origin: clips[1].origin, startSec: loop * loopLength + clips[1].seqStart, length: clips[1].length });
      const placed = Array.from({ length: 300 }, (_, k) => slotter.place(k / 60));
      // Every frame but possibly the very last fits before the window's end
      expect(placed.slice(0, 299).every((t) => t !== null)).toBe(true);
    }
  });

  it("drops no frame of a 60 fps clip whose In falls on a half slot", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0.125, startSec: 0, length: 1 });
    // The frame in effect at In, then every frame up to 1.125
    const placed = Array.from({ length: 61 }, (_, k) => slotter.place((k + 7) / 60));
    expect(placed.slice(0, 60).every((t) => t !== null)).toBe(true);
  });
});

describe("videoTrackDuration", () => {
  it("keeps the track's own duration when the last packet has one", () => {
    expect(videoTrackDuration(2, { timestamp: 1.95, duration: 0.05 }, 20)).toBe(2);
    expect(videoTrackDuration(2, null, 20)).toBe(2);
  });

  it("gives a last frame stored without a duration one average frame interval", () => {
    expect(videoTrackDuration(119 / 24, { timestamp: 119 / 24, duration: 0 }, 24)).toBeCloseTo(5, 9);
  });

  it("keeps the track's duration when the rate is unknown", () => {
    expect(videoTrackDuration(3, { timestamp: 3, duration: 0 }, 0)).toBe(3);
  });

  it("is 0 for a bad duration with nothing to add", () => {
    expect(videoTrackDuration(Number.NaN, null, 30)).toBe(0);
  });
});

describe("secToSlot", () => {
  it("rounds half up, float noise just under a half included", () => {
    expect(secToSlot(0)).toBe(0);
    expect(secToSlot(1)).toBe(60);
    expect(secToSlot(2.5 / 60)).toBe(3);
    expect(secToSlot(2.4999999 / 60)).toBe(3);
    expect(secToSlot(2.49 / 60)).toBe(2);
    expect(secToSlot(1, 24)).toBe(24);
  });

  it("matches where the slotter places a frame", () => {
    const slotter = new FrameSlotter();
    slotter.begin({ origin: 0, startSec: 0, length: 10 });
    for (let j = 0; j < 120; j++) {
      expect(Math.round(slotter.place(j / 24)! * FRAME_RATE)).toBe(secToSlot(j / 24));
    }
  });
});

describe("FrameSlotter: stacked windows", () => {
  /** Places 24 fps frames from `from` up to `to` (source seconds) and returns their slots. */
  const placeAll = (slotter: FrameSlotter, from: number, to: number) => {
    const slots: number[] = [];
    for (let j = Math.ceil(from * 24 - 1e-9); j / 24 < to; j++) {
      const t = slotter.place(j / 24);
      if (t !== null) slots.push(Math.round(t * FRAME_RATE));
    }
    return slots;
  };

  it("tiles solo A, the claimed dissolve slots and solo B with no gap or repeat", () => {
    // A 5 s and B 5 s, overlap 1: A plays alone over [0, 4), the dissolve owns [4, 5), B plays alone from 5 (source 1)
    const slotter = new FrameSlotter();
    slotter.beginRange({ origin: 0, fromSec: 0, toSec: 4 });
    const soloA = placeAll(slotter, 0, 5);
    const dissolve: number[] = [];
    for (let slot = secToSlot(4); slot < secToSlot(5); slot++) {
      if (slotter.claim(slot) !== null) dissolve.push(slot);
    }
    slotter.beginRange({ origin: 1, fromSec: 5, toSec: 9 });
    const soloB = placeAll(slotter, 1, 5);

    expect(soloA[0]).toBe(0);
    expect(soloA[soloA.length - 1]).toBeLessThan(240);
    expect(dissolve).toEqual(Array.from({ length: 60 }, (_, i) => 240 + i));
    expect(soloB[0]).toBe(300);
    expect(soloB[soloB.length - 1]).toBeLessThan(540);
    const all = [...soloA, ...dissolve, ...soloB];
    expect(all.every((slot, i) => i === 0 || slot > all[i - 1])).toBe(true);
  });

  it("refuses a claim on or before the last slot written", () => {
    const slotter = new FrameSlotter();
    expect(slotter.claim(0)).toBe(0);
    expect(slotter.claim(0)).toBeNull();
    expect(slotter.claim(3)).toBeCloseTo(3 / 60, 12);
    expect(slotter.claim(2)).toBeNull();
    slotter.beginRange({ origin: 0, fromSec: 0, toSec: 1 });
    // A placed frame on a claimed slot is dropped too
    expect(slotter.place(3 / 60)).toBeNull();
    expect(slotter.place(4 / 60)).toBeCloseTo(4 / 60, 12);
  });

  it("begins a range with the same rounding as begin", () => {
    const a = new FrameSlotter();
    const b = new FrameSlotter();
    a.begin({ origin: 0.5, startSec: 2.5 / 60, length: 1 });
    b.beginRange({ origin: 0.5, fromSec: 2.5 / 60, toSec: 2.5 / 60 + 1 });
    for (let j = 0; j < 30; j++) expect(a.place(0.5 + j / 24)).toBe(b.place(0.5 + j / 24));
  });
});
