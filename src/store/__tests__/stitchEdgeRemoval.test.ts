import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { StitchTimelineClip, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";
import { readStitchDraft } from "@/lib/stitch/draft";
import { stitchReadContext } from "@/lib/stitch/sources";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// The card is never mounted here: whatever happens to the sequence happens in the store.

const store = () => useWorkflowStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;

// The id onConnect gives the same connection every time.
const edgeId = (source: string, handle: string) => `edge-${source}-stitch-video-${handle}`;
const edgeA = edgeId("gen-a", "video-0");
const edgeB = edgeId("gen-b", "video-1");

const clip = (id: string, edge: string, init: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "edge", edgeId: edge },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...init,
});

function seed(withTimeline: boolean) {
  const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
    id,
    source,
    target: "stitch",
    sourceHandle: "video",
    targetHandle,
  });
  const data: Partial<VideoStitchNodeData> = {
    clips: [],
    clipOrder: [edgeA, edgeB],
    outputVideo: null,
    loopCount: 1,
    status: "idle",
    error: null,
    progress: 0,
    encoderSupported: true,
    ...(withTimeline && { timeline: [clip(`clip:${edgeA}`, edgeA, { inSec: 2 }), clip(`clip:${edgeB}`, edgeB)] }),
  };
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
      node("stitch", "videoStitch", data as Record<string, unknown>),
    ],
    edges: [edge(edgeA, "gen-a", "video-0"), edge(edgeB, "gen-b", "video-1")],
  });
}

const stitchData = () => store().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
const draft = () => {
  const { nodes, edges } = store();
  return readStitchDraft(stitchData(), stitchReadContext("stitch", nodes, edges));
};
const replugA = () =>
  store().onConnect({ source: "gen-a", target: "stitch", sourceHandle: "video", targetHandle: "video-0" });

beforeEach(() => store().clearWorkflow());
afterEach(() => store().clearWorkflow());

describe("removing an edge into a Stitch", () => {
  it("drops its clip at once, so plugging it back in gives a fresh clip at the end", () => {
    seed(true);
    store().removeEdge(edgeA);
    expect(stitchData().timeline!.map((c) => c.id)).toEqual([`clip:${edgeB}`]);
    expect(stitchData().clipOrder).toEqual([edgeB]);

    replugA();
    expect(store().edges.map((e) => e.id)).toContain(edgeA);
    expect(draft().timeline.map((c) => [c.source.kind === "edge" && c.source.edgeId, c.inSec])).toEqual([
      [edgeB, 0],
      [edgeA, 0],
    ]);
  });

  it("puts the clip back with the edge on Undo", () => {
    seed(true);
    store().removeEdge(edgeA);
    store().undo();
    expect(store().edges.map((e) => e.id)).toContain(edgeA);
    expect(stitchData().timeline!.map((c) => [c.id, c.inSec])).toEqual([
      [`clip:${edgeA}`, 2],
      [`clip:${edgeB}`, 0],
    ]);
  });

  it("drops it on a canvas delete, removeEdges, a deleted source and an agent batch alike", () => {
    seed(true);
    store().onEdgesChange([{ type: "remove", id: edgeA }]);
    expect(stitchData().clipOrder).toEqual([edgeB]);

    seed(true);
    store().removeEdges([edgeA]);
    expect(stitchData().clipOrder).toEqual([edgeB]);

    seed(true);
    store().removeNode("gen-a");
    expect(stitchData().timeline!.map((c) => c.id)).toEqual([`clip:${edgeB}`]);

    seed(true);
    store().applyAgentGraphOps({ batchId: "b1", toolCallId: "t1", summary: "", ops: [{ op: "removeEdge", id: edgeA }] });
    expect(stitchData().clipOrder).toEqual([edgeB]);
  });

  it("drops a legacy node's clipOrder entry too, without giving it a timeline", () => {
    seed(false);
    store().removeEdge(edgeA);
    expect(stitchData().clipOrder).toEqual([edgeB]);
    expect("timeline" in stitchData()).toBe(false);

    replugA();
    expect(draft().timeline.map((c) => c.source.kind === "edge" && c.source.edgeId)).toEqual([edgeB, edgeA]);
  });

  it("leaves Stitch nodes alone when an unrelated edge goes", () => {
    seed(true);
    useWorkflowStore.setState({
      nodes: [...store().nodes, node("p", "prompt", { prompt: "x" }), node("g", "nanoBanana", {})],
      edges: [...store().edges, { id: "other", source: "p", target: "g", sourceHandle: "text", targetHandle: "text" }],
    });
    const before = store().nodes;
    store().removeEdge("other");
    expect(store().nodes).toBe(before);
  });
});

