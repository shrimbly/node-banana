/**
 * What the GPU canvas measures about itself: frame times and the scene's
 * JavaScript per frame, input latency (from the event to the frame that drew
 * it), and the painter's timings. Exposed on window.__gpuCanvas for runners,
 * and read by the performance overlay.
 */

const MAX_SAMPLES = 4096;
const LONG_FRAME_MS = 250;
/** Long animation frames over this are kept (the 50 longest): a missed vsync at 120 Hz is far below LONG_FRAME_MS. */
const LOAF_MS = 50;

export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}

export interface LongAnimationFrame {
  at: number;
  ms: number;
  blockingMs: number;
  /** From the frame's rendering start, and its style and layout start, to its end. */
  renderMs: number;
  layoutMs: number;
  phase: string;
  /** The slowest scripts; `layoutMs` is style and layout they forced, `pauseMs` time they waited synchronously. */
  scripts: { ms: number; invoker: string; fn: string; at: string; layoutMs: number; pauseMs: number }[];
}

/** PerformanceLongAnimationFrameTiming, which the DOM types do not have yet. */
interface LoafEntry {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: { duration: number; invoker: string; sourceFunctionName: string; sourceURL: string; sourceCharPosition: number; forcedStyleAndLayoutDuration?: number; pauseDuration?: number }[];
}

export class GpuCanvasStats {
  /** Named samples in ms (painter.batchMs, input.latencyMs, …), newest last. */
  readonly samples: Record<string, number[]> = {};
  frameTimes: number[] = [];
  jsMs: number[] = [];
  /** What the canvas was doing (set by the painter), for naming a long frame. */
  phase = "idle";
  /** Frames over LONG_FRAME_MS: how long, when, and the phase they ended in. */
  longFrames: { ms: number; at: number; phase: string }[] = [];
  /** The browser's 50 longest long-animation-frame entries over LOAF_MS: where the time went, and the slowest scripts. */
  loafs: LongAnimationFrame[] = [];
  /** Workflow store writes by the keys they changed (and node writes by node count), so a gesture that writes shows. */
  storeWrites: Record<string, number> = {};
  private observer?: PerformanceObserver;

  /** Starts recording long animation frames, where the browser reports them. */
  observeLongFrames() {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) return;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as LoafEntry[]) {
        if (entry.duration < LOAF_MS || (this.loafs.length >= 50 && entry.duration <= this.loafs[this.loafs.length - 1].ms)) continue;
        this.loafs.push({
          at: Math.round(entry.startTime), ms: Math.round(entry.duration), blockingMs: Math.round(entry.blockingDuration ?? 0),
          renderMs: entry.renderStart ? Math.round(entry.startTime + entry.duration - entry.renderStart) : 0,
          layoutMs: Math.round(entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0),
          phase: this.phase,
          scripts: [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => ({
            ms: Math.round(s.duration), invoker: s.invoker, fn: s.sourceFunctionName, at: `${s.sourceURL}:${s.sourceCharPosition}`,
            layoutMs: Math.round(s.forcedStyleAndLayoutDuration ?? 0), pauseMs: Math.round(s.pauseDuration ?? 0),
          })),
        });
        this.loafs.sort((a, b) => b.ms - a.ms);
        this.loafs.length = Math.min(this.loafs.length, 50);
      }
    });
    this.observer.observe({ type: "long-animation-frame", buffered: false });
  }

  dispose() {
    this.observer?.disconnect();
  }

  record(name: string, value: number) {
    const list = (this.samples[name] ??= []);
    list.push(value);
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES / 2);
  }

  frame(now: number, jsMs: number) {
    const last = this.frameTimes.at(-1);
    if (last != null && now - last > LONG_FRAME_MS && this.longFrames.length < 50) {
      this.longFrames.push({ ms: Math.round(now - last), at: Math.round(now), phase: this.phase });
    }
    this.frameTimes.push(now);
    this.jsMs.push(jsMs);
    if (this.frameTimes.length > MAX_SAMPLES * 3) {
      this.frameTimes = this.frameTimes.slice(-MAX_SAMPLES);
      this.jsMs = this.jsMs.slice(-MAX_SAMPLES);
    }
  }

  /** Clears samples and frames, for a runner starting a measurement. */
  reset() {
    for (const key of Object.keys(this.samples)) delete this.samples[key];
    this.frameTimes = [];
    this.jsMs = [];
    this.longFrames = [];
    this.loafs = [];
    this.storeWrites = {};
  }

  /** Counts a store write under its name. */
  storeWrite(name: string) {
    this.storeWrites[name] = (this.storeWrites[name] ?? 0) + 1;
  }

  summary() {
    const intervals = this.frameTimes.slice(1).map((t, i) => t - this.frameTimes[i]);
    const seconds = this.frameTimes.length > 1 ? (this.frameTimes.at(-1)! - this.frameTimes[0]) / 1000 : 0;
    return {
      fps: seconds ? Math.round(((this.frameTimes.length - 1) / seconds) * 10) / 10 : 0,
      frameMs: percentiles(intervals),
      jsMs: percentiles(this.jsMs),
      longFrames: this.longFrames,
      loafs: this.loafs,
      storeWrites: this.storeWrites,
      samples: Object.fromEntries(Object.entries(this.samples).map(([name, values]) => [name, percentiles(values)])),
    };
  }
}
