import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { ProviderSettings } from "@/types";
import { ProviderModel } from "@/lib/providers/types";

// Mock deduplicatedFetch to pass through to global fetch (avoids caching issues in tests)
vi.mock("@/utils/deduplicatedFetch", () => ({
  deduplicatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  clearFetchCache: vi.fn(),
}));

// Mock the workflow store
const mockAddNode = vi.fn();
const mockIncrementModalCount = vi.fn();
const mockDecrementModalCount = vi.fn();
const mockTrackModelUsage = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
  useProviderApiKeys: () => ({
    replicateApiKey: "test-replicate-key",
    falApiKey: "test-fal-key",
    kieApiKey: null,
    wavespeedApiKey: null,
    replicateEnabled: true,
    kieEnabled: false,
  }),
}));

// Mock useReactFlow
const mockScreenToFlowPosition = vi.fn((pos) => pos);

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      screenToFlowPosition: mockScreenToFlowPosition,
    }),
  };
});

// Mock createPortal for dialog
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
    anthropic: { id: "anthropic", name: "Anthropic", enabled: false, apiKey: null },
    replicate: { id: "replicate", name: "Replicate", enabled: true, apiKey: "test-replicate-key" },
    fal: { id: "fal", name: "fal.ai", enabled: true, apiKey: "test-fal-key" },
    kie: { id: "kie", name: "Kie.ai", enabled: false, apiKey: null },
    wavespeed: { id: "wavespeed", name: "WaveSpeed", enabled: false, apiKey: null },
    orcarouter: { id: "orcarouter", name: "OrcaRouter", enabled: false, apiKey: null, apiKeyEnvVar: "ORCAROUTER_API_KEY" },
  },
};

// Sample models for testing
const sampleModels: ProviderModel[] = [
  {
    id: "flux/dev",
    name: "FLUX.1 Dev",
    description: "High quality image generation model",
    provider: "fal",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: "https://example.com/flux.jpg",
  },
  {
    id: "stability-ai/sdxl",
    name: "SDXL",
    description: "Stable Diffusion XL",
    provider: "replicate",
    capabilities: ["text-to-image"],
    coverImage: "https://example.com/sdxl.jpg",
  },
  {
    id: "kling-video/v1.6/pro",
    name: "Kling Video Pro",
    description: "AI video generation",
    provider: "fal",
    capabilities: ["text-to-video", "image-to-video"],
    coverImage: "https://example.com/kling.jpg",
  },
  {
    id: "fal-ai/triposr",
    name: "TripoSR",
    description: "3D model generation from images",
    provider: "fal",
    capabilities: ["image-to-3d"],
    coverImage: "https://example.com/triposr.jpg",
  },
];

