import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { EditableEdge } from "@/components/edges/EditableEdge";
import { ReactFlowProvider, Position } from "@xyflow/react";
import { EDGE_COLORS } from "@/lib/edges/colors";
import { STUB_DOUBLE_CLICK_MS } from "@/components/edges/HiddenEdgeStub";
import { readFileSync } from "fs";
import { join } from "path";

// Mock the workflow store
const mockSetEdges = vi.fn();
const mockSetCenter = vi.fn();
const mockSetEdgesHidden = vi.fn();
const mockSetBundleClamp = vi.fn();
const mockUseWorkflowStore = vi.fn();
const mockSetExpandedStubGroup = vi.fn();
const mockSetHoveredHandle = vi.fn();
const mockSetEdgeLabel = vi.fn();
const mockSetEdgesLabel = vi.fn();
let connectionInProgress = false;

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      if (selector) {
        return mockUseWorkflowStore(selector);
      }
      return mockUseWorkflowStore((s: unknown) => s);
    },
    { getState: () => mockUseWorkflowStore((s: unknown) => s) }
  ),
}));

// Mock useReactFlow
vi.mock("@/components/flowPortals", () => ({
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <foreignObject><div>{children}</div></foreignObject>,
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    useReactFlow: () => ({
      setEdges: mockSetEdges,
      screenToFlowPosition: (p: { x: number; y: number }) => p,
      setCenter: mockSetCenter,
      getZoom: () => 1.5,
    }),
    // The real one portals into HTML; foreignObject keeps the labels HTML inside the test's svg
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <foreignObject><div>{children}</div></foreignObject>,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useConnection: (selector?: (c: { inProgress: boolean }) => unknown) => {
      const connection = { inProgress: connectionInProgress };
      return selector ? selector(connection) : connection;
    },
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
  setBundleClamp: mockSetBundleClamp,
  edgeAppearance: { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true },
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
    it("carries a noodle on the fork mid-sweep, without a handle until release", () => {
      const edges = [{ id: "edge-1", source: "a", target: "b", selected: true, data: {} }];
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ edges, hookDrag: { x: 200, y: 80, edgeIds: ["edge-1"] } })));
      const { container } = render(<TestWrapper><EditableEdge {...createDefaultProps({ selected: true })} /></TestWrapper>);
      expect(container.querySelector(".react-flow__edge-path")?.getAttribute("d")).toContain("L216,80");
      expect(screen.queryByTestId("hook-bundle-clamp")).toBeNull();
    });

    it("leaves a noodle the sweep has not caught on its own route", () => {
      const edges = [{ id: "edge-1", source: "a", target: "b", data: {} }];
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ edges, hookDrag: { x: 200, y: 80, edgeIds: ["edge-9"] } })));
      const { container } = render(<TestWrapper><EditableEdge {...createDefaultProps()} /></TestWrapper>);
      expect(container.querySelector(".react-flow__edge-path")?.getAttribute("d")).not.toContain("L216,80");
    });

    it.each(["angular", "curved", "straight"])("routes %s edges through multiple handles with one active menu", (edgeStyle) => {
      const hookBundles = [{ id: "first", x: 180, y: 80 }, { id: "second", x: 260, y: 120 }];
      const edges = [
        { id: "edge-1", source: "a", target: "b", selected: true, data: { hookBundles } },
        { id: "edge-2", source: "c", target: "d", selected: true, data: { hookBundles } },
      ];
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ edges, edgeStyle, activeHookBundleId: "second" })));
      const { container } = render(<TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hookBundles }, selected: true })} />
        <EditableEdge {...createDefaultProps({ id: "edge-2", data: { hookBundles }, selected: true, sourceY: 150 })} />
      </TestWrapper>);
      expect(screen.getAllByTestId("hook-bundle-clamp")).toHaveLength(2);
      expect(screen.getAllByTitle("Remove bundle")).toHaveLength(1);
      container.querySelectorAll(".react-flow__edge-path").forEach((path) => {
        const d = path.getAttribute("d")!;
        expect(d).toContain("L196,80");
        expect(d).toContain("L276,120");
        expect(d.indexOf("L196,80")).toBeLessThan(d.indexOf("L276,120"));
      });
    });

    it.each(["angular", "curved", "straight"])("routes %s hook bundles through exactly one shared clamp", (edgeStyle) => {
      const hookBundle = { id: "hook-test", x: 200, y: 80 };
      const edges = [
        { id: "edge-1", source: "a", target: "b", selected: true, data: { hookBundle } },
        { id: "edge-2", source: "c", target: "d", selected: true, data: { hookBundle } },
      ];
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ edges, edgeStyle })));
      const { container } = render(<TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hookBundle }, selected: true })} />
        <EditableEdge {...createDefaultProps({ id: "edge-2", data: { hookBundle }, selected: true, sourceY: 150 })} />
      </TestWrapper>);
      expect(screen.getAllByTestId("hook-bundle-clamp")).toHaveLength(1);
      expect(screen.getByTitle("Remove bundle")).toBeInTheDocument();
      expect(screen.getByTitle("Delete 2 connections")).toBeInTheDocument();
      expect(screen.queryByTestId("edge-toolbar")).not.toBeInTheDocument();
      const paths = container.querySelectorAll(".react-flow__edge-path");
      expect(paths).toHaveLength(2);
      paths.forEach((path) => expect(path.getAttribute("d")).toContain("L216,80"));
    });

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

      expect(container.querySelector('[data-testid="edge-running"]')).not.toBeNull();
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

      expect(container.querySelector('[data-testid="edge-running"]')).toBeNull();
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
  const baseAppearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true };
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

  const running = (container: HTMLElement) => container.querySelector('[data-testid="edge-running"]');

  it.each(["nanoBanana", "generateVideo", "generateAudio", "generate3d", "llmGenerate", "comfyApp", "splitGrid"])(
    "runs the comet while a %s target is loading",
    (type) => {
      withState({ nodes: [{ id: "node-2", type, data: { status: "loading" }, position: { x: 0, y: 0 } }] });
      expect(running(renderEdge())).not.toBeNull();
    }
  );

  it("draws the comet as a tail and a lighter head in the type colour, source to target", () => {
    withState({ nodes: [{ id: "node-2", type: "generateVideo", data: { status: "loading" }, position: { x: 0, y: 0 } }] });
    const container = renderEdge();
    const base = container.querySelector(".react-flow__edge-path")?.getAttribute("d");
    const tail = container.querySelector(".edge-running-tail");
    const head = container.querySelector(".edge-running-head");
    expect(running(container)?.querySelectorAll("path")).toHaveLength(2);
    expect(tail?.getAttribute("d")).toBe(base);
    expect(tail?.getAttribute("pathLength")).toBe("100");
    expect(tail?.getAttribute("stroke")).toBe(EDGE_COLORS.image);
    expect(tail?.getAttribute("stroke-width")).toBe("6");
    expect(head?.getAttribute("stroke")).toBe("#70d5b3");
    expect(head?.getAttribute("stroke-width")).toBe("3");
    expect(container.querySelector("[filter]")).toBeNull();
  });

  it("does not run the comet for an idle or finished target", () => {
    for (const status of ["idle", "complete", "error"]) {
      withState({ nodes: [{ id: "node-2", type: "nanoBanana", data: { status }, position: { x: 0, y: 0 } }] });
      expect(running(renderEdge())).toBeNull();
    }
  });

  it("does not run the comet out of a running node", () => {
    withState({ nodes: [{ id: "node-1", type: "nanoBanana", data: { status: "loading" }, position: { x: 0, y: 0 } }] });
    expect(running(renderEdge())).toBeNull();
  });

  it("skips the comet when the setting is off", () => {
    withState({
      edgeAppearance: { ...baseAppearance, loadingPulse: false },
      nodes: [{ id: "node-2", type: "nanoBanana", data: { status: "loading" }, position: { x: 0, y: 0 } }],
    });
    expect(running(renderEdge())).toBeNull();
  });
});

