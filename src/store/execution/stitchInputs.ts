/**
 * What a Stitch run encodes: the node's timeline resolved to video Blobs, and
 * its audio: the music as before when the audio has the legacy shape, else
 * every audio clip. Read the way the card and the editor read it
 * (readStitchDraft), so the encode is the sequence they show. An edit
 * project's draft (the Edit video view) is gathered by the same rules from
 * its library clips (gatherDraftInputs), and both build the engine's options
 * and the recorded parameters with the same two functions.
 */

import type { StitchTimelineClip, VideoStitchNodeData } from "@/types";
import { AssetApiError, fetchAssetBlob } from "@/lib/assets/client/api";
import type { StitchAudioClipInput, StitchClipInput, StitchMusicInput, StitchOptions } from "@/lib/stitch/engineTypes";
import { isLegacyAudioShape } from "@/lib/stitch/audioClips";
import { requestAssetInfo } from "@/lib/stitch/assetInfo";
import { musicAudio, readStitchDraft, type StitchDraft } from "@/lib/stitch/draft";
import { isLegacyStitch, stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { isPlaced, sourceKey } from "@/lib/stitch/timeline";
import { fetchMusicBlob } from "@/lib/stitch/musicBlob";
import { resolveEdgeVideo, resolveEdgeVideos } from "@/lib/stitch/sources";
import { gatherAudioClipInputs } from "./audioClipInputs";
import type { NodeExecutionContext } from "./types";

export interface GatheredStitch {
  /** Playable clips in timeline order. On an unedited node a router edge gives one clip per video it carries. */
  clips: StitchClipInput[];
  /**
   * Null when no music has output, when the music is muted (it is then never decoded), and when the audio is not
   * legacy-shaped (audioClips then carries the music too).
   */
  music: StitchMusicInput | null;
  /** Every unmuted audio clip, when the audio is not legacy-shaped (the new loop rule); else null (the old music path). */
  audioClips: StitchAudioClipInput[] | null;
  loopCount: 1 | 2 | 3;
  /** Playable clips, for the asset recording. */
  clipCount: number;
  /** Stacked with an overlap; null for Track, every legacy node, and inputs gathered without edges. */
  stack: { overlapSec: number; crossfade: boolean } | null;
  /** Stacked with a stored start; null for Track, lined-up stacks, legacy nodes and inputs gathered without edges. */
  placed: { crossfade: boolean; overlapSec: number } | null;
}

type ClipMedia = { kind: "url"; url: string } | { kind: "asset"; assetId: string; position: number };

/** A clip to encode before its video is fetched: where the video comes from (asset position = timeline index + 1). */
export interface PendingClip extends Omit<StitchClipInput, "blob"> {
  media: ClipMedia;
}

const TOO_FEW_CLIPS = "Need at least 2 video clips to render";
export const NO_CLIP_TO_RENDER = "Add a clip to render";

type Placed = GatheredStitch["placed"];

/** A timeline clip's trim and sound, and its start when the stack is placed. */
function clipTrim(clip: StitchTimelineClip, placed: Placed): Omit<StitchClipInput, "blob" | "source"> {
  return {
    inSec: clip.inSec,
    outSec: clip.outSec,
    muted: clip.muted,
    volume: clip.volume,
    // A clip dropped below takes its start with it; no other clip moves
    ...(placed && clip.startSec !== undefined ? { startSec: clip.startSec } : {}),
  };
}

/**
 * Each pending clip's video, fetched once per source however many pieces of it play. A library video that is gone
 * stops the run with "Clip N's library video is no longer in the library", and its record is read again.
 */
export async function fetchClipBlobs(pending: readonly PendingClip[], signal?: AbortSignal): Promise<StitchClipInput[]> {
  const fetches = new Map<string, Promise<Blob>>();
  const blobFor = (media: ClipMedia): Promise<Blob> => {
    const key = media.kind === "url" ? `url:${media.url}` : `asset:${media.assetId}`;
    let blob = fetches.get(key);
    if (!blob) {
      blob =
        media.kind === "url"
          ? fetch(media.url).then((r) => r.blob())
          : fetchAssetBlob(media.assetId, signal).catch((error: unknown) => {
              if (error instanceof AssetApiError && error.status === 404) {
                // The card and the editor read its record again, so they count it as the run found it
                requestAssetInfo([media.assetId], { refresh: true });
                throw new Error(`Clip ${media.position}'s library video is no longer in the library`);
              }
              throw error;
            });
      fetches.set(key, blob);
    }
    return blob;
  };
  const blobs = await Promise.all(pending.map((clip) => blobFor(clip.media)));
  return pending.map((clip, i) => ({
    blob: blobs[i],
    inSec: clip.inSec,
    outSec: clip.outSec,
    muted: clip.muted,
    volume: clip.volume,
    ...(clip.source !== undefined ? { source: clip.source } : {}),
    ...(clip.startSec !== undefined ? { startSec: clip.startSec } : {}),
  }));
}

/**
 * The engine's options for a gathered stitch. A Track sequence passes the loop count alone, as it always did, and a
 * lined-up stack its overlap as before; audio clips only when the audio is not legacy-shaped.
 */
export function stitchEngineOptions(g: Pick<GatheredStitch, "loopCount" | "placed" | "stack" | "audioClips">): StitchOptions {
  return {
    loopCount: g.loopCount,
    ...(g.placed
      ? { overlapSec: g.placed.overlapSec, crossfade: g.placed.crossfade, placed: true }
      : g.stack
        ? { overlapSec: g.stack.overlapSec, crossfade: g.stack.crossfade }
        : {}),
    ...(g.audioClips ? { audioClips: g.audioClips } : {}),
  };
}

/** What the asset library records about a stitch's settings. */
export function stitchRecordParameters(g: GatheredStitch): Record<string, unknown> {
  return {
    clips: g.clipCount,
    loopCount: g.loopCount,
    withAudio: g.music !== null || (g.audioClips?.length ?? 0) > 0,
    ...(g.audioClips ? { audioClips: g.audioClips.length } : {}),
    ...(g.placed
      ? {
          crossfade: g.placed.crossfade,
          overlapSec: g.placed.overlapSec,
          starts: g.clips.map((clip) => clip.startSec ?? null),
        }
      : g.stack
        ? { overlapSec: g.stack.overlapSec, crossfade: g.stack.crossfade }
        : {}),
  };
}

/** Everything a stitch needs, in timeline order. Throws before any fetch when fewer than 2 clips can play. */
export async function gatherStitchInputs(
  ctx: NodeExecutionContext,
  data: VideoStitchNodeData
): Promise<GatheredStitch> {
  const { node, signal } = ctx;
  const nodes = ctx.getNodes();
  const edges = ctx.getEdges();
  const dimmed = (ctx.get?.() as { dimmedNodeIds?: Set<string> } | undefined)?.dimmedNodeIds;
  const inputs = ctx.getConnectedInputs(node.id);

  // Music is read from output, as the stitch always did; the card reads it from the graph
  const musicUrl = inputs.audio[0] || null;
  const hasMusic = musicUrl !== null;
  const liveEdgeIds = stitchVideoEdgeIds(node.id, edges);
  const draft = readStitchDraft(data, { liveEdgeIds, hasMusic });
  const legacy = isLegacyStitch(data);

  const pending: PendingClip[] = [];
  const fromInputs = liveEdgeIds.length === 0 && !draft.timeline.some((c) => c.source.kind === "asset");
  const layout = draft.sequenceLayout;
  // Every clip of the timeline counts, one whose edge has no video yet included: the engine routes by this, not by
  // which starts reach it
  const placed =
    layout.mode === "stacked" && !legacy && !fromInputs && isPlaced(draft.timeline)
      ? { crossfade: layout.crossfade, overlapSec: layout.overlapSec }
      : null;
  if (fromInputs) {
    // No video edges to read (a context without edges): the connected videos, whole, in order
    for (const url of inputs.videos) {
      pending.push({ media: { kind: "url", url }, inSec: 0, outSec: null, muted: hasMusic, volume: 1 });
    }
  } else {
    draft.timeline.forEach((clip, index) => {
      const trim = clipTrim(clip, placed);
      if (clip.source.kind === "asset") {
        pending.push({
          media: { kind: "asset", assetId: clip.source.assetId, position: index + 1 },
          ...trim,
          ...(legacy ? {} : { source: sourceKey(clip.source) }),
        });
      } else if (legacy) {
        // Every video the edge carries, as the stitch always took them; none yet = not generated
        for (const url of resolveEdgeVideos(node.id, clip.source.edgeId, nodes, edges, dimmed)) {
          pending.push({ media: { kind: "url", url }, ...trim });
        }
      } else {
        const url = resolveEdgeVideo(node.id, clip.source.edgeId, nodes, edges, dimmed);
        // Split pieces share the key, so the engine joins them with a cut
        if (url) pending.push({ media: { kind: "url", url }, ...trim, source: sourceKey(clip.source) });
      }
    });
  }

  if (pending.length < 2) throw new Error(TOO_FEW_CLIPS);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const clips = await fetchClipBlobs(pending, signal);

  let music: StitchMusicInput | null = null;
  let audioClips: StitchAudioClipInput[] | null = null;
  // Decided by what the audio is now, never by whether audioClips is stored: a stored [] plays as the key's absence
  if (isLegacyAudioShape(draft.audioClips)) {
    const { curve, muted } = musicAudio(draft);
    if (musicUrl && !muted) {
      const { prepareAudioAsync } = await import("@/hooks/useAudioMixing");
      const audio = await prepareAudioAsync(await fetchMusicBlob(musicUrl), 0);
      if (audio) {
        music = { audio, curve, muted: false };
      } else if (legacy || fromInputs) {
        // Music that would not decode never replaced the clips' sound
        for (const clip of clips) clip.muted = false;
      }
    }
  } else {
    audioClips = await gatherAudioClipInputs(draft.audioClips, { musicUrl, signal });
  }

  // Without edges the clips play whole and carry no source keys: stacking them would dissolve where the editor shows cuts
  const stack =
    layout.mode === "stacked" && layout.overlapSec > 0 && !fromInputs
      ? { overlapSec: layout.overlapSec, crossfade: layout.crossfade }
      : null;

  return { clips, music, audioClips, loopCount: draft.loopCount, clipCount: clips.length, stack, placed };
}

/**
 * What an edit project's draft encodes: its library clips (one is enough) and its library audio clips, by the
 * node's rules for a non-legacy node with no edges or music, so the same asset clips encode the same as the node.
 */
export async function gatherDraftInputs(draft: StitchDraft, signal?: AbortSignal): Promise<GatheredStitch> {
  const layout = draft.sequenceLayout;
  const placed =
    layout.mode === "stacked" && isPlaced(draft.timeline)
      ? { crossfade: layout.crossfade, overlapSec: layout.overlapSec }
      : null;
  const pending: PendingClip[] = draft.timeline.flatMap((clip, index) =>
    clip.source.kind === "asset"
      ? [
          {
            media: { kind: "asset", assetId: clip.source.assetId, position: index + 1 },
            ...clipTrim(clip, placed),
            source: sourceKey(clip.source),
          },
        ]
      : [],
  );
  if (pending.length === 0) throw new Error(NO_CLIP_TO_RENDER);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const clips = await fetchClipBlobs(pending, signal);
  const audioClips = isLegacyAudioShape(draft.audioClips)
    ? null
    : await gatherAudioClipInputs(draft.audioClips, { musicUrl: null, signal });
  const stack =
    layout.mode === "stacked" && layout.overlapSec > 0
      ? { overlapSec: layout.overlapSec, crossfade: layout.crossfade }
      : null;
  return { clips, music: null, audioClips, loopCount: draft.loopCount, clipCount: clips.length, stack, placed };
}
