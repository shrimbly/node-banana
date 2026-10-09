import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AssetFacets, AssetPage, AssetView, LibraryStatus } from "@/lib/assets/types";

const api = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(),
  fetchFacets: vi.fn(),
  fetchLibraryStatus: vi.fn(),
  bulkAssets: vi.fn(),
  revealAsset: vi.fn(),
  revealLibraryRoot: vi.fn(),
  fetchAssetBlob: vi.fn(),
  startExport: vi.fn(),
  startImport: vi.fn(),
  fetchJob: vi.fn(),
  cancelJob: vi.fn(),
  fetchProjects: vi.fn(),
  bringInProjects: vi.fn(),
  dismissProjectsOffer: vi.fn(),
  assetFileUrl: (id: string, download = false) => `/api/assets/${id}/file${download ? "?download=1" : ""}`,
  assetThumbUrl: (sha: string, width: number) => `/api/assets/thumb/${sha}?w=${width}`,
}));
vi.mock("@/lib/assets/client/api", () => api);

const recorder = vi.hoisted(() => ({
  listener: null as ((result: unknown) => void) | null,
  statusListener: null as ((status: unknown) => void) | null,
  /** What the recorder last heard; may be older than the server's answer. */
  known: null as unknown,
  applyLibraryStatus: vi.fn(),
}));
vi.mock("@/lib/assets/client/recorder", () => ({
  getRecorderLibraryStatus: () => recorder.known,
  applyLibraryStatus: recorder.applyLibraryStatus,
  onAssetRecorded: (listener: (result: unknown) => void) => {
    recorder.listener = listener;
    return () => {
      recorder.listener = null;
    };
  },
  onLibraryStatus: (listener: (status: unknown) => void) => {
    recorder.statusListener = listener;
    return () => {
      recorder.statusListener = null;
    };
  },
}));

const poster = vi.hoisted(() => ({
  ensurePoster: vi.fn(async () => false),
  listener: null as ((id: string) => void) | null,
}));
vi.mock("@/lib/assets/client/poster", () => ({
  ensurePoster: poster.ensurePoster,
  onPosterReady: (listener: (id: string) => void) => {
    poster.listener = listener;
    return () => {
      poster.listener = null;
    };
  },
}));

const openWorkflow = vi.hoisted(() => ({
  openAssetWorkflow: vi.fn(),
  openWorkflowBlockedReason: vi.fn(),
}));
vi.mock("@/lib/assets/client/openWorkflow", () => openWorkflow);

import { AssetsView } from "../AssetsView";
import { __resetPosterRequestsForTests } from "../posterRequests";
import { ARRIVALS_POLL_MS, useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";

const initial = useAssetStore.getState();
const T0 = new Date(2026, 8, 27, 14, 2).getTime();

function asset(id: string, overrides: Partial<AssetView> = {}): AssetView {
  return {
    v: 1,
    id,
    kind: "image",
    origin: "generated",
    mime: "image/png",
    ext: "png",
    bytes: 2_400_000,
    sha256: id.padEnd(64, "0"),
    md5: "",
    file: { root: "library", rel: `Generations/2026-09-27/${id}.png` },
    filename: `${id}.png`,
    width: 1024,
    height: 768,
    createdAt: T0,
    prompt: `A cat called ${id}`,
    model: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
    producer: { nodeId: "n1", nodeType: "nanoBanana" },
    workflowId: "wf_1",
    workflowName: null,
    runId: "r1",
    tags: [],
    favorite: false,
    workflow: { id: "wf_1", name: null, projectPath: null },
    displayPath: `/Users/me/Pictures/Node Banana/Generations/2026-09-27/${id}.png`,
    ...overrides,
  };
}

function page(assets: AssetView[], overrides: Partial<AssetPage> = {}): AssetPage {
  return { assets, nextCursor: null, headCursor: assets[0] ? "h" : null, total: assets.length, totalBytes: 0, ...overrides };
}

const facets = (overrides: Partial<AssetFacets> = {}): AssetFacets => ({
  total: 3,
  favorites: 0,
  trash: 0,
  missing: 0,
  kinds: { image: 3, video: 0, audio: 0, "3d": 0 },
  origins: { generated: 3, edited: 0 },
  models: [],
  tags: [],
  workflows: [],
  projects: [],
  ...overrides,
});

const library = (overrides: Partial<LibraryStatus> = {}): LibraryStatus => ({
  available: true,
  root: "/Users/me/Pictures/Node Banana",
  source: "default",
  defaultRoot: "/Users/me/Pictures/Node Banana",
  cacheDir: "/Users/me/Library/Caches/Node Banana",
  platform: "darwin",
  synced: null,
  counts: { assets: 3, trashed: 0, bytes: 0 },
  empty: false,
  job: null,
  ...overrides,
});

const tile = (id: string) => document.querySelector<HTMLElement>(`[data-asset-tile="${id}"]`)!;

async function renderView(assets: AssetView[] = [asset("a3"), asset("a2"), asset("a1")]) {
  api.fetchAssetPage.mockResolvedValue(page(assets));
  const view = render(<AssetsView />);
  if (assets.length) await waitFor(() => expect(tile(assets[0]!.id)).toBeInTheDocument());
  else await waitFor(() => expect(screen.getByTestId("assets-empty")).toBeInTheDocument());
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder.known = null;
  __resetPosterRequestsForTests();
  useAssetStore.setState({ ...initial, appView: "assets" }, true);
  api.fetchFacets.mockResolvedValue(facets());
  api.fetchLibraryStatus.mockResolvedValue(library());
  api.fetchProjects.mockResolvedValue({ root: "/Users/me/Pictures/Node Banana", projects: [], elsewhere: null, offerDismissed: false });
  api.dismissProjectsOffer.mockResolvedValue(undefined);
  // A key test may trash through the view without caring about the result
  api.bulkAssets.mockResolvedValue({ affected: 0, ids: [], errors: [] });
  openWorkflow.openWorkflowBlockedReason.mockReturnValue(null);
  openWorkflow.openAssetWorkflow.mockResolvedValue({ ok: true, tabId: "tab-2", nodeId: "n1" });
});

