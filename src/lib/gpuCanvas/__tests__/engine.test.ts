import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { GridIndex, SceneGraph } from "../graph";
import { AtlasLayout } from "../atlasLayout";
import { atlasBudget } from "../budget";
import { edgesByNode, hashData, paintKey, upstreamPaintKeys, type PaintKeyContext } from "../paintKey";
import { BACKGROUND, EIGHTH, PaintQueue, URGENT, VIEW, packSheet, tierToShow, tiersFor, wantedTier } from "../paintQueue";

function node(id: string, x: number, y: number, data: Record<string, unknown> = {}, type = "prompt"): WorkflowNode {
  return { id, type, position: { x, y }, data, width: 300 } as unknown as WorkflowNode;
}

function edge(id: string, source: string, target: string, sourceHandle = "text", targetHandle = "text"): WorkflowEdge {
  return { id, source, target, sourceHandle, targetHandle } as WorkflowEdge;
}

describe("SceneGraph", () => {
  it("moves nodes in place and rebuilds when nodes are added", () => {
    const a = node("a", 0, 0), b = node("b", 400, 0);
    const graph = new SceneGraph([a, b], [edge("e", "a", "b")], {});
    expect(graph.edges).toHaveLength(1);
    expect(graph.edgeEnds(0)).toEqual([300, graph.nodes[0].h / 2, 400, graph.nodes[1].h / 2]);

    const moved = { ...b, position: { x: 500, y: 10 } };
    const sync = graph.sync([a, moved], [edge("e", "a", "b")], {});
    expect(sync.rebuilt).toBe(false);
    expect(sync.moved).toEqual([1]);
    expect(graph.nodes[1].x).toBe(500);

    const sync2 = graph.sync([a, moved, node("c", 0, 600)], [], {});
    expect(sync2.rebuilt).toBe(true);
    expect(graph.indexOf.get("c")).toBe(2);
    expect(graph.edges).toHaveLength(0);
  });

  it("keeps a measured height and handle anchors across a rebuild", () => {
    const graph = new SceneGraph([node("a", 0, 0)], [], {});
    graph.nodes[0].h = 777;
    graph.nodes[0].handles = new Map([["source:text", { x: 300, y: 40 }]]);
    graph.sync([node("a", 0, 0), node("b", 0, 900)], [edge("e", "a", "b")], {});
    expect(graph.nodes[0].h).toBe(777);
    expect(graph.edgeEnds(0).slice(0, 2)).toEqual([300, 40]);
  });
});

describe("GridIndex", () => {
  it("finds the topmost node under a point and follows moves", () => {
    const graph = new SceneGraph([node("a", 0, 0), node("b", 100, 100)], [], {});
    const index = new GridIndex(graph.nodes);
    expect(index.at(150, 150)).toBe(1);
    expect(index.at(10, 10)).toBe(0);
    expect(index.at(-10, -10)).toBe(-1);
    graph.nodes[1].x = 2000;
    index.update(1);
    expect(index.at(150, 150)).toBe(0);
    expect(index.at(2100, 150)).toBe(1);
    expect(index.within(1900, 0, 2500, 400)).toEqual([1]);
  });
});

describe("AtlasLayout", () => {
  it("shelf-packs 1/8 images and reuses a released slot of the same size", () => {
    const atlas = new AtlasLayout(256, 4);
    const a = atlas.allocateShelf(40, 50, EIGHTH)!;
    const b = atlas.allocateShelf(40, 50, EIGHTH)!;
    expect(a.layer).toBe(b.layer);
    expect(b.x).toBe(a.x + 42);
    atlas.release(a);
    expect(atlas.allocateShelf(40, 50, EIGHTH)).toEqual(a);
  });

  it("frees a slab's layer when its last cell goes", () => {
    const atlas = new AtlasLayout(512, 2);
    const one = atlas.allocateCell(1, 300, 400, "a")!;
    const two = atlas.allocateCell(1, 300, 400, "b")!;
    expect(one.layer).not.toBe(two.layer);
    expect(atlas.allocateCell(1, 300, 400, "c")).toBeNull();
    expect(atlas.cellOwners(1).sort()).toEqual(["a", "b"]);
    atlas.release(one);
    expect(atlas.layersInUse()).toBe(1);
    expect(atlas.allocateCell(1, 300, 400, "c")).not.toBeNull();
  });

  it("puts small cell classes in quarters of a layer, freeing the layer with its last slab", () => {
    const atlas = new AtlasLayout(2048, 2);
    // Four classes of 1/4 images share one layer, one quarter each.
    const slots = [60, 120, 180, 240].map((h, k) => atlas.allocateCell(0.25, 80, h, `n${k}`)!);
    expect(new Set(slots.map((s) => s.layer)).size).toBe(1);
    expect(new Set(slots.map((s) => `${s.x < 1024}:${s.y < 1024}`)).size).toBe(4);
    expect(atlas.layersInUse()).toBe(1);
    // A fifth class opens the next layer.
    expect(atlas.allocateCell(0.25, 140, 60, "n4")!.layer).not.toBe(slots[0].layer);
    for (const slot of slots) atlas.release(slot);
    expect(atlas.layersInUse()).toBe(1);
    expect(atlas.cellOwners(0.25)).toEqual(["n4"]);
  });
});

describe("atlasBudget", () => {
  it("gives integrated GPUs and small machines half", () => {
    expect(atlasBudget({ renderer: "ANGLE (NVIDIA GeForce RTX 4090)", maxTextureSize: 16384, maxArrayLayers: 2048 }).bytes).toBe(256 * 2 ** 20);
    expect(atlasBudget({ renderer: "Apple M5 Pro", maxTextureSize: 16384, maxArrayLayers: 2048 }).layers).toBe(16);
    expect(atlasBudget({ renderer: "ANGLE (Intel(R) UHD Graphics 620)", maxTextureSize: 16384, maxArrayLayers: 2048 }).layers).toBe(8);
    expect(atlasBudget({ renderer: "NVIDIA", maxTextureSize: 16384, maxArrayLayers: 2048, deviceMemoryGb: 4 }).layers).toBe(8);
  });
});

