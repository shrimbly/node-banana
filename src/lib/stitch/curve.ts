import type { VolumePoint } from "@/types";

/**
 * The music's volume curve over the Stitch sequence (one loop).
 *
 * Gain is linear, 0..1 (1 = 0 dB). Between points the curve runs straight in
 * display *level*, `1 − √gain` (0 = 0 dB at the top of the lane, 1 = −∞ at the
 * bottom), so −12 dB sits on the middle guide and a straight segment on screen
 * is exactly what is heard. An empty curve is flat at 0 dB, and each end is
 * held before the first point and after the last.
 *
 * Every function here takes a curve sorted by t (see sortCurve) and returns a
 * new one; nothing is mutated.
 */

export const FADE_SEC = 1;
export const MIN_POINT_GAP_SEC = 0.01;

/** NaN becomes 0, so a value from pointer maths on a zero-size lane cannot reach the data. */
const clamp01 = (value: number) => (Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), 1));

/** Sanitise: finite values, t >= 0, gain clamped 0..1, sorted by t; when t repeats, keep the last. */
export function sortCurve(curve: readonly VolumePoint[] | undefined): VolumePoint[] {
  if (!Array.isArray(curve)) return [];
  const byTime = new Map<number, VolumePoint>();
  for (const point of curve as readonly unknown[]) {
    if (!point || typeof point !== "object") continue;
    const { t, gain } = point as Partial<VolumePoint>;
    if (typeof t !== "number" || typeof gain !== "number") continue;
    if (!Number.isFinite(t) || !Number.isFinite(gain) || t < 0) continue;
    byTime.delete(t);
    byTime.set(t, { t, gain: clamp01(gain) });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function gainToLevel(gain: number): number {
  return 1 - Math.sqrt(clamp01(gain));
}

export function levelToGain(level: number): number {
  return (1 - clamp01(level)) ** 2;
}

/** Empty → 1. Before the first point, the first gain; after the last, the last gain. Between points: levelToGain(lerp(level_a, level_b, u)). */
export function gainAt(curve: readonly VolumePoint[], t: number): number {
  if (curve.length === 0) return 1;
  if (!(t > curve[0].t)) return curve[0].gain; // NaN too
  const last = curve[curve.length - 1];
  if (t >= last.t) return last.gain;
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i];
    if (t > b.t) continue;
    const a = curve[i - 1];
    if (t === b.t || b.t === a.t) return b.gain;
    const u = (t - a.t) / (b.t - a.t);
    const level = gainToLevel(a.gain) + (gainToLevel(b.gain) - gainToLevel(a.gain)) * u;
    return levelToGain(level);
  }
  return last.gain;
}

/**
 * gain defaults to gainAt(curve, t), so a click on the line adds a point on the line. Points closer than
 * MIN_POINT_GAP_SEC to t are replaced, so the points stay at least that far apart. A non-finite t adds nothing
 * (index −1); a non-finite gain counts as omitted.
 */
export function addPoint(
  curve: readonly VolumePoint[],
  t: number,
  gain?: number,
): { curve: VolumePoint[]; index: number } {
  if (!Number.isFinite(t)) return { curve: curve.slice(), index: -1 };
  const at = Math.max(0, t);
  const point = { t: at, gain: clamp01(gain !== undefined && Number.isFinite(gain) ? gain : gainAt(curve, at)) };
  const next = curve.filter((p) => Math.abs(p.t - at) >= MIN_POINT_GAP_SEC);
  let index = next.findIndex((p) => p.t > at);
  if (index === -1) index = next.length;
  next.splice(index, 0, point);
  return { curve: next, index };
}

/**
 * t clamped to [prev.t + GAP, next.t − GAP] (and >= 0); gain clamped 0..1. A neighbour already closer than GAP
 * bounds the point at its current t instead, so the curve stays sorted and a drag that does not move stays put.
 * A non-finite t or gain keeps the point's current one.
 */
export function movePoint(curve: readonly VolumePoint[], index: number, t: number, gain: number): VolumePoint[] {
  if (index < 0 || index >= curve.length) return curve.slice();
  const current = curve[index].t;
  const prev = curve[index - 1];
  const next = curve[index + 1];
  const min = prev ? Math.min(prev.t + MIN_POINT_GAP_SEC, current) : 0;
  const max = next ? Math.max(next.t - MIN_POINT_GAP_SEC, current) : Infinity;
  const at = Math.min(Math.max(Number.isFinite(t) ? t : current, min), max);
  const nextGain = Number.isFinite(gain) ? clamp01(gain) : curve[index].gain;
  return curve.map((p, i) => (i === index ? { t: at, gain: nextGain } : p));
}

export function removePoint(curve: readonly VolumePoint[], index: number): VolumePoint[] {
  return curve.filter((_, i) => i !== index);
}