afterEach(() => {
  useAssetStore.setState(initial, true);
});

describe("AssetsView", () => {
  it("renders a tile per asset of the first page, under a day header, with the count", async () => {
    await renderView();
    expect(api.fetchAssetPage).toHaveBeenCalledWith({ limit: 200 }, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "A cat called a3" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-asset-tile]")).toHaveLength(3);
    expect(screen.getByText("3 assets")).toBeInTheDocument();
    // Thumbnails come from the server's cache, never the original file
    expect(tile("a3").querySelector("img")!.getAttribute("src")).toMatch(/^\/api\/assets\/thumb\/a3/);
  });

  it("opens the context menu on right-click, and Open workflow opens it and goes back to the canvas", async () => {
    await renderView();
    fireEvent.contextMenu(tile("a2"), { clientX: 200, clientY: 200 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Show in Finder/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Open workflow/ }));
    await waitFor(() => expect(openWorkflow.openAssetWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "snapshot"));
    await waitFor(() => expect(useAssetStore.getState().appView).toBe("canvas"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("says why Open workflow is unavailable instead of failing after the click", async () => {
    openWorkflow.openWorkflowBlockedReason.mockReturnValue("Available when the run finishes");
    await renderView();
    fireEvent.contextMenu(tile("a2"), { clientX: 10, clientY: 10 });
    const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: /Open workflow/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent("Available when the run finishes");
  });

  it("shows the bulk bar for a selection, and bulk Trash sends that selection", async () => {
    await renderView();
    fireEvent.click(tile("a3"), { metaKey: true });
    fireEvent.click(tile("a1"), { metaKey: true });
    const bar = screen.getByRole("toolbar", { name: "Selected assets" });
    expect(bar).toHaveTextContent("2 selected");

    api.bulkAssets.mockResolvedValueOnce({ affected: 2, ids: ["a3", "a1"], errors: [] });
    fireEvent.click(within(bar).getByRole("button", { name: "Trash" }));
    await waitFor(() =>
      expect(api.bulkAssets).toHaveBeenCalledWith({ selection: { mode: "ids", ids: ["a3", "a1"] }, op: { action: "trash" } }),
    );
    await waitFor(() => expect(document.querySelectorAll("[data-asset-tile]")).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent("Trashed 2 assets");
    expect(screen.queryByRole("toolbar", { name: "Selected assets" })).not.toBeInTheDocument();
  });

  it("selects a range in sort order with Shift-click", async () => {
    await renderView();
    fireEvent.click(tile("a3"), { metaKey: true });
    fireEvent.click(tile("a1"), { shiftKey: true });
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: ["a3", "a2", "a1"] });
  });

  it("opens the detail with its metadata, and Open workflow opens it and switches to the canvas", async () => {
    await renderView();
    fireEvent.click(tile("a2"));
    const panel = screen.getByRole("complementary", { name: "Asset details" });
    expect(within(panel).getByText("Image · Generated · 27 Sep 2026")).toBeInTheDocument();
    expect(within(panel).getByText("27 Sep 2026, 14:02")).toBeInTheDocument();
    expect(within(panel).getByText("Nano Banana Pro")).toBeInTheDocument();
    expect(within(panel).getByText("1024 × 768")).toBeInTheDocument();
    expect(within(panel).getByText("2.4 MB")).toBeInTheDocument();
    expect(within(panel).getByText("Untitled · 27 Sep 14:02")).toBeInTheDocument();
    expect(within(panel).getByText("Not in a project")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Open workflow" }));
    await waitFor(() => expect(openWorkflow.openAssetWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "snapshot"));
    await waitFor(() => expect(useAssetStore.getState().appView).toBe("canvas"));
    // Coming back lands on the grid, on that tile, not on the detail left behind
    expect(useAssetStore.getState()).toMatchObject({ detailId: null, detailAsset: null, focusedId: "a2" });
  });

  it("offers a project asset its project, and the copy as it was when made", async () => {
    await renderView([asset("a1", { workflow: { id: "wf_1", name: "Cat ads", projectPath: "/p/Cat ads" }, file: { root: "external", path: "/p/Cat ads/generations/x.png" } })]);
    fireEvent.click(tile("a1"));
    const panel = screen.getByRole("complementary", { name: "Asset details" });
    expect(within(panel).getByRole("button", { name: "Open project" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Open as it was when made" })).toBeInTheDocument();
    expect(within(panel).getByText("Opens a copy; your project isn't changed.")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Open as it was when made" }));
    await waitFor(() => expect(openWorkflow.openAssetWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "snapshot"));
  });

  it("keeps the view and says why when a workflow cannot be opened", async () => {
    openWorkflow.openAssetWorkflow.mockResolvedValueOnce({ ok: false, reason: "No snapshot of this run was saved" });
    await renderView();
    fireEvent.click(tile("a2"));
    fireEvent.click(screen.getByRole("button", { name: "Open workflow" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No snapshot of this run was saved"));
    expect(useAssetStore.getState().appView).toBe("assets");
  });

  it("flags a missing file in the detail with Remove from library", async () => {
    await renderView([asset("a1", { missing: true })]);
    fireEvent.click(tile("a1"));
    expect(screen.getByText(/File not found at \/Users\/me\/Pictures/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove from library" }));
    expect(useAssetStore.getState().confirm).toMatchObject({ kind: "remove", count: 1 });
  });

  it("steps through the detail with the arrow keys and closes it, then the selection, then the view, with Escape", async () => {
    await renderView();
    fireEvent.click(tile("a3"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(useAssetStore.getState().detailId).toBe("a2"));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(useAssetStore.getState().detailId).toBe("a3"));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAssetStore.getState().detailId).toBeNull();
    fireEvent.click(tile("a2"), { metaKey: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: [] });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("takes focus into the detail, keeps the grid out of reach, and lands on the last asset shown when it closes", async () => {
    await renderView();
    fireEvent.click(tile("a3"));
    const detail = screen.getByRole("dialog", { name: "A cat called a3" });
    await waitFor(() => expect(detail).toHaveFocus());
    expect(screen.getByTestId("asset-grid").closest("main")).toHaveAttribute("inert");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(useAssetStore.getState().detailId).toBe("a2"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(tile("a2")).toHaveFocus());
    expect(screen.getByTestId("asset-grid").closest("main")).not.toHaveAttribute("inert");
  });

  it("leaves the arrow keys to a focused player in the detail", async () => {
    await renderView([asset("a2", { kind: "video", mime: "video/mp4", ext: "mp4" }), asset("a1")]);
    fireEvent.click(tile("a2"));
    const video = document.querySelector("[data-asset-detail] video")!;
    fireEvent.keyDown(video, { key: "ArrowRight" });
    expect(useAssetStore.getState().detailId).toBe("a2");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(useAssetStore.getState().detailId).toBe("a1"));
  });

  it("keeps its keys from the canvas: they stop at the view's capture handler", async () => {
    await renderView();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      fireEvent.keyDown(window, { key: "a", metaKey: true });
      fireEvent.keyDown(window, { key: "Delete" });
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: ["a3", "a2", "a1"] });
  });

  it("trashes with Delete and undoes with Cmd+Z", async () => {
    await renderView();
    fireEvent.click(tile("a2"), { metaKey: true });
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(document.querySelectorAll("[data-asset-tile]")).toHaveLength(2));

    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["a2"] }, op: { action: "restore" } }));
    await waitFor(() => expect(document.querySelectorAll("[data-asset-tile]")).toHaveLength(3));
  });

  it("offers to select everything matching after Cmd+A", async () => {
    // The grid asks for the next page at once (the first is shorter than the window): make it slow
    api.fetchAssetPage.mockImplementation((request: { cursor?: string }) =>
      request.cursor ? new Promise(() => {}) : Promise.resolve(page([asset("a3"), asset("a2")], { total: 40, nextCursor: "c1" })),
    );
    render(<AssetsView />);
    await waitFor(() => expect(tile("a3")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Select all 40 matching" }));
    expect(useAssetStore.getState().selection).toEqual({ mode: "query", query: {}, excludeIds: [] });
    expect(screen.getByRole("toolbar", { name: "Selected assets" })).toHaveTextContent("40 selected");
  });

  it("acts on the whole selection from the menu of a selected tile", async () => {
    await renderView();
    fireEvent.click(tile("a3"), { metaKey: true });
    fireEvent.click(tile("a2"), { metaKey: true });
    fireEvent.contextMenu(tile("a2"), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole("menu", { name: "2 assets selected" });
    api.bulkAssets.mockResolvedValueOnce({ affected: 2, ids: ["a3", "a2"], errors: [] });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Favorite" }));
    await waitFor(() =>
      expect(api.bulkAssets).toHaveBeenCalledWith({ selection: { mode: "ids", ids: ["a3", "a2"] }, op: { action: "favorite" } }),
    );
  });

  it("stops asking for more when a page brings nothing new", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("a3"), asset("a2")], { total: 40, nextCursor: "c1" }));
    render(<AssetsView />);
    await waitFor(() => expect(tile("a3")).toBeInTheDocument());
    await waitFor(() => expect(useAssetStore.getState().nextCursor).toBeNull());
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
  });

  it("has a poster made for a video tile without one, and shows its thumbnail once stored", async () => {
    await renderView([asset("vid1", { kind: "video", mime: "video/mp4", ext: "mp4" }), asset("a1")]);
    expect(poster.ensurePoster).toHaveBeenCalledTimes(1);
    expect(poster.ensurePoster).toHaveBeenCalledWith(
      expect.objectContaining({ id: "vid1", kind: "video" }),
      // Its turn goes to another tile while a failed capture waits to try again
      { onRetryWait: expect.any(Function) },
    );
    // Asked before the poster existed: the server had nothing (204)
    fireEvent.error(tile("vid1").querySelector("img")!);
    expect(tile("vid1").querySelector("img")).toBeNull();

    act(() => poster.listener?.("vid1"));
    expect(useAssetStore.getState().items[0]!.asset!.hasPoster).toBe(true);
    expect(tile("vid1").querySelector("img")!.getAttribute("src")).toBe(`/api/assets/thumb/${"vid1".padEnd(64, "0")}?w=320&poster=1`);
    // Once per video, not on every render
    expect(poster.ensurePoster).toHaveBeenCalledTimes(1);
  });

  it("asks for a video's poster only once its tile is on screen, not while it waits in the overscan", async () => {
    // Five rows of images, then a video mounted below the visible area
    const images = Array.from({ length: 20 }, (_, i) => asset(`i${String(i).padStart(2, "0")}`));
    await renderView([...images, asset("vid9", { kind: "video", mime: "video/mp4", ext: "mp4" })]);
    expect(tile("vid9")).toBeInTheDocument();
    expect(poster.ensurePoster).not.toHaveBeenCalled();

    const grid = screen.getByTestId("asset-grid");
    grid.scrollTop = 600;
    fireEvent.scroll(grid);
    await waitFor(() => expect(poster.ensurePoster).toHaveBeenCalledWith(expect.objectContaining({ id: "vid9" }), expect.anything()));
  });

  it("prepends a recorded asset that matches while scrolled to the top", async () => {
    await renderView();
    act(() => recorder.listener?.({ asset: asset("a4", { createdAt: T0 + 1000 }), filename: "a4.png", legacyId: "a4", reusedFile: false }));
    await waitFor(() => expect(tile("a4")).toBeInTheDocument());
    expect(useAssetStore.getState().items[0]!.id).toBe("a4");
  });

  describe("empty states", () => {
    it("explains a fresh library, where it saves, and the way back", async () => {
      api.fetchFacets.mockResolvedValue(facets({ total: 0 }));
      await renderView([]);
      const empty = screen.getByTestId("assets-empty");
      await waitFor(() => expect(within(empty).getByText("/Users/me/Pictures/Node Banana")).toBeInTheDocument());
      expect(within(empty).getByText("Nothing saved yet")).toBeInTheDocument();
      // The rail's foot says the same, with Show and Change…
      expect(screen.getByRole("button", { name: "Change…" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show in Finder" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Back to canvas" }));
      expect(useAssetStore.getState().appView).toBe("canvas");
    });

    it("offers to import the generations of projects saved before the library", async () => {
      window.localStorage.setItem(
        "node-banana-workflow-configs",
        JSON.stringify({ wf_1: { workflowId: "wf_1", name: "Cat ads", directoryPath: "/p/cat", generationsPath: null, lastSavedAt: null } }),
      );
      try {
        await renderView([]);
        api.startImport.mockResolvedValueOnce({ id: "j1", type: "import", state: "running", done: 0, total: 5, bytesDone: 0, bytesTotal: 0, startedAt: 1 });
        fireEvent.click(screen.getByRole("button", { name: "Import generations from your 1 project" }));
        await waitFor(() => expect(api.startImport).toHaveBeenCalledWith({ projectDirs: ["/p/cat"] }));
      } finally {
        window.localStorage.removeItem("node-banana-workflow-configs");
      }
    });

    it("says nothing matches, with Clear filters", async () => {
      useAssetStore.setState({ filters: { ...initial.filters, kinds: ["video"] } });
      await renderView([]);
      expect(screen.getByText("No assets match")).toBeInTheDocument();
      api.fetchAssetPage.mockResolvedValue(page([asset("a1")]));
      fireEvent.click(within(screen.getByTestId("assets-empty")).getByRole("button", { name: "Clear filters" }));
      await waitFor(() => expect(tile("a1")).toBeInTheDocument());
    });

    it("says how long the Trash keeps things", async () => {
      useAssetStore.setState({ filters: { ...initial.filters, view: "trash" } });
      await renderView([]);
      expect(api.fetchAssetPage).toHaveBeenCalledWith({ scope: "trash", limit: 200 }, expect.any(AbortSignal));
      expect(screen.getByText("Items in Trash are deleted after 30 days.")).toBeInTheDocument();
    });

    it("explains an unavailable library", async () => {
      api.fetchLibraryStatus.mockResolvedValue(library({ available: false, reason: "This server is read-only." }));
      await renderView([]);
      await waitFor(() => expect(screen.getAllByText("This server is read-only.").length).toBeGreaterThan(0));
      expect(screen.getByText("The asset library is not available")).toBeInTheDocument();
    });
  });

  it("asks before deleting from the Trash, naming project files as kept", async () => {
    useAssetStore.setState({ filters: { ...initial.filters, view: "trash" } });
    await renderView([asset("a1", { trashedAt: 1, file: { root: "external", path: "/p/x.png" } })]);
    fireEvent.click(tile("a1"), { metaKey: true });
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected assets" })).getByRole("button", { name: "Delete permanently…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 1 asset permanently?" });
    expect(within(dialog).getByText(/Also delete the 1 file in project folders/)).toBeInTheDocument();
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a1"], errors: [] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() =>
      expect(api.bulkAssets).toHaveBeenCalledWith({
        selection: { mode: "ids", ids: ["a1"] },
        op: { action: "delete", deleteProjectFiles: false },
      }),
    );
  });

  it("leaves a selection behind when the Trash opens, so Delete there cannot reach live assets", async () => {
    await renderView();
    fireEvent.click(tile("a3"), { metaKey: true });
    fireEvent.click(tile("a1"), { metaKey: true });
    expect(screen.getByRole("toolbar", { name: "Selected assets" })).toHaveTextContent("2 selected");

    api.fetchAssetPage.mockResolvedValue(page([asset("t1", { trashedAt: 1 })]));
    fireEvent.click(screen.getByRole("button", { name: /^Trash\s*0$/ }));
    await waitFor(() => expect(tile("t1")).toBeInTheDocument());
    expect(screen.queryByRole("toolbar", { name: "Selected assets" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(useAssetStore.getState().confirm).toBeNull();
    expect(screen.queryByRole("dialog", { name: /permanently/ })).not.toBeInTheDocument();
  });

  it("loads the list again when Settings switches the library underneath it", async () => {
    await renderView();
    await waitFor(() => expect(useAssetStore.getState().library?.root).toBe("/Users/me/Pictures/Node Banana"));
    fireEvent.click(tile("a2"), { metaKey: true });
    api.fetchAssetPage.mockResolvedValue(page([asset("b1")]));
    act(() => recorder.statusListener?.(library({ root: "/Volumes/Work/Node Banana" })));
    await waitFor(() => expect(tile("b1")).toBeInTheDocument());
    expect(tile("a2")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Selected assets" })).not.toBeInTheDocument();
    expect(screen.getByText("/Volumes/Work/Node Banana")).toBeInTheDocument();
  });

  it("comes back on a fresh library status, not the recorder's copy from before a move ended", async () => {
    const view = await renderView();
    await waitFor(() => expect(useAssetStore.getState().loadedRoot).toBe("/Users/me/Pictures/Node Banana"));
    fireEvent.click(tile("a2"), { metaKey: true });
    view.unmount();

    // The recorder last heard of the library mid-move: still the old folder, the job running
    const moving = { id: "mv1", type: "move" as const, state: "running" as const, done: 1, total: 9, bytesDone: 0, bytesTotal: 0, startedAt: 1 };
    recorder.known = library({ root: "/Volumes/Old/Node Banana", job: moving });
    const loads = () => api.fetchAssetPage.mock.calls.filter(([query]) => !("newerThan" in query)).length;
    const before = loads();
    render(<AssetsView />);
    await waitFor(() => expect(api.fetchLibraryStatus).toHaveBeenCalledTimes(2));
    await act(async () => {});
    // The list and the selection stay; no finished move is followed again
    expect(useAssetStore.getState().library?.root).toBe("/Users/me/Pictures/Node Banana");
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: ["a2"] });
    expect(loads()).toBe(before);
    expect(useAssetStore.getState().job).toBeNull();
    expect(screen.queryByText(/Moving library/)).not.toBeInTheDocument();
  });

  it("follows an import started in Settings once its dialog closes, and shows what it brought", async () => {
    await renderView();
    const running = { id: "j9", type: "import" as const, state: "running" as const, done: 2, total: 4, bytesDone: 0, bytesTotal: 0, startedAt: 1 };
    api.fetchLibraryStatus.mockResolvedValue(library({ job: running }));
    // Settings opens over the view, starts the import and closes
    act(() => useWorkflowStore.getState().incrementModalCount());
    act(() => useWorkflowStore.getState().decrementModalCount());
    await waitFor(() => expect(screen.getByText("Importing 2 of 4")).toBeInTheDocument());

    const finished = { ...running, state: "done" as const, done: 4, finishedAt: Date.now() };
    api.fetchJob.mockResolvedValue(finished);
    api.fetchLibraryStatus.mockResolvedValue(library({ job: finished }));
    api.fetchAssetPage.mockResolvedValue(page([asset("a3"), asset("a2"), asset("a1"), asset("imp1", { createdAt: T0 - 86_400_000 * 40 })]));
    await waitFor(() => expect(tile("imp1")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText(/Importing/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Imported 4 files");
  });

  describe("projects in other folders", () => {
    const ROOT = "/Users/me/Pictures/Node Banana";
    const outside = ["/Users/me/test-files/test workflows/A", "/Users/me/pet-hype"];
    const overview = {
      root: ROOT,
      projects: [
        { dir: `${ROOT}/Fox`, name: "Fox", relativePath: "Fox", inRoot: true, lastModified: 2, mediaCount: 0 },
        ...outside.map((dir) => ({ dir, name: dir, relativePath: null, inRoot: false, lastModified: 1, mediaCount: 0 })),
      ],
      elsewhere: {
        count: 2,
        dirs: outside,
        bytes: 0,
        groups: [
          { label: "~/test-files/test workflows", count: 1 },
          { label: "~/pet-hype", count: 1 },
        ],
      },
      offerDismissed: false,
    };
    const offer = () => screen.findByRole("region", { name: "Projects in other folders" });

    it("offers to move them in, and follows the move in the header", async () => {
      api.fetchProjects.mockResolvedValue(overview);
      const running = { id: "p1", type: "projects" as const, state: "running" as const, done: 189, total: 860, bytesDone: 0, bytesTotal: 0, startedAt: 1 };
      api.bringInProjects.mockResolvedValue({ root: ROOT, job: running });
      api.fetchJob.mockResolvedValue(running);
      await renderView();
      expect(await offer()).toHaveTextContent(
        "2 projects live in other folders" +
          "test-files › test workflows and pet-hype. Move them into your Node Banana folder to keep everything in one place."
      );

      fireEvent.click(screen.getByRole("button", { name: "Move them in" }));
      await waitFor(() => expect(screen.getByText("Moving projects 189 of 860")).toBeInTheDocument());
      expect(api.bringInProjects).toHaveBeenCalledWith({ dirs: outside, mode: "move" });
      expect(screen.queryByRole("region", { name: "Projects in other folders" })).not.toBeInTheDocument();
    });

    it("keeps them where they are, says where to change that, and does not offer again", async () => {
      api.fetchProjects.mockResolvedValue(overview);
      await renderView();
      fireEvent.click(within(await offer()).getByRole("button", { name: "Keep where they are" }));
      await waitFor(() => expect(api.dismissProjectsOffer).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("region", { name: "Projects in other folders" })).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("They stay where they are. Settings › Storage can move them later.");
    });

    it("makes no offer once it was declined", async () => {
      api.fetchProjects.mockResolvedValue({ ...overview, offerDismissed: true });
      await renderView();
      await waitFor(() => expect(api.fetchProjects).toHaveBeenCalled());
      expect(screen.queryByRole("region", { name: "Projects in other folders" })).not.toBeInTheDocument();
    });
  });

  describe("fullscreen detail", () => {
    let fullscreenElement: Element | null = null;
    const enterFullscreen = () =>
      act(() => {
        fullscreenElement = document.querySelector("[data-asset-detail]");
        document.dispatchEvent(new Event("fullscreenchange"));
      });

    beforeEach(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: vi.fn(async () => {
          fullscreenElement = null;
          document.dispatchEvent(new Event("fullscreenchange"));
        }),
      });
    });
    afterEach(() => {
      fullscreenElement = null;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    });

    it("shows the notice inside the detail, where fullscreen can paint it", async () => {
      await renderView();
      fireEvent.click(tile("a2"));
      enterFullscreen();
      const detail = document.querySelector<HTMLElement>("[data-asset-detail]")!;
      api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
      fireEvent.keyDown(window, { key: "Delete" });
      await waitFor(() => expect(within(detail).getByRole("status")).toHaveTextContent("Trashed 1 asset"));
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("leaves fullscreen before asking to delete for good, so the question can be seen", async () => {
      useAssetStore.setState({ filters: { ...initial.filters, view: "trash" } });
      await renderView([asset("t1", { trashedAt: 1 }), asset("t2", { trashedAt: 1 })]);
      fireEvent.click(tile("t1"));
      enterFullscreen();
      fireEvent.keyDown(window, { key: "Delete" });
      expect(document.exitFullscreen).toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Delete 1 asset permanently?" })).toBeInTheDocument();
    });

    it("leaves fullscreen before showing the shortcuts, which open outside the detail", async () => {
      await renderView();
      fireEvent.click(tile("a2"));
      enterFullscreen();
      fireEvent.keyDown(window, { key: "?" });
      expect(document.exitFullscreen).toHaveBeenCalled();
      expect(useWorkflowStore.getState().shortcutsDialogOpen).toBe(true);
      useWorkflowStore.setState({ shortcutsDialogOpen: false });
    });

    it("leaves fullscreen when any dialog opens over the detail, however it was opened", async () => {
      await renderView();
      fireEvent.click(tile("a2"));
      enterFullscreen();
      // Settings, say, opened from the desktop menu
      act(() => useWorkflowStore.getState().incrementModalCount());
      expect(document.exitFullscreen).toHaveBeenCalled();
      act(() => useWorkflowStore.getState().decrementModalCount());
    });
  });

  describe("while the page is hidden", () => {
    let visibility: DocumentVisibilityState = "visible";
    beforeEach(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    });
    afterEach(() => {
      visibility = "visible";
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it("asks nothing every 5 s, and asks at once on coming back", async () => {
      const intervals = vi.spyOn(globalThis, "setInterval");
      try {
        await renderView();
        const tick = intervals.mock.calls.find(([, ms]) => ms === ARRIVALS_POLL_MS)![0] as () => void;
        await waitFor(() => expect(api.fetchLibraryStatus).toHaveBeenCalled());
        api.fetchLibraryStatus.mockClear();
        api.fetchAssetPage.mockClear();

        visibility = "hidden";
        act(() => tick());
        expect(api.fetchLibraryStatus).not.toHaveBeenCalled();
        expect(api.fetchAssetPage).not.toHaveBeenCalled();

        visibility = "visible";
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(api.fetchLibraryStatus).toHaveBeenCalledTimes(1);
        expect(api.fetchAssetPage).toHaveBeenCalledWith(expect.objectContaining({ newerThan: "h" }));
      } finally {
        intervals.mockRestore();
      }
    });

    it.each(["hosted", "guard"] as const)(
      "asks nothing every 5 s of a library off for good (%s), and on coming back at most every 30 s",
      async (reasonCode) => {
        api.fetchLibraryStatus.mockResolvedValue(library({ available: false, reason: "Not on this server.", reasonCode }));
        const intervals = vi.spyOn(globalThis, "setInterval");
        let clock: ReturnType<typeof vi.spyOn> | null = null;
        try {
          await renderView();
          const tick = intervals.mock.calls.find(([, ms]) => ms === ARRIVALS_POLL_MS)![0] as () => void;
          await waitFor(() => expect(useAssetStore.getState().library?.reasonCode).toBe(reasonCode));
          api.fetchLibraryStatus.mockClear();
          api.fetchAssetPage.mockClear();
          const start = Date.now();
          clock = vi.spyOn(Date, "now").mockReturnValue(start);

          act(() => tick());
          act(() => tick());
          expect(api.fetchLibraryStatus).not.toHaveBeenCalled();
          expect(api.fetchAssetPage).not.toHaveBeenCalled();

          // Back within 30 s of the last ask: nothing
          visibility = "hidden";
          visibility = "visible";
          act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          expect(api.fetchLibraryStatus).not.toHaveBeenCalled();

          // Later: asked once, and the 5 s poll still asks nothing
          clock.mockReturnValue(start + 30_000);
          act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          expect(api.fetchLibraryStatus).toHaveBeenCalledTimes(1);
          act(() => tick());
          expect(api.fetchLibraryStatus).toHaveBeenCalledTimes(1);
        } finally {
          clock?.mockRestore();
          intervals.mockRestore();
        }
      },
    );
  });

  it("goes back to the canvas when a workflow opens or the tab changes, however that was asked for", async () => {
    await renderView();
    act(() => useWorkflowStore.setState({ canvasGeneration: useWorkflowStore.getState().canvasGeneration + 1 }));
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("empties the whole Trash, not just what a search shows, and offers the project files without guessing their number", async () => {
    api.fetchFacets.mockResolvedValue(facets({ trash: 40 }));
    useAssetStore.setState({ filters: { ...initial.filters, view: "trash", q: "cat" } });
    await renderView([asset("a1", { trashedAt: 1 })]);
    await waitFor(() => expect(useAssetStore.getState().facets?.trash).toBe(40));
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 40 assets permanently?" });
    expect(within(dialog).getByText(/Also delete any of their files that are in project folders/)).toBeInTheDocument();
    api.bulkAssets.mockResolvedValueOnce({ affected: 40, ids: [], errors: [] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() =>
      expect(api.bulkAssets).toHaveBeenCalledWith({
        selection: { mode: "query", query: { scope: "trash" }, excludeIds: [] },
        op: { action: "delete", deleteProjectFiles: false },
      }),
    );
  });

  it("goes back to the canvas on a bare A, and over to the chat on a bare C", async () => {
    await renderView();
    fireEvent.keyDown(window, { key: "a", repeat: true });
    expect(useAssetStore.getState().appView).toBe("assets");
    fireEvent.keyDown(window, { key: "a" });
    expect(useAssetStore.getState().appView).toBe("canvas");

    act(() => useAssetStore.setState({ appView: "assets" }));
    fireEvent.keyDown(window, { key: "C", shiftKey: true });
    fireEvent.keyDown(window, { key: "c", repeat: true });
    expect(useAssetStore.getState().appView).toBe("assets");
    fireEvent.keyDown(window, { key: "c" });
    expect(useAssetStore.getState().appView).toBe("chat");
  });

  it("leaves A and C to the search field being typed in", async () => {
    await renderView();
    const search = screen.getByRole("textbox", { name: "Search assets" });
    search.focus();
    fireEvent.keyDown(search, { key: "c" });
    fireEvent.keyDown(search, { key: "a" });
    expect(useAssetStore.getState().appView).toBe("assets");
  });

  it("opens the shortcuts from ? and hands the keyboard to a dialog above it", async () => {
    await renderView();
    fireEvent.keyDown(window, { key: "?" });
    expect(useWorkflowStore.getState().shortcutsDialogOpen).toBe(true);
    useWorkflowStore.setState({ shortcutsDialogOpen: false });
  });
});
