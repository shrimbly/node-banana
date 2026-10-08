"use client";

import { LibraryBig, MessagesSquare, Plus, X } from "lucide-react";
import { useEffect, useMemo, type MouseEvent, type ReactNode } from "react";
import { useOnViewportChange, useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import { useShallow } from "zustand/shallow";
import { summarizeWorkflowTabs } from "@/store/utils/workflowTabs";

/** The shown tab's shape: hanging over the frame's top border, outlined on three sides. */
const SHOWN_TAB_SHAPE =
  "-mb-0.5 h-[32px] text-neutral-100 shadow-[inset_1px_0_0_rgba(64,64,64,0.6),inset_-1px_0_0_rgba(64,64,64,0.6),inset_0_1px_0_rgba(64,64,64,0.6)]";

/** The shown tab: canvas-coloured, so it reads as part of the canvas. */
const SHOWN_TAB_CLASS = `${SHOWN_TAB_SHAPE} bg-canvas-bg`;

/** A shown view entry (the chat, Assets): the colour of the view's left rail it sits over. */
const SHOWN_VIEW_CLASS = `${SHOWN_TAB_SHAPE} bg-pane`;

/**
 * Open workflows as browser-style tabs across the top of the window. The bar
 * is always there, so the workflow name has one home. The active tab is the
 * canvas colour and open at the bottom, so it reads as part of the canvas.
 * Switching and closing are blocked while a run, a save or a media write is
 * in flight, because the store holds only the live workflow's execution state.
 * Each tab also remembers its pan and zoom.
 *
 * The chat and Assets entries lead the strip, each an icon until its view
 * is shown, when it takes its label. They are toggle buttons, not tabs (each
 * is a view over every workflow, not one of them), and take the shown-tab
 * look while their view is up. That look is styling only: which workflow
 * tab is live, and what the busy state blocks, never changes with it. Any
 * workflow tab, the plus and closing a tab all go back to the canvas.
 */
export function WorkflowTabs() {
  const appView = useAssetStore((state) => state.appView);
  const setAppView = useAssetStore((state) => state.setAppView);
  const toggleAppView = useAssetStore((state) => state.toggleAppView);
  const {
    tabs,
    activeTabId,
    workflowName,
    hasUnsavedChanges,
    isRunning,
    isSaving,
    pendingMediaSaves,
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
      setCanvasViewport: state.setCanvasViewport,
      switchTab: state.switchTab,
      closeTab: state.closeTab,
      newTab: state.newTab,
    }))
  );

  // The viewport lives in React Flow; mirror it into the store so it parks with the tab
  const { getViewport, setViewport } = useReactFlow();
  useOnViewportChange({ onEnd: setCanvasViewport });
  // Capture the incoming tab's viewport during render, before React Flow's
  // effects can publish navigation events for the outgoing view.
  const tabViewport = useMemo(() => useWorkflowStore.getState().canvasViewport, [activeTabId]);
  useEffect(() => {
    // A tab that has been viewed before comes back where it was left; a tab
    // shown for the first time adopts the current view as its own
    if (tabViewport) setViewport(tabViewport);
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
    setAppView("canvas");
  };

  // The live tab looks shown only while the canvas is what is shown
  const shownIndex = appView === "canvas" ? summaries.findIndex((tab) => tab.isActive) : -1;

  return (
    <div
      role="tablist"
      aria-label="Open workflows"
      // Just above the canvas frame, so the active tab can sit over its top
      // border; everything the frame clips stays below it, and everything
      // fixed (modals, menus) still stacks above
      className="workflow-tabs relative z-[1] flex h-[38px] min-w-0 shrink-0 items-end bg-[#0f0f0f] pl-3 pr-2"
    >
      <ViewToggle
        label="Chat"
        shortcut="C"
        icon={<MessagesSquare size={14} strokeWidth={1.75} />}
        shown={appView === "chat"}
        onToggle={() => toggleAppView("chat")}
      />
      <ViewToggle
        label="Assets"
        shortcut="A"
        icon={<LibraryBig size={14} strokeWidth={1.75} />}
        shown={appView === "assets"}
        onToggle={() => toggleAppView("assets")}
      />
      {summaries.map((tab, index) => {
        const name = tab.name ?? "Untitled";
        const shown = index === shownIndex;
        // Only between two workflow tabs neither of which is shown: the first
        // tab never draws one, nothing divides it from the view icons
        const hairline = index > 0 && !shown && index - 1 !== shownIndex;
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
              shown
                ? SHOWN_TAB_CLASS
                : `text-neutral-400 ${busy && !tab.isActive ? "opacity-60" : "hover:bg-white/[0.04] hover:text-neutral-200"}`
            }`}
          >
            {/* The shown tab flows into the canvas frame: concave corners at its feet */}
            {shown && (
              <>
                <TabEar side="left" />
                <TabEar side="right" />
              </>
            )}
            {hairline && (
              <span aria-hidden className="absolute top-[7px] bottom-[7px] -left-px w-px bg-neutral-800" />
            )}
            <button
              type="button"
              onClick={() => {
                setAppView("canvas");
                if (!tab.isActive) switchTab(tab.id);
              }}
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
                  tab.hasUnsavedChanges || !shown
                    ? "hidden group-hover:flex group-focus-within:flex"
                    : "flex"
                }`}
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            </span>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          setAppView("canvas");
          newTab();
        }}
        disabled={busy}
        aria-label="New tab"
        title={busy ? busyReason : "New tab"}
        className="mb-px ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Plus size={14} strokeWidth={2.25} />
      </button>
    </div>
  );
}

