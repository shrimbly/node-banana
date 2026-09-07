import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeVideoStitch, executeEaseCurve, executeVideoTrim } from "../videoProcessingExecutors";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";
import { stitchVideosAsync } from "@/hooks/useStitchVideos";
import { trimVideoAsync } from "@/hooks/useTrimVideo";
import { applySpeedCurveAsync } from "@/hooks/useApplySpeedCurve";

vi.mock("@/hooks/useTrimVideo", () => ({ trimVideoAsync: vi.fn() }));
vi.mock("@/hooks/useApplySpeedCurve", () => ({ applySpeedCurveAsync: vi.fn() }));

// Mock the stitch helper so the executor's cancellation wiring can be asserted
// without running the real mediabunny encode.
vi.mock("@/hooks/useStitchVideos", () => ({
  stitchVideosAsync: vi.fn(),
  checkEncoderSupport: vi.fn().mockResolvedValue(true),
}));
const mockStitchVideosAsync = stitchVideosAsync as unknown as ReturnType<typeof vi.fn>;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock URL methods
vi.stubGlobal("URL", {
  ...URL,
  createObjectURL: vi.fn().mockReturnValue("blob:http://localhost/mock"),
  revokeObjectURL: vi.fn(),
});

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
      text: null,
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
  // clearAllMocks resets call history but NOT implementations, so explicitly
  // drop any per-test fetch/helper impl to avoid leaking across tests (a
  // resolving fetch would make video-metadata probing hang other cases).
  mockFetch.mockReset();
  mockStitchVideosAsync.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("replacing shared video output", () => {
  it("preserves the previous video when reading the replacement fails", async () => {
    const oldUrl = "blob:http://localhost/last-good-output";
    const node = {
      id: "stitch", type: "videoStitch", position: { x: 0, y: 0 },
      data: { outputVideo: oldUrl, encoderSupported: true, loopCount: 1 },
    } as WorkflowNode;
    mockFetch.mockResolvedValue({ blob: async () => new Blob(["video"]) });
    mockStitchVideosAsync.mockResolvedValue(new Blob(["new video"]));
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {
      throw new Error("Could not read replacement");
    });
    const releaseMediaUrl = vi.fn();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [] }),
      updateNodeData: (_id, data) => { Object.assign(node.data, data); },
      releaseMediaUrl,
    });

    await expect(executeVideoStitch(ctx)).rejects.toThrow("Could not read replacement");

    expect(node.data.outputVideo).toBe(oldUrl);
    expect(releaseMediaUrl).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(oldUrl);
  });

  it.each([
    ["videoStitch", executeVideoStitch],
    ["videoTrim", executeVideoTrim],
    ["easeCurve", executeEaseCurve],
  ] as const)("%s asks the store to release the previous URL only after replacement", async (type, execute) => {
    const oldUrl = "blob:http://localhost/copied-to-another-tab";
    const node = {
      id: "video-1", type, position: { x: 0, y: 0 },
      data: {
        outputVideo: oldUrl, encoderSupported: true, loopCount: 1,
        startTime: 0, endTime: 5, bezierHandles: [0, 0, 1, 1],
        easingPreset: "linear", outputDuration: 5,
      },
    } as WorkflowNode;
    const output = { size: 21 * 1024 * 1024, type: "video/mp4" } as Blob;
    mockFetch.mockResolvedValue({ blob: async () => new Blob(["video"]) });
    mockStitchVideosAsync.mockResolvedValue(output);
    vi.mocked(trimVideoAsync).mockResolvedValue(output);
    vi.mocked(applySpeedCurveAsync).mockResolvedValue(output);
    // EaseCurve probes metadata before encoding; complete that browser callback.
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName !== "video") return createElement(tagName, options);
      const video = { duration: 5, onloadedmetadata: null as (() => void) | null, src: "" };
      Object.defineProperty(video, "src", {
        get: () => "blob:http://localhost/metadata",
        set: () => queueMicrotask(() => video.onloadedmetadata?.()),
      });
      return video as unknown as HTMLVideoElement;
    });
    const releaseMediaUrl = vi.fn(() => {
      // The ownership check must see the new output on the source node.
      expect(node.data.outputVideo).toBe("blob:http://localhost/mock");
    });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [], easeCurve: null }),
      updateNodeData: (_id, data) => { Object.assign(node.data, data); },
      releaseMediaUrl,
    });

    await execute(ctx);

    expect(releaseMediaUrl).toHaveBeenCalledWith(oldUrl);
    // Only the store knows about the copied node in another tab.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(oldUrl);
  });
});

