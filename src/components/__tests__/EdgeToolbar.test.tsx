import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { EdgeToolbar, useIsToolbarEdge, getImageSequenceNumber } from "@/components/EdgeToolbar";
import type { WorkflowEdge } from "@/types";

// Mock the workflow store
const mockToggleEdgePause = vi.fn();
const mockSetEdgesPause = vi.fn();
const mockRemoveEdges = vi.fn();
const mockSetLoopCount = vi.fn();
const mockSetEdgesHidden = vi.fn();
const mockSetEdgeLabel = vi.fn();
const mockBundleEdges = vi.fn();
const mockUnbundleEdges = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    if (selector) {
      return mockUseWorkflowStore(selector);
    }
    return mockUseWorkflowStore((s: unknown) => s);
  },
}));

// The label renderer needs a mounted ReactFlow; render its children in place.
let mockZoom = 1;
vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual("@xyflow/react");
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <div data-testid="label-renderer">{children}</div>,
    useViewport: () => ({ x: 0, y: 0, zoom: mockZoom }),
  };
});

const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source: "a",
  sourceHandle: "image",
  target: "b",
  targetHandle: "image",
  data: {},
  ...overrides,
});

const createDefaultState = (overrides = {}) => ({
  edges: [] as WorkflowEdge[],
  toggleEdgePause: mockToggleEdgePause,
  setEdgesPause: mockSetEdgesPause,
  removeEdges: mockRemoveEdges,
  setLoopCount: mockSetLoopCount,
  setEdgesHidden: mockSetEdgesHidden,
  setEdgeLabel: mockSetEdgeLabel,
  bundleEdges: mockBundleEdges,
  unbundleEdges: mockUnbundleEdges,
  ...overrides,
});

const withEdges = (edges: WorkflowEdge[]) => {
  mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ edges })));
};

