import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ recordUpload: vi.fn(), show: vi.fn() }));
vi.mock("@/lib/assets/client/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/upload")>()),
  recordUpload: m.recordUpload,
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: m.show }) } }));

import type { AssetView } from "@/lib/assets/types";
import type { StitchDraft } from "@/lib/stitch/draft";
import { NOT_MEDIA_REASON, UNSUPPORTED_MEDIA_REASON } from "@/lib/assets/client/upload";
import { __resetAssetInfoForTests, getAssetInfo, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { createClip } from "@/lib/stitch/timeline";
import { __resetEditProjectForTests, useEditProjectStore } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  __resetMediaUploadsForTests,
  GESTURE_IDLE_MS,
  addFilesToEdit,
  editUploadContext,
  moveEditUploads,
  addToOpenEditMedia,
  addRecordedUploads,
  uploadFiles,
  useMediaUploads,
} from "../mediaUploads";

const EDIT = "ed0000000000a1";
const OTHER = "ed0000000000b2";
const A = "aclipaaaaaaaa1";
const X = "aupldaaaaaaaa1";
const Y = "aupldaaaaaaaa2";
const editor = () => useStitchEditorStore.getState();
const project = () => useEditProjectStore.getState();
const pending = () => useMediaUploads.getState().uploads;

const view = (id: string, overrides: Partial<AssetView> = {}): AssetView =>
  ({ id, kind: "video", durationSec: 5, filename: `${id}.mp4`, sha256: `sha-${id}`, workflow: { projectPath: null }, ...overrides }) as unknown as AssetView;
const file = (name: string, type: string) => new File(["x"], name, { type });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Each recordUpload call's answer, settled by the test. */
function answers() {
  const calls: ReturnType<typeof deferred<AssetView>>[] = [];
  m.recordUpload.mockImplementation(() => {
    const answer = deferred<AssetView>();
    calls.push(answer);
    return answer.promise;
  });
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function openEdit(editId = EDIT, media = [A]) {
  const draft: StitchDraft = {
    timeline: [createClip({ kind: "asset", assetId: A }, { id: "v1" })],
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: { mode: "track", overlapSec: 1, crossfade: true },
    media,
  };
  editor().openEdit({ editId, draft });
}

beforeEach(() => {
  vi.clearAllMocks();
  editor().close();
  __resetEditProjectForTests();
  __resetAssetInfoForTests();
  __resetMediaUploadsForTests();
});

describe("uploadFiles", () => {
  it("records every video and audio file at once and leaves the rest out with one notice", async () => {
    const calls = answers();
    const on = { started: vi.fn(), recorded: vi.fn(), failed: vi.fn() };
    const video = file("sunset.mp4", "video/mp4");
    const sound = file("score.wav", "");
    const started = uploadFiles(
      [video, file("notes.txt", "text/plain"), sound, file("brief.pdf", "application/pdf")],
      { editId: EDIT, editName: "Trip" },
      on,
    );
    expect(m.show).toHaveBeenCalledTimes(1);
    expect(m.show).toHaveBeenCalledWith(NOT_MEDIA_REASON, "info");
    expect(started.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "sunset.mp4", kind: "video" },
      { name: "score.wav", kind: "audio" },
    ]);
    expect(new Set(started.map((u) => u.key)).size).toBe(2);
    expect(on.started.mock.calls.map(([u]) => u)).toEqual(started);
    // Both at once, with the edit they came in through
    expect(m.recordUpload.mock.calls).toEqual([
      [video, { editId: EDIT, editName: "Trip" }],
      [sound, { editId: EDIT, editName: "Trip" }],
    ]);

    // Each as it is recorded, its record in the cache first
    const score = view(Y, { kind: "audio" });
    let cached: AssetView | null | undefined;
    on.recorded.mockImplementation(() => {
      cached = getAssetInfo(Y);
    });
    calls[1].resolve(score);
    await settle();
    expect(on.recorded).toHaveBeenCalledWith(started[1], score);
    expect(cached).toBe(score);

    calls[0].reject(new Error("The asset library is off."));
    await settle();
    expect(m.show).toHaveBeenLastCalledWith("Couldn't add “sunset.mp4”", "error", false, "The asset library is off.");
    expect(on.failed).toHaveBeenCalledWith(started[0], "The asset library is off.");
    expect(on.recorded).toHaveBeenCalledTimes(1);
  });

  it("says nothing when every file is video or audio, and starts nothing for none", () => {
    answers();
    const recorded = vi.fn();
    expect(uploadFiles([file("a.mov", ""), file("b.m4a", "audio/mp4")], {}, { recorded })).toHaveLength(2);
    expect(m.show).not.toHaveBeenCalled();
    expect(uploadFiles([file("a.txt", "text/plain")], {}, { recorded })).toEqual([]);
    expect(m.recordUpload).toHaveBeenCalledTimes(2);
  });

  it("leaves out video and audio the library can't keep with a notice of its own, naming the files", () => {
    answers();
    const recorded = vi.fn();
    const started = uploadFiles(
      [file("a.avi", "video/x-msvideo"), file("notes.txt", "text/plain"), file("b.aiff", ""), file("ok.mp4", "video/mp4")],
      {},
      { recorded },
    );
    expect(started.map((u) => u.name)).toEqual(["ok.mp4"]);
    expect(m.recordUpload).toHaveBeenCalledTimes(1);
    expect(m.show.mock.calls).toEqual([
      [NOT_MEDIA_REASON, "info"],
      ["Couldn't add 2 files", "error", false, "The library can't keep that kind of video or audio: a.avi, b.aiff."],
    ]);

    // One file is named in the title
    m.show.mockClear();
    expect(uploadFiles([file("memo.caf", "audio/x-caf")], {}, { recorded })).toEqual([]);
    expect(m.show.mock.calls).toEqual([["Couldn't add “memo.caf”", "error", false, UNSUPPORTED_MEDIA_REASON]]);
    expect(m.recordUpload).toHaveBeenCalledTimes(1);
  });
});

