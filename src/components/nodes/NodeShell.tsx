"use client";

import React, { ReactNode, useCallback, useLayoutEffect, useRef } from "react";
import {
  NodeResizeControl,
  OnResize,
  OnResizeEnd,
  useReactFlow,
  useUpdateNodeInternals,
  type ResizeControlVariant,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { isPanningRef, isDraggingNodeRef } from "@/components/WorkflowCanvas";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { useShowHandleLabels } from "@/hooks/useShowHandleLabels";
import type { NodeType } from "@/types";
import type { ShellMedia } from "@/utils/nodeDimensions";
import { cn } from "./ui/cn";
import { SocketColumn, socketRowCount, type SocketSpec } from "./ui/Socket";
import { CONTROLS_GAP, GAP_ROW_H, NODE_MIN_W, socketMinHeight } from "./ui/tokens";

export type { ShellMedia };

/** Widest a node can be dragged. Auto-sizing uses the tighter NODE_MAX_W. */
const RESIZE_MAX_W = 1200;

export interface NodeShellProps {
  id: string;
  selected?: boolean;
  isExecuting?: boolean;
  hasError?: boolean;
  /** Tutorial hook, placed on the media card. */
  dataTutorial?: string;
  /** How tall the media clip is: from the width and an aspect, or fixed. */
  media: ShellMedia;
  inputs?: ReadonlyArray<SocketSpec>;
  outputs?: ReadonlyArray<SocketSpec>;
  /** Overrides the default (selected or connecting). */
  showLabels?: boolean;
  /** Content of the gap row between media and controls. */
  gap?: ReactNode;
  /** Usually a <ControlsCard>. Its presence also adds the gap row. */
  controls?: ReactNode;
  /** Media content, rendered inside the clip. */
  children?: ReactNode;
  /** Clip the media to the rounded rect (default). Off for legacy content that positions its own handles. */
  clip?: boolean;
  /** Rendered inside the media card but outside the clip: never clipped. */
  cardChildren?: ReactNode;
  mediaClassName?: string;
  cardClassName?: string;
  className?: string;
  minWidth?: number;
  maxWidth?: number;
  onMediaDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

const EMPTY: ReadonlyArray<SocketSpec> = [];

/**
 * The node anatomy every node type is built from: a media card carrying the
 * sockets and the selection/running/error outline, a gap row, and a detached
 * controls card. Width comes from the node; height comes from the content.
 */
export function NodeShell({
  id,
  selected = false,
  isExecuting = false,
  hasError = false,
  dataTutorial,
  media,
  inputs = EMPTY,
  outputs = EMPTY,
  showLabels,
  gap,
  controls,
  children,
  clip = true,
  cardChildren,
  mediaClassName,
  cardClassName,
  className,
  minWidth = NODE_MIN_W,
  maxWidth = RESIZE_MAX_W,
  onMediaDoubleClick,
}: NodeShellProps) {
  const currentNodeIds = useWorkflowStore((state) => state.currentNodeIds);
  const setHoveredNodeId = useWorkflowStore((state) => state.setHoveredNodeId);
  const running = isExecuting || (currentNodeIds?.includes(id) ?? false);
  const { getNodes, setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const connectingLabels = useShowHandleLabels(selected);
  const labels = showLabels ?? connectingLabels;

  const rows = Math.max(socketRowCount(inputs), socketRowCount(outputs));

  // Sockets sit at fixed offsets from the card top, so React Flow only needs
  // to re-measure handles when the set of sockets changes, not on every
  // height change (its own node observer covers those).
  const socketKey = `${inputs.map((s) => s.id).join(",")}|${outputs.map((s) => s.id).join(",")}`;
  const mountedKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (mountedKey.current === null) {
      mountedKey.current = socketKey;
      return;
    }
    if (mountedKey.current !== socketKey) {
      mountedKey.current = socketKey;
      updateNodeInternals(id);
    }
  }, [id, socketKey, updateNodeInternals]);

  // Width-only resizing. React Flow writes this node's width; other selected
  // nodes follow so a multi-selection resizes together.
  const handleResize: OnResize = useCallback(
    (_event, params) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.selected && node.id !== id
            ? { ...node, width: params.width, style: { ...node.style, width: params.width } }
            : node
        )
      );
    },
    [id, setNodes]
  );

  const handleResizeEnd: OnResizeEnd = useCallback(
    (_event, params) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id ? { ...node, width: params.width, style: { ...node.style, width: params.width } } : node
        )
      );
    },
    [id, setNodes]
  );

  // Double-clicking a resize edge puts the node back at its type's default width.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".react-flow__resize-control")) return;
      e.stopPropagation();
      const thisNode = getNodes().find((n) => n.id === id);
      const width = defaultNodeDimensions[thisNode?.type as NodeType]?.width ?? 300;
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id || node.selected ? { ...node, width, style: { ...node.style, width } } : node
        )
      );
    },
    [getNodes, id, setNodes]
  );

  const mediaStyle: React.CSSProperties =
    media.kind === "aspect"
      ? { aspectRatio: String(media.aspect > 0 && Number.isFinite(media.aspect) ? media.aspect : 1) }
      : media.kind === "fixed"
        ? { height: media.height }
        : {};

  return (
    <div
      className={cn("relative flex flex-col items-center w-full", className)}
      data-node-shell
      onDoubleClick={handleDoubleClick}
      onMouseEnter={(e) => {
        if (e.buttons !== 0 || isPanningRef.current || isDraggingNodeRef.current) return;
        setHoveredNodeId(id);
      }}
      onMouseLeave={(e) => {
        if (e.buttons !== 0 || isPanningRef.current || isDraggingNodeRef.current) return;
        setHoveredNodeId(null);
      }}
    >
      {selected && (
        <>
          <NodeResizeControl
            position="left"
            variant={"line" as ResizeControlVariant}
            resizeDirection="horizontal"
            minWidth={minWidth}
            maxWidth={maxWidth}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
            className="!border-transparent"
          />
          <NodeResizeControl
            position="right"
            variant={"line" as ResizeControlVariant}
            resizeDirection="horizontal"
            minWidth={minWidth}
            maxWidth={maxWidth}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
            className="!border-transparent"
          />
        </>
      )}

      {/* Media card: the outline, the sockets and the clip. */}
      <div
        data-media-card
        data-tutorial={dataTutorial}
        className={cn(
          "relative w-full shrink-0 p-[4px] rounded-card squircle bg-card border border-card-border overflow-visible",
          "transition-[box-shadow,border-color] duration-150",
          selected && "border-selection ring-2 ring-selection/40 shadow-lg shadow-selection/25",
          running && !selected && "ring-1 ring-running/20",
          running && "border-running",
          hasError && "border-error",
          cardClassName
        )}
        style={{ minHeight: socketMinHeight(rows) }}
      >
        <div
          data-media-clip
          className={cn(
            "relative w-full rounded-media squircle",
            clip ? "overflow-hidden" : "overflow-visible",
            mediaClassName
          )}
          style={{ contain: "layout style", ...mediaStyle }}
          onDoubleClick={onMediaDoubleClick}
        >
          {children}
        </div>
        {cardChildren}
        <SocketColumn nodeId={id} side="left" sockets={inputs} showLabels={labels} />
        <SocketColumn nodeId={id} side="right" sockets={outputs} showLabels={labels} />
      </div>

      {(gap !== undefined && gap !== null) || controls ? (
        <div
          data-gap-row
          className="w-full shrink-0 flex items-center justify-center"
          style={{ height: gap !== undefined && gap !== null ? GAP_ROW_H : CONTROLS_GAP }}
        >
          {gap}
        </div>
      ) : null}

      {controls}
    </div>
  );
}
