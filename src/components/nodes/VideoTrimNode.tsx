"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoTrimNodeData } from "@/types";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";

type VideoTrimNodeType = Node<VideoTrimNodeData, "videoTrim">;

/**
 * Format a time value in seconds as M:SS.s (e.g. "0:02.5")
 */
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

export function VideoTrimNode({ id, data, selected }: NodeProps<VideoTrimNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);

  // Track whether user wants to see source or output video
  const [showOutput, setShowOutput] = useState(false);

  // Keep a ref to endTime so the metadata callback reads fresh state
  const endTimeRef = useRef(nodeData.endTime);
  endTimeRef.current = nodeData.endTime;

  // Check encoder support on mount
  useEffect(() => {
    if (nodeData.encoderSupported === null) {
      checkEncoderSupport().then((supported) => {
        updateNodeData(id, { encoderSupported: supported });
      });
    }
  }, [id, nodeData.encoderSupported, updateNodeData]);

  // Find connected source video from incoming edges
  const sourceVideoUrl = useMemo(() => {
    const incomingEdge = edges.find((e) => e.target === id && e.targetHandle === "video");
    if (!incomingEdge) return null;

    const sourceNode = nodes.find((n) => n.id === incomingEdge.source);
    if (!sourceNode) return null;

    const d = sourceNode.data as Record<string, unknown>;
    // Support common video output fields from generateVideo, videoStitch, easeCurve, videoTrim
    return (d.outputVideo as string | null) ?? null;
  }, [edges, nodes, id]);

  // When source video changes, load metadata to detect duration
  useEffect(() => {
    if (!sourceVideoUrl) return;

    let cancelled = false;
    const abortController = new AbortController();
    let blobUrl: string | null = null;

    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (cancelled) return;
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 0) {
        updateNodeData(id, {
          duration: dur,
          // Only auto-set endTime if it hasn't been set yet (still at default 0)
          endTime: endTimeRef.current === 0 ? dur : endTimeRef.current,
        });
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    };
    video.onerror = () => {
      if (cancelled) return;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    };

    // If the source is a data URL, create a blob URL for metadata loading efficiency
    if (sourceVideoUrl.startsWith("data:")) {
      fetch(sourceVideoUrl, { signal: abortController.signal })
        .then((r) => r.blob())
        .then((blob) => {
          if (cancelled) return;
          blobUrl = URL.createObjectURL(blob);
          video.src = blobUrl;
        })
        .catch(() => {
          if (cancelled) return;
          video.src = sourceVideoUrl;
        });
    } else {
      video.src = sourceVideoUrl;
    }

    return () => {
      cancelled = true;
      abortController.abort();
      video.onloadedmetadata = null;
      video.onerror = null;
      video.src = "";
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [sourceVideoUrl, id, updateNodeData]);

  // Auto-switch to output when trimming completes
  const prevOutputVideoRef = useRef(nodeData.outputVideo);
  useEffect(() => {
    if (!prevOutputVideoRef.current && nodeData.outputVideo) {
      setShowOutput(true);
    }
    prevOutputVideoRef.current = nodeData.outputVideo;
  }, [nodeData.outputVideo]);

  const duration = nodeData.duration ?? 0;
  const startTime = nodeData.startTime;
  const endTime = nodeData.endTime > 0 ? nodeData.endTime : duration;
  const trimDuration = Math.max(0, endTime - startTime);

  const handleStartChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      const clamped = Math.min(val, endTime - 0.1);
      updateNodeData(id, { startTime: Math.max(0, clamped) });
    },
    [id, updateNodeData, endTime]
  );

  const handleEndChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      const clamped = Math.max(val, startTime + 0.1);
      updateNodeData(id, { endTime: Math.min(duration > 0 ? duration : clamped, clamped) });
    },
    [id, updateNodeData, startTime, duration]
  );

  const handleTrim = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const hasSourceVideo = Boolean(sourceVideoUrl);
  const canTrim = hasSourceVideo && startTime < endTime && endTime > 0;

  // Which video URL to show in preview
  const previewUrl = showOutput && nodeData.outputVideo ? nodeData.outputVideo : sourceVideoUrl;
  const previewBlobUrl = useVideoBlobUrl(previewUrl);

  // Compute slider thumb position percentages for the visual range highlight
  const startPct = duration > 0 ? (startTime / duration) * 100 : 0;
  const endPct = duration > 0 ? (endTime / duration) * 100 : 100;

  // Shared handles rendered in ALL states
  const renderHandles = () => (
    <>
      {/* Video In (target, left, 50%) */}
      <Handle
        type="target"
        position={Position.Left}
        id="video"
        data-handletype="video"
        isConnectable={true}
        style={{ top: "50%" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{ right: "calc(100% + 8px)", top: "calc(50% - 7px)", color: "rgb(168, 85, 247)" }}
      >
        Video In
      </div>

      {/* Video Out (source, right, 50%) */}
      <Handle
        type="source"
        position={Position.Right}
        id="video"
        data-handletype="video"
        isConnectable={true}
        style={{ top: "50%" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{ left: "calc(100% + 8px)", top: "calc(50% - 7px)", color: "rgb(168, 85, 247)" }}
      >
        Video Out
      </div>
    </>
  );

  // Encoder not supported
  if (nodeData.encoderSupported === false) {
    return (
      <BaseNode
        id={id}
        selected={selected}
        contentClassName="flex-1 min-h-0 overflow-clip"
        minWidth={360}
        minHeight={360}
      >
        {renderHandles()}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-4">
          <svg className="w-8 h-8 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="text-xs text-neutral-400">
            Your browser doesn&apos;t support video encoding.
          </span>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 underline"
          >
            Doesn&apos;t seem right? Message Willie on Discord.
          </a>
        </div>
      </BaseNode>
    );
  }

  // Checking encoder state
  if (nodeData.encoderSupported === null) {
    return (
      <BaseNode
        id={id}
        selected={selected}
        minWidth={360}
        minHeight={360}
      >
        {renderHandles()}
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-neutral-400">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-xs">Checking encoder...</span>
          </div>
        </div>
      </BaseNode>
    );
  }

  return (
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      minWidth={360}
      minHeight={360}
    >
      {renderHandles()}

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Video preview area */}
        <div className="flex-1 min-h-0 relative">
          {previewUrl ? (
            <video
              key={previewUrl}
              src={previewBlobUrl ?? undefined}
              controls
              playsInline
              muted
              loop
              className="absolute inset-0 w-full h-full object-contain rounded"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center border border-dashed border-neutral-600 rounded">
              <span className="text-[10px] text-neutral-500">Connect a video to trim</span>
            </div>
          )}

          {/* Source / trimmed toggle (shown when output exists) */}
          {nodeData.outputVideo && sourceVideoUrl && (
            <div className="absolute top-1 left-1 flex gap-1">
              <button
                onClick={() => setShowOutput(false)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                  !showOutput
                    ? "bg-neutral-700 text-neutral-200"
                    : "bg-neutral-900/70 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Source
              </button>
              <button
                onClick={() => setShowOutput(true)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                  showOutput
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-900/70 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Trimmed
              </button>
            </div>
          )}

          {/* Clear output button */}
          {nodeData.outputVideo && (
            <button
              onClick={() => {
                updateNodeData(id, { outputVideo: null, status: "idle" });
                setShowOutput(false);
              }}
              className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
              title="Clear trimmed video"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Trim controls (only shown when we have a duration) */}
        {hasSourceVideo && (
          <div className="shrink-0 flex flex-col gap-1.5 px-1">
            {/* Dual range slider */}
            <div className="nodrag nowheel relative h-5 flex items-center trim-slider-container">
              {/* Make only the slider thumbs interactive, not the full-width invisible input bodies */}
              <style>{`
                .trim-slider-container input[type="range"] {
                  pointer-events: none;
                }
                .trim-slider-container input[type="range"]::-webkit-slider-thumb {
                  pointer-events: all;
                  cursor: pointer;
                }
                .trim-slider-container input[type="range"]::-moz-range-thumb {
                  pointer-events: all;
                  cursor: pointer;
                }
              `}</style>

              {/* Track background */}
              <div className="absolute left-0 right-0 h-1.5 bg-neutral-700 rounded-full" />

              {/* Highlighted trim range */}
              <div
                className="absolute h-1.5 bg-blue-500/60 rounded-full pointer-events-none"
                style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
              />

              {/* Start slider (higher z-index so it's draggable when both thumbs overlap at 0) */}
              <input
                type="range"
                min={0}
                max={duration > 0 ? duration : 100}
                step={0.1}
                value={startTime}
                onChange={handleStartChange}
                className="absolute w-full h-full opacity-0 nodrag"
                style={{ zIndex: 3 }}
              />

              {/* End slider */}
              <input
                type="range"
                min={0}
                max={duration > 0 ? duration : 100}
                step={0.1}
                value={endTime}
                onChange={handleEndChange}
                className="absolute w-full h-full opacity-0 nodrag"
                style={{ zIndex: 2 }}
              />

              {/* Visual thumb indicators */}
              <div
                className="absolute w-3 h-3 bg-white rounded-full border-2 border-blue-500 pointer-events-none"
                style={{ left: `calc(${startPct}% - 6px)`, zIndex: 4 }}
              />
              <div
                className="absolute w-3 h-3 bg-white rounded-full border-2 border-blue-500 pointer-events-none"
                style={{ left: `calc(${endPct}% - 6px)`, zIndex: 4 }}
              />
            </div>

            {/* Time labels */}
            <div className="flex items-center justify-between">
              <div className="flex flex-col items-start">
                <span className="text-[10px] text-neutral-400">Start</span>
                <span className="text-[11px] text-neutral-200 font-mono">{formatTime(startTime)}</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-[10px] text-neutral-400">Duration</span>
                <span className="text-[11px] text-neutral-200 font-mono">{formatTime(trimDuration)}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] text-neutral-400">End</span>
                <span className="text-[11px] text-neutral-200 font-mono">{formatTime(endTime)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Trim button */}
        <div className="shrink-0 flex justify-end px-1">
          <button
            onClick={handleTrim}
            disabled={!canTrim || nodeData.status === "loading" || isRunning}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:cursor-not-allowed rounded text-white text-xs font-medium transition-colors"
          >
            {nodeData.status === "loading" ? "Processing..." : "Trim"}
          </button>
        </div>

        {/* Processing overlay */}
        {nodeData.status === "loading" && (
          <div className="absolute inset-0 bg-neutral-900/70 rounded flex flex-col items-center justify-center gap-2">
            <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-white text-xs">Processing... {Math.round(nodeData.progress)}%</span>
          </div>
        )}

        {/* Error display */}
        {nodeData.status === "error" && nodeData.error && (
          <div className="shrink-0 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
            <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
          </div>
        )}
      </div>
    </BaseNode>
  );
}
