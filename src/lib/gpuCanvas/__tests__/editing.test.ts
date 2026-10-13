import { describe, expect, it } from "vitest";
import { getBezierPath, getSmoothStepPath, Position } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings, type CanvasNavigationSettings } from "@/types/canvas";
import { defaultEdgeAppearance } from "@/types";
import { SceneGraph } from "../graph";
import { cubicAt, distanceToCubic, pathToCubics, routeSceneEdge, type RouteContext } from "../edgeRoutes";
import { handleAt, marqueeNodes, paneDragAction } from "../gestures";

function node(id: string, x: number, y: number, data: Record<string, unknown> = {}, type = "prompt"): WorkflowNode {
  return { id, type, position: { x, y }, data, width: 300 } as unknown as WorkflowNode;
}

function edge(id: string, source: string, target: string, data: Record<string, unknown> = {}, sourceHandle = "text", targetHandle = "text"): WorkflowEdge {
  return { id, source, target, sourceHandle, targetHandle, data } as WorkflowEdge;
}

function context(graphEdges: WorkflowEdge[], nodes: WorkflowNode[], style: RouteContext["style"] = "curved"): RouteContext {
  return { style, appearance: defaultEdgeAppearance, edges: graphEdges, nodes, thicknessPx: 3 };
}

describe("pathToCubics", () => {
  it("reads React Flow's bezier and step paths into cubics that pass through the same points", () => {
    const [bezier] = getBezierPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 100, targetPosition: Position.Left });
    const curve = pathToCubics(bezier);
    expect(curve).toHaveLength(1);
    expect(curve[0][0]).toBe(0);
    expect(curve[0][6]).toBe(300);
    expect(curve[0][7]).toBe(100);

    const [step] = getSmoothStepPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 100, targetPosition: Position.Left, borderRadius: 8 });
    const steps = pathToCubics(step);
    expect(steps.length).toBeGreaterThan(2);
    // Consecutive segments join, and the route ends at the target.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i][0]).toBeCloseTo(steps[i - 1][6]);
      expect(steps[i][1]).toBeCloseTo(steps[i - 1][7]);
    }
    expect(steps[steps.length - 1][6]).toBeCloseTo(300);
    expect(steps[steps.length - 1][7]).toBeCloseTo(100);
  });

  it("measures distance to a curve", () => {
    const [line] = pathToCubics("M0,0 L100,0");
    expect(cubicAt(line, 0.5)).toEqual({ x: 50, y: 0 });
    expect(distanceToCubic(line, 50, 10)).toBeCloseTo(10);
  });
});

describe("routeSceneEdge", () => {
  const nodes = [node("a", 0, 0), node("b", 600, 200)];

  it("routes a connection as the edge style says, between the measured handles", () => {
    const edges = [edge("e", "a", "b")];
    const graph = new SceneGraph(nodes, edges, {});
    graph.nodes[0].handles = new Map([["source:text", { x: 300, y: 40, position: "right" }]]);
    graph.nodes[1].handles = new Map([["target:text", { x: 0, y: 60, position: "left" }]]);
    const curved = routeSceneEdge(graph, 0, context(edges, nodes));
    expect(curved.ends).toEqual([300, 40, 600, 260]);
    expect(curved.segments).toHaveLength(1);
    expect(curved.decorated).toBe(false);
    const angular = routeSceneEdge(graph, 0, context(edges, nodes, "angular"));
    expect(angular.segments.length).toBeGreaterThan(2);
  });

  it("marks connections that show more than a line, and draws no line for a hidden one", () => {
    const edges = [edge("e", "a", "b", { label: "hero" }), edge("h", "a", "b", { hidden: true }), edge("p", "a", "b", { hasPause: true })];
    const graph = new SceneGraph(nodes, edges, {});
    expect(routeSceneEdge(graph, 0, context(edges, nodes)).decorated).toBe(true);
    const hidden = routeSceneEdge(graph, 1, context(edges, nodes));
    expect(hidden.hidden).toBe(true);
    expect(hidden.segments).toHaveLength(0);
    expect(routeSceneEdge(graph, 2, context(edges, nodes)).decorated).toBe(true);
  });

  it("draws a bundle's stem once and starts its members past it", () => {
    const fan = [node("a", 0, 0), node("b", 600, 0), node("c", 600, 400)];
    const edges = [
      edge("e1", "a", "b", { sourceBundleId: "x", createdAt: 1 }),
      edge("e2", "a", "c", { sourceBundleId: "x", createdAt: 2 }),
    ];
    const graph = new SceneGraph(fan, edges, {});
    const first = routeSceneEdge(graph, 0, context(edges, fan));
    const second = routeSceneEdge(graph, 1, context(edges, fan));
    expect(first.stems).toHaveLength(1);
    expect(second.stems).toHaveLength(0);
    // Both noodles leave from the stem's end, not the handle.
    expect(first.segments[0][0]).toBeGreaterThan(300);
    expect(second.segments[0][0]).toBe(first.segments[0][0]);
  });

  it("draws a reference link dashed and curved", () => {
    const edges = [{ ...edge("r", "a", "b"), type: "reference" } as WorkflowEdge];
    const graph = new SceneGraph(nodes, edges, {});
    const route = routeSceneEdge(graph, 0, context(edges, nodes, "angular"));
    expect(route.dashed).toBe(true);
    expect(route.width).toBe(2);
    expect(route.segments).toHaveLength(1);
  });
});

