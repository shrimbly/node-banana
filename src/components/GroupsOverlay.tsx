"use client";

import { memo, useCallback, useState, useRef, useEffect } from "react";
import { useStore, ViewportPortal, type ReactFlowState, useReactFlow } from "@xyflow/react";
import { useShallow } from "zustand/shallow";
import { useWorkflowStore, GROUP_COLORS } from "@/store/workflowStore";
import { GroupColor } from "@/types";
import { isOverviewZoom } from "@/utils/canvasPerformance";

const COLOR_OPTIONS: { color: GroupColor; label: string }[] = [
  { color: "neutral", label: "Gray" },
  { color: "blue", label: "Blue" },
  { color: "green", label: "Green" },
  { color: "purple", label: "Purple" },
  { color: "orange", label: "Orange" },
  { color: "red", label: "Red" },
];

// Brighter preview colors for the color picker (more saturated/vivid)
const PICKER_PREVIEW_COLORS: Record<GroupColor, string> = {
  neutral: "#525252",
  blue: "#3b82f6",
  green: "#22c55e",
  purple: "#8b5cf6",
  orange: "#f97316",
  red: "#ef4444",
};

interface GroupBackgroundProps {
  groupId: string;
}

// Renders just the group background - displayed below nodes (z-index 1).
// Memoised, with the portals below, because the canvas re-renders on every
// drag frame and would take every group with it.
const GroupBackground = memo(function GroupBackground({ groupId }: GroupBackgroundProps) {
  const group = useWorkflowStore((state) => state.groups[groupId]);

  if (!group) return null;

  const bgColor = GROUP_COLORS[group.color];

  return (
    <div
      className="absolute rounded-xl"
      style={{
        left: group.position.x,
        top: group.position.y,
        width: group.size.width,
        height: group.size.height,
        backgroundColor: `${bgColor}60`,
        border: group.isNbpInput ? `3px dashed rgba(255,255,255,0.25)` : `1px solid ${bgColor}`,
        pointerEvents: "none",
      }}
    />
  );
});

interface GroupControlsProps {
  groupId: string;
  showInteractiveControls: boolean;
}