describe("connecting a video to a Stitch", () => {
  const edgeV = edgeId("gen-v", "video-2");
  const musicEdge: WorkflowEdge = { id: "music", source: "music", target: "stitch", sourceHandle: "audio", targetHandle: "audio" };
  const connectV = () =>
    store().onConnect({ source: "gen-v", target: "stitch", sourceHandle: "video", targetHandle: "video-2" });

  /** A node Done wrote with both clips muted under music, plus a third video source. */
  function seedMutedUnderMusic() {
    seed(true);
    useWorkflowStore.setState({
      nodes: [
        ...store().nodes.map((n) =>
          n.id === "stitch"
            ? ({
                ...n,
                data: {
                  ...n.data,
                  timeline: (n.data as VideoStitchNodeData).timeline!.map((c) => ({ ...c, muted: true })),
                },
              } as WorkflowNode)
            : n,
        ),
        node("gen-v", "generateVideo", { outputVideo: "blob:v" }),
        node("music", "generateAudio", {}),
      ],
      edges: [...store().edges, musicEdge],
    });
  }

  it("writes the clip when the connection is made, muted like the others under music, so it stays muted without the music", () => {
    seedMutedUnderMusic();
    connectV();
    expect(stitchData().timeline!.map((c) => [c.id, c.muted])).toEqual([
      [`clip:${edgeA}`, true],
      [`clip:${edgeB}`, true],
      [`clip:${edgeV}`, true],
    ]);
    expect(stitchData().clipOrder).toEqual([edgeA, edgeB, edgeV]);

    store().removeEdge("music");
    expect(draft().timeline.map((c) => c.muted)).toEqual([true, true, true]);
  });

  it("adds it with its sound when no music is connected", () => {
    seedMutedUnderMusic();
    store().removeEdge("music");
    connectV();
    expect(stitchData().timeline!.map((c) => c.muted)).toEqual([true, true, false]);
  });

  it("takes the connection and its clip away together on Undo", () => {
    seedMutedUnderMusic();
    connectV();
    store().undo();
    expect(store().edges.map((e) => e.id)).not.toContain(edgeV);
    expect(stitchData().timeline!.map((c) => c.id)).toEqual([`clip:${edgeA}`, `clip:${edgeB}`]);
  });

  it("does the same for an agent's connection and a reconnected edge", () => {
    seedMutedUnderMusic();
    store().applyAgentGraphOps({
      batchId: "b1",
      toolCallId: "t1",
      summary: "",
      ops: [{ op: "addEdge", id: edgeV, source: "gen-v", target: "stitch", sourceHandle: "video", targetHandle: "video-2" }],
    });
    expect(stitchData().timeline!.map((c) => [c.id, c.muted])).toContainEqual([`clip:${edgeV}`, true]);

    seedMutedUnderMusic();
    store().reconnectEdge(edgeB, { source: "gen-v", target: "stitch", sourceHandle: "video", targetHandle: "video-1" });
    const moved = edgeId("gen-v", "video-1");
    expect(stitchData().timeline!.map((c) => [c.id, c.muted])).toEqual([
      [`clip:${edgeA}`, true],
      [`clip:${moved}`, true],
    ]);
  });

  it("leaves a legacy node without a timeline", () => {
    seed(false);
    useWorkflowStore.setState({ nodes: [...store().nodes, node("gen-v", "generateVideo", { outputVideo: "blob:v" })] });
    connectV();
    expect("timeline" in stitchData()).toBe(false);
  });
});
