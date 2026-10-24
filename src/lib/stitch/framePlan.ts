import type { StitchSequenceLayout, StitchTimelineClip } from "@/types";
import type { ClipReaderWindow } from "./clipReader";
import type { StitchOptions } from "./engineTypes";
import { envelopeAt, TIME_EPS, type StackEnvelope } from "./placement";
import { pictureSegments, readerRange, segmentSlots, unitSlots, visibilityRuns, type Segment } from "./placedSchedule";
import { planPicture, type PicturePlan } from "./picturePlan";
import { FRAME_RATE, secToSlot } from "./sequencePlan";
import { dissolveFrames, sharedCadence, soloPass } from "./stack";
import {
  layersAt,
  placedLayersAt,
  sourceKey,
  spanAtTime,
  type ClipSpan,
  type SourceDurations,
  type SourceKey,
} from "./timeline";

/**
 * Frame to canvas: which output slot the playhead means, and what Render
 * writes on it (the clips, the source frame each one reads, their weights).
 * The clips are the ones the preview shows; how each looks is Render's rule.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds; slots are 1/60 s.
 */

/** One clip that can play, in timeline order. */
export interface FrameClip {
  clipId: string;
  source: SourceKey;
  inSec: number;
  outSec: number | null;
  /** The source's measured duration. */
  duration: number;
  /** Only when the stack is placed (stitchInputs' rule). */
  startSec?: number;
}

/** What the encode reads from a source when it opens it (probeClip). */
export interface FrameSourceFacts {
  firstTimestamp: number;
  frameRate: number | null;
}

export const EMPTY_FACTS: ReadonlyMap<SourceKey, FrameSourceFacts> = new Map();

/**
 * The executor's StitchOptions for this draft, at loopCount 1: placed → { overlapSec, crossfade, placed: true };
 * stacked with overlapSec > 0 → { overlapSec, crossfade }; else none.
 */
export function frameOptions(layout: StitchSequenceLayout, timeline: readonly StitchTimelineClip[]): StitchOptions {
  if (layout.mode !== "stacked") return { loopCount: 1 };
  if (timeline.some((clip) => typeof clip.startSec === "number" && Number.isFinite(clip.startSec))) {
    return { loopCount: 1, overlapSec: layout.overlapSec, crossfade: layout.crossfade, placed: true };
  }
  return layout.overlapSec > 0 ? { loopCount: 1, overlapSec: layout.overlapSec, crossfade: layout.crossfade } : { loopCount: 1 };
}

/** Timeline order; a clip with no src or no measured duration is left out (the encode drops or refuses it). */
export function frameClips(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  srcOf: (clipId: string) => string | null,
  placed: boolean,
): FrameClip[] {
  return timeline.flatMap((clip): FrameClip[] => {
    const source = sourceKey(clip.source);
    const duration = durations.get(source);
    if (!srcOf(clip.id) || duration === undefined || !(duration > 0)) return [];
    return [
      {
        clipId: clip.id,
        source,
        inSec: clip.inSec,
        outSec: clip.outSec,
        duration,
        ...(placed && clip.startSec !== undefined ? { startSec: clip.startSec } : {}),
      },
    ];
  });
}

/** secToSlot(t), clamped to [0, max(0, secToSlot(loopLength) − 1)]. */
export function frameSlot(t: number, loopLength: number): number {
  const last = Math.max(0, secToSlot(Number.isFinite(loopLength) ? loopLength : 0) - 1);
  const slot = Number.isFinite(t) ? secToSlot(t) : 0;
  return Math.min(Math.max(slot, 0), last);
}

/**
 * The clip ids the preview shows at t, at opacity > 0, by the preview's own rule for the layout: Track (stack null)
 * spanAtTime; lined up layersAt; placed placedLayersAt. Empty in a gap or with no non-empty span.
 */
export function shownAt(
  spans: readonly ClipSpan[],
  t: number,
  stack: { crossfade: boolean; placed: boolean } | null,
): ReadonlySet<string> {
  if (!stack) {
    const span = spanAtTime(spans, t);
    return new Set(span ? [span.clip.id] : []);
  }
  const layers = stack.placed ? placedLayersAt(spans, t, stack.crossfade) : layersAt(spans, t, stack.crossfade);
  return new Set(layers.filter((layer) => layer.opacity > 0).map((layer) => layer.span.clip.id));
}

export type FrameRead =
  /** A ClipReader over `range` with `window`, asked for the frame on `slot`. */
  | { by: "slot"; slot: number; range: { from: number; to: number }; window: ClipReaderWindow; inSec: number }
  /** The frame in effect at `time` (a dissolve's lookup). */
  | { by: "time"; time: number };

export interface FrameLayer {
  /** The picture plan's unit. */
  unit: number;
  clipId: string;
  source: SourceKey;
  read: FrameRead;
  /** >= 0; a plan's weights sum to 1. */
  weight: number;
  /** Track and lined-up solo: what Render holds on this slot when the read gives no frame (the unit before). */
  held?: Omit<FrameLayer, "held" | "weight">;
}