describe("EdgeToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZoom = 1;
    withEdges([]);
  });

  it("renders nothing for an edge that no longer exists", () => {
    render(<EdgeToolbar edgeId="gone" x={0} y={0} />);
    expect(screen.queryByTestId("edge-toolbar")).toBeNull();
  });

  it("anchors at the given flow position and counter-scales with the zoom", () => {
    mockZoom = 2;
    withEdges([edge("e1", { selected: true })]);
    render(<EdgeToolbar edgeId="e1" x={120} y={80} />);
    const anchor = screen.getByTestId("edge-toolbar");
    expect(anchor.style.transform).toBe("translate(120px, 80px)");
    expect((anchor.firstElementChild as HTMLElement).style.transform).toContain("scale(0.5)");
  });

  it("opens above the clicked position and moves on subsequent clicks", () => {
    let edgeMenuAnchor = { edgeId: "e1", x: 310, y: 190 };
    mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({
      edges: [edge("e1", { selected: true })], edgeMenuAnchor,
    })));
    const { rerender } = render(<EdgeToolbar edgeId="e1" x={120} y={80} />);
    expect(screen.getByTestId("edge-toolbar").style.transform).toBe("translate(310px, 190px)");
    expect((screen.getByTestId("edge-toolbar").firstElementChild as HTMLElement).style.transform).toContain("calc(-100% - 12px)");
    edgeMenuAnchor = { edgeId: "e1", x: 420, y: 230 };
    rerender(<EdgeToolbar edgeId="e1" x={120} y={80} />);
    expect(screen.getByTestId("edge-toolbar").style.transform).toBe("translate(420px, 230px)");
  });

  it("ignores the click position of an edge outside the current selection", () => {
    mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({
      edges: [edge("e1", { selected: true })], edgeMenuAnchor: { edgeId: "other", x: 310, y: 190 },
    })));
    render(<EdgeToolbar edgeId="e1" x={120} y={80} />);
    expect(screen.getByTestId("edge-toolbar").style.transform).toBe("translate(120px, 80px)");
  });

  it("sits above selected nodes and the hidden-connection pills", () => {
    withEdges([edge("e1", { selected: true })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(Number(screen.getByTestId("edge-toolbar").style.zIndex)).toBeGreaterThan(2001);
  });

  it("toggles the pause of a single edge", () => {
    withEdges([edge("e1", { selected: true })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    fireEvent.click(screen.getByTitle("Add pause"));
    expect(mockToggleEdgePause).toHaveBeenCalledWith("e1");
    expect(mockSetEdgesPause).not.toHaveBeenCalled();
  });

  it("shows the resume icon when the edge is paused", () => {
    withEdges([edge("e1", { selected: true, data: { hasPause: true } })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.getByTitle("Remove pause")).toBeInTheDocument();
  });

  it("edits the label of a single edge", () => {
    withEdges([edge("e1", { selected: true, data: { label: "old" } })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    const input = screen.getByLabelText("Connection label") as HTMLInputElement;
    expect(input.value).toBe("old");
    fireEvent.change(input, { target: { value: "hero shot" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSetEdgeLabel).toHaveBeenCalledWith("e1", "hero shot");
  });

  it("reverts the label draft on Escape", () => {
    withEdges([edge("e1", { selected: true, data: { label: "old" } })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    const input = screen.getByLabelText("Connection label") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "typo" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("old");
    // The blur Escape triggers must not commit the discarded draft
    expect(mockSetEdgeLabel).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
  });

  it("offers to show a hidden edge instead of hiding it", () => {
    withEdges([edge("e1", { selected: true, data: { hidden: true } })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.queryByTitle("Hide connection")).toBeNull();
    fireEvent.click(screen.getByTitle("Show connection"));
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1"], false);
  });

  it("hides a single edge", () => {
    withEdges([edge("e1", { selected: true })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    fireEvent.click(screen.getByTitle("Hide connection"));
    expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1"], true);
  });

  it("deletes a single edge", () => {
    withEdges([edge("e1", { selected: true })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    fireEvent.click(screen.getByTitle("Delete"));
    expect(mockRemoveEdges).toHaveBeenCalledWith(["e1"]);
  });

  it("shows the image order among connections into the same handle", () => {
    withEdges([
      edge("e1", { data: { createdAt: 1 } }),
      edge("e2", { selected: true, source: "c", data: { createdAt: 2 } }),
    ]);
    render(<EdgeToolbar edgeId="e2" x={0} y={0} />);
    expect(screen.getByText("Image 2")).toBeInTheDocument();
  });

  it("offers loop controls instead of pause on a loop edge", () => {
    withEdges([edge("e1", { selected: true, data: { isLoop: true, loopCount: 4 } })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.queryByTitle("Add pause")).toBeNull();
    fireEvent.click(screen.getByTitle("Increase loop count"));
    expect(mockSetLoopCount).toHaveBeenCalledWith("e1", 5);
    fireEvent.click(screen.getByTitle("Decrease loop count"));
    expect(mockSetLoopCount).toHaveBeenCalledWith("e1", 3);
  });

  describe("with several edges selected", () => {
    const three = [
      edge("e1", { selected: true }),
      edge("e2", { selected: true, source: "c", data: { hasPause: true } }),
      edge("e3", { selected: false, source: "d" }),
    ];

    it("says how many are selected and offers no label field", () => {
      withEdges(three);
      render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
      expect(screen.getByText("2 connections")).toBeInTheDocument();
      expect(screen.queryByText(/^Image \d/)).toBeNull();
      expect(screen.queryByLabelText("Connection label")).toBeNull();
    });

    it("pauses every selected edge when not all are paused", () => {
      withEdges(three);
      render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
      fireEvent.click(screen.getByTitle("Pause all"));
      expect(mockSetEdgesPause).toHaveBeenCalledWith(["e1", "e2"], true);
    });

    it("removes the pauses when all are paused", () => {
      withEdges([edge("e1", { selected: true, data: { hasPause: true } }), edge("e2", { selected: true, source: "c", data: { hasPause: true } })]);
      render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
      fireEvent.click(screen.getByTitle("Remove pauses"));
      expect(mockSetEdgesPause).toHaveBeenCalledWith(["e1", "e2"], false);
    });

    it("hides every selected edge", () => {
      withEdges(three);
      render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
      fireEvent.click(screen.getByTitle("Hide 2 connections"));
      expect(mockSetEdgesHidden).toHaveBeenCalledWith(["e1", "e2"], true);
    });

    it("deletes every selected edge", () => {
      withEdges(three);
      render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
      fireEvent.click(screen.getByTitle("Delete 2 connections"));
      expect(mockRemoveEdges).toHaveBeenCalledWith(["e1", "e2"]);
    });
  });
});

describe("EdgeToolbar bundles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZoom = 1;
  });

  it("offers to bundle a multi-selection leaving one handle", () => {
    withEdges([edge("e1", { selected: true }), edge("e2", { selected: true, target: "z" })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    fireEvent.click(screen.getByTitle("Bundle 2 connections"));
    expect(mockBundleEdges).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("does not offer to bundle a selection that is already one bundle", () => {
    withEdges([
      edge("e1", { selected: true, data: { sourceBundleId: "x", createdAt: 1 } }),
      edge("e2", { selected: true, target: "z", data: { sourceBundleId: "x", createdAt: 2 } }),
    ]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.queryByTitle(/^Bundle/)).toBeNull();
    expect(screen.getByTitle("Unbundle")).toBeTruthy();
  });

  it("offers to bundle a selection at the other end of an edge already bundled at one", () => {
    withEdges([
      edge("e1", { selected: true, data: { targetBundleId: "in", createdAt: 1 } }),
      edge("e2", { selected: true, target: "z", data: { createdAt: 2 } }),
    ]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.getByTitle("Bundle 2 connections")).toBeTruthy();
  });

  it("does not offer to bundle edges on different handles", () => {
    withEdges([edge("e1", { selected: true }), edge("e2", { selected: true, sourceHandle: "text", target: "z", targetHandle: "text" })]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.queryByTitle(/^Bundle/)).toBeNull();
  });

  it("acts on the whole manual bundle from one selected member and offers to unbundle", () => {
    withEdges([
      edge("e1", { selected: true, data: { sourceBundleId: "x", createdAt: 1 } }),
      edge("e2", { target: "z", data: { sourceBundleId: "x", createdAt: 2 } }),
    ]);
    render(<EdgeToolbar edgeId="e1" x={0} y={0} />);
    expect(screen.getByText("2 connections")).toBeInTheDocument();
    expect(screen.queryByLabelText("Connection label")).toBeNull();
    fireEvent.click(screen.getByTitle("Pause all"));
    expect(mockSetEdgesPause).toHaveBeenCalledWith(["e1", "e2"], true);
    fireEvent.click(screen.getByTitle("Unbundle"));
    expect(mockUnbundleEdges).toHaveBeenCalledWith(["e1", "e2"], "source");
  });
});

describe("useIsToolbarEdge", () => {
  it("is true only for the first selected edge", () => {
    withEdges([edge("e1"), edge("e2", { selected: true }), edge("e3", { selected: true })]);
    expect(renderHook(() => useIsToolbarEdge("e2")).result.current).toBe(true);
    expect(renderHook(() => useIsToolbarEdge("e3")).result.current).toBe(false);
    expect(renderHook(() => useIsToolbarEdge("e1")).result.current).toBe(false);
  });
});

describe("getImageSequenceNumber", () => {
  it("orders siblings by creation time", () => {
    const edges = [edge("late", { data: { createdAt: 20 } }), edge("early", { source: "c", data: { createdAt: 10 } })];
    expect(getImageSequenceNumber(edges[0], edges)).toBe(2);
    expect(getImageSequenceNumber(edges[1], edges)).toBe(1);
  });

  it("is null for lone or non-image connections", () => {
    const lone = edge("e1");
    expect(getImageSequenceNumber(lone, [lone])).toBeNull();
    const text = edge("t", { sourceHandle: "text", targetHandle: "text" });
    expect(getImageSequenceNumber(text, [text, edge("t2", { sourceHandle: "text", targetHandle: "text", source: "c" })])).toBeNull();
  });
});
