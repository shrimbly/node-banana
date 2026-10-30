import { formatTimecode } from "./timecode";

/**
 * The timeline ruler's ticks for a zoom, in sequence seconds: labelled
 * majors far enough apart to read, and one unlabelled mark half-way between
 * each two (Index-Editor-Clip draws a label every 10 s and one mark at 5 s).
 * Pure.
 */

export interface RulerTicks {
  /** The labelled ticks. */
  majors: number[];
  /** One mark half-way between each two majors. */
  minors: number[];
  /** One per major. */
  labels: Array<{ t: number; text: string }>;
}

const STEPS = [0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;
/** The least room between steps. 56 keeps 1 s steps at Fit on a 1440px window (≈ 63 px/s). */
const MIN_MAJOR_PX = 56;
/** A step under a second needs this much room, so 120 px/s keeps whole seconds. */
const MIN_SUBSECOND_PX = 100;
/** From this much room between steps a label goes on every step; below it, on every second one. */
const ROOMY_MAJOR_PX = 100;
/** Guards the float steps: 0.1 + 0.2 must still land on a tick. */
const EPS = 1e-6;

export function majorStep(pxPerSec: number): number {
  return STEPS.find((step) => step * pxPerSec >= (step < 1 ? MIN_SUBSECOND_PX : MIN_MAJOR_PX)) ?? STEPS[STEPS.length - 1];
}

/**
 * step = the smallest in [0.25, 0.5, 1, 2, 5, 10, 30, 60] with step·pps >= 56 (>= 100 for a step under a second);
 * majors (each labelled) every step if step·pps >= 100, else every second step (from 0:00);
 * one minor half-way between each two majors;
 * label digits: 2 below a half-second step, 1 if pps >= 100 or step < 1, else 0.
 * At 64 px/s: majors "0:00", "0:02", … with a minor at each odd second. At 120 px/s: "0:04.0" every second, a minor
 * at each half. At 19 px/s (the boards): a label every 10 s, a minor at 5 s.
 */
export function rulerTicks(pxPerSec: number, fromSec: number, toSec: number): RulerTicks {
  const majors: number[] = [];
  const minors: number[] = [];
  const labels: Array<{ t: number; text: string }> = [];
  if (!(pxPerSec > 0) || !Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) {
    return { majors, minors, labels };
  }
  const step = majorStep(pxPerSec);
  const every = step * pxPerSec >= ROOMY_MAJOR_PX ? step : step * 2;
  const digits: 0 | 1 | 2 = step < 0.5 ? 2 : pxPerSec >= 100 || step < 1 ? 1 : 0;
  const inRange = (t: number) => t >= fromSec - EPS && t <= toSec + EPS;

  const first = Math.max(0, Math.floor(fromSec / every - EPS));
  const last = Math.ceil(toSec / every + EPS);
  for (let i = first; i <= last; i++) {
    const t = i * every;
    if (inRange(t)) {
      majors.push(t);
      labels.push({ t, text: formatTimecode(t, digits) });
    }
    if (inRange(t + every / 2)) minors.push(t + every / 2);
  }
  return { majors, minors, labels };
}
