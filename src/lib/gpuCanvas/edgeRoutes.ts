/**
 * Connections as the GPU canvas draws them: each edge's path (from the same
 * route the SVG edges take, src/lib/edges/route.ts) as cubic segments the
 * scene instances, plus what the scene needs to know about it.
 *
 * The scene draws every connection's stroke. Anything more a connection
 * shows (a label, hidden-connection stubs, a bundle's clamp, a pause badge,
 * the running comet, the toolbar) is the real edge component's, on the live
 * layer, so such an edge is `decorated`: while it is on screen the live layer
 * renders it and the scene leaves it out.
 */
import { Position } from "@xyflow/react";
import type { EdgeAppearance, EdgeStyle, WorkflowEdge, WorkflowNode } from "@/types";
import { routeEdge } from "@/lib/edges/route";
import { bundleReach, edgeBundles } from "@/lib/edges/bundles";
import { edgeGraphIndex, nodeGraphIndex } from "@/lib/edges/graphIndex";
import { hookHandles } from "@/lib/edges/hook";
import type { HandleAnchor, SceneGraph } from "./graph";

/** A cubic segment: start, two controls, end (flow units). */
export type Cubic = [number, number, number, number, number, number, number, number];

/** Parses an absolute SVG path (M, L, Q, C, as React Flow's path helpers write them) into cubics. */
export function pathToCubics(d: string): Cubic[] {
  const out: Cubic[] = [];
  const tokens = d.match(/[MLQCZmlqcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0, x = 0, y = 0, command = "M";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++].toUpperCase();
    if (command === "Z") continue;
    if (i >= tokens.length || /[A-Za-z]/.test(tokens[i])) continue;
    if (command === "M") {
      x = num();
      y = num();
      // Further pairs after a move are lines.
      command = "L";
    } else if (command === "L") {
      const nx = num(), ny = num();
      if (nx !== x || ny !== y) out.push([x, y, x + (nx - x) / 3, y + (ny - y) / 3, x + (2 * (nx - x)) / 3, y + (2 * (ny - y)) / 3, nx, ny]);
      x = nx;
      y = ny;
    } else if (command === "Q") {
      const qx = num(), qy = num(), nx = num(), ny = num();
      out.push([x, y, x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny]);
      x = nx;
      y = ny;
    } else if (command === "C") {
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), nx = num(), ny = num();
      out.push([x, y, c1x, c1y, c2x, c2y, nx, ny]);
      x = nx;
      y = ny;
    } else i++;
  }
  return out;
}

/** A point on a cubic. */
export function cubicAt(c: Cubic, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
    y: u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7],
  };
}

/** A cubic's length, near enough for dashes (the chord and control polygon averaged). */
export function cubicLength(c: Cubic): number {
  const chord = Math.hypot(c[6] - c[0], c[7] - c[1]);
  const polygon = Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]) + Math.hypot(c[6] - c[4], c[7] - c[5]);
  return (chord + polygon) / 2;
}

/** The distance from a point to a cubic, sampled (flow units). */
export function distanceToCubic(c: Cubic, x: number, y: number, steps = 24): number {
  let best = Infinity;
  let previous = cubicAt(c, 0);
  for (let s = 1; s <= steps; s++) {
    const p = cubicAt(c, s / steps);
    const dx = p.x - previous.x, dy = p.y - previous.y;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - previous.x) * dx + (y - previous.y) * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(previous.x + t * dx - x, previous.y + t * dy - y));
    previous = p;
  }
  return best;
}

export interface EdgeRoute {
  /** The noodle. */
  segments: Cubic[];
  /** Bundle stems this edge draws (the first member of each bundle), as straight cubics, with their width. */
  stems: { segment: Cubic; width: number }[];
  /** Where it leaves its source and enters its target: x, y, x, y (flow units). */
  ends: [number, number, number, number];
  /** Where the toolbar goes when the edge is selected (flow units). */
  labelX: number;
  labelY: number;
  width: number;
  dashed: boolean;
  /** Not drawn by the scene at all (a hidden connection: stubs only, on the live layer). */
  hidden: boolean;
  /** Shows more than its stroke; see the top of this file. */
  decorated: boolean;
}

export interface RouteContext {
  style: EdgeStyle;
  appearance: EdgeAppearance;
  /** The store's edges and nodes (bundles, hooks and clamps are read from them). */
  edges: WorkflowEdge[];
  nodes: readonly WorkflowNode[];
  thicknessPx: number;
}

const POSITIONS: Record<string, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

