/**
 * Where painted node images go in the atlas: a texture array of square
 * layers, laid out here without touching the GPU.
 *
 * The 1/8 images every node keeps are shelf-packed into layers of their own.
 * A shelf slot given back is reused by the next image of exactly its size;
 * shelves are never compacted, so a graph that churns through many nodes
 * eventually rebuilds the atlas (`full` reports when no layer is left).
 * Larger tiers, kept only near the view, use fixed cells so a cell can be
 * freed and reused. Cells come in size classes (each tier's images rounded
 * up to a step), so a layer at 2× holds several nodes rather than one cell
 * sized for the largest. A class's cells sit in a slab: a whole layer for
 * large cells, or a quarter of one for small cells, so the small
 * tiers' many classes do not each take a layer.
 */

export interface Slot {
  layer: number;
  /** Top-left texel and size of the image inside the layer. */
  x: number;
  y: number;
  w: number;
  h: number;
  tier: number;
  /** For a cell: its index in its slab and its size class. */
  cell?: number;
  cellKey?: string;
}

/** The largest painted image, in css px at 100% (node, header and margin). */
export const MAX_IMAGE = { w: 640, h: 900 };
/** Cell size classes step by this much, in css px at 100%. */
const CELL_STEP = { w: 64, h: 96 };

interface Slab {
  key: string;
  tier: number;
  layer: number;
  /** The slab's region of its layer: top-left texel and side. */
  x: number;
  y: number;
  side: number;
  region: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  free: number[];
  owner: (string | undefined)[];
}

interface Shelf {
  layer: number;
  y: number;
  h: number;
  x: number;
}

/** A layer split into equal square regions, each free or holding a slab. */
interface Regions {
  side: number;
  per: number;
  slabs: (Slab | null)[];
}

/** A slab wants at least this many cells before it takes a smaller region. */
const MIN_CELLS_PER_SLAB = 16;

export class AtlasLayout {
  /** What each layer holds: shelves, slabs in regions, or nothing yet. */
  private layerUse: ("shelf" | Regions | null)[];
  private shelves: Shelf[] = [];
  private shelfTop = new Map<number, number>();
  private slabs: Slab[] = [];
  /** Shelf slots given back (a repaint at a new size, a removed node), for reuse at the same size. */
  private freeShelfSlots: Slot[] = [];
  /** Texels holding images, by tier. */
  readonly usedTexels = new Map<number, number>();

  constructor(readonly size: number, readonly layers: number) {
    this.layerUse = new Array(layers).fill(null);
  }

  private freeLayer(): number {
    return this.layerUse.indexOf(null);
  }

  /** A permanent shelf slot (for the 1/8 tier), or null when no layer is left. */
  allocateShelf(w: number, h: number, tier: number): Slot | null {
    w = Math.ceil(w);
    h = Math.ceil(h);
    const reuse = this.freeShelfSlots.findIndex((s) => s.tier === tier && s.w === w && s.h === h);
    if (reuse >= 0) {
      const [slot] = this.freeShelfSlots.splice(reuse, 1);
      this.use(tier, w * h);
      return slot;
    }
    // One texel of gutter on every side, so filtering never reads a neighbour.
    const gw = w + 2, gh = h + 2;
    if (gw > this.size || gh > this.size) return null;
    for (const shelf of this.shelves) {
      if (shelf.h >= gh && shelf.h <= gh * 1.5 && shelf.x + gw <= this.size) {
        const slot = { layer: shelf.layer, x: shelf.x + 1, y: shelf.y + 1, w, h, tier };
        shelf.x += gw;
        this.use(tier, w * h);
        return slot;
      }
    }
    let layer = [...this.shelfTop].find(([, top]) => top + gh <= this.size)?.[0];
    if (layer == null) {
      layer = this.freeLayer();
      if (layer < 0) return null;
      this.layerUse[layer] = "shelf";
      this.shelfTop.set(layer, 0);
    }
    const y = this.shelfTop.get(layer)!;
    this.shelfTop.set(layer, y + gh);
    this.shelves.push({ layer, y, h: gh, x: gw });
    this.use(tier, w * h);
    return { layer, x: 1, y: y + 1, w, h, tier };
  }

  /** The cell size class an image of a tier goes in (images larger than MAX_IMAGE are squeezed into the largest). */
  cellClass(tier: number, w: number, h: number) {
    const stepW = Math.max(1, Math.round(CELL_STEP.w * tier)), stepH = Math.max(1, Math.round(CELL_STEP.h * tier));
    const cellW = Math.min(Math.ceil(w / stepW) * stepW, Math.ceil(MAX_IMAGE.w * tier), this.size - 2) + 2;
    const cellH = Math.min(Math.ceil(h / stepH) * stepH, Math.ceil(MAX_IMAGE.h * tier), this.size - 2) + 2;
    return { cellW, cellH, key: `${tier}:${cellW}x${cellH}` };
  }

