import type { StitchSequenceLayout } from "@/types";
import { FRAME_RATE, secToSlot, type PlannedClip } from "./sequencePlan";

/**
 * The Stacked layout's rules, shared by the editor, the card and the encoder:
 * how far each clip overlaps the one before, where each clip's frames pass
 * straight through, which frames a dissolve blends and how its sound fades,
 * and the sentence that says so in the rail.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds.
 */

export const DEFAULT_OVERLAP_SEC = 1;
export const MAX_OVERLAP_SEC = 10;
export const OVERLAP_STEP_SEC = 0.1;
export const DEFAULT_SEQUENCE_LAYOUT: StitchSequenceLayout = {
  mode: "track",
  overlapSec: DEFAULT_OVERLAP_SEC,
  crossfade: true,
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
/** NaN becomes 0. */
const clamp01 = (value: number) => (Number.isNaN(value) ? 0 : clamp(value, 0, 1));

/** Finite → clamped to [0, MAX] and rounded to 0.1 s; otherwise DEFAULT_OVERLAP_SEC. */
export function clampOverlapSec(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OVERLAP_SEC;
  // Scale by the whole number of steps per second: dividing by 0.1 would turn 0.25 into 2.4999… and round it down.
  const perSec = Math.round(1 / OVERLAP_STEP_SEC);
  return Math.round(clamp(value, 0, MAX_OVERLAP_SEC) * perSec) / perSec;
}

/** What the sequence uses: overlapSec when stacked, else 0. */
export function effectiveOverlapSec(layout: StitchSequenceLayout): number {
  return layout.mode === "stacked" ? layout.overlapSec : 0;
}

/**
 * Whole 60 fps slots, rounded down: floor(sec · FRAME_RATE + 1e-9) / FRAME_RATE (0 for non-finite or negative).
 * The epsilon only absorbs float noise; joinOverlaps steps a result that still lands above its caps down a slot.
 */
export function floorToSlot(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.floor(sec * FRAME_RATE + 1e-9) / FRAME_RATE;
}

export interface StackItem {
  length: number;
  source: string;
}

/**
 * The overlap before each item, seconds, same indices. An item with length <= 0 gets 0 and is skipped: it does not separate its
 * neighbours. A join between two adjacent non-empty items with the same source is a cut (0). A run is a maximal sequence of such
 * items. Every other join gets floorToSlot(min(overlapSec, runBefore/2, runAfter/2, before.length, after.length)), and 0 under one
 * slot. overlapSec <= 0 or non-finite gives all zeros.
 */
export function joinOverlaps(items: readonly StackItem[], overlapSec: number): number[] {
  const out = items.map(() => 0);
  if (!(Number.isFinite(overlapSec) && overlapSec > 0)) return out;
  const filled: number[] = [];
  items.forEach((item, i) => {
    if (item.length > 0) filled.push(i);
  });
  // Run ids along the non-empty items, and each run's summed length.
  const runOf: number[] = [];
  const runLength: number[] = [];
  filled.forEach((i, n) => {
    const fresh = n === 0 || items[filled[n - 1]].source !== items[i].source;
    if (fresh) runLength.push(0);
    runOf.push(runLength.length - 1);
    runLength[runLength.length - 1] += items[i].length;
  });
  for (let n = 1; n < filled.length; n++) {
    const p = filled[n - 1];
    const q = filled[n];
    if (runOf[n - 1] === runOf[n]) continue;
    // Halves of the runs and the two touching lengths are hard caps: two overlaps on one run must never sum past it,
    // or a third clip would be live for an instant.
    const caps = Math.min(runLength[runOf[n - 1]] / 2, runLength[runOf[n]] / 2, items[p].length, items[q].length);
    let overlap = floorToSlot(Math.min(overlapSec, caps));
    if (overlap > caps) overlap = Math.max(0, Math.round(overlap * FRAME_RATE) - 1) / FRAME_RATE;
    out[q] = overlap;
  }
  return out;
}

// The encoder's side: a planned sequence laid out stacked.

export interface StackedClip extends PlannedClip {
  /** Overlap with the previous / next clip, seconds (0 at cuts, the first and the last). */
  overlapIn: number;
  overlapOut: number;
  /** Replaces PlannedClip.seqStart: seqStart_{k+1} = end_k − overlapIn_{k+1}. */
  seqStart: number;
  /** Where this clip's frames pass straight through, [soloStart, soloEnd) in loop seconds; soloOrigin = its source time at soloStart. */
  soloStart: number;
  soloEnd: number;
  soloOrigin: number;
}

/** outgoing and incoming index StackedPlan.clips. */
export interface Dissolve {
  outgoing: number;
  incoming: number;
  fromSec: number;
  toSec: number;
}

export interface StackedPlan {
  clips: StackedClip[];
  dissolves: Dissolve[];
  loopLength: number;
}

/**
 * sources[k] is planned[k]'s source key. Boundaries are computed once and shared, so the windows tile exactly:
 *   end_k = seqStart_k + length_k;  seqStart_{k+1} = end_k − o_{k+1}
 * Both modes:   soloStart_k  = k > 0 ? end_{k−1} : seqStart_0     (equals seqStart_k at a cut: same float)
 *               soloOrigin_k = origin_k + o_k
 * Crossfade on: soloEnd_k = seqStart_{k+1} when o_{k+1} > 0, else end_k
 *               dissolve k→k+1 when o_{k+1} > 0: { fromSec: seqStart_{k+1}, toSec: end_k }
 * Crossfade off (the earlier clip in front): soloEnd_k = end_k; no dissolves. Each clip owns [end_{k−1}, end_k).
 * loopLength = end of the last clip. A solo window can be empty (o_in + o_out = length, crossfade on): it is skipped. Such a
 * clip's next one starts exactly at end_{k−1} (snapped when within 1e-9), so float noise never leaves a sliver of a window.
 */
export function stackSequence(
  planned: readonly PlannedClip[],
  sources: readonly string[],
  opts: { overlapSec: number; crossfade: boolean },
): StackedPlan {
  const overlaps = joinOverlaps(
    planned.map((clip, k) => ({ length: clip.length, source: sources[k] ?? `#${k}` })),
    opts.overlapSec,
  );
  const starts: number[] = [];
  const ends: number[] = [];
  planned.forEach((clip, k) => {
    let seqStart = k === 0 ? 0 : ends[k - 1] - overlaps[k];
    // A middle clip its two overlaps fill: start exactly where the clip before it ends, so its solo window is exactly empty
    if (k >= 2 && Math.abs(seqStart - ends[k - 2]) < 1e-9) seqStart = ends[k - 2];
    starts.push(seqStart);
    ends.push(seqStart + clip.length);
  });

  const dissolves: Dissolve[] = [];
  const clips = planned.map((clip, k): StackedClip => {
    const overlapIn = k === 0 ? 0 : overlaps[k];
    const overlapOut = overlaps[k + 1] ?? 0;
    const blendsOut = opts.crossfade && overlapOut > 0;
    if (blendsOut) dissolves.push({ outgoing: k, incoming: k + 1, fromSec: starts[k + 1], toSec: ends[k] });
    return {
      ...clip,
      overlapIn,
      overlapOut,
      seqStart: starts[k],
      soloStart: k > 0 ? ends[k - 1] : starts[0],
      soloEnd: blendsOut ? starts[k + 1] : ends[k],
      soloOrigin: clip.origin + overlapIn,
    };
  });
  return { clips, dissolves, loopLength: ends.length > 0 ? ends[ends.length - 1] : 0 };
}

/**
 * A stacked clip's solo pass in the loop at loopOffset: the window FrameSlotter.beginRange fills, and the source range to
 * decode for it. Null when the window covers no whole slot (a clip its overlaps fill): nothing would be placed.
 * decodeFrom: soloOrigin when the clip before covers or dissolves over its head (that head is not decoded again), else In.
 * decodeTo: the window's slots, not its seconds, set the last frame: the window's two ends are rounded to slots separately, so
 * a frame up to a slot past soloOrigin + (soloEnd − soloStart) can still land inside it. Frames past it are dropped by the slotter.
 */
export function soloPass(
  clip: StackedClip,
  loopOffset: number,
  fps: number = FRAME_RATE,
): { fromSec: number; toSec: number; decodeFrom: number; decodeTo: number } | null {
  const fromSec = loopOffset + clip.soloStart;
  const toSec = loopOffset + clip.soloEnd;
  const slots = secToSlot(toSec, fps) - secToSlot(fromSec, fps);
  if (!(slots > 0)) return null;
  return {
    fromSec,
    toSec,
    decodeFrom: clip.soloOrigin > clip.origin ? clip.soloOrigin : clip.inSec,
    decodeTo: Math.min(clip.outSec, clip.soloOrigin + slots / fps),
  };
}

/** A shared frame cadence: the rate both clips report, and each clip's first frame time (nominal frames at first + j / rate). */
export interface DissolveCadence {
  rate: number;
  /** The outgoing clip's first frame time. */
  firstTimestamp: number;
  /** The incoming clip's own rate (within 1 % of rate) and first frame time; rate and 0 when absent. */
  incomingRate?: number;
  incomingFirstTimestamp?: number;
}

/**
 * Below this rate a dissolve at the source's own frames has too few of them: a 1 fps slideshow or a one-frame still has no
 * frame (or one) inside a 1 s overlap, and the picture would cut while the sound crossfades. Such clips blend on every slot.
 */
export const MIN_CADENCE_RATE = 10;

/**
 * A track's frame rate from its frame intervals, for the cadence. mediabunny's averagePacketRate is packetCount over
 * (last end − first start); a last packet stored without a duration (WebM from MediaRecorder) leaves one interval out of that
 * span, so the rate reads N / ((N − 1)·Δ). Then (N − 1) / (last − first) is the real one. lastPacket null or with a duration:
 * the average as given. Null when unknown.
 */
export function cadenceRate(
  averagePacketRate: number,
  firstTimestamp: number,
  lastPacket: { timestamp: number; duration: number } | null,
): number | null {
  if (!Number.isFinite(averagePacketRate) || !(averagePacketRate > 0)) return null;
  if (!lastPacket || lastPacket.duration > 0 || !Number.isFinite(lastPacket.timestamp)) return averagePacketRate;
  const span = lastPacket.timestamp - (Number.isFinite(firstTimestamp) ? firstTimestamp : 0);
  if (!(span > 0)) return averagePacketRate;
  // averagePacketRate = N / span here, so N − 1 = averagePacketRate · span − 1
  const rate = averagePacketRate - 1 / span;
  return rate > 0 ? rate : null;
}

/**
 * The outgoing clip's cadence when both clips report the same rate (|a − b| <= 1 % of the larger, both in
 * [MIN_CADENCE_RATE, 60]); else null (every slot).
 */
export function sharedCadence(
  a: { frameRate: number | null; firstTimestamp: number },
  b: { frameRate: number | null; firstTimestamp?: number },
): DissolveCadence | null {
  const ra = a.frameRate;
  const rb = b.frameRate;
  if (ra === null || rb === null || !Number.isFinite(ra) || !Number.isFinite(rb)) return null;
  if (!(ra >= MIN_CADENCE_RATE && ra <= FRAME_RATE && rb >= MIN_CADENCE_RATE && rb <= FRAME_RATE)) return null;
  if (Math.abs(ra - rb) > 0.01 * Math.max(ra, rb)) return null;
  const first = (t: number | undefined) => (typeof t === "number" && Number.isFinite(t) ? t : 0);
  return { rate: ra, firstTimestamp: first(a.firstTimestamp), incomingRate: rb, incomingFirstTimestamp: first(b.firstTimestamp) };
}

/**
 * One dissolve's frames in the loop starting at loopOffset (L). Each side shows the frame its own solo window would show on
 * that slot, so neither clip skips or repeats a frame where the dissolve meets its solo windows (or the next dissolve).
 * A clip X's solo mapping, as FrameSlotter places it: its frame at t lands on slot S_X + secToSlot(t − X.soloOrigin), with
 *   S_X = secToSlot(L + X.soloStart); extended before soloOrigin for the incoming clip, whose solo window comes after.
 *   The frame on slot n is the last frame mapped to n or before: the frame in effect at
 *   mapTime(X, n) = X.soloOrigin + (n − S_X + 0.5 − 1e-6) / fps   (secToSlot's own rounding, inverted).
 * The dissolve owns the slots [secToSlot(L + fromSec), secToSlot(L + toSec)): A's solo window ends on the first, B's starts on
 * the last, so nothing is left unwritten between them.
 * cadence null (every 1/60 slot): every slot of that range; outgoing time = mapTime(A, slot), incoming time = mapTime(B, slot);
 *   seq time s = slot / fps − L.
 * cadence { rate, firstTimestamp, incomingRate, incomingFirstTimestamp }: A's nominal frames τ_j = firstTimestamp + j / rate whose slot
 *   S_A + secToSlot(τ_j − A.soloOrigin) falls in that range; s_j = A.soloStart + (τ_j − A.soloOrigin); outgoing lookup time =
 *   τ_j + 0.5 / rate (the frame itself, robust to float error). When A has no solo window and its first frame in range lands
 *   after the first slot, the first slot is written too, with the frame in effect there (s = slot / fps − L), as a solo window
 *   writes its own first slot. B's nominal frames (at its own rate) are the ones just before the frame its solo mapping puts
 *   on S_B (B's first frame after the dissolve), one per written slot in order, each looked up at its own mid-frame time.
 * Both: times clamped to [clip.origin, clip.outSec − 1e-6]; alpha = clamp01((s + h − fromSec) / (toSec − fromSec)),
 *   h = half a frame (1/(2·fps) or 1/(2·rate), 0 for the added first slot): (i + 0.5)/n on the slot grid.
 */
export function dissolveFrames(
  plan: StackedPlan,
  d: Dissolve,
  loopOffset: number,
  opts: { fps?: number; cadence?: DissolveCadence | null } = {},
): { slots: number[]; outgoingTimes: number[]; incomingTimes: number[]; alphas: number[] } {
  const fps = opts.fps ?? FRAME_RATE;
  const a = plan.clips[d.outgoing];
  const b = plan.clips[d.incoming];
  const result = { slots: [] as number[], outgoingTimes: [] as number[], incomingTimes: [] as number[], alphas: [] as number[] };
  if (!a || !b || !(d.toSec > d.fromSec)) return result;

  const L = loopOffset;
  const firstSlot = secToSlot(L + d.fromSec, fps);
  const endSlot = secToSlot(L + d.toSec, fps);
  const soloSlotA = secToSlot(L + a.soloStart, fps);
  const soloSlotB = secToSlot(L + b.soloStart, fps);
  const mapTime = (clip: StackedClip, soloSlot: number, slot: number) => clip.soloOrigin + (slot - soloSlot + 0.5 - 1e-6) / fps;
  const span = d.toSec - d.fromSec;
  const within = (clip: StackedClip, t: number) => clamp(t, clip.origin, Math.max(clip.origin, clip.outSec - 1e-6));
  const alphaAt = (s: number, half: number) => clamp01((s + half - d.fromSec) / span);

  const cadence = opts.cadence ?? null;
  if (!cadence || !(cadence.rate > 0)) {
    for (let slot = firstSlot; slot < endSlot; slot++) {
      result.slots.push(slot);
      result.outgoingTimes.push(within(a, mapTime(a, soloSlotA, slot)));
      result.incomingTimes.push(within(b, mapTime(b, soloSlotB, slot)));
      result.alphas.push(alphaAt(slot / fps - L, 1 / (2 * fps)));
    }
    return result;
  }

  const { rate, firstTimestamp } = cadence;
  const outgoing: Array<{ slot: number; time: number; alpha: number }> = [];
  // Start a frame early and filter by slot: the range is defined on the slot grid, not on τ.
  const fromTau = a.soloOrigin + (d.fromSec - a.soloStart);
  let j = Math.max(0, Math.floor((fromTau - firstTimestamp) * rate) - 1);
  for (; ; j++) {
    const tau = firstTimestamp + j / rate;
    const slot = soloSlotA + secToSlot(tau - a.soloOrigin, fps);
    if (slot >= endSlot) break;
    if (slot < firstSlot) continue;
    outgoing.push({ slot, time: tau + 0.5 / rate, alpha: alphaAt(a.soloStart + (tau - a.soloOrigin), 1 / (2 * rate)) });
  }
  if (!soloPass(a, L, fps) && firstSlot < endSlot && (outgoing.length === 0 || outgoing[0].slot > firstSlot)) {
    outgoing.unshift({ slot: firstSlot, time: mapTime(a, soloSlotA, firstSlot), alpha: alphaAt(firstSlot / fps - L, 0) });
  }

  // B's first frame after the dissolve: the last nominal frame its solo mapping puts on S_B or before.
  const incomingRate = cadence.incomingRate !== undefined && cadence.incomingRate > 0 ? cadence.incomingRate : rate;
  const incomingFirst = cadence.incomingFirstTimestamp ?? 0;
  const frameOf = (k: number) => incomingFirst + k / incomingRate;
  let next = Math.floor((b.soloOrigin - incomingFirst) * incomingRate);
  while (secToSlot(frameOf(next + 1) - b.soloOrigin, fps) <= 0) next++;
  while (secToSlot(frameOf(next) - b.soloOrigin, fps) > 0) next--;

  outgoing.forEach((frame, i) => {
    result.slots.push(frame.slot);
    result.outgoingTimes.push(within(a, frame.time));
    result.incomingTimes.push(within(b, frameOf(next - (outgoing.length - i)) + 0.5 / incomingRate));
    result.alphas.push(frame.alpha);
  });
  return result;
}

/** Equal-power: "in" = sin(x·π/2), "out" = cos(x·π/2); x clamped to [0, 1]. */
export function crossfadeGain(x: number, side: "in" | "out"): number {
  const angle = (clamp01(x) * Math.PI) / 2;
  return side === "in" ? Math.sin(angle) : Math.cos(angle);
}

/**
 * A stacked clip's fades in its own samples at rate sr (crossfade on). The clip sits at round(seqStart·sr) in the loop.
 * inLength = round(overlapIn·sr); outStart = round(nextSeqStart·sr) − round(seqStart·sr); outLength = round(overlapOut·sr).
 * nextSeqStart is null for the last clip (no fade out). The next clip's fade-in covers exactly the same loop samples.
 */
export function clipFadeSamples(
  clip: Pick<StackedClip, "seqStart" | "overlapIn" | "overlapOut">,
  nextSeqStart: number | null,
  sr: number,
): { inLength: number; outStart: number; outLength: number } {
  const inLength = Math.round(clip.overlapIn * sr);
  if (nextSeqStart === null) return { inLength, outStart: 0, outLength: 0 };
  return {
    inLength,
    outStart: Math.round(nextSeqStart * sr) - Math.round(clip.seqStart * sr),
    outLength: Math.round(clip.overlapOut * sr),
  };
}
