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
  useStore,
  useConnection,
  type ReactFlowState,
} from "@xyflow/react";
import { shallow, useShallow } from "zustand/shallow";
import { useWorkflowStore } from "@/store/workflowStore";
import { NanoBananaNodeData, WorkflowEdgeData } from "@/types";
import { getSharedGradientId } from "./SharedEdgeGradients";
import { EDGE_COLORS, edgeColorKeyForHandles } from "@/lib/edges/colors";
import { EDGE_THICKNESS_PX } from "@/lib/edges/appearance";
import { EdgeToolbar, useIsToolbarEdge } from "@/components/EdgeToolbar";
import { HiddenEdgeStub } from "./HiddenEdgeStub";
import {
  edgeDisplayLabelById,
  hiddenStubOffset,
  hiddenStubRole,
  parallelEdgePosition,
  pluralTypeLabel,
  stubGroupKey,
} from "@/lib/edges/labels";
import { EdgeLabel } from "./EdgeLabel";
import { edgeBundles, bundleReach, bundleClampKey, type BundleMembership } from "@/lib/edges/bundles";
import { edgeGraphIndex, nodeGraphIndex } from "@/lib/edges/graphIndex";
import { bundleClampStyle } from "./BundleClamp";
import { HookBundleClamp } from "./HookBundleClamp";
import { hookHandles } from "@/lib/edges/hook";

interface EdgeData extends WorkflowEdgeData {
  offsetX?: number;
  offsetY?: number;
}

/**
 * Absolute y of the centre of each handle on one side of a node, by handle id.
 * Only a hidden edge needs it, and every edge subscribes, so the subscription
 * selects nothing until then rather than comparing the node on every update.
 */