describe("paintKey", () => {
  const context = (nodes: WorkflowNode[], edges: WorkflowEdge[]): PaintKeyContext => {
    const byNode = edgesByNode(edges);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return { nodeById: (id) => byId.get(id), edgesOf: (id) => byNode.get(id) ?? [], salt: "test" };
  };

  it("ignores position and selection, follows data, sockets and upstream data", () => {
    const a = node("a", 0, 0, { prompt: "hi" }), b = node("b", 400, 0, {}, "output");
    const base = paintKey(b, context([a, b], [edge("e", "a", "b")]));
    expect(paintKey({ ...b, position: { x: 9, y: 9 }, selected: true }, context([a, b], [edge("e", "a", "b")]))).toBe(base);
    expect(paintKey(b, context([a, b], []))).not.toBe(base);
    const a2 = { ...a, data: { prompt: "hello" } };
    expect(paintKey(b, context([a2, b], [edge("e", "a", "b")]))).not.toBe(base);
  });

  it("takes in changes anywhere upstream, and survives cycles", () => {
    const a = node("a", 0, 0, { prompt: "hi" }), b = node("b", 400, 0, {}), c = node("c", 800, 0, {}, "output");
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];
    const base = upstreamPaintKeys(context([a, b, c], edges))("c");
    expect(upstreamPaintKeys(context([{ ...a, data: { prompt: "hello" } }, b, c], edges))("c")).not.toBe(base);
    expect(upstreamPaintKeys(context([a, b, c], edges))("c")).toBe(base);
    const looped = upstreamPaintKeys(context([a, b, c], [...edges, edge("e3", "c", "a")]));
    expect(looped("c")).toBeTruthy();
  });

  it("hashes the same data the same way whatever its key order, and long strings by content", () => {
    expect(hashData({ a: 1, b: "x" })).toBe(hashData({ b: "x", a: 1 }));
    const long = "x".repeat(10_000);
    expect(hashData({ image: long })).toBe(hashData({ image: "x".repeat(10_000) }));
    expect(hashData({ image: long })).not.toBe(hashData({ image: `${"x".repeat(9_999)}y` }));
  });

  it("leaves a node's file refs out, so a save that records them repaints nothing", () => {
    expect(hashData({ image: "a.png", imageRef: "img-1", inputImageRefs: ["img-2"] })).toBe(hashData({ image: "a.png" }));
    expect(hashData({ settings: { styleRef: "x" } })).not.toBe(hashData({ settings: {} }));
  });
});

describe("paint queue", () => {
  it("chooses tiers by zoom and display scale", () => {
    expect(tiersFor(2)).toEqual([EIGHTH, 0.25, 0.5, 1, 2]);
    expect(tiersFor(1.5)).toEqual([EIGHTH, 0.25, 0.5, 1, 1.5]);
    expect(wantedTier(0.05, 2, tiersFor(2))).toBe(EIGHTH);
    expect(wantedTier(0.4, 2, tiersFor(2))).toBe(1);
    expect(wantedTier(1, 2, tiersFor(2))).toBe(2);
    expect(tierToShow([EIGHTH, 1, 2], 0.5)).toBe(1);
    expect(tierToShow([EIGHTH, 0.25], 1)).toBe(0.25);
  });

  it("takes one tier at a time, most urgent first, and puts back what it could not paint", () => {
    const queue = new PaintQueue();
    queue.add("a", EIGHTH, BACKGROUND, 0);
    queue.add("b", 1, VIEW, 0);
    queue.add("c", 1, VIEW, 0);
    queue.add("a", EIGHTH, URGENT, 1);
    const first = queue.take(10, () => true);
    expect(first.map((r) => r.id)).toEqual(["a"]);
    const second = queue.take(1, () => true);
    expect(second.map((r) => r.id)).toEqual(["b"]);
    queue.restore(second);
    expect(queue.take(10, () => true).map((r) => r.id)).toEqual(["b", "c"]);
    expect(queue.size).toBe(0);
  });

  it("paints a change on its own, not with a sheet of others", () => {
    const queue = new PaintQueue();
    queue.add("b", 1, VIEW, 0);
    queue.add("c", 1, VIEW, 0);
    queue.add("a", 1, URGENT, 1);
    expect(queue.hasUrgent()).toBe(true);
    expect(queue.take(10, () => true).map((r) => r.id)).toEqual(["a"]);
    expect(queue.hasUrgent()).toBe(false);
    expect(queue.take(10, () => true).map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("packs a sheet in rows and leaves out what does not fit", () => {
    const placed = packSheet([{ key: 1, w: 60, h: 50 }, { key: 2, w: 60, h: 50 }, { key: 3, w: 60, h: 50 }], 130, 60, 4);
    expect(placed.get(1)).toEqual({ x: 0, y: 0 });
    expect(placed.get(2)).toEqual({ x: 64, y: 0 });
    expect(placed.has(3)).toBe(false);
  });

  it("starts every box on a whole texel at 1/8", () => {
    const placed = packSheet([{ key: 1, w: 61.5, h: 50.25 }, { key: 2, w: 60, h: 50 }, { key: 3, w: 60, h: 50 }], 140, 200, 4);
    expect(placed.get(2)).toEqual({ x: 72, y: 0 });
    expect(placed.get(3)).toEqual({ x: 0, y: 56 });
  });
});