  /** A freeable cell for a tier's image, or null when every layer is taken. */
  allocateCell(tier: number, w: number, h: number, owner: string): Slot | null {
    w = Math.ceil(w);
    h = Math.ceil(h);
    const { cellW, cellH, key } = this.cellClass(tier, w, h);
    let slab = this.slabs.find((s) => s.key === key && s.free.length);
    if (!slab) {
      slab = this.newSlab(key, tier, cellW, cellH) ?? undefined;
      if (!slab) return null;
    }
    const cell = slab.free.pop()!;
    slab.owner[cell] = owner;
    const slot: Slot = {
      layer: slab.layer,
      x: slab.x + (cell % slab.cols) * slab.cellW + 1,
      y: slab.y + Math.floor(cell / slab.cols) * slab.cellH + 1,
      w: Math.min(w, slab.cellW - 2),
      h: Math.min(h, slab.cellH - 2),
      tier,
      cell,
      cellKey: key,
    };
    this.use(tier, slot.w * slot.h);
    return slot;
  }

  /** A quarter of a layer when it holds enough cells of this size, else a whole layer; in a layer split that way, or a free one. */
  private newSlab(key: string, tier: number, cellW: number, cellH: number): Slab | null {
    const half = this.size / 2;
    const side = Math.floor(half / cellW) * Math.floor(half / cellH) >= MIN_CELLS_PER_SLAB ? half : this.size;
    let layer = this.layerUse.findIndex((use) => use && use !== "shelf" && use.side === side && use.slabs.includes(null));
    if (layer < 0) {
      layer = this.freeLayer();
      if (layer < 0) return null;
      const per = this.size / side;
      this.layerUse[layer] = { side, per, slabs: new Array(per * per).fill(null) };
    }
    const regions = this.layerUse[layer] as Regions;
    const region = regions.slabs.indexOf(null);
    const cols = Math.floor(side / cellW), rows = Math.floor(side / cellH);
    const slab: Slab = {
      key, tier, layer, x: (region % regions.per) * side, y: Math.floor(region / regions.per) * side, side, region,
      cols, rows, cellW, cellH, free: Array.from({ length: cols * rows }, (_, k) => cols * rows - 1 - k), owner: [],
    };
    regions.slabs[region] = slab;
    this.slabs.push(slab);
    return slab;
  }

  /** Gives a slot back: a cell to its slab (an empty slab frees its region, and an empty layer the layer), a shelf slot for reuse at its size. */
  release(slot: Slot) {
    this.use(slot.tier, -slot.w * slot.h);
    if (slot.cell == null) {
      this.freeShelfSlots.push(slot);
      return;
    }
    const regions = this.layerUse[slot.layer];
    if (!regions || regions === "shelf") return;
    const slab = regions.slabs[Math.floor(slot.y / regions.side) * regions.per + Math.floor(slot.x / regions.side)];
    if (!slab) return;
    slab.owner[slot.cell] = undefined;
    slab.free.push(slot.cell);
    if (slab.free.length === slab.cols * slab.rows) {
      this.slabs.splice(this.slabs.indexOf(slab), 1);
      regions.slabs[slab.region] = null;
      if (regions.slabs.every((s) => s === null)) this.layerUse[slot.layer] = null;
    }
  }

  /** Every node holding a cell of this tier (for choosing what to evict). */
  cellOwners(tier: number): string[] {
    return this.slabs.filter((s) => s.tier === tier).flatMap((s) => s.owner.filter((o): o is string => o != null));
  }

  layersInUse(): number {
    return this.layerUse.filter(Boolean).length;
  }

  layerSummary() {
    const byTier: Record<string, number> = {};
    for (const slab of this.slabs) byTier[slab.tier] = (byTier[slab.tier] ?? 0) + 1;
    return { shelf: this.layerUse.filter((u) => u === "shelf").length, byTier, total: this.layers };
  }

  /** The slot's texture coordinates (v = 0 at the top row). */
  uv(slot: Slot) {
    return { u0: slot.x / this.size, v0: slot.y / this.size, u1: (slot.x + slot.w) / this.size, v1: (slot.y + slot.h) / this.size };
  }

  private use(tier: number, texels: number) {
    this.usedTexels.set(tier, (this.usedTexels.get(tier) ?? 0) + texels);
  }
}
