import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { subscribeLivePlayhead, useStitchEditorStore } from "@/store/stitchEditorStore";
import { buildTimeAxis, fitPxPerSec, MAX_PX_PER_SEC, MIN_PX_PER_SEC, type TimeAxis } from "@/lib/stitch/timeAxis";
import { draftSpans } from "@/lib/stitch/draft";
import { spansEnd, type ClipSpan } from "@/lib/stitch/timeline";
import { GEOMETRY, LANE_TRAILING_PX } from "../editorStyles";

/**
 * The timeline's zoom, shared by the lane (which it lays out), the control
 * row (−, + and Fit), the editor's keys (− = and ⇧Z) and ⌘ wheel or pinch
 * over the lanes. The store holds the chosen px/s, or null for Fit, which
 * follows the lane's width as it is observed. A zoom keeps one moment where
 * it was on screen: the pointer's
 * for the wheel, otherwise the playhead when it is in view, else the middle.
 * While the preview plays, it scrolls the lanes to keep the playhead in view.
 *
 * In Stacked the axis is linear: an empty clip sits in its own row and
 * takes no width from the clips after it. Fit leaves room for its slot only
 * where it would reach past the sequence's end.
 *
 * It also holds the lanes' scroll position for the parts drawn only across
 * the visible range (ticks, filmstrip frames). Every scroll it makes itself
 * is published in the same tick, so those parts are never a frame behind.
 */

/** The lanes' scroll position as an external store: the timeline reads it, the zoom (and the scroll listener) write it. */
export interface ScrollPosition {
  get(): number;
  set(scrollLeft: number): void;
  subscribe(listener: () => void): () => void;
}

function createScrollPosition(): ScrollPosition {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface TimelineZoom {
  axis: TimeAxis;
  pxPerSec: number;
  /** The lanes' visible width, px (observed). */
  laneWidth: number;
  /**
   * The axis for the editor's state as it is now, not as the last render saw it: a press that blurs a field
   * (committing its edit) measures with this, since in Fit the zoom follows the sequence's length.
   */
  axisNow(): TimeAxis;
  /** The lanes' scroll position (subscribe with useSyncExternalStore). */
  scrollPosition: ScrollPosition;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  /** ⌘ wheel / pinch: zoom to pxPerSec keeping the time under viewX (px from the scroller's left) in place. */
  zoomAround(pxPerSec: number, viewX: number): void;
  /** The lanes' scroller; the lane measures and scrolls it. */
  scrollerRef: (el: HTMLDivElement | null) => void;
  scroller: { readonly current: HTMLDivElement | null };
}

const STEP = 1.5;
/** While playing, the lanes scroll once the playhead passes this share of their width. */
const FOLLOW_AT = 0.9;
const clampZoom = (pps: number) => Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pps));

const FIT_LAYOUT = { origin: GEOMETRY.origin, slotPx: GEOMETRY.emptySlot, trailingPx: LANE_TRAILING_PX };

/**
 * Fit's px/s. Track: every empty clip's slot shifts the clips after it, so all of them take room. Stacked: an empty clip's
 * slot sits at its start in its own row and can reach past the sequence's end (when the clips after it are short), so
 * the zoom is the largest at which the sequence and every slot still end inside the lane.
 */
function fitFor(spans: readonly ClipSpan[], laneWidth: number, stacked: boolean): number {
  // The latest end: a placed clip in a higher row can end after the last row's
  const total = spansEnd(spans);
  if (!stacked) return fitPxPerSec(total, spans.filter((s) => s.length <= 0).length, laneWidth, FIT_LAYOUT);
  let pps = fitPxPerSec(total, 0, laneWidth, FIT_LAYOUT);
  for (const span of spans) {
    // A slot at 0 s ends at the same x whatever the zoom
    if (span.length <= 0 && span.start > 0) pps = Math.min(pps, fitPxPerSec(span.start, 1, laneWidth, FIT_LAYOUT));
  }
  return pps;
}

const pxPerSecFor = (stored: number | null, spans: readonly ClipSpan[], laneWidth: number, stacked: boolean) =>
  stored ?? fitFor(spans, laneWidth, stacked);

/** The axis's slot width: Track's empty clips shift the clips after them; Stacked's sit at an instant in their own row. */
const slotPxFor = (stacked: boolean) => (stacked ? 0 : GEOMETRY.emptySlot);

/** The moment at lane x, and the pixels from that moment's own x to it (into an empty slot). */
function anchorAt(axis: TimeAxis, x: number, viewX: number): { time: number; extra: number; viewX: number } {
  const time = axis.xToTime(x);
  return { time, extra: x - axis.timeToX(time), viewX };
}

