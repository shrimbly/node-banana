/**
 * The workflow as the GPU canvas draws it: flat node rectangles, edges by
 * node index, and group rectangles, built from the workflow store.
 *
 * A node's index is its place in the store's node array, so it changes when
 * nodes are added or removed; the scene and the painter key what they keep
 * by node id and look indices up here. `sync` tells a change that only moved
 * or resized nodes (applied in place) from one that added, removed or
 * reordered them (the graph is rebuilt).
 */
import type { NodeGroup, WorkflowEdge, WorkflowNode } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { groupBaseColor } from "@/utils/groupColors";
import { miniMapTypeColor } from "@/components/CanvasMinimap";
import { EDGE_COLORS, edgeColorKeyForHandles } from "@/lib/edges/colors";

export type Rgb = [number, number, number];

/** A handle's anchor, relative to its node's top-left, in flow units. */
export interface HandleAnchor {
  x: number;
  y: number;
  /** The side the handle is on ("left", "right", "top", "bottom"); edges leave it that way. */
  position?: string;
  /** The handle's own box, relative to the node: presses land on it, and React Flow measures a connection's reach from its centre. */
  box?: { x: number; y: number; w: number; h: number };
  /** Whether a connection may start or end on it (React Flow's connectable classes); absent is yes. A hidden legacy socket takes neither. */
  connectableStart?: boolean;
  connectableEnd?: boolean;
}

export interface SceneNode {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgb;
  /** Where each handle sits, once a painted copy of the node has been measured ("source:image", "target:text"). */
  handles?: Map<string, HandleAnchor>;
  /** The media card's box within the node, once measured: what a marquee must hold to take the node. */
  card?: { x: number; y: number; w: number; h: number } | null;
  /** The node's width when its handles and card were measured: a new width moves them (`refitMeasured`). */
  measuredW?: number;
  /**
   * The controls card's box within the node, once measured, when it reaches past the node's sides (widened by its
   * grips past the node): presses and hover find the node there too, as on classic, where the card is the node's.
   */
  overhang?: { x: number; y: number; w: number; h: number } | null;
}

/**
 * How far a node's controls card reaches past each side of the node (flow units): its width grips can make it
 * wider than the node (data.controlsWidth), and it stays centred under the node, overflowing both sides evenly.
 */
export function controlsOverhang(data: unknown, w: number): number {
  const width = (data as { controlsWidth?: unknown } | null | undefined)?.controlsWidth;
  return typeof width === "number" && Number.isFinite(width) ? Math.max(0, (width - w) / 2) : 0;
}

/**
 * A measured node's handles and card at a new width, until it is measured again: React Flow measures
 * a node's handles on the frame its size changes, so a connection on a right-hand socket follows a
 * width change at once. Right-hand handles keep their distance from the right side, top and bottom
 * ones their share of the width, left ones stay; a card reaching the right side stretches with it.
 */
export function refitMeasured(n: SceneNode, w: number) {
  const from = n.measuredW;
  if (from == null || from === w) return;
  n.measuredW = w;
  const dw = w - from, scale = from > 0 ? w / from : 1;
  if (n.handles) {
    const handles = new Map<string, HandleAnchor>();
    for (const [key, anchor] of n.handles) {
      const side = anchor.position ?? (key.startsWith("source:") ? "right" : "left");
      const shift = side === "right" ? dw : side === "top" || side === "bottom" ? anchor.x * scale - anchor.x : 0;
      handles.set(key, shift ? { ...anchor, x: anchor.x + shift, ...(anchor.box ? { box: { ...anchor.box, x: anchor.box.x + shift } } : {}) } : anchor);
    }
    n.handles = handles;
  }
  if (n.card && n.card.x + n.card.w >= from - 0.5) n.card = { ...n.card, w: Math.max(0, n.card.w + dw) };
  // A widened controls card stays centred.
  if (n.overhang) n.overhang = n.overhang.w > w ? { ...n.overhang, x: n.overhang.x + dw / 2 } : null;
}

