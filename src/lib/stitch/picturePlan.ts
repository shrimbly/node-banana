import { normalizePlacement, normalizeStack, type StitchOptions } from "./engineTypes";
import { buildEnvelope, type StackEnvelope } from "./placement";
import { routePlacement, type StitchRoute } from "./placedSchedule";
import { planSequence, type PlanClip, type PlannedClip } from "./sequencePlan";
import { stackSequence, type StackedPlan } from "./stack";

/**
 * Where a sequence's picture comes from: which clips play, the branch the
 * encoder takes, and that branch's plan for one loop. stitchVideosAsync and
 * Frame to canvas both read it from here, so the frame is planned as Render
 * plans it.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds.
 */

export interface PictureClip extends PlanClip {
  /** The timeline's source key; absent for legacy nodes (then `#${index}`). */
  source?: string;
  /** Stacked, placed: where this clip starts in one loop, seconds. */
  startSec?: number;
}

export interface PicturePlan {
  /** planSequence's clips: unit k is planned[k]. A clip with sourceDuration 0 (no video) is not among them. */
  planned: PlannedClip[];
  /** Per unit: its clip's source key, or `#${index}`. */
  sources: string[];
  route: StitchRoute;
  /** The lined-up stack's plan; null unless the route is derived and some join really overlaps. */
  sp: StackedPlan | null;
  /** Placed: the envelope, unit k on row k. */
  env: StackEnvelope | null;
  loopLength: number;
}

export function planPicture(clips: readonly PictureClip[], options: StitchOptions | undefined): PicturePlan {
  const stack = normalizeStack(options);
  const plan = planSequence(clips);
  const planned = plan.clips;
  const sources = planned.map((unit) => clips[unit.index].source ?? `#${unit.index}`);
  const placement = normalizePlacement(options);
  // A placed node whose clips sit where Track or a lined-up stack puts them encodes as that branch, byte for byte
  const route = routePlacement(
    planned,
    sources,
    planned.map((unit) => clips[unit.index].startSec),
    placement,
    stack,
  );
  // Stacked only when some join really overlaps: a stack of cuts is Track, call for call
  let sp: StackedPlan | null = stack && route.kind === "derived" ? stackSequence(planned, sources, stack) : null;
  if (sp && !sp.clips.some((clip) => clip.overlapIn > 0)) sp = null;
  // Placed: unit k is the envelope's unit k (every planned clip is non-empty, and rows follow the clip order)
  const env: StackEnvelope | null =
    route.kind === "placed"
      ? buildEnvelope(
          planned.map((unit, k) => ({
            start: route.starts[k],
            length: unit.length,
            row: k,
            source: sources[k],
            inSec: unit.inSec,
          })),
          placement?.crossfade ?? true,
        )
      : null;
  const loopLength = env ? env.loopLength : sp ? sp.loopLength : plan.loopLength;
  return { planned, sources, route, sp, env, loopLength };
}
