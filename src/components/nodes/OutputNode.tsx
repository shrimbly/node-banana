"use client";

import { useCallback, useState, useMemo, useEffect, useRef } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { Dialog } from "@/components/ui/Dialog";
import { NodeShell } from "./NodeShell";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { OutputNodeData } from "@/types";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { downloadMedia, MediaType } from "@/utils/downloadMedia";
import { EmptyState, ScrubRow, type SocketSpec } from "./ui";

type OutputNodeType = Node<OutputNodeData, "output">;

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "Image" },
  { id: "video", type: "video", label: "Video" },
  { id: "audio", type: "audio", label: "Audio" },
];
const EMPTY_HEIGHT = 160;
const AUDIO_HEIGHT = 64;

export function OutputNode({ id, data, selected }: NodeProps<OutputNodeType>) {
  const nodeData = data;
  useCommentNavigation(id);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const connectedEdgeCount = useWorkflowStore(
    (state) => state.edges.filter((edge) => edge.target === id).length
  );
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const [showLightbox, setShowLightbox] = useState(false);
  const previousEdgeCountRef = useRef<number | null>(null);
  const videoAutoplayRef = useVideoAutoplay(id);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Determine if content is audio
  const isAudio = useMemo(() => {
    if (nodeData.audio) return true;
    if (nodeData.contentType === "audio") return true;
    if (nodeData.image?.startsWith("data:audio/")) return true;
    return false;
  }, [nodeData.audio, nodeData.contentType, nodeData.image]);

  // Determine if content is video
  const isVideo = useMemo(() => {
    if (isAudio) return false;
    if (nodeData.video) return true;
    if (nodeData.contentType === "video") return true;
    if (nodeData.image?.startsWith("data:video/")) return true;
    if (nodeData.image?.includes(".mp4") || nodeData.image?.includes(".webm")) return true;
    return false;
  }, [isAudio, nodeData.video, nodeData.contentType, nodeData.image]);

  // Get the content source (audio, video, or image)
  const contentSrc = useMemo(() => {
    if (nodeData.audio) return nodeData.audio;
    if (nodeData.video) return nodeData.video;
    return nodeData.image;
  }, [nodeData.audio, nodeData.video, nodeData.image]);

  const imageSrc = !isAudio && !isVideo ? contentSrc : null;
  const adaptiveImage = useAdaptiveImageSrc(imageSrc, id);
  const videoBlobUrl = useVideoBlobUrl(isVideo ? contentSrc ?? null : null);

  // Auto-trigger execution when a new connection is made
  useEffect(() => {
    if (previousEdgeCountRef.current === null) {
      // First run — just record the baseline, don't trigger
      previousEdgeCountRef.current = connectedEdgeCount;
      return;
    }
    if (connectedEdgeCount > previousEdgeCountRef.current) {
      regenerateNode(id);
    }
    previousEdgeCountRef.current = connectedEdgeCount;
  }, [connectedEdgeCount, id, regenerateNode]);

  const handleDownload = useCallback(async () => {
    if (!contentSrc) return;
    const type: MediaType = isAudio ? "audio" : isVideo ? "video" : "image";
    try {
      await downloadMedia(contentSrc, type, nodeData.outputFilename ?? undefined);
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [contentSrc, isAudio, isVideo, nodeData.outputFilename]);

  const media = !contentSrc
    ? { kind: "fixed" as const, height: EMPTY_HEIGHT }
    : isAudio
      ? { kind: "fixed" as const, height: AUDIO_HEIGHT }
      : { kind: "aspect" as const, aspect: loadedAspect?.src === contentSrc ? loadedAspect.aspect : isVideo ? 16 / 9 : 1 };

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        isExecuting={isRunning}
        media={media}
        inputs={INPUT_SOCKETS}
        mediaClassName="group"
        gap={
          contentSrc && isVideo ? (
            <ScrubRow videoRef={videoAutoplayRef} src={videoBlobUrl} className="w-full" />
          ) : undefined
        }
      >
        {contentSrc ? (
          <>
            {isAudio ? (
              <div className="absolute inset-0 flex items-center justify-center px-3 bg-neutral-900/40">
                <audio src={contentSrc} controls className="w-full nodrag nopan" />
              </div>
            ) : (
              <div className="absolute inset-0 cursor-pointer" onClick={() => setShowLightbox(true)}>
                {isVideo ? (
                  <video
                    ref={videoAutoplayRef}
                    src={videoBlobUrl ?? undefined}
                    loop
                    muted
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover"
                    onClick={(e) => e.stopPropagation()}
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      if (v.videoWidth > 0 && v.videoHeight > 0) {
                        setLoadedAspect({ src: contentSrc, aspect: v.videoWidth / v.videoHeight });
                      }
                    }}
                  />
                ) : (
                  <img
                    src={adaptiveImage ?? contentSrc}
                    alt="Output"
                    className="absolute inset-0 w-full h-full object-cover"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                        setLoadedAspect({ src: contentSrc, aspect: img.naturalWidth / img.naturalHeight });
                      }
                    }}
                  />
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
                  <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded">
                    View full size
                  </span>
                </div>
              </div>
            )}
            <button
              onClick={handleDownload}
              className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-black/80 text-white text-xs rounded transition-colors flex items-center gap-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
              title="Download"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
          </>
        ) : (
          <EmptyState
            message="Connect input"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            }
          />
        )}
      </NodeShell>

      {/* Lightbox Modal (skip for audio) */}
      {showLightbox && contentSrc && !isAudio && (
        <Dialog open onClose={() => setShowLightbox(false)} variant="lightbox" portal label="Output full size">
            {isVideo ? (
              <video
                src={videoBlobUrl ?? undefined}
                controls
                loop
                autoPlay
                playsInline
                className="max-w-full max-h-[90vh] object-contain rounded"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <img
                src={contentSrc}
                alt="Output full size"
                className="max-w-full max-h-[90vh] object-contain rounded"
                // A click on the image closes, as it always has; the video keeps its controls
                onClick={() => setShowLightbox(false)}
              />
            )}
            <button
              onClick={() => setShowLightbox(false)}
              className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 rounded text-white text-sm transition-colors flex items-center justify-center"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
        </Dialog>
      )}
    </>
  );
}
