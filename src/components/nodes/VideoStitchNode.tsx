"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, Film, LibraryBig, TriangleAlert, VolumeX, X } from "lucide-react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import {
  ChipGroup,
  ControlsCard,
  EmptyState,
  Field,
  FieldRow,
  PanelButton,
  ScrubRow,
  Spinner,
  SummaryValues,
  formatTime,
  type SocketSpec,
} from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import type { StitchTimelineClip, VideoStitchNodeData } from "@/types";
import { isLegacyAudioShape } from "@/lib/stitch/audioClips";
import { draftDuration, draftSpans, readStitchDraft, type StitchReadContext } from "@/lib/stitch/draft";
import { isLegacyStitch, stitchOrderPatch } from "@/lib/stitch/migrate";
import { edgeClipSourceTuple, edgeClipSourcesFromTuple, stitchReadContext } from "@/lib/stitch/sources";
import {
  clipLength,
  edgeIdsInOrder,
  isPlaced,
  moveClip,
  sourceKey,
  spansEnvelope,
  type SourceDurations,
  type SourceKey,
} from "@/lib/stitch/timeline";
import { placedCardItems } from "@/lib/stitch/placement";
import { formatSeconds, formatTileSeconds } from "@/lib/stitch/timecode";
import { assetMediaKey, mediaKeyOf, nearestFrame, type StitchMediaInfo } from "@/lib/stitch/mediaInfo";
import { assetFileUrl } from "@/lib/assets/client/api";
import { openStitchEditor } from "@/components/stitch/openStitchEditor";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useStitchMediaInfo, type StitchMediaEntry } from "@/hooks/useStitchMediaInfo";
import { useStitchAssetInfo } from "@/hooks/useStitchAssetInfo";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { PaintPending, useDerivedNodeData, useUpdateNodeData, useNodeUiState } from "./paintMode";

type VideoStitchNodeType = Node<VideoStitchNodeData, "videoStitch">;

/** One filmstrip tile: a timeline clip and where its video is read from (null: its source has not run). */
interface CardClip {
  clip: StitchTimelineClip;
  src: string | null;
  mediaKey: string | null;
}

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Output" }];
const EMPTY_HEIGHT = 120;
const LOOP_OPTIONS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
];
const SUMMARY_ICON = <Film size={14} strokeWidth={1.75} />;
/** The sequence each Edit Video node's card last wrote back (see the write-back effect). */
const lastWrittenOrder = new Map<string, string>();

export function __resetStitchWritesForTests(): void {
  lastWrittenOrder.clear();
}