describe("addFilesToEdit", () => {
  it("shows each file as pending until its record exists, then adds it to the open edit's media and reveals it", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("one.mp4", "video/mp4"), file("two.mp3", "audio/mpeg")], { editId: EDIT, editName: "Trip" });
    expect(pending().map(({ name, kind, editId, asset }) => ({ name, kind, editId, asset }))).toEqual([
      { name: "one.mp4", kind: "video", editId: EDIT, asset: null },
      { name: "two.mp3", kind: "audio", editId: EDIT, asset: null },
    ]);
    const reveal = project().mediaFocus.reveal;

    calls[0].resolve(view(X));
    await settle();
    expect(pending().map((u) => u.name)).toEqual(["two.mp3"]);
    expect(editor().draft!.media).toEqual([A, X]);
    expect(project().mediaFocus).toEqual({ id: X, reveal: reveal + 1 });

    calls[1].resolve(view(Y, { kind: "audio" }));
    await settle();
    expect(pending()).toEqual([]);
    expect(editor().draft!.media).toEqual([A, X, Y]);
    expect(project().mediaFocus.id).toBe(Y);
    // Each one undo step; the timeline is left alone
    editor().undo();
    expect(editor().draft!.media).toEqual([A, X]);
    expect(editor().draft!.timeline).toHaveLength(1);
  });

  it("adds the files in the order they were dropped: one recorded first waits for the one before it", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit(
      [file("big.mov", "video/quicktime"), file("small.mp4", "video/mp4"), file("last.mp4", "video/mp4")],
      { editId: EDIT },
    );
    calls[1].resolve(view(Y));
    await settle();
    expect(editor().draft!.media).toEqual([A]);
    expect(pending().map(({ name, asset }) => [name, asset?.id ?? null])).toEqual([
      ["big.mov", null],
      ["small.mp4", Y],
      ["last.mp4", null],
    ]);

    // The first in brings the one waiting behind it, in one undo step
    calls[0].resolve(view(X));
    await settle();
    expect(editor().draft!.media).toEqual([A, X, Y]);
    expect(editor().past).toHaveLength(1);
    expect(project().mediaFocus.id).toBe(Y);
    expect(pending().map((u) => u.name)).toEqual(["last.mp4"]);
  });

  it("a file that fails lets the ones dropped after it in", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("broken.mp4", "video/mp4"), file("fine.mp4", "video/mp4")], { editId: EDIT });
    calls[1].resolve(view(Y));
    await settle();
    expect(editor().draft!.media).toEqual([A]);
    calls[0].reject(new Error("The file couldn't be read as video or audio."));
    await settle();
    expect(editor().draft!.media).toEqual([A, Y]);
    expect(pending()).toEqual([]);
  });

  it("adds nothing for a file whose bytes the media holds already, and reveals that one; a lost one doesn't count", async () => {
    openEdit(EDIT, [A, "aclipaaaaaaaa2"]);
    primeAssetInfo([view(A, { sha256: "same" }), view("aclipaaaaaaaa2", { sha256: "gone", missing: true })]);
    const calls = answers();
    addFilesToEdit([file("again.mp4", "video/mp4"), file("back.mp4", "video/mp4")], { editId: EDIT });
    calls[0].resolve(view(X, { sha256: "same" }));
    await settle();
    expect(editor().draft!.media).toEqual([A, "aclipaaaaaaaa2"]);
    expect(editor().past).toHaveLength(0);
    expect(project().mediaFocus.id).toBe(A);
    expect(pending().map((u) => u.name)).toEqual(["back.mp4"]);
    // The library lost the file this one is: the new record can be placed
    calls[1].resolve(view(Y, { sha256: "gone" }));
    await settle();
    expect(editor().draft!.media).toEqual([A, "aclipaaaaaaaa2", Y]);
  });

  it("a file that can't be added says why and leaves no pending row", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("broken.mp4", "video/mp4")], { editId: EDIT });
    expect(pending()).toHaveLength(1);
    calls[0].reject(new Error("The file couldn't be read as video or audio."));
    await settle();
    expect(pending()).toEqual([]);
    expect(m.show).toHaveBeenCalledWith("Couldn't add “broken.mp4”", "error", false, "The file couldn't be read as video or audio.");
    expect(editor().draft!.media).toEqual([A]);
  });

  it("keeps one recorded while its edit isn't open, and adds it (once per file) when the editor holds that edit again", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("one.mp4", "video/mp4"), file("one again.mp4", "video/mp4")], { editId: EDIT });
    // Another edit opens before the files are recorded
    openEdit(OTHER);
    calls[0].resolve(view(X, { sha256: "one" }));
    calls[1].resolve(view(Y, { sha256: "one" }));
    await settle();
    expect(editor().draft!.media).toEqual([A]);
    expect(pending().map((u) => u.asset?.id)).toEqual([X, Y]);
    // Not while another edit is open
    addRecordedUploads(EDIT);
    expect(pending()).toHaveLength(2);

    openEdit(EDIT);
    addRecordedUploads(EDIT);
    expect(pending()).toEqual([]);
    expect(editor().draft!.media).toEqual([A, X]);
    expect(project().mediaFocus.id).toBe(X);
    expect(editor().past).toHaveLength(1);
  });
});