/** Where an edge leaves its source and enters its target, and which way. */
export function edgeAnchors(graph: SceneGraph, e: number): { source: HandleAnchor & { position: Position }; target: HandleAnchor & { position: Position } } {
  const edge = graph.edges[e];
  const s = graph.nodes[edge.source], t = graph.nodes[edge.target];
  const from = s.handles?.get(`source:${edge.sourceHandle ?? ""}`) ?? { x: s.w, y: s.h / 2 };
  const to = t.handles?.get(`target:${edge.targetHandle ?? ""}`) ?? { x: 0, y: t.h / 2 };
  return {
    source: { x: s.x + from.x, y: s.y + from.y, position: POSITIONS[from.position ?? "right"] ?? Position.Right },
    target: { x: t.x + to.x, y: t.y + to.y, position: POSITIONS[to.position ?? "left"] ?? Position.Left },
  };
}

/** The route of one scene edge, as EditableEdge or ReferenceEdge would draw it. */
export function routeSceneEdge(graph: SceneGraph, e: number, context: RouteContext): EdgeRoute {
  const sceneEdge = graph.edges[e];
  const edge = sceneEdge.edge;
  const data = edge?.data;
  const { source, target } = edgeAnchors(graph, e);
  const hidden = !!data?.hidden;
  const isReference = edge?.type === "reference";
  const width = isReference ? 2 : context.thicknessPx;
  const targetNode = edge ? nodeGraphIndex(context.nodes).byId.get(edge.target) : undefined;
  const loading = context.appearance.loadingPulse && (targetNode?.data as { status?: string } | undefined)?.status === "loading";
  if (isReference && !hidden) {
    const [path, labelX, labelY] = routeEdge({ style: "curved", sourceX: source.x, sourceY: source.y, sourcePosition: source.position, targetX: target.x, targetY: target.y, targetPosition: target.position });
    return { segments: pathToCubics(path), stems: [], ends: [source.x, source.y, target.x, target.y], labelX, labelY, width, dashed: true, hidden, decorated: false };
  }
  const stems: EdgeRoute["stems"] = [];
  let startX = source.x, endX = target.x, decorated = hidden || loading || !!data?.hasPause || !!data?.isLoop || !!data?.label?.trim();
  // Hook bundles that gather more than this edge.
  const index = edge ? edgeGraphIndex(context.edges) : null;
  const hooks = edge && index ? hookHandles(data).filter((hook) => (index.hookBundles.get(hook.id)?.length ?? 0) > 1) : [];
  if (hooks.length) decorated = true;
  else if (edge && !hidden) {
    // Bundles split apart while one of their members is selected.
    const bundles = edgeBundles(edge.id, context.edges);
    const members = [...(bundles.source?.members ?? []), ...(bundles.target?.members ?? [])];
    const expanded = members.some((id) => index?.selectedIds.has(id));
    for (const [end, bundle] of [["source", bundles.source], ["target", bundles.target]] as const) {
      if (!bundle || expanded) continue;
      // A bundle's count and clamp sit on its stem.
      decorated = true;
      const anchor = end === "source" ? source : target;
      const dir = end === "source" ? (anchor.position === Position.Left ? -1 : 1) : (anchor.position === Position.Right ? 1 : -1);
      const reach = bundleReach(context.nodes as WorkflowNode[], end === "source" ? edge.source : edge.target, end, end === "source" ? edge.sourceHandle : edge.targetHandle);
      if (end === "source") startX = anchor.x + dir * reach;
      else endX = anchor.x + dir * reach;
      if (bundle.index === 0) {
        const stemWidth = width * (1 + Math.min(bundle.count - 1, 4) * 0.5);
        stems.push({ segment: pathToCubics(`M${anchor.x},${anchor.y} L${anchor.x + dir * reach},${anchor.y}`)[0], width: stemWidth });
      }
    }
    // An Array item's name rides at the target end.
    if (graph.nodes[sceneEdge.source]?.type === "array") decorated = true;
  }
  const [path, labelX, labelY] = routeEdge({
    style: context.style,
    sourceX: source.x, sourceY: source.y, sourcePosition: source.position,
    targetX: target.x, targetY: target.y, targetPosition: target.position,
    startX, endX, isLoop: data?.isLoop, offsetX: (data as { offsetX?: number } | undefined)?.offsetX ?? 0,
    hooks: hooks.length ? hooks : undefined,
  });
  return { segments: hidden ? [] : pathToCubics(path), stems, ends: [source.x, source.y, target.x, target.y], labelX, labelY, width, dashed: false, hidden, decorated };
}
