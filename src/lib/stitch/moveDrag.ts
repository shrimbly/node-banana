import { clipName } from "./labels";
import { MAX_START_SEC, pairOverlap } from "./placement";
import { formatSeconds } from "./timecode";
import { sourceKey, type ClipSpan, type SnapTarget } from "./timeline";
import { SNAP_THRESHOLD_PX } from "./trimDrag";

/**
 * One body drag of a clip in the Stacked timeline, as pure functions of the
 * pointer: the start it lands on (snapped or not) and the row it lands in.
 * The lane draws this while the pointer moves and applies it once, on
 * release. Every other clip keeps its start, so the targets taken at the
 * lift stay true for the whole drag.
 */

export interface MoveTarget extends SnapTarget {
  /** Which edge of the dragged clip may meet it. */
  edge: "start" | "end" | "both";
  /** The row of the clip it belongs to (for the guide's length); null for the playhead and 0:00. */
  row: number | null;
}

/** The label of the clip's own start: a drag up or down usually keeps its time by snapping to it. */
export const WHERE_IT_WAS = "where it was";

/**
 * The targets for clipId, taken at the lift from the press's spans (after the preview pauses): the playhead (both
 * edges), 0:00 (start, "the start"), its own start (start, "where it was"), every other non-empty span's start and end
 * (both; "Clip 3's start", "Clip 3's end"), and per other non-empty span c with o = pairOverlap(c, self, overlapSec)
 * > 0: { t: c.end − o, edge: "start", label: "a 1.0 s overlap with Clip 3" } (o with 1 decimal when it equals
 * overlapSec, else 2). Names are the press's (the row headers keep them until release). [] when clipId is not in spans.
 * Spans whose clip is in `exclude` give no targets: a group drag's other clips move with the one held.
 */
export function moveTargets(
  spans: readonly ClipSpan[],
  clipId: string,
  playhead: number,
  overlapSec: number,
  exclude?: ReadonlySet<string>,
): MoveTarget[] {
  const self = spans.find((s) => s.clip.id === clipId);
  if (!self) return [];
  const targets: MoveTarget[] = [
    { t: playhead, kind: "playhead", label: "the playhead", edge: "both", row: null },
    { t: 0, kind: "edge", label: "the start", edge: "start", row: null },
    { t: self.start, kind: "edge", label: WHERE_IT_WAS, edge: "start", row: self.index },
  ];
  const item = (span: ClipSpan) => ({ length: span.length, source: sourceKey(span.clip.source) });
  for (const other of spans) {
    if (other === self || !(other.length > 0) || exclude?.has(other.clip.id)) continue;
    const name = clipName(other.index);
    targets.push(
      { t: other.start, kind: "edge", label: `${name}'s start`, edge: "both", row: other.index },
      { t: other.end, kind: "edge", label: `${name}'s end`, edge: "both", row: other.index },
    );
    const overlap = pairOverlap(item(other), item(self), overlapSec);
    if (overlap > 0) {
      const amount = formatSeconds(overlap, Math.abs(overlap - overlapSec) < 1e-9 ? 1 : 2);
      targets.push({
        t: other.end - overlap,
        kind: "edge",
        label: `a ${amount} overlap with ${name}`,
        edge: "start",
        row: other.index,
      });
    }
  }
  return targets;
}

/** Half a row's travel past a boundary is not enough to change the landing row; this much more is, px. */
export const ROW_HYSTERESIS_PX = 4;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The row a body drag lands in. centre = index · rowHeight + dy (the box's centre, relative to row 0's middle).
 * Keeps `current` while |centre − current · rowHeight| <= rowHeight / 2 + ROW_HYSTERESIS_PX; otherwise the row under
 * the centre, round(centre / rowHeight). Clamped to [0, rowCount − 1]. Non-finite dy → current.
 */
export function moveRowAt(index: number, dy: number, current: number, rowCount: number, rowHeight: number): number {
  const last = Math.max(0, rowCount - 1);
  const kept = clamp(current, 0, last);
  if (!Number.isFinite(dy) || !(rowHeight > 0)) return kept;
  const centre = index * rowHeight + dy;
  if (Math.abs(centre - kept * rowHeight) <= rowHeight / 2 + ROW_HYSTERESIS_PX) return kept;
  return clamp(Math.round(centre / rowHeight), 0, last);
}

