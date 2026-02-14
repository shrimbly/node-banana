"use client";

import { ReactNode, useCallback, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, OnResize, useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";

export interface CommentNavigationProps {
  currentIndex: number;
  totalCount: number;
  onPrevious: () => void;
  onNext: () => void;
}

interface BaseNodeProps {
  id: string;
  title: string;
  customTitle?: string;
  comment?: string;
  onCustomTitleChange?: (title: string) => void;
  onCommentChange?: (comment: string) => void;
  onExpand?: () => void;
  onRun?: () => void;
  children: ReactNode;
  selected?: boolean;
  isExecuting?: boolean;
  hasError?: boolean;
  className?: string;
  contentClassName?: string;
  minWidth?: number;
  minHeight?: number;
  headerAction?: ReactNode;
  headerButtons?: ReactNode;
  titlePrefix?: ReactNode;
  commentNavigation?: CommentNavigationProps;
}

export function BaseNode({
  id,
  title,
  customTitle,
  comment,
  onCustomTitleChange,
  onCommentChange,
  onExpand,
  onRun,
  children,
  selected = false,
  isExecuting = false,
  hasError = false,
  className = "",
  contentClassName,
  minWidth = 180,
  minHeight = 100,
  headerAction,
  headerButtons,
  titlePrefix,
  commentNavigation,
}: BaseNodeProps) {
  const currentNodeIds = useWorkflowStore((state) => state.currentNodeIds);
  const groups = useWorkflowStore((state) => state.groups);
  const nodes = useWorkflowStore((state) => state.nodes);
  const focusedCommentNodeId = useWorkflowStore((state) => state.focusedCommentNodeId);
  const setFocusedCommentNodeId = useWorkflowStore((state) => state.setFocusedCommentNodeId);
  const isCurrentlyExecuting = currentNodeIds.includes(id);
  const { getNodes, setNodes } = useReactFlow();

  // Check if node is in a locked group
  const node = nodes.find((n) => n.id === id);
  const isInLockedGroup = node?.groupId && groups[node.groupId]?.locked;

  // Inline editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState(customTitle || "");
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [editCommentValue, setEditCommentValue] = useState(comment || "");
  const [showCommentTooltip, setShowCommentTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const commentPopoverRef = useRef<HTMLDivElement>(null);
  const commentButtonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Track if this node's comment is focused (for navigation tooltip)
  const isCommentFocused = focusedCommentNodeId === id;

  // Sync state with props
  useEffect(() => {
    if (!isEditingTitle) {
      setEditTitleValue(customTitle || "");
    }
  }, [customTitle, isEditingTitle]);

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

  // Continuously update tooltip position while showing (handles canvas pan/zoom animations)
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

    // Initial position
    updatePosition();

    // Use animation frame to track position during canvas animations
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
    if (trimmed !== (customTitle || "")) {
      onCustomTitleChange?.(trimmed);
    }
    setIsEditingTitle(false);
  }, [editTitleValue, customTitle, onCustomTitleChange]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleTitleSubmit();
      } else if (e.key === "Escape") {
        setEditTitleValue(customTitle || "");
        setIsEditingTitle(false);
      }
    },
    [handleTitleSubmit, customTitle]
  );

  // Comment handlers
  const handleCommentSubmit = useCallback(() => {
    const trimmed = editCommentValue.trim();
    if (trimmed !== (comment || "")) {
      onCommentChange?.(trimmed);
    }
    setIsEditingComment(false);
  }, [editCommentValue, comment, onCommentChange]);

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

  // Click outside handler for focused comment tooltip
  useEffect(() => {
    const handleClickOutsideTooltip = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        setFocusedCommentNodeId(null);
      }
    };

    if (isCommentFocused && !isEditingComment) {
      // Small delay to avoid immediately closing when navigating
      const timer = setTimeout(() => {
        document.addEventListener("mousedown", handleClickOutsideTooltip);
      }, 100);
      return () => {
        clearTimeout(timer);
        document.removeEventListener("mousedown", handleClickOutsideTooltip);
      };
    }
    return () => document.removeEventListener("mousedown", handleClickOutsideTooltip);
  }, [isCommentFocused, isEditingComment, setFocusedCommentNodeId]);

  // Synchronize resize across all selected nodes
  const handleResize: OnResize = useCallback(
    (event, params) => {
      const allNodes = getNodes();
      const selectedNodes = allNodes.filter((node) => node.selected && node.id !== id);

      if (selectedNodes.length > 0) {
        // Apply the same dimensions to all other selected nodes by updating their style
        setNodes((nodes) =>
          nodes.map((node) => {
            if (node.selected && node.id !== id) {
              return {
                ...node,
                style: {
                  ...node.style,
                  width: params.width,
                  height: params.height,
                },
              };
            }
            return node;
          })
        );
      }
    },
    [id, getNodes, setNodes]
  );

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={minWidth}
        minHeight={minHeight}
        lineClassName="!border-transparent"
        handleClassName="!w-3 !h-3 !bg-transparent !border-none"
        onResize={handleResize}
      />
      <div
        className={`
          bg-neutral-800 rounded-md shadow-lg border h-full w-full flex flex-col
          ${isCurrentlyExecuting || isExecuting ? "border-blue-500 ring-1 ring-blue-500/20" : "border-neutral-700"}
          ${hasError ? "border-red-500" : ""}
          ${selected ? "border-blue-500 ring-2 ring-blue-500/40 shadow-lg shadow-blue-500/25" : ""}
          ${className}
        `}
      >
        <div className="px-3 pt-2 pb-1 flex items-center justify-between shrink-0">
          {/* Title Section */}
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            {titlePrefix}
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onBlur={handleTitleSubmit}
                onKeyDown={handleTitleKeyDown}
                placeholder="Custom title..."
                className="nodrag nopan w-full bg-transparent border-none outline-none text-xs font-semibold tracking-wide text-neutral-300 placeholder:text-neutral-500 uppercase"
              />
            ) : (
              <span
                className="nodrag text-xs font-semibold uppercase tracking-wide text-neutral-400 cursor-text truncate"
                onClick={() => setIsEditingTitle(true)}
                title="Click to edit title"
              >
                {customTitle ? `${customTitle} - ${title}` : title}
              </span>
            )}
            {headerAction}
          </div>

          {/* Lock Badge for nodes in locked groups */}
          {isInLockedGroup && (
            <div className="ml-2 shrink-0 flex items-center" title="This node is in a locked group and will be skipped during execution">
              <svg className="w-3.5 h-3.5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
          )}

          {/* Custom Header Buttons */}
          {headerButtons}

          {/* Comment Icon */}
          <div className="relative ml-2 shrink-0 flex items-center gap-1" ref={commentPopoverRef}>
            <button
              ref={commentButtonRef}
              onClick={() => setIsEditingComment(!isEditingComment)}
              onMouseEnter={() => comment && !isCommentFocused && setShowCommentTooltip(true)}
              onMouseLeave={() => setShowCommentTooltip(false)}
              className={`nodrag nopan p-0.5 rounded transition-colors ${
                comment
                  ? "text-blue-400 hover:text-blue-200"
                  : "text-neutral-500 hover:text-neutral-200 border border-neutral-600"
              }`}
              title={comment ? "Edit comment" : "Add comment"}
            >
              {comment ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
                </svg>
              )}
            </button>

            {/* Comment Tooltip with Navigation - shown on hover OR when focused via navigation */}
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
                {/* Navigation controls - only show when focused and navigation available */}
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
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                      </svg>
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
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
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
              <div className="absolute z-[60] right-0 top-full mt-1 w-64 p-2 bg-neutral-800 border border-neutral-600 rounded shadow-lg">
                <textarea
                  value={editCommentValue}
                  onChange={(e) => setEditCommentValue(e.target.value)}
                  onKeyDown={handleCommentKeyDown}
                  placeholder="Add a comment..."
                  autoFocus
                  className="nodrag nopan nowheel w-full h-20 p-2 text-xs text-neutral-100 bg-neutral-900/50 border border-neutral-700 rounded resize-none focus:outline-none focus:ring-1 focus:ring-neutral-600"
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

          {/* Expand Button */}
          {onExpand && (
            <div className="relative ml-2 shrink-0 group">
              <button
                onClick={onExpand}
                className="nodrag nopan p-0.5 rounded transition-all duration-200 ease-in-out text-neutral-500 group-hover:text-neutral-200 border border-neutral-600 flex items-center overflow-hidden group-hover:pr-2"
                title="Expand editor"
              >
                <svg
                  className="w-3.5 h-3.5 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                >
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                <span className="max-w-0 opacity-0 whitespace-nowrap text-[10px] transition-all duration-200 ease-in-out overflow-hidden group-hover:max-w-[60px] group-hover:opacity-100 group-hover:ml-1">
                  Expand
                </span>
              </button>
            </div>
          )}

          {/* Run Button */}
          {onRun && (
            <div className="relative ml-2 shrink-0 group">
              <button
                onClick={onRun}
                disabled={isExecuting}
                className="nodrag nopan p-0.5 rounded transition-all duration-200 ease-in-out text-neutral-500 group-hover:text-neutral-200 border border-neutral-600 flex items-center overflow-hidden group-hover:pr-2 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Run this node"
              >
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span className="max-w-0 opacity-0 whitespace-nowrap text-[10px] transition-all duration-200 ease-in-out overflow-hidden group-hover:max-w-[60px] group-hover:opacity-100 group-hover:ml-1">
                  Run node
                </span>
              </button>
            </div>
          )}
        </div>
        <div className={contentClassName ?? "px-3 pb-4 flex-1 min-h-0 overflow-hidden flex flex-col"}>{children}</div>
      </div>
    </>
  );
}