describe("a file recorded while a gesture runs", () => {
  /** Lets the fake timers and the recordings' promises run. */
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  const loop = (count: 1 | 2 | 3, gestureKey: string) => editor().apply((d) => ({ ...d, loopCount: count }), { gestureKey });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the gesture to end, which stays one undo step, then joins as a step of its own", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("one.mp4", "video/mp4")], { editId: EDIT });
    // A volume drag: every tick shares one key, and so one undo step
    loop(2, "volume:v1");
    calls[0].resolve(view(X));
    await tick();
    expect(editor().draft!.media).toEqual([A]);
    expect(pending().map((u) => u.asset?.id)).toEqual([X]);
    loop(3, "volume:v1");
    expect(editor().past).toHaveLength(1);

    editor().endGesture();
    expect(editor().draft!.media).toEqual([A, X]);
    expect(pending()).toEqual([]);
    expect(project().mediaFocus.id).toBe(X);
    expect(editor().past).toHaveLength(2);
    editor().undo();
    expect(editor().draft).toMatchObject({ media: [A], loopCount: 3 });
    editor().undo();
    expect(editor().draft).toMatchObject({ media: [A], loopCount: 1 });
  });

  it("joins once a gesture whose key is left set has changed nothing for a while (a run of nudges)", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("one.mp4", "video/mp4")], { editId: EDIT });
    loop(2, "nudge:v1");
    await tick(GESTURE_IDLE_MS - 400);
    calls[0].resolve(view(X));
    await tick();
    expect(editor().draft!.media).toEqual([A]);
    // Another nudge of the run: it waits that much longer
    await tick(100);
    loop(3, "nudge:v1");
    await tick(GESTURE_IDLE_MS - 1);
    expect(editor().draft!.media).toEqual([A]);
    expect(editor().past).toHaveLength(1);
    await tick(1);
    expect(editor().draft!.media).toEqual([A, X]);
    expect(pending()).toEqual([]);
    expect(editor().past).toHaveLength(2);
  });
});

