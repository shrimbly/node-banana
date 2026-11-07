import { crossesEdge, type Point } from "./hook";

export type ScreenRect = { x: number; y: number; width: number; height: number };

/** Select the rendered curve, not the usually much larger edge bounding box. */
export function pathIntersectsRect(points: Point[], rect: ScreenRect): boolean {
  const { x, y, width, height } = rect;
  if (points.some((p) => p.x >= x && p.x <= x + width && p.y >= y && p.y <= y + height)) return true;
  const corners = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  return corners.some((p, i) => crossesEdge(p, corners[(i + 1) % 4], points, 0.5));
}
