import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetPage, AssetView, LibraryJobStatus, LibraryStatus } from "@/lib/assets/types";
import { encodeAssetPageRequest } from "@/lib/assets/query";

const api = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(),
  fetchAsset: vi.fn(),
  fetchFacets: vi.fn(),
  fetchLibraryStatus: vi.fn(),
  bulkAssets: vi.fn(),
  fetchJob: vi.fn(),
  cancelJob: vi.fn(),
}));
vi.mock("@/lib/assets/client/api", () => api);

const recorder = vi.hoisted(() => ({ applyLibraryStatus: vi.fn() }));
vi.mock("@/lib/assets/client/recorder", () => recorder);

import {
  DEFAULT_FILTERS,
  buildAssetQuery,
  bulkFavoriteOp,
  hiddenSelectionCount,
  matchesAssetQuery,
  selectionCount,
  useAssetStore,
} from "../assetStore";

const initial = useAssetStore.getState();
const T0 = new Date(2026, 8, 27, 14, 0).getTime();

function asset(id: string, overrides: Partial<AssetView> = {}): AssetView {
  return {
    v: 1,
    id,
    kind: "image",
    origin: "generated",
    mime: "image/png",
    ext: "png",
    bytes: 1000,
    sha256: id.padEnd(64, "0"),
    md5: "",
    file: { root: "library", rel: `Generations/${id}.png` },
    filename: `${id}.png`,
    width: 100,
    height: 100,
    createdAt: T0,
    producer: { nodeId: "n1", nodeType: "nanoBanana" },
    workflowId: "wf_1",
    workflowName: null,
    runId: "r1",
    tags: [],
    favorite: false,
    workflow: { id: "wf_1", name: null, projectPath: null },
    displayPath: `/lib/${id}.png`,
    ...overrides,
  };
}

function page(assets: AssetView[], overrides: Partial<AssetPage> = {}): AssetPage {
  return { assets, nextCursor: null, headCursor: assets[0] ? `head:${assets[0].id}` : null, total: assets.length, totalBytes: 0, ...overrides };
}

const ids = () => useAssetStore.getState().items.map((item) => item.id);

beforeEach(() => {
  vi.clearAllMocks();
  useAssetStore.setState(initial, true);
  api.fetchFacets.mockResolvedValue(null);
});

describe("filters", () => {
  it("turns the rail into request params: AND across groups, lists as repeated keys", () => {
    const query = buildAssetQuery(
      { ...DEFAULT_FILTERS, view: "favorites", q: "  cat ", kinds: ["image", "video"], tags: ["hero"], projects: [""], date: "7d" },
      "oldest",
      T0,
    );
    const midnight = new Date(2026, 8, 27).getTime();
    expect(query).toEqual({
      favorite: true,
      q: "cat",
      kinds: ["image", "video"],
      tags: ["hero"],
      projects: [""],
      from: midnight - 6 * 24 * 3600_000,
      sort: "oldest",
    });
    expect(encodeAssetPageRequest(query).toString()).toBe(
      `q=cat&kind=image&kind=video&tag=hero&project=&favorite=1&from=${midnight - 6 * 24 * 3600_000}&sort=oldest`,
    );
  });

  it("maps Trash and Missing to scopes", () => {
    expect(buildAssetQuery({ ...DEFAULT_FILTERS, view: "trash" }, "newest")).toEqual({ scope: "trash" });
    expect(buildAssetQuery({ ...DEFAULT_FILTERS, view: "missing" }, "newest")).toEqual({ scope: "missing" });
    expect(buildAssetQuery({ ...DEFAULT_FILTERS, date: "today" }, "newest", T0)).toEqual({ from: new Date(2026, 8, 27).getTime() });
  });

  it("requests the page for the current filters and refetches when they change", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("a1")]));
    await useAssetStore.getState().refresh();
    expect(api.fetchAssetPage).toHaveBeenLastCalledWith({ limit: 200 }, expect.any(AbortSignal));

    useAssetStore.getState().toggleFilter("kinds", "video");
    await vi.waitFor(() => expect(api.fetchAssetPage).toHaveBeenCalledTimes(2));
    expect(api.fetchAssetPage).toHaveBeenLastCalledWith({ kinds: ["video"], limit: 200 }, expect.any(AbortSignal));
  });

  it("mirrors the server's matching for arrivals and hidden selections", () => {
    const cat = asset("a1", { prompt: "A cat", tags: ["hero"], workflow: { id: "wf_1", name: "Ads", projectPath: "/p/ads" } });
    expect(matchesAssetQuery(cat, { q: "CAT" })).toBe(true);
    expect(matchesAssetQuery(cat, { q: "ads" })).toBe(true);
    expect(matchesAssetQuery(cat, { tags: ["other", "hero"] })).toBe(true);
    expect(matchesAssetQuery(cat, { projects: [""] })).toBe(false);
    expect(matchesAssetQuery(cat, { projects: ["/p/ads"], kinds: ["video"] })).toBe(false);
    expect(matchesAssetQuery(cat, { scope: "trash" })).toBe(false);
    expect(matchesAssetQuery({ ...cat, trashedAt: 1 }, { scope: "trash" })).toBe(true);
    expect(matchesAssetQuery({ ...cat, trashedAt: 1 }, {})).toBe(false);
  });

  it("searches the way the server does: every word somewhere, tags and (on macOS) projects without case", () => {
    const lake = asset("a1", { prompt: "Golden light over a lakeside", tags: ["Hero"], workflow: { id: "wf_1", name: "Ads", projectPath: "/Users/me/Ads" } });
    expect(matchesAssetQuery(lake, { q: "golden lakeside" })).toBe(true);
    expect(matchesAssetQuery(lake, { q: "  golden   ads " })).toBe(true);
    expect(matchesAssetQuery(lake, { q: "golden forest" })).toBe(false);
    expect(matchesAssetQuery(lake, { tags: ["hero"] })).toBe(true);
    expect(matchesAssetQuery(lake, { projects: ["/users/me/ads/"] }, "darwin")).toBe(true);
    expect(matchesAssetQuery(lake, { projects: ["/users/me/ads"] }, "linux")).toBe(false);
  });
});

