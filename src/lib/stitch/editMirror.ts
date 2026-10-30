/**
 * A node's edit as an edit project: the mirror the dialog's Save and Done
 * write to the Edits folder, so the sequence finished on a node is listed
 * in the Edit video view too.
 *
 * An edit project holds clips by asset library id only. A node's clips come
 * from its sockets (and its music from the `audio` socket), so each of those
 * is replaced by the library asset its video or sound is; a clip whose media
 * the library does not hold (an upload, a tool's output with no record) is
 * left out and counted. Pure: the caller resolves sockets to assets.
 */

import type { StitchAudioClip, StitchTimelineClip } from "@/types";
import type { StitchDraft } from "./draft";
import { sourceKey, type SourceDurations } from "./timeline";

export interface MirrorSources {
  /** The library asset the edge's clip plays, or null when it is not in the library. */
  videoAssetOfEdge(edgeId: string): string | null;
  /** The library asset the node's music is, or null. */
  musicAsset(): string | null;
}

export interface MirroredEdit {
  /** The draft with asset sources only; audio rows as they were (the sequence builder compacts them). */
  draft: StitchDraft;
  /** The measured lengths keyed by the asset sources the edge clips became, for the summary. */
  durations: SourceDurations;
  /** Clips (video and audio) left out because their media is not in the library. */
  leftOut: number;
}

/** The node's draft as an edit project's: sockets replaced by the assets they play, the rest kept clip for clip. */
export function mirrorDraft(draft: StitchDraft, sources: MirrorSources, measured: SourceDurations): MirroredEdit {
  let leftOut = 0;
  const durations = new Map<ReturnType<typeof sourceKey>, number>(measured);
  const timeline: StitchTimelineClip[] = [];
  for (const clip of draft.timeline) {
    if (clip.source.kind === "asset") {
      timeline.push(clip);
      continue;
    }
    const assetId = sources.videoAssetOfEdge(clip.source.edgeId);
    if (!assetId) {
      leftOut++;
      continue;
    }
    const source = { kind: "asset" as const, assetId };
    const length = measured.get(sourceKey(clip.source));
    if (length !== undefined && !durations.has(sourceKey(source))) durations.set(sourceKey(source), length);
    timeline.push({ ...clip, source });
  }
  const audioClips: StitchAudioClip[] = [];
  let music: string | null | undefined;
  for (const clip of draft.audioClips) {
    if (clip.source.kind === "asset") {
      audioClips.push(clip);
      continue;
    }
    if (music === undefined) music = sources.musicAsset();
    if (!music) {
      leftOut++;
      continue;
    }
    audioClips.push({ ...clip, source: { kind: "asset", assetId: music } });
  }
  return {
    draft: { ...draft, timeline, audioClips, legacyAudio: { curve: [], muted: false } },
    durations,
    leftOut,
  };
}

/** Nothing to list: no clip of any kind survived. */
export function mirrorIsEmpty(mirror: Pick<MirroredEdit, "draft">): boolean {
  return mirror.draft.timeline.length === 0 && mirror.draft.audioClips.length === 0;
}
