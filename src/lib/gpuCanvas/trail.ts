/**
 * Classic's controls-card trail (NodeShell's useTrailingOffset) for painted nodes: while a node moves, its controls
 * card (the gap row and the card below the media card) eases after it, closing 40% of the remaining distance per
 * 16.7ms and never more than 18 flow units behind. The scene keeps a smoothed position per moving painted node and
 * draws the part of its image below the media card offset by (smoothed - position).
 */

/** Fraction of the remaining distance the controls close per 16.7ms (NodeShell's TRAIL_EASE). */
export const TRAIL_EASE = 0.4;
/** How far behind the controls may trail, in flow units (NodeShell's TRAIL_MAX). */
export const TRAIL_MAX = 18;

export interface TrailPoint {
  x: number;
  y: number;
}

/** Keeps the smoothed point within TRAIL_MAX of the target (moves `smoothed`). */
export function clampTrail(smoothed: TrailPoint, target: TrailPoint) {
  const dx = smoothed.x - target.x, dy = smoothed.y - target.y, dist = Math.hypot(dx, dy);
  if (dist <= TRAIL_MAX) return;
  smoothed.x = target.x + (dx * TRAIL_MAX) / dist;
  smoothed.y = target.y + (dy * TRAIL_MAX) / dist;
}

/**
 * One frame of the trail, `dt` ms after the last (capped at 64, as NodeShell's): eases `smoothed` toward `target`
 * and clamps it. False once it has settled (within 0.2 on both axes, snapped onto the target).
 */
export function stepTrail(smoothed: TrailPoint, target: TrailPoint, dt: number): boolean {
  const k = 1 - Math.pow(1 - TRAIL_EASE, Math.max(0, Math.min(64, dt)) / 16.7);
  smoothed.x += (target.x - smoothed.x) * k;
  smoothed.y += (target.y - smoothed.y) * k;
  clampTrail(smoothed, target);
  if (Math.abs(smoothed.x - target.x) < 0.2 && Math.abs(smoothed.y - target.y) < 0.2) {
    smoothed.x = target.x;
    smoothed.y = target.y;
    return false;
  }
  return true;
}
