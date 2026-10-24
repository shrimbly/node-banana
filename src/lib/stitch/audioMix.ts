import type { VolumePoint } from "@/types";
import { gainAt } from "./curve";
import { coverGain, ownGain, type GainPiece } from "./placement";
import { crossfadeGain } from "./stack";

/**
 * The Stitch sound mix on plain sample arrays. The encoder takes one sample
 * rate and channel count for the whole track, so every clip's sound and the
 * music are brought to one master format, laid out by sequence time, and
 * summed. Nothing here touches mediabunny or the Web Audio API.
 */

/** Planar samples, one Float32Array per channel. */
export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

/** A decoded block and where it starts in its source, in seconds. */
export interface PcmChunk extends Pcm {
  timestamp: number;
}

export interface MasterFormat {
  sampleRate: number;
  channels: 1 | 2;
}

/** The parts of an AudioBuffer read here (jsdom has none). */
export interface AudioBufferLike {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

const DEFAULT_BLOCK_SIZE = 128;

const frameCount = (pcm: Pcm) => pcm.channels[0]?.length ?? 0;

/** Copies the channel data, so the buffer can be released. */
export function pcmFromAudioBuffer(buffer: AudioBufferLike, timestamp = 0): PcmChunk {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  return { sampleRate: buffer.sampleRate, channels, timestamp };
}

/**
 * The first `frames` samples of each channel (fewer when the buffer is shorter), as views on the buffer's own data:
 * nothing is copied, so the buffer must outlive them. For the music, of which a stitch plays only the beginning.
 */
export function pcmHead(buffer: AudioBufferLike, frames: number): Pcm {
  const end = Math.max(0, Math.min(buffer.length, Math.ceil(frames)));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).subarray(0, end));
  return { sampleRate: buffer.sampleRate, channels };
}

/** Linear interpolation; the same pcm when the rate already matches. Length round(n · ratio). */
export function resampleLinear(pcm: Pcm, sampleRate: number): Pcm {
  if (pcm.sampleRate === sampleRate) return pcm;
  const n = frameCount(pcm);
  const length = Math.round((n * sampleRate) / pcm.sampleRate);
  const step = pcm.sampleRate / sampleRate;
  const channels = pcm.channels.map((source) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const position = i * step;
      const i0 = Math.min(Math.floor(position), n - 1);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = position - i0;
      out[i] = source[i0] + (source[i1] - source[i0]) * frac;
    }
    return out;
  });
  return { sampleRate, channels };
}

const SQRT1_2 = Math.SQRT1_2;

/**
 * Mono → several duplicates it; several → mono averages them. Quad and 5.1 →
 * stereo use the Web Audio speaker downmix (channel order L, R, C, LFE, SL,
 * SR; the LFE is dropped), so a centre channel's dialogue is kept. Otherwise
 * the first channels are kept (a missing one repeats the last).
 */
export function remix(pcm: Pcm, channels: number): Pcm {
  const sources = pcm.channels;
  if (sources.length === channels || sources.length === 0) return pcm;
  if (channels === 2 && (sources.length === 4 || sources.length === 6)) {
    const n = frameCount(pcm);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    if (sources.length === 4) {
      const [l, r, sl, sr] = sources;
      for (let i = 0; i < n; i++) {
        left[i] = 0.5 * (l[i] + sl[i]);
        right[i] = 0.5 * (r[i] + sr[i]);
      }
    } else {
      const [l, r, c, , sl, sr] = sources;
      for (let i = 0; i < n; i++) {
        left[i] = l[i] + SQRT1_2 * (c[i] + sl[i]);
        right[i] = r[i] + SQRT1_2 * (c[i] + sr[i]);
      }
    }
    return { sampleRate: pcm.sampleRate, channels: [left, right] };
  }
  if (channels === 1) {
    const n = frameCount(pcm);
    const mono = new Float32Array(n);
    for (const source of sources) for (let i = 0; i < n; i++) mono[i] += source[i];
    for (let i = 0; i < n; i++) mono[i] /= sources.length;
    return { sampleRate: pcm.sampleRate, channels: [mono] };
  }
  return {
    sampleRate: pcm.sampleRate,
    channels: Array.from({ length: channels }, (_, c) => sources[Math.min(c, sources.length - 1)].slice()),
  };
}

export function toMasterFormat(pcm: Pcm, format: MasterFormat): Pcm {
  return resampleLinear(remix(pcm, format.channels), format.sampleRate);
}

