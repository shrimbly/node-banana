import { describe, expect, it } from "vitest";
import { getBezierPath, getSmoothStepPath, Position } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings, type CanvasNavigationSettings } from "@/types/canvas";
import { defaultEdgeAppearance } from "@/types";
import { measuredChanges, refitMeasured, resolveHandle, SceneGraph, type SceneNode } from "../graph";
import { cubicArcLength, cubicAt, cubicPieces, cubicXExtent, distanceToCubic, PAINTED_HEADER_HEIGHT, paintedCover, pickLiveEdges, pathToCubics, routeGradientRange, routePolylines, routeSceneEdge, type RouteContext } from "../edgeRoutes";
import { EDGE_CAP_END, EDGE_CAP_START, Scene } from "../scene";
import { autoPanVelocity, closestHandle, edgeEndAt, edgeEndHandle, handleAt, marqueeNodes, paneDragAction, selectionKeyHeld } from "../gestures";
import { cachedHandle, handleFromCache } from "../paintCache";

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
    // The gradient spans the noodle from the split point, not the stem behind it.
    expect(routeGradientRange(first)[0]).toBe(first.segments[0][0]);
    expect(routeGradientRange(first)[0]).toBeGreaterThan(first.ends[0]);
  });

  it("resolves an edge's handles as React Flow does: by id, the first of the kind for none, nothing for a missing one", () => {
    const measured = { handles: new Map([["target:image", { x: 0, y: 20 }], ["source:image", { x: 300, y: 20 }], ["source:text", { x: 300, y: 60 }]]) } as SceneNode;
    expect(resolveHandle(measured, "source", "text")?.[0]).toBe("source:text");
    expect(resolveHandle(measured, "source", null)?.[0]).toBe("source:image");
    expect(resolveHandle(measured, "source", "")?.[0]).toBe("source:image");
    expect(resolveHandle(measured, "target", "gone")).toBeNull();
    expect(resolveHandle({ handles: new Map() } as SceneNode, "target", null)).toBeNull();
    expect(resolveHandle({} as SceneNode, "target", "text")).toBeUndefined();
  });

  it("draws and takes nothing for a connection to a handle its measured node does not have", () => {
    const edges = [edge("e", "a", "b", {}, "text", "gone")];
    const graph = new SceneGraph(nodes, edges, {});
    // Not measured yet: the node's mid-side stands in.
    expect(routeSceneEdge(graph, 0, context(edges, nodes)).unresolved).toBeFalsy();
    graph.nodes[0].handles = new Map([["source:text", { x: 300, y: 40, position: "right" }]]);
    graph.nodes[1].handles = new Map([["target:text", { x: 0, y: 60, position: "left" }]]);
    const route = routeSceneEdge(graph, 0, context(edges, nodes));
    expect(route.unresolved).toBe(true);
    expect(route.segments).toHaveLength(0);
    expect(route.stems).toHaveLength(0);
    expect(graph.edgeEnds(0)).toBeNull();
    expect(edgeEndAt(graph, [0, 1], 310, 40)).toBeNull();
  });

  it("carries the connections a hook sweep caught through the fork", () => {
    const edges = [edge("e", "a", "b"), edge("f", "a", "b")];
    const graph = new SceneGraph(nodes, edges, {});
    const hookDrag = { x: 450, y: -300, edgeIds: ["e"] };
    const caught = routeSceneEdge(graph, 0, { ...context(edges, nodes), hookDrag });
    const passes = (route: typeof caught) => Math.min(...route.segments.map((c) => distanceToCubic(c, 450, -300))) < 2;
    expect(passes(caught)).toBe(true);
    expect(passes(routeSceneEdge(graph, 1, { ...context(edges, nodes), hookDrag }))).toBe(false);
  });

  it("samples a route's noodle and stems as polylines", () => {
    const route = { segments: pathToCubics("M0,0 L100,0 L100,50"), stems: [{ segment: pathToCubics("M0,0 L-20,0")[0], width: 6 }] } as Parameters<typeof routePolylines>[0];
    const [noodle, stem] = routePolylines(route, 10);
    expect(noodle[0]).toEqual({ x: 0, y: 0 });
    expect(noodle[noodle.length - 1]).toEqual({ x: 100, y: 50 });
    // A point every 10 units or so, the joint not repeated.
    expect(noodle).toHaveLength(16);
    expect(stem[stem.length - 1]).toEqual({ x: -20, y: 0 });
  });

  it("draws a reference link dashed and curved", () => {
    const edges = [{ ...edge("r", "a", "b"), type: "reference" } as WorkflowEdge];
    const graph = new SceneGraph(nodes, edges, {});
    const route = routeSceneEdge(graph, 0, context(edges, nodes, "angular"));
    expect(route.dashed).toBe(true);
    expect(route.width).toBe(2);
    // In short pieces along one curve, so its dashes keep their spacing.
    expect(route.segments.length).toBeGreaterThan(1);
    for (let i = 1; i < route.segments.length; i++) expect(route.segments[i][0]).toBeCloseTo(route.segments[i - 1][6]);
  });

  it("keeps a paused reference link grey, as ReferenceEdge does", () => {
    const edges = [{ ...edge("r", "a", "b", { hasPause: true }), type: "reference" } as WorkflowEdge, edge("p", "a", "b", { hasPause: true })];
    const graph = new SceneGraph(nodes, edges, {});
    expect(graph.edges[0].color).not.toEqual(graph.edges[1].color);
  });

  it("cuts a cubic into pieces of even arc length that trace it", () => {
    const c = [0, 0, 300, 0, 0, 200, 300, 200] as Parameters<typeof cubicPieces>[0];
    const pieces = cubicPieces(c, 40);
    const lengths = pieces.map((piece) => cubicArcLength(piece));
    expect(lengths.reduce((a, b) => a + b)).toBeCloseTo(cubicArcLength(c, 200), 0);
    for (const length of lengths) expect(Math.abs(length - lengths[0])).toBeLessThan(1);
    expect(pieces[0].slice(0, 2)).toEqual([0, 0]);
    expect(pieces[pieces.length - 1].slice(6)).toEqual([300, 200]);
    // A point on a piece lies on the cubic.
    const mid = cubicAt(pieces[3], 0.5);
    expect(distanceToCubic(c, mid.x, mid.y, 400)).toBeLessThan(0.5);
  });
});

