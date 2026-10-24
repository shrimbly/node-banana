import { describe, it, expect } from "vitest";
import { shallow } from "zustand/shallow";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import {
  edgeClipSourceTuple,
  edgeClipSources,
  edgeClipSourcesFromTuple,
  resolveEdgeVideo,
  resolveEdgeVideos,
  stitchHasMusicEdge,
  stitchMusicMedia,
  stitchReadContext,
} from "../sources";

const node = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
const edge = (id: string, source: string, target: string, targetHandle: string, sourceHandle = "video", data?: object) =>
  ({ id, source, target, sourceHandle, targetHandle, ...(data ? { data } : {}) }) as WorkflowEdge;

const stitch = node("s", "videoStitch", { clips: [], clipOrder: [] });

describe("resolveEdgeVideo", () => {
  it("reads a generated video and an uploaded one", () => {
    const nodes = [stitch, node("g", "generateVideo", { outputVideo: "blob:gen" }), node("v", "videoInput", { video: "data:video/mp4;base64,AAA" })];
    const edges = [edge("e1", "g", "s", "video-0"), edge("e2", "v", "s", "video-1")];
    expect(resolveEdgeVideo("s", "e1", nodes, edges)).toBe("blob:gen");
    expect(resolveEdgeVideo("s", "e2", nodes, edges)).toBe("data:video/mp4;base64,AAA");
  });

  it("is null while the source has produced nothing", () => {
    const nodes = [stitch, node("g", "generateVideo", { outputVideo: null })];
    expect(resolveEdgeVideo("s", "e1", nodes, [edge("e1", "g", "s", "video-0")])).toBeNull();
  });

  it("follows a router, which can carry several videos", () => {
    const nodes = [
      stitch,
      node("g1", "generateVideo", { outputVideo: "blob:1" }),
      node("g2", "generateVideo", { outputVideo: "blob:2" }),
      node("g3", "generateVideo", { outputVideo: "blob:3" }),
      node("r", "router", {}),
    ];
    const edges = [
      edge("a", "g1", "r", "video"),
      edge("b", "g2", "r", "video"),
      edge("c", "g3", "r", "video"),
      edge("e1", "r", "s", "video-0"),
    ];
    expect(resolveEdgeVideos("s", "e1", nodes, edges)).toEqual(["blob:1", "blob:2", "blob:3"]);
    expect(resolveEdgeVideo("s", "e1", nodes, edges)).toBe("blob:1");
    expect(edgeClipSources("s", nodes, edges).get("e1")).toEqual({
      edgeId: "e1",
      sourceNodeId: "r",
      media: "blob:1",
      videoCount: 3,
    });
  });

  it("reads only the edge asked for", () => {
    const nodes = [stitch, node("g1", "generateVideo", { outputVideo: "blob:1" }), node("g2", "generateVideo", { outputVideo: "blob:2" })];
    const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1")];
    expect(resolveEdgeVideos("s", "e2", nodes, edges)).toEqual(["blob:2"]);
  });

  it("is null for a dimmed source", () => {
    const nodes = [stitch, node("g", "generateVideo", { outputVideo: "blob:gen" })];
    expect(resolveEdgeVideo("s", "e1", nodes, [edge("e1", "g", "s", "video-0")], new Set(["g"]))).toBeNull();
  });
});

