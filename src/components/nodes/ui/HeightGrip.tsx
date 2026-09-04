"use client";

import React, { useCallback, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { cn } from "./cn";

interface HeightGripProps {
  height: number;
  min?: number;
  max?: number;
  onChange: (height: number) => void;
  className?: string;
}

/**
 * A grab bar along the bottom edge of a fixed-height media slot (text
 * surfaces). Dragging it changes the slot's height in flow pixels, so it
 * accounts for the canvas zoom.
 */
export function HeightGrip({ height, min = 60, max = 800, onChange, className }: HeightGripProps) {
  const reactFlow = useReactFlow();
  const drag = useRef<{ startY: number; startH: number; zoom: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const zoom = typeof reactFlow.getZoom === "function" ? reactFlow.getZoom() || 1 : 1;
      drag.current = { startY: e.clientY, startH: height, zoom };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [height, reactFlow]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      const dy = (e.clientY - drag.current.startY) / drag.current.zoom;
      const next = Math.round(Math.max(min, Math.min(max, drag.current.startH + dy)));
      if (next !== height) onChange(next);
    },
    [height, max, min, onChange]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize text area"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "nodrag nopan absolute bottom-0 left-0 right-0 h-3 flex items-end justify-center cursor-ns-resize group/grip",
        className
      )}
    >
      <span className="mb-[3px] w-6 h-[3px] rounded-full bg-neutral-600 group-hover/grip:bg-neutral-400 transition-colors" />
    </div>
  );
}
