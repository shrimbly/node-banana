import type { WorkflowEdge } from "@/types";

/**
 * Bundles: the connections that share one handle, drawn as a short stem at
 * that handle which then splits into the individual noodles. A fan-out is
 * one output feeding several nodes; a fan-in is several outputs arriving at
 * one input handle. An edge can sit in a bundle at each end.
 *
 * Bundling is always deliberate: members share a bundle id for that end
 * (`sourceBundleId` or `targetBundleId`), set from the handle menu or the edge
 * toolbar. The two ends are independent, so a fan-out bundled at its output
 * can also be bundled at any of its inputs. Hidden edges and reference links
 * never bundle.
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

const bundleable = (e: WorkflowEdge) => !e.data?.hidden && e.type !== "reference";

/** The bundle id an edge carries at one end, if any. */
export function bundleIdAt(edge: WorkflowEdge, end: BundleEnd): string | undefined {
  return end === "source" ? edge.data?.sourceBundleId : edge.data?.targetBundleId;
}

const byCreation = (a: WorkflowEdge, b: WorkflowEdge) => {
  const timeA = a.data?.createdAt || 0;
  const timeB = b.data?.createdAt || 0;
  if (timeA !== timeB) return timeA - timeB;
  return a.id.localeCompare(b.id);
};

const sameHandle = (a: WorkflowEdge, b: WorkflowEdge, end: BundleEnd) =>
  end === "source"
    ? a.source === b.source && (a.sourceHandle ?? null) === (b.sourceHandle ?? null)
    : a.target === b.target && (a.targetHandle ?? null) === (b.targetHandle ?? null);

function membership(edge: WorkflowEdge, edges: WorkflowEdge[], end: BundleEnd): BundleMembership | null {
  const bundleId = bundleIdAt(edge, end);
  if (!bundleId) return null;
  const members = edges
    .filter((e) => bundleable(e) && bundleIdAt(e, end) === bundleId && sameHandle(e, edge, end))
    .sort(byCreation);
  if (members.length < 2) return null;
  const index = members.findIndex((e) => e.id === edge.id);
  return { end, key: `${end}:${bundleId}`, members: members.map((e) => e.id), index: index < 0 ? 0 : index, count: members.length };
}

/** The bundles an edge belongs to at each end, or null where it is alone. */
export function edgeBundles(edgeId: string, edges: WorkflowEdge[]): EdgeBundles {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge || !bundleable(edge)) return { source: null, target: null };
  return { source: membership(edge, edges, "source"), target: membership(edge, edges, "target") };
}

/** The bundle the toolbar acts on: the source end first, else the target end. */
export function bundleMembership(edgeId: string, edges: WorkflowEdge[]): BundleMembership | null {
  const { source, target } = edgeBundles(edgeId, edges);
  return source ?? target;
}

/** True when every edge shares the given end's handle. */
export function shareHandleAt(edges: WorkflowEdge[], end: BundleEnd): boolean {
  if (edges.length < 2) return false;
  const [first] = edges;
  return edges.every((e) => sameHandle(e, first, end));
}

/** The end at which every edge shares one handle, output first, or null. */
export function sharedEnd(edges: WorkflowEdge[]): BundleEnd | null {
  if (shareHandleAt(edges, "source")) return "source";
  if (shareHandleAt(edges, "target")) return "target";
  return null;
}

/** True when every edge leaves the same output handle, or arrives at the same input handle. */
export function shareHandle(edges: WorkflowEdge[]): boolean {
  return sharedEnd(edges) !== null;
}

/** Every edge attached to one handle of a node, in creation order. */
export function edgesOnHandle(edges: WorkflowEdge[], nodeId: string, end: BundleEnd, handleId: string | null | undefined): WorkflowEdge[] {
  return edges
    .filter((e) => (end === "source"
      ? e.source === nodeId && (e.sourceHandle ?? null) === (handleId ?? null)
      : e.target === nodeId && (e.targetHandle ?? null) === (handleId ?? null)))
    .sort(byCreation);
}

/** Default, smallest and largest distance from the handle to the split point. */
export const DEFAULT_BUNDLE_REACH = 56;
export const MIN_BUNDLE_REACH = 16;
export const MAX_BUNDLE_REACH = 4000;

export function bundleClampKey(end: BundleEnd, handleId: string | null | undefined): string {
  return `${end}:${handleId ?? ""}`;
}

/** The split distance set on a node's handle, or the default. */
export function bundleReach(
  nodes: { id: string; data: { bundleClamps?: Record<string, number> } }[],
  nodeId: string,
  end: BundleEnd,
  handleId: string | null | undefined,
): number {
  const stored = nodes.find((n) => n.id === nodeId)?.data?.bundleClamps?.[bundleClampKey(end, handleId)];
  return typeof stored === "number" && Number.isFinite(stored)
    ? Math.min(MAX_BUNDLE_REACH, Math.max(MIN_BUNDLE_REACH, stored))
    : DEFAULT_BUNDLE_REACH;
}
