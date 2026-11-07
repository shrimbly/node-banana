import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AssetFacets, AssetPage, AssetView, LibraryStatus } from "@/lib/assets/types";

const api = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(),
  fetchFacets: vi.fn(),
  fetchAsset: vi.fn(),
  assetFileUrl: (id: string, download = false) => `/api/assets/${id}/file${download ? "?download=1" : ""}`,
  assetThumbUrl: (sha: string, width: number) => `/api/assets/thumb/${sha}?w=${width}`,
}));
vi.mock("@/lib/assets/client/api", () => api);

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

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: toast }) } }));

const uploadsApi = vi.hoisted(() => ({ recordUpload: vi.fn() }));
vi.mock("@/lib/assets/client/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/upload")>()),
  ...uploadsApi,
}));
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

import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { __resetEditProjectForTests, useEditProjectStore } from "@/store/editProjectStore";
import { __resetPosterRequestsForTests } from "@/components/assets/posterRequests";
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import { UPLOAD_ACCEPT } from "@/lib/assets/client/upload";
import { __resetAssetInfoForTests, getAssetInfo, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { createClip, sourceKey } from "@/lib/stitch/timeline";
import { DEFAULT_SEQUENCE_LAYOUT as TRACK_LAYOUT } from "@/lib/stitch/stack";
import { LibraryPicker } from "../library/LibraryPicker";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import type { StitchSequenceLayout, WorkflowNode } from "@/types";

const editor = () => useStitchEditorStore.getState();
const T0 = Date.UTC(2026, 9, 16, 12);

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

function page(assets: AssetView[], overrides: Partial<AssetPage> = {}): AssetPage {
  return { assets, nextCursor: null, headCursor: assets[0] ? "h" : null, total: assets.length, totalBytes: 0, ...overrides };
}

const facets = (projects: AssetFacets["projects"]): AssetFacets => ({
  total: 3,
  favorites: 0,
  trash: 0,
  missing: 0,
  kinds: { image: 0, video: 3, audio: 0, "3d": 0 },
  origins: { generated: 3, edited: 0, uploaded: 0 },
  models: [],
  tags: [],
  workflows: [],
  projects,
});

const lastRequest = () => api.fetchAssetPage.mock.calls[api.fetchAssetPage.mock.calls.length - 1][0];

/** An editor session with two clips of `clipSec` each, the picker open over it. */
function openPicker({
  workflowId = "wf_1" as string | null,
  clips = 2,
  clipSec = 4,
  sequenceLayout = TRACK_LAYOUT as StitchSequenceLayout,
  kind = "video" as "video" | "audio" | "all",
} = {}) {
  useWorkflowStore.setState({ workflowId });
  act(() => {
    editor().open({
      nodeId: "stitch",
      draft: {
        timeline: Array.from({ length: clips }, (_, i) => createClip({ kind: "edge", edgeId: `e${i}` }, { id: `c${i}` })),
        audioClips: [],
        legacyAudio: { curve: [], muted: false },
        loopCount: 1,
        sequenceLayout,
      },
      canvasGeneration: 0,
    });
    editor().setDurations(
      new Map(Array.from({ length: clips }, (_, i) => [sourceKey({ kind: "edge", edgeId: `e${i}` }), clipSec])),
    );
    editor().setPickerOpen(kind);
  });
  return render(<LibraryPicker />);
}

const dialog = () => screen.getByRole("dialog", { name: "Add media" });
const search = (scope = dialog()) => within(scope).getByRole("textbox", { name: "Search the library" });
/** The footer's left side: what is picked, how long it runs and (in the node's dialog) where it goes. */
const footerText = () => within(dialog()).getByRole("button", { name: "Cancel" }).parentElement!.firstElementChild!.textContent;
/** A tile's accessible name starts with its file name, then its length, project and flags. */
const named = (file: string) => new RegExp(`^${file.replace(/\./g, "\\.")}(,|$)`);
const tile = (file: string) => within(dialog()).getByRole("button", { name: named(file) });
const filterButton = (scope = dialog()) => within(scope).getByRole("button", { name: "Filter and sort" });
/** The search's filter popover, opened if it is not open yet. */
function filters(scope = dialog()) {
  const button = filterButton(scope);
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  return within(scope).getByRole("dialog", { name: "Filter and sort" });
}

/**
 * A press on `target`, with the focus a browser gives it (jsdom moves none): the nearest focusable ancestor takes it
 * (the page, when none does), then the click.
 */
function pressAt(target: HTMLElement) {
  const focusable = target.closest<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]");
  act(() => {
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  });
  fireEvent.click(target);
}

const fileInput = () => dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
const video = (name: string) => new File(["v"], name, { type: "video/mp4" });
/** A drag from the Finder, as jsdom can carry one: a plain object for the DataTransfer it lacks. */
const fileDrag = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files, dropEffect: "none" } });
/** An upload's record: the library names its file itself; the file's own name is its display name. */
const uploaded = (id: string, name: string, overrides: Partial<AssetView> = {}) =>
  asset(id, { origin: "uploaded", filename: `142233_${id}.mp4`, name, ...overrides });
/** Each recordUpload's answer, settled by the test. */
function answers() {
  const calls: { resolve: (asset: AssetView) => void; reject: (error: Error) => void }[] = [];
  uploadsApi.recordUpload.mockImplementation(() => new Promise((resolve, reject) => calls.push({ resolve, reject })));
  return calls;
}
const uploadsGroup = () => within(dialog()).queryByRole("group", { name: "Uploads" });

beforeEach(() => {
  __resetPosterRequestsForTests();
  __resetAssetInfoForTests();
  __resetEditProjectForTests();
  toast.mockClear();
  uploadsApi.recordUpload.mockReset();
  uploadsApi.recordUpload.mockImplementation(() => new Promise(() => {}));
  api.fetchAssetPage.mockReset();
  api.fetchFacets.mockReset();
  api.fetchAsset.mockReset();
  api.fetchAssetPage.mockResolvedValue(page([asset("a1"), asset("a2", { durationSec: 4.6 }), asset("a3")]));
  api.fetchFacets.mockResolvedValue(facets([]));
  api.fetchAsset.mockResolvedValue(null);
});

