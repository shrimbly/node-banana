import { describe, it, expect, vi } from "vitest";
import { lastResult } from "../lastResult";

describe("lastResult", () => {
  it("hands back the same result while its inputs are the same objects", () => {
    const compute = vi.fn((state: { edges: number[]; other: number }) => ({ count: state.edges.length }));
    const select = lastResult((state: { edges: number[]; other: number }) => [state.edges], compute);
    const edges = [1, 2];
    const first = select({ edges, other: 1 });
    // A store update elsewhere: same edges array, so no recompute and the same object
    expect(select({ edges, other: 2 })).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when any input changes identity", () => {
    const compute = vi.fn((state: { a: object; b: object }) => ({ a: state.a, b: state.b }));
    const select = lastResult((state: { a: object; b: object }) => [state.a, state.b], compute);
    const a = {}, b = {};
    const first = select({ a, b });
    const second = select({ a, b: {} });
    expect(second).not.toBe(first);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
