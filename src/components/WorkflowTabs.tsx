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
      className="flex h-[38px] shrink-0 items-end overflow-x-auto bg-[#0f0f0f] px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            className={`group relative flex h-[30px] min-w-[120px] max-w-[220px] shrink items-center gap-2 rounded-t-lg pl-3 pr-2 text-xs whitespace-nowrap ${
              tab.isActive
                ? "bg-canvas-bg text-neutral-100 shadow-[inset_1px_0_0_rgba(64,64,64,0.6),inset_-1px_0_0_rgba(64,64,64,0.6),inset_0_1px_0_rgba(64,64,64,0.6)]"
                : `text-neutral-400 ${busy ? "opacity-60" : "hover:bg-white/[0.04] hover:text-neutral-200"}`
            }`}
          >
            {/* Hairline between two inactive neighbours */}
            {index > 0 && !tab.isActive && !previousActive && (
              <span aria-hidden className="absolute top-[7px] bottom-[7px] -left-px w-px bg-neutral-800" />
            )}
            <button
              type="button"
              onClick={() => !tab.isActive && switchTab(tab.id)}
              disabled={busy && !tab.isActive}
              className={`min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm disabled:cursor-not-allowed ${
                tab.name ? "" : "italic text-neutral-500"
              }`}
            >
              {name}
            </button>
            {/* Unsaved dot sits where the close lives; hover swaps them */}
            {tab.hasUnsavedChanges && (
              <span
                aria-label="Unsaved"
                className="h-2 w-2 shrink-0 rounded-full bg-red-500 group-hover:hidden group-focus-within:hidden"
              />
            )}
            <button
              type="button"
              onClick={() => handleClose(tab.id, tab.name, tab.hasUnsavedChanges)}
              disabled={busy}
              aria-label={`Close ${name}`}
              title={busy ? busyReason : "Close tab"}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed ${
                tab.hasUnsavedChanges || !tab.isActive
                  ? "hidden group-hover:flex group-focus-within:flex"
                  : ""
              }`}
            >
              <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
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