afterEach(() => {
  act(() => editor().close());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A stand-in IntersectionObserver (jsdom has none), put back by restore even when an assertion fails. The
 * sentinel is the grid's end marker; fire tells its observer that it came into view.
 */
function stubObserver() {
  const globals = globalThis as { IntersectionObserver?: unknown };
  const original = globals.IntersectionObserver;
  const live = new Set<{ callback: IntersectionObserverCallback; target: Element | null }>();
  let registered = 0;
  globals.IntersectionObserver = class {
    entry = { callback: null as unknown as IntersectionObserverCallback, target: null as Element | null };
    constructor(callback: IntersectionObserverCallback) {
      this.entry.callback = callback;
    }
    observe(target: Element) {
      this.entry.target = target;
      live.add(this.entry);
      registered++;
    }
    disconnect() {
      live.delete(this.entry);
    }
    unobserve() {}
  };
  return {
    /** How many observers have been registered so far. */
    registrations: () => registered,
    sentinel() {
      const entry = [...live].filter((o) => o.target?.getAttribute("aria-hidden") === "true").at(-1);
      return entry
        ? {
            fire: () =>
              entry.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
          }
        : null;
    },
    restore() {
      globals.IntersectionObserver = original;
    },
  };
}

/**
 * Fires the sentinel's observer once the list now shown has registered its own. The picker registers it in a
 * passive effect after the commit that findByRole waits for, and until then none is live, or the previous list's,
 * whose loadMore asks from that list's cursor. `after`: the registrations before that list landed.
 */
async function fireSentinel(observers: ReturnType<typeof stubObserver>, after: number): Promise<void> {
  await waitFor(() => expect(observers.registrations()).toBeGreaterThan(after));
  act(() => observers.sentinel()!.fire());
}

describe("LibraryPicker", () => {
  it("lists the library's videos, 60 at a time, and nothing else by default", async () => {
    openPicker();
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeInTheDocument();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);
    expect(api.fetchAssetPage.mock.calls[0][0]).toEqual({ kinds: ["video"], limit: 60 });
    expect(api.fetchAssetPage.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    // The tile: a cover under its project's name, with nothing on it at rest but its length in whole seconds; its
    // name shows on keyboard focus alone, which no title tooltip follows
    expect(within(tile("a2.mp4")).getByText("0:05")).toBeInTheDocument();
    expect(within(tile("a2.mp4")).getByText("a2.mp4").closest("[data-testid='library-tile-focus-name']")).toHaveClass(
      "opacity-0",
      "group-focus-visible:opacity-100",
    );
    expect(within(tile("a2.mp4")).queryByText("Launch film")).toBeNull();
    expect(within(dialog()).getByRole("group", { name: "Launch film" })).toContainElement(tile("a2.mp4"));
    // Everything the tile knows is in its name, its length to a tenth; the file name is its tooltip
    expect(tile("a2.mp4")).toHaveAccessibleName("a2.mp4, 0:04.6, Launch film");
    expect(tile("a2.mp4")).toHaveAttribute("title", "a2.mp4");
    // Nothing narrows the list: no dot on the filter button
    expect(filterButton()).not.toHaveAttribute("data-filtered");
    expect(filterButton()).not.toHaveAccessibleDescription();
  });

  it("groups the files by project, each where its first file comes in the list", async () => {
    const elsewhere = { id: "wf_2", name: "Desert", projectPath: "/Users/me/Node Banana/Desert spots" };
    api.fetchAssetPage.mockResolvedValue(
      page([asset("a1"), asset("d1", { workflow: elsewhere }), asset("a2"), asset("n1", { workflow: { id: "wf_3", name: null, projectPath: null } }), asset("d2", { workflow: elsewhere })]),
    );
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    expect(within(dialog()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Launch film",
      "Desert spots",
      "Not in a project",
    ]);
    // In ink-3 on the picker's pane ground, where it reads at 5.7:1
    for (const label of within(dialog()).getAllByRole("heading", { level: 3 })) {
      expect(label).toHaveClass("text-ink-3");
    }
    const ids = (name: string) =>
      [...within(dialog()).getByRole("group", { name }).querySelectorAll("[data-asset-id]")].map((el) => el.getAttribute("data-asset-id"));
    expect(ids("Launch film")).toEqual(["a1", "a2"]);
    expect(ids("Desert spots")).toEqual(["d1", "d2"]);
    expect(ids("Not in a project")).toEqual(["n1"]);
  });

  it("searches 200 ms after the last key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    openPicker();
    await act(async () => {});
    fireEvent.change(search(), { target: { value: "veo" } });
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
    expect(lastRequest()).toEqual({ kinds: ["video"], limit: 60, q: "veo" });
  });

  it("narrows to favourites and to this workflow, from the search's filter button, which then shows a dot", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    expect(filterButton()).toHaveAttribute("aria-expanded", "false");
    const panel = filters();
    expect(filterButton()).toHaveAttribute("aria-expanded", "true");
    // It takes focus as it opens: on its first row, the kind it opened on
    expect(within(panel).getByRole("radio", { name: "Video" })).toHaveFocus();
    fireEvent.click(within(panel).getByRole("switch", { name: "Favorites" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true }));
    fireEvent.click(within(filters()).getByRole("switch", { name: "This workflow" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true, workflowIds: ["wf_1"] }));
    expect(within(filters()).getByRole("switch", { name: "This workflow" })).toHaveAttribute("aria-checked", "true");
    expect(filterButton()).toHaveAttribute("data-filtered", "true");
    expect(filterButton()).toHaveAccessibleDescription("Filters are on");
    // A click on a row's label toggles its switch too
    fireEvent.click(within(filters()).getByText("Favorites"));
    await waitFor(() => expect(lastRequest()).not.toHaveProperty("favorite"));
    // A press outside closes the popover; the dot stays while This workflow is on
    fireEvent.pointerDown(screen.getByTestId("stitch-library-grid"));
    expect(within(dialog()).queryByRole("dialog", { name: "Filter and sort" })).toBeNull();
    expect(filterButton()).toHaveAttribute("data-filtered", "true");
  });

  it("cannot narrow to a workflow that has no id yet", async () => {
    openPicker({ workflowId: null });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const toggle = within(filters()).getByRole("switch", { name: "This workflow" });
    expect(toggle).toBeDisabled();
    // The switch itself says why, to a screen reader as to a pointer over its row
    expect(toggle).toHaveAccessibleDescription("Nothing from this workflow is in the library yet");
    expect(toggle.closest("label")).toHaveAttribute("title", "Nothing from this workflow is in the library yet");
  });

  it("narrows to a project from the library's own list", async () => {
    api.fetchFacets.mockResolvedValue(
      facets([
        { path: "/p", name: "Launch film", count: 3 },
        { path: null, name: "Not in a project", count: 1 },
      ]),
    );
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(within(filters()).getByRole("button", { name: "Project: All projects" }));
    const menu = await screen.findByRole("menu", { name: "Project: All projects" });
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3));
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Launch film" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ projects: ["/p"] }));
    expect(screen.queryByRole("menu")).toBeNull();
    // The pick closes the menu, not the filters, and gives focus back to its field
    expect(within(filters()).getByRole("button", { name: "Project: Launch film" })).toHaveFocus();
    fireEvent.click(within(filters()).getByRole("button", { name: "Project: Launch film" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Not in a project" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ projects: [""] }));
    expect(filterButton()).toHaveAttribute("data-filtered", "true");
  });

  it("sorts oldest first; Escape closes the project menu, then the filters, but not the picker", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const sort = within(filters()).getByRole("radiogroup", { name: "Sort" });
    expect(within(sort).getByRole("radio", { name: "Newest" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(sort).getByRole("radio", { name: "Oldest" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ sort: "oldest" }));
    expect(within(sort).getByRole("radio", { name: "Oldest" })).toHaveAttribute("aria-checked", "true");
    expect(filterButton()).toHaveAttribute("data-filtered", "true");
    // One tab stop; the arrows move the choice
    expect(within(sort).getByRole("radio", { name: "Newest" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(within(sort).getByRole("radio", { name: "Oldest" }), { key: "ArrowLeft" });
    await waitFor(() => expect(lastRequest()).not.toHaveProperty("sort"));
    expect(within(sort).getByRole("radio", { name: "Newest" })).toHaveFocus();
    expect(filterButton()).not.toHaveAttribute("data-filtered");

    fireEvent.click(within(filters()).getByRole("button", { name: "Project: All projects" }));
    const menu = screen.getByRole("menu", { name: "Project: All projects" });
    fireEvent.keyDown(within(menu).getByRole("menuitemradio", { name: "All projects" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(dialog()).getByRole("dialog", { name: "Filter and sort" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(within(dialog()).queryByRole("dialog", { name: "Filter and sort" })).toBeNull();
    expect(filterButton()).toHaveFocus();
    expect(editor().pickerOpen).toBe("video");
  });

  it("counts the picked videos, their length in whole seconds and where they go", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    expect(within(dialog()).getByRole("button", { name: "Add" })).toBeDisabled();
    // Where they go is said only once something is picked
    expect(footerText()).toBe("Pick videos or audio to add");
    fireEvent.click(tile("a1.mp4"));
    expect(footerText()).toBe("1 video·0:05goes after Clip 2");
    expect(within(dialog()).getByRole("button", { name: "Add" })).toBeEnabled();
    fireEvent.click(tile("a2.mp4"));
    expect(tile("a2.mp4")).toHaveAttribute("aria-pressed", "true");
    expect(tile("a2.mp4").className).toMatch(/\bring-neutral-100\b/);
    // 5 s and 4.6 s
    expect(within(dialog()).getByText("2 videos")).toBeInTheDocument();
    expect(footerText()).toBe("2 videos·0:10goes after Clip 2");
    // A second press takes a video back out
    fireEvent.click(tile("a1.mp4"));
    expect(footerText()).toBe("1 video·0:05goes after Clip 2");
  });

  it("names the clip that ends last in a placed stack, where new clips start under it", async () => {
    openPicker({ clips: 3, clipSec: 4, sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    // Clip 1 placed at 10 s ends last (14 s); Clips 2 and 3 end at 4 s and 6 s
    act(() =>
      editor().apply((d) => ({
        ...d,
        timeline: d.timeline.map((clip, i) => ({ ...clip, startSec: [10, 0, 2][i] })),
      })),
    );
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    expect(within(dialog()).getByText("goes after Clip 1")).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(editor().draft!.timeline[3].startSec).toBeUndefined();
    expect(editor().playhead).toBe(13);
  });

  it("says a clip goes first on an empty timeline", async () => {
    openPicker({ clips: 0 });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    expect(within(dialog()).getByText("goes first")).toBeInTheDocument();
  });

  it("appends the picked videos as library clips in the order they were picked, in one step, and closes", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a3.mp4"));
    fireEvent.click(tile("a1.mp4"));
    const before = editor().past.length;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    const timeline = editor().draft!.timeline;
    expect(timeline.map((c) => c.source)).toEqual([
      { kind: "edge", edgeId: "e0" },
      { kind: "edge", edgeId: "e1" },
      { kind: "asset", assetId: "a3" },
      { kind: "asset", assetId: "a1" },
    ]);
    expect(timeline.slice(2).every((c) => !c.muted && c.volume === 1 && c.inSec === 0 && c.outSec === null)).toBe(true);
    expect(editor().past.length).toBe(before + 1);
    expect(editor().selection).toEqual({ kind: "clip", clipId: timeline[2].id });
    // After the two 4 s clips
    expect(editor().playhead).toBe(8);
    expect(editor().pickerOpen).toBe(false);
    // Labelled from the page's records, with nothing asked again
    expect(getAssetInfo("a3")?.filename).toBe("a3.mp4");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull());
  });

  it("puts the playhead on a new clip's first frame in Stacked, where it starts under the last clip", async () => {
    openPicker({ clips: 1, clipSec: 5, sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    // The footer still says where it goes in the order, and how much footage is picked
    expect(footerText()).toBe("1 video·0:05goes after Clip 1");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(editor().draft!.timeline).toHaveLength(2);
    // The 5 s clip ends at 5; the new 5 s clip starts 1 s before that
    expect(editor().playhead).toBe(4);
  });

  it("cannot pick a video whose file is missing", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("a1", { missing: true }), asset("a2")]));
    openPicker();
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeDisabled();
    expect(tile("a1.mp4")).toHaveAttribute("title", "a1.mp4\nThe file is missing");
    expect(tile("a2.mp4")).toBeEnabled();
  });

  it("drops an answer to a query that is no longer current", async () => {
    let answerFirst!: (value: AssetPage) => void;
    api.fetchAssetPage.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("fav", { favorite: true })]));
    openPicker();
    fireEvent.click(within(filters()).getByRole("switch", { name: "Favorites" }));
    expect(await within(dialog()).findByRole("button", { name: named("fav.mp4") })).toBeInTheDocument();
    expect(tile("fav.mp4")).toHaveAccessibleName("fav.mp4, 0:05.0, Launch film, favorite");
    await act(async () => answerFirst(page([asset("stale")])));
    expect(within(dialog()).queryByRole("button", { name: named("stale.mp4") })).toBeNull();
    expect(tile("fav.mp4")).toBeInTheDocument();
  });

  it("says when the library has no videos, when nothing matches, and the list's error", async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([]));
    openPicker();
    expect(await within(dialog()).findByText("No videos in the library yet")).toBeInTheDocument();
    api.fetchAssetPage.mockResolvedValueOnce(page([]));
    fireEvent.click(within(filters()).getByRole("switch", { name: "Favorites" }));
    expect(await within(dialog()).findByText("No videos match")).toBeInTheDocument();
    api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
    fireEvent.click(within(filters()).getByRole("switch", { name: "Favorites" }));
    expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
  });

  it("says when the library has neither, and when neither matches, set to both kinds", async () => {
    api.fetchAssetPage.mockResolvedValue(page([]));
    openPicker({ kind: "all" });
    expect(await within(dialog()).findByText("Nothing in the library yet")).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: "veo" } });
    expect(await within(dialog()).findByText("No videos or audio match")).toBeInTheDocument();
  });

  it("asks for a first page that failed again from its Try again", async () => {
    api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
    openPicker();
    expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeInTheDocument();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
    expect(api.fetchAssetPage.mock.calls[1][0]).toEqual(api.fetchAssetPage.mock.calls[0][0]);
    expect(within(dialog()).queryByText("The library is moving.")).toBeNull();
  });

  it("starts a new query's list at the top", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const grid = screen.getByTestId("stitch-library-grid");
    grid.scrollTop = 300;
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("fav", { favorite: true }), asset("a2"), asset("a3")]));
    fireEvent.click(within(filters()).getByRole("switch", { name: "Favorites" }));
    await within(dialog()).findByRole("button", { name: named("fav.mp4") });
    expect(grid.scrollTop).toBe(0);
  });

  it("loads the next page from the cursor as the end of the grid comes into view, and stops at the end", async () => {
    const observers = stubObserver();
    try {
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1")], { nextCursor: "c1", total: 2 }));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: "c1", total: 2 }));
      // Nothing new on the same cursor: the end, whatever the server says
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1"), asset("a2")], { nextCursor: "c1", total: 2 }));
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      await fireSentinel(observers, 0);
      const mark = observers.registrations();
      expect(await within(dialog()).findByRole("button", { name: named("a2.mp4") })).toBeInTheDocument();
      expect(lastRequest()).toEqual({ kinds: ["video"], limit: 60, cursor: "c1" });
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
      await fireSentinel(observers, mark);
      await waitFor(() => expect(api.fetchAssetPage).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(observers.sentinel()).toBeNull());
      expect(dialog().querySelectorAll("[data-asset-id]")).toHaveLength(2);
    } finally {
      observers.restore();
    }
  });

  it("asks no next page from the list while the same query's first page is out again, so none goes missing", async () => {
    const observers = stubObserver();
    try {
      let answerAgain!: (value: AssetPage) => void;
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1")], { nextCursor: "c1", total: 3 }));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: "c2", total: 3 }));
      // Favourites on (never answers), then off again: the first page is asked again
      api.fetchAssetPage.mockImplementationOnce(() => new Promise(() => {}));
      api.fetchAssetPage.mockImplementationOnce(() => new Promise((resolve) => (answerAgain = resolve)));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: "c2", total: 3 }));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3")], { nextCursor: null, total: 3 }));
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      await fireSentinel(observers, 0);
      await within(dialog()).findByRole("button", { name: named("a2.mp4") });
      const favourites = within(filters()).getByRole("switch", { name: "Favorites" });
      fireEvent.click(favourites);
      fireEvent.click(favourites);
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(4);
      // The old list is still shown; its end coming into view asks nothing yet
      act(() => observers.sentinel()?.fire());
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(4);
      let mark = observers.registrations();
      await act(async () => answerAgain(page([asset("a1")], { nextCursor: "c1", total: 3 })));
      await fireSentinel(observers, mark);
      mark = observers.registrations();
      await within(dialog()).findByRole("button", { name: named("a2.mp4") });
      await fireSentinel(observers, mark);
      await within(dialog()).findByRole("button", { name: named("a3.mp4") });
      expect(api.fetchAssetPage.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1", undefined, undefined, "c1", "c2"]);
      expect([...dialog().querySelectorAll("[data-asset-id]")].map((el) => el.getAttribute("data-asset-id"))).toEqual([
        "a1",
        "a2",
        "a3",
      ]);
    } finally {
      observers.restore();
    }
  });

  it("asks nothing again when the workflow's id changes while This workflow is off", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    act(() => useWorkflowStore.setState({ workflowId: "wf_2" }));
    await act(async () => {});
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);
    expect(tile("a1.mp4")).toBeInTheDocument();
  });

  it("keeps the list when a next page fails, says so, and tries the same cursor again", async () => {
    const observers = stubObserver();
    try {
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1")], { nextCursor: "c1", total: 2 }));
      api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: null, total: 2 }));
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      await fireSentinel(observers, 0);
      expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
      expect(tile("a1.mp4")).toBeInTheDocument();
      // Not asked again by itself: no observer is left on the failed list
      await waitFor(() => expect(observers.sentinel()).toBeNull());
      fireEvent.click(within(dialog()).getByRole("button", { name: "Try again" }));
      expect(await within(dialog()).findByRole("button", { name: named("a2.mp4") })).toBeInTheDocument();
      expect(api.fetchAssetPage.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1", "c1"]);
      expect(within(dialog()).queryByText("The library is moving.")).toBeNull();
    } finally {
      observers.restore();
    }
  });

  it("asks for a poster for a tile on screen that has none, and shows it once made", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("np", { hasPoster: false }), asset("a2")]));
    openPicker();
    const npTile = await within(dialog()).findByRole("button", { name: named("np.mp4") });
    await waitFor(() => expect(poster.ensurePoster).toHaveBeenCalledWith(expect.objectContaining({ id: "np" }), expect.anything()));
    expect(poster.ensurePoster).toHaveBeenCalledTimes(1);
    const before = npTile.querySelector("img")!.getAttribute("src");
    act(() => poster.listener!("np"));
    const after = npTile.querySelector("img")!.getAttribute("src");
    expect(after).not.toBe(before);
    expect(after).toBe(tile("a2.mp4").querySelector("img")!.getAttribute("src")!.replace("a2", "np"));
  });

  it("closes on a press on the scrim, but not on a drag from inside let go over it", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    const scrim = dialog().parentElement!;
    // Chromium sends the click to the common ancestor: the scrim
    fireEvent.pointerDown(search());
    fireEvent.click(scrim);
    expect(editor().pickerOpen).toBe("video");
    expect(within(dialog()).getByText("1 video")).toBeInTheDocument();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(editor().pickerOpen).toBe(false);
  });

  it("closes an open menu on a wheel over the grid", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(within(filters()).getByRole("button", { name: "Project: All projects" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.wheel(screen.getByTestId("stitch-library-grid"), { deltaY: 40 });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("calls a cover by the name it was given, in its focus chip, its tooltip and its accessible name", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("a2", { name: "Opening shot" })]));
    openPicker();
    const cover = await within(dialog()).findByRole("button", { name: named("Opening shot") });
    expect(within(cover).getByTestId("library-tile-focus-name")).toHaveTextContent(/^Opening shot$/);
    expect(cover).toHaveAttribute("title", "Opening shot");
    expect(cover).toHaveAccessibleName("Opening shot, 0:05.0, Launch film");
  });

  it("rings a picked cover in white, and draws nothing on a cover but its picture and length", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    // At rest: the name keyboard focus shows is not drawn
    const focusName = within(tile("a1.mp4")).getByTestId("library-tile-focus-name");
    expect(focusName).toHaveClass("opacity-0");
    const marks = () => [...tile("a1.mp4").children].filter((el) => el !== focusName).map((el) => el.tagName);
    expect(tile("a1.mp4").className).not.toMatch(/ring-selection/);
    expect(marks()).toEqual(["IMG", "SPAN"]);
    fireEvent.click(tile("a1.mp4"));
    expect(tile("a1.mp4").className).toMatch(/\bring-neutral-100\b/);
    // The ring is the pick (aria-pressed says it): no badge on the picture
    expect(marks()).toEqual(["IMG", "SPAN"]);
    expect(within(tile("a1.mp4")).queryByLabelText("Selected")).toBeNull();
  });

  it("rings its own buttons in the editor's white, Close and Upload in the header as well as the footer's", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const own = ["Close", "Upload", "Cancel", "Add"].map((name) => within(dialog()).getByRole("button", { name }));
    for (const button of own) {
      expect(button.className).not.toMatch(/ring-selection/);
      expect(button.className.split(" ")).toContain("focus-visible:ring-white/40");
    }
    // The footer's set off from the pane they sit on, not the dialogs' card
    for (const button of own.slice(2)) {
      expect(button.className.split(" ")).toContain("focus-visible:ring-offset-pane");
      expect(button.className).not.toMatch(/ring-offset-card/);
    }
    // And the covers, on the same pane
    expect(tile("a1.mp4").className.split(" ")).toContain("focus-visible:ring-offset-pane");
    expect(tile("a1.mp4").className).not.toMatch(/ring-offset-card/);
    expect(within(dialog()).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    fireEvent.click(own[0]);
    expect(editor().pickerOpen).toBe(false);
  });

  it("draws a cover it has no picture for as a grey frame, never a tinted placeholder", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("gone", { missing: true }), asset("a2")]));
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a2.mp4") });
    const blank = (cover: HTMLElement) => {
      expect(cover.querySelector("img")).toBeNull();
      expect(cover.querySelector("svg")).not.toBeNull();
      expect(cover.innerHTML).not.toMatch(/handle-/);
    };
    // A file that is gone
    blank(tile("gone.mp4"));
    // A thumbnail that fails to load
    fireEvent.error(tile("a2.mp4").querySelector("img")!);
    blank(tile("a2.mp4"));
    // Its length, and its name for keyboard focus only
    const focusName = within(tile("a2.mp4")).getByTestId("library-tile-focus-name");
    expect(focusName).toHaveClass("opacity-0");
    expect(tile("a2.mp4").textContent!.replace(focusName.textContent!, "")).toBe("0:05");
  });

  it("stays open under a press on its padding or a row's label, which still toggles the switch, and still hears Escape", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const panel = filters();
    const open = () => within(dialog()).queryByRole("dialog", { name: "Filter and sort" });
    // Its padding: the popover takes focus, not the dialog around it (which would close it)
    pressAt(panel);
    expect(panel).toHaveFocus();
    expect(open()).toBe(panel);
    // A row's label, and a switch row's, which toggles its switch
    pressAt(within(panel).getByText("Sort"));
    expect(open()).toBe(panel);
    pressAt(within(panel).getByText("Favorites"));
    await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true }));
    expect(open()).toBe(panel);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(open()).toBeNull();
    expect(filterButton()).toHaveFocus();
    expect(editor().pickerOpen).toBe("video");
  });

  it("is one quiet row on the pane: Add media, the search, then Upload and Close; no description", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    expect(dialog()).toHaveClass("bg-pane", "border-edit-line");
    expect(dialog()).not.toHaveClass("bg-card");
    const title = within(dialog()).getByRole("heading", { level: 2, name: "Add media" });
    const header = title.closest(".border-b")!;
    expect(header).toHaveClass("border-edit-line");
    // In the header's order: the title, the search, Upload, Close; nothing under them
    expect(within(header as HTMLElement).getByRole("textbox", { name: "Search the library" })).toBe(search());
    expect([...header.querySelectorAll("button[aria-label], button:not([aria-label])")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Filter and sort",
      "Upload",
      "Close",
    ]);
    expect(header.querySelector("p")).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Cancel" }).parentElement).toHaveClass("border-edit-line");
  });

  it("filters by kind first, set to what opened it; another kind asks for it, keeps the picks and shows the dot until it is back", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    const panel = filters();
    const kind = within(panel).getByRole("radiogroup", { name: "Kind" });
    // The first row, before Project
    expect(panel.querySelector('[role="radiogroup"]')).toBe(kind);
    const project = within(panel).getByRole("button", { name: "Project: All projects" });
    expect(kind.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(kind).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All", "Video", "Audio"]);
    expect(within(kind).getByRole("radio", { name: "Video" })).toHaveAttribute("aria-checked", "true");
    expect(filterButton()).not.toHaveAttribute("data-filtered");

    const sound = asset("t1", { kind: "audio", mime: "audio/mp4", ext: "m4a", filename: "t1.m4a", durationSec: 3, hasPoster: false });
    api.fetchAssetPage.mockResolvedValueOnce(page([sound]));
    fireEvent.click(within(kind).getByRole("radio", { name: "Audio" }));
    await waitFor(() => expect(lastRequest()).toEqual({ kinds: ["audio"], limit: 60 }));
    expect(await within(dialog()).findByRole("button", { name: named("t1.m4a") })).toBeInTheDocument();
    expect(filterButton()).toHaveAttribute("data-filtered", "true");
    // The same picker: its pick stays
    expect(footerText()).toBe("1 video·0:05goes after Clip 2");
    fireEvent.click(within(filters()).getByRole("radio", { name: "All" }));
    await waitFor(() => expect(lastRequest()).toEqual({ kinds: ["video", "audio"], limit: 60 }));
    fireEvent.click(within(filters()).getByRole("radio", { name: "Video" }));
    await waitFor(() => expect(lastRequest()).toEqual({ kinds: ["video"], limit: 60 }));
    expect(filterButton()).not.toHaveAttribute("data-filtered");
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toHaveAttribute("aria-pressed", "true");
    expect(editor().pickerOpen).toBe("video");
  });

  it("set to both kinds as it opens, shows no dot for it", async () => {
    openPicker({ kind: "all" });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    expect(within(filters()).getByRole("radio", { name: "All" })).toHaveFocus();
    expect(filterButton()).not.toHaveAttribute("data-filtered");
  });

  it("Enter in the search goes to the first file that can be picked", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("gone", { missing: true }), asset("a2"), asset("a3")]));
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a2.mp4") });
    act(() => search().focus());
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      search().dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(tile("a2.mp4")).toHaveFocus();
    // Enter or Space on it is the button's own click, which picks it
    expect(tile("a2.mp4").tagName).toBe("BUTTON");
    fireEvent.click(tile("a2.mp4"));
    expect(tile("a2.mp4")).toHaveAttribute("aria-pressed", "true");

    // With nothing to go to, Enter stays in the search
    api.fetchAssetPage.mockResolvedValue(page([]));
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(await within(dialog()).findByText("No videos match")).toBeInTheDocument();
    act(() => search().focus());
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(search()).toHaveFocus();
  });

  describe("Upload", () => {
    it("opens the file chooser for the video and audio formats the library keeps, many at once", async () => {
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      const input = fileInput();
      // Not every video and audio file: an AVI or an AIFF couldn't be added
      expect(input).toHaveAttribute("accept", UPLOAD_ACCEPT);
      expect(UPLOAD_ACCEPT.split(",")).toEqual(expect.arrayContaining(["video/mp4", ".mov", "audio/wav", ".m4a"]));
      expect(input.multiple).toBe(true);
      // Never a stop of its own: Upload is
      expect(input).toHaveAttribute("tabindex", "-1");
      const choose = vi.spyOn(input, "click").mockImplementation(() => {});
      fireEvent.click(within(dialog()).getByRole("button", { name: "Upload" }));
      expect(choose).toHaveBeenCalledTimes(1);
    });

    it("shows each file at the top as it uploads, then as a picked tile, whatever the filters say", async () => {
      const calls = answers();
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      const take = video("take one.mp4");
      const voice = new File(["a"], "voice.m4a", { type: "audio/mp4" });
      const clear = vi.spyOn(fileInput(), "value", "set");
      fireEvent.change(fileInput(), { target: { files: [take, new File(["t"], "notes.txt", { type: "text/plain" }), voice] } });
      // Cleared, so the same file can be chosen again
      expect(clear).toHaveBeenCalledWith("");
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith("Only video and audio files can be added.", "info");
      // Outside an edit: under Uploads
      expect(uploadsApi.recordUpload.mock.calls).toEqual([
        [take, {}],
        [voice, {}],
      ]);
      const group = uploadsGroup()!;
      // At the top, before the projects' groups
      expect(dialog().querySelector('[role="group"]')).toBe(group);
      expect(group).toHaveTextContent(/^Uploadstake one\.mp4Uploading…voice\.m4aUploading…$/);
      expect(group.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
      expect(within(group).queryByRole("button")).toBeNull();
      // Add waits for them: one still uploading would be left out
      const add = () => within(dialog()).getByRole("button", { name: "Add" });
      expect(footerText()).toBe("Uploading 2 files…");
      expect(add()).toBeDisabled();

      await act(async () => calls[0].resolve(uploaded("up1", "take one.mp4")));
      const picked = within(group).getByRole("button", { name: named("take one.mp4") });
      expect(picked).toHaveAttribute("aria-pressed", "true");
      expect(group).toHaveTextContent("voice.m4aUploading…");
      expect(footerText()).toBe("1 video·0:05Uploading 1 file…");
      expect(add()).toBeDisabled();
      expect(getAssetInfo("up1")?.name).toBe("take one.mp4");

      // Still at the top and picked under a filter that lists nothing, and never twice once the list has it too
      api.fetchAssetPage.mockResolvedValueOnce(page([]));
      fireEvent.click(within(filters()).getByRole("switch", { name: "Favorites" }));
      await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true }));
      expect(within(uploadsGroup()!).getByRole("button", { name: named("take one.mp4") })).toHaveAttribute("aria-pressed", "true");
      expect(within(dialog()).getByText("No videos match")).toBeInTheDocument();
      api.fetchAssetPage.mockResolvedValueOnce(page([uploaded("up1", "take one.mp4"), asset("a2")]));
      fireEvent.click(within(filters()).getByRole("switch", { name: "Favorites" }));
      await within(dialog()).findByRole("button", { name: named("a2.mp4") });
      expect(dialog().querySelectorAll('[data-asset-id="up1"]')).toHaveLength(1);

      // Add takes it with the rest
      await act(async () => calls[1].resolve(uploaded("up2", "voice.m4a", { kind: "audio", mime: "audio/mp4", ext: "m4a", durationSec: 3 })));
      expect(footerText()).toBe("1 video and 1 audio file·0:08the video goes after Clip 2, the audio file starts at 0:00.00 on a new row");
      fireEvent.click(add());
      expect(editor().draft!.timeline.map((c) => c.source)).toContainEqual({ kind: "asset", assetId: "up1" });
      expect(editor().draft!.audioClips.map((c) => c.source)).toEqual([{ kind: "asset", assetId: "up2" }]);
    });

    it("says nothing under its uploads in a library that had none of their kind, but still says the list's error", async () => {
      api.fetchAssetPage.mockResolvedValue(page([]));
      openPicker();
      expect(await within(dialog()).findByText("No videos in the library yet")).toBeInTheDocument();
      fireEvent.change(fileInput(), { target: { files: [video("take one.mp4")] } });
      expect(uploadsGroup()).toHaveTextContent("take one.mp4Uploading…");
      expect(within(dialog()).queryByText("No videos in the library yet")).toBeNull();
      expect(within(dialog()).queryByText("Nothing in the library yet")).toBeNull();
      // Listing the other kind, which the upload is not: the list says the library has none
      fireEvent.click(within(filters()).getByRole("radio", { name: "Audio" }));
      await waitFor(() => expect(lastRequest()).toEqual({ kinds: ["audio"], limit: 60 }));
      expect(await within(dialog()).findByText("No audio in the library yet")).toBeInTheDocument();
      expect(uploadsGroup()).toHaveTextContent("take one.mp4Uploading…");
      // Both kinds: the upload is one
      fireEvent.click(within(filters()).getByRole("radio", { name: "All" }));
      await waitFor(() => expect(lastRequest()).toEqual({ kinds: ["video", "audio"], limit: 60 }));
      await waitFor(() => expect(within(dialog()).queryByText("No audio in the library yet")).toBeNull());
      expect(within(dialog()).queryByText("Nothing in the library yet")).toBeNull();
      // A list that fails says so under them
      api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
      fireEvent.click(within(filters()).getByRole("radio", { name: "Video" }));
      expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
      expect(uploadsGroup()).toHaveTextContent("take one.mp4Uploading…");
    });

    it("says why a file could not be uploaded, with its name, and lets it go", async () => {
      const calls = answers();
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      fireEvent.change(fileInput(), { target: { files: [video("take one.mp4")] } });
      expect(uploadsGroup()).toHaveTextContent("take one.mp4Uploading…");
      await act(async () => calls[0].reject(new Error("The file couldn't be read as video or audio.")));
      expect(toast).toHaveBeenCalledWith("Couldn't add “take one.mp4”", "error", false, "The file couldn't be read as video or audio.");
      expect(uploadsGroup()).toBeNull();
      expect(footerText()).toBe("Pick videos or audio to add");
    });

    it("takes files dropped on it the same way, with Drop to add while they are over it", async () => {
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      const take = video("take one.mp4");
      const results = screen.getByTestId("stitch-library-grid").parentElement!;
      expect(within(dialog()).queryByText("Drop to add")).toBeNull();
      fireEvent.dragEnter(tile("a1.mp4"), fileDrag());
      expect(within(dialog()).getByText("Drop to add")).toBeInTheDocument();
      expect(results).toHaveClass("ring-1", "ring-inset");
      const over = fileDrag();
      expect(fireEvent.dragOver(search(), over)).toBe(false);
      expect(over.dataTransfer.dropEffect).toBe("copy");
      expect(fireEvent.drop(tile("a1.mp4"), fileDrag([take]))).toBe(false);
      expect(within(dialog()).queryByText("Drop to add")).toBeNull();
      expect(results).not.toHaveClass("ring-1");
      expect(uploadsApi.recordUpload).toHaveBeenCalledWith(take, {});
      expect(uploadsGroup()).toHaveTextContent("take one.mp4Uploading…");

      // Text is no file: left alone
      const text = { dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" } };
      expect(fireEvent.dragOver(tile("a1.mp4"), text)).toBe(true);
      expect(within(dialog()).queryByText("Drop to add")).toBeNull();
    });

    it("takes nothing while the library is off: Upload is off, and a file dropped on it is only kept from the browser", async () => {
      const status = (available: boolean) =>
        ({ available, reasonCode: available ? undefined : "hosted", root: null, source: "default", defaultRoot: "/x", cacheDir: "/x", platform: "darwin" }) as LibraryStatus;
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      try {
        act(() => applyLibraryStatus(status(false)));
        expect(within(dialog()).getByRole("button", { name: "Upload" })).toBeDisabled();
        fireEvent.dragEnter(dialog(), fileDrag());
        expect(within(dialog()).queryByText("Drop to add")).toBeNull();
        const over = fileDrag();
        expect(fireEvent.dragOver(dialog(), over)).toBe(false);
        expect(over.dataTransfer.dropEffect).toBe("none");
        expect(fireEvent.drop(dialog(), fileDrag([video("take one.mp4")]))).toBe(false);
        expect(uploadsApi.recordUpload).not.toHaveBeenCalled();
        expect(uploadsGroup()).toBeNull();
      } finally {
        act(() => applyLibraryStatus(status(true)));
      }
    });
  });

  it("never leaves its filters open with focus elsewhere, and turns its search and filters off with the library", async () => {
    const libraryStatus = (available: boolean) =>
      ({
        available,
        reasonCode: available ? undefined : "hosted",
        root: null,
        source: "default",
        defaultRoot: "/x",
        cacheDir: "/x",
        platform: "darwin",
      }) as LibraryStatus;
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const open = () => within(dialog()).queryByRole("dialog", { name: "Filter and sort" });

    // Shift+Tab out of it: to its button (still open), then on to the search, which closes it
    filters();
    act(() => filterButton().focus());
    expect(open()).not.toBeNull();
    act(() => search().focus());
    expect(open()).toBeNull();

    // Tab on from it to a tile
    expect(within(filters()).getByRole("radio", { name: "Video" })).toHaveFocus();
    act(() => tile("a1.mp4").focus());
    expect(open()).toBeNull();

    // The library going off closes it and turns the search and its button off; it does not come back with the library
    filters();
    try {
      act(() => applyLibraryStatus(libraryStatus(false)));
      expect(open()).toBeNull();
      expect(search()).toBeDisabled();
      expect(filterButton()).toBeDisabled();
    } finally {
      act(() => applyLibraryStatus(libraryStatus(true)));
    }
    expect(open()).toBeNull();
    expect(filterButton()).toHaveAttribute("aria-expanded", "false");
    expect(search()).toBeEnabled();
  });
});