describe("ModelSearchDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default mock fetch response
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, models: sampleModels }),
    });

    // Default store mock
    mockUseWorkflowStore.mockImplementation((selector) => {
      const state = {
        providerSettings: defaultProviderSettings,
        addNode: mockAddNode,
        incrementModalCount: mockIncrementModalCount,
        decrementModalCount: mockDecrementModalCount,
        recentModels: [],
        trackModelUsage: mockTrackModelUsage,
      };
      return selector(state);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("Visibility", () => {
    it("should not render when isOpen is false", () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={false} onClose={vi.fn()} />
        </TestWrapper>
      );

      expect(screen.queryByText("Browse Models")).not.toBeInTheDocument();
    });

    it("should render with title when isOpen is true", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      expect(screen.getByText("Browse Models")).toBeInTheDocument();
    });

    it("should register and unregister modal count", async () => {
      const { unmount } = render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      expect(mockIncrementModalCount).toHaveBeenCalled();

      unmount();

      expect(mockDecrementModalCount).toHaveBeenCalled();
    });
  });

  describe("Search Functionality", () => {
    it("should render search input", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      const searchInput = screen.getByPlaceholderText("Search models...");
      expect(searchInput).toBeInTheDocument();
    });

    it("should debounce search input and refetch models", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      // Clear initial fetch calls
      await vi.advanceTimersByTimeAsync(100);
      mockFetch.mockClear();

      const searchInput = screen.getByPlaceholderText("Search models...");
      fireEvent.change(searchInput, { target: { value: "flux" } });

      // Before debounce timeout, should not fetch
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFetch).not.toHaveBeenCalled();

      // After debounce timeout (300ms), should fetch
      await vi.advanceTimersByTimeAsync(150);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0][0] as string;
        expect(fetchCall).toContain("search=flux");
      });
    });

    it("should focus search input when dialog opens", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      const searchInput = screen.getByPlaceholderText("Search models...");
      await waitFor(() => {
        expect(document.activeElement).toBe(searchInput);
      });
    });
  });

  describe("Provider Filter", () => {
    it("should render provider filter buttons", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      // Provider filter is now buttons - check for "All" button with title "All Providers"
      const allButton = screen.getByTitle("All Providers");
      expect(allButton).toBeInTheDocument();
      expect(allButton).toHaveTextContent("All");
    });

    it("should filter by provider when button is clicked", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await vi.advanceTimersByTimeAsync(100);
      mockFetch.mockClear();

      // Click the Replicate button (has title "Replicate")
      const replicateButton = screen.getByTitle("Replicate");
      fireEvent.click(replicateButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0][0] as string;
        expect(fetchCall).toContain("provider=replicate");
      });
    });

    it("should use initialProvider when provided", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} initialProvider="fal" />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0][0] as string;
        expect(fetchCall).toContain("provider=fal");
      });
    });
  });

  describe("Capability Filter", () => {
    it("should render capability filter dropdown", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      const capabilitySelect = screen.getByDisplayValue("All Types");
      expect(capabilitySelect).toBeInTheDocument();
    });

    it("should filter by image capabilities when selected", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await vi.advanceTimersByTimeAsync(100);
      mockFetch.mockClear();

      const capabilitySelect = screen.getByDisplayValue("All Types");
      fireEvent.change(capabilitySelect, { target: { value: "image" } });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0][0] as string;
        // URL encodes comma as %2C
        expect(fetchCall).toMatch(/capabilities=text-to-image[,%].*image-to-image/);
      });
    });

    it("should filter by video capabilities when selected", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await vi.advanceTimersByTimeAsync(100);
      mockFetch.mockClear();

      const capabilitySelect = screen.getByDisplayValue("All Types");
      fireEvent.change(capabilitySelect, { target: { value: "video" } });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0][0] as string;
        // URL encodes comma as %2C
        expect(fetchCall).toMatch(/capabilities=text-to-video[,%].*image-to-video/);
      });
    });

    it("should use initialCapabilityFilter when provided", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} initialCapabilityFilter="video" />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0][0] as string;
        // URL encodes comma as %2C
        expect(fetchCall).toMatch(/capabilities=text-to-video[,%].*image-to-video/);
      });
    });
  });

  describe("Model Card Rendering", () => {
    it("should render model cards with name and description", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("FLUX.1 Dev")).toBeInTheDocument();
        expect(screen.getByText("High quality image generation model")).toBeInTheDocument();
        expect(screen.getByText("SDXL")).toBeInTheDocument();
        expect(screen.getByText("Stable Diffusion XL")).toBeInTheDocument();
      });
    });

    it("should render provider badges on model cards", async () => {
      const { container } = render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        // Check provider badges in the model cards grid
        const modelGrid = container.querySelector(".grid");
        expect(modelGrid).toBeInTheDocument();
        // fal.ai appears for 2 models (FLUX.1 Dev and Kling Video)
        const falBadges = modelGrid!.querySelectorAll('span[class*="bg-yellow"]');
        expect(falBadges.length).toBeGreaterThanOrEqual(2);
        // Replicate appears for 1 model (SDXL)
        const replicateBadges = modelGrid!.querySelectorAll('span[class*="bg-blue"]');
        expect(replicateBadges.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("should render capability badges on model cards", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        // Check for capability badges (using short form labels)
        const txtImgBadges = screen.getAllByText("txt\u2192img");
        const imgImgBadges = screen.getAllByText("img\u2192img");
        const txtVidBadges = screen.getAllByText("txt\u2192vid");
        const imgVidBadges = screen.getAllByText("img\u2192vid");

        expect(txtImgBadges.length).toBeGreaterThanOrEqual(2); // FLUX and SDXL
        expect(imgImgBadges.length).toBeGreaterThanOrEqual(1); // FLUX
        expect(txtVidBadges.length).toBeGreaterThanOrEqual(1); // Kling Video
        expect(imgVidBadges.length).toBeGreaterThanOrEqual(1); // Kling Video
      });
    });

    it("should render model count in footer", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(/4 models? found/)).toBeInTheDocument();
      });
    });
  });

  describe("Model Selection", () => {
    it("should call onModelSelected when a model card is clicked (callback mode)", async () => {
      const onModelSelected = vi.fn();
      const onClose = vi.fn();

      render(
        <TestWrapper>
          <ModelSearchDialog
            isOpen={true}
            onClose={onClose}
            onModelSelected={onModelSelected}
          />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("FLUX.1 Dev")).toBeInTheDocument();
      });

      // Click on the FLUX.1 Dev model card
      const modelCard = screen.getByText("FLUX.1 Dev").closest("button");
      fireEvent.click(modelCard!);

      expect(onModelSelected).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "flux/dev",
          name: "FLUX.1 Dev",
          provider: "fal",
        })
      );
      expect(onClose).toHaveBeenCalled();
    });

    it("should call addNode when a model card is clicked (create node mode)", async () => {
      const onClose = vi.fn();

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("SDXL")).toBeInTheDocument();
      });

      // Click on the SDXL model card
      const modelCard = screen.getByText("SDXL").closest("button");
      fireEvent.click(modelCard!);

      expect(mockAddNode).toHaveBeenCalledWith(
        "nanoBanana",
        expect.any(Object),
        expect.objectContaining({
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
            capabilities: ["text-to-image"],
          },
        })
      );
      expect(onClose).toHaveBeenCalled();
    });

    it("should create generateVideo node for video models", async () => {
      const onClose = vi.fn();

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Kling Video Pro")).toBeInTheDocument();
      });

      // Click on the Kling Video model card
      const modelCard = screen.getByText("Kling Video Pro").closest("button");
      fireEvent.click(modelCard!);

      expect(mockAddNode).toHaveBeenCalledWith(
        "generateVideo",
        expect.any(Object),
        expect.objectContaining({
          selectedModel: {
            provider: "fal",
            modelId: "kling-video/v1.6/pro",
            displayName: "Kling Video Pro",
            capabilities: ["text-to-video", "image-to-video"],
          },
        })
      );
    });

    it("should create generate3d node for 3D models", async () => {
      const onClose = vi.fn();

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("TripoSR")).toBeInTheDocument();
      });

      // Click on the TripoSR 3D model card
      const modelCard = screen.getByText("TripoSR").closest("button");
      fireEvent.click(modelCard!);

      expect(mockAddNode).toHaveBeenCalledWith(
        "generate3d",
        expect.any(Object),
        expect.objectContaining({
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/triposr",
            displayName: "TripoSR",
            capabilities: ["image-to-3d"],
          },
        })
      );
    });
  });

  describe("Close Behavior", () => {
    it("should call onClose when close button is clicked", async () => {
      const onClose = vi.fn();

      const { container } = render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      // Find close button in the header (first button after title)
      const headerCloseButton = container.querySelector("button.p-1\\.5");
      fireEvent.click(headerCloseButton!);

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose when Escape key is pressed", async () => {
      const onClose = vi.fn();

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      fireEvent.keyDown(window, { key: "Escape" });

      expect(onClose).toHaveBeenCalled();
    });

    it("should call onClose when backdrop is clicked", async () => {
      const onClose = vi.fn();

      const { container } = render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      // Click on the backdrop (the outer div with bg-black/60)
      const backdrop = container.querySelector(".bg-black\\/60");
      fireEvent.click(backdrop!);

      expect(onClose).toHaveBeenCalled();
    });

    it("should not close when clicking inside the dialog", async () => {
      const onClose = vi.fn();

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={onClose} />
        </TestWrapper>
      );

      // Click on the dialog title (inside the dialog)
      fireEvent.click(screen.getByText("Browse Models"));

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("Loading State", () => {
    it("should show loading spinner while fetching models", async () => {
      // Create a promise that won't resolve immediately
      let resolvePromise: ((value: unknown) => void) | undefined;
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { container } = render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      // Check for loading spinner
      await waitFor(() => {
        const spinner = container.querySelector(".animate-spin");
        expect(spinner).toBeInTheDocument();
      });

      expect(screen.getByText("Loading models...")).toBeInTheDocument();

      // Resolve the promise
      resolvePromise!({
        ok: true,
        json: () => Promise.resolve({ success: true, models: [] }),
      });
    });
  });

  describe("Error State", () => {
    it("should show error message when fetch fails", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "API error occurred" }),
      });

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("API error occurred")).toBeInTheDocument();
      });
    });

    it("should show error message when network request fails", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });

    it("should show Try Again button on error", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "API error" }),
      });

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Try Again")).toBeInTheDocument();
      });
    });

    it("should refetch when Try Again button is clicked", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "API error" }),
      });

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Try Again")).toBeInTheDocument();
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, models: sampleModels }),
      });

      fireEvent.click(screen.getByText("Try Again"));

      await waitFor(() => {
        expect(screen.getByText("FLUX.1 Dev")).toBeInTheDocument();
      });
    });
  });

  describe("Empty State", () => {
    it("should show empty state when no models match search", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, models: [] }),
      });

      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("No models found")).toBeInTheDocument();
        expect(screen.getByText("Try adjusting your search or filters")).toBeInTheDocument();
      });
    });
  });

  describe("API Headers", () => {
    it("should include API keys in request headers", async () => {
      render(
        <TestWrapper>
          <ModelSearchDialog isOpen={true} onClose={vi.fn()} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
        const fetchCall = mockFetch.mock.calls[0];
        const options = fetchCall[1] as RequestInit;
        expect(options.headers).toEqual({
          "X-Replicate-Key": "test-replicate-key",
          "X-Fal-Key": "test-fal-key",
        });
      });
    });
  });
});
