/**
 * applyAgentGraphOps: the store side of the agent's canvas edits.
 *
 * applyGraphOps (the pure op applier) belongs to the graph module and is
 * replaced here by a small faithful fake, so these tests pin the store's own
 * contract: one undo step per batch, group handling, skipped-op reporting,
 * and starting a run after the edits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NodeGroup, WorkflowEdge, WorkflowNode, WorkflowNodeData } from "@/types";
import type { AgentGraphOp, AgentGraphOpBatch } from "@/lib/agent/types";
import type { ApplyGraphOpsDeps, ApplyGraphOpsResult, ApplyGraphOpsState } from "@/lib/agent/graph/applyOps";
import type { RunScope } from "../utils/runBatch";

const applyGraphOpsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent/graph/applyOps", () => ({ applyGraphOps: applyGraphOpsMock }));

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

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

import { useWorkflowStore } from "../workflowStore";

/** Minimal applier with the real one's contract (see graph/applyOps.ts). */
function fakeApplyGraphOps(
  state: ApplyGraphOpsState,
  ops: AgentGraphOp[],
  deps: ApplyGraphOpsDeps,
): ApplyGraphOpsResult {
  let nodes = [...state.nodes];
  let edges = [...state.edges];
  let groups: Record<string, NodeGroup> = state.groups ?? {};
  let clearedCanvas = false;
  let applied = 0;
  const skipped: string[] = [];
  let run: ApplyGraphOpsResult["run"];
  for (const op of ops) {
    switch (op.op) {
      case "clearCanvas":
        nodes = [];
        edges = [];
        groups = {};
        clearedCanvas = true;
        applied++;
        break;
      case "addGroup":
        groups = { ...groups, [op.id]: { id: op.id, name: op.name, color: op.color, position: op.position, size: op.size } };
        nodes = nodes.map((node) => (op.nodeIds.includes(node.id) ? { ...node, groupId: op.id } : node));
        applied++;
        break;
      case "updateGroup":
        groups = { ...groups, [op.id]: { ...groups[op.id], ...op } as NodeGroup };
        delete (groups[op.id] as { op?: string }).op;
        applied++;
        break;
      case "removeGroup": {
        const { [op.id]: _removed, ...rest } = groups;
        groups = rest;
        nodes = nodes.map((node) => (node.groupId === op.id ? { ...node, groupId: undefined } : node));
        applied++;
        break;
      }
      case "setNodeGroup":
        nodes = nodes.map((node) => (node.id === op.id ? { ...node, groupId: op.groupId ?? undefined } : node));
        applied++;
        break;
      case "addNode": {
        const size = deps.defaultNodeDimensions[op.nodeType];
        nodes.push({
          id: op.id,
          type: op.nodeType,
          position: op.position,
          data: { ...deps.createDefaultNodeData(op.nodeType), ...op.data } as WorkflowNodeData,
          style: { width: size.width, height: size.height },
        });
        applied++;
        break;
      }
      case "updateNode": {
        const index = nodes.findIndex((node) => node.id === op.id);
        if (index < 0) {
          skipped.push(`updateNode ${op.id}: node no longer exists`);
          break;
        }
        nodes[index] = { ...nodes[index], data: { ...nodes[index].data, ...op.data } as WorkflowNodeData };
        applied++;
        break;
      }
      case "removeNode":
        if (!nodes.some((node) => node.id === op.id)) {
          skipped.push(`removeNode ${op.id}: node no longer exists`);
          break;
        }
        nodes = nodes.filter((node) => node.id !== op.id);
        edges = edges.filter((edge) => edge.source !== op.id && edge.target !== op.id);
        applied++;
        break;
      case "addEdge":
        if (!nodes.some((n) => n.id === op.source) || !nodes.some((n) => n.id === op.target)) {
          skipped.push(`addEdge ${op.id}: an endpoint no longer exists`);
          break;
        }
        edges.push({
          id: op.id,
          source: op.source,
          sourceHandle: op.sourceHandle,
          target: op.target,
          targetHandle: op.targetHandle,
          data: { ...op.data, createdAt: 1 },
        } as WorkflowEdge);
        applied++;
        break;
      case "removeEdge":
        edges = edges.filter((edge) => edge.id !== op.id);
        applied++;
        break;
      case "moveNode":
        nodes = nodes.map((node) => (node.id === op.id ? { ...node, position: op.position } : node));
        applied++;
        break;
      case "run":
        run = { scope: op.scope, runs: op.runs };
        break;
    }
  }
  return { nodes, edges, groups, clearedCanvas, applied, skipped, ...(run ? { run } : {}) };
}

