import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { useAssetStore } from "@/store/assetStore";
import { FrameCaptureError, type FrameCapture, type FrameCaptureJob } from "@/lib/stitch/frameCapture";
import * as mediaBlob from "@/lib/assets/client/mediaBlob";
import { frameOptions, shownAt } from "@/lib/stitch/framePlan";
import { createClip, layoutSpans, sourceKey, type SourceKey } from "@/lib/stitch/timeline";
import { getNodeSize } from "@/utils/nodeDimensions";
import type { ImageInputNodeData, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";
import { openStitchEditor } from "../openStitchEditor";
import {
  __resetFramePlacementForTests,
  addFrameNode,
  canvasCentrePosition,
  CAPTURE_TIMEOUT_MS,
  FRAME_BESIDE_GAP,
  frameFileName,
  frameNodePosition,
  frameToCanvas,
} from "../frameToCanvas";
import type { ClipMediaView } from "../useStitchEditorMedia";

const { show, capture } = vi.hoisted(() => ({
  show: vi.fn(),
  capture: vi.fn<(job: FrameCaptureJob) => Promise<FrameCapture>>(),
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show }) } }));
vi.mock("@/lib/stitch/frameCapture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stitch/frameCapture")>()),
  captureSequenceFrame: (job: FrameCaptureJob) => capture(job),
}));

// Real workflow and editor stores; the capture is mocked and recordUiAsset spied.

const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const STITCH_AT = { x: 100, y: 50 };
const STITCH_WIDTH = 320;
const node = (id: string, type: string, data: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 }, ...extra }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle: "video",
  targetHandle,
});

const DURATIONS = new Map<SourceKey, number>([
  ["edge:eA", 5],
  ["edge:eB", 4],
]);
const SIZE = { width: 1280, height: 720 };

const recordUiAsset = vi.fn();
const originalRecord = useWorkflowStore.getState().recordUiAsset;

function seed() {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a" }, { position: { x: -800, y: 0 } }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }, { position: { x: -800, y: 400 } }),
      node(
        "stitch",
        "videoStitch",
        { clips: [], clipOrder: ["eA", "eB"], outputVideo: null, loopCount: 1, status: "idle" },
        { position: STITCH_AT, width: STITCH_WIDTH },
      ),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")],
    recordUiAsset,
  });
  openStitchEditor("stitch");
  editor().setDurations(DURATIONS);
}

const view = (clipId: string, key: SourceKey, src: string): ClipMediaView => ({
  clipId,
  key,
  src,
  mediaKey: null,
  status: "ready",
  duration: DURATIONS.get(key) ?? 5,
  width: SIZE.width,
  height: SIZE.height,
  fps: 24,
  frames: [],
  sourceNodeId: null,
  sourceLabel: "",
  railSource: { kind: "Video", detail: null },
  missing: false,
});

/** What the modal hands the button: the spans and the media views of the current draft. */
function press() {
  const draft = editor().draft!;
  const media = new Map(
    draft.timeline.map((clip) => {
      const key = sourceKey(clip.source);
      const src = clip.source.kind === "asset" ? `/api/assets/${clip.source.assetId}/file` : key === "edge:eA" ? "blob:a" : "blob:b";
      return [clip.id, view(clip.id, key, src)] as const;
    }),
  );
  const spans = layoutSpans(draft.timeline, editor().durations, draft.sequenceLayout);
  return frameToCanvas({ spans, media, size: SIZE });
}

const captured = (job: FrameCaptureJob, slot = 60): FrameCapture => ({
  blob: new Blob(["png"], { type: "image/png" }),
  width: job.size.width,
  height: job.size.height,
  plan: { slot, route: "track", sources: [], show: { kind: "layers", layers: [] } },
  drawn: [...job.shown].map((clipId) => ({ clipId, sourceSec: 1.25, weight: 1 })),
});

const frames = () => wf().nodes.filter((n) => n.type === "imageInput");
const stitch = () => wf().nodes.find((n) => n.id === "stitch");