export function VideoStitchNode({ id, data, selected }: NodeProps<VideoStitchNodeType>) {
  const nodeData = data;
  const updateNodeData = useUpdateNodeData();
  const deriveNodeData = useDerivedNodeData();
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);
  const videoAutoplayRef = useVideoAutoplay(id, videoBlobUrl);
  const [expanded, setExpanded] = useNodeUiState(id, "expanded", true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Check encoder support on mount
  useEffect(() => {
    if (nodeData.encoderSupported === null) {
      checkEncoderSupport().then((supported) => {
        deriveNodeData(id, { encoderSupported: supported });
      });
    }
  }, [id, nodeData.encoderSupported, deriveNodeData]);

  // What the card reads from the graph, as primitives so the card only
  // re-renders when the edges into it or its music connection change
  const contextTuple = useWorkflowStore(
    useShallow((state) => {
      const ctx = stitchReadContext(id, state.nodes, state.edges, state.dimmedNodeIds);
      return [ctx.hasMusic ? "music" : "", ...ctx.liveEdgeIds];
    })
  );
  const readContext = useMemo<StitchReadContext>(
    () => ({ hasMusic: contextTuple[0] === "music", liveEdgeIds: contextTuple.slice(1) }),
    [contextTuple]
  );
  // Each edge's source and video, resolved the way the executor resolves it
  const sourceTuple = useWorkflowStore(
    useShallow((state) => edgeClipSourceTuple(id, state.nodes, state.edges, state.dimmedNodeIds))
  );
  const clipSources = useMemo(() => edgeClipSourcesFromTuple(sourceTuple), [sourceTuple]);
  // Sockets follow every video edge, loops included: one per edge plus a free
  // one, and never fewer than the highest in use, since handles are never
  // renumbered and after a middle clip is removed a later edge still needs its socket
  const videoSocketCount = useWorkflowStore((state) => {
    let count = 0;
    let highest = -1;
    for (const e of state.edges) {
      if (e.target !== id || !e.targetHandle?.startsWith("video-")) continue;
      count++;
      const index = Number(e.targetHandle.slice("video-".length));
      if (Number.isInteger(index) && index > highest) highest = index;
    }
    return Math.max(count + 1, highest + 2, 2);
  });

  // The sequence, migrated and reconciled on read (never written just by reading).
  // Keyed on the fields it reads, so a status or output write keeps the same tiles.
  const { timeline, clipOrder, audioCurve, audioMuted, audioClips, loopCount, sequenceLayout } = nodeData;
  const draft = useMemo(
    () => readStitchDraft({ timeline, clipOrder, audioCurve, audioMuted, audioClips, loopCount, sequenceLayout }, readContext),
    [timeline, clipOrder, audioCurve, audioMuted, audioClips, loopCount, sequenceLayout, readContext]
  );

  // Write back only when the edges changed what is stored: a legacy node keeps
  // writing clipOrder alone, a node the editor wrote gets its timeline too
  // (the store already wrote a new connection's clip, appendConnectedStitchClips,
  // so this catches only what reached the node another way).
  // The draft only says when to look. The write is built from one store
  // snapshot, because the data prop catches up with the store a render after
  // the edges do, and a patch built from it would replace a newer timeline.
  useEffect(() => {
    const state = useWorkflowStore.getState();
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    const stored = node.data as VideoStitchNodeData;
    const fresh = readStitchDraft(stored, stitchReadContext(id, state.nodes, state.edges, state.dimmedNodeIds));
    const legacy = isLegacyStitch(stored);
    let saved: string[];
    if (legacy) {
      // An older card counted loop edges into clipOrder; they are not clips, so they do not make it stale
      const loopEdgeIds = new Set(
        state.edges.filter((e) => e.target === id && e.data?.isLoop).map((e) => e.id)
      );
      saved = (Array.isArray(stored.clipOrder) ? stored.clipOrder : []).filter((edgeId) => !loopEdgeIds.has(edgeId));
    } else {
      saved = (stored.timeline ?? []).map((c) => c?.id);
    }
    const current = legacy ? edgeIdsInOrder(fresh.timeline) : fresh.timeline.map((c) => c.id);
    if (current.length === saved.length && current.every((v, i) => v === saved[i])) return;

    // Skip a sequence this card already wrote. Undo can restore the data from
    // before that write; every reader reconciles on read, so leaving it is
    // harmless, while writing again would put a new step on the undo stack
    // each time and Undo could never get past it. Kept per node, not per
    // mount: on the GPU canvas the node is mounted afresh for each paint.
    const key = current.join("\n");
    if (lastWrittenOrder.get(id) === key) return;
    lastWrittenOrder.set(id, key);
    deriveNodeData(id, stitchOrderPatch(stored, fresh.timeline));
  }, [draft, id, deriveNodeData]);

  // The card's tiles: every clip of the sequence, with where its video is read from
  const cardClips = useMemo<CardClip[]>(
    () =>
      draft.timeline.map((clip) => {
        if (clip.source.kind === "asset") {
          return { clip, src: assetFileUrl(clip.source.assetId), mediaKey: assetMediaKey(clip.source.assetId) };
        }
        const media = clipSources.get(clip.source.edgeId)?.media ?? null;
        return { clip, src: media, mediaKey: media ? mediaKeyOf(media) : null };
      }),
    [draft.timeline, clipSources]
  );

  // Lengths and posters from the cache the editor shares (never node data).
  // A trimmed clip (a split piece is one) needs frames inside its own range,
  // which the single poster frame is not, so its source gets the filmstrip.
  const mediaEntries = useMemo(() => {
    const seen = new Map<string, StitchMediaEntry>();
    for (const { clip, src, mediaKey } of cardClips) {
      if (!src || !mediaKey) continue;
      const trimmed = clip.inSec > 0 || clip.outSec !== null;
      const entry = seen.get(mediaKey);
      if (!entry) seen.set(mediaKey, { key: mediaKey, src, level: trimmed ? "filmstrip" : "poster" });
      else if (trimmed) entry.level = "filmstrip";
    }
    return [...seen.values()];
  }, [cardClips]);
  const mediaInfo = useStitchMediaInfo(mediaEntries, "poster");
  // The library's records for the library clips, read again when the card mounts and whenever the editor or a run
  // reads them. A clip the library lost counts no time, as in the editor and the run (useStitchEditorMedia's rule):
  // no record, or a record whose file is missing and a file that does not read either
  const assetIds = useMemo(
    () => draft.timeline.flatMap((clip) => (clip.source.kind === "asset" ? [clip.source.assetId] : [])),
    [draft.timeline]
  );
  const assets = useStitchAssetInfo(assetIds);
  const goneAssets = useMemo(() => {
    const gone = new Set<string>();
    for (const { clip, mediaKey } of cardClips) {
      if (clip.source.kind !== "asset") continue;
      const asset = assets.get(clip.source.assetId);
      const info = mediaKey ? mediaInfo.get(mediaKey) : undefined;
      if (asset === null || (asset?.missing === true && info?.status !== "ready")) gone.add(clip.source.assetId);
    }
    return gone;
  }, [cardClips, assets, mediaInfo]);
  const durations = useMemo<SourceDurations>(() => {
    const known = new Map<SourceKey, number>();
    for (const { clip, mediaKey } of cardClips) {
      if (clip.source.kind === "asset" && goneAssets.has(clip.source.assetId)) continue;
      const info = mediaKey ? mediaInfo.get(mediaKey) : undefined;
      if (info?.status === "ready" && info.duration !== null) known.set(sourceKey(clip.source), info.duration);
    }
    return known;
  }, [cardClips, mediaInfo, goneAssets]);
  const sequenceSec = draftDuration(draft, durations);
  // Lined up: named only when some join really overlaps (a stack of cuts encodes as Track). Placed: counted from the
  // envelope, which has no one overlap value to name
  const stackedItem = useMemo(() => {
    const layout = draft.sequenceLayout;
    if (layout.mode !== "stacked") return [];
    const spans = draftSpans(draft, durations);
    if (isPlaced(draft.timeline)) return placedCardItems(spansEnvelope(spans, layout.crossfade));
    if (!spans.some((span) => span.overlapIn > 0)) return [];
    return [`${formatSeconds(layout.overlapSec, 1)} ${layout.crossfade ? "crossfade" : "overlap"}`];
  }, [draft, durations]);
  // Audio that is more than the music alone, whole from 0:00, is counted (it also loops by the new rule)
  const audioItem = isLegacyAudioShape(draft.audioClips)
    ? []
    : [`${draft.audioClips.length} audio clip${draft.audioClips.length === 1 ? "" : "s"}`];
  // The length is shown once it is settled: every clip with a source read
  // (or found unreadable) and at least one length known. Until then it would
  // read 0:00 and count up as each source is probed.
  const sequenceSettled =
    durations.size > 0 &&
    cardClips.every(({ mediaKey }) => !mediaKey || (mediaInfo.get(mediaKey)?.status ?? "loading") !== "loading");

  // How many clips read each edge: the last one's ✕ disconnects it
  const piecesByEdge = useMemo(() => {
    const counts = new Map<string, number>();
    for (const clip of draft.timeline) {
      if (clip.source.kind === "edge") counts.set(clip.source.edgeId, (counts.get(clip.source.edgeId) ?? 0) + 1);
    }
    return counts;
  }, [draft.timeline]);

  // Pointer-based drag reorder (HTML5 drag doesn't work inside React Flow nodes)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null);
  const [hoverClipId, setHoverClipId] = useState<string | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, clipId: string) => {
    // Only left mouse button
    if (e.button !== 0) return;
    e.stopPropagation();
    setDraggedClipId(clipId);
    setHoverClipId(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggedClipId) return;
    // Find which clip element the pointer is over
    const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elementsUnder) {
      const clipEl = (el as HTMLElement).closest("[data-clip-id]") as HTMLElement | null;
      if (clipEl) {
        const targetId = clipEl.dataset.clipId!;
        if (targetId !== draggedClipId) {
          setHoverClipId(targetId);
        }
        return;
      }
    }
    setHoverClipId(null);
  }, [draggedClipId]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Always release pointer capture to prevent capture leak
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* element may have been removed */ }

    if (!draggedClipId || !hoverClipId || draggedClipId === hoverClipId) {
      setDraggedClipId(null);
      setHoverClipId(null);
      return;
    }

    const draggedIndex = draft.timeline.findIndex((c) => c.id === draggedClipId);
    const targetIndex = draft.timeline.findIndex((c) => c.id === hoverClipId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      const moved = moveClip(draft.timeline, draggedIndex, targetIndex);
      if (moved !== draft.timeline) updateNodeData(id, stitchOrderPatch(nodeData, moved));
    }

    setDraggedClipId(null);
    setHoverClipId(null);
  }, [draggedClipId, hoverClipId, draft.timeline, nodeData, id, updateNodeData]);

  // Removing the last clip of an edge disconnects the edge (otherwise
  // reconciliation would bring the clip back); removing one piece of a split,
  // or a library clip, takes it out of the sequence and leaves the edge connected
  const handleRemoveClip = useCallback(
    (clip: StitchTimelineClip) => {
      if (clip.source.kind === "edge" && piecesByEdge.get(clip.source.edgeId) === 1) {
        removeEdge(clip.source.edgeId);
        return;
      }
      const next = draft.timeline.filter((c) => c.id !== clip.id);
      if (next.length !== draft.timeline.length) updateNodeData(id, stitchOrderPatch(nodeData, next));
    },
    [draft.timeline, piecesByEdge, nodeData, id, removeEdge, updateNodeData]
  );

  const handleStitch = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Dynamic video input sockets: one per connected clip plus a free slot,
  // and never fewer than the highest one in use.
  const inputSockets = useMemo<SocketSpec[]>(() => {
    const sockets: SocketSpec[] = Array.from({ length: videoSocketCount }, (_, i) => ({
      id: `video-${i}`,
      type: "video",
      label: `Video ${i + 1}`,
    }));
    sockets.push({ id: "audio", type: "audio", label: "Audio" });
    return sockets;
  }, [videoSocketCount]);

  const encoderChecking = nodeData.encoderSupported === null;
  const encoderUnsupported = nodeData.encoderSupported === false;
  const encoderReady = !encoderChecking && !encoderUnsupported;
  const showOutput = encoderReady && Boolean(nodeData.outputVideo) && nodeData.status !== "loading";

  const media = showOutput
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputVideo ? loadedAspect.aspect : 16 / 9 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const clipCount = draft.timeline.length;
  // A painted copy waits for its tiles' posters (PaintPending)
  const postersPending = cardClips.some(({ mediaKey }) => mediaKey && (mediaInfo.get(mediaKey)?.status ?? "loading") === "loading");
  const filmstrip = (
    <div className="overflow-y-auto nowheel grid grid-cols-4 content-start gap-1.5 p-1.5 bg-well rounded-well squircle shadow-well max-h-[140px]">
      <PaintPending pending={postersPending} />
      {cardClips.map(({ clip, src, mediaKey }, index) => {
        const info = mediaKey ? mediaInfo.get(mediaKey) : undefined;
        // Removing the last clip of an edge disconnects it (handleRemoveClip)
        const isLastPiece = clip.source.kind === "edge" && piecesByEdge.get(clip.source.edgeId) === 1;
        return (
          <div
            key={clip.id}
            data-clip-id={clip.id}
            onPointerDown={(e) => handlePointerDown(e, clip.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`nodrag relative w-full aspect-video rounded overflow-hidden bg-neutral-800 cursor-move transition-shadow group ${
              draggedClipId === clip.id
                ? "opacity-50 ring-1 ring-selection"
                : hoverClipId === clip.id && draggedClipId
                  ? "ring-2 ring-blue-400/60"
                  : "ring-1 ring-white/8"
            }`}
          >
            <ClipTileFace
              clip={clip}
              index={index}
              src={src}
              info={info}
              gone={clip.source.kind === "asset" && goneAssets.has(clip.source.assetId)}
            />
            <div className="absolute left-[3px] top-[3px] flex gap-[3px] text-neutral-300 drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.9)]">
              {clip.muted && (
                <span title="Clip audio muted" className="flex">
                  <VolumeX size={9} strokeWidth={2.5} aria-label="Clip audio muted" />
                </span>
              )}
              {clip.source.kind === "asset" && (
                <span title="From the library" className="flex">
                  <LibraryBig size={9} strokeWidth={2.5} aria-label="From the library" />
                </span>
              )}
            </div>
            <button
              onClick={() => handleRemoveClip(clip)}
              className="absolute top-0.5 right-0.5 w-4 h-4 bg-red-600/80 hover:bg-red-500 rounded text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              title={isLastPiece ? "Disconnect" : "Remove clip"}
            >
              <X size={10} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      media={media}
      inputs={inputSockets}
      outputs={OUTPUT_SOCKETS}
      minWidth={300}
      // The sockets can make the card taller than the clip: the clip grows to fill it (on black, behind a letterboxed output)
      cardClassName="flex flex-col"
      mediaClassName={showOutput ? "group grow bg-black" : "group grow"}
      gap={showOutput ? <ScrubRow videoRef={videoAutoplayRef} src={videoBlobUrl} className="w-full" /> : undefined}
      controls={
        <ControlsCard
          id={id}
          summary={{
            icon: SUMMARY_ICON,
            title: `${clipCount} clip${clipCount === 1 ? "" : "s"}`,
            // One loop, in m:ss as the scrub row reads the stitched video, so the two agree at 1×. The clip count stays
            // whole: a placed stack's longer values give way first, cut at their end. The audio count comes last, so
            // the loop count stays in view
            values: (
              <SummaryValues
                truncate
                items={[
                  sequenceSettled ? formatTime(sequenceSec) : "",
                  ...stackedItem,
                  `loop ${draft.loopCount}×`,
                  ...audioItem,
                ]}
              />
            ),
            className: "grid-cols-[16px_max-content_minmax(0,1fr)_auto]",
          }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          {clipCount > 0 ? (
            <FieldRow className="h-auto">
              <div className="w-full">{filmstrip}</div>
            </FieldRow>
          ) : (
            <span className="text-node text-neutral-500 py-1">No clips connected</span>
          )}
          <Field label="Loop">
            <ChipGroup
              value={String(draft.loopCount)}
              options={LOOP_OPTIONS}
              onChange={(v) => updateNodeData(id, { loopCount: Number(v) as 1 | 2 | 3 })}
            />
          </Field>
          <FieldRow className="justify-end">
            <PanelButton onClick={() => openStitchEditor(id)}>Open editor</PanelButton>
            <PanelButton
              primary
              onClick={handleStitch}
              disabled={clipCount < 2 || nodeData.status === "loading" || isRunning}
            >
              {nodeData.status === "loading" ? "Rendering…" : "Render"}
            </PanelButton>
          </FieldRow>
        </ControlsCard>
      }
    >
      {encoderUnsupported ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 bg-neutral-900/40">
          <TriangleAlert size={32} strokeWidth={1.5} className="text-neutral-500" />
          <span className="text-xs text-neutral-400">Your browser doesn&apos;t support video encoding.</span>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 underline"
          >
            Doesn&apos;t seem right? Message Willie on Discord.
          </a>
        </div>
      ) : encoderChecking ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-400 bg-neutral-900/40">
          <Spinner />
          <span className="text-xs">Checking encoder...</span>
        </div>
      ) : showOutput ? (
        <>
          <video
            ref={videoAutoplayRef}
            src={videoBlobUrl ?? undefined}
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0 && nodeData.outputVideo) {
                setLoadedAspect({ src: nodeData.outputVideo, aspect: v.videoWidth / v.videoHeight });
              }
            }}
          />
          <button
            onClick={() => updateNodeData(id, { outputVideo: null, status: "idle" })}
            className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Clear video"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </>
      ) : (
        <EmptyState message={clipCount === 0 ? "Connect videos to edit" : "Render to preview"} />
      )}

      {encoderReady && nodeData.status === "loading" && (
        <div className="absolute inset-0 bg-neutral-900/70 flex flex-col items-center justify-center gap-2">
          <Spinner size={24} className="text-white" />
          <span className="text-white text-xs">Processing... {Math.round(nodeData.progress)}%</span>
        </div>
      )}
    </NodeShell>
  );
}

