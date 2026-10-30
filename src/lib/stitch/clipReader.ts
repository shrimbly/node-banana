import { EncodedPacketSink, VideoSampleSink } from "mediabunny";
import type { InputVideoTrack, VideoSample } from "mediabunny";
import type { BlenderRef, FrameBlender } from "./crossfadeFrames";
import { envelopeAt, TIME_EPS, type StackEnvelope } from "./placement";
import {
  nextBlendSlot,
  readerRange,
  readerStart,
  segmentSlots,
  unitSlots,
  visibilityRuns,
  type Segment,
} from "./placedSchedule";
import { FRAME_RATE, secToSlot } from "./sequencePlan";
import { MIN_CADENCE_RATE } from "./stack";
import { formatTimecode } from "./timecode";

/**
 * The placed Stacked encode's picture: one decoder per clip per stretch it is
 * visible in, each answering "the frame on slot n" on the 60 fps grid, and the
 * walk that writes one loop's segments (black, a clip's own frames, blends)
 * to the encoder. Runs in the page (mediabunny); what each segment shows comes
 * from placedSchedule.ts.
 */

export interface ClipReaderWindow {
  /** max(In, the track's first timestamp): where the clip's frames start counting. */
  origin: number;
  /** S_u: the slot the origin lands on in this loop (Track's begin() mapping). */
  anchorSlot: number;
  /** Frames on this slot or later are not counted: the run's end, or the clip's own end when that comes first. */
  endSlot: number;
  fps?: number;
}

interface Counted {
  sample: VideoSample;
  slot: number;
}

/**
 * Frames of one decoder placed on the slot grid by Track's rules, so a clip shown alone writes what Track writes: a
 * frame at source time ts lands on anchorSlot + secToSlot(max(0, ts − origin)); in decode order, a frame on a slot no
 * later than the last one kept is dropped; the last frame before origin is held and takes anchorSlot only when no
 * kept frame lands there. The frame on slot n is the kept frame with the largest slot <= n.
 */
export class ClipReader {
  private readonly fps: number;
  private current: Counted | null = null;
  private lookahead: Counted | null = null;
  private fetched = false;
  private ended = false;
  private closed = false;
  private heldBefore: VideoSample | null = null;
  private pending: VideoSample | null = null;
  private lastSlot = -Infinity;

  constructor(
    private readonly frames: AsyncIterator<VideoSample, void, unknown>,
    private readonly window: ClipReaderWindow,
  ) {
    this.fps = window.fps ?? FRAME_RATE;
  }

  private countable(slot: number): boolean {
    return slot > this.lastSlot && slot < this.window.endSlot;
  }

  private keep(sample: VideoSample, slot: number): Counted {
    this.lastSlot = slot;
    return { sample, slot };
  }

  private async nextCounted(): Promise<Counted | null> {
    const { origin, anchorSlot, endSlot } = this.window;
    for (;;) {
      let sample: VideoSample;
      if (this.pending) {
        sample = this.pending;
        this.pending = null;
      } else {
        if (this.ended) return null;
        const next = await this.frames.next();
        if (next.done) {
          this.ended = true;
          const held = this.heldBefore;
          this.heldBefore = null;
          if (held && this.countable(anchorSlot)) return this.keep(held, anchorSlot);
          held?.close();
          return null;
        }
        sample = next.value;
      }
      const timestamp = sample.timestamp ?? 0;
      if (timestamp < origin) {
        this.heldBefore?.close();
        this.heldBefore = sample;
        continue;
      }
      const slot = anchorSlot + secToSlot(Number.isFinite(timestamp) ? Math.max(0, timestamp - origin) : 0, this.fps);
      if (this.heldBefore) {
        const held = this.heldBefore;
        this.heldBefore = null;
        // A frame the trim cut away must not push out the first one it kept
        if (slot !== anchorSlot && this.countable(anchorSlot)) {
          this.pending = sample;
          return this.keep(held, anchorSlot);
        }
        held.close();
      }
      if (slot >= endSlot) {
        sample.close();
        this.ended = true;
        return null;
      }
      if (slot <= this.lastSlot) {
        sample.close();
        continue;
      }
      return this.keep(sample, slot);
    }
  }

