/**
 * Edited outputs (a resize, a trim, a cut-out, a split) are assets too: they
 * go to the library as "edited", with the operation that made them, and a
 * re-run that reproduced the previous output is not recorded again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode, WorkflowNodeData, WorkflowEdge } from "@/types";
import type { AssetRunContext, RecordAssetInput, RecordAssetResult, RecordedAssetHandle } from "@/lib/assets/types";
import { beginRun, endRun, recordAsset as recordInLibrary } from "@/lib/assets/client/recorder";
import type { CapturedGraph } from "@/lib/assets/client/snapshot";
import { assetView, jsonResponse, recordResult } from "@/lib/assets/client/__tests__/helpers";
import { executeRemoveBackground } from "../removeBackgroundExecutor";
import { executeImageResize, executeGifEncoder } from "../imageProcessingExecutors";
import { executeVideoStitch, executeVideoTrim, executeEaseCurve, executeVideoFrameGrab } from "../videoProcessingExecutors";
import { executeSplitGrid } from "../splitGridExecutor";

const mocks = vi.hoisted(() => ({
  removeImageBackground: vi.fn(),
  resizeImage: vi.fn(),
  encodeFramesToGif: vi.fn(),
  stitchVideosAsync: vi.fn(),
  trimVideoAsync: vi.fn(),
  applySpeedCurveAsync: vi.fn(),
  splitWithDimensions: vi.fn(),
}));
vi.mock("@/utils/backgroundRemoval", () => ({ removeImageBackground: mocks.removeImageBackground }));
vi.mock("@/utils/imageResize", () => ({ resizeImage: mocks.resizeImage }));
vi.mock("@/utils/gifEncode", () => ({ encodeFramesToGif: mocks.encodeFramesToGif }));
vi.mock("@/hooks/useStitchVideos", () => ({ stitchVideosAsync: mocks.stitchVideosAsync }));
vi.mock("@/hooks/useTrimVideo", () => ({ trimVideoAsync: mocks.trimVideoAsync }));
vi.mock("@/hooks/useApplySpeedCurve", () => ({ applySpeedCurveAsync: mocks.applySpeedCurveAsync }));
vi.mock("@/utils/gridSplitter", () => ({ splitWithDimensions: mocks.splitWithDimensions }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("URL", {
  ...URL,
  createObjectURL: vi.fn().mockReturnValue("blob:http://localhost/out"),
  revokeObjectURL: vi.fn(),
});

class MockImage {
  width = 256;
  height = 128;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}
vi.stubGlobal("Image", MockImage);

/** Over 20 MB, so executors keep an object URL rather than a data: URL. */
const BIG = 21 * 1024 * 1024;
const bigVideo = new Blob([new Uint8Array(BIG)], { type: "video/mp4" });

/**
 * The bytes of an encode of edit `seed`: the same body every time, and a head
 * that differs per `stamp`, like the time a muxer writes into the moov box.
 */
function encodedBytes(size: number, seed: number, stamp: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 997) bytes[i] = (i * 31 + seed) & 0xff;
  bytes[40] = stamp & 0xff;
  bytes[41] = (stamp >> 8) & 0xff;
  return bytes;
}

function encoded(size: number, seed: number, stamp: number): Blob {
  return new Blob([encodedBytes(size, seed, stamp) as BlobPart], { type: "video/mp4" });
}

function recorder() {
  let count = 0;
  return vi.fn((_input: RecordAssetInput): RecordedAssetHandle => ({
    assetId: `a${String(++count).padStart(12, "0")}`,
    done: Promise.resolve(null),
  }));
}

