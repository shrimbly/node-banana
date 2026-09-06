import type { WorkflowEdge } from "@/types";
import { hookHandles } from "./hook";

/**
 * What an edge needs to know about the other edges, computed once per edges
 * array and kept for as long as that array is the store's current one.
 *
 * Every edge on the canvas subscribes to the store, and the store updates on
 * every frame of a drag. A selector that scans the edges is therefore
 * quadratic per frame, so the per-edge helpers in `labels.ts` and
 * `bundles.ts` read from this index instead and cost a map lookup each.
 */

export type BundleEnd = "source" | "target";

export interface BundleMembership {
  end: BundleEnd;
  /** Identifies the bundle. */
  key: string;
  /** Member edge ids in creation order. */
  members: string[];
  /** This edge's position among the members; 0 draws the stem. */
  index: number;
  count: number;
}

export interface EdgeBundles {
  source: BundleMembership | null;
  target: BundleMembership | null;
}

export interface HiddenStubGroup {
  key: string;
  /** Member edge ids in stack order. */
  members: string[];
  /** True for a connection the user has named, which stands outside its handle's group. */
  named?: boolean;
}

export interface EdgeGraphIndex {
  byId: Map<string, WorkflowEdge>;
  /** 1-based order among the image connections sharing a target handle; absent when alone. */
  imageSequence: Map<string, number>;
  /** Position among the visible edges between the same two nodes. */
  parallel: Map<string, { index: number; count: number }>;
  bundles: Map<string, EdgeBundles>;
  hookBundles: Map<string, WorkflowEdge[]>;
  /** Hidden stub groups per node side, keyed by `hiddenStubSideKey`. */
  hiddenStubGroups: Map<string, HiddenStubGroup[]>;
  selectedIds: Set<string>;
  /** The first selected edge, which carries the toolbar. */
  toolbarEdgeId: string | null;
}

export interface NodeGraphIndex<T> {
  byId: Map<string, T>;
  selectedIds: Set<string>;
}

const ENDS: BundleEnd[] = ["source", "target"];
const NO_BUNDLES: EdgeBundles = { source: null, target: null };

/** Creation order, falling back to the id for legacy edges without a timestamp. */
export const byCreation = (a: WorkflowEdge, b: WorkflowEdge) => {
  const timeA = a.data?.createdAt || 0;
  const timeB = b.data?.createdAt || 0;
  if (timeA !== timeB) return timeA - timeB;
  return a.id.localeCompare(b.id);
};

/** The bundle id an edge carries at one end, if any. */
export function bundleIdAt(edge: WorkflowEdge, end: BundleEnd): string | undefined {
  return end === "source" ? edge.data?.sourceBundleId : edge.data?.targetBundleId;
}

/** Hidden edges and reference links never bundle. */
export const bundleable = (e: WorkflowEdge) => !e.data?.hidden && e.type !== "reference";

/** Identifies the hidden connections on one handle, which collapse into a single pill. */
export function stubGroupKey(nodeId: string, side: BundleEnd, handleId: string | null | undefined): string {
  return `${nodeId}:${side}:${handleId ?? ""}`;
}

/** Identifies one side of a node in `hiddenStubGroups`. */
export function hiddenStubSideKey(nodeId: string, side: BundleEnd): string {
  return `${nodeId}:${side}`;
}