function batch(ops: AgentGraphOp[], extra: Partial<AgentGraphOpBatch> = {}): AgentGraphOpBatch {
  return { batchId: "b1", toolCallId: "call-1", ops, summary: "test", ...extra };
}

function promptNode(id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    type: "prompt",
    position: { x: 0, y: 0 },
    data: { prompt: "hello" } as WorkflowNodeData,
    style: { width: 320, height: 220 },
    ...extra,
  };
}

function seed(nodes: WorkflowNode[], edges: WorkflowEdge[] = [], groups = {}) {
  useWorkflowStore.setState({ nodes, edges, groups, hasUnsavedChanges: false });
}

describe("applyAgentGraphOps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    applyGraphOpsMock.mockReset();
    applyGraphOpsMock.mockImplementation(fakeApplyGraphOps);
    useWorkflowStore.getState().clearWorkflow();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the batch with the store's node defaults and dimensions", () => {
    const result = useWorkflowStore.getState().applyAgentGraphOps(
      batch([{ op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 10, y: 20 }, data: { prompt: "a cat" } }]),
    );

    expect(result).toEqual({ applied: 1, skipped: [] });
    const deps = applyGraphOpsMock.mock.calls[0][2] as ApplyGraphOpsDeps;
    expect(typeof deps.createDefaultNodeData).toBe("function");
    expect(deps.defaultNodeDimensions.prompt).toBeDefined();

    const state = useWorkflowStore.getState();
    const node = state.nodes.find((n) => n.id === "prompt-ag1");
    expect(node?.position).toEqual({ x: 10, y: 20 });
    expect((node?.data as { prompt?: string }).prompt).toBe("a cat");
    expect(state.hasUnsavedChanges).toBe(true);
  });

  it("records one undo step per batch, and undo restores the canvas before it", () => {
    seed([promptNode("prompt-1")]);
    expect(useWorkflowStore.getState().canUndo).toBe(false);

    useWorkflowStore.getState().applyAgentGraphOps(
      batch([
        { op: "addNode", id: "nanoBanana-ag1", nodeType: "nanoBanana", position: { x: 400, y: 0 }, data: {} },
        {
          op: "addEdge",
          id: "edge-prompt-1-nanoBanana-ag1-text-text",
          source: "prompt-1",
          sourceHandle: "text",
          target: "nanoBanana-ag1",
          targetHandle: "text",
        },
        { op: "updateNode", id: "prompt-1", data: { prompt: "changed" } },
      ]),
    );

    let state = useWorkflowStore.getState();
    expect(state.canUndo).toBe(true);
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);

    state.undo();
    state = useWorkflowStore.getState();
    expect(state.nodes.map((n) => n.id)).toEqual(["prompt-1"]);
    expect(state.edges).toHaveLength(0);
    expect((state.nodes[0].data as { prompt?: string }).prompt).toBe("hello");
    expect(state.canUndo).toBe(false);
  });

  it("clears groups when the batch cleared the canvas", () => {
    seed([promptNode("prompt-1", { groupId: "group-1" })], [], {
      "group-1": { id: "group-1", name: "Group 1", color: "blue", position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
    });

    useWorkflowStore.getState().applyAgentGraphOps(
      batch(
        [
          { op: "clearCanvas" },
          { op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: {} },
        ],
        { replacedCanvas: true },
      ),
    );

    const state = useWorkflowStore.getState();
    expect(state.groups).toEqual({});
    expect(state.nodes.map((n) => n.id)).toEqual(["prompt-ag1"]);

    // Undo brings the old canvas back, groups included.
    state.undo();
    expect(Object.keys(useWorkflowStore.getState().groups)).toEqual(["group-1"]);
  });

  it("prunes a group whose last node the agent removed, and keeps groups that still have members", () => {
    const group = (id: string) => ({
      id,
      name: id,
      color: "blue" as const,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
    });
    seed(
      [
        promptNode("prompt-1", { groupId: "group-a" }),
        promptNode("prompt-2", { groupId: "group-b" }),
        promptNode("prompt-3", { groupId: "group-b" }),
      ],
      [],
      { "group-a": group("group-a"), "group-b": group("group-b") },
    );

    useWorkflowStore.getState().applyAgentGraphOps(
      batch([
        { op: "removeNode", id: "prompt-1" },
        { op: "removeNode", id: "prompt-2" },
      ]),
    );

    expect(Object.keys(useWorkflowStore.getState().groups)).toEqual(["group-b"]);
  });

  it("passes the live groups to the applier and keeps the groups a batch creates with its nodes", () => {
    const group = (id: string): NodeGroup => ({ id, name: id, color: "blue", position: { x: 0, y: 0 }, size: { width: 400, height: 300 } });
    seed([promptNode("prompt-1", { groupId: "group-1" }), promptNode("prompt-2")], [], { "group-1": group("group-1") });

    useWorkflowStore.getState().applyAgentGraphOps(
      batch([
        { op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 500 }, data: {} },
        { op: "addGroup", id: "group-ag1", name: "Scene set", color: "purple", position: { x: -30, y: 470 }, size: { width: 380, height: 280 }, nodeIds: ["prompt-ag1", "prompt-2"] },
        { op: "updateGroup", id: "group-1", name: "Hero film" },
      ]),
    );
    expect(applyGraphOpsMock.mock.calls[0][0].groups).toEqual({ "group-1": group("group-1") });

    let state = useWorkflowStore.getState();
    expect(Object.keys(state.groups).sort()).toEqual(["group-1", "group-ag1"]);
    expect(state.groups["group-1"].name).toBe("Hero film");
    expect(state.groups["group-ag1"]).toMatchObject({ name: "Scene set", color: "purple", size: { width: 380, height: 280 } });
    expect(state.nodes.map((n) => [n.id, n.groupId])).toEqual([
      ["prompt-1", "group-1"],
      ["prompt-2", "group-ag1"],
      ["prompt-ag1", "group-ag1"],
    ]);

    // One undo step for the whole batch, groups included.
    state.undo();
    state = useWorkflowStore.getState();
    expect(state.groups).toEqual({ "group-1": group("group-1") });
    expect(state.nodes.map((n) => [n.id, n.groupId])).toEqual([
      ["prompt-1", "group-1"],
      ["prompt-2", undefined],
    ]);
  });

  it("keeps a group created in a batch that replaced the canvas, and drops the old ones", () => {
    const group = (id: string): NodeGroup => ({ id, name: id, color: "blue", position: { x: 0, y: 0 }, size: { width: 400, height: 300 } });
    seed([promptNode("prompt-1", { groupId: "group-1" })], [], { "group-1": group("group-1") });

    useWorkflowStore.getState().applyAgentGraphOps(
      batch(
        [
          { op: "removeNode", id: "prompt-1" },
          { op: "addNode", id: "prompt-ag1", nodeType: "prompt", position: { x: 0, y: 0 }, data: {} },
          { op: "addGroup", id: "group-ag1", name: "New", color: "green", position: { x: -30, y: -30 }, size: { width: 380, height: 280 }, nodeIds: ["prompt-ag1"] },
        ],
        { replacedCanvas: true },
      ),
    );
    expect(Object.keys(useWorkflowStore.getState().groups)).toEqual(["group-ag1"]);
  });

  it("returns skipped ops with their reasons", () => {
    seed([promptNode("prompt-1")]);

    const result = useWorkflowStore.getState().applyAgentGraphOps(
      batch([
        { op: "updateNode", id: "prompt-1", data: { prompt: "ok" } },
        { op: "updateNode", id: "gone", data: { prompt: "x" } },
      ]),
    );

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual(["updateNode gone: node no longer exists"]);
  });

  it("leaves undo history alone when nothing applied", () => {
    seed([promptNode("prompt-1")]);

    const result = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "removeNode", id: "gone" }]));

    const state = useWorkflowStore.getState();
    expect(result).toEqual({ applied: 0, skipped: ["removeNode gone: node no longer exists"] });
    expect(state.canUndo).toBe(false);
    expect(state.hasUnsavedChanges).toBe(false);
  });

  it("ignores an empty batch without calling the applier", () => {
    const result = useWorkflowStore.getState().applyAgentGraphOps(batch([]));
    expect(result).toEqual({ applied: 0, skipped: [] });
    expect(applyGraphOpsMock).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().canUndo).toBe(false);
  });

  it("recomputes switch dimming after the batch", () => {
    const recompute = vi.spyOn(useWorkflowStore.getState(), "recomputeDimmedNodes");
    seed([promptNode("prompt-1")]);
    useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "moveNode", id: "prompt-1", position: { x: 5, y: 5 } }]));
    expect(recompute).toHaveBeenCalled();
    recompute.mockRestore();
  });

  it("clears stale input images when the agent disconnects the last image source", () => {
    const imageInput: WorkflowNode = {
      id: "imageInput-1",
      type: "imageInput",
      position: { x: 0, y: 0 },
      data: { image: "data:image/png;base64,AAAA" } as WorkflowNodeData,
    };
    const generator: WorkflowNode = {
      id: "nanoBanana-1",
      type: "nanoBanana",
      position: { x: 400, y: 0 },
      data: { inputImages: ["data:image/png;base64,AAAA"] } as unknown as WorkflowNodeData,
    };
    const edge = {
      id: "edge-imageInput-1-nanoBanana-1-image-image",
      source: "imageInput-1",
      sourceHandle: "image",
      target: "nanoBanana-1",
      targetHandle: "image",
    } as WorkflowEdge;
    seed([imageInput, generator], [edge]);

    useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "removeEdge", id: edge.id }]));

    const state = useWorkflowStore.getState();
    const data = state.nodes.find((n) => n.id === "nanoBanana-1")?.data as { inputImages?: string[] };
    expect(data.inputImages).toEqual([]);

    // Still a single undo step: undo restores the edge and the images together.
    vi.advanceTimersByTime(1000);
    state.undo();
    const restored = useWorkflowStore.getState();
    expect(restored.edges).toHaveLength(1);
    expect(
      (restored.nodes.find((n) => n.id === "nanoBanana-1")?.data as { inputImages?: string[] }).inputImages,
    ).toHaveLength(1);
    expect(restored.canUndo).toBe(false);
  });

  describe("a run the batch asks for", () => {
    const originalRunBatch = useWorkflowStore.getState().runBatch;
    const runBatch = vi.fn<(scope: RunScope, count?: number) => Promise<void>>();
    /** As the real one: the first run is going before runBatch first awaits. */
    const startRun = async () => {
      useWorkflowStore.setState({ isRunning: true });
    };

    beforeEach(() => {
      runBatch.mockReset();
      runBatch.mockImplementation(startRun);
      useWorkflowStore.setState({ runBatch, isRunning: false, batch: null });
    });

    afterEach(() => {
      useWorkflowStore.setState({ runBatch: originalRunBatch, isRunning: false, batch: null, desktopConnected: true });
    });

    it("starts through runBatch once the batch's edits are on the canvas, outside its undo step", () => {
      seed([promptNode("prompt-1")]);
      let canvasWhenStarted: string[] = [];
      runBatch.mockImplementation(async () => {
        canvasWhenStarted = useWorkflowStore.getState().nodes.map((node) => node.id);
        await startRun();
      });

      const result = useWorkflowStore.getState().applyAgentGraphOps(
        batch([
          { op: "addNode", id: "llmGenerate-ag1", nodeType: "llmGenerate", position: { x: 400, y: 0 }, data: {} },
          { op: "run", scope: { kind: "nodes", nodeIds: ["llmGenerate-ag1"] }, runs: 2 },
        ]),
      );

      expect(result).toEqual({
        applied: 1,
        skipped: [],
        runStarted: true,
        run: { scope: { kind: "nodes", nodeIds: ["llmGenerate-ag1"] }, runs: 2 },
      });
      expect(runBatch).toHaveBeenCalledTimes(1);
      expect(runBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["llmGenerate-ag1"] }, 2);
      expect(canvasWhenStarted).toEqual(["prompt-1", "llmGenerate-ag1"]);
      // One undo step, for the edit: undoing it neither re-runs nor leaves a step behind.
      useWorkflowStore.getState().undo();
      expect(useWorkflowStore.getState().nodes.map((node) => node.id)).toEqual(["prompt-1"]);
      expect(useWorkflowStore.getState().canUndo).toBe(false);
      expect(runBatch).toHaveBeenCalledTimes(1);
    });

    it("leaves undo history and the unsaved flag alone for a batch that only runs", () => {
      seed([promptNode("prompt-1")]);
      const result = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "run", scope: { kind: "all" }, runs: 1 }]));
      expect(result).toEqual({ applied: 0, skipped: [], runStarted: true, run: { scope: { kind: "all" }, runs: 1 } });
      expect(runBatch).toHaveBeenCalledWith({ kind: "all" }, 1);
      expect(useWorkflowStore.getState().canUndo).toBe(false);
      expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(false);
    });

    it("ignores the run while one is going (a run or a batch between its runs), and says why", () => {
      seed([promptNode("prompt-1")]);
      useWorkflowStore.setState({ isRunning: true });
      const during = useWorkflowStore.getState().applyAgentGraphOps(
        batch([
          { op: "updateNode", id: "prompt-1", data: { prompt: "changed" } },
          { op: "run", scope: { kind: "all" }, runs: 1 },
        ]),
      );
      expect(during).toEqual({ applied: 1, skipped: [], runRefused: "a run is already going" });
      useWorkflowStore.setState({ isRunning: false, batch: { id: "batch-1", index: 1, count: 3, stopping: false } });
      const between = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "run", scope: { kind: "all" }, runs: 1 }]));
      expect(between.runRefused).toBe("a run is already going");
      expect(between).not.toHaveProperty("runStarted");
      expect(runBatch).not.toHaveBeenCalled();
    });

    it("says the run started only for a batch that started one, so the chat can follow it", () => {
      seed([promptNode("prompt-1")]);
      const edit = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "updateNode", id: "prompt-1", data: { prompt: "changed" } }]));
      expect(edit).not.toHaveProperty("runStarted");
      expect(edit).not.toHaveProperty("runRefused");

      const run = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "run", scope: { kind: "all" }, runs: 3 }]));
      expect(run.runStarted).toBe(true);
      expect(run).not.toHaveProperty("runRefused");
      expect(runBatch).toHaveBeenCalledWith({ kind: "all" }, 3);
    });

    it("hands back the run it started as the live canvas allowed it, for the chat's record", () => {
      seed([promptNode("prompt-1")]);
      // The applier leaves out a node the user deleted meanwhile.
      applyGraphOpsMock.mockImplementationOnce((state: ApplyGraphOpsState, ops: AgentGraphOp[], deps: ApplyGraphOpsDeps) => ({
        ...fakeApplyGraphOps(state, ops, deps),
        run: { scope: { kind: "nodes", nodeIds: ["prompt-1"] }, runs: 2 },
      }));
      const result = useWorkflowStore
        .getState()
        .applyAgentGraphOps(batch([{ op: "run", scope: { kind: "nodes", nodeIds: ["prompt-1", "gone-1"] }, runs: 2 }]));
      expect(result.run).toEqual({ scope: { kind: "nodes", nodeIds: ["prompt-1"] }, runs: 2 });
      expect(runBatch).toHaveBeenCalledWith({ kind: "nodes", nodeIds: ["prompt-1"] }, 2);

      useWorkflowStore.setState({ isRunning: false });
      runBatch.mockImplementationOnce(async () => {});
      const refused = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "run", scope: { kind: "all" }, runs: 1 }]));
      expect(refused).not.toHaveProperty("run");
    });

    it("says the run didn't start when the canvas refused it at once, with the canvas's reason", () => {
      seed([promptNode("prompt-1")]);
      // The real runBatch: a batch of three is set up before its first run is refused.
      useWorkflowStore.setState({ runBatch: originalRunBatch, desktopConnected: false });
      const offline = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "run", scope: { kind: "all" }, runs: 3 }]));
      expect(offline).toEqual({
        applied: 0,
        skipped: [],
        runRefused: "Local server disconnected. Use Help → Restart Local Server to reconnect.",
      });

      useWorkflowStore.setState({ runBatch, batch: null, desktopConnected: true });
      runBatch.mockImplementation(async () => {});
      const refused = useWorkflowStore.getState().applyAgentGraphOps(batch([{ op: "run", scope: { kind: "all" }, runs: 1 }]));
      expect(refused).toEqual({ applied: 0, skipped: [], runRefused: "the canvas refused it" });
    });
  });
});
