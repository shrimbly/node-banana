/**
 * Generators hand every output to the asset library through ctx.recordAsset,
 * with the metadata of what actually ran, and put the asset's id in the
 * carousel entry written with the output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NodeExecutionContext } from "../types";
import type { ComfyAppNodeData, WorkflowEdge, WorkflowNode, WorkflowNodeData } from "@/types";
import type { RecordAssetInput, RecordAssetResult, RecordedAssetHandle } from "@/lib/assets/types";
import { executeNanoBanana } from "../nanoBananaExecutor";
import { executeGenerateVideo } from "../generateVideoExecutor";
import { executeGenerateAudio } from "../generateAudioExecutor";
import { executeGenerate3D } from "../generate3dExecutor";
import { executeComfyApp } from "../comfyAppExecutor";
import { runBatchIfApplicable } from "../batchExecution";
import {
  adoptLegacyId,
  assetParameters,
  assetProducer,
  parameterFraming,
  resolvedPrompt,
  sizeFromString,
} from "../assetRecording";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/utils/costCalculator", () => ({
  calculateGenerationCost: vi.fn().mockReturnValue(0.05),
}));

vi.mock("@/lib/comfy/settings", () => ({
  getComfySettings: () => ({ jobTimeoutMs: 600_000, randomizeSeeds: true }),
  comfyConfigError: () => null,
  buildComfyHeaders: () => ({ "Content-Type": "application/json" }),
}));

const providerSettings = { providers: {} } as never;

/** A recorder stand-in: numbered ids, and a `done` that settles with `result` (null: the recording failed). */
function makeRecorder(result: Partial<RecordAssetResult> | null = {}) {
  let count = 0;
  const handles: RecordedAssetHandle[] = [];
  const recordAsset = vi.fn((_input: RecordAssetInput): RecordedAssetHandle => {
    count += 1;
    const handle = {
      assetId: `a${String(count).padStart(12, "0")}`,
      done: Promise.resolve(result as RecordAssetResult | null),
    };
    handles.push(handle);
    return handle;
  });
  return { recordAsset, handles };
}

/**
 * One recording the test settles by hand. `hold()` is the recorder saying the
 * library is keeping it waiting (a move paused it, or the library is gone for now).
 */
function heldRecorder() {
  let settle!: (result: RecordAssetResult | null) => void;
  let hold!: () => void;
  const handle = {
    assetId: "a000000000001",
    done: new Promise<RecordAssetResult | null>((resolve) => (settle = resolve)),
    held: new Promise<void>((resolve) => (hold = resolve)),
  };
  const recordAsset = vi.fn((_input: RecordAssetInput): RecordedAssetHandle => handle);
  return { recordAsset, handle, settle: (result: RecordAssetResult | null) => settle(result), hold: () => hold() };
}

/** Whether a promise has settled yet, without waiting for it. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return settled;
}

/** A context over a tiny in-memory node map, so later writes can be read back. */
function makeCtx(node: WorkflowNode, overrides: Partial<NodeExecutionContext> = {}, text: string | null = "a red fox") {
  const nodes = new Map<string, WorkflowNode>([[node.id, node]]);
  const updateNodeData = vi.fn((id: string, data: Partial<WorkflowNodeData>) => {
    const current = nodes.get(id);
    if (current) nodes.set(id, { ...current, data: { ...current.data, ...data } as WorkflowNodeData });
  });
  const ctx: NodeExecutionContext = {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      model3d: null,
      text,
      textItems: [],
      dynamicInputs: {},
      easeCurve: null,
    }),
    updateNodeData,
    getFreshNode: (id: string) => nodes.get(id),
    getEdges: () => [],
    getNodes: () => [...nodes.values()],
    providerSettings,
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
  return { ctx, nodes, updateNodeData };
}

function completeCall(updateNodeData: ReturnType<typeof vi.fn>, field: string) {
  return updateNodeData.mock.calls.find((c) => field in (c[1] as Record<string, unknown>))?.[1] as Record<string, unknown> | undefined;
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

function imageNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "gen-1",
    type: "nanoBanana",
    position: { x: 0, y: 0 },
    data: {
      outputImage: null,
      inputImages: [],
      inputPrompt: null,
      status: "idle",
      error: null,
      aspectRatio: "1:1",
      resolution: "1K",
      model: "nano-banana",
      useGoogleSearch: false,
      useImageSearch: false,
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
      parameters: {},
      imageHistory: [],
      selectedHistoryIndex: 0,
      ...data,
    },
  } as WorkflowNode;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("recording helpers", () => {
  it("keeps settings but never media in parameters", () => {
    expect(
      assetParameters({
        seed: 7,
        style: "photo",
        image_url: "data:image/png;base64,AAAA",
        mask: "blob:http://localhost/1",
        raw: "A".repeat(2048),
        nested: { ref: "data:image/png;base64,BBBB", strength: 0.4 },
        list: ["data:x", "keep"],
      })
    ).toEqual({ seed: 7, style: "photo", nested: { strength: 0.4 }, list: ["keep"] });
    expect(assetParameters({ image: "data:image/png;base64,AAAA" })).toBeUndefined();
    expect(assetParameters(undefined)).toBeUndefined();
  });

  it("resolves the prompt a request carried", () => {
    expect(resolvedPrompt("typed", { prompt: "dynamic" })).toBe("typed");
    expect(resolvedPrompt(null, { prompt: ["from handle"] })).toBe("from handle");
    expect(resolvedPrompt(null, {})).toBeUndefined();
  });

  it("reads framing from a model's parameters and sizes from a size string", () => {
    expect(parameterFraming({ aspect_ratio: "16:9", resolution: "1080p" })).toEqual({ aspectRatio: "16:9", resolution: "1080p" });
    expect(parameterFraming({ aspectRatio: "4:3" })).toEqual({ aspectRatio: "4:3" });
    expect(parameterFraming({ aspect_ratio: 3 })).toEqual({});
    expect(sizeFromString("1536x864")).toEqual({ width: 1536, height: 864 });
    expect(sizeFromString("auto")).toEqual({});
  });

  it("names the producer by its custom title only when it has one", () => {
    const titled = makeCtx(imageNode({ customTitle: "  Hero shot " })).ctx;
    expect(assetProducer(titled, { operation: "resize" })).toEqual({
      nodeId: "gen-1",
      nodeType: "nanoBanana",
      nodeTitle: "Hero shot",
      operation: "resize",
    });
    expect(assetProducer(makeCtx(imageNode()).ctx)).toEqual({ nodeId: "gen-1", nodeType: "nanoBanana" });
  });

  it("gives the recorded asset's carousel entry the file's name", () => {
    const node = imageNode({ imageHistory: [{ id: "111", assetId: "a1", timestamp: 1, prompt: "", aspectRatio: "1:1", model: "m" }] });
    const { ctx, nodes } = makeCtx(node);
    adoptLegacyId(ctx, "imageHistory", "a1", { legacyId: "a_red_fox_abc" } as RecordAssetResult);
    expect((nodes.get("gen-1")!.data as { imageHistory: { id: string }[] }).imageHistory[0].id).toBe("a_red_fox_abc");

    // Nothing to do without a result, or for an entry that is not there
    const { ctx: other, updateNodeData } = makeCtx(imageNode());
    adoptLegacyId(other, "imageHistory", "a1", null);
    adoptLegacyId(other, "imageHistory", "a1", { legacyId: "x" } as RecordAssetResult);
    expect(updateNodeData).not.toHaveBeenCalled();
  });
});

