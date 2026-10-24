import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEditProjectForTests, editWritesIdle, useEditProjectStore } from "@/store/editProjectStore";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { AUTOSAVE_BACKOFF_MS, AUTOSAVE_RETRY_MS, AUTOSAVE_SETTLE_MS, type AutoSave } from "@/store/utils/autoSave";
import { createEditAutoSave, startEditAutoSave } from "@/store/utils/editAutoSave";
import { EditApiError } from "@/lib/edits/client";
import { createClip } from "@/lib/stitch/timeline";
import type { EditDocument, SaveEditRequest } from "@/lib/edits/types";
import type { AssetView } from "@/lib/assets/types";

const api = vi.hoisted(() => ({ fetchEdit: vi.fn(), saveEdit: vi.fn(), fetchEditList: vi.fn(), show: vi.fn() }));
vi.mock("@/lib/edits/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edits/client")>()),
  fetchEdit: api.fetchEdit,
  saveEdit: api.saveEdit,
  fetchEditList: api.fetchEditList,
}));
vi.mock("@/lib/stitch/assetInfo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stitch/assetInfo")>()),
  requestAssetInfo: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: api.show }) } }));

const ID = "ed0000000000a1";
const editor = () => useStitchEditorStore.getState();
const document: EditDocument = {
  kind: "node-banana-edit",
  version: 1,
  id: ID,
  name: "Trip",
  createdAt: 1,
  updatedAt: 2,
  sequence: {
    timeline: [createClip({ kind: "asset", assetId: "aclipaaaaaaaa1" }, { id: "v1" })],
    audioClips: [],
    loopCount: 1,
    sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
  },
  media: ["aclipaaaaaaaa1"],
  assets: {},
  renders: [],
  summary: { clipCount: 1, audioClipCount: 0, durationSec: 0, posterAssetId: "aclipaaaaaaaa1" },
};
let updatedAt = 2;
const answer = async (_id: string, request: SaveEditRequest): Promise<EditDocument> => ({
  ...document,
  updatedAt: ++updatedAt,
  sequence: request.sequence,
  media: request.media,
});
const edit = () => editor().apply((d) => ({ ...d, loopCount: d.loopCount === 3 ? 1 : ((d.loopCount + 1) as 2 | 3) }));
/** Lets the timers and the save's promises run. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await editWritesIdle();
}

let autoSave: AutoSave | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  __resetEditProjectForTests();
  editor().close();
  useAssetStore.setState({ appView: "edit" });
  useWorkflowStore.setState({ autoSaveEnabled: true });
  api.fetchEditList.mockResolvedValue({ edits: [], problems: [], folder: "/lib/Edits" });
  api.saveEdit.mockImplementation(answer);
  api.fetchEdit.mockResolvedValue(document);
  await useEditProjectStore.getState().openEditById(ID);
  autoSave = createEditAutoSave();
  autoSave.start();
});

afterEach(() => {
  autoSave?.stop();
  autoSave = null;
  editor().close();
  vi.useRealTimers();
});

describe("the edit autosave", () => {
  it("saves a settle period after the last change", async () => {
    edit();
    await advance(AUTOSAVE_SETTLE_MS - 500);
    edit();
    await advance(AUTOSAVE_SETTLE_MS - 500);
    expect(api.saveEdit).not.toHaveBeenCalled();
    await advance(600);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(selectIsDirty(editor())).toBe(false);
  });

  it("saves a media item renamed in the pane, with nothing else changed, once", async () => {
    const renamed = { id: "aclipaaaaaaaa1", kind: "video", filename: "aclipaaaaaaaa1.mp4", name: "Intro", workflow: { projectPath: null } };
    useEditProjectStore.getState().noteAssetRenamed(renamed as unknown as AssetView);
    expect(selectIsDirty(editor())).toBe(false);
    await advance(AUTOSAVE_SETTLE_MS + 100);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect((api.saveEdit.mock.calls[0][1] as SaveEditRequest).assets.aclipaaaaaaaa1.name).toBe("Intro");
    await advance(AUTOSAVE_SETTLE_MS * 3);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
  });

  it("does nothing with Save automatically off", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: false });
    edit();
    await advance(AUTOSAVE_SETTLE_MS * 3);
    expect(api.saveEdit).not.toHaveBeenCalled();
  });

  it("does nothing while a conflict or a gone edit waits for the user", async () => {
    for (const state of ["conflict", "gone"] as const) {
      useEditProjectStore.setState({ save: { state, error: null, conflict: null, retryAt: null } });
      edit();
      await advance(AUTOSAVE_SETTLE_MS * 3);
    }
    expect(api.saveEdit).not.toHaveBeenCalled();
  });

  it("follows a parked edit too: the session the view left is the one saved", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: false });
    edit();
    useEditProjectStore.getState().leaveView();
    useWorkflowStore.setState({ autoSaveEnabled: true });
    await advance(AUTOSAVE_SETTLE_MS + 100);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(useEditProjectStore.getState().parked?.initial).toBe(useEditProjectStore.getState().parked?.draft);
  });

  it("waits out a moving library until its retry time, then saves, with no failure notice", async () => {
    api.saveEdit.mockRejectedValueOnce(new EditApiError("Paused", 503, "paused", undefined, 10_000));
    edit();
    await advance(AUTOSAVE_SETTLE_MS + 100);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(useEditProjectStore.getState().save.state).toBe("waiting");
    // Looked at every few seconds, nothing sent before the retry time
    await advance(9_000);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    await advance(AUTOSAVE_SETTLE_MS + 1_000);
    expect(api.saveEdit).toHaveBeenCalledTimes(2);
    expect(useEditProjectStore.getState().save.state).toBe("saved");
    expect(api.show).not.toHaveBeenCalled();
  });

  it("retries a failed save once, then backs off with one notice", async () => {
    api.saveEdit.mockRejectedValue(new EditApiError("Disk full", 500));
    edit();
    await advance(AUTOSAVE_SETTLE_MS + 100);
    await advance(AUTOSAVE_RETRY_MS + 100);
    expect(api.saveEdit).toHaveBeenCalledTimes(2);
    expect(api.show).toHaveBeenCalledTimes(1);
    expect(api.show.mock.calls[0][0]).toContain("couldn't save the edit (Disk full)");
    await advance(AUTOSAVE_BACKOFF_MS - 1_000);
    expect(api.saveEdit).toHaveBeenCalledTimes(2);
  });
});

describe("startEditAutoSave", () => {
  it("saves at once when the window loses focus", async () => {
    autoSave?.stop();
    const stop = startEditAutoSave();
    edit();
    window.dispatchEvent(new Event("blur"));
    await advance(0);
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    stop();
  });

  it("saves at once when the tab is hidden, and not when it shows again", async () => {
    autoSave?.stop();
    const stop = startEditAutoSave();
    // `document` here is the edit the tests open
    const page = window.document;
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(page, "visibilityState", { configurable: true, get: () => state });
    try {
      edit();
      page.dispatchEvent(new Event("visibilitychange"));
      await advance(0);
      expect(api.saveEdit).not.toHaveBeenCalled();
      state = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
      await advance(0);
      expect(api.saveEdit).toHaveBeenCalledTimes(1);
    } finally {
      // Back to the prototype's
      delete (page as { visibilityState?: DocumentVisibilityState }).visibilityState;
      stop();
    }
  });
});
