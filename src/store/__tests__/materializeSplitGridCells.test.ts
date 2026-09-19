/**
 * Integration tests for materializeSplitGridCells through the real Zustand store.
 *
 * Covers template instantiation (nodes, groups, reference edges, node data
 * bookkeeping), no-op behavior when cells are current, rebuild on config
 * change, legacy childNodeIds handling, and undo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { useWorkflowStore } from "../workflowStore";
import {
  createDefaultSplitGridTemplate,
  createClassicSplitGridTemplate,
  computeMaterializedKey,
  getSplitGridTemplate,
} from "../utils/splitGridTemplate";
import { getNodeSize } from "@/utils/nodeDimensions";
import type {
  WorkflowNode,
  WorkflowNodeData,
  SplitGridNodeData,
  PromptNodeData,
} from "@/types";

// Mock the Toast hook
vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

// Mock the logger
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

// Mock localStorage for provider/generation defaults
const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  }),
});

function resetStore() {
  useWorkflowStore.getState().clearWorkflow();
}

const SPLIT_ID = "splitGrid-test-1";

function makeSplitGridNode(data: Partial<SplitGridNodeData> = {}): WorkflowNode {
  return {
    id: SPLIT_ID,
    type: "splitGrid",
    position: { x: 0, y: 0 },
    style: { width: 300, height: 400 },
    data: {
      sourceImage: null,
      gridRows: 2,
      gridCols: 2,
      template: createDefaultSplitGridTemplate(),
      cells: [],
      materializedKey: null,
      targetCount: 4,
      defaultPrompt: "",
      generateSettings: {
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
        useImageSearch: false,
      },
      childNodeIds: [],
      isConfigured: false,
      status: "idle",
      error: null,
      ...data,
    } as WorkflowNodeData,
  };
}

function makeNode(id: string, type: string): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    position: { x: 0, y: 0 },
    data: {} as WorkflowNodeData,
  };
}

function getSplitData(): SplitGridNodeData {
  const node = useWorkflowStore.getState().nodes.find((n) => n.id === SPLIT_ID);
  return node!.data as SplitGridNodeData;
}

describe("materializeSplitGridCells", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  describe("default template 2x2", () => {
    beforeEach(() => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode()],
        edges: [],
      });
    });

    it("creates a configured video generator in every cell with its typed connections", () => {
      const template = createClassicSplitGridTemplate();
      const generator = template.nodes.find((node) => node.type === "nanoBanana")!;
      generator.type = "generateVideo";
      generator.data = {
        selectedModel: { provider: "fal", modelId: "test-video", displayName: "Test Video" },
        parameters: { duration: "10" },
        inputSchema: [{ name: "image_url", type: "image", label: "Start frame", required: true }],
      };
      template.edges[0].targetHandle = "image-0";
      template.edges[1].targetHandle = "text-0";
      template.router = [{ source: generator.id, sourceHandle: "video", targetHandle: "video" }];
      act(() => useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID, { force: true, template }));
      const state = useWorkflowStore.getState();
      const videos = state.nodes.filter((node) => node.type === "generateVideo");
      expect(videos).toHaveLength(4);
      for (const video of videos) {
        expect(video.data).toMatchObject(generator.data);
        expect(state.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ target: video.id, targetHandle: "image-0", sourceHandle: "image" }),
          expect.objectContaining({ target: video.id, targetHandle: "text-0", sourceHandle: "text" }),
          expect.objectContaining({ source: video.id, sourceHandle: "video", target: getSplitData().routerNodeId, targetHandle: "video" }),
        ]));
      }
    });

    it.each(["grid", "vertical", "horizontal"] as const)("persists and places cells in %s layout without changing their source order", (layout) => {
      const template = { ...createClassicSplitGridTemplate(), layout };
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID, { force: true, template });
      });
      const state = useWorkflowStore.getState();
      const data = getSplitData();
      expect(data.template?.layout).toBe(layout);
      const groups = data.cells!.map((cell) => state.groups[cell.groupId!]);
      expect(groups.map((group) => group.name)).toEqual(["Cell 1-1", "Cell 1-2", "Cell 2-1", "Cell 2-2"]);
      expect(new Set(groups.map((group) => group.position.x)).size).toBe(layout === "vertical" ? 1 : layout === "horizontal" ? 4 : 2);
      expect(new Set(groups.map((group) => group.position.y)).size).toBe(layout === "horizontal" ? 1 : layout === "vertical" ? 4 : 2);
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i], b = groups[j];
          expect(b.position.x >= a.position.x + a.size.width || b.position.y >= a.position.y + a.size.height).toBe(true);
        }
      }
      // Running again preserves the saved arrangement and existing cell IDs.
      expect(useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID)).toBe(false);
      expect(getSplitData().cells).toEqual(data.cells);
    });

    it("rebuilds when the saved layout changes, and undo restores the previous layout", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const originalCells = getSplitData().cells;
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID, {
          template: { ...createDefaultSplitGridTemplate(), layout: "horizontal" },
        });
      });
      expect(getSplitData().template?.layout).toBe("horizontal");
      expect(getSplitData().cells).not.toEqual(originalCells);
      act(() => useWorkflowStore.getState().undo());
      expect(getSplitData().template?.layout ?? "grid").toBe("grid");
      expect(getSplitData().cells).toEqual(originalCells);
    });

    it("creates 4 imageInput nodes, 4 groups, and 4 reference edges", () => {
      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      const imageInputs = state.nodes.filter((n) => n.type === "imageInput");
      expect(imageInputs).toHaveLength(4);
      expect(state.nodes).toHaveLength(5); // split node + 4 cells

      expect(Object.keys(state.groups)).toHaveLength(4);
      expect(
        Object.values(state.groups)
          .map((g) => g.name)
          .sort()
      ).toEqual(["Cell 1-1", "Cell 1-2", "Cell 2-1", "Cell 2-2"]);

      const referenceEdges = state.edges.filter((e) => e.type === "reference");
      expect(referenceEdges).toHaveLength(4);
      expect(state.edges).toHaveLength(4);
      for (const edge of referenceEdges) {
        expect(edge.source).toBe(SPLIT_ID);
        expect(edge.sourceHandle).toBe("reference");
        expect(edge.targetHandle).toBe("reference");
        expect(imageInputs.some((n) => n.id === edge.target)).toBe(true);
      }
    });

    it("updates the split node's cells, materializedKey, targetCount, and isConfigured", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const data = getSplitData();
      expect(data.cells).toHaveLength(4);

      const state = useWorkflowStore.getState();
      const nodeIds = new Set(state.nodes.map((n) => n.id));
      for (const cell of data.cells!) {
        expect(nodeIds.has(cell.baseImageNodeId)).toBe(true);
        expect(cell.nodeIds).toEqual([cell.baseImageNodeId]); // single-node template
        expect(cell.groupId).toBeDefined();
        expect(state.groups[cell.groupId!]).toBeDefined();
      }

      expect(data.materializedKey).toBe(
        computeMaterializedKey(2, 2, getSplitGridTemplate(data))
      );
      expect(data.targetCount).toBe(4);
      expect(data.isConfigured).toBe(true);
      expect(data.childNodeIds).toEqual([]);
    });

    it("is a no-op when cells already match the configuration", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const stateAfterFirst = useWorkflowStore.getState();
      const nodeCount = stateAfterFirst.nodes.length;
      const nodeIds = stateAfterFirst.nodes.map((n) => n.id);
      const groupIds = Object.keys(stateAfterFirst.groups);

      let secondResult = true;
      act(() => {
        secondResult = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      expect(secondResult).toBe(false);
      const state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(nodeCount);
      expect(state.nodes.map((n) => n.id)).toEqual(nodeIds);
      expect(Object.keys(state.groups)).toEqual(groupIds);
    });

    it("rebuilds cells when gridRows changes (old cell nodes and groups removed)", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const oldCellNodeIds = getSplitData().cells!.flatMap((c) => c.nodeIds);
      const oldGroupIds = Object.keys(useWorkflowStore.getState().groups);
      expect(oldCellNodeIds).toHaveLength(4);

      act(() => {
        useWorkflowStore.getState().updateNodeData(SPLIT_ID, { gridRows: 3 });
      });

      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      const imageInputs = state.nodes.filter((n) => n.type === "imageInput");
      expect(imageInputs).toHaveLength(6); // 3x2
      expect(state.nodes).toHaveLength(7);
      expect(Object.keys(state.groups)).toHaveLength(6);
      expect(state.edges.filter((e) => e.type === "reference")).toHaveLength(6);

      // Old cell nodes and groups are gone
      const currentIds = new Set(state.nodes.map((n) => n.id));
      for (const oldId of oldCellNodeIds) {
        expect(currentIds.has(oldId)).toBe(false);
      }
      for (const oldGroupId of oldGroupIds) {
        expect(state.groups[oldGroupId]).toBeUndefined();
      }

      const data = getSplitData();
      expect(data.cells).toHaveLength(6);
      expect(data.targetCount).toBe(6);
      expect(data.materializedKey).toBe(
        computeMaterializedKey(3, 2, getSplitGridTemplate(data))
      );
    });
  });

  describe("prompt + generate template", () => {
    it("creates 3 nodes per cell wired imageInput->nanoBanana and prompt->nanoBanana", () => {
      useWorkflowStore.setState({
        nodes: [
          makeSplitGridNode({ template: createClassicSplitGridTemplate("cell prompt") }),
        ],
        edges: [],
      });

      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      expect(state.nodes.filter((n) => n.type === "imageInput")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "prompt")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "nanoBanana")).toHaveLength(4);
      expect(state.nodes).toHaveLength(13); // split + 4 cells * 3 nodes

      const data = getSplitData();
      expect(data.cells).toHaveLength(4);

      for (const cell of data.cells!) {
        expect(cell.nodeIds).toHaveLength(3);
        const cellNodes = state.nodes.filter((n) => cell.nodeIds.includes(n.id));
        const imageNode = cellNodes.find((n) => n.type === "imageInput")!;
        const promptNode = cellNodes.find((n) => n.type === "prompt")!;
        const generateNode = cellNodes.find((n) => n.type === "nanoBanana")!;
        expect(cell.baseImageNodeId).toBe(imageNode.id);

        // imageInput -> nanoBanana (image handles)
        expect(
          state.edges.some(
            (e) =>
              e.source === imageNode.id &&
              e.target === generateNode.id &&
              e.sourceHandle === "image" &&
              e.targetHandle === "image"
          )
        ).toBe(true);

        // prompt -> nanoBanana (text handles)
        expect(
          state.edges.some(
            (e) =>
              e.source === promptNode.id &&
              e.target === generateNode.id &&
              e.sourceHandle === "text" &&
              e.targetHandle === "text"
          )
        ).toBe(true);

        // reference edge split -> base image node
        expect(
          state.edges.some(
            (e) => e.type === "reference" && e.source === SPLIT_ID && e.target === imageNode.id
          )
        ).toBe(true);

        // seeded prompt text from the template
        expect((promptNode.data as PromptNodeData).prompt).toBe("cell prompt");

        // all three nodes share the cell's group
        for (const node of cellNodes) {
          expect(node.groupId).toBe(cell.groupId);
        }
      }

      // 4 cells * (2 intra edges + 1 reference edge)
      expect(state.edges).toHaveLength(12);
    });
  });

  describe("legacy childNodeIds workflows", () => {
    function seedLegacyWorkflow(dims: { gridRows: number; gridCols: number } = { gridRows: 1, gridCols: 1 }) {
      useWorkflowStore.setState({
        nodes: [
          makeSplitGridNode({
            ...dims,
            template: undefined,
            cells: undefined,
            materializedKey: undefined,
            defaultPrompt: "legacy prompt",
            childNodeIds: [
              { imageInput: "legacy-img-1", prompt: "legacy-prompt-1", nanoBanana: "legacy-gen-1" },
            ],
            isConfigured: true,
          }),
          makeNode("legacy-img-1", "imageInput"),
          makeNode("legacy-prompt-1", "prompt"),
          makeNode("legacy-gen-1", "nanoBanana"),
        ],
        edges: [],
      });
    }

    it("returns false for legacy nodes matching their grid without force", () => {
      seedLegacyWorkflow();

      let result = true;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      expect(result).toBe(false);
      const state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(4);
      expect(state.nodes.some((n) => n.id === "legacy-img-1")).toBe(true);
    });

    it("rebuilds legacy nodes whose grid no longer matches the child count", () => {
      // 2x2 grid but only one legacy child set: the slices would misalign,
      // so a rebuild (via the classic template) replaces the legacy children
      seedLegacyWorkflow({ gridRows: 2, gridCols: 2 });

      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      expect(result).toBe(true);
      const state = useWorkflowStore.getState();
      expect(state.nodes.some((n) => n.id === "legacy-img-1")).toBe(false);
      const data = state.nodes.find((n) => n.id === SPLIT_ID)!.data as SplitGridNodeData;
      expect(data.cells).toHaveLength(4);
      // Classic template: image + prompt + generate per cell
      expect(data.cells![0].nodeIds).toHaveLength(3);
    });

    it("rebuilds with force:true, removing legacy child nodes", () => {
      seedLegacyWorkflow({ gridRows: 2, gridCols: 2 });

      let result = false;
      act(() => {
        result = useWorkflowStore
          .getState()
          .materializeSplitGridCells(SPLIT_ID, { force: true });
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      // Legacy children are gone
      expect(state.nodes.some((n) => n.id === "legacy-img-1")).toBe(false);
      expect(state.nodes.some((n) => n.id === "legacy-prompt-1")).toBe(false);
      expect(state.nodes.some((n) => n.id === "legacy-gen-1")).toBe(false);

      // Legacy data maps onto the classic template: 3 nodes per cell, 2x2 grid
      expect(state.nodes).toHaveLength(13);
      expect(state.nodes.filter((n) => n.type === "imageInput")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "prompt")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "nanoBanana")).toHaveLength(4);

      const data = getSplitData();
      expect(data.cells).toHaveLength(4);
      expect(data.childNodeIds).toEqual([]);
      expect(data.template).toBeDefined();
      expect(data.isConfigured).toBe(true);
    });
  });

  describe("invalid targets", () => {
    it("returns false for an unknown node id", () => {
      useWorkflowStore.setState({ nodes: [makeSplitGridNode()], edges: [] });

      let result = true;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells("nonexistent");
      });

      expect(result).toBe(false);
      expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    });

    it("returns false when the node is not a splitGrid node", () => {
      useWorkflowStore.setState({
        nodes: [makeNode("prompt-1", "prompt")],
        edges: [],
      });

      let result = true;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells("prompt-1");
      });

      expect(result).toBe(false);
    });
  });

  describe("undo", () => {
    it("a single undo restores the pre-materialization node and group counts", () => {
      useWorkflowStore.setState({ nodes: [makeSplitGridNode()], edges: [] });

      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      let state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(5);
      expect(Object.keys(state.groups)).toHaveLength(4);
      expect(state.edges).toHaveLength(4);
      expect(state.canUndo).toBe(true);

      act(() => {
        useWorkflowStore.getState().undo();
      });

      state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe(SPLIT_ID);
      expect(Object.keys(state.groups)).toHaveLength(0);
      expect(state.edges).toHaveLength(0);

      const data = getSplitData();
      expect(data.cells).toEqual([]);
      expect(data.materializedKey).toBeNull();
    });
  });

  describe("shared downstream router", () => {
    // Classic template with its generate node wired to the fixed router port.
    function routerWiredTemplate() {
      const t = createClassicSplitGridTemplate();
      return {
        ...t,
        router: [{ source: "cell-generate", sourceHandle: "image", targetHandle: "image" }],
      };
    }

    it("creates exactly one shared router right of the grid with a terminal->router edge per cell", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const state = useWorkflowStore.getState();
      const routers = state.nodes.filter((n) => n.type === "router");
      expect(routers).toHaveLength(1);
      const router = routers[0];

      // Tracked on the split node, shared (no group), grid groups unchanged
      expect(getSplitData().routerNodeId).toBe(router.id);
      expect(router.groupId).toBeUndefined();
      expect(Object.keys(state.groups)).toHaveLength(4);

      // One typed edge per cell, from each cell's generate node into the router
      const routerEdges = state.edges.filter((e) => e.target === router.id);
      expect(routerEdges).toHaveLength(4);
      const generateIds = new Set(
        state.nodes.filter((n) => n.type === "nanoBanana").map((n) => n.id)
      );
      for (const e of routerEdges) {
        expect(generateIds.has(e.source)).toBe(true);
        expect(e.targetHandle).toBe("image");
        expect(e.type).not.toBe("reference");
      }

      // Positioned to the right of every cell node
      const cellRightEdges = state.nodes
        .filter((n) => n.groupId)
        .map((n) => n.position.x + ((n.style?.width as number) ?? 300));
      expect(router.position.x).toBeGreaterThan(Math.max(...cellRightEdges));

      // split + 12 cell nodes + 1 router; 4 ref + 8 intra + 4 router edges
      expect(state.nodes).toHaveLength(14);
      expect(state.edges).toHaveLength(16);
    });

    it("creates no router when the template port is unwired", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: createClassicSplitGridTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const state = useWorkflowStore.getState();
      expect(state.nodes.filter((n) => n.type === "router")).toHaveLength(0);
      expect(getSplitData().routerNodeId ?? null).toBeNull();
    });

    it("reuses the router id and preserves onward wiring across a grid resize", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;
      expect(routerId).toBeTruthy();

      // User wires the router onward to an output node on the main canvas
      act(() => {
        useWorkflowStore.setState((s) => ({
          nodes: [...s.nodes, makeNode("out-1", "output")],
          edges: [
            ...s.edges,
            {
              id: "edge-router-out",
              source: routerId,
              sourceHandle: "image",
              target: "out-1",
              targetHandle: "image",
            },
          ],
        }));
      });

      // Resize 2x2 -> 3x2 and rematerialize
      act(() => {
        useWorkflowStore.getState().updateNodeData(SPLIT_ID, { gridRows: 3 });
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const state = useWorkflowStore.getState();
      expect(getSplitData().routerNodeId).toBe(routerId); // id stable
      expect(state.nodes.filter((n) => n.type === "router")).toHaveLength(1);
      expect(state.edges.filter((e) => e.target === routerId)).toHaveLength(6); // rewired to 6 cells
      // Onward wiring survives
      expect(
        state.edges.some((e) => e.id === "edge-router-out" && e.source === routerId)
      ).toBe(true);
    });

    it("removes onward edges whose router output type is no longer active", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;
      act(() => {
        useWorkflowStore.setState((state) => ({
          nodes: [...state.nodes, makeNode("out-1", "output")],
          edges: [
            ...state.edges,
            {
              id: "edge-router-out",
              source: routerId,
              sourceHandle: "image",
              target: "out-1",
              targetHandle: "image",
            },
          ],
        }));
      });

      const textRouterTemplate = {
        ...createClassicSplitGridTemplate(),
        router: [{ source: "cell-prompt", sourceHandle: "text", targetHandle: "text" }],
      };
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID, {
          force: true,
          template: textRouterTemplate,
        });
      });

      const state = useWorkflowStore.getState();
      expect(getSplitData().routerNodeId).toBe(routerId);
      expect(state.edges.some((edge) => edge.id === "edge-router-out")).toBe(false);
      expect(state.edges.filter((edge) => edge.target === routerId)).toHaveLength(4);
      expect(
        state.edges
          .filter((edge) => edge.target === routerId)
          .every((edge) => edge.targetHandle === "text")
      ).toBe(true);
    });

    it("does not reuse a non-router node referenced by corrupt router metadata", () => {
      const victim = { ...makeNode("victim-1", "output"), position: { x: 50, y: 75 } };
      useWorkflowStore.setState({
        nodes: [
          makeSplitGridNode({
            template: routerWiredTemplate(),
            routerNodeId: victim.id,
          }),
          victim,
        ],
        edges: [],
      });

      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const state = useWorkflowStore.getState();
      expect(state.nodes.find((node) => node.id === victim.id)).toMatchObject({
        type: "output",
        position: victim.position,
      });
      expect(getSplitData().routerNodeId).not.toBe(victim.id);
      expect(state.nodes.filter((node) => node.type === "router")).toHaveLength(1);
      expect(state.edges.some((edge) => edge.target === victim.id)).toBe(false);
    });

    it("does not delete a non-router node when corrupt router metadata is cleared", () => {
      const victim = makeNode("victim-1", "output");
      useWorkflowStore.setState({
        nodes: [
          makeSplitGridNode({
            template: createClassicSplitGridTemplate(),
            routerNodeId: victim.id,
          }),
          victim,
        ],
        edges: [],
      });

      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID, {
          force: true,
          template: createClassicSplitGridTemplate(),
        });
      });

      const state = useWorkflowStore.getState();
      expect(state.nodes.some((node) => node.id === victim.id && node.type === "output")).toBe(true);
      expect(getSplitData().routerNodeId).toBeNull();
    });

    it("removes the shared router and its edges when the port is unwired on re-apply", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;
      act(() => {
        useWorkflowStore.setState((s) => ({
          nodes: [...s.nodes, makeNode("out-1", "output")],
          edges: [
            ...s.edges,
            {
              id: "edge-router-out",
              source: routerId,
              sourceHandle: "image",
              target: "out-1",
              targetHandle: "image",
            },
          ],
        }));
      });

      // Re-apply with a port-less template (user disconnected the port)
      act(() => {
        useWorkflowStore
          .getState()
          .materializeSplitGridCells(SPLIT_ID, {
            force: true,
            template: createClassicSplitGridTemplate(),
          });
      });

      const state = useWorkflowStore.getState();
      expect(state.nodes.filter((n) => n.type === "router")).toHaveLength(0);
      expect(state.edges.some((e) => e.source === routerId || e.target === routerId)).toBe(false);
      expect(getSplitData().routerNodeId).toBeNull();
    });

    it("restores the pre-router state on a single undo", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(useWorkflowStore.getState().nodes.filter((n) => n.type === "router")).toHaveLength(1);

      act(() => {
        useWorkflowStore.getState().undo();
      });
      const state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe(SPLIT_ID);
      expect(state.nodes.filter((n) => n.type === "router")).toHaveLength(0);
      expect(getSplitData().routerNodeId ?? null).toBeNull();
    });

    it("remaps routerNodeId when the router is copied with the split node", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate(), gridRows: 1, gridCols: 1 })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const before = useWorkflowStore.getState();
      const split = before.nodes.find((n) => n.id === SPLIT_ID)!;
      const routerId = (split.data as SplitGridNodeData).routerNodeId!;
      const cellNodeIds = (split.data as SplitGridNodeData).cells!.flatMap((c) => c.nodeIds);
      const clipboardNodes = [
        split,
        ...before.nodes.filter((n) => cellNodeIds.includes(n.id) || n.id === routerId),
      ];

      act(() => {
        useWorkflowStore.setState({
          clipboard: { nodes: clipboardNodes, edges: before.edges },
        });
        useWorkflowStore.getState().pasteNodes({ x: 800, y: 0 });
      });

      const after = useWorkflowStore.getState();
      const pastedSplit = after.nodes.find((n) => n.type === "splitGrid" && n.id !== SPLIT_ID)!;
      const newRouterId = (pastedSplit.data as SplitGridNodeData).routerNodeId!;
      expect(newRouterId).toBeTruthy();
      expect(newRouterId).not.toBe(routerId); // its OWN router, not the original's
      expect(after.nodes.some((n) => n.id === newRouterId && n.type === "router")).toBe(true);
      expect(after.edges.some((e) => e.target === newRouterId)).toBe(true);
    });

    it("detaches routerNodeId when the split is pasted without its router", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate(), gridRows: 1, gridCols: 1 })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const before = useWorkflowStore.getState();
      const split = before.nodes.find((n) => n.id === SPLIT_ID)!;
      const routerId = (split.data as SplitGridNodeData).routerNodeId!;
      const cellNodeIds = (split.data as SplitGridNodeData).cells!.flatMap((c) => c.nodeIds);
      // Clipboard WITHOUT the router node (and without router edges)
      const clipboardNodes = [split, ...before.nodes.filter((n) => cellNodeIds.includes(n.id))];
      const clipboardEdges = before.edges.filter(
        (e) => e.source !== routerId && e.target !== routerId
      );

      act(() => {
        useWorkflowStore.setState({
          clipboard: { nodes: clipboardNodes, edges: clipboardEdges },
        });
        useWorkflowStore.getState().pasteNodes({ x: 800, y: 0 });
      });

      const after = useWorkflowStore.getState();
      const pastedSplit = after.nodes.find((n) => n.type === "splitGrid" && n.id !== SPLIT_ID)!;
      // Detached: the paste rebuilds its own cells + router on next split/apply
      expect((pastedSplit.data as SplitGridNodeData).routerNodeId ?? null).toBeNull();
      expect((pastedSplit.data as SplitGridNodeData).cells ?? []).toHaveLength(0);
    });

    it("nulls routerNodeId and rebuilds the router after it is manually deleted", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;

      // Delete the shared router on the canvas
      act(() => {
        useWorkflowStore.getState().onNodesChange([{ type: "remove" as const, id: routerId }]);
      });
      expect(getSplitData().routerNodeId ?? null).toBeNull(); // self-heal
      expect(useWorkflowStore.getState().nodes.filter((n) => n.type === "router")).toHaveLength(0);

      // On the next run/materialize the router is rebuilt (was previously stuck)
      let rebuilt = false;
      act(() => {
        rebuilt = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(rebuilt).toBe(true);
      const state = useWorkflowStore.getState();
      expect(state.nodes.filter((n) => n.type === "router")).toHaveLength(1);
      expect(getSplitData().routerNodeId).toBeTruthy();
      expect(state.edges.filter((e) => e.target === getSplitData().routerNodeId)).toHaveLength(4);
    });

    it("recreates the router on re-apply after a manual delete", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;
      act(() => {
        useWorkflowStore.getState().onNodesChange([{ type: "remove" as const, id: routerId }]);
      });
      expect(useWorkflowStore.getState().nodes.filter((n) => n.type === "router")).toHaveLength(0);

      // Re-apply the identical template (as the modal's Apply does)
      act(() => {
        useWorkflowStore
          .getState()
          .materializeSplitGridCells(SPLIT_ID, { force: true, template: routerWiredTemplate() });
      });
      expect(useWorkflowStore.getState().nodes.filter((n) => n.type === "router")).toHaveLength(1);
      expect(getSplitData().routerNodeId).toBeTruthy();
    });

    it("repositions a reused router to the right when the grid widens", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate(), gridRows: 2, gridCols: 2 })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;
      const beforeX = useWorkflowStore.getState().nodes.find((n) => n.id === routerId)!.position.x;

      // Widen 2x2 -> 2x3 (more columns extends the grid rightward)
      act(() => {
        useWorkflowStore.getState().updateNodeData(SPLIT_ID, { gridCols: 3 });
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const state = useWorkflowStore.getState();
      const router = state.nodes.find((n) => n.id === routerId)!;
      const cellRight = Math.max(
        ...state.nodes
          .filter((n) => n.groupId)
          .map((n) => n.position.x + ((n.style?.width as number) ?? 300))
      );
      expect(router.position.x).toBeGreaterThan(beforeX);
      expect(router.position.x).toBeGreaterThan(cellRight);
    });

    it("keeps a user-moved router position when the grid does not grow into it", () => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode({ template: routerWiredTemplate() })],
        edges: [],
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      const routerId = getSplitData().routerNodeId!;

      // User parks the router far to the right
      act(() => {
        useWorkflowStore.setState((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === routerId ? { ...n, position: { x: 5000, y: 1234 } } : n
          ),
        }));
      });

      // A rows-only resize does not extend the grid past x=5000
      act(() => {
        useWorkflowStore.getState().updateNodeData(SPLIT_ID, { gridRows: 3 });
      });
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const router = useWorkflowStore.getState().nodes.find((n) => n.id === routerId)!;
      expect(router.position).toEqual({ x: 5000, y: 1234 }); // preserved
    });
  });
});


describe("split cell content measurements", () => {
  beforeEach(resetStore);

  function materialize() {
    const template = createClassicSplitGridTemplate();
    template.nodes[0].size = { width: 300, height: 100 };
    template.nodes[1].position = { x: 0, y: 150 };
    template.nodes[1].size = { width: 300, height: 150 };
    template.nodes[2].position = { x: 450, y: 0 };
    template.nodes[2].size = { width: 300, height: 280 };
    useWorkflowStore.setState({
      nodes: [makeSplitGridNode({ template }), makeNode("unrelated", "prompt")],
      edges: [],
    });
    useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
    return getSplitData().cells!;
  }

  it("lets real node shells measure their full height instead of fixing editor heights", () => {
    const cells = materialize();
    for (const id of cells.flatMap((cell) => cell.nodeIds)) {
      const node = useWorkflowStore.getState().nodes.find((n) => n.id === id)!;
      expect(node.style?.height).toBeUndefined();
      expect(node.height).toBeUndefined();
      expect(node.measured?.height).toBeGreaterThan(0);
    }
  });

  it("preserves gaps when a slice grows, encloses controls, and moves the next row", () => {
    const cells = materialize();
    const before = useWorkflowStore.getState();
    const [imageId, promptId, generateId] = cells[0].nodeIds;
    const image = before.nodes.find((n) => n.id === imageId)!;
    const prompt = before.nodes.find((n) => n.id === promptId)!;
    const oldGap = prompt.position.y - image.position.y - getNodeSize(image).height;
    const oldGroup = before.groups[cells[0].groupId!];
    const oldNextGroup = before.groups[cells[2].groupId!];
    const oldRowGap = oldNextGroup.position.y - oldGroup.position.y - oldGroup.size.height;
    useWorkflowStore.getState().onNodesChange([
      { id: imageId, type: "dimensions", dimensions: { width: 300, height: 240 } },
      { id: promptId, type: "dimensions", dimensions: { width: 300, height: 208 } },
      { id: generateId, type: "dimensions", dimensions: { width: 300, height: 440 } },
    ]);
    const after = useWorkflowStore.getState();
    const nextPrompt = after.nodes.find((n) => n.id === promptId)!;
    expect(nextPrompt.position.y - image.position.y - 240).toBe(oldGap);
    expect(nextPrompt.position.x).toBe(prompt.position.x);
    const group = after.groups[cells[0].groupId!];
    for (const id of cells[0].nodeIds) {
      const node = after.nodes.find((n) => n.id === id)!;
      expect(node.position.y + getNodeSize(node).height).toBeLessThanOrEqual(group.position.y + group.size.height - 20);
    }
    const nextGroup = after.groups[cells[2].groupId!];
    expect(nextGroup.position.y - group.position.y - group.size.height).toBe(oldRowGap);
    for (const id of cells[2].nodeIds) {
      const previous = before.nodes.find((n) => n.id === id)!;
      const next = after.nodes.find((n) => n.id === id)!;
      expect(next.position.y - previous.position.y).toBe(nextGroup.position.y - oldNextGroup.position.y);
    }
    expect(after.nodes.find((n) => n.id === "unrelated")).toBe(before.nodes.find((n) => n.id === "unrelated"));
    expect(after.edges).toBe(before.edges);
    expect(after.groups[cells[1].groupId!]).toBe(before.groups[cells[1].groupId!]);

    // Repeated observer notifications must not keep pushing the layout down.
    useWorkflowStore.getState().onNodesChange([
      { id: imageId, type: "dimensions", dimensions: { width: 300, height: 240 } },
    ]);
    expect(useWorkflowStore.getState().nodes.map((n) => n.position)).toEqual(after.nodes.map((n) => n.position));
    expect(useWorkflowStore.getState().groups).toEqual(after.groups);
  });

  it("restores spacing when a loading image settles to a shorter slice", () => {
    const cells = materialize();
    const [imageId, promptId] = cells[0].nodeIds;
    const before = useWorkflowStore.getState();
    const promptY = before.nodes.find((node) => node.id === promptId)!.position.y;
    const measure = (height: number) => useWorkflowStore.getState().onNodesChange([
      { id: imageId, type: "dimensions", dimensions: { width: 300, height } },
    ]);
    measure(300);
    expect(useWorkflowStore.getState().nodes.find((node) => node.id === promptId)!.position.y).toBe(promptY + 200);
    measure(100);
    expect(useWorkflowStore.getState().nodes.map((node) => node.position)).toEqual(before.nodes.map((node) => node.position));
    expect(useWorkflowStore.getState().groups).toEqual(before.groups);
  });

  it("leaves deliberate node dragging alone", () => {
    const cells = materialize();
    const promptId = cells[0].nodeIds[1];
    const groups = useWorkflowStore.getState().groups;
    useWorkflowStore.getState().onNodesChange([
      { id: promptId, type: "position", position: { x: 500, y: 10 } },
    ]);
    expect(useWorkflowStore.getState().nodes.find((n) => n.id === promptId)!.position).toEqual({ x: 500, y: 10 });
    expect(useWorkflowStore.getState().groups).toBe(groups);
  });
});
