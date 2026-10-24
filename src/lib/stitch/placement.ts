import { FRAME_RATE } from "./sequencePlan";
import { joinOverlaps, type StackItem } from "./stack";

/**
 * A placed Stacked timeline's picture and sound: where each clip starts, which
 * clips play at an instant, how far each shows through the clips above it and
 * how loud it is. The editor's lane and preview, the card and the encoder all
 * read it from here, so they cannot disagree.
 *
 * Rows are layers: row 0 is in front. With Crossfade on, a clip fades in across
 * the overlap at its start when it starts over the picture below it, and out
 * across the overlap at its end when that picture plays on after it; each fade
 * is capped by how long the picture below has played (or plays on), so moving
 * a clip never makes the picture jump. With Crossfade off the top live clip
 * covers and every live clip is heard. Pieces of one video whose frames
 * continue (a split) count as one clip: a split changes nothing.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds.
 */

/** A non-empty clip on the Stacked timeline. row = its timeline index (0 = top); source = its source key; inSec = its In. */
export interface PlacedUnit {
  start: number;
  length: number;
  row: number;
  source: string;
  inSec: number;
}

export interface LayerFades {
  fadeIn: number;
  fadeOut: number;
}

/**
 * One output slot, seconds (1/60). Fades and gaps shorter than this count as nothing; gaps shorter than this in the
 * picture below a clip are bridged.
 */
export const SLOT_SEC = 1 / FRAME_RATE;
/** Two instants this close are one, seconds. */
export const TIME_EPS = 1e-9;
/**
 * Two pieces of one video continue each other when their join and their frames' anchors miss by less than this (half
 * a slot), seconds.
 */
export const RUN_TOL_SEC = SLOT_SEC / 2;
/** The latest a stored start may be, seconds: it bounds the encoder's audio buffers. */
export const MAX_START_SEC = 600;
/** Above this many visible layers the encoder warns. */
export const LAYER_WARNING = 4;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
/** NaN becomes 0. */
const clamp01 = (value: number) => (Number.isNaN(value) ? 0 : clamp(value, 0, 1));
const underSlot = (sec: number) => sec < SLOT_SEC - TIME_EPS;
// Exactly 1 and 0 at the ends, so a covered clip is silent rather than at cos(π/2) ≈ 6e-17
const sinHalfPi = (a: number) => (a >= 1 ? 1 : Math.sin((a * Math.PI) / 2));
const cosHalfPi = (a: number) => (a >= 1 ? 0 : Math.cos((a * Math.PI) / 2));
/** A clip's gain from its own opacity α (clamped to [0, 1]): sin(α·π/2), exactly 1 at α = 1. */
export const ownGain = (alpha: number) => sinHalfPi(clamp01(alpha));
/** The factor a layer above at opacity α (clamped) leaves a clip's gain: cos(α·π/2), exactly 0 at α = 1. */
export const coverGain = (alpha: number) => cosHalfPi(clamp01(alpha));

/** Live at t: start − TIME_EPS <= t < end − TIME_EPS. Every function here uses this one predicate. */
export function isLive(start: number, end: number, t: number): boolean {
  return start - TIME_EPS <= t && t < end - TIME_EPS;
}

/**
 * The pair rule of commit 9, for one join: joinOverlaps([a, b], overlapSec)[1]. Same source → 0. Only the overlap
 * snap target uses it.
 */
export function pairOverlap(a: StackItem, b: StackItem, overlapSec: number): number {
  return joinOverlaps([a, b], overlapSec)[1];
}

/**
 * Starts for a placed stack, in row order. A finite stored start is kept (clamped to [0, MAX_START_SEC]). An item
 * without one starts at max(0, E − o_i): E is the latest end among the non-empty items above it (0 when none), and
 * o_i = joinOverlaps(items, overlapSec)[i], computed once over every item in row order (lengths and sources only, so
 * run caps apply as in Line up). An item of length <= 0 takes that start and does not change E. A derived start is
 * capped at MAX_START_SEC too, so pinning it stores what is drawn.
 */
