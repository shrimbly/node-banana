import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StitchAudioClip, StitchTimelineClip, WorkflowEdge, WorkflowNode } from "@/types";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import type { NodeExecutionContext } from "../types";
import type { StitchDraft } from "@/lib/stitch/draft";
import {
  gatherDraftInputs,
  gatherStitchInputs,
  NO_CLIP_TO_RENDER,
  stitchEngineOptions,
  stitchRecordParameters,
  type GatheredStitch,
} from "../stitchInputs";

const mocks = vi.hoisted(() => {
  class AssetApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = "AssetApiError";
    }
  }
  return { AssetApiError, fetchAssetBlob: vi.fn(), prepareAudioAsync: vi.fn(), requestAssetInfo: vi.fn(), gatherAudioClipInputs: vi.fn() };
});
vi.mock("../audioClipInputs", () => ({ gatherAudioClipInputs: mocks.gatherAudioClipInputs }));
vi.mock("@/lib/assets/client/api", () => ({ AssetApiError: mocks.AssetApiError, fetchAssetBlob: mocks.fetchAssetBlob }));
vi.mock("@/hooks/useAudioMixing", () => ({ prepareAudioAsync: mocks.prepareAudioAsync }));
vi.mock("@/lib/stitch/assetInfo", () => ({ requestAssetInfo: mocks.requestAssetInfo }));

/** Where each fetched Blob came from (jsdom's Blob cannot be read back). */
const origins = new WeakMap<Blob, string>();
function sourced(from: string, type: string): Blob {
  const blob = new Blob([from], { type });
  origins.set(blob, from);
  return blob;
}
const mockFetch = vi.fn(async (url: string) => ({ blob: async () => sourced(url, url.startsWith("audio") ? "audio/mpeg" : "video/mp4") }));
vi.stubGlobal("fetch", mockFetch);

const node = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
const edge = (id: string, source: string, target: string, targetHandle: string, sourceHandle = "video") =>
  ({ id, source, target, sourceHandle, targetHandle }) as WorkflowEdge;
const video = (id: string, url: string | null) => node(id, "generateVideo", { outputVideo: url });
const edgeClip = (id: string, edgeId: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "edge", edgeId },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});
const assetClip = (id: string, assetId: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "asset", assetId },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});

function stitchNode(data: Record<string, unknown> = {}): WorkflowNode {
  return node("s", "videoStitch", { clips: [], clipOrder: [], loopCount: 1, outputVideo: null, ...data });
}

/** A context over a real graph; getConnectedInputs reads it the way the store does. */
function makeCtx(stitch: WorkflowNode, nodes: WorkflowNode[], edges: WorkflowEdge[], extra: Partial<NodeExecutionContext> = {}) {
  const all = [stitch, ...nodes];
  return {
    node: stitch,
    getConnectedInputs: (id: string) => getConnectedInputsPure(id, all, edges),
    updateNodeData: vi.fn(),
    getFreshNode: (id: string) => all.find((n) => n.id === id),
    getEdges: () => edges,
    getNodes: () => all,
    get: () => ({ dimmedNodeIds: new Set<string>() }),
    ...extra,
  } as unknown as NodeExecutionContext;
}

function texts(blobs: Blob[]): Array<string | undefined> {
  return blobs.map((b) => origins.get(b));
}

