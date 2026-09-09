import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { SplitGridTemplateModal } from "@/components/splitgrid/SplitGridTemplateModal";
import { TEMPLATE_NODE_CATALOG } from "@/components/splitgrid/templateCatalog";
import type { SplitGridNodeData } from "@/types";
import type { FinalConnectionState } from "@xyflow/react";

const reactFlowCapture = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      reactFlowCapture.props = props;
      return React.createElement(actual.ReactFlow, props);
    },
  };
});

// Mock the workflow store (selector-passthrough pattern)
const mockUpdateNodeData = vi.fn();
const mockMaterializeSplitGridCells = vi.fn();
const mockIncrementModalCount = vi.fn();
const mockDecrementModalCount = vi.fn();
let mockIsRunning = false;

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) =>
    selector({
      updateNodeData: mockUpdateNodeData,
      materializeSplitGridCells: mockMaterializeSplitGridCells,
      incrementModalCount: mockIncrementModalCount,
      decrementModalCount: mockDecrementModalCount,
      isRunning: mockIsRunning,
    }),
}));

const NODE_ID = "split-grid-node-1";
const PROMPT_TEXTAREA_PLACEHOLDER = "Describe what to generate...";
const GENERATE_WARNING = "Generate Image nodes need a Prompt connected to their text input";

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

function renderModal(
  options: { nodeData?: Partial<SplitGridNodeData>; onClose?: () => void } = {}
) {
  const onClose = options.onClose ?? vi.fn();
  const result = render(
    <SplitGridTemplateModal
      nodeId={NODE_ID}
      nodeData={createNodeData(options.nodeData)}
      onClose={onClose}
    />
  );
  return { ...result, onClose };
}

function mockCanvasSize(width = 1000, height = 600): () => void {
  const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  const heightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
  return () => {
    widthSpy.mockRestore();
    heightSpy.mockRestore();
  };
}

