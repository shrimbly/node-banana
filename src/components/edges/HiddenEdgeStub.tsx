"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

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
  /** Tooltip; defaults to "Hidden connection". */
  title?: string;
  color: string;
  selected: boolean;
  onHoverChange: (hovering: boolean) => void;
  onSelect: () => void;
  /** Reports the pill's width (flow px) so the edge can draw to its outer edge. */
  onMeasure?: (width: number) => void;
}

export function HiddenEdgeStub({ side, x, y, direction, label, title = "Hidden connection", color, selected, onHoverChange, onSelect, onMeasure }: HiddenEdgeStubProps) {
  const pillRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    onMeasure?.(pillRef.current?.offsetWidth ?? 0);
  }, [label, onMeasure]);

  // A pill can vanish under the pointer (a collapsed group expands on click),
  // so a hover it reported must be taken back when it unmounts
  const hoveredRef = useRef(false);
  const onHoverChangeRef = useRef(onHoverChange);
  onHoverChangeRef.current = onHoverChange;
  const setHovered = (hovering: boolean) => {
    hoveredRef.current = hovering;
    onHoverChangeRef.current(hovering);
  };
  useEffect(() => () => {
    if (hoveredRef.current) onHoverChangeRef.current(false);
  }, []);

  const anchor = direction === 1 ? "translate(0, -50%)" : "translate(-100%, -50%)";
  return (
    <div
      className="nodrag nopan"
      data-testid={`hidden-edge-stub-${side}`}
      // Flex, so the wrapper is exactly the pill's height and -50% centres it on
      // the handle. A selected node or edge lifts edge SVGs above the label
      // layer, so the pill keeps a z-index above any elevated edge or a noodle
      // would be drawn across it.
      style={{ position: "absolute", display: "flex", transform: `translate(${x}px, ${y}px) ${anchor}`, pointerEvents: "all", zIndex: 2001 }}
    >
      <button
        ref={pillRef}
        type="button"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={title}
        className={`inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-medium leading-none text-neutral-100 whitespace-nowrap border transition-colors ${
          selected ? "bg-neutral-700" : "bg-neutral-800/90 hover:bg-neutral-700"
        }`}
        style={{ borderColor: `${color}${selected ? "" : "99"}` }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        {/* Optical centring: the system font sits low in its line box at this size */}
        <span className="leading-none relative -top-px">{label}</span>
      </button>
    </div>
  );
}