beforeAll(() => {
  // A paste-style second select pass runs on the next frame; run it at once
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetFramePlacementForTests();
  show.mockReset();
  capture.mockReset();
  recordUiAsset.mockReset();
  capture.mockImplementation(async (job) => captured(job));
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  editor().close();
  useWorkflowStore.setState({ recordUiAsset: originalRecord });
  wf().clearWorkflow();
});

describe("frameToCanvas", () => {
  it("adds one selected Image Input right of the Edit Video node, undone in one step", async () => {
    editor().setPlayhead(1);
    const before = stitch()!;
    expect(await press()).toBe("added");

    expect(frames()).toHaveLength(1);
    const frame = frames()[0];
    expect(frame.data as ImageInputNodeData).toMatchObject({
      image: "data:image/png;base64,cG5n",
      filename: "frame-0-01-00.png",
      dimensions: SIZE,
    });
    expect(frame.position.x).toBeGreaterThanOrEqual(STITCH_AT.x + STITCH_WIDTH);
    expect(frame.position).toEqual({ x: STITCH_AT.x + STITCH_WIDTH + FRAME_BESIDE_GAP, y: STITCH_AT.y });
    expect(wf().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([frame.id]);
    expect(show).toHaveBeenCalledWith("Frame added to the canvas", "success");

    wf().undo();
    expect(frames()).toHaveLength(0);
    expect(stitch()).toEqual(before);
  });

  it("records the frame with the image node as producer, after the node exists", async () => {
    editor().setPlayhead(6);
    recordUiAsset.mockImplementation(() => {
      // The run's graph snapshot is taken in this call: the node must already be there
      expect(frames()).toHaveLength(1);
      return [];
    });
    await press();
    expect(recordUiAsset).toHaveBeenCalledTimes(1);
    const input = recordUiAsset.mock.calls[0][0];
    const frameId = frames()[0].id;
    expect(input).toMatchObject({
      kind: "image",
      origin: "edited",
      mime: "image/png",
      width: SIZE.width,
      height: SIZE.height,
      producer: { nodeId: frameId, nodeType: "imageInput", operation: "frameGrab" },
      parameters: {
        fromNodeId: "stitch",
        atSec: 6,
        slot: 60,
        mode: "track",
        crossfade: true,
        layers: [{ clip: 2, sourceSec: 1.25, weight: 1 }],
      },
    });
    expect(input.media).toBeInstanceOf(Blob);
    // The agent finds an Edit Video node's renders by producer: a frame is never one of them
    expect(input.producer.nodeId).not.toBe("stitch");
  });

  it("names a library clip's asset in the record", async () => {
    editor().apply((d) => ({ ...d, timeline: [createClip({ kind: "asset", assetId: "lib1" }, { id: "lib" }), ...d.timeline] }));
    editor().setDurations(new Map([...DURATIONS, ["asset:lib1", 3]]));
    editor().setPlayhead(1);
    await press();
    expect(recordUiAsset.mock.calls[0][0].parameters.layers).toEqual([
      { clip: 1, assetId: "lib1", sourceSec: 1.25, weight: 1 },
    ]);
  });

  it("stacks five frames from one node in a column under the first", async () => {
    for (let i = 0; i < 5; i++) {
      editor().setPlayhead(i);
      expect(await press()).toBe("added");
    }
    const column = frames();
    expect(column).toHaveLength(5);
    column.forEach((frame, i) => {
      expect(frame.position.x).toBe(column[0].position.x);
      if (i > 0) {
        const previous = column[i - 1];
        expect(frame.position.y).toBe(previous.position.y + getNodeSize(previous).height + 20);
      }
    });
    expect(column[0].position).toEqual({ x: STITCH_AT.x + STITCH_WIDTH + FRAME_BESIDE_GAP, y: STITCH_AT.y });
    expect(wf().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([column[4].id]);

    const noted = { id: "stitch", position: STITCH_AT, width: STITCH_WIDTH };
    expect(frameNodePosition(noted)).not.toEqual({ x: STITCH_AT.x + STITCH_WIDTH + FRAME_BESIDE_GAP, y: STITCH_AT.y });
    // A replaced canvas, or a fresh session, starts beside the node again
    useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 });
    expect(frameNodePosition(noted)).toEqual({ x: STITCH_AT.x + STITCH_WIDTH + FRAME_BESIDE_GAP, y: STITCH_AT.y });
    useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration - 1 });
    __resetFramePlacementForTests();
    expect(frameNodePosition(noted)).toEqual({ x: STITCH_AT.x + STITCH_WIDTH + FRAME_BESIDE_GAP, y: STITCH_AT.y });
  });

  it("pauses a playing preview and takes the frame where it stopped", async () => {
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending.push(cb);
      return pending.length;
    });
    try {
      editor().setPlayhead(1);
      editor().setPlaying(true);
      const done = press();
      expect(editor().playing).toBe(false);
      // The frame loop's last tick lands after the pause
      editor().setPlayhead(6);
      const tick = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        pending.splice(0).forEach((cb) => cb(0));
      };
      await tick();
      expect(capture).not.toHaveBeenCalled();
      await tick();
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
      await done;
      const job = capture.mock.calls[0][0];
      expect(job.t).toBe(6);
      const draft = editor().draft!;
      const spans = layoutSpans(draft.timeline, editor().durations, draft.sequenceLayout);
      expect([...job.shown]).toEqual([...shownAt(spans, 6, null)]);
      expect([...job.shown]).toEqual(["clip:eB"]);
    } finally {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    }
  });

  it.each([
    ["lined up", false, true, 4.5],
    ["placed", true, true, 2],
    ["lined up, Crossfade off", false, false, 4.5],
  ])("hands a %s stack's layout to the capture and the record", async (_name, placed, crossfade, t) => {
    editor().apply((d) => ({
      ...d,
      sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade },
      timeline: placed ? d.timeline.map((clip, i) => ({ ...clip, startSec: i === 0 ? 0 : 6 })) : d.timeline,
    }));
    editor().setPlayhead(t);
    expect(await press()).toBe("added");
    const job = capture.mock.calls[0][0];
    const draft = editor().draft!;
    const spans = layoutSpans(draft.timeline, editor().durations, draft.sequenceLayout);
    expect([...job.shown]).toEqual([...shownAt(spans, t, { crossfade, placed })]);
    expect(job.options).toEqual(frameOptions(draft.sequenceLayout, draft.timeline));
    expect(job.options.placed === true).toBe(placed);
    expect(job.clips.map((c) => c.startSec)).toEqual(placed ? [0, 6] : [undefined, undefined]);
    expect(recordUiAsset.mock.calls[0][0].parameters).toMatchObject({ mode: placed ? "placed" : "stacked", crossfade });
  });

  it("hands the capture the raw sources, clip numbers and the sequence's frame size", async () => {
    editor().setPlayhead(1);
    await press();
    const job = capture.mock.calls[0][0];
    expect(job.clips.map((c) => c.clipId)).toEqual(["clip:eA", "clip:eB"]);
    expect(job.srcOf("edge:eA")).toBe("blob:a");
    expect(job.srcOf("edge:eB")).toBe("blob:b");
    expect(job.clipNumberOf("clip:eB")).toBe(2);
    expect(job.size).toEqual(SIZE);
    expect(job.options).toEqual({ loopCount: 1 });
    expect(job.signal).toBeInstanceOf(AbortSignal);
  });

  it("drops the frame when the canvas is replaced during the capture", async () => {
    capture.mockImplementation(async (job) => {
      useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 });
      return captured(job);
    });
    expect(await press()).toBe("dropped");
    expect(frames()).toHaveLength(0);
    expect(recordUiAsset).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      "The canvas changed while the frame was being made, so it was not added.",
      "warning",
    );
  });

  it("places the frame where the node was when it is deleted during the capture", async () => {
    useWorkflowStore.setState({
      nodes: wf().nodes.map((n) => (n.id === "stitch" ? { ...n, position: { x: 600, y: 300 } } : n)),
    });
    // A column already under way: the frame still goes beside the noted node, not under the column
    expect(await press()).toBe("added");
    capture.mockImplementation(async (job) => {
      useWorkflowStore.setState({ nodes: wf().nodes.filter((n) => n.id !== "stitch") });
      return captured(job);
    });
    expect(await press()).toBe("added");
    expect(frames()).toHaveLength(2);
    // Beside the noted node, on its row (addNode moves it right, off the first frame), not under the column
    expect(frames()[1].position.y).toBe(300);
    expect(frames()[1].position.x).toBeGreaterThan(frames()[0].position.x);
    expect(recordUiAsset).toHaveBeenCalledTimes(2);
  });

  it("adds nothing when the frame cannot be turned into a data URL", async () => {
    vi.spyOn(mediaBlob, "blobToDataUrl").mockRejectedValueOnce(new Error("read failed"));
    expect(await press()).toBe("failed");
    expect(show).toHaveBeenCalledWith("Couldn't read the video at the playhead.", "error", true, "read failed");
    expect(frames()).toHaveLength(0);
    expect(recordUiAsset).not.toHaveBeenCalled();
  });

  it("gives up after CAPTURE_TIMEOUT_MS with a persistent toast naming the clip", async () => {
    vi.useFakeTimers();
    let reason: unknown = null;
    capture.mockImplementation(
      (job) =>
        new Promise<FrameCapture>((_, reject) => {
          const fail = () => {
            reason = job.signal!.reason;
            reject(new FrameCaptureError("timeout", "Reading the clip took too long", 1));
          };
          if (job.signal!.aborted) fail();
          else job.signal!.addEventListener("abort", fail);
        }),
    );
    const done = press();
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
    expect(reason).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toBe("failed");
    expect((reason as DOMException).name).toBe("TimeoutError");
    expect(show).toHaveBeenCalledWith("Reading Clip 1's video took too long.", "error", true, null);
    expect(frames()).toHaveLength(0);
    expect(recordUiAsset).not.toHaveBeenCalled();
  });

  it.each([
    [new FrameCaptureError("empty", "Nothing plays", undefined), ["Nothing plays at the playhead.", "warning"]],
    [
      new FrameCaptureError("crossOrigin", "Failed to fetch", 1),
      ["Can't read Clip 1's video from its site: the site blocks copying, or the file is gone.", "error", true, null],
    ],
    [new FrameCaptureError("timeout", "Too long", 2), ["Reading Clip 2's video took too long.", "error", true, null]],
    [new FrameCaptureError("timeout", "x", undefined), ["Reading a clip's video took too long.", "error", true, null]],
    [new FrameCaptureError("unreadable", "x", undefined), ["Couldn't read the video at the playhead.", "error", true, "x"]],
    [
      new FrameCaptureError("unreadable", "Decoder failed", 2),
      ["Couldn't read Clip 2's video at the playhead.", "error", true, "Decoder failed"],
    ],
    [new Error("Something else"), ["Couldn't read the video at the playhead.", "error", true, "Something else"]],
  ])("shows the toast for %s and adds nothing", async (error, toast) => {
    capture.mockRejectedValue(error);
    expect(await press()).toBe("failed");
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(...toast);
    expect(frames()).toHaveLength(0);
    expect(recordUiAsset).not.toHaveBeenCalled();
  });

  it("never touches the editor's draft, history or the Edit Video node", async () => {
    editor().apply((d) => ({ ...d, loopCount: 2 }));
    const { draft, past, future, initial } = editor();
    const data = structuredClone(stitch()!.data) as VideoStitchNodeData;
    const dataRef = stitch()!.data;
    editor().setPlayhead(1);
    await press();
    expect(editor().draft).toBe(draft);
    expect(editor().past).toBe(past);
    expect(editor().future).toBe(future);
    expect(editor().initial).toBe(initial);
    expect(stitch()!.data).toBe(dataRef);
    expect(stitch()!.data).toEqual(data);
  });

  it("adds a node with the image's size from the start (no second undo step)", () => {
    const id = addFrameNode({ dataUrl: "data:image/png;base64,AA", filename: "f.png", size: SIZE, position: { x: 0, y: 900 } });
    expect((wf().nodes.find((n) => n.id === id)!.data as ImageInputNodeData).dimensions).toEqual(SIZE);
    wf().undo();
    expect(wf().nodes.some((n) => n.id === id)).toBe(false);
  });
});