describe("connections and painted nodes", () => {
  it("finds a connection by its bundle's stem as well as its noodle", () => {
    const stemmed = { segments: pathToCubics("M100,0 L300,0"), stems: [{ segment: pathToCubics("M0,0 L60,0")[0], width: 6 }], width: 3 };
    const graph = { edges: [{}] };
    const fake = { graph, view: { x: 0, y: 0, zoom: 1 }, routes: [stemmed], edgeBounds: new Float32Array([0, 0, 300, 0]), toWorld: (x: number, y: number) => ({ x, y }) };
    expect(Scene.prototype.edgeAt.call(fake as unknown as Scene, 20, 4)).toBe(0);
    expect(Scene.prototype.edgeAt.call(fake as unknown as Scene, 20, 40)).toBe(-1);
  });

  it("takes a connection within classic's 10-unit band of its centre line, never under 7 px past its stroke", () => {
    const route = { segments: pathToCubics("M0,0 L300,0"), stems: [], width: 2 };
    const fake = (zoom: number) => ({ graph: { edges: [{}] }, view: { x: 0, y: 0, zoom }, routes: [route], edgeBounds: new Float32Array([0, 0, 300, 0]), toWorld: (x: number, y: number) => ({ x: x / zoom, y: y / zoom }) });
    const at = (zoom: number, y: number) => Scene.prototype.edgeAt.call(fake(zoom) as unknown as Scene, 100 * zoom, y * zoom);
    expect(at(1, 9.5)).toBe(0);
    expect(at(1, 10.5)).toBe(-1);
    expect(at(2, 9.5)).toBe(0);
    // Zoomed out, 7 px past the stroke is more than 10 units.
    expect(at(0.25, 25)).toBe(0);
  });

  it("gives overlapping bands to the later connection (drawn on top), even when the pointer is nearer the other", () => {
    const lower = { segments: pathToCubics("M0,0 L300,0"), stems: [], width: 2 };
    const upper = { segments: pathToCubics("M0,8 L300,8"), stems: [], width: 2 };
    const fake = { graph: { edges: [{}, {}] }, view: { x: 0, y: 0, zoom: 1 }, routes: [lower, upper], edgeBounds: new Float32Array([0, 0, 300, 0, 0, 8, 300, 8]), toWorld: (x: number, y: number) => ({ x, y }) };
    const at = (y: number) => Scene.prototype.edgeAt.call(fake as unknown as Scene, 100, y);
    expect(at(1)).toBe(1);
    expect(at(-5)).toBe(0);
  });

  it("caps a connection's ends only, so its joints do not overlap", () => {
    const route = { segments: pathToCubics("M0,0 L50,0 L50,50 L100,50"), stems: [{ segment: pathToCubics("M0,0 L-20,0")[0], width: 6 }], ends: [0, 0, 100, 50], width: 2, dashed: false, hidden: false };
    const fake = {
      routes: [route], graph: { edges: [{ source: 0, target: 1, color: [1, 1, 1] }] }, edgeLive: new Set(), edgeHeld: -1, edgeSelected: new Set(), hoveredEdge: -1, selected: new Set(),
      routeOffset: [0], routeCount: [4], edgeData: new Float32Array(4 * 20), edgeBounds: new Float32Array(4),
    };
    (Scene.prototype as unknown as { writeEdge(e: number): void }).writeEdge.call(fake, 0);
    const caps = [0, 1, 2, 3].map((k) => fake.edgeData[k * 20 + 11] & (EDGE_CAP_START | EDGE_CAP_END));
    expect(caps).toEqual([EDGE_CAP_START, 0, EDGE_CAP_END, EDGE_CAP_START | EDGE_CAP_END]);
  });

  it("hides the spare slots after a connection's pieces", () => {
    const route = { segments: pathToCubics("M0,0 L50,0"), stems: [], ends: [0, 0, 50, 0], width: 2, dashed: false, hidden: false };
    const fake = {
      routes: [route], graph: { edges: [{ source: 0, target: 1, color: [1, 1, 1] }] }, edgeLive: new Set(), edgeHeld: -1, edgeSelected: new Set(), hoveredEdge: -1, selected: new Set(),
      routeOffset: [0], routeCount: [3], edgeData: new Float32Array(3 * 20).fill(7), edgeBounds: new Float32Array(4),
    };
    (Scene.prototype as unknown as { writeEdge(e: number): void }).writeEdge.call(fake, 0);
    const hidden = 8;
    expect(fake.edgeData[11] & hidden).toBe(0);
    for (const k of [1, 2]) {
      expect(fake.edgeData[k * 20 + 11]).toBe(hidden);
      expect(fake.edgeData[k * 20 + 12]).toBe(0);
    }
  });

  it("draws a long curve in pieces, continuous and capped at its ends only", () => {
    const route = { segments: [[0, 0, 400, 0, 0, 300, 400, 300]], stems: [], ends: [0, 0, 400, 300], width: 2, dashed: false, hidden: false };
    const fake = {
      routes: [route], graph: { edges: [{ source: 0, target: 1, color: [1, 1, 1] }] }, edgeLive: new Set(), edgeHeld: -1, edgeSelected: new Set(), hoveredEdge: -1, selected: new Set(),
      routeOffset: [0], routeCount: [16], edgeData: new Float32Array(16 * 20), edgeBounds: new Float32Array(4),
    };
    (Scene.prototype as unknown as { writeEdge(e: number): void }).writeEdge.call(fake, 0);
    const pieces: number[][] = [];
    for (let k = 0; k < 16 && fake.edgeData[k * 20 + 12] > 0; k++) pieces.push([...fake.edgeData.slice(k * 20, k * 20 + 12)]);
    expect(pieces.length).toBeGreaterThan(4);
    for (let k = 1; k < pieces.length; k++) {
      expect(pieces[k][0]).toBeCloseTo(pieces[k - 1][6], 3);
      expect(pieces[k][1]).toBeCloseTo(pieces[k - 1][7], 3);
      expect(pieces[k][11] & EDGE_CAP_START).toBe(0);
    }
    expect(pieces[pieces.length - 1].slice(6, 8)).toEqual([400, 300]);
    expect(pieces[pieces.length - 1][11] & EDGE_CAP_END).toBe(EDGE_CAP_END);
  });

  it("names the painted nodes over live connections and the connections they cover", () => {
    const nodes = [node("a", 0, 0), node("b", 600, 0), node("over", 300, -50), node("far", 0, 2000)];
    const edges = [edge("e", "a", "b"), edge("f", "a", "far")];
    const graph = new SceneGraph(nodes, edges, {});
    const routes = [
      { ends: [300, 50, 600, 50], segments: pathToCubics("M300,50 L600,50"), stems: [] },
      { ends: [300, 50, 0, 2050], segments: [], stems: [] },
    ] as unknown as ReturnType<typeof routeSceneEdge>[];
    const within = (x0: number, y0: number, x1: number, y1: number) =>
      graph.nodes.flatMap((n, i) => (n.x <= x1 && n.x + n.w >= x0 && n.y <= y1 && n.y + n.h >= y0 ? [i] : []));
    const cover = paintedCover(graph, [0], (e) => routes[e], within, (id) => id === "a" || id === "b");
    expect(cover.edgeIds).toEqual(["e"]);
    // The box reaches up over the painted header strip, which classic keeps above every edge.
    expect(cover.boxes).toEqual([{ x: 300, y: -50 - PAINTED_HEADER_HEIGHT, w: 300, h: graph.nodes[2].h + PAINTED_HEADER_HEIGHT }]);
    // Nothing painted near it: nothing to mask.
    expect(paintedCover(graph, [0], (e) => routes[e], within, () => true)).toEqual({ edgeIds: [], boxes: [] });
  });

  it("masks an unselected hidden connection only where another painted node lies over its handle strokes", () => {
    // a's handle at (300, 50) touches a and b; "over" crosses it, "near" lies within reach of the line but not of the strokes.
    const nodes = [node("a", 0, 0), node("b", 600, 0), node("over", 290, 40), node("near", 420, 100)];
    const graph = new SceneGraph(nodes, [edge("e", "a", "b", { hidden: true })], {});
    const route = { ends: [300, 50, 600, 50], segments: [], stems: [], hidden: true } as unknown as ReturnType<typeof routeSceneEdge>;
    const within = (x0: number, y0: number, x1: number, y1: number) =>
      graph.nodes.flatMap((n, i) => (n.x <= x1 && n.x + n.w >= x0 && n.y <= y1 && n.y + n.h >= y0 ? [i] : []));
    const painted = (id: string) => id === "a" || id === "b";
    expect(paintedCover(graph, [0], () => route, within, (id) => id !== "over").edgeIds).toEqual(["e"]);
    expect(paintedCover(graph, [0], () => route, within, (id) => id === "over" || painted(id))).toEqual({ edgeIds: [], boxes: [] });
    // Its own ends and a node past its strokes never mask it.
    expect(paintedCover(graph, [0], () => route, within, (id) => id === "over")).toEqual({ edgeIds: [], boxes: [] });
  });
});

