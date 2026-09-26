import { describe, expect, it } from "vitest";
import type { NodeGroup } from "@/types/workflow";
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

  describe("groups", () => {
    const box = { position: { x: -30, y: -30 }, size: { width: 780, height: 520 } };
    const existing: NodeGroup = { id: "group-1", name: "Group 1", color: "blue", ...box, locked: true };
    const grouped = () => {
      const s = state();
      s.nodes[0] = { ...s.nodes[0], groupId: "group-1" } as typeof s.nodes[0];
      return { ...s, groups: { "group-1": existing } };
    };

    it("adds a group with its box and members, after nodes added in the same batch", () => {
      const ops: AgentGraphOp[] = [
        { op: "addNode", id: "output-ag1", nodeType: "output", position: { x: 800, y: 0 }, data: {} },
        { op: "addGroup", id: "group-ag1", name: "Hero film", color: "purple", ...box, nodeIds: ["nanoBanana-2", "output-ag1"] },
      ];
      const result = applyGraphOps(state(), ops, deps());
      expect(result.skipped).toEqual([]);
      expect(result.applied).toBe(2);
      expect(result.groups).toEqual({ "group-ag1": { id: "group-ag1", name: "Hero film", color: "purple", ...box } });
      expect(result.nodes.map((n) => [n.id, n.groupId])).toEqual([
        ["prompt-1", undefined],
        ["nanoBanana-2", "group-ag1"],
        ["output-ag1", "group-ag1"],
      ]);
    });

    it("renames, recolours and refits a group, and leaves the rest of it alone", () => {
      const result = applyGraphOps(
        grouped(),
        [
          { op: "updateGroup", id: "group-1", name: "Scene set", color: "orange" },
          { op: "updateGroup", id: "group-1", position: { x: 0, y: 10 }, size: { width: 500, height: 300 } },
        ],
        deps(),
      );
      expect(result.groups["group-1"]).toEqual({ id: "group-1", name: "Scene set", color: "orange", position: { x: 0, y: 10 }, size: { width: 500, height: 300 }, locked: true });
      expect(result.applied).toBe(2);
    });

    it("removes a group and ungroups its nodes; sets and clears one node's group", () => {
      const removed = applyGraphOps(grouped(), [{ op: "removeGroup", id: "group-1" }], deps());
      expect(removed.groups).toEqual({});
      expect(removed.nodes.every((n) => !("groupId" in n))).toBe(true);

      const moved = applyGraphOps(
        grouped(),
        [
          { op: "setNodeGroup", id: "nanoBanana-2", groupId: "group-1" },
          { op: "setNodeGroup", id: "prompt-1", groupId: null },
        ],
        deps(),
      );
      expect(moved.nodes.map((n) => [n.id, n.groupId])).toEqual([
        ["prompt-1", undefined],
        ["nanoBanana-2", "group-1"],
      ]);
      expect("groupId" in moved.nodes[0]).toBe(false);
      expect(moved.groups).toEqual({ "group-1": existing });
    });

    it("skips group ops the live canvas no longer fits, and reports why", () => {
      const result = applyGraphOps(
        state(),
        [
          { op: "updateGroup", id: "group-gone", name: "x" },
          { op: "setNodeGroup", id: "prompt-1", groupId: "group-gone" },
          { op: "setNodeGroup", id: "gone-1", groupId: null },
          { op: "addGroup", id: "group-ag1", name: "Lost", color: "red", ...box, nodeIds: ["gone-1", "gone-2"] },
          { op: "addGroup", id: "group-ag2", name: "Half", color: "red", ...box, nodeIds: ["prompt-1", "gone-1"] },
          { op: "addGroup", id: "group-ag2", name: "Twice", color: "red", ...box, nodeIds: ["prompt-1"] },
          { op: "removeGroup", id: "group-gone" },
        ],
        deps(),
      );
      expect(result.skipped).toEqual([
        "updateGroup group-gone: the group is no longer on the canvas",
        "setNodeGroup prompt-1: group group-gone is no longer on the canvas",
        "setNodeGroup gone-1: the node is no longer on the canvas",
        "addGroup group-ag1: none of its nodes are on the canvas any more",
        "addGroup group-ag2: gone-1 is no longer on the canvas (grouped the rest)",
        "addGroup group-ag2: a group with this id already exists",
      ]);
      expect(result.applied).toBe(1);
      expect(Object.keys(result.groups)).toEqual(["group-ag2"]);
      expect(result.nodes.find((n) => n.id === "prompt-1")!.groupId).toBe("group-ag2");
    });

    it("drops every group on clearCanvas, keeps groups the batch adds after it, and never mutates its input", () => {
      const input = grouped();
      const before = JSON.stringify(input);
      const result = applyGraphOps(
        input,
        [
          { op: "clearCanvas" },
          { op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: {} },
          { op: "addGroup", id: "group-ag1", name: "New", color: "green", ...box, nodeIds: ["prompt-ag1"] },
        ],
        deps(),
      );
      expect(result.clearedCanvas).toBe(true);
      expect(Object.keys(result.groups)).toEqual(["group-ag1"]);
      expect(JSON.stringify(input)).toBe(before);
      // No group op: the same groups object back.
      const untouched = grouped();
      expect(applyGraphOps(untouched, [{ op: "moveNode", id: "prompt-1", position: { x: 1, y: 1 } }], deps()).groups).toBe(untouched.groups);
    });
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
    expect(store.groups).toEqual({});
    // The replaced image edge moved to the Veo image slot and the stale one is gone.
    expect(store.edges.filter((e) => e.target === "generateVideo-2").map((e) => `${e.source}.${e.sourceHandle}->${e.targetHandle}`).sort()).toEqual([
      "nanoBanana-ag2.image->image-0",
      "prompt-ag7.text->text-1",
    ]);
  });
});