describe("nanoBanana", () => {
  it("records the image with the model and settings that ran, and keys the carousel entry by it", async () => {
    const { recordAsset, handles } = makeRecorder();
    const node = imageNode({ customTitle: "Fox", useGoogleSearch: true });
    const { ctx, updateNodeData } = makeCtx(node, { recordAsset });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }));

    await executeNanoBanana(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "image",
      origin: "generated",
      media: "data:image/png;base64,fox",
      prompt: "a red fox",
      model: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
      parameters: { useGoogleSearch: true },
      aspectRatio: "1:1",
      resolution: "1K",
      cost: { amount: 0.05, currency: "USD", estimated: true },
      producer: { nodeId: "gen-1", nodeType: "nanoBanana", nodeTitle: "Fox" },
    });
    // The id lands with the output, in one write
    const complete = completeCall(updateNodeData, "imageHistory")!;
    expect(complete.outputImage).toBe("data:image/png;base64,fox");
    expect(complete.imageHistory).toEqual([expect.objectContaining({ assetId: handles[0].assetId, model: "nano-banana-pro" })]);
    // No project: nothing is written to a folder, and nothing holds the tabs
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(ctx.trackSaveGeneration).not.toHaveBeenCalled();
  });

  it("records the fallback model after the primary fails, with its own parameters and framing", async () => {
    const { recordAsset } = makeRecorder();
    const node = imageNode({
      selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
      fallbackModel: { provider: "fal", modelId: "fal-ai/flux", displayName: "Flux", pricing: { type: "per-run", amount: 0.03 } },
      fallbackParameters: { aspect_ratio: "16:9", seed: 4, image_url: "data:image/png;base64,in" },
    });
    const { ctx, updateNodeData } = makeCtx(node, { recordAsset });
    mockFetch
      .mockResolvedValueOnce(okJson({ success: false, error: "quota" }))
      .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,flux" }));

    await executeNanoBanana(ctx);

    expect(recordAsset).toHaveBeenCalledOnce();
    const input = recordAsset.mock.calls[0][0];
    expect(input.model).toEqual({ provider: "fal", modelId: "fal-ai/flux", displayName: "Flux" });
    expect(input.parameters).toEqual({ aspect_ratio: "16:9", seed: 4 });
    expect(input.aspectRatio).toBe("16:9");
    expect(input.resolution).toBeUndefined();
    expect(input.cost).toEqual({ amount: 0.03, currency: "USD", estimated: true });
    // The history names the model that ran, not the stale Gemini field
    expect(completeCall(updateNodeData, "imageHistory")!.imageHistory).toEqual([expect.objectContaining({ model: "Flux" })]);
    expect(ctx.addToGlobalHistory).toHaveBeenCalledWith(expect.objectContaining({ model: "Flux" }));
  });

  it("records OpenAI's reported cost and size", async () => {
    const { recordAsset } = makeRecorder();
    const node = imageNode({ selectedModel: { provider: "openai", modelId: "gpt-image-2.5-flare", displayName: "GPT Image 2.5 Flare" } });
    const generation = { modelId: "gpt-image-2.5-flare", size: "1536x864", parameters: {}, cost: { amount: 0.02, currency: "USD", estimated: false } };
    const { ctx } = makeCtx(node, { recordAsset });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/webp;base64,x", generation }));

    await executeNanoBanana(ctx);

    expect(recordAsset.mock.calls[0][0]).toMatchObject({
      cost: { amount: 0.02, currency: "USD", estimated: false },
      width: 1536,
      height: 864,
    });
    expect(ctx.addIncurredCost).toHaveBeenCalledExactlyOnceWith(0.02);
  });

  it("in a project, swaps the entry's id for the recorded file's name, tracked like a save", async () => {
    const { recordAsset, handles } = makeRecorder({ legacyId: "a_red_fox_9f8e" });
    const { ctx, nodes } = makeCtx(imageNode(), { recordAsset, generationsPath: "/proj/generations" });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }));

    await executeNanoBanana(ctx);

    // The recorder writes into the project; the old save route is not called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const track = ctx.trackSaveGeneration as ReturnType<typeof vi.fn>;
    expect(track).toHaveBeenCalledOnce();
    await track.mock.calls[0][1];
    const history = (nodes.get("gen-1")!.data as { imageHistory: { id: string; assetId?: string }[] }).imageHistory;
    expect(history).toEqual([expect.objectContaining({ id: "a_red_fox_9f8e", assetId: handles[0].assetId })]);
  });

  it("saves to the generations folder as before when the library is not recording", async () => {
    const { ctx, updateNodeData } = makeCtx(imageNode(), { generationsPath: "/proj/generations" });
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }))
      .mockResolvedValueOnce(okJson({ success: true, imageId: "a_red_fox_1" }));

    await executeNanoBanana(ctx);

    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    expect(completeCall(updateNodeData, "imageHistory")!.imageHistory).toEqual([expect.not.objectContaining({ assetId: expect.anything() })]);
  });

  it("falls back to the folder, and still finishes, when the recorder throws", async () => {
    const recordAsset = vi.fn(() => {
      throw new Error("recorder down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, updateNodeData } = makeCtx(imageNode(), { recordAsset, generationsPath: "/proj/generations" });
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }))
      .mockResolvedValueOnce(okJson({ success: true }));

    await executeNanoBanana(ctx);

    expect(completeCall(updateNodeData, "outputImage")!.status).toBe("complete");
    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    error.mockRestore();
  });

  it("in a project, saves to the folder when the recording fails, and the entry lives by the file's name", async () => {
    const { recordAsset } = makeRecorder(null);
    const { ctx, nodes } = makeCtx(imageNode(), { recordAsset, generationsPath: "/proj/generations" });
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }))
      .mockResolvedValueOnce(okJson({ success: true, imageId: "a_red_fox_1" }));

    await executeNanoBanana(ctx);
    const track = ctx.trackSaveGeneration as ReturnType<typeof vi.fn>;
    expect(track).toHaveBeenCalledOnce();
    await track.mock.calls[0][1];

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({
      directoryPath: "/proj/generations",
      image: "data:image/png;base64,fox",
      prompt: "a red fox",
    });
    // The library never stored it, so the entry keeps only the folder's name for it
    const [entry] = (nodes.get("gen-1")!.data as { imageHistory: Record<string, unknown>[] }).imageHistory;
    expect(entry.id).toBe("a_red_fox_1");
    expect(entry).not.toHaveProperty("assetId");
  });

  it("in a project, saves to the folder at once rather than hold the tabs while a library move keeps the recording waiting", async () => {
    const { recordAsset, handle, settle, hold } = heldRecorder();
    const { ctx, nodes } = makeCtx(imageNode(), { recordAsset, generationsPath: "/proj/generations" });
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }))
      .mockResolvedValueOnce(okJson({ success: true, imageId: "a_red_fox_1" }));

    await executeNanoBanana(ctx);
    const track = ctx.trackSaveGeneration as ReturnType<typeof vi.fn>;
    expect(track).toHaveBeenCalledOnce();
    const tracked = track.mock.calls[0][1] as Promise<void>;
    expect(await hasSettled(tracked)).toBe(false);

    hold();
    await tracked;
    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    const history = () => (nodes.get("gen-1")!.data as { imageHistory: Record<string, unknown>[] }).imageHistory;
    // The folder's file names the entry; it keeps its asset id, which the library records later
    expect(history()).toEqual([expect.objectContaining({ id: "a_red_fox_1", assetId: handle.assetId })]);

    // The move ends and the recording lands: the folder save came first, so its name stays
    settle({ legacyId: "143200_a_red_fox_aaaaaaaa" } as RecordAssetResult);
    expect(await hasSettled(handle.done)).toBe(true);
    expect(history()).toEqual([expect.objectContaining({ id: "a_red_fox_1", assetId: handle.assetId })]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("in a project, gives the library 20 s before saving to the folder without it", async () => {
    vi.useFakeTimers();
    try {
      const { recordAsset, settle } = heldRecorder();
      const { ctx, nodes } = makeCtx(imageNode(), { recordAsset, generationsPath: "/proj/generations" });
      mockFetch
        .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }))
        .mockResolvedValueOnce(okJson({ success: true, imageId: "a_red_fox_1" }));

      await executeNanoBanana(ctx);
      const tracked = (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1] as Promise<void>;
      await vi.advanceTimersByTimeAsync(19_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(await hasSettled(tracked)).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await tracked;
      expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");

      // A recording that fails afterwards does not save a second copy
      settle(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [entry] = (nodes.get("gen-1")!.data as { imageHistory: Record<string, unknown>[] }).imageHistory;
      expect(entry.id).toBe("a_red_fox_1");
      expect(entry).not.toHaveProperty("assetId");
    } finally {
      vi.useRealTimers();
    }
  });

  it("in a project, lets a recording that lands before the folder save name the entry", async () => {
    const { recordAsset, handle, settle, hold } = heldRecorder();
    const { ctx, nodes } = makeCtx(imageNode(), { recordAsset, generationsPath: "/proj/generations" });
    let answerSave!: (value: unknown) => void;
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }))
      .mockReturnValueOnce(new Promise((resolve) => (answerSave = resolve)));

    await executeNanoBanana(ctx);
    hold();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    settle({ legacyId: "143200_a_red_fox_aaaaaaaa" } as RecordAssetResult);
    const history = () => (nodes.get("gen-1")!.data as { imageHistory: Record<string, unknown>[] }).imageHistory;
    await vi.waitFor(() =>
      expect(history()).toEqual([expect.objectContaining({ id: "143200_a_red_fox_aaaaaaaa", assetId: handle.assetId })])
    );

    // The folder save answers after it, and leaves the entry alone
    answerSave(okJson({ success: true, imageId: "a_red_fox_1" }));
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(history()).toEqual([expect.objectContaining({ id: "143200_a_red_fox_aaaaaaaa", assetId: handle.assetId })]);
  });

  it("outside a project, leaves a recorded entry's id alone: it loads by its asset id", async () => {
    const { recordAsset, handles } = makeRecorder({ legacyId: "143200_a_red_fox_aaaaaaaa" });
    const { ctx, nodes, updateNodeData } = makeCtx(imageNode(), { recordAsset });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }));

    await executeNanoBanana(ctx);
    await handles[0].done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One write with the output, and no rename after it (which would be an undo step that changes nothing)
    expect(updateNodeData.mock.calls.filter((c) => "imageHistory" in (c[1] as Record<string, unknown>))).toHaveLength(1);
    const [entry] = (nodes.get("gen-1")!.data as { imageHistory: { id: string; assetId?: string }[] }).imageHistory;
    expect(entry.id).not.toBe("143200_a_red_fox_aaaaaaaa");
    expect(entry.assetId).toBe(handles[0].assetId);
  });

  it("outside a project, takes a failed recording's entry back out of the carousel", async () => {
    const { recordAsset } = makeRecorder(null);
    const older = { id: "older", assetId: "a-older", timestamp: 1, prompt: "", aspectRatio: "1:1", model: "m" };
    const { ctx, nodes } = makeCtx(imageNode({ imageHistory: [older], selectedHistoryIndex: 0 }), { recordAsset });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }));

    await executeNanoBanana(ctx);

    await vi.waitFor(() => {
      expect((nodes.get("gen-1")!.data as { imageHistory: { id: string }[] }).imageHistory).toEqual([older]);
    });
    // The node still shows the new image, so the selection names no entry rather than the older one
    expect(nodes.get("gen-1")!.data).toMatchObject({ outputImage: "data:image/png;base64,fox", selectedHistoryIndex: -1 });
    expect(ctx.trackSaveGeneration).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("outside a project, keeps a selection on another entry on that entry when a failed one goes", async () => {
    const { recordAsset, settle } = heldRecorder();
    const entry = (id: string) => ({ id, assetId: `a-${id}`, timestamp: 1, prompt: "", aspectRatio: "1:1", model: "m" });
    const { ctx, nodes } = makeCtx(imageNode({ imageHistory: [entry("b"), entry("c")], selectedHistoryIndex: 0 }), { recordAsset });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,fox" }));

    await executeNanoBanana(ctx);
    // The user steps back to "c" (index 2) before the recording fails
    ctx.updateNodeData("gen-1", { selectedHistoryIndex: 2 });
    settle(null);

    await vi.waitFor(() => {
      expect((nodes.get("gen-1")!.data as { imageHistory: { id: string }[] }).imageHistory.map((e) => e.id)).toEqual(["b", "c"]);
    });
    expect((nodes.get("gen-1")!.data as { selectedHistoryIndex: number }).selectedHistoryIndex).toBe(1);
  });

  it("tags each batch item's asset with its index", async () => {
    const { recordAsset } = makeRecorder();
    const { ctx } = makeCtx(imageNode(), { recordAsset });
    (ctx.getConnectedInputs as ReturnType<typeof vi.fn>).mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      model3d: null,
      text: null,
      textItems: ["one", "two"],
      dynamicInputs: {},
      easeCurve: null,
    });
    mockFetch.mockResolvedValue(okJson({ success: true, image: "data:image/png;base64,x" }));

    await expect(runBatchIfApplicable(ctx)).resolves.toBe(true);

    expect(recordAsset.mock.calls.map((c) => [c[0].prompt, c[0].producer.batchIndex])).toEqual([
      ["one", 0],
      ["two", 1],
    ]);
  });
});

