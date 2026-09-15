"use client";

import { EdgeLabelRenderer } from "@xyflow/react";

/**
 * The pill a connection wears at its midpoint: the user's own label or the
 * automatic one ("Image 2", "Text"), plus the loop count on loop edges.
 * Rendered through EdgeLabelRenderer so it stays crisp at any zoom and
 * never blocks clicks on the noodle beneath it.
 */

interface EdgeLabelProps {
  x: number;
  y: number;
  text: string;
  color: string;
  loopCount?: number;
  /** Faded when the edge is not attached to a selected node. */
  active: boolean;
}

export function EdgeLabel({ x, y, text, color, loopCount, active }: EdgeLabelProps) {
  if (!text && loopCount === undefined) return null;
  return (
    <EdgeLabelRenderer>
      <div
        data-testid="edge-label"
        className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full bg-neutral-800/90 border text-[10px] font-medium text-neutral-100 whitespace-nowrap transition-opacity duration-150"
        style={{
          position: "absolute",
          transform: `translate(${x}px, ${y}px) translate(-50%, -50%)`,
          pointerEvents: "none",
          borderColor: `${color}99`,
          opacity: active ? 1 : 0.7,
        }}
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        {text && <span>{text}</span>}
        {loopCount !== undefined && (
          <span className="text-fuchsia-200" data-testid="edge-label-loop">
            ↻ {loopCount}×
          </span>
        )}
      </div>
    </EdgeLabelRenderer>
  );
}