function makeCtx(
  node: WorkflowNode,
  inputs: Partial<ReturnType<NodeExecutionContext["getConnectedInputs"]>> = {},
  extra: { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] } = {}
) {
  const nodes = new Map<string, WorkflowNode>([[node.id, node], ...(extra.nodes ?? []).map((n) => [n.id, n] as const)]);
  const recordAsset = recorder();
  const ctx: NodeExecutionContext = {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      model3d: null,
      text: null,
      textItems: [],
      dynamicInputs: {},
      easeCurve: null,
      ...inputs,
    }),
    updateNodeData: vi.fn((id: string, data: Partial<WorkflowNodeData>) => {
      const current = nodes.get(id);
      if (current) nodes.set(id, { ...current, data: { ...current.data, ...data } as WorkflowNodeData });
    }),
    getFreshNode: (id: string) => nodes.get(id),
    getEdges: () => extra.edges ?? [],
    getNodes: () => [...nodes.values()],
    providerSettings: { providers: {} } as never,
    addIncurredCost: vi.fn(),
    addToGlobalHistory: vi.fn(),
    generationsPath: null,
    saveDirectoryPath: null,
    trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(),
    appendOutputGalleryVideo: vi.fn(),
    materializeSplitGridCells: vi.fn().mockReturnValue(false),
    recordAsset,
    get: vi.fn(),
  };
  return { ctx, recordAsset, nodes };
}

function node(id: string, type: string, data: Record<string, unknown>): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ blob: async () => new Blob(["v"], { type: "video/mp4" }) });
});

describe("removeBackground", () => {
  it("records the cut-out as an edit", async () => {
    mocks.removeImageBackground.mockResolvedValue("data:image/png;base64,cut");
    const { ctx, recordAsset } = makeCtx(node("rb-1", "removeBackground", { model: "isnet_fp16", outputImage: null, customTitle: "Cut" }), {
      images: ["data:image/png;base64,src"],
    });

    await executeRemoveBackground(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "image",
      origin: "edited",
      media: "data:image/png;base64,cut",
      parameters: { model: "isnet_fp16" },
      producer: { nodeId: "rb-1", nodeType: "removeBackground", nodeTitle: "Cut", operation: "removeBackground" },
    });
  });

  it("does not record an output identical to the one it replaces", async () => {
    mocks.removeImageBackground.mockResolvedValue("data:image/png;base64,cut");
    const { ctx, recordAsset } = makeCtx(node("rb-1", "removeBackground", { model: "isnet_fp16", outputImage: "data:image/png;base64,cut" }), {
      images: ["data:image/png;base64,src"],
    });

    await executeRemoveBackground(ctx);

    expect(recordAsset).not.toHaveBeenCalled();
  });
});

describe("imageResize", () => {
  const settings = { mode: "maxEdge", width: 512, height: 512, maxEdge: 800, scalePct: 50, fit: "contain", padColor: "#000000", format: "webp", quality: 0.9 };

  it("records the resized image with its size and settings", async () => {
    mocks.resizeImage.mockResolvedValue({ dataUrl: "data:image/webp;base64,small", width: 800, height: 450, bytes: 1000 });
    const { ctx, recordAsset } = makeCtx(node("rs-1", "imageResize", { ...settings, outputImage: null }), { images: ["data:image/png;base64,src"] });

    await executeImageResize(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "image",
      origin: "edited",
      media: "data:image/webp;base64,small",
      parameters: settings,
      producer: { nodeId: "rs-1", nodeType: "imageResize", operation: "resize" },
      width: 800,
      height: 450,
    });
  });

  it("does not record an output identical to the one it replaces", async () => {
    mocks.resizeImage.mockResolvedValue({ dataUrl: "data:image/webp;base64,small", width: 800, height: 450, bytes: 1000 });
    const { ctx, recordAsset } = makeCtx(node("rs-1", "imageResize", { ...settings, outputImage: "data:image/webp;base64,small" }), {
      images: ["data:image/png;base64,src"],
    });

    await executeImageResize(ctx);

    expect(recordAsset).not.toHaveBeenCalled();
  });
});