describe("frameToCanvas from an edit project (the Edit video view)", () => {
  const BOX = { width: 1200, height: 800 };
  let flow: HTMLElement;

  beforeEach(() => {
    editor().close();
    editor().openEdit({
      editId: "ed0123456789ab",
      draft: {
        timeline: [createClip({ kind: "asset", assetId: "lib1" }, { id: "v1" }), createClip({ kind: "asset", assetId: "lib2" }, { id: "v2" })],
        audioClips: [],
        legacyAudio: { curve: [], muted: false },
        loopCount: 1,
        sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
      },
    });
    editor().setDurations(new Map<SourceKey, number>([["asset:lib1", 5], ["asset:lib2", 4]]));
    // The canvas, panned and zoomed, laid out under the covering view
    flow = document.createElement("div");
    flow.className = "react-flow";
    flow.getBoundingClientRect = () => ({ ...BOX, x: 0, y: 0, left: 0, top: 0, right: BOX.width, bottom: BOX.height, toJSON: () => ({}) });
    const viewport = document.createElement("div");
    viewport.className = "react-flow__viewport";
    viewport.style.transform = "translate(-1000px, -2000px) scale(2)";
    flow.appendChild(viewport);
    document.body.appendChild(flow);
    useAssetStore.setState({ appView: "edit" });
  });

  afterEach(() => {
    flow.remove();
    useAssetStore.setState({ appView: "canvas" });
  });

  it("puts the Image Input in the middle of the canvas's viewport, selected", async () => {
    editor().setPlayhead(1);
    expect(await press()).toBe("added");
    expect(frames()).toHaveLength(1);
    const frame = frames()[0];
    // Viewport centre (600, 400) in flow coordinates is ((600 + 1000) / 2, (400 + 2000) / 2), less half the node
    expect(frame.position).toEqual({ x: 800 - 150, y: 1200 - 140 });
    expect(frame.selected).toBe(true);
    expect(wf().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([frame.id]);
  });

  it("centres the node on its measured size once the canvas has drawn it; one undo still takes it away", async () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
    const flushFrames = async () => {
      for (let i = 0; i < 40; i++) {
        for (const cb of queued.splice(0)) cb(0);
        await Promise.resolve();
      }
    };
    try {
      editor().setPlayhead(1);
      expect(await press()).toBe("added");
      const id = frames()[0].id;
      await flushFrames();
      expect(frames()[0].position).toEqual({ x: 650, y: 1060 });
      // Not measured within its frames: it stays where it was put. Measured: a 16:9 frame at 300 wide is shorter
      expect(await press()).toBe("added");
      const second = frames()[1].id;
      useWorkflowStore.setState({
        nodes: wf().nodes.map((n) => (n.id === second ? { ...n, measured: { width: 300, height: 211 } } : n)),
      });
      await flushFrames();
      // Moved down by half what it lost, from wherever addNode put it (clear of the first)
      expect(frames().find((n) => n.id === second)!.position).toEqual({ x: 970, y: 1060 + (280 - 211) / 2 });
      expect(frames().find((n) => n.id === id)!.position).toEqual({ x: 650, y: 1060 });
      wf().undo();
      expect(frames().map((n) => n.id)).toEqual([id]);
    } finally {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    }
  });

  it("leaves a node moved before it was measured where it was moved", async () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
    try {
      editor().setPlayhead(1);
      await press();
      const id = frames()[0].id;
      useWorkflowStore.setState({
        nodes: wf().nodes.map((n) => (n.id === id ? { ...n, position: { x: 5, y: 5 }, measured: { width: 300, height: 211 } } : n)),
      });
      for (let i = 0; i < 40; i++) {
        for (const cb of queued.splice(0)) cb(0);
        await Promise.resolve();
      }
      expect(frames()[0].position).toEqual({ x: 5, y: 5 });
    } finally {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    }
  });

  it("says so in a toast that offers Go to canvas, and stays in the view", async () => {
    editor().setPlayhead(1);
    await press();
    expect(show).toHaveBeenCalledWith("Frame added to the canvas", "success", false, null, [
      { label: "Go to canvas", onClick: expect.any(Function) },
    ]);
    expect(useAssetStore.getState().appView).toBe("edit");
    expect(editor().isOpen).toBe(true);
    const [[, , , , actions]] = show.mock.calls;
    actions[0].onClick();
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("drops the frame when the canvas is replaced during the capture (a tab switch from the view)", async () => {
    capture.mockImplementation(async (job) => {
      useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 });
      return captured(job);
    });
    editor().setPlayhead(1);
    expect(await press()).toBe("dropped");
    expect(frames()).toHaveLength(0);
    expect(recordUiAsset).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith("The canvas changed while the frame was being made, so it was not added.", "warning");
  });

  it("leaves the edit alone: same draft, same history, nothing to save", async () => {
    editor().setPlayhead(1);
    const { draft, past, future, initial } = editor();
    expect(await press()).toBe("added");
    expect(editor().draft).toBe(draft);
    expect(editor().past).toBe(past);
    expect(editor().future).toBe(future);
    expect(editor().initial).toBe(initial);
    expect(selectIsDirty(editor())).toBe(false);
  });

  it("records the frame against the edit, not a node", async () => {
    editor().setPlayhead(6);
    await press();
    const input = recordUiAsset.mock.calls[0][0];
    expect(input.parameters).toMatchObject({ fromEditId: "ed0123456789ab", layers: [{ clip: 2, assetId: "lib2" }] });
    expect(input.parameters).not.toHaveProperty("fromNodeId");
  });

  it("on the GPU canvas reads the live layer's flow and the host's box, not the painter's sheet ahead of them", () => {
    const expected = canvasCentrePosition({ width: 300, height: 280 });
    // The host holds the scene's canvas (with the painter's own React Flow, pinned at the origin) before the live layer
    const host = document.createElement("div");
    host.dataset.gpuCanvas = "";
    host.getBoundingClientRect = flow.getBoundingClientRect;
    const sheet = document.createElement("div");
    sheet.className = "react-flow";
    sheet.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768, toJSON: () => ({}) });
    const sheetViewport = document.createElement("div");
    sheetViewport.className = "react-flow__viewport";
    sheetViewport.style.transform = "translate(0px, 0px) scale(1)";
    sheet.appendChild(sheetViewport);
    const live = document.createElement("div");
    live.dataset.gpuCanvasLive = "";
    flow.remove();
    live.appendChild(flow);
    host.append(sheet, live);
    document.body.prepend(host);
    try {
      expect(canvasCentrePosition({ width: 300, height: 280 })).toEqual(expected);
    } finally {
      host.remove();
      document.body.appendChild(flow);
    }
  });

  it("falls back to the stored viewport, then to no pan, when the canvas has not drawn one", () => {
    flow.querySelector(".react-flow__viewport")!.remove();
    useWorkflowStore.setState({ canvasViewport: { x: 100, y: 0, zoom: 0.5 } });
    expect(canvasCentrePosition({ width: 300, height: 280 })).toEqual({ x: (600 - 100) / 0.5 - 150, y: 400 / 0.5 - 140 });
    useWorkflowStore.setState({ canvasViewport: null });
    expect(canvasCentrePosition({ width: 300, height: 280 })).toEqual({ x: 450, y: 260 });
  });
});

describe("frameFileName", () => {
  it("names the frame by its time", () => {
    expect(frameFileName(4.6)).toBe("frame-0-04-60.png");
    expect(frameFileName(75.25)).toBe("frame-1-15-25.png");
  });
});