const twoVideos = () => ({
  nodes: [video("g1", "blob:one"), video("g2", "blob:two")],
  edges: [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1")],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAssetBlob.mockImplementation(async (id: string) => sourced(`asset:${id}`, "video/mp4"));
  mocks.prepareAudioAsync.mockResolvedValue({ buffer: { sampleRate: 48000 }, duration: 3 });
  mocks.gatherAudioClipInputs.mockResolvedValue([]);
});

describe("gatherStitchInputs", () => {
  it("follows the timeline's order, not the edges'", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({ timeline: [edgeClip("b", "e2"), edgeClip("a", "e1")] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:two", "blob:one"]);
  });

  it("honours an unedited node's reordered clipOrder", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({ clipOrder: ["e2", "e1"] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:two", "blob:one"]);
  });

  it("passes In, Out, mute and volume through", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({
      timeline: [edgeClip("a", "e1", { inSec: 0.8, outSec: 5 }), edgeClip("b", "e2", { muted: true, volume: 0.4 })],
    });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(g.clips.map(({ inSec, outSec, muted, volume }) => ({ inSec, outSec, muted, volume }))).toEqual([
      { inSec: 0.8, outSec: 5, muted: false, volume: 1 },
      { inSec: 0, outSec: null, muted: true, volume: 0.4 },
    ]);
    expect(g.clipCount).toBe(2);
  });

  it("loads a library clip from the asset library, with the run's signal", async () => {
    const { nodes, edges } = twoVideos();
    const signal = new AbortController().signal;
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), assetClip("x", "aasset0000009")] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges, { signal }), stitch.data as never);
    expect(mocks.fetchAssetBlob).toHaveBeenCalledWith("aasset0000009", signal);
    // e2 is not in the timeline yet, so it is appended, as on the card
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:one", "asset:aasset0000009", "blob:two"]);
  });

  it("fetches a split clip's source once", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({
      timeline: [edgeClip("a1", "e1", { outSec: 2 }), edgeClip("a2", "e1", { inSec: 2 }), assetClip("x1", "alibrary00001"), assetClip("x2", "alibrary00001"), edgeClip("b", "e2")],
    });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(g.clips).toHaveLength(5);
    expect(g.clips[0].blob).toBe(g.clips[1].blob);
    expect(mockFetch.mock.calls.filter(([url]) => url === "blob:one")).toHaveLength(1);
    expect(mocks.fetchAssetBlob).toHaveBeenCalledTimes(1);
  });

  it("skips a clip whose source has not generated yet", async () => {
    const nodes = [video("g1", "blob:one"), video("g2", null), video("g3", "blob:three")];
    const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1"), edge("e3", "g3", "s", "video-2")];
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:one", "blob:three"]);
  });

  it("refuses one playable clip before fetching anything", async () => {
    const nodes = [video("g1", "blob:one"), video("g2", null)];
    const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1")];
    const stitch = stitchNode();
    await expect(gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never)).rejects.toThrow(
      "Need at least 2 video clips to render",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("mutes an unedited node's clips under music, as the stitch did", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const stitch = stitchNode();
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.clips.map((c) => c.muted)).toEqual([true, true]);
    expect(g.music).toEqual({ audio: { buffer: { sampleRate: 48000 }, duration: 3 }, curve: [], muted: false });
    expect(mocks.prepareAudioAsync).toHaveBeenCalledWith(expect.any(Blob), 0);
  });

  it("keeps an unedited node's clip sound when its music would not decode", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    mocks.prepareAudioAsync.mockResolvedValue(null);
    const stitch = stitchNode();
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music).toBeNull();
    expect(g.clips.map((c) => c.muted)).toEqual([false, false]);
  });

  describe("an edge from a router carrying three videos", () => {
    const nodes = [
      video("g1", "blob:1"),
      video("g2", "blob:2"),
      video("g3", "blob:3"),
      node("r", "router", {}),
    ];
    const edges = [
      edge("a", "g1", "r", "video"),
      edge("b", "g2", "r", "video"),
      edge("c", "g3", "r", "video"),
      edge("e1", "r", "s", "video-0"),
    ];

    it("gives an unedited node every video, in the router's order", async () => {
      const stitch = stitchNode();
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:1", "blob:2", "blob:3"]);
    });

    it("gives a timeline node's clip the first video only", async () => {
      const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), assetClip("x", "alibrary00001")] });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:1", "asset:alibrary00001"]);
    });
  });

  it("neither decodes nor returns muted music", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], audioMuted: true });
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music).toBeNull();
    expect(mocks.prepareAudioAsync).not.toHaveBeenCalled();
  });

  it("hands the music its curve and the node's loop count", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const curve = [{ t: 1, gain: 0.25 }];
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], audioCurve: curve, loopCount: 3 });
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music?.curve).toEqual(curve);
    expect(g.loopCount).toBe(3);
  });

  it("plays the music of a stored empty audioClips as a node without the key plays it: flat, unmuted", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const stitch = stitchNode({
      timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")],
      audioClips: [],
      // On a node with audioClips these are a copy for older builds, never read
      audioCurve: [{ t: 1, gain: 0 }],
      audioMuted: true,
    });
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music).not.toBeNull();
    expect(g.music?.curve).toEqual([]);
    expect(g.music?.muted).toBe(false);
    expect(g.audioClips).toBeNull();
    expect(mocks.gatherAudioClipInputs).not.toHaveBeenCalled();
  });

  describe("audio clips", () => {
    const musicClip = (extra: Partial<StitchAudioClip> = {}): StitchAudioClip => ({
      id: "audio:music",
      source: { kind: "music" },
      row: 0,
      startSec: 0,
      inSec: 0,
      outSec: null,
      muted: false,
      curve: [],
      ...extra,
    });
    const withMusic = (data: Record<string, unknown>) => {
      const { nodes, edges } = twoVideos();
      const music = node("m", "generateAudio", { outputAudio: "audio:song" });
      const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], ...data });
      return { stitch, ctx: makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]) };
    };

    it("takes the old music path for a stored untouched music clip alone, with its curve and mute", async () => {
      const curve = [{ t: 2, gain: 0.5 }];
      const { stitch, ctx } = withMusic({ audioClips: [musicClip({ row: 1, curve })], audioCurve: [], audioMuted: true });
      const g = await gatherStitchInputs(ctx, stitch.data as never);
      expect(g.music?.curve).toEqual(curve);
      expect(g.audioClips).toBeNull();
      expect(mocks.gatherAudioClipInputs).not.toHaveBeenCalled();
      const muted = withMusic({ audioClips: [musicClip({ muted: true })] });
      const m = await gatherStitchInputs(muted.ctx, muted.stitch.data as never);
      expect(m.music).toBeNull();
      expect(m.audioClips).toBeNull();
    });

    it("gathers every audio clip when the music moved, and passes no music", async () => {
      const inputs = [{ audio: { buffer: {}, duration: 3 }, startSec: 2, inSec: 0, outSec: null, curve: [] }];
      mocks.gatherAudioClipInputs.mockResolvedValue(inputs);
      const signal = new AbortController().signal;
      const { stitch, ctx } = withMusic({ audioClips: [musicClip({ startSec: 2 })] });
      const g = await gatherStitchInputs({ ...ctx, signal } as never, stitch.data as never);
      expect(g.music).toBeNull();
      expect(g.audioClips).toBe(inputs);
      expect(mocks.prepareAudioAsync).not.toHaveBeenCalled();
      expect(mocks.gatherAudioClipInputs).toHaveBeenCalledWith([musicClip({ startSec: 2 })], { musicUrl: "audio:song", signal });
    });

    it("gathers a library clip beside the music, the music reconciled onto row 0 when the node stores none", async () => {
      const tone: StitchAudioClip = { ...musicClip(), id: "aclip_1", source: { kind: "asset", assetId: "atone00000001" }, startSec: 3 };
      const { stitch, ctx } = withMusic({ audioClips: [tone] });
      await gatherStitchInputs(ctx, stitch.data as never);
      const [clips] = mocks.gatherAudioClipInputs.mock.calls[0];
      expect(clips.map((c: StitchAudioClip) => [c.id, c.row])).toEqual([
        ["audio:music", 0],
        ["aclip_1", 1],
      ]);
    });

    it("refuses too few video clips before fetching any audio", async () => {
      const { nodes, edges } = twoVideos();
      const stitch = stitchNode({ timeline: [edgeClip("a", "e1")], audioClips: [musicClip({ startSec: 2 })] });
      await expect(gatherStitchInputs(makeCtx(stitch, nodes.slice(0, 1), edges.slice(0, 1)), stitch.data as never)).rejects.toThrow("Need at least 2 video clips");
      expect(mocks.gatherAudioClipInputs).not.toHaveBeenCalled();
    });
  });

  it("says which clip's library video is gone", async () => {
    const { nodes, edges } = twoVideos();
    mocks.fetchAssetBlob.mockRejectedValue(new mocks.AssetApiError("No such asset in the library.", 404));
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2"), assetClip("x", "agone00000001")] });
    await expect(gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never)).rejects.toThrow(
      "Clip 3's library video is no longer in the library",
    );
    // The card and the editor hear it now, not at the next open
    expect(mocks.requestAssetInfo).toHaveBeenCalledWith(["agone00000001"], { refresh: true });
  });

  it("falls back to the connected videos when there are no edges to read", async () => {
    const stitch = stitchNode();
    const ctx = makeCtx(stitch, [], [], {
      getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [] }),
    });
    const g = await gatherStitchInputs(ctx, stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["v1", "v2"]);
    expect(g.clips.every((c) => c.inSec === 0 && c.outSec === null && !c.muted && c.volume === 1)).toBe(true);
  });

  describe("the stacked layout", () => {
    const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true };

    it("passes a stacked timeline node's overlap and crossfade", async () => {
      const { nodes, edges } = twoVideos();
      const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], sequenceLayout: STACKED });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(g.stack).toEqual({ overlapSec: 1, crossfade: true });
    });

    it("is null for Track, a 0 s overlap, a legacy node (even with a stacked key) and inputs gathered without edges", async () => {
      const { nodes, edges } = twoVideos();
      const timeline = [edgeClip("a", "e1"), edgeClip("b", "e2")];
      const cases: Array<{ data: Record<string, unknown>; ctx: NodeExecutionContext }> = [
        { data: { timeline }, ctx: makeCtx(stitchNode(), nodes, edges) },
        { data: { timeline, sequenceLayout: { ...STACKED, mode: "track" } }, ctx: makeCtx(stitchNode(), nodes, edges) },
        { data: { timeline, sequenceLayout: { ...STACKED, overlapSec: 0 } }, ctx: makeCtx(stitchNode(), nodes, edges) },
        { data: { sequenceLayout: STACKED }, ctx: makeCtx(stitchNode(), nodes, edges) },
        { data: { clipOrder: ["e1", "e2"], sequenceLayout: STACKED }, ctx: makeCtx(stitchNode(), nodes, edges) },
        {
          data: { timeline, sequenceLayout: STACKED },
          ctx: makeCtx(stitchNode(), [], [], { getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [] }) }),
        },
      ];
      for (const { data, ctx } of cases) {
        const stitch = stitchNode(data);
        const g = await gatherStitchInputs({ ...ctx, node: stitch } as NodeExecutionContext, stitch.data as never);
        expect(g.stack).toBeNull();
      }
    });

    it("keys a timeline node's clips by source, the same for split pieces", async () => {
      const { nodes, edges } = twoVideos();
      const stitch = stitchNode({
        timeline: [edgeClip("a1", "e1", { outSec: 2 }), edgeClip("a2", "e1", { inSec: 2 }), assetClip("x", "alibrary00001"), edgeClip("b", "e2")],
        sequenceLayout: STACKED,
      });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(g.clips.map((c) => c.source)).toEqual(["edge:e1", "edge:e1", "asset:alibrary00001", "edge:e2"]);
    });

    it("gives a legacy node's clips and inputs gathered without edges no source", async () => {
      const { nodes, edges } = twoVideos();
      const legacy = stitchNode({ clipOrder: ["e1", "e2"] });
      const g = await gatherStitchInputs(makeCtx(legacy, nodes, edges), legacy.data as never);
      expect(g.clips.every((c) => !("source" in c))).toBe(true);

      const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")] });
      const ctx = makeCtx(stitch, [], [], { getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [] }) });
      const fromInputs = await gatherStitchInputs(ctx, stitch.data as never);
      expect(fromInputs.clips.every((c) => !("source" in c))).toBe(true);
    });
  });

  describe("placed stacks", () => {
    const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true };
    const starts = (g: { clips: Array<{ startSec?: number }> }) => g.clips.map((c) => ("startSec" in c ? c.startSec : "none"));

    it("passes each clip's stored start and marks the node placed, with the stack as before", async () => {
      const { nodes, edges } = twoVideos();
      const stitch = stitchNode({
        timeline: [edgeClip("a", "e1", { startSec: 4 }), edgeClip("b", "e2", { startSec: 0 })],
        sequenceLayout: { ...STACKED, crossfade: false },
      });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(starts(g)).toEqual([4, 0]);
      expect(g.placed).toEqual({ crossfade: false, overlapSec: 1 });
      // The stack keeps its own rule: the engine's precedence decides
      expect(g.stack).toEqual({ overlapSec: 1, crossfade: false });
    });

    it("leaves a clip that was never placed without a start, and keeps a placed node with Overlap 0", async () => {
      const { nodes, edges } = twoVideos();
      const stitch = stitchNode({
        timeline: [edgeClip("a", "e1", { startSec: 1 }), edgeClip("b", "e2")],
        sequenceLayout: { ...STACKED, overlapSec: 0 },
      });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(starts(g)).toEqual([1, "none"]);
      expect(g.placed).toEqual({ crossfade: true, overlapSec: 0 });
      expect(g.stack).toBeNull();
    });

    it("passes no start and no placement for Track, a lined-up stack, legacy nodes and inputs gathered without edges", async () => {
      const { nodes, edges } = twoVideos();
      const placedTimeline = [edgeClip("a", "e1", { startSec: 4 }), edgeClip("b", "e2", { startSec: 0 })];
      const cases: Array<{ data: Record<string, unknown>; ctx: NodeExecutionContext }> = [
        { data: { timeline: placedTimeline, sequenceLayout: { ...STACKED, mode: "track" } }, ctx: makeCtx(stitchNode(), nodes, edges) },
        { data: { timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], sequenceLayout: STACKED }, ctx: makeCtx(stitchNode(), nodes, edges) },
        { data: { clipOrder: ["e1", "e2"], sequenceLayout: STACKED }, ctx: makeCtx(stitchNode(), nodes, edges) },
        // A legacy node with a start written into its old clip records by hand
        {
          data: { clipOrder: ["e1", "e2"], clips: [{ edgeId: "e1", startSec: 3 }], sequenceLayout: STACKED },
          ctx: makeCtx(stitchNode(), nodes, edges),
        },
        {
          data: { timeline: placedTimeline, sequenceLayout: STACKED },
          ctx: makeCtx(stitchNode(), [], [], { getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [] }) }),
        },
      ];
      for (const { data, ctx } of cases) {
        const stitch = stitchNode(data);
        const g = await gatherStitchInputs({ ...ctx, node: stitch } as NodeExecutionContext, stitch.data as never);
        expect(g.placed).toBeNull();
        expect(g.clips.every((c) => !("startSec" in c))).toBe(true);
      }
    });

    it("drops a clip with no video yet with its start; the others keep theirs", async () => {
      const nodes = [video("g1", "blob:one"), video("g2", null), video("g3", "blob:three")];
      const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1"), edge("e3", "g3", "s", "video-2")];
      const stitch = stitchNode({
        timeline: [edgeClip("a", "e1", { startSec: 2 }), edgeClip("b", "e2", { startSec: 0.5 }), edgeClip("c", "e3", { startSec: 7 })],
        sequenceLayout: STACKED,
      });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:one", "blob:three"]);
      expect(starts(g)).toEqual([2, 7]);
    });

    it("stays placed when the only pinned clip has no video yet", async () => {
      const nodes = [video("g1", "blob:one"), video("g2", null), video("g3", "blob:three")];
      const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1"), edge("e3", "g3", "s", "video-2")];
      const stitch = stitchNode({
        timeline: [edgeClip("a", "e1"), edgeClip("b", "e2", { startSec: 3 }), edgeClip("c", "e3")],
        sequenceLayout: STACKED,
      });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(g.placed).toEqual({ crossfade: true, overlapSec: 1 });
      expect(starts(g)).toEqual(["none", "none"]);
    });

    it("carries a library clip's start too", async () => {
      const { nodes, edges } = twoVideos();
      const stitch = stitchNode({
        timeline: [edgeClip("a", "e1", { startSec: 0 }), assetClip("x", "alibrary00001", { startSec: 2.5 }), edgeClip("b", "e2", { startSec: 6 })],
        sequenceLayout: STACKED,
      });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(starts(g)).toEqual([0, 2.5, 6]);
    });
  });
});

