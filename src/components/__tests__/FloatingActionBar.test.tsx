import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FloatingActionBar } from "@/components/FloatingActionBar";
import { ReactFlowProvider } from "@xyflow/react";
import { ProviderSettings } from "@/types";

// Mock the workflow store
const mockAddNode = vi.fn();
const mockExecuteWorkflow = vi.fn();
const mockRegenerateNode = vi.fn();
const mockStopWorkflow = vi.fn();
const mockValidateWorkflow = vi.fn();
const mockSetEdgeStyle = vi.fn();
const mockSetAllEdgesHidden = vi.fn();
const mockSetModelSearchOpen = vi.fn();
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
const mockGetNodes = vi.fn(() => []);

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      screenToFlowPosition: mockScreenToFlowPosition,
      getNodes: mockGetNodes,
    }),
  };
});

// Mock ModelSearchDialog
vi.mock("@/components/modals/ModelSearchDialog", () => ({
  ModelSearchDialog: ({ isOpen, onClose, initialProvider }: { isOpen: boolean; onClose: () => void; initialProvider?: string }) => (
    isOpen ? (
      <div data-testid="model-search-dialog" data-provider={initialProvider}>
        Model Search Dialog
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
  ),
}));

// Mock fetch for env-status
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

// Default provider settings
const defaultProviderSettings: ProviderSettings = {
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
  // One node, so Run has something to run; wiring never disables it
  nodes: [{ id: "gen", type: "nanoBanana", position: { x: 0, y: 0 }, data: {} }],
  isRunning: false,
  currentNodeIds: [],
  executeWorkflow: mockExecuteWorkflow,
  regenerateNode: mockRegenerateNode,
  stopWorkflow: mockStopWorkflow,
  validateWorkflow: mockValidateWorkflow,
  edgeStyle: "angular" as const,
  edgeAppearance: { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true },
  setEdgeStyle: mockSetEdgeStyle,
  setAllEdgesHidden: mockSetAllEdgesHidden,
  edges: [],
  setModelSearchOpen: mockSetModelSearchOpen,
  modelSearchOpen: false,
  modelSearchProvider: null,
  addNode: mockAddNode,
  ...overrides,
});

