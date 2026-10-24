import { liveRunsAt, envelopeAt, resolveStarts, SLOT_SEC, TIME_EPS, type StackEnvelope } from "./placement";
import { FRAME_RATE, secToSlot, type PlannedClip } from "./sequencePlan";
import { stackSequence } from "./stack";

/**
 * The encoder's plan for a placed Stacked sequence: which branch a node takes,
 * and, for the placed branch, what each stretch of one loop shows (black, one
 * clip's own frames, or a blend of the visible clips), the slots each clip is
 * visible in (one decoder per stretch), and how often a blend writes a frame.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds; slots are 1/60 s.
 */

export type StitchRoute = { kind: "track" } | { kind: "derived" } | { kind: "placed"; starts: number[] };

/** Two starts this close are one layout. */
const SAME_START_SEC = 1e-9;

/**
 * placement null → today's rule ("derived" when stack is set and stackSequence makes some overlapIn > 0, else "track").
 * Placed: starts = resolveStarts(…, overlapSec) with the engine's lengths and sources; then
 *   overlapSec > 0, stackSequence(…) has an overlap and every start is its seqStart within 1e-9 → "derived"
 *     (the node runs with { overlapSec, crossfade } exactly as a lined-up stack);
 *   every start is planSequence's seqStart within 1e-9 → "track";
 *   else "placed".
 * A layout dragged back into step therefore encodes byte for byte as the branch that made it.
 */
export function routePlacement(
  plans: readonly PlannedClip[],
  sources: readonly string[],
  storedStarts: ReadonlyArray<number | undefined>,
  placement: { crossfade: boolean; overlapSec: number } | null,
  stack: { overlapSec: number; crossfade: boolean } | null,
): StitchRoute {
  const overlapping = (opts: { overlapSec: number; crossfade: boolean }) => {
    const plan = stackSequence(plans, sources, opts);
    return plan.clips.some((clip) => clip.overlapIn > 0) ? plan : null;
  };
  if (!placement) return stack && overlapping(stack) ? { kind: "derived" } : { kind: "track" };

  const starts = resolveStarts(
    plans.map((plan, k) => ({ start: storedStarts[k], length: plan.length, source: sources[k] ?? `#${plan.index}` })),
    placement.overlapSec,
  );
  const sameAs = (layout: readonly number[]) => starts.every((start, k) => Math.abs(start - layout[k]) <= SAME_START_SEC);
  if (placement.overlapSec > 0) {
    const stacked = overlapping(placement);
    if (stacked && sameAs(stacked.clips.map((clip) => clip.seqStart))) return { kind: "derived" };
  }
  if (sameAs(plans.map((plan) => plan.seqStart))) return { kind: "track" };
  return { kind: "placed", starts };
}

export type Segment =
  | { kind: "black"; fromSec: number; toSec: number }
  | { kind: "solo"; unit: number; fromSec: number; toSec: number }
  /** units from the bottom (the base, opaque throughout) to the top, by row. */
  | { kind: "blend"; units: number[]; fromSec: number; toSec: number };

const underSlot = (sec: number) => sec < SLOT_SEC - TIME_EPS;

/** What the interval [fromSec, toSec) between two breakpoints shows, read at its middle. */
function classify(env: StackEnvelope, fromSec: number, toSec: number): Segment {
  const mid = (fromSec + toSec) / 2;
  if (!env.crossfade) {
    const layers = envelopeAt(env, mid);
    if (layers.length === 0) return { kind: "black", fromSec, toSec };
    return { kind: "solo", unit: layers[layers.length - 1].unit, fromSec, toSec };
  }
  // Top first; held runs (a bridged gap below) included, so a held clip can be the base
  const stack = liveRunsAt(env, mid);
  if (stack.length === 0) return { kind: "black", fromSec, toSec };
  // α is linear between breakpoints and every fade ends on one, so α = 1 at the middle means 1 throughout
  let base = stack.findIndex((layer) => layer.alpha >= 1);
  if (base === -1) base = stack.length - 1;
  if (base === 0) return { kind: "solo", unit: stack[0].unit, fromSec, toSec };
  return {
    kind: "blend",
    units: stack
      .slice(0, base + 1)
      .reverse()
      .map((layer) => layer.unit),
    fromSec,
    toSec,
  };
}

function sameShow(a: Segment, b: Segment): boolean {
  if (a.kind === "black" && b.kind === "black") return true;
  if (a.kind === "solo" && b.kind === "solo") return a.unit === b.unit;
  if (a.kind === "blend" && b.kind === "blend") {
    return a.units.length === b.units.length && a.units.every((unit, i) => unit === b.units[i]);
  }
  return false;
}

/**
 * One loop, in time order, tiling [0, loopLength) but for dropped black: each interval between breakpoints is black
 * (nothing live), solo (Off: the top live clip; On: the top live run when it is opaque throughout) or a blend from the
 * base (the highest live run opaque throughout, or the bottom one) up to the top; runs below the base are hidden.
 * Neighbours that show the same are merged. A black segment shorter than a slot is dropped (the frame before it holds),
 * except the loop's first: loop 0 has no frame before it to hold (segmentsInLoop drops it from the other loops).
 */
export function pictureSegments(env: StackEnvelope): Segment[] {
  const merged: Segment[] = [];
  const points = env.breakpoints;
  for (let i = 0; i + 1 < points.length; i++) {
    const segment = classify(env, points[i], points[i + 1]);
    const last = merged[merged.length - 1];
    if (last && sameShow(last, segment)) last.toSec = segment.toSec;
    else merged.push(segment);
  }
  return merged.filter((segment, i) => !(i > 0 && segment.kind === "black" && underSlot(segment.toSec - segment.fromSec)));
}

