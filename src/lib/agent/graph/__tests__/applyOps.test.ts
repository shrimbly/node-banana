import { describe, expect, it } from "vitest";
import { createDefaultNodeData, defaultNodeDimensions, migrateNodeGeometry } from "@/store/utils/nodeDefaults";
import type { AgentGraphOp } from "../../types";
import { applyGraphOps } from "../applyOps";
import { createAgentToolRuntime } from "../../tools/runtime";
import { applyResult, call, sequentialIds, snapshotOf, storeEdge, storeNode, type StoreState } from "../../tools/__tests__/testUtils";

const deps = (start = 5000) => {
  let clock = start;
  return { createDefaultNodeData, defaultNodeDimensions, now: () => clock++ };
};

describe("applyGraphOps", () => {
  const state = (): StoreState => ({
    nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "hi" }), storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 })],
    edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
  });

  it("adds nodes over the store defaults with width-only geometry, as addNode does", () => {
    const ops: AgentGraphOp[] = [
      { op: "addNode", id: "output-ag1", nodeType: "output", position: { x: 800, y: 0 }, data: { outputFilename: "hero" } },
      { op: "addEdge", id: "edge-nanoBanana-2-output-ag1-image-image", source: "nanoBanana-2", sourceHandle: "image", target: "output-ag1", targetHandle: "image" },
    ];
    const result = applyGraphOps(state(), ops, deps());
    expect(result.applied).toBe(2);
    expect(result.skipped).toEqual([]);
    const added = result.nodes.find((n) => n.id === "output-ag1")!;
    expect(added).toEqual({
      id: "output-ag1",
      type: "output",
      position: { x: 800, y: 0 },
      data: { image: null, outputFilename: "hero" },
      width: 320,
      style: { width: 320 },
    });
    // Nothing a render would have to correct: the same shape migrateNodeGeometry leaves.
    expect(migrateNodeGeometry(added)).toEqual(added);
    expect(result.edges[1]).toEqual({
      id: "edge-nanoBanana-2-output-ag1-image-image",
      source: "nanoBanana-2",
      sourceHandle: "image",
      target: "output-ag1",
      targetHandle: "image",
      data: { createdAt: 5000 },
    });
  });

  it("merges updates shallowly, moves, and removes nodes with their edges", () => {
    const result = applyGraphOps(
      state(),
      [
        { op: "updateNode", id: "nanoBanana-2", data: { aspectRatio: "16:9" } },
        { op: "moveNode", id: "prompt-1", position: { x: -50, y: 20 } },
        { op: "removeNode", id: "prompt-1" },
      ],
      deps(),
    );
    expect(result.nodes.map((n) => n.id)).toEqual(["nanoBanana-2"]);
    expect(result.nodes[0].data).toMatchObject({ aspectRatio: "16:9", model: "nano-banana-pro", status: "idle" });
    expect(result.edges).toEqual([]);
    expect(result.applied).toBe(3);
  });

  it("skips ops that no longer apply and reports why", () => {
    const result = applyGraphOps(
      state(),
      [
        { op: "updateNode", id: "gone-1", data: { prompt: "x" } },
        { op: "moveNode", id: "gone-1", position: { x: 0, y: 0 } },
        { op: "addEdge", id: "e1", source: "gone-1", sourceHandle: "text", target: "nanoBanana-2", targetHandle: "text" },
        { op: "addNode", id: "prompt-1", nodeType: "prompt", position: { x: 0, y: 0 }, data: {} },
        { op: "removeNode", id: "gone-2" },
        { op: "removeEdge", id: "gone-edge" },
      ],
      deps(),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([
      "updateNode gone-1: the node is no longer on the canvas",
      "moveNode gone-1: the node is no longer on the canvas",
      "addEdge gone-1 → nanoBanana-2: gone-1 is no longer on the canvas",
      "addNode prompt-1: a node with this id already exists",
    ]);
  });

  it("dedups edges by id and clears the canvas", () => {
    const duplicate = applyGraphOps(
      state(),
      [{ op: "addEdge", id: "edge-prompt-1-nanoBanana-2-text-text", source: "prompt-1", sourceHandle: "text", target: "nanoBanana-2", targetHandle: "text" }],
      deps(),
    );
    expect(duplicate.edges).toHaveLength(1);
    expect(duplicate.skipped).toEqual([]);

    const cleared = applyGraphOps(state(), [{ op: "clearCanvas" }, { op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: {} }], deps());
    expect(cleared.clearedCanvas).toBe(true);
    expect(cleared.nodes.map((n) => n.id)).toEqual(["prompt-ag1"]);
    expect(cleared.edges).toEqual([]);
  });

  it("sets and clears group membership carried on node ops", () => {
    const grouped = state();
    grouped.nodes[0] = { ...grouped.nodes[0], groupId: "group-1" } as typeof grouped.nodes[0];
    const ops: AgentGraphOp[] = [
      { op: "moveNode", id: "prompt-1", position: { x: 900, y: 900 }, groupId: null },
      { op: "moveNode", id: "nanoBanana-2", position: { x: 10, y: 10 }, groupId: "group-2" },
      { op: "addNode", id: "output-ag1", nodeType: "output", position: { x: 20, y: 20 }, data: {}, groupId: "group-2" },
    ];
    const result = applyGraphOps(grouped, ops, deps());
    expect(result.nodes.map((n) => [n.id, n.groupId])).toEqual([
      ["prompt-1", undefined],
      ["nanoBanana-2", "group-2"],
      ["output-ag1", "group-2"],
    ]);
    expect("groupId" in result.nodes[0]).toBe(false);
  });

  it("removes only the listed nodes, so nodes added meanwhile keep their edges (review C39)", () => {
    const live = state();
    live.nodes.push(storeNode("imageInput-9", "imageInput", { x: 0, y: 900 }));
    live.edges.push(storeEdge("imageInput-9", "image", "nanoBanana-2", "image"));
    const result = applyGraphOps(live, [{ op: "removeNode", id: "prompt-1" }], deps());
    expect(result.nodes.map((n) => n.id)).toEqual(["nanoBanana-2", "imageInput-9"]);
    expect(result.edges.map((e) => e.id)).toEqual(["edge-imageInput-9-nanoBanana-2-image-image"]);
    expect(result.clearedCanvas).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = state();
    const before = JSON.stringify(input);
    applyGraphOps(input, [{ op: "updateNode", id: "prompt-1", data: { prompt: "changed" } }, { op: "removeEdge", id: input.edges[0].id }], deps());
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("draft ↔ browser consistency", () => {
  it("replaying the ops on store nodes reproduces exactly what the tools saw", async () => {
    let store: StoreState = {
      nodes: [
        storeNode("imageInput-1", "imageInput", { x: 0, y: 0 }),
        storeNode("generateVideo-2", "generateVideo", { x: 400, y: 0 }),
        storeNode("prompt-3", "prompt", { x: 0, y: 400 }, { prompt: "sunset * sunrise" }),
      ],
      edges: [storeEdge("imageInput-1", "image", "generateVideo-2", "image")],
    };
    const runtime = createAgentToolRuntime(snapshotOf(store), { randomId: sequentialIds() });
    const calls: Array<[string, unknown]> = [
      ["update_node", { node: "generateVideo-2", title: "Clip", settings: { model: "veo-3.1/image-to-video", durationSeconds: "4" } }],
      [
        "create_workflow",
        {
          nodes: [
            { ref: "arr", type: "array" },
            { ref: "g1", type: "nanoBanana", settings: { model: "nano-banana-2", aspectRatio: "1:4" } },
            { ref: "g2", type: "nanoBanana" },
            { ref: "sw", type: "switch", settings: { switches: [{ name: "Keep" }, { name: "Drop", enabled: false }] } },
            { ref: "cs", type: "conditionalSwitch", settings: { rules: [{ label: "Sun", value: "sun" }] } },
            { ref: "gal", type: "outputGallery" },
          ],
          connections: [
            { from: "prompt-3", to: "arr" },
            { from: "arr", to: "g1" },
            { from: "arr", to: "g2" },
            { from: "g1", to: "sw" },
            { from: "sw", fromHandle: "Keep", to: "gal" },
            { from: "g2", to: "gal" },
            { from: "prompt-3", to: "cs" },
          ],
        },
      ],
      ["edit_workflow", { operations: [{ op: "add_node", ref: "neg", type: "prompt", settings: { prompt: "blur" } }, { op: "connect", from: "neg", to: "generateVideo-2", toHandle: "negative_prompt" }, { op: "connect", from: "g1", to: "generateVideo-2", toHandle: "image" }] }],
      ["arrange_workflow", {}],
    ];
    for (const [name, args] of calls) {
      const result = await call(runtime, name, args);
      expect(result.ok, `${name}: ${result.text}`).toBe(true);
      const applied = applyResult(store, result);
      expect(applied.skipped, name).toEqual([]);
      store = applied;
    }

    const toolView = await call(runtime, "get_workflow", { detail: "full" });
    const browserView = await call(createAgentToolRuntime(snapshotOf(store)), "get_workflow", { detail: "full" });
    expect(browserView.text).toBe(toolView.text);
    // The replaced image edge moved to the Veo image slot and the stale one is gone.
    expect(store.edges.filter((e) => e.target === "generateVideo-2").map((e) => `${e.source}.${e.sourceHandle}->${e.targetHandle}`).sort()).toEqual([
      "nanoBanana-ag2.image->image-0",
      "prompt-ag7.text->text-1",
    ]);
  });
});
