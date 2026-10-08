/**
 * "Split Grid Now" from a generator's output: the cells become image nodes,
 * and they are recorded in the asset library only once they are on the
 * canvas, holding their images, so the run's final graph shows them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";

const mocks = vi.hoisted(() => ({
  useWorkflowStore: vi.fn(),
  reactFlowProps: { current: null as Record<string, unknown> | null },
  dropMenuProps: { current: null as Record<string, unknown> | null },
  detectAndSplitGrid: vi.fn(),
}));

vi.mock("@/store/workflowStore", () => {
  const useWorkflowStore = (selector?: (state: unknown) => unknown) =>
    mocks.useWorkflowStore(selector ?? ((s: unknown) => s));
  useWorkflowStore.setState = vi.fn();
  useWorkflowStore.getState = () => mocks.useWorkflowStore((s: unknown) => s);
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
      screenToFlowPosition: (pos: { x: number; y: number }) => pos,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setViewport: vi.fn(),
    }),
  };
});

vi.mock("@/components/ConnectionDropMenu", () => ({
  ConnectionDropMenu: (props: Record<string, unknown>) => {
    mocks.dropMenuProps.current = props;
    return null;
  },
}));
vi.mock("@/components/MultiSelectToolbar", () => ({ MultiSelectToolbar: () => null }));
vi.mock("@/components/GlobalImageHistory", () => ({ GlobalImageHistory: () => null }));
// The agent button reads the page's agent session, which page.tsx mounts around the canvas.
vi.mock("@/components/agent/AgentSession", () => ({
  useAgentPresence: () => ({ busy: false, presence: { harness: "claude", harnessChosen: false, attention: false } }),
}));
vi.mock("@/components/GroupsOverlay", () => ({ GroupBackgroundsPortal: () => null, GroupControlsOverlay: () => null }));
vi.mock("@/components/quickstart", () => ({ WelcomeModal: () => null }));
vi.mock("@/utils/gridSplitter", () => ({ detectAndSplitGrid: mocks.detectAndSplitGrid }));
vi.mock("@/utils/logger", () => ({ logger: { log: vi.fn(), error: vi.fn() } }));

const source = {
  id: "gen-1",
  type: "nanoBanana",
  position: { x: 0, y: 0 },
  data: { outputImage: "data:image/png;base64,grid", aspectRatio: "1:1", model: "nano-banana" },
  selected: false,
};

/** The canvas as the store holds it: nodes added by addNode land here. */
let canvas: Array<{ id: string; type: string; data: Record<string, unknown> }>;
const addNode = vi.fn((type: string, _position: unknown, data: Record<string, unknown> = {}) => {
  const id = `${type}-${canvas.length + 1}`;
  canvas.push({ id, type, data: { ...data } });
  return id;
});
const updateNodeData = vi.fn((id: string, data: Record<string, unknown>) => {
  const node = canvas.find((n) => n.id === id);
  if (node) node.data = { ...node.data, ...data };
});
/** What the recorder would snapshot: the canvas at the moment of the call. */
let recordedWith: typeof canvas | null;
const recordUiAsset = vi.fn(() => {
  recordedWith = canvas.map((n) => ({ ...n, data: { ...n.data } }));
  return [];
});

function state() {
  return {
    nodes: [],
    edges: [],
    groups: {},
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    addNode,
    updateNodeData,
    loadWorkflow: vi.fn(),
    getNodeById: (id: string) => (id === source.id ? source : undefined),
    addToGlobalHistory: vi.fn(),
    recordUiAsset,
    setNodeGroupId: vi.fn(),
    executeWorkflow: vi.fn(),
    isModalOpen: false,
    showQuickstart: false,
    setShowQuickstart: vi.fn(),
    setHoveredNodeId: vi.fn(),
    copySelectedNodes: vi.fn(),
    pasteNodes: vi.fn(),
    clearClipboard: vi.fn(),
    clipboard: null,
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
  };
}

class NeverLoadingImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  src = "";
}

describe("Split Grid Now", () => {
  const originalImage = global.Image;
  const originalElementsFromPoint = document.elementsFromPoint;

  beforeEach(() => {
    vi.clearAllMocks();
    canvas = [];
    recordedWith = null;
    mocks.useWorkflowStore.mockImplementation((selector: (s: unknown) => unknown) => selector(state()));
    // The cells' dimensions come later; what is recorded must not wait for them
    global.Image = NeverLoadingImage as unknown as typeof Image;
    document.elementsFromPoint = () => [];
    mocks.detectAndSplitGrid.mockResolvedValue({
      grid: { rows: 1, cols: 2 },
      images: ["data:image/png;base64,cell1", "data:image/png;base64,cell2"],
    });
  });

  afterEach(() => {
    global.Image = originalImage;
    document.elementsFromPoint = originalElementsFromPoint;
  });

  it("records the cells after their image nodes exist, holding their images", async () => {
    render(
      <ReactFlowProvider>
        <WorkflowCanvas />
      </ReactFlowProvider>
    );

    // Drag from the generator's output onto empty canvas, then pick "Split Grid Now"
    act(() => {
      (mocks.reactFlowProps.current!.onConnectEnd as (event: unknown, state: unknown) => void)(
        { clientX: 400, clientY: 300 },
        { isValid: false, fromNode: source, fromHandle: { id: "image", type: "source" } }
      );
    });
    await waitFor(() => expect(mocks.dropMenuProps.current).not.toBeNull());
    await act(async () => {
      (mocks.dropMenuProps.current!.onSelect as (selection: unknown) => void)({ type: "splitGridImmediate", isAction: true });
    });

    await waitFor(() => expect(recordUiAsset).toHaveBeenCalledOnce());
    expect(recordedWith).toEqual([
      { id: "imageInput-1", type: "imageInput", data: { image: "data:image/png;base64,cell1", filename: "split-1-1.png" } },
      { id: "imageInput-2", type: "imageInput", data: { image: "data:image/png;base64,cell2", filename: "split-1-2.png" } },
    ]);
    const inputs = (recordUiAsset.mock.calls[0] as unknown as [Array<Record<string, unknown>>])[0];
    expect(inputs.map((input) => input.media)).toEqual(["data:image/png;base64,cell1", "data:image/png;base64,cell2"]);
    expect(inputs[1].producer).toEqual({ nodeId: "gen-1", nodeType: "nanoBanana", operation: "splitToNodes", batchIndex: 1 });
  });
});
