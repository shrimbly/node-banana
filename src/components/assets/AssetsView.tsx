"use client";

import { useEffect, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { clearGenerationToasts } from "@/components/GenerationToast";
import { libraryOffForGood } from "@/lib/assets/client/libraryStatus";
import { onPosterReady } from "@/lib/assets/client/poster";
import { onAssetRecorded, onLibraryStatus } from "@/lib/assets/client/recorder";
import { sameQuery } from "@/lib/assets/query";
import { ARRIVALS_POLL_MS, buildAssetQuery, selectionCount, useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { AssetContextMenu } from "./AssetContextMenu";
import { AssetDetail, toggleDetailFullscreen, useDetailFullscreen } from "./AssetDetail";
import { AssetGrid, gridNavigation } from "./AssetGrid";
import { AssetNotice } from "./AssetNotice";
import { AssetsHeader, AssetsSortMenu } from "./AssetsHeader";
import { AssetsRail } from "./AssetsRail";
import { BulkBar } from "./BulkBar";
import { ConfirmDelete } from "./ConfirmDelete";
import { EmptyState } from "./EmptyState";
import { ProjectsOffer } from "./ProjectsOffer";
import { BulkTagEditor } from "./TagEditor";
import { copyPrompt, leaveFullscreen, recordsOf, removeSelection, selectionOf } from "./assetActions";
import type { GridDirection } from "./masonryLayout";

const RAIL_WIDTH = 232;
const PANEL_WIDTH = 340;
const FACETS_AFTER_RECORDING_MS = 1500;
/** Coming back to the page asks again about a library that is off for good, at most this often (as the recorder does). */
const RETURN_RECHECK_MS = 30_000;

const ARROWS: Record<string, GridDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable='true']"));
}

/** A control other than a tile has focus: Enter and Space are its own. */
function isOtherControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("button, a, [role='checkbox']") && !target.closest("[data-asset-tile]");
}

/**
 * The view's one keyboard handler, in the capture phase so it runs before
 * anything else on the window (the canvas behind is also guarded, but this
 * keeps the view's keys its own), following AnnotationModal's shield:
 *
 * Esc closes the detail, then clears the selection, then returns to the
 * canvas. Arrows move through the grid (←/→ step through the detail),
 * Enter opens, Space selects, ⌘A selects all loaded, Delete trashes, ⌘Z
 * undoes the last asset action, F is fullscreen in the detail, ? shows the
 * shortcuts, A goes back to the canvas and C to the chat. ⌘C copies selected text as
 * usual, or the open asset's prompt when nothing is selected.
 */
