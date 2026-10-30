import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { selectIsDirty, STITCH_HISTORY_LIMIT, useStitchEditorStore } from "@/store/stitchEditorStore";
import { openStitchEditor } from "../openStitchEditor";
import { commitStitchEdit, saveStitchEdit } from "../commitStitchEdit";
import { createClip, removeClip, splitClipAt, trimClip, type SourceKey } from "@/lib/stitch/timeline";
import { createAudioClip, legacyMusicClip, MUSIC_CLIP_ID, removeAudioClips } from "@/lib/stitch/audioClips";
import { musicAudio, type StitchDraft } from "@/lib/stitch/draft";
import type { StitchSequenceLayout, VideoStitchNodeData, VolumePoint, WorkflowEdge, WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const mirror = vi.fn().mockResolvedValue(null);
vi.mock("../mirrorStitchEdit", () => ({ mirrorStitchEditToEdits: (...args: unknown[]) => mirror(...args) }));

// Real stores: what Done does to the canvas, and how it undoes.

const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
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

function seed() {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
      node("stitch", "videoStitch", { clips: [], clipOrder: ["eA", "eB"], outputVideo: null, loopCount: 1, status: "idle" }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")],
  });
  openStitchEditor("stitch");
  editor().setDurations(DURATIONS);
}

const data = () => wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
const edgeIds = () => wf().edges.map((e) => e.id);
/** The curve or the mute set on every music clip. */
const withMusicAudio = (d: StitchDraft, patch: { curve?: VolumePoint[]; muted?: boolean }): StitchDraft => ({
  ...d,
  audioClips: d.audioClips.map((clip) => (clip.source.kind === "music" ? { ...clip, ...patch } : clip)),
});
const remove = (clipId: string) => editor().apply((d) => ({ ...d, timeline: removeClip(d.timeline, clipId).timeline }));

beforeEach(async () => {
  // An edge removal holds the store's delete checkpoint until the next task; let an earlier test's go
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  seed();
});
afterEach(() => {
  editor().close();
  wf().clearWorkflow();
});

describe("commitStitchEdit", () => {
  it("closes without writing when nothing changed, so a legacy node stays legacy", () => {
    const before = wf().nodes;
    expect(commitStitchEdit()).toBe("closed");
    expect(editor().isOpen).toBe(false);
    expect(wf().nodes).toBe(before);
    expect("timeline" in data()).toBe(false);
  });

  it("writes the timeline, the curve, the music mute, the loop count and the clip order", () => {
    editor().apply((d) => ({ ...d, timeline: trimClip(d.timeline, "clip:eA", DURATIONS, { inSec: 1 }), loopCount: 2 }));
    expect(commitStitchEdit()).toBe("written");
    expect(data()).toMatchObject({
      timeline: [expect.objectContaining({ id: "clip:eA", inSec: 1 }), expect.objectContaining({ id: "clip:eB" })],
      audioCurve: [],
      audioMuted: false,
      loopCount: 2,
      clipOrder: ["eA", "eB"],
    });
    expect(editor().isOpen).toBe(false);
  });

  it("disconnects a video whose clip was removed, and one Undo brings back the edge and the old data", () => {
    const before = data();
    remove("clip:eA");
    expect(commitStitchEdit()).toBe("written");
    expect(edgeIds()).toEqual(["eB"]);
    expect(data().timeline!.map((c) => c.id)).toEqual(["clip:eB"]);
    expect(data().clipOrder).toEqual(["eB"]);

    wf().undo();
    expect(edgeIds()).toEqual(["eA", "eB"]);
    expect(data()).toEqual(before);
  });

  it("keeps the edge when one piece of a split is removed", () => {
    const split = splitClipAt(editor().draft!.timeline, DURATIONS, 2, () => "clip:eA-right")!;
    editor().apply((d) => ({ ...d, timeline: split.timeline }));
    remove("clip:eA-right");
    commitStitchEdit();
    expect(edgeIds()).toEqual(["eA", "eB"]);
    expect(data().timeline!.map((c) => [c.id, c.outSec])).toEqual([
      ["clip:eA", 2],
      ["clip:eB", null],
    ]);
  });

  it("removing every clip disconnects every edge and writes an empty timeline, undone in one step", () => {
    remove("clip:eA");
    remove("clip:eB");
    expect(commitStitchEdit()).toBe("written");
    expect(edgeIds()).toEqual([]);
    expect(data().timeline).toEqual([]);

    wf().undo();
    expect(edgeIds()).toEqual(["eA", "eB"]);
    expect("timeline" in data()).toBe(false);
  });

  it("picks up a video connected while the editor was open", () => {
    editor().apply((d) => ({ ...d, loopCount: 3 }));
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-c", "generateVideo", { outputVideo: "blob:c" })],
      edges: [...wf().edges, edge("eC", "gen-c", "video-2")],
    });
    commitStitchEdit();
    expect(data().clipOrder).toEqual(["eA", "eB", "eC"]);
  });

  it("writes nothing when the canvas was replaced under it", () => {
    editor().apply((d) => ({ ...d, loopCount: 3 }));
    useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 });
    expect(commitStitchEdit()).toBe("gone");
    expect(data().loopCount).toBe(1);
    expect(editor().isOpen).toBe(false);
  });
});