describe("gatherDraftInputs (an edit project's draft)", () => {
  const TRACK = { mode: "track" as const, overlapSec: 1, crossfade: true };
  const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
  const audioClip = (id: string, assetId: string, extra: Partial<StitchAudioClip> = {}): StitchAudioClip => ({
    id,
    source: { kind: "asset", assetId },
    row: 0,
    startSec: 0,
    inSec: 0,
    outSec: null,
    muted: false,
    curve: [],
    ...extra,
  });
  const draftOf = (timeline: StitchTimelineClip[], extra: Partial<StitchDraft> = {}): StitchDraft => ({
    timeline,
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: TRACK,
    ...extra,
  });
  /** What the engine is handed, the blobs by where they came from. */
  const shape = (g: GatheredStitch) => ({
    ...g,
    clips: g.clips.map(({ blob, ...rest }) => ({ ...rest, from: origins.get(blob) })),
    options: stitchEngineOptions(g),
    parameters: stitchRecordParameters(g),
  });

  it("encodes one clip: the view needs no second", async () => {
    const g = await gatherDraftInputs(draftOf([assetClip("x", "alibrary00001", { inSec: 1, outSec: 3, volume: 0.5 })]));
    expect(shape(g)).toMatchObject({
      clips: [{ inSec: 1, outSec: 3, muted: false, volume: 0.5, source: "asset:alibrary00001", from: "asset:alibrary00001" }],
      music: null,
      audioClips: null,
      loopCount: 1,
      clipCount: 1,
      stack: null,
      placed: null,
    });
  });

  it("refuses an empty edit before fetching anything", async () => {
    await expect(gatherDraftInputs(draftOf([]))).rejects.toThrow(NO_CLIP_TO_RENDER);
    expect(mocks.fetchAssetBlob).not.toHaveBeenCalled();
  });

  it("says which clip's library video is gone", async () => {
    mocks.fetchAssetBlob.mockImplementation(async (id: string) => {
      if (id === "agone00000001") throw new mocks.AssetApiError("gone", 404);
      return sourced(`asset:${id}`, "video/mp4");
    });
    await expect(gatherDraftInputs(draftOf([assetClip("x", "alibrary00001"), assetClip("y", "agone00000001")]))).rejects.toThrow(
      "Clip 2's library video is no longer in the library",
    );
    expect(mocks.requestAssetInfo).toHaveBeenCalledWith(["agone00000001"], { refresh: true });
  });

  it("passes the signal to every fetch and the audio", async () => {
    const signal = new AbortController().signal;
    const audio = [audioClip("s", "asound0000001", { startSec: 2 })];
    await gatherDraftInputs(draftOf([assetClip("x", "alibrary00001")], { audioClips: audio }), signal);
    expect(mocks.fetchAssetBlob).toHaveBeenCalledWith("alibrary00001", signal);
    expect(mocks.gatherAudioClipInputs).toHaveBeenCalledWith(audio, { musicUrl: null, signal });
  });

  // The same library clips must encode the same in the view as on the node (parent ruling 8)
  it.each([
    ["Track", [assetClip("x", "alibrary00001", { inSec: 0.5 }), assetClip("y", "alibrary00002", { muted: true })], TRACK],
    ["a lined-up stack", [assetClip("x", "alibrary00001"), assetClip("y", "alibrary00002", { outSec: 3 })], STACKED],
    [
      "a placed stack",
      [assetClip("x", "alibrary00001", { startSec: 0 }), assetClip("y", "alibrary00002", { startSec: 2.5 }), assetClip("z", "alibrary00001", { inSec: 4 })],
      STACKED,
    ],
  ] as const)("gathers %s exactly as the node with the same clips", async (_name, timeline, sequenceLayout) => {
    const audioClips = [audioClip("s", "asound0000001", { startSec: 1, curve: [{ t: 0, gain: 0.5 }] })];
    mocks.gatherAudioClipInputs.mockImplementation(async (clips: StitchAudioClip[]) => clips.map((c) => ({ id: c.id })));
    const stitch = stitchNode({ timeline: [...timeline], sequenceLayout, audioClips, loopCount: 2 });
    const fromNode = await gatherStitchInputs(makeCtx(stitch, [], []), stitch.data as never);
    const fromDraft = await gatherDraftInputs(draftOf([...timeline], { sequenceLayout, audioClips, loopCount: 2 }));
    expect(shape(fromDraft)).toEqual(shape(fromNode));
  });

  it("gathers no audio clips for an edit with none, as the node with none", async () => {
    const timeline = [assetClip("x", "alibrary00001"), assetClip("y", "alibrary00002")];
    const stitch = stitchNode({ timeline });
    const fromNode = await gatherStitchInputs(makeCtx(stitch, [], []), stitch.data as never);
    const fromDraft = await gatherDraftInputs(draftOf(timeline));
    expect(shape(fromDraft)).toEqual(shape(fromNode));
    expect(stitchEngineOptions(fromDraft)).toEqual({ loopCount: 1 });
    expect(mocks.gatherAudioClipInputs).not.toHaveBeenCalled();
  });
});
