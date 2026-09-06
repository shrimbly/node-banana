"use client";

import { useEffect, type MouseEvent } from "react";
import { useOnViewportChange, useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { summarizeWorkflowTabs } from "@/store/utils/workflowTabs";

/**
 * Open workflows as browser-style tabs across the top of the window. The bar
 * is always there, so the workflow name has one home. The active tab is the
 * canvas colour and open at the bottom, so it reads as part of the canvas.
 * Switching and closing are blocked while a run, a save or a media write is
 * in flight, because the store holds only the live workflow's execution state.
 * Each tab also remembers its pan and zoom.
 */
export function WorkflowTabs() {
  const {
    tabs,
    activeTabId,
    workflowName,
    hasUnsavedChanges,
    isRunning,
    isSaving,
    pendingMediaSaves,
    canvasViewport,
    setCanvasViewport,
    switchTab,
    closeTab,
    newTab,
  } = useWorkflowStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      workflowName: state.workflowName,
      hasUnsavedChanges: state.hasUnsavedChanges,
      isRunning: state.isRunning,
      isSaving: state.isSaving,
      pendingMediaSaves: state.pendingMediaSaves,
      canvasViewport: state.canvasViewport,
      setCanvasViewport: state.setCanvasViewport,
      switchTab: state.switchTab,
      closeTab: state.closeTab,
      newTab: state.newTab,
    }))
  );

  // The viewport lives in React Flow; mirror it into the store so it parks with the tab
  const { getViewport, setViewport } = useReactFlow();
  useOnViewportChange({ onEnd: setCanvasViewport });
  useEffect(() => {
    // A tab that has been viewed before comes back where it was left; a tab
    // shown for the first time adopts the current view as its own
    if (canvasViewport) setViewport(canvasViewport);
    else setCanvasViewport(getViewport());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  const summaries = summarizeWorkflowTabs(tabs, activeTabId, { workflowName, hasUnsavedChanges });
  const busy = isRunning || isSaving || pendingMediaSaves > 0;
  const busyReason = isRunning
    ? "Wait for the run to finish"
    : isSaving
      ? "Wait for the save to finish"
      : "Wait for the media to finish saving";

  const handleClose = (id: string, name: string | null, unsaved: boolean) => {
    if (busy) return;
    if (unsaved && !window.confirm(`Close ${name ?? "Untitled"} and discard its unsaved changes?`)) return;
    closeTab(id);
  };

  return (
    <div
      role="tablist"
      aria-label="Open workflows"
      // Above the canvas frame, so the active tab can sit over its top border
      className="relative z-20 flex h-[38px] min-w-0 shrink-0 items-end bg-[#0f0f0f] pl-3 pr-2"
    >
      {summaries.map((tab, index) => {
        const name = tab.name ?? "Untitled";
        const previousActive = index > 0 && summaries[index - 1].isActive;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.isActive}
            title={busy && !tab.isActive ? busyReason : name}
            onAuxClick={(event: MouseEvent) => {
              // Middle-click closes, as in a browser
              if (event.button === 1) handleClose(tab.id, tab.name, tab.hasUnsavedChanges);
            }}
            className={`group relative flex h-[30px] min-w-[72px] max-w-[220px] shrink items-center rounded-t-lg pl-3 pr-2 text-xs whitespace-nowrap ${
              tab.isActive
                ? "-mb-px h-[31px] bg-canvas-bg text-neutral-100 shadow-[inset_1px_0_0_rgba(64,64,64,0.6),inset_-1px_0_0_rgba(64,64,64,0.6),inset_0_1px_0_rgba(64,64,64,0.6)]"
                : `text-neutral-400 ${busy ? "opacity-60" : "hover:bg-white/[0.04] hover:text-neutral-200"}`
            }`}
          >
            {/* The active tab flows into the canvas frame: concave corners at its feet */}
            {tab.isActive && (
              <>
                <TabEar side="left" />
                <TabEar side="right" />
              </>
            )}
            {/* Hairline between two inactive neighbours */}
            {index > 0 && !tab.isActive && !previousActive && (
              <span aria-hidden className="absolute top-[7px] bottom-[7px] -left-px w-px bg-neutral-800" />
            )}
            <button
              type="button"
              onClick={() => !tab.isActive && switchTab(tab.id)}
              disabled={busy && !tab.isActive}
              // The label always leaves room for the slot on its right, so the
              // close button and the unsaved dot never move the text
              className={`min-w-0 flex-1 truncate pr-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm disabled:cursor-not-allowed ${
                tab.name ? "" : "italic text-neutral-500"
              }`}
            >
              {name}
            </button>
            {/* One slot over the label's end: the unsaved dot at rest, the close on hover */}
            <span className="absolute top-1/2 right-1.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center">
              {tab.hasUnsavedChanges && (
                <span
                  aria-label="Unsaved"
                  className="h-2 w-2 rounded-full bg-red-500 group-hover:hidden group-focus-within:hidden"
                />
              )}
              <button
                type="button"
                onClick={() => handleClose(tab.id, tab.name, tab.hasUnsavedChanges)}
                disabled={busy}
                aria-label={`Close ${name}`}
                title={busy ? busyReason : "Close tab"}
                className={`h-4 w-4 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed ${
                  tab.hasUnsavedChanges || !tab.isActive
                    ? "hidden group-hover:flex group-focus-within:flex"
                    : "flex"
                }`}
              >
                <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => newTab()}
        disabled={busy}
        aria-label="New tab"
        title={busy ? busyReason : "New tab"}
        className="mb-px ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}>
          <path strokeLinecap="round" d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The concave corner where the active tab meets the canvas frame, drawn just
 * outside the tab's foot on one side. Canvas-coloured, with the frame's border
 * running along its curve, so the tab and the canvas read as one sheet.
 */
function TabEar({ side }: { side: "left" | "right" }) {
  return (
    <svg
      aria-hidden
      className={`pointer-events-none absolute bottom-0 h-2 w-2 ${side === "left" ? "-left-2" : "-right-2 -scale-x-100"}`}
      viewBox="0 0 8 8"
      fill="none"
    >
      <path d="M8 0 A8 8 0 0 1 0 8 L8 8 Z" fill="var(--color-canvas-bg)" />
      <path d="M8 0 A8 8 0 0 1 0 8" stroke="var(--color-card-border)" strokeWidth="1" />
    </svg>
  );
}