describe("commitStitchEdit and the sequence layout", () => {
  const trimA = () =>
    editor().apply((d) => ({ ...d, timeline: trimClip(d.timeline, d.timeline[0].id, DURATIONS, { inSec: 1 }) }));
  /** Reopen the editor on the stitch node with these fields stored. */
  const reopenWith = (patch: Partial<VideoStitchNodeData>) => {
    editor().close();
    wf().updateNodeData("stitch", patch);
    openStitchEditor("stitch");
    editor().setDurations(DURATIONS);
  };

  it("writes a layout-only change", () => {
    editor().apply((d) => ({ ...d, sequenceLayout: { ...d.sequenceLayout, mode: "stacked" } }));
    expect(commitStitchEdit()).toBe("written");
    expect(data().sequenceLayout).toEqual({ mode: "stacked", overlapSec: 1, crossfade: true });
  });

  it("does not add the key for a change that leaves the layout as it reads", () => {
    trimA();
    expect(commitStitchEdit()).toBe("written");
    expect("sequenceLayout" in data()).toBe(false);
  });

  it("leaves a stored value from a newer build alone when Done did not change the layout", () => {
    const stored = { mode: "stacked", overlapSec: 1.04, crossfade: true, future: 1 } as unknown as StitchSequenceLayout;
    reopenWith({
      timeline: [createClip({ kind: "edge", edgeId: "eA" }, { id: "a" }), createClip({ kind: "edge", edgeId: "eB" }, { id: "b" })],
      sequenceLayout: stored,
    });
    expect(editor().draft!.sequenceLayout).toEqual({ mode: "stacked", overlapSec: 1, crossfade: true });
    trimA();
    expect(commitStitchEdit()).toBe("written");
    expect(data().sequenceLayout).toBe(stored);
  });

  it("lets one canvas Undo after a Done that switched to Stacked take the key away again", () => {
    const before = data();
    editor().apply((d) => ({ ...d, sequenceLayout: { ...d.sequenceLayout, mode: "stacked" } }));
    expect(commitStitchEdit()).toBe("written");
    expect(data().sequenceLayout?.mode).toBe("stacked");
    wf().undo();
    expect("sequenceLayout" in data()).toBe(false);
    expect(data()).toEqual(before);
  });

  it("writes the Track a legacy node with a hand-edited stacked key showed, on its first Done", () => {
    reopenWith({ sequenceLayout: { mode: "stacked", overlapSec: 2, crossfade: false } });
    expect(editor().draft!.sequenceLayout.mode).toBe("track");
    trimA();
    expect(commitStitchEdit()).toBe("written");
    expect(data().sequenceLayout).toEqual({ mode: "track", overlapSec: 2, crossfade: false });
  });
});