describe("pickLiveEdges", () => {
  it("keeps every connection on screen and fills what is left of the limit from the margin, nearest first", () => {
    const candidates = [
      { id: "far", distance: 900, onScreen: false },
      { id: "s1", distance: 500, onScreen: true },
      { id: "near", distance: 100, onScreen: false },
      { id: "s2", distance: 50, onScreen: true },
    ];
    expect(pickLiveEdges(candidates, 3)).toEqual(["s1", "s2", "near"]);
    expect(pickLiveEdges(candidates, 10)).toEqual(["s1", "s2", "near", "far"]);
    // More on screen than the limit: all of them, none from the margin.
    expect(pickLiveEdges(candidates, 1)).toEqual(["s1", "s2"]);
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
  const press = (patch: Partial<{ button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; space: boolean }> = {}) => ({ button: 0, shiftKey: false, altKey: false, ctrlKey: false, space: false, ...patch });

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

  it("starts no pan with Control held, as d3-zoom's default filter", () => {
    expect(paneDragAction(settings({}), press({ ctrlKey: true }), false)).toBe(null);
    expect(paneDragAction(settings({}), press({ ctrlKey: true, button: 1 }), false)).toBe(null);
    expect(paneDragAction(settings({ panMode: "space" }), press({ ctrlKey: true, space: true }), true)).toBe(null);
    expect(paneDragAction(settings({ panMode: "middleMouse" }), press({ ctrlKey: true, button: 2 }), true)).toBe(null);
    // A marquee is the pane's, not d3-zoom's: Control does not stop it.
    expect(paneDragAction(settings({}), press({ ctrlKey: true }), true)).toBe("select");
  });

  it("starts no pan with the selection key held, whatever the button", () => {
    expect(paneDragAction(settings({}), press({ shiftKey: true, button: 1 }), false)).toBe(null);
    expect(paneDragAction(settings({ panMode: "middleMouse" }), press({ shiftKey: true, button: 2 }), true)).toBe(null);
    expect(paneDragAction(settings({ panMode: "space" }), press({ shiftKey: true, space: true, button: 1 }), true)).toBe(null);
    expect(paneDragAction(settings({ panMode: "always", selectionMode: "altDrag" }), press({ altKey: true, button: 1 }), true)).toBe(null);
    expect(paneDragAction(settings({ panMode: "always", selectionMode: "altDrag" }), press({ shiftKey: true, button: 1 }), true)).toBe("pan");
  });

  it("tells the selection key, which selects over nodes too, from selecting on drag, which starts only on the pane", () => {
    const defaults = settings({});
    expect(selectionKeyHeld(defaults, press())).toBe(false);
    expect(selectionKeyHeld(defaults, press({ shiftKey: true }))).toBe(true);
    expect(selectionKeyHeld(defaults, press({ shiftKey: true, button: 1 }))).toBe(false);
    expect(selectionKeyHeld(settings({ selectionMode: "altDrag" }), press({ shiftKey: true }))).toBe(false);
    expect(selectionKeyHeld(settings({ selectionMode: "altDrag" }), press({ altKey: true }))).toBe(true);
  });
});

describe("hit tests", () => {
  it("finds the nearest measured handle", () => {
    const graph = new SceneGraph([node("a", 100, 100)], [], {});
    graph.nodes[0].handles = new Map([["source:image", { x: 300, y: 50 }], ["target:text", { x: 0, y: 50 }]]);
    expect(handleAt(graph, [0], 402, 151, 10)).toMatchObject({ node: 0, handleId: "image", type: "source", x: 400, y: 150 });
    expect(handleAt(graph, [0], 250, 150, 10)).toBeNull();
  });

  // A schema node's Prompt row as React Flow measures it: the socket's 18×28 box 15 px out from the card,
  // and the legacy `text` socket hidden at the card's edge on the same row.
  function socketGraph() {
    const graph = new SceneGraph([node("a", 100, 100), node("b", 600, 100)], [], {});
    graph.nodes[0].handles = new Map([
      ["target:text-0", { x: -15, y: 50, position: "left", box: { x: -15, y: 36, w: 18, h: 28 }, connectableStart: true, connectableEnd: true }],
      ["target:text", { x: 0, y: 50, position: "left", box: { x: 0, y: 50, w: 0, h: 0 }, connectableStart: false, connectableEnd: false }],
    ]);
    graph.nodes[1].handles = new Map([
      ["source:text", { x: 315, y: 50, position: "right", box: { x: 297, y: 36, w: 18, h: 28 }, connectableStart: true, connectableEnd: true }],
    ]);
    return graph;
  }

  it("takes a socket where its ellipse reaches, never a hidden one", () => {
    const graph = socketGraph();
    // The hole (5.5 px out), a little inside the card, and the ellipse's far edge.
    for (const [x, y] of [[94.5, 150], [105, 150], [80, 150], [94, 166]]) {
      expect(handleAt(graph, [0], x, y, 9)).toMatchObject({ node: 0, handleId: "text-0", type: "target", x: 85, y: 150, cx: 94, cy: 150 });
    }
    expect(handleAt(graph, [0], 94, 170, 9)).toBeNull();
    expect(handleAt(graph, [0], 120, 150, 9)).toBeNull();
    // A small zoom keeps a floor round the centre.
    expect(handleAt(graph, [0], 94, 175, 30)).toMatchObject({ handleId: "text-0" });
  });

  it("finds the nearest connectable handle centre for a connection, as React Flow", () => {
    const graph = socketGraph();
    const from = handleAt(graph, [1], 909, 150, 9)!;
    expect(from).toMatchObject({ handleId: "text", type: "source", cx: 906 });
    expect(closestHandle(graph, [0, 1], 99, 150, 20, "target", from)).toMatchObject({ node: 0, handleId: "text-0" });
    expect(closestHandle(graph, [0, 1], 120, 150, 20, "target", from)).toBeNull();
    // The handle it starts from is left out.
    expect(closestHandle(graph, [1], 906, 150, 20, "target", from)).toBeNull();
    // On a tie the opposite kind wins.
    graph.nodes[0].handles!.set("source:out", { x: 0, y: 0, box: { x: -9, y: -14, w: 18, h: 28 } });
    graph.nodes[0].handles!.set("target:in", { x: 0, y: 0, box: { x: -9, y: -14, w: 18, h: 28 } });
    expect(closestHandle(graph, [0], 100, 105, 20, "target")).toMatchObject({ handleId: "in", type: "target" });
    expect(closestHandle(graph, [0], 100, 105, 20, "source")).toMatchObject({ handleId: "out", type: "source" });
  });

  it("keeps a handle's box and connectability in the disk cache", () => {
    const graph = socketGraph();
    for (const [key, anchor] of graph.nodes[0].handles!) expect(handleFromCache(cachedHandle(key, anchor))).toEqual([key, anchor]);
    expect(handleFromCache(["source:image", 1, 2, "right"])).toEqual(["source:image", { x: 1, y: 2, position: "right" }]);
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

  it("judges a node by the card measured as it shows now over the painted one", () => {
    const graph = new SceneGraph([node("a", 0, 0), node("b", 400, 0)], [], {});
    graph.nodes[0].h = 300;
    graph.nodes[1].h = 300;
    graph.nodes[0].card = { x: 0, y: 0, w: 300, h: 280 };
    const marquee = { left: -10, top: -10, right: 1000, bottom: 250 };
    const cards = new Map([[0, { x: 0, y: 0, w: 300, h: 200 }], [1, { x: 0, y: 40, w: 300, h: 150 }]]);
    expect(marqueeNodes(graph, [0, 1], marquee)).toEqual([]);
    expect(marqueeNodes(graph, [0, 1], marquee, cards)).toEqual([0, 1]);
    // A live node without a card is taken whole.
    expect(marqueeNodes(graph, [0, 1], marquee, new Map([[0, null]]))).toEqual([]);
  });
});

describe("measuredChanges", () => {
  it("reports the scene's measured sizes the store does not know yet", () => {
    const nodes = [node("a", 0, 0), { ...node("b", 400, 0), measured: { width: 300, height: 180 } }, { ...node("c", 800, 0), measured: { width: 300, height: 100 } }] as WorkflowNode[];
    const graph = new SceneGraph(nodes, [], {});
    graph.nodes[0].h = 150;
    graph.nodes[1].h = 180.3;
    graph.nodes[2].h = 240;
    const indexOf = (id: string) => nodes.findIndex((n) => n.id === id);
    expect(measuredChanges(nodes, indexOf, graph, ["a", "b", "c", "gone"])).toEqual([
      { type: "dimensions", id: "a", dimensions: { width: 300, height: 150 }, setAttributes: false },
      { type: "dimensions", id: "c", dimensions: { width: 300, height: 240 }, setAttributes: false },
    ]);
  });
});

describe("edgeEndAt", () => {
  const nodes = [node("a", 0, 0), node("b", 600, 0)];
  const graph = () => {
    const g = new SceneGraph(nodes, [edge("ab", "a", "b")], {});
    g.nodes[0].handles = new Map([["source:text", { x: 315, y: 100, position: "right" }]]);
    g.nodes[1].handles = new Map([["target:text", { x: -15, y: 100, position: "left" }]]);
    return g;
  };

  it("finds React Flow's reconnect anchors: 10 flow units round each end, shifted 10 outward", () => {
    const g = graph();
    expect(edgeEndAt(g, [0, 1], 325, 100)).toEqual({ edge: 0, end: "source" });
    expect(edgeEndAt(g, [0, 1], 575, 108)).toEqual({ edge: 0, end: "target" });
    // Inward of the end is the handle's, not the anchor's.
    expect(edgeEndAt(g, [0, 1], 300, 100)).toBeNull();
    expect(edgeEndAt(g, [0, 1], 450, 100)).toBeNull();
  });

  it("skips connections React Flow does not render or cannot reconnect", () => {
    const g = graph();
    g.edges[0].edge = { ...g.edges[0].edge, reconnectable: false };
    expect(edgeEndAt(g, [0, 1], 325, 100)).toBeNull();
  });

  it("gives the handle at the other end to draw from", () => {
    expect(edgeEndHandle(graph(), 0, "source")).toMatchObject({ node: 0, handleId: "text", type: "source", x: 315, y: 100 });
  });
});

describe("autoPanVelocity", () => {
  it("is React Flow's calcAutoPan: nothing inside 40 px of the edges, up to 15 px a frame at them", () => {
    const size = { width: 1000, height: 800 };
    expect(autoPanVelocity({ x: 500, y: 400 }, size)).toEqual([0, 0]);
    expect(autoPanVelocity({ x: 0, y: 400 }, size)).toEqual([15, 0]);
    expect(autoPanVelocity({ x: 20, y: 790 }, size)).toEqual([7.5, -11.25]);
    expect(autoPanVelocity({ x: 1100, y: -50 }, size)).toEqual([-15, 15]);
  });
});

describe("cubicXExtent", () => {
  it("spans a backward curve's own overshoot, not its control points", () => {
    // A 400-unit backward bezier, as getBezierPath draws one (offset 0.25 * 25 * sqrt(400) = 125).
    const c = [400, 0, 525, 0, -125, 200, 0, 200] as Parameters<typeof cubicXExtent>[0];
    const [min, max] = cubicXExtent(c);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k <= 1000; k++) {
      const { x } = cubicAt(c, k / 1000);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    expect(min).toBeCloseTo(lo, 1);
    expect(max).toBeCloseTo(hi, 1);
    expect(max - min).toBeLessThan(450);
  });

  it("is the ends for a forward curve and a line", () => {
    expect(cubicXExtent([0, 0, 100, 0, 100, 50, 200, 50])).toEqual([0, 200]);
    expect(cubicXExtent([50, 0, 40, 0, 10, 0, 0, 0])).toEqual([0, 50]);
  });
});

describe("refitMeasured", () => {
  it("keeps right-hand handles on the right side and stretches a full-width card", () => {
    const n: SceneNode = {
      id: "a", type: "prompt", x: 0, y: 0, w: 300, h: 200, color: [0, 0, 0], measuredW: 300,
      handles: new Map([
        ["source:text", { x: 300, y: 40, position: "right", box: { x: 292, y: 32, w: 16, h: 16 } }],
        ["source:legacy", { x: 300, y: 60 }],
        ["target:text", { x: 0, y: 40, position: "left" }],
        ["target:top", { x: 150, y: 0, position: "top" }],
      ]),
      card: { x: 0, y: 0, w: 300, h: 120 },
    };
    n.w = 400;
    refitMeasured(n, 400);
    expect(n.handles!.get("source:text")).toMatchObject({ x: 400, box: { x: 392 } });
    expect(n.handles!.get("source:legacy")!.x).toBe(400);
    expect(n.handles!.get("target:text")!.x).toBe(0);
    expect(n.handles!.get("target:top")!.x).toBe(200);
    expect(n.card).toEqual({ x: 0, y: 0, w: 400, h: 120 });
    expect(n.measuredW).toBe(400);
    // Measured at that width already: nothing moves.
    refitMeasured(n, 400);
    expect(n.handles!.get("source:text")!.x).toBe(400);
  });

  it("moves a node's handles when the store widens it in place", () => {
    const nodes = [node("a", 0, 0), node("b", 600, 0)];
    const edges = [edge("e", "a", "b")];
    const graph = new SceneGraph(nodes, edges, {});
    graph.nodes[0].handles = new Map([["source:text", { x: 300, y: 40, position: "right" }]]);
    graph.nodes[0].measuredW = 300;
    const wider = [{ ...nodes[0], width: 360 } as WorkflowNode, nodes[1]];
    graph.sync(wider, edges, {});
    expect(graph.nodes[0].w).toBe(360);
    expect(graph.nodes[0].handles!.get("source:text")!.x).toBe(360);
  });
});
