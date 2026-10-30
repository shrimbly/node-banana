import { clipName } from "./labels";
import {
  clampTrim,
  clipLength,
  neighbourTarget,
  originalEdgeTarget,
  snapTo,
  type ClipSpan,
  type SnapTarget,
} from "./timeline";

/**
 * One trim drag on a clip's edge, as a pure function of the pointer: the
 * trim it gives, where the edge sits, the length change and the part the
 * edge has crossed. The lane draws this while the pointer moves and applies
 * it once, on release.
 *
 * Ripple trims: a clip's start in the sequence never moves during the drag.
 * The Out edge follows the pointer at start + new length. The In edge
 * follows it at start + (new In − old In), and the clip closes up to its
 * start on release. In Stacked the start moves with an In edge (the frames
 * stay where they are) and nothing else moves.
 */

export interface TrimDragStart {
  span: ClipSpan;
  edge: "in" | "out";
  sourceDuration: number | undefined;
  pointerX: number;
  pxPerSec: number;
  /**
   * The press axis's xToTime. An In edge measures the pointer's travel on it: the clips and slots before the clip
   * stay put, so a lengthening In that crosses an empty slot counts its pixels as no time and meets the playhead
   * where it is drawn. Without it, or for an Out edge (whose later slots are pushed along), travel is pixels / pps.
   */
  xToTime?: (x: number) => number;
  /** trimTargets(…): nothing that moves with the drag. */
  targets: readonly SnapTarget[];
  /** The lowest In an In edge may reach. Stacked passes clip.inSec − span.start, so the clip never starts before 0:00. */
  minInSec?: number;
}

export interface TrimDragResult {
  /** clampTrim applied. */
  inSec: number;
  outSec: number | null;
  /** Where the dragged edge sits in sequence time (out: start + new length; in: start + (new In − old In)). */
  edgeSeqTime: number;
  /** The edge's time in its source: the In or Out the rail would show. */
  edgeSourceTime: number;
  /** New length − old length (the "−0.80 s" chip). */
  deltaSec: number;
  /** New length. */
  lengthSec: number;
  snapped: SnapTarget | null;
  /** The span the edge has crossed when shortening, in sequence time; null when lengthening. */
  ghost: { fromSec: number; toSec: number } | null;
}

/** How near (px) an edge must come to a target to snap. The boards do not draw it; design-spec §7.5 suggests 8. */
export const SNAP_THRESHOLD_PX = 8;
/** A snapped edge that the trim limits pulled further than this is not snapped. */
const SNAP_HELD = 1e-6;

/**
 * What a dragged edge can snap to. Track: the playhead, and the one neighbouring edge a ripple trim can meet
 * (neighbourTarget); nothing that moves with the drag, since the clips after a lengthening edge are pushed live.
 * Stacked, where nothing else moves: the playhead; for an In edge 0:00 ("the start"); every other non-empty clip's
 * start and end ("Clip 3's start", "Clip 3's end"); and the edge's own start position (originalEdgeTarget, "the
 * original length").
 */
export function trimTargets(
  spans: readonly ClipSpan[],
  clipId: string,
  edge: "in" | "out",
  playhead: number,
  mode: "track" | "stacked" = "track",
): SnapTarget[] {
  const targets: SnapTarget[] = [{ t: playhead, kind: "playhead", label: "the playhead" }];
  if (mode === "stacked") {
    if (edge === "in") targets.push({ t: 0, kind: "edge", label: "the start" });
    for (const other of spans) {
      if (other.clip.id === clipId || !(other.length > 0)) continue;
      targets.push(
        { t: other.start, kind: "edge", label: `${clipName(other.index)}'s start` },
        { t: other.end, kind: "edge", label: `${clipName(other.index)}'s end` },
      );
    }
    const span = spans.find((s) => s.clip.id === clipId);
    if (span) targets.push(originalEdgeTarget(span, edge));
    return targets;
  }
  const neighbour = neighbourTarget(spans, clipId, edge);
  if (neighbour) targets.push(neighbour);
  return targets;
}

/** Snapping runs on the edge's sequence time when opts.snap is set, with threshold thresholdPx / pps (default 8 px). */
export function trimDragAt(
  start: TrimDragStart,
  pointerX: number,
  opts: { snap: boolean; thresholdPx?: number },
): TrimDragResult {
  const { span, edge, sourceDuration: d } = start;
  const clip = span.clip;
  const pps = start.pxPerSec > 0 ? start.pxPerSec : 1;
  const measurable = Number.isFinite(pointerX) && Number.isFinite(start.pointerX);
  const dx = !measurable
    ? 0
    : edge === "in" && start.xToTime
      ? start.xToTime(pointerX) - start.xToTime(start.pointerX)
      : (pointerX - start.pointerX) / pps;
  const startEdge = edge === "out" ? span.end : span.start;
  const pointerTime = startEdge + dx;
  // Each edge moves from its own stored value by the edge's travel, so no travel gives the clip's own In and Out
  // back exactly (rebuilding the Out from start + length would add float noise: (start + len) − start ≠ len)
  const known = d !== undefined && Number.isFinite(d);
  const effOut = known ? Math.min(clip.outSec ?? d, d) : (clip.outSec ?? clip.inSec + span.length);
  const minIn = start.minInSec !== undefined && Number.isFinite(start.minInSec) ? start.minInSec : -Infinity;
  const trimAt = (edgeTime: number) =>
    edge === "out"
      ? clampTrim(clip, d, { outSec: effOut + (edgeTime - span.end) })
      : clampTrim(clip, d, { inSec: Math.max(clip.inSec + (edgeTime - span.start), minIn) });
  const edgeOf = (trim: { inSec: number; outSec: number | null }) =>
    edge === "out" ? span.start + clipLength({ ...clip, ...trim }, d) : span.start + (trim.inSec - clip.inSec);

  let trim = trimAt(pointerTime);
  let target: SnapTarget | null = null;
  const snapped = opts.snap
    ? snapTo(pointerTime, start.targets, (opts.thresholdPx ?? SNAP_THRESHOLD_PX) / pps)
    : { value: pointerTime, target: null };
  if (snapped.target) {
    // The edge stays where the snap pulled it; when the trim limits pulled it off the target, it is not snapped
    trim = trimAt(snapped.value);
    if (Math.abs(edgeOf(trim) - snapped.target.t) <= SNAP_HELD) target = snapped.target;
  }

  const lengthSec = clipLength({ ...clip, ...trim }, d);
  const edgeSeqTime = edgeOf(trim);
  const edgeSourceTime = edge === "out" ? trim.inSec + lengthSec : trim.inSec;
  const deltaSec = lengthSec - span.length;

  let ghost: TrimDragResult["ghost"] = null;
  if (deltaSec < 0) {
    ghost = edge === "out" ? { fromSec: edgeSeqTime, toSec: span.end } : { fromSec: span.start, toSec: edgeSeqTime };
  }
  return { ...trim, edgeSeqTime, edgeSourceTime, deltaSec, lengthSec, snapped: target, ghost };
}
