import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/shallow";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchAssetInfo } from "@/hooks/useStitchAssetInfo";
import { useStitchMediaInfo, type StitchMediaEntry } from "@/hooks/useStitchMediaInfo";
import { modelLabel, operationLabel } from "@/components/assets/assetFormat";
import { assetFileUrl } from "@/lib/assets/client/api";
import { assetName } from "@/lib/assets/name";
import type { AssetView } from "@/lib/assets/types";
import type { EditAssetSnapshot } from "@/lib/edits/types";
import { audioSourceKey, type AudioSourceKey } from "@/lib/stitch/audioClips";
import { nodeKindLabel, nodeModelLabel } from "@/lib/stitch/labels";
import { requestAssetInfo } from "@/lib/stitch/assetInfo";
import { assetMediaKey, mediaKeyOf, retryMediaInfo } from "@/lib/stitch/mediaInfo";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { edgeClipSourcesFromTuple, edgeClipSourceTuple, stitchMusicEdge, stitchMusicMedia } from "@/lib/stitch/sources";
import { sourceKey, type SourceKey } from "@/lib/stitch/timeline";
import { getWaveform, requestWaveform, subscribeWaveform } from "@/lib/stitch/waveformCache";
import type { AudioInputNodeData, StitchAudioSource, WorkflowEdge, WorkflowNode } from "@/types";

/**
 * What the editor shows for each clip of its draft, read live from the
 * workflow store (whether a source has run, and what it holds) and from the
 * shared media cache (length, size, rate, frames). Nothing here is written
 * to node data; the durations go to the editor's own store.
 */

export interface ClipMediaView {
  clipId: string;
  key: SourceKey;
  /** What a <video> plays: the source's output, or the library file. null: the source has not run. */
  src: string | null;
  mediaKey: string | null;
  status: "empty" | "loading" | "ready" | "error";
  /** D, the source's full length. */
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: ReadonlyArray<string | null>;
  sourceNodeId: string | null;
  /**
   * What the clip's context menu names it by, under its heading: the model ("Veo 3.1"), else the node's kind ("Ease
   * curve"). A library clip: the model it was made with, else what made it ("Video edit"), else "Library".
   */
  sourceLabel: string;
  /** Where it comes from, for the rail's line ("Generate video · Veo 3.1", "Library · Veo 3.1"); see RailSource. */
  railSource: RailSource;
  /** A library clip the library no longer has (or whose file is gone): an error slot that counts 0 s. */
  missing: boolean;
}

/** What the editor shows for one audio clip, read like ClipMediaView. */
export interface AudioClipView {
  clipId: string;
  key: AudioSourceKey;
  source: StitchAudioSource;
  /** What an <audio> plays: the connected music, or the library file. null: no music is connected or delivered. */
  src: string | null;
  /** The waveform cache's key for src. */
  mediaKey: string | null;
  /** The music's file name, or the library file's display name. */
  fileName: string;
  /** Where it comes from, for the rail's line ("Audio Input", "Library · Kling 3"); see RailSource. */
  railSource: RailSource;
  /** The decoded file's length (the encoder's decode); null until then, and for a file that cannot be read. */
  duration: number | null;
  /** The library record's length, used for drawing and overlap checks until the decode; null when it has none. */
  recordDuration: number | null;
  /** empty: no music connected; error: the file cannot be decoded. */
  status: "empty" | "loading" | "ready" | "error";
  /** A library clip the library no longer has. */
  missing: boolean;
}

/**
 * Where a clip comes from, as the rail's line names it before the clip's length: its kind ("Generate video",
 * "Library", "Not in the library"), then what made it (the model), or a lost clip's file name; null when that would
 * only repeat the kind.
 */
export interface RailSource {
  kind: string;
  detail: string | null;
}

/** A library clip's kind. The Edit video view's rail leaves it out, since every clip of an edit is the library's. */
export const LIBRARY_SOURCE = "Library";

const NO_FRAMES: ReadonlyArray<string | null> = [];
const EMPTY: string[] = [];
const LABEL_WIDTH = 3;
const LIBRARY = LIBRARY_SOURCE;

/** A library clip's source label, from its record: the model, else the operation, else "Library". */
function assetSourceLabel(asset: AssetView | null | undefined): string {
  return (asset && (modelLabel(asset.model) ?? operationLabel(asset.producer?.operation))) || LIBRARY;
}

