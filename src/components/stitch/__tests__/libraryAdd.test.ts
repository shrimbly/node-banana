import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { __resetEditProjectForTests, useEditProjectStore } from "@/store/editProjectStore";
import { __resetAssetInfoForTests, getAssetInfo } from "@/lib/stitch/assetInfo";
import { WAITING_FOR_CLIPS, type LibraryDropTarget } from "@/lib/stitch/libraryInsert";
import { createClip, isPlaced, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchDraft } from "@/lib/stitch/draft";
import type { AssetView } from "@/lib/assets/types";
import { addLibraryClips, addLibraryItemAt, libraryAddBlockedReason, openLibraryPicker } from "../editorActions";
import { libraryDrop } from "../timeline/libraryDrop";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const editor = () => useStitchEditorStore.getState();
const view = (id: string, kind: "video" | "audio", durationSec: number): AssetView =>
  ({ id, kind, durationSec, filename: `${id}.${kind === "video" ? "mp4" : "m4a"}`, workflow: { projectPath: null } }) as unknown as AssetView;
const DURATIONS = new Map<SourceKey, number>([
  ["asset:aclipaaaaaaaa1", 4],
  ["asset:aclipaaaaaaaa2", 6],
]);

function openEdit(overrides: Partial<StitchDraft> = {}) {
  editor().openEdit({
    editId: "ed0000000000a1",
    draft: {
      timeline: [
        createClip({ kind: "asset", assetId: "aclipaaaaaaaa1" }, { id: "v1" }),
        createClip({ kind: "asset", assetId: "aclipaaaaaaaa2" }, { id: "v2" }),
      ],
      audioClips: [],
      legacyAudio: { curve: [], muted: false },
      loopCount: 1,
      sequenceLayout: { mode: "track", overlapSec: 1, crossfade: true },
      ...overrides,
    },
  });
  editor().setDurations(DURATIONS);
}

beforeEach(() => {
  editor().close();
  __resetEditProjectForTests();
  __resetAssetInfoForTests();
});

describe("openLibraryPicker", () => {
  it("opens the picker over a paused preview in the Edit video view, for the kind asked (Add media: both)", () => {
    openEdit();
    useEditProjectStore.getState().setPaneOpen(false);
    editor().setPlaying(true);
    openLibraryPicker("audio");
    expect(editor().pickerOpen).toBe("audio");
    expect(editor().playing).toBe(false);
    // The pane is left as it was
    expect(useEditProjectStore.getState().pane.open).toBe(false);
    openLibraryPicker("all");
    expect(editor().pickerOpen).toBe("all");
  });

  it("opens it in the dialog as before", () => {
    editor().open({
      nodeId: "s1",
      draft: { timeline: [], audioClips: [], legacyAudio: { curve: [], muted: false }, loopCount: 1, sequenceLayout: { mode: "track", overlapSec: 1, crossfade: true } },
      canvasGeneration: 1,
    });
    openLibraryPicker("video");
    expect(editor().pickerOpen).toBe("video");
  });

  it("does nothing with no editor open", () => {
    openLibraryPicker("video");
    expect(editor().pickerOpen).toBe(false);
  });
});