describe("LibraryPicker in the Edit video view", () => {
  const EDIT = "ed0000000000a1";

  /** An edit open in the view, its media a1 (on the timeline) and a4 (not), Add media open over it. */
  function openInEdit(kind: "video" | "audio" | "all" = "all") {
    useWorkflowStore.setState({ workflowId: "wf_1" });
    act(() => {
      editor().openEdit({
        editId: EDIT,
        draft: {
          timeline: [createClip({ kind: "asset", assetId: "a1" }, { id: "v1" })],
          audioClips: [],
          legacyAudio: { curve: [], muted: false },
          loopCount: 1,
          sequenceLayout: TRACK_LAYOUT,
          media: ["a1", "a4"],
        },
      });
      useEditProjectStore.setState({
        open: { id: EDIT, name: "Trip", createdAt: 1, baseUpdatedAt: 2, renders: [], assets: {} },
      });
      editor().setPickerOpen(kind);
    });
    return render(<LibraryPicker />);
  }

  it("Add puts the picks in the edit's media, never on the timeline, as one undo step, and the pane shows the last", async () => {
    openInEdit();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    // Nothing of a workflow here, and nothing to say about where clips go
    expect(within(filters()).queryByRole("switch", { name: "This workflow" })).toBeNull();
    fireEvent.click(tile("a1.mp4"));
    fireEvent.click(tile("a3.mp4"));
    fireEvent.click(tile("a2.mp4"));
    expect(footerText()).toBe("3 videos·0:15");
    const before = editor().past.length;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    // a1 is in it already
    expect(editor().draft!.media).toEqual(["a1", "a4", "a3", "a2"]);
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["v1"]);
    expect(editor().past.length).toBe(before + 1);
    expect(useEditProjectStore.getState().mediaFocus).toMatchObject({ id: "a2", reveal: 1 });
    expect(editor().pickerOpen).toBe(false);
    // Labelled at once
    expect(getAssetInfo("a3")?.filename).toBe("a3.mp4");
    act(() => editor().undo());
    expect(editor().draft!.media).toEqual(["a1", "a4"]);
  });

  it("uploads into the open edit", async () => {
    openInEdit("audio");
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const take = video("take one.mp4");
    fireEvent.change(fileInput(), { target: { files: [take] } });
    expect(uploadsApi.recordUpload).toHaveBeenCalledWith(take, { editId: EDIT, editName: "Trip" });
  });

  it("Add puts the uploads in the media once they are all in, in the order they were chosen, and nothing on the timeline", async () => {
    const calls = answers();
    openInEdit();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a3.mp4"));
    fireEvent.change(fileInput(), { target: { files: [video("take one.mp4"), video("take two.mp4")] } });
    const add = () => within(dialog()).getByRole("button", { name: "Add" });
    expect(footerText()).toBe("1 video·0:05Uploading 2 files…");
    expect(add()).toBeDisabled();
    // The second is in first: it still comes after the first
    await act(async () => calls[1].resolve(uploaded("up2", "take two.mp4")));
    expect(add()).toBeDisabled();
    await act(async () => calls[0].resolve(uploaded("up1", "take one.mp4")));
    expect(footerText()).toBe("3 videos·0:15");
    const before = editor().past.length;
    fireEvent.click(add());
    expect(editor().draft!.media).toEqual(["a1", "a4", "a3", "up1", "up2"]);
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["v1"]);
    expect(editor().past.length).toBe(before + 1);
    expect(useEditProjectStore.getState().mediaFocus).toMatchObject({ id: "up2", reveal: 1 });
    expect(editor().pickerOpen).toBe(false);
  });

  it("adds a pick from the library whatever its bytes, but an upload of a file the media holds only shows that one", async () => {
    const calls = answers();
    const a4Bytes = "a4".padEnd(64, "0");
    act(() => primeAssetInfo([asset("a4")]));
    // a2 is a4's bytes again
    api.fetchAssetPage.mockResolvedValue(page([asset("a1"), asset("a2", { sha256: a4Bytes }), asset("a3")]));
    openInEdit();
    await within(dialog()).findByRole("button", { name: named("a2.mp4") });
    fireEvent.click(tile("a2.mp4"));
    fireEvent.change(fileInput(), { target: { files: [video("a4 again.mp4")] } });
    await act(async () => calls[0].resolve(uploaded("up1", "a4 again.mp4", { sha256: a4Bytes })));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(editor().draft!.media).toEqual(["a1", "a4", "a2"]);
    expect(useEditProjectStore.getState().mediaFocus).toMatchObject({ id: "a4" });
  });
});

