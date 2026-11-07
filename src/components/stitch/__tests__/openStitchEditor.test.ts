import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { openEditorForExpand, openStitchEditor } from "@/components/stitch/openStitchEditor";
import type { WorkflowEdge, WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// Real stores: what the header's Expand and the card's Open editor do to them.

const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "s1",
  sourceHandle: targetHandle === "audio" ? "audio" : "video",
  targetHandle,
});

function seed() {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: null }),
      node("gen-b", "generateVideo", { outputVideo: null }),
      node("music", "generateAudio", { outputAudio: null }),
      node("s1", "videoStitch", { clips: [], clipOrder: ["eB"], outputVideo: null, loopCount: 2, status: "idle" }),
      node("p1", "prompt", { prompt: "" }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1"), edge("eM", "music", "audio")],
    canvasGeneration: 7,
  });
}

const editor = () => useStitchEditorStore.getState();

describe("openStitchEditor", () => {
  beforeEach(() => {
    editor().close();
    seed();
  });

  it("opens the editor on the node's migrated, reconciled sequence", () => {
    expect(openStitchEditor("s1")).toBe(true);
    const s = editor();
    expect(s.isOpen).toBe(true);
    expect(s.nodeId).toBe("s1");
    expect(s.canvasGeneration).toBe(7);
    // clipOrder first, then the live edge it lacks; music is connected, so the legacy clips are muted
    expect(s.draft!.timeline.map((c) => [c.id, c.muted])).toEqual([
      ["clip:eB", true],
      ["clip:eA", true],
    ]);
    expect(s.draft!.loopCount).toBe(2);
    expect(s.initial).toBe(s.draft);
  });

  it("returns false and leaves the editor closed when the node is not a Stitch node", () => {
    expect(openStitchEditor("p1")).toBe(false);
    expect(openStitchEditor("gone")).toBe(false);
    expect(editor().isOpen).toBe(false);
  });

  it("records the music edge at open, dimmed or not, and null without one", () => {
    openStitchEditor("s1");
    expect(editor().musicEdgeIdAtOpen).toBe("eM");
    // The music clip is read only with the music live, but the edge is recorded either way
    useWorkflowStore.setState({ dimmedNodeIds: new Set(["music"]) });
    openStitchEditor("s1");
    expect(editor().musicEdgeIdAtOpen).toBe("eM");
    expect(editor().draft!.audioClips).toEqual([]);
    useWorkflowStore.setState({ dimmedNodeIds: new Set(), edges: useWorkflowStore.getState().edges.filter((e) => e.id !== "eM") });
    openStitchEditor("s1");
    expect(editor().musicEdgeIdAtOpen).toBeNull();
  });

  it("routes Expand on a Stitch node to the editor", () => {
    expect(openEditorForExpand("s1", "videoStitch")).toBe(true);
    expect(editor().isOpen).toBe(true);
    expect(editor().nodeId).toBe("s1");
  });

  it("leaves Expand on other nodes to the canvas", () => {
    expect(openEditorForExpand("p1", "prompt")).toBe(false);
    expect(openEditorForExpand("a1", "annotation")).toBe(false);
    expect(editor().isOpen).toBe(false);
  });

  it("claims Expand on a Stitch node that is gone, without opening anything", () => {
    expect(openEditorForExpand("gone", "videoStitch")).toBe(true);
    expect(editor().isOpen).toBe(false);
  });

  it("opens nothing while an edit project's session holds the editor", () => {
    editor().openEdit({
      editId: "ed0123456789ab",
      draft: { timeline: [], audioClips: [], legacyAudio: { curve: [], muted: false }, loopCount: 1, sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true } },
    });
    expect(openStitchEditor("s1")).toBe(false);
    expect(editor().editId).toBe("ed0123456789ab");
    expect(editor().nodeId).toBeNull();
    // Parked, the store is free for the dialog again
    editor().park();
    expect(openStitchEditor("s1")).toBe(true);
    expect(editor().nodeId).toBe("s1");
  });
});
