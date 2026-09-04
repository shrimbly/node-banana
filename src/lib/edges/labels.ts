import type { WorkflowEdge, WorkflowEdgeData } from "@/types";
import { normalizeHandleType } from "./colors";

/** Human name for a handle's data type. */
export function edgeTypeLabel(handleId: string | null | undefined): string {
  switch (normalizeHandleType(handleId)) {
    case "image": return "Image";
    case "text": return "Text";
    case "video": return "Video";
    case "audio": return "Audio";
    case "3d": return "3D";
    case "easeCurve": return "Ease curve";
    case "reference": return "Reference";
    default: return "Connection";
  }
}

/**
 * For image connections that share a target handle, the 1-based order in
 * which they were made (the order images are sent to the model). Null when
 * the connection is alone or not an image.
 */
export function getImageSequenceNumber(edge: WorkflowEdge, edges: WorkflowEdge[]): number | null {
  const sourceHandle = edge.sourceHandle;
  const targetHandle = edge.targetHandle;
  const isImageConnection =
    sourceHandle === "image" || sourceHandle?.startsWith("image-") ||
    targetHandle === "image" || targetHandle?.startsWith("image-");
  if (!isImageConnection) return null;

  const siblings = edges.filter((e) => e.target === edge.target && e.targetHandle === edge.targetHandle);
  if (siblings.length <= 1) return null;

  // Sort by creation time (fallback to edge id for legacy edges without a timestamp)
  const sorted = [...siblings].sort((a, b) => {
    const timeA = (a.data as WorkflowEdgeData)?.createdAt || 0;
    const timeB = (b.data as WorkflowEdgeData)?.createdAt || 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.id.localeCompare(b.id);
  });
  const index = sorted.findIndex((e) => e.id === edge.id);
  return index >= 0 ? index + 1 : null;
}

/**
 * The label a connection shows when it has no text of its own: "Image 2"
 * for the second image into a handle, otherwise the data type.
 */
export function edgeAutoLabel(edge: WorkflowEdge, edges: WorkflowEdge[]): string {
  const sequence = getImageSequenceNumber(edge, edges);
  if (sequence !== null) return `Image ${sequence}`;
  return edgeTypeLabel(edge.sourceHandle || edge.targetHandle);
}

/** The user's label when set, otherwise the automatic one. */
export function edgeDisplayLabel(edge: WorkflowEdge, edges: WorkflowEdge[]): string {
  const own = edge.data?.label?.trim();
  return own || edgeAutoLabel(edge, edges);
}

/** Display label for an edge id, or an empty string when the edge is gone. */
export function edgeDisplayLabelById(edgeId: string, edges: WorkflowEdge[]): string {
  const edge = edges.find((e) => e.id === edgeId);
  return edge ? edgeDisplayLabel(edge, edges) : "";
}

/**
 * Position of an edge among the visible edges between the same two nodes,
 * so their labels can be offset instead of stacking on one point.
 * Returns the index and how many share the pair.
 */
export function parallelEdgePosition(edgeId: string, edges: WorkflowEdge[]): { index: number; count: number } {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return { index: 0, count: 1 };
  const parallel = edges
    .filter((e) => !e.data?.hidden && e.source === edge.source && e.target === edge.target)
    .sort((a, b) => {
      const timeA = a.data?.createdAt || 0;
      const timeB = b.data?.createdAt || 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });
  const index = parallel.findIndex((e) => e.id === edgeId);
  return { index: index < 0 ? 0 : index, count: Math.max(1, parallel.length) };
}

/**
 * Where a hidden edge's stub sits among the hidden edges sharing the same
 * handle, so their labels stack instead of overlapping. Creation order.
 */
export const HIDDEN_STUB_SPACING = 22;
/** Extra room between the stubs of different handles, so the types read as groups. */
export const HIDDEN_STUB_GROUP_GAP = 8;

/** The plural of a handle type's label, for a pill standing in for several hidden connections. */
export function pluralTypeLabel(handleId: string | null | undefined): string {
  const label = edgeTypeLabel(handleId);
  return label === "Audio" || label === "3D" ? label : `${label}s`;
}

/** Identifies the hidden connections on one handle, which collapse into a single pill. */
export function stubGroupKey(nodeId: string, side: "source" | "target", handleId: string | null | undefined): string {
  return `${nodeId}:${side}:${handleId ?? ""}`;
}

export interface HiddenStubGroup {
  key: string;
  /** Member edge ids in stack order. */
  members: string[];
  /** True for a connection the user has named, which stands outside its handle's group. */
  named?: boolean;
}

const hasOwnLabel = (e: WorkflowEdge) => Boolean(e.data?.label?.trim());

/**
 * The hidden connections on each handle of a node's side. Unnamed ones share
 * a group per handle (collapsed into one plural pill); a connection the user
 * has named keeps its own pill, listed after its handle's group.
 */
