"use client";

import { useLayoutEffect, useRef } from "react";
import { livePlayhead, subscribeLivePlayhead } from "@/store/stitchEditorStore";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { GEOMETRY } from "../editorStyles";

/**
 * The playhead: a 1px white line down the lanes and a small rounded 9×12
 * head on the ruler. Drawn at the live playhead: placed when it renders, then
 * moved with it by writing its position, so a playing preview renders none
 * of the timeline (useTimelineZoom keeps it in view). The line ends
 * at the strip under the audio rows (`bottom`), clear of "+ Audio". While a
 * trim is snapped to it, the line is left out and the trim's dashed guide
 * takes its place under the head (Trim.png). While a trim lengthens a clip,
 * the timeline passes the axis release will leave (liveSpans), so the
 * playhead moves with the pushed clips and slots. Stacked draws the head in
 * the sticky ruler and the line in a box pinned to the rows' view, so each
 * takes one part; the head's part carries the line on through the ruler,
 * which covers the other line there.
 */
export function Playhead({
  axis,
  limit = axis.total,
  hideLine = false,
  part = "all",
  top = 0,
  bottom = 0,
}: {
  axis: TimeAxis;
  /** The playhead is drawn no later than this (the sequence's end at rest; a stored one past it sits there). */
  limit?: number;
  hideLine?: boolean;
  part?: "all" | "line" | "head";
  /** The line's ends inside the box it is drawn in, px. */
  top?: number;
  bottom?: number;
}) {
  const line = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const x = axis.timeToX(Math.min(livePlayhead(), limit));

  useLayoutEffect(() => {
    const move = (t: number) => {
      const at = axis.timeToX(Math.min(t, limit));
      if (line.current) line.current.style.left = `${at}px`;
      if (head.current) head.current.style.left = `${at - 4}px`;
    };
    move(livePlayhead());
    return subscribeLivePlayhead(move);
  }, [axis, limit, hideLine, part]);

  return (
    <>
      {!hideLine && (
        <div
          ref={line}
          aria-hidden="true"
          data-testid={part === "head" ? undefined : "stitch-playhead-line"}
          className="pointer-events-none absolute z-3 w-px bg-neutral-100"
          style={{ left: x, top, bottom }}
        />
      )}
      {part !== "line" && (
        <div
          ref={head}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-3 w-[9px] rounded-t-[2px] rounded-b-[5px] bg-neutral-100"
          style={{ left: x - 4, height: GEOMETRY.playheadHead }}
        />
      )}
    </>
  );
}
