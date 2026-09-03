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

/**
 * Where each hidden stub on one side of a node should sit, so the pills never
 * overlap. Stubs are ordered by their handle's y (then creation), and each one
 * sits at its own handle unless the stub above it is too close, in which case
 * it is pushed down. `handleY` gives the y of a handle on the node; return
 * undefined when it is not known and the stub is assumed level with the caller.
 */
export function stackHiddenStubs(
  edges: WorkflowEdge[],
  nodeId: string,
  side: "source" | "target",
  handleY: (handleId: string | null) => number | undefined,
  fallbackY = 0,
  spacing = HIDDEN_STUB_SPACING,
): Map<string, number> {
  const handleOf = (e: WorkflowEdge) => (side === "source" ? e.sourceHandle : e.targetHandle) ?? null;
  const nodeOf = (e: WorkflowEdge) => (side === "source" ? e.source : e.target);
  const anchors = edges
    .filter((e) => e.data?.hidden && nodeOf(e) === nodeId)
    .map((e) => ({ id: e.id, y: handleY(handleOf(e)) ?? fallbackY, createdAt: e.data?.createdAt || 0 }))
    .sort((a, b) => a.y - b.y || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const placed = new Map<string, number>();
  let floor = -Infinity;
  for (const stub of anchors) {
    const y = Math.max(stub.y, floor);
    placed.set(stub.id, y);
    floor = y + spacing;
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
): number {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return 0;
  const nodeId = side === "source" ? edge.source : edge.target;
  const y = stackHiddenStubs(edges, nodeId, side, handleY, ownY).get(edgeId);
  if (y === undefined) return 0;
  const own = handleY((side === "source" ? edge.sourceHandle : edge.targetHandle) ?? null) ?? ownY;
  return y - own;
}
