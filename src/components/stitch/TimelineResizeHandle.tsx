"use client";

import { useRef, useState, type PointerEvent } from "react";
import { GEOMETRY } from "./editorStyles";

/** ↑ and ↓ move the edge this far, ⇧↑ and ⇧↓ eight times as far, px. */
const KEY_STEP_PX = 8;

/**
 * The timeline's top edge, as a handle. Drag it up and the timeline takes
 * height from the stage, which keeps GEOMETRY.stageFloor (maxHeight); drag it
 * down and it gives the height back, down to GEOMETRY.timeline. ↑ and ↓ move
 * it from the keyboard (the editor's own arrows take ⌥), and a double-click
 * lets the timeline fit its rows again. At rest it is the
 * timeline's own hairline; under the pointer, while dragged or focused that
 * line lightens.
 */
export function TimelineResizeHandle({
  height,
  maxHeight,
  onChange,
}: {
  /** The height the timeline is drawn at (Timeline's onHeight). */
  height: number;
  /** The most the timeline may take; Infinity while unmeasured. */
  maxHeight: number;
  /** A new height, or null to fit the rows again. */
  onChange: (height: number | null) => void;
}) {
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (height: number) => Math.round(Math.max(GEOMETRY.timeline, Math.min(height, maxHeight)));

  const end = (e: PointerEvent) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className="relative z-10 h-0 shrink-0">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Timeline height"
        aria-valuenow={Math.round(height)}
        aria-valuemin={GEOMETRY.timeline}
        aria-valuemax={Number.isFinite(maxHeight) ? Math.round(maxHeight) : undefined}
        tabIndex={0}
        title="Drag to resize the timeline. Double-click to fit it."
        data-dragging={dragging || undefined}
        className="group absolute inset-x-0 -top-1.5 h-2 cursor-row-resize touch-none outline-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: height };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.pointerId !== e.pointerId) return;
          onChange(clamp(d.startHeight + d.startY - e.clientY));
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => onChange(null)}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const step = (e.shiftKey ? 8 : 1) * KEY_STEP_PX;
          onChange(clamp(height + (e.key === "ArrowUp" ? step : -step)));
        }}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1.5 h-px transition-colors group-hover:bg-neutral-600 group-focus-visible:bg-white/40 group-data-[dragging]:bg-neutral-400" />
      </div>
    </div>
  );
}
