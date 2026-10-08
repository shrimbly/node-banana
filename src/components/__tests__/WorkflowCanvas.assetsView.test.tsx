import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";
import { AGENT_BUTTON_MARGIN } from "@/lib/agent/client/layout";
import { useAssetStore } from "@/store/assetStore";

/**
 * The canvas stays mounted (inert, invisible) under the Assets and chat
 * views, and its window-level key handler must not act on the hidden graph;
 * bare A and C are how it opens them. Rendered the
 * way WorkflowCanvas.test.tsx renders it, with the store mocked; the
 * Assets view's side of the contract (the modal count it holds) is
 * modelled by `isModalOpen`.
 */

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  reactFlowProps: { current: null as Record<string, unknown> | null },
  historyProps: { current: null as { rightInset?: number; anchorRight?: number } | null },
}));

const mockAddNode = vi.fn().mockReturnValue("new-node-id");
const mockExecuteWorkflow = vi.fn();
const mockCopySelectedNodes = vi.fn();
const mockPasteNodes = vi.fn();
const mockUndo = vi.fn();
const mockRedo = vi.fn();
const mockOnNodesChange = vi.fn();
const mockSetShortcutsDialogOpen = vi.fn();

vi.mock("@/store/workflowStore", () => {
  const useWorkflowStore = (selector?: (state: unknown) => unknown) => (selector ? selector(mocks.state) : mocks.state);
  useWorkflowStore.setState = vi.fn();
  useWorkflowStore.getState = () => mocks.state;
  return { useWorkflowStore };
});

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      mocks.reactFlowProps.current = props;
      return React.createElement(actual.ReactFlow, props);
    },
    useStore: (selector: (state: { transform: [number, number, number]; nodeLookup: Map<string, unknown> }) => unknown) =>
      selector({ transform: [0, 0, 1], nodeLookup: new Map() }),
    useUpdateNodeInternals: () => vi.fn(),
    useReactFlow: () => ({
      screenToFlowPosition: (pos: unknown) => pos,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setViewport: vi.fn(),
    }),
  };
});

vi.mock("@/components/ConnectionDropMenu", () => ({ ConnectionDropMenu: () => null }));
vi.mock("@/components/MultiSelectToolbar", () => ({ MultiSelectToolbar: () => null }));
vi.mock("@/components/GlobalImageHistory", () => ({
  GlobalImageHistory: (props: { rightInset?: number; anchorRight?: number }) => {
    mocks.historyProps.current = props;
    return null;
  },
}));
vi.mock("@/components/agent/AgentPanel", () => ({ AgentPanel: () => null }));
// The agent button reads the page's agent session, which page.tsx mounts around the canvas.
vi.mock("@/components/agent/AgentSession", () => ({
  useAgentPresence: () => ({ busy: false, presence: { harness: "claude", harnessChosen: false, attention: false } }),
}));
vi.mock("@/components/GroupsOverlay", () => ({ GroupBackgroundsPortal: () => null, GroupControlsOverlay: () => null }));
vi.mock("@/components/quickstart", () => ({ WelcomeModal: () => null }));
vi.mock("@/utils/logger", () => ({ logger: { log: vi.fn(), error: vi.fn() } }));

function state(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [{ id: "image-1", type: "imageInput", position: { x: 0, y: 0 }, data: {}, selected: true }],
    edges: [],
    groups: {},
    onNodesChange: mockOnNodesChange,
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    addNode: mockAddNode,
    updateNodeData: vi.fn(),
    loadWorkflow: vi.fn(),
    getNodeById: vi.fn(),
    addToGlobalHistory: vi.fn(),
    setNodeGroupId: vi.fn(),
    executeWorkflow: mockExecuteWorkflow,
    isModalOpen: false,
    showQuickstart: false,
    setShowQuickstart: vi.fn(),
    setHoveredNodeId: vi.fn(),
    copySelectedNodes: mockCopySelectedNodes,
    pasteNodes: mockPasteNodes,
    clearClipboard: vi.fn(),
    clipboard: { nodes: [{ id: "copied" }], edges: [] },
    undo: mockUndo,
    redo: mockRedo,
    setShortcutsDialogOpen: mockSetShortcutsDialogOpen,
    providerSettings: { providers: {} },
    edgeStyle: "angular",
    edgeAppearance: { thickness: "regular", fadedOpacity: 0.25, gradient: true, loadingPulse: true },
    currentNodeIds: [],
    navigationTarget: null,
    setNavigationTarget: vi.fn(),
    getNodesWithComments: vi.fn(() => []),
    markCommentViewed: vi.fn(),
    canvasNavigationSettings: { panMode: "space", zoomMode: "altScroll", selectionMode: "click" },
    dimmedNodeIds: new Set<string>(),
    skippedNodeIds: new Set<string>(),
    applyEditOperations: vi.fn(() => ({ applied: 0, skipped: [] })),
    setWorkflowMetadata: vi.fn(),
    ...overrides,
  };
}

const renderCanvas = () =>
  render(
    <ReactFlowProvider>
      <WorkflowCanvas />
    </ReactFlowProvider>,
  );