/** ⌥-drag: every point's level += deltaLevel, clamped. An empty curve becomes [{0,g},{sequenceSec,g}] with g = levelToGain(deltaLevel). */
export function offsetCurve(curve: readonly VolumePoint[], deltaLevel: number, sequenceSec: number): VolumePoint[] {
  if (!Number.isFinite(deltaLevel)) return curve.slice();
  if (curve.length === 0) {
    const gain = levelToGain(deltaLevel);
    return sequenceSec > 0 && Number.isFinite(sequenceSec) ? [{ t: 0, gain }, { t: sequenceSec, gain }] : [{ t: 0, gain }];
  }
  return curve.map((p) => ({ t: p.t, gain: levelToGain(gainToLevel(p.gain) + deltaLevel) }));
}

/** L = min(length, seq/2); seq <= 0 or not finite → unchanged; a non-finite length counts FADE_SEC. Drops points with t <= L; adds {0,0} and {L, gainAt(old, L)}. */
export function fadeIn(curve: readonly VolumePoint[], sequenceSec: number, length: number = FADE_SEC): VolumePoint[] {
  return fadeInRange(curve, 0, sequenceSec, length);
}

/** s = seq − L. Drops points with t >= s; adds {s, gainAt(old, s)} and {seq, 0}. */
export function fadeOut(curve: readonly VolumePoint[], sequenceSec: number, length: number = FADE_SEC): VolumePoint[] {
  return fadeOutRange(curve, 0, sequenceSec, length);
}

/**
 * fadeIn over [from, to] (an audio clip's heard part, in its source seconds): L = min(length, (to − from)/2); an empty
 * or non-finite range → unchanged. Drops every point with t <= from + L; adds {from, 0} and {from + L, gainAt(old,
 * from + L)}.
 */
export function fadeInRange(
  curve: readonly VolumePoint[],
  from: number,
  to: number,
  length: number = FADE_SEC,
): VolumePoint[] {
  if (!(to > from) || !Number.isFinite(from) || !Number.isFinite(to)) return curve.slice();
  const end = from + Math.min(Number.isFinite(length) ? length : FADE_SEC, (to - from) / 2);
  return [{ t: from, gain: 0 }, { t: end, gain: gainAt(curve, end) }, ...curve.filter((p) => p.t > end)];
}

/** fadeOut over [from, to]: s = to − L. Drops points with t >= s; adds {s, gainAt(old, s)} and {to, 0}. */
export function fadeOutRange(
  curve: readonly VolumePoint[],
  from: number,
  to: number,
  length: number = FADE_SEC,
): VolumePoint[] {
  if (!(to > from) || !Number.isFinite(from) || !Number.isFinite(to)) return curve.slice();
  const start = to - Math.min(Number.isFinite(length) ? length : FADE_SEC, (to - from) / 2);
  return [...curve.filter((p) => p.t < start), { t: start, gain: gainAt(curve, start) }, { t: to, gain: 0 }];
}

/**
 * A fade out that ends at the sequence's end follows the end when the length changes without a trim (a layout switch,
 * a new overlap): when the curve's last point has gain 0 within one 1/60 s frame of oldTotal, the last two points
 * move by newTotal − oldTotal. Shifting rather than fading again is exactly invertible, so switching back restores the
 * curve. Anything else, or a move that would put the second-to-last point before 0 or within MIN_POINT_GAP_SEC of
 * the point before it, leaves the curve as it is.
 */
export function followEndFade(curve: readonly VolumePoint[], oldTotal: number, newTotal: number): VolumePoint[] {
  if (curve.length < 2) return curve.slice();
  if (!(Number.isFinite(oldTotal) && oldTotal > 0 && Number.isFinite(newTotal) && newTotal > 0)) return curve.slice();
  const delta = newTotal - oldTotal;
  const last = curve[curve.length - 1];
  if (delta === 0 || last.gain !== 0 || Math.abs(last.t - oldTotal) > 1 / 60) return curve.slice();
  const before = curve[curve.length - 2];
  const third = curve[curve.length - 3];
  const moved = before.t + delta;
  if (moved < 0 || (third && moved < third.t + MIN_POINT_GAP_SEC)) return curve.slice();
  return [...curve.slice(0, -2), { t: moved, gain: before.gain }, { t: last.t + delta, gain: last.gain }];
}

/** Flat at 0 dB. */
export function flat(): VolumePoint[] {
  return [];
}

/** 20·log10(g); −Infinity at 0. */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

/** 10^(db/20); 0 for −Infinity. */
export function dbToGain(db: number): number {
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

/** "0.0 dB", "−6.0 dB" (U+2212), "−∞ dB". */
export function formatDb(gain: number): string {
  const db = gainToDb(clamp01(gain));
  if (db === -Infinity) return "−∞ dB";
  const tenths = Math.round(db * 10);
  if (tenths === 0) return "0.0 dB";
  return `−${(Math.abs(tenths) / 10).toFixed(1)} dB`;
}

/** The lane's guides, top to bottom. */
export const DB_GUIDES: readonly { db: number; label: string }[] = [
  { db: 0, label: "0 dB" },
  { db: -12, label: "−12" },
  { db: -Infinity, label: "−∞" },
];

export function sameCurve(a: readonly VolumePoint[], b: readonly VolumePoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.t - b[i].t) <= 1e-6 && Math.abs(p.gain - b[i].gain) <= 1e-6);
}
