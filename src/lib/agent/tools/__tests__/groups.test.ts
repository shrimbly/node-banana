/**
 * Groups and the agent's layout tools (review C8).
 *
 * A group is a box stored on the group plus a `groupId` on each member; the
 * canvas keeps the two in step only when the user drags. The agent must do the
 * same: arranging leaves grouped nodes (and their box) alone, new nodes are
 * placed clear of every box, and move_node joins or leaves groups by where
 * the node's centre lands, like a drop on the canvas.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowNode } from "@/types";
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
import type { AgentGraphOp, AgentToolRuntime } from "../../types";
import { buildAgentSnapshot } from "../../graph/snapshot";
import { createAgentToolRuntime } from "../runtime";
import { applyResult, call, sequentialIds, storeEdge, storeNode, type StoreState } from "./testUtils";

type Box = { x: number; y: number; width: number; height: number };

function group(id: string, box: Box, locked = false): NodeGroup {
  return { id, name: `Group ${id}`, color: "blue", position: { x: box.x, y: box.y }, size: { width: box.width, height: box.height }, ...(locked ? { locked } : {}) };
}

function runtimeWith(state: StoreState, groups: Record<string, NodeGroup>): AgentToolRuntime {
  return createAgentToolRuntime(buildAgentSnapshot({ nodes: state.nodes, edges: state.edges, groups }), { randomId: sequentialIds() });
}

function boxOf(node: WorkflowNode): Box {
  const { width, height } = getNodeSize(node);
  return { x: node.position.x, y: node.position.y, width, height };
}

function centreInside(node: WorkflowNode, g: NodeGroup): boolean {
  const b = boxOf(node);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx >= g.position.x && cx <= g.position.x + g.size.width && cy >= g.position.y && cy <= g.position.y + g.size.height;
}

function overlaps(a: Box, g: NodeGroup): boolean {
  return a.x < g.position.x + g.size.width && a.x + a.width > g.position.x && a.y < g.position.y + g.size.height && a.y + a.height > g.position.y;
}

function moveOps(ops: AgentGraphOp[]) {
  return ops.filter((op): op is Extract<AgentGraphOp, { op: "moveNode" }> => op.op === "moveNode");
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
  });

  it("arrange_workflow leaves grouped nodes in their box and keeps everything else out of it", async () => {
    const state = grouped();
    const result = await call(runtimeWith(state, { "group-1": g1 }), "arrange_workflow", {});
    expect(result.ok, result.text).toBe(true);
    expect(moveOps(result.ops).map((op) => op.id).sort()).toEqual(["nanoBanana-4", "output-5", "prompt-3"]);
    expect(result.text).toContain('Left 2 grouped nodes in place (group "Group group-1")');
    const store = applyResult(state, result);
    for (const node of store.nodes) {
      if (node.groupId) expect(centreInside(node, g1), node.id).toBe(true);
      else expect(overlaps(boxOf(node), g1), node.id).toBe(false);
    }

    const onlyGrouped = await call(runtimeWith(state, { "group-1": g1 }), "arrange_workflow", { nodeIds: ["prompt-1"] });
    expect(onlyGrouped.ops).toEqual([]);
    expect(onlyGrouped.text).toContain("Nothing was moved");
  });

  it("move_node takes a member out of its group when it lands outside the box", async () => {
    const state = grouped();
    const result = await call(runtimeWith(state, { "group-1": g1 }), "edit_workflow", {
      operations: [{ op: "move_node", node: "prompt-1", position: { x: 5000, y: 5000 } }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(moveOps(result.ops)).toEqual([{ op: "moveNode", id: "prompt-1", position: { x: 5000, y: 5000 }, groupId: null }]);
    expect(result.text).toContain('prompt-1 left group "Group group-1" (a locked group, so it runs again)');
    const store = applyResult(state, result);
    expect(store.nodes.find((n) => n.id === "prompt-1")!.groupId).toBeUndefined();
    expect(store.nodes.find((n) => n.id === "nanoBanana-2")!.groupId).toBe("group-1");
  });

  it("move_node puts a node dropped inside a locked group's box into that group, and says it will not run", async () => {
    const state = grouped();
    const result = await call(runtimeWith(state, { "group-1": g1 }), "edit_workflow", {
      operations: [{ op: "move_node", node: "prompt-3", position: { x: 3000, y: 3020 } }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(moveOps(result.ops)[0]).toMatchObject({ id: "prompt-3", groupId: "group-1" });
    expect(result.text).toContain('prompt-3 is now in locked group "Group group-1": it will not run until the user unlocks the group');
    const store = applyResult(state, result);
    expect(store.nodes.find((n) => n.id === "prompt-3")!.groupId).toBe("group-1");

    // Moving within the box changes nothing about membership.
    const within = await call(runtimeWith(state, { "group-1": g1 }), "edit_workflow", {
      operations: [{ op: "move_node", node: "prompt-1", position: { x: 3010, y: 3010 } }],
    });
    expect(moveOps(within.ops)[0]).not.toHaveProperty("groupId");
  });

  it("places new nodes clear of a group's empty area", async () => {
    const state: StoreState = {
      nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a" }, { groupId: "group-1" })],
      edges: [],
    };
    const wide = group("group-1", { x: -20, y: -20, width: 2000, height: 600 }, true);
    const result = await call(runtimeWith(state, { "group-1": wide }), "edit_workflow", {
      operations: [
        { op: "add_node", ref: "g", type: "nanoBanana" },
        { op: "connect", from: "prompt-1", to: "g" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const store = applyResult(state, result);
    const added = store.nodes.find((n) => n.type === "nanoBanana")!;
    expect(overlaps(boxOf(added), wide)).toBe(false);
    expect(added.groupId).toBeUndefined();
  });

  it("shows each group's box and lock in get_workflow", async () => {
    const result = await call(runtimeWith(grouped(), { "group-1": g1 }), "get_workflow", {});
    expect(result.text).toContain("- Group group-1 [group-1] locked box (2980, 2980) 800×300: prompt-1, nanoBanana-2");
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

  async function run(runtime: AgentToolRuntime, name: string, args: unknown) {
    const result = await runtime.execute(name, args);
    if (result.ops.length > 0) {
      useWorkflowStore.getState().applyAgentGraphOps({ batchId: "b", toolCallId: "t", ops: result.ops, summary: result.summary });
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
});