// Renders the group header and resize handles - displayed above nodes (z-index 5)
// The zoom reaches the header as a CSS variable on the overlay and the drag
// math reads it at event time, so a zoom step does not re-render every group.
const GroupControls = memo(function GroupControls({
  groupId,
  showInteractiveControls,
}: GroupControlsProps) {
  const { group, updateGroup, deleteGroup, moveGroupNodes, toggleGroupLock } =
    useWorkflowStore(
      useShallow((state) => ({
        group: state.groups[groupId],
        updateGroup: state.updateGroup,
        deleteGroup: state.deleteGroup,
        moveGroupNodes: state.moveGroupNodes,
        toggleGroupLock: state.toggleGroupLock,
      }))
    );

  const { getViewport } = useReactFlow();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group?.name || "");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number; posX: number; posY: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Reset color picker when menu closes
  useEffect(() => {
    if (!showMenu) {
      setShowColorPicker(false);
    }
  }, [showMenu]);

  useEffect(() => {
    if (group?.name && !isEditing) {
      setEditName(group.name);
    }
  }, [group?.name, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showColorPicker || showMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showColorPicker, showMenu]);

  const handleNameSubmit = useCallback(() => {
    if (editName.trim() && editName !== group?.name) {
      updateGroup(groupId, { name: editName.trim() });
    } else {
      setEditName(group?.name || "");
    }
    setIsEditing(false);
  }, [editName, group?.name, groupId, updateGroup]);

  useEffect(() => {
    if (showInteractiveControls) return;
    if (isEditing) handleNameSubmit();
    setShowMenu(false);
    setShowColorPicker(false);
  }, [showInteractiveControls, isEditing, handleNameSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleNameSubmit();
      } else if (e.key === "Escape") {
        setEditName(group?.name || "");
        setIsEditing(false);
      }
    },
    [handleNameSubmit, group?.name]
  );

  const handleColorChange = useCallback(
    (color: GroupColor) => {
      updateGroup(groupId, { color });
      setShowColorPicker(false);
    },
    [groupId, updateGroup]
  );

  const handleDelete = useCallback(() => {
    deleteGroup(groupId);
  }, [groupId, deleteGroup]);

  const handleToggleLock = useCallback(() => {
    toggleGroupLock(groupId);
  }, [groupId, toggleGroupLock]);

  // Header drag handlers
  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (
        (e.target as HTMLElement).closest("button") ||
        (e.target as HTMLElement).closest("input")
      ) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    },
    []
  );

  // Resize handlers
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, handle: string) => {
      e.stopPropagation();
      e.preventDefault();
      setIsResizing(true);
      setResizeHandle(handle);
      resizeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: group.size.width,
        height: group.size.height,
        posX: group.position.x,
        posY: group.position.y,
      };
    },
    [group?.size, group?.position]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;

      const { zoom } = getViewport();
      const deltaX = (e.clientX - dragStartRef.current.x) / zoom;
      const deltaY = (e.clientY - dragStartRef.current.y) / zoom;

      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        // Move the group position
        updateGroup(groupId, {
          position: {
            x: group.position.x + deltaX,
            y: group.position.y + deltaY,
          },
        });
        // Move all nodes in the group
        moveGroupNodes(groupId, { x: deltaX, y: deltaY });
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, groupId, group?.position, moveGroupNodes, updateGroup, getViewport]);

  useEffect(() => {
    if (!isResizing || !resizeHandle) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;

      const { zoom } = getViewport();
      const deltaX = (e.clientX - resizeStartRef.current.x) / zoom;
      const deltaY = (e.clientY - resizeStartRef.current.y) / zoom;

      let newWidth = resizeStartRef.current.width;
      let newHeight = resizeStartRef.current.height;
      let newPosX = resizeStartRef.current.posX;
      let newPosY = resizeStartRef.current.posY;

      // Handle based on which corner/edge is being dragged
      if (resizeHandle.includes("e")) {
        newWidth = Math.max(200, resizeStartRef.current.width + deltaX);
      }
      if (resizeHandle.includes("w")) {
        const widthDelta = Math.min(deltaX, resizeStartRef.current.width - 200);
        newWidth = resizeStartRef.current.width - widthDelta;
        newPosX = resizeStartRef.current.posX + widthDelta;
      }
      if (resizeHandle.includes("s")) {
        newHeight = Math.max(100, resizeStartRef.current.height + deltaY);
      }
      if (resizeHandle.includes("n")) {
        const heightDelta = Math.min(deltaY, resizeStartRef.current.height - 100);
        newHeight = resizeStartRef.current.height - heightDelta;
        newPosY = resizeStartRef.current.posY + heightDelta;
      }

      updateGroup(groupId, {
        size: { width: newWidth, height: newHeight },
        position: { x: newPosX, y: newPosY },
      });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setResizeHandle(null);
      resizeStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizeHandle, groupId, updateGroup, getViewport]);

  if (!group) return null;

  const bgColor = GROUP_COLORS[group.color];

  return (
    <div
      className="absolute"
      style={{
        left: group.position.x,
        top: group.position.y,
        width: group.size.width,
        height: group.size.height,
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      {/* Group title label + three-dot menu - top-left, viewport-scaled */}
      {/* Outer wrapper: zero-height anchor at the top edge of the group */}
      <div
        className="absolute left-0"
        style={{ top: 0, height: 0, overflow: "visible" }}
      >
        {/* Inner scaled element: bottom-anchored so it grows upward, scale keeps bottom-left fixed */}
        <div
          ref={menuRef}
          className={`absolute left-0 select-none ${
            showInteractiveControls
              ? "pointer-events-auto cursor-grab active:cursor-grabbing"
              : "pointer-events-none"
          }`}
          style={{
            bottom: 0,
            transform: "scale(calc(1 / var(--group-zoom, 1)))",
            transformOrigin: "bottom left",
            whiteSpace: "nowrap",
          }}
          onMouseDown={showInteractiveControls ? handleHeaderMouseDown : undefined}
        >
          <div
            className="flex items-center gap-0.5 mb-1"
          >
            {/* Title pill */}
            <div
              className="flex items-center rounded-md px-2 py-0.5"
              style={{ backgroundColor: bgColor }}
            >
              {group.locked && (
                <svg className="w-3 h-3 text-white/70 mr-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              )}
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleNameSubmit}
                  onKeyDown={handleKeyDown}
                  className="bg-transparent border-none outline-none text-xs font-medium text-white px-0 py-0"
                  style={{ minWidth: 60, maxWidth: 200, width: `${Math.max(60, editName.length * 7)}px` }}
                />
              ) : (
                <span
                  className="text-xs font-medium text-white truncate"
                  style={{ maxWidth: 200 }}
                  onDoubleClick={showInteractiveControls ? (e) => { e.stopPropagation(); setIsEditing(true); } : undefined}
                >
                  {group.name}
                </span>
              )}
            </div>

            {/* Three-dot menu toggle — omitted in overview mode */}
            {showInteractiveControls && <div className="relative group-interactive-controls">
              <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
                className="w-6 h-6 rounded-md flex flex-col items-center justify-center gap-[2px] hover:bg-white/20 transition-colors"
                title="Group options"
              >
                <div className="w-[3px] h-[3px] rounded-full bg-white/70" />
                <div className="w-[3px] h-[3px] rounded-full bg-white/70" />
                <div className="w-[3px] h-[3px] rounded-full bg-white/70" />
              </button>

              {/* Vertical context menu - appears above the three-dot button */}
              {showMenu && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-neutral-800/90 backdrop-blur rounded-lg py-1 min-w-[130px] shadow-lg shadow-black/30" ref={colorPickerRef}>
                  {/* Color fan - anchored to top-left corner of menu */}
                  {showColorPicker && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setShowColorPicker(false)}
                      />
                      <div className="absolute top-0 left-0 z-50 pointer-events-auto">
                        {COLOR_OPTIONS.map(({ color, label }, index) => {
                          const totalItems = COLOR_OPTIONS.length;
                          const arcSpread = 180;
                          const startAngle = -130 - arcSpread / 2;
                          const angleStep = arcSpread / (totalItems - 1);
                          const angle = startAngle + index * angleStep;
                          const radius = 55;
                          const rad = (angle * Math.PI) / 180;
                          const x = Math.cos(rad) * radius;
                          const y = Math.sin(rad) * radius;
                          const finalX = x;
                          const finalY = y;

                          return (
                            <button
                              key={color}
                              onClick={() => handleColorChange(color)}
                              className={`absolute w-6 h-6 rounded-full border-2 transition-[transform,border-color] duration-150 hover:scale-125 ${
                                group.color === color
                                  ? "border-white"
                                  : "border-transparent hover:border-white/50"
                              }`}
                              style={{
                                backgroundColor: PICKER_PREVIEW_COLORS[color],
                                left: finalX - 12,
                                top: finalY - 12,
                                animation: `colorFanIn-${index} 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards`,
                                animationDelay: `${index * 0.025}s`,
                                opacity: 0,
                              }}
                              title={label}
                            >
                              <style>{`
                                @keyframes colorFanIn-${index} {
                                  0% {
                                    opacity: 0;
                                    left: -12px;
                                    top: -12px;
                                    transform: scale(0.3);
                                  }
                                  100% {
                                    opacity: 1;
                                    left: ${finalX - 12}px;
                                    top: ${finalY - 12}px;
                                    transform: scale(1);
                                  }
                                }
                              `}</style>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* Background color row */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowColorPicker(!showColorPicker); }}
                    className="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-white/10 text-xs text-white/80 transition-colors"
                  >
                    <div
                      className="w-3 h-3 rounded-full border border-white/30"
                      style={{ backgroundColor: bgColor }}
                    />
                    <span>Background</span>
                  </button>

                  {/* Lock/Unlock row */}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleLock(); setShowMenu(false); }}
                    className="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-white/10 text-xs text-white/80 transition-colors"
                  >
                    {group.locked ? (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                      </svg>
                    )}
                    <span>{group.locked ? "Unlock" : "Lock"}</span>
                  </button>

                  {/* NBP Input toggle row */}
                  <button
                    onClick={(e) => { e.stopPropagation(); updateGroup(groupId, { isNbpInput: !group.isNbpInput }); setShowMenu(false); }}
                    className="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-white/10 text-xs text-white/80 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                    </svg>
                    <span>NBP Input</span>
                    {group.isNbpInput && (
                      <svg className="w-3 h-3 ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>

                  {/* Delete row */}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                    className="flex items-center gap-2 px-3 py-1.5 w-full hover:bg-white/10 text-xs text-white/80 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>}
          </div>
        </div>
      </div>

      {showInteractiveControls && <div className="group-resize-controls">
      {/* Resize handles - interactive */}
      <div
        className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "nw")}
      />
      <div
        className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "ne")}
      />
      <div
        className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "sw")}
      />
      <div
        className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "se")}
      />
      <div
        className="absolute top-0 left-3 right-3 h-2 cursor-n-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "n")}
      />
      <div
        className="absolute bottom-0 left-3 right-3 h-2 cursor-s-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "s")}
      />
      <div
        className="absolute left-0 top-3 bottom-3 w-2 cursor-w-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "w")}
      />
      <div
        className="absolute right-0 top-3 bottom-3 w-2 cursor-e-resize pointer-events-auto"
        onMouseDown={(e) => handleResizeMouseDown(e, "e")}
      />
      </div>}
    </div>
  );
});