describe("saveStitchEdit", () => {
  const trimA = (inSec: number) =>
    editor().apply((d) => ({ ...d, timeline: trimClip(d.timeline, "clip:eA", DURATIONS, { inSec }) }));

  it("writes the draft as Done does and keeps the editor open, no longer dirty, with its undo history", () => {
    trimA(1);
    expect(saveStitchEdit()).toBe("saved");
    expect(data().timeline).toEqual([expect.objectContaining({ id: "clip:eA", inSec: 1 }), expect.objectContaining({ id: "clip:eB" })]);
    expect(editor().isOpen).toBe(true);
    expect(selectIsDirty(editor())).toBe(false);
    expect(editor().past).toHaveLength(1);
  });

  it("writes nothing when nothing changed since it opened or since the last save", () => {
    const before = wf().nodes;
    expect(saveStitchEdit()).toBe("unchanged");
    expect(wf().nodes).toBe(before);
    expect("timeline" in data()).toBe(false);
    trimA(1);
    saveStitchEdit();
    const saved = wf().nodes;
    expect(saveStitchEdit()).toBe("unchanged");
    expect(wf().nodes).toBe(saved);
  });

  it("counts later edits from the save: Done writes them, and undoing back to the save leaves nothing to write", () => {
    trimA(1);
    saveStitchEdit();
    trimA(2);
    expect(selectIsDirty(editor())).toBe(true);
    editor().undo();
    expect(selectIsDirty(editor())).toBe(false);
    editor().redo();
    expect(commitStitchEdit()).toBe("written");
    expect(data().timeline![0]).toMatchObject({ inSec: 2 });
  });

  it("closes, writing nothing, when the node is gone", () => {
    trimA(1);
    wf().onNodesChange([{ type: "remove", id: "stitch" }]);
    expect(saveStitchEdit()).toBe("gone");
    expect(editor().isOpen).toBe(false);
  });

  it("keeps a video connected while the dialog is open: the Save picks it up and the Done after it leaves its edge", () => {
    trimA(1);
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-c", "generateVideo", { outputVideo: "blob:c" })],
      edges: [...wf().edges, edge("eC", "gen-c", "video-2")],
    });
    expect(saveStitchEdit()).toBe("saved");
    expect(data().clipOrder).toEqual(["eA", "eB", "eC"]);
    trimA(2);
    expect(commitStitchEdit()).toBe("written");
    expect(edgeIds()).toEqual(["eA", "eB", "eC"]);
    expect(data().clipOrder).toEqual(["eA", "eB", "eC"]);
    expect(data().timeline![0]).toMatchObject({ inSec: 2 });
  });

  it("still disconnects a video removed after a Save that picked up another", () => {
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-c", "generateVideo", { outputVideo: "blob:c" })],
      edges: [...wf().edges, edge("eC", "gen-c", "video-2")],
    });
    trimA(1);
    saveStitchEdit();
    remove("clip:eB");
    commitStitchEdit();
    expect(edgeIds()).toEqual(["eA", "eC"]);
  });
});

describe("an edit project's session", () => {
  beforeEach(() => {
    editor().close();
    editor().openEdit({
      editId: "ed0123456789ab",
      draft: {
        timeline: [createClip({ kind: "asset", assetId: "a1" }, { id: "v1" })],
        audioClips: [],
        legacyAudio: { curve: [], muted: false },
        loopCount: 1,
        sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
      },
    });
    editor().apply((d) => ({ ...d, loopCount: 2 }));
  });

  it("Done writes nothing and leaves it open", () => {
    const nodes = wf().nodes;
    expect(commitStitchEdit()).toBe("closed");
    expect(editor().isOpen).toBe(true);
    expect(editor().editId).toBe("ed0123456789ab");
    expect(wf().nodes).toBe(nodes);
  });

  it("Save writes nothing and leaves it open and dirty", () => {
    const nodes = wf().nodes;
    expect(saveStitchEdit()).toBe("unchanged");
    expect(editor().isOpen).toBe(true);
    expect(selectIsDirty(editor())).toBe(true);
    expect(wf().nodes).toBe(nodes);
  });
});

