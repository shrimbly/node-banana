"use client";

import { useLayoutEffect, useRef } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { moveSnapText } from "@/lib/stitch/moveDrag";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { EDITOR_CHIP, GEOMETRY } from "../editorStyles";
import { SnapGuide } from "./TrimOverlay";
import type { MoveLive } from "./useClipMove";

/** The move chip's gap from the moving box, and its drop from the box's top, px. */
const CHIP_GAP = 12;
const CHIP_DROP = 10;

/** A box's bottom in the lane content from its top in the rows block, which starts under the ruler, px. */
const boxBottom = (rowTop: number) => GEOMETRY.ruler + rowTop + GEOMETRY.stackClipHeight;

/**
 * Inside the lanes, scrolling with them, while Stacked's body drag runs: the
 * chip with where the clip will play and how far it moved ("0:11.00–0:14.20
 * · −1.00 s"), right of the moving box (left of it, and inside the visible
 * lanes, when the right has no room), and when its start or end has
 * snapped, the dashed guide and the chip naming what it snapped to. For a
 * group the chip counts the clips and spans them all ("3 clips ·
 * 0:11.00–0:20.40 · −1.00 s"); the guide stays the pressed clip's.
 */
export function MoveOverlay({
  move,
  axis,
  lengthSec,
  boxWidth,
  boxTop,
  targetBoxTop,
  scrollLeft,
  laneWidth,
  group = null,
}: {
  move: MoveLive;
  axis: TimeAxis;
  /** The clip's length (0 for an empty clip, whose chip names its start only). */
  lengthSec: number;
  /** The moving box's width and its drawn top in the rows block, px. */
  boxWidth: number;
  boxTop: number;
  /** The top of the box that owns the snapped target, in the rows block; null for the playhead and 0:00. */
  targetBoxTop: number | null;
  /** The visible lanes' left in the content, and their width, px. */
  scrollLeft: number;
  laneWidth: number;
  /** A group drag: from the earliest moved start to the latest moved end, sequence seconds; null for one clip. */
  group?: { fromSec: number; toSec: number } | null;
}) {
  const chipRef = useRef<HTMLDivElement>(null);
  const { startSec, deltaSec } = move.result;
  const left = move.x;
  const right = move.x + boxWidth;
  const top = GEOMETRY.ruler + boxTop + CHIP_DROP;

  // Right of the box when it fits in the visible lanes, else left of it, never past their sides
  useLayoutEffect(() => {
    const el = chipRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const viewEnd = scrollLeft + laneWidth;
    let x = right + CHIP_GAP;
    if (laneWidth > 0 && x + width > viewEnd) {
      const before = left - CHIP_GAP - width;
      x = before >= scrollLeft ? before : Math.max(scrollLeft, viewEnd - width);
    }
    el.style.left = `${x}px`;
  });

  const span = group
    ? `${move.clipIds.length} clips · ${formatTimecode(group.fromSec)}–${formatTimecode(group.toSec)}`
    : lengthSec > 0
      ? `${formatTimecode(startSec)}–${formatTimecode(startSec + lengthSec)}`
      : formatTimecode(startSec);
  const text = moveSnapText(move.result);
  const bottom = boxBottom(boxTop);
  return (
    <>
      <div
        ref={chipRef}
        aria-hidden="true"
        data-testid="stitch-move-chip"
        className={cn(EDITOR_CHIP, "pointer-events-none absolute z-20 whitespace-nowrap tabular-nums text-neutral-200")}
        style={{ left: right + CHIP_GAP, top }}
      >
        {`${span} · ${formatSeconds(deltaSec, 2, { signed: true })}`}
      </div>
      {move.result.snapped && text && (
        <SnapGuide
          x={axis.timeToX(move.result.snapped.t)}
          bottom={Math.max(bottom, targetBoxTop === null ? 0 : boxBottom(targetBoxTop))}
          chipTop={bottom + CHIP_GAP}
          text={text}
        />
      )}
    </>
  );
}