  private async fill(): Promise<void> {
    if (this.fetched) return;
    this.lookahead = await this.nextCounted();
    this.fetched = true;
  }

  /** The frame on slot n (the reader keeps it; null before its first frame). Advances, closing the frames it passes. */
  async frameOn(n: number): Promise<VideoSample | null> {
    await this.fill();
    while (this.lookahead && this.lookahead.slot <= n) {
      this.current?.sample.close();
      this.current = this.lookahead;
      this.lookahead = await this.nextCounted();
    }
    return this.current && this.current.slot <= n ? this.current.sample : null;
  }

  /** The next slot on which the frame changes; Infinity at the end. */
  async nextChangeSlot(): Promise<number> {
    await this.fill();
    return this.lookahead ? this.lookahead.slot : Infinity;
  }

  /** The first frame the reader has, without passing it: the encode's reference when a loop opens on black or a blend. */
  async firstFrame(): Promise<VideoSample | null> {
    await this.fill();
    return this.current?.sample ?? this.lookahead?.sample ?? null;
  }

  /**
   * Writes [n0, n1) straight through: the frame in effect on n0, then each frame that lands in the range, each as a clone
   * at slot / fps lasting one slot, closed after write. The reader keeps the originals (a blend may follow). Nothing
   * when n0 >= n1.
   */
  async passThrough(n0: number, n1: number, write: (sample: VideoSample, slot: number) => Promise<void>): Promise<void> {
    if (!(n0 < n1)) return;
    let slot = n0;
    let sample = await this.frameOn(n0);
    for (;;) {
      if (sample) {
        const copy = sample.clone();
        try {
          copy.setTimestamp(slot / this.fps);
          copy.setDuration(1 / this.fps);
          await write(copy, slot);
        } finally {
          copy.close();
        }
      }
      const next = await this.nextChangeSlot();
      if (next >= n1) return;
      slot = next;
      sample = await this.frameOn(next);
    }
  }

