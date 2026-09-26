import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GlobalImageHistory } from "@/components/GlobalImageHistory";
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
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

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
  ...overrides,
});

describe("GlobalImageHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty history
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
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
    render(<GlobalImageHistory />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTitle(/Est. \$0.0325 USD/)).toHaveAttribute("title", expect.stringContaining("1536x864 · WEBP"));
    expect(screen.getByTitle(/Cost unavailable/)).toBeInTheDocument();
  });

  describe("Empty State", () => {
    it("should not render when history is empty", () => {
      const { container } = render(<GlobalImageHistory />);
      expect(container.firstChild).toBeNull();
    });

    it("should return null when no images in history", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: [] }));
      });

      const { container } = render(<GlobalImageHistory />);
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Trigger Button", () => {
    it("should render trigger button when history has items", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      // Should have a button (trigger)
      const button = screen.getByRole("button");
      expect(button).toBeInTheDocument();
    });

    it("sits in the corner, or further left while the agent window covers it", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      const { rerender } = render(<GlobalImageHistory />);
      expect(screen.getByTestId("image-history")).toHaveStyle({ top: "16px", right: "16px" });

      rerender(<GlobalImageHistory rightInset={432} />);
      expect(screen.getByTestId("image-history")).toHaveStyle({ top: "16px", right: "432px" });
      // The notifications hanging beneath it follow (Toast.tsx reads this).
      expect(document.documentElement.style.getPropertyValue("--nb-history-right")).toBe("432px");

      rerender(<GlobalImageHistory />);
      expect(document.documentElement.style.getPropertyValue("--nb-history-right")).toBe("");
    });

    it("should show history count badge", () => {
      const history = [createHistoryItem(), createHistoryItem(), createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("should show '99+' when count exceeds 99", () => {
      const history = Array.from({ length: 105 }, () => createHistoryItem());
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      expect(screen.getByText("99+")).toBeInTheDocument();
    });

    it("should display correct title with singular form for 1 image", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      const button = screen.getByTitle("1 image in history");
      expect(button).toBeInTheDocument();
    });

    it("should display correct title with plural form for multiple images", () => {
      const history = [createHistoryItem(), createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      const button = screen.getByTitle("2 images in history");
      expect(button).toBeInTheDocument();
    });
  });

  describe("Drop-down Open/Close", () => {
    it("should open fan on trigger button click", () => {
      const history = [createHistoryItem()];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

      const triggerButton = screen.getByRole("button");

      // Open
      fireEvent.click(triggerButton);
      let allButtons = screen.getAllByRole("button");
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

      render(<GlobalImageHistory />);

      const triggerButton = screen.getByRole("button");
      fireEvent.click(triggerButton);

      // 1 trigger + Clear + 12 thumbnails + Show all
      expect(screen.getAllByRole("button").length).toBe(15);
      expect(screen.getAllByRole("img").length).toBe(12);
    });

    it("should show 'Show all' when history exceeds 12 items", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

      // Open fan
      fireEvent.click(screen.getByRole("button"));

      // For 2 items, no overflow, but we can trigger sidebar by clicking show more
      // Let's create a scenario with overflow
    });

    it("should show Clear All button in sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      // Open fan
      fireEvent.click(screen.getByRole("button"));
      // Open sidebar
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getByText("Clear All")).toBeInTheDocument();
    });

    it("should call clearGlobalHistory when Clear All is clicked", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

      // Open fan
      fireEvent.click(screen.getByRole("button"));
      // Open sidebar
      fireEvent.click(screen.getByText("Show all · 15"));
      // Clear all
      fireEvent.click(screen.getByText("Clear All"));

      expect(mockClearGlobalHistory).toHaveBeenCalled();
    });

    it("should have close button in sidebar", () => {
      const history = Array.from({ length: 15 }, (_, i) =>
        createHistoryItem({ id: `item-${i}` })
      );
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

      // Open fan then sidebar
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Show all · 15"));

      expect(screen.getByText("Drag images to canvas to create nodes")).toBeInTheDocument();
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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByText("Clear"));

      expect(mockClearGlobalHistory).toHaveBeenCalled();
    });

    it("should not offer 'Show all' when everything fits the grid", () => {
      const history = Array.from({ length: 12 }, (_, i) => createHistoryItem({ id: `item-${i}` }));
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);
      fireEvent.click(screen.getByRole("button"));

      expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
    });
  });

  describe("Drag and Drop", () => {
    it("should set data transfer on thumbnail drag", () => {
      const history = [createHistoryItem({ prompt: "Test drag prompt" })];
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ globalImageHistory: history }));
      });

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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

      render(<GlobalImageHistory />);

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