describe("running noodle styles", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("pauses the comet while the canvas pans or a node drags", () => {
    for (const cls of ["canvas-interacting", "canvas-native-navigation-active", "canvas-wheel-navigation-active"]) {
      expect(css).toContain(`.${cls} .edge-running path`);
    }
    expect(css).toMatch(/\.canvas-wheel-navigation-active \.edge-running path \{\s*animation-play-state: paused;/);
  });

  it("holds a static highlight under reduced motion", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .edge-running path"));
    expect(block).toMatch(/\.edge-running path \{\s*animation: none;\s*stroke-dasharray: none;/);
    expect(block).toMatch(/\.edge-running-head \{\s*opacity: 0\.85;/);
  });
});

describe("EditableEdge toolbar and highlight", () => {
  const baseAppearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true };
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
  const baseAppearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true };
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

  it("draws nothing while a noodle is being dragged, so the handle labels can show", () => {
    connectionInProgress = true;
    try {
      const { container } = renderHidden();
      expect(container.querySelector('[data-testid="hidden-edge-stub-target"]')).toBeNull();
      expect(container.querySelector(".react-flow__edge-path")).toBeNull();
    } finally {
      connectionInProgress = false;
    }
  });

  it("keeps the stubs above elevated edge SVGs", () => {
    renderHidden();
    expect(Number(screen.getByTestId("hidden-edge-stub-source").style.zIndex)).toBeGreaterThan(2000);
    expect(Number(screen.getByTestId("hidden-edge-stub-target").style.zIndex)).toBeGreaterThan(2000);
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

  const siblings = [
    { id: "edge-0", source: "x", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { hidden: true, createdAt: 1 } },
    { ...hiddenEdge, data: { hidden: true, createdAt: 2 } },
  ];

  it("leaves the collapsed pill to the first hidden sibling on the handle", () => {
    // edge-1 is the second hidden connection into node-2's image handle, so edge-0 draws the pill
    renderHidden(siblings);
    expect(screen.queryByTestId("hidden-edge-stub-target")).toBeNull();
    // Nothing else leaves node-1's handle, so the source stub is its own
    expect(screen.getByTestId("hidden-edge-stub-source")).toHaveTextContent("Image 2");
  });

  it("draws a plural pill for a collapsed group and expands it on click", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: siblings, setExpandedStubGroup: mockSetExpandedStubGroup, setHoveredHandle: mockSetHoveredHandle }))
    );
    render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ id: "edge-0", source: "x", data: { hidden: true } })} />
      </TestWrapper>
    );
    const pill = screen.getByTestId("hidden-edge-stub-target");
    expect(pill).toHaveTextContent("Images");
    expect(pill.style.transform).toContain("50px");
    fireEvent.mouseEnter(pill.querySelector("button")!);
    expect(mockSetHoveredHandle).toHaveBeenCalledWith({ nodeId: "node-2", handleId: "image", type: "target" });
    vi.useFakeTimers();
    try {
      fireEvent.click(pill.querySelector("button")!, { detail: 1 });
      // The click waits to rule out a double-click (a rename)
      expect(mockSetExpandedStubGroup).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(STUB_DOUBLE_CLICK_MS));
    } finally {
      vi.useRealTimers();
    }
    expect(mockSetExpandedStubGroup).toHaveBeenCalledWith("node-2:target:image");
    expect(mockSetEdges).not.toHaveBeenCalled();
  });

  const named = (label: string) => siblings.map((e) => ({ ...e, data: { ...e.data, label } }));
  const renderStack = (edges: unknown[], props: Record<string, unknown>, state: Record<string, unknown> = {}) => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(
        createDefaultState({
          edges,
          setExpandedStubGroup: mockSetExpandedStubGroup,
          setHoveredHandle: mockSetHoveredHandle,
          setEdgeLabel: mockSetEdgeLabel,
          setEdgesLabel: mockSetEdgesLabel,
          ...state,
        })
      )
    );
    return render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps(props)} />
      </TestWrapper>
    );
  };

  it("names a collapsed stack's pill after its label, on the downstream side too", () => {
    vi.useFakeTimers();
    try {
      renderStack(named("Model"), { id: "edge-0", source: "x", data: { hidden: true, label: "Model" } });
      const pill = screen.getByTestId("hidden-edge-stub-target").querySelector("button")!;
      expect(pill).toHaveTextContent("Model");
      fireEvent.click(pill, { detail: 1 });
      act(() => vi.advanceTimersByTime(STUB_DOUBLE_CLICK_MS));
    } finally {
      vi.useRealTimers();
    }
    expect(mockSetExpandedStubGroup).toHaveBeenCalledWith("node-2:target:image#Model");
  });

  it("renames every connection in a collapsed stack from its pill", () => {
    renderStack(siblings, { id: "edge-0", source: "x", data: { hidden: true } });
    const pill = screen.getByTestId("hidden-edge-stub-target").querySelector("button")!;
    fireEvent.doubleClick(pill);
    const input = screen.getByRole("textbox", { name: "Rename stack" });
    fireEvent.change(input, { target: { value: "Model" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetEdgesLabel).toHaveBeenCalledWith(["edge-0", "edge-1"], "Model");
    expect(mockSetEdgeLabel).not.toHaveBeenCalled();
  });

  it("renames a single connection from its pill in an expanded stack", () => {
    renderStack(named("Model"), { data: { hidden: true, label: "Model" } }, { expandedStubGroup: "node-2:target:image#Model" });
    const pill = screen.getByTestId("hidden-edge-stub-target").querySelector("button")!;
    expect(pill).toHaveTextContent("Model");
    fireEvent.doubleClick(pill);
    const input = screen.getByRole("textbox", { name: "Rename connection" }) as HTMLInputElement;
    expect(input.value).toBe("Model");
    fireEvent.change(input, { target: { value: "Base" } });
    fireEvent.blur(input);
    expect(mockSetEdgeLabel).toHaveBeenCalledWith("edge-1", "Base");
    expect(mockSetEdgesLabel).not.toHaveBeenCalled();
  });

  it("leaves the labels alone when a rename is cancelled", () => {
    renderStack(siblings, { id: "edge-0", source: "x", data: { hidden: true } });
    fireEvent.doubleClick(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    const input = screen.getByRole("textbox", { name: "Rename stack" });
    fireEvent.change(input, { target: { value: "Model" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockSetEdgesLabel).not.toHaveBeenCalled();
    expect(screen.getByTestId("hidden-edge-stub-target")).toHaveTextContent("Images");
  });

  it("lets go of the handle hover when the collapsed pill expands under the pointer", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: siblings, setExpandedStubGroup: mockSetExpandedStubGroup, setHoveredHandle: mockSetHoveredHandle }))
    );
    const props = createDefaultProps({ id: "edge-0", source: "x", data: { hidden: true } });
    const { rerender } = render(
      <TestWrapper>
        <EditableEdge {...props} />
      </TestWrapper>
    );
    fireEvent.mouseEnter(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    mockSetHoveredHandle.mockClear();
    // The group expands: the plural pill is replaced by this edge's own stub
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: siblings, expandedStubGroup: "node-2:target:image", setHoveredHandle: mockSetHoveredHandle }))
    );
    rerender(
      <TestWrapper>
        <EditableEdge {...props} />
      </TestWrapper>
    );
    expect(screen.getByTestId("hidden-edge-stub-target")).toHaveTextContent("Image 1");
    expect(mockSetHoveredHandle).toHaveBeenCalledWith(null);
  });

  it("stacks stubs below earlier hidden siblings once the group is expanded", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: siblings, expandedStubGroup: "node-2:target:image" }))
    );
    render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hidden: true } })} />
      </TestWrapper>
    );
    // Target handle is at y=50; the second hidden stub sits one row (22px) lower
    const stub = screen.getByTestId("hidden-edge-stub-target");
    expect(stub).toHaveTextContent("Image 2");
    expect(stub.style.transform).toContain("72px");
    expect(screen.getByTestId("hidden-edge-stub-source").style.transform).toContain("50px");
  });

  it("starts a collapsed member's ghost at the outer edge of the shared pill", () => {
    // edge-1 draws no target pill; the pill edge-0 drew measured 80px wide
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: siblings, stubGroupWidths: { "node-2:target:image": 80 } }))
    );
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hidden: true }, selected: true })} />
      </TestWrapper>
    );
    // Target handle at x=300, stub anchored 12px inside it, pill extends 80px further left
    const ghost = container.querySelector('[data-testid="hidden-edge-ghost"]')!;
    expect(ghost.getAttribute("d")).toMatch(/208,50$/);
  });

  it("publishes the collapsed pill's width for its members", () => {
    const setStubGroupWidth = vi.fn();
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: siblings, setStubGroupWidth, setHoveredHandle: mockSetHoveredHandle }))
    );
    render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ id: "edge-0", source: "x", data: { hidden: true } })} />
      </TestWrapper>
    );
    expect(setStubGroupWidth).toHaveBeenCalledWith("node-2:target:image", expect.any(Number));
  });

  it("folds an output's hidden connections that share a name into one pill", () => {
    // One output feeding forty nodes, every connection named "Model": one pill at the output, not forty
    const fanOut = Array.from({ length: 40 }, (_, i) => ({
      id: `edge-${i}`, source: "node-1", sourceHandle: "image", target: `node-${i + 2}`, targetHandle: "image",
      data: { hidden: true, createdAt: i, label: "Model" },
    }));
    const setStubGroupWidth = vi.fn();
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edges: fanOut, setStubGroupWidth, setHoveredHandle: mockSetHoveredHandle }))
    );
    const pills = fanOut.filter((member) => {
      const { unmount } = render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps({ id: member.id, target: member.target, data: member.data })} />
        </TestWrapper>
      );
      const pill = screen.queryByTestId("hidden-edge-stub-source");
      if (pill) expect(pill).toHaveTextContent("Model");
      // Each target has only this connection, so its own stub still shows the name
      expect(screen.getByTestId("hidden-edge-stub-target")).toHaveTextContent("Model");
      unmount();
      return pill !== null;
    });
    expect(pills.map((e) => e.id)).toEqual(["edge-0"]);
    expect(setStubGroupWidth).toHaveBeenCalledWith("node-1:source:image#Model", expect.any(Number));
  });

  it("ghosts the line while a stub is hovered", () => {
    const { container } = renderHidden();
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).not.toBeNull();
    fireEvent.mouseLeave(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).toBeNull();
  });

  it("selects the connection when a stub is clicked, without showing it", () => {
    renderHidden();
    fireEvent.click(screen.getByTestId("hidden-edge-stub-source").querySelector("button")!);
    expect(mockSetEdgesHidden).not.toHaveBeenCalled();
    expect(mockSetEdges).toHaveBeenCalledTimes(1);
    const mapper = mockSetEdges.mock.calls[0][0] as (edges: unknown[]) => { id: string; selected: boolean }[];
    expect(mapper([{ id: "edge-1" }, { id: "edge-2", selected: true }])).toEqual([
      { id: "edge-1", selected: true },
      { id: "edge-2", selected: false },
    ]);
  });

  it("ghosts the line while its handle is hovered", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({
        edgeAppearance: baseAppearance,
        edges: [hiddenEdge],
        hoveredHandle: { nodeId: "node-2", handleId: "image", type: "target" },
      }))
    );
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hidden: true } })} />
      </TestWrapper>
    );
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).not.toBeNull();
  });

  it("runs the ghost between the label pills, not the handles", () => {
    const { container } = renderHidden();
    fireEvent.mouseEnter(screen.getByTestId("hidden-edge-stub-source").querySelector("button")!);
    const d = container.querySelector('[data-testid="hidden-edge-ghost"]')?.getAttribute("d") ?? "";
    // Source handle is at x=100; the stub pill starts 12px past it
    expect(d.startsWith("M112")).toBe(true);
  });

  it("puts the toolbar above the label when selected", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: baseAppearance, edges: [{ ...hiddenEdge, selected: true }] }))
    );
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hidden: true }, selected: true })} />
      </TestWrapper>
    );
    const toolbar = container.querySelector('[data-testid="edge-toolbar"]') as HTMLElement | null;
    expect(toolbar).not.toBeNull();
    // Anchored at the source stub (x=112) and 10px above its centre line (y=50)
    expect(toolbar!.style.transform).toBe("translate(112px, 40px)");
    expect(container.querySelector('[data-testid="hidden-edge-ghost"]')).not.toBeNull();
  });

  it("takes the downstream pill's toolbar to the upstream end", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: baseAppearance, edges: [{ ...hiddenEdge, selected: true }] }))
    );
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps({ data: { hidden: true }, selected: true })} />
      </TestWrapper>
    );
    // Opened from the upstream pill there is nowhere to go
    expect(screen.queryByRole("button", { name: "Go to upstream connection" })).toBeNull();
    fireEvent.click(screen.getByTestId("hidden-edge-stub-target").querySelector("button")!);
    const toolbar = () => container.querySelector('[data-testid="edge-toolbar"]') as HTMLElement;
    // Target stub anchored at x=288, extending left
    expect(toolbar().style.transform).toBe("translate(288px, 40px)");
    fireEvent.click(screen.getByRole("button", { name: "Go to upstream connection" }));
    // Centres the upstream pill (x=112, unmeasured width) at the current zoom
    expect(mockSetCenter).toHaveBeenCalledWith(112, 50, { zoom: 1.5, duration: 300 });
    expect(toolbar().style.transform).toBe("translate(112px, 40px)");
    expect(screen.queryByRole("button", { name: "Go to upstream connection" })).toBeNull();
  });
});