export function resolveStarts(
  items: ReadonlyArray<{ start?: number; length: number; source: string }>,
  overlapSec: number,
): number[] {
  const overlaps = joinOverlaps(
    items.map((item) => ({ length: item.length > 0 ? item.length : 0, source: item.source })),
    overlapSec,
  );
  let latestEnd = 0;
  return items.map((item, i) => {
    const stored = item.start;
    const start =
      stored !== undefined && Number.isFinite(stored)
        ? clamp(stored, 0, MAX_START_SEC)
        : clamp(latestEnd - overlaps[i], 0, MAX_START_SEC);
    if (item.length > 0) latestEnd = Math.max(latestEnd, start + item.length);
    return start;
  });
}

/**
 * A run: pieces whose frames continue, in consecutive non-empty rows, in row order (which is time order).
 * units index StackEnvelope.units; row = its first piece's row.
 */
export interface PlacedRun {
  units: readonly number[];
  start: number;
  end: number;
  row: number;
}

export interface StackEnvelope {
  /** The non-empty units, in row order. Every unit index in this module indexes this array. */
  units: readonly PlacedUnit[];
  /** In row order: runs[0] is the top (front) run. */
  runs: readonly PlacedRun[];
  /** runOf[u] = the run that unit u belongs to. */
  runOf: readonly number[];
  /** Per run; all zeros when crossfade is off. */
  fades: readonly LayerFades[];
  /** Per run, the picture below it as sorted [from, to) parts, sub-slot gaps bridged; [] when crossfade is off. */
  pictureBelow: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  crossfade: boolean;
  /**
   * Sorted, merged within TIME_EPS (the first value of a cluster stands for it): 0, every unit start and end, every
   * run's start + fadeIn and end − fadeOut, the loop end. Between two of them every α is linear and nothing starts or
   * stops.
   */
  breakpoints: readonly number[];
  /** The latest end (0 when no unit). */
  loopLength: number;
}

/** The union of these intervals as sorted parts; two parts whose gap is under one slot are one (bridged). */
function unionBridged(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const parts: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = parts[parts.length - 1];
    if (last && underSlot(from - last[1])) {
      last[1] = Math.max(last[1], to);
      continue;
    }
    parts.push([from, to]);
  }
  return parts;
}

/**
 * A run's fades against the picture below it. In: the overlap at its start, at most the lead (how long that picture
 * has played). Out: the overlap at its end, at most the trail (how long it plays on). Fades under a slot are 0; two
 * that sum past the run's length are scaled to fit it, and a scaled fade under a slot gives the whole length to the
 * other.
 */
function runFades(run: { start: number; end: number }, below: ReadonlyArray<readonly [number, number]>): LayerFades {
  const { start: s, end: e } = run;
  let fadeIn = 0;
  let fadeOut = 0;
  for (const [p, q] of below) {
    if (isLive(p, q, s)) fadeIn = Math.max(fadeIn, Math.min(Math.min(q, e) - s, s - p));
    if (p < e - TIME_EPS && q > e + TIME_EPS) fadeOut = Math.max(fadeOut, Math.min(e - Math.max(p, s), q - e));
  }
  if (underSlot(fadeIn)) fadeIn = 0;
  if (underSlot(fadeOut)) fadeOut = 0;
  const length = e - s;
  if (fadeIn + fadeOut > length + TIME_EPS) {
    const scaledIn = (length * fadeIn) / (fadeIn + fadeOut);
    fadeIn = scaledIn;
    fadeOut = length - scaledIn;
    if (underSlot(fadeIn)) {
      fadeIn = 0;
      fadeOut = underSlot(length) ? 0 : length;
    } else if (underSlot(fadeOut)) {
      fadeOut = 0;
      fadeIn = length;
    }
  }
  return { fadeIn, fadeOut };
}

