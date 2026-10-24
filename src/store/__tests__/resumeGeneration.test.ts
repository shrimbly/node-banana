/**
 * Picking up a kept provider request (resumeGeneration): it polls the request
 * the node kept and finishes it as the run would have, into the carousel and
 * the asset library, as a single node's own run outside any batch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GenerateVideoNodeData, PendingGenerationTask, WorkflowNode } from "@/types";

const recorder = vi.hoisted(() => ({
  isRecorderEnabled: vi.fn(() => true),
  beginRun: vi.fn(),
  endRun: vi.fn(),
  recordAsset: vi.fn(),
}));
vi.mock("@/lib/assets/client/recorder", () => recorder);
vi.mock("@/lib/assets/client/snapshot", () => ({ captureGraph: () => ({}) }));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
vi.mock("../execution/pollTaskCompletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution/pollTaskCompletion")>()),
  pollGenerateTask: vi.fn(),
}));

import { GenerationStillRunningError, pollGenerateTask } from "../execution/pollTaskCompletion";
import { useWorkflowStore } from "../workflowStore";

const poll = vi.mocked(pollGenerateTask);
const initial = useWorkflowStore.getState();
const store = () => useWorkflowStore.getState();

const TASK: PendingGenerationTask = {
  provider: "comfy",
  taskId: "3544457f",
  modelId: "byteplus/dreamina-seedance-2-5-260628",
  modelName: "Seedance 2.5",
  mediaType: "video",
  submittedAt: 1000,
};

function videoNode(data: Partial<GenerateVideoNodeData> = {}): WorkflowNode {
  return {
    id: "vid-1",
    type: "generateVideo",
    position: { x: 0, y: 0 },
    data: {
      inputImages: [],
      inputPrompt: "an armoured trap house raid",
      outputVideo: null,
      selectedModel: { provider: "comfy", modelId: TASK.modelId, displayName: "Seedance 2.5" },
      parameters: { duration: 10 },
      status: "error",
      error: "Seedance 2.5: still running on Comfy Router after 90 minutes (request 3544457f).",
      videoHistory: [],
      selectedVideoHistoryIndex: 0,
      pendingTask: TASK,
      ...data,
    },
  } as WorkflowNode;
}

const nodeData = () => store().nodes.find((n) => n.id === "vid-1")!.data as GenerateVideoNodeData;

describe("resumeGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poll.mockReset();
    recorder.recordAsset.mockImplementation(() => ({ assetId: "a-picked-up", done: new Promise(() => {}) }));
    useWorkflowStore.setState({
      ...initial,
      nodes: [videoNode()],
      edges: [],
      groups: {},
      isRunning: false,
      currentNodeIds: [],
      batch: null,
      providerSettings: {
        ...initial.providerSettings,
        providers: { ...initial.providerSettings.providers, comfy: { ...initial.providerSettings.providers.comfy, apiKey: "comfy-key" } },
      },
    });
  });

  it("finishes the kept request into the carousel and the asset library, and lets it go", async () => {
    poll.mockResolvedValueOnce({ success: true, video: "data:video/mp4;base64,AA==" });

    await store().resumeGeneration("vid-1");

    expect(poll).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "3544457f",
      provider: "comfy",
      modelId: TASK.modelId,
      headers: expect.objectContaining({ "X-Comfy-Router-Key": "comfy-key" }),
    }));
    expect(recorder.recordAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "video",
        media: "data:video/mp4;base64,AA==",
        prompt: "an armoured trap house raid",
        parameters: { duration: 10 },
      }),
      expect.anything()
    );
    const data = nodeData();
    expect(data.outputVideo).toBe("data:video/mp4;base64,AA==");
    expect(data.status).toBe("complete");
    expect(data.error).toBeNull();
    expect(data.pendingTask).toBeUndefined();
    expect(data.videoHistory[0]).toMatchObject({ assetId: "a-picked-up", prompt: "an armoured trap house raid", model: TASK.modelId });
    expect(store().isRunning).toBe(false);
  });

  it("shows the provider's reason and lets the request go when the run failed", async () => {
    const reason = "Seedance 2.5: The model's generated output was refused by the provider's content policy. (content_policy_violation)";
    poll.mockResolvedValueOnce({ success: false, error: reason });

    await store().resumeGeneration("vid-1");

    const data = nodeData();
    expect(data.status).toBe("error");
    expect(data.error).toBe(reason);
    expect(data.pendingTask).toBeUndefined();
    expect(recorder.recordAsset).not.toHaveBeenCalled();
  });

  it("keeps the request when the provider is still running it", async () => {
    const stillRunning = new GenerationStillRunningError("Seedance 2.5: still running on Comfy Router after 90 minutes (request 3544457f).", "3544457f", "comfy");
    poll.mockRejectedValueOnce(stillRunning);

    await store().resumeGeneration("vid-1");

    const data = nodeData();
    expect(data.status).toBe("error");
    expect(data.error).toBe(stillRunning.message);
    expect(data.pendingTask).toEqual(TASK);
    expect(store().isRunning).toBe(false);
  });

  it("lets the request go and settles the node when the user stops it", async () => {
    poll.mockImplementationOnce(({ signal }) =>
      new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))))
    );

    const picking = store().resumeGeneration("vid-1");
    await vi.waitFor(() => expect(nodeData().status).toBe("loading"));
    store().stopWorkflow();
    await picking;

    const data = nodeData();
    expect(data.status).toBe("idle");
    expect(data.pendingTask).toBeUndefined();
    expect(store().isRunning).toBe(false);
  });

  it("waits for a workflow run, and does nothing for a node without a kept request", async () => {
    useWorkflowStore.setState({ isRunning: true });
    await store().resumeGeneration("vid-1");
    expect(poll).not.toHaveBeenCalled();

    useWorkflowStore.setState({ isRunning: false, nodes: [videoNode({ pendingTask: undefined })] });
    await store().resumeGeneration("vid-1");
    expect(poll).not.toHaveBeenCalled();
    expect(store().isRunning).toBe(false);
  });
});
