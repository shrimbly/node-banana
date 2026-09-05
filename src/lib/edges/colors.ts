/**
 * Edge and handle colour tokens.
 *
 * One hue per data type, shared by the noodles (EditableEdge and the gradients
 * in SharedEdgeGradients), the handle rules in globals.css (a test keeps the
 * `--color-handle-*` variables in step with this file) and the nodes that colour
 * handles inline. Change a hue here and both the noodle and its handles follow.
 */

/** Handle types that carry data between nodes. */
export const HANDLE_TYPES = ["image", "text", "video", "audio", "3d", "easeCurve"] as const;
export type HandleType = (typeof HANDLE_TYPES)[number];

/** The hue for each data type. Handles and noodles of that type share it. */
export const HANDLE_TYPE_COLORS: Record<HandleType, string> = {
  image: "#10b981",
  text: "#3b82f6",
  video: "#ec4899",
  audio: "#a855f7",
  "3d": "#f97316",
  easeCurve: "#bef264",
};

/** Every colour a noodle can take: the data types plus the edge-only states. */
export const EDGE_COLORS = {
  ...HANDLE_TYPE_COLORS,
  reference: "#6b7280",
  default: "#64748b",
  pause: "#ea580c",
  loop: "#d946ef",
} as const satisfies Record<string, string>;

export type EdgeColorKey = keyof typeof EDGE_COLORS;

/**
 * Reduce a handle id to its data type: `image-2` → `image`, `prompt` → `text`.
 * Unknown ids come back unchanged so callers can fall back to `default`.
 */
export function normalizeHandleType(handleId: string | null | undefined): string {
  if (!handleId) return "";
  const stripped = handleId.replace(/-\d+$/, "");
  return stripped === "prompt" ? "text" : stripped;
}

function isEdgeColorKey(key: string): key is EdgeColorKey {
  return Object.prototype.hasOwnProperty.call(EDGE_COLORS, key);
}

/** The colour key for a connection, from its source handle (or target if absent). */
export function edgeColorKeyForHandles(
  sourceHandleId: string | null | undefined,
  targetHandleId: string | null | undefined,
): EdgeColorKey {
  const type = normalizeHandleType(sourceHandleId || targetHandleId);
  return isEdgeColorKey(type) ? type : "default";
}

/** The hex colour for a connection between the given handles. */
export function edgeColorForHandles(
  sourceHandleId: string | null | undefined,
  targetHandleId: string | null | undefined,
): string {
  return EDGE_COLORS[edgeColorKeyForHandles(sourceHandleId, targetHandleId)];
}