export function buildEnvelope(units: readonly PlacedUnit[], crossfade: boolean): StackEnvelope {
  const sorted = units.filter((u) => u.length > 0).sort((a, b) => a.row - b.row);
  const runs: Array<{ units: number[]; start: number; end: number; row: number }> = [];
  const runOf: number[] = [];
  sorted.forEach((unit, i) => {
    const above = i > 0 ? sorted[i - 1] : null;
    const continues =
      above !== null &&
      above.source === unit.source &&
      Math.abs(unit.start - (above.start + above.length)) < RUN_TOL_SEC - TIME_EPS &&
      Math.abs(unit.start - unit.inSec - (above.start - above.inSec)) < RUN_TOL_SEC - TIME_EPS;
    if (continues) {
      const run = runs[runs.length - 1];
      run.units.push(i);
      run.end = unit.start + unit.length;
    } else {
      runs.push({ units: [i], start: unit.start, end: unit.start + unit.length, row: unit.row });
    }
    runOf.push(runs.length - 1);
  });

  const pictureBelow: Array<Array<[number, number]>> = runs.map(() => []);
  const fades: LayerFades[] = runs.map(() => ({ fadeIn: 0, fadeOut: 0 }));
  if (crossfade) {
    runs.forEach((run, k) => {
      pictureBelow[k] = unionBridged(runs.slice(k + 1).map((r): [number, number] => [r.start, r.end]));
      fades[k] = runFades(run, pictureBelow[k]);
    });
  }

  const loopLength = sorted.reduce((end, u) => Math.max(end, u.start + u.length), 0);
  const raw = [0, loopLength];
  sorted.forEach((u) => raw.push(u.start, u.start + u.length));
  runs.forEach((run, k) => raw.push(run.start + fades[k].fadeIn, run.end - fades[k].fadeOut));
  raw.sort((a, b) => a - b);
  const breakpoints: number[] = [];
  for (const t of raw) {
    if (breakpoints.length === 0 || t - breakpoints[breakpoints.length - 1] > TIME_EPS) breakpoints.push(t);
  }
  return { units: sorted, runs, runOf, fades, pictureBelow, crossfade, breakpoints, loopLength };
}

/** α of run k at t: 0 when not live; 1 outside its fades; linear across them. */
function runAlpha(env: StackEnvelope, k: number, t: number): number {
  const run = env.runs[k];
  if (!isLive(run.start, run.end, t)) return 0;
  const { fadeIn, fadeOut } = env.fades[k];
  let alpha = 1;
  if (fadeIn > 0) alpha = Math.min(alpha, (t - run.start) / fadeIn);
  if (fadeOut > 0) alpha = Math.min(alpha, (run.end - t) / fadeOut);
  return clamp01(alpha);
}

/** The run's piece at t: the last of its units that has started (an earlier piece holds over a gap under half a slot). */
function pieceAt(env: StackEnvelope, k: number, t: number): number {
  const pieces = env.runs[k].units;
  let piece = pieces[0];
  for (const u of pieces) if (env.units[u].start - TIME_EPS <= t) piece = u;
  return piece;
}

/** One run in the composite at an instant, before the bottom one is set to 1. */
export interface RunLayer {
  run: number;
  /** The run's piece: a unit index. */
  unit: number;
  /** Its opacity as the fades give it, clamped to [0, 1]. A held run's is the one it had just before its gap. */
  alpha: number;
  held: boolean;
  /** Where its α was read: t, or just before the bridged gap a held run holds across. */
  at: number;
}

/**
 * Crossfade on: the live runs at t, top first, with their piece and α. Inside a bridged gap of the picture below the
 * bottom live run, the runs below it that were live just before the gap follow (held), with their piece and α as just
 * before it, and the rule applies again below them. Crossfade off: [].
 */
