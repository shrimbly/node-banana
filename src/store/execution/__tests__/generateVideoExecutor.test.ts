import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeGenerateVideo } from "../generateVideoExecutor";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../persistentGeneration", () => ({
  submitPersistentGeneration: vi.fn(async (options: any) => {
    const run = {
      version: 1 as const,
      runId: "test-run-id",
      workflowId: options.workflowId ?? null,
      nodeId: options.nodeId,
      nodeType: "generateVideo" as const,
      provider: options.model.provider,
      modelId: options.model.modelId,
      modelName: options.model.displayName,
      mediaType: "video" as const,
      prompt: options.prompt,
      status: "running" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    options.onCreated?.(run);
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.payload),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        message = JSON.parse(text).error || message;
      } catch {
        // Keep the HTTP fallback.
      }
      throw new Error(message);
    }
    return { run, result: await response.json() };
  }),
}));

const defaultProviderSettings = {
  providers: {
    gemini: { apiKey: "" },
    replicate: { apiKey: "" },
    fal: { apiKey: "fal-key" },
    kie: { apiKey: "" },
    wavespeed: { apiKey: "" },
    openai: { apiKey: "" },
  },
} as any;

function makeNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "vid-1",
    type: "generateVideo",
    position: { x: 0, y: 0 },
    data: {
      outputVideo: null,
      inputImages: [],
      inputPrompt: null,
      status: null,
      error: null,
      selectedModel: { provider: "fal", modelId: "fal-video-model", displayName: "Fal Video" },
      parameters: {},
      videoHistory: [],
      selectedVideoHistoryIndex: 0,
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
      images: [],
      videos: [],
      audio: [],
      text: "video prompt",
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
    get: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeGenerateVideo", () => {
  it("should throw when missing required inputs", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await expect(executeGenerateVideo(ctx)).rejects.toThrow("Missing required inputs");
  });

  it("should NOT throw when only a video input is connected (video-to-video)", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,output" }),
    });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["data:video/mp4;base64,input"],
        audio: [],
        text: null,
        dynamicInputs: { video_url: "data:video/mp4;base64,input" },
        easeCurve: null,
      }),
    });

    await expect(executeGenerateVideo(ctx)).resolves.toBeUndefined();
    // dynamicInputs (which carries the connected video) must be forwarded to /api/generate
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.dynamicInputs.video_url).toBe("data:video/mp4;base64,input");
  });

  it("should throw when no model selected", async () => {
    const node = makeNode({ selectedModel: null });
    const ctx = makeCtx(node);

    await expect(executeGenerateVideo(ctx)).rejects.toThrow("No model selected");
  });

  it("should set loading status before API call", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,output" }),
    });

    const ctx = makeCtx(node);
    await executeGenerateVideo(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "loading"
    );
    expect(loadingCall).toBeDefined();
  });

  it("should call /api/generate with mediaType=video", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,output" }),
    });

    const ctx = makeCtx(node);
    await executeGenerateVideo(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.mediaType).toBe("video");
    expect(body.prompt).toBe("video prompt");
  });

  it("should update node with video result on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,output" }),
    });

    const ctx = makeCtx(node);
    await executeGenerateVideo(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![1] as Record<string, unknown>).outputVideo).toBe("data:video/mp4;base64,output");
  });

  it("should handle videoUrl field in response", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, videoUrl: "https://cdn.fal.media/video.mp4" }),
    });

    const ctx = makeCtx(node);
    await executeGenerateVideo(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect((completeCall![1] as Record<string, unknown>).outputVideo).toBe("https://cdn.fal.media/video.mp4");
  });

  it("should handle image fallback response", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,preview" }),
    });

    const ctx = makeCtx(node);
    await executeGenerateVideo(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect((completeCall![1] as Record<string, unknown>).outputVideo).toBe("data:image/png;base64,preview");
  });

  it("should not feed the fal receipt into the legacy cost counter", async () => {
    const node = makeNode({
      selectedModel: { provider: "fal", modelId: "fal-vid", displayName: "Fal" },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        video: "data:video/mp4;base64,out",
        generationCost: {
          provider: "fal",
          requestId: "fal-video-request-1",
          modelId: "fal-vid",
          units: 5,
          unit: "seconds",
          unitPrice: 0.05,
          currency: "USD",
          cost: 0.25,
        },
      }),
    });

    const ctx = makeCtx(node, {
      getFreshNode: vi.fn().mockReturnValue(node),
    });
    await executeGenerateVideo(ctx);

    expect(ctx.addIncurredCost).not.toHaveBeenCalled();
  });

  it("should throw on HTTP error", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve('{"error": "Video gen failed"}'),
    });

    const ctx = makeCtx(node);
    await expect(executeGenerateVideo(ctx)).rejects.toThrow("Video gen failed");
  });

  it("should throw on API failure", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, error: "Bad video" }),
    });

    const ctx = makeCtx(node);
    await expect(executeGenerateVideo(ctx)).rejects.toThrow("Bad video");
  });

  it("should use stored fallback in regenerate mode", async () => {
    const node = makeNode({
      inputImages: ["stored-img.png"],
      inputPrompt: "stored video prompt",
    });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
      getFreshNode: vi.fn().mockReturnValue(node),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,out" }),
    });

    await executeGenerateVideo(ctx, { useStoredFallback: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toEqual(["stored-img.png"]);
    expect(body.prompt).toBe("stored video prompt");
  });

  it("should add to video history with 50-item limit", async () => {
    const existingHistory = Array.from({ length: 50 }, (_, i) => ({
      id: `old-${i}`,
      timestamp: i,
      prompt: `old-${i}`,
      model: "m",
    }));
    const node = makeNode({ videoHistory: existingHistory });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,out" }),
    });

    const ctx = makeCtx(node, {
      getFreshNode: vi.fn().mockReturnValue(node),
    });
    await executeGenerateVideo(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    const videoHistory = (completeCall![1] as Record<string, unknown>).videoHistory as unknown[];
    expect(videoHistory.length).toBe(50); // capped at 50
  });

  it("falls back on primary failure and stamps metadata", async () => {
    const node = makeNode({
      fallbackModel: {
        provider: "replicate",
        modelId: "video-fallback",
        displayName: "Replicate Video Fallback",
      },
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "Primary video boom" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,fallback" }),
      });

    const ctx = makeCtx(node);
    await executeGenerateVideo(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.selectedModel.modelId).toBe("video-fallback");

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const stampCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).__usedFallback === true
    );
    expect(stampCall).toBeDefined();
    expect((stampCall![1] as Record<string, unknown>).__fallbackModelUsed).toBe("Replicate Video Fallback");
    expect((stampCall![1] as Record<string, unknown>).__primaryError).toBe("Primary video boom");
  });
});
