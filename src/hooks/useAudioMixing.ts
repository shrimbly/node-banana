'use client';

import { useCallback } from 'react';
import {
  Input,
  AudioBufferSink,
  BlobSource,
  ALL_FORMATS,
} from 'mediabunny';

const MINIMUM_AUDIO_DURATION = 0.1;

interface AudioProcessingOptions {
  offset?: number;
  fadeIn?: number;
  fadeOut?: number;
}

interface AudioMixProgress {
  message: string;
  progress: number;
}

interface AudioData {
  buffer: AudioBuffer;
  duration: number;
}

interface UseAudioMixingReturn {
  prepareAudio: (
    audioBlob: Blob,
    videoDuration: number,
    onProgress?: (progress: AudioMixProgress) => void,
    options?: AudioProcessingOptions
  ) => Promise<AudioData | null>;
}

/**
 * Decode audio blob using MediaBunny. Supports MP3, WAV, OGG and container formats.
 * Returns an array of decoded AudioBuffers, or, with `onPiece`, hands each one
 * over as it is decoded and keeps none (returns []).
 */
async function decodeWithMediaBunny(
  audioBlob: Blob,
  onProgress?: (progress: AudioMixProgress) => void,
  onPiece?: (buffer: AudioBuffer) => void,
): Promise<AudioBuffer[]> {
  onProgress?.({ message: 'Reading audio tracks...', progress: 20 });

  let blobSource: BlobSource | undefined;
  let input: Input | undefined;
  let sink: AudioBufferSink | undefined;

  try {
    blobSource = new BlobSource(audioBlob);
    input = new Input({ source: blobSource, formats: ALL_FORMATS });

    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      throw new Error('No audio tracks found in file');
    }

    const decodable = await audioTrack.canDecode();
    if (!decodable) {
      throw new Error('Audio codec not supported by this browser');
    }

    sink = new AudioBufferSink(audioTrack);
    const audioDuration = await input.computeDuration();

    onProgress?.({ message: 'Decoding audio...', progress: 30 });
    const decodedBuffers: AudioBuffer[] = [];
    let pieces = 0;
    for await (const wrappedBuffer of sink.buffers(0, audioDuration)) {
      if (wrappedBuffer?.buffer) {
        pieces++;
        if (onPiece) onPiece(wrappedBuffer.buffer);
        else decodedBuffers.push(wrappedBuffer.buffer);
      }
    }

    if (pieces === 0) {
      throw new Error('Failed to decode audio');
    }

    return decodedBuffers;
  } finally {
    // Defensively close resources — types may not declare close() but implementations may have it
    const closeable = (obj: unknown): obj is { close(): Promise<void> } =>
      obj != null && typeof (obj as any).close === 'function';
    if (closeable(sink)) {
      try { await sink.close(); } catch (e) { console.warn('Failed to close sink:', e); }
    }
    if (closeable(input)) {
      try { await input.close(); } catch (e) { console.warn('Failed to close input:', e); }
    }
    if (closeable(blobSource)) {
      try { await blobSource.close(); } catch (e) { console.warn('Failed to close blobSource:', e); }
    }
  }
}

/**
 * Decode audio blob using the Web Audio API as a fallback.
 */
async function decodeWithWebAudio(
  audioBlob: Blob,
  onProgress?: (progress: AudioMixProgress) => void,
): Promise<AudioBuffer[]> {
  onProgress?.({ message: 'Decoding audio (Web Audio API)...', progress: 30 });
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    return [decoded];
  } finally {
    await audioContext.close();
  }
}

/**
 * The file's decoded pieces in order: MediaBunny's, or the Web Audio API's one
 * buffer when MediaBunny cannot read it.
 */
export async function decodeAudioBuffers(
  audioBlob: Blob,
  onProgress?: (progress: AudioMixProgress) => void,
): Promise<AudioBuffer[]> {
  try {
    return await decodeWithMediaBunny(audioBlob, onProgress);
  } catch (mediaBunnyError) {
    console.warn('MediaBunny audio decode failed, falling back to Web Audio API:', mediaBunnyError);
    return decodeWithWebAudio(audioBlob, onProgress);
  }
}

/**
 * decodeAudioBuffers, each piece handed to `piece` as it is decoded and none
 * kept. `restart` is called before the Web Audio fallback hands its one
 * buffer, so pieces MediaBunny gave before it failed can be dropped.
 */
export async function decodeAudioPieces(
  audioBlob: Blob,
  each: { piece: (buffer: AudioBuffer) => void; restart: () => void },
): Promise<void> {
  try {
    await decodeWithMediaBunny(audioBlob, undefined, each.piece);
  } catch (mediaBunnyError) {
    console.warn('MediaBunny audio decode failed, falling back to Web Audio API:', mediaBunnyError);
    const [buffer] = await decodeWithWebAudio(audioBlob);
    each.restart();
    each.piece(buffer);
  }
}

/** The samples prepareAudioAsync(…, 0) gives a file `decodedSamples` long: at least MINIMUM_AUDIO_DURATION. */
export function fullLengthSamples(decodedSamples: number, sampleRate: number): number {
  return Math.max(1, Math.floor(Math.max(MINIMUM_AUDIO_DURATION, decodedSamples / sampleRate) * sampleRate));
}

/**
 * Standalone async function to prepare audio for mixing with video.
 * Uses MediaBunny for decoding, with Web Audio API as fallback.
 */