describe("audio clips on Done", () => {
  const connectMusic = () => {
    editor().close();
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-m", "generateAudio", {})],
      edges: [
        ...wf().edges,
        { id: "eM", source: "gen-m", target: "stitch", sourceHandle: "audio", targetHandle: "audio" },
      ],
    });
    openStitchEditor("stitch");
    editor().setDurations(DURATIONS);
  };
  const moveMusic = (startSec: number) =>
    editor().apply((d) => ({
      ...d,
      audioClips: d.audioClips.map((clip) => (clip.source.kind === "music" ? { ...clip, startSec } : clip)),
    }));

  it("adds no key for an edit possible before audio clips: a trim, the curve, the mute, the loop", () => {
    connectMusic();
    expect(editor().draft!.audioClips.map((c) => c.id)).toEqual([MUSIC_CLIP_ID]);
    editor().apply((d) => ({
      ...withMusicAudio(d, { curve: [{ t: 1, gain: 0.5 }], muted: true }),
      timeline: trimClip(d.timeline, "clip:eA", DURATIONS, { inSec: 1 }),
      loopCount: 2,
    }));
    expect(commitStitchEdit()).toBe("written");
    expect("audioClips" in data()).toBe(false);
    expect(data()).toMatchObject({ audioCurve: [{ t: 1, gain: 0.5 }], audioMuted: true, loopCount: 2 });
  });

  it("writes the clips with the older-build copy once the music moves, and drops them when it moves back", () => {
    connectMusic();
    editor().apply((d) => withMusicAudio(d, { curve: [{ t: 1, gain: 0.5 }] }));
    moveMusic(1);
    commitStitchEdit();
    expect(data().audioClips).toEqual([
      createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, startSec: 1, curve: [{ t: 1, gain: 0.5 }] }),
    ]);
    expect(data()).toMatchObject({ audioCurve: [], audioMuted: true });

    openStitchEditor("stitch");
    editor().setDurations(DURATIONS);
    expect(musicAudio(editor().draft!).curve).toEqual([{ t: 1, gain: 0.5 }]);
    moveMusic(0);
    commitStitchEdit();
    expect(data().audioClips).toBeUndefined();
    expect(data()).toMatchObject({ audioCurve: [{ t: 1, gain: 0.5 }], audioMuted: false });
  });

  const TONE = "atone00000001";
  const addTone = () =>
    editor().apply((d) => ({
      ...d,
      audioClips: [...d.audioClips, createAudioClip({ kind: "asset", assetId: TONE }, { id: "tone", row: 1, startSec: 2 })],
    }));
  const removeAudio = (...ids: string[]) =>
    editor().apply((d) => ({ ...d, audioClips: removeAudioClips(d.audioClips, new Set(ids)).clips }));
  const trimA = () => editor().apply((d) => ({ ...d, timeline: trimClip(d.timeline, "clip:eA", DURATIONS, { inSec: 1 }) }));
  /** A node that stores audio clips: the music moved and a library clip under it. */
  const storeClips = () => {
    connectMusic();
    moveMusic(1);
    addTone();
    commitStitchEdit();
    expect(data().audioClips!.map((c) => c.id)).toEqual([MUSIC_CLIP_ID, "tone"]);
    openStitchEditor("stitch");
    editor().setDurations(DURATIONS);
  };
  const audioIds = () => data().audioClips?.map((c) => c.id);

  it("disconnects the music with the data write when every music clip was removed, undone in one step", () => {
    connectMusic();
    const before = data();
    removeAudio(MUSIC_CLIP_ID);
    expect(commitStitchEdit()).toBe("written");
    expect(edgeIds()).toEqual(["eA", "eB"]);
    // Legacy-shaped again: no key, and the re-read added no music clip back
    expect("audioClips" in data()).toBe(false);
    openStitchEditor("stitch");
    expect(editor().draft!.audioClips).toEqual([]);
    editor().close();

    wf().undo();
    expect(edgeIds()).toEqual(["eA", "eB", "eM"]);
    expect(data()).toEqual(before);
  });

  it("removing the music clip and keeping a library clip disconnects the music and writes no music clip", () => {
    connectMusic();
    addTone();
    removeAudio(MUSIC_CLIP_ID);
    commitStitchEdit();
    expect(edgeIds()).not.toContain("eM");
    expect(audioIds()).toEqual(["tone"]);
    expect(data().audioClips![0]).toMatchObject({ row: 0, startSec: 2 });
  });

  it("drops the music clips when the music was disconnected on the canvas while the editor was open", () => {
    storeClips();
    wf().onEdgesChange([{ type: "remove", id: "eM" }]);
    trimA();
    expect(commitStitchEdit()).toBe("written");
    expect(audioIds()).toEqual(["tone"]);
    expect(data().timeline![0]).toMatchObject({ inSec: 1 });
  });

  it("gives music connected after that disconnect one fresh clip, and leaves its edge", () => {
    storeClips();
    wf().onEdgesChange([{ type: "remove", id: "eM" }]);
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-m2", "generateAudio", {})],
      edges: [...wf().edges, { id: "eM2", source: "gen-m2", target: "stitch", sourceHandle: "audio", targetHandle: "audio" }],
    });
    trimA();
    commitStitchEdit();
    expect(edgeIds()).toContain("eM2");
    // The fresh music clip is whole and at 0:00; the tone moves under it
    expect(data().audioClips).toEqual([
      createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }),
      expect.objectContaining({ id: "tone", row: 1 }),
    ]);
  });

  it("writes nothing when the only change is the music going away on the canvas", () => {
    storeClips();
    wf().onEdgesChange([{ type: "remove", id: "eM" }]);
    const before = wf().nodes;
    expect(commitStitchEdit()).toBe("closed");
    expect(wf().nodes).toBe(before);
    expect(audioIds()).toEqual(["tone"]);
  });

  it("disconnects the music whose source is dimmed when its stored clip is removed", () => {
    storeClips();
    editor().close();
    useWorkflowStore.setState({ dimmedNodeIds: new Set(["gen-m"]) });
    openStitchEditor("stitch");
    // A stored music clip is kept while its source is dimmed
    expect(editor().draft!.audioClips.map((c) => c.id)).toEqual([MUSIC_CLIP_ID, "tone"]);
    expect(editor().musicEdgeIdAtOpen).toBe("eM");
    removeAudio(MUSIC_CLIP_ID);
    commitStitchEdit();
    expect(edgeIds()).not.toContain("eM");
    expect(audioIds()).toEqual(["tone"]);
  });

  it("writes the older-build copy beside the clips: an untouched music clip's curve and mute, else muted", () => {
    connectMusic();
    editor().apply((d) => withMusicAudio(d, { curve: [{ t: 2, gain: 0.25 }], muted: true }));
    addTone();
    commitStitchEdit();
    expect(data()).toMatchObject({ audioCurve: [{ t: 2, gain: 0.25 }], audioMuted: true });
    expect(audioIds()).toEqual([MUSIC_CLIP_ID, "tone"]);
  });

  it("after a Save, Done checks the music edge the Save saw", () => {
    connectMusic();
    expect(editor().musicEdgeIdAtOpen).toBe("eM");
    addTone();
    // The music is swapped on the canvas, then Save: the old edge is gone, so the draft's music clip is dropped
    wf().onEdgesChange([{ type: "remove", id: "eM" }]);
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-m2", "generateAudio", {})],
      edges: [...wf().edges, { id: "eM2", source: "gen-m2", target: "stitch", sourceHandle: "audio", targetHandle: "audio" }],
    });
    moveMusic(3);
    expect(saveStitchEdit()).toBe("saved");
    // The draft still holds the old music clip, so the gone edge stays the one to compare against
    expect(editor().musicEdgeIdAtOpen).toBe("eM");
    expect(data().audioClips![0]).toMatchObject({ source: { kind: "music" }, startSec: 0 });
    // At Done the old music clip is dropped again: eM2 keeps its fresh clip and is not disconnected
    trimA();
    commitStitchEdit();
    expect(edgeIds()).toContain("eM2");
    expect(data().audioClips![0]).toMatchObject({ source: { kind: "music" }, startSec: 0 });
  });

  it("after music is disconnected and saved, Done writes no music clip back, and new music starts whole", () => {
    storeClips();
    wf().onEdgesChange([{ type: "remove", id: "eM" }]);
    trimA();
    expect(saveStitchEdit()).toBe("saved");
    expect(audioIds()).toEqual(["tone"]);
    editor().apply((d) => ({ ...d, loopCount: 2 }));
    expect(commitStitchEdit()).toBe("written");
    expect(audioIds()).toEqual(["tone"]);
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-m2", "generateAudio", {})],
      edges: [...wf().edges, { id: "eM2", source: "gen-m2", target: "stitch", sourceHandle: "audio", targetHandle: "audio" }],
    });
    openStitchEditor("stitch");
    expect(editor().draft!.audioClips[0]).toEqual(createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }));
  });

  it("is clean after a Save of a legacy node's edited music curve and mute", () => {
    connectMusic();
    editor().apply((d) => withMusicAudio(d, { curve: [{ t: 1, gain: 0.5 }] }));
    editor().apply((d) => withMusicAudio(d, { muted: true }));
    expect(saveStitchEdit()).toBe("saved");
    expect("audioClips" in data()).toBe(false);
    expect(data()).toMatchObject({ audioCurve: [{ t: 1, gain: 0.5 }], audioMuted: true });
    expect(selectIsDirty(editor())).toBe(false);
    const before = wf().nodes;
    expect(saveStitchEdit()).toBe("unchanged");
    expect(commitStitchEdit()).toBe("closed");
    expect(wf().nodes).toBe(before);
  });

  it("disconnects the music for a music clip removed more edits ago than the history keeps", () => {
    connectMusic();
    addTone();
    removeAudio(MUSIC_CLIP_ID);
    for (let i = 1; i <= STITCH_HISTORY_LIMIT + 1; i++) editor().apply((d) => ({ ...d, loopCount: ((i % 3) + 1) as StitchDraft["loopCount"] }));
    expect(editor().past.some((d) => d.audioClips.some((c) => c.source.kind === "music"))).toBe(false);
    commitStitchEdit();
    expect(edgeIds()).not.toContain("eM");
    expect(audioIds()).toEqual(["tone"]);
  });

  it("keeps music a Save picked up that the draft never held", () => {
    // Opened without music; music connected while the editor is open, then Save and Done
    expect(editor().musicEdgeIdAtOpen).toBeNull();
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-m", "generateAudio", {})],
      edges: [...wf().edges, { id: "eM", source: "gen-m", target: "stitch", sourceHandle: "audio", targetHandle: "audio" }],
    });
    trimA();
    saveStitchEdit();
    expect(editor().initial!.audioClips).toEqual([legacyMusicClip([], false)]);
    editor().apply((d) => ({ ...d, loopCount: 2 }));
    commitStitchEdit();
    expect(edgeIds()).toContain("eM");
  });
});

