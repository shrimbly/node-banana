import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AssetFacets, AssetPage, AssetView, LibraryStatus } from "@/lib/assets/types";
import type { EditDocument, EditSummary } from "@/lib/edits/types";

const edits = vi.hoisted(() => ({
  fetchEditList: vi.fn(),
  fetchEdit: vi.fn(),
  createEdit: vi.fn(),
  saveEdit: vi.fn(),
  patchEdit: vi.fn(),
  deleteEdit: vi.fn(),
  revealEdit: vi.fn(),
  revealEditsFolder: vi.fn(),
}));
vi.mock("@/lib/edits/client", async (importOriginal) => ({
  EditApiError: (await importOriginal<typeof import("@/lib/edits/client")>()).EditApiError,
  ...edits,
}));

const assetsApi = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(),
  fetchFacets: vi.fn(),
  fetchAsset: vi.fn(),
  patchAsset: vi.fn(),
  upsertWorkflowEntry: vi.fn(),
}));
vi.mock("@/lib/assets/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/api")>()),
  ...assetsApi,
}));

const uploadsApi = vi.hoisted(() => ({ recordUpload: vi.fn() }));
vi.mock("@/lib/assets/client/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/upload")>()),
  ...uploadsApi,
}));

const poster = vi.hoisted(() => ({ ensurePoster: vi.fn(), listeners: new Set<(assetId: string) => void>() }));
vi.mock("@/lib/assets/client/poster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/poster")>()),
  ensurePoster: poster.ensurePoster,
  onPosterReady: (listener: (assetId: string) => void) => {
    poster.listeners.add(listener);
    return () => poster.listeners.delete(listener);
  },
}));

vi.mock("@/hooks/useStitchVideos", () => ({ checkEncoderSupport: async () => true, stitchVideosAsync: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: toast }) } }));
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key];
  }),
  clear: vi.fn(),
});

import { __resetPosterRequestsForTests } from "@/components/assets/posterRequests";
import { EditApiError } from "@/lib/edits/client";
import { editAssetIds } from "@/lib/edits/document";
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import { __resetAssetInfoForTests, getAssetInfo } from "@/lib/stitch/assetInfo";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, assetMediaKey } from "@/lib/stitch/mediaInfo";
import { createAudioClip } from "@/lib/stitch/audioClips";
import { createClip } from "@/lib/stitch/timeline";
import { useAssetStore } from "@/store/assetStore";
import { __resetEditProjectForTests, LAST_EDIT_KEY, LIBRARY_PANE_KEY, PANE_LAYOUT_KEY, useEditProjectStore } from "@/store/editProjectStore";
import { requestSave, useSaveRequestStore } from "@/store/saveRequestStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { setLoopCount } from "@/components/stitch/editorActions";
import { libraryDrop } from "@/components/stitch/timeline/libraryDrop";
import { LOOP_AUDIO_NOTE } from "@/components/stitch/sequenceMenu";
import { EditVideoView } from "../EditVideoView";
import { NAME_CLICK_WAIT_MS } from "../MediaPane";
import { __resetMediaUploadsForTests, useMediaUploads } from "../mediaUploads";

const ID = "ed0000000000a1";
const OTHER = "ed0000000000b2";
const A = "aclipaaaaaaaa1";
const B = "aclipaaaaaaaa2";
const C = "aclipaaaaaaaa3";
const M = "aaudioaaaaaaa1";
const T0 = Date.UTC(2026, 9, 16, 12);
const editor = () => useStitchEditorStore.getState();
const project = () => useEditProjectStore.getState();

function asset(id: string, overrides: Partial<AssetView> = {}): AssetView {
  return {
    v: 1,
    id,
    kind: "video",
    origin: "generated",
    mime: "video/mp4",
    ext: "mp4",
    bytes: 2_400_000,
    sha256: id.padEnd(64, "0"),
    md5: "",
    file: { root: "library", rel: `Generations/2026-10-16/${id}.mp4` },
    filename: `${id}.mp4`,
    width: 1280,
    height: 720,
    durationSec: 5,
    createdAt: T0,
    model: { provider: "kie", modelId: "veo3", displayName: "Veo 3.1" },
    producer: { nodeId: "n1", nodeType: "generateVideo" },
    workflowId: "wf_1",
    workflowName: null,
    runId: "r1",
    tags: [],
    favorite: false,
    hasPoster: true,
    workflow: { id: "wf_1", name: "Launch", projectPath: "/Users/me/Node Banana/Launch film" },
    displayPath: `/Users/me/Node Banana/Generations/2026-10-16/${id}.mp4`,
    ...overrides,
  };
}

const LIBRARY: Record<string, AssetView> = {
  [A]: asset(A, { filename: "sunset.mp4" }),
  [B]: asset(B, { filename: "beach.mp4" }),
  [C]: asset(C, { filename: "desert.mp4" }),
  [M]: asset(M, { kind: "audio", mime: "audio/mp4", ext: "m4a", filename: "music.m4a", width: undefined, height: undefined, durationSec: 20 }),
};

function page(list: AssetView[]): AssetPage {
  return { assets: list, nextCursor: null, headCursor: list[0] ? "h" : null, total: list.length, totalBytes: 0 };
}

const facets: AssetFacets = {
  total: 4,
  favorites: 0,
  trash: 0,
  missing: 0,
  kinds: { image: 0, video: 3, audio: 1, "3d": 0 },
  origins: { generated: 4, edited: 0, uploaded: 0 },
  models: [],
  tags: [],
  workflows: [],
  projects: [{ path: "/Users/me/Node Banana/Launch film", name: "Launch film", count: 4 }],
};

const status = (available: boolean) =>
  ({
    available,
    reasonCode: available ? undefined : "hosted",
    root: null,
    source: "default",
    defaultRoot: "/x",
    cacheDir: "/x",
    platform: "darwin",
  }) as LibraryStatus;

function doc(overrides: Partial<EditDocument> = {}, layout: "track" | "stacked" = "track"): EditDocument {
  const sequence = overrides.sequence ?? {
    timeline: [createClip({ kind: "asset", assetId: A }, { id: "v1" }), createClip({ kind: "asset", assetId: B }, { id: "v2" })],
    audioClips: [],
    loopCount: 1,
    sequenceLayout: { mode: layout, overlapSec: 0.5, crossfade: true },
  };
  return {
    kind: "node-banana-edit",
    version: 1,
    id: ID,
    name: "Trip",
    createdAt: 1000,
    updatedAt: 2000,
    sequence,
    media: editAssetIds(sequence),
    assets: { [A]: { name: "sunset.mp4", kind: "video", project: "Launch film", durationSec: 5 } },
    renders: [],
    summary: { clipCount: 2, audioClipCount: 0, durationSec: 10, posterAssetId: A },
    ...overrides,
  };
}

function summary(document: EditDocument, overrides: Partial<EditSummary> = {}): EditSummary {
  return {
    ...document.summary,
    id: document.id,
    name: document.name,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    renderCount: document.renders.length,
    fileName: `${document.name}.nbedit`,
    poster: null,
    ...overrides,
  };
}

const listOf = (docs: EditDocument[], problems: { fileName: string; problem: "unreadable" | "newer" | "duplicate"; name: string | null }[] = []) => ({
  edits: docs.map((d) => summary(d)),
  problems,
  folder: "/Users/me/Node Banana/Edits",
});

/** Every clip's media measured: lengths 5 s, 1280 × 720. */
function measure(...ids: string[]) {
  for (const id of ids) __setMediaInfoForTests(assetMediaKey(id), { status: "ready", duration: 5, width: 1280, height: 720, fps: 24 });
}

/** An edit whose media also holds a video and a sound no clip uses yet: desert.mp4 (C) and music.m4a (M). */
const withMedia = (overrides: Partial<EditDocument> = {}, layout: "track" | "stacked" = "track") =>
  doc({ media: [A, B, C, M], ...overrides }, layout);

/** The view with `edit` open (it is the last edit, so entering opens it). */
async function renderOpen(edit = doc()) {
  storage[LAST_EDIT_KEY] = edit.id;
  edits.fetchEdit.mockResolvedValue(edit);
  edits.fetchEditList.mockResolvedValue(listOf([edit]));
  const view = render(<EditVideoView />);
  await screen.findByRole("button", { name: "Edit menu" });
  return view;
}

/** Once the library has answered for these items, so the pane can place them. */
async function placeable(...ids: string[]) {
  await waitFor(() => {
    for (const id of ids) expect(tile(id)).toBeEnabled();
  });
}

async function renderHome(list = listOf([])) {
  edits.fetchEditList.mockResolvedValue(list);
  const view = render(<EditVideoView />);
  await act(async () => {});
  return view;
}

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const tile = (id: string) => document.querySelector<HTMLElement>(`aside [data-asset-id="${id}"]`)!;
const tileIds = () => Array.from(document.querySelectorAll<HTMLElement>("aside [data-asset-id]")).map((el) => el.dataset.assetId);
/** A sheet's buttons take the editor's white focus ring, never the dialogs' blue one. */
function expectWhiteRings(sheet: HTMLElement) {
  for (const button of within(sheet).getAllByRole("button")) {
    expect(button.className).not.toMatch(/ring-selection/);
    expect(button.className.split(" ")).toContain("focus-visible:ring-white/40");
  }
}
const timelineIds = () => editor().draft!.timeline.map((c) => c.source.kind === "asset" ? c.source.assetId : c.id);

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  vi.clearAllMocks();
  __resetEditProjectForTests();
  editor().close();
  __resetMediaInfoForTests();
  __resetAssetInfoForTests();
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  applyLibraryStatus(status(true));
  useAssetStore.setState({ appView: "edit" });
  useWorkflowStore.setState({ autoSaveEnabled: false, shortcutsDialogOpen: false });
  useSaveRequestStore.setState({ request: null });
  assetsApi.fetchAsset.mockImplementation(async (id: string) => LIBRARY[id] ?? null);
  assetsApi.fetchAssetPage.mockResolvedValue(page([LIBRARY[C], LIBRARY[B], LIBRARY[A], LIBRARY[M]]));
  assetsApi.fetchFacets.mockResolvedValue(facets);
  edits.saveEdit.mockImplementation(async (_id: string, request: Pick<EditDocument, "sequence" | "media">) =>
    doc({ updatedAt: 3000, sequence: request.sequence, media: request.media }),
  );
  edits.revealEditsFolder.mockResolvedValue(undefined);
  useStitchClipboard.getState().setClipboard(null);
  __resetMediaUploadsForTests();
  uploadsApi.recordUpload.mockImplementation(() => new Promise(() => {}));
  __resetPosterRequestsForTests();
  poster.ensurePoster.mockResolvedValue(false);
});

afterEach(() => {
  act(() => editor().close());
  applyLibraryStatus(status(true));
  __setMediaExtractorForTests(null);
  vi.restoreAllMocks();
});

