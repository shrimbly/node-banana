import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { executeNanoBanana, executeGlbViewer, executeVideoTrim } from "../execution";
import type { NodeExecutionContext } from "../execution";
import type { WorkflowNode } from "@/types";
import { hydrateWorkflowMedia } from "@/utils/mediaStorage";

vi.mock("@/utils/mediaStorage", () => ({
  externalizeWorkflowMedia: vi.fn(async (workflow) => workflow),
  hydrateWorkflowMedia: vi.fn(async (workflow) => workflow),
}));

vi.mock("../execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution")>(),
  executeNanoBanana: vi.fn(),
  executeGlbViewer: vi.fn(),
  executeVideoTrim: vi.fn(),
  runBatchIfApplicable: vi.fn(async () => false),
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    startSession: vi.fn(async () => undefined), endSession: vi.fn(async () => undefined),
    getCurrentSession: vi.fn(() => null),
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const store = () => useWorkflowStore.getState();
const node = (id: string, type = "nanoBanana"): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { status: "idle", outputImage: "original" } }) as WorkflowNode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hydrateWorkflowMedia).mockImplementation(async (workflow) => workflow);
  store().clearWorkflow();
  useWorkflowStore.setState({ nodes: [node("generate-1")], isSaving: false });
});
afterEach(() => store().clearWorkflow());

const runners = {
  workflow: () => store().executeWorkflow(),
  selected: () => store().executeSelectedNodes(["generate-1"]),
  regenerate: () => store().regenerateNode("generate-1"),
};

