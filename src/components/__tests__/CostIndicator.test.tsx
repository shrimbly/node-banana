import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CostIndicator } from "@/components/CostIndicator";
import { WorkflowNode } from "@/types";

// Mock the workflow store
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// Mock CostDialog
vi.mock("@/components/CostDialog", () => ({
  CostDialog: ({ predictedCost, incurredCost, onClose }: {
    predictedCost: { totalCost: number };
    incurredCost: number;
    onClose: () => void
  }) => (
    <div data-testid="cost-dialog">
      <span data-testid="dialog-predicted-cost">${predictedCost.totalCost.toFixed(2)}</span>
      <span data-testid="dialog-incurred-cost">${incurredCost.toFixed(2)}</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// Default store state factory
const createDefaultState = (overrides: { nodes?: WorkflowNode[]; incurredCost?: number } = {}) => ({
  nodes: [] as WorkflowNode[],
  incurredCost: 0,
  ...overrides,
});

describe("CostIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation - no nodes
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Basic Rendering", () => {
    it("should not render when there are no nodes and incurredCost is 0", () => {
      render(<CostIndicator />);

      expect(screen.queryByTitle("Estimated workflow cost (click for details)")).not.toBeInTheDocument();
    });

    it("should render when there are generation nodes", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      expect(screen.getByTitle("Estimated workflow cost (click for details)")).toBeInTheDocument();
    });

    it("should render when incurredCost is greater than 0", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ incurredCost: 0.50 }));
      });

      render(<CostIndicator />);

      expect(screen.getByTitle("Estimated workflow cost (click for details)")).toBeInTheDocument();
    });
  });

  describe("Zero Cost Display", () => {
    it("should display $0.00 when nodes exist but cost is 0", () => {
      // A prompt node doesn't generate costs
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "prompt",
          position: { x: 0, y: 0 },
          data: {
            prompt: "test",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes, incurredCost: 0.01 }));
      });

      render(<CostIndicator />);

      expect(screen.getByText("$0.00")).toBeInTheDocument();
    });
  });

  describe("Non-zero Cost Display", () => {
    it("should format cost correctly for nano-banana model", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // nano-banana costs $0.039/image
      expect(screen.getByText("$0.04")).toBeInTheDocument();
    });

    it("should format cost correctly for nano-banana-pro model", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana-pro",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // nano-banana-pro 1K costs $0.134/image
      expect(screen.getByText("$0.13")).toBeInTheDocument();
    });

    it("should format cost correctly for 4K resolution", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana-pro",
            resolution: "4K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // nano-banana-pro 4K costs $0.24/image
      expect(screen.getByText("$0.24")).toBeInTheDocument();
    });

    it("should sum costs for multiple generation nodes", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
        {
          id: "node-2",
          type: "nanoBanana",
          position: { x: 100, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // 2 * $0.039 = $0.078
      expect(screen.getByText("$0.08")).toBeInTheDocument();
    });
  });

  describe("CostDialog Opening", () => {
    it("should open CostDialog when clicked", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      const button = screen.getByTitle("Estimated workflow cost (click for details)");
      fireEvent.click(button);

      expect(screen.getByTestId("cost-dialog")).toBeInTheDocument();
    });

    it("should close CostDialog when onClose is called", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // Open dialog
      fireEvent.click(screen.getByTitle("Estimated workflow cost (click for details)"));
      expect(screen.getByTestId("cost-dialog")).toBeInTheDocument();

      // Close dialog
      fireEvent.click(screen.getByText("Close"));
      expect(screen.queryByTestId("cost-dialog")).not.toBeInTheDocument();
    });

    it("should pass correct predictedCost to CostDialog", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      fireEvent.click(screen.getByTitle("Estimated workflow cost (click for details)"));

      // nano-banana costs $0.039
      expect(screen.getByTestId("dialog-predicted-cost")).toHaveTextContent("$0.04");
    });

    it("should pass correct incurredCost to CostDialog", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes, incurredCost: 1.25 }));
      });

      render(<CostIndicator />);

      fireEvent.click(screen.getByTitle("Estimated workflow cost (click for details)"));

      expect(screen.getByTestId("dialog-incurred-cost")).toHaveTextContent("$1.25");
    });
  });

  describe("Cost Updates", () => {
    it("should update displayed cost when nodes change", () => {
      const initialNodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes: initialNodes }));
      });

      const { rerender } = render(<CostIndicator />);

      // Initial cost: $0.039 = $0.04
      expect(screen.getByText("$0.04")).toBeInTheDocument();

      // Update to more nodes
      const updatedNodes: WorkflowNode[] = [
        ...initialNodes,
        {
          id: "node-2",
          type: "nanoBanana",
          position: { x: 100, y: 0 },
          data: {
            model: "nano-banana-pro",
            resolution: "4K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes: updatedNodes }));
      });

      rerender(<CostIndicator />);

      // Updated cost: $0.039 + $0.24 = $0.279 = $0.28
      expect(screen.getByText("$0.28")).toBeInTheDocument();
    });

    it("should update when incurredCost changes", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ incurredCost: 0.50 }));
      });

      const { rerender } = render(<CostIndicator />);

      // $0.00 predicted (no generation nodes), but should show due to incurredCost
      expect(screen.getByText("$0.00")).toBeInTheDocument();

      // Update incurredCost
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ incurredCost: 1.00 }));
      });

      rerender(<CostIndicator />);

      // Still shows predicted cost $0.00 in the button
      expect(screen.getByText("$0.00")).toBeInTheDocument();
    });
  });

  describe("SplitGrid Nodes", () => {
    it("should include splitGrid costs when configured", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "splitGrid",
          position: { x: 0, y: 0 },
          data: {
            isConfigured: true,
            targetCount: 4,
            generateSettings: {
              model: "nano-banana",
              resolution: "1K",
            },
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // 4 * $0.039 = $0.156 = $0.16
      expect(screen.getByText("$0.16")).toBeInTheDocument();
    });

    it("should not include unconfigured splitGrid costs", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "splitGrid",
          position: { x: 0, y: 0 },
          data: {
            isConfigured: false,
            targetCount: 0,
            generateSettings: {
              model: "nano-banana",
              resolution: "1K",
            },
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // Should not render when no configured nodes
      expect(screen.queryByTitle("Estimated workflow cost (click for details)")).not.toBeInTheDocument();
    });
  });

  describe("Non-Gemini Provider Display", () => {
    it("should render $0.00 when a nanoBanana node has a non-Gemini selectedModel", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
            selectedModel: {
              provider: "fal",
              modelId: "fal-ai/flux",
              displayName: "Flux",
            },
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      // Non-Gemini nodes show $0.00 (no pricing data available)
      expect(screen.getByTitle("Estimated workflow cost (click for details)")).toBeInTheDocument();
      expect(screen.getByText("$0.00")).toBeInTheDocument();
    });

    it("should render when a nanoBanana node has selectedModel with provider gemini", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
            selectedModel: {
              provider: "gemini",
              modelId: "nano-banana",
              displayName: "Nano Banana",
            },
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      expect(screen.getByTitle("Estimated workflow cost (click for details)")).toBeInTheDocument();
    });

    it("should render when a nanoBanana node has no selectedModel (legacy Gemini)", () => {
      const nodes: WorkflowNode[] = [
        {
          id: "node-1",
          type: "nanoBanana",
          position: { x: 0, y: 0 },
          data: {
            model: "nano-banana",
            resolution: "1K",
          },
        },
      ];

      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ nodes }));
      });

      render(<CostIndicator />);

      expect(screen.getByTitle("Estimated workflow cost (click for details)")).toBeInTheDocument();
    });
  });
});
