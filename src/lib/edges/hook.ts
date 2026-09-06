import type { WorkflowEdgeData } from "@/types";

export type Point = { x: number; y: number };
export type HookHandle = Point & { id: string };
const EMPTY_HANDLES: HookHandle[] = [];

export function hookHandles(data?: WorkflowEdgeData): HookHandle[] {
  return data?.hookBundles ?? (data?.hookBundle ? [data.hookBundle] : EMPTY_HANDLES);
}

export function withHookHandles(data: WorkflowEdgeData | undefined, handles: HookHandle[]): WorkflowEdgeData {
  const { hookBundle: _legacy, hookBundles: _handles, ...rest } = data ?? {};
  void _legacy;
  void _handles;
  return handles.length ? { ...rest, hookBundles: handles } : rest;
}

/** Insert at the nearest part of the route, preserving existing handle order. */
export function insertHookHandle(handles: HookHandle[], handle: HookHandle, source: Point, target: Point) {
  const points = [source, ...handles, target];
  let index = 0;
  let nearest = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const distance = distanceToSegment(handle, points[i], points[i + 1]);
    if (distance < nearest) { nearest = distance; index = i; }
  }
  return [...handles.slice(0, index), handle, ...handles.slice(index)];
}

function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Swept pointer segment against a sampled edge, including fast pointer moves. */
export function crossesEdge(from: Point, to: Point, points: Point[], tolerance = 6) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const c1 = cross(from, to, a), c2 = cross(from, to, b);
    const c3 = cross(a, b, from), c4 = cross(a, b, to);
    if (c1 * c2 < 0 && c3 * c4 < 0) return true;
    if (Math.min(distanceToSegment(a, from, to), distanceToSegment(b, from, to),
      distanceToSegment(from, a, b), distanceToSegment(to, a, b)) <= tolerance) return true;
  }
  return false;
}

// The fork the sweep is made with, drawn to Lucide's rules (24px grid, 2px
// stroke, round caps and joins). It is rendered as an element that follows the
// pointer rather than as a native cursor image, so it can ease between sizes;
// the tip of the tines is the hotspot.
export const FORK_PATHS = ["M5 2v6a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V2", "M8 2v9", "M8 11v11"];
export const FORK_SIZE = 32;
/** Hotspot (8, 2) on the 24 grid, scaled to the rendered size. */
export const FORK_HOTSPOT = { x: (8 * FORK_SIZE) / 24, y: (2 * FORK_SIZE) / 24 };
