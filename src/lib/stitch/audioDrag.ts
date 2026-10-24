import type { AudioSpan } from "./audioClips";
import { clipName } from "./labels";
import { moveDragAt, moveSnapText, ROW_HYSTERESIS_PX, WHERE_IT_WAS, type MoveTarget } from "./moveDrag";
import { MAX_START_SEC } from "./placement";
import type { TimeAxis } from "./timeAxis";
import { snapTo, type ClipSpan } from "./timeline";
import { SNAP_THRESHOLD_PX } from "./trimDrag";

/**
 * One drag of an audio box (its body, or an edge), as pure functions of the
 * pointer's travel. The section draws this while the pointer moves and
 * applies it once, on release.
 *
 * Travel is read on the lane's TimeAxis, not on pixels per second alone:
 * Track's axis draws an empty video clip as a slot at one instant, so a time
 * is read from where an edge is drawn: xToTime(timeToX(t) + dx).
 */

export interface AudioMoveTarget {
  t: number;
  label: string;
  kind: "playhead" | "edge";
  /** Which edge of the dragged box may meet it. */
  edge: "start" | "end" | "both";
}

/**
 * What a moved audio box snaps to: the playhead, 0:00 ("the start"), the sequence's end ("the end"), every non-empty
 * video clip's start and end ("Clip 3's end"), and the start and end of every audio clip that is not moving
 * ("music.m4a's start", by `names`). Names are the press's. A move also snaps to where its lead started
 * (audioMoveAt adds it).
 */
export function audioMoveTargets(
  spans: readonly AudioSpan[],
  videoSpans: readonly ClipSpan[],
  ids: ReadonlySet<string>,
  playhead: number,
  total: number,
  names: (span: AudioSpan) => string,
): AudioMoveTarget[] {
  const targets: AudioMoveTarget[] = [
    { t: playhead, kind: "playhead", label: "the playhead", edge: "both" },
    { t: 0, kind: "edge", label: "the start", edge: "start" },
  ];
  if (total > 0) targets.push({ t: total, kind: "edge", label: "the end", edge: "both" });
  for (const video of videoSpans) {
    if (!(video.length > 0)) continue;
    const name = clipName(video.index);
    targets.push(
      { t: video.start, kind: "edge", label: `${name}'s start`, edge: "both" },
      { t: video.end, kind: "edge", label: `${name}'s end`, edge: "both" },
    );
  }
  for (const span of spans) {
    if (ids.has(span.clip.id) || !(span.length > 0)) continue;
    const name = names(span);
    targets.push(
      { t: span.start, kind: "edge", label: `${name}'s start`, edge: "both" },
      { t: span.end, kind: "edge", label: `${name}'s end`, edge: "both" },
    );
  }
  return targets;
}

export interface AudioMoveResult {
  deltaSec: number;
  snapped: AudioMoveTarget | null;
  snappedEdge: "start" | "end" | null;
}

/**
 * The lead (the box pressed) decides the snap, and the group moves by its delta. Its start is read where its left edge
 * is drawn after dx; then snapped as moveDragAt snaps (ties: where it was, the playhead, then the start edge; a target
 * that would start the lead below lead.min is skipped) and clamped to [lead.min, lead.max]. min and max default to
 * 0:00 and 10:00; a group passes the lead's room before its earliest and after its latest clip hit those.
 */