/**
 * The labels of each node feeding a live video edge, as primitives, [nodeId, kind, model, …], for a useShallow
 * selector beside edgeClipSourceTuple (which carries the edges' media).
 */
function sourceLabelTuple(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const tuple: string[] = [];
  const seen = new Set<string>();
  const live = new Set(stitchVideoEdgeIds(nodeId, edges));
  for (const edge of edges) {
    if (!live.has(edge.id) || seen.has(edge.source)) continue;
    const node = nodes.find((n) => n.id === edge.source);
    if (!node) continue;
    seen.add(node.id);
    tuple.push(node.id, nodeKindLabel(node), nodeModelLabel(node) ?? "");
  }
  return tuple;
}

/** The music edge's source node, as primitives: [nodeId, file name, kind]. The edge is found by the shared rule. */
function musicSourceTuple(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[], dimmed?: Set<string>): string[] {
  const edge = stitchMusicEdge(nodeId, edges, dimmed, nodes);
  const node = edge ? nodes.find((n) => n.id === edge.source) : undefined;
  if (!node) return EMPTY;
  const fileName = node.type === "audioInput" ? (node.data as AudioInputNodeData).filename : null;
  return [node.id, fileName || "Audio", nodeKindLabel(node)];
}

/** One waveform's state as a primitive, for a snapshot over several keys. */
function waveformState(key: string): string {
  const waveform = getWaveform(key);
  return waveform ? `${waveform.status}:${waveform.duration ?? ""}` : "";
}

export interface StitchEditorMediaOptions {
  /**
   * What an edit project's file says about an asset: a library clip the library has lost is named by it ("Not in the
   * library · sunset.mp4") rather than left as "Library". The node's dialog passes none.
   */
  assetFallback?: (assetId: string) => EditAssetSnapshot | undefined;
}

const NOT_IN_LIBRARY = "Not in the library";