export interface MoveDragStart {
  clipId: string;
  startSec: number;
  lengthSec: number;
  pointerX: number;
  pxPerSec: number;
  targets: readonly MoveTarget[];
  /** The lowest start the drag may land on (default 0): a group's earliest clip stops at 0:00. */
  minStartSec?: number;
  /** The highest (default MAX_START_SEC): a group's latest clip stops at 10:00. */
  maxStartSec?: number;
}

export interface MoveDragResult {
  startSec: number;
  deltaSec: number;
  snapped: MoveTarget | null;
  snappedEdge: "start" | "end" | null;
}

/** Equal distances closer than this are a tie. */
const TIE_SEC = 1e-9;

/** Lower wins a tie: "where it was", then the playhead, then the start edge. */
function tieRank(target: MoveTarget, edge: "start" | "end"): number {
  if (target.label === WHERE_IT_WAS) return 0;
  if (target.kind === "playhead") return 1;
  return edge === "start" ? 2 : 3;
}

/**
 * raw = startSec + (pointerX − start.pointerX) / pps. With opts.snap: each target gives a candidate start (t for the
 * start edge, t − lengthSec for the end edge; an empty clip tests the start edge only); a candidate below minStartSec
 * (default 0), or above a given maxStartSec, is skipped; the nearest within thresholdPx / pps (default 8) wins; ties:
 * "where it was", then the playhead, then the start edge. Then clamped to [minStartSec, maxStartSec ?? MAX_START_SEC].
 * deltaSec = result − startSec.
 */
export function moveDragAt(
  start: MoveDragStart,
  pointerX: number,
  opts: { snap: boolean; thresholdPx?: number },
): MoveDragResult {
  const pps = start.pxPerSec > 0 ? start.pxPerSec : 1;
  const minStart = start.minStartSec ?? 0;
  const maxStart = start.maxStartSec;
  const measurable = Number.isFinite(pointerX) && Number.isFinite(start.pointerX);
  const raw = start.startSec + (measurable ? (pointerX - start.pointerX) / pps : 0);

  let best: { target: MoveTarget; edge: "start" | "end"; value: number; distance: number } | null = null;
  if (opts.snap) {
    const threshold = (opts.thresholdPx ?? SNAP_THRESHOLD_PX) / pps;
    const hasLength = start.lengthSec > 0;
    for (const target of start.targets) {
      const edges: Array<"start" | "end"> =
        target.edge === "both" ? (hasLength ? ["start", "end"] : ["start"]) : target.edge === "end" && !hasLength ? [] : [target.edge];
      for (const edge of edges) {
        const value = edge === "start" ? target.t : target.t - start.lengthSec;
        if (!Number.isFinite(value) || value < minStart - TIE_SEC) continue;
        if (maxStart !== undefined && value > maxStart + TIE_SEC) continue;
        const distance = Math.abs(value - raw);
        if (distance > threshold) continue;
        const better =
          !best ||
          distance < best.distance - TIE_SEC ||
          (distance <= best.distance + TIE_SEC && tieRank(target, edge) < tieRank(best.target, best.edge));
        if (better) best = { target, edge, value, distance };
      }
    }
  }

  const value = best ? best.value : raw;
  const startSec = clamp(value, minStart, maxStart ?? MAX_START_SEC);
  // A snap the clamp pulled off its target is no snap
  const held = best !== null && Math.abs(startSec - best.value) <= TIE_SEC;
  return {
    startSec,
    deltaSec: startSec - start.startSec,
    snapped: held && best ? best.target : null,
    snappedEdge: held && best ? best.edge : null,
  };
}

/** The snap chip's text: "Snapped to <label>" for the start edge, "End snapped to <label>" for the end edge. */
export function moveSnapText(result: MoveDragResult): string | null {
  if (!result.snapped) return null;
  return result.snappedEdge === "end" ? `End snapped to ${result.snapped.label}` : `Snapped to ${result.snapped.label}`;
}
