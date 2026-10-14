"use client";

import { useContext, useLayoutEffect, useRef } from "react";
import { EdgeLabelRenderer } from "@/components/flowPortals";
import { EdgeLabelCoverContext, labelClip } from "./edgeLabelCover";

/**
 * The pill a connection wears: the user's own label or the automatic one
 * ("Image 2", "Text") at its midpoint, the item an Array connection carries
 * at its target end, plus the loop count on loop edges.
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
  /** Which side of the pill sits on (x, y): its centre, or its right or left edge. */
  anchor?: "center" | "end" | "start";
}

const ANCHOR_SHIFT = { center: "-50%", end: "-100%", start: "0%" } as const;
const ANCHOR_FRACTION = { center: -0.5, end: -1, start: 0 } as const;

export function EdgeLabel({ x, y, text, color, loopCount, active, anchor = "center" }: EdgeLabelProps) {
  const cover = useContext(EdgeLabelCoverContext);
  const ref = useRef<HTMLDivElement>(null);
  // Where something other than the node layer covers labels (the GPU canvas's painted nodes), the pill is cut
  // where a box lies over it, as a node above it would hide it. Without a cover (classic) nothing is touched.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || (!cover && !el.style.clipPath && !el.style.visibility)) return;
    const clip = cover?.length ? labelClip({ x: x + ANCHOR_FRACTION[anchor] * el.offsetWidth, y: y - el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight }, cover) : null;
    el.style.visibility = clip === "hidden" ? "hidden" : "";
    el.style.clipPath = clip && clip !== "hidden" ? clip : "";
  });
  if (!text && loopCount === undefined) return null;
  return (
    <EdgeLabelRenderer>
      <div
        ref={ref}
        data-testid="edge-label"
        className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full bg-neutral-800/90 border text-[10px] font-medium text-neutral-100 whitespace-nowrap transition-opacity duration-150"
        style={{
          position: "absolute",
          transform: `translate(${x}px, ${y}px) translate(${ANCHOR_SHIFT[anchor]}, -50%)`,
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
