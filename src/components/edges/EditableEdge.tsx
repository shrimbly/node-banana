"use client";

import { useState, useCallback, useMemo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getSmoothStepPath,
  getBezierPath,
  getStraightPath,
  useReactFlow,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { NanoBananaNodeData, WorkflowEdgeData } from "@/types";
import { getSharedGradientId } from "./SharedEdgeGradients";
import { EDGE_COLORS, edgeColorKeyForHandles } from "@/lib/edges/colors";
import { EDGE_THICKNESS_PX } from "@/lib/edges/appearance";
import { EdgeToolbar, useIsToolbarEdge } from "@/components/EdgeToolbar";
import { HiddenEdgeStub } from "./HiddenEdgeStub";
import { edgeDisplayLabelById, hiddenSiblingIndex, parallelEdgePosition } from "@/lib/edges/labels";
import { EdgeLabel } from "./EdgeLabel";

interface EdgeData extends WorkflowEdgeData {
  offsetX?: number;
  offsetY?: number;
}

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
  const appearance = useWorkflowStore((state) => state.edgeAppearance);
  const [isDragging, setIsDragging] = useState(false);
  const carriesToolbar = useIsToolbarEdge(id);

  // Hidden connections: labelled stubs at the handles; hover ghosts the line back
  const isHidden = Boolean((data as EdgeData | undefined)?.hidden);
  const [revealed, setRevealed] = useState(false);
  const setEdgesHidden = useWorkflowStore((state) => state.setEdgesHidden);
  const displayLabel = useWorkflowStore((state) => edgeDisplayLabelById(id, state.edges));
  const hasOwnLabel = Boolean((data as EdgeData | undefined)?.label?.trim());
  const stubLabel = displayLabel;
  const [hovered, setHovered] = useState(false);
  const parallel = useWorkflowStore((state) => {
    const { index, count } = parallelEdgePosition(id, state.edges);
    return count > 1 ? index - (count - 1) / 2 : 0;
  });
  const sourceStack = useWorkflowStore((state) => (isHidden ? hiddenSiblingIndex(id, state.edges, "source") : 0));
  const targetStack = useWorkflowStore((state) => (isHidden ? hiddenSiblingIndex(id, state.edges, "target") : 0));

  // Narrow selector: returns boolean, only re-renders when selection relevance changes
  const isConnectedToSelection = useWorkflowStore((state) =>
    state.nodes.some((n) => n.selected && (n.id === source || n.id === target))
  );

  const edgeData = data as EdgeData | undefined;
  const offsetX = edgeData?.offsetX ?? 0;
  const offsetY = edgeData?.offsetY ?? 0;
  const hasPause = edgeData?.hasPause ?? false;

  // Narrow selector: only re-renders when target loading status changes
  const isTargetLoading = useWorkflowStore((state) => {
    const targetNode = state.nodes.find((n) => n.id === target);
    if (targetNode?.type !== "nanoBanana") return false;
    return (targetNode.data as NanoBananaNodeData).status === "loading";
  });

  // Colour key: magenta for loop edges, orange if paused, else the data type
  const colorKey = useMemo(() => {
    if (edgeData?.isLoop) return "loop" as const;
    if (hasPause) return "pause" as const;
    return edgeColorKeyForHandles(sourceHandleId, targetHandleId);
  }, [edgeData?.isLoop, hasPause, sourceHandleId, targetHandleId]);
  const edgeColor = EDGE_COLORS[colorKey];

  // Shared gradient for the colour key + selection state; the "active" one
  // also serves as the hover/selected stroke (see globals.css)
  const gradientId = getSharedGradientId(colorKey, isConnectedToSelection ? "active" : "dimmed");
  const activeGradientId = getSharedGradientId(colorKey, "active");

  // Calculate the path based on edge style
  const [edgePath, labelX, labelY] = useMemo(() => {
    // Loop edges: smooth arc that exits/enters along handle directions, bowed below nodes
    if (edgeData?.isLoop) {
      const dist = Math.sqrt((targetX - sourceX) ** 2 + (targetY - sourceY) ** 2);
      const extent = Math.max(100, dist * 0.4);
      const drop = Math.max(120, dist * 0.4);

      // Direction vectors matching handle positions
      const dir: Record<string, [number, number]> = {
        top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0],
      };
      const [sdx, sdy] = dir[sourcePosition] ?? [1, 0];
      const [tdx, tdy] = dir[targetPosition] ?? [-1, 0];

      // Follow handle direction + push arc below the nodes
      const cp1x = sourceX + sdx * extent;
      const cp1y = sourceY + sdy * extent + drop;
      const cp2x = targetX + tdx * extent;
      const cp2y = targetY + tdy * extent + drop;

      const path = `M${sourceX},${sourceY} C${cp1x},${cp1y} ${cp2x},${cp2y} ${targetX},${targetY}`;
      // Label at bezier midpoint (t=0.5)
      const lx = 0.125 * sourceX + 0.375 * cp1x + 0.375 * cp2x + 0.125 * targetX;
      const ly = 0.125 * sourceY + 0.375 * cp1y + 0.375 * cp2y + 0.125 * targetY;
      return [path, lx, ly] as [string, number, number];
    }

    if (edgeStyle === "straight") {
      return getStraightPath({ sourceX, sourceY, targetX, targetY });
    }

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
  }, [edgeStyle, edgeData?.isLoop, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, offsetX]);

  // Calculate handle positions on the path segments (only for angular mode)
  const handlePositions = useMemo(() => {
    if (edgeStyle !== "angular") return [];

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

  // Stroke from the appearance settings: the shared gradient, or a solid
  // colour faded when the edge is not attached to a selected node.
  const strokeWidth = EDGE_THICKNESS_PX[appearance.thickness];
  const stroke = appearance.gradient ? `url(#${gradientId})` : edgeColor;
  const strokeOpacity = appearance.gradient || isConnectedToSelection ? 1 : appearance.fadedOpacity;
  const activeStroke = appearance.gradient ? `url(#${activeGradientId})` : edgeColor;
  const showPulse = isTargetLoading && appearance.loadingPulse;

  // Labels: the user's own always shows; automatic ones follow the setting
  const labelMode = appearance.labels ?? "hover";
  const autoVisible =
    labelMode === "always" || (labelMode === "hover" && (hovered || Boolean(selected) || isConnectedToSelection));
  const labelText = hasOwnLabel || autoVisible ? displayLabel : "";
  const showLabel = Boolean(labelText) || Boolean(edgeData?.isLoop);

  if (isHidden) {
    const sourceDir: 1 | -1 = sourcePosition === "left" ? -1 : 1;
    const targetDir: 1 | -1 = targetPosition === "right" ? 1 : -1;
    const stubLength = 8;
    return (
      <>
        {revealed && (
          <path
            d={edgePath}
            fill="none"
            stroke={edgeColor}
            strokeWidth={strokeWidth}
            strokeOpacity={0.7}
            strokeDasharray="6 7"
            strokeLinecap="round"
            data-testid="hidden-edge-ghost"
          />
        )}
        <path d={`M${sourceX},${sourceY} L${sourceX + sourceDir * stubLength},${sourceY}`} fill="none" stroke={edgeColor} strokeWidth={strokeWidth} strokeOpacity={0.9} strokeLinecap="round" />
        <path d={`M${targetX},${targetY} L${targetX + targetDir * stubLength},${targetY}`} fill="none" stroke={edgeColor} strokeWidth={strokeWidth} strokeOpacity={0.9} strokeLinecap="round" />
        <EdgeLabelRenderer>
          <HiddenEdgeStub
            side="source"
            x={sourceX + sourceDir * (stubLength + 4)}
            y={sourceY + sourceStack * 22}
            direction={sourceDir}
            label={stubLabel}
            color={edgeColor}
            onHoverChange={setRevealed}
            onShow={() => setEdgesHidden([id], false)}
          />
          <HiddenEdgeStub
            side="target"
            x={targetX + targetDir * (stubLength + 4)}
            y={targetY + targetStack * 22}
            direction={targetDir}
            label={stubLabel}
            color={edgeColor}
            onHoverChange={setRevealed}
            onShow={() => setEdgesHidden([id], false)}
          />
        </EdgeLabelRenderer>
      </>
    );
  }

  return (
    <g data-testid="edge-hover-area" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeOpacity,
          strokeWidth,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "--edge-stroke-active": activeStroke,
        } as React.CSSProperties}
      />

      {selected && carriesToolbar && <EdgeToolbar edgeId={id} x={labelX} y={labelY} />}

      {/* Animated pulse overlay when target is loading */}
      {showPulse && (
        <>
          {/* Outer glow — replaces blur(6px) filter for better perf on Windows */}
          <path
            d={edgePath}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth * 6.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.06}
          />
          {/* Inner glow */}
          <path
            d={edgePath}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth * 4}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.12}
          />
          {/* Animated flowing pulse using stroke-dasharray */}
          <path
            d={edgePath}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth + 2}
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

      {showLabel && (
        <EdgeLabel
          x={labelX}
          y={labelY + parallel * 18}
          text={labelText}
          color={edgeColor}
          loopCount={edgeData?.isLoop ? edgeData.loopCount || 3 : undefined}
          active={isConnectedToSelection || Boolean(selected) || hovered}
        />
      )}

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
    </g>
  );
}