export function liveRunsAt(env: StackEnvelope, t: number): RunLayer[] {
  if (!env.crossfade) return [];
  return liveRunsFrom(env, t, 0, false);
}

function liveRunsFrom(env: StackEnvelope, t: number, from: number, held: boolean): RunLayer[] {
  const out: RunLayer[] = [];
  for (let k = from; k < env.runs.length; k++) {
    const run = env.runs[k];
    if (isLive(run.start, run.end, t)) out.push({ run: k, unit: pieceAt(env, k, t), alpha: runAlpha(env, k, t), held, at: t });
  }
  if (out.length === 0) return out;
  const bottom = out[out.length - 1].run;
  const inPicture = env.pictureBelow[bottom].some(([p, q]) => p - TIME_EPS <= t && t < q - TIME_EPS);
  if (!inPicture) return out;
  // t is inside a bridged gap below the bottom live run: the runs that played just before it hold until it ends
  let gapStart = -Infinity;
  for (let k = bottom + 1; k < env.runs.length; k++) {
    const end = env.runs[k].end;
    if (end <= t + TIME_EPS) gapStart = Math.max(gapStart, end);
  }
  if (!Number.isFinite(gapStart)) return out;
  return out.concat(liveRunsFrom(env, gapStart - 2 * TIME_EPS, bottom + 1, true));
}

/** One clip in the composite at an instant: its unit, opacity α, share of the picture and gain. */
export interface EnvelopeLayer {
  unit: number;
  alpha: number;
  weight: number;
  gain: number;
  /** A run holding its last frame across a bridged gap below the clips that play. */
  held?: boolean;
}

/**
 * One layer per live run at t: the run's piece at t, bottom (the highest row number) first, with the run's opacity α
 * (clamped to [0, 1]; the bottom layer's is 1), its share of the picture (weight) and its gain. Inside a bridged gap of
 * the picture below the bottom live run, the held runs below it come first (held: true; their piece and α as just
 * before the gap). Crossfade off: one layer per live unit, bottom first, the top one at weight 1. [] in a gap or
 * outside [0, loopLength).
 */
export function envelopeAt(env: StackEnvelope, t: number): EnvelopeLayer[] {
  if (!env.crossfade) {
    const live: number[] = [];
    env.units.forEach((u, i) => {
      if (isLive(u.start, u.start + u.length, t)) live.push(i);
    });
    return live
      .map((unit, i) => ({ unit, alpha: i === 0 ? 1 : 0, weight: i === 0 ? 1 : 0, gain: 1 }))
      .reverse();
  }
  const stack = liveRunsAt(env, t);
  const layers: EnvelopeLayer[] = [];
  let rest = 1;
  let cosProduct = 1;
  stack.forEach((layer, i) => {
    // By the rules the bottom layer is opaque already; writing 1 absorbs float error
    const alpha = i === stack.length - 1 ? 1 : layer.alpha;
    layers.push({
      unit: layer.unit,
      alpha,
      weight: alpha * rest,
      gain: sinHalfPi(alpha) * cosProduct,
      ...(layer.held ? { held: true } : {}),
    });
    rest *= 1 - alpha;
    cosProduct *= cosHalfPi(alpha);
  });
  return layers.reverse();
}

/** CSS opacities for weights given in DOM order, bottom first: α_k = w_k / Σ_{i<=k} w_i (0 when the sum is 0). */
export function domOpacities(weights: readonly number[]): number[] {
  let sum = 0;
  return weights.map((w) => {
    sum += w;
    return sum > 0 ? clamp01(w / sum) : 0;
  });
}

/** [from, to) inside [0, loopLength) where no unit is live, only those at least SLOT_SEC long. */
export function gaps(env: StackEnvelope): Array<{ fromSec: number; toSec: number }> {
  const out: Array<{ fromSec: number; toSec: number }> = [];
  const intervals = env.units.map((u) => [u.start, u.start + u.length] as const).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (const [from, to] of intervals) {
    if (from > covered && !underSlot(from - covered)) out.push({ fromSec: covered, toSec: from });
    covered = Math.max(covered, to);
  }
  return out;
}

