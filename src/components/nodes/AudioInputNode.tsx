"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { AudioInputNodeData } from "@/types";
import { useAudioVisualization } from "@/hooks/useAudioVisualization";
import { useAudioPlayback } from "@/hooks/useAudioPlayback";
import { useNodeMediaRequest } from "@/hooks/useNodeMediaRequest";
import { downloadMedia } from "@/utils/downloadMedia";
import { ControlsCard, SummaryValues, type SocketSpec } from "./ui";

type AudioInputNodeType = Node<AudioInputNodeData, "audioInput">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "audio", type: "audio", label: "Audio" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "audio", type: "audio", label: "Audio" }];
const MEDIA_HEIGHT = 96;

export function AudioInputNode({ id, data, selected }: NodeProps<AudioInputNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { beginRequest, cancelRequest } = useNodeMediaRequest();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);

  // Convert base64 data URL to Blob for the hook
  useEffect(() => {
    if (nodeData.audioFile) {
      fetch(nodeData.audioFile)
        .then((r) => r.blob())
        .then(setAudioBlob)
        .catch(() => setAudioBlob(null));
    } else {
      setAudioBlob(null);
    }
  }, [nodeData.audioFile]);

  const { waveformData, isLoading } = useAudioVisualization(audioBlob);
  const {
    audioRef,
    canvasRef,
    waveformContainerRef,
    isPlaying,
    currentTime,
    handlePlayPause,
    handleSeek,
    formatTime,
  } = useAudioPlayback({
    audioSrc: nodeData.audioFile ?? null,
    waveformData,
    isLoadingWaveform: isLoading,
  });

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.match(/^audio\//)) {
        alert("Unsupported format. Use MP3, WAV, OGG, AAC, or other audio formats.");
        return;
      }

      if (file.size > 50 * 1024 * 1024) {
        alert("Audio file too large. Maximum size is 50MB.");
        return;
      }

      const isCurrent = beginRequest();
      const reader = new FileReader();
      reader.onload = (event) => {
        if (!isCurrent()) return;
        const base64 = event.target?.result as string;

        // Extract duration using HTML Audio element
        const audio = new Audio(base64);
        audio.onloadedmetadata = () => {
          if (!isCurrent()) return;
          updateNodeData(id, {
            audioFile: base64,
            audioFileRef: undefined,
            filename: file.name,
            format: file.type,
            duration: audio.duration,
          });
        };
        audio.onerror = () => {
          if (!isCurrent()) return;
          // Still load the file even if metadata extraction fails
          updateNodeData(id, {
            audioFile: base64,
            audioFileRef: undefined,
            filename: file.name,
            format: file.type,
            duration: null,
          });
        };
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData, beginRequest]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    cancelRequest();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setAudioBlob(null);
    updateNodeData(id, {
      audioFile: null,
      audioFileRef: undefined,
      filename: null,
      duration: null,
      format: null,
    });
  }, [id, updateNodeData, audioRef, cancelRequest]);

  const duration = audioRef.current?.duration;
  const hasDuration = !!duration && isFinite(duration);

  const transport = nodeData.audioFile ? (
    <div className="nodrag nopan flex items-center gap-1.5 w-full h-full px-1">
      <button
        onClick={handlePlayPause}
        className="w-5 h-5 rounded-[6px] squircle flex items-center justify-center text-neutral-300 hover:text-white hover:bg-white/10 transition-colors shrink-0"
        title={isPlaying ? "Pause" : "Play"}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? (
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0 h-1 bg-neutral-700 rounded-full overflow-hidden relative">
        {hasDuration && (
          <div className="h-full bg-violet-500 transition-all" style={{ width: `${(currentTime / duration) * 100}%` }} />
        )}
      </div>
      <span className="text-node text-neutral-400 tabular-nums shrink-0">{formatTime(currentTime)}</span>
    </div>
  ) : undefined;

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "fixed", height: MEDIA_HEIGHT }}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      gap={transport}
      controls={
        nodeData.audioFile ? (
          <ControlsCard
            id={id}
            summary={{
              title: nodeData.filename || "Audio",
              values: (
                <SummaryValues
                  items={[nodeData.duration ? formatTime(nodeData.duration) : null, nodeData.isOptional ? "optional" : null]}
                />
              ),
            }}
          />
        ) : undefined
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mp3,audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/mp4,audio/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.audioFile ? (
        <>
          {nodeData.isOptional && (
            <span className="absolute top-1 left-1 z-10 text-[9px] font-medium text-neutral-300 bg-black/50 px-1.5 py-0.5 rounded">
              Optional
            </span>
          )}
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/50">
              <span className="text-node text-neutral-500">Loading waveform...</span>
            </div>
          ) : waveformData ? (
            <div ref={waveformContainerRef} className="absolute inset-0 bg-neutral-900/50 cursor-pointer" onClick={handleSeek}>
              <canvas ref={canvasRef} className="w-full h-full" />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/50">
              <span className="text-node text-neutral-500">Processing...</span>
            </div>
          )}
          <button
            onClick={() => downloadMedia(nodeData.audioFile!, "audio")}
            aria-label="Download audio"
            className="absolute top-1 right-7 w-5 h-5 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-white transition-opacity flex items-center justify-center"
            title="Download audio"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          <button
            onClick={handleRemove}
            aria-label="Remove audio"
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload audio file"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="absolute inset-0 bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-800/60 transition-colors"
        >
          <div className={`absolute inset-2 rounded-[6px] squircle border border-dashed pointer-events-none ${nodeData.isOptional ? "border-neutral-600" : "border-neutral-700/70"}`} />
          <svg className="w-6 h-6 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
          </svg>
          <span className="text-xs text-neutral-500 mt-1.5">
            {nodeData.isOptional ? "Optional" : "Drop audio or click"}
          </span>
        </div>
      )}
    </NodeShell>
  );
}
