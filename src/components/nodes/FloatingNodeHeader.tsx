"use client";

import { ReactNode, useState, useEffect, useRef, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { useReactFlow } from "@xyflow/react";
import { NodeType, ProviderType } from "@/types";
import { useWorkflowStore } from "@/store/workflowStore";
import { getNodeSize } from "@/utils/nodeDimensions";
import { ProviderBadge } from "./ProviderBadge";
import { menuSurfaceClass } from "@/components/ui/Menu";
import { KbdGroup } from "@/components/ui/Kbd";
import { cn } from "./ui/cn";
import { useHoldLive, useIsPaintedNode } from "./paintMode";
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  LifeBuoy,
  Lock,
  Maximize2,
  MessageSquare,
  Pencil,
  Play,
  Replace,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

export interface CommentNavigationProps {
  currentIndex: number;
  totalCount: number;
  onPrevious: () => void;
  onNext: () => void;
}

const RUNNABLE_TYPES = new Set([
  'nanoBanana',
  'generateVideo',
  'generate3d',
  'generateAudio',
  'llmGenerate',
  'removeBackground',
  'comfyApp',
  'videoStitch',
]);
const EXPANDABLE_TYPES = new Set(['prompt', 'promptConstructor', 'splitGrid', 'annotation', 'videoStitch']);

interface FloatingNodeHeaderProps {
  id: string;
  type: NodeType;
  isInLockedGroup?: boolean;
  isExecuting?: boolean;
  focusedCommentNodeId?: string | null;
  position: { x: number; y: number };
  width: number;
  selected: boolean;
  onExpandNode?: (nodeId: string, nodeType: string) => void;
  onRunNode?: (nodeId: string) => void;
  /** Opens the model browser. Present, the title becomes the model picker. */
  onBrowse?: (nodeId: string) => void;
  /** A ComfyUI app node: choose a different workflow for it. */
  onReplaceWorkflow?: (nodeId: string) => void;
  /** The node can take a fallback model; `fallbackName` is the one set, if any. */
  canFallback?: boolean;
  fallbackName?: string;
  onOpenFallback?: (nodeId: string, nodeType: string) => void;
  /** Input nodes: whether an empty input skips the branch instead of blocking. */
  canToggleOptional?: boolean;
  isOptional?: boolean;
  onToggleOptional?: (nodeId: string, isOptional: boolean) => void;
  /** Short reason the node cannot run as wired ("needs a prompt"). Never fades. */
  hint?: string;
  provider?: ProviderType;
  title: string;
  /**
   * Shown instead of the title text — for a node whose kind is better said with
   * a logo. `title` still supplies the accessible name and the tooltip.
   */
  titleLogo?: ReactNode;
  customTitle?: string;
  comment?: string;
  onCustomTitleChange?: (nodeId: string, title: string) => void;
  onCommentChange?: (nodeId: string, comment: string) => void;
  commentNavigation?: CommentNavigationProps;
}

export const FloatingNodeHeader = memo(function FloatingNodeHeader({
  id,
  type,
  isInLockedGroup = false,
  isExecuting = false,
  focusedCommentNodeId,
  position,
  width,
  selected,
  onExpandNode,
  onRunNode,
  onBrowse,
  onReplaceWorkflow,
  canFallback = false,
  fallbackName,
  onOpenFallback,
  canToggleOptional = false,
  isOptional = false,
  onToggleOptional,
  hint,
  provider,
  title,
  titleLogo,
  customTitle,
  comment,
  onCustomTitleChange,
  onCommentChange,
  commentNavigation,
}: FloatingNodeHeaderProps) {
  const canRun = RUNNABLE_TYPES.has(type);
  const canExpand = EXPANDABLE_TYPES.has(type);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  // A painted copy never shows hover-only controls: its picture outlives the hover it was painted under.
  const painted = useIsPaintedNode();
  const isBodyHovered = useWorkflowStore((state) => !painted && state.hoveredNodeId === id);
  const isHovered = isHeaderHovered || isBodyHovered;
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState(customTitle || (titleLogo ? title : ""));
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [editCommentValue, setEditCommentValue] = useState(comment || "");
  const [showCommentTooltip, setShowCommentTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const commentPopoverRef = useRef<HTMLDivElement>(null);
  const commentButtonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Check if comment is focused for navigation
  const isCommentFocused = focusedCommentNodeId === id;
  // On the GPU canvas the node stays live while its header shows something of its own: the header
  // sits outside the node (its own id, not the node's context), and unmounting would drop the edit.
  useHoldLive(isEditingTitle || isEditingComment || isMenuOpen || isCommentFocused, id);

  /**
   * The name the user edits.
   *
   * Where a logo says what kind of node this is, the text beside it is the
   * node's own name — the workflow it runs — so it is what the editor starts
   * from, and clearing it falls back to that name rather than to nothing.
   */
  const defaultTitle = titleLogo ? title : "";
  const seedTitle = customTitle || defaultTitle;

  // Sync state with props
  useEffect(() => {
    if (!isEditingTitle) {
      setEditTitleValue(seedTitle);
    }
  }, [seedTitle, isEditingTitle]);

  useEffect(() => {
    if (!isEditingComment) {
      setEditCommentValue(comment || "");
    }
  }, [comment, isEditingComment]);

  // Focus input on edit mode
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Continuously update tooltip position while showing
  useEffect(() => {
    if (!(showCommentTooltip || isCommentFocused) || !commentButtonRef.current) {
      setTooltipPosition(null);
      return;
    }

    const updatePosition = () => {
      if (commentButtonRef.current) {
        const rect = commentButtonRef.current.getBoundingClientRect();
        setTooltipPosition({
          top: rect.top - 8,
          left: rect.left + rect.width / 2,
        });
      }
    };

    updatePosition();

    let animationId: number;
    const trackPosition = () => {
      updatePosition();
      animationId = requestAnimationFrame(trackPosition);
    };
    animationId = requestAnimationFrame(trackPosition);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [showCommentTooltip, isCommentFocused]);

  // Title handlers
  const handleTitleSubmit = useCallback(() => {
    const trimmed = editTitleValue.trim();
    // Typing the node's own name back is not a custom title — storing it would
    // freeze the name against a later change of workflow.
    const next = trimmed === defaultTitle ? "" : trimmed;
    if (next !== (customTitle || "")) {
      onCustomTitleChange?.(id, next);
    }
    setIsEditingTitle(false);
  }, [editTitleValue, defaultTitle, customTitle, onCustomTitleChange, id]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleTitleSubmit();
      } else if (e.key === "Escape") {
        setEditTitleValue(seedTitle);
        setIsEditingTitle(false);
      }
    },
    [handleTitleSubmit, seedTitle]
  );

  // Comment handlers
  const handleCommentSubmit = useCallback(() => {
    const trimmed = editCommentValue.trim();
    if (trimmed !== (comment || "")) {
      onCommentChange?.(id, trimmed);
    }
    setIsEditingComment(false);
  }, [editCommentValue, comment, onCommentChange, id]);

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setEditCommentValue(comment || "");
        setIsEditingComment(false);
      }
    },
    [comment]
  );

  // Click outside handler for comment popover
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (commentPopoverRef.current && !commentPopoverRef.current.contains(e.target as Node)) {
        handleCommentSubmit();
      }
    };

    if (isEditingComment) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEditingComment, handleCommentSubmit]);

  // Run and the kebab arrive on hover or selection and stay while the menu is up.
  const showControls = isHovered || selected || isMenuOpen;

  // The kebab menu closes on an outside press or Escape.
  useEffect(() => {
    if (!isMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isMenuOpen]);

  const runMenuAction = useCallback((action: () => void) => {
    setIsMenuOpen(false);
    action();
  }, []);

  // Drag-to-move: allow repositioning nodes by dragging the header
  const { setNodes, getNodes, getViewport } = useReactFlow();
  const isDraggingRef = useRef(false);

  const handleHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't drag from interactive elements
    if ((e.target as HTMLElement).closest('.nodrag, button, input, textarea, a')) return;
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;

    const allNodes = getNodes();
    const targetNode = allNodes.find(n => n.id === id);
    if (!targetNode) return;

    // Select this node if not already selected
    if (!targetNode.selected) {
      setNodes(nodes => nodes.map(n => ({
        ...n,
        selected: n.id === id,
      })));
    }

    // Capture starting positions of all nodes that will move
    const movingIds = targetNode.selected
      ? new Set(allNodes.filter(n => n.selected).map(n => n.id))
      : new Set([id]);
    const startPositions = new Map(
      allNodes.filter(n => movingIds.has(n.id)).map(n => [n.id, { x: n.position.x, y: n.position.y }])
    );

    isDraggingRef.current = false;

    const handlePointerMove = (e: PointerEvent) => {
      const screenDx = e.clientX - startX;
      const screenDy = e.clientY - startY;

      if (!isDraggingRef.current && (Math.abs(screenDx) > 5 || Math.abs(screenDy) > 5)) {
        isDraggingRef.current = true;
      }

      if (isDraggingRef.current) {
        const { zoom } = getViewport();
        const dx = screenDx / zoom;
        const dy = screenDy / zoom;
        setNodes(nodes => nodes.map(n => {
          const startPos = startPositions.get(n.id);
          if (!startPos) return n;
          return {
            ...n,
            position: { x: startPos.x + dx, y: startPos.y + dy },
          };
        }));
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      const wasDragging = isDraggingRef.current;

      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      isDraggingRef.current = false;

      // Check group membership for ALL moved nodes
      if (wasDragging) {
        const store = useWorkflowStore.getState();
        const { zoom } = getViewport();
        const dx = (e.clientX - startX) / zoom;
        const dy = (e.clientY - startY) / zoom;

        for (const [nodeId, startPos] of startPositions) {
          // Calculate final position deterministically from drag delta
          const finalX = startPos.x + dx;
          const finalY = startPos.y + dy;

          // Get node dimensions from store (always fresh)
          const storeNode = store.nodes.find(n => n.id === nodeId);
          if (!storeNode) continue;

          const { width: nodeWidth, height: nodeHeight } = getNodeSize(storeNode);

          // Calculate node center
          const nodeCenterX = finalX + nodeWidth / 2;
          const nodeCenterY = finalY + nodeHeight / 2;

          // Check if node center is inside any group
          let targetGroupId: string | undefined;

          for (const group of Object.values(store.groups)) {
            const inBoundsX = nodeCenterX >= group.position.x && nodeCenterX <= group.position.x + group.size.width;
            const inBoundsY = nodeCenterY >= group.position.y && nodeCenterY <= group.position.y + group.size.height;

            if (inBoundsX && inBoundsY) {
              targetGroupId = group.id;
              break;
            }
          }

          // Update groupId if it changed
          const currentGroupId = storeNode.groupId;
          if (targetGroupId !== currentGroupId) {
            store.setNodeGroupId(nodeId, targetGroupId);
          }
        }
      }
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [id, getNodes, getViewport, setNodes]);

  return (
    <div
      className="absolute pointer-events-none transition-opacity duration-200"
      data-node-header={id}
      style={{
        left: `${position.x}px`,
        top: `${position.y - 26}px`,
        width: `${width}px`,
        // Above nodes/group controls (1000), below noodle context menus (2100).
        zIndex: selected ? 2000 : 1500,
      }}
    >
      <div
        className="px-1 py-1 flex items-center justify-between w-full pointer-events-auto cursor-grab"
        onMouseEnter={() => setIsHeaderHovered(true)}
        onMouseLeave={() => setIsHeaderHovered(false)}
        onPointerDown={handleHeaderPointerDown}
      >
        {/* Title: the model picker on generate nodes, otherwise the name (double-click renames). */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-2">
          {provider && <ProviderBadge provider={provider} />}
          {isEditingTitle ? (
            <>
              {/* The logo stays put while its name is edited, so the header does
                  not jump and it stays clear which node is being renamed. */}
              {titleLogo}
              <input
                ref={titleInputRef}
                type="text"
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onBlur={handleTitleSubmit}
                onKeyDown={handleTitleKeyDown}
                placeholder={titleLogo ? "Name this node..." : "Custom title..."}
                className={`nodrag nopan w-full bg-transparent border-none outline-none text-xs font-semibold tracking-wide text-neutral-300 placeholder:text-neutral-500 ${
                  titleLogo ? "" : "uppercase"
                }`}
              />
            </>
          ) : onBrowse ? (
            <button
              type="button"
              onClick={() => onBrowse(id)}
              title="Browse models"
              data-testid="node-title-picker"
              className="nodrag nopan group/picker flex items-center gap-1.5 min-w-0 h-[22px] pl-1.5 -ml-1.5 pr-1.5 rounded-[6px] text-xs font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-200 hover:bg-white/8 transition-colors cursor-pointer"
            >
              <span className="truncate">{customTitle ? `${customTitle} - ${title}` : title}</span>
              <ChevronDown size={14} strokeWidth={2.25} className="shrink-0 text-neutral-400 group-hover/picker:text-neutral-200" />
            </button>
          ) : (
            <span
              className="nodrag flex items-center gap-1.5 min-w-0 text-xs font-semibold uppercase tracking-wide text-neutral-400 cursor-default truncate"
              onDoubleClick={() => setIsEditingTitle(true)}
              title="Double-click to rename"
            >
              {titleLogo}
              {/* With a logo standing in for the kind of node, the text beside
                  it is the node's name on its own, not a prefix to a type. */}
              {titleLogo ? (
                seedTitle && <span className="truncate normal-case">{seedTitle}</span>
              ) : customTitle ? (
                `${customTitle} - ${title}`
              ) : (
                title
              )}
            </span>
          )}
        </div>

        {/* Right cluster: what never fades, then Run and the kebab. */}
        <div className="shrink-0 flex items-center gap-0.5 pr-1">
          {hint && (
            <span
              data-testid="node-readiness-hint"
              title={`${hint}: this node will be skipped when the workflow runs`}
              className="mr-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] leading-4 text-amber-200/90 whitespace-nowrap"
            >
              {hint}
            </span>
          )}

          {isInLockedGroup && (
            <div className="shrink-0 flex items-center px-0.5" title="This node is in a locked group and will be skipped during execution">
              <Lock size={14} strokeWidth={2} className="text-yellow-500" />
            </div>
          )}

          {/* A comment shows as a glyph: hover reads it, click edits it. */}
          <div className="relative shrink-0 flex items-center" ref={commentPopoverRef}>
            {comment && (
              <button
                ref={commentButtonRef}
                type="button"
                onClick={() => setIsEditingComment(!isEditingComment)}
                onMouseEnter={() => !isCommentFocused && setShowCommentTooltip(true)}
                onMouseLeave={() => setShowCommentTooltip(false)}
                className="nodrag nopan w-5 h-5 rounded-[5px] flex items-center justify-center text-blue-400 hover:text-blue-200 hover:bg-white/8 transition-colors"
                title="Edit comment"
                aria-label="Edit comment"
                data-testid="node-comment-glyph"
              >
                <MessageSquare size={12} strokeWidth={0} fill="currentColor" />
              </button>
            )}

            {/* Comment Tooltip with Navigation */}
            {(showCommentTooltip || isCommentFocused) && comment && !isEditingComment && tooltipPosition && createPortal(
              <div
                ref={tooltipRef}
                className="fixed z-[9999] p-3 text-sm text-neutral-200 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl"
                style={{
                  top: tooltipPosition.top,
                  left: tooltipPosition.left,
                  transform: "translateY(-100%) translateX(-50%)",
                }}
              >
                {isCommentFocused && commentNavigation && (
                  <div className="flex items-center justify-center gap-3 mb-2 pb-2 border-b border-neutral-700">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        commentNavigation.onPrevious();
                      }}
                      className="nodrag nopan w-6 h-6 flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
                      title="Previous comment"
                    >
                      <ChevronLeft size={16} strokeWidth={2} />
                    </button>
                    <span className="text-xs text-neutral-400 min-w-[32px] text-center">
                      {commentNavigation.currentIndex}/{commentNavigation.totalCount}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        commentNavigation.onNext();
                      }}
                      className="nodrag nopan w-6 h-6 flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
                      title="Next comment"
                    >
                      <ChevronRight size={16} strokeWidth={2} />
                    </button>
                  </div>
                )}
                <div className="max-w-[240px] whitespace-pre-wrap break-words">
                  {comment}
                </div>
              </div>,
              document.body
            )}

            {/* Comment Edit Popover */}
            {isEditingComment && (
              <div className={cn(menuSurfaceClass, "absolute z-[60] right-0 top-full mt-1 w-64 p-2")}>
                <textarea
                  value={editCommentValue}
                  onChange={(e) => setEditCommentValue(e.target.value)}
                  onKeyDown={handleCommentKeyDown}
                  placeholder="Add a comment..."
                  autoFocus
                  aria-label="Comment"
                  className="nodrag nopan nowheel w-full h-20 p-2 text-xs text-neutral-100 bg-well border border-card-border rounded-well resize-none focus:outline-none focus:ring-1 focus:ring-neutral-600"
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    onClick={() => {
                      setEditCommentValue(comment || "");
                      setIsEditingComment(false);
                    }}
                    className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCommentSubmit}
                    className="px-2 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Expand, Run and the kebab fade in together and never change width. */}
          <div className={`shrink-0 flex items-center gap-0.5 transition-opacity duration-200 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
            {canExpand && onExpandNode && (
              <GhostButton label="Expand editor" onClick={() => onExpandNode(id, type)}>
                <Maximize2 size={12} strokeWidth={2} />
              </GhostButton>
            )}
            {/* Run carries a short permanent label so it reads as a button, and never resizes. */}
            {canRun && onRunNode && (
              <button
                type="button"
                onClick={() => onRunNode(id)}
                disabled={isExecuting}
                aria-label="Run node"
                title="Run node"
                className="nodrag nopan h-5 pl-1 pr-1.5 mr-0.5 rounded-[5px] flex items-center gap-1 bg-white/8 hover:bg-white/14 text-neutral-200 hover:text-white text-[10px] font-semibold leading-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white/8"
              >
                <Play size={11} strokeWidth={0} fill="currentColor" />
                Run
              </button>
            )}

            <div className="relative shrink-0" ref={menuRef}>
              <GhostButton
                label="More"
                onClick={() => setIsMenuOpen((open) => !open)}
                active={isMenuOpen}
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
                badge={Boolean(fallbackName)}
              >
                <EllipsisVertical size={12} strokeWidth={2} />
              </GhostButton>

              {isMenuOpen && (
                <div
                  role="menu"
                  aria-label="Node actions"
                  className={cn(menuSurfaceClass, "nodrag nopan nowheel absolute right-0 top-full mt-1 z-[60] min-w-[168px] py-1")}
                >
                  {onBrowse && (
                    <MenuRow icon={<Box size={11} strokeWidth={1.75} />} onClick={() => runMenuAction(() => onBrowse(id))}>
                      Browse models…
                    </MenuRow>
                  )}
                  {onReplaceWorkflow && (
                    <MenuRow icon={<Replace size={11} strokeWidth={1.75} />} onClick={() => runMenuAction(() => onReplaceWorkflow(id))}>
                      Replace workflow…
                    </MenuRow>
                  )}
                  {canRun && onRunNode && (
                    <MenuRow icon={<Play size={11} strokeWidth={0} fill="currentColor" />} keys={["⌥", "↵"]} disabled={isExecuting} onClick={() => runMenuAction(() => onRunNode(id))}>
                      Run node
                    </MenuRow>
                  )}
                  <MenuRow icon={<Pencil size={11} strokeWidth={1.75} />} meta={onBrowse ? undefined : "dbl-click"} onClick={() => runMenuAction(() => setIsEditingTitle(true))}>
                    Rename
                  </MenuRow>
                  {(canFallback || canToggleOptional || onCommentChange) && <div className="my-1 border-t border-chrome-border" />}
                  {canFallback && onOpenFallback && (
                    <MenuRow icon={<LifeBuoy size={11} strokeWidth={1.75} />} set={Boolean(fallbackName)} onClick={() => runMenuAction(() => onOpenFallback(id, type))}>
                      {fallbackName ? `Fallback: ${fallbackName}` : "Set fallback model…"}
                    </MenuRow>
                  )}
                  {canToggleOptional && onToggleOptional && (
                    <MenuRow
                      icon={isOptional ? <ToggleRight size={11} strokeWidth={1.75} /> : <ToggleLeft size={11} strokeWidth={1.75} />}
                      meta={isOptional ? "on" : "off"}
                      onClick={() => runMenuAction(() => onToggleOptional(id, !isOptional))}
                    >
                      Optional input
                    </MenuRow>
                  )}
                  {onCommentChange && (
                    <MenuRow icon={<MessageSquare size={11} strokeWidth={1.75} />} set={Boolean(comment)} onClick={() => runMenuAction(() => setIsEditingComment(true))}>
                      {comment ? "Edit comment…" : "Add comment…"}
                    </MenuRow>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/** 20px flat icon button with the chrome tooltip; the header's one button style. */
function GhostButton({
  label,
  active = false,
  badge = false,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; badge?: boolean }) {
  return (
    <span className="group/ghost relative shrink-0 flex">
      <button
        {...rest}
        type="button"
        aria-label={label}
        className={cn(
          "nodrag nopan w-5 h-5 rounded-[5px] flex items-center justify-center transition-colors",
          "text-neutral-400 hover:text-neutral-100 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
          active && "bg-white/10 text-neutral-100",
          className
        )}
      >
        {children}
      </button>
      {badge && (
        <span className="pointer-events-none absolute -top-px -right-px w-[5px] h-[5px] rounded-full bg-blue-400 ring-[1.5px] ring-canvas-bg" />
      )}
      {!active && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 z-10 whitespace-nowrap rounded-md squircle border border-white/10 bg-neutral-950 px-2 py-1 text-[10px] font-medium leading-3 text-neutral-200 opacity-0 shadow-[0_4px_12px_rgba(0,0,0,0.5)] transition-opacity delay-300 duration-[120ms] group-hover/ghost:opacity-100"
        >
          {label}
        </span>
      )}
    </span>
  );
}

/** A row of the kebab menu at node density: 22px, 10px type, meta in mono. */
function MenuRow({
  icon,
  meta,
  keys,
  set = false,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; meta?: string; keys?: string[]; set?: boolean }) {
  return (
    <button
      {...rest}
      type="button"
      role="menuitem"
      className={cn(
        "w-full h-[22px] px-2 flex items-center gap-1.5 text-node text-left whitespace-nowrap transition-colors",
        "text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:bg-neutral-700",
        "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        className
      )}
    >
      <span className="shrink-0 flex items-center justify-center w-[11px] text-current">{icon}</span>
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">{children}</span>
      {meta && <span className="font-mono text-[9px] text-ink-3">{meta}</span>}
      {keys && <KbdGroup keys={keys} size="xs" className="gap-0.5 [&_kbd]:text-neutral-400" />}
      {set && <span className="w-[5px] h-[5px] rounded-full bg-blue-400" />}
    </button>
  );
}
