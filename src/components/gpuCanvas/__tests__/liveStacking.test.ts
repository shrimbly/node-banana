import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";
import { GridIndex, SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene } from "@/lib/gpuCanvas/scene";
import { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import { LiveLayer, type LiveConnection } from "../LiveLayer";

function node(id: string, x: number, y: number, selected = false): WorkflowNode {
  return { id, type: "prompt", position: { x, y }, data: { prompt: "" }, width: 300, height: 200, selected } as unknown as WorkflowNode;
}

let layer: LiveLayer;
let element: HTMLDivElement;

beforeEach(() => {
  // b overlaps a and comes after it in the store; c overlaps b; d only touches c; e is far away.
  const nodes = [node("a", 0, 0), node("b", 100, 100), node("c", 300, 250), node("d", 600, 250), node("e", 2000, 0)];
  useWorkflowStore.setState({ nodes, edges: [] });
  const graph = new SceneGraph(nodes, [], {});
  for (const n of graph.nodes) n.h = 200;
  const index = new GridIndex(graph.nodes);
  const noop = () => {};
  const scene = {
    graph, nodesWithin: (x0: number, y0: number, x1: number, y1: number) => index.within(x0, y0, x1, y1),
    setHidden: noop, setHeadersLive: noop, wheel: noop, pointerDown: noop, hasPainted: () => true, pixelSnap: () => [0, 0],
  } as unknown as Scene;
  element = document.createElement("div");
  layer = new LiveLayer(element, {} as LiveConnection, scene, new GpuCanvasStats());
});

afterEach(() => layer.dispose());

describe("live nodes stack as classic's, in store order", () => {
  it("a hovered node brings the later nodes over it live too, and lets them go with it", () => {
    layer.want("a", "hover", true);
    expect(layer.has("b", "cover")).toBe(true);
    // Covering b, which is covered in turn.
    expect(layer.has("c", "cover")).toBe(true);
    // Touching is not overlapping.
    expect(layer.has("d", "cover")).toBe(false);
    expect(layer.has("e", "cover")).toBe(false);
    layer.wantOnly("hover", []);
    expect(layer.has("b", "cover")).toBe(false);
    expect(layer.has("c", "cover")).toBe(false);
  });

  it("an earlier node does not cover a later live one, nor does anything cover a selected one", () => {
    layer.want("c", "hover", true);
    expect(layer.has("b", "cover")).toBe(false);
    layer.want("c", "hover", false);
    useWorkflowStore.setState({ nodes: useWorkflowStore.getState().nodes.map((n) => n.id === "a" ? { ...n, selected: true } : n) });
    layer.want("a", "selected", true);
    expect(layer.has("b", "cover")).toBe(false);
  });
});