/**
 * The samples of [fromSec, toSec), exactly round((to − from) · sr) of them, in
 * the first chunk's format. Each chunk goes by its own timestamp, so sound
 * before `from` is skipped and a gap (or sound that starts late) is silence.
 * No chunks → null.
 */
export function sliceChunksToRange(chunks: readonly PcmChunk[], fromSec: number, toSec: number): Pcm | null {
  if (chunks.length === 0) return null;
  const sampleRate = chunks[0].sampleRate;
  const channelCount = chunks[0].channels.length;
  const n = Math.max(0, Math.round((toSec - fromSec) * sampleRate));
  const out = Array.from({ length: channelCount }, () => new Float32Array(n));
  // Rounded once, and each chunk by its own whole-sample position: rounding
  // each chunk's difference from a start on a half sample would leave
  // one-sample gaps or overlaps at the seams.
  const fromSample = Math.round(fromSec * sampleRate);
  for (const chunk of chunks) {
    const pcm =
      chunk.sampleRate === sampleRate && chunk.channels.length === channelCount
        ? chunk
        : resampleLinear(remix(chunk, channelCount), sampleRate);
    const offset = Math.round(chunk.timestamp * sampleRate) - fromSample;
    const length = frameCount(pcm);
    const start = Math.max(0, -offset);
    const end = Math.min(length, n - offset);
    if (end <= start) continue;
    for (let c = 0; c < channelCount; c++) out[c].set(pcm.channels[c].subarray(start, end), offset + start);
  }
  return { sampleRate, channels: out };
}

/**
 * The music's rate when the music is the only source; with any clip sound, the
 * highest rate among all the sources, so a low-rate voice-over does not drag
 * the clips down. As many channels as the widest source, at most 2. Nothing
 * usable given → null.
 */
export function chooseMasterFormat(
  music: { sampleRate: number; channels: number } | null,
  clips: ReadonlyArray<{ sampleRate: number; channels: number }>,
): MasterFormat | null {
  const usable = (s: { sampleRate: number; channels: number }) =>
    Number.isFinite(s.sampleRate) && s.sampleRate > 0 && s.channels >= 1;
  const clipSources = clips.filter(usable);
  const sources = [...(music && usable(music) ? [music] : []), ...clipSources];
  if (sources.length === 0) return null;
  const widest = Math.max(...sources.map((s) => s.channels));
  const sampleRate = clipSources.length === 0 ? sources[0].sampleRate : Math.max(...sources.map((s) => s.sampleRate));
  return { sampleRate, channels: widest >= 2 ? 2 : 1 };
}

/**
 * The layers' format: the one source's rate when it plays alone; with several sources or any clip sound, the highest
 * rate of all. As many channels as the widest, at most 2. Nothing usable given → null.
 */
export function chooseLayerMasterFormat(
  sources: ReadonlyArray<{ sampleRate: number; channels: number }>,
  clips: ReadonlyArray<{ sampleRate: number; channels: number }>,
): MasterFormat | null {
  const usable = (s: { sampleRate: number; channels: number }) =>
    Number.isFinite(s.sampleRate) && s.sampleRate > 0 && s.channels >= 1;
  const layerSources = sources.filter(usable);
  const clipSources = clips.filter(usable);
  const all = [...layerSources, ...clipSources];
  if (all.length === 0) return null;
  const widest = Math.max(...all.map((s) => s.channels));
  const sampleRate =
    layerSources.length === 1 && clipSources.length === 0 ? layerSources[0].sampleRate : Math.max(...all.map((s) => s.sampleRate));
  return { sampleRate, channels: widest >= 2 ? 2 : 1 };
}

/*
 * Audio clips are laid on their source's own grid at the master rate: grid sample j of a source is what
 * toMasterFormat would give at index j for the whole buffer, and a clip puts it at output sample K + j, with
 * K = round((start − In) · rate). Every piece of one source reads the same grid and the same curve gains, so a split
 * changes no sample.
 */

/** How many samples the source has on its grid at the master rate (resampleLinear's length rule). */
export function masterLength(buffer: AudioBufferLike, format: MasterFormat): number {
  return Math.round((buffer.length * format.sampleRate) / buffer.sampleRate);
}

/**
 * Grid samples [a, b) of the source in the master format, in new arrays (safe to scale in place). Only the frames the
 * range reads are remixed, and each sample is interpolated with resampleLinear's own expressions, so the range is
 * sample for sample that slice of toMasterFormat of the whole buffer.
 */
