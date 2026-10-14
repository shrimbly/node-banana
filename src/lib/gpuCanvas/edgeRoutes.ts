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
import { hookHandles, insertHookHandle } from "@/lib/edges/hook";
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

/**
 * A cubic's tight horizontal extent [min, max]: its ends and any turning point between them, not its
 * control points (an SVG path's bounding box, which classic's objectBoundingBox gradient spans).
 */
export function cubicXExtent(c: Cubic): [number, number] {
  const [x0, , x1, , x2, , x3] = c;
  let min = Math.min(x0, x3), max = Math.max(x0, x3);
  // dx/dt = a t² + b t + k
  const a = 3 * (-x0 + 3 * x1 - 3 * x2 + x3), b = 6 * (x0 - 2 * x1 + x2), k = 3 * (x1 - x0);
  const roots: number[] = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-k / b);
  } else {
    const disc = b * b - 4 * a * k;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  for (const t of roots) {
    if (t <= 0 || t >= 1) continue;
    const x = cubicAt(c, t).x;
    min = Math.min(min, x);
    max = Math.max(max, x);
  }
  return [min, max];
}

/** A cubic's length, near enough for dashes (the chord and control polygon averaged). */
export function cubicLength(c: Cubic): number {
  const chord = Math.hypot(c[6] - c[0], c[7] - c[1]);
  const polygon = Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]) + Math.hypot(c[6] - c[4], c[7] - c[5]);
  return (chord + polygon) / 2;
}

/** A cubic's arc length, sampled (flow units): for dashes, which must not drift along a curve. */
export function cubicArcLength(c: Cubic, steps = 12): number {
  let length = 0, previous = cubicAt(c, 0);
  for (let s = 1; s <= steps; s++) {
    const p = cubicAt(c, s / steps);
    length += Math.hypot(p.x - previous.x, p.y - previous.y);
    previous = p;
  }
  return length;
}

/** A cubic split in two at t (de Casteljau). */
function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
  const ax = lerp(x0, x1), ay = lerp(y0, y1), bx = lerp(x1, x2), by = lerp(y1, y2), cx = lerp(x2, x3), cy = lerp(y2, y3);
  const dx = lerp(ax, bx), dy = lerp(ay, by), ex = lerp(bx, cx), ey = lerp(by, cy);
  const fx = lerp(dx, ex), fy = lerp(dy, ey);
  return [[x0, y0, ax, ay, dx, dy, fx, fy], [fx, fy, ex, ey, cx, cy, x3, y3]];
}

/**
 * A cubic cut into pieces of about `step` flow units of arc each, so that along each piece its parameter
 * runs near evenly with distance (the scene lays dashes out by the parameter).
 */
export function cubicPieces(c: Cubic, step: number, samples = 32): Cubic[] {
  const lengths = [0];
  let previous = cubicAt(c, 0);
  for (let k = 1; k <= samples; k++) {
    const p = cubicAt(c, k / samples);
    lengths.push(lengths[k - 1] + Math.hypot(p.x - previous.x, p.y - previous.y));
    previous = p;
  }
  const total = lengths[samples];
  const count = Math.min(samples, Math.max(1, Math.ceil(total / step)));
  const pieces: Cubic[] = [];
  let rest = c, done = 0, k = 1;
  for (let j = 1; j < count; j++) {
    // The parameter at this cut's share of the arc, from the sampled lengths.
    const target = (total * j) / count;
    while (lengths[k] < target) k++;
    const t = (k - 1 + (target - lengths[k - 1]) / Math.max(lengths[k] - lengths[k - 1], 1e-9)) / samples;
    // Where t falls within what is left of the cubic.
    const [piece, after] = splitCubic(rest, (t - done) / (1 - done));
    pieces.push(piece);
    rest = after;
    done = t;
  }
  pieces.push(rest);
  return pieces;
}

/** How long (flow units) the pieces of a dashed route are. */
const DASH_PIECE = 40;

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
  /** Its target is loading: it shows the running comet (and so is decorated), at any zoom. */
  running: boolean;
  /**
   * A measured end has no such handle (a removed input, a stale id): React Flow renders no such edge,
   * so it has no segments or stems, and is neither drawn nor taken by a press or a marquee.
   */
  unresolved?: boolean;
}

