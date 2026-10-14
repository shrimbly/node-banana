import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { GlobalImageHistory, groupRecentByBatch } from "@/components/GlobalImageHistory";
import { ImageHistoryItem } from "@/types";

// Mock createPortal for sidebar rendering
vi.mock("react-dom", async () => {
  const actual = await vi.importActual("react-dom");
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

// Mock the workflow store
const mockClearGlobalHistory = vi.fn();
const mockAddNode = vi.fn(() => "imageInput-9");
const mockUpdateNodeData = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      if (selector) {
        return mockUseWorkflowStore(selector);
      }
      return mockUseWorkflowStore((s: unknown) => s);
    },
    // useAddMediaNode selects the new node through the store.
    { getState: () => ({ nodes: [], onNodesChange: () => {} }) },
  ),
}));

// The asset library as the recorder last saw it. Most tests below cover the
// full list in its sidebar, which is what "Show all" opens without a library.
const libraryStatus = vi.hoisted(() => ({ current: null as { available: boolean } | null }));
vi.mock("@/lib/assets/client/recorder", () => ({
  getRecorderLibraryStatus: () => libraryStatus.current,
}));

import { useAssetStore } from "@/store/assetStore";

// Helper to create mock history items
const createHistoryItem = (overrides: Partial<ImageHistoryItem> = {}): ImageHistoryItem => ({
  id: `item-${Math.random().toString(36).substring(7)}`,
  image: "data:image/png;base64,mockImageData",
  timestamp: Date.now(),
  prompt: "A test prompt",
  aspectRatio: "1:1",
  model: "nano-banana",
  ...overrides,
});

// Default store state factory
const createDefaultState = (overrides: { globalImageHistory?: ImageHistoryItem[] } = {}) => ({
  globalImageHistory: [],
  clearGlobalHistory: mockClearGlobalHistory,
  addNode: mockAddNode,
  updateNodeData: mockUpdateNodeData,
  incrementModalCount: vi.fn(),
  decrementModalCount: vi.fn(),
  ...overrides,
});

// The viewer places nodes through React Flow, so the button needs its provider.
const wrapper = ReactFlowProvider;