export function useTimelineZoom(spans: readonly ClipSpan[], stacked = false): TimelineZoom {
  const stored = useStitchEditorStore((s) => s.pxPerSec);
  const setZoom = useStitchEditorStore((s) => s.setZoom);
  const [laneWidth, setLaneWidth] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  /**
   * The moment to keep in place across the next zoom, where it was on screen, and how far past that moment's x the
   * anchor sat: 0, except inside an empty slot, whose pixels all read as one instant (the slot keeps its width).
   */
  const anchor = useRef<{ time: number; extra: number; viewX: number } | null>(null);
  const [scrollPosition] = useState(createScrollPosition);
  const latestLaneWidth = useRef(0);

  const pxPerSec = pxPerSecFor(stored, spans, laneWidth, stacked);
  const axis = useMemo(
    () => buildTimeAxis(spans, pxPerSec, GEOMETRY.origin, slotPxFor(stacked)),
    [spans, pxPerSec, stacked],
  );
  const latestAxis = useRef(axis);

  const scrollerRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    scroller.current = el;
    if (!el) return;
    const measure = () => {
      latestLaneWidth.current = el.clientWidth;
      setLaneWidth(el.clientWidth);
    };
    measure();
    scrollPosition.set(el.scrollLeft);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, [scrollPosition]);

  const axisNow = useCallback(() => {
    const s = useStitchEditorStore.getState();
    const now = s.draft ? draftSpans(s.draft, s.durations) : [];
    const stackedNow = s.draft?.sequenceLayout.mode === "stacked";
    return buildTimeAxis(
      now,
      pxPerSecFor(s.pxPerSec, now, latestLaneWidth.current, stackedNow),
      GEOMETRY.origin,
      slotPxFor(stackedNow),
    );
  }, []);

  // After a zoom, scroll so the anchored moment is back where it was
  useLayoutEffect(() => {
    latestAxis.current = axis;
    const el = scroller.current;
    const kept = anchor.current;
    anchor.current = null;
    if (!el || !kept) return;
    el.scrollLeft = Math.max(0, axis.timeToX(kept.time) + kept.extra - kept.viewX);
    scrollPosition.set(el.scrollLeft);
  }, [axis, scrollPosition]);

  // While the preview plays, the playhead stays in view: followed as it is drawn, every frame
  useEffect(
    () =>
      subscribeLivePlayhead((playhead) => {
        const el = scroller.current;
        if (!useStitchEditorStore.getState().playing || !el) return;
        const current = latestAxis.current;
        const x = current.timeToX(Math.min(playhead, current.total));
        const viewX = x - el.scrollLeft;
        if (viewX > el.clientWidth * FOLLOW_AT || viewX < 0) {
          el.scrollLeft = Math.max(0, x - el.clientWidth * (1 - FOLLOW_AT));
          scrollPosition.set(el.scrollLeft);
        }
      }),
    [scrollPosition],
  );

  // A zoom that the limits hold at the current px/s changes nothing: it sets no anchor, which the next
  // unrelated axis change (an edit, a duration arriving) would otherwise scroll back to
  const zoomAround = useCallback(
    (next: number, viewX: number) => {
      const el = scroller.current;
      const current = latestAxis.current;
      const target = clampZoom(next);
      if (target === current.pxPerSec) return;
      if (el) anchor.current = anchorAt(current, el.scrollLeft + viewX, viewX);
      setZoom(target);
    },
    [setZoom],
  );

  /** The playhead when it is in view, else the middle of the view. */
  const zoomKeepingFocus = useCallback(
    (next: number) => {
      const el = scroller.current;
      const current = latestAxis.current;
      const target = clampZoom(next);
      if (target === current.pxPerSec) return;
      if (el) {
        // The playhead as it is drawn: a stored one past a sequence that got shorter sits at the end
        const playhead = Math.min(useStitchEditorStore.getState().playhead, current.total);
        const x = current.timeToX(playhead) - el.scrollLeft;
        const inView = x >= 0 && x <= el.clientWidth;
        const viewX = inView ? x : el.clientWidth / 2;
        anchor.current = inView ? { time: playhead, extra: 0, viewX } : anchorAt(current, el.scrollLeft + viewX, viewX);
      }
      setZoom(target);
    },
    [setZoom],
  );

  const fit = useCallback(() => {
    anchor.current = null;
    if (scroller.current) scroller.current.scrollLeft = 0;
    scrollPosition.set(0);
    setZoom(null);
  }, [setZoom, scrollPosition]);

  return {
    axis,
    pxPerSec,
    laneWidth,
    axisNow,
    scrollPosition,
    zoomIn: () => zoomKeepingFocus(pxPerSec * STEP),
    zoomOut: () => zoomKeepingFocus(pxPerSec / STEP),
    fit,
    zoomAround,
    scrollerRef,
    scroller,
  };
}
