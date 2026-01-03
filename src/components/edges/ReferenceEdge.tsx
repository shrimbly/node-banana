"use client";

import { useMemo } from "react";
import {
  BaseEdge,
  EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";

// Grey color for reference connections (dimmed for softer appearance)
const REFERENCE_COLOR = "#52525b";

export function ReferenceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  source,
  target,
}: EdgeProps) {
  const edgeStyle = useWorkflowStore((state) => state.edgeStyle);
  const nodes = useWorkflowStore((state) => state.nodes);

  // Check if any node is selected and if this edge is connected to it
  const isConnectedToSelection = useMemo(() => {
    const selectedNodes = nodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return false; // No selection, show all dimmed

    // Check if this edge connects to any selected node
    return selectedNodes.some((n) => n.id === source || n.id === target);
  }, [nodes, source, target]);

  // Calculate the path - always use curved for reference edges for softer look
  const [edgePath] = useMemo(() => {
    return getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      curvature: 0.25,
    });
  }, [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition]);

  // Generate a unique gradient ID based on selection state
  const gradientId = useMemo(() => {
    const selectionKey = isConnectedToSelection ? "active" : "dimmed";
    return `reference-gradient-${selectionKey}-${id}`;
  }, [isConnectedToSelection, id]);

  return (
    <>
      {/* SVG gradient definition for bright-dim-bright effect */}
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={REFERENCE_COLOR} stopOpacity={isConnectedToSelection ? 1 : 0.25} />
          <stop offset="50%" stopColor={REFERENCE_COLOR} stopOpacity={isConnectedToSelection ? 0.55 : 0.1} />
          <stop offset="100%" stopColor={REFERENCE_COLOR} stopOpacity={isConnectedToSelection ? 1 : 0.25} />
        </linearGradient>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: `url(#${gradientId})`,
          strokeWidth: 2,
          strokeDasharray: "6 4",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />

      {/* Invisible wider path for easier selection */}
      <path
        d={edgePath}
        fill="none"
        strokeWidth={10}
        stroke="transparent"
        className="react-flow__edge-interaction"
      />
    </>
  );
}
