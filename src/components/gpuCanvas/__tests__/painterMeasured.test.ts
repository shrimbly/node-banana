import { beforeEach, describe, expect, it } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";
import { SceneGraph, type HandleAnchor } from "@/lib/gpuCanvas/graph";
import { Painter } from "../painter";

function node(id: string, height: number): WorkflowNode {
  return { id, type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "" }, width: 300, measured: { width: 300, height } } as unknown as WorkflowNode;
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("a painted measurement of a live node", () => {
  let painter: Painter;
  let graph: SceneGraph;
  let hidden: Set<number>;

  beforeEach(() => {
    const nodes = [node("a", 260)];
    useWorkflowStore.setState({ nodes, edges: [] });
    graph = new SceneGraph(nodes, [], {});
    graph.nodes[0].h = 260;
    hidden = new Set([0]);
    const scene = {
      graph,
      isHidden: (i: number) => hidden.has(i),
      setNodeHeight: (i: number, h: number) => { graph.nodes[i].h = h; },
      setOverhang: (i: number, overhang: unknown) => { graph.nodes[i].overhang = overhang as never; },
      setHandles: (i: number, handles: Map<string, HandleAnchor>) => { graph.nodes[i].handles = handles; },
    };
    // Only what applyMeasured and its store report read: no WebGL, no sheet.
    painter = Object.assign(Object.create(Painter.prototype) as Painter, { scene, paints: new Map(), measuredIds: new Set(), reportedSizes: new Set(), disposed: false });
  });

  const apply = (height: number, handles?: Map<string, HandleAnchor>) =>
    (painter as unknown as { applyMeasured: (id: string, h: number, handles?: Map<string, HandleAnchor>) => void }).applyMeasured("a", height, handles);
  const storeHeight = () => useWorkflowStore.getState().nodes[0].measured?.height;

  it("keeps the live height in the scene and the store; the painted one returns as the node leaves", async () => {
    const handles = new Map([["target:text", { x: 0, y: 100 }]]);
    apply(200, handles);
    await flush();
    expect(graph.nodes[0].h).toBe(260);
    expect(graph.nodes[0].handles).toBeUndefined();
    expect(storeHeight()).toBe(260);
    // Back on the scene: the painted image's box, and the store hears it.
    hidden.clear();
    expect(painter.restoreMeasured("a")).toBe(true);
    await flush();
    expect(graph.nodes[0].h).toBe(200);
    expect(graph.nodes[0].handles).toBe(handles);
    expect(storeHeight()).toBe(200);
  });

  it("a painted node takes its painted height at once", async () => {
    hidden.clear();
    apply(220);
    await flush();
    expect(graph.nodes[0].h).toBe(220);
    expect(storeHeight()).toBe(220);
  });
});
