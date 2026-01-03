"use client";

import { useState, useCallback, useMemo } from "react";
import {
  BaseEdge,
  EdgeProps,
  getSmoothStepPath,
  getBezierPath,
  useReactFlow,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { NanoBananaNodeData, WorkflowEdgeData } from "@/types";

interface EdgeData extends WorkflowEdgeData {
  offsetX?: number;
  offsetY?: number;
}

// Colors for different connection types (dimmed for softer appearance)
const EDGE_COLORS = {
  image: "#0d9668", // Dimmed green for image connections
  prompt: "#2563eb", // Dimmed blue for prompt connections
  default: "#64748b", // Dimmed gray for unknown
  pause: "#ea580c", // Dimmed orange for paused edges
};

export function EditableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
  data,
  sourceHandleId,
  targetHandleId,
  source,
  target,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const edgeStyle = useWorkflowStore((state) => state.edgeStyle);
  // Subscribe to nodes array to get updates when node data changes
  const nodes = useWorkflowStore((state) => state.nodes);
  const [isDragging, setIsDragging] = useState(false);

  // Check if any node is selected and if this edge is connected to it
  const isConnectedToSelection = useMemo(() => {
    const selectedNodes = nodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return false; // No selection, show all dimmed

    // Check if this edge connects to any selected node
    return selectedNodes.some((n) => n.id === source || n.id === target);
  }, [nodes, source, target]);

  const edgeData = data as EdgeData | undefined;
  const offsetX = edgeData?.offsetX ?? 0;
  const offsetY = edgeData?.offsetY ?? 0;
  const hasPause = edgeData?.hasPause ?? false;

  // Check if target node is a Generate node that's currently loading
  const isTargetLoading = useMemo(() => {
    const targetNode = nodes.find((n) => n.id === target);
    if (targetNode?.type === "nanoBanana") {
      const nodeData = targetNode.data as NanoBananaNodeData;
      return nodeData.status === "loading";
    }
    return false;
  }, [target, nodes]);

  // Determine edge color based on handle type (orange if paused)
  const edgeColor = useMemo(() => {
    if (hasPause) return EDGE_COLORS.pause;
    // Use source handle to determine color (or target if source is not available)
    const handleType = sourceHandleId || targetHandleId;
    if (handleType === "image") return EDGE_COLORS.image;
    if (handleType === "prompt") return EDGE_COLORS.prompt;
    return EDGE_COLORS.default;
  }, [hasPause, sourceHandleId, targetHandleId]);

  // Generate a unique gradient ID based on edge color and selection state
  const gradientId = useMemo(() => {
    const colorKey = hasPause ? "pause" : (sourceHandleId || targetHandleId || "default");
    const selectionKey = isConnectedToSelection ? "active" : "dimmed";
    return `edge-gradient-${colorKey}-${selectionKey}-${id}`;
  }, [hasPause, sourceHandleId, targetHandleId, isConnectedToSelection, id]);

  // Calculate the path based on edge style
  const [edgePath, labelX, labelY] = useMemo(() => {
    if (edgeStyle === "curved") {
      return getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        curvature: 0.25,
      });
    } else {
      return getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 8,
        offset: offsetX,
      });
    }
  }, [edgeStyle, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, offsetX]);

  // Calculate handle positions on the path segments (only for angular mode)
  const handlePositions = useMemo(() => {
    if (edgeStyle === "curved") return [];

    const handles: { x: number; y: number; direction: "horizontal" | "vertical" }[] = [];

    const midX = (sourceX + targetX) / 2 + offsetX;
    const midY = (sourceY + targetY) / 2 + offsetY;

    // Middle segment handle
    if (Math.abs(targetX - sourceX) > 50) {
      handles.push({
        x: midX,
        y: midY,
        direction: "horizontal",
      });
    }

    return handles;
  }, [edgeStyle, sourceX, sourceY, targetX, targetY, offsetX, offsetY]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, direction: "horizontal" | "vertical") => {
      e.stopPropagation();
      e.preventDefault();
      setIsDragging(true);

      const startX = e.clientX;
      const startY = e.clientY;
      const startOffsetX = offsetX;
      const startOffsetY = offsetY;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;

        setEdges((edges) =>
          edges.map((edge) => {
            if (edge.id === id) {
              return {
                ...edge,
                data: {
                  ...edge.data,
                  offsetX: direction === "horizontal" ? startOffsetX + deltaX : startOffsetX,
                  offsetY: direction === "vertical" ? startOffsetY + deltaY : startOffsetY,
                },
              };
            }
            return edge;
          })
        );
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [id, offsetX, offsetY, setEdges]
  );

  return (
    <>
      {/* SVG gradient definition for bright-dim-bright effect */}
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={edgeColor} stopOpacity={isConnectedToSelection ? 1 : 0.25} />
          <stop offset="50%" stopColor={edgeColor} stopOpacity={isConnectedToSelection ? 0.55 : 0.1} />
          <stop offset="100%" stopColor={edgeColor} stopOpacity={isConnectedToSelection ? 1 : 0.25} />
        </linearGradient>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: `url(#${gradientId})`,
          strokeWidth: 3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />

      {/* Animated pulse overlay when target is loading */}
      {isTargetLoading && (
        <>
          {/* Glow effect behind the pulse */}
          <path
            d={edgePath}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={10}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              opacity: 0.2,
              filter: "blur(6px)",
            }}
          />
          {/* Animated flowing pulse using stroke-dasharray */}
          <path
            d={edgePath}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="20 30"
            style={{
              animation: "flowPulse 1s linear infinite",
            }}
          />
        </>
      )}

      {/* Invisible wider path for easier selection */}
      <path
        d={edgePath}
        fill="none"
        strokeWidth={15}
        stroke="transparent"
        className="react-flow__edge-interaction"
      />

      {/* Pause indicator near target connection point */}
      {hasPause && (
        <g transform={`translate(${targetX - 24}, ${targetY})`}>
          {/* Background circle */}
          <circle
            r={10}
            fill="#27272a"
            stroke={edgeColor}
            strokeWidth={2}
          />
          {/* Pause bars */}
          <rect x={-4} y={-5} width={2.5} height={10} fill={edgeColor} rx={1} />
          <rect x={1.5} y={-5} width={2.5} height={10} fill={edgeColor} rx={1} />
        </g>
      )}

      {/* Draggable handles on segments */}
      {(selected || isDragging) &&
        handlePositions.map((handle, index) => (
          <g key={index}>
            <circle
              cx={handle.x}
              cy={handle.y}
              r={6}
              fill="white"
              stroke="#3b82f6"
              strokeWidth={2}
              style={{
                cursor: handle.direction === "horizontal" ? "ew-resize" : "ns-resize",
              }}
              onMouseDown={(e) => handleMouseDown(e, handle.direction)}
            />
          </g>
        ))}
    </>
  );
}
