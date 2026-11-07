import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingGenerationTask, WorkflowNode } from "@/types";
import type { NodeExecutionContext } from "../types";

vi.mock("../pollTaskCompletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pollTaskCompletion")>()),
  pollGenerateTask: vi.fn(),
}));

import { GenerationStillRunningError, pollGenerateTask } from "../pollTaskCompletion";
import { USER_STOP_REASON, pendingTaskFrom, waitForPendingTask } from "../pendingTask";
import { executeGenerateVideo } from "../generateVideoExecutor";
import { executeNanoBanana } from "../nanoBananaExecutor";

const poll = vi.mocked(pollGenerateTask);
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENVELOPE = {
  success: true,
  polling: true,
  taskId: "3544457f",
  pollProvider: "comfy",
  pollModelId: "byteplus/dreamina-seedance-2-5-260628",
  pollModelName: "Seedance 2.5",
  pollMediaType: "video",
};

const TASK: PendingGenerationTask = {
  provider: "comfy",
  taskId: "3544457f",
  modelId: "byteplus/dreamina-seedance-2-5-260628",
  modelName: "Seedance 2.5",
  mediaType: "video",
  submittedAt: 1000,
};

const STILL_RUNNING = new GenerationStillRunningError("Seedance 2.5: still running on Comfy Router after 90 minutes (request 3544457f).", "3544457f", "comfy");

/** The node's data after every update the run made, merged in order. */
function finalData(updateNodeData: ReturnType<typeof vi.fn>, id: string): Record<string, unknown> {
  return updateNodeData.mock.calls
    .filter(([nodeId]) => nodeId === id)
    .reduce((data, [, patch]) => ({ ...data, ...patch }), {} as Record<string, unknown>);
}

function videoNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "vid-1",
    type: "generateVideo",
    position: { x: 0, y: 0 },
    data: {
      outputVideo: null,
      inputImages: [],
      inputPrompt: null,
      status: "idle",
      error: null,
      selectedModel: { provider: "comfy", modelId: "byteplus/dreamina-seedance-2-5-260628", displayName: "Seedance 2.5" },
      parameters: {},
      videoHistory: [],
      selectedVideoHistoryIndex: 0,
      ...data,
    },
  } as WorkflowNode;
}

function makeCtx(node: WorkflowNode, overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({ images: [], videos: [], audio: [], text: "a raid", dynamicInputs: {}, easeCurve: null }),
    updateNodeData: vi.fn(),
    getFreshNode: vi.fn().mockReturnValue(node),
    getEdges: vi.fn().mockReturnValue([]),
    getNodes: vi.fn().mockReturnValue([node]),
    providerSettings: { providers: {} } as NodeExecutionContext["providerSettings"],
    addIncurredCost: vi.fn(),
    addToGlobalHistory: vi.fn(),
    generationsPath: null,
    saveDirectoryPath: null,
    trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(),
    appendOutputGalleryVideo: vi.fn(),
    materializeSplitGridCells: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  poll.mockReset();
});

describe("pendingTaskFrom", () => {
  it("names the request a polling envelope carries", () => {
    expect(pendingTaskFrom(ENVELOPE, 1000)).toEqual(TASK);
  });
});

describe("waitForPendingTask", () => {
  function ctxFor(signal?: AbortSignal) {
    const updateNodeData = vi.fn();
    return { ctx: { node: videoNode(), updateNodeData, signal }, updateNodeData };
  }

  it("keeps the request on the node while it polls, and lets it go on the provider's answer", async () => {
    for (const answer of [{ success: true, video: "v" }, { success: false, error: "Seedance 2.5: refused" }]) {
      const { ctx, updateNodeData } = ctxFor();
      poll.mockImplementationOnce(async () => {
        expect(finalData(updateNodeData, "vid-1").pendingTask).toEqual(TASK);
        return answer;
      });
      await expect(waitForPendingTask(ctx, TASK, {})).resolves.toEqual(answer);
      expect(finalData(updateNodeData, "vid-1").pendingTask).toBeUndefined();
    }
  });

  it("polls the request with the headers it is given", async () => {
    const { ctx } = ctxFor();
    poll.mockResolvedValueOnce({ success: true });
    await waitForPendingTask(ctx, TASK, { "X-Comfy-Router-Key": "k" });
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ taskId: "3544457f", provider: "comfy", modelName: "Seedance 2.5", headers: { "X-Comfy-Router-Key": "k" } }));
  });

  it("keeps the request when the poller stops waiting without an answer", async () => {
    const { ctx, updateNodeData } = ctxFor();
    poll.mockRejectedValueOnce(STILL_RUNNING);
    await expect(waitForPendingTask(ctx, TASK, {})).rejects.toBe(STILL_RUNNING);
    expect(finalData(updateNodeData, "vid-1").pendingTask).toEqual(TASK);
  });

  it("lets the request go when the user stops the run, and keeps it on any other interruption", async () => {
    for (const [reason, kept] of [[USER_STOP_REASON, false], ["desktop-backend-disconnected", true], [undefined, true]] as const) {
      const controller = new AbortController();
      controller.abort(reason);
      const { ctx, updateNodeData } = ctxFor(controller.signal);
      poll.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));
      await expect(waitForPendingTask(ctx, TASK, {})).rejects.toThrow("aborted");
      expect(finalData(updateNodeData, "vid-1").pendingTask).toEqual(kept ? TASK : undefined);
    }
  });
});