describe("draft ↔ browser consistency with groups", () => {
  it("replaying grouped edits on store nodes and groups reproduces exactly what the tools saw", async () => {
    let store: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a lighthouse" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }, {}, { groupId: "group-1" }),
        storeNode("output-3", "output", { x: 1400, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
      groups: { "group-1": { id: "group-1", name: "Group 1", color: "neutral", position: { x: -20, y: -20 }, size: { width: 760, height: 500 } } },
    };
    const runtime = createAgentToolRuntime(snapshotOf(store, { viewport: { x: 0, y: 0, width: 1600, height: 900, zoom: 1 } }), { randomId: sequentialIds() });
    const calls: Array<[string, unknown]> = [
      [
        "create_workflow",
        {
          nodes: [
            { ref: "sp", type: "prompt", settings: { prompt: "a misty harbour" } },
            { ref: "sg", type: "nanoBanana" },
            { ref: "fp", type: "prompt", settings: { prompt: "slow push in" } },
            { ref: "fv", type: "generateVideo", settings: { model: "veo-3.1/image-to-video" } },
            { ref: "fo", type: "output" },
          ],
          connections: [
            { from: "sp", to: "sg" },
            { from: "sg", to: "fv", toHandle: "image" },
            { from: "fp", to: "fv" },
            { from: "fv", to: "fo" },
          ],
          groups: [
            { name: "Scene set", color: "blue", nodes: ["sp", "sg"] },
            { name: "Hero film", color: "purple", nodes: ["fp", "fv", "fo"] },
          ],
        },
      ],
      [
        "edit_workflow",
        {
          operations: [
            { op: "update_group", group: "group-1", name: "Key art", color: "green" },
            { op: "add_to_group", nodes: ["output-3"], group: "Key art" },
            { op: "add_node", ref: "extra", type: "output" },
            { op: "connect", from: "sg", to: "extra" },
            { op: "add_to_group", nodes: ["extra"], group: "Scene set" },
          ],
        },
      ],
      ["edit_workflow", { operations: [{ op: "remove_from_group", nodes: ["prompt-ag3"] }, { op: "move_node", node: "output-ag5", position: { x: 5000, y: 5000 } }] }],
      ["edit_workflow", { operations: [{ op: "group", nodes: ["prompt-ag3", "output-ag5"], name: "Loose ends", color: "red" }] }],
      ["edit_workflow", { operations: [{ op: "remove_node", node: "prompt-1" }, { op: "remove_node", node: "nanoBanana-2" }, { op: "remove_node", node: "output-3" }] }],
      ["arrange_workflow", {}],
      ["edit_workflow", { operations: [{ op: "ungroup", group: "Loose ends" }] }],
    ];
    for (const [name, args] of calls) {
      const result = await call(runtime, name, args);
      expect(result.ok, `${name}: ${result.text}`).toBe(true);
      const applied = applyResult(store, result);
      expect(applied.skipped, name).toEqual([]);
      store = applied;
      const toolView = await call(runtime, "get_workflow", { detail: "full" });
      const browserView = await call(createAgentToolRuntime(snapshotOf(store)), "get_workflow", { detail: "full" });
      expect(browserView.text, `after ${name} ${JSON.stringify(args).slice(0, 60)}`).toBe(toolView.text);
    }
    // Key art lost all its nodes with the deletions; Loose ends was ungrouped.
    expect(Object.values(store.groups ?? {}).map((g) => [g.id, g.name, g.color])).toEqual([
      ["group-ag1", "Scene set", "blue"],
      ["group-ag2", "Hero film", "purple"],
    ]);
    expect(store.nodes.filter((n) => n.groupId).map((n) => [n.id, n.groupId])).toEqual([
      ["prompt-ag1", "group-ag1"],
      ["nanoBanana-ag2", "group-ag1"],
      ["generateVideo-ag4", "group-ag2"],
      ["output-ag6", "group-ag1"],
    ]);
  });
});
