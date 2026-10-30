/**
 * Where each clip of a Stitch sequence goes, and where each of its frames
 * lands on the output's 60 fps grid. Pure, so the engine's timing can be
 * tested without decoding anything.
 */

/** The output frame grid. Equals MAX_OUTPUT_FPS; not imported, since video-probing loads mediabunny. */
export const FRAME_RATE = 60;

export interface PlanClip {
  inSec: number;
  outSec: number | null;
  /** The video track's duration (its last packet's end). */
  sourceDuration: number;
  /** The video track's first timestamp; both tracks of the clip are read from it. */
  firstTimestamp?: number;
}

export interface PlannedClip {
  /** The clip's index in the list given to planSequence. */
  index: number;
  inSec: number;
  outSec: number;
  /** max(inSec, firstTimestamp): where the clip's picture and sound both start being read. */
  origin: number;
  length: number;
  /** Start within one loop of the sequence, in seconds. */
  seqStart: number;
}

/**
 * The output slot a time lands on: half rounds up, and float noise just under a half does too. Shared by the
 * slotter and the stacked plan, so a dissolve's frames land where the slotter would put the same frames.
 */
export function secToSlot(sec: number, fps: number = FRAME_RATE): number {
  return Math.floor(sec * fps + 0.5 + 1e-6);
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const finiteOr = (value: number | null | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * In is clamped to [0, D] and Out (D when null) to [In, D], so the length is the one the editor shows. A clip
 * shorter than one output frame (a past-end trim, an empty source) is dropped, and the clips after it close up.
 */
export function planSequence(clips: readonly PlanClip[]): { clips: PlannedClip[]; loopLength: number } {
  const planned: PlannedClip[] = [];
  let seqStart = 0;
  clips.forEach((clip, index) => {
    const duration = Math.max(0, finiteOr(clip.sourceDuration, 0));
    const inSec = clamp(finiteOr(clip.inSec, 0), 0, duration);
    const outSec = clamp(finiteOr(clip.outSec, duration), inSec, duration);
    const length = outSec - inSec;
    if (length < 1 / FRAME_RATE) return;
    const origin = Math.max(inSec, Math.max(0, finiteOr(clip.firstTimestamp, 0)));
    planned.push({ index, inSec, outSec, origin, length, seqStart });
    seqStart += length;
  });
  return { clips: planned, loopLength: seqStart };
}

/**
 * The video track's length: its last packet's end. A container that leaves
 * the last frame's duration out (WebM without BlockDuration, as Chrome's
 * MediaRecorder writes) reports 0 for it; that frame then gets one average
 * frame interval, so it is not cut off by an exclusive end.
 */
export function videoTrackDuration(
  trackDuration: number,
  lastPacket: { timestamp: number; duration: number } | null,
  averagePacketRate: number,
): number {
  const duration = Number.isFinite(trackDuration) && trackDuration > 0 ? trackDuration : 0;
  if (!lastPacket || lastPacket.duration > 0) return duration;
  if (!Number.isFinite(lastPacket.timestamp) || !(averagePacketRate > 0) || !Number.isFinite(averagePacketRate)) {
    return duration;
  }
  return Math.max(duration, lastPacket.timestamp + 1 / averagePacketRate);
}

/**
 * Places decoded frames on the output grid; one per encode. Slots are whole
 * numbers, so nothing drifts however many clips and loops there are. A frame
 * goes at its own offset from the clip's origin; one that lands past the
 * clip's window, or on a slot already written, is dropped.
 *
 * The window's start and each frame's offset are snapped separately, with the
 * same rounding: a start on a half slot (after a 24 fps clip of an odd frame
 * count, say) would otherwise round neighbouring frames different ways and put
 * two on one slot.
 */
export class FrameSlotter {
  private readonly fps: number;
  private origin = 0;
  private startSlot = 0;
  private endSlot = 0;
  private lastSlot = -1;

  constructor(fps: number = FRAME_RATE) {
    this.fps = fps;
  }

  private toSlot(sec: number): number {
    return secToSlot(sec, this.fps);
  }

  /** Start one clip of one loop. startSec = loopIndex · loopLength + clip.seqStart. */
  begin(window: { origin: number; startSec: number; length: number }): void {
    this.origin = window.origin;
    this.startSlot = this.toSlot(window.startSec);
    this.endSlot = this.toSlot(window.startSec + window.length);
  }

  /**
   * Start the part of a clip that plays alone (stacked): its frames from `origin` on fill the slots of
   * [fromSec, toSec), with the same rounding as begin, so the windows either side of a dissolve tile with it.
   */
  beginRange(window: { origin: number; fromSec: number; toSec: number }): void {
    this.origin = window.origin;
    this.startSlot = this.toSlot(window.fromSec);
    this.endSlot = this.toSlot(window.toSec);
  }

  /** A slot a dissolve writes: its output timestamp, or null when the slot is not after the last one written. */
  claim(slot: number): number | null {
    if (!(slot > this.lastSlot)) return null;
    this.lastSlot = slot;
    return slot / this.fps;
  }

  private slotOf(timestamp: number): number {
    const rel = Number.isFinite(timestamp) ? Math.max(0, timestamp - this.origin) : 0;
    return this.startSlot + this.toSlot(rel);
  }

  /**
   * Whether a frame at this timestamp would land on the window's first slot.
   * Places nothing: the engine asks it of the first frame at or after In, to
   * learn whether the frame before In (decoded first) should give way to it.
   */
  takesFirstSlot(timestamp: number): boolean {
    return this.slotOf(timestamp) === this.startSlot;
  }

  /** The frame's output timestamp in seconds, or null to drop it. */
  place(timestamp: number): number | null {
    const slot = this.slotOf(timestamp);
    if (slot >= this.endSlot || slot <= this.lastSlot) return null;
    this.lastSlot = slot;
    return slot / this.fps;
  }
}