function useHandleY(nodeId: string, side: "source" | "target", enabled: boolean) {
  const node = useStore(
    useCallback((s: ReactFlowState) => (enabled ? s.nodeLookup.get(nodeId) : undefined), [nodeId, enabled]),
    shallow
  );
  const bounds = node?.internals.handleBounds?.[side];
  const top = node?.internals.positionAbsolute.y ?? 0;
  return useCallback(
    (handleId: string | null) => {
      const handle = bounds?.find((h) => (h.id ?? null) === handleId);
      return handle ? top + handle.y + handle.height / 2 : undefined;
    },
    [bounds, top]
  );
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
  const hookData = useMemo(() => hookHandles(data as EdgeData | undefined), [data]);
  const hookGroups = useWorkflowStore(useShallow((state) => hookData.map((handle) =>
    edgeGraphIndex(state.edges).hookBundles.get(handle.id))));
  const hookBundles = useMemo(() => hookData.filter((_, index) => (hookGroups[index]?.length ?? 0) > 1), [hookData, hookGroups]);
  const hookBundle = hookBundles.length > 0;
  const activeHookBundleId = useWorkflowStore((state) => state.activeHookBundleId);

  // Hidden connections: labelled stubs at the handles; hover ghosts the line back
  const isHidden = Boolean((data as EdgeData | undefined)?.hidden);
  // While a noodle is being dragged the handle labels take the stubs' place
  const isConnecting = useConnection((c) => c.inProgress);
  const [stubHovered, setStubHovered] = useState(false);
  const [stubWidths, setStubWidths] = useState({ source: 0, target: 0 });
  const [toolbarSide, setToolbarSide] = useState<"source" | "target">("source");
  const measureSource = useCallback((w: number) => setStubWidths((prev) => (prev.source === w ? prev : { ...prev, source: w })), []);
  const measureTarget = useCallback((w: number) => setStubWidths((prev) => (prev.target === w ? prev : { ...prev, target: w })), []);
  const selectThisEdge = useCallback(
    (side: "source" | "target") => {
      setToolbarSide(side);
      setEdges((edges) => edges.map((e) => ({ ...e, selected: e.id === id })));
    },
    [id, setEdges]
  );
  const hasOwnLabel = Boolean((data as EdgeData | undefined)?.label?.trim());
  const [hovered, setHovered] = useState(false);
  // A collapsed pill is drawn by one member but every member's ghost must
  // leave from its outer edge, so its measured width goes through the store
  const sourceGroupKey = stubGroupKey(source, "source", sourceHandleId ?? null);
  const targetGroupKey = stubGroupKey(target, "target", targetHandleId ?? null);

  // Everything this edge needs from the other edges, in one subscription.
  // The helpers read an index built once per edges array, so each is a
  // lookup, and the shallow compare keeps a store update that left this
  // slice alone from re-rendering the edge. Bundles are packed as a string
  // for the same reason.
  const {
    displayLabel,
    parallel,
    bundleKey,
    bundleExpanded,
    sourceRole,
    targetRole,
    sourceGroupWidth,
    targetGroupWidth,
    handleHovered,
  } = useWorkflowStore(
    useShallow((state) => {
      const { source: sb, target: tb } = edgeBundles(id, state.edges);
      const pack = (m: BundleMembership | null) => (m ? `${m.index}|${m.count}|${m.members.join(",")}` : "");
      const members = [...(sb?.members ?? []), ...(tb?.members ?? [])];
      const { selectedIds } = edgeGraphIndex(state.edges);
      const { index, count } = parallelEdgePosition(id, state.edges);
      const h = isHidden ? state.hoveredHandle : null;
      return {
        displayLabel: edgeDisplayLabelById(id, state.edges),
        parallel: count > 1 ? index - (count - 1) / 2 : 0,
        bundleKey: `${pack(sb)}\u0002${pack(tb)}`,
        // Bundles split apart while one of their members is selected
        bundleExpanded: members.some((m) => selectedIds.has(m)),
        sourceRole: isHidden ? hiddenStubRole(id, state.edges, "source", state.expandedStubGroup) : "single",
        targetRole: isHidden ? hiddenStubRole(id, state.edges, "target", state.expandedStubGroup) : "single",
        sourceGroupWidth: isHidden ? state.stubGroupWidths?.[sourceGroupKey] ?? 0 : 0,
        targetGroupWidth: isHidden ? state.stubGroupWidths?.[targetGroupKey] ?? 0 : 0,
        handleHovered:
          Boolean(h) &&
          ((h!.type === "source" && h!.nodeId === source && (h!.handleId ?? null) === (sourceHandleId ?? null)) ||
            (h!.type === "target" && h!.nodeId === target && (h!.handleId ?? null) === (targetHandleId ?? null))),
      };
    })
  );
  // And from the nodes: the clamp position for each end lives on the node
  // that owns the handle, and selection and loading state drive the stroke
  const { sourceReach, targetReach, isConnectedToSelection, isTargetLoading } = useWorkflowStore(
    useShallow((state) => {
      const { byId, selectedIds } = nodeGraphIndex(state.nodes);
      const targetNode = byId.get(target);
      return {
        sourceReach: bundleReach(state.nodes, source, "source", sourceHandleId),
        targetReach: bundleReach(state.nodes, target, "target", targetHandleId),
        isConnectedToSelection: selectedIds.has(source) || selectedIds.has(target),
        isTargetLoading: targetNode?.type === "nanoBanana" && (targetNode.data as NanoBananaNodeData).status === "loading",
      };
    })
  );
  const { setBundleClamp, setExpandedStubGroup, setHoveredHandle, setStubGroupWidth } = useWorkflowStore(
    useShallow((state) => ({
      setBundleClamp: state.setBundleClamp,
      setExpandedStubGroup: state.setExpandedStubGroup,
      setHoveredHandle: state.setHoveredHandle,
      setStubGroupWidth: state.setStubGroupWidth,
    }))
  );
  const stubLabel = displayLabel;

  // Bundles: the noodles sharing a handle leave it as one short stem and
  // split further out, until one of them is selected.
  const bundles = useMemo(() => {
    const unpack = (packed: string, end: "source" | "target"): BundleMembership | null => {
      if (!packed) return null;
      const [index, count, members] = packed.split("|");
      return { end, key: "", index: Number(index), count: Number(count), members: members.split(",") };
    };
    const [sb, tb] = bundleKey.split("\u0002");
    return { source: unpack(sb, "source"), target: unpack(tb, "target") };
  }, [bundleKey]);
  const sourceBundle = bundleExpanded || hookBundle ? null : bundles.source;
  const targetBundle = bundleExpanded || hookBundle ? null : bundles.target;
  const sDir: 1 | -1 = sourcePosition === "left" ? -1 : 1;
  const tDir: 1 | -1 = targetPosition === "right" ? 1 : -1;
  // Where this noodle starts and ends: the stem's far end when bundled
  const startX = sourceBundle ? sourceX + sDir * sourceReach : sourceX;
  const endX = targetBundle ? targetX + tDir * targetReach : targetX;
  // Hidden stubs stack down the side of the node without overlapping, which
  // needs the y of every handle on that side, not just this edge's own
  const sourceHandleY = useHandleY(source, "source", isHidden);
  const targetHandleY = useHandleY(target, "target", isHidden);
  const sourceStack = useWorkflowStore((state) =>
    isHidden ? hiddenStubOffset(id, state.edges, "source", sourceHandleY, sourceY, state.expandedStubGroup) : 0
  );
  const targetStack = useWorkflowStore((state) =>
    isHidden ? hiddenStubOffset(id, state.edges, "target", targetHandleY, targetY, state.expandedStubGroup) : 0
  );
  const measureSourceGroup = useCallback((w: number) => setStubGroupWidth?.(sourceGroupKey, w), [setStubGroupWidth, sourceGroupKey]);
  const measureTargetGroup = useCallback((w: number) => setStubGroupWidth?.(targetGroupKey, w), [setStubGroupWidth, targetGroupKey]);

  const edgeData = data as EdgeData | undefined;
  const offsetX = edgeData?.offsetX ?? 0;
  const offsetY = edgeData?.offsetY ?? 0;
  const hasPause = edgeData?.hasPause ?? false;

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
    if (hookBundle) {
      const direction = targetX >= sourceX ? 1 : -1;
      const reach = 16 * direction;
      const route = edgeStyle === "straight" ? getStraightPath : edgeStyle === "curved" ? getBezierPath : getSmoothStepPath;
      let from = { sourceX: startX, sourceY, sourcePosition };
      let path = "";
      const append = (segment: string) => { path += path ? ` ${segment.replace(/^M[^A-Za-z]*/, "")}` : segment; };
      for (const { x, y } of hookBundles) {
        const [segment] = route({ ...from, targetX: x - reach, targetY: y, targetPosition: direction > 0 ? Position.Left : Position.Right });
        append(segment);
        path += ` L${x + reach},${y}`;
        from = { sourceX: x + reach, sourceY: y, sourcePosition: direction > 0 ? Position.Right : Position.Left };
      }
      append(route({ ...from, targetX: endX, targetY, targetPosition })[0]);
      return [path, hookBundles[0].x, hookBundles[0].y] as [string, number, number];
    }
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
  }, [hookBundle, hookBundles, edgeStyle, edgeData?.isLoop, startX, endX, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, offsetX]);

  // Calculate handle positions on the path segments (only for angular mode)
  const handlePositions = useMemo(() => {
    if (edgeStyle !== "angular" || hookBundle) return [];

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
  }, [hookBundle, edgeStyle, sourceX, sourceY, targetX, targetY, offsetX, offsetY]);

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

  // Labels: only one the user typed sits on the noodle; the automatic type
  // and image-order names stay on the toolbar and the hidden-connection stubs
  const labelText = hasOwnLabel ? displayLabel : "";
  const showLabel = Boolean(labelText) || Boolean(edgeData?.isLoop);

  if (isHidden) {
    if (isConnecting) return null;
    const sourceDir: 1 | -1 = sourcePosition === "left" ? -1 : 1;
    const targetDir: 1 | -1 = targetPosition === "right" ? 1 : -1;
    const stubLength = 8;
    const revealed = stubHovered || handleHovered || Boolean(selected);
    const sourceCollapsed = sourceRole.startsWith("collapsed");
    const targetCollapsed = targetRole.startsWith("collapsed");
    // Stub pills sit just past the handles; the ghost runs between their outer edges
    const sourceStub = { x: sourceX + sourceDir * (stubLength + 4), y: sourceY + sourceStack };
    const targetStub = { x: targetX + targetDir * (stubLength + 4), y: targetY + targetStack };
    const sourceWidth = sourceCollapsed ? sourceGroupWidth : stubWidths.source;
    const targetWidth = targetCollapsed ? targetGroupWidth : stubWidths.target;
    const [ghostPath] = getBezierPath({
      sourceX: sourceStub.x + sourceDir * sourceWidth,
      sourceY: sourceStub.y,
      sourcePosition: sourceDir === 1 ? Position.Right : Position.Left,
      targetX: targetStub.x + targetDir * targetWidth,
      targetY: targetStub.y,
      targetPosition: targetDir === 1 ? Position.Right : Position.Left,
      curvature: 0.25,
    });
    const toolbarStub = toolbarSide === "target" ? targetStub : sourceStub;
    const toolbarDir = toolbarSide === "target" ? targetDir : sourceDir;
    const toolbarWidth = toolbarSide === "target" ? targetWidth : sourceWidth;
    // A collapsed pill acts like its handle: hovering ghosts every member, clicking expands
    const groupStub = (side: "source" | "target") => {
      const nodeId = side === "source" ? source : target;
      const handleId = (side === "source" ? sourceHandleId : targetHandleId) ?? null;
      return {
        label: pluralTypeLabel(handleId),
        title: "Hidden connections, click to expand",
        onHoverChange: (hovering: boolean) => setHoveredHandle(hovering ? { nodeId, handleId, type: side } : null),
        onSelect: () => setExpandedStubGroup(stubGroupKey(nodeId, side, handleId)),
      };
    };
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
          {sourceRole !== "collapsed-member" && (
            <HiddenEdgeStub
              key={sourceCollapsed ? "source-group" : "source-own"}
              side="source"
              x={sourceStub.x}
              y={sourceStub.y}
              direction={sourceDir}
              color={edgeColor}
              onMeasure={sourceCollapsed ? measureSourceGroup : measureSource}
              {...(sourceCollapsed
                ? { ...groupStub("source"), selected: false }
                : { label: stubLabel, selected: Boolean(selected), onHoverChange: setStubHovered, onSelect: () => selectThisEdge("source") })}
            />
          )}
          {targetRole !== "collapsed-member" && (
            <HiddenEdgeStub
              key={targetCollapsed ? "target-group" : "target-own"}
              side="target"
              x={targetStub.x}
              y={targetStub.y}
              direction={targetDir}
              color={edgeColor}
              onMeasure={targetCollapsed ? measureTargetGroup : measureTarget}
              {...(targetCollapsed
                ? { ...groupStub("target"), selected: false }
                : { label: stubLabel, selected: Boolean(selected), onHoverChange: setStubHovered, onSelect: () => selectThisEdge("target") })}
            />
          )}
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

      {selected && carriesToolbar && !hookBundle && <EdgeToolbar edgeId={id} x={labelX} y={labelY} />}
      {hookData.map((handle, index) => {
        const members = hookGroups[index];
        if (!members || members.length < 2 || members[0].id !== id) return null;
        const active = hookBundles.some((handle) => handle.id === activeHookBundleId)
          ? activeHookBundleId : hookBundles[hookBundles.length - 1]?.id;
        return <HookBundleClamp key={handle.id} bundle={handle} members={members.map((e) => e.id)} selected={active === handle.id && members.some((e) => e.selected)} color={edgeColor} />;
      })}

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

      {showLabel && !hookBundle && (
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
function BundleStem({ x, y, dir, reach, count, stroke, strokeOpacity, width, activeStroke, screenToFlowPosition, onReachChange }: BundleStemProps) {
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
    // Capture phase, so the release ends the drag even if something between
    // the clamp and the window stops the event; blur covers a release outside.
    const onUp = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onUp);
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onUp);
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
        {/* The clamp: an outline pill over the split point. A selected
            node or edge lifts the edge's SVG (and so the stem's hit area) above
            the label layer, so the clamp keeps a z-index above any elevated
            edge or it would lose the press to the stem. */}
        <div
          className="nodrag nopan"
          data-testid="edge-bundle-clamp"
          title={`${count} connections · drag to move where the bundle splits`}
          onMouseDown={startClampDrag}
          onClick={(e) => e.stopPropagation()}
          style={{
            ...bundleClampStyle,
            position: "absolute",
            transform: `translate(${splitX}px, ${y}px) translate(-50%, -50%)`,
            pointerEvents: "all",
            zIndex: 2001,
            cursor: "ew-resize",
          }}
        />
      </EdgeLabelRenderer>
    </>
  );
}
