import { fetchMusicBlob } from "./musicBlob";
import { computePeaks } from "./peaks";

/**
 * The Stitch editor's music waveforms: peaks per media key, decoded once
 * the way the stitch decodes its music (useAudioMixing's decoder, which
 * loads mediabunny lazily and falls back to Web Audio), so the bars line up
 * with what is encoded. At most WAVEFORM_DECODES sources decode at a time,
 * each piece is folded into one channel as it is read, and the samples are
 * dropped as soon as the peaks are taken: an edit with several long sounds
 * never holds them all decoded at once. A browser-only module cache, never
 * written into the workflow store; the newest WAVEFORM_LRU_LIMIT keys asked
 * for are kept.
 */

export interface StitchWaveform {
  status: "loading" | "ready" | "error";
  /** The decoded music's length, seconds. */
  duration: number | null;
  peaks: Float32Array | null;
}

/** Decoded channels of a source; tests swap the decoder in with __setWaveformDecoderForTests. */
export type WaveformDecoder = (src: string) => Promise<{ channels: Float32Array[]; duration: number }>;

export const WAVEFORM_LRU_LIMIT = 16;
/** Decodes running at once; the others wait their turn. */
export const WAVEFORM_DECODES = 2;

interface Entry {
  waveform: StitchWaveform;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let clock = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * As the executor reads the music (stitchInputs, through fetchMusicBlob): the samples prepareAudioAsync(blob, 0)
 * would give, as one channel holding each sample's loudest channel, which has the same peaks as every channel. Each
 * decoded piece is folded in and let go as it arrives. A file shorter than prepareAudioAsync's minimum, which it
 * repeats to fill, is read through it.
 */
async function decodeWithAudioMixing(src: string): Promise<{ channels: Float32Array[]; duration: number }> {
  const blob = await fetchMusicBlob(src);
  const { decodeAudioPieces, fullLengthSamples, prepareAudioAsync } = await import("@/hooks/useAudioMixing");
  let folded: Float32Array[] = [];
  let decoded = 0;
  let sampleRate = 0;
  await decodeAudioPieces(blob, {
    restart: () => {
      folded = [];
      decoded = 0;
    },
    piece: (buffer) => {
      if (decoded === 0) sampleRate = buffer.sampleRate;
      const loudest = new Float32Array(buffer.length);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          // NaN never wins, as in computePeaks
          const value = Math.abs(data[i]);
          if (value > loudest[i]) loudest[i] = value;
        }
      }
      folded.push(loudest);
      decoded += buffer.length;
    },
  });
  if (decoded === 0) throw new Error("The music could not be decoded");
  const length = fullLengthSamples(decoded, sampleRate);
  if (length > decoded) {
    const audio = await prepareAudioAsync(blob, 0);
    if (!audio) throw new Error("The music could not be decoded");
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.buffer.numberOfChannels; c++) channels.push(audio.buffer.getChannelData(c));
    return { channels, duration: audio.duration };
  }
  const whole = new Float32Array(length);
  let at = 0;
  for (let i = 0; i < folded.length && at < length; i++) {
    const part = folded[i];
    const count = Math.min(part.length, length - at);
    whole.set(count === part.length ? part : part.subarray(0, count), at);
    at += count;
  }
  folded = [];
  return { channels: [whole], duration: length / sampleRate };
}

let waiting: Array<() => void> = [];
let running = 0;
/** A reset (tests) starts the turns again; a job from before it frees no turn. */
let turns = 0;

/** Runs `job` once fewer than WAVEFORM_DECODES are running. */
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const round = turns;
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      let started: Promise<T>;
      try {
        started = job();
      } catch (error) {
        started = Promise.reject(error);
      }
      started
        .then(resolve, reject)
        .finally(() => {
          if (round !== turns) return;
          running--;
          waiting.shift()?.();
        });
    };
    if (running < WAVEFORM_DECODES) start();
    else waiting.push(start);
  });
}

let decode: WaveformDecoder = decodeWithAudioMixing;

function evict(): void {
  while (entries.size > WAVEFORM_LRU_LIMIT) {
    let oldest: string | null = null;
    let oldestUsed = Infinity;
    for (const [key, entry] of entries) {
      if (entry.lastUsed < oldestUsed) {
        oldest = key;
        oldestUsed = entry.lastUsed;
      }
    }
    if (oldest === null) return;
    entries.delete(oldest);
  }
}

export function getWaveform(key: string): StitchWaveform | undefined {
  return entries.get(key)?.waveform;
}

export function subscribeWaveform(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts the decode once per key; a key already known only counts as used. */
export function requestWaveform(key: string, src: string): void {
  const known = entries.get(key);
  if (known) {
    known.lastUsed = ++clock;
    return;
  }
  const entry: Entry = { waveform: { status: "loading", duration: null, peaks: null }, lastUsed: ++clock };
  entries.set(key, entry);
  evict();
  notify();
  // A key evicted while it waited is never decoded
  void inTurn(() => (entries.get(key) === entry ? decode(src) : Promise.reject(new Error("evicted")))).then(
    ({ channels, duration }) => {
      // Evicted (or reset) while decoding: nobody is showing it
      if (entries.get(key) !== entry) return;
      const ready = Number.isFinite(duration) && duration > 0;
      entry.waveform = ready
        ? { status: "ready", duration, peaks: computePeaks(channels) }
        : { status: "error", duration: null, peaks: null };
      notify();
    },
    () => {
      if (entries.get(key) !== entry) return;
      entry.waveform = { status: "error", duration: null, peaks: null };
      notify();
    },
  );
}

export function __setWaveformForTests(key: string, waveform: Partial<StitchWaveform>): void {
  entries.set(key, {
    waveform: { status: "ready", duration: null, peaks: null, ...waveform },
    lastUsed: ++clock,
  });
  notify();
}

export function __resetWaveformForTests(): void {
  entries.clear();
  turns++;
  running = 0;
  waiting = [];
  decode = decodeWithAudioMixing;
  notify();
}

export function __setWaveformDecoderForTests(next: WaveformDecoder | null): void {
  decode = next ?? decodeWithAudioMixing;
}
