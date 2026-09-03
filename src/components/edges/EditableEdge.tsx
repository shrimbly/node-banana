"use client";

import { useState, useCallback, useMemo } from "react";
import { Position } from "@xyflow/react";
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
import { edgeBundles, bundleReach, bundleClampKey, type BundleMembership } from "@/lib/edges/bundles";

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
  const { setEdges, screenToFlowPosition } = useReactFlow();
  const edgeStyle = useWorkflowStore((state) => state.edgeStyle);
  const appearance = useWorkflowStore((state) => state.edgeAppearance);
  const [isDragging, setIsDragging] = useState(false);
  const carriesToolbar = useIsToolbarEdge(id);

  // Hidden connections: labelled stubs at the handles; hover ghosts the line back
  const isHidden = Boolean((data as EdgeData | undefined)?.hidden);
  const [stubHovered, setStubHovered] = useState(false);
  const [stubWidths, setStubWidths] = useState({ source: 0, target: 0 });
  const [toolbarSide, setToolbarSide] = useState<"source" | "target">("source");
  const measureSource = useCallback((w: number) => setStubWidths((prev) => (prev.source === w ? prev : { ...prev, source: w })), []);
  const measureTarget = useCallback((w: number) => setStubWidths((prev) => (prev.target === w ? prev : { ...prev, target: w })), []);
  const handleHovered = useWorkflowStore((state) => {
    if (!isHidden) return false;
    const h = state.hoveredHandle;
    if (!h) return false;
    return (
      (h.type === "source" && h.nodeId === source && (h.handleId ?? null) === (sourceHandleId ?? null)) ||
      (h.type === "target" && h.nodeId === target && (h.handleId ?? null) === (targetHandleId ?? null))
    );
  });
  const selectThisEdge = useCallback(
    (side: "source" | "target") => {
      setToolbarSide(side);
      setEdges((edges) => edges.map((e) => ({ ...e, selected: e.id === id })));
    },
    [id, setEdges]
  );
  const displayLabel = useWorkflowStore((state) => edgeDisplayLabelById(id, state.edges));
  const hasOwnLabel = Boolean((data as EdgeData | undefined)?.label?.trim());
  const stubLabel = displayLabel;
  const [hovered, setHovered] = useState(false);
  const parallel = useWorkflowStore((state) => {
    const { index, count } = parallelEdgePosition(id, state.edges);
    return count > 1 ? index - (count - 1) / 2 : 0;
  });

  // Bundles: the noodles sharing a handle leave it as one short stem and
  // split further out, until one of them is selected. Selected as a string
  // so the selector stays referentially stable.
  const bundleKey = useWorkflowStore((state) => {
    const { source: sb, target: tb } = edgeBundles(id, state.edges, state.edgeAppearance.bundling);
    const pack = (m: BundleMembership | null) => (m ? `${m.index}|${m.count}|${m.manual ? 1 : 0}|${m.members.join(",")}` : "");
    return `${pack(sb)}\u0002${pack(tb)}`;
  });
  const bundles = useMemo(() => {
    const unpack = (packed: string, end: "source" | "target"): BundleMembership | null => {
      if (!packed) return null;
      const [index, count, manual, members] = packed.split("|");
      return { end, key: "", index: Number(index), count: Number(count), manual: manual === "1", members: members.split(",") };
    };
    const [sb, tb] = bundleKey.split("\u0002");
    return { source: unpack(sb, "source"), target: unpack(tb, "target") };
  }, [bundleKey]);
  const bundleExpanded = useWorkflowStore((state) => {
    const members = [...(bundles.source?.members ?? []), ...(bundles.target?.members ?? [])];
    return members.length > 0 && state.edges.some((e) => e.selected && members.includes(e.id));
  });
  const sourceBundle = bundleExpanded ? null : bundles.source;
  const targetBundle = bundleExpanded ? null : bundles.target;
  // The clamp position for each end lives on the node that owns the handle
  const sourceReach = useWorkflowStore((state) => bundleReach(state.nodes, source, "source", sourceHandleId));
  const targetReach = useWorkflowStore((state) => bundleReach(state.nodes, target, "target", targetHandleId));
  const setBundleClamp = useWorkflowStore((state) => state.setBundleClamp);
  const sDir: 1 | -1 = sourcePosition === "left" ? -1 : 1;
  const tDir: 1 | -1 = targetPosition === "right" ? 1 : -1;
  // Where this noodle starts and ends: the stem's far end when bundled
  const startX = sourceBundle ? sourceX + sDir * sourceReach : sourceX;
  const endX = targetBundle ? targetX + tDir * targetReach : targetX;
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
      return getStraightPath({ sourceX: startX, sourceY, targetX: endX, targetY });
    }

    if (edgeStyle === "curved") {
      return getBezierPath({
        sourceX: startX,
        sourceY,
        sourcePosition,
        targetX: endX,
        targetY,
        targetPosition,
        curvature: 0.25,
      });
    } else {
      return getSmoothStepPath({
        sourceX: startX,
        sourceY,
        sourcePosition,
        targetX: endX,
        targetY,
        targetPosition,
        borderRadius: 8,
        offset: offsetX,
      });
    }
  }, [edgeStyle, edgeData?.isLoop, startX, endX, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, offsetX]);

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
    const revealed = stubHovered || handleHovered || Boolean(selected);
    // Stub pills sit just past the handles; the ghost runs between their outer edges
    const sourceStub = { x: sourceX + sourceDir * (stubLength + 4), y: sourceY + sourceStack * 22 };
    const targetStub = { x: targetX + targetDir * (stubLength + 4), y: targetY + targetStack * 22 };
    const [ghostPath] = getBezierPath({
      sourceX: sourceStub.x + sourceDir * stubWidths.source,
      sourceY: sourceStub.y,
      sourcePosition: sourceDir === 1 ? Position.Right : Position.Left,
      targetX: targetStub.x + targetDir * stubWidths.target,
      targetY: targetStub.y,
      targetPosition: targetDir === 1 ? Position.Right : Position.Left,
      curvature: 0.25,
    });
    const toolbarStub = toolbarSide === "target" ? targetStub : sourceStub;
    const toolbarDir = toolbarSide === "target" ? targetDir : sourceDir;
    const toolbarWidth = toolbarSide === "target" ? stubWidths.target : stubWidths.source;
    return (
      <>
        {revealed && (
          <path
            d={ghostPath}
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
            x={sourceStub.x}
            y={sourceStub.y}
            direction={sourceDir}
            label={stubLabel}
            color={edgeColor}
            selected={Boolean(selected)}
            onHoverChange={setStubHovered}
            onSelect={() => selectThisEdge("source")}
            onMeasure={measureSource}
          />
          <HiddenEdgeStub
            side="target"
            x={targetStub.x}
            y={targetStub.y}
            direction={targetDir}
            label={stubLabel}
            color={edgeColor}
            selected={Boolean(selected)}
            onHoverChange={setStubHovered}
            onSelect={() => selectThisEdge("target")}
            onMeasure={measureTarget}
          />
        </EdgeLabelRenderer>
        {selected && carriesToolbar && (
          <EdgeToolbar edgeId={id} x={toolbarStub.x + toolbarDir * (toolbarWidth / 2)} y={toolbarStub.y - 10} />
        )}
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

      {/* Bundle stems: the first member of each bundle draws the shared stem and its count */}
      {sourceBundle?.index === 0 && (
        <BundleStem
          x={sourceX}
          y={sourceY}
          dir={sDir}
          reach={sourceReach}
          count={sourceBundle.count}
          stroke={stroke}
          strokeOpacity={strokeOpacity}
          width={strokeWidth}
          color={edgeColor}
          activeStroke={activeStroke}
          screenToFlowPosition={screenToFlowPosition}
          onReachChange={(reach) => setBundleClamp(source, bundleClampKey("source", sourceHandleId), reach)}
        />
      )}
      {targetBundle?.index === 0 && (
        <BundleStem
          x={targetX}
          y={targetY}
          dir={tDir}
          reach={targetReach}
          count={targetBundle.count}
          stroke={stroke}
          strokeOpacity={strokeOpacity}
          width={strokeWidth}
          color={edgeColor}
          activeStroke={activeStroke}
          screenToFlowPosition={screenToFlowPosition}
          onReachChange={(reach) => setBundleClamp(target, bundleClampKey("target", targetHandleId), reach)}
        />
      )}

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

interface BundleStemProps {
  /** The shared handle, in flow coordinates. */
  x: number;
  y: number;
  /** Which way the stem leaves the handle: +1 right, -1 left. */
  dir: 1 | -1;
  reach: number;
  count: number;
  stroke: string;
  strokeOpacity: number;
  width: number;
  color: string;
  activeStroke: string;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  /** Called while the clamp is dragged, with the new distance from the handle. */
  onReachChange: (reach: number) => void;
}

/**
 * The short shared stem at a bundled handle, with the connection count on it
 * and a clamp, a cable tie, at the split point that drags along the stem to
 * tie the noodles closer to or further from the handle.
 */
function BundleStem({ x, y, dir, reach, count, stroke, strokeOpacity, width, color, activeStroke, screenToFlowPosition, onReachChange }: BundleStemProps) {
  const stemWidth = width * (1 + Math.min(count - 1, 4) * 0.5);
  const splitX = x + dir * reach;
  const path = `M${x},${y} L${splitX},${y}`;

  const startClampDrag = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const onMove = (event: MouseEvent) => {
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onReachChange(dir * (flow.x - x));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeOpacity={strokeOpacity}
        strokeWidth={stemWidth}
        strokeLinecap="round"
        className="react-flow__edge-path"
        style={{ "--edge-stroke-active": activeStroke } as React.CSSProperties}
        data-testid="edge-bundle-stem"
      />
      <path d={path} fill="none" strokeWidth={stemWidth + 12} stroke="transparent" className="react-flow__edge-interaction" />
      <EdgeLabelRenderer>
        {/* The clamp: a glassy vertical pill over the split point */}
        <div
          className="nodrag nopan"
          data-testid="edge-bundle-clamp"
          title="Drag to move where the bundle splits"
          onMouseDown={startClampDrag}
          style={{
            position: "absolute",
            transform: `translate(${splitX}px, ${y}px) translate(-50%, -50%)`,
            pointerEvents: "all",
            width: 10,
            height: 26,
            borderRadius: 9999,
            cursor: "ew-resize",
            background: "linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))",
            border: "1px solid rgba(255,255,255,0.45)",
            boxShadow: `inset 0 0 0 1px ${color}55, 0 1px 4px rgba(0,0,0,0.45)`,
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}
        />
        <div
          data-testid="edge-bundle-count"
          className="inline-flex items-center gap-1 h-5 pl-1.5 pr-2 rounded-full bg-neutral-800/95 border text-[10px] font-semibold text-neutral-100 whitespace-nowrap"
          style={{
            position: "absolute",
            transform: `translate(${splitX}px, ${y - 19}px) translate(-50%, -100%)`,
            pointerEvents: "none",
            borderColor: `${color}b3`,
          }}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round">
            <path d="M1.5 3.5h3.5c2 0 2 3.5 4 3.5h3.5M1.5 7H5M1.5 10.5h3.5c2 0 2-3.5 4-3.5" />
          </svg>
          <span>{count}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