export interface RouteContext {
  style: EdgeStyle;
  appearance: EdgeAppearance;
  /** The store's edges and nodes (bundles, hooks and clamps are read from them). */
  edges: WorkflowEdge[];
  nodes: readonly WorkflowNode[];
  thicknessPx: number;
  /** A hook sweep under way (the store's hookDrag): the connections it caught route through the fork. */
  hookDrag?: { x: number; y: number; edgeIds: string[] } | null;
}

const POSITIONS: Record<string, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

/** Where an edge leaves its source and enters its target, and which way; `missing` when a measured end has no such handle (its node's mid-side stands in). */
export function edgeAnchors(graph: SceneGraph, e: number): { source: HandleAnchor & { position: Position }; target: HandleAnchor & { position: Position }; missing: boolean } {
  const edge = graph.edges[e];
  const s = graph.nodes[edge.source], t = graph.nodes[edge.target];
  const handles = graph.edgeHandles(e);
  const from = handles?.from ?? { x: s.w, y: s.h / 2 };
  const to = handles?.to ?? { x: 0, y: t.h / 2 };
  return {
    source: { x: s.x + from.x, y: s.y + from.y, position: POSITIONS[from.position ?? "right"] ?? Position.Right },
    target: { x: t.x + to.x, y: t.y + to.y, position: POSITIONS[to.position ?? "left"] ?? Position.Left },
    missing: !handles,
  };
}

/**
 * The x range a route's gradient spans: its noodle's own tight extent, as classic's objectBoundingBox
 * gradient spans the noodle path (from a bundle's split point, not the handle behind its stem).
 */
export function routeGradientRange(route: EdgeRoute): [number, number] {
  if (!route.segments.length) return [Math.min(route.ends[0], route.ends[2]), Math.max(route.ends[0], route.ends[2])];
  let min = Infinity, max = -Infinity;
  for (const c of route.segments) {
    const [lo, hi] = cubicXExtent(c);
    min = Math.min(min, lo);
    max = Math.max(max, hi);
  }
  return [min, max];
}

/** The route of one scene edge, as EditableEdge or ReferenceEdge would draw it. */
export function routeSceneEdge(graph: SceneGraph, e: number, context: RouteContext): EdgeRoute {
  const sceneEdge = graph.edges[e];
  const edge = sceneEdge.edge;
  const data = edge?.data;
  const { source, target, missing } = edgeAnchors(graph, e);
  const hidden = !!data?.hidden;
  const isReference = edge?.type === "reference";
  const width = isReference ? 2 : context.thicknessPx;
  if (missing) {
    return { segments: [], stems: [], ends: [source.x, source.y, target.x, target.y], labelX: (source.x + target.x) / 2, labelY: (source.y + target.y) / 2, width, dashed: false, hidden: false, decorated: false, running: false, unresolved: true };
  }
  const targetNode = edge ? nodeGraphIndex(context.nodes).byId.get(edge.target) : undefined;
  const loading = context.appearance.loadingPulse && (targetNode?.data as { status?: string } | undefined)?.status === "loading";
  if (isReference && !hidden) {
    const [path, labelX, labelY] = routeEdge({ style: "curved", sourceX: source.x, sourceY: source.y, sourcePosition: source.position, targetX: target.x, targetY: target.y, targetPosition: target.position });
    const segments = pathToCubics(path).flatMap((c) => cubicPieces(c, DASH_PIECE));
    return { segments, stems: [], ends: [source.x, source.y, target.x, target.y], labelX, labelY, width, dashed: true, hidden, decorated: false, running: false };
  }
  const stems: EdgeRoute["stems"] = [];
  let startX = source.x, endX = target.x, decorated = hidden || loading || !!data?.hasPause || !!data?.isLoop || !!data?.label?.trim();
  // Hook bundles that gather more than this edge.
  const index = edge ? edgeGraphIndex(context.edges) : null;
  let hooks = edge && index ? hookHandles(data).filter((hook) => (index.hookBundles.get(hook.id)?.length ?? 0) > 1) : [];
  // Mid-sweep, a caught noodle is carried on the fork, as if a handle sat there (EditableEdge's hook-drag handle).
  const drag = context.hookDrag;
  if (edge && drag?.edgeIds.includes(edge.id)) hooks = insertHookHandle(hooks, { id: "hook-drag", x: drag.x, y: drag.y }, source, target);
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
  return { segments: hidden ? [] : pathToCubics(path), stems, ends: [source.x, source.y, target.x, target.y], labelX, labelY, width, dashed: false, hidden, decorated, running: loading && !hidden };
}