describe("SplitGridTemplateModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = false;
  });

  describe("Rendering", () => {
    it("should render the modal title", () => {
      renderModal();

      expect(screen.getByText("Cell Node Set")).toBeInTheDocument();
    });

    it("should not render add-node toolbar chips (nodes are added via handle drag)", () => {
      renderModal();

      for (const entry of TEMPLATE_NODE_CATALOG) {
        if (entry.label === "Prompt" || entry.label === "Generate Image") continue; // preset labels overlap
        expect(screen.queryByRole("button", { name: entry.label })).not.toBeInTheDocument();
      }
    });

    it("should render presets in the header", () => {
      renderModal();

      expect(screen.getByText("Presets")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Image only" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Prompt + Generate" })).toBeInTheDocument();
    });

    it("should render the base image node with its floating title", () => {
      renderModal();

      expect(screen.getByText("Image Input")).toBeInTheDocument();
      expect(screen.getByText("Split image lands here")).toBeInTheDocument();
      expect(screen.getByText("1 per cell")).toBeInTheDocument();
    });

    it("should render both preset buttons", () => {
      renderModal();

      expect(screen.getByRole("button", { name: "Image only" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Prompt + Generate" })).toBeInTheDocument();
    });
  });

  describe("Preview geometry", () => {
    it("previews a cell slice at its real aspect and includes the image controls", () => {
      renderModal({ nodeData: {
        sourceImage: "data:image/png;base64,grid", gridRows: 5, gridCols: 9,
      } });
      const img = screen.getByAltText("Source");
      Object.defineProperties(img, {
        naturalWidth: { value: 3200 }, naturalHeight: { value: 1000 },
      });
      fireEvent.load(img);
      const clip = img.closest("[data-media-clip]") as HTMLElement;
      expect(Number(clip.style.aspectRatio)).toBeCloseTo(16 / 9);
      expect((img as HTMLElement).style.width).toBe("900%");
      expect((img as HTMLElement).style.height).toBe("500%");
      expect(img.closest("[data-node-shell]")?.querySelector("[data-controls-card]")).toHaveTextContent("split-1-1.png");
    });

    it("uses custom slice boundaries in the cell preview", () => {
      renderModal({ nodeData: {
        sourceImage: "data:image/png;base64,grid", gridRows: 2, gridCols: 2,
        colOffsets: [0.25], rowOffsets: [0.5],
      } });
      const img = screen.getByAltText("Source");
      Object.defineProperties(img, {
        naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 },
      });
      fireEvent.load(img);
      expect((img.closest("[data-media-clip]") as HTMLElement).style.aspectRatio).toBe("1");
      expect((img as HTMLElement).style.width).toBe("400%");
    });

    it("matches the real prompt height and configured generator aspect", () => {
      renderModal({ nodeData: { generateSettings: {
        aspectRatio: "16:9", resolution: "2K", model: "nano-banana-2",
        useGoogleSearch: false, useImageSearch: false,
      } } });
      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      const prompt = screen.getByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER);
      expect(prompt.closest("[data-media-clip]")).toHaveStyle({ height: "160px" });
      expect(prompt.closest("[data-node-shell]")?.querySelector("[data-controls-card]")).toHaveTextContent("Add variable");
      const generate = screen.getByText("Run to generate");
      expect(Number((generate.closest("[data-media-clip]") as HTMLElement).style.aspectRatio)).toBeCloseTo(16 / 9);
    });
  });

  describe("Modal Count", () => {
    it("should increment the modal count on mount", () => {
      renderModal();

      expect(mockIncrementModalCount).toHaveBeenCalledTimes(1);
      expect(mockDecrementModalCount).not.toHaveBeenCalled();
    });

    it("should decrement the modal count on unmount", () => {
      const { unmount } = renderModal();

      unmount();

      expect(mockDecrementModalCount).toHaveBeenCalledTimes(1);
    });
  });

  describe("Adding Nodes", () => {
    it.each(["double-click", "right-click"])("adds an unconnected node at the %s location", (gesture) => {
      renderModal();
      const pane = document.querySelector(".react-flow__pane")!;
      if (gesture === "double-click") fireEvent.doubleClick(pane, { clientX: 400, clientY: 250 });
      else fireEvent.contextMenu(pane, { clientX: 400, clientY: 250 });

      const search = screen.getByRole("textbox", { name: "Search nodes" });
      expect(screen.queryByRole("button", { name: "Generate Video" })).not.toBeInTheDocument();
      fireEvent.change(search, { target: { value: "prompt" } });
      fireEvent.keyDown(search, { key: "Enter" });
      expect(screen.queryByRole("textbox", { name: "Search nodes" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));
      const template = mockMaterializeSplitGridCells.mock.calls[0][1].template;
      expect(template.nodes).toHaveLength(2);
      expect(template.nodes[1]).toMatchObject({ type: "prompt", position: { x: 400, y: 250 } });
      expect(template.edges).toHaveLength(0);
    });

    it("dismisses the node menu with Escape without closing the editor", () => {
      const { onClose } = renderModal();
      fireEvent.contextMenu(document.querySelector(".react-flow__pane")!);
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Search nodes" }), { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "Search nodes" })).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("does not open the node menu when double-clicking a node", () => {
      renderModal();
      fireEvent.doubleClick(screen.getByText("Split image lands here"));
      expect(screen.queryByRole("textbox", { name: "Search nodes" })).not.toBeInTheDocument();
    });

    it("adds prompt and generate cards when the classic preset is applied", () => {
      renderModal();

      expect(
        screen.queryByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER)
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));

      expect(screen.getByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER)).toBeInTheDocument();
      expect(screen.getByText("Model")).toBeInTheDocument();
    });
  });

  describe("Footer", () => {
    it("should show 'Apply to 6 cells' for a 2x3 grid", () => {
      renderModal({ nodeData: { gridRows: 2, gridCols: 3 } });

      expect(screen.getByRole("button", { name: "Apply to 6 cells" })).toBeInTheDocument();
    });

    it("should show singular 'Apply to 1 cell' for a 1x1 grid", () => {
      renderModal({ nodeData: { gridRows: 1, gridCols: 1 } });

      expect(screen.getByRole("button", { name: "Apply to 1 cell" })).toBeInTheDocument();
    });
  });

  describe("Apply", () => {
    it.each(["grid", "vertical", "horizontal"] as const)("applies the %s cell layout", (layout) => {
      renderModal();
      expect(screen.getByRole("combobox", { name: "Cell layout" })).toHaveValue("grid");
      fireEvent.change(screen.getByRole("combobox", { name: "Cell layout" }), { target: { value: layout } });
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));
      const template = mockMaterializeSplitGridCells.mock.calls[0][1].template;
      expect(template.layout ?? "grid").toBe(layout);
    });

    it("restores a saved layout and preserves it when changing presets", () => {
      renderModal({ nodeData: { template: {
        baseNodeId: "cell-image", layout: "vertical",
        nodes: [{ id: "cell-image", type: "imageInput", position: { x: 0, y: 0 } }], edges: [],
      } } });
      expect(screen.getByRole("combobox", { name: "Cell layout" })).toHaveValue("vertical");
      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));
      expect(mockMaterializeSplitGridCells.mock.calls[0][1].template.layout).toBe("vertical");
    });

    it("treats a layout change as an unsaved edit", () => {
      const { onClose } = renderModal();
      fireEvent.change(screen.getByRole("combobox", { name: "Cell layout" }), { target: { value: "horizontal" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByText("Discard changes?")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("should materialize with force and the built template in one call, then close", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      expect(mockMaterializeSplitGridCells).toHaveBeenCalledWith(NODE_ID, {
        force: true,
        template: expect.objectContaining({ baseNodeId: "cell-image" }),
      });
      // Template save and materialization are atomic (single undo entry) —
      // no separate updateNodeData call
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("should include preset nodes in the applied template", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      const template = options.template;
      expect(template.nodes).toHaveLength(3);
      expect(template.nodes.map((node: { type: string }) => node.type)).toEqual(
        expect.arrayContaining(["imageInput", "prompt", "nanoBanana"])
      );
      // Generate node carries concrete settings, like a main-canvas node
      const generate = template.nodes.find((node: { type: string }) => node.type === "nanoBanana");
      expect(generate.data).toMatchObject({
        selectedModel: expect.objectContaining({ modelId: expect.any(String) }),
      });
    });

    it("preserves legacy generate settings and prompt when the classic preset is applied", () => {
      renderModal({
        nodeData: {
          defaultPrompt: "make it pop",
          generateSettings: {
            aspectRatio: "16:9",
            resolution: "2K",
            model: "nano-banana-pro",
            useGoogleSearch: true,
            useImageSearch: false,
          },
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      const template = options.template;
      const generate = template.nodes.find(
        (node: { type: string }) => node.type === "nanoBanana"
      );
      expect(generate.data).toMatchObject({
        aspectRatio: "16:9",
        resolution: "2K",
        selectedModel: expect.objectContaining({ modelId: "nano-banana-pro" }),
      });
      const promptNode = template.nodes.find(
        (node: { type: string }) => node.type === "prompt"
      );
      expect(promptNode.data).toMatchObject({ prompt: "make it pop" });
    });
  });

  describe("Unsaved changes", () => {
    it("asks before discarding when Escape is pressed after edits", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.keyDown(window, { key: "Escape" });

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText("Discard changes?")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps editing when the user declines the discard prompt", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

      expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("While a workflow is running", () => {
    it("disables Apply so cells cannot be rebuilt mid-run", () => {
      mockIsRunning = true;
      renderModal();

      const applyButton = screen.getByRole("button", { name: "Apply to 6 cells" });
      expect(applyButton).toBeDisabled();

      fireEvent.click(applyButton);
      expect(mockMaterializeSplitGridCells).not.toHaveBeenCalled();
    });
  });

  describe("Cancel", () => {
    it("should call onClose without saving the template", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
      expect(mockMaterializeSplitGridCells).not.toHaveBeenCalled();
    });
  });

  describe("Escape Key", () => {
    it("should call onClose when Escape is pressed", () => {
      const { onClose } = renderModal();

      fireEvent.keyDown(window, { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });
  });

  describe("Presets", () => {
    it("should show Prompt and Generate Image cards after applying 'Prompt + Generate'", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));

      // Prompt card body (textarea) and Generate card body (Model select) are unique to the canvas
      expect(screen.getByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER)).toBeInTheDocument();
      expect(screen.getByText("Model")).toBeInTheDocument();
      // Floating card titles
      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });
  });

  describe("Generate Prompt Warning", () => {
    it("should not show the warning initially", () => {
      renderModal();

      expect(screen.queryByText(GENERATE_WARNING)).not.toBeInTheDocument();
    });

    it("should warn when a stored template has a Generate Image node with no prompt", () => {
      renderModal({
        nodeData: {
          template: {
            baseNodeId: "cell-image",
            nodes: [
              { id: "cell-image", type: "imageInput", position: { x: 0, y: 0 } },
              { id: "cell-generate", type: "nanoBanana", position: { x: 340, y: 0 } },
            ],
            edges: [
              {
                id: "cell-image-generate",
                source: "cell-image",
                sourceHandle: "image",
                target: "cell-generate",
                targetHandle: "image",
              },
            ],
          },
        },
      });

      expect(screen.getByText(GENERATE_WARNING)).toBeInTheDocument();
    });

    it("should not warn when the preset wires a prompt into the generate node", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));

      expect(screen.queryByText(GENERATE_WARNING)).not.toBeInTheDocument();
    });
  });

  describe("Downstream router port", () => {
    const wiredTemplate: SplitGridNodeData["template"] = {
      baseNodeId: "cell-image",
      nodes: [
        { id: "cell-image", type: "imageInput", position: { x: 0, y: 0 } },
        { id: "cell-prompt", type: "prompt", position: { x: 0, y: 310 } },
        { id: "cell-generate", type: "nanoBanana", position: { x: 340, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "cell-image", sourceHandle: "image", target: "cell-generate", targetHandle: "image" },
        { id: "e2", source: "cell-prompt", sourceHandle: "text", target: "cell-generate", targetHandle: "text" },
      ],
      router: [{ source: "cell-generate", sourceHandle: "image", targetHandle: "image" }],
    };

    it("emits no router wiring for an unwired node set", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      expect(options.template.router ?? []).toHaveLength(0);
    });

    it("round-trips the router wiring into the applied template", () => {
      renderModal({ nodeData: { template: wiredTemplate } });

      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      expect(options.template.router).toEqual([
        { source: "cell-generate", sourceHandle: "image", targetHandle: "image" },
      ]);
      // The router is never emitted as a template node (it's a fixed overlay)
      expect(
        options.template.nodes.some((node: { type: string }) => node.type === "router")
      ).toBe(false);
    });

    it("clears the router wiring when a preset resets the node set", () => {
      renderModal({ nodeData: { template: wiredTemplate } });

      fireEvent.click(screen.getByRole("button", { name: "Image only" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      expect(options.template.router ?? []).toHaveLength(0);
    });

    it("adds router wiring when an output connection ends over the rail", () => {
      const restoreCanvasSize = mockCanvasSize();
      try {
        renderModal();
        const onConnectEnd = reactFlowCapture.props?.onConnectEnd as
          | ((event: MouseEvent, state: FinalConnectionState) => void)
          | undefined;
        expect(onConnectEnd).toBeTypeOf("function");

        act(() => {
          onConnectEnd?.(
            new MouseEvent("mouseup", { clientX: 950, clientY: 300 }),
            {
              isValid: false,
              fromNode: { id: "cell-image" },
              fromHandle: { id: "image", type: "source" },
            } as unknown as FinalConnectionState
          );
        });
        fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

        const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
        expect(options.template.router).toEqual([
          { source: "cell-image", sourceHandle: "image", targetHandle: "image" },
        ]);
      } finally {
        restoreCanvasSize();
      }
    });

    it("disconnects a router type through its socket control", () => {
      const restoreCanvasSize = mockCanvasSize();
      try {
        renderModal({ nodeData: { template: wiredTemplate } });
        fireEvent.click(screen.getByTitle("Disconnect Image"));
        fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

        const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
        expect(options.template.router ?? []).toHaveLength(0);
      } finally {
        restoreCanvasSize();
      }
    });

    it("disconnects one router wire through the floating delete toolbar", () => {
      const restoreCanvasSize = mockCanvasSize();
      try {
        renderModal({ nodeData: { template: wiredTemplate } });
        const wire = document.querySelector(
          '[data-wire-source="cell-generate"][data-wire-handle="image"]'
        );
        expect(wire).not.toBeNull();

        fireEvent.mouseDown(wire!, { clientX: 700, clientY: 250 });
        fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
        fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

        const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
        expect(options.template.router ?? []).toHaveLength(0);
      } finally {
        restoreCanvasSize();
      }
    });
  });
});