/**
 * A leading entry that shows a view over every workflow in place of the
 * canvas: just its icon until the view is up, then the icon, its label and
 * the shown-tab look. A second press goes back to the canvas.
 */
function ViewToggle({
  label,
  shortcut,
  icon,
  shown,
  onToggle,
}: {
  label: string;
  shortcut: string;
  icon: ReactNode;
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={shown}
      onClick={onToggle}
      aria-label={label}
      title={shown ? `Back to the canvas (${shortcut})` : `${label} (${shortcut})`}
      className={`relative flex h-[30px] shrink-0 items-center gap-1.5 rounded-t-lg text-xs whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        shown ? `${SHOWN_VIEW_CLASS} px-3` : "w-[34px] justify-center text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200"
      }`}
    >
      {shown && (
        <>
          <TabEar side="left" fill="var(--color-pane)" />
          <TabEar side="right" fill="var(--color-pane)" />
        </>
      )}
      {icon}
      {shown && label}
    </button>
  );
}

/**
 * The concave corner where the active tab meets the canvas frame, drawn just
 * outside the tab's foot on one side. Canvas-coloured, with the frame's border
 * running along its curve, so the tab and the canvas read as one sheet.
 */
function TabEar({ side, fill = "var(--color-canvas-bg)" }: { side: "left" | "right"; fill?: string }) {
  return (
    // 9px square, one column into the tab so the curve starts on the tab's own
    // 1px side border and ends on the centre of the frame's top border row.
    // The tab hangs 2px over the frame; the ear stops 1px short so its curve
    // lands on the border row, not below it.
    <svg
      aria-hidden
      className={`pointer-events-none absolute bottom-px h-[9px] w-[9px] ${side === "left" ? "-left-2" : "-right-2 -scale-x-100"}`}
      viewBox="0 0 9 9"
      fill="none"
    >
      <path d="M8.5 0 A8 8.5 0 0 1 0.5 8.5 L0.5 9 L9 9 L9 0 Z" fill={fill} />
      <path d="M8.5 0 A8 8.5 0 0 1 0.5 8.5" stroke="var(--color-card-border)" strokeWidth="1" />
    </svg>
  );
}
