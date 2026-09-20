import { describe, it, expect } from "vitest";
import { pathIntersectsRect } from "../marquee";

describe("noodle marquee hit testing", () => {
  const rect = { x: 20, y: 20, width: 20, height: 20 };
  it("catches segments crossing the rectangle with both endpoints outside", () => {
    expect(pathIntersectsRect([{ x: 0, y: 30 }, { x: 80, y: 30 }], rect)).toBe(true);
  });
  it("does not select a curve just because its bounds overlap", () => {
    expect(pathIntersectsRect([{ x: 0, y: 0 }, { x: 0, y: 80 }, { x: 80, y: 80 }], rect)).toBe(false);
  });
  it("selects enclosed and boundary-touching curves", () => {
    expect(pathIntersectsRect([{ x: 25, y: 25 }, { x: 35, y: 35 }], rect)).toBe(true);
    expect(pathIntersectsRect([{ x: 0, y: 20 }, { x: 80, y: 20 }], rect)).toBe(true);
  });
});