/** The segments loop `loop` plays: a leading black under a slot is written in loop 0 only (later loops hold the seam). */
export function segmentsInLoop(segments: readonly Segment[], loop: number): readonly Segment[] {
  const first = segments[0];
  if (loop === 0 || !first || first.kind !== "black" || !underSlot(first.toSec - first.fromSec)) return segments;
  return segments.slice(1);
}

/** A segment's slots in the loop at loopOffset: [secToSlot(loopOffset + fromSec), secToSlot(loopOffset + toSec)). */
export function segmentSlots(segment: Segment, loopOffset: number): { n0: number; n1: number } {
  return { n0: secToSlot(loopOffset + segment.fromSec), n1: secToSlot(loopOffset + segment.toSec) };
}

/** The units a segment shows: none, one, or the blend's, bottom first. */
export function segmentUnits(segment: Segment): readonly number[] {
  if (segment.kind === "solo") return [segment.unit];
  if (segment.kind === "blend") return segment.units;
  return [];
}

/**
 * Per unit, the slot ranges [n0, n1) of one loop in which it is visible (solo or in a blend), built from the segments'
 * non-empty slot ranges only: a segment with no slots neither starts nor ends a run.
 */
export function visibilityRuns(
  segments: readonly Segment[],
  unitCount: number,
  loopOffset: number,
): Array<Array<{ n0: number; n1: number }>> {
  const runs: Array<Array<{ n0: number; n1: number }>> = Array.from({ length: unitCount }, () => []);
  for (const segment of segments) {
    const { n0, n1 } = segmentSlots(segment, loopOffset);
    if (!(n1 > n0)) continue;
    for (const unit of segmentUnits(segment)) {
      const own = runs[unit];
      if (!own) continue;
      const last = own[own.length - 1];
      if (last && last.n1 === n0) last.n1 = n1;
      else own.push({ n0, n1 });
    }
  }
  return runs;
}

/** The most units any segment shows at once. */
export function maxVisibleLayers(segments: readonly Segment[]): number {
  return segments.reduce((most, segment) => Math.max(most, segmentUnits(segment).length), 0);
}

/** The breakpoint that stands for a unit's edge (the first value of its merged cluster), so anchors and segments agree. */
export function breakpointFor(env: StackEnvelope, sec: number): number {
  // A cluster is merged into its first value, so the value standing for sec is the last one at or before it
  let found = sec;
  for (const point of env.breakpoints) {
    if (point > sec) break;
    found = point;
  }
  return sec - found <= TIME_EPS ? found : sec;
}

/**
 * A unit's slots in the loop at loopOffset: S_u, where its origin lands (Track's begin() mapping), and the slot its own
 * end falls on; frames on that slot or later are not its own.
 */
export function unitSlots(env: StackEnvelope, unit: number, loopOffset: number, fps: number = FRAME_RATE): { anchor: number; end: number } {
  const u = env.units[unit];
  return {
    anchor: secToSlot(loopOffset + breakpointFor(env, u.start), fps),
    end: secToSlot(loopOffset + breakpointFor(env, u.start + u.length), fps),
  };
}

/**
 * The source range one decoder reads for a visibility run [n0, n1) of a clip anchored at slot `anchor`: from In when the
 * run starts on the anchor, else the earliest source time on slot n0, at most Out (the frame in effect there comes
 * first; see readerStart for where the decoder then starts); to the latest source time on the run's last slot, at most
 * Out.
 */
export function readerRange(
  clip: { inSec: number; outSec: number; origin: number },
  anchor: number,
  run: { n0: number; n1: number },
  fps: number = FRAME_RATE,
): { from: number; to: number } {
  const to = Math.min(clip.outSec, clip.origin + (run.n1 - anchor + 0.5) / fps);
  // A run in the clip's held tail (past its last frame before Out) starts at Out: a frame past Out is never its own
  return { from: run.n0 <= anchor ? clip.inSec : Math.min(clip.origin + (run.n0 - anchor - 0.5) / fps, to), to };
}

/**
 * Where a reader opened partway into a clip (from past In) starts decoding, given the timestamp of the frame in effect
 * at `from` (null when unknown): the earliest source time on the slot before that frame's. Track keeps the first frame
 * that lands on a slot and drops the later ones; a source above 60 fps, or with uneven timestamps, can put two frames on
 * the slot of the frame in effect, and that frame may be the second, or a frame held for several slots (a clip's tail).
 * Started a slot earlier, the reader counts that slot's frames as Track does. Never before In.
 */
export function readerStart(
  from: number,
  inEffect: number | null,
  clip: { inSec: number; origin: number },
  anchor: number,
  fps: number = FRAME_RATE,
): number {
  if (inEffect === null || !Number.isFinite(inEffect) || !(from > clip.inSec)) return from;
  const slot = anchor + secToSlot(Math.max(0, inEffect - clip.origin), fps);
  return Math.max(clip.inSec, Math.min(from, clip.origin + (slot - anchor - 1.5) / fps));
}

/** A blend writes at least every this many slots, so a source holding one frame does not freeze the dissolve. */
export const BLEND_MAX_STEP = 3;

/**
 * The slot a blend writes after `written`: the next slot on which some visible clip's frame changes, at most
 * BLEND_MAX_STEP on; the next slot when a clip has no usable rate (everySlot); never past n1 (the segment's end).
 */
export function nextBlendSlot(written: number, nextChange: number, n1: number, everySlot: boolean): number {
  const next = everySlot ? written + 1 : Math.min(Math.max(nextChange, written + 1), written + BLEND_MAX_STEP);
  return Math.min(next, n1);
}
