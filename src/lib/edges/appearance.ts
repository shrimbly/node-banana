import {
  EdgeAppearance,
  EdgeLabelMode,
  EdgeStyle,
  EdgeThickness,
  defaultEdgeAppearance,
} from "@/types";

export const EDGE_THICKNESS_PX: Record<EdgeThickness, number> = {
  thin: 2,
  regular: 3,
  thick: 5,
};

export const EDGE_STYLES: readonly EdgeStyle[] = ["curved", "angular", "straight"];
export const EDGE_THICKNESSES: readonly EdgeThickness[] = ["thin", "regular", "thick"];
export const EDGE_LABEL_MODES: readonly EdgeLabelMode[] = ["always", "hover", "never"];

export function isEdgeStyle(value: unknown): value is EdgeStyle {
  return typeof value === "string" && (EDGE_STYLES as readonly string[]).includes(value);
}

/**
 * Fill in an appearance read from a file or localStorage: unknown or invalid
 * fields fall back to the defaults, so old workflows and hand-edited files
 * always yield something the edges can render.
 */
export function normalizeEdgeAppearance(input: unknown): EdgeAppearance {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const thickness = (EDGE_THICKNESSES as readonly string[]).includes(raw.thickness as string)
    ? (raw.thickness as EdgeThickness)
    : defaultEdgeAppearance.thickness;
  const fadedOpacity =
    typeof raw.fadedOpacity === "number" && Number.isFinite(raw.fadedOpacity)
      ? Math.min(1, Math.max(0, raw.fadedOpacity))
      : defaultEdgeAppearance.fadedOpacity;
  return {
    thickness,
    fadedOpacity,
    gradient: typeof raw.gradient === "boolean" ? raw.gradient : defaultEdgeAppearance.gradient,
    loadingPulse:
      typeof raw.loadingPulse === "boolean" ? raw.loadingPulse : defaultEdgeAppearance.loadingPulse,
    labels: (EDGE_LABEL_MODES as readonly string[]).includes(raw.labels as string)
      ? (raw.labels as EdgeLabelMode)
      : defaultEdgeAppearance.labels,
  };
}
