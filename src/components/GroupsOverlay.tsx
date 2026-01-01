"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import { useReactFlow, ViewportPortal } from "@xyflow/react";
import { useWorkflowStore, GROUP_COLORS } from "@/store/workflowStore";
import { GroupColor } from "@/types";

const HEADER_HEIGHT = 32;

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

// Renders just the group background - displayed below nodes (z-index 1)
function GroupBackground({ groupId }: GroupBackgroundProps) {
  const { groups } = useWorkflowStore();
  const group = groups[groupId];

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
        border: `1px solid ${bgColor}`,
        pointerEvents: "none",
      }}
    />
  );
}

interface GroupControlsProps {
  groupId: string;
  zoom: number;
}

// Renders the group header and resize handles - displayed above nodes (z-index 5)
function GroupControls({ groupId, zoom }: GroupControlsProps) {
  const { groups, updateGroup, deleteGroup, moveGroupNodes, toggleGroupLock } = useWorkflowStore();
  const group = groups[groupId];

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group?.name || "");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number; posX: number; posY: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

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
    };

    if (showColorPicker) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showColorPicker]);

  const handleNameSubmit = useCallback(() => {
    if (editName.trim() && editName !== group?.name) {
      updateGroup(groupId, { name: editName.trim() });
    } else {
      setEditName(group?.name || "");
    }
    setIsEditing(false);
  }, [editName, group?.name, groupId, updateGroup]);

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
  }, [isDragging, groupId, group?.position, moveGroupNodes, updateGroup, zoom]);

  useEffect(() => {
    if (!isResizing || !resizeHandle) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;

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
  }, [isResizing, resizeHandle, groupId, updateGroup, zoom]);

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
      }}
    >
      {/* Header - interactive */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center gap-2 px-3 cursor-grab active:cursor-grabbing select-none rounded-t-xl pointer-events-auto"
        style={{ backgroundColor: bgColor, height: HEADER_HEIGHT }}
        onMouseDown={handleHeaderMouseDown}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameSubmit}
            onKeyDown={handleKeyDown}
            className="bg-transparent border-none outline-none text-sm font-medium text-white px-0 py-0"
            style={{ minWidth: 60, maxWidth: 200, width: `${Math.max(60, editName.length * 8)}px` }}
          />
        ) : (
          <span
            className="text-sm font-medium text-white truncate cursor-text"
            style={{ maxWidth: 200 }}
            onClick={() => setIsEditing(true)}
          >
            {group.name}
          </span>
        )}

        {/* Spacer for drag area */}
        <div className="flex-1" />

        {/* Color Picker */}
        <div className="relative flex items-center" ref={colorPickerRef}>
          <button
            onClick={() => setShowColorPicker(!showColorPicker)}
            className="w-5 h-5 rounded border border-white/30 hover:border-white/60 transition-colors"
            style={{ backgroundColor: bgColor }}
            title="Change color"
          />
          {showColorPicker && (
            <>
              {/* Invisible backdrop to catch clicks outside */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowColorPicker(false)}
              />
              <div className="absolute bottom-full left-1/2 mb-2 z-50 pointer-events-auto" style={{ transform: "translateX(-50%)" }}>
                {COLOR_OPTIONS.map(({ color, label }, index) => {
                  // Fan out in an arc above the button
                  const totalItems = COLOR_OPTIONS.length;
                  const arcSpread = 180; // degrees of arc spread (wider)
                  const startAngle = -90 - arcSpread / 2; // start from top-left
                  const angleStep = arcSpread / (totalItems - 1);
                  const angle = startAngle + index * angleStep;
                  const radius = 55; // distance from center (larger)
                  const rad = (angle * Math.PI) / 180;
                  const x = Math.cos(rad) * radius;
                  const y = Math.sin(rad) * radius;
                  const finalX = x - 12;
                  const finalY = y - 12;

                  return (
                    <button
                      key={color}
                      onClick={() => handleColorChange(color)}
                      className={`absolute w-6 h-6 rounded-full border-2 transition-[transform,border-color] duration-150 hover:scale-110 ${
                        group.color === color
                          ? "border-white"
                          : "border-transparent hover:border-white/50"
                      }`}
                      style={{
                        backgroundColor: PICKER_PREVIEW_COLORS[color],
                        transform: `translate(${finalX}px, ${finalY}px)`,
                        animation: `colorFanIn-${index} 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards`,
                        animationDelay: `${index * 0.025}s`,
                        opacity: 0,
                        // Use CSS custom properties to pass the final position to the animation
                        ["--final-x" as string]: `${finalX}px`,
                        ["--final-y" as string]: `${finalY}px`,
                      }}
                      title={label}
                    >
                      <style>{`
                        @keyframes colorFanIn-${index} {
                          0% {
                            opacity: 0;
                            transform: translate(-12px, 0px) scale(0.3);
                          }
                          100% {
                            opacity: 1;
                            transform: translate(${finalX}px, ${finalY}px) scale(1);
                          }
                        }
                      `}</style>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Lock/Unlock Button */}
        <button
          onClick={handleToggleLock}
          className="p-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors"
          title={group.locked ? "Unlock group" : "Lock group"}
        >
          {group.locked ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
            </svg>
          )}
        </button>

        {/* Delete Button */}
        <button
          onClick={handleDelete}
          className="p-0.5 rounded hover:bg-white/20 text-white/70 hover:text-white transition-colors"
          title="Delete group"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

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
    </div>
  );
}

// Renders group backgrounds inside ReactFlow's viewport using ViewportPortal
// This participates in React Flow's stacking context so z-index works properly
export function GroupBackgroundsPortal() {
  const { groups } = useWorkflowStore();
  const groupIds = Object.keys(groups);

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
}

// Renders group controls (headers, resize handles) using ViewportPortal above nodes
export function GroupControlsOverlay() {
  const { groups } = useWorkflowStore();
  const viewport = useReactFlow().getViewport();

  const groupIds = Object.keys(groups);

  if (groupIds.length === 0) return null;

  return (
    <ViewportPortal>
      <div style={{ position: "absolute", top: 0, left: 0, zIndex: 1000, pointerEvents: "none" }}>
        {groupIds.map((groupId) => (
          <GroupControls key={groupId} groupId={groupId} zoom={viewport.zoom} />
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