export function selectViewportZoom(state: Pick<ReactFlowState, "transform">): number {
  return state.transform[2];
}

// Renders group backgrounds inside ReactFlow's viewport using ViewportPortal
// This participates in React Flow's stacking context so z-index works properly
export const GroupBackgroundsPortal = memo(function GroupBackgroundsPortal() {
  const groupIds = useWorkflowStore(useShallow((state) => Object.keys(state.groups)));

  if (groupIds.length === 0) return null;

  return (
    <ViewportPortal>
      <div style={{ position: "absolute", top: 0, left: 0, zIndex: -1, pointerEvents: "none" }}>
        {groupIds.map((groupId) => (
          <GroupBackground key={groupId} groupId={groupId} />
        ))}
      </div>
    </ViewportPortal>
  );
});

// Renders group controls (headers, resize handles) using ViewportPortal above nodes
export function GroupControlsOverlay() {
  const groupIds = useWorkflowStore(useShallow((state) => Object.keys(state.groups)));
  const zoom = useStore(selectViewportZoom);
  const showInteractiveControls = !isOverviewZoom(zoom);

  if (groupIds.length === 0) return null;

  return (
    <ViewportPortal>
      <div
        className="group-controls-overlay"
        style={{ position: "absolute", top: 0, left: 0, zIndex: 1000, pointerEvents: "none", "--group-zoom": zoom } as React.CSSProperties}
      >
        {groupIds.map((groupId) => (
          <GroupControls
            key={groupId}
            groupId={groupId}
            showInteractiveControls={showInteractiveControls}
          />
        ))}
      </div>
    </ViewportPortal>
  );
}

// Legacy export for backwards compatibility - combines both overlays
// Note: For proper z-index behavior, use GroupBackgroundsPortal inside ReactFlow
// and GroupControlsOverlay outside ReactFlow
export function GroupsOverlay() {
  return <GroupControlsOverlay />;
}
