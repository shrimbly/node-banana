import { describe, expect, it } from "vitest";
import { crossesEdge, insertHookHandle } from "../hook";

describe("hook handle ordering", () => {
  it("inserts before, between and after existing handles", () => {
    const handles = [{ id: "a", x: 100, y: 0 }, { id: "b", x: 300, y: 0 }];
    for (const [x, order] of [[50, ["new", "a", "b"]], [200, ["a", "new", "b"]], [350, ["a", "b", "new"]]] as const) {
      expect(insertHookHandle(handles, { id: "new", x, y: 0 }, { x: 0, y: 0 }, { x: 400, y: 0 }).map((h) => h.id)).toEqual(order);
    }
  });
  it("follows reversed and vertical routes", () => {
    expect(insertHookHandle([{ id: "a", x: 300, y: 0 }], { id: "new", x: 100, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 0 }).map((h) => h.id)).toEqual(["a", "new"]);
    expect(insertHookHandle([{ id: "a", x: 0, y: 300 }], { id: "new", x: 0, y: 100 }, { x: 0, y: 0 }, { x: 0, y: 400 }).map((h) => h.id)).toEqual(["new", "a"]);
  });
});

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
