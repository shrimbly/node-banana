"use client";

import { useCallback, useState, useMemo, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { OutputNodeData } from "@/types";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";

type OutputNodeType = Node<OutputNodeData, "output">;

export function OutputNode({ id, data, selected }: NodeProps<OutputNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const connectedEdgeCount = useWorkflowStore(
    (state) => state.edges.filter((edge) => edge.target === id).length
  );
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const [showLightbox, setShowLightbox] = useState(false);
  const previousEdgeCountRef = useRef<number | null>(null);

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

  // Handle Run button click
  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleDownload = useCallback(async () => {
    if (!contentSrc) return;

    const timestamp = Date.now();
    const extension = isAudio ? "mp3" : isVideo ? "mp4" : "png";
    // Use custom filename if provided, otherwise use timestamp
    const filename = nodeData.outputFilename
      ? `${nodeData.outputFilename}.${extension}`
      : `generated-${timestamp}.${extension}`;

    // Handle URL-based content (needs fetch + blob conversion)
    if (contentSrc.startsWith("http://") || contentSrc.startsWith("https://")) {
      try {
        const response = await fetch(contentSrc);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error("Failed to download:", error);
      }
      return;
    }

    // Handle data URL content (direct download)
    const link = document.createElement("a");
    link.href = contentSrc;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [contentSrc, isAudio, isVideo, nodeData.outputFilename]);

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        isExecuting={isRunning}
        contentClassName="flex-1 min-h-0 relative"
        className="min-w-[200px]"
      >
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          data-handletype="image"
          style={{ zIndex: 10 }}
        />
        <Handle
          type="target"
          position={Position.Left}
          id="audio"
          data-handletype="audio"
          style={{ top: "60%", background: "rgb(167, 139, 250)", zIndex: 10 }}
        />

        <div className="relative w-full h-full overflow-hidden rounded-lg">
        {contentSrc ? (
          <>
            {isAudio ? (
              <div className="w-full h-full flex items-center justify-center p-4">
                <audio
                  src={contentSrc}
                  controls
                  className="w-full rounded"
                />
              </div>
            ) : (
              <div
                className="relative cursor-pointer group w-full h-full"
                onClick={() => setShowLightbox(true)}
              >
                {isVideo ? (
                  <video
                    src={videoBlobUrl ?? undefined}
                    controls
                    loop
                    muted
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <img
                    src={contentSrc}
                    alt="Output"
                    className="w-full h-full object-cover"
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
              className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-black/80 text-white text-xs rounded transition-colors flex items-center gap-1"
              title="Download"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
          </>
        ) : (
          <div className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center">
            <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
            <span className="text-xs text-neutral-500 mt-2">Connect input</span>
          </div>
        )}
        </div>
      </BaseNode>

      {/* Lightbox Modal (skip for audio) */}
      {showLightbox && contentSrc && !isAudio && (
        <div
          className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
          onClick={() => setShowLightbox(false)}
        >
          <div className="relative max-w-full max-h-full">
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
          </div>
        </div>
      )}
    </>
  );
}