/** A route's noodle and its stems as polylines, a point about every `step` flow units (for sweeping across them). */
export function routePolylines(route: EdgeRoute, step: number): { x: number; y: number }[][] {
  const sample = (segments: Cubic[]) => {
    const points: { x: number; y: number }[] = [];
    for (const c of segments) {
      const steps = Math.max(1, Math.ceil(cubicLength(c) / step));
      for (let k = points.length ? 1 : 0; k <= steps; k++) points.push(cubicAt(c, k / steps));
    }
    return points;
  };
  const lines = route.segments.length ? [sample(route.segments)] : [];
  for (const stem of route.stems) lines.push(sample([stem.segment]));
  return lines;
}

/** How far (flow units) past a route's ends and segments its decorations reach: a pause badge, a hidden connection's stubs and ghost. */
const DECORATION_REACH = 100;

/**
 * Which decorated connections near the view go live: every one on screen, whatever their number (classic
 * draws all their decorations), then those in the margin round it, nearest the view's centre first, while
 * fewer than `max` are live in all.
 */
export function pickLiveEdges(candidates: { id: string; distance: number; onScreen: boolean }[], max: number): string[] {
  const ids: string[] = [], margin: { id: string; distance: number }[] = [];
  for (const c of candidates) {
    if (c.onScreen) ids.push(c.id);
    else margin.push(c);
  }
  if (ids.length >= max) return ids;
  margin.sort((p, q) => p.distance - q.distance);
  for (let k = 0; k < margin.length && ids.length < max; k++) ids.push(margin[k].id);
  return ids;
}

/** A floating header's height above its node (FloatingNodeHeader's top offset); the scene paints it for painted nodes. */
export const PAINTED_HEADER_HEIGHT = 26;

/**
 * The painted nodes that cover live connections' decorations, and which of those connections they cover.
 * On classic every node covers the edge layer; the live layer draws a connection's decorations over the
 * scene, so they are masked where a painted node lies over them (LiveLayer). Live nodes cover them themselves.
 */
export function paintedCover(
  graph: SceneGraph,
  edges: Iterable<number>,
  routeOf: (e: number) => EdgeRoute | null,
  nodesWithin: (x0: number, y0: number, x1: number, y1: number) => number[],
  isLive: (id: string) => boolean,
): { edgeIds: string[]; boxes: { x: number; y: number; w: number; h: number }[] } {
  const edgeIds: string[] = [], boxes: { x: number; y: number; w: number; h: number }[] = [], taken = new Set<number>();
  for (const e of edges) {
    const route = routeOf(e);
    if (!route || route.unresolved) continue;
    let [x0, y0, x1, y1] = route.ends;
    [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
    [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
    for (const c of [...route.segments, ...route.stems.map((stem) => stem.segment)]) for (let k = 0; k < 8; k += 2) {
      x0 = Math.min(x0, c[k]); x1 = Math.max(x1, c[k]);
      y0 = Math.min(y0, c[k + 1]); y1 = Math.max(y1, c[k + 1]);
    }
    let covered = false;
    for (const i of nodesWithin(x0 - DECORATION_REACH, y0 - DECORATION_REACH, x1 + DECORATION_REACH, y1 + DECORATION_REACH)) {
      const n = graph.nodes[i];
      if (!n || isLive(n.id)) continue;
      covered = true;
      if (taken.has(i)) continue;
      taken.add(i);
      // The node and its painted header strip: classic's floating headers sit above every edge (z-index 1500).
      boxes.push({ x: n.x, y: n.y - PAINTED_HEADER_HEIGHT, w: n.w, h: n.h + PAINTED_HEADER_HEIGHT });
    }
    if (covered) edgeIds.push(graph.edges[e].id);
  }
  return { edgeIds, boxes };
}
