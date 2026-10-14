import { describe, expect, it } from "vitest";
import type { NodeChange, Position } from "@xyflow/react";
import type { WorkflowNode } from "@/types";
import { resizeChanges, sameHandleBounds } from "../LiveLayer";

const store = [
  { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {}, width: 300, style: { width: 300 } },
  { id: "b", type: "prompt", position: { x: 400, y: 0 }, data: {}, selected: true },
] as unknown as WorkflowNode[];
const real = new Set(["a", "b"]);

describe("resizeChanges", () => {
  it("passes React Flow's resize, with the left grip's move, and drops plain measuring", () => {
    const changes: NodeChange[] = [
      { id: "a", type: "position", position: { x: -20, y: 0 } },
      { id: "a", type: "dimensions", resizing: true, setAttributes: "width", dimensions: { width: 320, height: 200 } },
    ];
    expect(resizeChanges(changes, real, store)).toEqual(changes);
    expect(resizeChanges([{ id: "a", type: "dimensions", dimensions: { width: 300, height: 210 } }], real, store)).toEqual([]);
    expect(resizeChanges([{ id: "a", type: "position", position: { x: 5, y: 5 } }], real, store)).toEqual([]);
  });

  it("turns NodeShell's setNodes widths into the store's node at that width, and ignores stand-ins and the rest", () => {
    const changes: NodeChange[] = [
      { id: "b", type: "replace", item: { id: "b", position: { x: 9, y: 9 }, data: { other: 1 }, width: 360, style: { width: 360 } } },
      { id: "a", type: "replace", item: { id: "a", position: { x: 9, y: 9 }, data: {}, width: 300, style: { width: 300 } } },
      { id: "ghost", type: "replace", item: { id: "ghost", position: { x: 0, y: 0 }, data: {}, width: 50 } },
    ];
    expect(resizeChanges(changes, real, store)).toEqual([
      { id: "b", type: "replace", item: { ...store[1], width: 360, style: { width: 360 } } },
    ]);
  });
});

describe("sameHandleBounds", () => {
  const handle = (id: string, y: number) => ({ id, nodeId: "n", type: "source" as const, position: "right" as Position, x: 290, y, width: 20, height: 20 });
  it("sees reordered or renamed sockets at the same size, not a fresh copy of the same ones", () => {
    const a = { source: [handle("r1", 40), handle("r2", 80)], target: null };
    expect(sameHandleBounds(a, { source: [handle("r1", 40), handle("r2", 80)], target: null })).toBe(true);
    expect(sameHandleBounds(a, { source: [handle("r1", 80), handle("r2", 40)], target: null })).toBe(false);
    expect(sameHandleBounds(a, { source: [handle("r1", 40), handle("r3", 80)], target: null })).toBe(false);
    expect(sameHandleBounds(a, { source: [handle("r1", 40)], target: null })).toBe(false);
    expect(sameHandleBounds(a, { source: [handle("r1", 40), handle("r2", 80)], target: [] })).toBe(false);
    expect(sameHandleBounds(undefined, a)).toBe(false);
  });
});
