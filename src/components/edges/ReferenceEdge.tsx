"use client";

import { useMemo } from "react";
import {
  BaseEdge,
  EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { getSharedGradientId } from "./SharedEdgeGradients";
import { EDGE_COLORS } from "@/lib/edges/colors";

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
  const appearance = useWorkflowStore((state) => state.edgeAppearance);

  // Narrow selector: returns boolean, only re-renders when selection relevance changes
  const isConnectedToSelection = useWorkflowStore((state) => {
    const selectedNodes = state.nodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return false;
    return selectedNodes.some((n) => n.id === source || n.id === target);
  });

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

  // Reference shared gradient by selection state
  const gradientId = useMemo(() => {
    const selectionKey = isConnectedToSelection ? "active" : "dimmed";
    return getSharedGradientId("reference", selectionKey);
  }, [isConnectedToSelection]);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: appearance.gradient ? `url(#${gradientId})` : EDGE_COLORS.reference,
          strokeOpacity: appearance.gradient || isConnectedToSelection ? 1 : appearance.fadedOpacity,
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