describe("paging", () => {
  it("pages by cursor and drops duplicates by id", async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3"), asset("a2")], { nextCursor: "c1", total: 4 }));
    await useAssetStore.getState().refresh();
    expect(ids()).toEqual(["a3", "a2"]);

    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2"), asset("a1"), asset("a0")], { nextCursor: null, total: 4 }));
    await useAssetStore.getState().loadMore();
    expect(api.fetchAssetPage).toHaveBeenLastCalledWith({ cursor: "c1", limit: 200 });
    expect(ids()).toEqual(["a3", "a2", "a1", "a0"]);
    expect(useAssetStore.getState().nextCursor).toBeNull();

    // Nothing more to fetch
    await useAssetStore.getState().loadMore();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
  });

  it("shows a failed load as an error, not the previous query's tiles", async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2"), asset("a1")], { nextCursor: "c1", total: 9 }));
    await useAssetStore.getState().refresh();
    api.fetchAssetPage.mockRejectedValueOnce(new Error("The asset library is not available"));
    useAssetStore.getState().toggleFilter("kinds", "video");
    await vi.waitFor(() => expect(useAssetStore.getState().status).toBe("error"));
    expect(useAssetStore.getState()).toMatchObject({ items: [], total: 0, nextCursor: null, error: "The asset library is not available" });
  });

  it("drops a response for a query that has since changed", async () => {
    let resolveFirst!: (value: AssetPage) => void;
    api.fetchAssetPage.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("b1")]));
    const first = useAssetStore.getState().refresh();
    await useAssetStore.getState().refresh();
    resolveFirst(page([asset("stale")]));
    await first;
    expect(ids()).toEqual(["b1"]);
  });

  it("keeps at most the cap of full records, dropping far pages and refetching them by cursor", async () => {
    // 26 pages of 200: one page over the cap
    const pageOf = (n: number) => Array.from({ length: 200 }, (_, i) => asset(`a${String(n * 200 + i).padStart(5, "0")}`));
    api.fetchAssetPage.mockResolvedValueOnce(page(pageOf(0), { nextCursor: "c1", total: 5200 }));
    await useAssetStore.getState().refresh();
    for (let n = 1; n < 26; n++) {
      api.fetchAssetPage.mockResolvedValueOnce(page(pageOf(n), { nextCursor: n < 25 ? `c${n + 1}` : null, total: 5200 }));
      await useAssetStore.getState().loadMore();
    }
    expect(useAssetStore.getState().items).toHaveLength(5200);

    // Looking at the end: the first page gives up its records but keeps its slots
    useAssetStore.getState().trimLoaded(5100, 5199);
    const state = useAssetStore.getState();
    expect(state.items).toHaveLength(5200);
    expect(state.items.filter((item) => item.asset).length).toBe(5000);
    expect(state.items[0]!.asset).toBeNull();
    expect(state.items[200]!.asset).not.toBeNull();
    expect(state.pages[0]!.loaded).toBe(false);

    api.fetchAssetPage.mockResolvedValueOnce(page(pageOf(0)));
    await useAssetStore.getState().ensurePage(0);
    expect(api.fetchAssetPage).toHaveBeenLastCalledWith({ cursor: undefined, limit: 200 });
    expect(useAssetStore.getState().items[0]!.asset?.id).toBe("a00000");

    // A middle page is refetched by the cursor that first fetched it
    useAssetStore.getState().trimLoaded(0, 100);
    const dropped = useAssetStore.getState().pages.findIndex((slot) => !slot.loaded);
    expect(dropped).toBe(25);
    api.fetchAssetPage.mockResolvedValueOnce(page(pageOf(25)));
    await useAssetStore.getState().ensurePage(25);
    expect(api.fetchAssetPage).toHaveBeenLastCalledWith({ cursor: "c25", limit: 200 });
  });

  it("fills a dropped page whose cursor no longer brings all of it back, so no tile stays a placeholder", async () => {
    const [n2, n1, a3, a2, a1] = [asset("n2", { createdAt: T0 + 5 }), asset("n1", { createdAt: T0 + 4 }), asset("a3", { createdAt: T0 + 3 }), asset("a2", { createdAt: T0 + 2 }), asset("a1", { createdAt: T0 + 1 })];
    const slot = (a: AssetView, pageIndex: number, loaded: boolean) => ({ id: a.id, createdAt: a.createdAt, kind: a.kind, asset: loaded ? a : null, page: pageIndex });
    // The first page (a3, a2, a1) was dropped for memory; two arrivals went in above it
    useAssetStore.setState({
      status: "ready",
      loadedQuery: {},
      items: [slot(n2, -1, true), slot(n1, -1, true), slot(a3, 0, false), slot(a2, 0, false), slot(a1, 0, false)],
      pages: [{ cursor: null, loaded: false }],
      total: 5,
    });
    // Asked again, "the newest page" starts with the arrivals; a2 fell off its end, a1 was deleted meanwhile
    api.fetchAssetPage.mockResolvedValueOnce(page([n2, n1, a3]));
    api.fetchAsset.mockImplementation(async (id: string) => (id === "a2" ? a2 : null));
    useAssetStore.getState().openDetail("a2");
    await vi.waitFor(() => expect(useAssetStore.getState().detailAsset?.id).toBe("a2"));
    expect(api.fetchAsset).toHaveBeenCalledTimes(2);
    expect(useAssetStore.getState().items.map((item) => [item.id, !!item.asset])).toEqual([
      ["n2", true],
      ["n1", true],
      ["a3", true],
      ["a2", true],
    ]);
    expect(useAssetStore.getState().pages[0]!.loaded).toBe(true);
    expect(useAssetStore.getState().total).toBe(4);
  });
});

