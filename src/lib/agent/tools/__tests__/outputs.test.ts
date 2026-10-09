import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshotOutput, AgentWorkflowSnapshot } from "../../types";
import { GraphDraft } from "../../graph/draft";
import { VIEW_OUTPUTS_MAX_IMAGES, viewOutputs, type AgentOutputReader, type ViewableOutput } from "../outputs";
import { createAgentToolRuntime } from "../runtime";
import { call, emptySnapshot, sequentialIds, snapshotOf, storeNode } from "./testUtils";

const picture = (assetId: string): ViewableOutput => ({
  kind: "image",
  image: { mime: "image/webp", data: `bytes-${assetId}` },
  prompt: `prompt for ${assetId}`,
  model: "GPT Image 2.5 Flare",
});

function readerOf(found: Record<string, ViewableOutput | null>): AgentOutputReader & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async (id: string) => found[id] ?? null) };
}

/** Nodes as the snapshot sends them, with the library ids of their results. */
function canvas(nodes: Array<{ id: string; x: number; title?: string; outputs?: AgentSnapshotOutput[]; image?: boolean }>): AgentWorkflowSnapshot {
  const snapshot = snapshotOf({
    nodes: nodes.map((n) => storeNode(n.id, n.id.startsWith("imageInput") ? "imageInput" : "nanoBanana", { x: n.x, y: 0 }, n.title ? { customTitle: n.title } : {})),
    edges: [],
  });
  snapshot.nodes.forEach((node, index) => {
    const spec = nodes[index];
    if (spec.outputs) node.outputs = spec.outputs;
    if (spec.image) node.content = { image: true };
  });
  return snapshot;
}

const shown = (assetId: string): AgentSnapshotOutput => ({ assetId, kind: "image", current: true });
const earlier = (assetId: string): AgentSnapshotOutput => ({ assetId, kind: "image" });

describe("view_outputs", () => {
  it("shows each node's current result, left to right, each image after its caption", async () => {
    const draft = new GraphDraft(
      canvas([
        { id: "nanoBanana-2", x: 800, title: "Scene 2", outputs: [shown("s2"), earlier("s2-old")] },
        { id: "nanoBanana-1", x: 0, title: "Scene 1", outputs: [shown("s1")] },
      ]),
    );
    const result = await viewOutputs(draft, readerOf({ s1: picture("s1"), s2: picture("s2") }), {});
    expect(result).toMatchObject({ ok: true, ops: [], summary: "Looked at 2 images from 2 nodes", focusNodeIds: ["nanoBanana-1", "nanoBanana-2"] });
    expect(result.text).toBe("2 images from 2 nodes follow, each after its caption.");
    expect(result.images!.map((image) => image.data)).toEqual(["bytes-s1", "bytes-s2"]);
    expect(result.images![0].caption).toBe(
      'Image 1: Scene 1 (nanoBanana-1), the result it shows · model GPT Image 2.5 Flare · prompt "prompt for s1"',
    );
  });

  it("adds earlier takes to compare runs, and names the run of a batch", async () => {
    const draft = new GraphDraft(canvas([{ id: "nanoBanana-1", x: 0, outputs: [shown("a"), earlier("b"), earlier("c")] }]));
    const reader = readerOf({ a: picture("a"), b: { ...picture("b"), batch: { index: 1, count: 4 } }, c: picture("c") });
    const result = await viewOutputs(draft, reader, { takes: 2 });
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(result.images!.map((image) => image.caption.split(" · ").slice(0, 2).join(" · "))).toEqual([
      "Image 1: nanoBanana (nanoBanana-1), the result it shows · model GPT Image 2.5 Flare",
      "Image 2: nanoBanana (nanoBanana-1), an earlier take (2 of its latest) · run 2 of 4",
    ]);
  });

  it("says what it could not show: uploads, lost files, frameless videos, audio, unknown nodes, past the cap", async () => {
    const many = Array.from({ length: VIEW_OUTPUTS_MAX_IMAGES + 2 }, (_, i) => ({ id: `nanoBanana-${i + 10}`, x: 1000 + i, outputs: [shown(`m${i}`)] }));
    const draft = new GraphDraft(
      canvas([
        { id: "imageInput-1", x: 0, image: true },
        { id: "nanoBanana-1", x: 100, outputs: [shown("gone")] },
        { id: "nanoBanana-2", x: 200, outputs: [{ assetId: "clip", kind: "video", current: true }] },
        { id: "nanoBanana-3", x: 300, outputs: [{ assetId: "song", kind: "audio", current: true }] },
        ...many,
      ]),
    );
    const found: Record<string, ViewableOutput | null> = { clip: { kind: "video" }, song: { kind: "audio" } };
    many.forEach((_, i) => (found[`m${i}`] = picture(`m${i}`)));
    const result = await viewOutputs(draft, readerOf(found), {
      nodeIds: ["imageInput-1", "nanoBanana-1", "nanoBanana-2", "nanoBanana-3", "nope", ...many.map((m) => m.id)],
    });
    expect(result.text).toContain("imageInput (imageInput-1) has no generated result to look at (an uploaded or copied file is not viewable).");
    expect(result.text).toContain("nanoBanana (nanoBanana-1), the result it shows: no longer in the asset library.");
    expect(result.text).toContain("the video has no captured frame yet");
    expect(result.text).toContain("audio cannot be viewed");
    expect(result.text).toContain('No node "nope" on the canvas.');
    expect(result.text).toContain("5 more results were left out (at most 12 per call)");
    expect(result.images).toHaveLength(9);
  });

  it("captions a video by its first frame, and has nothing to show on a canvas without results", async () => {
    const draft = new GraphDraft(canvas([{ id: "nanoBanana-1", x: 0, outputs: [{ assetId: "clip", kind: "video", current: true }] }]));
    const result = await viewOutputs(draft, readerOf({ clip: { ...picture("clip"), kind: "video" } }), {});
    expect(result.images![0].caption).toContain("the result it shows, the video's first frame");

    const empty = await viewOutputs(new GraphDraft(emptySnapshot()), readerOf({}), {});
    expect(empty).toMatchObject({ ok: true, summary: "Nothing to look at yet" });
    expect(empty).not.toHaveProperty("images");
  });

  it("runs as a read-only tool on the turn's runtime, with the reader it is given", async () => {
    const runtime = createAgentToolRuntime(canvas([{ id: "nanoBanana-1", x: 0, outputs: [shown("s1")] }]), {
      randomId: sequentialIds(),
      outputs: readerOf({ s1: picture("s1") }),
    });
    const result = await call(runtime, "view_outputs", {});
    expect(result).toMatchObject({ ok: true, ops: [], summary: "Looked at 1 image from 1 node" });
    expect(result.images).toHaveLength(1);
  });
});