/**
 * The measured handle an edge end attaches to, as React Flow's getHandle picks it: the one with that id,
 * or the first of its kind when the edge names none. Undefined while the node is not measured; null when
 * it has no such handle (React Flow then draws no edge: a removed input, a stale id).
 */
export function resolveHandle(node: SceneNode, kind: "source" | "target", id: string | null | undefined): [string, HandleAnchor] | null | undefined {
  if (!node.handles) return undefined;
  if (id) {
    const anchor = node.handles.get(`${kind}:${id}`);
    return anchor ? [`${kind}:${id}`, anchor] : null;
  }
  // The anchors keep React Flow's handle order, so the first of the kind is its bounds[0].
  for (const entry of node.handles) if (entry[0].startsWith(`${kind}:`)) return entry;
  return null;
}

export interface SceneEdge {
  id: string;
  source: number;
  target: number;
  sourceHandle: string | null;
  targetHandle: string | null;
  color: Rgb;
  /** The store's edge. */
  edge: WorkflowEdge;
}

export interface SceneGroup {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgb;
}

export function rgb(hex: string): Rgb {
  const value = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** The size the store knows for a node: its width as set, and its measured height when it has one. */
export function storeNodeSize(node: WorkflowNode): { w: number; h: number } {
  const defaults = defaultNodeDimensions[node.type as keyof typeof defaultNodeDimensions] ?? { width: 300, height: 280 };
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : undefined;
  const w = node.width ?? styleWidth ?? node.measured?.width ?? defaults.width;
  const h = node.measured?.height ?? node.height ?? defaults.height;
  return { w: Number(w) || defaults.width, h: Number(h) || defaults.height };
}

/** What React Flow reports when it measures a node (a "dimensions" NodeChange that keeps width and height unset). */
export interface MeasuredChange {
  type: "dimensions";
  id: string;
  dimensions: { width: number; height: number };
  setAttributes: false;
}

/**
 * The "dimensions" changes that bring the store's measured sizes up to the
 * sizes the scene measured, for these node ids: only where the store's
 * differs by more than half a pixel, as React Flow measures on the classic
 * canvas (getNodeSize and the arrange commands read them).
 */
export function measuredChanges(nodes: readonly WorkflowNode[], indexOf: (id: string) => number, graph: SceneGraph, ids: Iterable<string>): MeasuredChange[] {
  const changes: MeasuredChange[] = [];
  for (const id of ids) {
    const i = graph.indexOf.get(id), k = indexOf(id);
    if (i == null || k < 0) continue;
    const { w, h } = graph.nodes[i], measured = nodes[k].measured;
    if (measured?.width != null && measured.height != null && Math.abs(measured.width - w) <= 0.5 && Math.abs(measured.height - h) <= 0.5) continue;
    changes.push({ type: "dimensions", id, dimensions: { width: w, height: h }, setAttributes: false });
  }
  return changes;
}

function edgeColor(edge: WorkflowEdge): Rgb {
  const data = edge.data as { isLoop?: boolean; hasPause?: boolean; hidden?: boolean } | undefined;
  // ReferenceEdge reads neither a loop nor a pause: it stays grey. A hidden one is drawn as EditableEdge.
  const key = edge.type === "reference" && !data?.hidden ? "reference"
    : data?.isLoop ? "loop" : data?.hasPause ? "pause" : edge.type === "reference" ? "reference" : edgeColorKeyForHandles(edge.sourceHandle, edge.targetHandle);
  return rgb(EDGE_COLORS[key]);
}

export interface GraphSync {
  /** Nodes were added, removed or reordered: indices changed and the scene rebuilds. */
  rebuilt: boolean;
  /** Indices of nodes whose rectangle changed in place. */
  moved: number[];
  edgesChanged: boolean;
  /** When the edges are the same ones in the same order, the indices of those replaced (their data or selection changed); the scene updates them in place. */
  edgesUpdated: number[] | null;
  groupsChanged: boolean;
}

export class SceneGraph {
  nodes: SceneNode[] = [];
  indexOf = new Map<string, number>();
  edges: SceneEdge[] = [];
  edgeIndexOf = new Map<string, number>();
  /** Edge indices touching each node. */
  edgesOf: number[][] = [];
  groups: SceneGroup[] = [];
  private sourceNodes: readonly WorkflowNode[] = [];
  private sourceEdges: readonly WorkflowEdge[] = [];
  private sourceGroups: Record<string, NodeGroup> = {};
  /**
   * Where a node being dragged is held (the editor's drag sets it): the store's position for it is
   * left behind by the drag until the drop, so it is not taken over the dragged one (classic lays
   * its drag positions over the store's nodes the same way).
   */
  hold: ((id: string) => { x: number; y: number } | undefined) | null = null;

  constructor(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[], groups: Record<string, NodeGroup>) {
    this.rebuildNodes(nodes);
    this.rebuildEdges(edges);
    this.rebuildGroups(groups);
  }

  /** Brings the graph up to date with the store; see GraphSync. */
  sync(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[], groups: Record<string, NodeGroup>): GraphSync {
    const result: GraphSync = { rebuilt: false, moved: [], edgesChanged: false, edgesUpdated: null, groupsChanged: false };
    if (nodes !== this.sourceNodes) {
      const sameIds = nodes.length === this.nodes.length && nodes.every((node, i) => node.id === this.nodes[i].id);
      if (!sameIds) {
        this.rebuildNodes(nodes);
        result.rebuilt = true;
      } else {
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i] === this.sourceNodes[i]) continue;
          const n = this.nodes[i], node = nodes[i];
          const { w } = storeNodeSize(node), { x, y } = this.positionOf(node);
          // Heights come from painting once known; the store's only seeds them.
          if (n.x !== x || n.y !== y || n.w !== w) {
            n.x = x;
            n.y = y;
            n.w = w;
            refitMeasured(n, w);
            result.moved.push(i);
          }
        }
        this.sourceNodes = nodes;
      }
    }
    if (!result.rebuilt && edges !== this.sourceEdges) {
      const updated = this.updateEdges(edges);
      if (updated) result.edgesUpdated = updated;
      else {
        this.rebuildEdges(edges);
        result.edgesChanged = true;
      }
    } else if (result.rebuilt) {
      this.rebuildEdges(edges);
      result.edgesChanged = true;
    }
    if (groups !== this.sourceGroups) {
      this.rebuildGroups(groups);
      result.groupsChanged = true;
    }
    return result;
  }

  /**
   * Applies a change that replaced some node objects in place (no node added
   * or removed), looking only at those ids. Returns the indices whose
   * rectangle moved, or null when the array no longer lines up with the
   * graph (nodes were reordered) and `sync` must rebuild it.
   */
  updateNodes(nodes: readonly WorkflowNode[], ids: Iterable<string>): number[] | null {
    if (nodes.length !== this.nodes.length) return null;
    const moved: number[] = [];
    for (const id of ids) {
      const i = this.indexOf.get(id);
      if (i == null || nodes[i]?.id !== id) return null;
      const n = this.nodes[i], node = nodes[i];
      const { w } = storeNodeSize(node), { x, y } = this.positionOf(node);
      if (n.x !== x || n.y !== y || n.w !== w) {
        n.x = x;
        n.y = y;
        n.w = w;
        refitMeasured(n, w);
        moved.push(i);
      }
    }
    this.sourceNodes = nodes;
    return moved;
  }

  private positionOf(node: WorkflowNode): { x: number; y: number } {
    return this.hold?.(node.id) ?? node.position;
  }

  private rebuildNodes(nodes: readonly WorkflowNode[]) {
    const previous = new Map(this.nodes.map((n) => [n.id, n]));
    this.sourceNodes = nodes;
    this.nodes = nodes.map((node): SceneNode => {
      const { w, h } = storeNodeSize(node);
      const kept = previous.get(node.id), { x, y } = this.positionOf(node);
      if (kept) refitMeasured(kept, w);
      return {
        id: node.id,
        type: String(node.type),
        x,
        y,
        w,
        // A node already measured keeps its height until it is painted again.
        h: kept && kept.w === w ? kept.h : h,
        color: rgb(miniMapTypeColor(node.type)),
        handles: kept?.handles,
        card: kept?.card,
        overhang: kept?.overhang,
        measuredW: kept?.measuredW,
      };
    });
    this.indexOf = new Map(this.nodes.map((n, i) => [n.id, i]));
  }

  /**
   * Takes in an edges array holding the same edges in the same order (some
   * replaced: selected, relabelled, paused), in place. Returns the indices of
   * the replaced ones, or null when edges were added, removed or reconnected.
   */
  private updateEdges(edges: readonly WorkflowEdge[]): number[] | null {
    const previous = this.sourceEdges;
    if (edges.length !== previous.length) return null;
    const updated: number[] = [];
    for (let k = 0; k < edges.length; k++) {
      const edge = edges[k], before = previous[k];
      if (edge === before) continue;
      if (edge.id !== before.id || edge.source !== before.source || edge.target !== before.target
        || (edge.sourceHandle ?? null) !== (before.sourceHandle ?? null) || (edge.targetHandle ?? null) !== (before.targetHandle ?? null)) return null;
      const e = this.edgeIndexOf.get(edge.id);
      if (e == null) continue;
      this.edges[e].edge = edge;
      this.edges[e].color = edgeColor(edge);
      updated.push(e);
    }
    this.sourceEdges = edges;
    return updated;
  }

  private rebuildEdges(edges: readonly WorkflowEdge[]) {
    this.sourceEdges = edges;
    this.edges = [];
    this.edgeIndexOf = new Map();
    this.edgesOf = this.nodes.map(() => []);
    for (const edge of edges) {
      const source = this.indexOf.get(edge.source), target = this.indexOf.get(edge.target);
      if (source == null || target == null) continue;
      const e = this.edges.length;
      this.edgeIndexOf.set(edge.id, e);
      this.edges.push({ id: edge.id, source, target, sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null, color: edgeColor(edge), edge });
      this.edgesOf[source].push(e);
      if (target !== source) this.edgesOf[target].push(e);
    }
  }

  private rebuildGroups(groups: Record<string, NodeGroup>) {
    this.sourceGroups = groups;
    this.groups = Object.values(groups ?? {}).map((group) => ({
      id: group.id,
      x: group.position.x,
      y: group.position.y,
      w: group.size.width,
      h: group.size.height,
      color: rgb(groupBaseColor(group.color)),
    }));
  }

  /**
   * The handles an edge leaves and enters, relative to their nodes: an unmeasured node's mid-side until
   * it is measured. Null when a measured node has no such handle, as React Flow then draws no edge.
   */
  edgeHandles(e: number): { from: HandleAnchor; to: HandleAnchor } | null {
    const edge = this.edges[e];
    const s = this.nodes[edge.source], t = this.nodes[edge.target];
    const from = resolveHandle(s, "source", edge.sourceHandle), to = resolveHandle(t, "target", edge.targetHandle);
    if (from === null || to === null) return null;
    return { from: from?.[1] ?? { x: s.w, y: s.h / 2 }, to: to?.[1] ?? { x: 0, y: t.h / 2 } };
  }

  /** Where an edge leaves its source and enters its target, in flow units (null: see `edgeHandles`). */
  edgeEnds(e: number): [number, number, number, number] | null {
    const handles = this.edgeHandles(e);
    if (!handles) return null;
    const edge = this.edges[e], s = this.nodes[edge.source], t = this.nodes[edge.target];
    return [s.x + handles.from.x, s.y + handles.from.y, t.x + handles.to.x, t.y + handles.to.y];
  }

  /** The bounds of every node, or null for an empty graph. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.nodes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    return { minX, minY, maxX, maxY };
  }
}

/** Flow units above a node that its floating header takes: a press there is on the node. */
export const NODE_HEADER = 30;

