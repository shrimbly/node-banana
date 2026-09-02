import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditableEdge } from "@/components/edges/EditableEdge";
import { ReactFlowProvider, Position } from "@xyflow/react";

// Mock the workflow store
const mockSetEdges = vi.fn();
const mockSetEdgesHidden = vi.fn();
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
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
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
  edges: [],
  setEdgesHidden: mockSetEdgesHidden,
  edgeAppearance: { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels: "hover" as const },
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

describe("EditableEdge appearance settings", () => {
  const baseAppearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels: "hover" as const };
  const withState = (overrides: Record<string, unknown>) => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: baseAppearance, ...overrides }))
    );
  };
  const renderEdge = (props = {}) => {
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps(props)} />
      </TestWrapper>
    );
    return container;
  };
  const baseStyle = (container: HTMLElement) =>
    container.querySelector(".react-flow__edge-path")?.getAttribute("style") ?? "";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the thickness setting for the stroke width", () => {
    withState({ edgeAppearance: { ...baseAppearance, thickness: "thick" } });
    expect(baseStyle(renderEdge())).toContain("stroke-width: 5");
  });

  it("draws a solid stroke faded to the setting when the gradient is off", () => {
    withState({ edgeAppearance: { ...baseAppearance, gradient: false, fadedOpacity: 0.4 } });
    const style = baseStyle(renderEdge());
    expect(style).not.toContain("url(#");
    expect(style).toContain("stroke-opacity: 0.4");
  });

  it("keeps a solid stroke at full opacity when attached to a selected node", () => {
    withState({
      edgeAppearance: { ...baseAppearance, gradient: false, fadedOpacity: 0.4 },
      nodes: [{ id: "node-1", selected: true, type: "prompt", data: {}, position: { x: 0, y: 0 } }],
    });
    expect(baseStyle(renderEdge())).toContain("stroke-opacity: 1");
  });

  it("draws a straight line when the style is straight", () => {
    withState({ edgeStyle: "straight" });
    const d = renderEdge().querySelector(".react-flow__edge-path")?.getAttribute("d") ?? "";
    expect(d).toContain("L");
    expect(d).not.toMatch(/[CQ]/);
  });

  it("shows the loading pulse while the target generates", () => {
    withState({
      nodes: [{ id: "node-2", type: "nanoBanana", data: { status: "loading" }, position: { x: 0, y: 0 } }],
    });
    expect(renderEdge().querySelector('path[stroke-dasharray="20 30"]')).not.toBeNull();
  });

  it("skips the loading pulse when the setting is off", () => {
    withState({
      edgeAppearance: { ...baseAppearance, loadingPulse: false },
      nodes: [{ id: "node-2", type: "nanoBanana", data: { status: "loading" }, position: { x: 0, y: 0 } }],
    });
    expect(renderEdge().querySelector('path[stroke-dasharray="20 30"]')).toBeNull();
  });
});

describe("EditableEdge toolbar and highlight", () => {
  const baseAppearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels: "hover" as const };
  const stateWith = (overrides: Record<string, unknown>) =>
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: baseAppearance, ...overrides }))
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the toolbar when it is the first selected edge", () => {
    stateWith({ edges: [{ id: "edge-1", selected: true, source: "node-1", target: "node-2", data: {} }] });
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ selected: true })} />
      </TestWrapper>
    );
    expect(container.querySelector('[data-testid="edge-toolbar"]')).not.toBeNull();
  });

  it("leaves the toolbar to the first selected edge when several are selected", () => {
    stateWith({
      edges: [
        { id: "edge-0", selected: true, source: "x", target: "y", data: {} },
        { id: "edge-1", selected: true, source: "node-1", target: "node-2", data: {} },
      ],
    });
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ selected: true })} />
      </TestWrapper>
    );
    expect(container.querySelector('[data-testid="edge-toolbar"]')).toBeNull();
  });

  it("shows no toolbar when not selected", () => {
    stateWith({ edges: [{ id: "edge-1", selected: false, source: "node-1", target: "node-2", data: {} }] });
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ selected: false })} />
      </TestWrapper>
    );
    expect(container.querySelector('[data-testid="edge-toolbar"]')).toBeNull();
  });

  it("exposes its active stroke for the hover and selected highlight", () => {
    stateWith({});
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps()} />
      </TestWrapper>
    );
    const style = container.querySelector(".react-flow__edge-path")?.getAttribute("style") ?? "";
    expect(style).toContain("--edge-stroke-active: url(#edge-grad-image-active)");
  });
});