describe("gifEncoder", () => {
  it("records the GIF with its frame count and timing", async () => {
    mocks.encodeFramesToGif.mockResolvedValue({ dataUrl: "data:image/gif;base64,anim", bytes: 5000, width: 320, height: 240 });
    const gif = node("gif-1", "gifEncoder", { outputGif: null, fps: 10, loopCount: 0, colorCount: 128, dither: true, targetMaxBytes: null, clipOrder: [] });
    const frames = [node("f1", "imageInput", { image: "data:image/png;base64,1" }), node("f2", "imageInput", { image: "data:image/png;base64,2" })];
    const edges = [
      { id: "e1", source: "f1", target: "gif-1", targetHandle: "image-0" },
      { id: "e2", source: "f2", target: "gif-1", targetHandle: "image-1" },
    ] as WorkflowEdge[];
    const { ctx, recordAsset } = makeCtx(gif, {}, { nodes: frames, edges });

    await executeGifEncoder(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "image",
      origin: "edited",
      media: "data:image/gif;base64,anim",
      mime: "image/gif",
      parameters: { frames: 2, fps: 10, loopCount: 0, colorCount: 128, dither: true, targetMaxBytes: null },
      producer: { nodeId: "gif-1", nodeType: "gifEncoder", operation: "gif" },
      width: 320,
      height: 240,
      durationSec: 0.2,
    });
  });
});

