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
            error: "Upstream provider rejected the request",
            outputImage: "data:image/png;base64,abc123",
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Generation failed")).toBeInTheDocument();
      expect(screen.getByText("Upstream provider rejected the request")).toBeInTheDocument();
      expect(screen.queryByText("See toast for details")).not.toBeInTheDocument();
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

    it("should keep carousel controls out of React Flow node dragging", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
            imageHistory: [
              { id: "img1", timestamp: 2, prompt: "test1", aspectRatio: "1:1", model: "nano-banana" },
              { id: "img2", timestamp: 1, prompt: "test2", aspectRatio: "1:1", model: "nano-banana" },
            ],
            selectedHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Previous image")).toHaveClass("nodrag", "nopan");
      expect(screen.getByTitle("Next image")).toHaveClass("nodrag", "nopan");
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

    it("should load and select the image reached by the next arrow", async () => {
      const imageHistory = [
        { id: "latest", timestamp: 2, prompt: "latest", aspectRatio: "1:1" as const, model: "nano-banana" as const },
        { id: "older", timestamp: 1, prompt: "older", aspectRatio: "1:1" as const, model: "nano-banana" as const },
      ];
      const latestImage = "data:image/png;base64,bGF0ZXN0";
      const olderImage = "data:image/png;base64,b2xkZXI=";

      mockFetch.mockImplementation(async (url, init) => {
        if (url === "/api/load-generation") {
          const body = JSON.parse(String(init?.body));
          expect(body.imageId).toBe("older");
          return {
            ok: true,
            json: () => Promise.resolve({ success: true, image: olderImage }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ models: [], success: true }),
        };
      });

      const { rerender } = render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: latestImage,
            outputImageRef: "latest",
            imageHistory,
            selectedHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      fireEvent.click(screen.getByTitle("Next image"));

      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", {
          outputImage: olderImage,
          outputImageRef: undefined,
          selectedHistoryIndex: 1,
          status: "idle",
          error: null,
        });
      });

      rerender(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: olderImage,
            outputImageRef: "older",
            imageHistory,
            selectedHistoryIndex: 1,
          })} />
        </TestWrapper>
      );

      expect(screen.getByAltText("Generated")).toHaveAttribute("src", olderImage);
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });

    it("should display a safe index when persisted selection is out of bounds", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            outputImage: "data:image/png;base64,abc123",
            imageHistory: [
              { id: "img1", timestamp: 2, prompt: "one", aspectRatio: "1:1", model: "nano-banana" },
              { id: "img2", timestamp: 1, prompt: "two", aspectRatio: "1:1", model: "nano-banana" },
            ],
            selectedHistoryIndex: 99,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("1 / 2")).toBeInTheDocument();
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

    it("should migrate legacy nano-banana-2-lite model field to selectedModel", async () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            model: "nano-banana-2-lite",
            selectedModel: undefined,
          })} />
        </TestWrapper>
      );

      // The migration effect should resolve the display name from MODEL_DISPLAY_NAMES
      await waitFor(() => {
        expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", {
          selectedModel: {
            provider: "gemini",
            modelId: "nano-banana-2-lite",
            displayName: "Nano Banana 2 Lite",
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

  describe("Fallback Settings Tab", () => {
    beforeEach(() => {
      // Enable inline parameters for tab bar tests
      localStorage.setItem("node-banana-inline-parameters", "true");
    });
    afterEach(() => {
      localStorage.removeItem("node-banana-inline-parameters");
    });

    it("shows tab bar when fallbackModel is set", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX Dev" },
            fallbackModel: { provider: "replicate", modelId: "flux-schnell", displayName: "FLUX Schnell" },
            parametersExpanded: true,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("FLUX Dev")).toBeInTheDocument();
      expect(screen.getByText("FLUX Schnell")).toBeInTheDocument();
    });

    it("hides tab bar when no fallbackModel", () => {
      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX Dev" },
            parametersExpanded: true,
          })} />
        </TestWrapper>
      );

      // Should not find the fallback label
      expect(screen.queryByText("FLUX Schnell")).not.toBeInTheDocument();
    });

    it("switches to fallback ModelParameters when fallback tab clicked", async () => {
      // Track which modelId is being fetched for schema
      const schemaFetchCalls: string[] = [];
      mockFetch.mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("/api/models/")) {
          schemaFetchCalls.push(url);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ parameters: [], inputs: [], success: true }),
        });
      });

      render(
        <TestWrapper>
          <GenerateImageNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "flux/dev", displayName: "FLUX Dev" },
            fallbackModel: { provider: "replicate", modelId: "flux-schnell", displayName: "FLUX Schnell" },
            parametersExpanded: true,
          })} />
        </TestWrapper>
      );

      // Click the fallback tab
      fireEvent.click(screen.getByText("FLUX Schnell"));

      // After clicking fallback tab, ModelParameters should fetch schema for fallback model
      await waitFor(() => {
        const fallbackFetches = schemaFetchCalls.filter(url => url.includes("flux-schnell"));
        expect(fallbackFetches.length).toBeGreaterThan(0);
      });
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
