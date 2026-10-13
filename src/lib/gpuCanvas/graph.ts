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
import { defaultNodeDimensions, GROUP_COLORS } from "@/store/utils/nodeDefaults";
import { miniMapTypeColor } from "@/components/CanvasMinimap";
import { EDGE_COLORS, edgeColorKeyForHandles } from "@/lib/edges/colors";

export type Rgb = [number, number, number];

/** A handle's anchor, relative to its node's top-left, in flow units. */
export interface HandleAnchor {
  x: number;
  y: number;
  /** The side the handle is on ("left", "right", "top", "bottom"); edges leave it that way. */
  position?: string;
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

function edgeColor(edge: WorkflowEdge): Rgb {
  const data = edge.data as { isLoop?: boolean; hasPause?: boolean } | undefined;
  const key = data?.isLoop ? "loop" : data?.hasPause ? "pause" : edge.type === "reference" ? "reference" : edgeColorKeyForHandles(edge.sourceHandle, edge.targetHandle);
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
          const { w } = storeNodeSize(node);
          // Heights come from painting once known; the store's only seeds them.
          if (n.x !== node.position.x || n.y !== node.position.y || n.w !== w) {
            n.x = node.position.x;
            n.y = node.position.y;
            n.w = w;
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
      const { w } = storeNodeSize(node);
      if (n.x !== node.position.x || n.y !== node.position.y || n.w !== w) {
        n.x = node.position.x;
        n.y = node.position.y;
        n.w = w;
        moved.push(i);
      }
    }
    this.sourceNodes = nodes;
    return moved;
  }

  private rebuildNodes(nodes: readonly WorkflowNode[]) {
    const previous = new Map(this.nodes.map((n) => [n.id, n]));
    this.sourceNodes = nodes;
    this.nodes = nodes.map((node) => {
      const { w, h } = storeNodeSize(node);
      const kept = previous.get(node.id);
      return {
        id: node.id,
        type: String(node.type),
        x: node.position.x,
        y: node.position.y,
        w,
        // A node already measured keeps its height until it is painted again.
        h: kept && kept.w === w ? kept.h : h,
        color: rgb(miniMapTypeColor(node.type)),
        handles: kept && kept.w === w ? kept.handles : undefined,
        card: kept && kept.w === w ? kept.card : undefined,
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
      color: rgb(GROUP_COLORS[group.color] ?? "#6b7280"),
    }));
  }

  /** Where an edge leaves its source and enters its target, in flow units. */
  edgeEnds(e: number): [number, number, number, number] {
    const edge = this.edges[e];
    const s = this.nodes[edge.source], t = this.nodes[edge.target];
    const from = s.handles?.get(`source:${edge.sourceHandle ?? ""}`) ?? { x: s.w, y: s.h / 2 };
    const to = t.handles?.get(`target:${edge.targetHandle ?? ""}`) ?? { x: 0, y: t.h / 2 };
    return [s.x + from.x, s.y + from.y, t.x + to.x, t.y + to.y];
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

/** A uniform grid over node rectangles, for finding the node under a point. */
export class GridIndex {
  private cells = new Map<string, number[]>();
  /** The cells each node was inserted under, so a node can leave them after it moved. */
  private keysOf = new Map<number, string[]>();

  constructor(private nodes: readonly SceneNode[], private cell = 512) {
    for (let i = 0; i < nodes.length; i++) this.insert(i);
  }

  private keys(i: number): string[] {
    const n = this.nodes[i], keys: string[] = [];
    for (let cx = Math.floor(n.x / this.cell); cx <= Math.floor((n.x + n.w) / this.cell); cx++) {
      for (let cy = Math.floor(n.y / this.cell); cy <= Math.floor((n.y + n.h) / this.cell); cy++) keys.push(`${cx},${cy}`);
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

  /** The topmost (last drawn) node containing the point, or -1. */
  at(x: number, y: number): number {
    const list = this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`);
    let best = -1;
    for (const i of list ?? []) {
      const n = this.nodes[i];
      if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h && i > best) best = i;
    }
    return best;
  }

  /** Nodes whose rectangle overlaps the given one. */
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