/** How unit u is drawn over its own span, in its own seconds from its start. */
export type WeightPiece =
  /** w linear from → to. */
  | { kind: "ramp"; fromSec: number; toSec: number; from: number; to: number }
  /** [sec, w], 2–17 points. */
  | { kind: "curve"; fromSec: number; toSec: number; points: Array<[number, number]> }
  /** w = 0 throughout; coveredByRow is the row of the clip in front of it. */
  | { kind: "hidden"; fromSec: number; toSec: number; coveredByRow: number };

/** α over one piece: clamp01(at + slope · (t − fromSec)). Each α is linear between two breakpoints. */
export interface LinearAlpha {
  at: number;
  slope: number;
}

const alphaAt = (alpha: LinearAlpha, fromSec: number, t: number) => clamp01(alpha.at + alpha.slope * (t - fromSec));

/** Run k's α over [fromSec, …) as one linear piece, read at mid (inside the piece). */
function linearAlpha(env: StackEnvelope, k: number, mid: number, fromSec: number): LinearAlpha {
  const run = env.runs[k];
  const { fadeIn, fadeOut } = env.fades[k];
  let value = 1;
  let slope = 0;
  if (fadeIn > 0 && (mid - run.start) / fadeIn < value) {
    value = (mid - run.start) / fadeIn;
    slope = 1 / fadeIn;
  }
  if (fadeOut > 0 && (run.end - mid) / fadeOut < value) {
    value = (run.end - mid) / fadeOut;
    slope = -1 / fadeOut;
  }
  return { at: value - slope * (mid - fromSec), slope };
}

/** Unit u over one interval as factors: w = own · Π (1 − above), γ = sin(own·π/2) · Π cos(above·π/2). */
interface Factors {
  own: LinearAlpha;
  above: LinearAlpha[];
  /** Rows of the layers above, top first, with whether each is opaque throughout the interval. */
  aboveRows: Array<{ row: number; opaque: boolean }>;
}

/**
 * Unit u's factors over [fromSec, toSec), an interval between breakpoints, read at its middle. { coverRow } when u is
 * not a layer there (w = 0): the row of the top layer. null when nothing plays.
 */
function factorsOver(env: StackEnvelope, unit: number, fromSec: number, toSec: number): Factors | { coverRow: number } | null {
  const mid = (fromSec + toSec) / 2;
  if (!env.crossfade) {
    let top = -1;
    env.units.forEach((u, i) => {
      if (top === -1 && isLive(u.start, u.start + u.length, mid)) top = i;
    });
    if (top === unit) return { own: { at: 1, slope: 0 }, above: [], aboveRows: [] };
    return top === -1 ? null : { coverRow: env.units[top].row };
  }
  const stack = liveRunsAt(env, mid);
  const index = stack.findIndex((layer) => layer.unit === unit && !layer.held);
  if (index === -1) return stack.length > 0 ? { coverRow: env.units[stack[0].unit].row } : null;
  const alphaOf = (layer: RunLayer, i: number): LinearAlpha =>
    i === stack.length - 1
      ? { at: 1, slope: 0 }
      : layer.held
        ? { at: layer.alpha, slope: 0 }
        : linearAlpha(env, layer.run, mid, fromSec);
  const above = stack.slice(0, index).map(alphaOf);
  return {
    own: alphaOf(stack[index], index),
    above,
    aboveRows: stack.slice(0, index).map((layer, i) => ({
      row: env.units[layer.unit].row,
      opaque: above[i].slope === 0 && above[i].at >= 1 - TIME_EPS,
    })),
  };
}

const weightOf = (f: Factors, fromSec: number, t: number) =>
  f.above.reduce((w, a) => w * (1 - alphaAt(a, fromSec, t)), alphaAt(f.own, fromSec, t));
