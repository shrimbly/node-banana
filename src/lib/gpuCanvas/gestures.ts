/**
 * What a press on the GPU canvas does, decided as today's canvas decides it
 * from the navigation settings (WorkflowCanvas's React Flow props), and the
 * hit tests the scene's editing needs: handles, and what a marquee takes.
 */
import type { CanvasNavigationSettings } from "@/types/canvas";
import { contains, type Box } from "@/lib/nodes/marqueeSelection";
import type { SceneGraph } from "./graph";

export type PaneAction = "pan" | "select" | null;

export interface PaneModifiers {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Space is held (the "space" pan mode's key). */
  space: boolean;
}

/**
 * What a drag on empty canvas does. Mirrors React Flow as WorkflowCanvas
 * configures it: `selectionKeyCode` (Shift, or Alt for "altDrag") draws a
 * marquee; `panActivationKeyCode` (Space in "space" mode) pans; otherwise
 * `panOnDrag` (left and middle when "always", or by default off the Mac; the
 * right button in "middleMouse" mode) pans, and `selectionOnDrag` (on the
 * Mac, unless a drag mode or "always" is set) draws a marquee.
 */
export function paneDragAction(settings: CanvasNavigationSettings, modifiers: PaneModifiers, isMac: boolean): PaneAction {
  const { button } = modifiers;
  const selectionKey = settings.selectionMode === "altDrag" ? modifiers.altKey : modifiers.shiftKey;
  if (button === 0 && selectionKey) return "select";
  if (settings.panMode === "space" && modifiers.space && (button === 0 || button === 1)) return "pan";
  const panButtons = settings.panMode === "always" ? [0, 1] : settings.panMode === "middleMouse" ? [2] : isMac ? [] : [0, 1];
  if (panButtons.includes(button)) return "pan";
  const selectionOnDrag = settings.selectionMode === "altDrag" || settings.selectionMode === "shiftDrag" ? false : settings.panMode === "always" ? false : isMac;
  if (button === 0 && selectionOnDrag) return "select";
  return null;
}

export interface HandleHit {
  node: number;
  /** The handle's id ("" for a handle without one). */
  handleId: string;
  type: "source" | "target";
  x: number;
  y: number;
}

/**
 * The measured handle nearest a flow point within `reach` (flow units), over
 * the given nodes. Handles are known for nodes that have been painted.
 */
export function handleAt(graph: SceneGraph, nodes: Iterable<number>, x: number, y: number, reach: number): HandleHit | null {
  let best: HandleHit | null = null, bestDistance = reach;
  for (const i of nodes) {
    const n = graph.nodes[i];
    if (!n?.handles) continue;
    for (const [key, anchor] of n.handles) {
      const ax = n.x + anchor.x, ay = n.y + anchor.y;
      const distance = Math.hypot(ax - x, ay - y);
      if (distance > bestDistance) continue;
      const colon = key.indexOf(":");
      bestDistance = distance;
      best = { node: i, handleId: key.slice(colon + 1), type: key.slice(0, colon) as "source" | "target", x: ax, y: ay };
    }
  }
  return best;
}

/**
 * The nodes a marquee takes (flow units): it must hold the node's media
 * card whole, or the node whole when it has none (marqueeSelection.ts).
 */
export function marqueeNodes(graph: SceneGraph, candidates: Iterable<number>, marquee: Box): number[] {
  const taken: number[] = [];
  for (const i of candidates) {
    const n = graph.nodes[i];
    const card = n.card;
    const box: Box = card
      ? { left: n.x + card.x, top: n.y + card.y, right: n.x + card.x + card.w, bottom: n.y + card.y + card.h }
      : { left: n.x, top: n.y, right: n.x + n.w, bottom: n.y + n.h };
    if (contains(marquee, box)) taken.push(i);
  }
  return taken;
}
