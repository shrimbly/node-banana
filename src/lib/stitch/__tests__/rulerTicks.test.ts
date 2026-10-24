import { describe, it, expect } from "vitest";
import { majorStep, rulerTicks } from "../rulerTicks";

const close = (values: number[]) => values.map((v) => Math.round(v * 1000) / 1000);

describe("rulerTicks", () => {
  it("at 64 px/s labels every 2 s, with one mark at each odd second between them", () => {
    const ticks = rulerTicks(64, 0, 4);
    expect(close(ticks.majors)).toEqual([0, 2, 4]);
    expect(close(ticks.minors)).toEqual([1, 3]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:00", "0:02", "0:04"]);
    expect(ticks.labels.map((l) => l.t)).toEqual(ticks.majors);
  });

  it("draws the boards' ruler at 19 px/s: a label every 10 s and one mark at 5 s", () => {
    const ticks = rulerTicks(19, 0, 30);
    expect(close(ticks.majors)).toEqual([0, 10, 20, 30]);
    expect(close(ticks.minors)).toEqual([5, 15, 25]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:00", "0:10", "0:20", "0:30"]);
  });

  it("keeps 1 s steps at Fit on a 1440px window (≈ 63 px/s)", () => {
    expect(majorStep(63.4)).toBe(1);
    expect(rulerTicks(63.4, 0, 18.4).labels.at(-1)?.text).toBe("0:18");
  });

  it("at 120 px/s labels every second with tenths, with a mark at each half", () => {
    const ticks = rulerTicks(120, 4, 9);
    expect(close(ticks.majors)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(close(ticks.minors)).toEqual([4.5, 5.5, 6.5, 7.5, 8.5]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:04.0", "0:05.0", "0:06.0", "0:07.0", "0:08.0", "0:09.0"]);
  });

  it("steps down to half or quarter seconds when zoomed in", () => {
    expect(majorStep(150)).toBe(1);
    expect(majorStep(250)).toBe(0.5);
    expect(majorStep(480)).toBe(0.25);
    const ticks = rulerTicks(480, 1, 2);
    expect(close(ticks.majors)).toEqual([1, 1.25, 1.5, 1.75, 2]);
    expect(close(ticks.minors)).toEqual([1.125, 1.375, 1.625, 1.875]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:01.00", "0:01.25", "0:01.50", "0:01.75", "0:02.00"]);
  });

  it("steps up to 5 or 10 s when zoomed out", () => {
    expect(majorStep(20)).toBe(5);
    expect(majorStep(8)).toBe(10);
    const ticks = rulerTicks(8, 0, 60);
    expect(close(ticks.majors)).toEqual([0, 20, 40, 60]);
    expect(close(ticks.minors)).toEqual([10, 30, 50]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:00", "0:20", "0:40", "1:00"]);
  });

  it("draws only the asked range, and nothing for a bad zoom", () => {
    const ticks = rulerTicks(64, 10.1, 12.9);
    expect(close(ticks.majors)).toEqual([12]);
    expect(close(ticks.minors)).toEqual([11]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:12"]);
    expect(rulerTicks(0, 0, 10)).toEqual({ majors: [], minors: [], labels: [] });
    expect(rulerTicks(64, 5, 1)).toEqual({ majors: [], minors: [], labels: [] });
  });
});