describe("addLibraryItemAt", () => {
  it("adds a clicked video after the clip under the playhead, as one undo step, selected, the playhead at its start", () => {
    openEdit();
    editor().setPlayhead(1);
    const id = addLibraryItemAt(view("anewvideo00001", "video", 3));
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["v1", id, "v2"]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toEqual({ kind: "clip", clipId: id });
    expect(editor().playhead).toBe(4);
    // Labelled at once
    expect(getAssetInfo("anewvideo00001")?.filename).toBe("anewvideo00001.mp4");
    editor().undo();
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["v1", "v2"]);
  });

  it("keeps clicks in a row in the order clicked, on an empty edit and after a clip", () => {
    const sources = (ids: string[]) =>
      editor().draft!.timeline.map((c) => (c.source.kind === "asset" ? c.source.assetId : c.id)).filter((a) => ids.includes(a));
    const clicked = ["anewvideo0000a", "anewvideo0000b", "anewvideo0000c"];
    // Measured, as the editor measures each new clip before the next click
    const measured = new Map<SourceKey, number>([...DURATIONS, ...clicked.map((id) => [`asset:${id}` as SourceKey, 3] as const)]);

    openEdit({ timeline: [] });
    editor().setDurations(measured);
    for (const id of clicked) addLibraryItemAt(view(id, "video", 3));
    expect(sources(clicked)).toEqual(clicked);
    expect(editor().past).toHaveLength(3);

    openEdit();
    editor().setDurations(measured);
    editor().setPlayhead(1);
    for (const id of clicked) addLibraryItemAt(view(id, "video", 3));
    expect(editor().draft!.timeline.map((c) => (c.source.kind === "asset" ? c.source.assetId : c.id))).toEqual([
      "aclipaaaaaaaa1",
      ...clicked,
      "aclipaaaaaaaa2",
    ]);
  });

  it("adds at a drop target: a new Stacked row there, the others pinned where they were", () => {
    openEdit({ sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    const target: LibraryDropTarget = { lane: "clips", mode: "stacked", startSec: 3, row: 2 };
    const id = addLibraryItemAt(view("anewvideo00001", "video", 3), target);
    expect(editor().draft!.timeline.map((c) => [c.id, c.startSec])).toEqual([
      ["v1", 0],
      ["v2", 3],
      [id, 3],
    ]);
    expect(editor().playhead).toBe(3);
  });

  it("waits while a clip is loading and the add would pin, and adds once it has loaded", () => {
    openEdit({ sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    editor().setPlayhead(2);
    editor().setClipsLoading(new Set<SourceKey>(["asset:aclipaaaaaaaa2"]));
    const item = view("anewvideo00001", "video", 3);
    expect(libraryAddBlockedReason({ assetId: item.id, kind: "video", durationSec: 3 })).toBe(WAITING_FOR_CLIPS);
    expect(addLibraryItemAt(item)).toBeNull();
    expect(editor().past).toHaveLength(0);
    expect(isPlaced(editor().draft!.timeline)).toBe(false);
    // Audio never waits
    expect(libraryAddBlockedReason({ assetId: "asound0000001", kind: "audio", durationSec: 2 })).toBeNull();

    editor().setClipsLoading(new Set());
    const id = addLibraryItemAt(item);
    expect(editor().draft!.timeline.map((c) => [c.id, c.startSec])).toEqual([
      ["v1", 0],
      ["v2", 3],
      [id, 2],
    ]);
  });

  it("pins a clip not measured yet with its record's length, not 0", () => {
    openEdit({ sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    editor().setDurations(new Map());
    useEditProjectStore.setState({
      open: {
        id: "ed0000000000a1",
        name: "Trip",
        createdAt: 1,
        baseUpdatedAt: 2,
        renders: [],
        assets: { aclipaaaaaaaa1: { name: "a.mp4", kind: "video", project: null, durationSec: 4 } },
      },
    });
    addLibraryItemAt(view("anewvideo00001", "video", 3), { lane: "clips", mode: "stacked", startSec: 0, row: 2 });
    // v1's 4 s from the edit's snapshot (v2, unknown, counts 0 and overlaps nothing): v2 is pinned at 4, not 0
    expect(editor().draft!.timeline.map((c) => c.startSec)).toEqual([0, 4, 0]);
  });

  it("adds a sound at the playhead on the first row with room, selected", () => {
    openEdit();
    editor().setPlayhead(2);
    const id = addLibraryItemAt(view("asound0000001", "audio", 2));
    const clip = editor().draft!.audioClips.find((c) => c.id === id);
    expect(clip).toMatchObject({ row: 0, startSec: 2, source: { kind: "asset", assetId: "asound0000001" } });
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: id });
    expect(editor().past).toHaveLength(1);
  });

  it("adds nothing for an image or with no session", () => {
    openEdit();
    expect(addLibraryItemAt({ ...view("aimage0000001", "video", 1), kind: "image" } as AssetView)).toBeNull();
    editor().close();
    expect(addLibraryItemAt(view("anewvideo00001", "video", 3))).toBeNull();
  });
});

describe("addLibraryClips (the dialog's Add media)", () => {
  const sources = () => editor().draft!.timeline.map((c) => (c.source.kind === "asset" ? c.source.assetId : c.id));

  it("puts each video after the last clip and each sound on a new row at the playhead, as one undo step", () => {
    openEdit();
    editor().setPlayhead(1.5);
    editor().setPickerOpen("all");
    addLibraryClips([view("asound0000001", "audio", 2), view("anewvideo00001", "video", 3), view("asound0000002", "audio", 4)]);
    const draft = editor().draft!;
    expect(sources()).toEqual(["aclipaaaaaaaa1", "aclipaaaaaaaa2", "anewvideo00001"]);
    expect(draft.audioClips.map((c) => [c.source, c.row, c.startSec])).toEqual([
      [{ kind: "asset", assetId: "asound0000001" }, 0, 1.5],
      [{ kind: "asset", assetId: "asound0000002" }, 1, 1.5],
    ]);
    expect(editor().past).toHaveLength(1);
    // The new video is selected, the playhead at its start (after the 4 s and 6 s clips)
    expect(editor().selection).toEqual({ kind: "clip", clipId: draft.timeline[2].id });
    expect(editor().playhead).toBe(10);
    expect(editor().pickerOpen).toBe(false);
    expect(getAssetInfo("asound0000002")?.filename).toBe("asound0000002.m4a");
    editor().undo();
    expect(sources()).toEqual(["aclipaaaaaaaa1", "aclipaaaaaaaa2"]);
    expect(editor().draft!.audioClips).toEqual([]);
  });

  it("with sounds alone selects the first and leaves the playhead; with nothing does nothing", () => {
    openEdit();
    editor().setPlayhead(2);
    addLibraryClips([]);
    expect(editor().past).toHaveLength(0);
    addLibraryClips([view("asound0000001", "audio", 2)]);
    const clip = editor().draft!.audioClips[0];
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: clip.id });
    expect(editor().playhead).toBe(2);
    expect(sources()).toEqual(["aclipaaaaaaaa1", "aclipaaaaaaaa2"]);
    expect(editor().past).toHaveLength(1);
  });
});

describe("libraryDrop", () => {
  it("asks the registered Timeline's probe, and tells subscribers of a new target", () => {
    const item = { assetId: "anewvideo00001", kind: "video" as const, durationSec: 3 };
    expect(libraryDrop.probe(10, 10, item)).toBeNull();
    const target: LibraryDropTarget = { lane: "clips", mode: "track", index: 1 };
    const unregister = libraryDrop.register(() => target);
    expect(libraryDrop.probe(10, 10, item)).toBe(target);
    const heard = vi.fn();
    const unsubscribe = libraryDrop.subscribe(heard);
    libraryDrop.set(target);
    libraryDrop.set(target);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(libraryDrop.get()).toBe(target);
    libraryDrop.set(null);
    expect(heard).toHaveBeenCalledTimes(2);
    unsubscribe();
    // An older unregister leaves a newer probe alone
    const newer = libraryDrop.register(() => null);
    unregister();
    expect(libraryDrop.probe(0, 0, item)).toBeNull();
    newer();
  });
});
