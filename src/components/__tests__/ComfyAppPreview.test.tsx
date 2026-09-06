import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

import { ComfyAppNode } from "@/components/nodes/ComfyAppNode";
import type { ComfyAppDefinition } from "@/lib/comfy/types";
import type { ComfyAppNodeData } from "@/types";

/**
 * What a running Comfy node shows.
 *
 * The latent where the engine sends one, the spinner everywhere else — the
 * first seconds of any run, and every run on a stock ComfyUI, which has no
 * event stream at all.
 */

const mockUpdateNodeData = vi.fn();
const mockUseWorkflowStore = vi.fn();
const mockPreview = vi.fn<(jobId?: string | null, active?: boolean) => string | null>(() => null);

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) =>
    selector ? mockUseWorkflowStore(selector) : mockUseWorkflowStore((s: unknown) => s),
}));

vi.mock("@/hooks/useComfyPreview", () => ({
  // Arguments forwarded, not dropped: the node deciding *when* to stream, and
  // for which job, is the half of this worth asserting.
  useComfyPreview: (jobId: string | null | undefined, active: boolean) =>
    mockPreview(jobId, active),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    useUpdateNodeInternals: () => vi.fn(),
    useReactFlow: () => ({
      getNodes: vi.fn(() => []),
      setNodes: vi.fn(),
      screenToFlowPosition: vi.fn((pos: unknown) => pos),
    }),
  };
});

const app = (): ComfyAppDefinition => ({
  id: "app-1",
  name: "Upscale Pass",
  description: "",
  source: "upload",
  graph: {},
  inputs: [],
  params: [],
  outputs: [{ id: "9", label: "Result", type: "image", nodeId: "9", classType: "SaveImage" }],
  classTypes: [],
  nodeCount: 2,
  createdAt: 0,
});

const nodeData = (over: Partial<ComfyAppNodeData> = {}): ComfyAppNodeData => ({
  app: app(),
  paramValues: {},
  outputs: {},
  outputImage: null,
  outputVideo: null,
  outputAudio: null,
  outputText: null,
  output3dUrl: null,
  status: "loading",
  runStatus: "running",
  jobId: "job_1",
  error: null,
  ...over,
});

const tree = (data: ComfyAppNodeData) => (
  <ReactFlowProvider>
    <ComfyAppNode
      id="comfyApp-1"
      type="comfyApp"
      data={data}
      selected={false}
      dragging={false}
      draggable
      selectable
      deletable
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
    />
  </ReactFlowProvider>
);

const LATENT = "data:image/jpeg;base64,AAAA";

describe("a running Comfy node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreview.mockReturnValue(null);
    mockUseWorkflowStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        updateNodeData: mockUpdateNodeData,
        edges: [],
        removeEdge: vi.fn(),
        currentNodeIds: [],
        setHoveredNodeId: vi.fn(),
      })
    );
  });

  it("streams for the job it is running, and only while it runs", () => {
    // The half the mock used to swallow. A node that asked for previews of the
    // wrong job — or kept asking after the run ended — would still have shown
    // whatever the hook returned, so every test below would pass regardless.
    render(tree(nodeData()));
    expect(mockPreview).toHaveBeenCalledWith("job_1", true);

    mockPreview.mockClear();
    render(tree(nodeData({ status: "success", runStatus: null })));
    expect(mockPreview).toHaveBeenCalledWith("job_1", false);
  });

  it("shows the latent once the engine sends one", () => {
    mockPreview.mockReturnValue(LATENT);
    render(tree(nodeData()));

    expect(screen.getByAltText("Rendering")).toHaveAttribute("src", LATENT);
  });

  it("still says it is running, over the image", () => {
    // The preview looks like a finished result at a glance, especially late in
    // a render — without this the node reads as done.
    mockPreview.mockReturnValue(LATENT);
    render(tree(nodeData()));

    expect(screen.getByText("Rendering…")).toBeInTheDocument();
  });

  it("keeps the spinner when no preview has arrived", () => {
    // Every run starts here, and a stock ComfyUI never leaves it.
    render(tree(nodeData()));

    expect(screen.queryByAltText("Rendering")).not.toBeInTheDocument();
    expect(screen.getByText("Rendering…")).toBeInTheDocument();
  });

  it("shows the real result once the run is done, not the last latent", () => {
    // The preview is a lossy, half-finished JPEG; the output is the thing the
    // user asked for, and downstream nodes get that one.
    mockPreview.mockReturnValue(LATENT);
    render(
      tree(
        nodeData({
          status: "complete",
          runStatus: null,
          jobId: null,
          outputs: { "9": "data:image/png;base64,FINAL" },
        })
      )
    );

    expect(screen.queryByAltText("Rendering")).not.toBeInTheDocument();
    expect(screen.getByAltText("Result")).toHaveAttribute(
      "src",
      "data:image/png;base64,FINAL"
    );
  });

  it("shows the error, not a stale latent, when the run fails", () => {
    mockPreview.mockReturnValue(LATENT);
    render(tree(nodeData({ status: "error", error: "Out of credits", runStatus: null })));

    expect(screen.queryByAltText("Rendering")).not.toBeInTheDocument();
    expect(screen.getByText("Out of credits")).toBeInTheDocument();
  });
});

describe("the clip of a running Comfy node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkflowStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        updateNodeData: mockUpdateNodeData,
        edges: [],
        removeEdge: vi.fn(),
        currentNodeIds: [],
        setHoveredNodeId: vi.fn(),
      })
    );
  });

  const clipAspect = (container: HTMLElement) =>
    (container.querySelector("[data-media-clip]") as HTMLElement).style.aspectRatio;

  /** jsdom never decodes an image, so its measured size is set by hand. */
  const loads = (img: HTMLElement, width: number, height: number) => {
    Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
    fireEvent.load(img);
  };

  it("keeps the measured proportions from one preview frame to the next", () => {
    // Every frame is a new data URL. Snapping back to square until each one
    // loads made a portrait node pulse twice per sampling step.
    mockPreview.mockReturnValue(LATENT);
    const { container, rerender } = render(tree(nodeData()));
    loads(screen.getByAltText("Rendering"), 1024, 1536);
    expect(clipAspect(container)).toBe(String(1024 / 1536));

    mockPreview.mockReturnValue("data:image/jpeg;base64,BBBB");
    rerender(tree(nodeData()));

    expect(screen.getByAltText("Rendering")).toHaveAttribute("src", "data:image/jpeg;base64,BBBB");
    expect(clipAspect(container)).toBe(String(1024 / 1536));
  });

  it("lets the finished result correct the proportions on its own load", () => {
    mockPreview.mockReturnValue(LATENT);
    const { container, rerender } = render(tree(nodeData()));
    loads(screen.getByAltText("Rendering"), 1024, 1536);

    const done = nodeData({ status: "complete", runStatus: null, jobId: null, outputs: { "9": "data:image/png;base64,FINAL" } });
    rerender(tree(done));
    expect(clipAspect(container)).toBe(String(1024 / 1536));

    loads(screen.getByAltText("Result"), 1920, 1080);
    expect(clipAspect(container)).toBe(String(1920 / 1080));
  });

  it("starts square again for a different workflow", () => {
    mockPreview.mockReturnValue(LATENT);
    const { container, rerender } = render(tree(nodeData()));
    loads(screen.getByAltText("Rendering"), 1024, 1536);

    rerender(tree(nodeData({ app: { ...app(), id: "app-2" } })));

    expect(clipAspect(container)).toBe("1");
  });
});