const gainOf = (f: Factors, fromSec: number, t: number) =>
  f.above.reduce((g, a) => g * cosHalfPi(alphaAt(a, fromSec, t)), sinHalfPi(alphaAt(f.own, fromSec, t)));
const varying = (f: Factors) => (f.own.slope !== 0 ? 1 : 0) + f.above.filter((a) => a.slope !== 0).length;

/** The intervals between breakpoints inside [from, to), each longer than TIME_EPS. */
function intervalsIn(env: StackEnvelope, from: number, to: number): Array<[number, number]> {
  const cuts = [from, ...env.breakpoints.filter((b) => b > from + TIME_EPS && b < to - TIME_EPS), to];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > TIME_EPS) out.push([cuts[i], cuts[i + 1]]);
  return out;
}

const NEAR = 1e-12;

/** One interval of unit u: nothing to draw (w = 1), or the piece, in loop seconds. */
function weightOver(env: StackEnvelope, unit: number, a: number, b: number, pxPerSec: number): WeightPiece | null {
  const f = factorsOver(env, unit, a, b);
  if (f === null) return { kind: "hidden", fromSec: a, toSec: b, coveredByRow: env.units[unit].row };
  if ("coverRow" in f) return { kind: "hidden", fromSec: a, toSec: b, coveredByRow: f.coverRow };
  const ends = [weightOf(f, a, a), weightOf(f, a, (a + b) / 2), weightOf(f, a, b)];
  if (ends.every((w) => w <= NEAR)) {
    // The nearest clip above that is opaque throughout covers it
    let cover = f.aboveRows[0]?.row ?? env.units[unit].row;
    for (let i = f.aboveRows.length - 1; i >= 0; i--) {
      if (f.aboveRows[i].opaque) {
        cover = f.aboveRows[i].row;
        break;
      }
    }
    return { kind: "hidden", fromSec: a, toSec: b, coveredByRow: cover };
  }
  if (ends.every((w) => w >= 1 - NEAR)) return null;
  if (varying(f) <= 1) return { kind: "ramp", fromSec: a, toSec: b, from: ends[0], to: ends[2] };
  const count = Math.max(2, Math.min(17, Math.ceil(((b - a) * pxPerSec) / 4) + 1));
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const t = a + ((b - a) * i) / (count - 1);
    points.push([t, weightOf(f, a, t)]);
  }
  return { kind: "curve", fromSec: a, toSec: b, points };
}

/**
 * How unit u is drawn over its own span, in its own seconds from its start. Per interval between breakpoints: w ≡ 1 →
 * nothing; w ≡ 0 → hidden, with the row of the clip that covers it (Off: the top live row; On: the nearest run above
 * it that is opaque throughout); w linear (one fading factor) → ramp; otherwise a curve, sampled at max(2, min(17,
 * ⌈interval px / 4⌉ + 1)) points. Neighbouring hidden pieces under the same row are one.
 */
export function weightPieces(env: StackEnvelope, unit: number, pxPerSec: number = 64): WeightPiece[] {
  const u = env.units[unit];
  if (!u) return [];
  const pps = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : 64;
  const pieces: WeightPiece[] = [];
  for (const [a, b] of intervalsIn(env, u.start, u.start + u.length)) {
    const piece = weightOver(env, unit, a, b, pps);
    if (!piece) continue;
    const last = pieces[pieces.length - 1];
    if (
      piece.kind === "hidden" &&
      last?.kind === "hidden" &&
      last.coveredByRow === piece.coveredByRow &&
      Math.abs(last.toSec - piece.fromSec) <= TIME_EPS
    ) {
      last.toSec = piece.toSec;
      continue;
    }
    pieces.push(piece);
  }
  return pieces.map((piece) => {
    const own = { fromSec: piece.fromSec - u.start, toSec: piece.toSec - u.start };
    if (piece.kind !== "curve") return { ...piece, ...own };
    return { ...piece, ...own, points: piece.points.map(([t, w]): [number, number] => [t - u.start, w]) };
  });
}

