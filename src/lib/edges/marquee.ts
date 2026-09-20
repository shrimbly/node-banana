import { crossesEdge, type Point } from "./hook";

export type ScreenRect = { x: number; y: number; width: number; height: number };

/** Select the rendered curve, not the usually much larger edge bounding box. */
export function pathIntersectsRect(points: Point[], rect: ScreenRect): boolean {
  const { x, y, width, height } = rect;
  if (points.some((p) => p.x >= x && p.x <= x + width && p.y >= y && p.y <= y + height)) return true;
  const corners = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  return corners.some((p, i) => crossesEdge(p, corners[(i + 1) % 4], points, 0.5));
}

export function sampleEdgePaths(canvas: HTMLElement, eligible: Set<string>) {
  const paths: { id: string; points: Point[] }[] = [];
  canvas.querySelectorAll<SVGPathElement>(".react-flow__edge .react-flow__edge-path").forEach((path) => {
    const id = path.closest(".react-flow__edge")?.getAttribute("data-id");
    const matrix = path.getScreenCTM();
    if (!id || !eligible.has(id) || !matrix) return;
    const length = path.getTotalLength();
    const steps = Math.max(1, Math.ceil(length * Math.hypot(matrix.a, matrix.b) / 4));
    paths.push({ id, points: Array.from({ length: steps + 1 }, (_, i) => {
      const p = path.getPointAtLength(length * i / steps);
      return { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f };
    }) });
  });
  return paths;
}
