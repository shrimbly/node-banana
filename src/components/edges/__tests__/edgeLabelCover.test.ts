import { describe, expect, it } from "vitest";
import { labelClip, uncoveredRects } from "../edgeLabelCover";

const pill = { x: 0, y: 0, w: 100, h: 20 };
const area = (rects: { w: number; h: number }[]) => rects.reduce((sum, r) => sum + r.w * r.h, 0);

describe("edge label cover", () => {
  it("leaves a pill no box touches whole", () => {
    expect(labelClip(pill, [{ x: 200, y: 0, w: 50, h: 50 }])).toBeNull();
    expect(labelClip(pill, [])).toBeNull();
  });

  it("hides a pill a box covers", () => {
    expect(labelClip(pill, [{ x: -10, y: -10, w: 200, h: 40 }])).toBe("hidden");
    expect(labelClip(pill, [{ x: -10, y: -10, w: 60, h: 40 }, { x: 40, y: -10, w: 100, h: 40 }])).toBe("hidden");
  });

  it("cuts out what boxes cover, overlapping boxes included", () => {
    const boxes = [{ x: 50, y: -10, w: 100, h: 40 }, { x: 40, y: 10, w: 30, h: 30 }];
    expect(area(uncoveredRects(pill, boxes))).toBe(40 * 20 + 10 * 10);
    expect(labelClip(pill, [{ x: 50, y: -10, w: 100, h: 40 }])).toBe('path("M0 0h50v20h-50Z")');
  });

  it("writes the clip in the pill's own coordinates", () => {
    expect(labelClip({ x: 300, y: 100, w: 100, h: 20 }, [{ x: 350, y: 90, w: 100, h: 40 }])).toBe('path("M0 0h50v20h-50Z")');
  });
});
