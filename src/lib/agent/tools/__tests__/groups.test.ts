/**
 * Groups and the agent's tools (review C8, and group editing).
 *
 * A group is a box stored on the group plus a `groupId` on each member; the
 * canvas keeps the two in step only when the user drags, and never resizes a
 * box by itself. The agent must do it: a new group's box is fitted around its
 * nodes (laid out as their own block), boxes follow the nodes the agent adds,
 * moves or takes out, arranging moves each group as one unit, new nodes are
 * placed clear of every box and the title above it, and move_node joins or
 * leaves groups by where the node's centre lands, like a drop on the canvas.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeType, WorkflowNode } from "@/types";
import type { NodeGroup } from "@/types/workflow";

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key];
  }),
  clear: vi.fn(),
});

import { useWorkflowStore } from "@/store/workflowStore";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { getNodeSize } from "@/utils/nodeDimensions";
import type { AgentGraphOp, AgentToolResult, AgentToolRuntime } from "../../types";
import { GROUP_HEADER_ROOM } from "../../graph/layout";
import { estimatedNodeHeight } from "../../graph/sizes";
import { buildAgentSnapshot } from "../../graph/snapshot";
import { createAgentToolRuntime } from "../runtime";
import { applyResult, call, runtimeFor, sequentialIds, storeEdge, storeNode, type StoreState } from "./testUtils";

type Box = { x: number; y: number; width: number; height: number };

function group(id: string, box: Box, locked = false): NodeGroup {
  return { id, name: `Group ${id}`, color: "blue", position: { x: box.x, y: box.y }, size: { width: box.width, height: box.height }, ...(locked ? { locked } : {}) };
}

function runtimeWith(state: StoreState, groups: Record<string, NodeGroup> = state.groups ?? {}): AgentToolRuntime {
  return createAgentToolRuntime(buildAgentSnapshot({ nodes: state.nodes, edges: state.edges, groups }), { randomId: sequentialIds() });
}

function boxOf(node: WorkflowNode): Box {
  const { width, height } = getNodeSize(node);
  return { x: node.position.x, y: node.position.y, width, height };
}

/** The space a node takes once rendered: its measured height, or the layout's estimate for an unmeasured one. */
function renderedBox(node: WorkflowNode): Box {
  const box = boxOf(node);
  return node.measured?.height ? box : { ...box, height: estimatedNodeHeight(node.type as NodeType) };
}

function boxOfGroup(g: NodeGroup): Box {
  return { x: g.position.x, y: g.position.y, width: g.size.width, height: g.size.height };
}

/** The box plus the band above it where the canvas draws the group's title. */
function footprint(g: NodeGroup): Box {
  return { x: g.position.x, y: g.position.y - GROUP_HEADER_ROOM, width: g.size.width, height: g.size.height + GROUP_HEADER_ROOM };
}

function centreInside(node: WorkflowNode, g: NodeGroup): boolean {
  const b = boxOf(node);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx >= g.position.x && cx <= g.position.x + g.size.width && cy >= g.position.y && cy <= g.position.y + g.size.height;
}

function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function overlaps(a: Box, g: NodeGroup): boolean {
  return boxesOverlap(a, boxOfGroup(g));
}

function moveOps(ops: AgentGraphOp[]) {
  return ops.filter((op): op is Extract<AgentGraphOp, { op: "moveNode" }> => op.op === "moveNode");
}

function groupOps(ops: AgentGraphOp[]) {
  return ops.filter((op) => op.op === "addGroup" || op.op === "updateGroup" || op.op === "removeGroup" || op.op === "setNodeGroup");
}

/**
 * The canvas reads right: each member sits wholly inside its group's box,
 * which matches its membership (the drop rule), no other node overlaps a box
 * or the title above it, and no two groups (titles included) overlap.
 */
function expectTidyGroups(store: { nodes: WorkflowNode[]; groups: Record<string, NodeGroup> }) {
  const groups = Object.values(store.groups);
  for (const node of store.nodes) {
    const own = node.groupId ? store.groups[node.groupId] : undefined;
    if (own) expect(contains(boxOfGroup(own), renderedBox(node)), `${node.id} inside ${own.id}`).toBe(true);
    for (const g of groups) {
      expect(centreInside(node, g), `${node.id} centre in ${g.id}`).toBe(node.groupId === g.id);
      if (g !== own) expect(boxesOverlap(renderedBox(node), footprint(g)), `${node.id} × ${g.id}`).toBe(false);
    }
  }
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      expect(boxesOverlap(footprint(groups[i]), footprint(groups[j])), `${groups[i].id} × ${groups[j].id}`).toBe(false);
    }
  }
}