export function audioMoveAt(
  axis: Pick<TimeAxis, "timeToX" | "xToTime" | "pxPerSec">,
  lead: { start: number; length: number; min?: number; max?: number },
  dx: number,
  targets: readonly AudioMoveTarget[],
  opts: { snap: boolean },
): AudioMoveResult {
  const raw = Number.isFinite(dx) ? axis.xToTime(axis.timeToX(lead.start) + dx) : lead.start;
  const pps = axis.pxPerSec > 0 ? axis.pxPerSec : 1;
  const moveTargets: MoveTarget[] = [
    ...targets.map((target) => ({ ...target, row: null })),
    { t: lead.start, kind: "edge", label: WHERE_IT_WAS, edge: "start", row: null },
  ];
  const result = moveDragAt(
    {
      clipId: "",
      startSec: lead.start,
      lengthSec: Number.isFinite(lead.length) ? lead.length : 0,
      pointerX: 0,
      pxPerSec: pps,
      targets: moveTargets,
      minStartSec: lead.min ?? 0,
      maxStartSec: lead.max ?? MAX_START_SEC,
    },
    (raw - lead.start) * pps,
    { snap: opts.snap, thresholdPx: SNAP_THRESHOLD_PX },
  );
  const index = result.snapped ? moveTargets.indexOf(result.snapped) : -1;
  const snapped =
    index === -1
      ? null
      : index < targets.length
        ? targets[index]
        : { t: lead.start, kind: "edge" as const, label: WHERE_IT_WAS, edge: "start" as const };
  return { deltaSec: result.deltaSec, snapped, snappedEdge: snapped ? result.snappedEdge : null };
}

export interface AudioTrimResult {
  inSec?: number;
  outSec?: number | null;
  snapped: AudioMoveTarget | null;
}

/**
 * One edge of one box. The edge's sequence time is read where it is drawn after dx and snapped (within 8 px, the
 * playhead winning a tie); the In or Out it gives (In: in + (edge − start), the sound staying in place; Out:
 * in + (edge − start)) is clamped to bounds (the trim limits in source seconds: the file's length, the neighbours on
 * the row, the shortest clip). A snap the bounds pulled off its target is no snap.
 */
export function audioTrimAt(
  axis: Pick<TimeAxis, "timeToX" | "xToTime" | "pxPerSec">,
  span: AudioSpan,
  edge: "in" | "out",
  dx: number,
  bounds: { min: number; max: number },
  targets: readonly AudioMoveTarget[],
  opts: { snap: boolean },
): AudioTrimResult {
  const from = edge === "in" ? span.start : span.end;
  const raw = Number.isFinite(dx) ? axis.xToTime(axis.timeToX(from) + dx) : from;
  const pps = axis.pxPerSec > 0 ? axis.pxPerSec : 1;
  const snap = opts.snap ? snapTo(raw, targets, SNAP_THRESHOLD_PX / pps) : { value: raw, target: null };
  const source = span.clip.inSec + (snap.value - span.start);
  const value = Math.min(Math.max(source, bounds.min), bounds.max);
  const held = snap.target !== null && Math.abs(value - source) <= 1e-9;
  const snapped = held ? (snap.target as AudioMoveTarget) : null;
  return edge === "in" ? { inSec: value, snapped } : { outSec: value, snapped };
}

/**
 * The landing row, from the box centre's y in the section's content coordinates (the live audio scroll added):
 * rowTops.length means a new row appended through the strip. The current row is kept while the centre is within
 * its band and ROW_HYSTERESIS_PX more on either side (so uneven rows behave as moveRowAt's even ones); otherwise the
 * row under the centre, the strip from stripTop down. The layout is the press's: rows never change height or number
 * during a drag.
 */
export function audioRowAt(
  centreY: number,
  current: number,
  rowTops: readonly number[],
  rowHeights: readonly number[],
  stripTop: number,
): number {
  const rows = rowTops.length;
  const kept = Math.min(Math.max(current, 0), rows);
  if (!Number.isFinite(centreY)) return kept;
  const top = kept === rows ? stripTop : rowTops[kept];
  const bottom = kept === rows ? Infinity : rowTops[kept] + rowHeights[kept];
  if (centreY >= top - ROW_HYSTERESIS_PX && centreY <= bottom + ROW_HYSTERESIS_PX) return kept;
  if (centreY >= stripTop) return rows;
  for (let row = rows - 1; row >= 0; row--) if (centreY >= rowTops[row]) return row;
  return 0;
}

/** "Snapped to Clip 3's end", "End snapped to the end". */
export function audioSnapText(result: AudioMoveResult): string | null {
  if (!result.snapped) return null;
  return moveSnapText({
    startSec: 0,
    deltaSec: result.deltaSec,
    snapped: { ...result.snapped, row: null },
    snappedEdge: result.snappedEdge,
  });
}
