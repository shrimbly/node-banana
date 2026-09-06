import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeSplitGrid } from "../splitGridExecutor";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode, SplitGridCell } from "@/types";

// Mock gridSplitter (dynamically imported by the executor)
const { mockSplitWithDimensions } = vi.hoisted(() => ({
  mockSplitWithDimensions: vi.fn(),
}));
vi.mock("@/utils/gridSplitter", () => ({
  splitWithDimensions: mockSplitWithDimensions,
}));

// Mock Image constructor for dimension loading.
// Srcs added to `failingSrcs` fire onerror instead of onload.
const failingSrcs = new Set<string>();
class MockImage {
  width = 512;
  height = 512;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(val: string) {
    this._src = val;
    // Use queueMicrotask so handlers fire after assignment
    queueMicrotask(() => {
      if (failingSrcs.has(val)) {
        this.onerror?.();
      } else {
        this.onload?.();
      }
    });
  }
}
vi.stubGlobal("Image", MockImage);

const SOURCE_IMAGE = "data:image/png;base64,source";
const SPLIT_IMAGES = ["split-0.png", "split-1.png", "split-2.png", "split-3.png"];

const defaultProviderSettings = {
  providers: {
    gemini: { apiKey: "" },
    replicate: { apiKey: "" },
    fal: { apiKey: "" },
    kie: { apiKey: "" },
    wavespeed: { apiKey: "" },
    openai: { apiKey: "" },
  },
} as never;

function makeCells(count: number): SplitGridCell[] {
  return Array.from({ length: count }, (_, i) => ({
    baseImageNodeId: `cell-img-${i}`,
    nodeIds: [`cell-img-${i}`],
    groupId: `group-${i}`,
  }));
}

function makeNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "sg-1",
    type: "splitGrid",
    position: { x: 0, y: 0 },
    data: {
      sourceImage: null,
      status: null,
      error: null,
      gridRows: 2,
      gridCols: 2,
      cells: makeCells(4),
      materializedKey: null,
      // Deprecated legacy fields (kept in the data shape)
      targetCount: 4,
      defaultPrompt: "",
      generateSettings: {
        aspectRatio: "1:1",
        resolution: "1024x1024",
        model: "nano-banana",
        useGoogleSearch: false,
        useImageSearch: false,
      },
      childNodeIds: [],
      isConfigured: true,
      ...data,
    },
  } as WorkflowNode;
}

function makeCtx(
  node: WorkflowNode,
  overrides: Partial<NodeExecutionContext> = {}
): NodeExecutionContext {
  return {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({
      images: [SOURCE_IMAGE],
      videos: [],
      audio: [],
      model3d: null,
      text: null,
      textItems: [],
      dynamicInputs: {},
      easeCurve: null,
    }),
    updateNodeData: vi.fn(),
    getFreshNode: vi.fn().mockReturnValue(node),
    getEdges: vi.fn().mockReturnValue([]),
    getNodes: vi.fn().mockReturnValue([node]),
    providerSettings: defaultProviderSettings,
    addIncurredCost: vi.fn(),
    addToGlobalHistory: vi.fn(),
    generationsPath: null,
    saveDirectoryPath: null,
    trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(),
    appendOutputGalleryVideo: vi.fn(),
    materializeSplitGridCells: vi.fn().mockReturnValue(false),
    get: vi.fn(),
    ...overrides,
  };
}

