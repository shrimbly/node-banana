/**
 * What a press on the GPU canvas does, decided as today's canvas decides it
 * from the navigation settings (WorkflowCanvas's React Flow props), and the
 * hit tests the scene's editing needs: handles, and what a marquee takes.
 */
import type { CanvasNavigationSettings } from "@/types/canvas";
import { contains, type Box } from "@/lib/nodes/marqueeSelection";
import { Position } from "@xyflow/react";
import { resolveHandle, type HandleAnchor, type SceneGraph } from "./graph";
import { edgeAnchors } from "./edgeRoutes";

export type PaneAction = "pan" | "select" | null;

export interface PaneModifiers {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Control is held: d3-zoom's default filter starts no pan with it. */
  ctrlKey: boolean;
  /** Space is held (the "space" pan mode's key). */
  space: boolean;
}

/**
 * What a drag on empty canvas does. Mirrors React Flow as WorkflowCanvas
 * configures it: `selectionKeyCode` (Shift, or Alt for "altDrag") draws a
 * marquee; `panActivationKeyCode` (Space in "space" mode) pans; otherwise
 * `panOnDrag` (left and middle when "always", or by default off the Mac; the
 * right button in "middleMouse" mode) pans, and `selectionOnDrag` (on the
 * Mac, unless a drag mode or "always" is set) draws a marquee. A pan never
 * starts with Control held (d3-zoom's default filter, which React Flow keeps),
 * nor with the selection key held (React Flow's `!selectionKeyPressed && panOnDrag`).
 */
export function paneDragAction(settings: CanvasNavigationSettings, modifiers: PaneModifiers, isMac: boolean): PaneAction {
  const { button } = modifiers;
  if (settings.selectionMode === "altDrag" ? modifiers.altKey : modifiers.shiftKey) return button === 0 ? "select" : null;
  if (settings.panMode === "space" && modifiers.space && (button === 0 || button === 1)) return modifiers.ctrlKey ? null : "pan";
  const panButtons = settings.panMode === "always" ? [0, 1] : settings.panMode === "middleMouse" ? [2] : isMac ? [] : [0, 1];
  if (panButtons.includes(button)) return modifiers.ctrlKey ? null : "pan";
  const selectionOnDrag = settings.selectionMode === "altDrag" || settings.selectionMode === "shiftDrag" ? false : settings.panMode === "always" ? false : isMac;
  if (button === 0 && selectionOnDrag) return "select";
  return null;
}

/**
 * A left press with React Flow's `selectionKeyCode` held (Shift, or Alt for
 * "altDrag"). Unlike `selectionOnDrag`, which draws a marquee only from empty
 * canvas, it starts a selection over nodes and connections too.
 */
export function selectionKeyHeld(settings: CanvasNavigationSettings, modifiers: PaneModifiers): boolean {
  return modifiers.button === 0 && (settings.selectionMode === "altDrag" ? modifiers.altKey : modifiers.shiftKey);
}

export interface HandleHit {
  node: number;
  /** The handle's id ("" for a handle without one). */
  handleId: string;
  type: "source" | "target";
  /** Its anchor, where an edge meets it (flow units). */
  x: number;
  y: number;
  /** Its box's centre (flow units): where React Flow ends a connection line and opens the handle's menu. */
  cx: number;
  cy: number;
  /** Whether a connection may end on it. */
  connectableEnd: boolean;
}

/** A socket's reach round its box's centre: the 30×34 ellipse of `.react-flow__handle.socket::before` (globals.css). */
const SOCKET_REACH_X = 15;
const SOCKET_REACH_Y = 17;

function handleHit(graph: SceneGraph, i: number, key: string, anchor: HandleAnchor): HandleHit {
  const n = graph.nodes[i], colon = key.indexOf(":"), box = anchor.box;
  const x = n.x + anchor.x, y = n.y + anchor.y;
  return {
    node: i, handleId: key.slice(colon + 1), type: key.slice(0, colon) as "source" | "target", x, y,
    cx: box ? n.x + box.x + box.w / 2 : x, cy: box ? n.y + box.y + box.h / 2 : y,
    connectableEnd: anchor.connectableEnd !== false,
  };
}

/** A hidden legacy socket: kept for the edges that name it, but no pointer reaches it. */
function takesNoPointer(anchor: HandleAnchor) {
  return anchor.connectableStart === false && anchor.connectableEnd === false;
}

/**
 * The measured handle under a flow point, as the element under the pointer
 * would be on today's canvas: in the handle's box or the socket's ellipse
 * round it, or within `floor` (flow units) of its centre so a small zoom
 * still grabs it. The nearest centre wins. Handles are known for nodes that
 * have been painted (or are live).
 */
export function handleAt(graph: SceneGraph, nodes: Iterable<number>, x: number, y: number, floor: number): HandleHit | null {
  let best: HandleHit | null = null, bestDistance = Infinity;
  for (const i of nodes) {
    const n = graph.nodes[i];
    if (!n?.handles) continue;
    for (const [key, anchor] of n.handles) {
      if (takesNoPointer(anchor)) continue;
      const hit = handleHit(graph, i, key, anchor), box = anchor.box;
      const dx = x - hit.cx, dy = y - hit.cy, distance = Math.hypot(dx, dy);
      const on = distance <= floor || (!!box && ((dx / SOCKET_REACH_X) ** 2 + (dy / SOCKET_REACH_Y) ** 2 <= 1
        || (Math.abs(dx) <= box.w / 2 && Math.abs(dy) <= box.h / 2)));
      if (!on || distance >= bestDistance) continue;
      bestDistance = distance;
      best = hit;
    }
  }
  return best;
}