describe("FloatingActionBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateWorkflow.mockReturnValue({ valid: true, errors: [] });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ gemini: true, openai: false, replicate: false }),
    });

    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Basic Rendering", () => {
    it("should render node type buttons", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Prompt" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Output" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "All nodes" })).toBeInTheDocument();
      });
    });

    it("should render the Generate menu button", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
      });
    });

    it("shows the keyboard shortcut in the hover label", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      const imageButton = await screen.findByRole("button", { name: "Image" });
      expect(imageButton.parentElement).toHaveTextContent("⇧I");
    });

    it("should render Run button", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Run")).toBeInTheDocument();
      });
    });

    it("should render edge style toggle button", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Switch to straight connectors" })).toBeInTheDocument();
      });
    });
  });

  describe("Node Button Click", () => {
    it("should call addNode when Image button is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
      });

      const imageButton = screen.getByRole("button", { name: "Image" });
      fireEvent.click(imageButton);

      expect(mockAddNode).toHaveBeenCalledWith("imageInput", expect.any(Object));
    });

    it("should call addNode when Prompt button is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Prompt" })).toBeInTheDocument();
      });

      const promptButton = screen.getByRole("button", { name: "Prompt" });
      fireEvent.click(promptButton);

      expect(mockAddNode).toHaveBeenCalledWith("prompt", expect.any(Object));
    });

    it("should call addNode when Output button is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Output" })).toBeInTheDocument();
      });

      const outputButton = screen.getByRole("button", { name: "Output" });
      fireEvent.click(outputButton);

      expect(mockAddNode).toHaveBeenCalledWith("output", expect.any(Object));
    });
  });

  describe("Node Button Drag", () => {
    it("should set dataTransfer with node type on drag start", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
      });

      const imageButton = screen.getByRole("button", { name: "Image" });

      const mockDataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
      };

      fireEvent.dragStart(imageButton, {
        dataTransfer: mockDataTransfer,
      });

      expect(mockDataTransfer.setData).toHaveBeenCalledWith("application/node-type", "imageInput");
      expect(mockDataTransfer.effectAllowed).toBe("copy");
    });

    it("should set dataTransfer with prompt type on drag", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Prompt" })).toBeInTheDocument();
      });

      const promptButton = screen.getByRole("button", { name: "Prompt" });

      const mockDataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
      };

      fireEvent.dragStart(promptButton, {
        dataTransfer: mockDataTransfer,
      });

      expect(mockDataTransfer.setData).toHaveBeenCalledWith("application/node-type", "prompt");
    });
  });

  describe("Generate Combo Button", () => {
    it("should open dropdown menu when Generate button is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
      });

      const generateButton = screen.getByRole("button", { name: "Generate" });
      fireEvent.click(generateButton);

      // Dropdown menu items should appear
      expect(screen.getByRole("menuitem", { name: /^Image/ })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /^Video/ })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /Text \(LLM\)/ })).toBeInTheDocument();
    });

    it("opens the menu without adding a node", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      fireEvent.click(await screen.findByRole("button", { name: "Generate" }));

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(mockAddNode).not.toHaveBeenCalled();
    });

    it("should add nanoBanana node when Image option is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
      });

      // Open dropdown
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));

      // Click Image option in dropdown
      const imageOption = screen.getByRole("menuitem", { name: /^Image/ });
      fireEvent.click(imageOption);

      expect(mockAddNode).toHaveBeenCalledWith("nanoBanana", expect.any(Object));
    });

    it("should add generateVideo node when Video option is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /^Video/ }));

      expect(mockAddNode).toHaveBeenCalledWith("generateVideo", expect.any(Object));
    });

    it("should add llmGenerate node when Text (LLM) option is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Text \(LLM\)/ }));

      expect(mockAddNode).toHaveBeenCalledWith("llmGenerate", expect.any(Object));
    });

    it("should close dropdown after selecting an option", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Generate" }));

      // Verify dropdown is open
      expect(screen.getByRole("menuitem", { name: /^Video/ })).toBeInTheDocument();

      // Click an option
      fireEvent.click(screen.getByRole("menuitem", { name: /^Video/ }));

      // Dropdown should close
      expect(screen.queryByRole("menuitem", { name: /^Video/ })).not.toBeInTheDocument();
    });
  });

  describe("Browse Models Button", () => {
    it("should render All models button", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All models" })).toBeInTheDocument();
      });
    });

    it("should open ModelSearchDialog when All models button is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All models" })).toBeInTheDocument();
      });

      const browseButton = screen.getByRole("button", { name: "All models" });
      fireEvent.click(browseButton);

      expect(mockSetModelSearchOpen).toHaveBeenCalledWith(true);
    });
  });

  describe("All Nodes Menu", () => {
    it("should render All nodes button", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All nodes" })).toBeInTheDocument();
      });
    });

    it("should open All nodes dropdown when clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All nodes" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "All nodes" }));

      // Check representative items from different categories
      expect(screen.getByRole("menuitem", { name: "Image Input" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Generate Image" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Router" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Output Gallery" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Annotate" })).toBeInTheDocument();
    });

    it("should call addNode when a node is selected from All nodes menu", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All nodes" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "All nodes" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Annotate" }));

      expect(mockAddNode).toHaveBeenCalledWith("annotation", expect.any(Object));
    });

    it("should close All nodes dropdown after selection", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All nodes" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "All nodes" }));

      // Verify dropdown is open
      expect(screen.getByRole("menuitem", { name: "Image Input" })).toBeInTheDocument();

      // Click an item
      fireEvent.click(screen.getByRole("menuitem", { name: "Image Input" }));

      // Dropdown should close - "Image Input" should no longer be visible
      expect(screen.queryByRole("menuitem", { name: "Image Input" })).not.toBeInTheDocument();
    });
  });

  describe("Edge Style Toggle", () => {
    it("should call setEdgeStyle with straight when currently angular", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Switch to straight connectors" })).toBeInTheDocument();
      });

      const toggleButton = screen.getByRole("button", { name: "Switch to straight connectors" });
      fireEvent.click(toggleButton);

      expect(mockSetEdgeStyle).toHaveBeenCalledWith("straight");
    });

    it("should call setEdgeStyle with curved when currently straight", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          edgeStyle: "straight",
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Switch to curved connectors" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Switch to curved connectors" }));

      expect(mockSetEdgeStyle).toHaveBeenCalledWith("curved");
    });

    it("should call setEdgeStyle with angular when currently curved", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          edgeStyle: "curved",
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Switch to angular connectors" })).toBeInTheDocument();
      });

      const toggleButton = screen.getByRole("button", { name: "Switch to angular connectors" });
      fireEvent.click(toggleButton);

      expect(mockSetEdgeStyle).toHaveBeenCalledWith("angular");
    });
  });

  describe("Run Button", () => {
    it("should call executeWorkflow when Run button is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Run")).toBeInTheDocument();
      });

      const runButton = screen.getByText("Run");
      fireEvent.click(runButton);

      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });

    it("should show Stop button when isRunning is true", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          isRunning: true,
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Stop")).toBeInTheDocument();
      });
    });

    it("should call stopWorkflow when Stop button is clicked", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          isRunning: true,
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Stop")).toBeInTheDocument();
      });

      const stopButton = screen.getByText("Stop");
      fireEvent.click(stopButton);

      expect(mockStopWorkflow).toHaveBeenCalled();
    });

    it("keeps Run enabled when nodes are missing connections", async () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ nodes: [{ id: "gen", type: "nanoBanana", position: { x: 0, y: 0 }, data: {} }], edges: [] })));

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Run")).toBeInTheDocument();
      });

      expect(screen.getByText("Run").closest("button")).not.toBeDisabled();
      expect(screen.getByTitle("Run options")).toBeInTheDocument();
    });

    it("should disable Run button when the workflow is empty", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes: [], edges: [] })));

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Run")).toBeInTheDocument();
      });

      const runButton = screen.getByText("Run").closest("button");
      expect(runButton).toBeDisabled();
    });

    it("says why in the title when the workflow is empty", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes: [], edges: [] })));

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        const runButton = screen.getByText("Run").closest("button");
        expect(runButton).toHaveAttribute("title", "Workflow is empty");
      });
    });
  });

  describe("Run Menu Dropdown", () => {
    it("should show dropdown chevron when workflow is valid and not running", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });
    });

    it("should not show dropdown chevron when the workflow is empty", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ nodes: [], edges: [] })));

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.queryByTitle("Run options")).not.toBeInTheDocument();
      });
    });

    it("should not show dropdown chevron when running", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          isRunning: true,
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.queryByTitle("Run options")).not.toBeInTheDocument();
      });
    });

    it("should open run menu when dropdown chevron is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Run options"));

      expect(screen.getByText("Run entire workflow")).toBeInTheDocument();
      expect(screen.getByText("Run from selected node")).toBeInTheDocument();
      expect(screen.getByText("Run selected node only")).toBeInTheDocument();
    });

    it("should call executeWorkflow when 'Run entire workflow' is clicked", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Run options"));
      fireEvent.click(screen.getByText("Run entire workflow"));

      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });

    it("should disable 'Run from selected node' when no node is selected", async () => {
      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Run options"));

      const runFromSelectedButton = screen.getByText("Run from selected node").closest("button");
      expect(runFromSelectedButton).toBeDisabled();
    });

    it("should enable 'Run from selected node' when a single node is selected", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-1", selected: true, type: "prompt" }],
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Run options"));

      const runFromSelectedButton = screen.getByText("Run from selected node").closest("button");
      expect(runFromSelectedButton).not.toHaveClass("cursor-not-allowed");
    });

    it("should call executeWorkflow with node id when 'Run from selected node' is clicked", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-1", selected: true, type: "prompt" }],
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Run options"));
      fireEvent.click(screen.getByText("Run from selected node"));

      expect(mockExecuteWorkflow).toHaveBeenCalledWith("node-1");
    });

    it("should call regenerateNode when 'Run selected node only' is clicked", async () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-1", selected: true, type: "prompt" }],
        }));
      });

      render(
        <TestWrapper>
          <FloatingActionBar />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTitle("Run options")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle("Run options"));
      fireEvent.click(screen.getByText("Run selected node only"));

      expect(mockRegenerateNode).toHaveBeenCalledWith("node-1");
    });
  });
});