function handleAssetsKey(event: KeyboardEvent) {
  const store = useAssetStore.getState();
  if (store.appView !== "assets") return;
  // A dialog above the view (settings, shortcuts, the delete confirm) owns the keyboard
  if (document.querySelector("[data-dialog-overlay]")) return;
  const key = event.key;
  const lower = key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  const own = () => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  // A menu or the tag editor handles its own keys; Escape closes it
  if (store.popover) {
    if (key === "Escape") {
      own();
      store.closePopover();
    }
    return;
  }

  if (isTypingTarget(event.target)) {
    if (key === "Escape") {
      own();
      (event.target as HTMLElement).blur();
    }
    return;
  }

  if (key === "Escape") {
    own();
    if (store.detailId) store.closeDetail();
    else if (selectionCount(store) > 0) store.clearSelection();
    else if (store.selectMode) store.setSelectMode(false);
    else store.setAppView("canvas");
    return;
  }

  if (mod) {
    if (lower === "z" && !event.shiftKey) {
      own();
      void store.undo();
    } else if (lower === "a") {
      own();
      if (!store.detailId) store.selectAllLoaded();
    } else if (lower === "c") {
      // Selected text copies as it always does
      if (window.getSelection()?.toString()) return;
      own();
      if (store.detailAsset?.prompt) void copyPrompt(store.detailAsset);
    }
    return;
  }
  if (event.altKey) return;

  if (key === "?") {
    own();
    // The dialog renders outside the detail: in fullscreen it would take the keyboard unseen
    leaveFullscreen();
    useWorkflowStore.getState().setShortcutsDialogOpen(true);
    return;
  }
  if (lower === "a" && !event.shiftKey) {
    own();
    if (!event.repeat) store.setAppView("canvas");
    return;
  }
  if (lower === "c" && !event.shiftKey) {
    own();
    if (!event.repeat) store.setAppView("chat");
    return;
  }

  if (store.detailId) {
    // A focused player keeps its arrows for seeking
    if ((key === "ArrowLeft" || key === "ArrowRight") && !(event.target instanceof HTMLMediaElement)) {
      own();
      void store.stepDetail(key === "ArrowLeft" ? -1 : 1);
    } else if (lower === "f" && !event.shiftKey) {
      own();
      toggleDetailFullscreen();
    } else if (key === "Delete" || key === "Backspace") {
      own();
      removeSelection(selectionOf([store.detailId]));
    }
    return;
  }

  if (ARROWS[key]) {
    own();
    gridNavigation.current?.(ARROWS[key]!);
    return;
  }
  if (key === "Enter" && store.focusedId && !isOtherControl(event.target)) {
    own();
    store.openDetail(store.focusedId);
    return;
  }
  if (key === " " && store.focusedId && !isOtherControl(event.target)) {
    own();
    store.toggleSelect(store.focusedId);
    return;
  }
  if (key === "Delete" || key === "Backspace") {
    own();
    if (selectionCount(store) > 0) removeSelection(store.selection);
    else if (store.focusedId) removeSelection(selectionOf([store.focusedId]));
  }
}

function Popovers() {
  const popover = useAssetStore((state) => state.popover);
  // Re-read records when they change, so the tag editor's states follow each click
  useAssetStore(useShallow((state) => [state.items, state.selectedRecords, state.detailAsset]));
  const facets = useAssetStore((state) => state.facets);
  if (!popover) return null;
  if (popover.kind === "menu") {
    return <AssetContextMenu x={popover.x} y={popover.y} anchorId={popover.anchorId} useSelection={popover.useSelection} />;
  }
  if (popover.kind === "sort") return <AssetsSortMenu x={popover.x} y={popover.y} />;
  return (
    <BulkTagEditor
      selection={popover.selection}
      records={recordsOf(popover.selection)}
      suggestions={(facets?.tags ?? []).map((tag) => tag.tag)}
      x={popover.x}
      y={popover.y}
      above={popover.above}
    />
  );
}

/**
 * The Assets view: every asset the library holds, as a masonry of day
 * sections with a filter rail, a detail view, bulk actions and tags. It is
 * a layer over the canvas inside the canvas frame; the canvas stays mounted
 * (inert) underneath. While open it polls for new arrivals and the library
 * status (unless the library is off for good), listens to the recorder, and
 * owns the keyboard (see handleAssetsKey).
 */