describe("execution ownership", () => {
  it("cancels a run started during hydration before replacing its graph", async () => {
    const hydration = deferred();
    const generation = deferred();
    vi.mocked(hydrateWorkflowMedia).mockImplementationOnce(async (workflow) => {
      await hydration.promise;
      return workflow;
    });
    vi.mocked(executeNanoBanana).mockImplementationOnce(async (ctx) => {
      await generation.promise;
      ctx.updateNodeData(ctx.node.id, { outputImage: "outgoing-graph-result" });
    });
    const loading = store().loadWorkflow({
      version: 1, name: "Loaded", edgeStyle: "angular", edges: [],
      nodes: [{ ...node("generate-1"), data: { status: "idle", outputImage: "loaded-image" } } as WorkflowNode],
    }, "/loaded");
    const running = store().executeWorkflow();
    await vi.waitFor(() => expect(executeNanoBanana).toHaveBeenCalledOnce());
    const controller = store()._abortController!;
    const lifecycleDuringHydration = store().workflowLifecycleId;
    hydration.resolve();
    await loading;
    expect(controller.signal.aborted).toBe(true);
    expect(store()._abortController).toBeNull();
    expect(store().workflowLifecycleId).toBeGreaterThan(lifecycleDuringHydration);
    generation.resolve();
    await running;
    expect(store().nodes[0].data.outputImage).toBe("loaded-image");
    expect(store().workflowName).toBe("Loaded");
    expect(store().hasUnsavedChanges).toBe(false);
  });

  it.each(Object.keys(runners) as (keyof typeof runners)[])("%s completion cannot overwrite or unlock a newer run", async (kind) => {
    const first = deferred();
    const second = deferred();
    vi.mocked(executeNanoBanana)
      .mockImplementationOnce(async (ctx) => {
        await first.promise;
        ctx.updateNodeData(ctx.node.id, { outputImage: "stale-first-result" });
      })
      .mockImplementationOnce(async (ctx) => {
        ctx.updateNodeData(ctx.node.id, { outputImage: "second-result" });
        await second.promise;
      });
    const oldRun = runners[kind]();
    await vi.waitFor(() => expect(executeNanoBanana).toHaveBeenCalledTimes(1));
    store().stopWorkflow();
    const newRun = runners[kind]();
    await vi.waitFor(() => expect(executeNanoBanana).toHaveBeenCalledTimes(2));
    const owner = store()._abortController;

    first.resolve();
    await oldRun;
    expect(store().isRunning).toBe(true);
    expect(store()._abortController).toBe(owner);
    expect(store().currentNodeIds).toEqual(["generate-1"]);
    expect(store().nodes[0].data.outputImage).toBe("second-result");
    await runners[kind]();
    expect(executeNanoBanana).toHaveBeenCalledTimes(2);

    second.resolve();
    await newRun;
    expect(store().isRunning).toBe(false);
  });

  it.each(Object.keys(runners) as (keyof typeof runners)[])("%s failure cannot clear a newer controller or mark its nodes failed", async (kind) => {
    const first = deferred();
    const second = deferred();
    vi.mocked(executeNanoBanana).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldRun = runners[kind]();
    await vi.waitFor(() => expect(executeNanoBanana).toHaveBeenCalledTimes(1));
    store().stopWorkflow();
    const newRun = runners[kind]();
    await vi.waitFor(() => expect(executeNanoBanana).toHaveBeenCalledTimes(2));
    const owner = store()._abortController;
    first.reject(new Error("Old request failed"));
    await oldRun;
    expect(store()._abortController).toBe(owner);
    expect(store().isRunning).toBe(true);
    expect(store().nodes[0].data.status).toBe("idle");
    second.resolve();
    await newRun;
  });

  it("guards regeneration branches that finish immediately after an executor", async () => {
    useWorkflowStore.setState({ nodes: [node("trim-1", "videoTrim")] });
    const first = deferred();
    const second = deferred();
    vi.mocked(executeVideoTrim).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldRun = store().regenerateNode("trim-1");
    await vi.waitFor(() => expect(executeVideoTrim).toHaveBeenCalledTimes(1));
    store().stopWorkflow();
    const newRun = store().regenerateNode("trim-1");
    await vi.waitFor(() => expect(executeVideoTrim).toHaveBeenCalledTimes(2));
    const owner = store()._abortController;
    first.resolve();
    await oldRun;
    expect(store()._abortController).toBe(owner);
    expect(store().isRunning).toBe(true);
    second.resolve();
    await newRun;
  });

  it.each(["regenerate", "selected"] as const)("%s passes cancellation into downstream consumers", async (kind) => {
    useWorkflowStore.setState({
      nodes: [node("generate-1"), node("viewer-1", "glbViewer")],
      edges: [{ id: "e", source: "generate-1", target: "viewer-1" }],
    });
    vi.mocked(executeNanoBanana).mockResolvedValueOnce(undefined);
    const pending = deferred();
    let downstream!: NodeExecutionContext;
    vi.mocked(executeGlbViewer).mockImplementationOnce(async (ctx) => {
      downstream = ctx;
      await pending.promise;
      ctx.updateNodeData(ctx.node.id, { outputImage: "stale-viewer-result" });
    });
    const run = runners[kind]();
    await vi.waitFor(() => expect(executeGlbViewer).toHaveBeenCalledOnce());
    store().stopWorkflow();
    expect(downstream.signal?.aborted).toBe(true);
    pending.resolve();
    await run;
    expect(store().nodes[1].data.outputImage).toBe("original");
  });

  it("rejects all context writes after the graph is replaced, even without a signal", () => {
    const ctx = store()._buildExecutionContext(store().nodes[0]);
    store().clearWorkflow();
    useWorkflowStore.setState({ nodes: [node("generate-1"), { ...node("gallery", "outputGallery"), data: { images: [], videos: [] } } as WorkflowNode] });
    ctx.updateNodeData("generate-1", { outputImage: "stale" });
    ctx.appendOutputGalleryImage("gallery", "stale");
    ctx.appendOutputGalleryVideo("gallery", "stale");
    ctx.addIncurredCost(10);
    ctx.addToGlobalHistory({ image: "stale", timestamp: 0, prompt: "test", model: "nano-banana", aspectRatio: "1:1" });
    expect(store().nodes[0].data.outputImage).toBe("original");
    expect(store().nodes[1].data).toEqual({ images: [], videos: [] });
    expect(store().incurredCost).toBe(0);
    expect(store().globalImageHistory).toEqual([]);
  });
});
