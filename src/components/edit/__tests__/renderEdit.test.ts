import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEditProjectForTests, editWritesIdle, useEditProjectStore } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useAssetStore } from "@/store/assetStore";
import { stitchEngineOptions, stitchRecordParameters, type GatheredStitch } from "@/store/execution/stitchInputs";
import { createClip } from "@/lib/stitch/timeline";
import type { EditDocument } from "@/lib/edits/types";
import type { AssetRunContext, AssetView, RecordAssetInput } from "@/lib/assets/types";
import type { StitchProgress } from "@/hooks/useStitchVideos";
import { renderEdit, setRenderCanvasAdder, stopEditRender } from "../renderEdit";

const m = vi.hoisted(() => ({
  fetchEdit: vi.fn(),
  patchEdit: vi.fn(),
  fetchEditList: vi.fn(),
  gatherDraftInputs: vi.fn(),
  stitchVideosAsync: vi.fn(),
  recordAsset: vi.fn(),
  beginRun: vi.fn(),
  isRecorderEnabled: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@/lib/edits/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edits/client")>()),
  fetchEdit: m.fetchEdit,
  patchEdit: m.patchEdit,
  fetchEditList: m.fetchEditList,
}));
vi.mock("@/store/execution/stitchInputs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/execution/stitchInputs")>()),
  gatherDraftInputs: m.gatherDraftInputs,
}));
vi.mock("@/hooks/useStitchVideos", () => ({ stitchVideosAsync: m.stitchVideosAsync }));
vi.mock("@/lib/assets/client/recorder", () => ({
  recordAsset: m.recordAsset,
  beginRun: m.beginRun,
  isRecorderEnabled: m.isRecorderEnabled,
}));
vi.mock("@/lib/stitch/assetInfo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stitch/assetInfo")>()),
  requestAssetInfo: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: m.show }) } }));

const ID = "ed0000000000a1";
const OTHER = "ed0000000000b2";
const editor = () => useStitchEditorStore.getState();
const doc = (id = ID): EditDocument => ({
  kind: "node-banana-edit",
  version: 1,
  id,
  name: id === ID ? "Trip" : "Other",
  createdAt: 1,
  updatedAt: 2,
  sequence: {
    timeline: [createClip({ kind: "asset", assetId: "aclipaaaaaaaa1" }, { id: "v1" })],
    audioClips: [],
    loopCount: 2,
    sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: false },
  },
  media: ["aclipaaaaaaaa1"],
  assets: {},
  renders: [],
  summary: { clipCount: 1, audioClipCount: 0, durationSec: 0, posterAssetId: "aclipaaaaaaaa1" },
});

const gathered: GatheredStitch = {
  clips: [{ blob: new Blob(["v"]), inSec: 0, outSec: null, muted: false, volume: 1, source: "asset:aclipaaaaaaaa1" }],
  music: null,
  audioClips: null,
  loopCount: 2,
  clipCount: 1,
  stack: { overlapSec: 1, crossfade: false },
  placed: null,
};
const rendered = new Blob(["mp4"], { type: "video/mp4" });
const asset = { id: "arender000001", filename: "Trip.mp4", durationSec: 12.4, kind: "video" } as AssetView;

beforeEach(async () => {
  vi.clearAllMocks();
  __resetEditProjectForTests();
  editor().close();
  setRenderCanvasAdder(null);
  useAssetStore.setState({ appView: "edit", detailId: null, detailAsset: null });
  m.fetchEditList.mockResolvedValue({ edits: [], problems: [], folder: "/lib/Edits" });
  m.isRecorderEnabled.mockReturnValue(true);
  m.gatherDraftInputs.mockResolvedValue(gathered);
  m.stitchVideosAsync.mockImplementation(async (_c, _m, onProgress: (p: StitchProgress) => void) => {
    onProgress({ status: "processing", message: "", progress: 40 });
    return rendered;
  });
  m.recordAsset.mockImplementation(() => ({ assetId: asset.id, done: Promise.resolve({ asset }), held: new Promise(() => {}) }));
  m.patchEdit.mockImplementation(async (id: string, request: { render: unknown }) => ({
    document: { ...doc(id), renders: [request.render] },
    previousUpdatedAt: 2,
  }));
  m.fetchEdit.mockResolvedValue(doc());
  await useEditProjectStore.getState().openEditById(ID);
});

