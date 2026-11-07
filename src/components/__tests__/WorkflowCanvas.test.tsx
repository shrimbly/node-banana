import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";
import { ReactFlowProvider } from "@xyflow/react";

// Mock the workflow store
const mockSetWorkflowState = vi.hoisted(() => vi.fn());
const mockOnNodesChange = vi.fn();
const mockOnEdgesChange = vi.fn();
const mockOnConnect = vi.fn();
const mockAddNode = vi.fn().mockReturnValue("new-node-id");
const mockUpdateNodeData = vi.fn();
const mockLoadWorkflow = vi.fn();
const mockGetNodeById = vi.fn();
const mockAddToGlobalHistory = vi.fn();
const mockSetNodeGroupId = vi.fn();
const mockRunBatch = vi.fn();
const mockCopySelectedNodes = vi.fn();
const mockPasteNodes = vi.fn();
const mockClearClipboard = vi.fn();
const mockSetShowQuickstart = vi.fn();
const mockSetHoveredNodeId = vi.fn();
const mockUseWorkflowStore = vi.fn();
const mockViewport = vi.hoisted(() => ({ zoom: 1 }));
const mockReactFlowProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("@/store/workflowStore", () => {
  const useWorkflowStore = (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  };
  // Handlers that run outside render read the store directly
  useWorkflowStore.setState = mockSetWorkflowState;
  useWorkflowStore.getState = () => mockUseWorkflowStore((s: unknown) => s);
  return { useWorkflowStore };
});

// Mock useReactFlow
const mockUpdateNodeInternals = vi.fn();
const mockScreenToFlowPosition = vi.fn((pos) => pos);
const mockGetViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));
const mockZoomIn = vi.fn();
const mockZoomOut = vi.fn();
const mockSetViewport = vi.fn();
const mockSetNodes = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      mockReactFlowProps.current = props;
      return React.createElement(actual.ReactFlow, props);
    },
    useStore: (selector: (state: { transform: [number, number, number]; nodeLookup: Map<string, unknown> }) => unknown) =>
      selector({ transform: [0, 0, mockViewport.zoom], nodeLookup: new Map() }),
    useUpdateNodeInternals: () => mockUpdateNodeInternals,
    useReactFlow: () => ({
      screenToFlowPosition: mockScreenToFlowPosition,
      getViewport: mockGetViewport,
      zoomIn: mockZoomIn,
      zoomOut: mockZoomOut,
      setViewport: mockSetViewport,
      setNodes: mockSetNodes,
    }),
  };
});

// The GPU canvas needs WebGL2, which jsdom lacks: stand in a React Flow that
// holds what WorkflowCanvas hands it (the navigator), and keep its props.
const mockGpuCanvasProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/components/gpuCanvas/GpuCanvas", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const { ReactFlow } = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    GpuCanvas: (props: { children?: React.ReactNode; flowChildren?: React.ReactNode }) => {
      mockGpuCanvasProps.current = props;
      return React.createElement(React.Fragment, null, React.createElement(ReactFlow, { nodes: [], edges: [] }, props.flowChildren), props.children);
    },
  };
});

// Mock the child components that aren't being tested
vi.mock("@/components/ConnectionDropMenu", () => ({
  ConnectionDropMenu: () => null,
}));

vi.mock("@/components/MultiSelectToolbar", () => ({
  MultiSelectToolbar: () => <div data-testid="multi-select-toolbar" />,
}));

vi.mock("@/components/GlobalImageHistory", () => ({
  GlobalImageHistory: () => null,
}));

// The agent button reads the page's agent session, which page.tsx mounts around the canvas.
vi.mock("@/components/agent/AgentSession", () => ({
  useAgentPresence: () => ({ busy: false, presence: { harness: "claude", harnessChosen: false, attention: false } }),
}));

vi.mock("@/components/GroupsOverlay", () => ({
  GroupControlsOverlay: () => null,
}));

vi.mock("@/components/quickstart", () => ({
  WelcomeModal: () => <div data-testid="welcome-modal" />,
}));

vi.mock("@/utils/gridSplitter", () => ({
  detectAndSplitGrid: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
  },
}));