export async function prepareAudioAsync(
  audioBlob: Blob,
  videoDuration: number,
  onProgress?: (progress: AudioMixProgress) => void,
  options?: AudioProcessingOptions
): Promise<AudioData | null> {
  try {
    onProgress?.({ message: 'Loading audio file...', progress: 10 });

    const decodedBuffers = await decodeAudioBuffers(audioBlob, onProgress);

    const sampleRate = decodedBuffers[0].sampleRate;
    const channels = decodedBuffers[0].numberOfChannels;

    // Compute the total decoded audio duration from buffers
    const decodedDuration = decodedBuffers.reduce((sum, buf) => sum + buf.length, 0) / sampleRate;

    // If videoDuration is 0 (unknown), use the full audio duration
    const targetDuration = videoDuration > 0
      ? Math.max(MINIMUM_AUDIO_DURATION, videoDuration)
      : Math.max(MINIMUM_AUDIO_DURATION, decodedDuration);
    const totalSamples = Math.max(1, Math.floor(targetDuration * sampleRate));

    onProgress?.({ message: 'Processing audio...', progress: 60 });

    const mergedBuffer = new AudioBuffer({
      length: totalSamples,
      numberOfChannels: channels,
      sampleRate,
    });

    const offsetSeconds = options?.offset ?? 0;
    const offsetSamples = Math.floor(offsetSeconds * sampleRate);

    let writeOffset = 0;
    let sourceSkipSamples = 0;

    if (offsetSamples > 0) {
      writeOffset = Math.min(offsetSamples, totalSamples);
    } else if (offsetSamples < 0) {
      sourceSkipSamples = Math.abs(offsetSamples);
    }

    // Skip offset samples across decoded buffers
    let samplesToSkip = sourceSkipSamples;
    let bufferIndex = 0;
    let bufferOffset = 0;

    while (samplesToSkip > 0 && bufferIndex < decodedBuffers.length) {
      const buffer = decodedBuffers[bufferIndex];
      const availableInBuffer = buffer.length - bufferOffset;
      if (samplesToSkip >= availableInBuffer) {
        samplesToSkip -= availableInBuffer;
        bufferIndex++;
        bufferOffset = 0;
      } else {
        bufferOffset = samplesToSkip;
        samplesToSkip = 0;
      }
    }

    // Copy decoded audio into the merged buffer
    while (writeOffset < totalSamples && bufferIndex < decodedBuffers.length) {
      const buffer = decodedBuffers[bufferIndex];
      const remainingSamples = totalSamples - writeOffset;
      const availableInBuffer = buffer.length - bufferOffset;
      const writeLength = Math.min(availableInBuffer, remainingSamples);

      for (let channel = 0; channel < channels; channel++) {
        const channelData = buffer.getChannelData(channel).subarray(bufferOffset, bufferOffset + writeLength);
        mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
      }

      writeOffset += writeLength;
      bufferOffset += writeLength;

      if (bufferOffset >= buffer.length) {
        bufferIndex++;
        bufferOffset = 0;
      }
    }

    // Loop audio to fill remaining duration if needed
    while (writeOffset < totalSamples && decodedBuffers.length > 0) {
      for (const buffer of decodedBuffers) {
        const remainingSamples = totalSamples - writeOffset;
        if (remainingSamples <= 0) break;
        const writeLength = Math.min(buffer.length, remainingSamples);
        for (let channel = 0; channel < channels; channel++) {
          const channelData = buffer.getChannelData(channel).subarray(0, writeLength);
          mergedBuffer.getChannelData(channel).set(channelData, writeOffset);
        }
        writeOffset += writeLength;
      }
    }

    applyFades(mergedBuffer, options);
    onProgress?.({ message: 'Audio ready for mixing', progress: 95 });

    return {
      buffer: mergedBuffer,
      duration: totalSamples / sampleRate,
    };
  } catch (error) {
    console.error('[VideoStitch] Audio preparation failed:', error instanceof Error ? error.message : error, error);
    throw new Error(`Failed to process audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * React hook wrapper for prepareAudioAsync
 */
export const useAudioMixing = (): UseAudioMixingReturn => {
  const prepareAudio = useCallback(
    async (
      audioBlob: Blob,
      videoDuration: number,
      onProgress?: (progress: AudioMixProgress) => void,
      options?: AudioProcessingOptions
    ): Promise<AudioData | null> => {
      return prepareAudioAsync(audioBlob, videoDuration, onProgress, options);
    },
    []
  );

  return { prepareAudio };
};

export function applyFades(buffer: AudioBuffer, options?: { fadeIn?: number; fadeOut?: number }) {
  if (!options) return;
  const fadeInSeconds = Math.max(0, options.fadeIn ?? 0);
  const fadeOutSeconds = Math.max(0, options.fadeOut ?? 0);
  if (fadeInSeconds === 0 && fadeOutSeconds === 0) return;

  const totalSamples = buffer.length;
  if (totalSamples === 0) return;

  let fadeInSamples = Math.min(totalSamples, Math.floor(fadeInSeconds * buffer.sampleRate));
  let fadeOutSamples = Math.min(totalSamples, Math.floor(fadeOutSeconds * buffer.sampleRate));

  if (fadeInSamples + fadeOutSamples > totalSamples) {
    const scale = totalSamples / Math.max(1, fadeInSamples + fadeOutSamples);
    fadeInSamples = Math.floor(fadeInSamples * scale);
    fadeOutSamples = Math.floor(fadeOutSamples * scale);
  }

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    if (fadeInSamples > 0) {
      for (let i = 0; i < fadeInSamples; i++) {
        channelData[i] *= i / fadeInSamples;
      }
    }
    if (fadeOutSamples > 0) {
      for (let i = 0; i < fadeOutSamples; i++) {
        const sampleIndex = totalSamples - fadeOutSamples + i;
        if (sampleIndex < 0 || sampleIndex >= totalSamples) continue;
        channelData[sampleIndex] *= (fadeOutSamples - i) / fadeOutSamples;
      }
    }
  }
}