describe("GlobalImageHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    libraryStatus.current = { available: false };
    useAssetStore.setState({ appView: "canvas" });
    // Default: empty history
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Assets hand-off", () => {
    const fifteen = () => Array.from({ length: 15 }, (_, i) => createHistoryItem({ id: `item-${i}` }));

    it("always offers Open Assets under the recent grid", () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: [createHistoryItem()] })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByRole("button", { name: "Open Assets" }));
      expect(useAssetStore.getState().appView).toBe("assets");
      // The drop-down closes on the way
      expect(screen.queryByRole("dialog", { name: "Recent generations" })).not.toBeInTheDocument();
    });

    it("opens Assets from Show all when the library is there", () => {
      libraryStatus.current = { available: true };
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: fifteen() })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));
      expect(useAssetStore.getState().appView).toBe("assets");
      expect(screen.queryByText("All History (15)")).not.toBeInTheDocument();
    });

    it("opens Assets from Show all before the library has answered", () => {
      libraryStatus.current = null;
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: fifteen() })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));
      expect(useAssetStore.getState().appView).toBe("assets");
    });

    it("says clearing the list keeps the files", () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: [createHistoryItem()] })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      expect(screen.getByText("Clear list")).toHaveAttribute("title", "Files stay in Assets");
    });

    it("closes its sidebar when the view switches to Assets", () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: fifteen() })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));
      expect(screen.getByText("All History (15)")).toBeInTheDocument();
      act(() => useAssetStore.getState().setAppView("assets"));
      expect(screen.queryByText("All History (15)")).not.toBeInTheDocument();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels usage costs as estimates and missing costs as unavailable", () => {
    const history = [
      createHistoryItem({ model: "GPT Image 2.5 Flare", generation: { modelId: "gpt-image-2.5-flare", parameters: {}, size: "1536x864", outputFormat: "webp", cost: { amount: 0.0325, currency: "USD", estimated: true } } }),
      createHistoryItem({ model: "GPT Image 2.5 Sunburst", generation: { modelId: "gpt-image-2.5-sunburst", parameters: {} } }),
    ];
    mockUseWorkflowStore.mockImplementation(selector => selector(createDefaultState({ globalImageHistory: history })));
    render(<GlobalImageHistory />, { wrapper });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTitle(/Est. \$0.0325 USD/)).toHaveAttribute("title", expect.stringContaining("1536x864 · WEBP"));
    expect(screen.getByTitle(/Cost unavailable/)).toBeInTheDocument();
  });

  describe("Empty State", () => {
    it("should not render when history is empty", () => {
      const { container } = render(<GlobalImageHistory />, { wrapper });
      expect(container.firstChild).toBeNull();
    });

    it("should return null when no images in history", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: [] }));
      });

      const { container } = render(<GlobalImageHistory />, { wrapper });
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Trigger Button", () => {
    it("should render trigger button when history has items", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Should have a button (trigger)
      const button = screen.getByRole("button");
      expect(button).toBeInTheDocument();
    });

    it("sits in the corner, or further left while the agent window covers it", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      const { rerender } = render(<GlobalImageHistory />, { wrapper });
      expect(screen.getByTestId("image-history")).toHaveStyle({ top: "16px", right: "16px" });

      rerender(<GlobalImageHistory rightInset={432} anchorRight={432} />);
      expect(screen.getByTestId("image-history")).toHaveStyle({ top: "16px", right: "432px" });
      // The notifications hanging beneath it follow (Toast.tsx reads this).
      expect(document.documentElement.style.getPropertyValue("--nb-history-right")).toBe("432px");

      rerender(<GlobalImageHistory />);
      expect(document.documentElement.style.getPropertyValue("--nb-history-right")).toBe("");
    });

    it("hangs the drop-down and the notifications from the window's edge while the agent window is closed", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      // Beside the agent pill: the button is 116px in, the drop-down still hugs the edge at 16px.
      render(<GlobalImageHistory rightInset={116} anchorRight={16} />, { wrapper });
      expect(document.documentElement.style.getPropertyValue("--nb-history-right")).toBe("");
      fireEvent.click(screen.getByRole("button"));
      const dropdown = screen.getByRole("dialog", { name: "Recent generations" });
      expect(dropdown).toHaveStyle({ right: "-100px", top: "50px", width: "344px" });
    });

    it("should show history count badge", () => {
      const history = [createHistoryItem(), createHistoryItem(), createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("should show '99+' when count exceeds 99", () => {
      const history = Array.from({ length: 105 }, () => createHistoryItem());
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      expect(screen.getByText("99+")).toBeInTheDocument();
    });

    it("should display correct title with singular form for 1 image", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      const button = screen.getByTitle("1 image in history");
      expect(button).toBeInTheDocument();
    });

    it("should display correct title with plural form for multiple images", () => {
      const history = [createHistoryItem(), createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      const button = screen.getByTitle("2 images in history");
      expect(button).toBeInTheDocument();
    });
  });

  describe("Batches", () => {
    const batch = (index: number) => ({ id: "b1", index, count: 3 });

    it("groups neighbouring outputs of one batch, and of no batch", () => {
      const items = [
        createHistoryItem({ id: "single-new" }),
        createHistoryItem({ id: "r3", batch: batch(3), timestamp: 3000 }),
        createHistoryItem({ id: "r2", batch: batch(2), timestamp: 2000 }),
        createHistoryItem({ id: "r1", batch: batch(1), timestamp: 1000 }),
        createHistoryItem({ id: "old-1" }),
        createHistoryItem({ id: "old-2" }),
      ];
      const sections = groupRecentByBatch(items);
      expect(sections.map((section) => section.items.map(({ item }) => item.id))).toEqual([
        ["single-new"],
        ["r3", "r2", "r1"],
        ["old-1", "old-2"],
      ]);
      expect(sections[1].batch).toEqual({ count: 3, startedAt: 1000 });
      expect(sections[0].batch).toBeUndefined();
      // Indexes stay those of the whole list, which the viewer opens
      expect(sections[2].items[0].index).toBe(4);
    });

    it("heads a batch in the drop-down and numbers each run", () => {
      const history = [
        createHistoryItem({ id: "r2", batch: batch(2) }),
        createHistoryItem({ id: "r1", batch: batch(1) }),
        createHistoryItem({ id: "old" }),
      ];
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: history })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      expect(screen.getByText("Batch · 3 runs")).toBeInTheDocument();
      expect(screen.getByText("Earlier")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("1")).toBeInTheDocument();
    });
  });

  describe("Drop-down Open/Close", () => {
    it("should open fan on trigger button click", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      const triggerButton = screen.getByRole("button");
      fireEvent.click(triggerButton);

      // Should show fan items (draggable buttons with images)
      const fanItems = screen.getAllByRole("button");
      // One trigger button + fan items
      expect(fanItems.length).toBeGreaterThan(1);
    });

    it("should close fan when trigger button is clicked again", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      const triggerButton = screen.getByRole("button");

      // Open
      fireEvent.click(triggerButton);
      const allButtons = screen.getAllByRole("button");
      expect(allButtons.length).toBeGreaterThan(1);

      // Close (click trigger again - first button)
      fireEvent.click(allButtons[0]);
    });

    it("should show max 12 items in the drop-down", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      const triggerButton = screen.getByRole("button");
      fireEvent.click(triggerButton);

      // 1 trigger + Clear list + 12 thumbnails + Show all + Open Assets
      expect(screen.getAllByRole("button").length).toBe(16);
      expect(screen.getAllByRole("img").length).toBe(12);
    });

    it("should show 'Show all' when history exceeds 12 items", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      const triggerButton = screen.getByRole("button");
      fireEvent.click(triggerButton);

      expect(screen.getByText("Show all · 15")).toBeInTheDocument();
    });
  });

  describe("History Sidebar", () => {
    it("should open sidebar when 'Show all' is clicked", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}`, prompt: `Prompt ${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      const triggerButton = screen.getByRole("button");
      fireEvent.click(triggerButton);

      // Click show more
      const showMoreButton = screen.getByText("Show all · 15");
      fireEvent.click(showMoreButton);

      // Sidebar should show "All History (15)"
      expect(screen.getByText("All History (15)")).toBeInTheDocument();
    });

    it("should display all history items in sidebar", () => {
      const history = [
        createHistoryItem({ id: "1", prompt: "First prompt" }),
        createHistoryItem({ id: "2", prompt: "Second prompt" }),
      ];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      fireEvent.click(screen.getByRole("button"));

      // For 2 items, no overflow, but we can trigger sidebar by clicking show more
      // Let's create a scenario with overflow
    });

    it("should show Clear list in the sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      fireEvent.click(screen.getByRole("button"));
      // Open sidebar
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getByText("Clear list")).toBeInTheDocument();
    });

    it("should call clearGlobalHistory when Clear list is clicked in the sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      fireEvent.click(screen.getByRole("button"));
      // Open sidebar
      fireEvent.click(screen.getByText("Show all · 15"));
      // Clear all
      fireEvent.click(screen.getByText("Clear list"));

      expect(mockClearGlobalHistory).toHaveBeenCalled();
    });

    it("should have close button in sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      // Close button has title "Close"
      const closeButton = screen.getByTitle("Close");
      expect(closeButton).toBeInTheDocument();
    });

    it("should show drag instruction footer", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getByText("Click to view · drag onto the canvas")).toBeInTheDocument();
    });
  });

  describe("Model Display", () => {
    it("should show 'Pro' for nano-banana-pro model in sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}`, model: "nano-banana-pro" })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      // Check for "Pro" text (it appears in the format "Xm ago . Pro")
      const proLabels = screen.getAllByText(/Pro/);
      expect(proLabels.length).toBeGreaterThan(0);
    });

    it("should show 'Standard' for nano-banana model in sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}`, model: "nano-banana" })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      // Check for "Standard" text
      const standardLabels = screen.getAllByText(/Standard/);
      expect(standardLabels.length).toBeGreaterThan(0);
    });
  });

  describe("Prompt Display", () => {
    it("should show truncated prompt in sidebar", () => {
      const longPrompt = "A very long prompt that exceeds sixty characters and should be truncated properly";
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}`, prompt: longPrompt })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      // Should show truncated version (first 60 chars)
      expect(screen.getAllByText(/A very long prompt/).length).toBeGreaterThan(0);
    });

    it("should show 'No prompt' when prompt is empty", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}`, prompt: "" })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getAllByText("No prompt").length).toBeGreaterThan(0);
    });
  });

  describe("Drop-down Clear", () => {
    it("should call clearGlobalHistory from the drop-down header", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Clear list"));

      expect(mockClearGlobalHistory).toHaveBeenCalled();
    });

    it("should not offer 'Show all' when everything fits the grid", () => {
      const history = Array.from({ length: 12 }, (_, i) => createHistoryItem({ id: `item-${i}` }));
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));

      expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
    });
  });

  describe("Viewer", () => {
    const three = () => [
      createHistoryItem({ id: "h-1", prompt: "First prompt", model: "nano-banana-pro", timestamp: Date.now() - 120_000, generation: { modelId: "nano-banana-pro", parameters: {}, size: "1536x1024", outputFormat: "png", cost: { amount: 0.134, currency: "USD", estimated: false } } }),
      createHistoryItem({ id: "h-2", prompt: "Second prompt" }),
      createHistoryItem({ id: "h-3", prompt: "" }),
    ];

    it("opens full screen on a thumbnail, over the whole history, and closes the drop-down", () => {
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: three() })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      expect(screen.getByText("Click to view · drag onto the canvas")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "View Second prompt" }));

      const viewer = screen.getByRole("dialog", { name: "Recent generation" });
      expect(screen.queryByRole("dialog", { name: "Recent generations" })).not.toBeInTheDocument();
      const rail = screen.getByTestId("media-viewer-rail");
      expect(rail).toHaveTextContent("2 of 3");
      expect(rail).toHaveTextContent("Second prompt");
      expect(screen.getByRole("button", { name: "Add to graph" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open in Assets" })).toBeInTheDocument();

      // Stepping back shows what made the first one
      fireEvent.keyDown(document, { key: "ArrowLeft" });
      expect(rail).toHaveTextContent("1 of 3");
      expect(rail).toHaveTextContent("Nano Banana Pro");
      expect(rail).toHaveTextContent("1536x1024");
      expect(rail).toHaveTextContent("$0.1340 USD");
      // A promptless item is titled as such
      fireEvent.keyDown(document, { key: "ArrowRight" });
      fireEvent.keyDown(document, { key: "ArrowRight" });
      expect(rail).toHaveTextContent("No prompt");
      expect(viewer).toBeInTheDocument();
    });

    it("adds the image to the graph as an Image Input node and says so for a moment", () => {
      vi.useFakeTimers();
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: three() })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByRole("button", { name: "View First prompt" }));

      fireEvent.click(screen.getByRole("button", { name: "Add to graph" }));
      expect(mockAddNode).toHaveBeenCalledWith("imageInput", expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }), {
        image: "data:image/png;base64,mockImageData",
        filename: expect.stringMatching(/^history-\d+\.png$/),
      });
      // The viewer stays up; the button confirms, then is ready again
      expect(screen.getByRole("button", { name: "Added" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByRole("button", { name: "Add to graph" })).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Recent generation" })).toBeInTheDocument();
    });

    it("opens from a row of the full list too", () => {
      const history = Array.from({ length: 15 }, (_, i) => createHistoryItem({ id: `item-${i}`, prompt: `Prompt ${i}` }));
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ globalImageHistory: history })));
      render(<GlobalImageHistory />, { wrapper });
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));
      fireEvent.click(screen.getByText("Prompt 13"));
      expect(screen.getByTestId("media-viewer-rail")).toHaveTextContent("14 of 15");
      expect(screen.queryByText("All History (15)")).not.toBeInTheDocument();
    });
  });

  describe("Drag and Drop", () => {
    it("should set data transfer on thumbnail drag", () => {
      const history = [createHistoryItem({ prompt: "Test drag prompt" })];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      fireEvent.click(screen.getByRole("button"));

      // Thumbnails follow the trigger and the Clear button
      const buttons = screen.getAllByRole("button");
      const fanItem = buttons[2];

      const mockDataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
      };

      fireEvent.dragStart(fanItem, { dataTransfer: mockDataTransfer });

      expect(mockDataTransfer.setData).toHaveBeenCalledWith(
        "application/history-image",
        expect.stringContaining("Test drag prompt")
      );
      expect(mockDataTransfer.effectAllowed).toBe("copy");
    });

    it("should set data transfer on sidebar item drag", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}`, prompt: `Prompt ${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      // Find a draggable item in sidebar (it's a div, not a button)
      const sidebarItems = document.querySelectorAll("[draggable='true']");
      expect(sidebarItems.length).toBeGreaterThan(0);

      const mockDataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
      };

      fireEvent.dragStart(sidebarItems[0], { dataTransfer: mockDataTransfer });

      expect(mockDataTransfer.setData).toHaveBeenCalledWith(
        "application/history-image",
        expect.any(String)
      );
    });
  });

  describe("Relative Time Display", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("should show 'Just now' for recent timestamps", () => {
      vi.setSystemTime(new Date("2024-01-15T12:00:30"));

      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({
          id: `item-${i}`,
          timestamp: new Date("2024-01-15T12:00:00").getTime()
        })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getAllByText(/Just now/).length).toBeGreaterThan(0);
    });

    it("should show minutes ago for timestamps within an hour", () => {
      vi.setSystemTime(new Date("2024-01-15T12:10:00"));

      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({
          id: `item-${i}`,
          timestamp: new Date("2024-01-15T12:00:00").getTime()
        })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getAllByText(/10m ago/).length).toBeGreaterThan(0);
    });

    it("should show hours ago for timestamps over an hour", () => {
      vi.setSystemTime(new Date("2024-01-15T14:00:00"));

      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({
          id: `item-${i}`,
          timestamp: new Date("2024-01-15T12:00:00").getTime()
        })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getAllByText(/2h ago/).length).toBeGreaterThan(0);
    });
  });

  describe("Image Thumbnails", () => {
    it("should render image thumbnails in the drop-down", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      fireEvent.click(screen.getByRole("button"));

      const images = screen.getAllByRole("img");
      expect(images.length).toBeGreaterThan(0);
      expect(images[0]).toHaveAttribute("src", "data:image/png;base64,mockImageData");
    });

    it("should render image thumbnails in sidebar view", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      const images = screen.getAllByRole("img");
      // 15 items in sidebar
      expect(images.length).toBe(15);
    });
  });

  describe("Keyboard Navigation", () => {
    it("should close sidebar on Escape key", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getByText("All History (15)")).toBeInTheDocument();

      // Press Escape
      fireEvent.keyDown(document, { key: "Escape" });

      // Sidebar should close
      expect(screen.queryByText("All History (15)")).not.toBeInTheDocument();
    });

    it("should close fan on Escape key when sidebar is not open", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />, { wrapper });

      // Open fan
      fireEvent.click(screen.getByRole("button"));

      // Verify fan is open (more than 1 button)
      let buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(1);

      // Press Escape
      fireEvent.keyDown(document, { key: "Escape" });

      // Drop-down should close - only trigger button remains
      buttons = screen.getAllByRole("button");
      expect(buttons.length).toBe(1);
    });
  });
});