describe("SceneGraph edges", () => {
  it("updates replaced edges in place and rebuilds when one is added", () => {
    const nodes = [node("a", 0, 0), node("b", 600, 0)];
    const e1 = edge("e1", "a", "b");
    const graph = new SceneGraph(nodes, [e1], {});
    const selected = { ...e1, selected: true };
    const sync = graph.sync(nodes, [selected], {});
    expect(sync.edgesChanged).toBe(false);
    expect(sync.edgesUpdated).toEqual([0]);
    expect(graph.edges[0].edge).toBe(selected);
    const added = graph.sync(nodes, [selected, edge("e2", "b", "a")], {});
    expect(added.edgesChanged).toBe(true);
    expect(graph.edgeIndexOf.get("e2")).toBe(1);
  });
});

describe("paneDragAction", () => {
  const settings = (patch: Partial<CanvasNavigationSettings>): CanvasNavigationSettings => ({ ...defaultCanvasNavigationSettings, ...patch });
  const press = (patch: Partial<{ button: number; shiftKey: boolean; altKey: boolean; space: boolean }> = {}) => ({ button: 0, shiftKey: false, altKey: false, space: false, ...patch });

  it("follows today's canvas: off the Mac a drag pans, on the Mac it draws a marquee, Shift always draws one", () => {
    const defaults = settings({});
    expect(paneDragAction(defaults, press(), false)).toBe("pan");
    expect(paneDragAction(defaults, press(), true)).toBe("select");
    expect(paneDragAction(defaults, press({ shiftKey: true }), false)).toBe("select");
    expect(paneDragAction(defaults, press({ space: true }), true)).toBe("pan");
    expect(paneDragAction(defaults, press({ button: 1 }), false)).toBe("pan");
  });

  it("honours the pan and selection modes", () => {
    expect(paneDragAction(settings({ panMode: "always" }), press(), true)).toBe("pan");
    expect(paneDragAction(settings({ panMode: "middleMouse" }), press({ button: 2 }), true)).toBe("pan");
    expect(paneDragAction(settings({ panMode: "middleMouse" }), press(), false)).toBe(null);
    expect(paneDragAction(settings({ selectionMode: "altDrag" }), press({ altKey: true }), false)).toBe("select");
    expect(paneDragAction(settings({ selectionMode: "altDrag" }), press({ shiftKey: true }), false)).toBe("pan");
    expect(paneDragAction(settings({ selectionMode: "shiftDrag" }), press(), true)).toBe(null);
  });
});

describe("hit tests", () => {
  it("finds the nearest measured handle", () => {
    const graph = new SceneGraph([node("a", 100, 100)], [], {});
    graph.nodes[0].handles = new Map([["source:image", { x: 300, y: 50 }], ["target:text", { x: 0, y: 50 }]]);
    expect(handleAt(graph, [0], 402, 151, 10)).toMatchObject({ node: 0, handleId: "image", type: "source", x: 400, y: 150 });
    expect(handleAt(graph, [0], 250, 150, 10)).toBeNull();
  });

  it("takes a node only when the marquee holds its media card, or the whole node without one", () => {
    const graph = new SceneGraph([node("a", 0, 0), node("b", 400, 0)], [], {});
    graph.nodes[0].h = 300;
    graph.nodes[1].h = 300;
    graph.nodes[0].card = { x: 0, y: 0, w: 300, h: 200 };
    const marquee = { left: -10, top: -10, right: 1000, bottom: 250 };
    expect(marqueeNodes(graph, [0, 1], marquee)).toEqual([0]);
    expect(marqueeNodes(graph, [0, 1], { ...marquee, bottom: 400 })).toEqual([0, 1]);
  });
});