describe("the Edits mirror", () => {
  beforeEach(() => mirror.mockClear());

  it("is not written when nothing changed", () => {
    expect(commitStitchEdit()).toBe("closed");
    expect(mirror).not.toHaveBeenCalled();
  });

  it("gets what Done wrote to the node, with the session's lengths, after the editor closes", () => {
    remove("clip:eA");
    expect(commitStitchEdit()).toBe("written");
    expect(mirror).toHaveBeenCalledTimes(1);
    const input = mirror.mock.calls[0][0];
    expect(input.nodeId).toBe("stitch");
    expect(input.draft.timeline.map((c: { source: unknown }) => c.source)).toEqual([{ kind: "edge", edgeId: "eB" }]);
    expect(input.durations).toBe(DURATIONS);
    expect(editor().isOpen).toBe(false);
  });

  it("gets what Save wrote, and again on the next Save", () => {
    remove("clip:eA");
    expect(saveStitchEdit()).toBe("saved");
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(saveStitchEdit()).toBe("unchanged");
    expect(mirror).toHaveBeenCalledTimes(1);
    editor().apply((d) => ({ ...d, loopCount: 2 }));
    expect(saveStitchEdit()).toBe("saved");
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(mirror.mock.calls[1][0].draft.loopCount).toBe(2);
  });
});