describe("generateVideo", () => {
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
        selectedModel: { provider: "fal", modelId: "fal-ai/kling", displayName: "Kling", pricing: { type: "per-run", amount: 0.4 } },
        parameters: { duration: "5", aspect_ratio: "9:16" },
        videoHistory: [],
        selectedVideoHistoryIndex: 0,
        ...data,
      },
    } as WorkflowNode;
  }

  it("records the video, with the prompt a dynamic handle supplied", async () => {
    const { recordAsset, handles } = makeRecorder();
    const { ctx, updateNodeData } = makeCtx(videoNode(), { recordAsset }, null);
    (ctx.getConnectedInputs as ReturnType<typeof vi.fn>).mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      model3d: null,
      text: null,
      textItems: [],
      dynamicInputs: { prompt: "waves at dusk" },
      easeCurve: null,
    });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, videoUrl: "https://cdn.example/v.mp4" }));

    await executeGenerateVideo(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "video",
      origin: "generated",
      media: "https://cdn.example/v.mp4",
      prompt: "waves at dusk",
      model: { provider: "fal", modelId: "fal-ai/kling", displayName: "Kling" },
      parameters: { duration: "5", aspect_ratio: "9:16" },
      aspectRatio: "9:16",
      cost: { amount: 0.4, currency: "USD", estimated: true },
      producer: { nodeId: "vid-1", nodeType: "generateVideo" },
    });
    expect(completeCall(updateNodeData, "videoHistory")!.videoHistory).toEqual([
      expect.objectContaining({ assetId: handles[0].assetId, model: "fal-ai/kling" }),
    ]);
    expect(ctx.trackSaveGeneration).not.toHaveBeenCalled();
  });

  it("records a still when the model answers with an image", async () => {
    const { recordAsset } = makeRecorder();
    const { ctx } = makeCtx(videoNode(), { recordAsset });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, image: "data:image/png;base64,still" }));

    await executeGenerateVideo(ctx);

    expect(recordAsset.mock.calls[0][0]).toMatchObject({ kind: "image", media: "data:image/png;base64,still" });
  });

  it("in a project, swaps the entry's id for the recorded file's name", async () => {
    const { recordAsset } = makeRecorder({ legacyId: "waves_1a2b" });
    const { ctx, nodes } = makeCtx(videoNode(), { recordAsset, generationsPath: "/proj/generations" });
    mockFetch.mockResolvedValueOnce(okJson({ success: true, video: "data:video/mp4;base64,v" }));

    await executeGenerateVideo(ctx);
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect((nodes.get("vid-1")!.data as { videoHistory: { id: string }[] }).videoHistory[0].id).toBe("waves_1a2b");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("in a project, hands a video whose recording failed to the folder save, which fetches the provider's URL itself", async () => {
    const { recordAsset } = makeRecorder(null);
    const { ctx, nodes } = makeCtx(videoNode(), { recordAsset, generationsPath: "/proj/generations" }, "waves");
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, videoUrl: "http://cdn.example/v.mp4" }))
      .mockResolvedValueOnce(okJson({ success: true, imageId: "waves_1a2b" }));

    await executeGenerateVideo(ctx);
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({ video: "http://cdn.example/v.mp4", prompt: "waves" });
    const [entry] = (nodes.get("vid-1")!.data as { videoHistory: Record<string, unknown>[] }).videoHistory;
    expect(entry.id).toBe("waves_1a2b");
    expect(entry).not.toHaveProperty("assetId");
  });

  it("in a batch, sends each item in the slot the batch feeds, beside the other slots", async () => {
    const { ctx } = makeCtx(videoNode(), { recordAsset: makeRecorder().recordAsset });
    (ctx.getConnectedInputs as ReturnType<typeof vi.fn>).mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      model3d: null,
      text: "one",
      textItems: ["one", "two"],
      textItemsInput: "prompt",
      dynamicInputs: { prompt: "one", negative_prompt: "blurry" },
      easeCurve: null,
    });
    mockFetch.mockResolvedValue(okJson({ success: true, video: "data:video/mp4;base64,v" }));

    await expect(runBatchIfApplicable(ctx)).resolves.toBe(true);

    expect(mockFetch.mock.calls.map((c) => JSON.parse(c[1].body)).map((body) => [body.prompt, body.dynamicInputs])).toEqual([
      ["one", { prompt: "one", negative_prompt: "blurry" }],
      ["two", { prompt: "two", negative_prompt: "blurry" }],
    ]);
  });
});