const nodeAt = (e: WorkflowEdge, end: BundleEnd) => (end === "source" ? e.source : e.target);
const handleAt = (e: WorkflowEdge, end: BundleEnd) => (end === "source" ? e.sourceHandle : e.targetHandle) ?? null;
const hasOwnLabel = (e: WorkflowEdge) => Boolean(e.data?.label?.trim());
const isImageConnection = (e: WorkflowEdge) =>
  e.sourceHandle === "image" || Boolean(e.sourceHandle?.startsWith("image-")) ||
  e.targetHandle === "image" || Boolean(e.targetHandle?.startsWith("image-"));

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildEdgeGraphIndex(edges: WorkflowEdge[]): EdgeGraphIndex {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const sorted = [...edges].sort(byCreation);

  // Image order: every connection into a handle counts, since they all share its type
  const byTargetHandle = new Map<string, WorkflowEdge[]>();
  for (const e of sorted) push(byTargetHandle, `${e.target}\u0000${e.targetHandle ?? ""}`, e);
  const imageSequence = new Map<string, number>();
  for (const siblings of byTargetHandle.values()) {
    if (siblings.length <= 1) continue;
    siblings.forEach((e, i) => {
      if (isImageConnection(e)) imageSequence.set(e.id, i + 1);
    });
  }

  // Parallel: the visible edges between one pair of nodes. A hidden edge is
  // not among them but still reports how many there are.
  const byPair = new Map<string, string[]>();
  for (const e of sorted) if (!e.data?.hidden) push(byPair, `${e.source}\u0000${e.target}`, e.id);
  const parallel = new Map<string, { index: number; count: number }>();
  for (const e of edges) {
    const pair = byPair.get(`${e.source}\u0000${e.target}`) ?? [];
    const index = pair.indexOf(e.id);
    parallel.set(e.id, { index: index < 0 ? 0 : index, count: Math.max(1, pair.length) });
  }

  // Bundles: members share a bundle id and a handle at that end
  const byBundle = { source: new Map<string, string[]>(), target: new Map<string, string[]>() };
  const hookBundles = new Map<string, WorkflowEdge[]>();
  for (const e of sorted) {
    if (!bundleable(e)) continue;
    if (!e.hidden) for (const handle of hookHandles(e.data)) push(hookBundles, handle.id, e);
    for (const end of ENDS) {
      const bundleId = bundleIdAt(e, end);
      if (bundleId) push(byBundle[end], `${bundleId}\u0000${nodeAt(e, end)}\u0000${handleAt(e, end) ?? ""}`, e.id);
    }
  }
  const membership = (e: WorkflowEdge, end: BundleEnd): BundleMembership | null => {
    const bundleId = bundleIdAt(e, end);
    if (!bundleId) return null;
    const members = byBundle[end].get(`${bundleId}\u0000${nodeAt(e, end)}\u0000${handleAt(e, end) ?? ""}`)!;
    if (members.length < 2) return null;
    return { end, key: `${end}:${bundleId}`, members, index: members.indexOf(e.id), count: members.length };
  };
  const bundles = new Map<string, EdgeBundles>();
  for (const e of edges) {
    bundles.set(e.id, bundleable(e) ? { source: membership(e, "source"), target: membership(e, "target") } : NO_BUNDLES);
  }

  // Hidden stubs: per node side, unnamed connections share a group per
  // handle (collapsed into one plural pill); a connection the user has named
  // keeps its own pill, listed after its handle's group.
  const shared = new Map<string, Map<string, string[]>>();
  const named = new Map<string, HiddenStubGroup[]>();
  for (const e of sorted) {
    if (!e.data?.hidden) continue;
    for (const side of ENDS) {
      const nodeId = nodeAt(e, side);
      const sideKey = hiddenStubSideKey(nodeId, side);
      const key = stubGroupKey(nodeId, side, handleAt(e, side));
      if (hasOwnLabel(e)) {
        push(named, sideKey, { key: `${key}#${e.id}`, members: [e.id], named: true });
      } else {
        let groups = shared.get(sideKey);
        if (!groups) shared.set(sideKey, (groups = new Map()));
        push(groups, key, e.id);
      }
    }
  }
  const hiddenStubGroups = new Map<string, HiddenStubGroup[]>();
  for (const sideKey of new Set([...shared.keys(), ...named.keys()])) {
    const groups = [...(shared.get(sideKey)?.entries() ?? [])].map(([key, members]) => ({ key, members }));
    hiddenStubGroups.set(sideKey, [...groups, ...(named.get(sideKey) ?? [])]);
  }

  const selectedIds = new Set(edges.filter((e) => e.selected).map((e) => e.id));
  const toolbarEdgeId = edges.find((e) => e.selected)?.id ?? null;

  return { byId, imageSequence, parallel, bundles, hookBundles, hiddenStubGroups, selectedIds, toolbarEdgeId };
}

const EMPTY_EDGE_INDEX = buildEdgeGraphIndex([]);
const edgeCache = new WeakMap<WorkflowEdge[], EdgeGraphIndex>();

/** The index for an edges array, built on first use and reused while the array is the same one. */
export function edgeGraphIndex(edges: WorkflowEdge[] | undefined): EdgeGraphIndex {
  if (!edges) return EMPTY_EDGE_INDEX;
  let index = edgeCache.get(edges);
  if (!index) {
    index = buildEdgeGraphIndex(edges);
    edgeCache.set(edges, index);
  }
  return index;
}

const nodeCache = new WeakMap<object, NodeGraphIndex<unknown>>();

/** The nodes by id and the selected ones, built once per nodes array. */
export function nodeGraphIndex<T extends { id: string; selected?: boolean }>(nodes: readonly T[]): NodeGraphIndex<T> {
  let index = nodeCache.get(nodes) as NodeGraphIndex<T> | undefined;
  if (!index) {
    index = {
      byId: new Map(nodes.map((n) => [n.id, n])),
      selectedIds: new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    };
    nodeCache.set(nodes, index as NodeGraphIndex<unknown>);
  }
  return index;
}
