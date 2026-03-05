import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GenerateImageNode } from "@/components/nodes/GenerateImageNode";
import { ReactFlowProvider } from "@xyflow/react";
import { NanoBananaNodeData, ProviderSettings } from "@/types";

// Mock deduplicatedFetch to pass through to global fetch (avoids caching issues in tests)
vi.mock("@/utils/deduplicatedFetch", () => ({
  deduplicatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  clearFetchCache: vi.fn(),
}));

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockAddNode = vi.fn();
const mockIncrementModalCount = vi.fn();
const mockDecrementModalCount = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    // When called without selector (destructuring pattern), return the full state object
    return mockUseWorkflowStore((s: unknown) => s);
  },
  useProviderApiKeys: () => ({
    replicateApiKey: null,
    falApiKey: null,
    kieApiKey: null,
    wavespeedApiKey: null,
    replicateEnabled: false,
    kieEnabled: false,
  }),
  saveNanoBananaDefaults: vi.fn(),
}));

// Mock useReactFlow
const mockSetNodes = vi.fn();
const mockScreenToFlowPosition = vi.fn((pos) => pos);

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      getNodes: vi.fn(() => []),
      setNodes: mockSetNodes,
      screenToFlowPosition: mockScreenToFlowPosition,
    }),
  };
});

// Mock Toast
vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