describe("new arrivals", () => {
  beforeEach(async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2", { createdAt: T0 + 2 }), asset("a1", { createdAt: T0 + 1 })], { headCursor: "h2" }));
    await useAssetStore.getState().refresh();
  });

  it("go straight in at the top when the grid is scrolled to the top", async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3", { createdAt: T0 + 3 })], { headCursor: "h3" }));
    await useAssetStore.getState().pollArrivals();
    expect(api.fetchAssetPage).toHaveBeenLastCalledWith({ newerThan: "h2", limit: 200 });
    expect(ids()).toEqual(["a3", "a2", "a1"]);
    expect(useAssetStore.getState().headCursor).toBe("h3");
    expect(useAssetStore.getState().total).toBe(3);
  });

  it("wait behind the pill while the user is scrolled down, then go in on request", async () => {
    useAssetStore.getState().setScroll(800, false);
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3", { createdAt: T0 + 3 })], { headCursor: "h3" }));
    await useAssetStore.getState().pollArrivals();
    expect(ids()).toEqual(["a2", "a1"]);
    expect(useAssetStore.getState().arrivals.map((a) => a.id)).toEqual(["a3"]);

    const before = useAssetStore.getState().scrollToTopSeq;
    useAssetStore.getState().showArrivals();
    expect(ids()).toEqual(["a3", "a2", "a1"]);
    expect(useAssetStore.getState().scrollToTopSeq).toBe(before + 1);
  });

  it("keep coming while a page of them comes back full, so none are skipped", async () => {
    // Oldest first as made; the server sends each page newest first
    const made = Array.from({ length: 260 }, (_, i) => asset(`n${String(i).padStart(3, "0")}`, { createdAt: T0 + 10 + i }));
    const newestFirst = (list: AssetView[]) => [...list].reverse();
    api.fetchAssetPage.mockResolvedValueOnce(page(newestFirst(made.slice(0, 200)), { headCursor: "h199" }));
    api.fetchAssetPage.mockResolvedValueOnce(page(newestFirst(made.slice(200)), { headCursor: "h259" }));
    await useAssetStore.getState().pollArrivals();
    expect(api.fetchAssetPage).toHaveBeenNthCalledWith(2, { newerThan: "h2", limit: 200 });
    expect(api.fetchAssetPage).toHaveBeenNthCalledWith(3, { newerThan: "h199", limit: 200 });
    expect(ids()).toHaveLength(262);
    expect(ids().slice(0, 2)).toEqual(["n259", "n258"]);
    expect(ids().slice(-3)).toEqual(["n000", "a2", "a1"]);
    expect(useAssetStore.getState()).toMatchObject({ headCursor: "h259", total: 262 });
  });

  it("take what the server matched for the list as it is, without second-guessing it", async () => {
    useAssetStore.setState({ loadedQuery: { tags: ["hero"] } });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3", { createdAt: T0 + 3, tags: [] })], { headCursor: "h3" }));
    await useAssetStore.getState().pollArrivals();
    expect(ids()).toEqual(["a3", "a2", "a1"]);
  });

  it("start a new list at the top, and go straight into a list that was empty", async () => {
    useAssetStore.getState().setScroll(4000, false);
    // Trash is empty: no grid is mounted to scroll back up
    api.fetchAssetPage.mockResolvedValueOnce(page([]));
    useAssetStore.getState().setLibraryView("trash");
    await vi.waitFor(() => expect(useAssetStore.getState().loadedQuery).toEqual({ scope: "trash" }));
    expect(useAssetStore.getState()).toMatchObject({ scrollTop: 0, atTop: true });

    // Even if the grid last reported being scrolled down, an arrival into nothing shows
    useAssetStore.setState({ atTop: false, scrollTop: 900 });
    useAssetStore.getState().receiveArrivals([asset("t1", { trashedAt: 5, createdAt: T0 + 9 })]);
    expect(ids()).toEqual(["t1"]);
    expect(useAssetStore.getState()).toMatchObject({ arrivals: [], total: 1, atTop: true, scrollTop: 0 });
  });

  it("take recorder results only when they match the current query, once", () => {
    useAssetStore.getState().receiveArrivals([asset("v1", { kind: "video", createdAt: T0 + 5, trashedAt: 3 })]);
    expect(ids()).toEqual(["a2", "a1"]);
    useAssetStore.getState().receiveArrivals([asset("a3", { createdAt: T0 + 3 }), asset("a2")]);
    useAssetStore.getState().receiveArrivals([asset("a3", { createdAt: T0 + 3 })]);
    expect(ids()).toEqual(["a3", "a2", "a1"]);
  });

  it("never take a recorder result whose file is unreadable (the server never lists it)", () => {
    useAssetStore.getState().receiveArrivals([asset("u1", { createdAt: T0 + 7, unreadable: true })]);
    expect(ids()).toEqual(["a2", "a1"]);
    expect(matchesAssetQuery(asset("u1", { unreadable: true }), {})).toBe(false);
    expect(matchesAssetQuery(asset("u1", { unreadable: true, trashedAt: 1 }), { scope: "trash" })).toBe(false);
  });
});

