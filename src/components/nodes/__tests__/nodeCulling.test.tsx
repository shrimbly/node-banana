import { describe, it, expect } from "vitest";
import { mountedArea, CULL_STEP } from "@/components/nodes/nodeCulling";

describe("mountedArea", () => {
  it("covers the view plus a viewport on every side, snapped to the grid", () => {
    // view of 1000x800 at zoom 1 with its top-left at flow (0, 0)
    const [minX, minY, maxX, maxY] = mountedArea([0, 0, 1], 1000, 800);
    expect(minX).toBe(-1000);
    expect(minY).toBe(-1000);
    expect(maxX).toBeGreaterThanOrEqual(2000);
    expect(maxY).toBeGreaterThanOrEqual(1600);
    expect(maxX % CULL_STEP).toBe(0);
  });

  it("grows with the zoom, since the view shows more of the flow when zoomed out", () => {
    const [, , maxAt1] = mountedArea([0, 0, 1], 1000, 800);
    const [, , maxAtHalf] = mountedArea([0, 0, 0.5], 1000, 800);
    expect(maxAtHalf).toBeGreaterThan(maxAt1);
  });
});
