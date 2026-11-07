"use client";

import { memo } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { nearestFrame } from "@/lib/stitch/mediaInfo";
import { GEOMETRY } from "../editorStyles";

/**
 * A clip's frames, one 56px cell after another from its left edge. Each
 * cell shows the source frame at its own time (In plus the cell's middle),
 * so the frames slide when the In moves. Only the cells inside the visible
 * range are drawn. The frames come from the shared media cache (at most
 * twelve per source; a cell takes the nearest).
 */
export const Filmstrip = memo(function Filmstrip({
  frames,
  duration,
  inSec,
  pxPerSec,
  width,
  boxX,
  viewLeft,
  viewRight,
  className,
}: {
  frames: ReadonlyArray<string | null>;
  duration: number | null;
  /** Source seconds at the strip's left edge. */
  inSec: number;
  pxPerSec: number;
  width: number;
  /** The strip's left in lane pixels, and the visible lane range, for virtualising the cells. */
  boxX: number;
  viewLeft: number;
  viewRight: number;
  className?: string;
}) {
  const cell = GEOMETRY.frameCell;
  const count = Math.max(0, Math.ceil(width / cell));
  const first = Math.max(0, Math.floor((viewLeft - boxX) / cell));
  const last = Math.min(count - 1, Math.ceil((viewRight - boxX) / cell));
  const info = { frames, duration };
  const cells = [];
  for (let k = first; k <= last; k++) {
    const src = nearestFrame(info, inSec + (k * cell + cell / 2) / pxPerSec);
    cells.push(
      <div key={k} className="absolute inset-y-0" style={{ left: k * cell, width: cell }}>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element -- an object URL the media cache owns
          <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
        )}
        <span className="absolute inset-y-0 right-0 w-px bg-black/40" />
      </div>,
    );
  }
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0", className)}>
      {cells}
    </div>
  );
});
