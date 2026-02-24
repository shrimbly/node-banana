import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";

vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
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

const { useWorkflowStore } = await import("../workflowStore");

describe("workflowStore undo/redo", () => {
  beforeEach(() => {
    const store = useWorkflowStore.getState();
    act(() => {
      store.clearWorkflow();
      store.clearUndoRedoHistory();
    });
    vi.clearAllMocks();
  });

  it("restores deleted nodes and related edges on undo", () => {
    const store = useWorkflowStore.getState();

    let promptId = "";
    let genId = "";
    act(() => {
      promptId = store.addNode("prompt", { x: 0, y: 0 });
      genId = store.addNode("nanoBanana", { x: 200, y: 0 });
      store.onConnect({
        source: promptId,
        sourceHandle: "text",
        target: genId,
        targetHandle: "text",
      });
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(true);
    expect(useWorkflowStore.getState().edges.length).toBe(1);

    act(() => {
      store.removeNode(promptId);
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(false);
    expect(useWorkflowStore.getState().edges.length).toBe(0);

    act(() => {
      store.undo();
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(true);
    expect(useWorkflowStore.getState().edges.length).toBe(1);
  });

  it("undoes and redoes node data content changes", () => {
    const store = useWorkflowStore.getState();

    let promptId = "";
    act(() => {
      promptId = store.addNode("prompt", { x: 0, y: 0 });
      store.updateNodeData(promptId, { prompt: "first prompt" });
      store.updateNodeData(promptId, { prompt: "second prompt" });
    });

    const readPrompt = () =>
      (useWorkflowStore.getState().nodes.find((n) => n.id === promptId)?.data as { prompt?: string } | undefined)?.prompt;

    expect(readPrompt()).toBe("second prompt");

    act(() => {
      store.undo();
    });
    expect(readPrompt()).toBe("first prompt");

    act(() => {
      store.redo();
    });
    expect(readPrompt()).toBe("second prompt");
  });

  it("tracks canUndo/canRedo state", () => {
    const store = useWorkflowStore.getState();

    expect(useWorkflowStore.getState().canUndo).toBe(false);
    expect(useWorkflowStore.getState().canRedo).toBe(false);

    let promptId = "";
    act(() => {
      promptId = store.addNode("prompt", { x: 0, y: 0 });
      store.updateNodeData(promptId, { prompt: "hello" });
    });

    expect(useWorkflowStore.getState().canUndo).toBe(true);

    act(() => {
      store.undo();
    });

    expect(useWorkflowStore.getState().canRedo).toBe(true);
  });

  it("preserves node-delete wire state across undo and redo", () => {
    const store = useWorkflowStore.getState();

    let promptId = "";
    let genId = "";
    let edgeId = "";

    act(() => {
      promptId = store.addNode("prompt", { x: 0, y: 0 });
      genId = store.addNode("nanoBanana", { x: 200, y: 0 });
      store.onConnect({
        source: promptId,
        sourceHandle: "text",
        target: genId,
        targetHandle: "text",
      });
      edgeId = useWorkflowStore.getState().edges[0].id;
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(true);
    expect(useWorkflowStore.getState().edges.some((e) => e.id === edgeId)).toBe(true);

    // Simulate canvas-level delete transaction snapshot + React Flow delete sequence.
    act(() => {
      store._pushHistorySnapshot();
      store.onNodesChange([{ type: "remove", id: promptId }]);
      store.onEdgesChange([{ type: "remove", id: edgeId }]);
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(false);
    expect(useWorkflowStore.getState().edges.some((e) => e.id === edgeId)).toBe(false);

    act(() => {
      store.undo();
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(true);
    expect(useWorkflowStore.getState().edges.some((e) => e.id === edgeId)).toBe(true);

    act(() => {
      store.redo();
    });

    expect(useWorkflowStore.getState().nodes.some((n) => n.id === promptId)).toBe(false);
    expect(useWorkflowStore.getState().edges.some((e) => e.id === edgeId)).toBe(false);
  });

  it("duplicates selected nodes with data context and internal wires", () => {
    const store = useWorkflowStore.getState();

    let promptId = "";
    let genId = "";
    act(() => {
      promptId = store.addNode("prompt", { x: 10, y: 20 });
      genId = store.addNode("nanoBanana", { x: 280, y: 20 });
      store.updateNodeData(promptId, { prompt: "keep this context" });
      store.onConnect({
        source: promptId,
        sourceHandle: "text",
        target: genId,
        targetHandle: "text",
      });
    });

    act(() => {
      store.onNodesChange([
        { type: "select", id: promptId, selected: true },
        { type: "select", id: genId, selected: true },
      ]);
      store.duplicateSelectedNodes();
    });

    const state = useWorkflowStore.getState();
    expect(state.nodes.length).toBe(4);
    expect(state.edges.length).toBe(2);

    const duplicatedNodes = state.nodes.filter((n) => n.selected);
    expect(duplicatedNodes.length).toBe(2);

    const duplicatedPrompt = duplicatedNodes.find((n) => n.type === "prompt");
    expect(duplicatedPrompt).toBeTruthy();
    expect((duplicatedPrompt?.data as { prompt?: string })?.prompt).toBe("keep this context");
  });

  it("duplicates full selected groups as new groups", () => {
    const store = useWorkflowStore.getState();

    let nodeA = "";
    let nodeB = "";
    let groupId = "";
    act(() => {
      nodeA = store.addNode("prompt", { x: 0, y: 0 });
      nodeB = store.addNode("nanoBanana", { x: 220, y: 0 });
      groupId = store.createGroup([nodeA, nodeB]);
      store.onNodesChange([
        { type: "select", id: nodeA, selected: true },
        { type: "select", id: nodeB, selected: true },
      ]);
      store.duplicateSelectedNodes();
    });

    const state = useWorkflowStore.getState();
    const allGroupIds = Object.keys(state.groups);
    expect(allGroupIds.length).toBe(2);

    const duplicatedSelected = state.nodes.filter((n) => n.selected);
    expect(duplicatedSelected.length).toBe(2);
    const duplicatedGroupIds = new Set(duplicatedSelected.map((n) => n.groupId));
    expect(duplicatedGroupIds.size).toBe(1);

    const [newGroupId] = Array.from(duplicatedGroupIds);
    expect(newGroupId).toBeTruthy();
    expect(newGroupId).not.toBe(groupId);
    expect(state.groups[newGroupId as string]?.name).toContain("Copy");
  });

  it("duplicates selected group when only group header is selected", () => {
    const store = useWorkflowStore.getState();

    let nodeA = "";
    let nodeB = "";
    let groupId = "";
    act(() => {
      nodeA = store.addNode("prompt", { x: 0, y: 0 });
      nodeB = store.addNode("nanoBanana", { x: 220, y: 0 });
      groupId = store.createGroup([nodeA, nodeB]);
      store.setSelectedGroupId(groupId);
      store.duplicateSelectedNodes({ selectedGroupId: groupId });
    });

    const state = useWorkflowStore.getState();
    expect(Object.keys(state.groups)).toHaveLength(2);
    expect(state.selectedGroupId).not.toBe(groupId);

    const duplicatedNodes = state.nodes.filter((n) => n.selected);
    expect(duplicatedNodes).toHaveLength(2);
    const duplicatedGroupId = duplicatedNodes[0]?.groupId;
    expect(duplicatedGroupId).toBeTruthy();
    expect(duplicatedNodes.every((n) => n.groupId === duplicatedGroupId)).toBe(true);
  });

  it("places duplicated group in a non-overlapping location", () => {
    const store = useWorkflowStore.getState();

    let nodeA = "";
    let nodeB = "";
    let groupId = "";
    act(() => {
      nodeA = store.addNode("prompt", { x: 40, y: 80 });
      nodeB = store.addNode("nanoBanana", { x: 360, y: 80 });
      groupId = store.createGroup([nodeA, nodeB]);
      store.setSelectedGroupId(groupId);
      store.duplicateSelectedNodes({ selectedGroupId: groupId, offset: { x: 0, y: 0 } });
    });

    const state = useWorkflowStore.getState();
    const originalGroup = state.groups[groupId];
    const duplicateGroupId = Object.keys(state.groups).find((id) => id !== groupId) as string;
    const duplicatedGroup = state.groups[duplicateGroupId];

    expect(duplicatedGroup).toBeTruthy();
    const overlaps = !(
      originalGroup.position.x + originalGroup.size.width <= duplicatedGroup.position.x ||
      duplicatedGroup.position.x + duplicatedGroup.size.width <= originalGroup.position.x ||
      originalGroup.position.y + originalGroup.size.height <= duplicatedGroup.position.y ||
      duplicatedGroup.position.y + duplicatedGroup.size.height <= originalGroup.position.y
    );
    expect(overlaps).toBe(false);
  });

  it("deletes selected group with all contained nodes and edges", () => {
    const store = useWorkflowStore.getState();
    let nodeA = "";
    let nodeB = "";
    let groupId = "";

    act(() => {
      nodeA = store.addNode("prompt", { x: 0, y: 0 });
      nodeB = store.addNode("nanoBanana", { x: 220, y: 0 });
      store.onConnect({
        source: nodeA,
        sourceHandle: "text",
        target: nodeB,
        targetHandle: "text",
      });
      groupId = store.createGroup([nodeA, nodeB]);
      store.setSelectedGroupId(groupId);
      store.deleteGroupWithNodes(groupId);
    });

    const state = useWorkflowStore.getState();
    expect(state.groups[groupId]).toBeUndefined();
    expect(state.nodes.some((n) => n.id === nodeA)).toBe(false);
    expect(state.nodes.some((n) => n.id === nodeB)).toBe(false);
    expect(state.edges.length).toBe(0);
    expect(state.selectedGroupId).toBeNull();
  });

  it("does not create undo steps for output gallery image accumulation", () => {
    const store = useWorkflowStore.getState();
    let galleryId = "";

    act(() => {
      galleryId = store.addNode("outputGallery", { x: 0, y: 0 });
      store.clearUndoRedoHistory();
      store.updateNodeData(galleryId, {
        images: ["img-1", "img-2"],
      } as never);
    });

    expect(useWorkflowStore.getState().canUndo).toBe(false);
    expect(useWorkflowStore.getState().undoHistory.length).toBe(0);
  });
});