/**
 * A tile's picture, or why there is none: a library clip the library no longer
 * has, a source that has not run, one that is still being read, one that
 * cannot be read, a trim that starts past the end of a source regenerated
 * shorter, or a trim left shorter than one frame. Only a readable clip shows
 * its length.
 */
function ClipTileFace({
  clip,
  index,
  src,
  info,
  gone,
}: {
  clip: StitchTimelineClip;
  index: number;
  src: string | null;
  info: StitchMediaInfo | undefined;
  gone: boolean;
}) {
  const alert = (title: string) => (
    <div className="w-full h-full flex items-center justify-center text-neutral-500" title={title}>
      <CircleAlert size={10} strokeWidth={1.75} aria-label={title} />
    </div>
  );
  if (gone) return alert("Not in the library");
  if (!src) return alert("Not generated yet");
  if (!info || info.status === "loading") {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Spinner size={14} className="text-neutral-500" />
      </div>
    );
  }
  if (info.status === "error" || info.duration === null) return alert("Can't read this video");
  if (clip.inSec >= info.duration) return alert("Trim starts past the end of this video");

  const length = clipLength(clip, info.duration);
  if (length === 0 && info.duration > 0) return alert("Trim is shorter than a frame");
  const poster = nearestFrame(info, clip.inSec + 0.25 * length);
  return (
    <>
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL the cache owns
        <img src={poster} alt={`Clip ${index + 1}`} className="w-full h-full object-cover" draggable={false} />
      ) : info.level === null || info.level === "metadata" ? (
        <div className="w-full h-full flex items-center justify-center">
          <Spinner size={14} className="text-neutral-500" />
        </div>
      ) : null}
      <span className="absolute right-[3px] bottom-[2px] font-mono text-[8px] leading-none text-neutral-200 [text-shadow:0_0_2px_rgb(0_0_0/0.9),0_1px_2px_rgb(0_0_0/0.8)]">
        {formatTileSeconds(length)}
      </span>
    </>
  );
}