/**
 * The nodes whose floating header band (NODE_HEADER above the node, its width) overlaps one of `rects`
 * (flow units), out of `candidates` (scene graph indices): classic draws headers over group labels and menus.
 */
export function headersUnder(graph: SceneGraph, candidates: Iterable<number>, rects: readonly { x0: number; y0: number; x1: number; y1: number }[]): string[] {
  const ids: string[] = [];
  for (const i of candidates) {
    const n = graph.nodes[i];
    if (n && rects.some((r) => r.x0 < n.x + n.w && r.x1 > n.x && r.y0 < n.y && r.y1 > n.y - NODE_HEADER)) ids.push(n.id);
  }
  return ids;
}

/** A rank above any node's raise (GridIndex.at): what a header band adds. */
const HEADER_RAISE = 1000;

/**
 * A uniform grid over node rectangles, for finding the node under a point.
 * `top` extends each node's hit area upwards (its floating header); `within`
 * still answers for the node boxes alone.
 */
export class GridIndex {
  private cells = new Map<string, number[]>();
  /** The cells each node was inserted under, so a node can leave them after it moved. */
  private keysOf = new Map<number, string[]>();

  constructor(private nodes: readonly SceneNode[], private cell = 512, private top = 0) {
    for (let i = 0; i < nodes.length; i++) this.insert(i);
  }

