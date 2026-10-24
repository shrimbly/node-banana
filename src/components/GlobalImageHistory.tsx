"use client";

import { Download, ImagePlus, Images, LayoutGrid, LibraryBig, Maximize2, Play, X, Check } from "lucide-react";
import { memo, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import { getRecorderLibraryStatus } from "@/lib/assets/client/recorder";
import { useAddMediaNode } from "@/hooks/useAddMediaNode";
import { downloadMedia } from "@/utils/downloadMedia";
import { ImageHistoryItem } from "@/types";
import { formatDuration } from "./assets/assetFormat";
import { ChromeIconButton } from "./ChromeIconButton";
import { CHROME_SURFACE } from "./chromeStyles";
import { MediaViewer, type MediaViewerAction, type MediaViewerItem } from "./MediaViewer";
import { HISTORY_RIGHT_VAR } from "./Toast";

/** Inset of the history button from the canvas edges (matches the navigator). */
export const HISTORY_MARGIN = 16;
/** Chrome card around the 32px button: 4px insets and a 1px border. */
export const HISTORY_BUTTON_SIZE = 42;
/** Recent thumbnails shown in the drop-down before "Show all". */
const RECENT_COUNT = 12;
/** The drop-down: four 80px thumbnails across, 6px padding, 4px gaps. */
const DROPDOWN_WIDTH = 344;
/** How long "Add to graph" reads "Added" before it resets. */
const ADDED_MS = 1400;

/** Drag payload a history thumbnail carries; the canvas turns it into an image or video node. */
export const HISTORY_DRAG_TYPE = "application/history-image";
/** Set beside it for a video: a drag's data cannot be read until the drop, only its types. */
export const HISTORY_VIDEO_DRAG_TYPE = "application/history-video";

export function setHistoryDragData(
  e: React.DragEvent,
  item: Pick<ImageHistoryItem, "kind" | "image" | "prompt" | "timestamp">,
) {
  const kind = item.kind ?? "image";
  e.dataTransfer.setData(
    HISTORY_DRAG_TYPE,
    JSON.stringify({ kind, image: item.image, prompt: item.prompt, timestamp: item.timestamp }),
  );
  if (kind === "video") e.dataTransfer.setData(HISTORY_VIDEO_DRAG_TYPE, "");
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
  if (model === "nano-banana" || model === "nano-banana-2" || model === "nano-banana-2.1" || model === "nano-banana-2-lite") {
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
    case "nano-banana-2.1": return "Nano Banana 2.1";
    case "nano-banana-2-lite": return "Nano Banana 2 Lite";
    default: return model;
  }
}

function generationCost(item: ImageHistoryItem): string | null {
  const metadata = item.generation;
  if (!metadata) return null;
  return metadata.cost
    ? `${metadata.cost.estimated ? "Est. " : ""}$${metadata.cost.amount.toFixed(4)} USD`
    : "Cost unavailable";
}

function generationDetails(item: ImageHistoryItem): string {
  const metadata = item.generation;
  if (!metadata) return "";
  return [metadata.size, metadata.outputFormat?.toUpperCase(), generationCost(item)].filter(Boolean).join(" · ");
}

/** A history item as the viewer shows it: the prompt on top, what made it underneath. */
export function historyViewerItem(item: ImageHistoryItem): MediaViewerItem {
  const details: [string, string][] = [
    ["Created", formatRelativeTime(item.timestamp)],
    ["Model", producerName(item.model)],
  ];
  if (item.durationSec) details.push(["Length", formatDuration(item.durationSec)]);
  if (item.generation?.size) details.push(["Size", item.generation.size]);
  if (item.generation?.outputFormat) details.push(["Format", item.generation.outputFormat.toUpperCase()]);
  const cost = generationCost(item);
  if (cost) details.push(["Cost", cost]);
  return {
    id: item.id,
    src: item.image,
    kind: item.kind ?? "image",
    ...(item.poster ? { thumb: item.poster } : {}),
    title: item.prompt || "No prompt",
    details,
  };
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
  <Images size={18} strokeWidth={1.75} />
);

const GridIcon = () => (
  <LayoutGrid size={14} strokeWidth={1.75} />
);

/** A run of the recent list: one batch's outputs, or outputs of single runs. */
export interface RecentSection {
  key: string;
  /** Set for a batch's section. */
  batch?: { count: number; startedAt: number };
  /** Each item with its index in the full history (what the viewer opens). */
  items: { item: ImageHistoryItem; index: number }[];
}

/**
 * Splits the recent list (newest first) into sections: neighbours from the
 * same batch share one, as do neighbours from no batch.
 */
export function groupRecentByBatch(items: ImageHistoryItem[]): RecentSection[] {
  const sections: RecentSection[] = [];
  items.forEach((item, index) => {
    const batchId = item.batch?.id ?? null;
    const last = sections[sections.length - 1];
    const lastId = last?.batch ? last.key : null;
    if (last && lastId === batchId) {
      last.items.push({ item, index });
      if (last.batch) last.batch.startedAt = Math.min(last.batch.startedAt, item.timestamp);
      return;
    }
    sections.push({
      key: batchId ?? `single-${index}`,
      ...(item.batch ? { batch: { count: item.batch.count, startedAt: item.timestamp } } : {}),
      items: [{ item, index }],
    });
  });
  return sections;
}

const TILE_MEDIA = "pointer-events-none h-full w-full object-cover";

/**
 * A tile's picture. A video shows the library's poster, or its first frame
 * until there is one, with a play mark and its length.
 */
function TileMedia({ item, alt }: { item: ImageHistoryItem; alt: string }) {
  const [posterFailed, setPosterFailed] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  if (item.kind !== "video") return <img src={item.image} alt={alt} className={TILE_MEDIA} draggable={false} />;

  const length = item.durationSec ?? measured;
  return (
    <>
      {item.poster && !posterFailed ? (
        <img src={item.poster} alt={alt} className={TILE_MEDIA} draggable={false} onError={() => setPosterFailed(true)} />
      ) : (
        <video
          src={item.image}
          aria-label={alt}
          preload="metadata"
          muted
          playsInline
          className={TILE_MEDIA}
          onLoadedMetadata={(e) => {
            const { duration } = e.currentTarget;
            if (Number.isFinite(duration) && duration > 0) setMeasured(duration);
          }}
        />
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1 top-1 inline-flex h-4 items-center gap-0.5 rounded-[4px] bg-neutral-950/80 px-1 font-mono text-[10px] leading-4 tabular-nums text-neutral-200"
      >
        <Play size={9} strokeWidth={0} fill="currentColor" />
        {length ? formatDuration(length) : "Video"}
      </span>
    </>
  );
}

/** One thumbnail in the drop-down grid: click to view, drag to place. */
function RecentThumb({
  item,
  index,
  onOpen,
  onDragStart,
}: {
  item: ImageHistoryItem;
  index: number;
  onOpen: (index: number) => void;
  onDragStart: (e: React.DragEvent, item: ImageHistoryItem) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onClick={() => onOpen(index)}
      onDragStart={(e) => onDragStart(e, item)}
      aria-label={`View ${item.prompt?.substring(0, 60) || `history ${item.kind === "video" ? "video" : "image"} ${index + 1}`}`}
      className="group relative h-20 cursor-pointer overflow-hidden rounded-lg squircle bg-well shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-[box-shadow,transform] duration-[120ms] ease-out hover:shadow-[inset_0_0_0_2px_#3b82f6] hover:scale-[1.04] active:cursor-grabbing focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_#3b82f6]"
      title={`${item.batch ? `Run ${item.batch.index} of ${item.batch.count} · ` : ""}${formatRelativeTime(item.timestamp)} · ${describeProducer(item.model)}\n${item.prompt?.substring(0, 80) || "No prompt"}${item.generation ? `\n${generationDetails(item)}` : ""}`}
    >
      <TileMedia item={item} alt={`History ${index + 1}`} />
      {item.batch && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-1 min-w-4 rounded-[4px] bg-neutral-950/80 px-1 text-center font-mono text-[10px] leading-4 tabular-nums text-neutral-200"
        >
          {item.batch.index}
        </span>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-1 right-1 flex h-[22px] w-[22px] items-center justify-center rounded-md bg-neutral-950/80 text-white opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <Maximize2 size={12} strokeWidth={2} />
      </span>
    </button>
  );
}

// Floating panel listing every history item
function HistorySidebar({
  history,
  onClear,
  onClose,
  onOpen,
  onDragStart,
  triggerRect,
}: {
  history: ImageHistoryItem[];
  onClear: () => void;
  onClose: () => void;
  onOpen: (index: number) => void;
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
            className="text-[10px] text-neutral-500 transition-colors hover:text-neutral-200"
            title="Files stay in Assets"
          >
            Clear list
          </button>
          <button
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-white/7 hover:text-white"
            title="Close"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {history.map((item, index) => (
          <div
            key={item.id}
            draggable
            role="button"
            tabIndex={0}
            onClick={() => onOpen(index)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(index);
              }
            }}
            onDragStart={(e) => onDragStart(e, item)}
            className="group flex cursor-pointer gap-3 rounded-lg p-2 transition-colors hover:bg-white/5 active:cursor-grabbing"
          >
            {/* Thumbnail */}
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg squircle shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-shadow group-hover:shadow-[inset_0_0_0_2px_#3b82f6]">
              <TileMedia item={item} alt={`History ${index + 1}`} />
            </div>

            {/* Info */}
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <p className="truncate text-[11px] text-neutral-300">
                {item.prompt?.substring(0, 60) || "No prompt"}
              </p>
              <p className="mt-0.5 text-[10px] text-neutral-500">
                {formatRelativeTime(item.timestamp)} · {describeProducer(item.model)}
              </p>
              {item.generation && <p className="mt-0.5 text-[10px] text-neutral-500">{generationDetails(item)}</p>}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-white/8 px-4 py-2">
        <span className="text-[10px] text-neutral-500">Click to view · drag onto the canvas</span>
      </div>
    </div>,
    document.body
  );
}

// Memoised: rendered by the canvas, which re-renders on every drag frame
interface GlobalImageHistoryProps {
  /** The button's distance from the canvas's right edge; larger while the agent window covers the corner. */
  rightInset?: number;
  /**
   * Where the drop-down and the notifications align, from the right edge:
   * the window's edge while the agent window is closed (the button sits
   * beside the agent pill), the button's own inset while it is open.
   */
  anchorRight?: number;
}

export const GlobalImageHistory = memo(function GlobalImageHistory({
  rightInset = HISTORY_MARGIN,
  anchorRight = HISTORY_MARGIN,
}: GlobalImageHistoryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  /** Index into the whole history, while the viewer is up. */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const history = useWorkflowStore((state) => state.globalImageHistory);
  const clearGlobalHistory = useWorkflowStore((state) => state.clearGlobalHistory);
  const appView = useAssetStore((state) => state.appView);
  const setAppView = useAssetStore((state) => state.setAppView);
  const addMediaNode = useAddMediaNode();

  // Nothing of this stays open over the Assets view (the sidebar is portaled above it)
  useEffect(() => {
    setIsOpen(false);
    setShowSidebar(false);
    setViewerIndex(null);
  }, [appView]);

  // Notifications hang where the drop-down does (Toast.tsx); tell them where that is.
  useEffect(() => {
    const root = document.documentElement;
    if (anchorRight === HISTORY_MARGIN) root.style.removeProperty(HISTORY_RIGHT_VAR);
    else root.style.setProperty(HISTORY_RIGHT_VAR, `${anchorRight}px`);
    return () => {
      root.style.removeProperty(HISTORY_RIGHT_VAR);
    };
  }, [anchorRight]);

  // "Added" reads for a moment, then the button is ready for the next one.
  useEffect(() => {
    if (addedId === null) return;
    const timer = window.setTimeout(() => setAddedId(null), ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [addedId]);

  const recentSections = useMemo(() => groupRecentByBatch(history.slice(0, RECENT_COUNT)), [history]);
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

  const openAssets = useCallback(() => {
    setIsOpen(false);
    setAppView("assets");
  }, [setAppView]);

  // Everything lives in Assets; this tab's list is only a recent slice of it.
  // Without a library (a hosted server) the list itself is all there is.
  const handleShowAll = useCallback(() => {
    if (getRecorderLibraryStatus()?.available === false) {
      setIsOpen(false);
      setShowSidebar(true);
    } else {
      openAssets();
    }
  }, [openAssets]);

  const handleCloseSidebar = useCallback(() => {
    setShowSidebar(false);
  }, []);

  const handleClear = useCallback(() => {
    clearGlobalHistory();
    setIsOpen(false);
    setShowSidebar(false);
    setViewerIndex(null);
  }, [clearGlobalHistory]);

  // The viewer walks the whole history, not just the recent slice.
  const openViewer = useCallback((index: number) => {
    setIsOpen(false);
    setShowSidebar(false);
    setAddedId(null);
    setViewerIndex(index);
  }, []);
  const closeViewer = useCallback(() => setViewerIndex(null), []);

  const viewerItems = useMemo(() => history.map(historyViewerItem), [history]);
  const viewed = viewerIndex !== null ? history[viewerIndex] : undefined;
  const viewerActions = useMemo<MediaViewerAction[]>(() => {
    if (!viewed) return [];
    const added = addedId === viewed.id;
    const kind = viewed.kind ?? "image";
    return [
      {
        label: added ? "Added" : "Add to graph",
        icon: added ? Check : ImagePlus,
        tone: added ? "success" : "primary",
        shortcut: "Enter",
        onClick: () => {
          addMediaNode({ kind, src: viewed.image, filename: `history-${viewed.timestamp}.${kind === "video" ? "mp4" : "png"}` });
          setAddedId(viewed.id);
        },
      },
      {
        label: "Download",
        icon: Download,
        shortcut: "d",
        onClick: () => {
          downloadMedia(viewed.image, kind).catch((err) => console.error("History download failed:", err));
        },
      },
    ];
  }, [viewed, addedId, addMediaNode]);

  if (history.length === 0) return null;

  const countLabel = `${history.length} item${history.length > 1 ? "s" : ""} in history`;

  return (
    <div
      ref={rootRef}
      className="absolute z-10 flex flex-col items-end"
      style={{ top: HISTORY_MARGIN, right: rightInset }}
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

      {/* Recent drop-down: right-aligned to the anchor, not to the button */}
      {isOpen && (
        <div
          className={`${CHROME_SURFACE} animate-drop-in nodrag nopan nowheel absolute flex flex-col gap-1.5 rounded-xl p-1.5`}
          style={{ top: HISTORY_BUTTON_SIZE + 8, right: anchorRight - rightInset, width: DROPDOWN_WIDTH }}
          role="dialog"
          aria-label="Recent generations"
          data-testid="history-dropdown"
        >
          <div className="flex items-center justify-between px-1.5 pt-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-neutral-500">Recent</span>
            <button
              type="button"
              onClick={handleClear}
              className="text-[10px] text-neutral-500 transition-colors hover:text-neutral-200"
              title="Files stay in Assets"
            >
              Clear list
            </button>
          </div>
          {recentSections.map((section, sectionIndex) => (
            <div key={section.key} className="flex flex-col gap-1.5">
              {section.batch ? (
                <div className="flex items-center justify-between px-1.5 font-mono text-[10px] uppercase leading-[14px] tracking-eyebrow">
                  <span className="text-neutral-300">Batch · {section.batch.count} runs</span>
                  <span className="text-ink-3">
                    {new Date(section.batch.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ) : sectionIndex > 0 ? (
                <span className="px-1.5 font-mono text-[10px] uppercase leading-[14px] tracking-eyebrow text-ink-3">Earlier</span>
              ) : null}
              <div className="grid grid-cols-4 gap-1">
                {section.items.map(({ item, index }) => (
                  <RecentThumb key={item.id} item={item} index={index} onOpen={openViewer} onDragStart={handleDragStart} />
                ))}
              </div>
            </div>
          ))}
          <span className="px-1.5 text-[10px] leading-[13px] text-neutral-500">Click to view · drag onto the canvas</span>
          <div className="flex gap-1">
            {hasOverflow && (
              <button
                type="button"
                onClick={handleShowAll}
                className="flex h-7 flex-1 items-center justify-center gap-2 rounded-md squircle bg-white/4 text-[11px] font-medium text-neutral-300 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
              >
                <GridIcon />
                <span>Show all · {history.length}</span>
              </button>
            )}
            <button
              type="button"
              onClick={openAssets}
              className="flex h-7 flex-1 items-center justify-center gap-2 rounded-md squircle text-[11px] font-medium text-neutral-400 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
              title="Every generation, from every workflow (A)"
            >
              <LibraryBig size={14} strokeWidth={1.75} />
              <span>Open Assets</span>
            </button>
          </div>
        </div>
      )}

      {/* Sidebar for all items */}
      {showSidebar && (
        <HistorySidebar
          history={history}
          onClear={handleClear}
          onClose={handleCloseSidebar}
          onOpen={openViewer}
          onDragStart={handleDragStart}
          triggerRect={triggerRef.current?.getBoundingClientRect() || null}
        />
      )}

      {/* Full-screen viewer over the whole history */}
      <MediaViewer
        open={viewerIndex !== null && viewed !== undefined}
        items={viewerItems}
        index={viewerIndex ?? 0}
        onIndexChange={(index) => {
          setAddedId(null);
          setViewerIndex(index);
        }}
        onClose={closeViewer}
        actions={viewerActions}
        label="Recent generation"
        footer={
          <button
            type="button"
            onClick={() => {
              closeViewer();
              openAssets();
            }}
            className="flex h-7 cursor-pointer items-center justify-center gap-2 rounded-md text-[11px] font-medium text-neutral-400 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
          >
            <LibraryBig size={14} strokeWidth={1.75} />
            <span>Open in Assets</span>
          </button>
        }
      />
    </div>
  );
});
