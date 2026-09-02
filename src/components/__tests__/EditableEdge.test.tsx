import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditableEdge } from "@/components/edges/EditableEdge";
import { ReactFlowProvider, Position } from "@xyflow/react";

// Mock the workflow store
const mockSetEdges = vi.fn();
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
vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      setEdges: mockSetEdges,
    }),
  };
});

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
  id: "edge-1",
  source: "node-1",
  target: "node-2",
  sourceX: 100,
  sourceY: 50,
  targetX: 300,
  targetY: 50,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  selected: false,
  sourceHandleId: "image",
  targetHandleId: "image",
  data: {},
  ...overrides,
});

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  edgeStyle: "angular" as const,
  nodes: [],
  ...overrides,
});

describe("EditableEdge", () => {
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
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // BaseEdge renders a path element
      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
    });

    it("should render with smooth step path when edgeStyle is angular", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ edgeStyle: "angular" }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
    });

    it("should render with bezier path when edgeStyle is curved", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ edgeStyle: "curved" }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const paths = container.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
    });

    it("should render invisible interaction path for easier selection", () => {
      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      const interactionPath = container.querySelector(".react-flow__edge-interaction");
      expect(interactionPath).toBeInTheDocument();
    });
  });

  describe("Edge Colors", () => {
    it("should use green color for image handle type", () => {
      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps({ sourceHandleId: "image" })} />
        </TestWrapper>
      );

      // Edges now reference shared gradient IDs instead of per-edge defs
      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("edge-grad-image-");
    });

    it("should use blue color for prompt handle type", () => {
      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps({ sourceHandleId: "prompt" })} />
        </TestWrapper>
      );

      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("edge-grad-text-");
    });

    it("should use orange color when edge is paused", () => {
      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              data: { hasPause: true },
            })}
          />
        </TestWrapper>
      );

      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("edge-grad-pause-");
    });
  });

  describe("Pause Indicator", () => {
    it("should render pause indicator when edge has pause", () => {
      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              data: { hasPause: true },
            })}
          />
        </TestWrapper>
      );

      // Pause indicator includes rectangles (pause bars) inside a group
      const rects = container.querySelectorAll("rect");
      expect(rects.length).toBeGreaterThan(0);
    });

    it("should not render pause indicator when edge is not paused", () => {
      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              data: { hasPause: false },
            })}
          />
        </TestWrapper>
      );

      // No pause bars should be rendered (only paths for edge)
      const rects = container.querySelectorAll("rect");
      expect(rects.length).toBe(0);
    });
  });

  describe("Draggable Handles", () => {
    it("should render draggable handles when edge is selected in angular mode", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ edgeStyle: "angular" }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              selected: true,
              sourceX: 0,
              targetX: 200, // Distance > 50 to show handles
            })}
          />
        </TestWrapper>
      );

      // Draggable handles are circles
      const circles = container.querySelectorAll("circle");
      expect(circles.length).toBeGreaterThan(0);
    });

    it("should not render draggable handles when edge is not selected", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ edgeStyle: "angular" }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              selected: false,
            })}
          />
        </TestWrapper>
      );

      // Only the pause indicator circle might appear, but not drag handles
      // Filter for filled white circles (drag handles)
      const circles = container.querySelectorAll("circle[fill='white']");
      expect(circles.length).toBe(0);
    });

    it("should not render draggable handles in curved mode", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ edgeStyle: "curved" }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              selected: true,
            })}
          />
        </TestWrapper>
      );

      // No drag handles in curved mode
      const circles = container.querySelectorAll("circle[fill='white']");
      expect(circles.length).toBe(0);
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
          <EditableEdge {...createDefaultProps()} />
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
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Should reference the "dimmed" shared gradient
      const basePath = container.querySelector(".react-flow__edge-path");
      const stroke = basePath?.getAttribute("style") ?? "";
      expect(stroke).toContain("-dimmed");
    });
  });

  describe("Loading Animation", () => {
    it("should show pulse animation when target node is loading", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            { id: "node-1", type: "prompt", selected: false },
            { id: "node-2", type: "nanoBanana", selected: false, data: { status: "loading" } },
          ],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Should have additional animated paths for loading state
      const paths = container.querySelectorAll("path");
      // More paths than just the base edge (loading animation paths)
      expect(paths.length).toBeGreaterThan(2);
    });

    it("should not show pulse animation when target node is not loading", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          nodes: [
            { id: "node-1", type: "prompt", selected: false },
            { id: "node-2", type: "nanoBanana", selected: false, data: { status: "idle" } },
          ],
        }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps()} />
        </TestWrapper>
      );

      // Fewer paths - no animation paths
      const paths = container.querySelectorAll("path");
      // Base edge path + interaction path = 2 minimum
      expect(paths.length).toBeLessThanOrEqual(3);
    });
  });

  describe("Handle Dragging", () => {
    it("should start dragging on mousedown on handle", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({ edgeStyle: "angular" }));
      });

      const { container } = render(
        <TestWrapper>
          <EditableEdge
            {...createDefaultProps({
              selected: true,
              sourceX: 0,
              targetX: 200,
            })}
          />
        </TestWrapper>
      );

      const handle = container.querySelector("circle[fill='white']");
      if (handle) {
        fireEvent.mouseDown(handle, { clientX: 100, clientY: 50 });
        // The component should enter dragging state
        // The actual drag behavior requires document-level event listeners
      }
    });
  });
});