/**
 * React Flow's getClosestHandle for a connection being drawn: the handle
 * whose centre is nearest a flow point within `radius`, of either kind (on
 * a tie the kind `prefer`), leaving out the one the connection starts from
 * and those it cannot end on.
 */
export function closestHandle(graph: SceneGraph, nodes: Iterable<number>, x: number, y: number, radius: number, prefer: "source" | "target", from?: HandleHit): HandleHit | null {
  let best: HandleHit | null = null, bestDistance = Infinity;
  for (const i of nodes) {
    const n = graph.nodes[i];
    if (!n?.handles) continue;
    for (const [key, anchor] of n.handles) {
      if (anchor.connectableEnd === false) continue;
      const hit = handleHit(graph, i, key, anchor);
      if (from && hit.node === from.node && hit.type === from.type && hit.handleId === from.handleId) continue;
      const distance = Math.hypot(x - hit.cx, y - hit.cy);
      if (distance > radius || distance > bestDistance || (distance === bestDistance && (hit.type !== prefer || best?.type === prefer))) continue;
      bestDistance = distance;
      best = hit;
    }
  }
  return best;
}

/** The handle at one end of a connection, as a press on it would find it (its anchor where it is not measured yet). */
export function edgeEndHandle(graph: SceneGraph, e: number, end: "source" | "target"): HandleHit {
  const edge = graph.edges[e], i = end === "source" ? edge.source : edge.target;
  const handleId = (end === "source" ? edge.sourceHandle : edge.targetHandle) ?? "";
  const resolved = resolveHandle(graph.nodes[i], end, handleId);
  // At the handle the edge resolves to, under the id the edge names (none: the first of its kind's place).
  if (resolved) return { ...handleHit(graph, i, resolved[0], resolved[1]), handleId };
  const { x, y } = edgeAnchors(graph, e)[end];
  return { node: i, handleId, type: end, x, y, cx: x, cy: y, connectableEnd: true };
}

/** React Flow's reconnectRadius: the circle round each end of a connection that a press takes to move that end. */
export const RECONNECT_RADIUS = 10;

/**
 * The end of a connection under a flow point, as React Flow's EdgeUpdateAnchors
 * place them: a circle of RECONNECT_RADIUS round each end, shifted as far
 * outward along its handle's side. `nodes` are the nodes near the point (the
 * ends sit on their sides). The nearest centre wins.
 */
export function edgeEndAt(graph: SceneGraph, nodes: Iterable<number>, x: number, y: number): { edge: number; end: "source" | "target" } | null {
  let best: { edge: number; end: "source" | "target" } | null = null, bestDistance = Infinity;
  for (const i of nodes) {
    for (const e of graph.edgesOf[i] ?? []) {
      const edge = graph.edges[e];
      // React Flow renders no hidden edge, and none whose reconnectable is off.
      if (!edge || edge.edge.hidden || edge.edge.reconnectable === false) continue;
      const anchors = edgeAnchors(graph, e);
      // Nor one whose handle is missing (React Flow draws no such edge, nor its anchors).
      if (anchors.missing) continue;
      for (const end of ["source", "target"] as const) {
        if ((end === "source" ? edge.source : edge.target) !== i) continue;
        const { x: ax, y: ay, position } = anchors[end];
        const cx = ax + (position === Position.Left ? -RECONNECT_RADIUS : position === Position.Right ? RECONNECT_RADIUS : 0);
        const cy = ay + (position === Position.Top ? -RECONNECT_RADIUS : position === Position.Bottom ? RECONNECT_RADIUS : 0);
        const distance = Math.hypot(x - cx, y - cy);
        if (distance > RECONNECT_RADIUS || distance >= bestDistance) continue;
        bestDistance = distance;
        best = { edge: e, end };
      }
    }
  }
  return best;
}

/**
 * React Flow's calcAutoPan: how far (css px a frame) to pan while a connection
 * is drawn with the pointer within `distance` of the canvas's edge, faster the
 * nearer it is. `at` is the pointer in the canvas's css pixels.
 */
export function autoPanVelocity(at: { x: number; y: number }, size: { width: number; height: number }, speed = 15, distance = 40): [number, number] {
  const velocity = (value: number, min: number, max: number) => {
    if (value < min) return (Math.min(Math.max(Math.abs(value - min), 1), min) / min) * speed;
    if (value > max) return (-Math.min(Math.max(Math.abs(value - max), 1), min) / min) * speed;
    return 0;
  };
  return [velocity(at.x, distance, size.width - distance), velocity(at.y, distance, size.height - distance)];
}

export type CardBox = { x: number; y: number; w: number; h: number } | null;

/**
 * The nodes a marquee takes (flow units): it must hold the node's media
 * card whole, or the node whole when it has none (marqueeSelection.ts).
 * `cards` holds cards measured as they show now (live nodes), which win
 * over the painted ones; null is a node with no card.
 */
export function marqueeNodes(graph: SceneGraph, candidates: Iterable<number>, marquee: Box, cards?: ReadonlyMap<number, CardBox>): number[] {
  const taken: number[] = [];
  for (const i of candidates) {
    const n = graph.nodes[i];
    const card = cards?.has(i) ? cards.get(i) : n.card;
    const box: Box = card
      ? { left: n.x + card.x, top: n.y + card.y, right: n.x + card.x + card.w, bottom: n.y + card.y + card.h }
      : { left: n.x, top: n.y, right: n.x + n.w, bottom: n.y + n.h };
    if (contains(marquee, box)) taken.push(i);
  }
  return taken;
}