describe("music", () => {
  const nodes = [stitch, node("m", "audioInput", { audioFile: "data:audio/mp3;base64,AAA" }), node("ga", "generateAudio", { outputAudio: null })];

  it("reads the connected music, or null", () => {
    expect(stitchMusicMedia("s", nodes, [edge("a", "m", "s", "audio", "audio")])).toBe("data:audio/mp3;base64,AAA");
    expect(stitchMusicMedia("s", nodes, [])).toBeNull();
  });

  it("counts a music edge whose source has not run yet", () => {
    expect(stitchHasMusicEdge("s", [edge("a", "ga", "s", "audio", "audio")])).toBe(true);
  });

  it("ignores a dimmed source, a loop edge and video edges", () => {
    expect(stitchHasMusicEdge("s", [edge("a", "m", "s", "audio", "audio")], new Set(["m"]))).toBe(false);
    expect(stitchHasMusicEdge("s", [edge("a", "m", "s", "audio", "audio", { isLoop: true })])).toBe(false);
    expect(stitchHasMusicEdge("s", [edge("e1", "g", "s", "video-0")])).toBe(false);
  });

  it("does not count a Switch output that is turned off, as the executor does not", () => {
    const sw = (enabled: boolean) =>
      node("sw", "switch", { inputType: "audio", switches: [{ id: "out-1", name: "A", enabled }] });
    const edges = [edge("in", "ga", "sw", "audio", "audio"), edge("a", "sw", "s", "audio", "out-1")];
    expect(stitchReadContext("s", [stitch, nodes[2], sw(false)], edges).hasMusic).toBe(false);
    expect(stitchReadContext("s", [stitch, nodes[2], sw(true)], edges).hasMusic).toBe(true);
  });

  it("does not count a source no run will fill: an empty Audio Input, directly or through a router", () => {
    const empty = node("m", "audioInput", { audioFile: null });
    const direct = [edge("a", "m", "s", "audio", "audio")];
    const routed = [edge("in", "m", "r", "audio", "audio"), edge("a", "r", "s", "audio", "audio")];
    expect(stitchHasMusicEdge("s", direct, undefined, [stitch, empty])).toBe(false);
    expect(stitchHasMusicEdge("s", routed, undefined, [stitch, empty, node("r", "router", {})])).toBe(false);
    expect(stitchHasMusicEdge("s", direct, undefined, nodes)).toBe(true);
    expect(stitchHasMusicEdge("s", routed, undefined, [...nodes, node("r", "router", {})])).toBe(true);
  });

  it("counts an empty Audio Input a generator feeds before the run fills it, so the answer does not flip", () => {
    const relay = (audioFile: string | null) => node("m", "audioInput", { audioFile });
    const edges = [edge("in", "ga", "m", "audio", "audio"), edge("a", "m", "s", "audio", "audio")];
    expect(stitchHasMusicEdge("s", edges, undefined, [stitch, nodes[2], relay(null)])).toBe(true);
    expect(stitchHasMusicEdge("s", edges, undefined, [stitch, nodes[2], relay("data:audio/mp3;base64,AAA")])).toBe(true);
    // An empty one fed only by another empty one still has nothing to give
    const chain = [edge("in", "m0", "m", "audio", "audio"), edge("a", "m", "s", "audio", "audio")];
    expect(stitchHasMusicEdge("s", chain, undefined, [stitch, relay(null), node("m0", "audioInput", { audioFile: null })])).toBe(false);
  });

  it("counts a generator behind a router before it has run, and nothing behind a Conditional Switch", () => {
    const routed = [edge("in", "ga", "r", "audio", "audio"), edge("a", "r", "s", "audio", "audio")];
    expect(stitchHasMusicEdge("s", routed, undefined, [...nodes, node("r", "router", {})])).toBe(true);
    const gated = [edge("in", "ga", "c", "text", "audio"), edge("a", "c", "s", "audio", "default")];
    expect(stitchHasMusicEdge("s", gated, undefined, [...nodes, node("c", "conditionalSwitch", { rules: [] })])).toBe(false);
  });

  it("does not count a source that is gone", () => {
    expect(stitchHasMusicEdge("s", [edge("a", "gone", "s", "audio", "audio")], undefined, nodes)).toBe(false);
  });

  it("goes into the read context with the live video edges", () => {
    const edges = [edge("e1", "g", "s", "video-0"), edge("a", "ga", "s", "audio", "audio")];
    expect(stitchReadContext("s", nodes, edges)).toEqual({ liveEdgeIds: ["e1"], hasMusic: true });
  });
});

describe("edge clip sources as selector tuples", () => {
  const nodes = [stitch, node("g1", "generateVideo", { outputVideo: "blob:1" }), node("g2", "generateVideo", { outputVideo: null })];
  const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1"), edge("e3", "gone", "s", "video-2")];

  it("lists every live video edge with its source and media", () => {
    expect([...edgeClipSources("s", nodes, edges).values()]).toEqual([
      { edgeId: "e1", sourceNodeId: "g1", media: "blob:1", videoCount: 1 },
      { edgeId: "e2", sourceNodeId: "g2", media: null, videoCount: 0 },
      { edgeId: "e3", sourceNodeId: null, media: null, videoCount: 0 },
    ]);
  });

  it("round-trips through the flat tuple", () => {
    expect(edgeClipSourcesFromTuple(edgeClipSourceTuple("s", nodes, edges))).toEqual(edgeClipSources("s", nodes, edges));
  });

  it("gives shallow-equal tuples for the same state, so a selector settles", () => {
    expect(shallow(edgeClipSourceTuple("s", nodes, edges), edgeClipSourceTuple("s", nodes, edges))).toBe(true);
  });
});
