import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const store = () => useWorkflowStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 }, selected: true }) as WorkflowNode;

const stitchData = (edgeId: string, timeline: boolean): VideoStitchNodeData => ({
  clips: [],
  clipOrder: [edgeId],
  outputVideo: null,
  loopCount: 1,
  status: "idle",
  error: null,
  progress: 0,
  encoderSupported: true,
  ...(timeline && {
    timeline: [
      { id: "clip_a", source: { kind: "edge", edgeId }, inSec: 1, outSec: 3, muted: true, volume: 0.5 },
      { id: "clip_lib", source: { kind: "asset", assetId: "asset-1" }, inSec: 0, outSec: null, muted: false, volume: 1 },
    ],
  }),
});

function seed(timeline: boolean, extra: Partial<VideoStitchNodeData> = {}) {
  const edge: WorkflowEdge = {
    id: "edge-gen-1-stitch-1-video-video-0",
    source: "gen-1",
    target: "stitch-1",
    sourceHandle: "video",
    targetHandle: "video-0",
  };
  useWorkflowStore.setState({
    nodes: [
      node("gen-1", "generateVideo", { outputVideo: "blob:clip" }),
      node("stitch-1", "videoStitch", { ...stitchData(edge.id, timeline), ...extra } as unknown as Record<string, unknown>),
    ],
    edges: [edge],
  });
}

beforeEach(() => {
  store().clearClipboard();
  store().clearWorkflow();
});

afterEach(() => {
  store().clearWorkflow();
});

describe("pasting a Stitch node with its sources", () => {
  it("points the pasted timeline and clipOrder at the pasted edge", () => {
    seed(true);
    store().copySelectedNodes();
    store().pasteNodes();

    const pastedEdge = store().edges[1];
    const pastedStitch = store().nodes.find((n) => n.type === "videoStitch" && n.id !== "stitch-1")!;
    const data = pastedStitch.data as VideoStitchNodeData;
    expect(pastedEdge.target).toBe(pastedStitch.id);
    expect(data.timeline![0].source).toEqual({ kind: "edge", edgeId: pastedEdge.id });
    expect(data.timeline![0]).toMatchObject({ inSec: 1, outSec: 3, muted: true, volume: 0.5 });
    expect(data.timeline![1].source).toEqual({ kind: "asset", assetId: "asset-1" });
    expect(data.clipOrder).toEqual([pastedEdge.id]);

    // The original keeps its own
    const original = store().nodes.find((n) => n.id === "stitch-1")!.data as VideoStitchNodeData;
    expect(original.clipOrder).toEqual(["edge-gen-1-stitch-1-video-video-0"]);
  });

  it("carries a legacy node's clipOrder over without giving it a timeline", () => {
    seed(false);
    store().copySelectedNodes();
    store().pasteNodes();

    const pastedEdge = store().edges[1];
    const pastedStitch = store().nodes.find((n) => n.type === "videoStitch" && n.id !== "stitch-1")!;
    const data = pastedStitch.data as VideoStitchNodeData;
    expect(data.clipOrder).toEqual([pastedEdge.id]);
    expect("timeline" in data).toBe(false);
  });

  it("keeps every clip's start in a placed node", () => {
    const sequenceLayout = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
    seed(true, { sequenceLayout });
    const placed = (store().nodes[1].data as VideoStitchNodeData).timeline!.map((clip, i) => ({
      ...clip,
      startSec: [2.25, 0][i],
    }));
    useWorkflowStore.setState({
      nodes: store().nodes.map((n) => (n.id === "stitch-1" ? { ...n, data: { ...n.data, timeline: placed } } : n)),
    });
    store().copySelectedNodes();
    store().pasteNodes();

    const pastedStitch = store().nodes.find((n) => n.type === "videoStitch" && n.id !== "stitch-1")!;
    expect((pastedStitch.data as VideoStitchNodeData).timeline!.map((clip) => clip.startSec)).toEqual([2.25, 0]);
  });

  it("keeps a stacked node's layout", () => {
    const sequenceLayout = { mode: "stacked" as const, overlapSec: 1.5, crossfade: false };
    seed(true, { sequenceLayout });
    store().copySelectedNodes();
    store().pasteNodes();

    const pastedStitch = store().nodes.find((n) => n.type === "videoStitch" && n.id !== "stitch-1")!;
    expect((pastedStitch.data as VideoStitchNodeData).sequenceLayout).toEqual(sequenceLayout);
  });
});

describe("pasting a Stitch node's audio clips", () => {
  const musicClip = { id: "audio:music", source: { kind: "music" }, row: 0, startSec: 1, inSec: 0, outSec: null, muted: false, curve: [] };
  const tone = {
    id: "t",
    source: { kind: "asset", assetId: "atone00000001" },
    row: 1,
    startSec: 0,
    inSec: 0,
    outSec: null,
    muted: false,
    curve: [],
  };
  const audioEdge: WorkflowEdge = {
    id: "edge-mus-1-stitch-1-audio-audio",
    source: "mus-1",
    target: "stitch-1",
    sourceHandle: "audio",
    targetHandle: "audio",
  };

  function seedWithMusic(audioClips: unknown[], copyMusicSource: boolean) {
    seed(true, { audioClips } as unknown as Partial<VideoStitchNodeData>);
    useWorkflowStore.setState({
      nodes: [...store().nodes, node("mus-1", "audioInput", { audioFile: "blob:music" })].map((n) => ({
        ...n,
        selected: n.id !== "mus-1" || copyMusicSource,
      })),
      edges: [...store().edges, audioEdge],
    });
  }
  const pasted = () =>
    store().nodes.find((n) => n.type === "videoStitch" && n.id !== "stitch-1")!.data as VideoStitchNodeData;

  it("drops the music clips of a node pasted without its music source", () => {
    seedWithMusic([musicClip, tone], false);
    store().copySelectedNodes();
    store().pasteNodes();
    expect(pasted().audioClips).toEqual([{ ...tone, row: 0 }]);
    // The original keeps its own
    expect((store().nodes.find((n) => n.id === "stitch-1")!.data as VideoStitchNodeData).audioClips).toHaveLength(2);
  });

  it("removes the key when only music was there", () => {
    seedWithMusic([musicClip], false);
    store().copySelectedNodes();
    store().pasteNodes();
    expect("audioClips" in pasted()).toBe(false);
  });

  it("keeps them when the music source is pasted with it", () => {
    seedWithMusic([musicClip, tone], true);
    store().copySelectedNodes();
    store().pasteNodes();
    expect(pasted().audioClips).toEqual([musicClip, tone]);
  });
});