export function AssetsView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { status, itemCount, detailOpen } = useAssetStore(
    useShallow((state) => ({ status: state.status, itemCount: state.items.length, detailOpen: state.detailId !== null })),
  );

  useEffect(() => {
    const store = useAssetStore.getState();
    const query = buildAssetQuery(store.filters, store.sort);
    // Coming back to the same query keeps what was loaded (and where the user was)
    if (store.status === "ready" && store.loadedQuery && sameQuery(store.loadedQuery, query)) void store.pollArrivals();
    else if (store.status !== "loading") void store.refresh();
    void store.refreshFacets();
    // Where the library is now and what it runs, asked afresh rather than taken from the recorder, whose copy
    // may be from before a move or a job ended: a switch meanwhile reloads the list, a running job is followed,
    // one that ended since the list loaded reloads it
    void store.refreshLibrary();
    let libraryAskedAt = Date.now();
    clearGenerationToasts();
    // A detail left open takes focus itself
    if (!store.detailId) rootRef.current?.focus({ preventScroll: true });

    let facetsTimer: ReturnType<typeof setTimeout> | null = null;
    const offRecorded = onAssetRecorded((result) => {
      useAssetStore.getState().receiveArrivals([result.asset]);
      if (facetsTimer) clearTimeout(facetsTimer);
      facetsTimer = setTimeout(() => void useAssetStore.getState().refreshFacets(), FACETS_AFTER_RECORDING_MS);
    });
    // A video's poster landed after its tile asked for a thumbnail: show it
    const offPoster = onPosterReady((id) => useAssetStore.getState().markPosterReady(id));
    // A switched or moved library reloads the list (setLibrary compares roots)
    const offStatus = onLibraryStatus((next) => useAssetStore.getState().setLibrary(next));
    const offCanvas = useWorkflowStore.subscribe((state, previous) => {
      // A workflow opened or a tab switched, however it was asked for: show it
      if (state.canvasGeneration !== previous.canvasGeneration) useAssetStore.getState().setAppView("canvas");
      // A dialog opened over a fullscreen detail is not painted, yet takes the keyboard: leave fullscreen
      if (state.openModalCount > previous.openModalCount) leaveFullscreen();
      // A dialog closed over the view (Settings may have switched the library or started a job): ask again
      if (state.openModalCount < previous.openModalCount) void useAssetStore.getState().refreshLibrary();
    });
    const pollNow = () => {
      libraryAskedAt = Date.now();
      const current = useAssetStore.getState();
      void current.pollArrivals();
      void current.refreshLibrary();
    };
    // A hosted server, or the request guard refusing this page, answers the same until the page reloads,
    // and each ask adds a refusal to the server's log
    const offForGood = () => libraryOffForGood(useAssetStore.getState().library);
    // Nothing is asked while the page is hidden (a background tab, a minimised window), nor every 5 s of a
    // library off for good; coming back asks at once, or at most every 30 s when it is off for good (the
    // recorder asks on focus as well, as often, and a different answer reaches the view from it)
    const poll = setInterval(() => {
      if (document.visibilityState !== "hidden" && !offForGood()) pollNow();
    }, ARRIVALS_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (offForGood() && Date.now() - libraryAskedAt < RETURN_RECHECK_MS) return;
      pollNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", handleAssetsKey, { capture: true });
    return () => {
      offRecorded();
      offPoster();
      offStatus();
      offCanvas();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      if (facetsTimer) clearTimeout(facetsTimer);
      window.removeEventListener("keydown", handleAssetsKey, { capture: true });
      useAssetStore.getState().closePopover();
    };
  }, []);

  // A fullscreen detail paints only itself: it shows the notice then
  const detailFullscreen = useDetailFullscreen();
  const showGrid = itemCount > 0;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="assets-view"
      role="region"
      aria-label="Assets"
      className="absolute inset-0 flex bg-canvas-bg outline-none"
    >
      {/* Behind an open detail, out of reach of Tab and the pointer */}
      <div className="contents" inert={detailOpen}>
        <AssetsRail />
      </div>
      <main className="relative flex min-w-0 flex-1 flex-col" inert={detailOpen}>
        <AssetsHeader />
        <ProjectsOffer />
        {showGrid ? (
          <AssetGrid />
        ) : status === "loading" || status === "idle" ? (
          <div className="flex flex-1 items-center justify-center pb-16" aria-busy>
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300 motion-reduce:animate-none" />
          </div>
        ) : (
          <EmptyState />
        )}
      </main>

      <AssetDetail />

      {/* Bulk bar and notices, centred over the grid or the detail's stage */}
      <div
        className="pointer-events-none absolute bottom-5 z-40 flex flex-col items-center gap-2"
        style={detailOpen ? { left: 0, right: PANEL_WIDTH } : { left: RAIL_WIDTH, right: 0 }}
      >
        {!detailFullscreen && <AssetNotice />}
        {!detailOpen && <BulkBar />}
      </div>

      <Popovers />
      <ConfirmDelete />
    </div>
  );
}