describe("EditableEdge labels", () => {
  const visibleEdge = (data: Record<string, unknown> = {}) => ({
    id: "edge-1", source: "node-1", sourceHandle: "image", target: "node-2", targetHandle: "image", data,
  });
  const renderWith = (edges: unknown[], props = {}) => {
    mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ edges })));
    return render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps(props)} />
      </TestWrapper>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a typed label on the noodle", () => {
    renderWith([visibleEdge({ label: "hero shot" })], { data: { label: "hero shot" } });
    expect(screen.getByTestId("edge-label")).toHaveTextContent("hero shot");
  });

  it("never puts the automatic label on the noodle, hovered or selected", () => {
    const { container } = renderWith([visibleEdge()], { selected: true });
    expect(screen.queryByTestId("edge-label")).toBeNull();
    fireEvent.mouseEnter(container.querySelector('[data-testid="edge-hover-area"]')!);
    expect(screen.queryByTestId("edge-label")).toBeNull();
  });

  it("puts the loop count in the label on loop edges", () => {
    renderWith([visibleEdge({ isLoop: true, loopCount: 4 })], { data: { isLoop: true, loopCount: 4 } });
    expect(screen.getByTestId("edge-label-loop")).toHaveTextContent("4×");
  });

  describe("from an Array node", () => {
    const arrayNode = (data: Record<string, unknown>) => ({
      id: "node-1", type: "array", position: { x: 0, y: 0 },
      data: { outputItems: ["fox", "lighthouse", "koi"], selectedOutputIndex: null, batchMode: false, ...data },
    });
    const renderArray = (edgeData: Record<string, unknown>, nodeData: Record<string, unknown> = {}) => {
      const edge = { id: "edge-1", source: "node-1", sourceHandle: "text", target: "node-2", targetHandle: "text", data: edgeData };
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ edges: [edge], nodes: [arrayNode(nodeData)] })));
      return render(
        <TestWrapper>
          <EditableEdge {...createDefaultProps({ sourceHandleId: "text", targetHandleId: "text", data: edgeData })} />
        </TestWrapper>
      );
    };

    it("names the item the connection carries", () => {
      renderArray({ arrayItemIndex: 4 });
      expect(screen.getByTestId("edge-label")).toHaveTextContent("Array 2");
    });

    it("puts the item name at the target end of the noodle", () => {
      renderArray({ arrayItemIndex: 0 });
      // Target handle at (300, 50) on the left: the pill's right edge lines up with the hidden stubs, 12px before it
      expect(screen.getByTestId("edge-label").style.transform).toBe("translate(288px, 50px) translate(-100%, -50%)");
    });

    it("keeps a typed label at the midpoint", () => {
      renderArray({ arrayItemIndex: 0, label: "hero" });
      expect(screen.getByTestId("edge-label").style.transform).toContain("translate(-50%, -50%)");
    });

    it("says All n in batch mode", () => {
      renderArray({ arrayItemIndex: 1 }, { batchMode: true });
      expect(screen.getByTestId("edge-label")).toHaveTextContent("All 3");
    });

    it("keeps a typed label over the item", () => {
      renderArray({ arrayItemIndex: 1, label: "hero" });
      expect(screen.getByTestId("edge-label")).toHaveTextContent("hero");
    });

    it("shows no label while the Array has no items", () => {
      renderArray({ arrayItemIndex: 1 }, { outputItems: [] });
      expect(screen.queryByTestId("edge-label")).toBeNull();
    });
  });

  it("offsets labels of parallel connections between the same nodes", () => {
    renderWith([
      { ...visibleEdge({ createdAt: 1, label: "first" }), id: "edge-0", targetHandle: "image-0" },
      visibleEdge({ createdAt: 2, label: "second" }),
    ], { data: { label: "second" } });
    // Two parallel edges: index 1 of 2 sits 9px below the midpoint (y=50)
    expect(screen.getByTestId("edge-label").style.transform).toContain("59px");
  });
});

