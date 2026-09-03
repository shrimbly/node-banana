import type { EdgeBundlingMode, WorkflowEdge } from "@/types";

/**
 * Bundles: the connections that share one handle, drawn as a short stem at
 * that handle which then splits into the individual noodles. A fan-out is
 * one output feeding several nodes; a fan-in is several outputs arriving at
 * one input handle (a generate node's image input, say). An edge can sit in
 * a bundle at each end.
 *
 * A bundle is either manual (members share a `bundleId`) or automatic (the
 * bundling setting: "on" needs two connections on a handle, "auto" three).
 * Hidden edges and reference links never bundle.
 */

export type BundleEnd = "source" | "target";

export interface BundleMembership {
  end: BundleEnd;
  /** Identifies the bundle: the bundleId, or the handle for automatic ones. */
  key: string;
  /** Member edge ids in creation order. */
  members: string[];
  /** This edge's position among the members; 0 draws the stem. */
  index: number;
  count: number;
  manual: boolean;
}

export interface EdgeBundles {
  source: BundleMembership | null;
  target: BundleMembership | null;
}

const bundleable = (e: WorkflowEdge) => !e.data?.hidden && e.type !== "reference";

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

export const AUTO_BUNDLE_THRESHOLD: Record<Exclude<EdgeBundlingMode, "off">, number> = { on: 2, auto: 3 };

function membership(edge: WorkflowEdge, edges: WorkflowEdge[], mode: EdgeBundlingMode, end: BundleEnd): BundleMembership | null {
  const bundleId = edge.data?.bundleId;
  let members: WorkflowEdge[];
  let key: string;
  let manual: boolean;
  if (bundleId) {
    members = edges.filter((e) => bundleable(e) && e.data?.bundleId === bundleId && sameHandle(e, edge, end));
    key = `${end}:${bundleId}`;
    manual = true;
    if (members.length < 2) return null;
  } else {
    if (mode === "off") return null;
    members = edges.filter((e) => bundleable(e) && !e.data?.bundleId && sameHandle(e, edge, end));
    key = end === "source" ? `source:${edge.source}:${edge.sourceHandle ?? ""}` : `target:${edge.target}:${edge.targetHandle ?? ""}`;
    manual = false;
    if (members.length < AUTO_BUNDLE_THRESHOLD[mode]) return null;
  }
  const sorted = members.sort(byCreation);
  const index = sorted.findIndex((e) => e.id === edge.id);
  return { end, key, members: sorted.map((e) => e.id), index: index < 0 ? 0 : index, count: sorted.length, manual };
}

/** The bundles an edge belongs to at each end, or null where it is alone. */
export function edgeBundles(edgeId: string, edges: WorkflowEdge[], mode: EdgeBundlingMode): EdgeBundles {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge || !bundleable(edge)) return { source: null, target: null };
  return {
    source: membership(edge, edges, mode, "source"),
    target: membership(edge, edges, mode, "target"),
  };
}

/** The bundle the toolbar acts on: the source end first, else the target end. */
export function bundleMembership(edgeId: string, edges: WorkflowEdge[], mode: EdgeBundlingMode): BundleMembership | null {
  const { source, target } = edgeBundles(edgeId, edges, mode);
  return source ?? target;
}

/** True when every edge leaves the same output handle, or arrives at the same input handle. */
export function shareHandle(edges: WorkflowEdge[]): boolean {
  if (edges.length < 2) return false;
  const [first] = edges;
  return edges.every((e) => sameHandle(e, first, "source")) || edges.every((e) => sameHandle(e, first, "target"));
}
