/**
 * The music's waveform as peaks: a fixed number of buckets over the whole
 * file, each the loudest sample in its stretch, whatever the channel. The
 * audio lane draws its bars from these at any zoom, so the file is decoded
 * once and the samples are not kept.
 *
 * Pure: no React, no DOM, no Web Audio.
 */

export const WAVEFORM_BUCKETS = 2048;

/** max |sample| across channels per bucket, 0..1. A file shorter than the bucket count gets one bucket per sample. */
export function computePeaks(channels: readonly Float32Array[], buckets: number = WAVEFORM_BUCKETS): Float32Array {
  const length = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const count = Math.max(0, Math.min(Math.floor(buckets), length));
  const peaks = new Float32Array(count);
  if (count === 0) return peaks;
  for (const channel of channels) {
    for (let bucket = 0; bucket < count; bucket++) {
      const from = Math.floor((bucket * length) / count);
      const to = Math.min(channel.length, Math.floor(((bucket + 1) * length) / count));
      let peak = peaks[bucket];
      for (let i = from; i < to; i++) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
      peaks[bucket] = peak;
    }
  }
  // Decoded audio can run past full scale; NaN reads as silence
  for (let bucket = 0; bucket < count; bucket++) {
    const value = peaks[bucket];
    peaks[bucket] = Number.isNaN(value) ? 0 : Math.min(value, 1);
  }
  return peaks;
}

/**
 * The max of the buckets covering [fromSec, toSec) of a `duration`-long file; 0 past the end. A range inside one
 * bucket reads that bucket, so a bar narrower than a bucket at a high zoom still has a height.
 */
export function peakInRange(peaks: Float32Array, duration: number, fromSec: number, toSec: number): number {
  if (peaks.length === 0 || !(duration > 0) || !Number.isFinite(fromSec) || !Number.isFinite(toSec)) return 0;
  const start = Math.max(0, fromSec);
  const end = Math.min(duration, toSec);
  if (start >= duration || end <= start) return 0;
  const perSec = peaks.length / duration;
  const first = Math.min(peaks.length - 1, Math.floor(start * perSec));
  const last = Math.min(peaks.length - 1, Math.max(first, Math.ceil(end * perSec) - 1));
  let peak = 0;
  for (let i = first; i <= last; i++) if (peaks[i] > peak) peak = peaks[i];
  return peak;
}
