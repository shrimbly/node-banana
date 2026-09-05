import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { SplitGridNode } from "@/components/nodes/SplitGridNode";
import { SplitGridCell, SplitGridNodeData, WorkflowNode } from "@/types";
import {
  createDefaultSplitGridTemplate,
  computeMaterializedKey,
} from "@/store/utils/splitGridTemplate";

// Mock the workflow store (selector passthrough)
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) => mockUseWorkflowStore(selector),
}));

// Stub the template modal so its React Flow mini canvas never renders
vi.mock("@/components/splitgrid/SplitGridTemplateModal", () => ({
  SplitGridTemplateModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="split-grid-template-modal">
      <button onClick={onClose}>Close Modal</button>
    </div>
  ),
}));

// Pass the full-resolution source straight through (skips thumbnail generation)
vi.mock("@/hooks/useAdaptiveImageSrc", () => ({
  useAdaptiveImageSrc: (fullSrc: string | null | undefined) => fullSrc ?? null,
}));

const NODE_ID = "split-grid-node-1";
const SOURCE_IMAGE = "data:image/png;base64,abc123";

interface StoreStateOverrides {
  isRunning?: boolean;
  nodes?: Array<{ id: string }>;
  edges?: Array<Record<string, unknown>>;
  getConnectedInputs?: ReturnType<typeof vi.fn>;
}

function setStoreState(overrides: StoreStateOverrides = {}) {
  const state = {
    updateNodeData: mockUpdateNodeData,
    regenerateNode: mockRegenerateNode,
    isRunning: false,
    currentNodeIds: [] as string[],
    setHoveredNodeId: vi.fn(),
    nodes: [] as Array<{ id: string }>,
    edges: [] as Array<Record<string, unknown>>,
    getConnectedInputs: vi.fn(() => ({ images: [] as string[], text: null })),
    ...overrides,
  };
  mockUseWorkflowStore.mockImplementation((selector: (s: typeof state) => unknown) =>
    selector(state)
  );
}

/** Store overrides simulating an upstream image connected to this node's image handle. */
function connectedImageState(image: string): StoreStateOverrides {
  return {
    edges: [{ id: "edge-img", source: "upstream-1", target: NODE_ID, targetHandle: "image" }],
    getConnectedInputs: vi.fn(() => ({ images: [image], text: null })),
  };
}

function createNodeData(overrides: Partial<SplitGridNodeData> = {}): SplitGridNodeData {
  return {
    sourceImage: null,
    gridRows: 2,
    gridCols: 3,
    targetCount: 6,
    defaultPrompt: "",
    generateSettings: {
      aspectRatio: "1:1",
      resolution: "1K",
      model: "nano-banana",
      useGoogleSearch: false,
      useImageSearch: false,
    },
    childNodeIds: [],
    isConfigured: false,
    status: "idle",
    error: null,
    ...overrides,
  };
}

/**
 * Freshly materialized data: cells matching rows*cols, a materializedKey
 * matching the current config, and the store nodes backing each cell.
 */
function materialized(rows: number, cols: number) {
  const template = createDefaultSplitGridTemplate();
  const cells: SplitGridCell[] = Array.from({ length: rows * cols }, (_, index) => ({
    baseImageNodeId: `cell-img-${index}`,
    nodeIds: [`cell-img-${index}`],
    groupId: `group-${index}`,
  }));
  return {
    data: {
      gridRows: rows,
      gridCols: cols,
      template,
      cells,
      materializedKey: computeMaterializedKey(rows, cols, template),
    } satisfies Partial<SplitGridNodeData>,
    storeNodes: cells.map((cell) => ({ id: cell.baseImageNodeId })) as WorkflowNode[],
  };
}

function renderNode(dataOverrides: Partial<SplitGridNodeData> = {}) {
  return render(
    <ReactFlowProvider>
      <SplitGridNode
        id={NODE_ID}
        type="splitGrid"
        data={createNodeData(dataOverrides)}
        selected={false}
        isConnectable={true}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
        dragging={false}
        deletable={true}
        selectable={true}
        draggable={true}
        parentId={undefined}
        dragHandle={undefined}
      />
    </ReactFlowProvider>
  );
}

