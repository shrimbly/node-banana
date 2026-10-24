import { spansEnd, type ClipSpan } from "./timeline";

/**
 * Sequence time ↔ lane pixels for the Stitch editor's timeline.
 *
 * Time maps linearly from the origin, except that a clip with no length
 * (not generated yet, loading, unreadable, gone from the library, trimmed
 * past its end or to under a frame) is drawn as a fixed-width slot that sits
 * at a single instant: every box after it moves right by the slot's width,
 * and the slot's own pixels all read as its time.
 * A playhead at a slot's time sits before the slot.
 *
 * Pure: no React, no DOM.
 */

export const MIN_PX_PER_SEC = 8;
export const MAX_PX_PER_SEC = 480;
/** 0:00 sits this far from the lane's left edge. */
export const AXIS_ORIGIN_PX = 16;
/** The drawn width of a clip with no length. */
export const EMPTY_SLOT_PX = 160;
/** Room Fit leaves after the last clip: the add slot (52) with its 8px gap, and a 16px margin. */
export const FIT_TRAILING_PX = 8 + 52 + 16;
/** The zoom when there is nothing timed to fit (the Main board's 64 px/s). */
export const DEFAULT_PX_PER_SEC = 64;

export interface AxisSlot {
  clipId: string;
  index: number;
  t: number;
  x: number;
  width: number;
}

export interface TimeAxis {
  pxPerSec: number;
  /** origin + t·pps + the widths of the slots whose time < t (a playhead at a slot's time sits before it). */
  timeToX(t: number): number;
  /** Inverse; an x inside a slot returns the slot's time. */
  xToTime(x: number): number;
  /** Box per span index: x = origin + start·pps + widths of slots with index < i; width = length·pps, or the slot width. */
  clipBox(index: number): { x: number; width: number };
  slots: ReadonlyArray<AxisSlot>;
  /** timeToX(total) plus the trailing slots: where the last box ends. */
  endX: number;
  /** One loop, seconds. */
  total: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function buildTimeAxis(
  spans: readonly ClipSpan[],
  pxPerSec: number,
  origin: number = AXIS_ORIGIN_PX,
  slotPx: number = EMPTY_SLOT_PX,
): TimeAxis {
  const pps = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : MIN_PX_PER_SEC;
  const boxes: { x: number; width: number }[] = [];
  const slots: AxisSlot[] = [];
  let shift = 0;
  for (const span of spans) {
    const x = origin + span.start * pps + shift;
    if (span.length > 0) {
      boxes.push({ x, width: span.length * pps });
    } else {
      boxes.push({ x, width: slotPx });
      // A slotPx of 0 keeps the axis linear (Stacked: an empty clip sits in its own row, taking no time or width).
      if (slotPx > 0) {
        slots.push({ clipId: span.clip.id, index: span.index, t: span.start, x, width: slotPx });
        shift += slotPx;
      }
    }
  }
  // The latest end of a clip with frames: an empty clip placed past it widens nothing in time
  const total = spansEnd(spans);

  const timeToX = (t: number): number => {
    let x = origin + t * pps;
    for (const slot of slots) if (slot.t < t) x += slot.width;
    return x;
  };

  const xToTime = (x: number): number => {
    let consumed = 0;
    for (const slot of slots) {
      const slotLeft = origin + slot.t * pps + consumed;
      if (x < slotLeft) break;
      if (x < slotLeft + slot.width) return slot.t;
      consumed += slot.width;
    }
    return (x - origin - consumed) / pps;
  };

  return {
    pxPerSec: pps,
    timeToX,
    xToTime,
    clipBox: (index) => boxes[index] ?? { x: timeToX(total), width: 0 },
    slots,
    endX: origin + total * pps + shift,
    total,
  };
}

/**
 * The zoom at which the whole sequence fits the lane: (laneWidth − origin − trailing room − slots) / max(seq, 1),
 * clamped. A sequence with no length (nothing timed, only slots) has nothing to fit: DEFAULT_PX_PER_SEC.
 * The layout defaults match buildTimeAxis's; the editor passes its GEOMETRY.
 */
export function fitPxPerSec(
  sequenceSec: number,
  slotCount: number,
  laneWidthPx: number,
  layout: { origin?: number; slotPx?: number; trailingPx?: number } = {},
): number {
  if (!(Number.isFinite(sequenceSec) && sequenceSec > 0)) return DEFAULT_PX_PER_SEC;
  const { origin = AXIS_ORIGIN_PX, slotPx = EMPTY_SLOT_PX, trailingPx = FIT_TRAILING_PX } = layout;
  const room = laneWidthPx - origin - trailingPx - slotCount * slotPx;
  const seconds = Math.max(sequenceSec, 1);
  const pps = room / seconds;
  return clamp(Number.isFinite(pps) ? pps : MIN_PX_PER_SEC, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
}
