"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Magnet } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { CHROME_SURFACE } from "@/components/chromeStyles";
import { nearestFrame } from "@/lib/stitch/mediaInfo";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { EDITOR_CHIP, GEOMETRY } from "../editorStyles";
import type { ClipMediaView } from "../useStitchEditorMedia";
import type { TrimLive } from "./useTrimDrag";

/** The popover: a 128px card (120×68 frame and an 18px caption, 4px padding) and its 5px arrow. */
const POPOVER_WIDTH = 128;
const POPOVER_HEIGHT = 101;
/** How far the arrow may leave the card's middle: its 10px width and the 8px corner stay on the card. */
const ARROW_TRAVEL = POPOVER_WIDTH / 2 - 5 - 8;
/** Room an In edge's length chip takes on its left ("−10.00 s"); with less before the view's left it goes right. */
const DELTA_CHIP_ROOM = 64;
/** A seek this close to the element's time is not issued. */
const SEEK_EPSILON = 0.001;

/**
 * The frame under the handle: the dragged clip's own source in a paused
 * <video>, seeked to the edge's source time. The latest target wins: while
 * a seek is in flight the next one waits for `seeked`. Until the first seek
 * lands, the nearest filmstrip frame stands in; when the first target is
 * already the element's own time (an In at 0), no seek is needed and the
 * loaded frame replaces it. No canvas, so a source served without CORS
 * still shows.
 */
function EdgeFrame({ src, time, fallback }: { src: string | null; time: number; fallback: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const target = useRef(time);
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    target.current = time;
    const el = ref.current;
    if (!el || el.seeking) return;
    if (Math.abs(el.currentTime - time) > SEEK_EPSILON) el.currentTime = time;
  }, [time]);

  const onSeeked = () => {
    setLanded(true);
    const el = ref.current;
    if (el && Math.abs(el.currentTime - target.current) > SEEK_EPSILON) el.currentTime = target.current;
  };
  const onLoadedData = () => {
    const el = ref.current;
    if (!el || el.seeking) return;
    if (Math.abs(el.currentTime - target.current) <= SEEK_EPSILON) setLanded(true);
    else el.currentTime = target.current;
  };

  return (
    <div className="relative h-[68px] w-[120px] overflow-hidden rounded bg-black">
      {src && (
        <video
          ref={ref}
          src={src}
          muted
          playsInline
          preload="auto"
          data-testid="stitch-edge-frame"
          onSeeked={onSeeked}
          onLoadedData={onLoadedData}
          className="h-[68px] w-[120px] rounded object-cover"
        />
      )}
      {!landed && fallback && (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL the media cache owns
        <img src={fallback} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
    </div>
  );
}

/**
 * The frame popover over a dragged edge (Trim.png). It sits above the clips
 * row, over the ruler and the transport, so it is a fixed layer outside the
 * timeline's clipping, placed from the lane's position on screen. Its top
 * is measured again after each layout: a press that selects the clip
 * collapses an expanded audio lane, which moves the lanes down after the
 * press measured them.
 */
export function TrimOverlay({
  trim,
  edgeX: laneEdgeX,
  view,
  src,
  contentRef,
  rowTop = GEOMETRY.ruler,
}: {
  trim: TrimLive;
  /** The dragged edge on the lane (trimEdgeX). */
  edgeX: number;
  view: ClipMediaView | undefined;
  src: string | null;
  /** The lane content, whose top the popover stands on. */
  contentRef?: RefObject<HTMLDivElement | null>;
  /** Where the arrow points, in content px: the clips row's top in Track (the ruler's foot), the dragged box's top in Stacked. */
  rowTop?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const content = contentRef?.current;
    if (!el || !content) return;
    el.style.top = `${content.getBoundingClientRect().top + rowTop - POPOVER_HEIGHT}px`;
  });
  const edgeX = trim.laneLeft + laneEdgeX;
  // Kept over the visible lanes when the edge is near or past their sides; the arrow still points at the edge
  const room = trim.viewRight - trim.viewLeft >= POPOVER_WIDTH;
  const center = room
    ? Math.min(Math.max(edgeX, trim.viewLeft + POPOVER_WIDTH / 2), trim.viewRight - POPOVER_WIDTH / 2)
    : edgeX;
  const arrowShift = Math.min(Math.max(edgeX - center, -ARROW_TRAVEL), ARROW_TRAVEL);
  const time = trim.result.edgeSourceTime;
  const fallback = view ? nearestFrame(view, time) : null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="stitch-trim-popover"
      className="pointer-events-none fixed z-100 flex flex-col items-center"
      style={{ left: center - POPOVER_WIDTH / 2, top: trim.laneTop + rowTop - POPOVER_HEIGHT, width: POPOVER_WIDTH }}
    >
      <div className={cn(CHROME_SURFACE, "w-full rounded-media p-1")}>
        <EdgeFrame src={src} time={time} fallback={fallback} />
        <div className="flex h-[18px] items-center justify-between px-1 text-[10px]">
          <span className="text-neutral-400">{trim.edge === "out" ? "Out" : "In"}</span>
          <span className="tabular-nums text-neutral-100">{formatTimecode(time)}</span>
        </div>
      </div>
      <div
        className="h-[5px] w-2.5 bg-neutral-800/92 [clip-path:polygon(0_0,100%_0,50%_100%)]"
        style={arrowShift === 0 ? undefined : { transform: `translateX(${arrowShift}px)` }}
      />
    </div>
  );
}

