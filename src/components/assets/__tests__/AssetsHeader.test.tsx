import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AssetFacets } from "@/lib/assets/types";

const api = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(async () => ({ assets: [], nextCursor: null, headCursor: null, total: 0, totalBytes: 0 })),
  fetchFacets: vi.fn(),
  fetchLibraryStatus: vi.fn(),
}));
vi.mock("@/lib/assets/client/api", () => api);

import { AssetsHeader, AssetsSortMenu } from "../AssetsHeader";
import { DEFAULT_FILTERS, useAssetStore } from "@/store/assetStore";

const initial = useAssetStore.getState();

const facets = (overrides: Partial<AssetFacets> = {}): AssetFacets => ({
  total: 383,
  favorites: 1,
  trash: 4,
  missing: 0,
  kinds: { image: 344, video: 37, audio: 2, "3d": 0 },
  origins: { generated: 383, edited: 0, uploaded: 0 },
  models: [],
  tags: [],
  workflows: [],
  projects: [],
  ...overrides,
});

/** The header, and the sort menu when the view would show it. */
function Harness() {
  const popover = useAssetStore((state) => state.popover);
  return (
    <>
      <AssetsHeader />
      {popover?.kind === "sort" && <AssetsSortMenu x={popover.x} y={popover.y} />}
    </>
  );
}

beforeEach(() => {
  useAssetStore.setState({ ...initial, facets: facets(), filters: { ...DEFAULT_FILTERS }, status: "ready", total: 383, sort: "newest", tileSize: "m" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AssetsHeader", () => {
  it("counts the view, and says how much of it the filters leave", () => {
    const { rerender } = render(<Harness />);
    expect(screen.getByText("383 assets")).toBeInTheDocument();
    act(() => {
      useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, kinds: ["video"] }, total: 37 });
    });
    rerender(<Harness />);
    expect(screen.getByRole("heading", { name: "Assets" }).parentElement).toHaveTextContent("37 of 383");
  });

  it("has no Clear filters of its own (the rail's Clear all does that)", () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, kinds: ["video"] }, total: 37 });
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("sorts from a menu that the button opens and closes", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Sort: Newest first" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Sort" });
    expect(screen.getByRole("menuitemradio", { name: "Newest first" })).toHaveAttribute("aria-checked", "true");

    act(() => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));
    });
    expect(useAssetStore.getState().sort).toBe("oldest");
    expect(menu).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort: Oldest first" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sort: Oldest first" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort: Oldest first" }));
    expect(screen.queryByRole("menu", { name: "Sort" })).toBeNull();
  });

  it("closes the sort menu on a press outside it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Sort: Newest first" }));
    expect(screen.getByRole("menu", { name: "Sort" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "Sort" })).toBeNull();
  });

  it("moves between the sort choices with the arrow keys", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Sort: Newest first" }));
    const newest = screen.getByRole("menuitemradio", { name: "Newest first" });
    const oldest = screen.getByRole("menuitemradio", { name: "Oldest first" });
    newest.focus();
    fireEvent.keyDown(newest, { key: "ArrowDown" });
    expect(document.activeElement).toBe(oldest);
    fireEvent.keyDown(oldest, { key: "ArrowDown" });
    expect(document.activeElement).toBe(newest);
  });

  it("sets the tile size from three icon buttons", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Medium tiles" })).toHaveAttribute("aria-pressed", "true");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Large tiles" }));
    });
    expect(useAssetStore.getState().tileSize).toBe("l");
    expect(screen.getByRole("button", { name: "Large tiles" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Medium tiles" })).toHaveAttribute("aria-pressed", "false");
  });

  it("turns Select into Done while selecting", () => {
    render(<Harness />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
    });
    expect(useAssetStore.getState().selectMode).toBe(true);
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers Empty Trash in the Trash", () => {
    useAssetStore.setState({ filters: { ...DEFAULT_FILTERS, view: "trash" }, total: 4 });
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Trash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Empty Trash" })).toBeInTheDocument();
  });
});