describe("moveEditUploads", () => {
  it("moves an edit's uploads to its new id, so they go into the edit under that id, and leaves the others", async () => {
    openEdit();
    const calls = answers();
    addFilesToEdit([file("one.mp4", "video/mp4")], { editId: EDIT });
    addFilesToEdit([file("other.mp4", "video/mp4")], { editId: OTHER });
    // Save as a new edit: the session takes the new id
    const NEW = "ed0000000000c3";
    editor().setEditId(NEW);
    moveEditUploads(EDIT, NEW);
    expect(pending().map(({ name, editId }) => [name, editId])).toEqual([
      ["one.mp4", NEW],
      ["other.mp4", OTHER],
    ]);
    calls[0].resolve(view(X));
    await settle();
    expect(editor().draft!.media).toEqual([A, X]);
    expect(pending().map((u) => u.name)).toEqual(["other.mp4"]);
  });
});

describe("addToOpenEditMedia (Add media's Add in the view)", () => {
  it("adds what the media lacks, in order, as one undo step; one there already, or with its bytes, adds nothing; the last is shown", () => {
    openEdit(EDIT, [A]);
    primeAssetInfo([view(A, { sha256: "sunset" })]);
    addToOpenEditMedia([view(X), view(A, { sha256: "sunset" }), view(Y, { sha256: "sunset" })]);
    expect(editor().draft!.media).toEqual([A, X]);
    expect(editor().past).toHaveLength(1);
    // Y is sunset's bytes again: the one there is shown
    expect(project().mediaFocus).toMatchObject({ id: A, reveal: 1 });
    expect(getAssetInfo(X)?.filename).toBe(`${X}.mp4`);

    addToOpenEditMedia([view(Y, { sha256: "other" })]);
    expect(editor().draft!.media).toEqual([A, X, Y]);
    expect(project().mediaFocus).toMatchObject({ id: Y, reveal: 2 });
    expect(editor().past).toHaveLength(2);
  });

  it("weighs the bytes only of the files just recorded from the computer: a pick from the library is added as it is", () => {
    openEdit(EDIT, [A]);
    primeAssetInfo([view(A, { sha256: "sunset" })]);
    // X was picked in the library, Y uploaded: both sunset's bytes
    addToOpenEditMedia([view(X, { sha256: "sunset" }), view(Y, { sha256: "sunset" })], (asset) => asset.id === Y);
    expect(editor().draft!.media).toEqual([A, X]);
    expect(project().mediaFocus).toMatchObject({ id: A });
    expect(editor().past).toHaveLength(1);
  });
});

describe("editUploadContext", () => {
  it("names the edit while it is the open one", () => {
    useEditProjectStore.setState({ open: { id: EDIT, name: "Trip", createdAt: 1, baseUpdatedAt: 2, renders: [], assets: {} } });
    expect(editUploadContext(EDIT)).toEqual({ editId: EDIT, editName: "Trip" });
    expect(editUploadContext(OTHER)).toEqual({ editId: OTHER });
  });
});
