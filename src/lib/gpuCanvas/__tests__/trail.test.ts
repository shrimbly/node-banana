import { describe, expect, it } from "vitest";
import { clampTrail, stepTrail, TRAIL_MAX } from "../trail";

describe("controls card trail", () => {
  it("closes 40% of the distance per 16.7ms", () => {
    const smoothed = { x: 0, y: 0 };
    expect(stepTrail(smoothed, { x: 10, y: 0 }, 16.7)).toBe(true);
    expect(smoothed.x).toBeCloseTo(4);
    expect(smoothed.y).toBe(0);
  });

  it("never lags more than TRAIL_MAX behind", () => {
    const smoothed = { x: 0, y: 0 };
    clampTrail(smoothed, { x: 300, y: 400 });
    expect(Math.hypot(300 - smoothed.x, 400 - smoothed.y)).toBeCloseTo(TRAIL_MAX);
    expect(smoothed.x).toBeCloseTo(300 - TRAIL_MAX * 0.6);
  });

  it("caps a long frame and settles onto the target", () => {
    const smoothed = { x: 0, y: 0 }, target = { x: 10, y: 10 };
    stepTrail(smoothed, target, 1000);
    // Capped at 64ms: 1 - 0.6^(64/16.7) of the way.
    expect(smoothed.x).toBeCloseTo(10 * (1 - Math.pow(0.6, 64 / 16.7)));
    let frames = 0;
    while (stepTrail(smoothed, target, 16.7)) frames++;
    expect(frames).toBeLessThan(20);
    expect(smoothed).toEqual(target);
  });

  it("does not move backwards on a negative frame time", () => {
    const smoothed = { x: 0, y: 0 };
    stepTrail(smoothed, { x: 10, y: 0 }, -5);
    expect(smoothed.x).toBe(0);
  });
});
