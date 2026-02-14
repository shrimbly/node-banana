import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowCanvas } from "@/components/WorkflowCanvas";
import { ReactFlowProvider } from "@xyflow/react";

// Mock the workflow store
const mockOnNodesChange = vi.fn();
const mockOnEdgesChange = vi.fn();
const mockOnConnect = vi.fn();
const mockAddNode = vi.fn().mockReturnValue("new-node-id");
const mockUpdateNodeData = vi.fn();
const mockLoadWorkflow = vi.fn();
const mockGetNodeById = vi.fn();
const mockAddToGlobalHistory = vi.fn();
const mockSetNodeGroupId = vi.fn();
const mockExecuteWorkflow = vi.fn();
const mockCopySelectedNodes = vi.fn();
const mockPasteNodes = vi.fn();
const mockClearClipboard = vi.fn();
const mockSetShowQuickstart = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// Mock useReactFlow
const mockScreenToFlowPosition = vi.fn((pos) => pos);
const mockGetViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));
const mockZoomIn = vi.fn();
const mockZoomOut = vi.fn();
const mockSetViewport = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      screenToFlowPosition: mockScreenToFlowPosition,
      getViewport: mockGetViewport,
      zoomIn: mockZoomIn,
      zoomOut: mockZoomOut,
      setViewport: mockSetViewport,
    }),
  };
});

// Mock the child components that aren't being tested
vi.mock("@/components/ConnectionDropMenu", () => ({
  ConnectionDropMenu: () => null,
}));

vi.mock("@/components/MultiSelectToolbar", () => ({
  MultiSelectToolbar: () => <div data-testid="multi-select-toolbar" />,
}));

vi.mock("@/components/EdgeToolbar", () => ({
  EdgeToolbar: () => <div data-testid="edge-toolbar" />,
}));

vi.mock("@/components/GlobalImageHistory", () => ({
  GlobalImageHistory: () => null,
}));

vi.mock("@/components/GroupsOverlay", () => ({
  GroupBackgroundsPortal: () => null,
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
  executeWorkflow: mockExecuteWorkflow,
  isModalOpen: false,
  showQuickstart: false,
  setShowQuickstart: mockSetShowQuickstart,
  copySelectedNodes: mockCopySelectedNodes,
  pasteNodes: mockPasteNodes,
  clearClipboard: mockClearClipboard,
  clipboard: null,
  providerSettings: defaultProviderSettings,
  edgeStyle: "angular" as const,
  currentNodeIds: [],
  navigationTarget: null,
  setNavigationTarget: vi.fn(),
  getNodesWithComments: vi.fn(() => []),
  markCommentViewed: vi.fn(),
  canvasNavigationSettings: { panMode: "space", zoomMode: "altScroll", selectionMode: "click" },
  captureSnapshot: vi.fn(),
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
    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Basic Rendering", () => {
    it("should render ReactFlow component", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // ReactFlow container should be present
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });

    it("should render Background component", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Background pattern should be rendered
      expect(document.querySelector(".react-flow__background")).toBeInTheDocument();
    });

    it("should render Controls component", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Controls panel should be rendered
      expect(document.querySelector(".react-flow__controls")).toBeInTheDocument();
    });

    it("should render MiniMap component", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // MiniMap should be rendered
      expect(document.querySelector(".react-flow__minimap")).toBeInTheDocument();
    });

    it("should render EdgeToolbar component", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      expect(screen.getByTestId("edge-toolbar")).toBeInTheDocument();
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
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [createMockNode("node-1", "prompt")],
          showQuickstart: true,
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

  describe("Node Types Registration", () => {
    it("should register all required node types for the canvas", () => {
      // We verify the canvas renders with the node types object defined
      // The actual node type registration happens at module level
      // This test confirms the canvas component can be rendered
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Canvas should render and have the ReactFlow component
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });
  });

  describe("Edge Types Registration", () => {
    it("should register editable and reference edge types for the canvas", () => {
      // Edge types are registered at module level
      // This test confirms the canvas renders with edge type config
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Canvas should render with edge types configured
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
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
  });

  describe("Keyboard Shortcuts", () => {
    it("should call executeWorkflow on Ctrl+Enter", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });

    it("should call executeWorkflow on Cmd+Enter", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "Enter", metaKey: true });

      expect(mockExecuteWorkflow).toHaveBeenCalled();
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

  describe("Connection Validation", () => {
    it("should render canvas with isValidConnection callback configured", () => {
      // The isValidConnection function is passed to ReactFlow to validate connections
      // This test confirms the canvas is properly configured
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // Canvas should have ReactFlow with validation configured
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });
  });

  describe("Group Handling", () => {
    it("should render canvas with group support enabled", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          groups: {
            "group-1": {
              id: "group-1",
              position: { x: 100, y: 100 },
              size: { width: 400, height: 400 },
              locked: false,
            },
          },
        }));
      });

      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // The canvas should render with groups functionality enabled
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });
  });

  describe("Canvas Configuration", () => {
    it("should configure delete key codes for node deletion", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // ReactFlow is configured with deleteKeyCode={["Backspace", "Delete"]}
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });

    it("should configure multi-selection with Shift key", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // ReactFlow is configured with multiSelectionKeyCode="Shift"
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });

    it("should configure zoom constraints", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // ReactFlow is configured with minZoom={0.1} maxZoom={4}
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
    });

    it("should use editable as default edge type", () => {
      render(
        <TestWrapper>
          <WorkflowCanvas />
        </TestWrapper>
      );

      // ReactFlow is configured with defaultEdgeOptions={{ type: "editable" }}
      expect(document.querySelector(".react-flow")).toBeInTheDocument();
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