describe("selection", () => {
  beforeEach(async () => {
    api.fetchAssetPage.mockResolvedValueOnce(
      page([asset("a4", { kind: "video" }), asset("a3"), asset("a2", { favorite: true }), asset("a1")], { total: 10, nextCursor: "c1" }),
    );
    await useAssetStore.getState().refresh();
  });

  it("toggles, and selects ranges in sort order from the anchor", () => {
    const store = useAssetStore.getState();
    store.toggleSelect("a3");
    store.selectRange("a1");
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: ["a3", "a2", "a1"] });
    useAssetStore.getState().toggleSelect("a2");
    expect(selectionCount(useAssetStore.getState())).toBe(2);
  });

  it("selects every loaded tile, then everything matching as a query with exclusions", () => {
    useAssetStore.getState().selectAllLoaded();
    expect(selectionCount(useAssetStore.getState())).toBe(4);
    expect(useAssetStore.getState().selectAllOffer).toBe(true);

    useAssetStore.getState().selectAllMatching();
    expect(useAssetStore.getState().selection).toEqual({ mode: "query", query: {}, excludeIds: [] });
    expect(selectionCount(useAssetStore.getState())).toBe(10);
    useAssetStore.getState().toggleSelect("a4");
    expect(useAssetStore.getState().selection).toEqual({ mode: "query", query: {}, excludeIds: ["a4"] });
    expect(selectionCount(useAssetStore.getState())).toBe(9);
  });

  it("keeps an ids selection through a filter change and counts what the filters hide", async () => {
    useAssetStore.getState().toggleSelect("a4");
    useAssetStore.getState().toggleSelect("a3");
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3")]));
    useAssetStore.getState().setFilters({ kinds: ["image"] });
    await vi.waitFor(() => expect(ids()).toEqual(["a3"]));
    expect(selectionCount(useAssetStore.getState())).toBe(2);
    expect(hiddenSelectionCount(useAssetStore.getState())).toBe(1);
  });

  it("drops a select-all-matching when the query changes", async () => {
    useAssetStore.getState().selectAllMatching();
    api.fetchAssetPage.mockResolvedValueOnce(page([]));
    useAssetStore.getState().setFilters({ kinds: ["audio"] });
    await vi.waitFor(() => expect(useAssetStore.getState().status).toBe("ready"));
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: [] });
  });

  it("drops the selection when the Library view changes: Trash and Missing act on it for good", async () => {
    useAssetStore.getState().toggleSelect("a3");
    useAssetStore.getState().toggleSelect("a1");
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("t1", { trashedAt: 1 })]));
    useAssetStore.getState().setLibraryView("trash");
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: [] });
    expect(useAssetStore.getState().selectedRecords).toEqual({});
    await vi.waitFor(() => expect(ids()).toEqual(["t1"]));
  });

  it("favorites in bulk unless every selected asset already is one", () => {
    useAssetStore.getState().toggleSelect("a2");
    expect(bulkFavoriteOp(useAssetStore.getState())).toEqual({ action: "unfavorite" });
    useAssetStore.getState().toggleSelect("a1");
    expect(bulkFavoriteOp(useAssetStore.getState())).toEqual({ action: "favorite" });
  });
});

