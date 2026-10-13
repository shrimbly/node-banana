/**
 * The path a connection takes: the edge style (curved, angular, straight),
 * a loop's arc under its nodes, a hook bundle's detour through its hooks,
 * and a bundle's stem. One function, so the SVG edges (EditableEdge) and the
 * GPU canvas draw the same line.
 */
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from "@xyflow/react";
import type { EdgeStyle } from "@/types";

export interface EdgeRouteParams {
  style: EdgeStyle;
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  /** Where the noodle starts and ends: the stem's far end when the handle is bundled, else the handle. */
  startX?: number;
  endX?: number;
  isLoop?: boolean;
  /** The angular style's middle segment, moved by its drag handle. */
  offsetX?: number;
  /** Hook bundles the connection detours through, in order (flow units). */
  hooks?: readonly { x: number; y: number }[];
}

/** The SVG path and the label's position. */
export function routeEdge(params: EdgeRouteParams): [path: string, labelX: number, labelY: number] {
  const { style, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, isLoop, offsetX = 0, hooks } = params;
  const startX = params.startX ?? sourceX;
  const endX = params.endX ?? targetX;
  if (hooks && hooks.length > 0) {
    const direction = targetX >= sourceX ? 1 : -1;
    const reach = 16 * direction;
    const route = style === "straight" ? getStraightPath : style === "curved" ? getBezierPath : getSmoothStepPath;
    let from = { sourceX: startX, sourceY, sourcePosition };
    let path = "";
    const append = (segment: string) => { path += path ? ` ${segment.replace(/^M[^A-Za-z]*/, "")}` : segment; };
    for (const { x, y } of hooks) {
      const [segment] = route({ ...from, targetX: x - reach, targetY: y, targetPosition: direction > 0 ? Position.Left : Position.Right });
      append(segment);
      path += ` L${x + reach},${y}`;
      from = { sourceX: x + reach, sourceY: y, sourcePosition: direction > 0 ? Position.Right : Position.Left };
    }
    append(route({ ...from, targetX: endX, targetY, targetPosition })[0]);
    return [path, hooks[0].x, hooks[0].y];
  }
  // Loop edges: smooth arc that exits/enters along handle directions, bowed below nodes
  if (isLoop) {
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
    return [path, lx, ly];
  }
  if (style === "straight") {
    const [path, labelX, labelY] = getStraightPath({ sourceX: startX, sourceY, targetX: endX, targetY });
    return [path, labelX, labelY];
  }
  if (style === "curved") {
    const [path, labelX, labelY] = getBezierPath({ sourceX: startX, sourceY, sourcePosition, targetX: endX, targetY, targetPosition, curvature: 0.25 });
    return [path, labelX, labelY];
  }
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX: startX, sourceY, sourcePosition, targetX: endX, targetY, targetPosition, borderRadius: 8, offset: offsetX });
  return [path, labelX, labelY];
}