  private keys(i: number): string[] {
    const n = this.nodes[i], keys: string[] = [], o = n.overhang;
    // A controls card reaching past the node's sides is filed too, so `at` finds it.
    const x0 = Math.min(n.x, o ? n.x + o.x : n.x), x1 = Math.max(n.x + n.w, o ? n.x + o.x + o.w : n.x);
    for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
      for (let cy = Math.floor((n.y - this.top) / this.cell); cy <= Math.floor((n.y + n.h) / this.cell); cy++) keys.push(`${cx},${cy}`);
    }
    return keys;
  }

  insert(i: number) {
    const keys = this.keys(i);
    this.keysOf.set(i, keys);
    for (const key of keys) {
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }

  remove(i: number) {
    for (const key of this.keysOf.get(i) ?? []) {
      const list = this.cells.get(key);
      const at = list?.indexOf(i) ?? -1;
      if (list && at >= 0) list.splice(at, 1);
    }
    this.keysOf.delete(i);
  }

  /** A node's rectangle changed: re-file it. */
  update(i: number) {
    this.remove(i);
    this.insert(i);
  }

  /**
   * The topmost node containing the point, its header band included unless `header` is false, or -1.
   * Topmost is a header band over any node's box (floating headers sit above the nodes, as classic's
   * z-index 1500), then the highest `rank` (nodes raised above the others), then the last drawn.
   */
  at(x: number, y: number, header = true, rank?: (i: number) => number): number {
    const top = header ? this.top : 0;
    const list = this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`);
    let best = -1, bestRank = -Infinity;
    for (const i of list ?? []) {
      const n = this.nodes[i], o = n.overhang;
      const inside = (x >= n.x && x <= n.x + n.w && y >= n.y - top && y <= n.y + n.h)
        || (!!o && x >= n.x + o.x && x <= n.x + o.x + o.w && y >= n.y + o.y && y <= n.y + o.y + o.h);
      if (!inside) continue;
      const r = (rank?.(i) ?? 0) + (y < n.y ? HEADER_RAISE : 0);
      if (r > bestRank || (r === bestRank && i > best)) {
        best = i;
        bestRank = r;
      }
    }
    return best;
  }

  /** Nodes whose rectangle (the node's own, without a controls card's overhang) overlaps the given one. */
  within(x0: number, y0: number, x1: number, y1: number): number[] {
    const found = new Set<number>();
    for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
      for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++) {
        for (const i of this.cells.get(`${cx},${cy}`) ?? []) {
          const n = this.nodes[i];
          if (n.x <= x1 && n.x + n.w >= x0 && n.y <= y1 && n.y + n.h >= y0) found.add(i);
        }
      }
    }
    return [...found];
  }
}