describe("asset actions and undo", () => {
  beforeEach(async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3", { createdAt: T0 + 3 }), asset("a2", { createdAt: T0 + 2, tags: ["hero"] }), asset("a1", { createdAt: T0 + 1 })]));
    await useAssetStore.getState().refresh();
  });

  it("trashes the selection, then Undo restores it to its place", async () => {
    useAssetStore.getState().toggleSelect("a2");
    const selection = useAssetStore.getState().selection;
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    await useAssetStore.getState().runBulk(selection, { action: "trash" });
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["a2"] }, op: { action: "trash" } });
    expect(ids()).toEqual(["a3", "a1"]);
    expect(selectionCount(useAssetStore.getState())).toBe(0);
    expect(useAssetStore.getState().notice).toMatchObject({ message: "Trashed 1 asset", undo: true });

    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    await useAssetStore.getState().undo();
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["a2"] }, op: { action: "restore" } });
    expect(ids()).toEqual(["a3", "a2", "a1"]);
    expect(useAssetStore.getState().undoStack).toHaveLength(0);
  });

  it("puts back only what the server restored: an asset deleted for good since stays gone", async () => {
    api.bulkAssets.mockResolvedValueOnce({ affected: 2, ids: ["a3", "a2"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a3", "a2"] }, { action: "trash" });
    expect(ids()).toEqual(["a1"]);
    expect(useAssetStore.getState().total).toBe(1);

    // a2 was then deleted permanently from the Trash
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a3"], errors: [{ id: "a2", error: "Not found" }] });
    await useAssetStore.getState().undo();
    expect(ids()).toEqual(["a3", "a1"]);
    expect(useAssetStore.getState().total).toBe(2);
    expect(useAssetStore.getState().notice).toMatchObject({ message: "Undid: Trashed 2 assets · 1 asset no longer exists", tone: "error" });
  });

  it("says so when nothing could be undone, and changes nothing on screen", async () => {
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "favorite" });
    expect(useAssetStore.getState().items.find((item) => item.id === "a2")!.asset!.favorite).toBe(true);

    api.bulkAssets.mockResolvedValueOnce({ affected: 0, ids: [], errors: [{ id: "a2", error: "The library is busy" }] });
    await useAssetStore.getState().undo();
    expect(useAssetStore.getState().items.find((item) => item.id === "a2")!.asset!.favorite).toBe(true);
    expect(useAssetStore.getState().notice).toMatchObject({ message: "Couldn't undo: 1 asset could not be changed back", tone: "error" });
    expect(useAssetStore.getState().notice?.message).not.toMatch(/Undid/);
  });

  it("undoes a tag only on the assets that did not have it", async () => {
    api.bulkAssets.mockResolvedValueOnce({ affected: 2, ids: ["a2", "a1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2", "a1"] }, { action: "tag", tags: ["hero"] });
    expect(useAssetStore.getState().items.find((item) => item.id === "a1")!.asset!.tags).toEqual(["hero"]);

    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a1"], errors: [] });
    await useAssetStore.getState().undo();
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["a1"] }, op: { action: "untag", tags: ["hero"] } });
    expect(useAssetStore.getState().items.find((item) => item.id === "a1")!.asset!.tags).toEqual([]);
    expect(useAssetStore.getState().items.find((item) => item.id === "a2")!.asset!.tags).toEqual(["hero"]);
  });

  it("undoes favorites and unfavorites only where they changed something", async () => {
    useAssetStore.setState({ items: useAssetStore.getState().items.map((item) => (item.id === "a3" ? { ...item, asset: { ...item.asset!, favorite: true } } : item)) });
    api.bulkAssets.mockResolvedValueOnce({ affected: 3, ids: ["a3", "a2", "a1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a3", "a2", "a1"] }, { action: "favorite" });
    expect(useAssetStore.getState().undoStack.at(-1)!.steps).toEqual([{ selection: { mode: "ids", ids: ["a2", "a1"] }, op: { action: "unfavorite" } }]);

    api.bulkAssets.mockResolvedValueOnce({ affected: 3, ids: ["a3", "a2", "a1"], errors: [] });
    await useAssetStore.getState().undo();
    expect(useAssetStore.getState().items.map((item) => item.asset!.favorite)).toEqual([true, false, false]);

    api.bulkAssets.mockResolvedValueOnce({ affected: 3, ids: ["a3", "a2", "a1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a3", "a2", "a1"] }, { action: "unfavorite" });
    expect(useAssetStore.getState().undoStack.at(-1)!.steps).toEqual([{ selection: { mode: "ids", ids: ["a3"] }, op: { action: "favorite" } }]);
  });

  it("compares tags without case, as the server does, and puts an untagged one back as it was spelled", async () => {
    // a2 already carries "hero": tagging "Hero" does not change it
    api.bulkAssets.mockResolvedValueOnce({ affected: 2, ids: ["a2", "a1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2", "a1"] }, { action: "tag", tags: ["Hero"] });
    expect(useAssetStore.getState().items.find((item) => item.id === "a2")!.asset!.tags).toEqual(["hero"]);
    expect(useAssetStore.getState().undoStack.at(-1)!.steps).toEqual([{ selection: { mode: "ids", ids: ["a1"] }, op: { action: "untag", tags: ["Hero"] } }]);

    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "untag", tags: ["HERO"] });
    expect(useAssetStore.getState().items.find((item) => item.id === "a2")!.asset!.tags).toEqual([]);
    expect(useAssetStore.getState().undoStack.at(-1)!.steps).toEqual([{ selection: { mode: "ids", ids: ["a2"] }, op: { action: "tag", tags: ["hero"] } }]);
  });

  it("offers no Undo for a favorite or tag that reached assets it never loaded, rather than guess what they had", async () => {
    useAssetStore.setState({ total: 10 });
    useAssetStore.getState().selectAllMatching();
    const everything = ["a3", "a2", "a1", "u1", "u2", "u3", "u4", "u5", "u6", "u7"];
    api.bulkAssets.mockResolvedValueOnce({ affected: 10, ids: everything, errors: [] });
    await useAssetStore.getState().runBulk(useAssetStore.getState().selection, { action: "tag", tags: ["hero"] });
    api.bulkAssets.mockResolvedValueOnce({ affected: 10, ids: everything, errors: [] });
    await useAssetStore.getState().runBulk(useAssetStore.getState().selection, { action: "favorite" });
    expect(useAssetStore.getState().undoStack).toHaveLength(0);
    expect(useAssetStore.getState().notice).toMatchObject({
      message: "Added 10 assets to Favorites · Undo isn't available: not all of them were loaded",
      undo: false,
    });
  });

  it("keeps a tile that stops matching the filters after a favorite or tag change, and Undo restores it in place", async () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, view: "favorites" } });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("f2", { favorite: true }), asset("f1", { favorite: true })]));
    await useAssetStore.getState().refresh();
    useAssetStore.getState().openDetail("f2");

    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["f2"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["f2"] }, { action: "unfavorite" });
    // Still there, count unchanged, and the detail can still step through the list
    expect(ids()).toEqual(["f2", "f1"]);
    expect(useAssetStore.getState().total).toBe(2);
    expect(useAssetStore.getState().detailAsset?.favorite).toBe(false);
    // Selected there, it is not "hidden by filters" either: it is on screen
    useAssetStore.getState().toggleSelect("f2");
    expect(hiddenSelectionCount(useAssetStore.getState())).toBe(0);
    await useAssetStore.getState().stepDetail(1);
    expect(useAssetStore.getState().detailId).toBe("f1");

    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["f2"], errors: [] });
    await useAssetStore.getState().undo();
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["f2"] }, op: { action: "favorite" } });
    expect(useAssetStore.getState().items[0]!.asset!.favorite).toBe(true);
    expect(useAssetStore.getState().total).toBe(2);
  });

  it("keeps a search result that is favorited, whatever the client makes of the search", async () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, q: "golden lakeside" } });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("g1", { prompt: "golden light over a lakeside", favorite: true })]));
    await useAssetStore.getState().refresh();
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["g1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["g1"] }, { action: "unfavorite" });
    expect(ids()).toEqual(["g1"]);
    expect(useAssetStore.getState().total).toBe(1);
  });

  it("does not offer Undo for a permanent delete", async () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, view: "trash" } });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("t1", { trashedAt: 1 })]));
    await useAssetStore.getState().refresh();
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["t1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["t1"] }, { action: "delete" });
    expect(useAssetStore.getState().undoStack).toHaveLength(0);
    expect(useAssetStore.getState().notice).toMatchObject({ message: "Deleted 1 asset", undo: false });
  });

  it("moves the open detail on to the next asset when its asset is trashed", async () => {
    useAssetStore.getState().openDetail("a2");
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "trash" });
    expect(useAssetStore.getState().detailId).toBe("a1");
  });

  it("starts the list over after trashing everything matching, since that reached past the loaded pages", async () => {
    useAssetStore.getState().selectAllMatching();
    api.bulkAssets.mockResolvedValueOnce({ affected: 3, ids: ["a3", "a2", "a1"], errors: [] });
    api.fetchAssetPage.mockResolvedValueOnce(page([]));
    await useAssetStore.getState().runBulk(useAssetStore.getState().selection, { action: "trash" });
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "query", query: {}, excludeIds: [] }, op: { action: "trash" } });
    expect(selectionCount(useAssetStore.getState())).toBe(0);
    await vi.waitFor(() => expect(api.fetchAssetPage).toHaveBeenCalledTimes(2));
    // Undo still knows every id the server changed
    expect(useAssetStore.getState().undoStack.at(-1)!.steps).toEqual([
      { selection: { mode: "ids", ids: ["a3", "a2", "a1"] }, op: { action: "restore" } },
    ]);
  });

  it("reports a failed action and keeps the grid as it was", async () => {
    api.bulkAssets.mockRejectedValueOnce(new Error("The library is busy"));
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a1"] }, { action: "trash" });
    expect(ids()).toEqual(["a3", "a2", "a1"]);
    expect(useAssetStore.getState().notice).toMatchObject({ message: "The library is busy", tone: "error" });
  });
});