describe("generateAudio", () => {
  function audioNode(): WorkflowNode {
    return {
      id: "aud-1",
      type: "generateAudio",
      position: { x: 0, y: 0 },
      data: {
        outputAudio: null,
        inputPrompt: null,
        status: "idle",
        error: null,
        selectedModel: { provider: "kie", modelId: "elevenlabs/tts", displayName: "ElevenLabs" },
        parameters: { voice: "Rachel" },
        audioHistory: [],
        selectedAudioHistoryIndex: 0,
        duration: null,
        format: null,
      },
    } as WorkflowNode;
  }

  it("records the audio and keys the carousel entry by it", async () => {
    const { recordAsset, handles } = makeRecorder();
    const { ctx, updateNodeData } = makeCtx(audioNode(), { recordAsset }, "hello there");
    mockFetch.mockResolvedValueOnce(okJson({ success: true, audio: "data:audio/mpeg;base64,a" }));

    await executeGenerateAudio(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "audio",
      origin: "generated",
      media: "data:audio/mpeg;base64,a",
      prompt: "hello there",
      model: { provider: "kie", modelId: "elevenlabs/tts", displayName: "ElevenLabs" },
      parameters: { voice: "Rachel" },
      producer: { nodeId: "aud-1", nodeType: "generateAudio" },
    });
    expect(completeCall(updateNodeData, "audioHistory")!.audioHistory).toEqual([
      expect.objectContaining({ assetId: handles[0].assetId }),
    ]);
  });

  it("in a project, swaps the entry's id for the recorded file's name", async () => {
    const { recordAsset } = makeRecorder({ legacyId: "hello_there_77" });
    const { ctx, nodes } = makeCtx(audioNode(), { recordAsset, generationsPath: "/proj/generations" }, "hello there");
    mockFetch.mockResolvedValueOnce(okJson({ success: true, audio: "data:audio/mpeg;base64,a" }));

    await executeGenerateAudio(ctx);
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect((nodes.get("aud-1")!.data as { audioHistory: { id: string }[] }).audioHistory[0].id).toBe("hello_there_77");
  });

  it("in a project, saves the audio to the folder when its recording fails", async () => {
    const { recordAsset } = makeRecorder(null);
    const { ctx, nodes } = makeCtx(audioNode(), { recordAsset, generationsPath: "/proj/generations" }, "hello there");
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, audio: "data:audio/mpeg;base64,a" }))
      .mockResolvedValueOnce(okJson({ success: true, imageId: "hello_there_77" }));

    await executeGenerateAudio(ctx);
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({ audio: "data:audio/mpeg;base64,a", imageId: expect.any(String) });
    const [entry] = (nodes.get("aud-1")!.data as { audioHistory: Record<string, unknown>[] }).audioHistory;
    expect(entry.id).toBe("hello_there_77");
    expect(entry).not.toHaveProperty("assetId");
  });
});