/**
 * Inside the lanes, scrolling with them: the length change beside the
 * dragged edge, and when the edge has snapped, the dashed guide from the
 * ruler down through the clips row with a chip naming what it snapped to.
 * The guide stands where the snapped time is; that is the drawn edge except
 * for a lengthening In, whose clip is drawn as release leaves it.
 */
export function TrimMarks({
  trim,
  axis,
  edgeX,
  scrollLeft,
  row,
}: {
  trim: TrimLive;
  /** The axis the playhead is drawn on during the drag (built from liveSpans). */
  axis: TimeAxis;
  /** The dragged edge on the lane (trimEdgeX). */
  edgeX: number;
  /** The lanes' scroll position: an In's chip goes right of the edge when the left has no room. */
  scrollLeft: number;
  /** Stacked: the dragged box's top and bottom in content px. Without it, Track's clips row. */
  row?: { top: number; bottom: number };
}) {
  const { edge } = trim.start;
  // On the playhead's axis: a snapped playhead and its guide are drawn at the same x, even with a slot between
  const snapX = axis.timeToX(trim.result.edgeSeqTime);
  const snapped = trim.result.snapped;
  const chipOnRight = edge === "out" || edgeX - 12 - DELTA_CHIP_ROOM < scrollLeft;
  const deltaTop = row ? row.top + 10 : GEOMETRY.ruler + 26;
  const clipsBottom = row ? row.bottom : GEOMETRY.ruler + GEOMETRY.clipRow;
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="stitch-trim-delta"
        className={cn(EDITOR_CHIP, "pointer-events-none absolute z-4 whitespace-nowrap tabular-nums text-neutral-200")}
        style={{
          top: deltaTop,
          ...(chipOnRight ? { left: edgeX + 12 } : { right: `calc(100% - ${edgeX - 12}px)` }),
        }}
      >
        {formatSeconds(trim.result.deltaSec, 2, { signed: true })}
      </div>
      {snapped && (
        <SnapGuide x={snapX} bottom={clipsBottom} chipTop={clipsBottom + 12} text={`Snapped to ${snapped.label}`} />
      )}
    </>
  );
}

/**
 * A snap, inside the lanes: the dashed guide from the playhead's head (as its line would) down to `bottom` at the snapped time, and the chip
 * naming what it snapped to, 9px right of the guide. A trim and a body drag both draw it; the audio section passes
 * the ruler's place in its own box as `top`.
 */
export function SnapGuide({
  x,
  bottom,
  chipTop,
  text,
  top = GEOMETRY.playheadHead,
}: {
  x: number;
  bottom: number;
  chipTop: number;
  text: string;
  top?: number;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute z-4 border-l border-dashed border-neutral-200/70"
        style={{ left: x, top, height: bottom - top + 1 }}
      />
      <div
        data-testid="stitch-snap-chip"
        className={cn(EDITOR_CHIP, "pointer-events-none absolute z-4 inline-flex items-center gap-1.5 whitespace-nowrap text-neutral-300")}
        style={{ left: x + 9, top: chipTop }}
      >
        <Magnet size={11} strokeWidth={1.75} />
        {text}
      </div>
    </>
  );
}