describe("EditableEdge bundles", () => {
  const appearance = { thickness: "regular" as const, fadedOpacity: 0.25, gradient: true, loadingPulse: true };
  // A fan-out bundled by hand: node-1's image output feeds node-2 and node-3
  const fanOut = (selected = false) => [
    { id: "edge-1", source: "node-1", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { createdAt: 1, sourceBundleId: "b" }, selected },
    { id: "edge-2", source: "node-1", sourceHandle: "image", target: "node-3", targetHandle: "image", data: { createdAt: 2, sourceBundleId: "b" } },
  ];
  const renderMember = (edges: unknown[], props = {}) => {
    mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ edgeAppearance: appearance, edges })));
    return render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps(props)} />
      </TestWrapper>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws the stem and the clamp from the first member, and starts its own line past the stem", () => {
    const { container } = renderMember(fanOut());
    expect(container.querySelector('[data-testid="edge-bundle-stem"]')).not.toBeNull();
    const clamp = screen.getByTestId("edge-bundle-clamp");
    expect(clamp.getAttribute("title")).toContain("2 connections");
    // Above an elevated edge's SVG (up to 2000), so a selected node can't cost it the press
    expect(Number(clamp.style.zIndex)).toBeGreaterThan(2000);
    // The source handle is at x=100 and the stem reaches 56px, so the noodle starts at 156
    const d = container.querySelector("#edge-1")?.getAttribute("d") ?? "";
    expect(d.startsWith("M156")).toBe(true);
    // The stem is thicker than a single noodle
    expect(container.querySelector('[data-testid="edge-bundle-stem"]')).toHaveAttribute("stroke-width", "4.5");
  });

  it("strokes the stem with a solid colour, since a gradient cannot paint a flat line", () => {
    // The stem is purely horizontal, so its bounding box has no height and an
    // objectBoundingBox gradient on it is an invalid paint server: nothing draws.
    const { container } = renderMember(fanOut());
    const stem = container.querySelector('[data-testid="edge-bundle-stem"]') as SVGPathElement;
    expect(stem.getAttribute("stroke")).not.toMatch(/^url\(/);
    expect(stem.getAttribute("stroke")).toBe(EDGE_COLORS.image);
    expect(stem.style.getPropertyValue("--edge-stroke-active")).toBe(EDGE_COLORS.image);
    // At the opacity of the noodle's first gradient stop, so the two meet seamlessly
    expect(stem.getAttribute("stroke-opacity")).toBe("0.25");
  });

  it("starts the other members past the stem without drawing it again", () => {
    const { container } = renderMember(fanOut(), { id: "edge-2", target: "node-3" });
    expect(container.querySelector('[data-testid="edge-bundle-stem"]')).toBeNull();
    expect(screen.queryByTestId("edge-bundle-clamp")).toBeNull();
    expect((container.querySelector("#edge-2")?.getAttribute("d") ?? "").startsWith("M156")).toBe(true);
  });

  it("bundles a fan-in at the target handle", () => {
    const fanIn = [
      { id: "edge-1", source: "node-1", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { createdAt: 1, targetBundleId: "in" } },
      { id: "edge-9", source: "node-9", sourceHandle: "image", target: "node-2", targetHandle: "image", data: { createdAt: 2, targetBundleId: "in" } },
    ];
    const { container } = renderMember(fanIn);
    // Target handle at x=300, stem reaching back 56px: the noodle ends at 244
    const d = container.querySelector("#edge-1")?.getAttribute("d") ?? "";
    expect(d.startsWith("M100")).toBe(true);
    expect(d.endsWith("244 50") || d.endsWith("244,50")).toBe(true);
    expect(container.querySelector('[data-testid="edge-bundle-stem"]')).not.toBeNull();
  });

  it("expands into ordinary noodles when a member is selected", () => {
    const { container } = renderMember(fanOut(true), { selected: true });
    expect(container.querySelector('[data-testid="edge-bundle-stem"]')).toBeNull();
    expect((container.querySelector("#edge-1")?.getAttribute("d") ?? "").startsWith("M100")).toBe(true);
  });

  it("splits where the node's clamp says", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({
        edgeAppearance: appearance,
        edges: fanOut(),
        nodes: [{ id: "node-1", type: "imageInput", position: { x: 0, y: 0 }, data: { bundleClamps: { "source:image": 120 } } }],
      }))
    );
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps()} />
      </TestWrapper>
    );
    expect((container.querySelector("#edge-1")?.getAttribute("d") ?? "").startsWith("M220")).toBe(true);
    expect(screen.getByTestId("edge-bundle-clamp").style.transform).toContain("translate(220px, 50px)");
  });

  it("moves the split point when the clamp is dragged", () => {
    renderMember(fanOut());
    fireEvent.mouseDown(screen.getByTestId("edge-bundle-clamp"), { clientX: 156, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 190, clientY: 50 });
    expect(mockSetBundleClamp).toHaveBeenLastCalledWith("node-1", "source:image", 90);
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 300, clientY: 50 });
    expect(mockSetBundleClamp).toHaveBeenCalledTimes(1);
  });

  it("ends the drag when released over the clamp itself", () => {
    renderMember(fanOut());
    const clamp = screen.getByTestId("edge-bundle-clamp");
    fireEvent.mouseDown(clamp, { clientX: 156, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 170, clientY: 50 });
    expect(mockSetBundleClamp).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(clamp, { clientX: 170, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 50 });
    expect(mockSetBundleClamp).toHaveBeenCalledTimes(1);
  });

  it("keeps a click on the clamp from reaching the edge", () => {
    mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ edgeAppearance: appearance, edges: fanOut() })));
    const onEdgeClick = vi.fn();
    render(
      <ReactFlowProvider>
        <svg onClick={onEdgeClick}>
          <EditableEdge {...createDefaultProps()} />
        </svg>
      </ReactFlowProvider>
    );
    fireEvent.mouseDown(screen.getByTestId("edge-bundle-clamp"), { clientX: 156, clientY: 50 });
    fireEvent.mouseUp(screen.getByTestId("edge-bundle-clamp"), { clientX: 170, clientY: 50 });
    fireEvent.click(screen.getByTestId("edge-bundle-clamp"));
    expect(onEdgeClick).not.toHaveBeenCalled();
  });

  it("does not bundle connections that carry no bundle id", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ edgeAppearance: appearance, edges: fanOut().map((e) => ({ ...e, data: { createdAt: e.data.createdAt } })) }))
    );
    const { container } = render(
      <TestWrapper>
        <EditableEdge {...createDefaultProps()} />
      </TestWrapper>
    );
    expect(container.querySelector('[data-testid="edge-bundle-stem"]')).toBeNull();
  });
});