export interface FramePlan {
  slot: number;
  route: PicturePlan["route"]["kind"];
  /**
   * Distinct source keys the layers read, bottom first: the sources to open. A held read's source is not among them
   * unless a layer reads it too; it is opened only when the layer's own read gives no frame.
   */
  sources: SourceKey[];
  show: { kind: "none" } | { kind: "black" } | { kind: "layers"; layers: FrameLayer[] };
}

/** Clip ids of a plan's layers with weight > 0; empty for "none" and "black". */
export function visibleClipIds(plan: FramePlan): ReadonlySet<string> {
  if (plan.show.kind !== "layers") return new Set();
  return new Set(plan.show.layers.filter((layer) => layer.weight > 0).map((layer) => layer.clipId));
}

const factsOf = (facts: ReadonlyMap<SourceKey, FrameSourceFacts>, source: SourceKey): FrameSourceFacts =>
  facts.get(source) ?? { firstTimestamp: 0, frameRate: null };

function picture(
  clips: readonly FrameClip[],
  options: StitchOptions,
  facts: ReadonlyMap<SourceKey, FrameSourceFacts>,
): PicturePlan {
  return planPicture(
    clips.map((clip) => ({
      inSec: clip.inSec,
      outSec: clip.outSec,
      sourceDuration: clip.duration,
      firstTimestamp: factsOf(facts, clip.source).firstTimestamp,
      source: clip.source,
      startSec: clip.startSec,
    })),
    options,
  );
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/**
 * The slot the playhead means: frameSlot(t), or one before it when the clips Render shows there (planned before any
 * source is opened) are not the ones the preview shows. secToSlot rounds half up, so within half a slot of a join or
 * a gap the slot already belongs to what comes next; the preview never runs ahead of it, so one step is enough.
 */
export function chooseFrameSlot(
  clips: readonly FrameClip[],
  options: StitchOptions,
  t: number,
  shown: ReadonlySet<string>,
): number {
  const n = frameSlot(t, picture(clips, options, EMPTY_FACTS).loopLength);
  if (n > 0 && !sameSet(visibleClipIds(planFrameAt(clips, options, n, EMPTY_FACTS)), shown)) return n - 1;
  return n;
}

/** The plan for one slot. Facts missing for a source read as { firstTimestamp: 0, frameRate: null }. */
export function planFrameAt(
  clips: readonly FrameClip[],
  options: StitchOptions,
  slot: number,
  facts: ReadonlyMap<SourceKey, FrameSourceFacts>,
): FramePlan {
  const p = picture(clips, options, facts);
  const n = slot;
  const route = p.route.kind;
  const plan = (show: FramePlan["show"]): FramePlan => {
    const sources: SourceKey[] = [];
    const add = (source: SourceKey) => {
      if (!sources.includes(source)) sources.push(source);
    };
    if (show.kind === "layers") {
      for (const layer of show.layers) add(layer.source);
    }
    return { slot: n, route, sources, show };
  };
  if (p.planned.length === 0) return plan({ kind: "none" });

  const clipOf = (unit: number) => clips[p.planned[unit].index];
  /**
   * A unit read by Track's rules: its frames from `origin` on fill the slots [anchorSlot, endSlot). Past the window
   * the frame is its last one, so the read asks for that slot instead of decoding beyond it.
   */
  const slotRead = (unit: number, slotAt: number, window: ClipReaderWindow, inSec: number): Omit<FrameLayer, "held" | "weight"> => {
    const planned = p.planned[unit];
    const clip = clipOf(unit);
    const at = Math.min(slotAt, window.endSlot - 1);
    return {
      unit,
      clipId: clip.clipId,
      source: clip.source,
      read: {
        by: "slot",
        slot: at,
        range: readerRange({ inSec, outSec: planned.outSec, origin: window.origin }, window.anchorSlot, { n0: at, n1: at + 1 }),
        window,
        inSec,
      },
    };
  };
  const timeRead = (unit: number, time: number, weight: number): FrameLayer => {
    const clip = clipOf(unit);
    return { unit, clipId: clip.clipId, source: clip.source, read: { by: "time", time }, weight };
  };
  const solo = (read: Omit<FrameLayer, "held" | "weight">, held?: Omit<FrameLayer, "held" | "weight">): FramePlan =>
    plan({ kind: "layers", layers: [{ ...read, weight: 1, ...(held ? { held } : {}) }] });

  if (p.env) return planPlaced(p, p.env, n, plan, slotRead);

  if (!p.sp) {
    // Track
    const trackRead = (unit: number) => {
      const planned = p.planned[unit];
      const anchorSlot = secToSlot(planned.seqStart);
      const endSlot = secToSlot(planned.seqStart + planned.length);
      return slotRead(unit, n, { origin: planned.origin, anchorSlot, endSlot, fps: FRAME_RATE }, planned.inSec);
    };
    const k = p.planned.findIndex(
      (planned) => secToSlot(planned.seqStart) <= n && n < secToSlot(planned.seqStart + planned.length),
    );
    if (k === -1) return plan({ kind: "none" });
    return solo(trackRead(k), k > 0 ? trackRead(k - 1) : undefined);
  }

  // A lined-up stack
  const sp = p.sp;
  const soloRead = (unit: number) => {
    const clip = sp.clips[unit];
    const pass = soloPass(clip, 0, FRAME_RATE);
    if (!pass) return null;
    const window = { origin: clip.soloOrigin, anchorSlot: secToSlot(pass.fromSec), endSlot: secToSlot(pass.toSec), fps: FRAME_RATE };
    return { read: slotRead(unit, n, window, pass.decodeFrom), window };
  };
  for (const d of sp.dissolves) {
    if (!(secToSlot(d.fromSec) <= n && n < secToSlot(d.toSec))) continue;
    const cadence = sharedCadence(
      factsOf(facts, clipOf(d.outgoing).source),
      factsOf(facts, clipOf(d.incoming).source),
    );
    const f = dissolveFrames(sp, d, 0, { fps: FRAME_RATE, cadence });
    let i = -1;
    f.slots.forEach((written, j) => {
      if (written <= n) i = j;
    });
    if (i >= 0) {
      return plan({
        kind: "layers",
        layers: [timeRead(d.outgoing, f.outgoingTimes[i], 1 - f.alphas[i]), timeRead(d.incoming, f.incomingTimes[i], f.alphas[i])],
      });
    }
    // Before the dissolve's first frame Render still holds the outgoing clip's last solo frame
    const before = soloRead(d.outgoing);
    return before ? solo(before.read) : plan({ kind: "none" });
  }
  for (let k = 0; k < sp.clips.length; k++) {
    const own = soloRead(k);
    if (!own || !(own.window.anchorSlot <= n && n < own.window.endSlot)) continue;
    return solo(own.read, k > 0 ? soloRead(k - 1)?.read : undefined);
  }
  return plan({ kind: "none" });
}

/** The placed branch: the segment Render writes slot n in, and its units read as encodePlacedLoop reads them. */
function planPlaced(
  p: PicturePlan,
  env: StackEnvelope,
  n: number,
  plan: (show: FramePlan["show"]) => FramePlan,
  slotRead: (unit: number, at: number, window: ClipReaderWindow, inSec: number) => Omit<FrameLayer, "held" | "weight">,
): FramePlan {
  const segments = pictureSegments(env);
  const withSlots = segments
    .map((segment) => ({ segment, ...segmentSlots(segment, 0) }))
    .filter(({ n0, n1 }) => n1 > n0);
  // A black under a slot is not written: the frame before it holds
  const found =
    withSlots.find(({ n0, n1 }) => n0 <= n && n < n1) ??
    withSlots.filter(({ n1 }) => n1 <= n).pop();
  if (!found) return plan({ kind: "none" });
  const { segment, n0, n1 } = found;
  if (segment.kind === "black") return plan({ kind: "black" });

  const at = Math.min(n, n1 - 1);
  const runs = visibilityRuns(segments, env.units.length, 0);
  const read = (unit: number) => {
    const planned = p.planned[unit];
    const slots = unitSlots(env, unit, 0, FRAME_RATE);
    const run = runs[unit]?.find((r) => r.n0 <= n0 && n0 < r.n1) ?? { n0, n1 };
    return slotRead(
      unit,
      at,
      { origin: planned.origin, anchorSlot: slots.anchor, endSlot: Math.min(run.n1, slots.end), fps: FRAME_RATE },
      planned.inSec,
    );
  };
  if (segment.kind === "solo") return plan({ kind: "layers", layers: [{ ...read(segment.unit), weight: 1 }] });
  return plan({ kind: "layers", layers: blendWeights(env, segment, at).map(({ unit, weight }) => ({ ...read(unit), weight })) });
}

/** A blend's weights at the middle of slot `at`, kept inside the segment, renormalised; a zero sum gives the bottom 1. */
function blendWeights(
  env: StackEnvelope,
  segment: Extract<Segment, { kind: "blend" }>,
  at: number,
): Array<{ unit: number; weight: number }> {
  const t = Math.min(Math.max((at + 0.5) / FRAME_RATE, segment.fromSec), segment.toSec - 2 * TIME_EPS);
  const weights = new Map(envelopeAt(env, t).map((layer) => [layer.unit, layer.weight]));
  const raw = segment.units.map((unit) => {
    const w = weights.get(unit) ?? 0;
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const sum = raw.reduce((total, w) => total + w, 0);
  return segment.units.map((unit, k) => ({ unit, weight: sum > 0 ? raw[k] / sum : k === 0 ? 1 : 0 }));
}
