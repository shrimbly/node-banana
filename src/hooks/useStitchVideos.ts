'use client';

import { useState, useCallback } from 'react';
import {
  Input,
  Output,
  VideoSampleSink,
  VideoSampleSource,
  AudioBufferSource,
  AudioBufferSink,
  BlobSource,
  ALL_FORMATS,
  BufferTarget,
  Mp4OutputFormat,
  getFirstEncodableAudioCodec,
  canEncodeVideo,
} from 'mediabunny';
import type { AudioCodec, InputAudioTrack, Rotation, VideoSample } from 'mediabunny';
import { createAvcEncodingConfig, AVC_LEVEL_4_0, AVC_LEVEL_5_1 } from '@/lib/video-encoding';
import {
  DEFAULT_BITRATE,
  MAX_OUTPUT_FPS,
  FALLBACK_WIDTH,
  FALLBACK_HEIGHT,
  BASELINE_PIXEL_LIMIT,
  ensureEvenDimension,
} from '@/lib/video-probing';
import {
  normalizeAudioClips,
  normalizeLoopCount,
  normalizeStack,
  normalizeStitchArgs,
  type StitchAudioData,
  type StitchClipInput,
  type StitchMusicInput,
  type StitchOptions,
} from '@/lib/stitch/engineTypes';
import { FrameSlotter, secToSlot, type PlannedClip } from '@/lib/stitch/sequencePlan';
import { clipFadeSamples, dissolveFrames, sharedCadence, soloPass, type Dissolve } from '@/lib/stitch/stack';
import { createFrameBlender, encodeDissolve, type FrameBlender } from '@/lib/stitch/crossfadeFrames';
import { encodePlacedLoop, openClipReader, type ClipReaderWindow, type PlacedEncodeState } from '@/lib/stitch/clipReader';
import { gainPieces, LAYER_WARNING, SLOT_SEC, TIME_EPS } from '@/lib/stitch/placement';
import { maxVisibleLayers, pictureSegments, segmentsInLoop } from '@/lib/stitch/placedSchedule';
import { planPicture } from '@/lib/stitch/picturePlan';
import { probeClip, type ClipProbe } from '@/lib/stitch/clipProbe';
import {
  applyCrossfades,
  applyGainPieces,
  audioClipLayers,
  audioLayersOverlap,
  chooseLayerMasterFormat,
  chooseMasterFormat,
  mixLoop,
  pcmFromAudioBuffer,
  pcmHead,
  sliceChunksToRange,
  toMasterFormat,
  type LoopMix,
  type MasterFormat,
  type Pcm,
  type PcmChunk,
} from '@/lib/stitch/audioMix';

const AUDIO_BITRATE = 128000;

/** One clip of the sequence that has frames to give. */
interface StitchUnit {
  plan: PlannedClip;
  clip: StitchClipInput;
  probe: ClipProbe;
}

const determineEncodeParameters = (
  probes: ClipProbe[]
): { width: number; height: number; rotation: Rotation; maxSourceBitrate: number } => {
  let maxWidth = 0;
  let maxHeight = 0;
  let maxSourceBitrate = 0;
  let rotation: Rotation | null = null;

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    maxWidth = Math.max(maxWidth, probe.width);
    maxHeight = Math.max(maxHeight, probe.height);
    maxSourceBitrate = Math.max(maxSourceBitrate, probe.bitrate);
    if (rotation === null) {
      rotation = probe.rotation;
    } else if (probe.rotation !== rotation) {
      console.warn(
        `Rotation mismatch detected for video ${i + 1} (got ${probe.rotation}, expected ${rotation}). Using the first rotation value.`
      );
    }
  }

  if (maxWidth <= 0 || maxHeight <= 0) {
    return {
      width: FALLBACK_WIDTH,
      height: FALLBACK_HEIGHT,
      rotation: rotation ?? (0 as Rotation),
      maxSourceBitrate,
    };
  }

  return {
    width: ensureEvenDimension(maxWidth),
    height: ensureEvenDimension(maxHeight),
    rotation: rotation ?? (0 as Rotation),
    maxSourceBitrate,
  };
};

/**
 * The first encodable codec for the master format, else for the two formats
 * every AAC encoder takes. Null when there is none.
 */
