import { EMPTY_SLOT_PX, type TimeAxis } from "./timeAxis";
import type { ClipSpan } from "./timeline";
import type { TrimDragResult } from "./trimDrag";

/**
 * Where the clips row draws each clip, in lane pixels, while a trim runs or
 * at rest. Ripple trims: a clip's start never moves, so on release the
 * dragged clip keeps its left and the clips after it close up or move out by
 * the length change.
 *
 * - Shortening (either edge): the dragged edge follows the pointer, the
 *   crossed part is the ghost, and the clips after it hold their places
 *   until release.
 * - Lengthening (either edge): the clip is drawn as release will leave it
 *   (its left where it was, its new length), and the clips after it are
 *   pushed live, so nothing jumps on release.
 *
 * Pure: no React, no DOM.
 */

/** Half the 2px gap the boards leave between clips that touch in time. */
export const JOIN_INSET_PX = 1;
/** A clip is never drawn narrower than this, so a very short piece at a low zoom can still be pressed. */
export const MIN_DRAWN_PX = 4;

export interface LaneTrim {
  clipId: string;
  edge: "in" | "out";
  result: Pick<TrimDragResult, "inSec" | "lengthSec" | "deltaSec" | "edgeSeqTime">;
}

export interface LaneBox {
  x: number;
  width: number;
  /** Source seconds at the box's left edge, and the length it shows (live while trimming). */
  inSec: number;
  lengthSec: number;
}

export function laneBoxes(axis: TimeAxis, spans: readonly ClipSpan[], trim: LaneTrim | null): LaneBox[] {
  const pps = axis.pxPerSec;
  const at = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  return spans.map((span, i) => {
    const base = axis.clipBox(i);
    const rest = { ...base, inSec: span.clip.inSec, lengthSec: span.length };
    if (!trim || at === -1 || i < at) return rest;
    const { result, edge } = trim;
    const lengthening = result.deltaSec > 0;
    if (i === at) {
      const left = edge === "in" && !lengthening ? base.x + (result.edgeSeqTime - span.start) * pps : base.x;
      return { x: left, width: result.lengthSec * pps, inSec: result.inSec, lengthSec: result.lengthSec };
    }
    return lengthening ? { ...rest, x: base.x + result.deltaSec * pps } : rest;
  });
}

/**
 * The spans as the lane draws them: while a trim lengthens a clip, its new length and the clips after it pushed
 * by the change (as release will leave them); otherwise the spans themselves. The playhead and the snap guide are
 * placed on an axis built from these, so they line up with the pushed boxes (a slot between an edge and the
 * playhead moves with the clips).
 */
export function liveSpans(spans: readonly ClipSpan[], trim: LaneTrim | null): readonly ClipSpan[] {
  if (!trim || !(trim.result.deltaSec > 0)) return spans;
  const at = spans.findIndex((s) => s.clip.id === trim.clipId);
  if (at === -1) return spans;
  const { deltaSec, lengthSec } = trim.result;
  return spans.map((span, i) => {
    if (i < at) return span;
    if (i === at) return { ...span, length: lengthSec, end: span.start + lengthSec };
    return { ...span, start: span.start + deltaSec, end: span.end + deltaSec };
  });
}

/**
 * Stacked rows: each clip's box on a linear axis, from its own start. Boxes overlap in x (each sits in its own row),
 * so there are no join insets. An empty clip is drawn emptyPx wide at its instant.
 */
export function stackedBoxes(axis: TimeAxis, spans: readonly ClipSpan[], emptyPx: number = EMPTY_SLOT_PX): LaneBox[] {
  return spans.map((span) => ({
    x: axis.timeToX(span.start),
    width: span.length > 0 ? Math.max(MIN_DRAWN_PX, span.length * axis.pxPerSec) : emptyPx,
    inSec: span.clip.inSec,
    lengthSec: span.length,
  }));
}

/** The dragged edge's x on the lane, from its drawn box: the popover, the length chip and the dragged handle sit there. */
export function trimEdgeX(box: { x: number; width: number }, edge: "in" | "out"): number {
  return edge === "in" ? box.x : box.x + box.width;
}

/**
 * A box as drawn: inset by JOIN_INSET_PX on each side it shares with another clip. One too narrow for that is
 * drawn MIN_DRAWN_PX wide, centred on its place (the insets leave its neighbours room for it).
 */
export function insetBox(box: { x: number; width: number }, index: number, count: number): { x: number; width: number } {
  const left = index > 0 ? JOIN_INSET_PX : 0;
  const right = index < count - 1 ? JOIN_INSET_PX : 0;
  const width = box.width - left - right;
  if (width >= MIN_DRAWN_PX) return { x: box.x + left, width };
  return { x: box.x + box.width / 2 - MIN_DRAWN_PX / 2, width: MIN_DRAWN_PX };
}