describe("video edits", () => {
  it("records a stitched video from its Blob", async () => {
    mocks.stitchVideosAsync.mockResolvedValue(bigVideo);
    const { ctx, recordAsset } = makeCtx(node("vs-1", "videoStitch", { outputVideo: null, encoderSupported: true, loopCount: 2 }), {
      videos: ["data:video/mp4;base64,a", "data:video/mp4;base64,b"],
    });

    await executeVideoStitch(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "video",
      origin: "edited",
      media: bigVideo,
      mime: "video/mp4",
      parameters: { clips: 2, loopCount: 2, withAudio: false },
      producer: { nodeId: "vs-1", nodeType: "videoStitch", operation: "stitch" },
    });
  });

  it("records a stacked stitch's overlap and crossfade", async () => {
    mocks.stitchVideosAsync.mockResolvedValue(bigVideo);
    const clip = (id: string, edgeId: string) => ({ id, source: { kind: "edge", edgeId }, inSec: 0, outSec: null, muted: false, volume: 1 });
    const stitch = node("vs-1", "videoStitch", {
      outputVideo: null,
      encoderSupported: true,
      loopCount: 1,
      timeline: [clip("a", "e1"), clip("b", "e2")],
      sequenceLayout: { mode: "stacked", overlapSec: 1.5, crossfade: true },
    });
    const sources = [node("g1", "generateVideo", { outputVideo: "data:video/mp4;base64,a" }), node("g2", "generateVideo", { outputVideo: "data:video/mp4;base64,b" })];
    const edges = [
      { id: "e1", source: "g1", sourceHandle: "video", target: "vs-1", targetHandle: "video-0" },
      { id: "e2", source: "g2", sourceHandle: "video", target: "vs-1", targetHandle: "video-1" },
    ] as WorkflowEdge[];
    const { ctx, recordAsset } = makeCtx(stitch, { videos: ["data:video/mp4;base64,a", "data:video/mp4;base64,b"] }, { nodes: sources, edges });

    await executeVideoStitch(ctx);

    expect(recordAsset).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: { clips: 2, loopCount: 1, withAudio: false, overlapSec: 1.5, crossfade: true } }),
    );
  });

  it("records a placed stitch's crossfade, overlap and each clip's start", async () => {
    mocks.stitchVideosAsync.mockResolvedValue(bigVideo);
    const clip = (id: string, edgeId: string, startSec?: number) => ({
      id,
      source: { kind: "edge", edgeId },
      inSec: 0,
      outSec: null,
      muted: false,
      volume: 1,
      ...(startSec === undefined ? {} : { startSec }),
    });
    const stitch = node("vs-1", "videoStitch", {
      outputVideo: null,
      encoderSupported: true,
      loopCount: 1,
      timeline: [clip("a", "e1", 2.5), clip("b", "e2")],
      sequenceLayout: { mode: "stacked", overlapSec: 1.5, crossfade: false },
    });
    const sources = [node("g1", "generateVideo", { outputVideo: "data:video/mp4;base64,a" }), node("g2", "generateVideo", { outputVideo: "data:video/mp4;base64,b" })];
    const edges = [
      { id: "e1", source: "g1", sourceHandle: "video", target: "vs-1", targetHandle: "video-0" },
      { id: "e2", source: "g2", sourceHandle: "video", target: "vs-1", targetHandle: "video-1" },
    ] as WorkflowEdge[];
    const { ctx, recordAsset } = makeCtx(stitch, { videos: ["data:video/mp4;base64,a", "data:video/mp4;base64,b"] }, { nodes: sources, edges });

    await executeVideoStitch(ctx);

    expect(recordAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { clips: 2, loopCount: 1, withAudio: false, crossfade: false, overlapSec: 1.5, starts: [2.5, null] },
      }),
    );
  });

  it("records a trimmed video with its new length", async () => {
    mocks.trimVideoAsync.mockResolvedValue(bigVideo);
    const { ctx, recordAsset } = makeCtx(node("vt-1", "videoTrim", { outputVideo: null, encoderSupported: true, startTime: 1.5, endTime: 4 }), {
      videos: ["data:video/mp4;base64,a"],
    });

    await executeVideoTrim(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "video",
      origin: "edited",
      media: bigVideo,
      mime: "video/mp4",
      parameters: { startTime: 1.5, endTime: 4 },
      producer: { nodeId: "vt-1", nodeType: "videoTrim", operation: "trim" },
      durationSec: 2.5,
    });
  });

  describe("with a stand-in video element", () => {
    const createElement = document.createElement.bind(document);
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function fakeVideo() {
      const video = {
        videoWidth: 640,
        videoHeight: 360,
        duration: 4,
        _src: "",
        onloadedmetadata: null as (() => void) | null,
        onseeked: null as (() => void) | null,
        onerror: null as (() => void) | null,
        get src() {
          return this._src;
        },
        set src(value: string) {
          this._src = value;
          queueMicrotask(() => this.onloadedmetadata?.());
        },
        set currentTime(_t: number) {
          queueMicrotask(() => this.onseeked?.());
        },
      };
      return video;
    }

    it("records an eased video with its output length", async () => {
      vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
        tag === "video" ? fakeVideo() : createElement(tag)) as typeof document.createElement);
      mocks.applySpeedCurveAsync.mockResolvedValue(bigVideo);
      const { ctx, recordAsset } = makeCtx(
        node("ec-1", "easeCurve", {
          outputVideo: null,
          encoderSupported: true,
          bezierHandles: [0.25, 0.1, 0.25, 1],
          easingPreset: "easeInOutSine",
          outputDuration: 3,
        }),
        { videos: ["data:video/mp4;base64,a"] }
      );

      await executeEaseCurve(ctx);

      expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
        kind: "video",
        origin: "edited",
        media: bigVideo,
        mime: "video/mp4",
        parameters: { easingPreset: "easeInOutSine", bezierHandles: [0.25, 0.1, 0.25, 1], outputDuration: 3 },
        producer: { nodeId: "ec-1", nodeType: "easeCurve", operation: "easeCurve" },
        durationSec: 3,
      });
    });

    it("records a grabbed frame with the video's dimensions", async () => {
      vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        if (tag === "video") return fakeVideo();
        if (tag === "canvas") return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => "data:image/png;base64,frame" };
        return createElement(tag);
      }) as typeof document.createElement);
      const { ctx, recordAsset } = makeCtx(node("fg-1", "videoFrameGrab", { framePosition: "last", outputImage: null }), {
        videos: ["https://cdn.example/clip.mp4"],
      });

      await executeVideoFrameGrab(ctx);

      expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
        kind: "image",
        origin: "edited",
        media: "data:image/png;base64,frame",
        mime: "image/png",
        parameters: { framePosition: "last" },
        producer: { nodeId: "fg-1", nodeType: "videoFrameGrab", operation: "frameGrab" },
        width: 640,
        height: 360,
      });
    });
  });
});

