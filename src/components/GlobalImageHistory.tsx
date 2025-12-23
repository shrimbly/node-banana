"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore } from "@/store/workflowStore";
import { useCropperStore } from "@/store/cropperStore";
import { downloadImage } from "@/utils/downloadImage";
import { ImageHistoryItem } from "@/types";

// Helper function for relative time display
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "Just now";
}

// Calculate fan position for each item (vertical stack with slight curve to the right, like macOS Downloads)
function calculateFanPosition(index: number, total: number) {
  // Vertical spacing between items
  const verticalSpacing = 60;

  // Curve to the right as items go up - slight quadratic curve
  const curveStrength = 0.15;
  const xOffset = index * index * curveStrength;

  const x = -28 + xOffset; // start centered above icon, then curve to the right
  const y = -(index * verticalSpacing + 56); // stack upward, start above icon with gap

  return { x, y };
}

// Fan Item Component
function FanItem({
  item,
  index,
  total,
  onDragStart,
}: {
  item: ImageHistoryItem;
  index: number;
  total: number;
  onDragStart: (e: React.DragEvent, item: ImageHistoryItem) => void;
}) {
  const { x, y } = calculateFanPosition(index, total);
  const delay = index * 30;

  return (
    <button
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      className="absolute w-14 h-14 rounded-lg overflow-hidden border-2 border-neutral-600 hover:border-blue-500 shadow-lg cursor-grab active:cursor-grabbing transition-colors duration-150 animate-fan-enter group"
      style={
        {
          "--fan-x": `${x}px`,
          "--fan-y": `${y}px`,
          animationDelay: `${delay}ms`,
          zIndex: 10 - index,
        } as React.CSSProperties
      }
      title={`${formatRelativeTime(item.timestamp)}\n${item.prompt?.substring(0, 50) || ""}...`}
    >
      <img
        src={item.image}
        alt={`History ${index + 1}`}
        className="w-full h-full object-cover pointer-events-none"
        draggable={false}
      />
    </button>
  );
}

// Floating Sidebar for showing all history items
function HistorySidebar({
  history,
  onClear,
  onClose,
  onDragStart,
  onDownload,
  onOpenCropper,
  triggerRect,
}: {
  history: ImageHistoryItem[];
  onClear: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent, item: ImageHistoryItem) => void;
  onDownload: (item: ImageHistoryItem) => void;
  onOpenCropper: (item: ImageHistoryItem) => void;
  triggerRect: DOMRect | null;
}) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: ImageHistoryItem } | null>(null);

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
      if (e.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: ImageHistoryItem) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  }, []);

  // Position the sidebar near the trigger, but ensure it stays on screen
  const sidebarStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 200,
  };

  if (triggerRect) {
    // Position above the trigger
    const left = Math.max(16, triggerRect.left - 140);
    const bottom = window.innerHeight - triggerRect.top + 8;
    sidebarStyle.left = `${left}px`;
    sidebarStyle.bottom = `${bottom}px`;
  } else {
    // Fallback to bottom right
    sidebarStyle.right = "100px";
    sidebarStyle.bottom = "100px";
  }

  return createPortal(
    <div
      ref={sidebarRef}
      className="w-80 max-h-[420px] bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl flex flex-col"
      style={sidebarStyle}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-700 flex items-center justify-between shrink-0">
        <span className="text-sm text-neutral-200 font-medium">
          All History ({history.length})
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            className="text-[10px] text-neutral-500 hover:text-red-400 transition-colors"
            title="Clear all history"
          >
            Clear All
          </button>
          <button
            onClick={onClose}
            className="w-5 h-5 rounded hover:bg-neutral-700 flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
            title="Close"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {history.map((item, index) => (
          <div
            key={item.id}
            draggable
            onDragStart={(e) => onDragStart(e, item)}
            onContextMenu={(e) => handleContextMenu(e, item)}
            className="flex gap-3 p-2 rounded-lg hover:bg-neutral-700/50 cursor-grab active:cursor-grabbing group transition-colors"
          >
            {/* Thumbnail */}
            <div className="w-14 h-14 rounded overflow-hidden shrink-0 border border-neutral-600 group-hover:border-blue-500 transition-colors relative">
              <img
                src={item.image}
                alt={`History ${index + 1}`}
                className="w-full h-full object-cover pointer-events-none"
                draggable={false}
              />
              {/* Quick action buttons on hover */}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); onDownload(item); }}
                  className="w-6 h-6 bg-neutral-700 hover:bg-green-600 rounded flex items-center justify-center text-white"
                  title="Download"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenCropper(item); }}
                  className="w-6 h-6 bg-neutral-700 hover:bg-blue-600 rounded flex items-center justify-center text-white"
                  title="Split Grid / Crop"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 flex flex-col justify-center">
              <p className="text-[11px] text-neutral-300 truncate">
                {item.prompt?.substring(0, 60) || "No prompt"}
              </p>
              <p className="text-[10px] text-neutral-500 mt-0.5">
                {formatRelativeTime(item.timestamp)} · {item.model === "nano-banana-pro" ? "Pro" : "Standard"}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-[300]"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-[301] bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => { onDownload(contextMenu.item); setContextMenu(null); }}
              className="w-full px-3 py-2 text-xs text-left text-neutral-300 hover:bg-neutral-700 hover:text-white flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download
            </button>
            <button
              onClick={() => { onOpenCropper(contextMenu.item); setContextMenu(null); }}
              className="w-full px-3 py-2 text-xs text-left text-neutral-300 hover:bg-neutral-700 hover:text-white flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
              Split Grid / Crop
            </button>
          </div>
        </>
      )}

      {/* Footer */}
      <div className="px-4 py-2 border-t border-neutral-700 bg-neutral-900/50 shrink-0">
        <span className="text-[10px] text-neutral-500">Drag images to canvas to create nodes</span>
      </div>
    </div>,
    document.body
  );
}

