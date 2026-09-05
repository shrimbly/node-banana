"use client";

import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { summarizeWorkflowTabs } from "@/store/utils/workflowTabs";

/**
 * Open workflows as a strip across the top of the window. It only appears
 * once a second workflow is open; with one, the corner menu is the whole
 * chrome. Switching and closing are blocked while a run or save is in flight,
 * because the store holds only the live workflow's execution state.
 */
export function WorkflowTabs() {
  const { tabs, activeTabId, workflowName, hasUnsavedChanges, isRunning, isSaving, switchTab, closeTab, newTab } =
    useWorkflowStore(
      useShallow((state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        workflowName: state.workflowName,
        hasUnsavedChanges: state.hasUnsavedChanges,
        isRunning: state.isRunning,
        isSaving: state.isSaving,
        switchTab: state.switchTab,
        closeTab: state.closeTab,
        newTab: state.newTab,
      }))
    );

  if (tabs.length <= 1) return null;

  const summaries = summarizeWorkflowTabs(tabs, activeTabId, { workflowName, hasUnsavedChanges });
  const busy = isRunning || isSaving;
  const busyReason = isRunning ? "Wait for the run to finish" : "Wait for the save to finish";

  const handleClose = (id: string, name: string | null, unsaved: boolean) => {
    if (unsaved && !window.confirm(`Close ${name ?? "Untitled"} and discard its unsaved changes?`)) return;
    closeTab(id);
  };

  return (
    <div
      role="tablist"
      aria-label="Open workflows"
      className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-neutral-700/50 bg-[#141414] px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {summaries.map((tab) => {
        const name = tab.name ?? "Untitled";
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.isActive}
            title={busy && !tab.isActive ? busyReason : name}
            className={`group flex h-7 shrink-0 items-center gap-1.5 rounded-md border pl-2.5 pr-1.5 text-xs whitespace-nowrap ${
              tab.isActive
                ? "border-neutral-700/80 bg-neutral-800 text-neutral-100"
                : `border-transparent text-neutral-400 ${busy ? "opacity-60" : "hover:bg-neutral-700/40 hover:text-neutral-200"}`
            }`}
          >
            <button
              type="button"
              onClick={() => !tab.isActive && switchTab(tab.id)}
              disabled={busy && !tab.isActive}
              className="flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm disabled:cursor-not-allowed"
            >
              {tab.hasUnsavedChanges && <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-label="Unsaved" />}
              <span className={tab.name ? "" : "italic text-neutral-500"}>{name}</span>
            </button>
            <button
              type="button"
              onClick={() => handleClose(tab.id, tab.name, tab.hasUnsavedChanges)}
              disabled={busy}
              aria-label={`Close ${name}`}
              title={busy ? busyReason : "Close tab"}
              className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm text-neutral-500 hover:bg-neutral-600 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed ${
                tab.isActive ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
        className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-700/40 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}>
          <path strokeLinecap="round" d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}
