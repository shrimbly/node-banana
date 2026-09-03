"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * The label a hidden connection leaves at a handle. Hovering it ghosts the
 * noodle back; clicking it selects the connection so its toolbar (with the
 * Show action) appears above the label. Rendered inside EdgeLabelRenderer by
 * the edge itself, so it follows the handle.
 */

interface HiddenEdgeStubProps {
  /** Which end of the connection this stub marks. */
  side: "source" | "target";
  /** Anchor in flow coordinates: just outside the handle. */
  x: number;
  y: number;
  /** Which way the stub extends from the handle: +1 right, -1 left. */
  direction: 1 | -1;
  label: string;
  color: string;
  selected: boolean;
  onHoverChange: (hovering: boolean) => void;
  onSelect: () => void;
  /** Reports the pill's width (flow px) so the edge can draw to its outer edge. */
  onMeasure?: (width: number) => void;
}

export function HiddenEdgeStub({ side, x, y, direction, label, color, selected, onHoverChange, onSelect, onMeasure }: HiddenEdgeStubProps) {
  const pillRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    onMeasure?.(pillRef.current?.offsetWidth ?? 0);
  }, [label, onMeasure]);

  const anchor = direction === 1 ? "translate(0, -50%)" : "translate(-100%, -50%)";
  return (
    <div
      className="nodrag nopan"
      data-testid={`hidden-edge-stub-${side}`}
      style={{ position: "absolute", transform: `translate(${x}px, ${y}px) ${anchor}`, pointerEvents: "all" }}
    >
      <button
        ref={pillRef}
        type="button"
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title="Hidden connection"
        className={`inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-medium leading-none text-neutral-100 whitespace-nowrap border transition-colors ${
          selected ? "bg-neutral-700" : "bg-neutral-800/90 hover:bg-neutral-700"
        }`}
        style={{ borderColor: `${color}${selected ? "" : "99"}` }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="pt-px">{label}</span>
      </button>
    </div>
  );
}
