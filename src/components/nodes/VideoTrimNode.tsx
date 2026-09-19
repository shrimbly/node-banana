"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoTrimNodeData } from "@/types";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import {
  ChipGroup,
  ControlsCard,
  EmptyState,
  Field,
  FieldRow,
  NumberField,
  PanelButton,
  Spinner,
  SummaryValues,
  type SocketSpec,
} from "./ui";

type VideoTrimNodeType = Node<VideoTrimNodeData, "videoTrim">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video In" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video Out" }];
const EMPTY_HEIGHT = 120;

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
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);
  const videoAutoplayRef = useVideoAutoplay(id);

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

  const setStart = useCallback(
    (val: number) => {
      const clamped = Math.min(val, endTime - 0.1);
      updateNodeData(id, { startTime: Math.max(0, clamped) });
    },
    [id, updateNodeData, endTime]
  );

  const setEnd = useCallback(
    (val: number) => {
      const clamped = Math.max(val, startTime + 0.1);
      updateNodeData(id, { endTime: Math.min(duration > 0 ? duration : clamped, clamped) });
    },
    [id, updateNodeData, startTime, duration]
  );

  const hasSourceVideo = Boolean(sourceVideoUrl);
  const canTrim = hasSourceVideo && startTime < endTime && endTime > 0;

  // Which video URL to show in preview
  const previewUrl = showOutput && nodeData.outputVideo ? nodeData.outputVideo : sourceVideoUrl;
  const previewBlobUrl = useVideoBlobUrl(previewUrl);

  // Slider thumb positions for the visual range highlight
  const startPct = duration > 0 ? (startTime / duration) * 100 : 0;
  const endPct = duration > 0 ? (endTime / duration) * 100 : 100;

  const encoderChecking = nodeData.encoderSupported === null;
  const encoderUnsupported = nodeData.encoderSupported === false;
  const encoderReady = !encoderChecking && !encoderUnsupported;

  const media =
    encoderReady && previewUrl
      ? { kind: "aspect" as const, aspect: loadedAspect?.src === previewUrl ? loadedAspect.aspect : 16 / 9 }
      : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const trimScrubber = encoderReady && hasSourceVideo ? (
    <div className="nodrag nowheel w-full h-full px-2 trim-slider-container">
      {/* Make only the slider thumbs interactive, not the full-width invisible input bodies */}
      <style>{`
        .trim-slider-container input[type="range"] { pointer-events: none; }
        .trim-slider-container input[type="range"]::-webkit-slider-thumb { pointer-events: all; cursor: pointer; }
        .trim-slider-container input[type="range"]::-moz-range-thumb { pointer-events: all; cursor: pointer; }
      `}</style>
      <div className="relative w-full h-full flex items-center">
        <div className="absolute inset-x-0 h-1.5 bg-neutral-700 rounded-full" />
        <div
          className="absolute h-1.5 bg-blue-500/60 rounded-full pointer-events-none"
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
        />
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 100}
          step={0.1}
          value={startTime}
          onChange={(e) => setStart(parseFloat(e.target.value))}
          aria-label="Trim start"
          className="absolute inset-0 w-full h-full opacity-0 nodrag"
          style={{ zIndex: 3 }}
        />
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 100}
          step={0.1}
          value={endTime}
          onChange={(e) => setEnd(parseFloat(e.target.value))}
          aria-label="Trim end"
          className="absolute inset-0 w-full h-full opacity-0 nodrag"
          style={{ zIndex: 2 }}
        />
        <div
          className="absolute w-3 h-3 bg-white rounded-full border-2 border-blue-500 pointer-events-none"
          style={{ left: `calc(${startPct}% - 6px)`, zIndex: 4 }}
        />
        <div
          className="absolute w-3 h-3 bg-white rounded-full border-2 border-blue-500 pointer-events-none"
          style={{ left: `calc(${endPct}% - 6px)`, zIndex: 4 }}
        />
      </div>
    </div>
  ) : undefined;

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      media={media}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      minWidth={300}
      mediaClassName="group"
      gap={trimScrubber}
      controls={
        <ControlsCard
          id={id}
          summary={{
            title: hasSourceVideo ? `${formatTime(startTime)} → ${formatTime(endTime)}` : "Trim",
            values: <SummaryValues items={[hasSourceVideo ? `${formatTime(trimDuration)}` : null]} />,
          }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          {nodeData.outputVideo && sourceVideoUrl && (
            <Field label="Preview">
              <ChipGroup
                value={showOutput ? "trimmed" : "source"}
                options={[
                  { value: "source", label: "Source" },
                  { value: "trimmed", label: "Trimmed" },
                ]}
                onChange={(v) => setShowOutput(v === "trimmed")}
              />
            </Field>
          )}
          <NumberField
            label="Start"
            unit="s"
            value={Number(startTime.toFixed(1))}
            min={0}
            max={duration > 0 ? duration : undefined}
            step={0.1}
            allowEmpty={false}
            disabled={!hasSourceVideo}
            onChange={(v) => v !== undefined && setStart(v)}
          />
          <NumberField
            label="End"
            unit="s"
            value={Number(endTime.toFixed(1))}
            min={0}
            max={duration > 0 ? duration : undefined}
            step={0.1}
            allowEmpty={false}
            disabled={!hasSourceVideo}
            onChange={(v) => v !== undefined && setEnd(v)}
          />
          <FieldRow className="justify-end">
            <PanelButton
              primary
              onClick={() => regenerateNode(id)}
              disabled={!canTrim || nodeData.status === "loading" || isRunning}
            >
              {nodeData.status === "loading" ? "Processing..." : "Trim"}
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
      ) : previewUrl ? (
        <>
          <video
            ref={videoAutoplayRef}
            key={previewUrl}
            src={previewBlobUrl ?? undefined}
            playsInline
            muted
            loop
            className="absolute inset-0 w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0) {
                setLoadedAspect({ src: previewUrl, aspect: v.videoWidth / v.videoHeight });
              }
            }}
          />
          {nodeData.outputVideo && (
            <button
              onClick={() => {
                updateNodeData(id, { outputVideo: null, status: "idle" });
                setShowOutput(false);
              }}
              className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              title="Clear trimmed video"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </>
      ) : (
        <EmptyState message="Connect a video to trim" />
      )}

      {encoderReady && nodeData.status === "loading" && (
        <div className="absolute inset-0 bg-neutral-900/70 flex flex-col items-center justify-center gap-2">
          <Spinner size={24} className="text-white" />
          <span className="text-white text-xs">Processing... {Math.round(nodeData.progress)}%</span>
        </div>
      )}

      {encoderReady && nodeData.status === "error" && nodeData.error && (
        <div className="absolute bottom-2 left-2 right-2 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
          <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
        </div>
      )}
    </NodeShell>
  );
}