export function masterRange(buffer: AudioBufferLike, format: MasterFormat, a: number, b: number): Pcm {
  const count = Math.max(0, b - a);
  const n = buffer.length;
  const channels = Array.from({ length: format.channels }, () => new Float32Array(count));
  if (count === 0 || n === 0) return { sampleRate: format.sampleRate, channels };
  const same = buffer.sampleRate === format.sampleRate;
  const step = buffer.sampleRate / format.sampleRate;
  const first = Math.min(same ? a : Math.floor(a * step), n - 1);
  const last = Math.min(same ? b - 1 : Math.floor((b - 1) * step) + 1, n - 1);
  const frames: Pcm = { sampleRate: buffer.sampleRate, channels: [] };
  for (let c = 0; c < buffer.numberOfChannels; c++) frames.channels.push(buffer.getChannelData(c).subarray(first, last + 1));
  // remix works frame by frame, so remixing the frames read gives the whole buffer's remix of them
  const mixed = remix(frames, format.channels).channels;
  channels.forEach((out, c) => {
    const source = mixed[c];
    if (same) {
      out.set(source.subarray(a - first, Math.min(b, n) - first));
      return;
    }
    for (let i = 0; i < count; i++) {
      const position = (a + i) * step;
      const i0 = Math.min(Math.floor(position), n - 1);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = position - i0;
      out[i] = source[i0 - first] + (source[i1 - first] - source[i0 - first]) * frac;
    }
  });
  return { sampleRate: format.sampleRate, channels };
}

/**
 * applyCurveGain on a source's grid: channels[c][i] is grid sample first + i, and the curve is read at grid sample /
 * sampleRate (source seconds). Block edges sit at the multiples of blockSize and at cutAt (the loop's end), so every
 * range of one grid reads the same gains. An empty curve changes nothing.
 */
export function applyCurveGainAt(
  channels: Float32Array[],
  sampleRate: number,
  curve: readonly VolumePoint[],
  first: number,
  cutAt = Infinity,
  blockSize = DEFAULT_BLOCK_SIZE,
): void {
  if (curve.length === 0 || channels.length === 0) return;
  const end = first + channels[0].length;
  const block = Math.max(1, Math.floor(blockSize));
  for (let blockStart = Math.floor(first / block) * block; blockStart < end; ) {
    let blockEnd = blockStart + block;
    if (blockStart < cutAt && cutAt < blockEnd) blockEnd = cutAt;
    const g0 = gainAt(curve, blockStart / sampleRate);
    const g1 = gainAt(curve, blockEnd / sampleRate);
    const span = blockEnd - blockStart;
    for (let j = Math.max(blockStart, first); j < Math.min(blockEnd, end); j++) {
      const gain = g0 + ((g1 - g0) * (j - blockStart)) / span;
      for (const channel of channels) channel[j - first] *= gain;
    }
    blockStart = blockEnd;
  }
}

/** One audio clip as audioClipLayers lays it: its decoded source, where its In plays, its trim and its curve. */
export interface AudioClipLayerSource {
  buffer: AudioBufferLike;
  startSec: number;
  inSec: number;
  outSec: number | null;
  /** Source seconds. */
  curve: readonly VolumePoint[];
}

/**
 * Each clip's heard part in the master format with its curve applied, and the output sample it starts at. A clip is
 * cut at the loop's end and at its source's end; one that is not heard in the loop is left out.
 */
export function audioClipLayers(
  clips: readonly AudioClipLayerSource[],
  format: MasterFormat,
  loopLength: number,
): Array<{ pcm: Pcm; at: number }> {
  const { sampleRate } = format;
  const loopSamples = Math.max(0, Math.round(loopLength * sampleRate));
  return clips.flatMap((clip) => {
    const length = masterLength(clip.buffer, format);
    const anchor = Math.round((clip.startSec - clip.inSec) * sampleRate);
    const a = Math.round(clip.inSec * sampleRate);
    const b = Math.min(clip.outSec === null ? length : Math.round(clip.outSec * sampleRate), length, loopSamples - anchor);
    if (b <= a) return [];
    const pcm = masterRange(clip.buffer, format, a, b);
    applyCurveGainAt(pcm.channels, sampleRate, clip.curve, a, loopSamples - anchor);
    return [{ pcm, at: anchor + a }];
  });
}

