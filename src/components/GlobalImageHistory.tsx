"use client";

import { memo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageHistoryItem } from "@/types";
import { ChromeIconButton } from "./ChromeIconButton";
import { CHROME_SURFACE } from "./chromeStyles";

/** Inset of the history button from the canvas edges (matches the navigator). */
export const HISTORY_MARGIN = 16;
/** Chrome card around the 32px button: 4px insets and a 1px border. */
export const HISTORY_BUTTON_SIZE = 42;
/** Recent thumbnails shown in the drop-down before "Show all". */
const RECENT_COUNT = 12;

/** Drag payload a history thumbnail carries; the canvas turns it into an image node. */
export const HISTORY_DRAG_TYPE = "application/history-image";

export function setHistoryDragData(
  e: React.DragEvent,
  item: Pick<ImageHistoryItem, "image" | "prompt" | "timestamp">,
) {
  e.dataTransfer.setData(
    HISTORY_DRAG_TYPE,
    JSON.stringify({ image: item.image, prompt: item.prompt, timestamp: item.timestamp }),
  );
  e.dataTransfer.effectAllowed = "copy";
}

/**
 * What produced an image, for the history row.
 *
 * `model` is a Gemini model id for the built-in generator, but a free-form
 * producer name for anything else (a ComfyUI app, say) — so anything
 * unrecognised is shown as-is rather than mislabelled "Standard".
 */
export function describeProducer(model: string): string {
  if (model === "nano-banana-pro") return "Pro";
  if (model === "nano-banana" || model === "nano-banana-2" || model === "nano-banana-2-lite") {
    return "Standard";
  }
  return model;
}

/** The producer's full name, for surfaces that stand alone (the generation toast). */
export function producerName(model: string): string {
  switch (model) {
    case "nano-banana-pro": return "Nano Banana Pro";
    case "nano-banana": return "Nano Banana";
    case "nano-banana-2": return "Nano Banana 2";
    case "nano-banana-2-lite": return "Nano Banana 2 Lite";
    default: return model;
  }
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "Just now";
}

const ImagesIcon = () => (
  <svg
    className="h-[18px] w-[18px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="7" y="3" width="14" height="14" rx="2" />
    <path d="M17 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2" />
    <circle cx="11.5" cy="7.5" r="1.25" />
    <path d="m21 14-3.3-3.3a1.5 1.5 0 0 0-2.1 0L10 16" />
  </svg>
);

const GridIcon = () => (
  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" rx="1.5" />
    <rect x="14" y="4" width="6" height="6" rx="1.5" />
    <rect x="4" y="14" width="6" height="6" rx="1.5" />
    <rect x="14" y="14" width="6" height="6" rx="1.5" />
  </svg>
);

/** One thumbnail in the drop-down grid. */
function RecentThumb({
  item,
  index,
  onDragStart,
}: {
  item: ImageHistoryItem;
  index: number;
  onDragStart: (e: React.DragEvent, item: ImageHistoryItem) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      className="relative h-[52px] cursor-grab overflow-hidden rounded-md squircle bg-well shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-[box-shadow,transform] duration-[120ms] ease-out hover:shadow-[inset_0_0_0_2px_#3b82f6] hover:scale-[1.04] active:cursor-grabbing focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_#3b82f6]"
      title={`${formatRelativeTime(item.timestamp)} · ${describeProducer(item.model)}\n${item.prompt?.substring(0, 80) || "No prompt"}`}
    >
      <img
        src={item.image}
        alt={`History ${index + 1}`}
        className="pointer-events-none h-full w-full object-cover"
        draggable={false}
      />
    </button>
  );
}

