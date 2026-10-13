/**
 * The painter's queue and the arithmetic around it: image tiers, the order
 * requests are painted in, and how a batch is packed onto a sheet. No DOM or
 * GPU here, so it is unit tested.
 *
 * Images come in tiers by scale (device pixels per flow unit): 1/8 for every
 * node, kept for good, and 1/4, 1/2 and up to the device pixel ratio for
 * nodes near the view. A node is drawn with the smallest tier it holds that
 * is as sharp as its size on screen needs.
 */

export const EIGHTH = 0.125;

/** A change, or a paint someone waits on; the view's tier; the background 1/8 pass; the zoomed-out tier painted for the disk cache. */
export const URGENT = 0, VIEW = 1, BACKGROUND = 2, PREFETCH = 3;

export interface PaintRequest {
  id: string;
  tier: number;
  priority: number;
  queuedAt: number;
  seq: number;
}

/** The tiers for a display scale (device pixels per css px): 1/8 up to the scale itself. */
export function tiersFor(scale: number): number[] {
  return [...[EIGHTH, 0.25, 0.5, 1, 2].filter((t) => t < scale - 0.01), scale];
}

/** The smallest tier as sharp as a zoom needs on this display. */
export function wantedTier(zoom: number, scale: number, tiers: readonly number[]): number {
  const need = zoom * scale;
  return tiers.find((t) => t >= need - 1e-6) ?? tiers[tiers.length - 1];
}

/** Of the tiers a node holds, the one to draw: the smallest that is sharp enough, else the sharpest. */
export function tierToShow(held: Iterable<number>, wanted: number): number | undefined {
  let best: number | undefined;
  for (const tier of held) {
    if (best === undefined) {
      best = tier;
      continue;
    }
    const enough = tier >= wanted, bestEnough = best >= wanted;
    if (enough && (!bestEnough || tier < best)) best = tier;
    else if (!enough && !bestEnough && tier > best) best = tier;
  }
  return best;
}

export class PaintQueue {
  private queued = new Map<string, PaintRequest>();
  private seq = 0;

  get size() {
    return this.queued.size;
  }

  /** Whether a change is waiting to be painted. */
  hasUrgent() {
    for (const request of this.queued.values()) if (request.priority === URGENT) return true;
    return false;
  }

  has(id: string, tier: number) {
    return this.queued.has(`${id}:${tier}`);
  }

  /** Queues a paint, or raises the priority of one already queued. */
  add(id: string, tier: number, priority: number, now: number) {
    const key = `${id}:${tier}`;
    const existing = this.queued.get(key);
    if (existing) {
      if (priority < existing.priority) {
        existing.priority = priority;
        existing.queuedAt = now;
      }
      return;
    }
    this.queued.set(key, { id, tier, priority, queuedAt: now, seq: this.seq++ });
  }

  /** Puts requests back that a batch took but did not paint, keeping their place. */
  restore(requests: readonly PaintRequest[]) {
    for (const request of requests) {
      const key = `${request.id}:${request.tier}`;
      const existing = this.queued.get(key);
      if (!existing || request.priority < existing.priority) this.queued.set(key, request);
    }
  }

  delete(id: string, tier?: number) {
    if (tier != null) {
      this.queued.delete(`${id}:${tier}`);
      return;
    }
    for (const [key, request] of this.queued) if (request.id === id) this.queued.delete(key);
  }

  /** Drops requests that `keep` refuses. */
  filter(keep: (request: PaintRequest) => boolean) {
    for (const [key, request] of this.queued) if (!keep(request)) this.queued.delete(key);
  }

  /** The most urgent requests in order: by priority, then first come. */
  ordered(): PaintRequest[] {
    return [...this.queued.values()].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  /**
   * Takes the first request's tier and as many more of that tier as `fits`
   * accepts (in order), at most `max` (or `max(tier, priority)` of the first). An urgent batch takes only urgent
   * requests, so a change is not held up by a full sheet of others. Taken
   * requests leave the queue.
   */
  take(max: number | ((tier: number, priority: number) => number), fits: (request: PaintRequest, taken: readonly PaintRequest[]) => boolean): PaintRequest[] {
    const queue = this.ordered();
    if (!queue.length) return [];
    const { tier, priority } = queue[0];
    const limit = typeof max === "number" ? max : max(tier, priority);
    const taken: PaintRequest[] = [];
    for (const request of queue) {
      if (request.tier !== tier || (priority === URGENT && request.priority !== URGENT)) continue;
      if (taken.length >= limit) break;
      if (!fits(request, taken)) {
        if (taken.length) break;
        // A first image too large for the sheet still goes, alone; it is squeezed.
      }
      taken.push(request);
      this.queued.delete(`${request.id}:${tier}`);
    }
    return taken;
  }
}

export interface SheetBox {
  /** Size in flow units (node plus header and margins). */
  w: number;
  h: number;
}

/**
 * Shelf-packs boxes left to right, top to bottom, onto a sheet of the given
 * size in flow units. Boxes that do not fit are left out of the result.
 */
/** Flow units sheet positions are rounded up to (1/8 is the smallest tier). */
export const SHEET_ALIGN = 8;

export function packSheet<K>(boxes: readonly (SheetBox & { key: K })[], width: number, height: number, gap: number, align = SHEET_ALIGN): Map<K, { x: number; y: number }> {
  // Every box starts on a multiple of `align` flow units, so at any tier down
  // to 1/8 it starts on a whole texel and is copied without resampling.
  const up = (v: number) => Math.ceil(v / align) * align;
  const placed = new Map<K, { x: number; y: number }>();
  let x = 0, y = 0, row = 0;
  for (const box of boxes) {
    if (x > 0 && x + box.w > width) {
      x = 0;
      y = up(y + row + gap);
      row = 0;
    }
    if (y + box.h > height && placed.size) continue;
    placed.set(box.key, { x, y });
    x = up(x + box.w + gap);
    row = Math.max(row, box.h);
  }
  return placed;
}