describe("the home screen", () => {
  it("lists the edits as rows, with New edit and Show in Finder; focus starts on the newest row", async () => {
    const other = doc({ id: OTHER, name: "Launch cut", updatedAt: 5000 });
    await renderHome(listOf([other, doc()]));
    const list = screen.getByRole("list", { name: "Edits" });
    const rows = within(list).getAllByRole("button", { name: /^Open / });
    expect(rows.map((c) => c.getAttribute("aria-label")?.split(",")[0])).toEqual(["Open Launch cut", "Open Trip"]);
    expect(rows[1]).toHaveAccessibleName(/^Open Trip, 2 clips, 0:10, edited /);
    expect(screen.getByRole("button", { name: "New edit" })).toBeEnabled();
    // Enter opens the newest
    expect(rows[0]).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    await waitFor(() => expect(edits.revealEditsFolder).toHaveBeenCalledTimes(1));
    fireEvent.click(rows[1]);
    await waitFor(() => expect(edits.fetchEdit).toHaveBeenCalledWith(ID));
  });

  it("says when there are no edits, while the list loads, and when it fails", async () => {
    const view = await renderHome();
    expect(screen.queryByRole("list", { name: "Edits" })).toBeNull();
    expect(screen.getByText("An edit puts videos and audio from any project on one timeline.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New edit" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New edit" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeInTheDocument();
    view.unmount();

    __resetEditProjectForTests();
    edits.fetchEditList.mockReturnValue(new Promise(() => {}));
    const loading = render(<EditVideoView />);
    expect(document.querySelector('[aria-busy="true"], [aria-busy]')).not.toBeNull();
    loading.unmount();

    __resetEditProjectForTests();
    edits.fetchEditList.mockRejectedValueOnce(new Error("The library could not be read")).mockResolvedValue(listOf([doc()]));
    render(<EditVideoView />);
    await screen.findByText("The library could not be read");
    expect(screen.getByRole("button", { name: "New edit" })).toHaveFocus();
    const again = screen.getByRole("button", { name: "Try again" });
    act(() => again.focus());
    fireEvent.click(again);
    // Try again goes with the message; focus goes to the edit it found
    await waitFor(() => expect(screen.getByRole("button", { name: /^Open Trip/ })).toHaveFocus());
  });

  it("with the library off, says so and offers neither New edit nor Show in Finder", async () => {
    applyLibraryStatus(status(false));
    await renderHome();
    expect(screen.getByText(/The asset library is off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "New edit" }) ?? { disabled: true }).toHaveProperty("disabled", true);
  });

  it("lists the files it cannot open, and makes a Finder copy a separate edit", async () => {
    edits.createEdit.mockResolvedValue(doc({ id: OTHER, name: "Trip copy" }));
    await renderHome(
      listOf([doc()], [
        { fileName: "Trip copy.nbedit", problem: "duplicate", name: "Trip" },
        { fileName: "Broken.nbedit", problem: "unreadable", name: null },
        { fileName: "Future.nbedit", problem: "newer", name: "Future" },
      ]),
    );
    expect(screen.getByText("Trip copy.nbedit is a copy of “Trip”")).toBeInTheDocument();
    expect(screen.getByText("Couldn't read Broken.nbedit")).toBeInTheDocument();
    expect(screen.getByText("Future.nbedit was made by a newer Node Banana")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make it a separate edit" }));
    await waitFor(() => expect(edits.createEdit).toHaveBeenCalledWith({ separate: "Trip copy.nbedit" }));
  });

  it("New edit opens an Untitled edit with the editor and its media pane, empty", async () => {
    edits.createEdit.mockResolvedValue(doc({ name: "Untitled edit", sequence: { ...doc().sequence, timeline: [] } }));
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: "New edit" }));
    await screen.findByRole("button", { name: "Edit menu" });
    expect(screen.getByRole("button", { name: "Untitled edit" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Media" })).getByText("No media yet")).toBeInTheDocument();
    expect(editor().editId).toBe(ID);
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Saved");
  });
});

describe("the open edit", () => {
  it("renames in place: Enter commits, Escape puts the name back, a taken name keeps the field with a note", async () => {
    await renderOpen();
    edits.patchEdit.mockResolvedValueOnce({ document: doc({ name: "Launch cut", updatedAt: 2500 }), previousUpdatedAt: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Trip" }));
    const field = await screen.findByRole("textbox", { name: "Edit name" });
    fireEvent.change(field, { target: { value: "Launch cut" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findByRole("button", { name: "Launch cut" });
    expect(edits.patchEdit).toHaveBeenCalledWith(ID, { op: "rename", name: "Launch cut" });

    fireEvent.click(screen.getByRole("button", { name: "Launch cut" }));
    const again = await screen.findByRole("textbox", { name: "Edit name" });
    fireEvent.change(again, { target: { value: "Something else" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Launch cut" })).toBeInTheDocument();
    expect(edits.patchEdit).toHaveBeenCalledTimes(1);

    edits.patchEdit.mockRejectedValueOnce(new EditApiError("taken", 409, "name_taken"));
    fireEvent.click(screen.getByRole("button", { name: "Launch cut" }));
    const third = await screen.findByRole("textbox", { name: "Edit name" });
    fireEvent.change(third, { target: { value: "Other" } });
    fireEvent.keyDown(third, { key: "Enter" });
    await screen.findByText("Another edit has that name");
    expect(screen.getByRole("textbox", { name: "Edit name" })).toBeInTheDocument();
  });

  it("names a clip the library lost from the edit's file", async () => {
    assetsApi.fetchAsset.mockImplementation(async (id: string) => (id === A ? null : (LIBRARY[id] ?? null)));
    await renderOpen();
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    await screen.findByText("Not in the library · sunset.mp4");
    const slot = screen.getByTestId("edit-render-slot");
    expect(slot).toHaveTextContent("Clip 1's video is no longer in the library");
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("puts the controls in one row under the video, which drops Fit, then − and +, when narrow", async () => {
    measure(A, B);
    await renderOpen();
    expect(screen.queryByRole("slider", { name: "Timeline zoom" })).toBeNull();
    const row = screen.getByTestId("stitch-controls");
    expect(row.parentElement!.className).toContain("@container");
    expect(screen.getByTestId("stitch-stage-column")).toContainElement(row);
    // Time | start, play, end | the rest, in the boards' order
    const [time, middle, right] = [...row.children] as HTMLElement[];
    expect(time).toHaveTextContent("0:00.00 / 0:10.00");
    expect(within(middle).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Go to start", "Play", "Go to end"]);
    expect(within(right).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Frame to canvas",
      "Mute all",
      "Track",
      "Stacked",
      "Snap",
      "Zoom out",
      "Zoom in",
      "Fit the timeline",
    ]);
    expect(screen.getByRole("button", { name: "Fit the timeline" }).parentElement!.className).toContain("@max-[695px]:hidden");
    for (const name of ["Zoom out", "Zoom in"]) {
      expect(screen.getByRole("button", { name }).parentElement!.className).toContain("@max-[628px]:hidden");
    }
    // Track and Stacked are the row's own buttons, pressed as Snap is, with no ground of their own
    const layout = screen.getByRole("group", { name: "Timeline layout" });
    expect(layout).not.toHaveClass("bg-edit-field");
    expect(within(layout).getByRole("button", { name: "Track" })).toHaveClass("aria-pressed:bg-edit-pressed");
  });

  it("mutes the preview from the control row, and shows Snap pressed while on", async () => {
    measure(A, B);
    await renderOpen();
    const mute = screen.getByRole("button", { name: "Mute all" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mute);
    expect(editor().soundOn).toBe(false);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mute);
    expect(editor().soundOn).toBe(true);
    // The preview's sound is no edit
    expect(editor().past).toHaveLength(0);
    // Snap is on by default: a press turns it off and the next on again, and neither is an edit
    const snap = screen.getByRole("button", { name: "Snap" });
    expect(editor().snap).toBe(true);
    expect(snap).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(snap);
    expect(editor().snap).toBe(false);
    expect(snap).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(snap);
    expect(editor().snap).toBe(true);
    expect(snap).toHaveAttribute("aria-pressed", "true");
    expect(editor().past).toHaveLength(0);
  });

  it("keeps the rail's column with nothing selected, and leaves Library out of a clip's source", async () => {
    measure(A, B);
    await renderOpen();
    act(() => editor().select(null));
    const rail = screen.getByRole("complementary", { name: "Clip" });
    expect(rail).toHaveClass("w-[280px]", "border-l", "border-edit-line");
    expect(within(rail).getByText("Select a clip to edit it.")).toBeInTheDocument();
    act(() => editor().select({ kind: "clip", clipId: "v2" }));
    expect(within(rail).getByText("Clip 2 of 2")).toBeInTheDocument();
    // Every clip of an edit is the library's: the line is its model and length
    expect(within(rail).getByText("Veo 3.1 · 5.00 s")).toBeInTheDocument();
    // A trim shows as the part of the file kept, and Reset trim only then
    expect(within(rail).queryByRole("button", { name: "Reset trim" })).toBeNull();
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c) => (c.id === "v2" ? { ...c, inSec: 1 } : c)) })));
    expect(within(rail).getByText("Veo 3.1 · 4.00 s of 5.00 s")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Reset trim" })).toBeEnabled();
    // The editor sits on the pane, as the header does
    expect(screen.getByRole("button", { name: "Mute all" }).closest("[data-stitch-editor]")).toHaveClass("bg-pane");
  });

  it("asks for a clip's record again when its file can't be read, and holds Render back either way", async () => {
    const unreadable = () => Promise.reject(new Error("404"));
    __setMediaExtractorForTests({ probe: unreadable, open: unreadable });
    measure(B);
    // The record was read before the file went: it says the file is there until it is read again
    let reads = 0;
    assetsApi.fetchAsset.mockImplementation(async (id: string) =>
      id === A ? { ...LIBRARY[A], missing: ++reads > 1 } : (LIBRARY[id] ?? null),
    );
    await renderOpen();
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    await screen.findByText("Not in the library · sunset.mp4");
    expect(reads).toBe(2);
    const slot = screen.getByTestId("edit-render-slot");
    expect(slot).toHaveTextContent("Clip 1's video is no longer in the library");
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("holds Render back for a file that is there but can't be read", async () => {
    const unreadable = () => Promise.reject(new Error("Not a video"));
    __setMediaExtractorForTests({ probe: unreadable, open: unreadable });
    measure(B);
    await renderOpen();
    const slot = screen.getByTestId("edit-render-slot");
    await waitFor(() => expect(slot).toHaveTextContent("Clip 1's video can't be read"));
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
    // Asked about once more, not in a loop
    expect(assetsApi.fetchAsset.mock.calls.filter(([id]) => id === A)).toHaveLength(2);
  });

  it("Render runs with one clip, is held back with none, and Stop replaces it while rendering", async () => {
    const one = doc({ sequence: { ...doc().sequence, timeline: [createClip({ kind: "asset", assetId: A }, { id: "v1" })] } });
    measure(A);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const view = await renderOpen(one);
    const slot = screen.getByTestId("edit-render-slot");
    await waitFor(() => expect(within(slot).getByRole("button", { name: "Render" })).toBeEnabled());
    fireEvent.click(within(slot).getByRole("button", { name: "Render" }));
    await waitFor(() => expect(project().render.state).toBe("rendering"));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(screen.queryByTestId("edit-render-slot")).toBeNull();
    fireEvent.click(stop);
    await waitFor(() => expect(project().render.state).toBe("idle"));
    await screen.findByTestId("edit-render-slot");
    view.unmount();
    act(() => editor().close());
    __resetEditProjectForTests();

    await renderOpen(doc({ sequence: { ...doc().sequence, timeline: [] } }));
    const empty = screen.getByTestId("edit-render-slot");
    await waitFor(() => expect(empty).toHaveTextContent("Add a clip to render"));
    expect(within(empty).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("holds Render back while another edit renders", async () => {
    measure(A, B);
    await renderOpen();
    act(() => project().setRenderState({ state: "rendering", editId: OTHER, progress: 40 }));
    const slot = screen.getByTestId("edit-render-slot");
    expect(slot).toHaveTextContent("Another edit is rendering");
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("shows how saving stands: Saving…, Saved, Waiting…, Save failed, with the banners' choices", async () => {
    await renderOpen();
    const word = () => screen.getByTestId("edit-save-state");
    expect(word()).toHaveTextContent("Saved");
    act(() => setLoopCount(2));
    expect(word()).toHaveTextContent("Unsaved");

    let answer!: (value: EditDocument) => void;
    edits.saveEdit.mockReturnValueOnce(new Promise<EditDocument>((resolve) => (answer = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(word()).toHaveTextContent("Saving…"));
    await act(async () => answer(doc({ updatedAt: 3000 })));
    expect(word()).toHaveTextContent("Saved");

    act(() => setLoopCount(3));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("paused", 503, "paused", undefined, 5000));
    await act(async () => void (await project().saveNow("manual")));
    expect(word()).toHaveTextContent("Waiting…");
    expect(screen.getByRole("alert")).toHaveTextContent("The library is moving. Saving resumes when it finishes.");

    edits.saveEdit.mockRejectedValueOnce(new EditApiError("disk full", 500));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(word()).toHaveTextContent("Save failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed: disk full");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(word()).toHaveTextContent("Saved"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a conflict offers Keep mine and Use the other version; a gone edit offers Save as a new edit", async () => {
    await renderOpen();
    act(() => setLoopCount(2));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("conflict", 409, "conflict", doc({ updatedAt: 9000 })));
    await act(async () => void (await project().saveNow("manual")));
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Changed elsewhere");
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("This edit was changed in another window.");
    expect(within(banner).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep mine", "Use the other version"]);
    fireEvent.click(within(banner).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(edits.saveEdit).toHaveBeenLastCalledWith(ID, expect.objectContaining({ force: true })));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    act(() => setLoopCount(3));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("gone", 404, "not_found"));
    await act(async () => void (await project().saveNow("manual")));
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Not in Edits");
    expect(screen.getByRole("alert")).toHaveTextContent("This edit is no longer in the Edits folder.");
    edits.createEdit.mockResolvedValueOnce(doc({ id: OTHER, updatedAt: 4000 }));
    fireEvent.click(screen.getByRole("button", { name: "Save as a new edit" }));
    await waitFor(() => expect(editor().editId).toBe(OTHER));
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Saved");
  });

  it("⌘S saves the edit, never the workflow, before the canvas's listener hears it", async () => {
    await renderOpen();
    const canvasListener = vi.fn();
    window.addEventListener("keydown", canvasListener);
    try {
      act(() => setLoopCount(2));
      const event = press(document.body, "s", { metaKey: true });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(edits.saveEdit).toHaveBeenCalledTimes(1));
      expect(canvasListener).not.toHaveBeenCalled();
      expect(useSaveRequestStore.getState().request).toBeNull();
      // The agent's save_workflow asks the floating menu; the view leaves that request alone
      act(() => requestSave("menu", "From the agent"));
      expect(useSaveRequestStore.getState().request).toMatchObject({ reason: "menu", name: "From the agent" });
    } finally {
      window.removeEventListener("keydown", canvasListener);
    }
  });

  it("⌘S on the home screen is kept from the browser and saves nothing", async () => {
    await renderHome(listOf([doc()]));
    const canvasListener = vi.fn();
    window.addEventListener("keydown", canvasListener);
    try {
      const event = press(document.body, "s", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(canvasListener).not.toHaveBeenCalled();
      expect(edits.saveEdit).not.toHaveBeenCalled();
      expect(useSaveRequestStore.getState().request).toBeNull();
    } finally {
      window.removeEventListener("keydown", canvasListener);
    }
  });
});

describe("keys", () => {
  it("the header's menu and a media item's ⋯ menu own Escape, Space, ⌫ and S while open", async () => {
    measure(A, B);
    await renderOpen();
    act(() => {
      editor().select({ kind: "clip", clipId: "v1" });
      editor().setPlayhead(2);
    });
    const draft = editor().draft;
    const selection = editor().selection;

    for (const open of [
      () => fireEvent.click(screen.getByRole("button", { name: "Edit menu" })),
      () => fireEvent.click(screen.getByRole("button", { name: "More for sunset.mp4" })),
    ]) {
      open();
      const menu = await screen.findByRole("menu");
      const item = menu.querySelector<HTMLElement>('[role^="menuitem"]')!;
      for (const key of [" ", "Backspace", "s"]) {
        const event = press(item, key);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(editor().draft).toBe(draft);
      expect(editor().playing).toBe(false);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(editor().draft).toBe(draft);
      expect(editor().selection).toBe(selection);
      expect(editor().playing).toBe(false);
    }

    // The ⋯ menu's Escape gave focus back to its ⋯
    expect(screen.getByRole("button", { name: "More for sunset.mp4" })).toHaveFocus();
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    // All closed: the editor's keys work again
    press(document.body, "s");
    expect(editor().draft!.timeline).toHaveLength(3);
    press(document.body, "Backspace");
    expect(editor().draft!.timeline).toHaveLength(2);
  });

  it("E, A, C and ? from the open edit; not while renaming media, nor mid-drag", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(C);
    press(document.body, "?", { shiftKey: true });
    expect(useWorkflowStore.getState().shortcutsDialogOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "More for desert.mp4" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "desert.mp4" })).getByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Rename desert.mp4" });
    act(() => field.focus());
    press(field, "e");
    expect(useAssetStore.getState().appView).toBe("edit");
    // Escape puts the name back and closes the field; E is the view's again
    press(field, "Escape");
    expect(screen.queryByRole("textbox", { name: "Rename desert.mp4" })).toBeNull();
    expect(assetsApi.patchAsset).not.toHaveBeenCalled();
    press(document.body, "e");
    expect(useAssetStore.getState().appView).toBe("canvas");
    act(() => useAssetStore.setState({ appView: "edit" }));

    // Mid-drag the view keys are swallowed (and no home-screen listener is there to hear them)
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.pointerDown(tile(C), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile(C), { pointerId: 1, clientX: 40, clientY: 10 });
    expect(editor().cancelGesture).not.toBeNull();
    press(document.body, "a");
    expect(useAssetStore.getState().appView).toBe("edit");
    press(document.body, "Escape");
    expect(editor().cancelGesture).toBeNull();

    for (const [key, view] of [["a", "assets"], ["c", "chat"], ["e", "canvas"]] as const) {
      act(() => useAssetStore.setState({ appView: "edit" }));
      press(document.body, key);
      expect(useAssetStore.getState().appView).toBe(view);
    }
  });

  it("on the home screen, E, A, C and ? are the view's own listener's", async () => {
    await renderHome(listOf([doc()]));
    press(document.body, "a");
    expect(useAssetStore.getState().appView).toBe("assets");
    act(() => useAssetStore.setState({ appView: "edit" }));
    press(document.body, "e", { repeat: true });
    expect(useAssetStore.getState().appView).toBe("edit");
    press(document.body, "e");
    expect(useAssetStore.getState().appView).toBe("canvas");
    act(() => useAssetStore.setState({ appView: "edit" }));
    press(document.body, "?", { shiftKey: true });
    expect(useWorkflowStore.getState().shortcutsDialogOpen).toBe(true);
  });

  it("the timeline's + opens Add media over a paused preview, set to videos; + Audio opens it set to audio", async () => {
    measure(A, B);
    await renderOpen();
    const lastRequest = () => assetsApi.fetchAssetPage.mock.calls[assetsApi.fetchAssetPage.mock.calls.length - 1][0];
    const kindChecked = (picker: HTMLElement) => {
      fireEvent.click(within(picker).getByRole("button", { name: "Filter and sort" }));
      const checked = within(within(picker).getByRole("radiogroup", { name: "Kind" })).getByRole("radio", { checked: true });
      fireEvent.keyDown(checked, { key: "Escape" });
      return checked.textContent;
    };
    act(() => editor().setPlaying(true));
    // Named as its tooltip says: it opens Add media, whose Add puts nothing on the timeline here
    const slot = screen.getByTestId("stitch-add-slot");
    expect(slot).toHaveAccessibleName("Add media");
    expect(slot).toHaveAttribute("title", "Add media");
    fireEvent.click(slot);
    expect(editor().pickerOpen).toBe("video");
    expect(editor().playing).toBe(false);
    const picker = await screen.findByRole("dialog", { name: "Add media" });
    await waitFor(() => expect(lastRequest()).toMatchObject({ kinds: ["video"] }));
    expect(kindChecked(picker)).toBe("Video");
    // It owns the keys: Space neither plays nor reaches the editor
    press(document.body, " ");
    expect(editor().playing).toBe(false);
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    expect(editor().pickerOpen).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    const addAudio = screen.getByRole("button", { name: "Add audio" });
    expect(addAudio).toHaveAttribute("title", "Add audio");
    fireEvent.click(addAudio);
    expect(editor().pickerOpen).toBe("audio");
    const audioPicker = await screen.findByRole("dialog", { name: "Add media" });
    await waitFor(() => expect(lastRequest()).toMatchObject({ kinds: ["audio"] }));
    expect(kindChecked(audioPicker)).toBe("Audio");
    fireEvent.click(within(audioPicker).getByRole("button", { name: "Cancel" }));
    expect(editor().pickerOpen).toBe(false);
  });
});

describe("adding from the media pane", () => {
  it("a click adds at the playhead as one undo step: in Track after the clip under it", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(C);
    act(() => editor().setPlayhead(2));
    const past = editor().past.length;
    fireEvent.click(tile(C));
    expect(timelineIds()).toEqual([A, C, B]);
    expect(editor().past.length).toBe(past + 1);
    const added = editor().draft!.timeline[1].id;
    expect(editor().selection).toMatchObject({ kind: "clip", clipId: added });
    expect(editor().playhead).toBe(5);
  });

  it("in Stacked, a click puts a new row at the playhead with every other clip pinned", async () => {
    measure(A, B);
    await renderOpen(withMedia({}, "stacked"));
    await placeable(C);
    act(() => editor().setPlayhead(2));
    fireEvent.click(tile(C));
    const timeline = editor().draft!.timeline;
    expect(timeline.map((c) => c.startSec)).toEqual([0, 4.5, 2]);
    expect(timelineIds()).toEqual([A, B, C]);
  });

  it("Enter on a focused item is left to the button; Space plays and adds nothing", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(C);
    const target = tile(C);
    target.focus();
    const space = press(target, " ");
    expect(space.defaultPrevented).toBe(true);
    expect(editor().playing).toBe(true);
    expect(editor().draft!.timeline).toHaveLength(2);
    act(() => editor().setPlaying(false));
    const enter = press(target, "Enter");
    expect(enter.defaultPrevented).toBe(false);
    // A real button: the browser turns that Enter into a click, which adds
    expect(target.tagName).toBe("BUTTON");
    expect(target).toHaveAttribute("type", "button");
    fireEvent.click(target);
    expect(editor().draft!.timeline).toHaveLength(3);
  });

  it("one drop adds once: the marker shows where, release adds, the click after it adds nothing", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(A, B, C, M);
    // jsdom lays nothing out: the lanes' probe answers as the Timeline would over clip 2
    const unregister = libraryDrop.register(() => ({ lane: "clips", mode: "track", index: 1 }), () => null);
    try {
      const target = tile(C);
      const order = tileIds();
      const past = editor().past.length;
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(target, { pointerId: 1, clientX: 12, clientY: 11 });
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      fireEvent.pointerMove(target, { pointerId: 1, clientX: 60, clientY: 300 });
      expect(screen.getByTestId("library-drop-marker")).toBeInTheDocument();
      // The ghost is the item lifted: its cover and its length, no name
      const ghost = screen.getByTestId("library-drag-ghost");
      expect(ghost.querySelector("img")).toHaveAttribute("src", expect.stringContaining(LIBRARY[C].sha256));
      expect(ghost).toHaveTextContent(/^0:05$/);
      expect(editor().draft!.timeline).toHaveLength(2);
      fireEvent.pointerUp(target, { pointerId: 1, clientX: 60, clientY: 300 });
      fireEvent.click(target);
      expect(editor().past.length).toBe(past + 1);
      expect(timelineIds()).toEqual([A, C, B]);
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      // The item is the same element in the same place in the list (its box is the browser checks' to measure)
      expect(tile(C)).toBe(target);
      expect(tileIds()).toEqual(order);

      // Escape mid-drag: nothing added, and the click after the release adds nothing either
      fireEvent.pointerDown(target, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(target, { pointerId: 2, clientX: 60, clientY: 300 });
      expect(screen.getByTestId("library-drop-marker")).toBeInTheDocument();
      press(document.body, "Escape");
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      fireEvent.pointerUp(target, { pointerId: 2, clientX: 60, clientY: 300 });
      fireEvent.click(target);
      expect(editor().past.length).toBe(past + 1);
      expect(editor().draft!.timeline).toHaveLength(3);
    } finally {
      unregister();
    }
  });

  it("a Stacked add waits while a clip is still loading, then adds a pinned row (the grid's covers too)", async () => {
    measure(A);
    await renderOpen(withMedia({}, "stacked"));
    await placeable(C, M);
    await waitFor(() => expect(tile(C)).toHaveAttribute("aria-disabled", "true"));
    expect(tile(C)).toHaveAttribute("title", "desert.mp4\nWaiting for the clips to load");
    // In the grid, a cover says so too; the keys see it there: on focus the cover shows its name and why it waits
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(tile(C)).toHaveAttribute("aria-disabled", "true");
    expect(tile(C)).toHaveAttribute("title", "desert.mp4\nWaiting for the clips to load");
    expect(within(tile(C)).getByTestId("library-tile-focus-name")).toHaveTextContent("desert.mp4Waiting for the clips to load");
    // Audio never waits
    expect(tile(M)).not.toHaveAttribute("aria-disabled");
    fireEvent.click(tile(C));
    expect(editor().draft!.timeline).toHaveLength(2);
    expect(editor().draft!.timeline.every((c) => c.startSec === undefined)).toBe(true);
    // Dragged over the lanes, the ghost says why it cannot land
    const unregister = libraryDrop.register(() => ({ lane: "clips", mode: "stacked", startSec: 1, row: 2 }), () => null);
    try {
      fireEvent.pointerDown(tile(C), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(tile(C), { pointerId: 1, clientX: 60, clientY: 300 });
      expect(screen.getByTestId("library-drag-ghost")).toHaveTextContent("0:05Waiting for the clips to load");
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      press(document.body, "Escape");
      fireEvent.pointerUp(tile(C), { pointerId: 1, clientX: 60, clientY: 300 });
      expect(screen.queryByTestId("library-drag-ghost")).toBeNull();
    } finally {
      unregister();
    }

    act(() => measure(B));
    await waitFor(() => expect(tile(C)).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(tile(C));
    expect(editor().draft!.timeline.map((c) => c.startSec)).toEqual([0, 4.5, 0]);
  });

  it("a sound's ghost is its row: the music glyph, its name and length, no picture", async () => {
    measure(A, B);
    assetsApi.fetchAsset.mockImplementation(async (id: string) => (id === M ? { ...LIBRARY[M], name: "Morning score" } : (LIBRARY[id] ?? null)));
    await renderOpen(withMedia());
    await placeable(M);
    const unregister = libraryDrop.register(() => ({ lane: "audio", startSec: 1, row: 0, newRow: true }), () => null);
    try {
      fireEvent.pointerDown(tile(M), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(tile(M), { pointerId: 1, clientX: 60, clientY: 300 });
      const ghost = screen.getByTestId("library-drag-ghost");
      expect(ghost).toHaveTextContent(/^Morning score0:20$/);
      expect(ghost.querySelector("img")).toBeNull();
      expect(ghost.querySelector("svg")).not.toBeNull();
      press(document.body, "Escape");
      fireEvent.pointerUp(tile(M), { pointerId: 1, clientX: 60, clientY: 300 });
      expect(editor().draft!.audioClips).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it("a click on an item's name waits a moment, so a double-click there renames without adding", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(C);
    // As a browser sends them: the press lands on the name, but the drag's pointer capture sends what follows the
    // press (its release, the click, the double-click) to the item's button
    const clickName = (detail: number, pointerId: number) => {
      const button = tile(C);
      fireEvent.pointerDown(within(button).getByText("desert.mp4"), { button: 0, pointerId, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(button, { pointerId, clientX: 10, clientY: 10 });
      fireEvent.click(button, { detail });
    };
    clickName(1, 1);
    clickName(2, 2);
    fireEvent.dblClick(tile(C), { detail: 2 });
    expect(await screen.findByRole("textbox", { name: "Rename desert.mp4" })).toHaveValue("desert.mp4");
    await act(() => new Promise((resolve) => setTimeout(resolve, NAME_CLICK_WAIT_MS + 50)));
    expect(editor().draft!.timeline).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename desert.mp4" }), { key: "Escape" });

    // One click on the name adds once the wait is over, and selects the item
    clickName(1, 3);
    expect(editor().draft!.timeline).toHaveLength(2);
    await waitFor(() => expect(editor().draft!.timeline).toHaveLength(3));
    expect(timelineIds()).toContain(C);
    expect(tile(C).closest("li")).toHaveAttribute("data-selected");

    // A press elsewhere on the item adds at once, and a double-click there renames nothing
    const cover = tile(C).querySelector("img")!.parentElement!;
    fireEvent.pointerDown(cover, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(tile(C), { pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.click(tile(C), { detail: 1 });
    expect(editor().draft!.timeline).toHaveLength(4);
    fireEvent.dblClick(tile(C), { detail: 2 });
    expect(screen.queryByRole("textbox", { name: "Rename desert.mp4" })).toBeNull();
  });
});

describe("the media pane", () => {
  const lastRequest = () => assetsApi.fetchAssetPage.mock.calls[assetsApi.fetchAssetPage.mock.calls.length - 1][0];
  const openMenu = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: `More for ${name}` }));
    return screen.getByRole("menu", { name });
  };
  const pick = (menu: HTMLElement, item: string) => fireEvent.click(within(menu).getByRole("menuitem", { name: item }));

  it("lists the edit's media in the order it came in: a cover, the name and the length; one the library lost says so", async () => {
    measure(A, B);
    assetsApi.fetchAsset.mockImplementation(async (id: string) =>
      id === B ? null : id === M ? { ...LIBRARY[M], name: "Morning score" } : (LIBRARY[id] ?? null),
    );
    const beach = { name: "beach.mp4", kind: "video" as const, project: "Launch film", durationSec: 5 };
    await renderOpen(withMedia({ media: [C, A, M, B], assets: { ...doc().assets, [B]: beach } }));
    const pane = screen.getByRole("complementary", { name: "Media" });
    expect(within(pane).getByRole("heading", { level: 2, name: "Media" })).toBeInTheDocument();
    await placeable(C, A, M);
    await waitFor(() => expect(tile(B)).toHaveTextContent("Not in the library"));
    expect(tileIds()).toEqual([C, A, M, B]);
    // A video: its poster, its name and its length; a sound: a glyph, the name it was given and its length
    expect(tile(C)).toHaveTextContent(/^desert\.mp40:05$/);
    expect(tile(C).querySelector("img")).toHaveAttribute("src", expect.stringContaining(LIBRARY[C].sha256));
    expect(tile(M)).toHaveTextContent(/^Morning score0:20$/);
    expect(tile(M).querySelector("img")).toBeNull();
    expect(tile(M).querySelector("svg")).not.toBeNull();
    expect(tile(C)).toHaveAccessibleName("Add desert.mp4, 0:05.0, at the playhead");
    expect(tile(C)).toHaveAttribute("title", "desert.mp4\nClick to add at the playhead, or drag onto the timeline.");
    expect(tile(M)).toHaveAttribute("title", "Morning score\nClick to add at the playhead, or drag onto the timeline.");
    // Lost: named from the edit's file, and it can no longer be placed
    expect(tile(B)).toHaveTextContent(/^beach\.mp4Not in the library$/);
    expect(tile(B)).toBeDisabled();
    expect(tile(B)).toHaveAttribute("title", "beach.mp4\nNot in the library");
    // No library list or search here: Add media brings media in
    expect(within(pane).queryByRole("textbox")).toBeNull();
    expect(assetsApi.fetchAssetPage).not.toHaveBeenCalled();
  });

  it("with no media, says so under Add media, which opens the library picker for videos and audio", async () => {
    await renderOpen(doc({ sequence: { ...doc().sequence, timeline: [] } }));
    const pane = screen.getByRole("complementary", { name: "Media" });
    expect(within(pane).getByText("No media yet")).toBeInTheDocument();
    expect(tileIds()).toEqual([]);
    // The empty lane's placeholder opens it too, and says so
    expect(screen.getByTestId("stitch-empty-lane")).toHaveAccessibleName("Add media");
    expect(screen.getByTestId("stitch-empty-lane")).toHaveAttribute("title", "Add media");
    // The head's and the empty pane's
    const adds = within(pane).getAllByRole("button", { name: "Add media" });
    expect(adds).toHaveLength(2);
    fireEvent.click(adds[1]);
    expect(editor().pickerOpen).toBe("all");
    await screen.findByRole("dialog", { name: "Add media" });
    await waitFor(() => expect(lastRequest()).toEqual({ kinds: ["video", "audio"], limit: 60 }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add media" })).getByRole("button", { name: "Cancel" }));
    fireEvent.click(adds[0]);
    expect(editor().pickerOpen).toBe("all");
  });

  it("Add media's Add puts the picks in the pane, selects and shows the last, and places nothing", async () => {
    measure(A, B);
    const scrolledTo: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this);
    };
    try {
      await renderOpen();
      await placeable(A, B);
      const opener = within(screen.getByRole("complementary", { name: "Media" })).getByRole("button", { name: "Add media" });
      act(() => opener.focus());
      fireEvent.click(opener);
      const picker = await screen.findByRole("dialog", { name: "Add media" });
      const pick = (name: string) =>
        fireEvent.click(within(picker).getByRole("button", { name: new RegExp(`^${name.replace(/\./g, "\\.")},`) }));
      await within(picker).findByRole("button", { name: /^desert\.mp4,/ });
      pick("desert.mp4");
      pick("music.m4a");
      expect(within(picker).getByText("1 video and 1 audio file")).toBeInTheDocument();
      // Nothing about where clips go: nothing goes on the timeline
      expect(within(picker).queryByText(/goes after|on a new row/)).toBeNull();
      const past = editor().past.length;
      fireEvent.click(within(picker).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull());
      expect(editor().draft!.media).toEqual([A, B, C, M]);
      expect(tileIds()).toEqual([A, B, C, M]);
      expect(timelineIds()).toEqual([A, B]);
      expect(editor().draft!.audioClips).toEqual([]);
      expect(editor().past.length).toBe(past + 1);
      const row = tile(M).closest("li")!;
      expect(row).toHaveAttribute("data-selected");
      expect(scrolledTo).toEqual([row]);
      // Focus goes back to Add media
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("Add media from the empty pane: focus goes to the item it added, its button being gone", async () => {
    await renderOpen(doc({ sequence: { ...doc().sequence, timeline: [] } }));
    const empty = within(screen.getByRole("complementary", { name: "Media" })).getAllByRole("button", { name: "Add media" })[1];
    act(() => empty.focus());
    fireEvent.click(empty);
    const picker = await screen.findByRole("dialog", { name: "Add media" });
    fireEvent.click(await within(picker).findByRole("button", { name: /^desert\.mp4,/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull());
    expect(screen.queryByText("No media yet")).toBeNull();
    expect(tileIds()).toEqual([C]);
    await waitFor(() => expect(tile(C)).toHaveFocus());
  });

  it("the grid: covers two to a row with their length, sounds a row each, in the media's order; the layout is kept", async () => {
    measure(A, B);
    const view = await renderOpen(withMedia({ media: [A, M, B, C] }));
    await placeable(A, B, C, M);
    expect(screen.getByRole("group", { name: "Layout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    expect(storage[PANE_LAYOUT_KEY]).toBe("grid");
    expect(tileIds()).toEqual([A, M, B, C]);
    // A cover shows its length alone at rest (its name waits for keyboard focus); a sound is a row with its name
    const focusName = within(tile(B)).getByTestId("library-tile-focus-name");
    expect(tile(B).textContent!.replace(focusName.textContent!, "")).toBe("0:05");
    expect(focusName).toHaveTextContent(/^beach\.mp4$/);
    expect(focusName).toHaveClass("opacity-0", "group-focus-visible:opacity-100");
    expect(tile(B)).toHaveAccessibleName("Add beach.mp4, 0:05.0, Launch film, at the playhead");
    expect(tile(B)).toHaveAttribute("title", "beach.mp4\nClick to add at the playhead, or drag onto the timeline.");
    expect(tile(M)).toHaveTextContent(/^music\.m4a0:20$/);
    expect(tile(M).closest("li")).toHaveClass("col-span-2");
    // A cover's ⋯ opens over its own column: beach.mp4 starts a row after the sound, desert.mp4 ends it
    expect(openMenu("beach.mp4").parentElement).toHaveClass("left-0");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(openMenu("desert.mp4").parentElement).toHaveClass("right-0");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // A cover renamed: the field lies across its foot, over its picture
    pick(openMenu("desert.mp4"), "Rename");
    const field = await screen.findByRole("textbox", { name: "Rename desert.mp4" });
    const cover = field.closest("li")!;
    expect(cover).toHaveAttribute("data-media-id", C);
    expect(cover.querySelector("img")).toHaveAttribute("src", expect.stringContaining(LIBRARY[C].sha256));
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.keyDown(field, { key: "Escape" });
    expect(tile(C).tagName).toBe("BUTTON");
    // The keys go back to the cover
    expect(tile(C)).toHaveFocus();
    // A cover adds as a row does
    const past = editor().past.length;
    fireEvent.click(tile(C));
    expect(timelineIds()).toEqual([A, C, B]);
    expect(editor().past.length).toBe(past + 1);

    view.unmount();
    act(() => editor().close());
    __resetEditProjectForTests();
    expect(project().pane.layout).toBe("grid");
    await renderOpen(withMedia());
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(storage[PANE_LAYOUT_KEY]).toBe("list");
  });

  it("renames an item in place: Enter writes its name, Escape and an empty name keep it, a refused name says why", async () => {
    measure(A, B);
    assetsApi.patchAsset.mockImplementation(async (id: string, patch: { name: string }) => ({ ...LIBRARY[id], name: patch.name }));
    // The Assets view has the item loaded, among its new arrivals and its selection, and its detail open
    const assetsBefore = useAssetStore.getState();
    act(() =>
      useAssetStore.setState({
        items: [{ id: C, createdAt: T0, kind: "video", asset: LIBRARY[C], page: 0 }],
        arrivals: [LIBRARY[B], LIBRARY[C]],
        selectedRecords: { [B]: LIBRARY[B], [C]: LIBRARY[C] },
        detailId: C,
        detailAsset: LIBRARY[C],
      }),
    );
    try {
      await renderOpen(withMedia());
      await placeable(C);
      fireEvent.dblClick(within(tile(C)).getByText("desert.mp4"));
      const field = await screen.findByRole("textbox", { name: "Rename desert.mp4" });
      expect(field).toHaveValue("desert.mp4");
      expect(field).toHaveAttribute("maxLength", "120");
      expect(field.className).toContain("focus-visible:ring-white/40");
      // Never inside the item's button: the row has none while it is renamed
      expect(field.closest("button")).toBeNull();
      // The field takes the keys, its name selected
      await waitFor(() => expect(field).toHaveFocus());
      fireEvent.change(field, { target: { value: "  Dune  " } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(tile(C)).toHaveTextContent(/^Dune0:05$/));
      expect(assetsApi.patchAsset).toHaveBeenCalledTimes(1);
      expect(assetsApi.patchAsset).toHaveBeenCalledWith(C, { name: "Dune" });
      // It is the library's name now: the cache has it, so a clip of it is called that too, and so does the Assets view
      expect(getAssetInfo(C)?.name).toBe("Dune");
      expect(useAssetStore.getState().items[0].asset?.name).toBe("Dune");
      expect(useAssetStore.getState().arrivals).toEqual([LIBRARY[B], { ...LIBRARY[C], name: "Dune" }]);
      expect(useAssetStore.getState().selectedRecords).toEqual({ [B]: LIBRARY[B], [C]: { ...LIBRARY[C], name: "Dune" } });
      expect(useAssetStore.getState().detailAsset?.name).toBe("Dune");
      // And the edit's snapshot names it so, which its next save sends with nothing else changed
      expect(project().open?.assets[C]?.name).toBe("Dune");
      expect(project().open?.snapshotStale).toBe(true);
      // The keys go back to the item
      expect(tile(C)).toHaveFocus();

      // Escape keeps the name, from the menu's Rename as from a double-click
      pick(openMenu("Dune"), "Rename");
      const again = await screen.findByRole("textbox", { name: "Rename Dune" });
      fireEvent.change(again, { target: { value: "Other" } });
      fireEvent.keyDown(again, { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "Rename Dune" })).toBeNull();
      expect(tile(C)).toHaveTextContent(/^Dune/);
      // So do an empty name and the same name, and none of them sends anything
      for (const value of ["   ", " Dune "]) {
        fireEvent.dblClick(within(tile(C)).getByText("Dune"));
        const same = await screen.findByRole("textbox", { name: "Rename Dune" });
        fireEvent.change(same, { target: { value } });
        fireEvent.keyDown(same, { key: "Enter" });
        await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename Dune" })).toBeNull());
        expect(tile(C)).toHaveTextContent(/^Dune/);
      }
      expect(assetsApi.patchAsset).toHaveBeenCalledTimes(1);

      // Leaving the field commits it
      fireEvent.dblClick(within(tile(C)).getByText("Dune"));
      const left = await screen.findByRole("textbox", { name: "Rename Dune" });
      fireEvent.change(left, { target: { value: "Dunes " } });
      fireEvent.blur(left);
      await waitFor(() => expect(tile(C)).toHaveTextContent(/^Dunes0:05$/));
      expect(assetsApi.patchAsset).toHaveBeenCalledTimes(2);
      expect(assetsApi.patchAsset).toHaveBeenLastCalledWith(C, { name: "Dunes" });

      // Refused: the field stays open, saying why
      assetsApi.patchAsset.mockRejectedValueOnce(new Error("Couldn't reach the asset library."));
      fireEvent.dblClick(within(tile(C)).getByText("Dunes"));
      const refused = await screen.findByRole("textbox", { name: "Rename Dunes" });
      fireEvent.change(refused, { target: { value: "Dune" } });
      fireEvent.keyDown(refused, { key: "Enter" });
      expect(await screen.findByText("Couldn't reach the asset library.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Rename Dunes" })).toBeInTheDocument();
    } finally {
      act(() =>
        useAssetStore.setState({
          items: assetsBefore.items,
          arrivals: assetsBefore.arrivals,
          selectedRecords: assetsBefore.selectedRecords,
          detailId: null,
          detailAsset: null,
        }),
      );
    }
  });

  it("a rename that settles after another item's field opened leaves that field, and its note, alone", async () => {
    measure(A, B);
    let answer: (view: AssetView) => void = () => {};
    let refuse: (error: Error) => void = () => {};
    assetsApi.patchAsset.mockImplementation(
      () =>
        new Promise<AssetView>((resolve, reject) => {
          answer = resolve;
          refuse = reject;
        }),
    );
    await renderOpen(withMedia());
    await placeable(B, C);
    fireEvent.dblClick(within(tile(C)).getByText("desert.mp4"));
    const first = await screen.findByRole("textbox", { name: "Rename desert.mp4" });
    fireEvent.change(first, { target: { value: "Dune" } });
    // Leaving it for beach.mp4's ⋯ commits it; beach.mp4's field opens while that is on its way
    fireEvent.blur(first);
    pick(openMenu("beach.mp4"), "Rename");
    expect(await screen.findByRole("textbox", { name: "Rename beach.mp4" })).toBeInTheDocument();
    await act(async () => answer({ ...LIBRARY[C], name: "Dune" }));
    expect(screen.getByRole("textbox", { name: "Rename beach.mp4" })).toBeInTheDocument();
    expect(tile(C)).toHaveTextContent(/^Dune/);

    // The same for one refused: its note is not put under the other field
    const beach = screen.getByRole("textbox", { name: "Rename beach.mp4" });
    fireEvent.change(beach, { target: { value: "Shore" } });
    fireEvent.blur(beach);
    pick(openMenu("sunset.mp4"), "Rename");
    expect(await screen.findByRole("textbox", { name: "Rename sunset.mp4" })).toBeInTheDocument();
    await act(async () => refuse(new Error("Couldn't reach the asset library.")));
    expect(screen.getByRole("textbox", { name: "Rename sunset.mp4" })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't reach the asset library.")).toBeNull();
  });

  it("⋯ › Remove from edit: at once when no clip uses it; else a sheet says how many clips go, and one undo brings all back", async () => {
    measure(A, B);
    const sequence = {
      ...doc().sequence,
      timeline: [
        createClip({ kind: "asset", assetId: A }, { id: "v1" }),
        createClip({ kind: "asset", assetId: B }, { id: "v2" }),
        createClip({ kind: "asset", assetId: A }, { id: "v3" }),
      ],
    };
    await renderOpen(withMedia({ sequence }));
    await placeable(A, B, C, M);
    const past = editor().past.length;

    act(() => project().selectMedia(C));
    const unused = openMenu("desert.mp4");
    expect(within(unused).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Show in Assets", "Remove from edit"]);
    pick(unused, "Remove from edit");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tileIds()).toEqual([A, B, M]);
    expect(editor().draft!.media).toEqual([A, B, M]);
    expect(editor().past.length).toBe(past + 1);
    // It was the selected item: none is now
    expect(project().mediaFocus.id).toBeNull();

    // Used twice: it asks, Cancel first
    pick(openMenu("sunset.mp4"), "Remove from edit…");
    // Named by its question, which says how many clips go
    const sheet = await screen.findByRole("dialog", { name: "Remove “sunset.mp4” and its 2 clips?" });
    expect(sheet).toHaveTextContent("The file stays in the asset library.");
    expectWhiteRings(sheet);
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Cancel" })).toHaveFocus());
    // The sheet owns the keys: ⌫ deletes no clip under it
    act(() => editor().select({ kind: "clip", clipId: "v2" }));
    press(document.body, "Backspace");
    expect(timelineIds()).toEqual([A, B, A]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tileIds()).toEqual([A, B, M]);

    pick(openMenu("sunset.mp4"), "Remove from edit…");
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Remove “sunset.mp4” and its 2 clips?" })).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(timelineIds()).toEqual([B]);
    expect(tileIds()).toEqual([B, M]);
    expect(editor().past.length).toBe(past + 2);
    act(() => editor().undo());
    expect(timelineIds()).toEqual([A, B, A]);
    expect(tileIds()).toEqual([A, B, M]);

    // One clip: "its clip"
    pick(openMenu("beach.mp4"), "Remove from edit…");
    expect(await screen.findByRole("dialog", { name: "Remove “beach.mp4” and its clip?" })).toBeInTheDocument();
  });

  it("⋯ › Show in Assets opens the Assets view on the item; an item the library lost can only be removed", async () => {
    measure(A, B);
    assetsApi.fetchAsset.mockImplementation(async (id: string) => (id === B ? null : (LIBRARY[id] ?? null)));
    await renderOpen(withMedia());
    await placeable(C);
    await waitFor(() => expect(tile(B)).toBeDisabled());
    const lost = openMenu("Unknown file");
    expect(within(lost).getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(within(lost).getByRole("menuitem", { name: "Show in Assets" })).toBeDisabled();
    expect(within(lost).getByRole("menuitem", { name: "Remove from edit…" })).toBeEnabled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // In the grid it is a blank cover saying so, which nothing can press
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(tile(B)).toHaveAttribute("role", "img");
    expect(tile(B)).toHaveAccessibleName("Unknown file, not in the library");
    expect(tile(B)).toHaveTextContent(/^Not in the library$/);
    fireEvent.click(screen.getByRole("button", { name: "List" }));

    // The Assets view has a page loaded that does not hold it: it opens on it, without taking it in as a new arrival
    act(() => useAssetStore.setState({ status: "ready", loadedQuery: {}, items: [], arrivals: [], total: 9, totalBytes: 100 }));
    try {
      pick(openMenu("desert.mp4"), "Show in Assets");
      const assets = useAssetStore.getState();
      expect(assets.appView).toBe("assets");
      expect(assets.detailId).toBe(C);
      expect(assets.detailAsset?.id).toBe(C);
      expect(assets.items).toEqual([]);
      expect(assets.arrivals).toEqual([]);
      expect(assets.total).toBe(9);
      expect(assets.totalBytes).toBe(100);
    } finally {
      act(() => useAssetStore.setState({ status: "idle", loadedQuery: null, total: 0, totalBytes: 0, detailId: null, detailAsset: null }));
    }
  });

  it("opens an item's ⋯ menu under it while the pane has room there, else over it; a cover's from under the cover", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(C);
    const box = (bottom: number) => ({ top: bottom - 28, bottom, left: 0, right: 28, width: 28, height: 28, x: 0, y: bottom - 28, toJSON: () => ({}) }) as DOMRect;
    const scroller = () => document.querySelector<HTMLElement>("[data-media-scroller]")!;
    vi.spyOn(scroller(), "getBoundingClientRect").mockReturnValue(box(600));
    const row = vi.spyOn(tile(C).closest("li")!, "getBoundingClientRect");
    row.mockReturnValue(box(100));
    expect(openMenu("desert.mp4").parentElement).not.toHaveClass("bottom-full");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    row.mockReturnValue(box(560));
    expect(openMenu("desert.mp4").parentElement).toHaveClass("bottom-full");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    // A cover's menu hangs from the cover's foot, well under its ⋯ at the top: that is where the room is measured
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    vi.spyOn(scroller(), "getBoundingClientRect").mockReturnValue(box(600));
    const cover = vi.spyOn(tile(C).closest("li")!, "getBoundingClientRect");
    vi.spyOn(screen.getByRole("button", { name: "More for desert.mp4" }), "getBoundingClientRect").mockReturnValue(box(455));
    cover.mockReturnValue(box(490));
    expect(openMenu("desert.mp4").parentElement).toHaveClass("bottom-full");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    cover.mockReturnValue(box(300));
    expect(openMenu("desert.mp4").parentElement).not.toHaveClass("bottom-full");
  });

  it("selects the item a click adds, and scrolls to one revealed, also when the pane is shown again", async () => {
    measure(A, B);
    const scrolledTo: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this);
    };
    try {
      await renderOpen(withMedia());
      await placeable(C, M);
      const row = (id: string) => tile(id).closest("li")!;
      fireEvent.click(tile(C));
      expect(row(C)).toHaveAttribute("data-selected");
      expect(project().mediaFocus.id).toBe(C);
      expect(scrolledTo).toEqual([]);

      act(() => project().revealMedia(M));
      expect(row(M)).toHaveAttribute("data-selected");
      expect(row(C)).not.toHaveAttribute("data-selected");
      expect(scrolledTo).toEqual([row(M)]);

      fireEvent.click(screen.getByRole("button", { name: "Hide media" }));
      fireEvent.click(screen.getByRole("button", { name: "Show media" }));
      expect(scrolledTo).toEqual([expect.anything(), row(M)]);
      expect(row(M)).toHaveAttribute("data-selected");
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("is open unless it was hidden, which is remembered", async () => {
    storage[LIBRARY_PANE_KEY] = "closed";
    __resetEditProjectForTests();
    await renderOpen();
    expect(screen.queryByRole("complementary", { name: "Media" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show media" }));
    expect(screen.getByRole("complementary", { name: "Media" })).toBeInTheDocument();
    expect(storage[LIBRARY_PANE_KEY]).toBe("open");
  });

  it("Add from the timeline's + or + Audio with the pane hidden shows the pane, the last pick selected and scrolled to", async () => {
    measure(A, B);
    storage[LIBRARY_PANE_KEY] = "closed";
    __resetEditProjectForTests();
    const scrolledTo: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this);
    };
    try {
      await renderOpen();
      expect(screen.queryByRole("complementary", { name: "Media" })).toBeNull();
      fireEvent.click(screen.getByTestId("stitch-add-slot"));
      const picker = await screen.findByRole("dialog", { name: "Add media" });
      fireEvent.click(await within(picker).findByRole("button", { name: /^sunset\.mp4,/ }));
      fireEvent.click(within(picker).getByRole("button", { name: /^desert\.mp4,/ }));
      fireEvent.click(within(picker).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull());
      expect(screen.getByRole("complementary", { name: "Media" })).toBeInTheDocument();
      expect(storage[LIBRARY_PANE_KEY]).toBe("open");
      expect(tileIds()).toEqual([A, B, C]);
      expect(tile(C).closest("li")).toHaveAttribute("data-selected");
      expect(scrolledTo).toEqual([tile(C).closest("li")]);
      // Nothing went on the timeline
      expect(timelineIds()).toEqual([A, B]);

      fireEvent.click(screen.getByRole("button", { name: "Hide media" }));
      fireEvent.click(screen.getByRole("button", { name: "Add audio" }));
      const audioPicker = await screen.findByRole("dialog", { name: "Add media" });
      fireEvent.click(await within(audioPicker).findByRole("button", { name: /^music\.m4a,/ }));
      fireEvent.click(within(audioPicker).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull());
      expect(screen.getByRole("complementary", { name: "Media" })).toBeInTheDocument();
      expect(tileIds()).toEqual([A, B, C, M]);
      expect(tile(M).closest("li")).toHaveAttribute("data-selected");
      expect(editor().draft!.audioClips).toEqual([]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("Remove from edit asks with the whole question, a long name wrapping, and names the sheet by it", async () => {
    measure(A, B);
    const long = "143022_cinematic-drone-over-the-coastline-at-golden-hour_1a2b3c4d.mp4";
    assetsApi.fetchAsset.mockImplementation(async (id: string) => (id === A ? { ...LIBRARY[A], filename: long } : (LIBRARY[id] ?? null)));
    const sequence = {
      ...doc().sequence,
      timeline: ["v1", "v2", "v3"].map((id) => createClip({ kind: "asset", assetId: A }, { id })),
    };
    await renderOpen(withMedia({ sequence }));
    await placeable(A);
    pick(openMenu(long), "Remove from edit…");
    const question = `Remove “${long}” and its 3 clips?`;
    const sheet = await screen.findByRole("dialog", { name: question });
    const title = within(sheet).getByRole("heading", { level: 2 });
    expect(title).toHaveTextContent(question);
    // It wraps, breaking the name where it must, so the count is never cut off
    expect(title).not.toHaveClass("truncate");
    expect(title).toHaveClass("[overflow-wrap:anywhere]");
    expect(sheet).toHaveTextContent("The file stays in the asset library.");
  });

  describe("after Remove from edit, focus goes to the next item, else the one before, else Add media", () => {
    const focusTarget = (id: string) => tile(id).closest("li")!.querySelector<HTMLElement>("button[data-asset-id]");
    const removeFrom = async (name: string, used: boolean) => {
      const trigger = screen.getByRole("button", { name: `More for ${name}` });
      act(() => trigger.focus());
      pick(openMenu(name), used ? "Remove from edit…" : "Remove from edit");
      if (used) {
        const sheet = await screen.findByRole("dialog", { name: new RegExp(`^Remove “${name.replace(/\./g, "\\.")}”`) });
        await waitFor(() => expect(within(sheet).getByRole("button", { name: "Cancel" })).toHaveFocus());
        fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
    };

    it("in the list, from the menu and from the sheet", async () => {
      measure(A, B);
      await renderOpen(withMedia());
      await placeable(A, B, C, M);
      // desert.mp4, unused: the next item, music.m4a
      await removeFrom("desert.mp4", false);
      expect(tileIds()).toEqual([A, B, M]);
      await waitFor(() => expect(focusTarget(M)).toHaveFocus());
      // music.m4a, the last: the one before, beach.mp4
      await removeFrom("music.m4a", false);
      await waitFor(() => expect(focusTarget(B)).toHaveFocus());
      // sunset.mp4, through its sheet: the next, beach.mp4
      await removeFrom("sunset.mp4", true);
      expect(tileIds()).toEqual([B]);
      await waitFor(() => expect(focusTarget(B)).toHaveFocus());
      // beach.mp4, the only one left: Add media
      await removeFrom("beach.mp4", true);
      expect(screen.getByText("No media yet")).toBeInTheDocument();
      const pane = screen.getByRole("complementary", { name: "Media" });
      await waitFor(() => expect(within(pane).getAllByRole("button", { name: "Add media" })[0]).toHaveFocus());
    });

    it("in the grid, onto a sound's row and a cover", async () => {
      measure(A, B);
      await renderOpen(withMedia());
      await placeable(A, B, C, M);
      fireEvent.click(screen.getByRole("button", { name: "Grid" }));
      await removeFrom("desert.mp4", false);
      await waitFor(() => expect(focusTarget(M)).toHaveFocus());
      await removeFrom("music.m4a", false);
      await waitFor(() => expect(tile(B)).toHaveFocus());
      expect(tile(B).tagName).toBe("BUTTON");
      // Cancel leaves it on the ⋯ that opened the sheet
      const trigger = screen.getByRole("button", { name: "More for sunset.mp4" });
      act(() => trigger.focus());
      pick(openMenu("sunset.mp4"), "Remove from edit…");
      const sheet = await screen.findByRole("dialog", { name: /^Remove “sunset\.mp4”/ });
      fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(trigger).toHaveFocus());
      await removeFrom("sunset.mp4", true);
      await waitFor(() => expect(tile(B)).toHaveFocus());
    });
  });

  it("takes the editor's white ring on keyboard focus, and shows ⋯ on hover or focus, in the list and the grid", async () => {
    measure(A, B);
    await renderOpen(withMedia());
    await placeable(C, M);
    const ring = [
      "has-[[data-media-add]:focus-visible]:ring-2",
      "has-[[data-media-add]:focus-visible]:ring-inset",
      "has-[[data-media-add]:focus-visible]:ring-white/40",
    ];
    for (const id of [C, M]) {
      const row = tile(id).closest("li")!;
      expect(row).toHaveClass("group/row", ...ring);
      expect(within(row).getByRole("button", { name: /^More for / })).toHaveClass(
        "opacity-0",
        "group-hover/row:opacity-100",
        "group-focus-within/row:opacity-100",
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    // A cover rings itself; a sound is still a row
    const cover = tile(C).closest("li")!;
    expect(tile(C)).toHaveClass("focus-visible:ring-2", "focus-visible:ring-white/40");
    expect(cover).toHaveClass("group/tile");
    expect(within(cover).getByRole("button", { name: "More for desert.mp4" })).toHaveClass(
      "opacity-0",
      "group-hover/tile:opacity-100",
      "group-focus-within/tile:opacity-100",
    );
    const sound = tile(M).closest("li")!;
    expect(sound).toHaveClass("group/row", ...ring);
    expect(within(sound).getByRole("button", { name: "More for music.m4a" })).toHaveClass("group-focus-within/row:opacity-100");
  });

  describe("a video with no poster", () => {
    /** IntersectionObserver for the covers: none on screen until `show` says so. */
    function stubObserver() {
      const observed = new Map<Element, (visible: boolean) => void>();
      class Observer {
        constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
        observe(el: Element) {
          observed.set(el, (visible) => this.callback([{ isIntersecting: visible }]));
        }
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("IntersectionObserver", Observer);
      return {
        show: (inside: Element) => {
          const el = Array.from(observed.keys()).find((observedEl) => inside === observedEl || inside.contains(observedEl));
          act(() => observed.get(el!)!(true));
        },
        restore: () => {
          delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
        },
      };
    }
    const src = (id: string) => tile(id).querySelector("img")!.getAttribute("src");
    const ready = (id: string) => act(() => poster.listeners.forEach((listener) => listener(id)));

    for (const layout of ["List", "Grid"] as const) {
      it(`gets one made once it is on screen, and shows it when it is (${layout.toLowerCase()})`, async () => {
        measure(A, B);
        if (layout === "Grid") storage[PANE_LAYOUT_KEY] = "grid";
        __resetEditProjectForTests();
        assetsApi.fetchAsset.mockImplementation(async (id: string) =>
          id === C ? { ...LIBRARY[C], hasPoster: false } : (LIBRARY[id] ?? null),
        );
        const observers = stubObserver();
        try {
          await renderOpen(withMedia());
          await placeable(C);
          expect(screen.getByRole("button", { name: layout })).toHaveAttribute("aria-pressed", "true");
          expect(src(C)).not.toContain("poster=1");
          expect(poster.ensurePoster).not.toHaveBeenCalled();
          observers.show(tile(C));
          await waitFor(() => expect(poster.ensurePoster).toHaveBeenCalledWith(expect.objectContaining({ id: C }), expect.anything()));
          expect(poster.ensurePoster).toHaveBeenCalledTimes(1);
          ready(C);
          // The URL a cover with a poster has from the start
          expect(src(C)).toBe(src(A)!.replace(LIBRARY[A].sha256, LIBRARY[C].sha256));
          expect(src(C)).toContain("poster=1");
        } finally {
          observers.restore();
        }
      });
    }
  });
});

describe("dropping files on the media pane", () => {
  const X = "aupldaaaaaaaa1";
  const Y = "aupldaaaaaaaa2";
  const pane = () => screen.getByRole("complementary", { name: "Media" });
  /** A drag from the Finder, as jsdom can carry one: a plain object for the DataTransfer it lacks. */
  const fileDrag = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files, dropEffect: "none" } });
  const video = (name: string) => new File(["v"], name, { type: "video/mp4" });
  const pendingRows = () => Array.from(document.querySelectorAll<HTMLElement>("aside [data-media-pending]"));
  /** An upload's record: the library names its file itself; the dropped file's name is its display name. */
  const uploaded = (id: string, name: string, overrides: Partial<AssetView> = {}) =>
    asset(id, { origin: "uploaded", filename: `142233_${id}.mp4`, name, ...overrides });
  /** Each recordUpload's answer, settled by the test. */
  function answers() {
    const calls: { resolve: (asset: AssetView) => void; reject: (error: Error) => void }[] = [];
    uploadsApi.recordUpload.mockImplementation(() => new Promise((resolve, reject) => calls.push({ resolve, reject })));
    return calls;
  }

  it("a file drag over it frames it and says Drop to add, its media still shown; leaving lets go; other drags are left alone", async () => {
    await renderOpen(withMedia());
    await placeable(C);
    const aside = pane();
    expect(screen.queryByText("Drop to add")).toBeNull();
    fireEvent.dragEnter(aside, fileDrag());
    expect(screen.getByText("Drop to add")).toBeInTheDocument();
    expect(aside).toHaveClass("ring-1", "ring-inset");
    expect(tileIds()).toEqual([A, B, C, M]);
    const over = fileDrag();
    expect(fireEvent.dragOver(tile(C), over)).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    // Into a row and out of it is still over the pane
    fireEvent.dragEnter(tile(C), fileDrag());
    fireEvent.dragLeave(tile(C), fileDrag());
    expect(screen.getByText("Drop to add")).toBeInTheDocument();
    fireEvent.dragLeave(aside, fileDrag());
    expect(screen.queryByText("Drop to add")).toBeNull();
    expect(aside).not.toHaveClass("ring-1");

    // Text dragged in is no file: the pane takes no part
    const text = { dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" } };
    fireEvent.dragEnter(aside, text);
    expect(fireEvent.dragOver(aside, text)).toBe(true);
    expect(screen.queryByText("Drop to add")).toBeNull();
    expect(fireEvent.drop(aside, text)).toBe(true);
    expect(uploadsApi.recordUpload).not.toHaveBeenCalled();

    // A drag that never says it left (a row replaced under it) lets go once dragover stops
    vi.useFakeTimers();
    try {
      fireEvent.dragEnter(tile(C), fileDrag());
      act(() => vi.advanceTimersByTime(900));
      fireEvent.dragOver(tile(C), fileDrag());
      act(() => vi.advanceTimersByTime(900));
      expect(screen.getByText("Drop to add")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByText("Drop to add")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the videos and sounds dropped at once: one notice for the rest, an Adding… row each, then each joins the media", async () => {
    await renderOpen(withMedia());
    await placeable(A, B, C, M);
    const calls = answers();
    const first = video("first take.mp4");
    const second = video("second take.mp4");
    toast.mockClear();
    fireEvent.dragEnter(pane(), fileDrag());
    expect(fireEvent.drop(pane(), fileDrag([first, new File(["t"], "notes.txt", { type: "text/plain" }), second]))).toBe(false);
    expect(screen.queryByText("Drop to add")).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Only video and audio files can be added.", "info");
    expect(uploadsApi.recordUpload.mock.calls).toEqual([
      [first, { editId: ID, editName: "Trip" }],
      [second, { editId: ID, editName: "Trip" }],
    ]);
    // After the media, in the order dropped, with nothing to press, drag or open yet
    expect(tileIds()).toEqual([A, B, C, M]);
    expect(pendingRows().map((row) => row.textContent)).toEqual(["first take.mp4Adding…", "second take.mp4Adding…"]);
    expect(pendingRows()[0].querySelector("button")).toBeNull();
    // Still there once the pane is hidden and shown again
    fireEvent.click(screen.getByRole("button", { name: "Hide media" }));
    fireEvent.click(screen.getByRole("button", { name: "Show media" }));
    expect(pendingRows()).toHaveLength(2);
    // In the grid a video is a blank cover saying so
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(pendingRows()[0]).toHaveTextContent(/^first take\.mp4Adding…$/);
    expect(pendingRows()[0].querySelector(".aspect-video")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "List" }));

    const past = editor().past.length;
    await act(async () => calls[0].resolve(uploaded(X, "first take.mp4")));
    expect(pendingRows().map((row) => row.textContent)).toEqual(["second take.mp4Adding…"]);
    expect(tileIds()).toEqual([A, B, C, M, X]);
    await act(async () => calls[1].resolve(uploaded(Y, "second take.mp4")));
    expect(pendingRows()).toEqual([]);
    expect(editor().draft!.media).toEqual([A, B, C, M, X, Y]);
    expect(tileIds()).toEqual([A, B, C, M, X, Y]);
    expect(tile(X)).toHaveTextContent(/^first take\.mp40:05$/);
    expect(tile(Y)).toHaveAccessibleName("Add second take.mp4, 0:05.0, at the playhead");
    // The last one in is selected; each was one undo step, and nothing went on the timeline
    expect(tile(Y).closest("li")).toHaveAttribute("data-selected");
    expect(editor().past.length).toBe(past + 2);
    expect(timelineIds()).toEqual([A, B]);
    act(() => editor().undo());
    expect(tileIds()).toEqual([A, B, C, M, X]);
  });

  it("a file that can't be added says why, with its name, and its row goes; with the library off too", async () => {
    applyLibraryStatus(status(false));
    await renderOpen(withMedia());
    const calls = answers();
    fireEvent.drop(pane(), fileDrag([video("sunset copy.mp4")]));
    expect(pendingRows()).toHaveLength(1);
    await act(async () => calls[0].reject(new Error("The asset library is off.")));
    expect(toast).toHaveBeenCalledWith("Couldn't add “sunset copy.mp4”", "error", false, "The asset library is off.");
    expect(pendingRows()).toEqual([]);
    expect(editor().draft!.media).toEqual([A, B, C, M]);
  });

  it("files join in the order they were dropped, whichever is recorded first", async () => {
    await renderOpen(withMedia());
    await placeable(A);
    const calls = answers();
    fireEvent.drop(pane(), fileDrag([video("big.mov"), video("small.mp4")]));
    const past = editor().past.length;
    await act(async () => calls[1].resolve(uploaded(Y, "small.mp4")));
    // small.mp4 waits its turn behind big.mov
    expect(tileIds()).toEqual([A, B, C, M]);
    expect(pendingRows().map((row) => row.textContent)).toEqual(["big.movAdding…", "small.mp4Adding…"]);
    await act(async () => calls[0].resolve(uploaded(X, "big.mov")));
    expect(pendingRows()).toEqual([]);
    expect(tileIds()).toEqual([A, B, C, M, X, Y]);
    expect(editor().past.length).toBe(past + 1);
    expect(tile(Y).closest("li")).toHaveAttribute("data-selected");
  });

  it("a file on its way shows only in the edit it was dropped on, there again when that edit is", async () => {
    const other = doc({ id: OTHER, name: "Launch cut" });
    await renderOpen(withMedia());
    const calls = answers();
    edits.fetchEdit.mockImplementation(async (id: string) => (id === OTHER ? other : withMedia()));
    fireEvent.drop(pane(), fileDrag([video("late.mp4")]));
    expect(pendingRows()).toHaveLength(1);

    await act(async () => project().openEditById(OTHER));
    await waitFor(() => expect(editor().editId).toBe(OTHER));
    expect(tileIds()).toEqual([A, B]);
    expect(pendingRows()).toEqual([]);

    await act(async () => project().openEditById(ID));
    await waitFor(() => expect(editor().editId).toBe(ID));
    expect(pendingRows().map((row) => row.textContent)).toEqual(["late.mp4Adding…"]);
    await act(async () => calls[0].resolve(uploaded(X, "late.mp4")));
    expect(tileIds()).toEqual([A, B, C, M, X]);
  });

  it("a file on its way follows its edit when that is saved as a new edit", async () => {
    const NEW = "ed0000000000c3";
    await renderOpen(withMedia());
    const calls = answers();
    fireEvent.drop(pane(), fileDrag([video("late.mp4")]));
    act(() => setLoopCount(2));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("gone", 404, "not_found"));
    await act(async () => void (await project().saveNow("manual")));
    edits.createEdit.mockResolvedValueOnce(withMedia({ id: NEW, updatedAt: 4000 }));
    fireEvent.click(screen.getByRole("button", { name: "Save as a new edit" }));
    await waitFor(() => expect(editor().editId).toBe(NEW));
    expect(pendingRows().map((row) => row.textContent)).toEqual(["late.mp4Adding…"]);
    await act(async () => calls[0].resolve(uploaded(X, "late.mp4")));
    expect(pendingRows()).toEqual([]);
    expect(editor().draft!.media).toEqual([A, B, C, M, X]);
  });

  it("a sheet the pane opens takes no file drop, though it is the pane's", async () => {
    await renderOpen(withMedia());
    await placeable(A);
    fireEvent.click(screen.getByRole("button", { name: "More for sunset.mp4" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "sunset.mp4" })).getByRole("menuitem", { name: "Remove from edit…" }));
    const sheet = await screen.findByRole("dialog", { name: /^Remove “sunset\.mp4”/ });
    fireEvent.dragEnter(sheet, fileDrag());
    expect(fireEvent.dragOver(sheet, fileDrag())).toBe(true);
    expect(screen.queryByText("Drop to add")).toBeNull();
    expect(fireEvent.drop(sheet, fileDrag([video("stray.mp4")]))).toBe(true);
    expect(uploadsApi.recordUpload).not.toHaveBeenCalled();
  });

  it("a file whose bytes the edit holds already adds nothing, and shows the one there", async () => {
    await renderOpen(withMedia());
    await placeable(A);
    const calls = answers();
    const past = editor().past.length;
    fireEvent.drop(pane(), fileDrag([video("sunset.mp4")]));
    await act(async () => calls[0].resolve(uploaded(X, "sunset.mp4", { sha256: LIBRARY[A].sha256 })));
    expect(pendingRows()).toEqual([]);
    expect(editor().draft!.media).toEqual([A, B, C, M]);
    expect(editor().past.length).toBe(past);
    expect(tile(A).closest("li")).toHaveAttribute("data-selected");
  });

  it("in the grid, a file on its way and one the library lost are the same dimmed cover, each with its note", async () => {
    measure(A, B);
    assetsApi.fetchAsset.mockImplementation(async (id: string) => (id === B ? null : (LIBRARY[id] ?? null)));
    await renderOpen(withMedia());
    await waitFor(() => expect(tile(B)).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    fireEvent.drop(pane(), fileDrag([video("late.mp4")]));
    const pending = pendingRows()[0].firstElementChild as HTMLElement;
    const lost = tile(B);
    expect(lost.className).toBe(pending.className);
    expect(lost.firstElementChild!.className).toBe(pending.firstElementChild!.className);
    // The note at the foot: "Not in the library" as "Adding…" is, the one chip both draw
    const note = within(lost).getByText("Not in the library");
    expect(note.className).toBe(within(pending).getByText("Adding…").className);
    expect(note).toHaveClass("font-normal", "text-neutral-300");
    // A file on its way shows its name at the top; a lost one is named by its label and tooltip
    expect(within(pending).getByText("late.mp4")).toBeInTheDocument();
    expect(lost).toHaveTextContent(/^Not in the library$/);
  });

  it("the empty pane takes a drop too", async () => {
    await renderOpen(doc({ sequence: { ...doc().sequence, timeline: [] } }));
    const calls = answers();
    const empty = screen.getByText("No media yet");
    fireEvent.dragEnter(empty, fileDrag());
    expect(screen.getByText("Drop to add")).toBeInTheDocument();
    expect(fireEvent.dragOver(empty, fileDrag())).toBe(false);
    fireEvent.drop(empty, fileDrag([new File(["a"], "voice.m4a", { type: "audio/mp4" })]));
    expect(screen.queryByText("No media yet")).toBeNull();
    expect(screen.queryByText("Drop to add")).toBeNull();
    expect(pendingRows().map((row) => row.textContent)).toEqual(["voice.m4aAdding…"]);
    // A sound's glyph for a cover, never a video's blank one; in the grid a whole row, no cover
    expect(pendingRows()[0].querySelector(".bg-edit-slot")).not.toBeNull();
    expect(pendingRows()[0].querySelector(".bg-edit-field")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(pendingRows()[0]).toHaveClass("col-span-2");
    expect(pendingRows()[0]).toHaveTextContent(/^voice\.m4aAdding…$/);
    expect(pendingRows()[0].querySelector(".aspect-video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const voice = { kind: "audio" as const, mime: "audio/mp4", ext: "m4a", durationSec: 12, width: undefined, height: undefined };
    await act(async () => calls[0].resolve(uploaded(X, "voice.m4a", voice)));
    expect(tileIds()).toEqual([X]);
    expect(tile(X)).toHaveTextContent(/^voice\.m4a0:12$/);
  });

  it("a file recorded after the edit was left joins its media when the edit shows again", async () => {
    const view = await renderOpen(withMedia());
    const calls = answers();
    fireEvent.drop(pane(), fileDrag([video("late.mp4")]));
    // Leaving the view parks the edit
    view.unmount();
    expect(editor().isOpen).toBe(false);
    await act(async () => calls[0].resolve(uploaded(X, "late.mp4")));
    expect(useMediaUploads.getState().uploads.map((upload) => upload.asset?.id)).toEqual([X]);

    render(<EditVideoView />);
    await screen.findByRole("button", { name: "Edit menu" });
    await waitFor(() => expect(tileIds()).toEqual([A, B, C, M, X]));
    expect(useMediaUploads.getState().uploads).toEqual([]);
    expect(tile(X).closest("li")).toHaveAttribute("data-selected");
    // An unsaved change of the edit's, one undo step
    act(() => editor().undo());
    expect(tileIds()).toEqual([A, B, C, M]);
  });
});

describe("copy, cut and paste", () => {
  it("⌘C and ⌘V copy a clip and paste it after the selection, ⌘X cuts, each one undo step", async () => {
    measure(A, B);
    await renderOpen();
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    press(document.body, "c", { metaKey: true });
    expect(useStitchClipboard.getState().clipboard).toMatchObject({ origin: { kind: "edit", editId: ID }, items: [{ source: { kind: "asset", assetId: A } }] });
    const past = editor().past.length;
    press(document.body, "v", { metaKey: true });
    expect(timelineIds()).toEqual([A, A, B]);
    expect(editor().past.length).toBe(past + 1);

    act(() => editor().select({ kind: "clip", clipId: "v2" }));
    press(document.body, "x", { metaKey: true });
    expect(timelineIds()).toEqual([A, A]);
    expect(editor().past.length).toBe(past + 2);
    expect(useStitchClipboard.getState().clipboard?.items).toMatchObject([{ source: { kind: "asset", assetId: B } }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("the clip menu's Copy, Cut and Paste work in the view", async () => {
    measure(A, B);
    await renderOpen();
    act(() => {
      editor().select({ kind: "clip", clipId: "v2" });
      editor().openMenu({ kind: "clip", clipId: "v2", x: 10, y: 10 });
    });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Copy/ }));
    act(() => editor().openMenu({ kind: "clip", clipId: "v1", x: 10, y: 10 }));
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Paste/ }));
    expect(timelineIds()).toEqual([A, B, B]);
    act(() => editor().openMenu({ kind: "clip", clipId: "v1", x: 10, y: 10 }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Cut/ }));
    expect(timelineIds()).toEqual([B, B]);
  });

  it("pastes a node's library clips into the edit and says why its connected videos were left out", async () => {
    measure(A, B);
    await renderOpen();
    act(() => {
      useStitchClipboard.getState().setClipboard({
        origin: { kind: "node", nodeId: "s1", tabId: "t1", workflowId: "w1" },
        items: [
          { track: "video", source: { kind: "edge", edgeId: "e1" }, inSec: 0, outSec: null, muted: false, volume: 1, offsetSec: 0 },
          { track: "video", source: { kind: "asset", assetId: C }, inSec: 1, outSec: 3, muted: false, volume: 1, offsetSec: 5 },
          { track: "video", source: { kind: "edge", edgeId: "e2" }, inSec: 0, outSec: null, muted: false, volume: 1, offsetSec: 7 },
        ],
      });
      editor().select({ kind: "clip", clipId: "v2" });
    });
    press(document.body, "v", { metaKey: true });
    expect(timelineIds()).toEqual([A, B, C]);
    expect(editor().draft!.timeline[2]).toMatchObject({ inSec: 1, outSec: 3 });
    expect(toast).toHaveBeenCalledWith(
      "2 clips not pasted: an edit holds only clips from the library, not connected videos or music.",
      "info",
    );
  });
});

describe("the header", () => {
  it("leads with Edits › the name: Edits goes home, the name renames, and the save word follows it", async () => {
    await renderOpen();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edits", "Trip"]);
    expect(crumb.nextElementSibling).toBe(screen.getByTestId("edit-save-state"));
    fireEvent.click(within(crumb).getByRole("button", { name: "Edits" }));
    await screen.findByRole("button", { name: "New edit" });
    expect(editor().isOpen).toBe(false);
    // Back home, focus is on the newest edit
    await waitFor(() => expect(screen.getByRole("button", { name: /^Open Trip/ })).toHaveFocus());
  });

  it("back home from an edit that was not the newest, once saved, starts on it as the list read again puts it first", async () => {
    const other = doc({ id: OTHER, name: "Launch cut", updatedAt: 5000 });
    storage[LAST_EDIT_KEY] = ID;
    edits.fetchEdit.mockResolvedValue(doc());
    edits.fetchEditList.mockResolvedValue(listOf([other, doc()]));
    render(<EditVideoView />);
    await screen.findByRole("button", { name: "Edit menu" });
    // Trip was saved since the list was read: the home shows the old list until the read on the way home lands
    let land!: (list: ReturnType<typeof listOf>) => void;
    edits.fetchEditList.mockReturnValue(new Promise((resolve) => (land = resolve)));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Edits" }));
    await screen.findByRole("button", { name: "New edit" });
    expect(screen.getByRole("button", { name: /^Open Launch cut/ })).toHaveFocus();
    await act(async () => land(listOf([doc({ updatedAt: 9000 }), other])));
    const trip = screen.getByRole("button", { name: /^Open Trip/ });
    expect(trip).toHaveFocus();
    expect(trip.closest("li")).toHaveAttribute("data-active");
    expect(document.querySelector("[data-edit-preview]")).toHaveAttribute("data-edit-preview", ID);
  });

  it("shows Save only with Save automatically off; ⌘S saves either way", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: true });
    await renderOpen();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Render" })).toBeInTheDocument();
    act(() => useWorkflowStore.setState({ autoSaveEnabled: false }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    act(() => setLoopCount(2));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("while rendering, Rendering N% and Stop take Save and Render's place, over a progress line", async () => {
    measure(A, B);
    await renderOpen();
    act(() => project().setRenderState({ state: "rendering", editId: ID, progress: 40.4 }));
    expect(screen.getByText("Rendering 40%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Rendering" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByTestId("edit-render-slot")).toBeNull();
    // Stop ends the header, where Render did
    expect(screen.getByRole("button", { name: "Stop" }).parentElement!.nextElementSibling).toBe(
      screen.getByRole("progressbar", { name: "Rendering" }),
    );
    act(() => project().setRenderState({ state: "idle", editId: null, progress: 0 }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("edit-render-slot")).toBeInTheDocument();
  });

  it("Show media sits first while the pane is hidden", async () => {
    await renderOpen();
    expect(screen.queryByRole("button", { name: "Show media" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide media" }));
    expect(screen.queryByRole("complementary", { name: "Media" })).toBeNull();
    const show = screen.getByRole("button", { name: "Show media" });
    expect(show.closest("[data-edit-chrome]")!.firstElementChild!.contains(show)).toBe(true);
    fireEvent.click(show);
    expect(screen.getByRole("complementary", { name: "Media" })).toBeInTheDocument();
  });
});

describe("the edit menu", () => {
  it("holds Rename, Duplicate, Show in Finder, Loop and Delete…, then what the sequence is", async () => {
    measure(A, B);
    await renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    const menu = screen.getByRole("menu", { name: "Edit menu" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label") ?? item.textContent);
    // New edit and the other edits are on the home, behind the breadcrumb's Edits
    expect(names).toEqual(["Rename", "Duplicate", "Show in Finder", "Loop: Off", "Delete…"]);
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    expect(menu).toHaveAccessibleDescription("2 clips · 1280 × 720 · 24 fps");
    // Rename opens the name's field in place, and the field keeps the focus it takes
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const field = await screen.findByRole("textbox", { name: "Edit name" });
    expect(field).toHaveValue("Trip");
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("Loop is a set of radios: picking one sets the loop count as one undo step", async () => {
    await renderOpen();
    const trigger = screen.getByRole("button", { name: "Edit menu" });
    fireEvent.click(trigger);
    // Its row reads Off at 1×, where nothing repeats, and so does the radio it names
    const row = within(screen.getByRole("menu", { name: "Edit menu" })).getByRole("menuitem", { name: "Loop: Off" });
    expect(row).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.keyDown(row, { key: "ArrowRight" });
    const loop = screen.getByRole("menu", { name: "Loop" });
    const radios = within(loop).getAllByRole("menuitemradio");
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["Off", "true"],
      ["2×", "false"],
      ["3×", "false"],
    ]);
    expect(radios[0]).toHaveFocus();
    // ← goes back to Loop's row, Enter opens it again
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Loop" })).toBeNull();
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: "Enter" });
    const past = editor().past.length;
    fireEvent.click(within(screen.getByRole("menu", { name: "Loop" })).getByRole("menuitemradio", { name: "3×" }));
    expect(editor().draft!.loopCount).toBe(3);
    expect(editor().past).toHaveLength(past + 1);
    expect(screen.queryByRole("menu")).toBeNull();
    // Focus goes back to ⋯, not to <body>
    expect(trigger).toHaveFocus();
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Unsaved");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Loop: 3×" })).toBeInTheDocument();
  });

  it("keeps Loop's submenu a moment after the pointer leaves its row, so the pointer can cross a row into it", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    const row = screen.getByRole("menuitem", { name: /^Loop/ }).parentElement!;
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    // Arriving in the submenu keeps it
    fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: "2×" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Loop" })).toBeNull());
    expect(screen.getByRole("menu", { name: "Edit menu" })).toBeInTheDocument();
    // The hover had put focus in the submenu; it is back on Loop's row, so the menu's keys still work
    expect(screen.getByRole("menuitem", { name: /^Loop/ })).toHaveFocus();
    press(document.activeElement!, "Escape");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a click on Loop's row keeps open the submenu the hover opened", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    const loop = screen.getByRole("menuitem", { name: /^Loop/ });
    fireEvent.mouseEnter(loop.parentElement!);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.click(loop);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.click(loop);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    expect(loop).toHaveAttribute("aria-expanded", "true");
  });

  it("Loop says each loop plays the audio clips again while it does", async () => {
    const withAudio = doc({
      sequence: { ...doc().sequence, loopCount: 2, audioClips: [createAudioClip({ kind: "asset", assetId: M }, { id: "a1" })] },
    });
    await renderOpen(withAudio);
    const showLoop = () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
      fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /^Loop/ }).parentElement!);
      return screen.getByRole("menu", { name: "Loop" });
    };
    expect(showLoop()).toHaveAccessibleDescription(LOOP_AUDIO_NOTE);
    fireEvent.click(within(screen.getByRole("menu", { name: "Loop" })).getByRole("menuitemradio", { name: "Off" }));
    expect(showLoop()).not.toHaveAttribute("aria-describedby");
  });

  it("Delete… asks, then sends the edit to the Trash and goes home", async () => {
    await renderOpen();
    edits.deleteEdit.mockResolvedValue(undefined);
    edits.fetchEditList.mockResolvedValue(listOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete…" }));
    const sheet = await screen.findByRole("dialog", { name: "Delete edit?" });
    expect(sheet).toHaveTextContent("Delete “Trip”?");
    expectWhiteRings(sheet);
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(edits.deleteEdit).toHaveBeenCalledWith(ID));
    await screen.findByText("An edit puts videos and audio from any project on one timeline.");
    expect(editor().isOpen).toBe(false);
  });

  it("with Save automatically off, switching away from changes asks first", async () => {
    await renderOpen();
    act(() => setLoopCount(2));
    const home = () => within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Edits" });
    fireEvent.click(home());
    const sheet = await screen.findByRole("dialog", { name: "Save changes?" });
    expect(sheet).toHaveTextContent("Save changes to “Trip”?");
    expectWhiteRings(sheet);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(editor().editId).toBe(ID);
    expect(editor().draft!.loopCount).toBe(2);

    fireEvent.click(home());
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Save changes?" })).getByRole("button", { name: "Don't save" }));
    await screen.findByRole("button", { name: "New edit" });
    expect(editor().isOpen).toBe(false);
    expect(edits.saveEdit).not.toHaveBeenCalled();
  });
});
