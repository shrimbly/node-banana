import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeGenerateVideo } from "../generateVideoExecutor";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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

  it("should track cost for fal provider", async () => {
    const node = makeNode({
      selectedModel: { provider: "fal", modelId: "fal-vid", displayName: "Fal" },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, video: "data:video/mp4;base64,out", cost: 0.25 }),
    });

    const ctx = makeCtx(node, {
      getFreshNode: vi.fn().mockReturnValue(node),
    });
    await executeGenerateVideo(ctx);

    expect(ctx.addIncurredCost).toHaveBeenCalledWith(0.25);
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
});