describe("SplitGridNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStoreState();
  });

  describe("Handles", () => {
    it("renders an image input handle", () => {
      const { container } = renderNode();
      expect(container.querySelector('[data-handletype="image"]')).toBeInTheDocument();
    });

    it("renders a reference output handle", () => {
      const { container } = renderNode();
      expect(container.querySelector('[data-handletype="reference"]')).toBeInTheDocument();
    });
  });

  describe("Grid dimension fields", () => {
    it("renders rows and columns fields with current values", () => {
      renderNode({ gridRows: 2, gridCols: 3 });

      expect(screen.getByLabelText("Rows")).toHaveValue("2");
      expect(screen.getByLabelText("Columns")).toHaveValue("3");
    });

    it("increments rows via the increase button", () => {
      renderNode({ gridRows: 2 });

      fireEvent.click(screen.getByLabelText("Increase rows"));

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridRows: 3 });
    });

    it("decrements rows via the decrease button", () => {
      renderNode({ gridRows: 2 });

      fireEvent.click(screen.getByLabelText("Decrease rows"));

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridRows: 1 });
    });

    it("increments columns via the increase button", () => {
      renderNode({ gridCols: 3 });

      fireEvent.click(screen.getByLabelText("Increase columns"));

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridCols: 4 });
    });

    it("clears custom column offsets when the column count changes", () => {
      renderNode({ gridCols: 3, colOffsets: [0.2, 0.6] });

      fireEvent.click(screen.getByLabelText("Increase columns"));

      // Explicitly resets colOffsets so stale interior lines don't linger
      const call = mockUpdateNodeData.mock.calls.find((c) => c[0] === NODE_ID);
      expect(call?.[1]).toHaveProperty("gridCols", 4);
      expect(call?.[1]).toHaveProperty("colOffsets", undefined);
      expect("colOffsets" in (call?.[1] as object)).toBe(true);
    });

    it("clears custom row offsets when the row count changes", () => {
      renderNode({ gridRows: 2, rowOffsets: [0.4] });

      fireEvent.click(screen.getByLabelText("Increase rows"));

      const call = mockUpdateNodeData.mock.calls.find((c) => c[0] === NODE_ID);
      expect(call?.[1]).toHaveProperty("gridRows", 3);
      expect("rowOffsets" in (call?.[1] as object)).toBe(true);
    });

    it("disables the decrease button at the minimum of 1", () => {
      renderNode({ gridRows: 1 });

      expect(screen.getByLabelText("Decrease rows")).toBeDisabled();
    });

    it("disables the increase button at the maximum of 16", () => {
      renderNode({ gridRows: 16 });

      expect(screen.getByLabelText("Increase rows")).toBeDisabled();
    });

    it("commits a typed value on blur", () => {
      renderNode({ gridRows: 2 });

      const input = screen.getByLabelText("Rows");
      fireEvent.change(input, { target: { value: "5" } });
      fireEvent.blur(input);

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridRows: 5 });
    });

    it("clamps typed values above the maximum to 16", () => {
      renderNode({ gridRows: 2 });

      const input = screen.getByLabelText("Rows");
      fireEvent.change(input, { target: { value: "99" } });
      fireEvent.blur(input);

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridRows: 16 });
    });

    it("clamps typed values below the minimum to 1", () => {
      renderNode({ gridCols: 3 });

      const input = screen.getByLabelText("Columns");
      fireEvent.change(input, { target: { value: "0" } });
      fireEvent.blur(input);

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridCols: 1 });
    });

    it("does not commit non-numeric input", () => {
      renderNode({ gridRows: 2 });

      const input = screen.getByLabelText("Rows");
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.blur(input);

      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });

    it("commits on Enter by blurring the field", () => {
      renderNode({ gridRows: 2 });

      const input = screen.getByLabelText("Rows") as HTMLInputElement;
      input.focus();
      fireEvent.change(input, { target: { value: "4" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(mockUpdateNodeData).toHaveBeenCalledWith(NODE_ID, { gridRows: 4 });
    });

    it("disables the fields while the workflow is running", () => {
      setStoreState({ isRunning: true });
      renderNode();

      expect(screen.getByLabelText("Rows")).toBeDisabled();
      expect(screen.getByLabelText("Columns")).toBeDisabled();
      expect(screen.getByLabelText("Increase rows")).toBeDisabled();
    });
  });

  describe("Cell nodes button", () => {
    it("opens the template modal when clicked", () => {
      renderNode();

      expect(screen.queryByTestId("split-grid-template-modal")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /open cell editor/i }));

      expect(screen.getByTestId("split-grid-template-modal")).toBeInTheDocument();
    });

    it("closes the template modal via onClose", () => {
      renderNode();

      fireEvent.click(screen.getByRole("button", { name: /open cell editor/i }));
      expect(screen.getByTestId("split-grid-template-modal")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Close Modal"));

      expect(screen.queryByTestId("split-grid-template-modal")).not.toBeInTheDocument();
    });

    it("does not auto-open the modal on mount", () => {
      renderNode({ isConfigured: false, childNodeIds: [] });

      expect(screen.queryByTestId("split-grid-template-modal")).not.toBeInTheDocument();
    });

  });

  describe("Split button", () => {
    it("is labeled with the current grid dimensions", () => {
      renderNode({ gridRows: 2, gridCols: 3 });

      expect(screen.getByRole("button", { name: "Split 2×3 now" })).toBeInTheDocument();
    });

    it("is disabled when there is no source image", () => {
      renderNode({ sourceImage: null });

      expect(screen.getByRole("button", { name: "Split 2×3 now" })).toBeDisabled();
    });

    it("is disabled while the workflow is running", () => {
      setStoreState({ isRunning: true, ...connectedImageState(SOURCE_IMAGE) });
      renderNode({ sourceImage: SOURCE_IMAGE });

      expect(screen.getByRole("button", { name: "Split 2×3 now" })).toBeDisabled();
    });

    it("calls regenerateNode when clicked with a source image", () => {
      setStoreState(connectedImageState(SOURCE_IMAGE));
      renderNode({ sourceImage: SOURCE_IMAGE });

      const splitButton = screen.getByRole("button", { name: "Split 2×3 now" });
      expect(splitButton).toBeEnabled();

      fireEvent.click(splitButton);

      expect(mockRegenerateNode).toHaveBeenCalledWith(NODE_ID);
    });
  });

  describe("Preview", () => {
    it("shows the source image when set", () => {
      setStoreState(connectedImageState(SOURCE_IMAGE));
      renderNode({ sourceImage: SOURCE_IMAGE });

      const img = screen.getByAltText("Source grid");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", SOURCE_IMAGE);
    });

    it("overlays one grid cell per rows x cols", () => {
      setStoreState(connectedImageState(SOURCE_IMAGE));
      const { container } = renderNode({ sourceImage: SOURCE_IMAGE, gridRows: 2, gridCols: 3 });

      const gridCells = container.querySelectorAll(".border.border-blue-400\\/50");
      expect(gridCells.length).toBe(6);
    });

    it("shows the connect-image placeholder when no source image", () => {
      renderNode({ sourceImage: null });

      expect(screen.getByText("Connect image")).toBeInTheDocument();
      expect(screen.queryByAltText("Source grid")).not.toBeInTheDocument();
    });
  });

  describe("Draggable grid lines", () => {
    it("renders one draggable line per interior boundary (cols-1 vertical, rows-1 horizontal)", () => {
      setStoreState(connectedImageState(SOURCE_IMAGE));
      const { container } = renderNode({ sourceImage: SOURCE_IMAGE, gridRows: 2, gridCols: 3 });

      expect(container.querySelectorAll('[style*="col-resize"]').length).toBe(2); // 3 cols → 2 lines
      expect(container.querySelectorAll('[style*="row-resize"]').length).toBe(1); // 2 rows → 1 line
    });

    it("renders no draggable lines while a workflow is running", () => {
      setStoreState({ ...connectedImageState(SOURCE_IMAGE), isRunning: true });
      const { container } = renderNode({ sourceImage: SOURCE_IMAGE, gridRows: 2, gridCols: 3 });

      expect(container.querySelectorAll('[style*="col-resize"]').length).toBe(0);
      expect(container.querySelectorAll('[style*="row-resize"]').length).toBe(0);
    });

    it("positions cell outlines from custom offsets when lines have been dragged", () => {
      setStoreState(connectedImageState(SOURCE_IMAGE));
      const { container } = renderNode({
        sourceImage: SOURCE_IMAGE,
        gridRows: 1,
        gridCols: 2,
        colOffsets: [0.25],
      });

      const overlay = container.querySelector('[style*="grid-template-columns"]') as HTMLElement;
      // 0.25 boundary → column fractions 0.25fr / 0.75fr (not the uniform 0.5/0.5)
      expect(overlay.style.gridTemplateColumns).toBe("0.25fr 0.75fr");
    });
  });

  describe("Loading state", () => {
    it("shows a spinner overlay while loading", () => {
      setStoreState(connectedImageState(SOURCE_IMAGE));
      const { container } = renderNode({ sourceImage: SOURCE_IMAGE, status: "loading" });

      expect(container.querySelector(".animate-spin")).toBeInTheDocument();
      expect(container.querySelector(".bg-neutral-900\\/70")).toBeInTheDocument();
    });

    it("does not show the spinner when idle", () => {
      const { container } = renderNode({ status: "idle" });

      expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    });
  });

  describe("Error state", () => {
    it("shows the error message when status is error", () => {
      renderNode({ status: "error", error: "Something went wrong" });

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    it("shows a default error message when error is null", () => {
      renderNode({ status: "error", error: null });

      expect(screen.getByText("Error")).toBeInTheDocument();
    });
  });

  describe("Status text", () => {
    it("shows the stale hint when the materialized key no longer matches", () => {
      const { data, storeNodes } = materialized(2, 3);
      setStoreState({ nodes: storeNodes });
      renderNode({ ...data, materializedKey: "stale-key" });

      expect(screen.getByText("Cells out of date — Split rebuilds")).toBeInTheDocument();
    });

    it("shows the stale hint when grid dimensions changed after materialization", () => {
      const { data, storeNodes } = materialized(2, 3);
      setStoreState({ nodes: storeNodes });
      // Key was computed for 2x3; rows changed to 3 afterwards
      renderNode({ ...data, gridRows: 3 });

      expect(screen.getByText("Cells out of date — Split rebuilds")).toBeInTheDocument();
    });

    it("does not mark cells stale when a single base node was deleted (intentional pruning)", () => {
      const { data, storeNodes } = materialized(2, 3);
      setStoreState({ nodes: storeNodes.slice(1) });
      renderNode(data);

      expect(screen.queryByText("Cells out of date — Split rebuilds")).not.toBeInTheDocument();
      expect(screen.getByText("6 cell groups")).toBeInTheDocument();
    });

    it("shows the stale hint when every cell's base node is gone", () => {
      const { data } = materialized(2, 3);
      setStoreState({ nodes: [] });
      renderNode(data);

      expect(screen.getByText("Cells out of date — Split rebuilds")).toBeInTheDocument();
    });

    it("counts legacy childNodeIds cells matching the grid without marking them stale", () => {
      renderNode({
        gridRows: 1,
        gridCols: 3,
        childNodeIds: [
          { imageInput: "img-1", prompt: "p-1", nanoBanana: "gen-1" },
          { imageInput: "img-2", prompt: "p-2", nanoBanana: "gen-2" },
          { imageInput: "img-3", prompt: "p-3", nanoBanana: "gen-3" },
        ],
      });

      expect(screen.getByText("3 cell groups")).toBeInTheDocument();
      expect(screen.queryByText("Cells out of date — Split rebuilds")).not.toBeInTheDocument();
    });

    it("marks legacy cells stale when rows/cols no longer match the child count", () => {
      renderNode({
        gridRows: 2,
        gridCols: 3,
        childNodeIds: [
          { imageInput: "img-1", prompt: "p-1", nanoBanana: "gen-1" },
          { imageInput: "img-2", prompt: "p-2", nanoBanana: "gen-2" },
          { imageInput: "img-3", prompt: "p-3", nanoBanana: "gen-3" },
        ],
      });

      expect(screen.getByText("Cells out of date — Split rebuilds")).toBeInTheDocument();
    });
  });
});