function hiddenStubGroups(edges: WorkflowEdge[], nodeId: string, side: "source" | "target"): HiddenStubGroup[] {
  const handleOf = (e: WorkflowEdge) => (side === "source" ? e.sourceHandle : e.targetHandle) ?? null;
  const nodeOf = (e: WorkflowEdge) => (side === "source" ? e.source : e.target);
  const order = (a: WorkflowEdge, b: WorkflowEdge) =>
    (a.data?.createdAt || 0) - (b.data?.createdAt || 0) || a.id.localeCompare(b.id);
  const onSide = edges.filter((e) => e.data?.hidden && nodeOf(e) === nodeId).sort(order);
  const shared = new Map<string, string[]>();
  const named: HiddenStubGroup[] = [];
  for (const e of onSide) {
    const key = stubGroupKey(nodeId, side, handleOf(e));
    if (hasOwnLabel(e)) named.push({ key: `${key}#${e.id}`, members: [e.id], named: true });
    else shared.set(key, [...(shared.get(key) ?? []), e.id]);
  }
  return [...[...shared.entries()].map(([key, members]) => ({ key, members })), ...named];
}

/** The group of hidden connections sharing this edge's handle on the given side. */
export function hiddenStubGroup(edgeId: string, edges: WorkflowEdge[], side: "source" | "target"): HiddenStubGroup | null {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge || !edge.data?.hidden) return null;
  const nodeId = side === "source" ? edge.source : edge.target;
  return hiddenStubGroups(edges, nodeId, side).find((g) => g.members.includes(edgeId)) ?? null;
}

export type HiddenStubRole = "single" | "expanded" | "collapsed-leader" | "collapsed-member";

/**
 * How this edge's stub on one side should draw: alone, as one of an expanded
 * group, as the pill standing in for a collapsed group, or not at all.
 */
export function hiddenStubRole(
  edgeId: string,
  edges: WorkflowEdge[],
  side: "source" | "target",
  expandedGroup: string | null,
): HiddenStubRole {
  const group = hiddenStubGroup(edgeId, edges, side);
  if (!group || group.members.length < 2) return "single";
  if (group.key === expandedGroup) return "expanded";
  return group.members[0] === edgeId ? "collapsed-leader" : "collapsed-member";
}

/**
 * Where each hidden stub on one side of a node should sit, so the pills never
 * overlap. A handle with several hidden connections takes one row unless its
 * group is expanded. Stubs are ordered by their handle's y (then creation),
 * and each one sits at its own handle unless the stub above it is too close,
 * in which case it is pushed down. `handleY` gives the y of a handle on the
 * node; return undefined when it is not known and the stub is assumed level
 * with the caller.
 */
export function stackHiddenStubs(
  edges: WorkflowEdge[],
  nodeId: string,
  side: "source" | "target",
  handleY: (handleId: string | null) => number | undefined,
  fallbackY = 0,
  expandedGroup: string | null = null,
  spacing = HIDDEN_STUB_SPACING,
): Map<string, number> {
  const handleOf = (e: WorkflowEdge) => (side === "source" ? e.sourceHandle : e.targetHandle) ?? null;
  const byId = new Map(edges.map((e) => [e.id, e]));
  // Rows are keyed by handle so stubs of one handle stay together; a named
  // connection ranks after its handle's shared group
  const rows: { ids: string[]; key: string; y: number; rank: number; createdAt: number }[] = [];
  for (const group of hiddenStubGroups(edges, nodeId, side)) {
    const first = byId.get(group.members[0])!;
    const y = handleY(handleOf(first)) ?? fallbackY;
    const key = group.key.split("#")[0];
    const rank = group.named ? 1 : 0;
    const collapsed = group.members.length > 1 && group.key !== expandedGroup;
    if (collapsed) {
      rows.push({ ids: group.members, key, y, rank, createdAt: first.data?.createdAt || 0 });
    } else {
      for (const id of group.members) rows.push({ ids: [id], key, y, rank, createdAt: byId.get(id)?.data?.createdAt || 0 });
    }
  }
  // Handles at one height keep the order their first connection was made in
  const handleOrder = new Map<string, number>();
  for (const row of rows) handleOrder.set(row.key, Math.min(handleOrder.get(row.key) ?? Infinity, row.createdAt));
  rows.sort(
    (a, b) =>
      a.y - b.y ||
      handleOrder.get(a.key)! - handleOrder.get(b.key)! ||
      a.key.localeCompare(b.key) ||
      a.rank - b.rank ||
      a.createdAt - b.createdAt ||
      a.ids[0].localeCompare(b.ids[0])
  );
  const placed = new Map<string, number>();
  let floor = -Infinity;
  let previousKey: string | null = null;
  for (const row of rows) {
    if (previousKey !== null && row.key !== previousKey) floor += HIDDEN_STUB_GROUP_GAP;
    const y = Math.max(row.y, floor);
    for (const id of row.ids) placed.set(id, y);
    floor = y + spacing;
    previousKey = row.key;
  }
  return placed;
}

/** How far below its handle a hidden edge's stub sits on the given side. */
export function hiddenStubOffset(
  edgeId: string,
  edges: WorkflowEdge[],
  side: "source" | "target",
  handleY: (handleId: string | null) => number | undefined,
  ownY: number,
  expandedGroup: string | null = null,
): number {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return 0;
  const nodeId = side === "source" ? edge.source : edge.target;
  const y = stackHiddenStubs(edges, nodeId, side, handleY, ownY, expandedGroup).get(edgeId);
  if (y === undefined) return 0;
  const own = handleY((side === "source" ? edge.sourceHandle : edge.targetHandle) ?? null) ?? ownY;
  return y - own;
}
