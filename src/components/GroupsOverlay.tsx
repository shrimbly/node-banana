"use client";

import { Ellipsis, Lock, LogOut, Pencil, Play, Repeat, Trash2 } from "lucide-react";
import { memo, useCallback, useState, useRef, useEffect } from "react";
import { useStore, type ReactFlowState, useReactFlow } from "@xyflow/react";
import { ViewportPortal } from "@/components/flowPortals";
import { useShallow } from "zustand/shallow";
import { useWorkflowStore } from "@/store/workflowStore";
import { GROUP_COLOR_ORDER } from "@/store/utils/nodeDefaults";
import { GroupColor } from "@/types";
import { isOverviewZoom } from "@/utils/canvasPerformance";
import { groupBaseColor, groupColorLabel, groupFill, groupLabelColor } from "@/utils/groupColors";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider, MenuItem, MenuList, MenuSectionLabel, MenuShortcut, MenuStepper, MenuSurface } from "@/components/ui/Menu";
import { MAX_RUN_COUNT } from "@/store/utils/runBatch";

/** Inset of the label from the group's left edge, so it starts inside the corner radius. */
const LABEL_INSET = 10;

interface GroupBackgroundProps {
  groupId: string;
}

// Renders just the group background - displayed below nodes (z-index 1).
// A faint wash of the group's hue and nothing else: the hue is painted once,
// here, and once more as the label's text colour. Memoised, with the portals
// below, because the canvas re-renders on every drag frame and would take
// every group with it.
const GroupBackground = memo(function GroupBackground({ groupId }: GroupBackgroundProps) {
  const group = useWorkflowStore((state) => state.groups[groupId]);

  if (!group) return null;

  return (
    <div
      className="absolute rounded-xl"
      style={{
        left: group.position.x,
        top: group.position.y,
        width: group.size.width,
        height: group.size.height,
        backgroundColor: groupFill(group.color),
        pointerEvents: "none",
      }}
    />
  );
});

