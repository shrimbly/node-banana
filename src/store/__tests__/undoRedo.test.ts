/**
 * Tests for Undo/Redo functionality in workflowStore
 *
 * Tests the undo/redo system including:
 * - pushToUndoStack: captures workflow state snapshots
 * - undo: restores previous state
 * - redo: re-applies undone state
 * - clearHistory: resets undo/redo stacks
 * - canUndo/canRedo: state availability flags
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";

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

// Mock localStorage for provider settings
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

// Helper to reset store state between tests
function resetStore() {
  const store = useWorkflowStore.getState();
  store.clearWorkflow();
  store.clearHistory();
}

describe("Undo/Redo functionality", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  describe("Initial state", () => {
    it("should have empty undo/redo stacks initially", () => {
      const store = useWorkflowStore.getState();
      expect(store.canUndo).toBe(false);
      expect(store.canRedo).toBe(false);
    });
  });

  describe("pushToUndoStack", () => {
    it("should capture current state to undo stack", () => {
      const store = useWorkflowStore.getState();

      // Add a node
      store.addNode("prompt", { x: 100, y: 100 });

      // Push to undo stack
      store.pushToUndoStack();

      const updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canUndo).toBe(true);
    });

    it("should clear redo stack when new action is pushed", () => {
      const store = useWorkflowStore.getState();

      // Add a node and push
      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Add another node
      store.addNode("imageInput", { x: 200, y: 100 });
      store.pushToUndoStack();

      // Undo to create redo state
      store.undo();

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canRedo).toBe(true);

      // Push new action - should clear redo
      store.addNode("output", { x: 300, y: 100 });
      store.pushToUndoStack();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canRedo).toBe(false);
    });

    it("should capture nodes and edges", () => {
      const store = useWorkflowStore.getState();

      // Add nodes
      const nodeId1 = store.addNode("prompt", { x: 100, y: 100 });
      const nodeId2 = store.addNode("nanoBanana", { x: 300, y: 100 });

      // Connect them
      store.onConnect({
        source: nodeId1,
        target: nodeId2,
        sourceHandle: "text",
        targetHandle: "text",
      });

      // Push state (this saves current state with 2 nodes and 1 edge)
      store.pushToUndoStack();

      // Delete a node
      store.removeNode(nodeId2);

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(1);
      expect(updatedStore.edges.length).toBe(0);

      // Undo should restore the state we pushed (2 nodes, 1 edge)
      store.undo();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(2);
      expect(updatedStore.edges.length).toBe(1);
    });
  });

  describe("undo", () => {
    it("should do nothing when undo stack is empty", () => {
      const store = useWorkflowStore.getState();

      const nodesBefore = store.nodes.length;
      store.undo();

      const updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(nodesBefore);
    });

    it("should restore previous state", () => {
      const store = useWorkflowStore.getState();

      // Add first node and push (saves state with 1 node)
      const nodeId1 = store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Add second node
      store.addNode("imageInput", { x: 200, y: 100 });

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(2);

      // Undo should restore to state with 1 node (the state we pushed)
      store.undo();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(1);
      expect(updatedStore.nodes[0].id).toBe(nodeId1);
    });

    it("should enable redo after undo", () => {
      const store = useWorkflowStore.getState();

      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      expect(store.canRedo).toBe(false);

      store.undo();

      const updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canRedo).toBe(true);
    });

    it("should set hasUnsavedChanges to true", () => {
      const store = useWorkflowStore.getState();

      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Mark as saved
      useWorkflowStore.setState({ hasUnsavedChanges: false });

      store.undo();

      const updatedStore = useWorkflowStore.getState();
      expect(updatedStore.hasUnsavedChanges).toBe(true);
    });

    it("should support undo and redo cycle", () => {
      const store = useWorkflowStore.getState();

      // Add node and push
      const nodeId1 = store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Add second node
      store.addNode("imageInput", { x: 200, y: 100 });

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(2);

      // Undo, then redo
      store.undo();
      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(1);

      store.redo();
      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(2);

      // Undo again
      store.undo();
      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(1);
    });
  });

  describe("redo", () => {
    it("should do nothing when redo stack is empty", () => {
      const store = useWorkflowStore.getState();

      // Adding a node but NOT undoing means redo stack is empty
      store.addNode("prompt", { x: 100, y: 100 });

      // Get node count before redo attempt
      let updatedStore = useWorkflowStore.getState();
      const nodesBefore = updatedStore.nodes.length;

      // Redo should do nothing
      store.redo();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(nodesBefore);
      expect(updatedStore.canRedo).toBe(false);
    });

    it("should restore undone state", () => {
      const store = useWorkflowStore.getState();

      // Add 1 node and push
      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Add second node (current state has 2)
      store.addNode("imageInput", { x: 200, y: 100 });

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(2);

      // Undo (goes back to 1 node, saves 2-node state to redo)
      store.undo();
      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(1);

      // Redo should restore to 2 nodes
      store.redo();
      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes.length).toBe(2);
    });

    it("should enable undo after redo", () => {
      const store = useWorkflowStore.getState();

      // Add node and push
      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Add another node
      store.addNode("imageInput", { x: 200, y: 100 });

      // Undo
      store.undo();

      // Redo
      store.redo();

      const updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canUndo).toBe(true);
    });

    it("should set hasUnsavedChanges to true", () => {
      const store = useWorkflowStore.getState();

      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();
      store.addNode("imageInput", { x: 200, y: 200 });
      store.undo();

      // Mark as saved
      useWorkflowStore.setState({ hasUnsavedChanges: false });

      store.redo();

      const updatedStore = useWorkflowStore.getState();
      expect(updatedStore.hasUnsavedChanges).toBe(true);
    });
  });

  describe("clearHistory", () => {
    it("should clear both undo and redo stacks", () => {
      const store = useWorkflowStore.getState();

      // Build up some history
      store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      store.addNode("imageInput", { x: 200, y: 100 });
      store.undo();

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canUndo).toBe(true);
      expect(updatedStore.canRedo).toBe(true);

      // Clear history
      store.clearHistory();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.canUndo).toBe(false);
      expect(updatedStore.canRedo).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("should handle undo/redo of node position changes", () => {
      const store = useWorkflowStore.getState();

      const nodeId = store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack(); // Save state with position (100, 100)

      // Move the node
      store.onNodesChange([{
        type: "position",
        id: nodeId,
        position: { x: 200, y: 200 },
      }]);

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes[0].position.x).toBe(200);

      // Undo should restore original position
      store.undo();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.nodes[0].position.x).toBe(100);
    });

    it("should handle undo/redo of edge deletion", () => {
      const store = useWorkflowStore.getState();

      const nodeId1 = store.addNode("prompt", { x: 100, y: 100 });
      const nodeId2 = store.addNode("nanoBanana", { x: 300, y: 100 });

      store.onConnect({
        source: nodeId1,
        target: nodeId2,
        sourceHandle: "text",
        targetHandle: "text",
      });

      store.pushToUndoStack(); // Save state with edge

      let updatedStore = useWorkflowStore.getState();
      expect(updatedStore.edges.length).toBe(1);

      // Delete edge
      const edgeId = updatedStore.edges[0].id;
      store.removeEdge(edgeId);

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.edges.length).toBe(0);

      // Undo should restore edge
      store.undo();

      updatedStore = useWorkflowStore.getState();
      expect(updatedStore.edges.length).toBe(1);
    });

    it("should preserve deep clones (not references)", () => {
      const store = useWorkflowStore.getState();

      const nodeId = store.addNode("prompt", { x: 100, y: 100 });
      store.pushToUndoStack();

      // Get state snapshot
      const stateAfterPush = useWorkflowStore.getState();
      const nodesAfterPush = stateAfterPush.nodes;

      // Modify node data
      store.updateNodeData(nodeId, { prompt: "modified" });

      // Undo
      store.undo();

      const restoredStore = useWorkflowStore.getState();

      // The restored state should not be the same reference
      expect(restoredStore.nodes).not.toBe(nodesAfterPush);
    });
  });
});