async function pickAudioCodec(preferred: MasterFormat): Promise<{ codec: AudioCodec; format: MasterFormat } | null> {
  const candidates: MasterFormat[] = [preferred, { sampleRate: 48000, channels: 2 }, { sampleRate: 44100, channels: 2 }];
  const tried = new Set<string>();
  for (const format of candidates) {
    const key = `${format.sampleRate}/${format.channels}`;
    if (tried.has(key)) continue;
    tried.add(key);
    // No opus: Twitter doesn't support it
    const codec = await getFirstEncodableAudioCodec(['aac', 'mp3'], {
      numberOfChannels: format.channels,
      sampleRate: format.sampleRate,
      bitrate: AUDIO_BITRATE,
    });
    if (codec) return { codec, format };
  }
  return null;
}

/**
 * A clip's sound over [from, to) of its source, sample-exact, and silent from
 * `audibleUntil` (its Out) on: when the video starts after In, the window runs
 * past Out, and the picture there holds its last frame. Null when it yields nothing.
 */
async function decodeClipSound(
  track: InputAudioTrack,
  from: number,
  to: number,
  audibleUntil: number,
  signal?: AbortSignal
): Promise<Pcm | null> {
  const until = Math.min(to, audibleUntil);
  if (!(until > from)) return null;
  const chunks: PcmChunk[] = [];
  // The first buffer is the one in effect at `from`, so it can start earlier; the slice goes by timestamps
  for await (const wrapped of new AudioBufferSink(track).buffers(from, until)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    chunks.push(pcmFromAudioBuffer(wrapped.buffer, wrapped.timestamp));
  }
  const pcm = sliceChunksToRange(chunks, from, to);
  if (!pcm) return null;
  // The last buffer can run past Out
  const cut = Math.max(0, Math.round((until - from) * pcm.sampleRate));
  for (const channel of pcm.channels) channel.fill(0, cut);
  return pcm;
}

export interface StitchProgress {
  status: 'idle' | 'processing' | 'complete' | 'error';
  message: string;
  progress: number; // 0-100
  currentVideo?: number; // Which video is being processed (1-indexed)
  totalVideos?: number;
  error?: string;
}

/** The old name of the music input; kept for existing imports. */
export type AudioData = StitchAudioData;

/**
 * Check if the device encoder supports AVC encoding
 */
export async function checkEncoderSupport(): Promise<boolean> {
  try {
    return await canEncodeVideo('avc', {
      width: 1920,
      height: 1080,
      bitrate: DEFAULT_BITRATE,
    });
  } catch {
    return false;
  }
}

/**
 * Stitches clips into one H.264 video. Each clip plays from In to Out (its
 * whole video track by default), butted against the one before, or, stacked
 * (`overlapSec`), starting that much before it ends: the picture dissolves
 * and the sound crossfades across the overlap, or with `crossfade: false` the
 * earlier clip stays in front while both are heard. Placed (`placed`), each
 * clip starts at its own startSec and the higher row is in front: where clips
 * overlap it fades in or out over the rows below (placement.ts), and a gap is
 * black. The sequence repeats
 * `loopCount` times, with a cut at each restart. Each clip's own sound plays
 * at its volume unless muted, and the music is mixed over it with its volume
 * curve, which repeats each loop while the music itself runs on. With
 * `audioClips` the music argument is ignored: each audio clip plays from its
 * start in every loop, with its curve, cut at the loop's end.
 *
 * Bare Blobs and a bare music buffer keep their old meaning: whole clips, and
 * the music replacing their sound (see normalizeStitchArgs).
 */
