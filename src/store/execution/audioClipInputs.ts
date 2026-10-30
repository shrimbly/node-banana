/**
 * Audio clips as a render mixes them: each distinct source fetched and decoded
 * once, the way the waveform decodes it (prepareAudioAsync(blob, 0)), so the
 * waveform drawn is the sound encoded. The Edit Video node's executor
 * (stitchInputs) and the Edit video view's drafts both gather through here.
 */

import type { StitchAudioClip } from "@/types";
import { AssetApiError, fetchAssetBlob } from "@/lib/assets/client/api";
import { audioSourceKey, compactAudioRows, normalizeAudioClips, type AudioSourceKey } from "@/lib/stitch/audioClips";
import { getAssetInfo, requestAssetInfo } from "@/lib/stitch/assetInfo";
import type { StitchAudioClipInput, StitchAudioData } from "@/lib/stitch/engineTypes";
import { fetchMusicBlob } from "@/lib/stitch/musicBlob";
import { formatTimecode } from "@/lib/stitch/timecode";

const DECODER_PREFIX = /^Failed to process audio: /;

/** “tone.m4a” when this page knows the record, else the clip's place: "the audio clip on Audio 2 at 0:03.00". */
function clipName(clip: StitchAudioClip, row: number): { known: string } | { place: string } {
  if (clip.source.kind === "asset") {
    const record = getAssetInfo(clip.source.assetId);
    if (record) return { known: record.filename };
  }
  return { place: `the audio clip on Audio ${row + 1} at ${formatTimecode(clip.startSec)}` };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Each unmuted clip, in audio order, as the engine mixes it. Music is read from `musicUrl`, and its clips are
 * skipped when it is null. A library file that is gone, or a file that cannot be decoded, stops the run with a
 * sentence that names the file as its box does, or the clip's place when this page has not read its record.
 */
export async function gatherAudioClipInputs(
  clips: readonly StitchAudioClip[],
  opts: { musicUrl: string | null; signal?: AbortSignal },
): Promise<StitchAudioClipInput[]> {
  const { musicUrl, signal } = opts;
  const ordered = compactAudioRows(normalizeAudioClips(clips)).clips;
  const decoded = new Map<AudioSourceKey, StitchAudioData>();
  const inputs: StitchAudioClipInput[] = [];
  for (const clip of ordered) {
    if (clip.muted || (clip.source.kind === "music" && musicUrl === null)) continue;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const key = audioSourceKey(clip.source);
    let audio = decoded.get(key);
    if (!audio) {
      audio = await decodeSource(clip, musicUrl, signal);
      decoded.set(key, audio);
    }
    inputs.push({ audio, startSec: clip.startSec, inSec: clip.inSec, outSec: clip.outSec, curve: clip.curve });
  }
  return inputs;
}

async function decodeSource(clip: StitchAudioClip, musicUrl: string | null, signal: AbortSignal | undefined): Promise<StitchAudioData> {
  const name = clipName(clip, clip.row);
  let blob: Blob;
  if (clip.source.kind === "music") {
    blob = await fetchMusicBlob(musicUrl ?? "");
  } else {
    const { assetId } = clip.source;
    try {
      blob = await fetchAssetBlob(assetId, signal);
    } catch (error) {
      if (error instanceof AssetApiError && error.status === 404) {
        // The card and the editor read its record again, so they show it gone as the run found it
        requestAssetInfo([assetId], { refresh: true });
        throw new Error(
          "known" in name
            ? `Audio clip “${name.known}” is no longer in the library`
            : `${capitalized(name.place)} is no longer in the library`,
        );
      }
      throw error;
    }
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const { prepareAudioAsync } = await import("@/hooks/useAudioMixing");
  try {
    const audio = await prepareAudioAsync(blob, 0);
    if (!audio) throw new Error("no sound decoded");
    return audio;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(DECODER_PREFIX, "");
    const what = "known" in name ? `audio clip “${name.known}”` : clip.source.kind === "music" ? "the connected music" : name.place;
    throw new Error(`Can't read ${what}: ${reason}`);
  }
}