afterEach(async () => {
  await editWritesIdle();
  editor().close();
});

describe("renderEdit", () => {
  it("encodes the draft at the press with the node's options and records it under the edit, not a workflow", async () => {
    const draft = editor().draft;
    expect(await renderEdit()).toBe("rendered");
    expect(m.gatherDraftInputs).toHaveBeenCalledWith(draft, expect.any(AbortSignal));
    const [clips, music, , signal, options] = m.stitchVideosAsync.mock.calls[0];
    expect(clips).toBe(gathered.clips);
    expect(music).toBeNull();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(options).toEqual(stitchEngineOptions(gathered));

    const [input, run] = m.recordAsset.mock.calls[0] as [RecordAssetInput, AssetRunContext];
    expect(run).toMatchObject({ workflowId: ID, workflowName: "Trip", projectDir: null });
    expect(input).toMatchObject({
      kind: "video",
      origin: "edited",
      media: rendered,
      mime: "video/mp4",
      parameters: stitchRecordParameters(gathered),
      producer: { nodeId: ID, nodeType: "editProject", nodeTitle: "Trip", operation: "stitch" },
    });
    // No workflow snapshot: there is no workflow
    expect(m.beginRun).not.toHaveBeenCalled();
  });

  it("adds the render to the edit's file and reports progress, then idles", async () => {
    const seen: number[] = [];
    const stop = useEditProjectStore.subscribe((s) => seen.push(s.render.progress));
    await renderEdit();
    stop();
    await editWritesIdle();
    expect(seen).toContain(40);
    expect(m.patchEdit).toHaveBeenCalledWith(ID, {
      op: "addRender",
      render: { assetId: asset.id, renderedAt: expect.any(Number), durationSec: 12.4 },
    });
    expect(useEditProjectStore.getState().open?.renders.map((r) => r.assetId)).toEqual([asset.id]);
    expect(useEditProjectStore.getState().render).toMatchObject({ state: "idle", editId: ID });
  });

  it("adds the render to the edit it was made from, even when another is open by then", async () => {
    let finish!: (blob: Blob) => void;
    m.stitchVideosAsync.mockReturnValueOnce(new Promise<Blob>((resolve) => (finish = resolve)));
    const rendering = renderEdit();
    await vi.waitFor(() => expect(m.stitchVideosAsync).toHaveBeenCalled());
    m.fetchEdit.mockResolvedValueOnce(doc(OTHER));
    await useEditProjectStore.getState().openEditById(OTHER);
    finish(rendered);
    await rendering;
    await editWritesIdle();
    expect(m.patchEdit).toHaveBeenCalledWith(ID, expect.objectContaining({ op: "addRender" }));
    expect(useEditProjectStore.getState().open).toMatchObject({ id: OTHER, renders: [] });
  });

  it("offers Show in Assets and Add to canvas, in a neutral notice", async () => {
    const add = vi.fn();
    setRenderCanvasAdder(add);
    await renderEdit();
    const [text, type, , , actions] = m.show.mock.calls[0];
    expect(text).toBe("Rendered “Trip” · 0:12");
    expect(type).toBe("info");
    expect(actions.map((a: { label: string }) => a.label)).toEqual(["Show in Assets", "Add to canvas"]);

    actions[1].onClick();
    expect(add).toHaveBeenCalledWith({ src: `/api/assets/${asset.id}/file`, filename: "Trip.mp4" });
    const [addedText, addedType, , , addedActions] = m.show.mock.calls[1];
    expect(addedText).toBe("Video added to the canvas");
    expect(addedType).toBe("info");
    expect(addedActions.map((a: { label: string }) => a.label)).toEqual(["Go to canvas"]);
    addedActions[0].onClick();
    expect(useAssetStore.getState().appView).toBe("canvas");

    actions[0].onClick();
    expect(useAssetStore.getState().appView).toBe("assets");
    expect(useAssetStore.getState().detailId).toBe(asset.id);
    expect(useAssetStore.getState().detailAsset).toBe(asset);
  });

  it("closes a node's editor dialog before Show in Assets switches the view under it", async () => {
    await renderEdit();
    const showInAssets = () => m.show.mock.calls[0][4][0].onClick();
    const nodeDraft = { ...doc().sequence, legacyAudio: { curve: [], muted: false } };
    const openDialog = () => {
      editor().close();
      editor().open({ nodeId: "n1", draft: nodeDraft, canvasGeneration: 1 });
      useAssetStore.setState({ appView: "canvas", detailId: null, detailAsset: null });
    };

    // Nothing changed: it closes as Cancel does, and Assets shows
    openDialog();
    showInAssets();
    expect(editor().isOpen).toBe(false);
    expect(useAssetStore.getState()).toMatchObject({ appView: "assets", detailId: asset.id });

    // Changed: the discard sheet asks; Keep editing stays, and a later close switches nothing
    openDialog();
    editor().apply((d) => ({ ...d, loopCount: 3 }));
    showInAssets();
    expect(editor().discardOpen).toBe(true);
    expect(useAssetStore.getState().appView).toBe("canvas");
    editor().setDiscardOpen(false);
    editor().close();
    expect(useAssetStore.getState().appView).toBe("canvas");

    // Changed, then Discard: Assets shows once the dialog has closed
    openDialog();
    editor().apply((d) => ({ ...d, loopCount: 3 }));
    showInAssets();
    expect(useAssetStore.getState().appView).toBe("canvas");
    editor().close();
    expect(useAssetStore.getState()).toMatchObject({ appView: "assets", detailId: asset.id });
  });

  it("offers no Add to canvas when the view has not handed in the canvas", async () => {
    await renderEdit();
    expect(m.show.mock.calls[0][4].map((a: { label: string }) => a.label)).toEqual(["Show in Assets"]);
  });

  it("Stop aborts the encode: nothing recorded, no toast, back to idle", async () => {
    m.stitchVideosAsync.mockImplementationOnce(
      (_c, _m, _p, signal: AbortSignal) =>
        new Promise<Blob>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const rendering = renderEdit();
    await vi.waitFor(() => expect(m.stitchVideosAsync).toHaveBeenCalled());
    expect(useEditProjectStore.getState().render.state).toBe("rendering");
    stopEditRender();
    expect(await rendering).toBe("stopped");
    expect(m.recordAsset).not.toHaveBeenCalled();
    expect(m.show).not.toHaveBeenCalled();
    expect(useEditProjectStore.getState().render.state).toBe("idle");
  });

  it("runs one render at a time", async () => {
    let finish!: (blob: Blob) => void;
    m.stitchVideosAsync.mockReturnValueOnce(new Promise<Blob>((resolve) => (finish = resolve)));
    const first = renderEdit();
    expect(await renderEdit()).toBe("skipped");
    await vi.waitFor(() => expect(m.stitchVideosAsync).toHaveBeenCalled());
    finish(rendered);
    expect(await first).toBe("rendered");
  });

  it("fails with the reason in the state and a toast", async () => {
    m.gatherDraftInputs.mockRejectedValueOnce(new Error("Clip 1's library video is no longer in the library"));
    expect(await renderEdit()).toBe("failed");
    expect(useEditProjectStore.getState().render).toMatchObject({
      state: "failed",
      message: "Clip 1's library video is no longer in the library",
    });
    expect(m.show).toHaveBeenCalledWith("Couldn't render “Trip”", "error", false, "Clip 1's library video is no longer in the library");
  });

  it("fails before encoding when the library is off", async () => {
    m.isRecorderEnabled.mockReturnValue(false);
    expect(await renderEdit()).toBe("failed");
    expect(m.stitchVideosAsync).not.toHaveBeenCalled();
  });

  it("fails when the library could not keep the video", async () => {
    m.recordAsset.mockReturnValueOnce({ assetId: "x", done: Promise.resolve(null), held: new Promise(() => {}) });
    expect(await renderEdit()).toBe("failed");
    expect(m.patchEdit).not.toHaveBeenCalled();
  });
});