export function useStitchEditorMedia({ assetFallback }: StitchEditorMediaOptions = {}): {
  byClip: ReadonlyMap<string, ClipMediaView>;
  audioByClip: ReadonlyMap<string, AudioClipView>;
} {
  const nodeId = useStitchEditorStore((s) => s.nodeId);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  const audioClips = useStitchEditorStore((s) => s.draft?.audioClips);
  const setDurations = useStitchEditorStore((s) => s.setDurations);
  const setAudioDurations = useStitchEditorStore((s) => s.setAudioDurations);

  const edgeTuple = useWorkflowStore(
    useShallow((s) => (nodeId ? edgeClipSourceTuple(nodeId, s.nodes, s.edges, s.dimmedNodeIds) : EMPTY)),
  );
  const labelTuple = useWorkflowStore(useShallow((s) => (nodeId ? sourceLabelTuple(nodeId, s.nodes, s.edges) : EMPTY)));
  const musicMedia = useWorkflowStore((s) =>
    nodeId ? stitchMusicMedia(nodeId, s.nodes, s.edges, s.dimmedNodeIds) : null,
  );
  const musicTuple = useWorkflowStore(
    useShallow((s) => (nodeId ? musicSourceTuple(nodeId, s.nodes, s.edges, s.dimmedNodeIds) : EMPTY)),
  );

  const edgeViews = useMemo(() => {
    const labels = new Map<string, { kind: string; model: string | null }>();
    for (let i = 0; i + LABEL_WIDTH <= labelTuple.length; i += LABEL_WIDTH) {
      const [sourceNodeId, kind, model] = labelTuple.slice(i, i + LABEL_WIDTH);
      labels.set(sourceNodeId, { kind, model: model || null });
    }
    const views = new Map<string, { sourceNodeId: string | null; media: string | null; kind: string; model: string | null }>();
    for (const source of edgeClipSourcesFromTuple(edgeTuple).values()) {
      const label = source.sourceNodeId ? labels.get(source.sourceNodeId) : undefined;
      views.set(source.edgeId, {
        sourceNodeId: source.sourceNodeId,
        media: source.media,
        kind: label?.kind ?? "",
        model: label?.model ?? null,
      });
    }
    return views;
  }, [edgeTuple, labelTuple]);

  // Where each clip's video is read from
  const sources = useMemo(
    () =>
      (timeline ?? []).map((clip) => {
        if (clip.source.kind === "asset") {
          const assetId = clip.source.assetId;
          return { clip, src: assetFileUrl(assetId), mediaKey: assetMediaKey(assetId), edge: null };
        }
        const edge = edgeViews.get(clip.source.edgeId) ?? null;
        const src = edge?.media ?? null;
        return { clip, src, mediaKey: src ? mediaKeyOf(src) : null, edge };
      }),
    [timeline, edgeViews],
  );

  const assetIds = useMemo(
    () =>
      [...(timeline ?? []), ...(audioClips ?? [])].flatMap((clip) =>
        clip.source.kind === "asset" ? [clip.source.assetId] : [],
      ),
    [timeline, audioClips],
  );
  const assets = useStitchAssetInfo(assetIds);

  const entries = useMemo(() => {
    const seen = new Map<string, StitchMediaEntry>();
    for (const { src, mediaKey } of sources) if (src && mediaKey) seen.set(mediaKey, { key: mediaKey, src });
    return [...seen.values()];
  }, [sources]);
  const infos = useStitchMediaInfo(entries, "filmstrip");

  // A library file that could not be read is read again once for each record the library gives for it (the
  // editor reads every record again when it opens), so a file found again since is measured as the encode will
  // read it, not counted 0 s for the session. The record a key was last seen with is kept, so a file that still
  // fails is not read in a loop
  const seenRecord = useRef(new Map<string, AssetView>());
  // The other way round: a file that fails while its record says it is there is asked about once more. The library
  // checks a file at most every 30 s, so a record read just before the file was deleted still says it is there;
  // the failed read has since marked it missing, and the clip then says it is not in the library
  const recheckedRecord = useRef(new Set<string>());
  useEffect(() => {
    for (const { clip, mediaKey } of sources) {
      if (clip.source.kind !== "asset" || !mediaKey) continue;
      const asset = assets.get(clip.source.assetId);
      const info = infos.get(mediaKey);
      if (!asset || !info) continue;
      if (info.status === "error" && !asset.missing && !recheckedRecord.current.has(mediaKey)) {
        recheckedRecord.current.add(mediaKey);
        requestAssetInfo([clip.source.assetId], { refresh: true });
      }
      if (seenRecord.current.get(mediaKey) === asset) continue;
      seenRecord.current.set(mediaKey, asset);
      if (info.status === "error") retryMediaInfo(mediaKey);
    }
  }, [sources, assets, infos]);

  const byClip = useMemo(() => {
    const views = new Map<string, ClipMediaView>();
    for (const { clip, src, mediaKey, edge } of sources) {
      const info = mediaKey ? infos.get(mediaKey) : undefined;
      const asset = clip.source.kind === "asset" ? assets.get(clip.source.assetId) : undefined;
      // Gone: the library no longer has the record, or its record says the file is missing and the file
      // could not be read either. The file route checks the file again on every read (as the encode does), so
      // a file found again since the record was written is a clip, whatever the stale flag says
      const missing =
        clip.source.kind === "asset" && (asset === null || (asset?.missing === true && info?.status !== "ready"));
      // A clip the library lost counts no time, whatever an earlier read of its file found
      const duration = info?.status === "ready" && !missing ? info.duration : null;
      // An edge clip whose edge went away while the editor was open is still a video, not a library clip
      const kind = clip.source.kind === "asset" ? LIBRARY : edge?.kind || "Video";
      const model = clip.source.kind === "asset" ? assetSourceLabel(asset) : (edge?.model ?? null);
      const lost = missing && clip.source.kind === "asset" ? assetFallback?.(clip.source.assetId) : undefined;
      views.set(clip.id, {
        clipId: clip.id,
        key: sourceKey(clip.source),
        src,
        mediaKey,
        status: !src ? "empty" : missing ? "error" : (info?.status ?? "loading"),
        duration,
        width: info?.width ?? null,
        height: info?.height ?? null,
        fps: info?.fps ?? null,
        frames: info?.frames ?? NO_FRAMES,
        sourceNodeId: edge?.sourceNodeId ?? null,
        sourceLabel: lost ? lost.name : (model ?? kind),
        railSource: lost ? { kind: NOT_IN_LIBRARY, detail: lost.name } : { kind, detail: model !== kind ? model : null },
        missing,
      });
    }
    return views;
  }, [sources, infos, assets, assetFallback]);

  // The ready lengths go to the store, where the timeline maths reads them; only when they change
  useEffect(() => {
    const next = new Map<SourceKey, number>();
    for (const view of byClip.values()) if (view.duration !== null) next.set(view.key, view.duration);
    const current = useStitchEditorStore.getState().durations;
    const same = current.size === next.size && [...next].every(([key, value]) => current.get(key) === value);
    if (!same) setDurations(next);
  }, [byClip, setDurations]);

  // Every audio source in the draft is decoded, rows scrolled out of view too, so every length is known. A file the
  // library is known no longer to have is not asked for
  const audioSources = useMemo(() => {
    const sources = new Map<AudioSourceKey, { src: string | null; mediaKey: string | null }>();
    for (const clip of audioClips ?? []) {
      const key = audioSourceKey(clip.source);
      if (sources.has(key)) continue;
      const src = clip.source.kind === "music" ? musicMedia : assetFileUrl(clip.source.assetId);
      sources.set(key, { src, mediaKey: src ? mediaKeyOf(src) : null });
    }
    return sources;
  }, [audioClips, musicMedia]);
  const wanted = useMemo(
    () =>
      [...audioSources].flatMap(([key, { src, mediaKey }]) =>
        src && mediaKey && !(key.startsWith("asset:") && assets.get(key.slice("asset:".length)) === null)
          ? [{ src, mediaKey }]
          : [],
      ),
    [audioSources, assets],
  );
  const wantedKey = wanted.map((w) => `${w.mediaKey}\t${w.src}`).join("\n");
  useEffect(() => {
    for (const { mediaKey, src } of wanted) requestWaveform(mediaKey, src);
    // The keys are the sources' identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey]);
  const waveformKeys = useMemo(
    () => [...audioSources.values()].flatMap(({ mediaKey }) => (mediaKey ? [mediaKey] : [])),
    [audioSources],
  );
  const waveformSnapshot = useCallback(() => waveformKeys.map(waveformState).join("|"), [waveformKeys]);
  const waveforms = useSyncExternalStore(subscribeWaveform, waveformSnapshot, waveformSnapshot);

  const audioByClip = useMemo(() => {
    const views = new Map<string, AudioClipView>();
    const [, musicFileName, musicKind] = musicTuple;
    for (const clip of audioClips ?? []) {
      const key = audioSourceKey(clip.source);
      const { src, mediaKey } = audioSources.get(key) ?? { src: null, mediaKey: null };
      const waveform = mediaKey ? getWaveform(mediaKey) : undefined;
      const asset = clip.source.kind === "asset" ? assets.get(clip.source.assetId) : undefined;
      // As for video clips: a stale "missing" flag on a file that decodes is not missing
      const missing =
        clip.source.kind === "asset" && (asset === null || (asset?.missing === true && waveform?.status !== "ready"));
      const duration = waveform?.status === "ready" && !missing ? waveform.duration : null;
      const recordDuration = typeof asset?.durationSec === "number" ? asset.durationSec : null;
      const kind = clip.source.kind === "music" ? musicKind || "Audio" : LIBRARY;
      const model = clip.source.kind === "asset" ? assetSourceLabel(asset) : null;
      const lost = missing && clip.source.kind === "asset" ? assetFallback?.(clip.source.assetId) : undefined;
      views.set(clip.id, {
        clipId: clip.id,
        key,
        source: clip.source,
        src,
        mediaKey,
        fileName: clip.source.kind === "music" ? musicFileName || "Audio" : (asset && assetName(asset)) || lost?.name || "Audio",
        railSource: lost ? { kind: NOT_IN_LIBRARY, detail: lost.name } : { kind, detail: model !== kind ? model : null },
        duration,
        recordDuration,
        status: !src ? "empty" : (waveform?.status ?? "loading"),
        missing,
      });
    }
    return views;
    // waveforms: the cache changed, so read it again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioClips, audioSources, assets, musicTuple, waveforms, assetFallback]);

  // The decoded lengths go to the store's own map, so video layouts do not recompute when audio loads
  useEffect(() => {
    const next = new Map<AudioSourceKey, number>();
    for (const view of audioByClip.values()) if (view.duration !== null) next.set(view.key, view.duration);
    const current = useStitchEditorStore.getState().audioDurations;
    const same = current.size === next.size && [...next].every(([key, value]) => current.get(key) === value);
    if (!same) setAudioDurations(next);
  }, [audioByClip, setAudioDurations]);

  return { byClip, audioByClip };
}
