"use client";

import { memo } from "react";
// Shared SVG gradient definitions for all edge types.
// Rendered once inside the React Flow SVG layer to avoid duplicating
// <defs>/<linearGradient> in every edge component.

import { EDGE_COLORS } from "@/lib/edges/colors";
import { useWorkflowStore } from "@/store/workflowStore";

const SELECTION_STATES = ["active", "dimmed"] as const;

/** Stop opacities along a noodle: bright at both ends, softer in the middle. */
export function gradientOpacities(active: boolean, fadedOpacity: number): [number, number, number] {
  if (active) return [1, 0.55, 1];
  return [fadedOpacity, fadedOpacity * 0.4, fadedOpacity];
}

function gradientStops(color: string, active: boolean, fadedOpacity: number) {
  const [start, middle, end] = gradientOpacities(active, fadedOpacity);
  return (
    <>
      <stop offset="0%" stopColor={color} stopOpacity={start} />
      <stop offset="50%" stopColor={color} stopOpacity={middle} />
      <stop offset="100%" stopColor={color} stopOpacity={end} />
    </>
  );
}

export function getSharedGradientId(colorKey: string, selectionKey: "active" | "dimmed") {
  return `edge-grad-${colorKey}-${selectionKey}`;
}

// Memoised: rendered by the canvas, which re-renders on every drag frame
export const SharedEdgeGradients = memo(function SharedEdgeGradients() {
  const fadedOpacity = useWorkflowStore((state) => state.edgeAppearance.fadedOpacity);
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }}>
      <defs>
        {Object.entries(EDGE_COLORS).flatMap(([colorKey, color]) =>
          SELECTION_STATES.map((sel) => (
            <linearGradient
              key={`${colorKey}-${sel}`}
              id={getSharedGradientId(colorKey, sel)}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="0%"
            >
              {gradientStops(color, sel === "active", fadedOpacity)}
            </linearGradient>
          ))
        )}
      </defs>
    </svg>
  );
});
