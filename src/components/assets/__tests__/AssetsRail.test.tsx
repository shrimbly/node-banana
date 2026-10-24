import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AssetFacets } from "@/lib/assets/types";

const api = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(async () => ({ assets: [], nextCursor: null, headCursor: null, total: 0, totalBytes: 0 })),
  fetchFacets: vi.fn(),
  fetchLibraryStatus: vi.fn(),
  revealLibraryRoot: vi.fn(),
}));
vi.mock("@/lib/assets/client/api", () => api);

import { AssetsRail, RAIL_OPEN_KEY } from "../AssetsRail";
import { DEFAULT_FILTERS, useAssetStore } from "@/store/assetStore";

const initial = useAssetStore.getState();

const facets = (overrides: Partial<AssetFacets> = {}): AssetFacets => ({
  total: 355,
  favorites: 1,
  trash: 0,
  missing: 0,
  kinds: { image: 316, video: 37, audio: 2, "3d": 0 },
  origins: { generated: 355, edited: 0, uploaded: 0 },
  models: [
    { modelId: "nano-banana-2", label: "Nano Banana 2", provider: "gemini", count: 3 },
    { modelId: "gpt-image", label: "GPT Image 2.5 Flare", provider: "openai", count: 6 },
  ],
  tags: [],
  workflows: [{ id: "wf_cars", name: "Cars", projectPath: "/p/Cars new", count: 238, lastAt: 0 }],
  projects: [
    { path: "/p/Cars new", name: "Cars new", count: 238 },
    { path: "/p/splitty", name: "splitty", count: 3 },
  ],
  ...overrides,
});

function groupHeader(name: string): HTMLElement {
  const group = screen.getByRole("group", { name });
  return within(group).getAllByRole("button")[0]!;
}

beforeEach(() => {
  localStorage.clear();
  useAssetStore.setState({ ...initial, facets: facets(), filters: { ...DEFAULT_FILTERS } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AssetsRail", () => {
  it("has no Source filter, and one folding group per facet", () => {
    render(<AssetsRail />);
    expect(screen.queryByText("Source")).toBeNull();
    expect(screen.queryByText("Edited")).toBeNull();
    for (const name of ["Type", "Projects", "Workflows", "Models", "Tags", "Date"]) {
      expect(groupHeader(name)).toHaveAttribute("aria-expanded");
    }
  });

  it("starts with Type open and the rest folded, and remembers what the viewer opens", () => {
    const { unmount } = render(<AssetsRail />);
    expect(groupHeader("Type")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Images/ })).toBeInTheDocument();
    expect(groupHeader("Projects")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Cars new/ })).toBeNull();

    fireEvent.click(groupHeader("Projects"));
    expect(groupHeader("Projects")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Cars new/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(RAIL_OPEN_KEY)!)).toMatchObject({ type: true, projects: true });

    unmount();
    render(<AssetsRail />);
    expect(groupHeader("Projects")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the filters that are on as chips, and a count on a folded group", () => {
    useAssetStore.setState({
      filters: { ...DEFAULT_FILTERS, kinds: ["image"], projects: ["/p/Cars new"], models: ["nano-banana-2"], date: "7d" },
    });
    render(<AssetsRail />);
    const on = screen.getByRole("group", { name: "Filters on" });
    const chips = within(on)
      .getAllByRole("button", { name: /^Remove filter:/ })
      .map((chip) => chip.getAttribute("aria-label"));
    expect(chips).toEqual([
      "Remove filter: Images",
      "Remove filter: Cars new",
      "Remove filter: Nano Banana 2",
      "Remove filter: Last 7 days",
    ]);
    expect(within(groupHeader("Projects")).getByLabelText("1 on")).toHaveTextContent("1");
    expect(within(groupHeader("Workflows")).queryByLabelText(/on$/)).toBeNull();
  });

  it("removes one filter from its chip", () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, projects: ["/p/Cars new", "/p/splitty"], date: "today" } });
    render(<AssetsRail />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Remove filter: Cars new" }));
    });
    expect(useAssetStore.getState().filters.projects).toEqual(["/p/splitty"]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Remove filter: Today" }));
    });
    expect(useAssetStore.getState().filters.date).toBe("any");
  });

  it("clears every filter with Clear all, keeping the search and the Library view", () => {
    useAssetStore.setState({
      filters: { ...DEFAULT_FILTERS, view: "favorites", q: "coat", kinds: ["video"], tags: ["hero"], date: "30d" },
    });
    render(<AssetsRail />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    });
    const { filters } = useAssetStore.getState();
    expect(filters).toMatchObject({ view: "favorites", q: "coat", kinds: [], tags: [], date: "any" });
    expect(screen.queryByRole("group", { name: "Filters on" })).toBeNull();
  });

  it("keeps a row for a filter that is on but no longer offered", () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, tags: ["hero"] } });
    render(<AssetsRail />);
    fireEvent.click(groupHeader("Tags"));
    expect(screen.getByRole("button", { name: /^hero/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("says when there are no tags yet", () => {
    render(<AssetsRail />);
    fireEvent.click(groupHeader("Tags"));
    expect(screen.getByText("No tags yet. Add them from an asset's details.")).toBeInTheDocument();
  });
});