describe("actions stay inside the view", () => {
  const live = asset("a2");
  const trashed = asset("t1", { trashedAt: 1 });

  it("deletes permanently from the Trash only what is in the Trash", async () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, view: "trash" } });
    api.fetchAssetPage.mockResolvedValueOnce(page([trashed]));
    await useAssetStore.getState().refresh();
    // However a live asset got into the selection, the delete never reaches it
    useAssetStore.setState({ selection: { mode: "ids", ids: ["a2", "t1"] }, selectedRecords: { a2: live, t1: trashed } });
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["t1"], errors: [] });
    await useAssetStore.getState().runBulk(useAssetStore.getState().selection, { action: "delete" });
    expect(api.bulkAssets).toHaveBeenCalledTimes(1);
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["t1"] }, op: { action: "delete" } });
    expect(useAssetStore.getState().notice?.message).toBe("Deleted 1 asset · 1 not in this view left as they were");

    // Nothing of it in the Trash: nothing is sent
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "delete" });
    expect(api.bulkAssets).toHaveBeenCalledTimes(1);
    expect(useAssetStore.getState().notice).toMatchObject({ message: "None of the selected assets are in the Trash.", tone: "error" });
  });

  it("removes from the library only records whose file is missing, and never trashes from the Trash", async () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, view: "missing" } });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("m1", { missing: true })]));
    await useAssetStore.getState().refresh();
    useAssetStore.setState({ selectedRecords: { a2: live } });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "delete" });
    expect(api.bulkAssets).not.toHaveBeenCalled();
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["m1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["m1"] }, { action: "delete" });
    expect(api.bulkAssets).toHaveBeenLastCalledWith({ selection: { mode: "ids", ids: ["m1"] }, op: { action: "delete" } });

    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, view: "trash" }, loadedQuery: { scope: "trash" }, items: [], selectedRecords: { t1: trashed } });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["t1"] }, { action: "trash" });
    expect(api.bulkAssets).toHaveBeenCalledTimes(1);
  });

  it("refuses a select-all made for another view, and a permanent delete from the library view", async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([live]));
    await useAssetStore.getState().refresh();
    await useAssetStore.getState().runBulk({ mode: "query", query: {}, excludeIds: [] }, { action: "delete" });
    await useAssetStore.getState().runBulk({ mode: "query", query: { scope: "trash" }, excludeIds: [] }, { action: "restore" });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "delete" });
    expect(api.bulkAssets).not.toHaveBeenCalled();
    // A missing file's record may still be removed from the library view (the detail's banner)
    useAssetStore.setState({ selectedRecords: { m1: asset("m1", { missing: true }) } });
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["m1"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["m1"] }, { action: "delete" });
    expect(api.bulkAssets).toHaveBeenCalledTimes(1);
  });
});

