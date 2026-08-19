import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GenerateAudioNode } from "@/components/nodes/GenerateAudioNode";
import { ReactFlowProvider } from "@xyflow/react";
import { GenerateAudioNodeData, ProviderSettings } from "@/types";

// Mock deduplicatedFetch to pass through to global fetch (avoids caching issues in tests)
vi.mock("@/utils/deduplicatedFetch", () => ({
  deduplicatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  clearFetchCache: vi.fn(),
}));

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockIncrementModalCount = vi.fn();
const mockDecrementModalCount = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
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

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      getNodes: vi.fn(() => []),
      setNodes: mockSetNodes,
      screenToFlowPosition: vi.fn((pos) => pos),
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

// Mock useAudioVisualization
vi.mock("@/hooks/useAudioVisualization", () => ({
  useAudioVisualization: () => ({
    waveformData: null,
    isLoading: false,
  }),
}));

// Mock fetch
const originalFetch = global.fetch;
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
    metaso: { id: "metaso", name: "metaso", enabled: false, apiKey: null },
  },
};

describe("GenerateAudioNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [], success: true }),
    });

    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        updateNodeData: mockUpdateNodeData,
        regenerateNode: mockRegenerateNode,
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
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const createNodeData = (overrides: Partial<GenerateAudioNodeData> = {}): GenerateAudioNodeData => ({
    inputPrompt: null,
    outputAudio: null,
    status: "idle",
    error: null,
    audioHistory: [],
    selectedAudioHistoryIndex: 0,
    duration: null,
    format: null,
    ...overrides,
  });

  const createNodeProps = (data: Partial<GenerateAudioNodeData> = {}) => ({
    id: "test-audio-1",
    type: "generateAudio" as const,
    data: createNodeData(data),
    selected: false,
  });

  describe("Basic Rendering", () => {
    it("should render text input handle", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps()} />
        </TestWrapper>
      );

      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(textHandle).toBeInTheDocument();
    });

    it("should render audio output handle", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps()} />
        </TestWrapper>
      );

      const outputHandle = container.querySelector('[data-handletype="audio"]');
      expect(outputHandle).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("should show loading spinner when status is loading", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({ status: "loading" })} />
        </TestWrapper>
      );

      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
      expect(screen.getByText("Generating audio...")).toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("should show error message when status is error", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            status: "error",
            error: "Audio generation failed",
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("Audio generation failed")).toBeInTheDocument();
    });
  });

  describe("Audio Output", () => {
    it("should render play button when audio is present", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            outputAudio: "data:audio/mp3;base64,abc123",
            status: "complete",
          })} />
        </TestWrapper>
      );

      const playButton = screen.getByTitle("Play");
      expect(playButton).toBeInTheDocument();
    });

    it("should render clear button when audio is present", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            outputAudio: "data:audio/mp3;base64,abc123",
            status: "complete",
          })} />
        </TestWrapper>
      );

      const clearButton = screen.getByTitle("Clear audio");
      expect(clearButton).toBeInTheDocument();
    });

    it("should call updateNodeData to clear audio when clear button is clicked", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            outputAudio: "data:audio/mp3;base64,abc123",
            status: "complete",
          })} />
        </TestWrapper>
      );

      const clearButton = screen.getByTitle("Clear audio");
      fireEvent.click(clearButton);

      expect(mockUpdateNodeData).toHaveBeenCalledWith("test-audio-1", {
        outputAudio: null,
        status: "idle",
        error: null,
        duration: null,
        format: null,
      });
    });
  });

  describe("Audio History Carousel", () => {
    it("should not show carousel controls when history has only one item", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            outputAudio: "data:audio/mp3;base64,abc123",
            audioHistory: [{ id: "audio1", timestamp: Date.now(), prompt: "test", model: "elevenlabs" }],
            selectedAudioHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.queryByTitle("Previous")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Next")).not.toBeInTheDocument();
    });

    it("should show carousel controls when history has multiple items", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            outputAudio: "data:audio/mp3;base64,abc123",
            audioHistory: [
              { id: "audio1", timestamp: Date.now(), prompt: "test1", model: "elevenlabs" },
              { id: "audio2", timestamp: Date.now(), prompt: "test2", model: "elevenlabs" },
            ],
            selectedAudioHistoryIndex: 0,
          })} />
        </TestWrapper>
      );

      expect(screen.getByTitle("Previous")).toBeInTheDocument();
      expect(screen.getByTitle("Next")).toBeInTheDocument();
    });

    it("should show current position in carousel", () => {
      render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            outputAudio: "data:audio/mp3;base64,abc123",
            audioHistory: [
              { id: "audio1", timestamp: Date.now(), prompt: "test1", model: "elevenlabs" },
              { id: "audio2", timestamp: Date.now(), prompt: "test2", model: "elevenlabs" },
              { id: "audio3", timestamp: Date.now(), prompt: "test3", model: "elevenlabs" },
            ],
            selectedAudioHistoryIndex: 1,
          })} />
        </TestWrapper>
      );

      expect(screen.getByText("2/3")).toBeInTheDocument();
    });
  });

  describe("Dynamic Input Handles", () => {
    it("should render dynamic handles when inputSchema is provided", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps({
            selectedModel: { provider: "kie", modelId: "elevenlabs-turbo-v2.5", displayName: "ElevenLabs" },
            inputSchema: [
              { name: "prompt", type: "text", required: true, label: "Text Prompt" },
            ],
          })} />
        </TestWrapper>
      );

      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(textHandle).toBeInTheDocument();
    });

    it("should show default text handle when no inputSchema", () => {
      const { container } = render(
        <TestWrapper>
          <GenerateAudioNode {...createNodeProps()} />
        </TestWrapper>
      );

      const textHandle = container.querySelector('[data-handletype="text"]');
      expect(textHandle).toBeInTheDocument();
    });
  });
});