describe("generate executors keep the request", () => {
  it("writes the request when the envelope arrives and clears it with the output", async () => {
    const node = videoNode();
    const ctx = makeCtx(node);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ENVELOPE) });
    poll.mockImplementationOnce(async () => {
      expect(finalData(ctx.updateNodeData as ReturnType<typeof vi.fn>, "vid-1").pendingTask).toMatchObject({ taskId: "3544457f", provider: "comfy" });
      return { success: true, video: "data:video/mp4;base64,AA==" };
    });

    await executeGenerateVideo(ctx);

    const data = finalData(ctx.updateNodeData as ReturnType<typeof vi.fn>, "vid-1");
    expect(data.pendingTask).toBeUndefined();
    expect(data.status).toBe("complete");
    expect(data.outputVideo).toBe("data:video/mp4;base64,AA==");
  });

  it("keeps the request, says so, and does not start the fallback when the provider is still running", async () => {
    const node = videoNode({
      fallbackModel: { provider: "fal", modelId: "fal-video", displayName: "Fal Video" },
    });
    const ctx = makeCtx(node);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ENVELOPE) });
    poll.mockRejectedValueOnce(STILL_RUNNING);

    await expect(executeGenerateVideo(ctx)).rejects.toBe(STILL_RUNNING);

    const data = finalData(ctx.updateNodeData as ReturnType<typeof vi.fn>, "vid-1");
    expect(data.pendingTask).toMatchObject({ taskId: "3544457f" });
    expect(data.status).toBe("error");
    expect(data.error).toBe(STILL_RUNNING.message);
    // One submit: the fallback never ran
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("lets go of an older request when the node runs again", async () => {
    const node = videoNode({ pendingTask: TASK, status: "error" });
    const ctx = makeCtx(node);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,AA==" }) });

    await executeGenerateVideo(ctx);

    const loading = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls.find(([, patch]) => patch.status === "loading");
    expect(loading?.[1]).toHaveProperty("pendingTask", undefined);
    expect(finalData(ctx.updateNodeData as ReturnType<typeof vi.fn>, "vid-1").pendingTask).toBeUndefined();
  });

  it("shows the provider's reason and clears the request when the run fails for real", async () => {
    const node: WorkflowNode = {
      id: "img-1",
      type: "nanoBanana",
      position: { x: 0, y: 0 },
      data: {
        inputImages: [],
        inputPrompt: null,
        outputImage: null,
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana",
        selectedModel: { provider: "comfy", modelId: "bfl/flux-2-pro", displayName: "FLUX.2 Pro" },
        useGoogleSearch: false,
        useImageSearch: false,
        status: "idle",
        error: null,
        imageHistory: [],
        selectedHistoryIndex: 0,
      },
    } as WorkflowNode;
    const ctx = makeCtx(node);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ...ENVELOPE, pollModelId: "bfl/flux-2-pro", pollModelName: "FLUX.2 Pro", pollMediaType: "image" }) });
    poll.mockResolvedValueOnce({ success: false, error: "FLUX.2 Pro: The output was refused by the provider's content policy. (content_policy_violation)" });

    await expect(executeNanoBanana(ctx)).rejects.toThrow("content policy");

    const data = finalData(ctx.updateNodeData as ReturnType<typeof vi.fn>, "img-1");
    expect(data.pendingTask).toBeUndefined();
    expect(data.status).toBe("error");
    expect(data.error).toBe("FLUX.2 Pro: The output was refused by the provider's content policy. (content_policy_violation)");
  });
});