export async function stitchVideosAsync(
  videoClips: ReadonlyArray<Blob | StitchClipInput>,
  audio?: StitchAudioData | StitchMusicInput | null,
  onProgress?: (progress: StitchProgress) => void,
  signal?: AbortSignal,
  options?: StitchOptions
): Promise<Blob> {
  const { clips, music } = normalizeStitchArgs(videoClips, audio);
  const audioClips = normalizeAudioClips(options);
  const loopCount = normalizeLoopCount(options);
  const stack = normalizeStack(options);
  let totalVideos = clips.length * loopCount;

  const updateProgress = (
    status: StitchProgress['status'],
    message: string,
    progressValue: number,
    currentVideo?: number
  ) => {
    onProgress?.({ status, message, progress: progressValue, currentVideo, totalVideos });
  };
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };

  const inputs: Input[] = [];
  let videoSource: VideoSampleSource | null = null;
  let audioSource: AudioBufferSource | null = null;
  let output: Output | null = null;
  let outputStarted = false;

  try {
    updateProgress('processing', 'Starting the render...', 0);

    if (clips.length === 0) {
      throw new Error('No videos to render');
    }

    try {
      updateProgress('processing', 'Analyzing video metadata...', 1);

      // Each source once, however many clips (split pieces, loops) play it
      const probes = new Map<Blob, ClipProbe | null>();
      for (let i = 0; i < clips.length; i++) {
        throwIfAborted();
        const { blob } = clips[i];
        if (probes.has(blob)) continue;
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        inputs.push(input);
        let probe: ClipProbe | null;
        try {
          probe = await probeClip(input);
        } catch (probeError) {
          console.error(`Error processing video ${i + 1}:`, probeError);
          throw new Error(probeError instanceof Error ? probeError.message : `Failed to process video ${i + 1}`);
        }
        if (!probe) console.warn(`No video tracks in video ${i + 1}`);
        probes.set(blob, probe);
      }

      // A source without a video track counts 0 s, and planSequence drops it
      const picture = planPicture(
        clips.map((clip) => {
          const probe = probes.get(clip.blob);
          return {
            inSec: clip.inSec,
            outSec: clip.outSec,
            sourceDuration: probe?.videoDuration ?? 0,
            firstTimestamp: probe?.firstTimestamp,
            source: clip.source,
            startSec: clip.startSec,
          };
        }),
        options
      );
      const units: StitchUnit[] = [];
      for (const planned of picture.planned) {
        const probe = probes.get(clips[planned.index].blob);
        if (probe) units.push({ plan: planned, clip: clips[planned.index], probe });
      }
      const { sp, env, loopLength } = picture;
      if (units.length === 0 || loopLength <= 0) {
        throw new Error('Nothing to render: every clip is empty');
      }
      totalVideos = units.length * loopCount;

      const {
        width: probedWidth,
        height: probedHeight,
        rotation: aggregateRotation,
        maxSourceBitrate,
      } = determineEncodeParameters(units.map((unit) => unit.probe));
      updateProgress('processing', 'Checking the encoder...', 3);

      const safeWidth = probedWidth > 0 ? probedWidth : FALLBACK_WIDTH;
      const safeHeight = probedHeight > 0 ? probedHeight : FALLBACK_HEIGHT;

      const codecProfile =
        safeWidth * safeHeight > BASELINE_PIXEL_LIMIT ? AVC_LEVEL_5_1 : AVC_LEVEL_4_0;

      // Use highest of default/source bitrate
      const candidateBitrate = Math.max(
        DEFAULT_BITRATE,
        Number.isFinite(maxSourceBitrate) && maxSourceBitrate > 0 ? maxSourceBitrate : 0
      );
      const resolvedBitrate = Math.max(1, Math.floor(candidateBitrate));

      const supportsConfig = await canEncodeVideo('avc', {
        width: safeWidth,
        height: safeHeight,
        bitrate: resolvedBitrate,
        fullCodecString: codecProfile,
      });

      if (!supportsConfig) {
        throw new Error(
          `Device encoder cannot output ${safeWidth}x${safeHeight} using profile ${codecProfile}. Reduce the resolution or bitrate and try again.`
        );
      }

      console.log('Stitch encoder configuration', {
        width: safeWidth,
        height: safeHeight,
        codecProfile,
        bitrate: resolvedBitrate,
        maxSourceBitrate,
        rotation: aggregateRotation,
      });

      // The sound: every audible clip and the music, in one master format
      // Each keeps its unit's index: muted and soundless clips are left out, so a position here is not one in the sequence
      const audible = units.flatMap((unit, unitIndex) =>
        unit.probe.audioTrack && !unit.clip.muted && unit.clip.volume > 0
          ? [{ ...unit, unitIndex, audioTrack: unit.probe.audioTrack }]
          : []
      );
      const audibleMusic = audioClips ? null : music && !music.muted ? music : null;
      // Each audio clip heard in a loop: from its start, for its trimmed length, until the loop ends
      const soundingAudio = (audioClips ?? []).filter(
        (clip) => Math.min(Math.min(clip.outSec ?? clip.audio.duration, clip.audio.duration) - clip.inSec, loopLength - clip.startSec) > 0
      );
      let mix: LoopMix | null = null;
      let audioCodec: AudioCodec | null = null;

      if (audible.length > 0 || audibleMusic || soundingAudio.length > 0) {
        // Decoded first, so the master format comes from the sound itself
        // (an HE-AAC track's container says half its rate and mono)
        const decoded: Array<{ pcm: Pcm; unitIndex: number; gain: number }> = [];
        for (let k = 0; k < audible.length; k++) {
          throwIfAborted();
          const { plan: planned, clip, audioTrack, unitIndex } = audible[k];
          updateProgress('processing', 'Extracting audio from source videos...', 5 + (k / audible.length) * 5);
          try {
            // From the same origin as the clip's frames, so picture and sound stay in the source's sync
            const pcm = await decodeClipSound(
              audioTrack,
              planned.origin,
              planned.origin + planned.length,
              planned.outSec,
              signal
            );
            if (pcm) decoded.push({ pcm, unitIndex, gain: clip.volume });
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            // Silence for this clip; the others keep their place
            console.warn(`Failed to extract audio from video ${planned.index + 1}:`, err);
          }
        }

        updateProgress('processing', 'Detecting supported audio codec...', 10);
        const preferred = audioClips
          ? chooseLayerMasterFormat(
              [...new Set(soundingAudio.map((clip) => clip.audio.buffer))].map((buffer) => ({
                sampleRate: buffer.sampleRate,
                channels: buffer.numberOfChannels,
              })),
              decoded.map(({ pcm }) => ({ sampleRate: pcm.sampleRate, channels: pcm.channels.length }))
            )
          : chooseMasterFormat(
              audibleMusic
                ? { sampleRate: audibleMusic.audio.buffer.sampleRate, channels: audibleMusic.audio.buffer.numberOfChannels }
                : null,
              decoded.map(({ pcm }) => ({ sampleRate: pcm.sampleRate, channels: pcm.channels.length }))
            );
        const chosen = preferred ? await pickAudioCodec(preferred) : null;

        if (!preferred) {
          console.warn('[VideoStitch] No clip sound could be decoded, continuing without audio');
        } else if (!chosen) {
          console.warn('[VideoStitch] No supported audio codec found, continuing without audio');
          updateProgress('processing', 'Warning: no supported audio codec — audio skipped', 10);
        } else {
          audioCodec = chosen.codec;
          // mixLoop plays loopCount loops of the music, in the master's samples: only that much of the song is
          // converted (+1 for the resampler's last neighbour), however long it is
          const musicPcm = (buffer: AudioBuffer) => {
            const played = loopCount * Math.max(0, Math.round(loopLength * chosen.format.sampleRate));
            return pcmHead(buffer, (played * buffer.sampleRate) / chosen.format.sampleRate + 1);
          };
          mix = {
            format: chosen.format,
            loopLength,
            clips: decoded.map(({ pcm, unitIndex, gain }) => {
              const master = toMasterFormat(pcm, chosen.format);
              if (env) {
                // Placed: at its own start; with Crossfade on its sound follows its share of the picture
                const start = env.units[unitIndex].start;
                const sampleRate = chosen.format.sampleRate;
                if (env.crossfade) {
                  applyGainPieces(master.channels, sampleRate, Math.round(start * sampleRate), gainPieces(env, unitIndex), signal);
                }
                return { pcm: master, seqStart: start, gain };
              }
              if (!sp) return { pcm: master, seqStart: units[unitIndex].plan.seqStart, gain };
              const placed = sp.clips[unitIndex];
              if (stack?.crossfade) {
                // Faded against the next planned clip, sounding or not: a silent partner still fades this side
                const next = sp.clips[unitIndex + 1];
                applyCrossfades(
                  master.channels,
                  clipFadeSamples(placed, next ? next.seqStart : null, chosen.format.sampleRate)
                );
              }
              return { pcm: master, seqStart: placed.seqStart, gain };
            }),
            music: audibleMusic
              ? { pcm: toMasterFormat(musicPcm(audibleMusic.audio.buffer), chosen.format), curve: audibleMusic.curve }
              : null,
          };
          if (env) {
            // Said from the layout, never the sample ranges: a rounding-level touch between butted clips is not an overlap
            const spans = decoded.map(({ unitIndex }) => env.units[unitIndex]);
            mix.clipsOverlap = spans.some((u, i) =>
              spans.some(
                (v, j) =>
                  j > i &&
                  Math.min(u.start + u.length, v.start + v.length) - Math.max(u.start, v.start) >= SLOT_SEC - TIME_EPS
              )
            );
          }
          if (sp) {
            const stacked = sp;
            const sounding = new Set(decoded.map(({ unitIndex }) => unitIndex));
            mix.clipsOverlap = decoded.some(
              ({ unitIndex }) => sounding.has(unitIndex + 1) && stacked.clips[unitIndex + 1].overlapIn > 0
            );
          }
          if (audioClips) {
            const count = soundingAudio.length;
            updateProgress('processing', `Mixing ${count} audio clip${count === 1 ? '' : 's'}...`, 10);
            const layers = audioClipLayers(
              soundingAudio.map((clip) => ({ ...clip, buffer: clip.audio.buffer })),
              chosen.format,
              loopLength
            );
            mix.audio = layers;
            mix.audioSums = audioLayersOverlap(layers, mix.clips, chosen.format.sampleRate);
          }
        }
      }

      // Create output
      updateProgress('processing', 'Creating output container...', 11);

      const encoderSource = new VideoSampleSource(
        createAvcEncodingConfig(resolvedBitrate, safeWidth, safeHeight, codecProfile)
      );
      videoSource = encoderSource;

      const bufferTarget = new BufferTarget();
      const muxer = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: bufferTarget,
      });
      output = muxer;

      muxer.addVideoTrack(encoderSource, { rotation: aggregateRotation, frameRate: MAX_OUTPUT_FPS });

      if (mix && audioCodec) {
        updateProgress('processing', `Adding audio track (${audioCodec})...`, 11);
        audioSource = new AudioBufferSource({
          codec: audioCodec,
          bitrate: AUDIO_BITRATE,
        });
        muxer.addAudioTrack(audioSource);
      }

      await muxer.start();
      outputStarted = true;

      // Feed audio early so the muxer can interleave audio packets with video frames.
      // Writing audio after all video causes broken interleaving (Discord won't play audio).
      // One loop at a time: added buffers play back to back.
      if (audioSource && mix) {
        updateProgress('processing', 'Encoding audio track...', 12);
        for (let loop = 0; loop < loopCount; loop++) {
          throwIfAborted();
          const channels = mixLoop(mix, loop);
          const length = channels[0]?.length ?? 0;
          if (length === 0) continue;
          const loopBuffer = new AudioBuffer({
            length,
            numberOfChannels: channels.length,
            sampleRate: mix.format.sampleRate,
          });
          channels.forEach((data, c) => loopBuffer.getChannelData(c).set(data));
          await audioSource.add(loopBuffer);
        }
        await audioSource.close();
        audioSource = null;
      }

      // Every frame lands on the 60 fps grid at its own offset into its clip;
      // each clip starts exactly where the one before ends, so nothing drifts.
      const slotter = new FrameSlotter(MAX_OUTPUT_FPS);
      const frameInterval = 1 / MAX_OUTPUT_FPS;
      // Stacked: mediabunny's reference size (the first frame added), which every blended frame is made at
      let ref: { width: number; height: number } | null = null;
      const addToEncoder = async (sample: VideoSample) => {
        if (sp && !ref) ref = { width: sample.codedWidth, height: sample.codedHeight };
        await encoderSource.add(sample);
      };

      /**
       * One clip's frames from `from` to `to` (source seconds), straight through to the encoder at the slots
       * startSlotAt opens; the frame before `holdBefore` is held back for the first slot.
       */
      const encodeRun = async (run: {
        unit: StitchUnit;
        unitIndex: number;
        startSlotAt: () => void;
        from: number;
        to: number;
        holdBefore: number;
        /** Where the run lands in the output, for the progress. */
        window: { startSec: number; length: number };
      }) => {
        throwIfAborted();
        const { probe } = run.unit;
        const videoNumber = run.unitIndex + 1;

        updateProgress(
          'processing',
          `Processing video ${videoNumber}/${totalVideos}...`,
          12 + (run.unitIndex / totalVideos) * 85,
          videoNumber
        );

        run.startSlotAt();

        let samplesFromThisVideo = 0;
        const encodeFrame = async (sample: VideoSample) => {
          const timestamp = slotter.place(sample.timestamp ?? 0);
          if (timestamp === null) {
            sample.close();
            return;
          }

          sample.setTimestamp(timestamp);
          sample.setDuration(frameInterval);
          try {
            await addToEncoder(sample);
          } finally {
            sample.close();
          }
          samplesFromThisVideo++;

          if (samplesFromThisVideo % 10 === 0) {
            // By where the frame landed, so a 24 fps clip fills its share as a 60 fps one does
            const withinClip = Math.min(1, Math.max(0, (timestamp - run.window.startSec) / run.window.length));
            updateProgress(
              'processing',
              `Processing video ${videoNumber}/${totalVideos}: ${samplesFromThisVideo} frames...`,
              12 + ((run.unitIndex + withinClip) / totalVideos) * 85,
              videoNumber
            );
          }
        };

        // The frame in effect at In starts before it. It is held back and
        // takes the join only when no frame at or after In lands there: a
        // frame the trim cut away must not push out the first one it kept.
        let heldBeforeIn: VideoSample | null = null;
        try {
          // Decodes only the clip's range, from the key frame before In
          const sink = new VideoSampleSink(probe.videoTrack);
          for await (const sample of sink.samples(run.from, run.to)) {
            if (signal?.aborted) {
              sample.close();
              throw new DOMException("Aborted", "AbortError");
            }
            const sourceTimestamp = sample.timestamp ?? 0;
            if (sourceTimestamp < run.holdBefore) {
              heldBeforeIn?.close();
              heldBeforeIn = sample;
              continue;
            }
            if (heldBeforeIn) {
              const before = heldBeforeIn;
              heldBeforeIn = null;
              if (slotter.takesFirstSlot(sourceTimestamp)) before.close();
              else await encodeFrame(before);
            }
            await encodeFrame(sample);
          }
          if (heldBeforeIn) {
            const before = heldBeforeIn;
            heldBeforeIn = null;
            await encodeFrame(before);
          }
        } catch (videoError) {
          // A user Stop must propagate as an AbortError, not a per-video failure.
          if (videoError instanceof DOMException && videoError.name === "AbortError") throw videoError;
          const errorMsg =
            videoError instanceof Error
              ? videoError.message
              : `Failed to process video ${videoNumber}`;
          console.error(`Error processing video ${videoNumber}:`, videoError);
          throw new Error(errorMsg);
        } finally {
          heldBeforeIn?.close();
        }
      };

      if (env) {
        const segments = pictureSegments(env);
        const most = maxVisibleLayers(segments);
        if (most > LAYER_WARNING) {
          console.warn(`[VideoStitch] ${most} clips blend at once; this takes about ${most * 50} MB at 1080p`);
        }
        const totalSlots = Math.max(1, secToSlot(loopCount * loopLength));
        // One blender and one reference for the whole encode, as the other branches keep theirs
        const state: PlacedEncodeState = { ref: null, blender: null };
        const sources = units.map((unit) => ({
          inSec: unit.plan.inSec,
          outSec: unit.plan.outSec,
          origin: unit.plan.origin,
          frameRate: unit.probe.frameRate,
          open: (range: { from: number; to: number }, window: ClipReaderWindow) =>
            openClipReader(unit.probe.videoTrack, range, window, unit.plan.inSec),
        }));
        for (let loop = 0; loop < loopCount; loop++) {
          const videoNumber = (unit: number) => loop * units.length + unit + 1;
          await encodePlacedLoop({
            env,
            segments: segmentsInLoop(segments, loop),
            loop,
            sources,
            state,
            fallbackRef: { width: safeWidth, height: safeHeight },
            makeBlender: (size) => createFrameBlender(size),
            claim: (slot) => slotter.claim(slot),
            add: (sample) => encoderSource.add(sample),
            report: (segment, slot) => {
              if (segment.kind === 'black') return;
              const share = 12 + Math.min(1, slot / totalSlots) * 85;
              if (segment.kind === 'solo') {
                const n = videoNumber(segment.unit);
                updateProgress('processing', `Processing video ${n}/${totalVideos}...`, share, n);
              } else if (segment.units.length === 2) {
                const [bottom, top] = segment.units.map(videoNumber);
                updateProgress('processing', `Blending video ${bottom} into ${top}...`, share, bottom);
              } else {
                updateProgress('processing', `Blending ${segment.units.length} videos...`, share, videoNumber(segment.units[0]));
              }
            },
            failure: (unit, error) => {
              const n = videoNumber(unit);
              console.error(`Error processing video ${n}:`, error);
              return new Error(error instanceof Error ? error.message : `Failed to process video ${n}`);
            },
            signal,
            fps: MAX_OUTPUT_FPS,
          });
        }
      } else if (!sp) {
        for (let loop = 0; loop < loopCount; loop++) {
          for (let k = 0; k < units.length; k++) {
            const unit = units[k];
            const { plan: planned } = unit;
            const windowStart = loop * loopLength + planned.seqStart;
            await encodeRun({
              unit,
              unitIndex: loop * units.length + k,
              startSlotAt: () => slotter.begin({ origin: planned.origin, startSec: windowStart, length: planned.length }),
              from: planned.inSec,
              to: planned.outSec,
              holdBefore: planned.origin,
              window: { startSec: windowStart, length: planned.length },
            });
          }
        }
      } else {
        const stacked = sp;
        let blender: FrameBlender | null = null;
        const blenderFor = (firstOutgoing: VideoSample | null): FrameBlender => {
          if (!blender) {
            const size = ref ?? {
              width: firstOutgoing?.codedWidth || safeWidth,
              height: firstOutgoing?.codedHeight || safeHeight,
            };
            ref ??= size;
            blender = createFrameBlender(size);
          }
          return blender;
        };
        const dissolveFrom = new Map<number, Dissolve>(stacked.dissolves.map((d) => [d.outgoing, d]));

        // A dissolve's slots, claimed after the outgoing clip's solo frames and before the incoming clip's
        const blendJoin = async (d: Dissolve, loopOffset: number, unitIndex: number) => {
          throwIfAborted();
          const videoNumber = unitIndex + 1;
          updateProgress(
            'processing',
            `Blending video ${videoNumber} into ${videoNumber + 1}...`,
            12 + ((unitIndex + 1) / totalVideos) * 85,
            videoNumber
          );
          const outgoing = units[d.outgoing].probe;
          const incoming = units[d.incoming].probe;
          const frames = dissolveFrames(stacked, d, loopOffset, {
            fps: MAX_OUTPUT_FPS,
            cadence: sharedCadence(outgoing, incoming),
          });
          const timestamps: number[] = [];
          const outgoingTimes: number[] = [];
          const incomingTimes: number[] = [];
          const alphas: number[] = [];
          frames.slots.forEach((slot, i) => {
            const timestamp = slotter.claim(slot);
            if (timestamp === null) return;
            timestamps.push(timestamp);
            outgoingTimes.push(frames.outgoingTimes[i]);
            incomingTimes.push(frames.incomingTimes[i]);
            alphas.push(frames.alphas[i]);
          });
          try {
            await encodeDissolve(
              {
                outgoing: outgoing.videoTrack,
                incoming: incoming.videoTrack,
                timestamps,
                outgoingTimes,
                incomingTimes,
                alphas,
                frameDuration: frameInterval,
                signal,
              },
              blenderFor,
              addToEncoder
            );
          } catch (blendError) {
            if (blendError instanceof DOMException && blendError.name === "AbortError") throw blendError;
            console.error(`Error processing video ${videoNumber}:`, blendError);
            throw new Error(blendError instanceof Error ? blendError.message : `Failed to process video ${videoNumber}`);
          }
        };

        for (let loop = 0; loop < loopCount; loop++) {
          const loopOffset = loop * loopLength;
          for (let k = 0; k < units.length; k++) {
            const unit = units[k];
            const placed = stacked.clips[k];
            const unitIndex = loop * units.length + k;
            const solo = soloPass(placed, loopOffset, MAX_OUTPUT_FPS);
            if (solo) {
              await encodeRun({
                unit,
                unitIndex,
                startSlotAt: () => slotter.beginRange({ origin: placed.soloOrigin, fromSec: solo.fromSec, toSec: solo.toSec }),
                // A head the clip before covers or dissolves over is not decoded again here
                from: solo.decodeFrom,
                to: solo.decodeTo,
                holdBefore: placed.soloOrigin,
                window: { startSec: solo.fromSec, length: solo.toSec - solo.fromSec },
              });
            }
            const join = dissolveFrom.get(k);
            if (join) await blendJoin(join, loopOffset, unitIndex);
          }
        }
      }

      // Flush encoder before finalizing container
      await encoderSource.close();
      videoSource = null; // Already closed, prevent double-close in finally
      updateProgress('processing', 'Finishing the video...', 97);

      // Finalize output
      await muxer.finalize();
      outputStarted = false; // Successfully finalized
      output = null;
      const buffer = bufferTarget.buffer;

      if (!buffer) {
        throw new Error('Failed to generate output buffer');
      }

      const outputBlob = new Blob([buffer], { type: 'video/mp4' });

      updateProgress(
        'complete',
        `Rendered ${totalVideos} videos into ${(outputBlob.size / 1024 / 1024).toFixed(2)}MB file`,
        100
      );

      return outputBlob;
    } finally {
      // Close whatever an error left open; the probed Inputs are released either way
      if (audioSource) {
        try {
          await audioSource.close();
        } catch (e) {
          console.warn('Failed to close audioSource:', e);
        }
      }
      if (videoSource) {
        try {
          await videoSource.close();
        } catch (e) {
          console.warn('Failed to close videoSource:', e);
        }
      }
      if (output && outputStarted) {
        try {
          await output.cancel();
        } catch (e) {
          console.warn('Failed to cancel output:', e);
        }
      }
      for (const input of inputs) input.dispose();
    }
  } catch (error) {
    // Preserve cancellation as an AbortError so the executor treats Stop as idle.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    console.error('Video stitching error:', normalizedError);

    const errorProgress: StitchProgress = {
      status: 'error',
      message: `Error: ${normalizedError.message}`,
      progress: 0,
      error: normalizedError.message,
    };

    onProgress?.(errorProgress);

    throw normalizedError;
  }
}

