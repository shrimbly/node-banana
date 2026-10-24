import type { VolumePoint } from "@/types";
import { gainAt, gainToLevel, levelToGain } from "./curve";
import type { TimeAxis } from "./timeAxis";

/**
 * Where the music's volume curve is drawn in the audio lane, and what a
 * pointer there means. y runs down from the audio block's top: 0 dB at
 * `top`, −∞ at `top + span`, linear in display level (curve.ts), so the
 * straight segments drawn between vertices are exactly what is heard.
 * x is the lane's own (TimeAxis.timeToX), slots included: the line runs
 * flat across a clip with no length, which takes no time.
 *
 * Pure: no React, no DOM.
 */

export interface CurveMetrics {
  /** y of 0 dB, relative to the audio block's top. */
  top: number;
  /** Pixels from 0 dB down to −∞. */
  span: number;
}

/** The 44px block of a collapsed row: 0 dB 6px under its top, silence 4px over its foot. */
export const COLLAPSED_CURVE: CurveMetrics = { top: 6, span: 34 };
/** The 120px block of the row whose volume curve is open. */
export const EXPANDED_CURVE: CurveMetrics = { top: 16, span: 90 };

export interface CurveVertex {
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function levelToY(level: number, m: CurveMetrics): number {
  return m.top + clamp(Number.isFinite(level) ? level : 0, 0, 1) * m.span;
}

/** Clamped to 0..1: a pointer above the line's top is 0 dB, below its floor −∞. */
export function yToLevel(y: number, m: CurveMetrics): number {
  if (!Number.isFinite(y) || !(m.span > 0)) return 0;
  return clamp((y - m.top) / m.span, 0, 1);
}

/**
 * The part of a curve a lane draws, in the curve's own clock: [from, to], drawn at sequence time t − offset (an audio
 * clip's curve is in its source seconds: offset = In − start). The music's curve over one loop is
 * { offset: 0, from: 0, to: sequenceSec }.
 */
export interface CurveWindow {
  offset: number;
  from: number;
  to: number;
}

/**
 * Vertices at the window's start, at each point inside it, at each slot's entry and exit (a flat run across the
 * slot), and at its end, in order. Points outside the window are not drawn, but they still shape the line up to its
 * ends (the end vertices read gainAt there). The window defaults to [0, sequenceSec].
 */
export function curvePolyline(
  curve: readonly VolumePoint[],
  sequenceSec: number,
  axis: Pick<TimeAxis, "timeToX" | "slots">,
  m: CurveMetrics,
  window: CurveWindow = { offset: 0, from: 0, to: sequenceSec },
): CurveVertex[] {
  const { offset, from, to } = window;
  if (!(to > from) || !Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(offset)) return [];
  const yAt = (t: number) => levelToY(gainToLevel(gainAt(curve, t)), m);
  const xAt = (t: number) => axis.timeToX(t - offset);
  const vertices: CurveVertex[] = [{ x: xAt(from), y: yAt(from) }];
  const inside = curve.filter((p) => p.t > from && p.t < to);
  // A slot sits at one instant: its entry is timeToX(t), its exit that plus its width
  const slots = axis.slots.filter((s) => s.t + offset >= from && s.t + offset < to);
  let p = 0;
  for (const slot of slots) {
    while (p < inside.length && inside[p].t <= slot.t + offset) {
      vertices.push({ x: xAt(inside[p].t), y: levelToY(gainToLevel(inside[p].gain), m) });
      p++;
    }
    const y = yAt(slot.t + offset);
    vertices.push({ x: slot.x, y }, { x: slot.x + slot.width, y });
  }
  for (; p < inside.length; p++) {
    vertices.push({ x: xAt(inside[p].t), y: levelToY(gainToLevel(inside[p].gain), m) });
  }
  vertices.push({ x: xAt(to), y: yAt(to) });
  return vertices;
}

/** The shortest distance from p to the polyline's segments; Infinity for no vertices. */
export function distanceToPolyline(p: CurveVertex, poly: readonly CurveVertex[]): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const u = lengthSq === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0, 1);
    best = Math.min(best, Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy)));
  }
  return best;
}

/**
 * The point a pointer at (x, y) means: t = clamp(xToTime(x) + offset, from, to), gain = levelToGain(yToLevel(y)). The
 * window defaults to [0, sequenceSec].
 */
export function pointerToPoint(
  x: number,
  y: number,
  axis: Pick<TimeAxis, "xToTime">,
  m: CurveMetrics,
  sequenceSec: number,
  window?: CurveWindow,
): VolumePoint {
  const end = Number.isFinite(sequenceSec) && sequenceSec > 0 ? sequenceSec : 0;
  const { offset, from, to } = window ?? { offset: 0, from: 0, to: end };
  const t = axis.xToTime(x) + offset;
  return { t: clamp(Number.isFinite(t) ? t : from, from, Math.max(from, to)), gain: levelToGain(yToLevel(y, m)) };
}