describe("a re-run of a video edit", () => {
  const trimNode = (id: string, outputVideo: string | null = null) =>
    node(id, "videoTrim", { outputVideo, encoderSupported: true, startTime: 1, endTime: 3 });

  /** A recorder whose recordings land. */
  function saving(ctx: NodeExecutionContext) {
    const recordAsset = vi.fn(
      (_input: RecordAssetInput): RecordedAssetHandle => ({ assetId: "a000000000001", done: Promise.resolve({} as RecordAssetResult) })
    );
    ctx.recordAsset = recordAsset;
    return recordAsset;
  }

  it("over 20 MB, is not recorded again when it made the same video", async () => {
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("blob:http://localhost/run-1")
      .mockReturnValueOnce("blob:http://localhost/run-2")
      .mockReturnValueOnce("blob:http://localhost/run-3");
    const { ctx } = makeCtx(trimNode("vt-rerun"), { videos: ["data:video/mp4;base64,a"] });
    const recordAsset = saving(ctx);

    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 1, 1));
    await executeVideoTrim(ctx);
    // The same edit, encoded a second later: a fresh object URL, the same video
    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 1, 2));
    await executeVideoTrim(ctx);
    expect(recordAsset).toHaveBeenCalledOnce();

    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 2, 3));
    await executeVideoTrim(ctx);
    expect(recordAsset).toHaveBeenCalledTimes(2);
  });

  it("is not recorded when it reproduced the video the node already showed", async () => {
    const size = 64 * 1024;
    const shown = `data:video/mp4;base64,${Buffer.from(encodedBytes(size, 7, 1)).toString("base64")}`;
    const { ctx } = makeCtx(trimNode("vt-loaded", shown), { videos: ["data:video/mp4;base64,a"] });
    const recordAsset = saving(ctx);

    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(size, 7, 2));
    await executeVideoTrim(ctx);

    expect(recordAsset).not.toHaveBeenCalled();
  });

  it("made while the same video is still uploading, is recorded if that upload then fails", async () => {
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("blob:http://localhost/slow-1")
      .mockReturnValueOnce("blob:http://localhost/slow-2")
      .mockReturnValueOnce("blob:http://localhost/slow-3");
    const { ctx } = makeCtx(trimNode("vt-slow"), { videos: ["data:video/mp4;base64,a"] });
    let failFirst!: () => void;
    const outcomes = [
      new Promise<RecordAssetResult | null>((resolve) => (failFirst = () => resolve(null))),
      Promise.resolve({} as RecordAssetResult),
    ];
    let count = 0;
    const recordAsset = vi.fn(
      (_input: RecordAssetInput): RecordedAssetHandle => ({ assetId: `a${String(++count).padStart(12, "0")}`, done: outcomes.shift()! })
    );
    ctx.recordAsset = recordAsset;

    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 4, 1));
    await executeVideoTrim(ctx);
    // Run again before the 300 MB upload is done: the same video, so nothing new yet
    const second = encoded(BIG, 4, 2);
    mocks.trimVideoAsync.mockResolvedValueOnce(second);
    await executeVideoTrim(ctx);
    expect(recordAsset).toHaveBeenCalledOnce();

    // The first upload fails: the second run's copy goes instead, once
    failFirst();
    await vi.waitFor(() => expect(recordAsset).toHaveBeenCalledTimes(2));
    expect(recordAsset.mock.calls[1][0].media).toBe(second);

    // It landed, so a third identical run records nothing
    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 4, 3));
    await executeVideoTrim(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordAsset).toHaveBeenCalledTimes(2);
  });

  it("recorded late, once the upload it waited on failed, keeps its run's workflow snapshot", async () => {
    // The failed upload is reported
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("blob:http://localhost/late-1")
      .mockReturnValueOnce("blob:http://localhost/late-2");
    const { ctx } = makeCtx(trimNode("vt-late"), { videos: ["data:video/mp4;base64,a"] });
    const run = (runId: string): AssetRunContext => ({ runId, workflowId: "wf_late", workflowName: "Late", projectDir: null, startedAt: 1 });
    const graph: CapturedGraph = { nodes: [], edges: [], edgeStyle: "curved", workflowId: "wf_late", workflowName: "Late" };
    /** Runs one execution the way the store does: its own asset run, closed once the node returns. */
    const execute = async (assetRun: AssetRunContext, output: Blob) => {
      ctx.assetRun = assetRun;
      ctx.recordAsset = (input) => recordInLibrary(input, assetRun);
      beginRun(assetRun, graph);
      mocks.trimVideoAsync.mockResolvedValueOnce(output);
      await executeVideoTrim(ctx);
      endRun(assetRun.runId, graph);
    };

    // The library, with the first upload stalled until it fails
    let failFirst!: () => void;
    let records = 0;
    const snapshots: string[] = [];
    mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/assets" && init.method === "POST") {
        const { meta } = JSON.parse(String(init.body)) as { meta: { id: string; runId: string } };
        if (++records === 1) {
          return new Promise((resolve) => (failFirst = () => resolve(jsonResponse({ error: "The upload stalled." }, { status: 400 }))));
        }
        return jsonResponse({ result: recordResult(assetView({ id: meta.id, kind: "video", mime: "video/mp4", runId: meta.runId })) });
      }
      const snapshot = /^\/api\/assets\/runs\/([^/]+)$/.exec(url);
      if (snapshot) {
        snapshots.push(`${snapshot[1]}:${(JSON.parse(String(init.body)) as { phase: string }).phase}`);
        return jsonResponse({ missingMedia: [] });
      }
      if (url.startsWith("/api/assets/workflows/")) return jsonResponse({ id: "wf_late", createdAt: 1, updatedAt: 1 });
      return { blob: async () => new Blob(["v"], { type: "video/mp4" }) };
    });

    await execute(run("r-late-first"), encoded(BIG, 5, 1));
    // Run again while that upload is under way: the same video, so it waits on it
    await execute(run("r-late-again"), encoded(BIG, 5, 2));
    expect(records).toBe(1);

    // The first upload fails: the second run's copy is recorded, under a run still open
    failFirst();
    await vi.waitFor(() => expect(snapshots).toEqual(["r-late-again:start", "r-late-again:final"]));
    expect(records).toBe(2);
    errors.mockRestore();
  });

  it("is recorded again after a recording that failed", async () => {
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("blob:http://localhost/fail-1")
      .mockReturnValueOnce("blob:http://localhost/fail-2");
    const { ctx, recordAsset } = makeCtx(trimNode("vt-failed"), { videos: ["data:video/mp4;base64,a"] });

    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 3, 1));
    await executeVideoTrim(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.trimVideoAsync.mockResolvedValueOnce(encoded(BIG, 3, 2));
    await executeVideoTrim(ctx);

    expect(recordAsset).toHaveBeenCalledTimes(2);
  });
});