/** Whether an audio layer overlaps another, or a clip's sound as mixLoop lays it, in output samples. */
export function audioLayersOverlap(
  layers: ReadonlyArray<{ pcm: Pcm; at: number }>,
  clips: LoopMix["clips"],
  sampleRate: number,
): boolean {
  const spans = layers.map(({ pcm, at }) => [at, at + frameCount(pcm)] as const);
  const clipSpans = clips.map(({ pcm, seqStart }) => {
    const at = Math.round(seqStart * sampleRate);
    return [at, at + frameCount(pcm)] as const;
  });
  const overlap = (u: readonly [number, number], v: readonly [number, number]) => Math.max(u[0], v[0]) < Math.min(u[1], v[1]);
  return spans.some((u, i) => spans.some((v, j) => j > i && overlap(u, v)) || clipSpans.some((v) => overlap(u, v)));
}

/** target[c][offset + i] += source[c][i] · gain; indices outside target are ignored. */
export function mixInto(target: Float32Array[], source: Float32Array[], offset: number, gain: number): void {
  if (gain === 0) return;
  const channels = Math.min(target.length, source.length);
  for (let c = 0; c < channels; c++) {
    const into = target[c];
    const from = source[c];
    const start = Math.max(0, -offset);
    const end = Math.min(from.length, into.length - offset);
    for (let i = start; i < end; i++) into[offset + i] += from[i] * gain;
  }
}

/**
 * Multiplies by the curve's gain at startSec + i/sr. The gain is read at each
 * block's edges and ramped straight inside the block, so a steep move does
 * not click. An empty curve is flat at 1 and changes nothing.
 */
export function applyCurveGain(
  channels: Float32Array[],
  sampleRate: number,
  curve: readonly VolumePoint[],
  startSec = 0,
  blockSize = DEFAULT_BLOCK_SIZE,
): void {
  if (curve.length === 0 || channels.length === 0) return;
  const n = channels[0].length;
  const block = Math.max(1, Math.floor(blockSize));
  for (let blockStart = 0; blockStart < n; blockStart += block) {
    const blockEnd = Math.min(blockStart + block, n);
    const g0 = gainAt(curve, startSec + blockStart / sampleRate);
    const g1 = gainAt(curve, startSec + blockEnd / sampleRate);
    const span = blockEnd - blockStart;
    for (let i = blockStart; i < blockEnd; i++) {
      const gain = g0 + ((g1 - g0) * (i - blockStart)) / span;
      for (const channel of channels) channel[i] *= gain;
    }
  }
}

/** A NaN becomes silence; everything else is left as it is. */
export function silenceNaN(channels: Float32Array[]): void {
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) if (Number.isNaN(channel[i])) channel[i] = 0;
  }
}

/** Hard clip to [−1, 1]; a NaN becomes silence. No limiter: loud sums distort. */
export function clampSamples(channels: Float32Array[]): void {
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      channel[i] = Number.isNaN(v) ? 0 : Math.min(Math.max(v, -1), 1);
    }
  }
}

/**
 * A stacked clip's crossfades, in place: an equal-power fade in over its first inLength samples, a fade out over
 * [outStart, outStart + outLength), and silence after it (the next clip has taken over). Each sample's gain is read
 * at its middle, so the two fades of one join sum to constant power sample for sample. Zero lengths change nothing.
 * The PCM must belong to one clip: toMasterFormat can hand back the decoded buffer itself.
 */
export function applyCrossfades(
  channels: Float32Array[],
  fades: { inLength: number; outStart: number; outLength: number },
): void {
  const { inLength, outStart, outLength } = fades;
  for (const channel of channels) {
    const n = channel.length;
    for (let i = 0; i < Math.min(inLength, n); i++) channel[i] *= crossfadeGain((i + 0.5) / inLength, "in");
    if (outLength <= 0) continue;
    const outEnd = outStart + outLength;
    for (let i = Math.max(0, outStart); i < Math.min(outEnd, n); i++) {
      channel[i] *= crossfadeGain((i - outStart + 0.5) / outLength, "out");
    }
    if (outEnd < n) channel.fill(0, Math.max(0, outEnd));
  }
}

/** How many samples a varying gain piece runs between abort checks. */
const ABORT_CHECK_SAMPLES = 65536;

/**
 * A placed clip's gains (placement.ts gainPieces), in place. The clip's first sample sits at loop sample startSample;
 * its sample i is read at loop time (startSample + i + 0.5) / sampleRate. A piece [fromSec, toSec) covers its samples
 * round(fromSec · sr) − startSample up to round(toSec · sr) − startSample; the first and last pieces reach the PCM's
 * ends. A constant piece multiplies (0 fills); a varying one evaluates sin(own·π/2) · Π cos(above·π/2) per sample.
 * The PCM must belong to one clip: toMasterFormat can hand back the decoded buffer itself.
 */