  /** Closes every frame it holds and awaits the decoder's return(), which closes what it still queues. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sample of [this.current?.sample, this.lookahead?.sample, this.heldBefore, this.pending]) sample?.close();
    this.current = null;
    this.lookahead = null;
    this.heldBefore = null;
    this.pending = null;
    try {
      await this.frames.return?.(undefined);
    } catch (error) {
      console.warn("[VideoStitch] Failed to stop a clip decoder", error);
    }
  }
}

/**
 * The frames a reader counts over range: from In, the range itself; opened partway into the clip, first the timestamp
 * of the frame in effect at range.from (inEffectAt; null or a failure leaves the range as it is), then the frames from
 * readerStart's earlier start. Lazy: nothing is asked of the source before the reader's first frame.
 */
export async function* readerFrames(
  range: { from: number; to: number },
  window: ClipReaderWindow,
  inSec: number,
  inEffectAt: (sec: number) => Promise<number | null>,
  samples: (from: number, to: number) => AsyncIterable<VideoSample>,
): AsyncGenerator<VideoSample, void, unknown> {
  let from = range.from;
  if (from > inSec) {
    let inEffect: number | null = null;
    try {
      inEffect = await inEffectAt(from);
    } catch {
      inEffect = null;
    }
    from = readerStart(from, inEffect, { inSec, origin: window.origin }, window.anchorSlot, window.fps ?? FRAME_RATE);
  }
  yield* samples(from, range.to);
}

/** A reader over new VideoSampleSink(track).samples(…), from where readerFrames starts it. */
export function openClipReader(
  track: InputVideoTrack,
  range: { from: number; to: number },
  window: ClipReaderWindow,
  inSec: number,
): ClipReader {
  const sink = new VideoSampleSink(track);
  const inEffectAt = async (sec: number) =>
    (await new EncodedPacketSink(track).getPacket(sec, { metadataOnly: true }))?.timestamp ?? null;
  return new ClipReader(readerFrames(range, window, inSec, inEffectAt, (from, to) => sink.samples(from, to)), window);
}

/** One placed clip, as the walk reads it. */
export interface PlacedClipSource {
  inSec: number;
  outSec: number;
  origin: number;
  /** Frames per second; null when unknown (its blends then write every slot). */
  frameRate: number | null;
  open(range: { from: number; to: number }, window: ClipReaderWindow): ClipReader;
}

/** What one encode keeps across loops. */
export interface PlacedEncodeState {
  /** The encode's reference: the first frame added, or a peek at the first visible clip when loop 0 opens otherwise. */
  ref: BlenderRef | null;
  blender: FrameBlender | null;
  /** A frame has been handed to the encoder: the file's size and colour tags are set. */
  started?: boolean;
}

export interface PlacedLoopJob {
  env: StackEnvelope;
  /** segmentsInLoop(pictureSegments(env), loop). */
  segments: readonly Segment[];
  loop: number;
  /** Per envelope unit. */
  sources: readonly PlacedClipSource[];
  state: PlacedEncodeState;
  /** The reference when no frame can be read: the encode's size, no format (black is then RGBX). */
  fallbackRef: BlenderRef;
  makeBlender: (ref: BlenderRef) => FrameBlender;
  /** FrameSlotter.claim. */
  claim: (slot: number) => number | null;
  /** Hands a frame to the encoder; the caller closes it afterwards. */
  add: (sample: VideoSample) => Promise<void>;
  /** A segment is starting, or another 10 frames were written. */
  report?: (segment: Segment, slot: number) => void;
  /** The error a failure of this unit becomes (not an abort, not a blend of 3 or more). */
  failure: (unit: number, error: unknown) => Error;
  signal?: AbortSignal;
  fps?: number;
}

const refOf = (sample: VideoSample): BlenderRef => ({
  width: sample.codedWidth,
  height: sample.codedHeight,
  format: sample.format,
  colorSpace: sample.colorSpace,
});

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** A reader call that failed, with its unit. */
class ReaderFailure {
  constructor(
    readonly unit: number,
    readonly error: unknown,
  ) {}
}

/**
 * One loop of a placed stack. For each segment with slots [n0, n1): black claims n0 and writes one black frame; solo
 * passes its unit's frames through; a blend writes n0, then each slot on which a visible clip's frame changes (at least
 * every 3 slots; every slot while a clip runs below 10 fps or has no rate), each a composite weighted by the envelope
 * at the middle of the frame's display interval. Readers open at their visibility run's first segment and close after
 * its last, or in finally.
 */
export async function encodePlacedLoop(job: PlacedLoopJob): Promise<void> {
  const fps = job.fps ?? FRAME_RATE;
  const { env, segments, state } = job;
  const loopOffset = job.loop * env.loopLength;
  const runs = visibilityRuns(segments, env.units.length, loopOffset);
  const open = new Map<number, { reader: ClipReader; n1: number }>();

  const throwIfAborted = () => {
    if (job.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const readerFor = (unit: number, n0: number): ClipReader => {
    const held = open.get(unit);
    if (held) return held.reader;
    const run = runs[unit]?.find((r) => r.n0 <= n0 && n0 < r.n1);
    if (!run) throw new Error(`No visibility run for unit ${unit} at slot ${n0}`);
    const source = job.sources[unit];
    const slots = unitSlots(env, unit, loopOffset, fps);
    const reader = source.open(readerRange(source, slots.anchor, run, fps), {
      origin: source.origin,
      anchorSlot: slots.anchor,
      endSlot: Math.min(run.n1, slots.end),
      fps,
    });
    open.set(unit, { reader, n1: run.n1 });
    return reader;
  };
  /** Runs a reader call, tagging its failure with the unit. */
  const read = async <T>(unit: number, call: (reader: ClipReader) => Promise<T>, n0: number): Promise<T> => {
    try {
      return await call(readerFor(unit, n0));
    } catch (error) {
      throw isAbort(error) ? error : new ReaderFailure(unit, error);
    }
  };
  const blender = (): FrameBlender => {
    state.ref ??= job.fallbackRef;
    state.blender ??= job.makeBlender(state.ref);
    return state.blender;
  };
  const claim = (slot: number): number => {
    const timestamp = job.claim(slot);
    if (timestamp === null) throw new Error(`Slot ${slot} was written already`);
    return timestamp;
  };
  const add = async (sample: VideoSample) => {
    throwIfAborted();
    state.ref ??= refOf(sample);
    await job.add(sample);
    state.started = true;
  };

  try {
    const withSlots = segments.filter((segment) => {
      const { n0, n1 } = segmentSlots(segment, loopOffset);
      return n1 > n0;
    });
    // mediabunny takes the file's size and colour tags from the first frame: when that is not a clip's own, read one first
    const first = withSlots[0];
    if (!state.ref && first && first.kind !== "solo") {
      const visible = withSlots.find((segment) => segment.kind !== "black");
      if (visible) {
        const unit = visible.kind === "solo" ? visible.unit : visible.units[0];
        try {
          const frame = await read(unit, (reader) => reader.firstFrame(), segmentSlots(visible, loopOffset).n0);
          if (frame) state.ref = refOf(frame);
        } catch (error) {
          if (isAbort(error)) throw error;
          throw job.failure(unit, error instanceof ReaderFailure ? error.error : error);
        }
      }
    }

    for (const segment of withSlots) {
      const { n0, n1 } = segmentSlots(segment, loopOffset);
      job.report?.(segment, n0);
      try {
        if (segment.kind === "black") {
          throwIfAborted();
          const frame = blender().black(claim(n0), 1 / fps);
          try {
            await add(frame);
          } finally {
            frame.close();
          }
        } else if (segment.kind === "solo") {
          let written = 0;
          await read(
            segment.unit,
            (reader) =>
              reader.passThrough(n0, n1, async (sample, slot) => {
                claim(slot);
                await add(sample);
                if (++written % 10 === 0) job.report?.(segment, slot);
              }),
            n0,
          );
        } else {
          const units = segment.units;
          const everySlot = units.some((unit) => {
            const rate = job.sources[unit].frameRate;
            return rate === null || !(rate >= MIN_CADENCE_RATE);
          });
          let written = 0;
          for (let n = n0; n < n1; ) {
            throwIfAborted();
            const layers: Array<{ sample: VideoSample | null; weight: number }> = [];
            let nextChange = Infinity;
            for (const unit of units) {
              const sample = await read(unit, (reader) => reader.frameOn(n), n0);
              nextChange = Math.min(nextChange, await read(unit, (reader) => reader.nextChangeSlot(), n0));
              layers.push({ sample, weight: 0 });
            }
            const m = nextBlendSlot(n, nextChange, n1, everySlot);
            const timestamp = claim(n);
            // Read at the middle of the frame's display interval, kept inside the segment: a segment that ends on a half
            // slot puts the last interval's middle on its end, where a unit ending there is no longer live
            const at = Math.min(Math.max((n + m) / 2 / fps - loopOffset, segment.fromSec), segment.toSec - 2 * TIME_EPS);
            const weights = new Map(envelopeAt(env, at).map((layer) => [layer.unit, layer.weight]));
            units.forEach((unit, k) => {
              layers[k].weight = weights.get(unit) ?? 0;
            });
            // The file's first frame, when a blend opens it, is made in the reference's own format and colour space
            const frame = await blender().composite(layers, timestamp, 1 / fps, { inRefFormat: !state.started });
            try {
              await add(frame);
            } finally {
              frame.close();
            }
            if (++written % 10 === 0) job.report?.(segment, n);
            n = m;
          }
        }
      } catch (error) {
        if (isAbort(error)) throw error;
        const failed = error instanceof ReaderFailure ? error : null;
        if (failed && segment.kind === "blend" && segment.units.length >= 3) {
          console.error("[VideoStitch] A clip decoder failed in a blend", failed.error);
          throw new Error(
            `Could not decode ${segment.units.length} clips at once at ${formatTimecode(loopOffset + segment.fromSec, 0)}. Move some apart or turn Crossfade off.`,
          );
        }
        const unit = failed ? failed.unit : segment.kind === "solo" ? segment.unit : segment.kind === "blend" ? segment.units[0] : 0;
        throw job.failure(unit, failed ? failed.error : error);
      }
      // A reader whose visibility run ends here is done
      for (const [unit, held] of [...open]) {
        if (held.n1 <= n1) {
          open.delete(unit);
          await held.reader.close();
        }
      }
    }
  } finally {
    const readers = [...open.values()].map((held) => held.reader);
    open.clear();
    await Promise.all(readers.map((reader) => reader.close()));
  }
}