/**
 * Unit u's gain over its own span in loop seconds: constant pieces, and pieces where it varies as
 * sin(own·π/2) · Π cos(above_k·π/2) over the live runs above it. Off: one constant piece of gain 1.
 */
export type GainPiece =
  | { fromSec: number; toSec: number; gain: number }
  | { fromSec: number; toSec: number; own: LinearAlpha; above: readonly LinearAlpha[] };

export function gainPieces(env: StackEnvelope, unit: number): GainPiece[] {
  const u = env.units[unit];
  if (!u) return [];
  if (!env.crossfade) return [{ fromSec: u.start, toSec: u.start + u.length, gain: 1 }];
  const pieces: GainPiece[] = [];
  for (const [a, b] of intervalsIn(env, u.start, u.start + u.length)) {
    const f = factorsOver(env, unit, a, b);
    let piece: GainPiece;
    if (f === null || "coverRow" in f) piece = { fromSec: a, toSec: b, gain: 0 };
    else if (varying(f) > 0) piece = { fromSec: a, toSec: b, own: f.own, above: f.above };
    else piece = { fromSec: a, toSec: b, gain: gainOf(f, a, a) };
    const last = pieces[pieces.length - 1];
    if (last && "gain" in last && "gain" in piece && Math.abs(last.gain - piece.gain) <= NEAR) {
      last.toSec = piece.toSec;
      continue;
    }
    pieces.push(piece);
  }
  return pieces;
}

/** A gain piece's value at t (loop seconds, inside the piece). */
export function gainPieceAt(piece: GainPiece, t: number): number {
  if ("gain" in piece) return piece.gain;
  return piece.above.reduce(
    (g, a) => g * cosHalfPi(alphaAt(a, piece.fromSec, t)),
    sinHalfPi(alphaAt(piece.own, piece.fromSec, t)),
  );
}

/** Crossfade on: the number of non-zero fades (each fade-in and each fade-out counts one). The card's "N crossfades". */
export function crossfadeCount(env: StackEnvelope): number {
  if (!env.crossfade) return 0;
  return env.fades.reduce((n, f) => n + (f.fadeIn > 0 ? 1 : 0) + (f.fadeOut > 0 ? 1 : 0), 0);
}

/** Pairs of runs whose spans overlap by at least SLOT_SEC, whatever the crossfade flag. The card's "N overlaps" (off). */
export function overlapCount(env: StackEnvelope): number {
  let n = 0;
  env.runs.forEach((a, i) => {
    for (const b of env.runs.slice(i + 1)) if (!underSlot(Math.min(a.end, b.end) - Math.max(a.start, b.start))) n++;
  });
  return n;
}

/** Units whose weight is 0 over their whole span (hidden under higher rows), in row order. The summary names them. */
export function hiddenUnits(env: StackEnvelope): number[] {
  const out: number[] = [];
  env.units.forEach((u, unit) => {
    const intervals = intervalsIn(env, u.start, u.start + u.length);
    if (intervals.length > 0 && intervals.every(([a, b]) => weightOver(env, unit, a, b, 64)?.kind === "hidden")) {
      out.push(unit);
    }
  });
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The card's middle items for a placed stack: ["2 crossfades" | "2 overlaps"]? then ["1 gap"]? */
export function placedCardItems(env: StackEnvelope): string[] {
  const items: string[] = [];
  if (env.crossfade) {
    const n = crossfadeCount(env);
    if (n > 0) items.push(plural(n, "crossfade", "crossfades"));
  } else {
    const n = overlapCount(env);
    if (n > 0) items.push(plural(n, "overlap", "overlaps"));
  }
  const gapCount = gaps(env).length;
  if (gapCount > 0) items.push(plural(gapCount, "gap", "gaps"));
  return items;
}
