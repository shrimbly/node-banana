import { createContext } from "react";

/** A box in flow units. */
export interface CoverRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The boxes (flow units) that cover connection labels, when something other than React Flow's own node layer
 * covers them: the GPU canvas's painted nodes, which lie under its live layer. Null on classic, where the node
 * layer stacks over the label renderer by itself and labels are left alone.
 */
export const EdgeLabelCoverContext = createContext<readonly CoverRect[] | null>(null);

/** What of `rect` no box covers, as disjoint rectangles. */
export function uncoveredRects(rect: CoverRect, boxes: readonly CoverRect[]): CoverRect[] {
  let parts: CoverRect[] = [rect];
  for (const b of boxes) {
    const next: CoverRect[] = [];
    for (const r of parts) {
      const x0 = Math.max(r.x, b.x), x1 = Math.min(r.x + r.w, b.x + b.w);
      const y0 = Math.max(r.y, b.y), y1 = Math.min(r.y + r.h, b.y + b.h);
      if (x0 >= x1 || y0 >= y1) {
        next.push(r);
        continue;
      }
      // Above and below the overlap at full width, then left and right of it at the overlap's height.
      if (y0 > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: y0 - r.y });
      if (y1 < r.y + r.h) next.push({ x: r.x, y: y1, w: r.w, h: r.y + r.h - y1 });
      if (x0 > r.x) next.push({ x: r.x, y: y0, w: x0 - r.x, h: y1 - y0 });
      if (x1 < r.x + r.w) next.push({ x: x1, y: y0, w: r.x + r.w - x1, h: y1 - y0 });
    }
    parts = next;
    if (!parts.length) break;
  }
  return parts;
}

/**
 * How a label at `rect` (flow units) shows under the covering boxes: whole (null), not at all ("hidden"),
 * or through a CSS clip-path in the label's own coordinates (its top-left at 0,0).
 */
export function labelClip(rect: CoverRect, boxes: readonly CoverRect[]): null | "hidden" | string {
  const parts = uncoveredRects(rect, boxes);
  if (parts.length === 1 && parts[0] === rect) return null;
  if (!parts.length) return "hidden";
  const d = parts.map((p) => `M${p.x - rect.x} ${p.y - rect.y}h${p.w}v${p.h}h${-p.w}Z`).join("");
  return `path("${d}")`;
}
