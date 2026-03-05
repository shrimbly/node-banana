import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GenerateVideoNode } from "@/components/nodes/GenerateVideoNode";
import { ReactFlowProvider } from "@xyflow/react";
import { GenerateVideoNodeData, ProviderSettings } from "@/types";

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

// Default provider settings - Note: Gemini doesn't support video
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

describe("GenerateVideoNode", () => {
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

  const createNodeData = (overrides: Partial<GenerateVideoNodeData> = {}): GenerateVideoNodeData => ({
    inputImages: [],
    inputPrompt: null,
    outputVideo: null,
    status: "idle",
    error: null,
    videoHistory: [],
    selectedVideoHistoryIndex: 0,
    ...overrides,
  });

  const createNodeProps = (data: Partial<GenerateVideoNodeData> = {}) => ({
    id: "test-node-1",
    type: "generateVideo" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("should render with fal.ai provider badge by default", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      // fal.ai badge SVG should be present - viewBox="0 0 1855 1855"
      const falBadge = container.querySelector('svg[viewBox="0 0 1855 1855"]');
      expect(falBadge).toBeInTheDocument();
    });

    it("should render 'Select model...' when no model is selected", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      // Default title when no model selected
      expect(screen.getByText("Select model...")).toBeInTheDocument();
    });

    it("should render model name as title when selectedModel is set", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Kling Video")).toBeInTheDocument();
    });

    it("should render image and text input handles", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      const imageHandle = container.querySelector('[data-handletype="image"][class*="target"]');
      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(imageHandle).toBeInTheDocument();
      expect(textHandle).toBeInTheDocument();
    });

    it("should render video output handle", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      const outputHandle = container.querySelector('[data-handletype="video"]');
      expect(outputHandle).toBeInTheDocument();
    });

    it("should render handle labels", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      // Should have Image and Prompt labels for inputs, Video for output
      expect(screen.getByText("Image")).toBeInTheDocument();
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      expect(screen.getByText("Video")).toBeInTheDocument();
    });
  });

  describe("Provider Selection (No Gemini)", () => {
    it("should not include Gemini in enabled providers", () => {
      // The component should only show fal.ai and Replicate (when configured)
      // Gemini is excluded because it doesn't support video generation
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
          })} />
        </TestWrapper>
      );

      // Check that there's no Gemini badge visible
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      // Gemini badge would have viewBox="0 0 65 65" - should not be present
      const geminiBadge = container.querySelector('svg[viewBox="0 0 65 65"]');
      expect(geminiBadge).not.toBeInTheDocument();
    });

    it("should show fal.ai as default provider", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      // fal.ai badge should be the default
      const falBadge = container.querySelector('svg[viewBox="0 0 1855 1855"]');
      expect(falBadge).toBeInTheDocument();
    });

    it("should show Replicate badge when Replicate provider is selected", async () => {
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
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "replicate", modelId: "minimax/video-01", displayName: "MiniMax Video" },
          })} />
        </TestWrapper>
      );

      await waitFor(() => {
        const replicateBadge = container.querySelector('svg[viewBox="0 0 1000 1000"]');
        expect(replicateBadge).toBeInTheDocument();
      });
    });
  });

  describe("Idle State", () => {
    it("should show 'Run to generate' message when idle and no output", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({ status: "idle", outputVideo: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Run to generate")).toBeInTheDocument();
    });

    it("should render empty state placeholder when no output video", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({ status: "idle", outputVideo: null })} />
        </TestWrapper>
      );

      expect(screen.getByText("Run to generate")).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("should show loading spinner when status is loading and no output", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({ status: "loading", outputVideo: null })} />
        </TestWrapper>
      );

      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
    });

    it("should show loading overlay when status is loading with existing output", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            status: "loading",
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      // Should show the spinner overlay on top of the video
      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();

      // Should still show the video element
      const video = container.querySelector("video");
      expect(video).toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("should show error message when status is error and no output", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            status: "error",
            error: "Video generation failed",
            outputVideo: null,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Video generation failed")).toBeInTheDocument();
    });

    it("should show error overlay when status is error with existing output", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            status: "error",
            error: "Generation failed",
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Generation failed")).toBeInTheDocument();
      expect(screen.getByText("See toast for details")).toBeInTheDocument();
    });

    it("should show 'Failed' when error message is null", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            status: "error",
            error: null,
            outputVideo: null,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  describe("Output Video Display", () => {
    it("should render video element when data.outputVideo exists", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const video = container.querySelector("video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", "data:video/mp4;base64,abc123");
    });

    it("should render video with controls attribute", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const video = container.querySelector("video");
      expect(video).toHaveAttribute("controls");
    });

    it("should render video with autoplay attribute", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const video = container.querySelector("video");
      expect(video?.autoplay).toBe(true);
    });

    it("should render video with loop attribute", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const video = container.querySelector("video");
      expect(video).toHaveAttribute("loop");
    });

    it("should render video with muted attribute", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const video = container.querySelector("video");
      expect(video?.muted).toBe(true);
    });

    it("should render clear button when output video exists", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const clearButton = screen.getByTitle("Clear video");
      expect(clearButton).toBeInTheDocument();
    });

    it("should call updateNodeData to clear video when clear button is clicked", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
          })} />
        </TestWrapper>
      );

      const clearButton = screen.getByTitle("Clear video");
      fireEvent.click(clearButton);

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", {
        outputVideo: null,
        status: "idle",
        error: null,
      });
    });
  });

  describe("Video History Carousel", () => {
    it("should not show carousel controls when history has only one item", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
            videoHistory: [{ id: "vid1", timestamp: Date.now(), prompt: "test", model: "kling-video/v1" }],
            selectedVideoHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.queryByTitle("Previous video")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Next video")).not.toBeInTheDocument();
    });

    it("should show carousel controls when history has multiple items", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
            videoHistory: [
              { id: "vid1", timestamp: Date.now(), prompt: "test1", model: "kling-video/v1" },
              { id: "vid2", timestamp: Date.now(), prompt: "test2", model: "kling-video/v1" },
            ],
            selectedVideoHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Previous video")).toBeInTheDocument();
      expect(screen.getByTitle("Next video")).toBeInTheDocument();
    });

    it("should show current position in carousel", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            outputVideo: "data:video/mp4;base64,abc123",
            videoHistory: [
              { id: "vid1", timestamp: Date.now(), prompt: "test1", model: "kling-video/v1" },
              { id: "vid2", timestamp: Date.now(), prompt: "test2", model: "kling-video/v1" },
              { id: "vid3", timestamp: Date.now(), prompt: "test3", model: "kling-video/v1" },
            ],
            selectedVideoHistoryIndex: 1,
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
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Run this node")).toBeInTheDocument();
    });

    it("should call regenerateNode when run button is clicked", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
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
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      const runButton = screen.getByTitle("Run this node");
      expect(runButton).toBeDisabled();
    });
  });

  describe("Browse Button", () => {
    it("should render Browse button", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      expect(screen.getByText("Browse")).toBeInTheDocument();
    });

    it("should open ModelSearchDialog when Browse button is clicked", async () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps()} />
        </TestWrapper>
      );

      const browseButton = screen.getByText("Browse");
      fireEvent.click(browseButton);

      // ModelSearchDialog should open
      await waitFor(() => {
        expect(screen.getByText("Browse Models")).toBeInTheDocument();
      });
    });
  });

  describe("Dynamic Input Handles", () => {
    it("should render dynamic handles when inputSchema is provided", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
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
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
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

    describe("Multiple Image Inputs (common for video)", () => {
      it("should render multiple image handles for multi-frame video models", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
              inputSchema: [
                { name: "start_image", type: "image", required: true, label: "Start Image" },
                { name: "end_image", type: "image", required: false, label: "End Image" },
                { name: "prompt", type: "text", required: true, label: "Motion Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        // Should have two image INPUT handles (exclude any output handles)
        const imageInputHandles = container.querySelectorAll('[data-handletype="image"][class*="target"]');
        expect(imageInputHandles.length).toBe(2);

        // Check schema names are set
        const schemaNames = Array.from(imageInputHandles).map(h => h.getAttribute('data-schema-name'));
        expect(schemaNames).toContain('start_image');
        expect(schemaNames).toContain('end_image');
      });

      it("should show labels like 'Start Frame', 'End Frame' from schema", () => {
        render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
              inputSchema: [
                { name: "start_image", type: "image", required: true, label: "Start Frame" },
                { name: "end_image", type: "image", required: false, label: "End Frame" },
                { name: "prompt", type: "text", required: true, label: "Motion Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        expect(screen.getByText("Start Frame")).toBeInTheDocument();
        expect(screen.getByText("End Frame")).toBeInTheDocument();
      });
    });

    describe("Placeholder Handles", () => {
      it("should show dimmed image handle when video model only needs text", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "text-to-video/model", displayName: "Text to Video" },
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
                { name: "negative_prompt", type: "text", required: false, label: "Negative" },
              ],
            })} />
          </TestWrapper>
        );

        // Image handle should exist with dimmed opacity
        const imageHandle = container.querySelector('[data-handletype="image"]') as HTMLElement;
        expect(imageHandle).toBeInTheDocument();
        expect(imageHandle.style.opacity).toBe("0.3");
      });

      it("should show dimmed text handle when video model only needs images", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "image-to-video/model", displayName: "Image to Video" },
              inputSchema: [
                { name: "start_frame", type: "image", required: true, label: "Start Frame" },
                { name: "end_frame", type: "image", required: false, label: "End Frame" },
              ],
            })} />
          </TestWrapper>
        );

        // Text handle should exist with dimmed opacity
        const textHandle = container.querySelector('[data-handletype="text"]') as HTMLElement;
        expect(textHandle).toBeInTheDocument();
        expect(textHandle.style.opacity).toBe("0.3");
      });

      it("should show 'Not used by this model' description for placeholder handles", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "text-to-video/model", displayName: "Text to Video" },
              inputSchema: [
                { name: "prompt", type: "text", required: true, label: "Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        // Image handle should have the placeholder title
        const imageHandle = container.querySelector('[data-handletype="image"]');
        expect(imageHandle).toHaveAttribute("title", "Not used by this model");
      });
    });

    describe("Schema Integration", () => {
      it("should position handles correctly with image handles before text handles", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
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

      it("should maintain gap between image and text handle groups", () => {
        const { container } = render(
          <TestWrapper>
            <GenerateVideoNode {...createNodeProps({
              selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
              inputSchema: [
                { name: "start_image", type: "image", required: true, label: "Start Image" },
                { name: "end_image", type: "image", required: false, label: "End Image" },
                { name: "prompt", type: "text", required: true, label: "Motion Prompt" },
              ],
            })} />
          </TestWrapper>
        );

        // Get all input handles in order (exclude output handle)
        const imageInputHandles = container.querySelectorAll('[data-handletype="image"][class*="target"]');
        const textHandle = container.querySelector('[data-handletype="text"]') as HTMLElement;

        expect(imageInputHandles.length).toBe(2);

        const image0 = imageInputHandles[0] as HTMLElement;
        const image1 = imageInputHandles[1] as HTMLElement;

        const top0 = parseFloat(image0.style.top);
        const top1 = parseFloat(image1.style.top);
        const topText = parseFloat(textHandle.style.top);

        // Gap between image-1 and text should be larger than gap between image-0 and image-1
        const imageDiff = top1 - top0;
        const gapDiff = topText - top1;

        // The gap should account for the spacing slot
        expect(gapDiff).toBeGreaterThan(imageDiff * 0.9);
      });
    });
  });

  describe("Custom Title and Comment", () => {
    it("should display custom title when provided", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            customTitle: "My Video Generator",
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
          })} />
        </TestWrapper>
      );

      expect(screen.getByText(/My Video Generator/)).toBeInTheDocument();
    });

    it("should call updateNodeData when custom title is changed", () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
          })} />
        </TestWrapper>
      );

      // Click on title to edit
      const title = screen.getByText("Kling Video");
      fireEvent.click(title);

      // Type new title
      const input = screen.getByPlaceholderText("Custom title...");
      fireEvent.change(input, { target: { value: "New Title" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-node-1", { customTitle: "New Title" });
    });
  });

  describe("ModelParameters Component", () => {
    it("should render ModelParameters when model is selected", async () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "kling-video/v1", displayName: "Kling Video" },
          })} />
        </TestWrapper>
      );

      // ModelParameters should attempt to load schema
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });

  describe("Fetch Models on Mount", () => {
    it("should fetch models when provider is fal", async () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
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

    it("should request video capabilities when fetching models", async () => {
      render(
        <TestWrapper>
          <GenerateVideoNode {...createNodeProps({
            selectedModel: { provider: "fal", modelId: "", displayName: "Select model..." },
          })} />
        </TestWrapper>
      );

      await waitFor(() => {
        const fetchCalls = mockFetch.mock.calls.filter(call =>
          typeof call[0] === 'string' && call[0].includes('text-to-video')
        );
        expect(fetchCalls.length).toBeGreaterThan(0);
      });
    });
  });
});