describe("executeVideoStitch", () => {
  function makeStitchNode(data: Record<string, unknown> = {}): WorkflowNode {
    return {
      id: "vs-1",
      type: "videoStitch",
      position: { x: 0, y: 0 },
      data: {
        outputVideo: null,
        status: null,
        error: null,
        progress: 0,
        encoderSupported: true,
        loopCount: 1,
        ...data,
      },
    } as WorkflowNode;
  }

  it("should error when encoder not supported", async () => {
    const node = makeStitchNode({ encoderSupported: false });
    const ctx = makeCtx(node);

    await expect(executeVideoStitch(ctx)).rejects.toThrow("Browser does not support video encoding");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("vs-1", expect.objectContaining({
      status: "error",
      error: "Browser does not support video encoding",
    }));
  });

  it("should error when fewer than 2 videos", async () => {
    const node = makeStitchNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["single-video"],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await expect(executeVideoStitch(ctx)).rejects.toThrow("Need at least 2 video clips to stitch");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("vs-1", expect.objectContaining({
      status: "error",
      error: "Need at least 2 video clips to stitch",
    }));
  });

  it("should set loading status with 0 progress", async () => {
    const node = makeStitchNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["video1", "video2"],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    // Will fail at fetch but we only care about the loading call
    await executeVideoStitch(ctx).catch(() => {});

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) =>
        (c[1] as Record<string, unknown>).status === "loading" &&
        (c[1] as Record<string, unknown>).progress === 0
    );
    expect(loadingCall).toBeDefined();
  });
});

describe("executeVideoStitch — cancellation", () => {
  function makeStitchNode(): WorkflowNode {
    return {
      id: "vs-1",
      type: "videoStitch",
      position: { x: 0, y: 0 },
      data: {
        outputVideo: null,
        status: null,
        error: null,
        progress: 0,
        encoderSupported: true,
        loopCount: 1,
      },
    } as WorkflowNode;
  }

  function makeTwoVideoCtx(node: WorkflowNode, signal?: AbortSignal) {
    return makeCtx(node, {
      signal,
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["v1", "v2"],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
  }

  it("threads ctx.signal into stitchVideosAsync", async () => {
    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob(["v"], { type: "video/mp4" })),
    });
    // Large output routes through URL.createObjectURL (mocked), avoiding FileReader.
    mockStitchVideosAsync.mockResolvedValue({ size: 21 * 1024 * 1024, type: "video/mp4" } as Blob);
    const controller = new AbortController();
    const ctx = makeTwoVideoCtx(makeStitchNode(), controller.signal);

    await executeVideoStitch(ctx);

    expect(mockStitchVideosAsync).toHaveBeenCalled();
    // signal is the 4th positional argument
    expect(mockStitchVideosAsync.mock.calls[0][3]).toBe(controller.signal);
  });

  it("treats an AbortError from the helper as idle cancellation, not an error", async () => {
    mockFetch.mockResolvedValue({
      blob: () => Promise.resolve(new Blob(["v"], { type: "video/mp4" })),
    });
    mockStitchVideosAsync.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const ctx = makeTwoVideoCtx(makeStitchNode());

    await expect(executeVideoStitch(ctx)).rejects.toMatchObject({ name: "AbortError" });

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => (c[1] as Record<string, unknown>).status === "idle")).toBe(true);
    expect(calls.some((c) => (c[1] as Record<string, unknown>).status === "error")).toBe(false);
  });
});

describe("executeEaseCurve", () => {
  function makeEaseNode(data: Record<string, unknown> = {}): WorkflowNode {
    return {
      id: "ec-1",
      type: "easeCurve",
      position: { x: 0, y: 0 },
      data: {
        outputVideo: null,
        status: null,
        error: null,
        progress: 0,
        encoderSupported: true,
        bezierHandles: [0.25, 0.1, 0.25, 1.0],
        easingPreset: "ease-in-out",
        outputDuration: 5,
        ...data,
      },
    } as WorkflowNode;
  }

  it("should error when encoder not supported", async () => {
    const node = makeEaseNode({ encoderSupported: false });
    const ctx = makeCtx(node);

    await expect(executeEaseCurve(ctx)).rejects.toThrow("Browser does not support video encoding");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("ec-1", expect.objectContaining({
      status: "error",
      error: "Browser does not support video encoding",
    }));
  });

  it("should error when no video connected", async () => {
    const node = makeEaseNode();
    const ctx = makeCtx(node);

    await expect(executeEaseCurve(ctx)).rejects.toThrow("Connect a video input to apply ease curve");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("ec-1", expect.objectContaining({
      status: "error",
      error: "Connect a video input to apply ease curve",
    }));
  });

  it("should set loading status with 0 progress", async () => {
    const node = makeEaseNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["video1"],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    // Will fail at fetch but we only care about the loading call
    await executeEaseCurve(ctx).catch(() => {});

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) =>
        (c[1] as Record<string, unknown>).status === "loading" &&
        (c[1] as Record<string, unknown>).progress === 0
    );
    expect(loadingCall).toBeDefined();
  });

  it("should propagate parent easeCurve settings", async () => {
    const node = makeEaseNode({
      bezierHandles: [0, 0, 1, 1],
      easingPreset: null,
    });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: ["video1"],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: {
          bezierHandles: [0.42, 0, 0.58, 1],
          easingPreset: "ease-in-out",
          outputDuration: 10,
        },
      }),
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "parent-ec", target: "ec-1", targetHandle: "easeCurve" },
      ]),
    });

    // Will fail at fetch but we only care about the easeCurve propagation
    await executeEaseCurve(ctx).catch(() => {});

    expect(ctx.updateNodeData).toHaveBeenCalledWith("ec-1", expect.objectContaining({
      bezierHandles: [0.42, 0, 0.58, 1],
      easingPreset: "ease-in-out",
      outputDuration: 10,
      inheritedFrom: "parent-ec",
    }));
  });
});