describe("generate3d", () => {
  function modelNode(): WorkflowNode {
    return {
      id: "3d-1",
      type: "generate3d",
      position: { x: 0, y: 0 },
      data: {
        inputImages: [],
        inputPrompt: null,
        output3dUrl: null,
        savedFilename: null,
        savedFilePath: null,
        status: "idle",
        error: null,
        selectedModel: { provider: "fal", modelId: "fal-ai/trellis", displayName: "Trellis", pricing: { type: "per-run", amount: 0.25 } },
        parameters: {},
      },
    } as WorkflowNode;
  }

  const saved = {
    filename: "HHMMSS_chair_12345678.glb",
    legacyId: "HHMMSS_chair_12345678",
    asset: { displayPath: "/Users/me/Pictures/Node Banana/Generations/2026-09-27/HHMMSS_chair_12345678.glb" },
  } as unknown as RecordAssetResult;

  it("records the provider's URL for the server to download, then points the node at the saved file", async () => {
    const { recordAsset } = makeRecorder(saved);
    const { ctx, nodes } = makeCtx(modelNode(), { recordAsset }, "a chair");
    mockFetch.mockResolvedValueOnce(okJson({ success: true, model3dUrl: "https://cdn.example/chair.glb" }));

    await executeGenerate3D(ctx);
    await Promise.resolve();
    await Promise.resolve();

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "3d",
      origin: "generated",
      media: "https://cdn.example/chair.glb",
      prompt: "a chair",
      model: { provider: "fal", modelId: "fal-ai/trellis", displayName: "Trellis" },
      cost: { amount: 0.25, currency: "USD", estimated: true },
      producer: { nodeId: "3d-1", nodeType: "generate3d" },
    });
    await vi.waitFor(() => {
      expect(nodes.get("3d-1")!.data).toMatchObject({ savedFilename: saved.filename, savedFilePath: saved.asset.displayPath });
    });
    // Not a project: the tabs are not held for it
    expect(ctx.trackSaveGeneration).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("leaves a node that has moved on to another model alone", async () => {
    let settle!: (value: RecordAssetResult) => void;
    const recordAsset = vi.fn(() => ({ assetId: "a000000000001", done: new Promise<RecordAssetResult | null>((r) => (settle = r)) }));
    const { ctx, nodes, updateNodeData } = makeCtx(modelNode(), { recordAsset, generationsPath: "/proj/generations" }, "a chair");
    mockFetch.mockResolvedValueOnce(okJson({ success: true, model3dUrl: "https://cdn.example/chair.glb" }));

    await executeGenerate3D(ctx);
    updateNodeData("3d-1", { output3dUrl: "https://cdn.example/other.glb" });
    settle(saved);
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(nodes.get("3d-1")!.data).toMatchObject({ savedFilename: null, savedFilePath: null });
  });

  it("in a project, saves the model to the folder when the library could not download it", async () => {
    const { recordAsset } = makeRecorder(null);
    const { ctx, nodes } = makeCtx(modelNode(), { recordAsset, generationsPath: "/proj/generations" }, "a chair");
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, model3dUrl: "http://cdn.example/chair.glb" }))
      .mockResolvedValueOnce(okJson({ success: true, filename: "chair.glb", filePath: "/proj/generations/chair.glb" }));

    await executeGenerate3D(ctx);
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({ model3d: "http://cdn.example/chair.glb", prompt: "a chair" });
    expect(nodes.get("3d-1")!.data).toMatchObject({ savedFilename: "chair.glb", savedFilePath: "/proj/generations/chair.glb" });
  });

  it("in a project, saves the model to the folder at once when the library holds its recording up", async () => {
    const { recordAsset, settle, hold } = heldRecorder();
    const { ctx, nodes } = makeCtx(modelNode(), { recordAsset, generationsPath: "/proj/generations" }, "a chair");
    mockFetch
      .mockResolvedValueOnce(okJson({ success: true, model3dUrl: "https://cdn.example/chair.glb" }))
      .mockResolvedValueOnce(okJson({ success: true, filename: "chair.glb", filePath: "/proj/generations/chair.glb" }));

    await executeGenerate3D(ctx);
    const tracked = (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1] as Promise<void>;
    expect(await hasSettled(tracked)).toBe(false);
    hold();
    await tracked;
    expect(mockFetch.mock.calls[1][0]).toBe("/api/save-generation");
    expect(nodes.get("3d-1")!.data).toMatchObject({ savedFilename: "chair.glb", savedFilePath: "/proj/generations/chair.glb" });

    // The recording lands later; the node keeps pointing at the file the folder save wrote
    settle(saved);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nodes.get("3d-1")!.data).toMatchObject({ savedFilename: "chair.glb", savedFilePath: "/proj/generations/chair.glb" });
  });

  it("in a batch, generates a model per item, each asset tagged with its index", async () => {
    const { recordAsset } = makeRecorder();
    const { ctx } = makeCtx(modelNode(), { recordAsset });
    (ctx.getConnectedInputs as ReturnType<typeof vi.fn>).mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      model3d: null,
      text: "a chair",
      textItems: ["a chair", "a lamp"],
      dynamicInputs: {},
      easeCurve: null,
    });
    mockFetch.mockResolvedValue(okJson({ success: true, model3dUrl: "https://cdn.example/m.glb" }));

    await expect(runBatchIfApplicable(ctx)).resolves.toBe(true);

    expect(mockFetch.mock.calls.map((c) => JSON.parse(c[1].body).prompt)).toEqual(["a chair", "a lamp"]);
    expect(recordAsset.mock.calls.map((c) => [c[0].prompt, c[0].producer.batchIndex])).toEqual([
      ["a chair", 0],
      ["a lamp", 1],
    ]);
  });
});