// Mock createPortal for ModelSearchDialog
vi.mock("react-dom", async () => {
  const actual = await vi.importActual("react-dom");
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

// Mock fetch
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

describe("GenerateImageNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [], success: true }),
    });

    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        regenerateNode: mockRegenerateNode,
        addNode: mockAddNode,
        incrementModalCount: mockIncrementModalCount,
        decrementModalCount: mockDecrementModalCount,
        providerSettings: defaultProviderSettings,
        generationsPath: "/test/generations",
        isRunning: false,
        currentNodeIds: [],
        groups: {},
        nodes: [],
        recentModels: [],
        trackModelUsage: vi.fn(),
        getNodesWithComments: vi.fn(() => []),
        markCommentViewed: vi.fn(),
        setNavigationTarget: vi.fn(),
      };
      return selector(state);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createNodeData = (overrides: Partial<NanoBananaNodeData> = {}): NanoBananaNodeData => ({
    inputImages: [],
    inputPrompt: null,
    outputImage: null,
    aspectRatio: "1:1",
    resolution: "1K",
    model: "nano-banana-pro",
    useGoogleSearch: false,
    status: "idle",
    error: null,
    imageHistory: [],
    selectedHistoryIndex: 0,
    ...overrides,
  });

  const createNodeProps = (data: Partial<NanoBananaNodeData> = {}) => ({
    id: "test-node-1",
    type: "nanoBanana" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("should render with Gemini provider badge by default", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      // Gemini badge SVG should be present (star shape)
      const geminiBadge = container.querySelector('svg[viewBox="0 0 65 65"]');
      expect(geminiBadge).toBeInTheDocument();
    });

    it("should render the model name as title", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({ model: "nano-banana-pro" })} />
        </TestWrapper>
      );

      // The title should show the display name
      expect(screen.getByText("Nano Banana Pro")).toBeInTheDocument();
    });

    it("should render display name from selectedModel when provided", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            model: "nano-banana" as const,
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX.1 Dev" },
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("FLUX.1 Dev")).toBeInTheDocument();
    });

    it("should render image and text input handles", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      const imageHandle = container.querySelector('[data-handletype="image"][class*="target"]');
      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(imageHandle).toBeInTheDocument();
      expect(textHandle).toBeInTheDocument();
    });

    it("should render image output handle", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      const outputHandle = container.querySelector('[data-handletype="image"][class*="source"]');
      expect(outputHandle).toBeInTheDocument();
    });

    it("should render handle labels", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      // Should have Image and Prompt labels for inputs, Image for output
      const imageLabels = screen.getAllByText("Image");
      const promptLabels = screen.getAllByText("Prompt");
      expect(imageLabels.length).toBeGreaterThanOrEqual(1);
      expect(promptLabels.length).toBe(1);
    });
  });

  describe("Idle State", () => {
    it("should show 'Run to generate' message when idle and no output", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({ status: "idle", outputImage: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Run to generate")).toBeInTheDocument();
    });

    it("should render empty state placeholder when no output image", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({ status: "idle", outputImage: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Run to generate")).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("should show loading spinner when status is loading and no output", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({ status: "loading", outputImage: null })} />
        </TestWrapper>
      );

      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
    });

    it("should show loading overlay when status is loading with existing output", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            status: "loading",
            outputImage: "data:image/png;base64,abc123",
          })} />
        </TestWrapper>
      );

      // Should show the spinner overlay on top of the image
      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();

      // Should still show the image
      const img = screen.getByAltText("Generated");
      expect(img).toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("should show error message when status is error and no output", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            status: "error",
            error: "API error occurred",
            outputImage: null,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("API error occurred")).toBeInTheDocument();
    });

    it("should show error overlay when status is error with existing output", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            status: "error",
            error: "Generation failed",
            outputImage: "data:image/png;base64,abc123",
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Generation failed")).toBeInTheDocument();
      expect(screen.getByText("See toast for details")).toBeInTheDocument();
    });

    it("should show 'Failed' when error message is null", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            status: "error",
            error: null,
            outputImage: null,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  describe("Output Image Display", () => {
    it("should render output image when data.outputImage exists", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
          })} />
        </TestWrapper>
      );

      const img = screen.getByAltText("Generated");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "data:image/png;base64,abc123");
    });

    it("should render clear button when output image exists", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
          })} />
        </TestWrapper>
      );

      const clearButton = screen.getByTitle("Clear image");
      expect(clearButton).toBeInTheDocument();
    });

    it("should call updateNodeData to clear image when clear button is clicked", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
          })} />
        </TestWrapper>
      );

      const clearButton = screen.getByTitle("Clear image");
      fireEvent.click(clearButton);

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", {
        outputImage: null,
        status: "idle",
        error: null,
      });
    });
  });

  describe("Image History Carousel", () => {
    it("should not show carousel controls when history has only one item", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
            imageHistory: [{ id: "img1", timestamp: Date.now(), prompt: "test", aspectRatio: "1:1", model: "nano-banana" }],
            selectedHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.queryByTitle("Previous image")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Next image")).not.toBeInTheDocument();
    });

    it("should show carousel controls when history has multiple items", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
            imageHistory: [
              { id: "img1", timestamp: Date.now(), prompt: "test1", aspectRatio: "1:1", model: "nano-banana" },
              { id: "img2", timestamp: Date.now(), prompt: "test2", aspectRatio: "1:1", model: "nano-banana" },
            ],
            selectedHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Previous image")).toBeInTheDocument();
      expect(screen.getByTitle("Next image")).toBeInTheDocument();
    });

    it("should show current position in carousel", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
            imageHistory: [
              { id: "img1", timestamp: Date.now(), prompt: "test1", aspectRatio: "1:1", model: "nano-banana" },
              { id: "img2", timestamp: Date.now(), prompt: "test2", aspectRatio: "1:1", model: "nano-banana" },
              { id: "img3", timestamp: Date.now(), prompt: "test3", aspectRatio: "1:1", model: "nano-banana" },
            ],
            selectedHistoryIndex: 1,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("2 / 3")).toBeInTheDocument();
    });
  });

  describe("Run Button", () => {
    it("should render run button", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Run this node")).toBeInTheDocument();
    });

    it("should call regenerateNode when run button is clicked", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      const runButton = screen.getByTitle("Run this node");
      fireEvent.click(runButton);

      expect(mockRegenerateNode).toHaveBeenCalledWith("test-node-1");
    });

    it("should disable run button when workflow is running", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        const state = {
          updateNodeData: mockUpdateNodeData,
          regenerateNode: mockRegenerateNode,
          addNode: mockAddNode,
          incrementModalCount: mockIncrementModalCount,
          decrementModalCount: mockDecrementModalCount,
          providerSettings: defaultProviderSettings,
          generationsPath: "/test/generations",
          isRunning: true,
          currentNodeIds: [],
          groups: {},
          nodes: [],
          getNodesWithComments: vi.fn(() => []),
          markCommentViewed: vi.fn(),
          setNavigationTarget: vi.fn(),
        };
        return selector(state);
      });

      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      const runButton = screen.getByTitle("Run this node");
      expect(runButton).toBeDisabled();
    });
  });

  describe("Browse Button", () => {
    it("should render Browse button when external providers are available", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByText("Browse")).toBeInTheDocument();
    });

    it("should open ModelSearchDialog when Browse button is clicked", async () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      const browseButton = screen.getByText("Browse");
      fireEvent.click(browseButton);

      // ModelSearchDialog should open - look for the dialog title
      await waitFor(() => {
        expect(screen.getByText("Browse Models")).toBeInTheDocument();
      });
    });
  });

  describe("Provider Badge Display", () => {
    it("should show Gemini badge for Gemini provider", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
          })} />
        </TestWrapper>
      );

      // Gemini badge uses viewBox="0 0 65 65"
      const geminiBadge = container.querySelector('svg[viewBox="0 0 65 65"]');
      expect(geminiBadge).toBeInTheDocument();
    });

    it("should show fal.ai badge for fal provider", async () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX.1 Dev" },
          })} />
        </TestWrapper>
      );

      // Wait for effects to run
      await waitFor(() => {
        // fal.ai badge uses viewBox="0 0 1855 1855"
        const falBadge = container.querySelector('svg[viewBox="0 0 1855 1855"]');
        expect(falBadge).toBeInTheDocument();
      });
    });

    it("should show Replicate badge for Replicate provider", async () => {
      // Enable Replicate provider
      mockUseWorkflowStore.mockImplementation((selector) => {
        const state = {
          updateNodeData: mockUpdateNodeData,
          regenerateNode: mockRegenerateNode,
          addNode: mockAddNode,
          incrementModalCount: mockIncrementModalCount,
          decrementModalCount: mockDecrementModalCount,
          providerSettings: {
            providers: {
              ...defaultProviderSettings.providers,
              replicate: { id: "replicate", name: "Replicate", enabled: true, apiKey: "test-key" },
            },
          },
          generationsPath: "/test/generations",
          isRunning: false,
          currentNodeIds: [],
          groups: {},
          nodes: [],
          getNodesWithComments: vi.fn(() => []),
          markCommentViewed: vi.fn(),
          setNavigationTarget: vi.fn(),
        };
        return selector(state);
      });

      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "replicate", modelId: "stability-ai/sdxl", displayName: "SDXL" },
          })} />
        </TestWrapper>
      );

      // Wait for effects to run
      await waitFor(() => {
        // Replicate badge uses viewBox="0 0 1000 1000"
        const replicateBadge = container.querySelector('svg[viewBox="0 0 1000 1000"]');
        expect(replicateBadge).toBeInTheDocument();
      });
    });
  });

  describe("Legacy Data Migration", () => {
    it("should migrate legacy model field to selectedModel", async () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            model: "nano-banana",
            selectedModel: undefined,
          })} />
        </TestWrapper>
      );

      // The migration effect should call updateNodeData
      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", {
          selectedModel: {
            provider: "gemini",
            modelId: "nano-banana",
            displayName: "Nano Banana",
          },
        });
      });
    });
  });

  describe("Dynamic Input Handles (External Providers)", () => {
    it("should render dynamic handles when inputSchema is provided", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX.1 Dev" },
            inputSchema: [
              { name: "image", type: "image", required: true, label: "Input Image" },
              { name: "prompt", type: "text", required: true, label: "Text Prompt" },
            ],
          })} />
        </TestWrapper>
      );

      // Should have handles rendered
      const imageHandle = container.querySelector('[data-handletype="image"]');
      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(imageHandle).toBeInTheDocument();
      expect(textHandle).toBeInTheDocument();
    });

    it("should show placeholder handles when schema lacks image or text inputs", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX.1 Dev" },
            inputSchema: [
              { name: "prompt", type: "text", required: true, label: "Prompt" },
            ],
          })} />
        </TestWrapper>
      );

      // Should still have both image and text handles (image as placeholder)
      const imageHandle = container.querySelector('[data-handletype="image"]');
      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(imageHandle).toBeInTheDocument();
      expect(textHandle).toBeInTheDocument();
    });

    describe("Static Handles (inputSchema does not affect handle count)", () => {
      it("should always render exactly one image and one text input handle regardless of schema", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateImageNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "video/frames", displayName: "Video Frames" },
              inputSchema: [
                { name: "first_frame", type: "image", required: true, label: "First Frame" },
                { name: "last_frame", type: "image", required: false, label: "Last Frame" },
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        // Component uses static handles - always 1 image input and 1 text input
        const imageInputHandles = container.querySelectorAll('[data-handletype="image"][class*="target"]');
        expect(imageInputHandles.length).toBe(1);

        const textHandles = container.querySelectorAll('[data-handletype="text"]');
        expect(textHandles.length).toBe(1);
      });

      it("should render static 'Image' and 'Prompt' labels", () => {
        render(
          <TestWrapper>
            <GenerateImageNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX Dev" },
              inputSchema: [
                { name: "image", type: "image", required: true, label: "Input Image" },
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        // "Image" may appear in multiple places (handle label + node type), just verify it exists
        expect(screen.getAllByText("Image").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("Prompt")).toBeInTheDocument();
      });

      it("should always have image handle and text handle even with text-only schema", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateImageNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "text-only/model", displayName: "Text Only" },
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        const imageHandle = container.querySelector('[data-handletype="image"]') as HTMLElement;
        const textHandle = container.querySelector('[data-handletype="text"]') as HTMLElement;
        expect(imageHandle).toBeInTheDocument();
        expect(textHandle).toBeInTheDocument();
      });
    });

    describe("Handle Ordering", () => {
      it("should render image handle above text handle", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateImageNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX Dev" },
              inputSchema: [
                { name: "image", type: "image", required: true, label: "Input Image" },
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        const imageHandle = container.querySelector('[data-handletype="image"]') as HTMLElement;
        const textHandle = container.querySelector('[data-handletype="text"]') as HTMLElement;

        // Image handle should be positioned above (lower %) text handle
        const imageTop = parseFloat(imageHandle.style.top);
        const textTop = parseFloat(textHandle.style.top);
        expect(imageTop).toBeLessThan(textTop);
      });
    });
  });

  describe("Custom Title and Comment", () => {
    it("should display custom title when provided", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            customTitle: "My Generator",
          })} />
        </TestWrapper>
      );

      expect(screen.getByText(/My Generator/)).toBeInTheDocument();
    });

    it("should call updateNodeData when custom title is changed", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps()} />
        </TestWrapper>
      );

      // Click on title to edit
      const title = screen.getByText("Nano Banana Pro");
      fireEvent.click(title);

      // Type new title
      const input = screen.getByPlaceholderText("Custom title...");
      fireEvent.change(input, { target: { value: "New Title" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", { customTitle: "New Title" });
    });
  });

  describe("ModelParameters Component", () => {
    it("should render ModelParameters when external provider model is selected", async () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX.1 Dev" },
          })} />
        </TestWrapper>
      );

      // ModelParameters should attempt to load schema
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });

    it("should not render ModelParameters for Gemini provider", async () => {
      mockFetch.mockClear();

      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
          })} />
        </TestWrapper>
      );

      // Give time for any effects to run
      await new Promise(resolve => setTimeout(resolve, 100));

      // ModelParameters component should not fetch for Gemini
      const fetchCalls = mockFetch.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('/api/models/')
      );
      expect(fetchCalls.length).toBe(0);
    });
  });

  describe("Fetch Models on Provider Change", () => {
    it("should fetch models when provider is fal", async () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "", displayName: "Select model..." },
          })} />
        </TestWrapper>
      );

      await waitFor(() => {
        const fetchCalls = mockFetch.mock.calls.filter(call =>
          typeof call[0] === 'string' && call[0].includes('/api/models?')
        );
        expect(fetchCalls.length).toBeGreaterThan(0);
      });
    });

    it("should not fetch models when provider is gemini", async () => {
      mockFetch.mockClear();

      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
          })} />
        </TestWrapper>
      );

      // Give time for any effects to run
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not fetch models for Gemini (those are hardcoded)
      const fetchCalls = mockFetch.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('/api/models?provider=gemini')
      );
      expect(fetchCalls.length).toBe(0);
    });
  });
});