describe("WorkflowCanvas behind the Assets view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = state();
    useAssetStore.setState({ appView: "canvas" });
  });
  afterEach(() => {
    useAssetStore.setState({ appView: "canvas" });
  });

  it("ignores its shortcuts while Assets shows: paste, add node, run, copy, undo", () => {
    const read = vi.fn().mockResolvedValue([]);
    Object.defineProperty(navigator, "clipboard", { value: { read }, configurable: true, writable: true });
    // As page.tsx does: Assets shows, and the modal count is held
    mocks.state = state({ isModalOpen: true });
    useAssetStore.setState({ appView: "assets" });
    renderCanvas();

    fireEvent.keyDown(window, { key: "v", metaKey: true });
    fireEvent.keyDown(window, { key: "g", shiftKey: true });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    fireEvent.keyDown(window, { key: "?" });

    expect(mockPasteNodes).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(mockAddNode).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockCopySelectedNodes).not.toHaveBeenCalled();
    expect(mockUndo).not.toHaveBeenCalled();
    expect(mockSetShortcutsDialogOpen).not.toHaveBeenCalled();
  });

  it("leaves Delete to nothing: React Flow's delete key is off while the view holds the modal count", () => {
    mocks.state = state({ isModalOpen: true });
    useAssetStore.setState({ appView: "assets" });
    renderCanvas();
    expect(mocks.reactFlowProps.current!.deleteKeyCode).toBeNull();
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(mockOnNodesChange).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: "remove" })]));
  });

  it("acts on the same keys again once the canvas is back", () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: "v", metaKey: true });
    fireEvent.keyDown(window, { key: "g", shiftKey: true });
    expect(mockPasteNodes).toHaveBeenCalled();
    expect(mockAddNode).toHaveBeenCalledWith("nanoBanana", expect.any(Object));
  });

  it("shows Assets on a bare A, but not with Shift (that adds an annotation) or over a dialog", () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: "a", shiftKey: true });
    expect(useAssetStore.getState().appView).toBe("canvas");
    expect(mockAddNode).toHaveBeenCalledWith("annotation", expect.any(Object));

    fireEvent.keyDown(window, { key: "a" });
    expect(useAssetStore.getState().appView).toBe("assets");
  });

  it("does not switch views while a menu or dropdown is open over the canvas", () => {
    renderCanvas();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    try {
      fireEvent.keyDown(window, { key: "a" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    } finally {
      menu.remove();
    }
    fireEvent.keyDown(window, { key: "a" });
    expect(useAssetStore.getState().appView).toBe("assets");
  });

  it("does not switch views while the connection-drop menu is open, whose Enter would add a node unseen", () => {
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [];
    try {
      renderCanvas();
      const onConnectEnd = mocks.reactFlowProps.current!.onConnectEnd as (event: unknown, state: unknown) => void;
      act(() =>
        onConnectEnd(
          { clientX: 300, clientY: 200 },
          { isValid: false, fromNode: { id: "image-1", type: "imageInput", data: {} }, fromHandle: { id: "image", type: "source" } },
        ),
      );
      fireEvent.keyDown(window, { key: "a" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    } finally {
      document.elementsFromPoint = elementsFromPoint;
    }
  });

  it("does not switch views while a dialog holds the canvas", () => {
    mocks.state = state({ isModalOpen: true });
    renderCanvas();
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "c" });
    expect(useAssetStore.getState().appView).toBe("canvas");
  });
});

describe("WorkflowCanvas and the chat view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = state();
    useAssetStore.setState({ appView: "canvas" });
  });
  afterEach(() => {
    useAssetStore.setState({ appView: "canvas" });
  });

  it("shows the chat on a bare C, leaving Shift+C to add a ComfyUI node and Cmd+C to copy", () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: "C", shiftKey: true });
    expect(mockAddNode).toHaveBeenCalledWith("comfyApp", expect.any(Object));
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    expect(mockCopySelectedNodes).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "c", altKey: true });
    fireEvent.keyDown(window, { key: "c", repeat: true });
    expect(useAssetStore.getState().appView).toBe("canvas");

    fireEvent.keyDown(window, { key: "c" });
    expect(useAssetStore.getState().appView).toBe("chat");
  });

  it("leaves C to a text field being typed in", () => {
    renderCanvas();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    try {
      field.focus();
      fireEvent.keyDown(field, { key: "c" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    } finally {
      field.remove();
    }
  });

  it("does not switch views while a menu is open or from inside a dialog such as the agent window", () => {
    renderCanvas();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    try {
      fireEvent.keyDown(window, { key: "c" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    } finally {
      menu.remove();
    }
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(button, { key: "c" });
      expect(useAssetStore.getState().appView).toBe("canvas");
    } finally {
      dialog.remove();
    }
  });

  it("ignores its keys while the chat shows: C, A and the rest do nothing to the hidden graph", () => {
    mocks.state = state({ isModalOpen: true });
    useAssetStore.setState({ appView: "chat" });
    renderCanvas();
    fireEvent.keyDown(window, { key: "c" });
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "g", shiftKey: true });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "?" });
    expect(useAssetStore.getState().appView).toBe("chat");
    expect(mockAddNode).not.toHaveBeenCalled();
    expect(mockCopySelectedNodes).not.toHaveBeenCalled();
    expect(mockSetShortcutsDialogOpen).not.toHaveBeenCalled();
  });

  it("puts notifications back in the corner while the chat hides the agent window", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    const windowEdge = mocks.historyProps.current?.anchorRight;
    expect(windowEdge).toBeGreaterThan(AGENT_BUTTON_MARGIN);

    act(() => useAssetStore.getState().setAppView("chat"));
    expect(mocks.historyProps.current?.anchorRight).toBe(AGENT_BUTTON_MARGIN);

    act(() => useAssetStore.getState().setAppView("canvas"));
    expect(mocks.historyProps.current?.anchorRight).toBe(windowEdge);
  });
});
