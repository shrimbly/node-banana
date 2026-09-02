import type { EdgeBundlingMode, WorkflowEdge } from "@/types";

/**
 * Bundles: several connections between the same two nodes drawn as one trunk.
 *
 * A bundle is either manual (members share a `bundleId`) or automatic (the
 * bundling setting: "on" bundles two or more parallel connections, "auto"
 * three or more). Hidden edges and reference links never bundle.
 */

export interface BundleMembership {
  /** Identifies the bundle: the bundleId, or the node pair for automatic ones. */
  key: string;
  /** Member edge ids in creation order. */
  members: string[];
  /** This edge's position among the members; 0 draws the trunk. */
  index: number;
  count: number;
  manual: boolean;
}

const bundleable = (e: WorkflowEdge) => !e.data?.hidden && e.type !== "reference";

const byCreation = (a: WorkflowEdge, b: WorkflowEdge) => {
  const timeA = a.data?.createdAt || 0;
  const timeB = b.data?.createdAt || 0;
  if (timeA !== timeB) return timeA - timeB;
  return a.id.localeCompare(b.id);
};

export const AUTO_BUNDLE_THRESHOLD: Record<Exclude<EdgeBundlingMode, "off">, number> = { on: 2, auto: 3 };

export function bundleMembership(edgeId: string, edges: WorkflowEdge[], mode: EdgeBundlingMode): BundleMembership | null {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge || !bundleable(edge)) return null;

  const bundleId = edge.data?.bundleId;
  let members: WorkflowEdge[];
  let key: string;
  let manual: boolean;
  if (bundleId) {
    members = edges.filter((e) => bundleable(e) && e.data?.bundleId === bundleId && e.source === edge.source && e.target === edge.target);
    key = bundleId;
    manual = true;
    if (members.length < 2) return null;
  } else {
    if (mode === "off") return null;
    members = edges.filter((e) => bundleable(e) && !e.data?.bundleId && e.source === edge.source && e.target === edge.target);
    key = `${edge.source}->${edge.target}`;
    manual = false;
    if (members.length < AUTO_BUNDLE_THRESHOLD[mode]) return null;
  }

  const sorted = members.sort(byCreation);
  const index = sorted.findIndex((e) => e.id === edgeId);
  return { key, members: sorted.map((e) => e.id), index: index < 0 ? 0 : index, count: sorted.length, manual };
}

/** True when every edge connects the same source node to the same target node. */
export function shareNodePair(edges: WorkflowEdge[]): boolean {
  if (edges.length === 0) return false;
  const [first] = edges;
  return edges.every((e) => e.source === first.source && e.target === first.target);
}