describe("splitGrid", () => {
  it("records each new slice, and skips a cell that already held it", async () => {
    mocks.splitWithDimensions.mockResolvedValue({ images: ["data:image/png;base64,s0", "data:image/png;base64,s1"] });
    const grid = node("sg-1", "splitGrid", {
      gridRows: 1,
      gridCols: 2,
      cells: [
        { baseImageNodeId: "cell-0", nodeIds: ["cell-0"], groupId: "g0" },
        { baseImageNodeId: "cell-1", nodeIds: ["cell-1"], groupId: "g1" },
      ],
    });
    const cells = [
      node("cell-0", "imageInput", { image: null }),
      node("cell-1", "imageInput", { image: "data:image/png;base64,s1" }),
    ];
    const { ctx, recordAsset } = makeCtx(grid, { images: ["data:image/png;base64,grid"] }, { nodes: cells });

    await executeSplitGrid(ctx);

    expect(recordAsset).toHaveBeenCalledExactlyOnceWith({
      kind: "image",
      origin: "edited",
      media: "data:image/png;base64,s0",
      parameters: { rows: 1, cols: 2, row: 1, col: 1 },
      producer: { nodeId: "sg-1", nodeType: "splitGrid", operation: "splitGrid" },
      width: 256,
      height: 128,
    });
  });
});

describe("without the asset library", () => {
  it("edits nothing but the node", async () => {
    mocks.removeImageBackground.mockResolvedValue("data:image/png;base64,cut");
    const { ctx } = makeCtx(node("rb-1", "removeBackground", { model: "isnet_fp16", outputImage: null }), { images: ["data:image/png;base64,src"] });
    delete ctx.recordAsset;

    await expect(executeRemoveBackground(ctx)).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