export function GlobalImageHistory() {
  const [isOpen, setIsOpen] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const history = useWorkflowStore((state) => state.globalImageHistory);
  const clearGlobalHistory = useWorkflowStore((state) => state.clearGlobalHistory);
  const openCropper = useCropperStore((state) => state.openModal);

  // Show max 10 items in fan
  const fanItems = history.slice(0, 10);
  const hasOverflow = history.length > 10;

  // Close fan on click outside (but not sidebar)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(event.target as Node)
      ) {
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

  const handleDragStart = useCallback(
    (e: React.DragEvent, item: ImageHistoryItem) => {
      e.dataTransfer.setData(
        "application/history-image",
        JSON.stringify({
          image: item.image,
          prompt: item.prompt,
          timestamp: item.timestamp,
        })
      );
      e.dataTransfer.effectAllowed = "copy";

      // Close the fan/sidebar after drag has started
      // Using setTimeout to defer state change until after the drag is properly initiated
      // This prevents the draggable element from being unmounted mid-drag
      setTimeout(() => {
        setIsOpen(false);
        setShowSidebar(false);
      }, 0);
    },
    []
  );

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

  const handleDownload = useCallback((item: ImageHistoryItem) => {
    downloadImage(item.image, {
      filename: `generated-${Date.now()}.png`,
    });
  }, []);

  const handleOpenCropper = useCallback((item: ImageHistoryItem) => {
    openCropper(item.image);
    setShowSidebar(false);
    setIsOpen(false);
  }, [openCropper]);

  if (history.length === 0) return null;

  return (
    <div ref={drawerRef} className="absolute bottom-4 right-64 z-10">
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`
          relative w-8 h-8 rounded-lg flex items-center justify-center
          bg-neutral-800 hover:bg-neutral-700 border border-neutral-600
          text-neutral-400 hover:text-white
          shadow-lg transition-colors
        `}
        title={`${history.length} image${history.length > 1 ? "s" : ""} in history`}
      >
        {/* Clock/history icon */}
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        {/* Badge showing count */}
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-blue-500 rounded-full text-[10px] text-white flex items-center justify-center font-bold">
          {history.length > 99 ? "99+" : history.length}
        </span>
      </button>

      {/* Fan Layout */}
      {isOpen && (
        <div className="absolute bottom-full right-1/2 translate-x-1/2 mb-2" style={{ zIndex: 100 }}>
          {/* Fan items */}
          <div className="relative w-0 h-0">
            {fanItems.map((item, index) => (
              <FanItem
                key={item.id}
                item={item}
                index={index}
                total={fanItems.length}
                onDragStart={handleDragStart}
              />
            ))}
          </div>

          {/* Show All button (if more than 10 items) - positioned relative to top fan item */}
          {hasOverflow && (() => {
            const topItemPos = calculateFanPosition(fanItems.length - 1, fanItems.length);
            return (
              <button
                onClick={handleShowAll}
                className="absolute animate-fan-enter bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded-lg px-2 py-1 text-[10px] text-neutral-300 hover:text-white shadow-lg transition-colors whitespace-nowrap"
                style={
                  {
                    "--fan-x": `${topItemPos.x}px`,
                    "--fan-y": `${topItemPos.y - 60}px`,
                    animationDelay: `${fanItems.length * 30}ms`,
                  } as React.CSSProperties
                }
              >
                +{history.length - 10} more
              </button>
            );
          })()}

        </div>
      )}

      {/* Sidebar for all items */}
      {showSidebar && (
        <HistorySidebar
          history={history}
          onClear={handleClear}
          onClose={handleCloseSidebar}
          onDragStart={handleDragStart}
          onDownload={handleDownload}
          onOpenCropper={handleOpenCropper}
          triggerRect={triggerRef.current?.getBoundingClientRect() || null}
        />
      )}
    </div>
  );
}
