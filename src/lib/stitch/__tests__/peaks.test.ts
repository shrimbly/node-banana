import { describe, it, expect } from "vitest";
import { computePeaks, peakInRange, WAVEFORM_BUCKETS } from "../peaks";

describe("computePeaks", () => {
  it("takes each bucket's loudest sample across the channels, as a magnitude", () => {
    const left = new Float32Array([0.1, -0.5, 0.2, 0.3, 0, 0, -0.1, 0.05]);
    const right = new Float32Array([0.2, 0.1, -0.9, 0.1, 0.4, 0, 0, 0]);
    expect(Array.from(computePeaks([left, right], 4))).toEqual([
      expect.closeTo(0.5),
      expect.closeTo(0.9),
      expect.closeTo(0.4),
      expect.closeTo(0.1),
    ]);
  });

  it("uses the default bucket count, caps overs at full scale and reads NaN as silence", () => {
    const samples = new Float32Array(WAVEFORM_BUCKETS * 3).fill(0.25);
    samples[0] = 1.6;
    samples[3] = Number.NaN;
    samples[4] = Number.NaN;
    samples[5] = Number.NaN;
    const peaks = computePeaks([samples]);
    expect(peaks).toHaveLength(WAVEFORM_BUCKETS);
    expect(peaks[0]).toBe(1);
    expect(peaks[1]).toBe(0);
    expect(peaks[2]).toBeCloseTo(0.25);
  });

  it("gives a file shorter than the bucket count one bucket per sample, and nothing for no samples", () => {
    expect(computePeaks([new Float32Array([0.5, -0.25])], 8)).toHaveLength(2);
    expect(computePeaks([], 8)).toHaveLength(0);
    expect(computePeaks([new Float32Array(0)])).toHaveLength(0);
  });
});

describe("peakInRange", () => {
  // 4 buckets over 2 s: [0, 0.5) 0.1, [0.5, 1) 0.8, [1, 1.5) 0.3, [1.5, 2) 0.6
  const peaks = new Float32Array([0.1, 0.8, 0.3, 0.6]);

  it("reads the max of the buckets the range covers", () => {
    expect(peakInRange(peaks, 2, 0, 0.5)).toBeCloseTo(0.1);
    expect(peakInRange(peaks, 2, 0.25, 1.25)).toBeCloseTo(0.8);
    expect(peakInRange(peaks, 2, 1, 2)).toBeCloseTo(0.6);
  });

  it("reads the bucket a range inside it falls in", () => {
    expect(peakInRange(peaks, 2, 1.1, 1.2)).toBeCloseTo(0.3);
  });

  it("clips at the edges and is 0 past the end", () => {
    expect(peakInRange(peaks, 2, -1, 0.4)).toBeCloseTo(0.1);
    expect(peakInRange(peaks, 2, 1.9, 5)).toBeCloseTo(0.6);
    expect(peakInRange(peaks, 2, 2, 3)).toBe(0);
    expect(peakInRange(peaks, 2, 2.5, 3)).toBe(0);
  });

  it("is 0 for an empty range, no peaks or a duration it cannot use", () => {
    expect(peakInRange(peaks, 2, 1, 1)).toBe(0);
    expect(peakInRange(new Float32Array(0), 2, 0, 1)).toBe(0);
    expect(peakInRange(peaks, 0, 0, 1)).toBe(0);
    expect(peakInRange(peaks, 2, Number.NaN, 1)).toBe(0);
  });
});
