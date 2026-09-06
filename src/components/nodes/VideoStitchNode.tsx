"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type SocketSpec,
} from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { nodeGraphIndex } from "@/lib/edges/graphIndex";
import { VideoStitchNodeData, WorkflowNode } from "@/types";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";

type VideoStitchNodeType = Node<VideoStitchNodeData, "videoStitch">;

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Output" }];
const EMPTY_HEIGHT = 120;
const LOOP_OPTIONS = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "3", label: "3x" },
];

export function VideoStitchNode({ id, data, selected }: NodeProps<VideoStitchNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);
  const videoAutoplayRef = useVideoAutoplay(id);
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Check encoder support on mount
  useEffect(() => {
    if (nodeData.encoderSupported === null) {
      checkEncoderSupport().then((supported) => {
        updateNodeData(id, { encoderSupported: supported });
      });
    }
  }, [id, nodeData.encoderSupported, updateNodeData]);

  // Get connected video edges
  const videoEdges = useMemo(() => {
    return edges.filter(
      (e) => e.target === id && e.targetHandle?.startsWith("video-")
    );
  }, [edges, id]);
  // The clips' source nodes, as the store's own objects, so the list only
  // changes when one of them does and not on every drag frame
  const sourceNodes = useWorkflowStore(
    useShallow((state) => {
      const { byId } = nodeGraphIndex(state.nodes);
      return videoEdges.map((e) => byId.get(e.source)).filter((n): n is WorkflowNode => n !== undefined);
    })
  );

  // Sync clipOrder with connected edges (side effect, must be in useEffect)
  const lastWrittenClipOrderRef = useRef<string[]>([]);
  useEffect(() => {
    const currentEdgeIds = videoEdges.map((e) => e.id);
    const currentOrder = nodeData.clipOrder || [];

    // Keep existing order for edges that still exist, append new ones
    const validExisting = currentOrder.filter((eid) => currentEdgeIds.includes(eid));
    const newEdges = currentEdgeIds.filter((eid) => !currentOrder.includes(eid));
    const newOrder = [...validExisting, ...newEdges];

    // Skip if we just wrote this exact order (prevents extra render cycle)
    if (
      newOrder.length === lastWrittenClipOrderRef.current.length &&
      newOrder.every((eid, idx) => eid === lastWrittenClipOrderRef.current[idx])
    ) {
      return;
    }

    if (
      newOrder.length !== currentOrder.length ||
      !newOrder.every((eid, idx) => eid === currentOrder[idx])
    ) {
      lastWrittenClipOrderRef.current = newOrder;
      updateNodeData(id, { clipOrder: newOrder });
    }
  }, [videoEdges, nodeData.clipOrder, id, updateNodeData]);

  // Get ordered clips based on clipOrder or connection order
  const orderedClips = useMemo(() => {
    const clipMap = new Map<string, { edge: any; sourceNode: any; videoData: string | null; duration: number | null }>();

    videoEdges.forEach((edge) => {
      const sourceNode = sourceNodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      let videoData: string | null = null;
      let duration: number | null = null;

      if (sourceNode.type === "generateVideo" || sourceNode.type === "easeCurve" || sourceNode.type === "videoStitch" || sourceNode.type === "videoTrim") {
        videoData = (sourceNode.data as any).outputVideo || null;
      }

      clipMap.set(edge.id, { edge, sourceNode, videoData, duration });
    });

    let ordered: Array<{ edgeId: string; edge: any; sourceNode: any; videoData: string | null; duration: number | null }>;

    if (nodeData.clipOrder && nodeData.clipOrder.length > 0) {
      ordered = nodeData.clipOrder
        .map((edgeId) => {
          const clip = clipMap.get(edgeId);
          if (!clip) return null;
          return { edgeId, ...clip };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);

      // Append any new edges not in clipOrder yet
      videoEdges.forEach((edge) => {
        if (!nodeData.clipOrder.includes(edge.id)) {
          const clip = clipMap.get(edge.id);
          if (clip) {
            ordered.push({ edgeId: edge.id, ...clip });
          }
        }
      });
    } else {
      ordered = videoEdges
        .sort((a, b) => {
          const timeA = (a.data as any)?.createdAt ?? 0;
          const timeB = (b.data as any)?.createdAt ?? 0;
          return timeA - timeB;
        })
        .map((edge) => {
          const clip = clipMap.get(edge.id);
          if (!clip) return null;
          return { edgeId: edge.id, ...clip };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
    }

    return ordered;
  }, [videoEdges, sourceNodes, nodeData.clipOrder]);

  // Stable key that only changes when clip edges or video data actually change
  const clipKey = useMemo(
    () => orderedClips.map((c) => `${c.edgeId}:${c.videoData ? c.videoData.slice(-20) : "0"}`).join(","),
    [orderedClips]
  );

  // Ref-based cache so the effect doesn't read stale `thumbnails` state
  const thumbnailsRef = useRef<Map<string, string>>(new Map());
  // Fingerprint cache: edgeId -> last-20-chars of videoData, used to detect which clips changed
  const thumbnailFingerprintsRef = useRef<Map<string, string>>(new Map());

  // Extract thumbnails from connected videos
  useEffect(() => {
    let cancelled = false;
    let activeVideo: HTMLVideoElement | null = null;
    let activeBlobUrl: string | null = null;

    const cleanupVideo = (video: HTMLVideoElement, blobUrl?: string | null) => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onseeked = null;
      video.src = "";
      video.load();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };

    const extractThumbnails = async () => {
      const newThumbnails = new Map<string, string>();
      const newFingerprints = new Map<string, string>();

      for (const clip of orderedClips) {
        if (cancelled) return;
        if (!clip.videoData) continue;

        const fingerprint = clip.videoData.slice(-20);
        newFingerprints.set(clip.edgeId, fingerprint);

        // Reuse cached thumbnail if the video data hasn't changed
        const cachedFingerprint = thumbnailFingerprintsRef.current.get(clip.edgeId);
        if (cachedFingerprint === fingerprint && thumbnailsRef.current.has(clip.edgeId)) {
          newThumbnails.set(clip.edgeId, thumbnailsRef.current.get(clip.edgeId)!);
          continue;
        }

        const video = document.createElement("video");
        activeVideo = video;
        activeBlobUrl = null;
        // Convert data URLs to blob URLs for metadata loading efficiency
        // (avoids re-parsing the full base64 payload into the element).
        let blobUrl: string | null = null;
        if (clip.videoData.startsWith("data:")) {
          try {
            const blob = await (await fetch(clip.videoData)).blob();
            if (cancelled) return;
            blobUrl = URL.createObjectURL(blob);
            activeBlobUrl = blobUrl;
          } catch {
            blobUrl = null;
          }
        }
        try {
          video.src = blobUrl ?? clip.videoData;
          video.crossOrigin = "anonymous";
          video.muted = true;
          video.preload = "metadata";

          await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Failed to load video"));
          });

          if (cancelled) { cleanupVideo(video, blobUrl); return; }

          const seekTime = video.duration * 0.25;
          video.currentTime = seekTime;

          await Promise.race([
            new Promise<void>((resolve) => {
              video.onseeked = () => resolve();
            }),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Seek timeout")), 10_000)
            ),
          ]);

          if (cancelled) { cleanupVideo(video, blobUrl); return; }

          const canvas = document.createElement("canvas");
          const thumbWidth = 160;
          const rawAspectRatio = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0;
          const aspectRatio = Number.isFinite(rawAspectRatio) && rawAspectRatio > 0 ? rawAspectRatio : 16 / 9;
          canvas.width = thumbWidth;
          canvas.height = Math.round(thumbWidth / aspectRatio);
          const ctx = canvas.getContext("2d");
          if (!ctx) { cleanupVideo(video, blobUrl); continue; }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
          newThumbnails.set(clip.edgeId, thumbnail);

          clip.duration = video.duration;
        } catch (error) {
          console.warn(`Failed to extract thumbnail for clip ${clip.edgeId}:`, error);
        }
        cleanupVideo(video, blobUrl);
        activeVideo = null;
        activeBlobUrl = null;
      }

      if (!cancelled) {
        thumbnailsRef.current = newThumbnails;
        thumbnailFingerprintsRef.current = newFingerprints;
        setThumbnails(newThumbnails);
      }
    };

    extractThumbnails();
    return () => {
      cancelled = true;
      if (activeVideo) {
        cleanupVideo(activeVideo, activeBlobUrl);
        activeVideo = null;
        activeBlobUrl = null;
      }
    };
  }, [clipKey]); // eslint-disable-line react-hooks/exhaustive-deps — orderedClips accessed via closure, clipKey is the stable dep

  // Pointer-based drag reorder (HTML5 drag doesn't work inside React Flow nodes)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null);
  const [hoverClipId, setHoverClipId] = useState<string | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, edgeId: string) => {
    // Only left mouse button
    if (e.button !== 0) return;
    e.stopPropagation();
    setDraggedClipId(edgeId);
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

    const currentOrder = [...(nodeData.clipOrder || [])];
    const draggedIndex = currentOrder.indexOf(draggedClipId);
    const targetIndex = currentOrder.indexOf(hoverClipId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      currentOrder.splice(draggedIndex, 1);
      currentOrder.splice(targetIndex, 0, draggedClipId);
      updateNodeData(id, { clipOrder: currentOrder });
    }

    setDraggedClipId(null);
    setHoverClipId(null);
  }, [draggedClipId, hoverClipId, nodeData.clipOrder, id, updateNodeData]);

  const handleRemoveClip = useCallback(
    (edgeId: string) => {
      removeEdge(edgeId);
    },
    [removeEdge]
  );

  const handleStitch = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Dynamic video input sockets: one per connected clip plus a free slot.
  const inputSockets = useMemo<SocketSpec[]>(() => {
    const count = Math.max(videoEdges.length + 1, 2);
    const sockets: SocketSpec[] = Array.from({ length: count }, (_, i) => ({
      id: `video-${i}`,
      type: "video",
      label: `Video ${i + 1}`,
    }));
    sockets.push({ id: "audio", type: "audio", label: "Audio" });
    return sockets;
  }, [videoEdges.length]);

  const encoderChecking = nodeData.encoderSupported === null;
  const encoderUnsupported = nodeData.encoderSupported === false;
  const encoderReady = !encoderChecking && !encoderUnsupported;
  const showOutput = encoderReady && Boolean(nodeData.outputVideo) && nodeData.status !== "loading";

  const media = showOutput
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputVideo ? loadedAspect.aspect : 16 / 9 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const filmstrip = (
    <div className="overflow-y-auto nowheel grid grid-cols-4 content-start gap-1.5 p-1.5 bg-well rounded-well squircle shadow-well max-h-[140px]">
      {orderedClips.map((clip) => {
        const thumbnail = thumbnails.get(clip.edgeId);
        return (
          <div
            key={clip.edgeId}
            data-clip-id={clip.edgeId}
            onPointerDown={(e) => handlePointerDown(e, clip.edgeId)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`nodrag relative w-full aspect-video bg-neutral-800 border rounded cursor-move transition-colors group ${
              draggedClipId === clip.edgeId
                ? "opacity-50 border-blue-500"
                : hoverClipId === clip.edgeId && draggedClipId
                  ? "border-blue-400 ring-1 ring-blue-400/50"
                  : "border-neutral-600 hover:border-neutral-500"
            }`}
          >
            {thumbnail ? (
              <img src={thumbnail} alt={`Clip ${clip.edgeId}`} className="w-full h-full object-cover rounded" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Spinner size={14} className="text-neutral-500" />
              </div>
            )}
            {clip.duration && (
              <div className="absolute bottom-1 right-1 bg-black/70 px-1 py-0.5 rounded text-[8px] text-white">
                {Math.round(clip.duration)}s
              </div>
            )}
            <button
              onClick={() => handleRemoveClip(clip.edgeId)}
              className="absolute top-0.5 right-0.5 w-4 h-4 bg-red-600/80 hover:bg-red-500 rounded text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              title="Disconnect"
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
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
      mediaClassName="group"
      gap={showOutput ? <ScrubRow videoRef={videoAutoplayRef} src={videoBlobUrl} className="w-full" /> : undefined}
      controls={
        <ControlsCard
          id={id}
          summary={{
            title: `${orderedClips.length} clip${orderedClips.length === 1 ? "" : "s"}`,
            values: <SummaryValues items={[`loop ${nodeData.loopCount || 1}x`]} />,
          }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          {orderedClips.length > 0 ? (
            <FieldRow className="h-auto">
              <div className="w-full">{filmstrip}</div>
            </FieldRow>
          ) : (
            <span className="text-node text-neutral-500 py-1">No clips connected</span>
          )}
          <Field label="Loop">
            <ChipGroup
              value={String(nodeData.loopCount || 1)}
              options={LOOP_OPTIONS}
              onChange={(v) => updateNodeData(id, { loopCount: Number(v) as 1 | 2 | 3 })}
            />
          </Field>
          <FieldRow className="justify-end">
            <PanelButton
              primary
              onClick={handleStitch}
              disabled={orderedClips.length < 2 || nodeData.status === "loading" || isRunning}
            >
              {nodeData.status === "loading" ? "Processing..." : "Stitch"}
            </PanelButton>
          </FieldRow>
        </ControlsCard>
      }
    >
      {encoderUnsupported ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 bg-neutral-900/40">
          <svg className="w-8 h-8 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="text-xs text-neutral-400">Your browser doesn't support video encoding.</span>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 underline"
          >
            Doesn't seem right? Message Willie on Discord.
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
            className="absolute inset-0 w-full h-full object-cover"
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
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      ) : (
        <EmptyState message={orderedClips.length === 0 ? "Connect videos to stitch" : "Stitch to preview"} />
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
