"use client";

import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { rulerTicks } from "@/lib/stitch/rulerTicks";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { pause } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { releaseTypingFocus } from "./releaseTypingFocus";

/** A label sits 5px right of its tick and is at most this wide ("10:00.00" at 11px tabular figures). */
const LABEL_ROOM = 52;

/**
 * The 28px ruler over the lanes, with no other chrome, as the boards draw
 * it: a tick from 8px down to the foot beside each label (11px ink-3,
 * tabular figures, at the zoom's spacing) and one short mark half-way
 * between each two, drawn only across the visible range. A tick whose label
 * has no room before the lanes' end is a short mark. Pressing or dragging on
 * it pauses and moves the playhead. An empty sequence shows only the short
 * marks where its labels would be.
 */
export function Ruler({
  axis,
  axisNow,
  viewLeft,
  viewRight,
  maxX,
  contentRef,
  showLabels,
}: {
  axis: TimeAxis;
  /** The axis for the editor's state now: a press that commits a focused field seeks on the zoom it leads to. */
  axisNow: () => TimeAxis;
  viewLeft: number;
  viewRight: number;
  /** The content's width: nothing is drawn past it, so the ruler never widens the scroll area. */
  maxX: number;
  contentRef: RefObject<HTMLDivElement | null>;
  showLabels: boolean;
}) {
  const dragging = useRef(false);
  const ticks = rulerTicks(axis.pxPerSec, Math.max(0, axis.xToTime(viewLeft)), Math.max(0, axis.xToTime(viewRight - 1)));
  // The labels drawn: each beside its tick, never past the content
  const labels = showLabels ? ticks.labels.filter(({ t }) => axis.timeToX(t) + 5 + LABEL_ROOM <= maxX) : [];
  const labelled = new Set(labels.map(({ t }) => t));

  const seekTo = (clientX: number) => {
    const left = contentRef.current?.getBoundingClientRect().left ?? 0;
    const now = axisNow();
    const t = Math.min(Math.max(now.xToTime(clientX - left), 0), now.total);
    useStitchEditorStore.getState().setPlayhead(t);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // preventDefault keeps focus where it is: a focused In/Out field lets go first, so I and O reach the editor
    releaseTypingFocus(event.currentTarget);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = true;
    pause();
    seekTo(event.clientX);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekTo(event.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  return (
    <div
      data-testid="stitch-ruler"
      className="absolute inset-x-0 top-0 cursor-pointer"
      style={{ height: GEOMETRY.ruler }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {showLabels &&
        ticks.minors.map((t) => (
          <span
            key={`m${t}`}
            aria-hidden="true"
            data-ruler-mark="minor"
            className="absolute bottom-0 h-1.5 w-px bg-neutral-800"
            style={{ left: axis.timeToX(t) }}
          />
        ))}
      {ticks.majors.map((t) => (
        <span
          key={`M${t}`}
          aria-hidden="true"
          data-ruler-mark={labelled.has(t) ? "labelled" : "major"}
          className={cn("absolute bottom-0 w-px bg-edit-tick", labelled.has(t) ? "top-2" : "h-2")}
          style={{ left: axis.timeToX(t) }}
        />
      ))}
      {labels.map(({ t, text }) => (
        <span
          key={`L${t}`}
          className="pointer-events-none absolute top-[9px] text-[11px] leading-[11px] tabular-nums text-ink-3"
          style={{ left: axis.timeToX(t) + 5 }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}
