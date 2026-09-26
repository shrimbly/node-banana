/**
 * An agent batch that gives a Split Grid its cells is built on the spot:
 * the cells, their groups and the shared Router appear before Run, the
 * Router the agent created is the one reused, and its wire to the gallery
 * survives — all as one undo step.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { createAgentToolRuntime } from "@/lib/agent/tools/runtime";
import { buildAgentSnapshot } from "@/lib/agent/graph/snapshot";
import type { SplitGridNodeData } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
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
  setItem: vi.fn((key: string, value: string) => void (storage[key] = value)),
  removeItem: vi.fn((key: string) => void delete storage[key]),
  clear: vi.fn(),
});

describe("applyAgentGraphOps with a Split Grid's cells", () => {
  beforeEach(() => {
    useWorkflowStore.getState().clearWorkflow();
  });

  it("builds every cell into the agent's Router and keeps the Router's gallery wire", async () => {
    const store = useWorkflowStore.getState();
    const snapshot = buildAgentSnapshot({ nodes: store.nodes, edges: store.edges, groups: store.groups });
    const runtime = createAgentToolRuntime(snapshot, { randomId: () => Math.random().toString(36).slice(2, 9) });
    const result = await runtime.execute("create_workflow", {
      nodes: [
        { ref: "g", type: "nanoBanana" },
        {
          ref: "s",
          type: "splitGrid",
          settings: {
            gridRows: 3,
            gridCols: 3,
            cells: {
              nodes: [
                { ref: "ask", type: "prompt", settings: { prompt: "Upscale this image" } },
                { ref: "up", type: "nanoBanana", settings: { resolution: "4K" } },
              ],
              connections: [
                { from: "cell", to: "up" },
                { from: "ask", to: "up" },
              ],
              collect: [{ from: "up" }],
              into: "gallery",
            },
          },
        },
        { ref: "gallery", type: "outputGallery" },
      ],
      connections: [{ from: "g", to: "s" }],
    });
    expect(result.ok, result.text).toBe(true);

    const undoBefore = useWorkflowStore.getState().canUndo;
    const applied = useWorkflowStore.getState().applyAgentGraphOps({ batchId: "b1", toolCallId: "t1", ops: result.ops, summary: "" });
    expect(applied.skipped).toEqual([]);

    const { nodes, edges, groups } = useWorkflowStore.getState();
    const grid = nodes.find((n) => n.type === "splitGrid")!;
    const data = grid.data as SplitGridNodeData;
    const routers = nodes.filter((n) => n.type === "router");
    const gallery = nodes.find((n) => n.type === "outputGallery")!;

    // Nine cells, one group each, all feeding the one Router the agent made.
    expect(data.cells).toHaveLength(9);
    expect(Object.keys(groups)).toHaveLength(9);
    expect(routers).toHaveLength(1);
    expect(data.routerNodeId).toBe(routers[0].id);
    expect(edges.filter((e) => e.target === routers[0].id && e.targetHandle === "image")).toHaveLength(9);
    expect(edges.some((e) => e.source === routers[0].id && e.sourceHandle === "image" && e.target === gallery.id)).toBe(true);
    // Each cell: slice + prompt + upscale.
    expect(nodes.filter((n) => n.type === "nanoBanana")).toHaveLength(1 + 9);

    // One undo step for the whole batch, cells included.
    expect(undoBefore).toBe(false);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes).toHaveLength(0);
  });
});