describe("EditableEdge when hidden", () => {
  const baseAppearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels: "hover" as const };
  const hiddenEdge = { id: "edge-1", source: "node-1", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { hidden: true } };
  const renderHidden = (edges: unknown[] = [hiddenEdge]) => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: baseAppearance, edges }))
    );
    return render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hidden: true } })} />
      </TestWrapper>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws labelled stubs instead of the line", () => {
    const { container } = renderHidden();
    expect(container.querySelector(".react-flow__edge-path")).toBeNull();
    expect(container.querySelector(".react-flow__edge-interaction")).toBeNull();
    expect(screen.getByTestId("hidden-edge-stub-source")).toHaveTextContent("Image");
    expect(screen.getByTestId("hidden-edge-stub-target")).toHaveTextContent("Image");
  });

  it("labels the stub with the image order among siblings", () => {
    renderHidden([
      { id: "edge-0", source: "x", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { createdAt: 1 } },
      { ...hiddenEdge, data: { hidden: true, createdAt: 2 } },
    ]);
    expect(screen.getByTestId("hidden-edge-stub-target")).toHaveTextContent("Image 2");
  });

  it("stacks stubs below earlier hidden siblings on the same handle", () => {
    renderHidden([
      { id: "edge-0", source: "x", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { hidden: true, createdAt: 1 } },
      { ...hiddenEdge, data: { hidden: true, createdAt: 2 } },
    ]);
    // Target handle is at y=50; the second hidden stub sits one row (22px) lower
    expect(screen.getByTestId("hidden-edge-stub-target").style.transform).toContain("72px");
    // Nothing else leaves node-1's handle, so the source stub stays on the handle
    expect(screen.getByTestId("hidden-edge-stub-source").style.transform).toContain("50px");
  });

  it("ghosts the line while a stub is hovered", () => {
    const { container } = renderHidden();
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).not.toBeNull();
    fireEvent.mouseLeave(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).toBeNull();
  });

  it("shows the connection again when a stub is clicked", () => {
    renderHidden();
    fireEvent.click(screen.getByTestId("hidden-edge-stub-source").querySelector("button")!);
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["edge-1"], false);
  });
});

describe("EditableEdge labels", () => {
  const appearance = (labels: "always" | "hover" | "never") => ({
    thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true, labels,
  });
  const visibleEdge = (data: Record<string, unknown> = {}) => ({
    id: "edge-1", source: "node-1", sourceHandle: "image", target: "node-2", targetHandle: "image", data,
  });
  const renderWith = (labels: "always" | "hover" | "never", edges: unknown[], props = {}) => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: appearance(labels), edges }))
    );
    return render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps(props)} />
      </TestWrapper>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the automatic label when labels are always on", () => {
    renderWith("always", [visibleEdge()]);
    expect(screen.getByTestId("edge-label")).toHaveTextContent("Image");
  });

  it("shows the automatic label only on hover in hover mode", () => {
    const { container } = renderWith("hover", [visibleEdge()]);
    expect(screen.queryByTestId("edge-label")).toBeNull();
    fireEvent.mouseEnter(container.querySelector('[data-testid="edge-hover-area"]')!);
    expect(screen.getByTestId("edge-label")).toHaveTextContent("Image");
    fireEvent.mouseLeave(container.querySelector('[data-testid="edge-hover-area"]')!);
    expect(screen.queryByTestId("edge-label")).toBeNull();
  });

  it("shows the automatic label while selected in hover mode", () => {
    renderWith("hover", [visibleEdge()], { selected: true });
    expect(screen.getByTestId("edge-label")).toHaveTextContent("Image");
  });

  it("always shows a typed label, even with labels off", () => {
    renderWith("never", [visibleEdge({ label: "hero shot" })], { data: { label: "hero shot" } });
    expect(screen.getByTestId("edge-label")).toHaveTextContent("hero shot");
  });

  it("hides automatic labels when labels are off", () => {
    renderWith("never", [visibleEdge()]);
    expect(screen.queryByTestId("edge-label")).toBeNull();
  });

  it("puts the loop count in the label on loop edges", () => {
    renderWith("never", [visibleEdge({ isLoop: true, loopCount: 4 })], { data: { isLoop: true, loopCount: 4 } });
    expect(screen.getByTestId("edge-label-loop")).toHaveTextContent("4×");
  });

  it("offsets labels of parallel connections between the same nodes", () => {
    renderWith("always", [
      { ...visibleEdge({ createdAt: 1 }), id: "edge-0", targetHandle: "image-0" },
      visibleEdge({ createdAt: 2 }),
    ]);
    // Two parallel edges: index 1 of 2 sits 9px below the midpoint (y=50)
    expect(screen.getByTestId("edge-label").style.transform).toContain("59px");
  });
});
