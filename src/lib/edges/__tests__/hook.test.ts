import { describe, expect, it } from "vitest";
import { crossesEdge } from "../hook";

describe("hook sweep hit testing", () => {
  const edge = [{ x: 50, y: 0 }, { x: 50, y: 100 }];
  it("catches an edge crossed between widely spaced pointer events", () => {
    expect(crossesEdge({ x: 0, y: 50 }, { x: 100, y: 50 }, edge)).toBe(true);
  });
  it("accepts a small screen-space tolerance", () => {
    expect(crossesEdge({ x: 54, y: 20 }, { x: 54, y: 80 }, edge)).toBe(true);
    expect(crossesEdge({ x: 58, y: 20 }, { x: 58, y: 80 }, edge)).toBe(false);
  });
  it("does not select distant collinear edges", () => {
    expect(crossesEdge({ x: 50, y: 200 }, { x: 50, y: 300 }, edge)).toBe(false);
  });
  it("catches a stationary press on the edge", () => {
    expect(crossesEdge({ x: 50, y: 50 }, { x: 50, y: 50 }, edge)).toBe(true);
  });
});
