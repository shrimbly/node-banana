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

// A compact, tilted crook with an open bowl; the hook tip is the hotspot.
const crook = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><linearGradient id="metal" x1="9" y1="4" x2="22" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="#b8c4d0"/></linearGradient></defs><path d="M10 28 18.5 10.5C21.5 4.5 16 1.5 12.5 4.5 10.5 6.2 10.3 8.5 12 10" fill="none" stroke="#101820" stroke-opacity=".9" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 28 18.5 10.5C21.5 4.5 16 1.5 12.5 4.5 10.5 6.2 10.3 8.5 12 10" fill="none" stroke="url(#metal)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="10" r="1.3" fill="#fff"/></svg>';
export const HOOK_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(crook)}") 12 10, crosshair`;