describe("LibraryPicker over the editor", () => {
  const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
    ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    useWorkflowStore.getState().clearWorkflow();
    __resetMediaInfoForTests();
    __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    useWorkflowStore.setState({
      nodes: [
        node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
        node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
      ],
      edges: [{ id: "eA", source: "gen-a", target: "stitch", sourceHandle: "video", targetHandle: "video-0" }],
      openModalCount: 0,
      isModalOpen: false,
    });
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1280, height: 720, fps: 24 });
  });

  afterEach(() => {
    __setMediaExtractorForTests(null);
    __resetMediaInfoForTests();
  });

  it("opens from the slot after the last clip, and Escape closes only the picker", async () => {
    render(<StitchEditorModal />);
    act(() => {
      openStitchEditor("stitch");
    });
    const editorDialog = screen.getByRole("dialog", { name: "Edit video" });
    // The + slot after the last clip (the timeline has no track headers, so no other +)
    const [slotAdd] = within(editorDialog).getAllByRole("button", { name: "Add media" });
    expect(within(editorDialog).getAllByRole("button", { name: "Add media" })).toHaveLength(1);
    expect(slotAdd).toBe(screen.getByTestId("stitch-add-slot"));
    // A browser focuses a button it clicks; jsdom does not
    act(() => slotAdd.focus());
    fireEvent.click(slotAdd);
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(search()));
    // Canvas and editor keys stay off while the picker is up: ⌫ removes no clip
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    expect(editor().draft!.timeline).toHaveLength(1);
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull());
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
    expect(screen.getByRole("dialog", { name: "Edit video" })).toBeInTheDocument();
    // Focus goes back to the + that opened it
    await waitFor(() => expect(document.activeElement).toBe(slotAdd));

    fireEvent.click(screen.getByTestId("stitch-add-slot"));
    expect(editor().pickerOpen).toBe("video");
  });

  it("offers Add media until the library is known to be off, then turns every entry point off", async () => {
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
    render(<StitchEditorModal />);
    act(() => {
      openStitchEditor("stitch");
    });
    // Not asked yet (null): offered, and the list request says what it finds
    const addAudio = () => screen.getByRole("button", { name: "Add audio" });
    expect(addAudio()).toBeEnabled();
    expect(screen.getByTestId("stitch-add-slot")).toBeEnabled();
    try {
      act(() => applyLibraryStatus(status(false)));
      expect(addAudio()).toBeDisabled();
      expect(addAudio()).toHaveAttribute("title", "The asset library is off");
      expect(screen.getByTestId("stitch-add-slot")).toBeDisabled();
      expect(screen.getByTestId("stitch-add-slot")).toHaveAttribute("title", "The asset library is off");
      // The picker, if it is up all the same, asks nothing
      act(() => editor().setPickerOpen("video"));
      expect(within(dialog()).getByText("The asset library is off.")).toBeInTheDocument();
      expect(within(dialog()).getByRole("button", { name: "Upload" })).toBeDisabled();
      expect(api.fetchAssetPage).not.toHaveBeenCalled();
      act(() => editor().setPickerOpen(false));
      // The empty lane's placeholder: off, and no +
      act(() => editor().apply((d) => ({ ...d, timeline: [] })));
      const placeholder = screen.getByTestId("stitch-empty-lane");
      expect(placeholder).toBeDisabled();
      expect(placeholder.querySelector("svg")).toBeNull();
    } finally {
      act(() => applyLibraryStatus(status(true)));
    }
    expect(screen.getByTestId("stitch-empty-lane")).toBeEnabled();
    expect(screen.getByTestId("stitch-empty-lane").querySelector("svg")).not.toBeNull();
  });

  describe("set to audio", () => {
    const audioAsset = (id: string, durationSec: number) =>
      asset(id, {
        kind: "audio",
        mime: "audio/mp4",
        ext: "m4a",
        filename: `${id}.m4a`,
        width: undefined,
        height: undefined,
        durationSec,
        hasPoster: false,
      });
    const audioDialog = dialog;
    const audioTile = (file: string) => within(audioDialog()).getByRole("button", { name: named(file) });

    beforeEach(() => {
      api.fetchAssetPage.mockResolvedValue(page([audioAsset("t1", 3), audioAsset("t2", 9)]));
    });

    it("lists the library's audio, set to Audio with no dot, and asks for no poster", async () => {
      poster.ensurePoster.mockClear();
      openPicker({ kind: "audio" });
      expect(await within(audioDialog()).findByRole("button", { name: named("t1.m4a") })).toBeInTheDocument();
      expect(api.fetchAssetPage.mock.calls[0][0]).toEqual({ kinds: ["audio"], limit: 60 });
      expect(search(audioDialog())).toHaveAttribute("placeholder", "Search");
      expect(within(filters(audioDialog())).getByRole("radio", { name: "Audio" })).toHaveAttribute("aria-checked", "true");
      expect(filterButton(audioDialog())).not.toHaveAttribute("data-filtered");
      // A one-line row: its name and its length, no thumbnail
      expect(audioTile("t1.m4a")).toHaveTextContent("t1.m4a0:03");
      expect(audioTile("t1.m4a").querySelector("img")).toBeNull();
      fireEvent.click(audioTile("t1.m4a"));
      expect(audioTile("t1.m4a")).toHaveAttribute("aria-pressed", "true");
      expect(within(audioTile("t1.m4a")).getByLabelText("Selected")).toBeInTheDocument();
      fireEvent.click(audioTile("t1.m4a"));
      expect(poster.ensurePoster).not.toHaveBeenCalled();
      expect(footerText()).toBe("Pick videos or audio to add");
    });

    it("puts each picked file on a new row at the playhead, in one step, the first selected", async () => {
      openPicker({ kind: "audio" });
      act(() => editor().setPlayhead(2.5));
      await within(audioDialog()).findByRole("button", { name: named("t1.m4a") });
      fireEvent.click(audioTile("t2.m4a"));
      expect(footerText()).toBe("1 audio file·0:09starts at 0:02.50 on a new row");
      fireEvent.click(audioTile("t1.m4a"));
      expect(footerText()).toBe("2 audio files·0:12each starts at 0:02.50 on a new row");
      const before = editor().past.length;
      fireEvent.click(within(audioDialog()).getByRole("button", { name: "Add" }));
      const clips = editor().draft!.audioClips;
      expect(clips.map((c) => [c.source, c.row, c.startSec])).toEqual([
        [{ kind: "asset", assetId: "t2" }, 0, 2.5],
        [{ kind: "asset", assetId: "t1" }, 1, 2.5],
      ]);
      expect(editor().draft!.timeline).toHaveLength(2);
      expect(editor().past.length).toBe(before + 1);
      expect(editor().selection).toMatchObject({ kind: "audio", clipId: clips[0].id });
      expect(editor().pickerOpen).toBe(false);
      expect(getAssetInfo("t2")?.filename).toBe("t2.m4a");
    });

    it("calls a file by the name it was given, in its row, its tooltip and its accessible name", async () => {
      api.fetchAssetPage.mockResolvedValue(page([{ ...audioAsset("t1", 3), name: "Morning score" }]));
      openPicker({ kind: "audio" });
      const row = await within(audioDialog()).findByRole("button", { name: named("Morning score") });
      expect(row).toHaveTextContent("Morning score0:03");
      expect(row).toHaveAttribute("title", "Morning score");
      expect(row).not.toHaveTextContent("t1.m4a");
    });

    it("says when the library has no audio, and when nothing matches", async () => {
      api.fetchAssetPage.mockResolvedValue(page([]));
      openPicker({ kind: "audio" });
      expect(await within(audioDialog()).findByText("No audio in the library yet")).toBeInTheDocument();
      fireEvent.click(within(filters(audioDialog())).getByRole("switch", { name: "Favorites" }));
      expect(await within(audioDialog()).findByText("No audio matches")).toBeInTheDocument();
    });

    it("opens from + Audio under the audio rows", async () => {
      render(<StitchEditorModal />);
      act(() => {
        openStitchEditor("stitch");
      });
      fireEvent.click(screen.getByRole("button", { name: "Add audio" }));
      expect(editor().pickerOpen).toBe("audio");
      expect(await within(audioDialog()).findByRole("button", { name: named("t1.m4a") })).toBeInTheDocument();
    });
  });

  describe("set to both kinds (Kind: All in the node's dialog)", () => {
    it("lists videos and audio in one list, and adds each where its own picker would, as one undo step", async () => {
      const sound = asset("t1", { kind: "audio", mime: "audio/mp4", ext: "m4a", filename: "t1.m4a", durationSec: 3, hasPoster: false });
      api.fetchAssetPage.mockResolvedValue(page([asset("a1"), sound]));
      openPicker({ kind: "all" });
      act(() => editor().setPlayhead(1.5));
      await within(dialog()).findByRole("button", { name: named("t1.m4a") });
      expect(api.fetchAssetPage.mock.calls[0][0]).toEqual({ kinds: ["video", "audio"], limit: 60 });
      fireEvent.click(tile("t1.m4a"));
      fireEvent.click(tile("a1.mp4"));
      expect(footerText()).toBe("1 video and 1 audio file·0:08the video goes after Clip 2, the audio file starts at 0:01.50 on a new row");
      const before = editor().past.length;
      fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
      expect(editor().past.length).toBe(before + 1);
      // The video after the last clip, the sound on a new row at the playhead
      expect(editor().draft!.timeline.map((c) => c.source)).toEqual([
        { kind: "edge", edgeId: "e0" },
        { kind: "edge", edgeId: "e1" },
        { kind: "asset", assetId: "a1" },
      ]);
      expect(editor().draft!.audioClips.map((c) => [c.source, c.row, c.startSec])).toEqual([[{ kind: "asset", assetId: "t1" }, 0, 1.5]]);
      expect(editor().selection).toMatchObject({ kind: "clip" });
      expect(editor().pickerOpen).toBe(false);
    });

    it("says where several of each go, and that videos go first on an empty timeline", async () => {
      const sound = (id: string, durationSec: number) =>
        asset(id, { kind: "audio", mime: "audio/mp4", ext: "m4a", filename: `${id}.m4a`, durationSec, hasPoster: false });
      api.fetchAssetPage.mockResolvedValue(page([asset("a1"), asset("a3"), sound("t1", 3), sound("t2", 2)]));
      openPicker({ kind: "all" });
      act(() => editor().setPlayhead(1.5));
      await within(dialog()).findByRole("button", { name: named("t2.m4a") });
      for (const file of ["a1.mp4", "t1.m4a", "a3.mp4", "t2.m4a"]) fireEvent.click(tile(file));
      expect(footerText()).toBe("2 videos and 2 audio files·0:15the videos go after Clip 2, each audio file starts at 0:01.50 on a new row");
      // An empty timeline holds the playhead at its start
      act(() => editor().apply((d) => ({ ...d, timeline: [] })));
      expect(footerText()).toBe("2 videos and 2 audio files·0:15the videos go first, each audio file starts at 0:00.00 on a new row");
      fireEvent.click(tile("a3.mp4"));
      fireEvent.click(tile("t2.m4a"));
      expect(footerText()).toBe("1 video and 1 audio file·0:08the video goes first, the audio file starts at 0:00.00 on a new row");
    });
  });
});