describe("library jobs and switches", () => {
  const status = (overrides: Partial<LibraryStatus> = {}): LibraryStatus => ({
    available: true,
    root: "/lib",
    source: "default",
    defaultRoot: "/lib",
    cacheDir: "/cache",
    platform: "darwin",
    synced: null,
    counts: { assets: 2, trashed: 0, bytes: 0 },
    empty: false,
    job: null,
    ...overrides,
  });
  const job = (overrides: Partial<LibraryJobStatus> = {}): LibraryJobStatus => ({
    id: "j1",
    type: "import",
    state: "running",
    done: 3,
    total: 10,
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: 1,
    ...overrides,
  });

  beforeEach(async () => {
    useAssetStore.setState({ appView: "assets", library: status() });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2"), asset("a1")]));
    await useAssetStore.getState().refresh();
    expect(useAssetStore.getState().loadedRoot).toBe("/lib");
  });

  it("follows a job started elsewhere every second, then shows what it changed", async () => {
    vi.useFakeTimers();
    try {
      api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: job() }));
      await useAssetStore.getState().refreshLibrary();
      expect(useAssetStore.getState().job).toMatchObject({ id: "j1", state: "running", done: 3 });

      api.fetchJob.mockResolvedValueOnce(job({ done: 7 }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.fetchJob).toHaveBeenLastCalledWith("j1");
      expect(useAssetStore.getState().job).toMatchObject({ state: "running", done: 7 });

      const finished = job({ state: "done", done: 10, finishedAt: Date.now() });
      api.fetchJob.mockResolvedValueOnce(finished);
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2"), asset("old", { createdAt: T0 - 1e9 }), asset("a1")]));
      api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: finished, counts: { assets: 3, trashed: 0, bytes: 0 } }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(ids()).toEqual(["a2", "old", "a1"]));
      expect(useAssetStore.getState().job).toMatchObject({ state: "done" });
      expect(api.fetchFacets).toHaveBeenCalled();
      expect(api.fetchLibraryStatus).toHaveBeenCalledTimes(2);
      expect(useAssetStore.getState().notice?.message).toBe("Imported 10 files");

      // No more polling, and the finished job does not reload the list again
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.fetchJob).toHaveBeenCalledTimes(2);
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a running job it no longer follows once the status has none", async () => {
    useAssetStore.setState({ job: job({ id: "stale" }) });
    api.fetchLibraryStatus.mockResolvedValueOnce(status());
    await useAssetStore.getState().refreshLibrary();
    expect(useAssetStore.getState().job).toBeNull();
  });

  it("reloads the list once for a job that finished unseen after it loaded, and not for one before", async () => {
    api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: job({ id: "before", state: "done", finishedAt: 1 }) }));
    await useAssetStore.getState().refreshLibrary();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);

    const later = job({ id: "later", state: "done", finishedAt: Date.now() + 60_000 });
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2"), asset("old", { createdAt: T0 - 1e9 }), asset("a1")]));
    api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: later }));
    await useAssetStore.getState().refreshLibrary();
    await vi.waitFor(() => expect(ids()).toEqual(["a2", "old", "a1"]));
    api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: later }));
    await useAssetStore.getState().refreshLibrary();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
  });

  it("loads the list again when the library now lives elsewhere, without the old selection or detail", async () => {
    useAssetStore.getState().toggleSelect("a2");
    useAssetStore.getState().openDetail("a1");
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("b1")]));
    useAssetStore.getState().setLibrary(status({ root: "/Volumes/Other/Node Banana" }));
    expect(useAssetStore.getState()).toMatchObject({ selection: { mode: "ids", ids: [] }, detailId: null });
    await vi.waitFor(() => expect(ids()).toEqual(["b1"]));
    expect(useAssetStore.getState().loadedRoot).toBe("/Volumes/Other/Node Banana");
    expect(api.fetchFacets).toHaveBeenCalled();

    // The same folder again changes nothing
    useAssetStore.getState().setLibrary(status({ root: "/Volumes/Other/Node Banana" }));
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
  });

  it("never follows a job again once it has seen it end, whatever late status still calls it running", async () => {
    vi.useFakeTimers();
    try {
      api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: job({ id: "late" }) }));
      await useAssetStore.getState().refreshLibrary();
      const finished = job({ id: "late", state: "done", done: 10, finishedAt: Date.now() });
      api.fetchJob.mockResolvedValueOnce(finished);
      api.fetchAssetPage.mockResolvedValue(page([asset("a2"), asset("a1")]));
      api.fetchLibraryStatus.mockResolvedValueOnce(status({ job: finished }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(useAssetStore.getState().notice?.message).toBe("Imported 10 files"));
      const notice = useAssetStore.getState().notice;
      const pages = api.fetchAssetPage.mock.calls.length;

      // Settings' answer from while it ran, say, handed in through the recorder
      useAssetStore.getState().setLibrary(status({ job: job({ id: "late" }) }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(useAssetStore.getState().job).toMatchObject({ id: "late", state: "done" });
      expect(api.fetchJob).toHaveBeenCalledTimes(1);
      expect(useAssetStore.getState().notice).toBe(notice);
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(pages);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands its reads to the recorder, and drops one that lands after a newer status", async () => {
    let answer!: (value: LibraryStatus) => void;
    api.fetchLibraryStatus.mockReturnValueOnce(new Promise<LibraryStatus>((resolve) => (answer = resolve)));
    const late = useAssetStore.getState().refreshLibrary();
    // Settings switched the library while that read was out
    api.fetchAssetPage.mockResolvedValue(page([asset("b1")]));
    useAssetStore.getState().setLibrary(status({ root: "/new" }));
    answer(status());
    await late;
    expect(useAssetStore.getState().library?.root).toBe("/new");
    expect(recorder.applyLibraryStatus).not.toHaveBeenCalled();

    api.fetchLibraryStatus.mockResolvedValueOnce(status({ root: "/new", counts: { assets: 1, trashed: 0, bytes: 0 } }));
    await useAssetStore.getState().refreshLibrary();
    expect(recorder.applyLibraryStatus).toHaveBeenCalledWith(expect.objectContaining({ root: "/new", counts: { assets: 1, trashed: 0, bytes: 0 } }));
  });

  it("loads the new library's list once, however often its status comes while that list is on its way", async () => {
    useAssetStore.getState().toggleSelect("a2");
    let deliver!: (value: AssetPage) => void;
    api.fetchAssetPage.mockReturnValueOnce(new Promise<AssetPage>((resolve) => (deliver = resolve)));
    api.fetchLibraryStatus.mockResolvedValue(status({ root: "/new" }));
    await useAssetStore.getState().refreshLibrary();
    expect(useAssetStore.getState().selection).toEqual({ mode: "ids", ids: [] });
    // The recorder echoing it, and the next 5 s read, before the list lands
    useAssetStore.getState().setLibrary(status({ root: "/new" }));
    await useAssetStore.getState().refreshLibrary();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
    deliver(page([asset("b1")]));
    await vi.waitFor(() => expect(ids()).toEqual(["b1"]));
    expect(useAssetStore.getState().loadedRoot).toBe("/new");
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
  });

  it("forgets Undo when the library changes: its actions belong to the other one", async () => {
    api.bulkAssets.mockResolvedValueOnce({ affected: 1, ids: ["a2"], errors: [] });
    await useAssetStore.getState().runBulk({ mode: "ids", ids: ["a2"] }, { action: "trash" });
    expect(useAssetStore.getState().undoStack).toHaveLength(1);
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("b1")]));
    useAssetStore.getState().setLibrary(status({ root: "/new" }));
    expect(useAssetStore.getState().undoStack).toHaveLength(0);
  });
});

describe("app view", () => {
  it("toggles between canvas and assets", () => {
    expect(useAssetStore.getState().appView).toBe("canvas");
    useAssetStore.getState().toggleAppView();
    expect(useAssetStore.getState().appView).toBe("assets");
    useAssetStore.getState().setAppView("canvas");
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("toggles the named view against the canvas, and moves straight from one view to the other", () => {
    const { toggleAppView } = useAssetStore.getState();
    toggleAppView("chat");
    expect(useAssetStore.getState().appView).toBe("chat");
    toggleAppView("assets");
    expect(useAssetStore.getState().appView).toBe("assets");
    toggleAppView("chat");
    expect(useAssetStore.getState().appView).toBe("chat");
    toggleAppView("chat");
    expect(useAssetStore.getState().appView).toBe("canvas");
  });

  it("closes an open popover when the view changes", () => {
    useAssetStore.setState({ popover: { kind: "sort", x: 0, y: 0 } });
    useAssetStore.getState().toggleAppView("chat");
    expect(useAssetStore.getState().popover).toBeNull();
  });

  it("remembers the tile size per viewer", () => {
    useAssetStore.getState().setTileSize("l");
    expect(window.localStorage.getItem("node-banana-assets-tile-size")).toBe("l");
  });
});
