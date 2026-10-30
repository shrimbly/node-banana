import { EncodedPacketSink } from 'mediabunny';
import type { Input, InputAudioTrack, InputVideoTrack, Rotation } from 'mediabunny';
import { measureVideoTrackDuration, readVideoTrackMetadata } from '@/lib/video-probing';
import { cadenceRate } from '@/lib/stitch/stack';

/** What the encode needs from one source. Its Input stays open until the stitch ends. */
export interface ClipProbe {
  videoTrack: InputVideoTrack;
  /** Null when the source has no sound this browser can decode. */
  audioTrack: InputAudioTrack | null;
  width: number;
  height: number;
  rotation: Rotation;
  bitrate: number;
  /** The video track's own duration; an audio tail past it does not count. */
  videoDuration: number;
  firstTimestamp: number;
  /** Frames per second over the whole track; null when unknown. */
  frameRate: number | null;
}

/** Reads one source; null when it has no video track. */
export async function probeClip(input: Input): Promise<ClipProbe | null> {
  const videoTrack = (await input.getVideoTracks())[0];
  if (!videoTrack) return null;

  const { width, height, rotation, bitrate, averagePacketRate } = await readVideoTrackMetadata(videoTrack);

  // The same length the editor measures, so a clip lasts what the timeline shows
  const videoDuration = await measureVideoTrackDuration(input, videoTrack, averagePacketRate);

  let firstTimestamp = 0;
  try {
    firstTimestamp = await videoTrack.getFirstTimestamp();
  } catch {
    // Read from 0
  }

  let audioTrack: InputAudioTrack | null = null;
  try {
    const track = (await input.getAudioTracks())[0];
    if (track && (await track.canDecode())) audioTrack = track;
  } catch (e) {
    console.warn('Failed to read the audio track', e);
  }

  const first = Number.isFinite(firstTimestamp) && firstTimestamp > 0 ? firstTimestamp : 0;
  // The cadence places frames on first + j / rate: measure the rate from the frame intervals, not the packet span
  let lastPacket: { timestamp: number; duration: number } | null = null;
  try {
    lastPacket = await new EncodedPacketSink(videoTrack).getPacket(Infinity, { metadataOnly: true });
  } catch {
    // The average as given
  }

  return {
    videoTrack,
    audioTrack,
    width,
    height,
    rotation,
    bitrate,
    videoDuration,
    firstTimestamp: first,
    frameRate: cadenceRate(averagePacketRate, first, lastPacket),
  };
}
