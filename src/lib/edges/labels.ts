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

/** Label for an edge id, or an empty string when the edge is gone. */
export function edgeAutoLabelById(edgeId: string, edges: WorkflowEdge[]): string {
  const edge = edges.find((e) => e.id === edgeId);
  return edge ? edgeAutoLabel(edge, edges) : "";
}

/**
 * Where a hidden edge's stub sits among the hidden edges sharing the same
 * handle, so their labels stack instead of overlapping. Creation order.
 */
export function hiddenSiblingIndex(edgeId: string, edges: WorkflowEdge[], side: "source" | "target"): number {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return 0;
  const siblings = edges
    .filter((e) => e.data?.hidden && (side === "source"
      ? e.source === edge.source && (e.sourceHandle ?? null) === (edge.sourceHandle ?? null)
      : e.target === edge.target && (e.targetHandle ?? null) === (edge.targetHandle ?? null)))
    .sort((a, b) => {
      const timeA = a.data?.createdAt || 0;
      const timeB = b.data?.createdAt || 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });
  const index = siblings.findIndex((e) => e.id === edgeId);
  return index < 0 ? 0 : index;
}
