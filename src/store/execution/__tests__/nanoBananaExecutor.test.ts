import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeNanoBanana } from "../nanoBananaExecutor";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock calculateGenerationCost
vi.mock("@/utils/costCalculator", () => ({
  calculateGenerationCost: vi.fn().mockReturnValue(0.05),
}));

function makeNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "gen-1",
    type: "nanoBanana",
    position: { x: 0, y: 0 },
    data: {
      outputImage: null,
      inputImages: [],
      inputPrompt: null,
      status: null,
      error: null,
      aspectRatio: "1:1",
      resolution: "1024x1024",
      model: "nano-banana",
      useGoogleSearch: false,
      selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
      parameters: {},
      imageHistory: [],
      selectedHistoryIndex: 0,
      ...data,
    },
  } as WorkflowNode;
}

const defaultProviderSettings = {
  providers: {
    gemini: { apiKey: "" },
    replicate: { apiKey: "" },
    fal: { apiKey: "" },
    kie: { apiKey: "" },
    wavespeed: { apiKey: "" },
    openai: { apiKey: "" },
  },
} as any;

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
      text: "test prompt",
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
    get: vi.fn().mockReturnValue({
      edges: [],
      nodes: [node],
      addToGlobalHistory: vi.fn(),
      addIncurredCost: vi.fn(),
      generationsPath: null,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeNanoBanana", () => {
  it("should throw when no text input is provided", async () => {
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

    await expect(executeNanoBanana(ctx)).rejects.toThrow("Missing text input");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("gen-1", {
      status: "error",
      error: "Missing text input",
    });
  });

  it("should set loading status before API call", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    // Check that loading was set
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "loading"
    );
    expect(loadingCall).toBeDefined();
  });

  it("should call /api/generate with correct payload", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"prompt":"test prompt"'),
      })
    );
  });

  it("should update node with result on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![1] as Record<string, unknown>).outputImage).toBe("data:image/png;base64,result");
  });

  it("should add to global history on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(ctx.addToGlobalHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "data:image/png;base64,result",
        prompt: "test prompt",
      })
    );
  });

  it("should track cost for gemini provider", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result", cost: 0.05 }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(ctx.addIncurredCost).toHaveBeenCalledWith(0.05);
  });

  it("should track cost for fal provider", async () => {
    const node = makeNode({
      selectedModel: { provider: "fal", modelId: "fal-model", displayName: "Fal" },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result", cost: 0.10 }),
    });

    const ctx = makeCtx(node, {
      getFreshNode: vi.fn().mockReturnValue(node),
    });
    await executeNanoBanana(ctx);

    expect(ctx.addIncurredCost).toHaveBeenCalledWith(0.10);
  });

  it("should throw on HTTP error", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve('{"error": "Server exploded"}'),
    });

    const ctx = makeCtx(node);
    await expect(executeNanoBanana(ctx)).rejects.toThrow("Server exploded");

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const errorCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "error"
    );
    expect(errorCall).toBeDefined();
  });

  it("should throw on API failure (success=false)", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, error: "Bad prompt" }),
    });

    const ctx = makeCtx(node);
    await expect(executeNanoBanana(ctx)).rejects.toThrow("Bad prompt");
  });

  it("should use text from dynamicInputs.prompt when no direct text", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: { prompt: "dynamic prompt" },
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/generate",
      expect.objectContaining({
        body: expect.stringContaining('"prompt":"dynamic prompt"'),
      })
    );
  });

  it("should pass images in request payload", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,img1"],
        videos: [],
        audio: [],
        text: "with image",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toEqual(["data:image/png;base64,img1"]);
  });

  it("should fall back to stored inputs in regenerate mode", async () => {
    const node = makeNode({
      inputImages: ["stored-img.png"],
      inputPrompt: "stored prompt",
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
    });
    // Enable regenerate mode: fallback to stored inputs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx, { useStoredFallback: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toEqual(["stored-img.png"]);
    expect(body.prompt).toBe("stored prompt");
  });

  it("should push to downstream outputGallery nodes", async () => {
    const node = makeNode();
    const galleryNode = {
      id: "gal-1",
      type: "outputGallery",
      data: { images: ["old.png"] },
    } as WorkflowNode;

    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "gen-1", target: "gal-1" },
      ]),
      getNodes: vi.fn().mockReturnValue([node, galleryNode]),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    expect(ctx.appendOutputGalleryImage).toHaveBeenCalledWith("gal-1", "data:image/png;base64,result");
  });
});