describe("comfyApp", () => {
  const app = {
    id: "app-1",
    name: "Upscaler",
    description: "",
    source: "upload",
    graph: {},
    inputs: [],
    params: [],
    outputs: [
      { id: "9", label: "Image", type: "image", nodeId: "9", classType: "SaveImage" },
      { id: "12", label: "Video", type: "video", nodeId: "12", classType: "SaveVideo" },
      { id: "15", label: "Caption", type: "text", nodeId: "15", classType: "ShowText" },
    ],
    classTypes: [],
    nodeCount: 3,
    createdAt: 1,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records every media output under its handle, and nothing to the folder", async () => {
    vi.useFakeTimers();
    const { recordAsset } = makeRecorder();
    const node = { id: "comfy-1", type: "comfyApp", position: { x: 0, y: 0 }, data: { app, paramValues: { "3:steps": 20 }, status: "idle" } } as unknown as WorkflowNode;
    const { ctx } = makeCtx(node, { recordAsset, generationsPath: "/proj/generations" });
    mockFetch.mockImplementation(async (url: string) =>
      url === "/api/comfy/run"
        ? okJson({ success: true, polling: true, jobId: "job-1", status: "queued" })
        : okJson({
            success: true,
            polling: false,
            status: "success",
            outputs: [
              { handleId: "9", type: "image", value: "data:image/png;base64,big" },
              { handleId: "12", type: "video", value: "data:video/mp4;base64,clip" },
              { handleId: "15", type: "text", value: "a caption" },
            ],
          })
    );

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(recordAsset.mock.calls.map((c) => [c[0].kind, c[0].producer.outputHandle, c[0].media])).toEqual([
      ["image", "9", "data:image/png;base64,big"],
      ["video", "12", "data:video/mp4;base64,clip"],
    ]);
    expect(recordAsset.mock.calls[0][0]).toMatchObject({
      origin: "generated",
      prompt: "Upscaler (steps=20)",
      model: { provider: "comfyui", modelId: "Upscaler", displayName: "Upscaler" },
      parameters: { "3:steps": 20, seedKey: expect.stringMatching(/^comfy-1-\d+$/) },
      producer: { nodeId: "comfy-1", nodeType: "comfyApp" },
    });
    expect(mockFetch.mock.calls.some((c) => c[0] === "/api/save-generation")).toBe(false);
    // The image and the video are both listed in recent generations; the video with its recording
    const listed = vi.mocked(ctx.addToGlobalHistory).mock.calls;
    expect(listed.map(([item, recording]) => [item.kind ?? "image", item.image, recording?.assetId])).toEqual([
      ["image", "data:image/png;base64,big", undefined],
      ["video", "data:video/mp4;base64,clip", "a000000000002"],
    ]);
    expect(listed[1][0]).toMatchObject({ prompt: "Upscaler (steps=20)", model: "Upscaler" });
  });

  it("lists an app whose only output is a video in recent generations", async () => {
    vi.useFakeTimers();
    const { recordAsset } = makeRecorder();
    const node = { id: "comfy-1", type: "comfyApp", position: { x: 0, y: 0 }, data: { app, paramValues: {}, status: "idle" } } as unknown as WorkflowNode;
    const { ctx } = makeCtx(node, { recordAsset });
    mockFetch.mockImplementation(async (url: string) =>
      url === "/api/comfy/run"
        ? okJson({ success: true, polling: true, jobId: "job-1", status: "queued" })
        : okJson({
            success: true,
            polling: false,
            status: "success",
            outputs: [{ handleId: "12", type: "video", value: "data:video/mp4;base64,clip" }],
          })
    );

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    expect(ctx.addToGlobalHistory).toHaveBeenCalledOnce();
    expect(ctx.addToGlobalHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video", image: "data:video/mp4;base64,clip", model: "Upscaler" }),
      expect.objectContaining({ assetId: "a000000000001" })
    );
  });

  it("runs with the seeds the node shows, then moves each on by its mode", async () => {
    // ComfyUI's "control after generate": the node shows the seed its next
    // run uses, and the mode says what that becomes once a run has taken it.
    vi.useFakeTimers();
    const seed = (id: string, extra: object = {}) => ({ id, label: "seed", nodeId: id.split(":")[0], inputKey: "seed", type: "integer", isSeed: true, ...extra });
    const seeded = { ...app, params: [seed("25:seed"), seed("26:seed"), seed("27:seed", { maximum: 9 }), seed("28:seed")] };
    const node = {
      id: "comfy-1",
      type: "comfyApp",
      position: { x: 0, y: 0 },
      data: {
        app: seeded,
        paramValues: { "25:seed": 41, "26:seed": 7, "27:seed": 9, "28:seed": 5 },
        seedModes: { "25:seed": "increment", "26:seed": "fixed", "27:seed": "increment", "28:seed": "decrement" },
        status: "idle",
      },
    } as unknown as WorkflowNode;
    const { ctx, nodes } = makeCtx(node, { recordAsset: makeRecorder().recordAsset });
    mockFetch.mockImplementation(async (url: string) =>
      url === "/api/comfy/run"
        ? okJson({ success: true, polling: true, jobId: "job-1", status: "queued" })
        : okJson({ success: true, polling: false, status: "success", outputs: [{ handleId: "9", type: "image", value: "data:image/png;base64,big" }] })
    );

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    const submitted = JSON.parse(mockFetch.mock.calls.find((c) => c[0] === "/api/comfy/run")![1].body);
    expect(submitted.params).toEqual({ "25:seed": 41, "26:seed": 7, "27:seed": 9, "28:seed": 5 });
    // Stepping past the maximum wraps to the minimum, as ComfyUI does.
    expect((nodes.get("comfy-1")!.data as { paramValues: unknown }).paramValues).toEqual({ "25:seed": 42, "26:seed": 7, "27:seed": 0, "28:seed": 4 });
  });

  it("gives a seed with no value yet one to run with, and records the seed it ran with", async () => {
    vi.useFakeTimers();
    const { recordAsset } = makeRecorder();
    const seeded = { ...app, params: [{ id: "25:seed", label: "seed", nodeId: "25", inputKey: "seed", type: "integer", isSeed: true }] };
    const node = { id: "comfy-1", type: "comfyApp", position: { x: 0, y: 0 }, data: { app: seeded, paramValues: {}, status: "idle" } } as unknown as WorkflowNode;
    const { ctx, nodes } = makeCtx(node, { recordAsset });
    mockFetch.mockImplementation(async (url: string) =>
      url === "/api/comfy/run"
        ? okJson({ success: true, polling: true, jobId: "job-1", status: "queued" })
        : okJson({ success: true, polling: false, status: "success", outputs: [{ handleId: "9", type: "image", value: "data:image/png;base64,big" }] })
    );

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    const ran = JSON.parse(mockFetch.mock.calls.find((c) => c[0] === "/api/comfy/run")![1].body).params["25:seed"];
    expect(Number.isInteger(ran)).toBe(true);
    expect(recordAsset.mock.calls[0][0].parameters).toMatchObject({ "25:seed": ran });
    // Random, the default: the node now shows the next one.
    expect((nodes.get("comfy-1")!.data as { paramValues: Record<string, unknown> }).paramValues["25:seed"]).toEqual(expect.any(Number));
  });

  describe("in a batch", () => {
    const text = (nodeId: string, name: string) => ({ id: `${nodeId}:text`, name, label: name, type: "text", nodeId, inputKey: "text", required: true });
    const prompted = { ...app, inputs: [text("6", "positive"), text("7", "negative")] };
    const items = ["a fox", "a hare", "an owl"];

    function batchRun(overrides: Partial<NodeExecutionContext> = {}) {
      const node = { id: "comfy-1", type: "comfyApp", position: { x: 0, y: 0 }, data: { app: prompted, paramValues: {}, status: "idle" } } as unknown as WorkflowNode;
      const made = makeCtx(node, overrides);
      (made.ctx.getConnectedInputs as ReturnType<typeof vi.fn>).mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        model3d: null,
        text: items[0],
        textItems: items,
        textItemsInput: "positive",
        dynamicInputs: { positive: items[0], negative: "blurry" },
        easeCurve: null,
      });
      return made;
    }

    const runBodies = () => mockFetch.mock.calls.filter((c) => c[0] === "/api/comfy/run").map((c) => JSON.parse(c[1].body));

    it("runs the app once per item, each in the slot the batch feeds", async () => {
      vi.useFakeTimers();
      const { recordAsset } = makeRecorder();
      const { ctx, nodes } = batchRun({ recordAsset });
      let jobs = 0;
      mockFetch.mockImplementation(async (url: string, init: { body: string }) =>
        url === "/api/comfy/run"
          ? okJson({ success: true, polling: true, jobId: `job-${++jobs}`, status: "queued" })
          : okJson({
              success: true,
              polling: false,
              status: "success",
              outputs: [{ handleId: "9", type: "image", value: `data:image/png;base64,${JSON.parse(init.body).jobId}` }],
            })
      );

      const run = runBatchIfApplicable(ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(run).resolves.toBe(true);

      expect(runBodies().map((body) => body.inputs)).toEqual(items.map((item) => ({ positive: item, negative: "blurry" })));
      expect(recordAsset.mock.calls.map((c) => [c[0].media, c[0].producer.batchIndex])).toEqual([
        ["data:image/png;base64,job-1", 0],
        ["data:image/png;base64,job-2", 1],
        ["data:image/png;base64,job-3", 2],
      ]);
      const data = nodes.get("comfy-1")!.data as ComfyAppNodeData;
      expect(data.runHistory!.map((entry) => entry.prompt)).toEqual([
        "Upscaler: an owl · blurry",
        "Upscaler: a hare · blurry",
        "Upscaler: a fox · blurry",
      ]);
      expect(data.selectedRunHistoryIndex).toBe(0);
      expect(data.status).toBe("complete");
    });

    it("hands each item's result to the Output Gallery it feeds, by the handle the edge leaves", async () => {
      vi.useFakeTimers();
      const gallery = { id: "gallery-1", type: "outputGallery", position: { x: 0, y: 0 }, data: { images: [], videos: [] } } as unknown as WorkflowNode;
      const { ctx } = batchRun({
        recordAsset: makeRecorder().recordAsset,
        getEdges: () => [
          { id: "e1", source: "comfy-1", sourceHandle: "9", target: "gallery-1", targetHandle: "image" },
          { id: "e2", source: "comfy-1", sourceHandle: "12", target: "gallery-1", targetHandle: "video" },
        ] as WorkflowEdge[],
        getNodes: () => [gallery],
      });
      let jobs = 0;
      mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
        if (url === "/api/comfy/run") return okJson({ success: true, polling: true, jobId: `job-${++jobs}`, status: "queued" });
        const { jobId } = JSON.parse(init.body);
        return okJson({
          success: true,
          polling: false,
          status: "success",
          outputs: [
            { handleId: "9", type: "image", value: `data:image/png;base64,${jobId}` },
            { handleId: "12", type: "video", value: `data:video/mp4;base64,${jobId}` },
            { handleId: "15", type: "text", value: "a caption" },
          ],
        });
      });

      const run = runBatchIfApplicable(ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      await run;

      expect((ctx.appendOutputGalleryImage as ReturnType<typeof vi.fn>).mock.calls).toEqual([
        ["gallery-1", "data:image/png;base64,job-1"],
        ["gallery-1", "data:image/png;base64,job-2"],
        ["gallery-1", "data:image/png;base64,job-3"],
      ]);
      expect((ctx.appendOutputGalleryVideo as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual([
        "data:video/mp4;base64,job-1",
        "data:video/mp4;base64,job-2",
        "data:video/mp4;base64,job-3",
      ]);
    });

    const finished = (value: string) =>
      okJson({ success: true, polling: false, status: "success", outputs: [{ handleId: "9", type: "image", value }] });
    const cancels = () =>
      mockFetch.mock.calls
        .filter((c) => c[0] === "/api/comfy/poll")
        .map((c) => JSON.parse(c[1].body))
        .filter((body) => body.cancel)
        .map((body) => body.jobId);

    it("stops at a failed item and leaves the node in error with its message", async () => {
      vi.useFakeTimers();
      const { ctx, nodes } = batchRun({ recordAsset: makeRecorder().recordAsset });
      let jobs = 0;
      mockFetch.mockImplementation(async (url: string) => {
        if (url !== "/api/comfy/run") return finished("data:image/png;base64,x");
        jobs += 1;
        return jobs === 2
          ? { ok: false, status: 400, text: async () => JSON.stringify({ success: false, error: "Prompt outputs failed validation" }) }
          : okJson({ success: true, polling: true, jobId: `job-${jobs}`, status: "queued" });
      });

      const failed = expect(runBatchIfApplicable(ctx)).rejects.toThrow("Prompt outputs failed validation");
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;

      expect(runBodies()).toHaveLength(2);
      const data = nodes.get("comfy-1")!.data as ComfyAppNodeData;
      expect(data).toMatchObject({ status: "error", error: "Prompt outputs failed validation" });
      expect(data.runHistory).toHaveLength(1);
    });

    it("on Stop, cancels the running item's job and runs no more", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const { ctx, nodes } = batchRun({ recordAsset: makeRecorder().recordAsset, signal: controller.signal });
      let jobs = 0;
      mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
        if (url === "/api/comfy/run") return okJson({ success: true, polling: true, jobId: `job-${++jobs}`, status: "queued" });
        const body = JSON.parse(init.body);
        if (body.cancel) return okJson({ success: true });
        // The first item finishes; the second is still rendering
        return body.jobId === "job-1" ? finished("data:image/png;base64,x") : okJson({ success: true, polling: true, status: "running" });
      });

      const stopped = expect(runBatchIfApplicable(ctx)).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(5_000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await stopped;

      expect(runBodies()).toHaveLength(2);
      expect(cancels()).toEqual(["job-2"]);
      const data = nodes.get("comfy-1")!.data as ComfyAppNodeData;
      expect(data.status).toBe("idle");
      expect(data.runHistory).toHaveLength(1);
    });

    it("on a Stop between items, keeps the finished item and runs no more", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const { ctx, nodes } = batchRun({ recordAsset: makeRecorder().recordAsset, signal: controller.signal });
      mockFetch.mockImplementation(async (url: string) => {
        if (url === "/api/comfy/run") return okJson({ success: true, polling: true, jobId: "job-1", status: "queued" });
        // Stop lands as the first item's result comes back
        controller.abort();
        return finished("data:image/png;base64,x");
      });

      const stopped = expect(runBatchIfApplicable(ctx)).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;

      expect(runBodies()).toHaveLength(1);
      const data = nodes.get("comfy-1")!.data as ComfyAppNodeData;
      expect(data.status).toBe("complete");
      expect(data.runHistory).toHaveLength(1);
    });
  });

  function comfyRun(recordAsset: NodeExecutionContext["recordAsset"]) {
    const node = { id: "comfy-1", type: "comfyApp", position: { x: 0, y: 0 }, data: { app, paramValues: {}, status: "idle" } } as unknown as WorkflowNode;
    const { ctx } = makeCtx(node, { recordAsset, generationsPath: "/proj/generations" });
    mockFetch.mockImplementation(async (url: string) =>
      url === "/api/comfy/run"
        ? okJson({ success: true, polling: true, jobId: "job-1", status: "queued" })
        : url === "/api/save-generation"
          ? okJson({ success: true })
          : okJson({
              success: true,
              polling: false,
              status: "success",
              outputs: [{ handleId: "9", type: "image", value: "data:image/png;base64,big" }],
            })
    );
    return ctx;
  }

  it("in a project, saves the image to the folder when its recording fails", async () => {
    vi.useFakeTimers();
    const { recordAsset } = makeRecorder(null);
    const ctx = comfyRun(recordAsset);

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    const track = ctx.trackSaveGeneration as ReturnType<typeof vi.fn>;
    expect(track).toHaveBeenCalledOnce();
    await track.mock.calls[0][1];

    const save = mockFetch.mock.calls.find((c) => c[0] === "/api/save-generation");
    expect(JSON.parse(save![1].body)).toMatchObject({ directoryPath: "/proj/generations", image: "data:image/png;base64,big" });
  });

  it("in a project, saves the image to the folder at once when the library holds its recording up", async () => {
    vi.useFakeTimers();
    const { recordAsset, hold } = heldRecorder();
    const ctx = comfyRun(recordAsset);

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    const tracked = (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1] as Promise<void>;
    expect(await hasSettled(tracked)).toBe(false);
    expect(mockFetch.mock.calls.some((c) => c[0] === "/api/save-generation")).toBe(false);

    hold();
    await vi.advanceTimersByTimeAsync(0);
    await tracked;
    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/save-generation")).toHaveLength(1);
  });

  it("in a project, saves the image to the folder when the recorder throws", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = comfyRun(() => {
      throw new Error("recorder down");
    });

    const run = executeComfyApp(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    await (ctx.trackSaveGeneration as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(mockFetch.mock.calls.filter((c) => c[0] === "/api/save-generation")).toHaveLength(1);
    error.mockRestore();
  });
});