export function applyGainPieces(
  channels: Float32Array[],
  sampleRate: number,
  startSample: number,
  pieces: readonly GainPiece[],
  signal?: AbortSignal,
): void {
  const n = channels[0]?.length ?? 0;
  const at = (sec: number) => Math.min(Math.max(Math.round(sec * sampleRate) - startSample, 0), n);
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  pieces.forEach((piece, p) => {
    throwIfAborted();
    const from = p === 0 ? 0 : at(piece.fromSec);
    const to = p === pieces.length - 1 ? n : at(piece.toSec);
    if (!(to > from)) return;
    if ("gain" in piece) {
      if (piece.gain === 1) return;
      for (const channel of channels) {
        if (piece.gain === 0) channel.fill(0, from, to);
        else for (let i = from; i < to; i++) channel[i] *= piece.gain;
      }
      return;
    }
    const { own, above, fromSec } = piece;
    for (let i = from; i < to; i++) {
      if (i > from && (i - from) % ABORT_CHECK_SAMPLES === 0) throwIfAborted();
      const dt = (startSample + i + 0.5) / sampleRate - fromSec;
      // placement.ts's gainPieceAt, unrolled for the sample loop: a covered clip is exactly silent
      let gain = ownGain(own.at + own.slope * dt);
      for (let k = 0; k < above.length; k++) gain *= coverGain(above[k].at + above[k].slope * dt);
      for (let c = 0; c < channels.length; c++) channels[c][i] *= gain;
    }
  });
}

export interface LoopMix {
  format: MasterFormat;
  /** One loop of the sequence, in seconds. */
  loopLength: number;
  /** In the master format; muted and silent clips are not listed. */
  clips: ReadonlyArray<{ pcm: Pcm; seqStart: number; gain: number }>;
  /** In the master format: the music the loops play (at least loopCount loops of it). Null when none or muted. */
  music: { pcm: Pcm; curve: readonly VolumePoint[] } | null;
  /** Clips overlap in the sequence (stacked), so their sound can sum. */
  clipsOverlap?: boolean;
  /** Audio clips (audioClipLayers): the same samples every loop, each from output sample `at`. */
  audio?: ReadonlyArray<{ pcm: Pcm; at: number }>;
  /** An audio clip overlaps another or a clip's sound (audioLayersOverlap), so they can sum. */
  audioSums?: boolean;
}

/**
 * One loop of the master sound, round(loopLength · sr) samples. Each clip is
 * mixed in at its sequence start with its gain. The music keeps running across
 * loops (loop k reads its samples from k · loopSamples on, silence past its
 * end), and the curve, which covers one loop, shapes it again each time.
 *
 * Audio clips (`audio`) are mixed in after the clips, the same samples every
 * loop; with them there is no music.
 *
 * The result is hard-clipped only when sources can sum: music under clip
 * sound, a gain above 1, audio clips that overlap each other or clip sound
 * (`audioSums`), or clips that overlap (stacked, said by the engine
 * rather than read from the sample ranges, so a rounding-level touch between
 * butted clips never turns it on). One source at a time (every unedited node)
 * passes its samples through as they were decoded, overs included.
 */
export function mixLoop(mix: LoopMix, loopIndex: number): Float32Array[] {
  const { sampleRate, channels } = mix.format;
  const loopSamples = Math.max(0, Math.round(mix.loopLength * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(loopSamples));
  for (const clip of mix.clips) {
    mixInto(out, clip.pcm.channels, Math.round(clip.seqStart * sampleRate), clip.gain);
  }
  if (mix.audio) {
    for (const layer of mix.audio) mixInto(out, layer.pcm.channels, layer.at, 1);
  }
  if (mix.music) {
    const from = loopIndex * loopSamples;
    const music = mix.music.pcm.channels.map((channel) => {
      const segment = new Float32Array(loopSamples);
      if (from < channel.length) segment.set(channel.subarray(from, from + loopSamples));
      return segment;
    });
    applyCurveGain(music, sampleRate, mix.music.curve);
    mixInto(out, music, 0, 1);
  }
  const sums =
    mix.clipsOverlap === true ||
    (mix.music !== null && mix.clips.length > 0) ||
    mix.clips.some((clip) => clip.gain > 1) ||
    mix.audioSums === true;
  if (sums) clampSamples(out);
  else silenceNaN(out);
  return out;
}