function membersOf(store: { nodes: WorkflowNode[] }, groupId: string): string[] {
  return store.nodes.filter((n) => n.groupId === groupId).map((n) => n.id);
}

describe("groups in the agent's tools", () => {
  // Two members of a locked group far from a messy unrelated chain.
  const g1 = group("group-1", { x: 2980, y: 2980, width: 800, height: 300 }, true);
  const grouped = (): StoreState => ({
    nodes: [
      storeNode("prompt-1", "prompt", { x: 3000, y: 3000 }, { prompt: "a" }, { groupId: "group-1" }),
      storeNode("nanoBanana-2", "nanoBanana", { x: 3400, y: 3000 }, {}, { groupId: "group-1" }),
      storeNode("prompt-3", "prompt", { x: 900, y: 0 }, { prompt: "b" }),
      storeNode("nanoBanana-4", "nanoBanana", { x: 0, y: 700 }),
      storeNode("output-5", "output", { x: 400, y: 1400 }),
    ],
    edges: [
      storeEdge("prompt-1", "text", "nanoBanana-2", "text"),
      storeEdge("prompt-3", "text", "nanoBanana-4", "text"),
      storeEdge("nanoBanana-4", "image", "output-5", "image"),
    ],
    groups: { "group-1": g1 },
  });

  it("arrange_workflow moves a group as one unit, its nodes tidied inside a refit box, and keeps everything else out of it", async () => {
    const state = grouped();
    const result = await call(runtimeWith(state), "arrange_workflow", {});
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain('Tidied group "Group group-1" [group-1] as a unit');
    // The box follows its nodes: one updateGroup with both position and size.
    const update = result.ops.find((op) => op.op === "updateGroup") as Extract<AgentGraphOp, { op: "updateGroup" }>;
    expect(update).toMatchObject({ id: "group-1", position: expect.any(Object), size: expect.any(Object) });
    const store = applyResult(state, result);
    expect(store.skipped).toEqual([]);
    expect(membersOf(store, "group-1")).toEqual(["prompt-1", "nanoBanana-2"]);
    expect(store.groups["group-1"].locked).toBe(true);
    expectTidyGroups(store);
    // Tidied inside: the prompt left of the generator it feeds.
    const at = (id: string) => store.nodes.find((n) => n.id === id)!.position;
    expect(at("prompt-1").x).toBeLessThan(at("nanoBanana-2").x);

    // Naming one node of a group arranges the whole group.
    const one = await call(runtimeWith(state), "arrange_workflow", { nodeIds: ["prompt-1"] });
    expect(one.ok, one.text).toBe(true);
    expect(one.text).toContain("nanoBanana-2 moved with their group");
    expect(moveOps(one.ops).map((op) => op.id).sort()).toEqual(["nanoBanana-2", "prompt-1"]);
    expectTidyGroups(applyResult(state, one));
  });

  it("move_node takes a member out of its group when it lands outside the box", async () => {
    const state = grouped();
    const result = await call(runtimeWith(state), "edit_workflow", {
      operations: [{ op: "move_node", node: "prompt-1", position: { x: 5000, y: 5000 } }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(moveOps(result.ops)).toEqual([{ op: "moveNode", id: "prompt-1", position: { x: 5000, y: 5000 }, groupId: null }]);
    expect(result.text).toContain('prompt-1 left group "Group group-1" (a locked group, so it runs again)');
    // Like a drag out on the canvas: the group keeps its box.
    expect(groupOps(result.ops)).toEqual([]);
    const store = applyResult(state, result);
    expect(store.nodes.find((n) => n.id === "prompt-1")!.groupId).toBeUndefined();
    expect(store.nodes.find((n) => n.id === "nanoBanana-2")!.groupId).toBe("group-1");
  });

  it("move_node puts a node dropped inside a locked group's box into that group, says it will not run, and refits the box", async () => {
    const state = grouped();
    const result = await call(runtimeWith(state), "edit_workflow", {
      operations: [{ op: "move_node", node: "prompt-3", position: { x: 3000, y: 3020 } }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(moveOps(result.ops)[0]).toMatchObject({ id: "prompt-3", groupId: "group-1" });
    expect(result.text).toContain('prompt-3 is now in locked group "Group group-1": it will not run until the user unlocks the group');
    const store = applyResult(state, result);
    expect(store.nodes.find((n) => n.id === "prompt-3")!.groupId).toBe("group-1");
    // The box grew around the node that joined it.
    for (const id of ["prompt-1", "nanoBanana-2", "prompt-3"]) {
      expect(contains(boxOfGroup(store.groups["group-1"]), renderedBox(store.nodes.find((n) => n.id === id)!)), id).toBe(true);
    }

    // Moving within the box changes nothing about membership.
    const within = await call(runtimeWith(state), "edit_workflow", {
      operations: [{ op: "move_node", node: "prompt-1", position: { x: 3010, y: 3010 } }],
    });
    expect(moveOps(within.ops)[0]).not.toHaveProperty("groupId");
  });

  it("places new nodes clear of a group's empty area and of the title above it", async () => {
    const wide = group("group-1", { x: -20, y: -20, width: 2000, height: 600 }, true);
    const state: StoreState = {
      nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" })],
      edges: [],
      groups: { "group-1": wide },
    };
    const result = await call(runtimeWith(state), "edit_workflow", {
      operations: [
        { op: "add_node", ref: "g", type: "nanoBanana" },
        { op: "connect", from: "prompt-1", to: "g" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const store = applyResult(state, result);
    const added = store.nodes.find((n) => n.type === "nanoBanana")!;
    expect(overlaps(renderedBox(added), wide)).toBe(false);
    expect(boxesOverlap(renderedBox(added), footprint(wide))).toBe(false);
    expect(added.groupId).toBeUndefined();
  });

  it("shows each group's colour, box, lock and nodes in get_workflow", async () => {
    const result = await call(runtimeWith(grouped()), "get_workflow", {});
    expect(result.text).toContain("- Group group-1 [group-1] blue locked box (2980, 2980) 800×300: prompt-1, nanoBanana-2");
  });
});

describe("the agent's own groups", () => {
  const VIEWPORT = { x: 0, y: 0, width: 1600, height: 900, zoom: 1 };
  const EMPTY: StoreState = { nodes: [], edges: [] };

  /** Scene set feeds Hero film: two stages. */
  const twoStages = {
    nodes: [
      { ref: "sp", type: "prompt", settings: { prompt: "a misty harbour at dawn, wide shot" } },
      { ref: "sg", type: "nanoBanana" },
      { ref: "fp", type: "prompt", settings: { prompt: "slow push in on the harbour" } },
      { ref: "fv", type: "generateVideo" },
      { ref: "fo", type: "output" },
    ],
    connections: [
      { from: "sp", to: "sg" },
      { from: "sg", to: "fv" },
      { from: "fp", to: "fv" },
      { from: "fv", to: "fo" },
    ],
    groups: [
      { name: "Scene set", color: "blue", nodes: ["sp", "sg"] },
      { name: "Hero film", color: "purple", nodes: ["fp", "fv", "fo"] },
    ],
  };

  it("create_workflow lays each group out as its own block inside a fitted box, with no two boxes overlapping", async () => {
    const runtime = runtimeFor(EMPTY, { viewport: VIEWPORT });
    const result = await call(runtime, "create_workflow", twoStages);
    expect(result.ok, result.text).toBe(true);

    const adds = result.ops.filter((op): op is Extract<AgentGraphOp, { op: "addGroup" }> => op.op === "addGroup");
    expect(adds.map(({ id, name, color, nodeIds }) => ({ id, name, color, nodeIds }))).toEqual([
      { id: "group-ag1", name: "Scene set", color: "blue", nodeIds: ["prompt-ag1", "nanoBanana-ag2"] },
      { id: "group-ag2", name: "Hero film", color: "purple", nodeIds: ["prompt-ag3", "generateVideo-ag4", "output-ag5"] },
    ]);
    // Groups come after the nodes they hold, so the browser can apply the batch in order.
    const lastAddNode = result.ops.map((op) => op.op).lastIndexOf("addNode");
    expect(result.ops.findIndex((op) => op.op === "addGroup")).toBeGreaterThan(lastAddNode);
    expect(result.text).toContain('Created group "Scene set" [group-ag1] (blue');
    expect(result.text).toContain('Created group "Hero film" [group-ag2] (purple');
    expect(result.text).toContain("): prompt-ag3, generateVideo-ag4, output-ag5.");
    expect(result.summary).toContain("2 groups");

    const store = applyResult(EMPTY, result);
    expect(store.skipped).toEqual([]);
    expect(Object.keys(store.groups)).toEqual(["group-ag1", "group-ag2"]);
    expect(membersOf(store, "group-ag1")).toEqual(["prompt-ag1", "nanoBanana-ag2"]);
    expect(membersOf(store, "group-ag2")).toEqual(["prompt-ag3", "generateVideo-ag4", "output-ag5"]);
    expectTidyGroups(store);
    // Stages read left to right: the group that feeds the other comes first.
    const [scene, film] = [store.groups["group-ag1"], store.groups["group-ag2"]];
    expect(scene.position.x + scene.size.width).toBeLessThan(film.position.x);
    // The whole thing lands in the visible area.
    expect(scene.position.y - GROUP_HEADER_ROOM).toBeGreaterThanOrEqual(VIEWPORT.y);
  });

  it("stacks groups that do not feed each other top to bottom, clear of each other's title", async () => {
    const runtime = runtimeFor(EMPTY, { viewport: VIEWPORT });
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a red fox in snow" } },
        { ref: "d", type: "nanoBanana" },
        { ref: "do", type: "output" },
        { ref: "n", type: "nanoBanana" },
        { ref: "no", type: "output" },
      ],
      connections: [
        { from: "p", to: "d" },
        { from: "d", to: "do" },
        { from: "p", to: "n" },
        { from: "n", to: "no" },
      ],
      groups: [
        { name: "Day", nodes: ["d", "do"] },
        { name: "Night", nodes: ["n", "no"] },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const store = applyResult(EMPTY, result);
    expectTidyGroups(store);
    const [day, night] = [store.groups["group-ag1"], store.groups["group-ag2"]];
    expect(day.position.x).toBe(night.position.x);
    expect(night.position.y).toBeGreaterThanOrEqual(day.position.y + day.size.height + GROUP_HEADER_ROOM);
    // Without a colour each group takes the next one no group uses, in the canvas's order.
    expect([day.color, night.color]).toEqual(["neutral", "blue"]);
    // The shared prompt is in no group, left of both.
    const prompt = store.nodes.find((n) => n.id === "prompt-ag1")!;
    expect(prompt.groupId).toBeUndefined();
    expect(prompt.position.x + 320).toBeLessThan(day.position.x);
  });

  it("places a new grouped workflow clear of existing nodes and groups", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }, {}, { groupId: "group-1" }),
        storeNode("output-3", "output", { x: 1500, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
      groups: { "group-1": group("group-1", { x: -30, y: -30, width: 780, height: 520 }) },
    };
    const runtime = runtimeWith(state);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "v", type: "generateVideo" },
        { ref: "vp", type: "prompt", settings: { prompt: "the camera drifts" } },
        { ref: "o", type: "output" },
      ],
      connections: [
        { from: "nanoBanana-2", to: "v" },
        { from: "vp", to: "v" },
        { from: "v", to: "o" },
      ],
      groups: [{ name: "Motion", nodes: ["v", "vp", "o"] }],
    });
    expect(result.ok, result.text).toBe(true);
    const store = applyResult(state, result);
    expect(store.skipped).toEqual([]);
    expect(Object.keys(store.groups)).toEqual(["group-1", "group-ag1"]);
    // The canvas has a blue group, so the new one takes the first unused colour.
    expect(store.groups["group-ag1"].color).toBe("neutral");
    expectTidyGroups(store);
  });

  it("groups existing nodes where they are when the fitted box covers nothing else", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }),
        storeNode("output-3", "output", { x: 1500, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
    };
    const result = await call(runtimeFor(state), "edit_workflow", {
      operations: [{ op: "group", nodes: ["prompt-1", "nanoBanana-2"], name: "Stills", color: "Green" }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(moveOps(result.ops)).toEqual([]);
    const add = result.ops.find((op) => op.op === "addGroup") as Extract<AgentGraphOp, { op: "addGroup" }>;
    // The canvas's fit: the nodes' bounding box (the generator rendered ~460 tall) plus padding.
    expect(add).toEqual({
      op: "addGroup",
      id: "group-ag1",
      name: "Stills",
      color: "green",
      position: { x: -30, y: -30 },
      size: { width: 720 + 60, height: estimatedNodeHeight("nanoBanana") + 60 },
      nodeIds: ["prompt-1", "nanoBanana-2"],
    });
    expect(result.text).toContain('Created group "Stills" [group-ag1] (green');
    expect(result.focusNodeIds).toEqual(expect.arrayContaining(["prompt-1", "nanoBanana-2"]));
    expectTidyGroups(applyResult(state, result));
  });

  it("moves the nodes together when the fitted box would cover a node outside the group", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }),
        storeNode("prompt-2", "prompt", { x: 0, y: 300 }, { prompt: "b" }),
        storeNode("nanoBanana-3", "nanoBanana", { x: 0, y: 600 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-3", "text")],
    };
    const result = await call(runtimeFor(state), "edit_workflow", {
      operations: [{ op: "group", nodes: ["prompt-1", "nanoBanana-3"], name: "Stills" }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain('Moved prompt-1, nanoBanana-3 so group "Stills" [group-ag1]\'s box holds its nodes and nothing else.');
    const store = applyResult(state, result);
    expectTidyGroups(store);
    // The node in the middle stayed put, outside the group.
    expect(store.nodes.find((n) => n.id === "prompt-2")!.position).toEqual({ x: 0, y: 300 });
  });

  it("gathers nodes that are far apart instead of drawing a mostly empty box", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 2500, y: 1800 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
    };
    const result = await call(runtimeFor(state), "edit_workflow", { operations: [{ op: "group", nodes: ["prompt-1", "nanoBanana-2"], name: "Stills" }] });
    expect(result.ok, result.text).toBe(true);
    const store = applyResult(state, result);
    expectTidyGroups(store);
    const box = store.groups["group-ag1"];
    expect(box.size.width).toBe(320 + 100 + 300 + 60);
    // The block starts where the box would have: at the first node.
    expect(store.nodes.find((n) => n.id === "prompt-1")!.position.x).toBe(0);
  });

  it("renames and recolours a group by id or name", async () => {
    const state: StoreState = {
      nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" })],
      edges: [],
      groups: { "group-1": group("group-1", { x: -30, y: -30, width: 380, height: 280 }) },
    };
    const runtime = runtimeWith(state);
    const renamed = await call(runtime, "edit_workflow", { operations: [{ op: "update_group", group: "group group-1", name: "Scene set", color: "orange" }] });
    expect(renamed.ok, renamed.text).toBe(true);
    expect(renamed.ops).toEqual([{ op: "updateGroup", id: "group-1", name: "Scene set", color: "orange" }]);
    expect(renamed.text).toContain('Group [group-1]: renamed "Group group-1" → "Scene set", colour blue → orange.');
    let store = applyResult(state, renamed);
    expect(store.groups["group-1"]).toMatchObject({ name: "Scene set", color: "orange", position: { x: -30, y: -30 } });

    const again = await call(runtime, "edit_workflow", { operations: [{ op: "update_group", group: "group-1", color: "green" }] });
    expect(again.ops).toEqual([{ op: "updateGroup", id: "group-1", color: "green" }]);
    store = applyResult(store, again);
    expect(store.groups["group-1"].color).toBe("green");
    expect((await call(runtime, "get_workflow", {})).text).toContain("- Scene set [group-1] green box (-30, -30) 380×280: prompt-1");
  });

  it("ungroups: the box goes, the nodes stay where they are", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }, {}, { groupId: "group-1" }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
      groups: { "group-1": group("group-1", { x: -30, y: -30, width: 780, height: 520 }, true) },
    };
    const result = await call(runtimeWith(state), "edit_workflow", { operations: [{ op: "ungroup", group: "Group group-1" }] });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops).toEqual([{ op: "removeGroup", id: "group-1" }]);
    expect(result.text).toContain('Removed group "Group group-1" [group-1]; its nodes stay where they are, ungrouped: prompt-1, nanoBanana-2. It was locked, so they run again.');
    expect(result.summary).toMatch(/removed 1 group/i);
    const store = applyResult(state, result);
    expect(store.groups).toEqual({});
    expect(store.nodes.map((n) => [n.id, n.groupId, n.position])).toEqual([
      ["prompt-1", undefined, { x: 0, y: 0 }],
      ["nanoBanana-2", undefined, { x: 420, y: 0 }],
    ]);
  });

  it("takes a node out of a group: it moves clear of the box, which shrinks around the rest", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }, {}, { groupId: "group-1" }),
        storeNode("output-3", "output", { x: 820, y: 0 }, {}, { groupId: "group-1" }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
      groups: { "group-1": group("group-1", { x: -30, y: -30, width: 1200, height: 520 }) },
    };
    // The generator is in the middle: shrinking the box cannot leave it out.
    const result = await call(runtimeWith(state), "edit_workflow", { operations: [{ op: "remove_from_group", nodes: ["nanoBanana-2"] }] });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain('Took nanoBanana-2 out of group "Group group-1" [group-1].');
    expect(groupOps(result.ops)[0]).toEqual({ op: "setNodeGroup", id: "nanoBanana-2", groupId: null });
    const store = applyResult(state, result);
    expect(membersOf(store, "group-1")).toEqual(["prompt-1", "output-3"]);
    expectTidyGroups(store);
  });

  it("removes a group when its last node is taken out, and when its last node is deleted", async () => {
    const state = (): StoreState => ({
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
      groups: { "group-1": group("group-1", { x: -30, y: -30, width: 380, height: 280 }) },
    });

    const takeOut = runtimeWith(state());
    const out = await call(takeOut, "edit_workflow", { operations: [{ op: "remove_from_group", node: "prompt-1" }] });
    expect(out.ok, out.text).toBe(true);
    expect(groupOps(out.ops)).toEqual([
      { op: "setNodeGroup", id: "prompt-1", groupId: null },
      { op: "removeGroup", id: "group-1" },
    ]);
    expect(out.text).toContain('Group "Group group-1" [group-1] had no nodes left, so it was removed.');
    expect(applyResult(state(), out).groups).toEqual({});
    expect((await call(takeOut, "get_workflow", {})).text).not.toContain("Groups");

    // Deleting it: the browser drops the emptied group by itself; the draft agrees.
    const del = runtimeWith(state());
    const removed = await call(del, "edit_workflow", { operations: [{ op: "remove_node", node: "prompt-1" }] });
    expect(removed.ok, removed.text).toBe(true);
    expect(groupOps(removed.ops)).toEqual([]);
    expect(removed.text).toContain('Group "Group group-1" [group-1] had no nodes left, so it was removed with them.');
    const store = applyResult(state(), removed);
    expect(store.groups).toEqual({});
    expect((await call(del, "get_workflow", {})).text).not.toContain("Groups");
  });

  it("adds nodes to a group, moving one out of another group, and grows the box around them", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }, {}, { groupId: "group-1" }),
        storeNode("output-3", "output", { x: 0, y: 900 }, {}, { groupId: "group-2" }),
        storeNode("prompt-4", "prompt", { x: 400, y: 900 }, { prompt: "b" }, { groupId: "group-2" }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
      groups: {
        "group-1": group("group-1", { x: -30, y: -30, width: 780, height: 520 }),
        "group-2": { ...group("group-2", { x: -30, y: 870, width: 780, height: 280 }), name: "Spare", color: "red" },
      },
    };
    const runtime = runtimeWith(state);
    const result = await call(runtime, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "o2", type: "output" },
        { op: "connect", from: "nanoBanana-2", to: "o2" },
        { op: "add_to_group", nodes: ["o2", "output-3"], group: "group-1" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain('Added output-ag1, output-3 to group "Group group-1" [group-1] (moved output-3 from "Spare" [group-2]).');
    const store = applyResult(state, result);
    expect(store.skipped).toEqual([]);
    expect(membersOf(store, "group-1")).toEqual(["prompt-1", "nanoBanana-2", "output-3", "output-ag1"]);
    expect(membersOf(store, "group-2")).toEqual(["prompt-4"]);
    expectTidyGroups(store);
    // What the tools saw is what the browser has.
    const toolView = await call(runtime, "get_workflow", { detail: "full" });
    const browserView = await call(runtimeWith(store), "get_workflow", { detail: "full" });
    expect(browserView.text).toBe(toolView.text);
  });

  it("rejects bad group requests with the fix, and changes nothing", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }),
      ],
      edges: [],
      groups: { "group-1": { ...group("group-1", { x: -30, y: -30, width: 380, height: 280 }), name: "Scene set" } },
    };
    const runtime = runtimeWith(state);
    const expectRejected = async (operations: unknown[], ...messages: string[]) => {
      const result = await call(runtime, "edit_workflow", { operations });
      expect(result.ok).toBe(false);
      expect(result.ops).toEqual([]);
      for (const message of messages) expect(result.text).toContain(message);
      return result;
    };

    await expectRejected(
      [{ op: "group", nodes: ["prompt-1", "nanoBanana-2"], name: "Both" }],
      'prompt-1 is already in group "Scene set" [group-1], and a node belongs to one group',
      'take it out first with {op:"remove_from_group", nodes:["prompt-1"]}',
    );
    await expectRejected([{ op: "group", nodes: [], name: "Nothing" }], "a group needs at least one node");
    await expectRejected([{ op: "group", nodes: ["nanoBanana-2"] }], "a group needs a name");
    await expectRejected([{ op: "group", nodes: ["nanoBanana-2"], name: "Teal", color: "teal" }], 'color "teal" is not a group colour; use one of neutral, blue, green, purple, orange, red.');
    await expectRejected([{ op: "ungroup", group: "Hero film" }], 'group "Hero film" does not exist. Groups: "Scene set" [group-1].');
    await expectRejected([{ op: "add_to_group", nodes: ["nanoBanana-2"] }], "group is required");
    await expectRejected([{ op: "update_group", group: "group-1" }], 'nothing to change on group "Scene set" [group-1]');
    await expectRejected([{ op: "remove_from_group", nodes: ["nope-9"] }], 'node "nope-9" does not exist');

    // A group made and dropped in one call leaves nothing behind, and nothing for the browser to skip.
    const both = await call(runtime, "edit_workflow", {
      operations: [
        { op: "group", nodes: ["nanoBanana-2"], name: "Brief" },
        { op: "ungroup", group: "Brief" },
      ],
    });
    expect(both.ok, both.text).toBe(true);
    const replayed = applyResult(state, both);
    expect(replayed.skipped).toEqual([]);
    expect(Object.keys(replayed.groups)).toEqual(["group-1"]);
    expect(replayed.nodes.find((n) => n.id === "nanoBanana-2")!.groupId).toBeUndefined();

    // Taking it out first, in the same call, is the fix the error names.
    const moved = await call(runtime, "edit_workflow", {
      operations: [
        { op: "remove_from_group", nodes: ["prompt-1"] },
        { op: "group", nodes: ["prompt-1", "nanoBanana-2"], name: "Both" },
      ],
    });
    expect(moved.ok, moved.text).toBe(true);
    const store = applyResult(replayed, moved);
    expect(Object.keys(store.groups)).toEqual(["group-ag2"]);
    expect(membersOf(store, "group-ag2")).toEqual(["prompt-1", "nanoBanana-2"]);
    expectTidyGroups(store);
  });

  it("create_workflow checks group members too, and a replaced canvas drops the old groups", async () => {
    const state: StoreState = {
      nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" })],
      edges: [],
      groups: { "group-1": group("group-1", { x: -30, y: -30, width: 380, height: 280 }) },
    };
    const runtime = runtimeWith(state);
    const bad = await call(runtime, "create_workflow", {
      nodes: [{ ref: "g", type: "nanoBanana" }],
      groups: [
        { name: "One", nodes: ["g", "ghost"] },
        { name: "Two", nodes: ["g"] },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('groups[0] ("One"): node "ghost" does not exist');

    const replaced = await call(runtime, "create_workflow", {
      replaceCanvas: true,
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a lighthouse in a storm" } },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [{ from: "p", to: "g" }],
      groups: [{ name: "Stills", nodes: ["p", "g"] }],
    });
    expect(replaced.ok, replaced.text).toBe(true);
    const store = applyResult(state, replaced);
    expect(Object.keys(store.groups)).toEqual(["group-ag1"]);
    // The rejected call used no ids.
    expect(membersOf(store, "group-ag1")).toEqual(["prompt-ag1", "nanoBanana-ag2"]);
    expectTidyGroups(store);
  });
});

describe("groups through the store", () => {
  beforeEach(() => {
    useWorkflowStore.getState().clearWorkflow();
  });

  function turn(): AgentToolRuntime {
    const s = useWorkflowStore.getState();
    return createAgentToolRuntime(buildAgentSnapshot({ nodes: s.nodes, edges: s.edges, groups: s.groups, createDefaultNodeData }), { randomId: sequentialIds() });
  }

  async function run(runtime: AgentToolRuntime, name: string, args: unknown): Promise<AgentToolResult> {
    const result = await runtime.execute(name, args);
    if (result.ops.length > 0) {
      const applied = useWorkflowStore.getState().applyAgentGraphOps({ batchId: "b", toolCallId: "t", ops: result.ops, summary: result.summary });
      expect(applied.skipped).toEqual([]);
    }
    return result;
  }

  it("keeps membership matching the boxes after arrange and move_node", async () => {
    const s = useWorkflowStore.getState();
    const member = s.addNode("prompt", { x: 3000, y: 3000 }, { prompt: "a" } as never);
    const stray = s.addNode("prompt", { x: -2500, y: 0 }, { prompt: "b" } as never);
    const gen = s.addNode("nanoBanana", { x: -2000, y: 900 });
    s.onConnect({ source: stray, sourceHandle: "text", target: gen, targetHandle: "text" });
    const groupId = s.createGroup([member]);
    s.toggleGroupLock(groupId);

    await run(turn(), "arrange_workflow", {});
    let state = useWorkflowStore.getState();
    const box = state.groups[groupId];
    for (const node of state.nodes) {
      expect(node.groupId === groupId, node.id).toBe(centreInside(node, box));
    }

    const moved = await run(turn(), "edit_workflow", { operations: [{ op: "move_node", node: member, position: { x: 9000, y: 9000 } }] });
    expect(moved.ok, moved.text).toBe(true);
    state = useWorkflowStore.getState();
    expect(state.nodes.find((n) => n.id === member)!.groupId).toBeUndefined();
    expect(state.groups[groupId].locked).toBe(true);
  });

  it("applies agent groups to the real store as one undo step per batch, and replays exactly what the tools saw", async () => {
    const s = useWorkflowStore.getState();
    const existing = s.addNode("prompt", { x: 0, y: 0 }, { prompt: "a lighthouse" } as never);
    const oldGroup = s.createGroup([existing]);
    const runtime = turn();

    // One batch: new nodes and the groups that hold them, next to a group already there.
    const created = await run(runtime, "create_workflow", {
      nodes: [
        { ref: "sp", type: "prompt", settings: { prompt: "a misty harbour at dawn" } },
        { ref: "sg", type: "nanoBanana" },
        { ref: "fv", type: "generateVideo" },
        { ref: "fo", type: "output" },
      ],
      connections: [
        { from: "sp", to: "sg" },
        { from: "sg", to: "fv" },
        { from: "existing", to: "fv" },
        { from: "fv", to: "fo" },
      ].map((c) => (c.from === "existing" ? { ...c, from: existing } : c)),
      groups: [
        { name: "Scene set", color: "blue", nodes: ["sp", "sg"] },
        { name: "Hero film", color: "purple", nodes: ["fv", "fo"] },
      ],
    });
    expect(created.ok, created.text).toBe(true);
    let state = useWorkflowStore.getState();
    // Created in the same batch as their nodes, and not pruned for it.
    expect(Object.keys(state.groups).sort()).toEqual([oldGroup, "group-ag1", "group-ag2"].sort());
    expect(state.groups["group-ag1"]).toMatchObject({ name: "Scene set", color: "blue" });
    expectTidyGroups(state);

    // A second batch: rename one, ungroup the other.
    const edited = await run(runtime, "edit_workflow", {
      operations: [
        { op: "update_group", group: "Scene set", name: "Establishing shot" },
        { op: "ungroup", group: "group-ag2" },
      ],
    });
    expect(edited.ok, edited.text).toBe(true);
    state = useWorkflowStore.getState();
    expect(state.groups["group-ag1"].name).toBe("Establishing shot");
    expect(state.groups["group-ag2"]).toBeUndefined();
    expect(state.nodes.filter((n) => n.groupId === "group-ag2")).toEqual([]);

    // The tools' draft and the store agree, groups included.
    const toolView = await runtime.execute("get_workflow", { detail: "full" });
    const browserView = await turn().execute("get_workflow", { detail: "full" });
    expect(browserView.text).toBe(toolView.text);

    // Undo: one step per batch.
    useWorkflowStore.getState().undo();
    state = useWorkflowStore.getState();
    expect(state.groups["group-ag1"].name).toBe("Scene set");
    expect(state.nodes.filter((n) => n.groupId === "group-ag2").map((n) => n.type)).toEqual(["generateVideo", "output"]);
    useWorkflowStore.getState().undo();
    state = useWorkflowStore.getState();
    expect(Object.keys(state.groups)).toEqual([oldGroup]);
    expect(state.nodes.map((n) => n.id)).toEqual([existing]);
  });
});
