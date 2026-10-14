import { useState, useEffect } from 'react';

export interface WaveformData {
  channelData: Float32Array[];
  sampleRate: number;
  duration: number;
  peaks: number[];
}

// Only the lightweight, render-relevant fields are cached. The full decoded PCM
// (channelData ~21MB/min of stereo audio) is intentionally NOT retained here — no
// consumer reads it, only `peaks` (256 numbers) is used for rendering.
type CachedWaveform = Pick<WaveformData, 'peaks' | 'sampleRate' | 'duration'>;

// Cap the cache and evict the least-recently-used entry so long sessions with
// many audio nodes don't grow the Map without bound.
const MAX_CACHE_ENTRIES = 30;
const waveformCache = new Map<string, CachedWaveform>();

const readWaveformCache = (key: string): CachedWaveform | undefined => {
  const cached = waveformCache.get(key);
  if (cached) {
    // Refresh LRU recency: re-inserting moves the key to the end.
    waveformCache.delete(key);
    waveformCache.set(key, cached);
  }
  return cached;
};

const writeWaveformCache = (key: string, value: CachedWaveform) => {
  waveformCache.delete(key);
  waveformCache.set(key, value);
  while (waveformCache.size > MAX_CACHE_ENTRIES) {
    const oldest = waveformCache.keys().next().value;
    if (oldest === undefined) break;
    waveformCache.delete(oldest);
  }
};

/**
 * A cache key for an audio source (its URL, or for a long data URL its
 * length and a sample of its characters), so a node mounted again finds the
 * waveform before it has fetched the audio.
 */
export function audioSourceKey(src: string | null | undefined): string | null {
  if (!src) return null;
  if (src.length <= 2048) return `src:${src}`;
  const samples = 256, step = Math.floor(src.length / samples);
  let sampled = "";
  for (let i = 0; i < samples; i++) sampled += src[i * step];
  return `src:${src.length}:${src.slice(0, 64)}:${sampled}:${src.slice(-64)}`;
}

const cachedWaveform = (key: string | null | undefined): WaveformData | null => {
  const cached = key ? readWaveformCache(key) : undefined;
  // channelData is intentionally not cached; consumers only read peaks/
  // duration/sampleRate. Reconstruct with an empty channelData array.
  return cached ? { ...cached, channelData: [] } : null;
};

const blobKeyStore = new WeakMap<Blob, string>();
let blobKeyCounter = 0;
let sharedAudioContext: AudioContext | null = null;

const getBlobCacheKey = (audioFile: File | Blob | null) => {
  if (!audioFile) return null;
  if (audioFile instanceof File) {
    return `${audioFile.name}-${audioFile.size}-${audioFile.lastModified}`;
  }
  const existing = blobKeyStore.get(audioFile);
  if (existing) return existing;
  const generated = `blob-${blobKeyCounter++}-${audioFile.size}-${audioFile.type ?? 'unknown'}`;
  blobKeyStore.set(audioFile, generated);
  return generated;
};

const getSharedAudioContext = () => {
  if (sharedAudioContext) {
    return sharedAudioContext;
  }
  const AudioCtor =
    typeof window !== 'undefined'
      ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : null;
  if (!AudioCtor) {
    throw new Error('AudioContext is not supported in this environment');
  }
  sharedAudioContext = new AudioCtor();
  return sharedAudioContext;
};

const decodeAudioBuffer = async (context: AudioContext, arrayBuffer: ArrayBuffer) => {
  if ('decodeAudioData' in context && context.decodeAudioData.length === 1) {
    return context.decodeAudioData(arrayBuffer);
  }
  return new Promise<AudioBuffer>((resolve, reject) => {
    context.decodeAudioData(arrayBuffer, resolve, reject);
  });
};

/**
 * The waveform of an audio file. `sourceKey` (audioSourceKey of the URL the
 * file was fetched from) finds one decoded before, in the first render and
 * without the file.
 */
export function useAudioVisualization(audioFile: File | Blob | null, sourceKey?: string | null) {
  const [waveformData, setWaveformData] = useState<WaveformData | null>(() => cachedWaveform(sourceKey));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const known = cachedWaveform(sourceKey);
    if (known) {
      setWaveformData((current) => (current?.peaks === known.peaks ? current : known));
      setIsLoading(false);
      setError(null);
      return;
    }
    if (!audioFile) {
      setWaveformData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const cacheKey = getBlobCacheKey(audioFile);
    const cached = cachedWaveform(cacheKey);
    if (cached) {
      if (sourceKey) writeWaveformCache(sourceKey, { peaks: cached.peaks, sampleRate: cached.sampleRate, duration: cached.duration });
      setWaveformData(cached);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isCancelled = false;

    const processAudio = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const arrayBuffer = await audioFile.arrayBuffer();
        const audioContext = getSharedAudioContext();
        const audioBuffer = await decodeAudioBuffer(audioContext, arrayBuffer);

        const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) =>
          audioBuffer.getChannelData(i)
        );

        const peaks = calculatePeaks(channelData, 256);

        const nextWaveform: WaveformData = {
          channelData,
          sampleRate: audioBuffer.sampleRate,
          duration: audioBuffer.duration,
          peaks,
        };

        // Cache only the lightweight fields; drop the full PCM channelData.
        for (const key of [cacheKey, sourceKey]) {
          if (key) writeWaveformCache(key, { peaks, sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration });
        }

        if (!isCancelled) {
          setWaveformData(nextWaveform);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process audio';
        setError(message);
        console.error('Audio processing error:', err);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    processAudio();

    return () => {
      isCancelled = true;
    };
  }, [audioFile, sourceKey]);

  return { waveformData, isLoading, error };
}

function calculatePeaks(channelData: Float32Array[], resolution: number): number[] {
  const peaks: number[] = [];
  const totalSamples = channelData[0]?.length ?? 0;
  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / resolution));

  for (let i = 0; i < resolution; i++) {
    let max = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, totalSamples);

    for (const channel of channelData) {
      for (let j = start; j < end; j++) {
        max = Math.max(max, Math.abs(channel[j] ?? 0));
      }
    }

    peaks.push(max);
  }

  return peaks;
}