interface UseStitchVideosReturn {
  stitchVideos: (
    videoBlobs: Blob[],
    audioData?: AudioData | null,
    onProgress?: (progress: StitchProgress) => void
  ) => Promise<Blob | null>;
  progress: StitchProgress;
  reset: () => void;
}

/**
 * Hook for stitching multiple video blobs together sequentially
 * Reads frames from each video and writes them to output in order
 */
export const useStitchVideos = (): UseStitchVideosReturn => {
  const [progress, setProgress] = useState<StitchProgress>({
    status: 'idle',
    message: 'Ready',
    progress: 0,
  });

  const stitchVideos = useCallback(
    async (
      videoBlobs: Blob[],
      audioData?: AudioData | null,
      onProgress?: (progress: StitchProgress) => void
    ): Promise<Blob | null> => {
      try {
        setProgress({
          status: 'processing',
          message: 'Initializing...',
          progress: 0,
        });

        const result = await stitchVideosAsync(videoBlobs, audioData, (p) => {
          setProgress(p);
          onProgress?.(p);
        });

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Render failed';
        setProgress({
          status: 'error',
          message: errorMessage,
          progress: 0,
          error: errorMessage,
        });
        return null;
      }
    },
    []
  );

  const reset = useCallback(() => {
    setProgress({
      status: 'idle',
      message: 'Ready',
      progress: 0,
    });
  }, []);

  return {
    stitchVideos,
    progress,
    reset,
  };
};