describe("Hidden connections toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateWorkflow.mockReturnValue({ valid: true, errors: [] });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ gemini: true }) });
  });

  it("is disabled when there are no connections", async () => {
    render(
      <TestWrapper>
        <FloatingActionBar />
      </TestWrapper>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide all connections" })).toBeDisabled());
  });

  it("hides every connection when none are hidden", async () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: [{ id: "e1", data: {} }, { id: "e2", data: {} }] }))
    );
    render(
      <TestWrapper>
        <FloatingActionBar />
      </TestWrapper>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide all connections" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Hide all connections" }));
    expect(mockSetAllEdgesHidden).toHaveBeenCalledWith(true);
  });

  it("counts the hidden connections and shows them all", async () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: [{ id: "e1", data: { hidden: true } }, { id: "e2", data: { hidden: true } }, { id: "e3", data: {} }] }))
    );
    render(
      <TestWrapper>
        <FloatingActionBar />
      </TestWrapper>
    );
    const button = await screen.findByRole("button", { name: "Show 2 hidden connections" });
    // The count badge sits beside the button, inside the same group.
    expect(button.parentElement).toHaveTextContent("2");
    fireEvent.click(button);
    expect(mockSetAllEdgesHidden).toHaveBeenCalledWith(false);
  });
});
