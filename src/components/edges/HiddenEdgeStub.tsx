"use client";

/**
 * The label a hidden connection leaves at a handle. Hovering it ghosts the
 * noodle back; clicking it shows the connection again. Rendered inside
 * EdgeLabelRenderer by the edge itself, so it follows the handle.
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
  onHoverChange: (hovering: boolean) => void;
  onShow: () => void;
}

export function HiddenEdgeStub({ side, x, y, direction, label, color, onHoverChange, onShow }: HiddenEdgeStubProps) {
  const anchor = direction === 1 ? "translate(0, -50%)" : "translate(-100%, -50%)";
  return (
    <div
      className="nodrag nopan"
      data-testid={`hidden-edge-stub-${side}`}
      style={{ position: "absolute", transform: `translate(${x}px, ${y}px) ${anchor}`, pointerEvents: "all" }}
    >
      <button
        type="button"
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        onClick={onShow}
        title="Hidden connection. Click to show"
        className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full bg-neutral-800/90 text-[10px] font-medium text-neutral-100 whitespace-nowrap border hover:bg-neutral-700 transition-colors"
        style={{ borderColor: `${color}99` }}
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        <span>{label}</span>
      </button>
    </div>
  );
}