function updateCalls(ctx: NodeExecutionContext): unknown[][] {
  return (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
}

function callsForNode(ctx: NodeExecutionContext, nodeId: string): Record<string, unknown>[] {
  return updateCalls(ctx)
    .filter((c) => c[0] === nodeId)
    .map((c) => c[1] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  failingSrcs.clear();
  mockSplitWithDimensions.mockResolvedValue({
    grid: { rows: 2, cols: 2, cells: [], confidence: 1 },
    images: [...SPLIT_IMAGES],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeSplitGrid", () => {
  describe("input validation", () => {
    it("throws and sets error status when no input image is connected", async () => {
      const node = makeNode();
      const ctx = makeCtx(node, {
        getConnectedInputs: vi.fn().mockReturnValue({
          images: [],
          videos: [],
          audio: [],
          model3d: null,
          text: null,
          textItems: [],
          dynamicInputs: {},
          easeCurve: null,
        }),
      });

      await expect(executeSplitGrid(ctx)).rejects.toThrow("No input image connected");
      expect(ctx.updateNodeData).toHaveBeenCalledWith("sg-1", {
        status: "skipped",
        error: "No input image connected",
      });
      expect(ctx.materializeSplitGridCells).not.toHaveBeenCalled();
      expect(mockSplitWithDimensions).not.toHaveBeenCalled();
    });
  });

  describe("status transitions", () => {
    it("sets sourceImage with loading status, then complete on success", async () => {
      const node = makeNode();
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      const selfCalls = callsForNode(ctx, "sg-1");
      const loadingIndex = selfCalls.findIndex((d) => d.status === "loading");
      const completeIndex = selfCalls.findIndex((d) => d.status === "complete");

      expect(loadingIndex).toBeGreaterThanOrEqual(0);
      expect(selfCalls[loadingIndex]).toEqual({
        sourceImage: SOURCE_IMAGE,
        status: "loading",
        error: null,
      });
      expect(completeIndex).toBeGreaterThan(loadingIndex);
      expect(selfCalls[completeIndex]).toEqual({ status: "complete", error: null });
    });
  });

  describe("materialization", () => {
    it("calls materializeSplitGridCells with the node id", async () => {
      const node = makeNode();
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      expect(ctx.materializeSplitGridCells).toHaveBeenCalledTimes(1);
      expect(ctx.materializeSplitGridCells).toHaveBeenCalledWith("sg-1");
    });

    it("re-reads the node after materialization and populates the new cells", async () => {
      const cells = makeCells(4);
      const unmaterialized = makeNode({ cells: [] });
      const materialized = makeNode({ cells });
      let currentNode = unmaterialized;

      const ctx = makeCtx(unmaterialized, {
        getFreshNode: vi.fn(() => currentNode),
        materializeSplitGridCells: vi.fn(() => {
          currentNode = materialized;
          return true;
        }),
      });

      await executeSplitGrid(ctx);

      for (let i = 0; i < 4; i++) {
        expect(ctx.updateNodeData).toHaveBeenCalledWith(
          `cell-img-${i}`,
          expect.objectContaining({ image: SPLIT_IMAGES[i] })
        );
      }
    });
  });

  describe("cell population", () => {
    it("splits the source image with the node's rows and cols", async () => {
      const node = makeNode({ gridRows: 2, gridCols: 2 });
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      expect(mockSplitWithDimensions).toHaveBeenCalledWith(SOURCE_IMAGE, 2, 2, {
        colOffsets: undefined,
        rowOffsets: undefined,
      });
    });

    it("forwards custom interior line offsets to the splitter", async () => {
      const node = makeNode({
        gridRows: 2,
        gridCols: 2,
        colOffsets: [0.3],
        rowOffsets: [0.7],
      });
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      expect(mockSplitWithDimensions).toHaveBeenCalledWith(SOURCE_IMAGE, 2, 2, {
        colOffsets: [0.3],
        rowOffsets: [0.7],
      });
    });

    it("populates each cell's base image node with its slice, filename, and dimensions", async () => {
      const node = makeNode();
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      // 2x2 grid: row-major filenames split-{row}-{col}.png
      const expectedFilenames = ["split-1-1.png", "split-1-2.png", "split-2-1.png", "split-2-2.png"];
      for (let i = 0; i < 4; i++) {
        expect(ctx.updateNodeData).toHaveBeenCalledWith(`cell-img-${i}`, {
          image: SPLIT_IMAGES[i],
          imageRef: undefined,
          filename: expectedFilenames[i],
          dimensions: { width: 512, height: 512 },
        });
      }
    });

    it("falls back to legacy childNodeIds when cells is empty", async () => {
      const node = makeNode({
        cells: [],
        childNodeIds: [
          { imageInput: "legacy-img-0", prompt: "legacy-p-0", nanoBanana: "legacy-g-0" },
          { imageInput: "legacy-img-1", prompt: "legacy-p-1", nanoBanana: "legacy-g-1" },
          { imageInput: "legacy-img-2", prompt: "legacy-p-2", nanoBanana: "legacy-g-2" },
          { imageInput: "legacy-img-3", prompt: "legacy-p-3", nanoBanana: "legacy-g-3" },
        ],
      });
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      for (let i = 0; i < 4; i++) {
        expect(ctx.updateNodeData).toHaveBeenCalledWith(
          `legacy-img-${i}`,
          expect.objectContaining({ image: SPLIT_IMAGES[i] })
        );
      }
      const selfCalls = callsForNode(ctx, "sg-1");
      expect(selfCalls.some((d) => d.status === "complete")).toBe(true);
    });

    it("falls back to legacy childNodeIds when cells is undefined", async () => {
      const node = makeNode({
        cells: undefined,
        childNodeIds: [{ imageInput: "legacy-img-0", prompt: "legacy-p-0", nanoBanana: "legacy-g-0" }],
      });
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      expect(ctx.updateNodeData).toHaveBeenCalledWith(
        "legacy-img-0",
        expect.objectContaining({ image: SPLIT_IMAGES[0] })
      );
    });

    it("skips cells with a missing baseImageNodeId without throwing", async () => {
      const node = makeNode({
        cells: [
          { baseImageNodeId: "", nodeIds: [] },
          { baseImageNodeId: "cell-img-1", nodeIds: ["cell-img-1"] },
          { baseImageNodeId: "", nodeIds: [] },
          { baseImageNodeId: "cell-img-3", nodeIds: ["cell-img-3"] },
        ],
      });
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      const targetIds = updateCalls(ctx).map((c) => c[0]);
      expect(targetIds).not.toContain("");
      expect(ctx.updateNodeData).toHaveBeenCalledWith(
        "cell-img-1",
        expect.objectContaining({ image: SPLIT_IMAGES[1] })
      );
      expect(ctx.updateNodeData).toHaveBeenCalledWith(
        "cell-img-3",
        expect.objectContaining({ image: SPLIT_IMAGES[3] })
      );
      const selfCalls = callsForNode(ctx, "sg-1");
      expect(selfCalls.some((d) => d.status === "complete")).toBe(true);
    });

    it("skips cells beyond the number of split images", async () => {
      mockSplitWithDimensions.mockResolvedValue({
        grid: { rows: 2, cols: 2, cells: [], confidence: 1 },
        images: ["split-0.png", "split-1.png"],
      });
      const node = makeNode();
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      expect(ctx.updateNodeData).toHaveBeenCalledWith(
        "cell-img-0",
        expect.objectContaining({ image: "split-0.png" })
      );
      expect(ctx.updateNodeData).toHaveBeenCalledWith(
        "cell-img-1",
        expect.objectContaining({ image: "split-1.png" })
      );
      const targetIds = updateCalls(ctx).map((c) => c[0]);
      expect(targetIds).not.toContain("cell-img-2");
      expect(targetIds).not.toContain("cell-img-3");
    });

    it("clears a cell's image when the split slice fails to load", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      failingSrcs.add("split-1.png");
      const node = makeNode();
      const ctx = makeCtx(node);

      await executeSplitGrid(ctx);

      expect(ctx.updateNodeData).toHaveBeenCalledWith("cell-img-1", {
        image: null,
        filename: null,
        dimensions: { width: 0, height: 0 },
      });
      // Other cells still populated; execution still completes
      expect(ctx.updateNodeData).toHaveBeenCalledWith(
        "cell-img-0",
        expect.objectContaining({ image: "split-0.png" })
      );
      const selfCalls = callsForNode(ctx, "sg-1");
      expect(selfCalls.some((d) => d.status === "complete")).toBe(true);
    });
  });

  describe("error handling", () => {
    it("sets status idle and rethrows on AbortError", async () => {
      const abortError = new DOMException("Aborted", "AbortError");
      mockSplitWithDimensions.mockRejectedValue(abortError);
      const node = makeNode();
      const ctx = makeCtx(node);

      await expect(executeSplitGrid(ctx)).rejects.toBe(abortError);

      expect(ctx.updateNodeData).toHaveBeenCalledWith("sg-1", { status: "idle", error: null });
      const selfCalls = callsForNode(ctx, "sg-1");
      expect(selfCalls.some((d) => d.status === "error")).toBe(false);
      expect(selfCalls.some((d) => d.status === "complete")).toBe(false);
    });

    it("sets status error and rethrows when splitting fails", async () => {
      mockSplitWithDimensions.mockRejectedValue(new Error("Canvas failure"));
      const node = makeNode();
      const ctx = makeCtx(node);

      await expect(executeSplitGrid(ctx)).rejects.toThrow("Canvas failure");

      expect(ctx.updateNodeData).toHaveBeenCalledWith("sg-1", {
        status: "error",
        error: "Canvas failure",
      });
      const selfCalls = callsForNode(ctx, "sg-1");
      expect(selfCalls.some((d) => d.status === "complete")).toBe(false);
    });

    it("wraps non-Error failures in a generic error", async () => {
      mockSplitWithDimensions.mockRejectedValue("string failure");
      const node = makeNode();
      const ctx = makeCtx(node);

      await expect(executeSplitGrid(ctx)).rejects.toThrow("Failed to split image");

      expect(ctx.updateNodeData).toHaveBeenCalledWith("sg-1", {
        status: "error",
        error: "Failed to split image",
      });
    });

    it("sets status error when materialization throws", async () => {
      const node = makeNode();
      const ctx = makeCtx(node, {
        materializeSplitGridCells: vi.fn(() => {
          throw new Error("Materialization failed");
        }),
      });

      await expect(executeSplitGrid(ctx)).rejects.toThrow("Materialization failed");

      expect(ctx.updateNodeData).toHaveBeenCalledWith("sg-1", {
        status: "error",
        error: "Materialization failed",
      });
      expect(mockSplitWithDimensions).not.toHaveBeenCalled();
    });
  });
});