// Floating panel listing every history item
function HistorySidebar({
  history,
  onClear,
  onClose,
  onDragStart,
  triggerRect,
}: {
  history: ImageHistoryItem[];
  onClear: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent, item: ImageHistoryItem) => void;
  triggerRect: DOMRect | null;
}) {
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Hang beneath the trigger, right-aligned, and stay on screen
  const sidebarStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 200,
  };

  if (triggerRect) {
    const top = triggerRect.bottom + 8;
    sidebarStyle.top = `${top}px`;
    sidebarStyle.right = `${Math.max(16, window.innerWidth - triggerRect.right)}px`;
    sidebarStyle.maxHeight = `${Math.min(480, window.innerHeight - top - 16)}px`;
  } else {
    sidebarStyle.right = "16px";
    sidebarStyle.top = "100px";
    sidebarStyle.maxHeight = "480px";
  }

  return createPortal(
    <div
      ref={sidebarRef}
      className={`${CHROME_SURFACE} animate-drop-in flex w-80 flex-col overflow-hidden rounded-xl`}
      style={sidebarStyle}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-3">
        <span className="text-sm font-medium text-neutral-200">
          All History ({history.length})
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            className="text-[10px] text-neutral-500 transition-colors hover:text-red-400"
            title="Clear all history"
          >
            Clear All
          </button>
          <button
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-white/7 hover:text-white"
            title="Close"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {history.map((item, index) => (
          <div
            key={item.id}
            draggable
            onDragStart={(e) => onDragStart(e, item)}
            className="group flex cursor-grab gap-3 rounded-lg p-2 transition-colors hover:bg-white/5 active:cursor-grabbing"
          >
            {/* Thumbnail */}
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-shadow group-hover:shadow-[inset_0_0_0_2px_#3b82f6]">
              <img
                src={item.image}
                alt={`History ${index + 1}`}
                className="pointer-events-none h-full w-full object-cover"
                draggable={false}
              />
            </div>

            {/* Info */}
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <p className="truncate text-[11px] text-neutral-300">
                {item.prompt?.substring(0, 60) || "No prompt"}
              </p>
              <p className="mt-0.5 text-[10px] text-neutral-500">
                {formatRelativeTime(item.timestamp)} · {describeProducer(item.model)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-white/8 px-4 py-2">
        <span className="text-[10px] text-neutral-500">Drag images to canvas to create nodes</span>
      </div>
    </div>,
    document.body
  );
}

// Memoised: rendered by the canvas, which re-renders on every drag frame
export const GlobalImageHistory = memo(function GlobalImageHistory() {
  const [isOpen, setIsOpen] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const history = useWorkflowStore((state) => state.globalImageHistory);
  const clearGlobalHistory = useWorkflowStore((state) => state.clearGlobalHistory);

  const recent = history.slice(0, RECENT_COUNT);
  const hasOverflow = history.length > RECENT_COUNT;

  // Close the drop-down on click outside (but not while the sidebar is up)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen && !showSidebar) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, showSidebar]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showSidebar) {
          setShowSidebar(false);
        } else {
          setIsOpen(false);
        }
      }
    };
    if (isOpen || showSidebar) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, showSidebar]);

  const handleDragStart = useCallback((e: React.DragEvent, item: ImageHistoryItem) => {
    setHistoryDragData(e, item);

    // Close after the drag has started. Deferred so the draggable element is
    // not unmounted mid-drag.
    setTimeout(() => {
      setIsOpen(false);
      setShowSidebar(false);
    }, 0);
  }, []);

  const handleShowAll = useCallback(() => {
    setIsOpen(false);
    setShowSidebar(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setShowSidebar(false);
  }, []);

  const handleClear = useCallback(() => {
    clearGlobalHistory();
    setIsOpen(false);
    setShowSidebar(false);
  }, [clearGlobalHistory]);

  if (history.length === 0) return null;

  const countLabel = `${history.length} image${history.length > 1 ? "s" : ""} in history`;

  return (
    <div
      ref={rootRef}
      className="absolute z-10 flex flex-col items-end"
      style={{ top: HISTORY_MARGIN, right: HISTORY_MARGIN }}
      data-testid="image-history"
    >
      {/* Trigger */}
      <div className={`${CHROME_SURFACE} nodrag nopan flex rounded-xl p-1`}>
        <ChromeIconButton
          ref={triggerRef}
          label={countLabel}
          title={countLabel}
          tooltipPlacement="bottom"
          tooltipAlign="end"
          open={isOpen}
          silent={isOpen}
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
          badge={
            <span className="pointer-events-none absolute -top-1.5 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold leading-none text-white">
              {history.length > 99 ? "99+" : history.length}
            </span>
          }
        >
          <ImagesIcon />
        </ChromeIconButton>
      </div>

      {/* Recent drop-down */}
      {isOpen && (
        <div
          className={`${CHROME_SURFACE} animate-drop-in nodrag nopan nowheel mt-2 flex w-[236px] flex-col gap-1.5 rounded-xl p-1.5`}
          role="dialog"
          aria-label="Recent generations"
        >
          <div className="flex items-center justify-between px-1.5 pt-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-neutral-500">Recent</span>
            <button
              type="button"
              onClick={handleClear}
              className="text-[10px] text-neutral-500 transition-colors hover:text-red-400"
              title="Clear all history"
            >
              Clear
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {recent.map((item, index) => (
              <RecentThumb key={item.id} item={item} index={index} onDragStart={handleDragStart} />
            ))}
          </div>
          {hasOverflow && (
            <button
              type="button"
              onClick={handleShowAll}
              className="flex h-7 items-center justify-center gap-2 rounded-md squircle bg-white/4 text-[11px] font-medium text-neutral-300 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
            >
              <GridIcon />
              <span>Show all · {history.length}</span>
            </button>
          )}
        </div>
      )}

      {/* Sidebar for all items */}
      {showSidebar && (
        <HistorySidebar
          history={history}
          onClear={handleClear}
          onClose={handleCloseSidebar}
          onDragStart={handleDragStart}
          triggerRect={triggerRef.current?.getBoundingClientRect() || null}
        />
      )}
    </div>
  );
});
