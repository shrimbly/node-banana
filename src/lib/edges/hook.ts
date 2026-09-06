export type Point = { x: number; y: number };

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

const crook = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M12 29V9a6 6 0 1 1 12 0v3a3 3 0 0 1-6 0" fill="none" stroke="#171717" stroke-width="5" stroke-linecap="round"/><path d="M12 29V9a6 6 0 1 1 12 0v3a3 3 0 0 1-6 0" fill="none" stroke="#fafafa" stroke-width="2.5" stroke-linecap="round"/></svg>';
export const HOOK_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(crook)}") 20 12, crosshair`;