// Create mock nodes for testing
const createMockNode = (id: string, type: string, overrides = {}) => ({
  id,
  type,
  position: { x: 100, y: 100 },
  data: {},
  selected: false,
  ...overrides,
});

// Default provider settings
const defaultProviderSettings = {
  providers: {
    gemini: { id: "gemini", name: "Gemini", enabled: true, apiKey: null, apiKeyEnvVar: "GEMINI_API_KEY" },
    openai: { id: "openai", name: "OpenAI", enabled: false, apiKey: null },
    replicate: { id: "replicate", name: "Replicate", enabled: false, apiKey: null },
    fal: { id: "fal", name: "fal.ai", enabled: true, apiKey: null },
    kie: { id: "kie", name: "Kie.ai", enabled: false, apiKey: null },
    wavespeed: { id: "wavespeed", name: "WaveSpeed", enabled: false, apiKey: null },
  },
};

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  nodes: [],
  edges: [],
  groups: {},
  onNodesChange: mockOnNodesChange,
  onEdgesChange: mockOnEdgesChange,
  onConnect: mockOnConnect,
  addNode: mockAddNode,
  updateNodeData: mockUpdateNodeData,
  loadWorkflow: mockLoadWorkflow,
  getNodeById: mockGetNodeById,
  addToGlobalHistory: mockAddToGlobalHistory,
  setNodeGroupId: mockSetNodeGroupId,
  runBatch: mockRunBatch,
  isModalOpen: false,
  showQuickstart: false,
  setShowQuickstart: mockSetShowQuickstart,
  setHoveredNodeId: mockSetHoveredNodeId,
  copySelectedNodes: mockCopySelectedNodes,
  pasteNodes: mockPasteNodes,
  clearClipboard: mockClearClipboard,
  clipboard: null,
  providerSettings: defaultProviderSettings,
  edgeStyle: "angular" as const,
  edgeAppearance: { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true },
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
});

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("WorkflowCanvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewport.zoom = 1;
    mockReactFlowProps.current = null;
    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Basic Rendering", () => {
    it("re-measures every node's handles after a workflow loads", async () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ nodes: [createMockNode("a", "prompt"), createMockNode("b", "nanoBanana")], workflowLoadCount: 1 }))
      );
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );
      await waitFor(() => expect(mockUpdateNodeInternals).toHaveBeenCalledWith(["a", "b"]));
    });

    it("leaves handle measurement alone until a workflow has loaded", async () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(mockUpdateNodeInternals).not.toHaveBeenCalled();
    });

    it("marks the canvas as overview mode below the edge visibility threshold", () => {
      mockViewport.zoom = 0.1;
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(document.querySelector(".bg-canvas-bg")).toHaveClass("canvas-overview");
    });

    it("mounts the navigator with its canvas controls", async () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(await screen.findByRole("button", { name: "Zoom in" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Fit view" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /lock canvas/i })).toBeInTheDocument();
    });

    it("should render MiniMap component", async () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // MiniMap should be rendered
      expect(await screen.findByRole("img", { name: "Mini Map" })).toBeInTheDocument();
    });

    it("allows the minimap to be hidden and restored", async () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.click(await screen.findByRole("button", { name: "Hide minimap" }));
      expect(screen.queryByRole("img", { name: "Mini Map" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show minimap" }));
      expect(screen.getByRole("img", { name: "Mini Map" })).toBeInTheDocument();
    });

    it("keeps the minimap inside the navigator card at its explicit size", async () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      const minimap = await screen.findByRole("img", { name: "Mini Map" });
      const navigator = screen.getByTestId("canvas-navigator");

      // Static, so it flows inside the card instead of pinning itself to the pane corner.
      // Width is the 238px navigator card minus its 1px borders and 6px minimap insets.
      expect(minimap).toHaveStyle({ width: "224px", height: "150px" });
      expect(navigator).toHaveStyle({ margin: "16px" });
      expect(navigator).toContainElement(screen.getByRole("button", { name: "Hide minimap" }));
    });

    it("should render MultiSelectToolbar component", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(screen.getByTestId("multi-select-toolbar")).toBeInTheDocument();
    });
  });

  describe("When the canvas cannot draw", () => {
    it("shows why in the canvas's place, and draws again when asked to", async () => {
      const { reportGpuCanvasFailure } = await import("@/lib/gpuCanvas/failure");
      vi.spyOn(console, "error").mockImplementation(() => {});
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );
      await screen.findByRole("button", { name: "Zoom in" });

      act(() => reportGpuCanvasFailure("WebGL2 is not available"));
      expect(screen.getByRole("alert")).toHaveTextContent("WebGL2 is not available.");
      expect(screen.queryByRole("button", { name: "Zoom in" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    });
  });

  describe("Welcome Modal", () => {
    it("should show welcome modal when canvas is empty and showQuickstart is true", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [],
          showQuickstart: true,
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(screen.getByTestId("welcome-modal")).toBeInTheDocument();
    });

    it("should not show welcome modal when canvas has nodes", () => {
      // When a workflow with nodes is loaded, the store sets showQuickstart to false.
      // The component renders the modal based solely on showQuickstart state.
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [createMockNode("node-1", "prompt")],
          showQuickstart: false,
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(screen.queryByTestId("welcome-modal")).not.toBeInTheDocument();
    });

    it("should not show welcome modal when showQuickstart is false", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [],
          showQuickstart: false,
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(screen.queryByTestId("welcome-modal")).not.toBeInTheDocument();
    });
  });

  describe("Drag and Drop", () => {
    it("should show drop overlay when dragging node type over canvas", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;

      // Simulate drag over with node type data
      const mockDataTransfer = {
        types: ["application/node-type"],
        items: [],
        dropEffect: "",
        effectAllowed: "",
        getData: vi.fn(),
      };

      fireEvent.dragOver(canvas, {
        dataTransfer: mockDataTransfer,
        preventDefault: vi.fn(),
      });

      // Should show "Drop to create node" indicator
      expect(screen.getByText("Drop to create node")).toBeInTheDocument();
    });

    it("should show drop overlay when dragging image over canvas", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;

      // Simulate drag over with image file
      const mockDataTransfer = {
        types: [],
        items: [{ kind: "file", type: "image/png" }],
        dropEffect: "",
        effectAllowed: "",
        getData: vi.fn(),
      };

      fireEvent.dragOver(canvas, {
        dataTransfer: mockDataTransfer,
        preventDefault: vi.fn(),
      });

      // Should show "Drop image to create node" indicator
      expect(screen.getByText("Drop image to create node")).toBeInTheDocument();
    });

    it("should show drop overlay when dragging workflow JSON over canvas", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;

      // Simulate drag over with JSON file
      const mockDataTransfer = {
        types: [],
        items: [{ kind: "file", type: "application/json" }],
        dropEffect: "",
        effectAllowed: "",
        getData: vi.fn(),
      };

      fireEvent.dragOver(canvas, {
        dataTransfer: mockDataTransfer,
        preventDefault: vi.fn(),
      });

      // Should show "Drop to load workflow" indicator
      expect(screen.getByText("Drop to load workflow")).toBeInTheDocument();
    });

    it("should hide drop overlay on drag leave", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;

      // First drag over
      const mockDataTransfer = {
        types: ["application/node-type"],
        items: [],
        dropEffect: "",
        effectAllowed: "",
        getData: vi.fn(),
      };

      fireEvent.dragOver(canvas, {
        dataTransfer: mockDataTransfer,
        preventDefault: vi.fn(),
      });

      expect(screen.getByText("Drop to create node")).toBeInTheDocument();

      // Then drag leave
      fireEvent.dragLeave(canvas, { preventDefault: vi.fn() });

      expect(screen.queryByText("Drop to create node")).not.toBeInTheDocument();
    });

    it("should call addNode when node type is dropped on canvas", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;

      const mockDataTransfer = {
        types: ["application/node-type"],
        items: [],
        files: [],
        dropEffect: "",
        effectAllowed: "",
        getData: vi.fn().mockReturnValue("prompt"),
      };

      fireEvent.drop(canvas, {
        dataTransfer: mockDataTransfer,
        preventDefault: vi.fn(),
        clientX: 500,
        clientY: 300,
      });

      expect(mockAddNode).toHaveBeenCalledWith("prompt", expect.any(Object));
    });

    // A recent-generations tile carries its kind; a video makes a Video Input node at the drop point
    const historyDrag = (kind: "image" | "video", image: string) => {
      const payload = JSON.stringify({ kind, image, prompt: "", timestamp: 1 });
      return {
        types: ["application/history-image", ...(kind === "video" ? ["application/history-video"] : [])],
        items: [],
        files: [],
        dropEffect: "",
        effectAllowed: "",
        getData: vi.fn((type: string) => (type === "application/history-image" ? payload : "")),
      };
    };

    it("says a dragged history video makes a video node", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );
      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;
      fireEvent.dragOver(canvas, { dataTransfer: historyDrag("video", "https://cdn.example/clip.mp4") });
      expect(screen.getByText("Drop video to create node")).toBeInTheDocument();
      fireEvent.dragOver(canvas, { dataTransfer: historyDrag("image", "data:image/png;base64,x") });
      expect(screen.getByText("Drop image to create node")).toBeInTheDocument();
    });

    it("makes a Video Input node where a history video is dropped, and an Image Input node for an image", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );
      const canvas = document.querySelector(".bg-canvas-bg") as HTMLElement;
      // jsdom's drop events carry no coordinates: the drop point is whatever the flow position comes to
      mockScreenToFlowPosition.mockReturnValueOnce({ x: 500, y: 300 });
      fireEvent.drop(canvas, { dataTransfer: historyDrag("video", "https://cdn.example/clip.mp4") });
      expect(mockAddNode).toHaveBeenCalledWith("videoInput", { x: 500, y: 300 }, {
        video: "https://cdn.example/clip.mp4",
        filename: expect.stringMatching(/^history-\d+\.mp4$/),
      });

      mockScreenToFlowPosition.mockReturnValueOnce({ x: 40, y: 60 });
      fireEvent.drop(canvas, { dataTransfer: historyDrag("image", "data:image/png;base64,x") });
      expect(mockAddNode).toHaveBeenCalledWith("imageInput", { x: 40, y: 60 }, {
        image: "data:image/png;base64,x",
        filename: expect.stringMatching(/^history-\d+\.png$/),
      });
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("runs the workflow on Ctrl+Enter", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

      expect(mockRunBatch).toHaveBeenCalledWith({ kind: "all" });
    });

    it("runs the workflow on Cmd+Enter", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "Enter", metaKey: true });

      expect(mockRunBatch).toHaveBeenCalledWith({ kind: "all" });
    });

    it("should call copySelectedNodes on Ctrl+C", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "c", ctrlKey: true });

      expect(mockCopySelectedNodes).toHaveBeenCalled();
    });

    it("should not copy when typing in input field", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
          <input data-testid="test-input" />
        </TestWrapper>
      );

      const input = screen.getByTestId("test-input");
      fireEvent.keyDown(input, { key: "c", ctrlKey: true });

      // Should not call copy when target is input
      expect(mockCopySelectedNodes).not.toHaveBeenCalled();
    });

    it("should add prompt node on Shift+P", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "p", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("prompt", expect.any(Object));
    });

    it("should add imageInput node on Shift+I", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "i", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("imageInput", expect.any(Object));
    });

    it("should add nanoBanana node on Shift+G", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "g", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("nanoBanana", expect.any(Object));
    });

    it("should add generate3d node on Shift+D", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "d", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("generate3d", expect.any(Object));
    });

    it("should add output node on Shift+O", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "o", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("output", expect.any(Object));
    });

    it("should add llmGenerate node on Shift+L", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "l", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("llmGenerate", expect.any(Object));
    });

    it("should add annotation node on Shift+A", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "a", shiftKey: true });

      expect(mockAddNode).toHaveBeenCalledWith("annotation", expect.any(Object));
    });
  });

  describe("Clipboard Paste", () => {
    // Helper to mock clipboard with image data
    const mockClipboardWithImage = () => {
      const mockBlob = new Blob(["fake-image-data"], { type: "image/png" });
      const mockClipboardItem = {
        types: ["image/png"],
        getType: vi.fn().mockResolvedValue(mockBlob),
      };
      const mockRead = vi.fn().mockResolvedValue([mockClipboardItem]);
      Object.defineProperty(navigator, "clipboard", {
        value: { read: mockRead },
        configurable: true,
        writable: true,
      });
      return { mockRead, mockClipboardItem };
    };

    // Helper to mock FileReader
    const mockFileReader = (dataUrl: string) => {
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        result: string = dataUrl;
        readAsDataURL() {
          setTimeout(() => {
            this.onload?.({ target: { result: this.result } } as ProgressEvent<FileReader>);
          }, 0);
        }
      }
      global.FileReader = MockFileReader as unknown as typeof FileReader;
    };

    // Helper to mock Image
    const mockImage = (width: number, height: number) => {
      class MockImage {
        onload: (() => void) | null = null;
        width: number = width;
        height: number = height;
        private _src: string = "";
        get src() { return this._src; }
        set src(value: string) {
          this._src = value;
          setTimeout(() => {
            this.onload?.();
          }, 0);
        }
      }
      global.Image = MockImage as unknown as typeof Image;
    };

    it("should update selected imageInput node when pasting image from clipboard", async () => {
      mockClipboardWithImage();
      mockFileReader("data:image/png;base64,test123");
      mockImage(1024, 768);

      const selectedImageNode = createMockNode("image-1", "imageInput", {
        selected: true,
        data: { image: null, filename: null, dimensions: null },
      });

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [selectedImageNode],
          clipboard: null,
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Trigger Ctrl+V
      fireEvent.keyDown(window, { key: "v", ctrlKey: true });

      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith(
          "image-1",
          expect.objectContaining({
            image: "data:image/png;base64,test123",
            filename: expect.stringContaining("pasted-"),
            dimensions: { width: 1024, height: 768 },
          })
        );
      });

      // Should NOT create a new node
      expect(mockAddNode).not.toHaveBeenCalled();
    });

    it("should create new imageInput node when pasting image with no selection", async () => {
      mockClipboardWithImage();
      mockFileReader("data:image/png;base64,newimage");
      mockImage(800, 600);

      // No nodes selected
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [],
          clipboard: null,
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Trigger Ctrl+V
      fireEvent.keyDown(window, { key: "v", ctrlKey: true });

      await waitFor(() => {
        expect(mockAddNode).toHaveBeenCalledWith("imageInput", expect.any(Object));
      });

      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith(
          "new-node-id",
          expect.objectContaining({
            image: "data:image/png;base64,newimage",
            dimensions: { width: 800, height: 600 },
          })
        );
      });
    });

    it("should create new imageInput node when pasting image with non-imageInput node selected", async () => {
      mockClipboardWithImage();
      mockFileReader("data:image/png;base64,anotherimage");
      mockImage(640, 480);

      // Prompt node selected (not imageInput)
      const selectedPromptNode = createMockNode("prompt-1", "prompt", {
        selected: true,
        data: { prompt: "test" },
      });

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [selectedPromptNode],
          clipboard: null,
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Trigger Ctrl+V
      fireEvent.keyDown(window, { key: "v", ctrlKey: true });

      await waitFor(() => {
        expect(mockAddNode).toHaveBeenCalledWith("imageInput", expect.any(Object));
      });

      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith(
          "new-node-id",
          expect.objectContaining({
            image: "data:image/png;base64,anotherimage",
            dimensions: { width: 640, height: 480 },
          })
        );
      });
    });

    it("should prioritize internal clipboard over system clipboard when nodes are copied", async () => {
      mockClipboardWithImage();
      mockFileReader("data:image/png;base64,ignored");
      mockImage(100, 100);

      // Internal clipboard has nodes
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [],
          clipboard: {
            nodes: [createMockNode("copied-1", "prompt")],
            edges: [],
          },
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Trigger Ctrl+V
      fireEvent.keyDown(window, { key: "v", ctrlKey: true });

      // Should paste internal clipboard nodes, not system clipboard image
      expect(mockPasteNodes).toHaveBeenCalled();
      expect(mockClearClipboard).toHaveBeenCalled();

      // Should NOT update or add nodes from system clipboard
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
      expect(mockAddNode).not.toHaveBeenCalled();
    });
  });
});
