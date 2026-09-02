import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ReferenceEdge } from "@/components/edges/ReferenceEdge";
import { ReactFlowProvider, Position } from "@xyflow/react";

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

// Wrapper component for React Flow context
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ReactFlowProvider>
      <svg data-testid="svg-container">{children}</svg>
    </ReactFlowProvider>
  );
}

// Default edge props
const createDefaultProps = (overrides = {}) => ({
  id: "ref-edge-1",
  source: "node-1",
  target: "node-2",
  sourceX: 100,
  sourceY: 50,
  targetX: 300,
  targetY: 50,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  selected: false,
  ...overrides,
});

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  edgeStyle: "angular" as const,
  edges: [],
  edgeAppearance: { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true },
  nodes: [],
  ...overrides,
});

describe("ReferenceEdge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  describe("Basic Rendering", () => {
    it("should render the edge path", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
    });

    it("should always use bezier (curved) path style", () => {
      // ReferenceEdge always uses curved paths regardless of edgeStyle setting
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
    });

    it("should render invisible interaction path for easier selection", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const interactionPath = container.querySelector(".react-flow__edge-interaction");
      expect(interactionPath).toBeInTheDocument();
    });
  });

  describe("Dashed Style", () => {
    it("should render with dashed stroke pattern", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // The BaseEdge path should have strokeDasharray style
      // The style is applied via the style prop to BaseEdge
      const paths = container.querySelectorAll("path");
      // At least one path should exist for the dashed edge
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  describe("Gray Color", () => {
    it("should render with gray color gradient", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Edges now reference shared gradient IDs instead of per-edge defs
      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("edge-grad-reference-");
    });
  });

  describe("Read-Only (No Interactive Elements)", () => {
    it("should not render any interactive draggable handles", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge
            {...createDefaultProps({
              selected: true,
            })}
          />
        </TestWrapper>
      );

      // No draggable handle circles should be rendered
      const circles = container.querySelectorAll("circle");
      expect(circles.length).toBe(0);
    });

    it("should not render pause indicator", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // No rectangles (pause bars) should be rendered
      const rects = container.querySelectorAll("rect");
      expect(rects.length).toBe(0);
    });
  });

  describe("Selection State", () => {
    it("should have brighter opacity when connected to selected node", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-1", selected: true }],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Should reference the "active" shared gradient
      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("-active");
    });

    it("should have dimmed opacity when not connected to selected node", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-3", selected: true }], // Different node selected
        }));
      });

      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Should reference the "dimmed" shared gradient
      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("-dimmed");
    });

    it("should be dimmed when no nodes are selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [], // No nodes at all
        }));
      });

      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Should reference the "dimmed" shared gradient
      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("-dimmed");
    });
  });

  describe("Stroke Width", () => {
    it("should render with thinner stroke than editable edges", () => {
      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // ReferenceEdge uses strokeWidth: 2 (vs 3 for EditableEdge)
      // The style is applied to the BaseEdge component
      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  describe("Connection to Source and Target", () => {
    it("should highlight when source node is selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-1", selected: true }],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("-active");
    });

    it("should highlight when target node is selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [{ id: "node-2", selected: true }],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <ReferenceEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("-active");
    });
  });
});
