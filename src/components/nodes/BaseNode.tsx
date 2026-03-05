"use client";

import { ReactNode, useCallback } from "react";
import { NodeResizer, OnResize, useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";

interface BaseNodeProps {
  id: string;
  children: ReactNode;
  selected?: boolean;
  isExecuting?: boolean;
  hasError?: boolean;
  className?: string;
  contentClassName?: string;
  minWidth?: number;
  minHeight?: number;
  /** When true, node has no background/border — content fills the entire node area */
  fullBleed?: boolean;
}

export function BaseNode({
  id,
  children,
  selected = false,
  isExecuting = false,
  hasError = false,
  className = "",
  contentClassName,
  minWidth = 180,
  minHeight = 100,
  fullBleed = false,
}: BaseNodeProps) {
  const currentNodeIds = useWorkflowStore((state) => state.currentNodeIds);
  const nodes = useWorkflowStore((state) => state.nodes);
  const setHoveredNodeId = useWorkflowStore((state) => state.setHoveredNodeId);
  const isCurrentlyExecuting = currentNodeIds.includes(id);
  const { getNodes, setNodes } = useReactFlow();

  // Synchronize resize across all selected nodes
  const handleResize: OnResize = useCallback(
    (event, params) => {
      const allNodes = getNodes();
      const selectedNodes = allNodes.filter((node) => node.selected && node.id !== id);

      if (selectedNodes.length > 0) {
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
          h-full w-full flex flex-col overflow-visible
          ${fullBleed ? "rounded-lg" : "bg-neutral-800 rounded-lg shadow-lg border"}
          ${fullBleed ? "" : (isCurrentlyExecuting || isExecuting ? "border-blue-500 ring-1 ring-blue-500/20" : "border-neutral-700/60")}
          ${fullBleed ? "" : (hasError ? "border-red-500" : "")}
          ${fullBleed && selected ? "ring-2 ring-blue-500/40 shadow-lg shadow-blue-500/25" : ""}
          ${!fullBleed && selected ? "border-blue-500 ring-2 ring-blue-500/40 shadow-lg shadow-blue-500/25" : ""}
          ${className}
        `}
        onMouseEnter={() => setHoveredNodeId(id)}
        onMouseLeave={() => setHoveredNodeId(null)}
      >
        <div className={contentClassName ?? (fullBleed ? "flex-1 min-h-0 relative" : "px-3 pb-4 flex-1 min-h-0 overflow-hidden flex flex-col")}>{children}</div>
      </div>
    </>
  );
}