/** A passive switch drawn inside a menu row; the row itself is the control. */
function RowSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ml-auto inline-flex h-4 w-[26px] shrink-0 items-center rounded-full p-0.5 transition-colors",
        on ? "justify-end bg-neutral-200" : "justify-start bg-white/12"
      )}
    >
      <span className={cn("h-3 w-3 rounded-full", on ? "bg-neutral-900" : "bg-neutral-400")} />
    </span>
  );
}

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
  const { group, updateGroup, deleteGroup, moveGroupNodes, toggleGroupLock, runCount, setRunCount, runBatch, isRunning } =
    useWorkflowStore(
      useShallow((state) => ({
        group: state.groups[groupId],
        updateGroup: state.updateGroup,
        deleteGroup: state.deleteGroup,
        moveGroupNodes: state.moveGroupNodes,
        toggleGroupLock: state.toggleGroupLock,
        runCount: state.runCount,
        setRunCount: state.setRunCount,
        runBatch: state.runBatch,
        isRunning: state.isRunning,
      }))
    );

  const { getViewport } = useReactFlow();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group?.name || "");
  const [showMenu, setShowMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number; posX: number; posY: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

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

  // The menu stays open: the swatches are for trying colours against the canvas.
  const handleColorChange = useCallback(
    (color: GroupColor) => {
      updateGroup(groupId, { color });
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
        (e.target as HTMLElement).closest("input") ||
        (e.target as HTMLElement).closest('[role="menu"]')
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

  const labelColor = groupLabelColor(group.color);
  const locked = Boolean(group.locked);
  const nbpInput = Boolean(group.isNbpInput);

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
      {/* Group title + menu - top-left, viewport-scaled */}
      {/* Outer wrapper: zero-height anchor at the top edge of the group */}
      <div
        className="absolute"
        style={{ left: LABEL_INSET, top: 0, height: 0, overflow: "visible" }}
      >
        {/* Inner scaled element: bottom-anchored so it grows upward, scale keeps bottom-left fixed */}
        <div
          ref={menuRef}
          className={cn(
            "group/header absolute left-0 select-none",
            showInteractiveControls ? "pointer-events-auto cursor-grab active:cursor-grabbing" : "pointer-events-none"
          )}
          style={{
            bottom: 0,
            transform: "scale(calc(1 / var(--group-zoom, 1)))",
            transformOrigin: "bottom left",
            whiteSpace: "nowrap",
          }}
          onMouseDown={showInteractiveControls ? handleHeaderMouseDown : undefined}
        >
          <div className="mb-1 flex items-center gap-0.5">
            {/* Title: the hue as text, with the lock and NBP marks after the name */}
            <div className="flex h-5 items-center gap-1.5 pr-0.5" style={{ color: labelColor }}>
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleNameSubmit}
                  onKeyDown={handleKeyDown}
                  className="border-none bg-transparent px-0 py-0 text-xs font-medium outline-none"
                  style={{ color: labelColor, minWidth: 60, maxWidth: 200, width: `${Math.max(60, editName.length * 7)}px` }}
                />
              ) : (
                <span
                  className="truncate text-xs font-medium"
                  style={{ maxWidth: 200 }}
                  onDoubleClick={showInteractiveControls ? (e) => { e.stopPropagation(); setIsEditing(true); } : undefined}
                >
                  {group.name}
                </span>
              )}
              {locked && <Lock size={12} strokeWidth={2} className="shrink-0 text-neutral-400" aria-label="Locked" />}
              {nbpInput && <LogOut size={12} strokeWidth={2} className="shrink-0 text-neutral-400" aria-label="NBP input" />}
            </div>

            {/* Menu toggle: shown on hover of the header, or while the menu is open. Omitted in overview mode */}
            {showInteractiveControls && <div className="group-interactive-controls relative">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-md transition-[opacity,background-color,color]",
                  "focus-visible:opacity-100 focus-visible:outline-none",
                  showMenu
                    ? "bg-white/12 text-white opacity-100"
                    : "text-neutral-300 opacity-0 hover:bg-white/6 group-hover/header:opacity-100"
                )}
                title="Group options"
                aria-label="Group options"
                aria-haspopup="menu"
                aria-expanded={showMenu}
              >
                <Ellipsis size={14} strokeWidth={2} />
              </button>

              {/* The menu sits above the button, left-aligned to it */}
              {showMenu && (
                <MenuSurface
                  role="menu"
                  aria-label="Group options"
                  floating={false}
                  className="absolute bottom-full left-0 z-50 mb-1.5 w-[232px] cursor-default"
                >
                  {/* Colour: six swatches in a row, the current one ringed */}
                  <div className="flex items-center gap-2 px-2.5 pt-2 pb-1.5">
                    <MenuSectionLabel className="flex-1">Colour</MenuSectionLabel>
                    {GROUP_COLOR_ORDER.map((color) => {
                      const selected = group.color === color;
                      const label = groupColorLabel(color);
                      return (
                        <button
                          key={color}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={(e) => { e.stopPropagation(); handleColorChange(color); }}
                          className={cn(
                            "flex h-5 w-5 items-center justify-center rounded-full transition-[box-shadow,transform] hover:scale-110",
                            selected ? "shadow-[0_0_0_1.5px_rgb(255_255_255/0.85)]" : "hover:shadow-[0_0_0_1.5px_rgb(255_255_255/0.35)]"
                          )}
                          title={label}
                          aria-label={label}
                        >
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: groupBaseColor(color) }} />
                        </button>
                      );
                    })}
                  </div>
                  <MenuDivider />
                  {/* Run the group's nodes, as many times as the Run menu's count (the same count) */}
                  <MenuList>
                    <MenuItem
                      role="menuitem"
                      disabled={locked || isRunning}
                      title={locked ? "Unlock the group to run it" : isRunning ? "A run is in progress" : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nodeIds = useWorkflowStore.getState().nodes.filter((n) => n.groupId === groupId).map((n) => n.id);
                        setShowMenu(false);
                        if (nodeIds.length > 0) runBatch({ kind: "nodes", nodeIds });
                      }}
                    >
                      <Play size={14} strokeWidth={0} fill="currentColor" />
                      <span>{runCount > 1 ? `Run group ${runCount}×` : "Run group"}</span>
                    </MenuItem>
                    <div className="flex min-h-7 items-center gap-2 px-2.5 py-1 text-xs text-neutral-300" onClick={(e) => e.stopPropagation()}>
                      <Repeat size={14} strokeWidth={2} />
                      <span>Runs</span>
                      <MenuStepper label="Runs" value={runCount} min={1} max={MAX_RUN_COUNT} onChange={setRunCount} />
                    </div>
                  </MenuList>
                  <MenuDivider />
                  <MenuList>
                    <MenuItem
                      role="menuitem"
                      onClick={(e) => { e.stopPropagation(); setShowMenu(false); setIsEditing(true); }}
                    >
                      <Pencil size={14} strokeWidth={2} />
                      <span>Rename</span>
                      <MenuShortcut>double-click</MenuShortcut>
                    </MenuItem>
                    <MenuItem
                      role="menuitemcheckbox"
                      aria-checked={locked}
                      onClick={(e) => { e.stopPropagation(); handleToggleLock(); setShowMenu(false); }}
                    >
                      <Lock size={14} strokeWidth={2} />
                      <span>Lock</span>
                      <RowSwitch on={locked} />
                    </MenuItem>
                    <MenuItem
                      role="menuitemcheckbox"
                      aria-checked={nbpInput}
                      onClick={(e) => { e.stopPropagation(); updateGroup(groupId, { isNbpInput: !nbpInput }); setShowMenu(false); }}
                    >
                      <LogOut size={14} strokeWidth={2} />
                      <span>NBP input</span>
                      <RowSwitch on={nbpInput} />
                    </MenuItem>
                  </MenuList>
                  <MenuDivider />
                  <MenuList>
                    <MenuItem
                      role="menuitem"
                      onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                      className="text-red-300 hover:text-red-200"
                    >
                      <Trash2 size={14} strokeWidth={2} />
                      <span>Delete group</span>
                    </MenuItem>
                  </MenuList>
                </MenuSurface>
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
