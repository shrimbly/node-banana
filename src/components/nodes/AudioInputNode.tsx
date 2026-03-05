"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { AudioInputNodeData } from "@/types";
import { useAudioVisualization } from "@/hooks/useAudioVisualization";
import { useAudioPlayback } from "@/hooks/useAudioPlayback";

type AudioInputNodeType = Node<AudioInputNodeData, "audioInput">;

export function AudioInputNode({ id, data, selected }: NodeProps<AudioInputNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
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

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;

        // Extract duration using HTML Audio element
        const audio = new Audio(base64);
        audio.onloadedmetadata = () => {
          updateNodeData(id, {
            audioFile: base64,
            filename: file.name,
            format: file.type,
            duration: audio.duration,
          });
        };
        audio.onerror = () => {
          // Still load the file even if metadata extraction fails
          updateNodeData(id, {
            audioFile: base64,
            filename: file.name,
            format: file.type,
            duration: null,
          });
        };
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData]
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
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setAudioBlob(null);
    updateNodeData(id, {
      audioFile: null,
      filename: null,
      duration: null,
      format: null,
    });
  }, [id, updateNodeData, audioRef]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      minWidth={250}
      minHeight={150}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mp3,audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/mp4,audio/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.audioFile ? (
        <div className="relative group flex-1 flex flex-col min-h-0 gap-2">
          {/* Filename and duration */}
          <div className="flex items-center justify-between shrink-0">
            <span className="text-[10px] text-neutral-400 truncate max-w-[150px]" title={nodeData.filename || ""}>
              {nodeData.filename}
            </span>
            {nodeData.duration && (
              <span className="text-[10px] text-neutral-500 bg-neutral-700/50 px-1.5 py-0.5 rounded">
                {formatTime(nodeData.duration)}
              </span>
            )}
          </div>

          {/* Waveform visualization */}
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center bg-neutral-900/50 rounded min-h-[60px]">
              <span className="text-xs text-neutral-500">Loading waveform...</span>
            </div>
          ) : waveformData ? (
            <div
              ref={waveformContainerRef}
              className="flex-1 min-h-[60px] bg-neutral-900/50 rounded cursor-pointer relative"
              onClick={handleSeek}
            >
              <canvas ref={canvasRef} className="w-full h-full" />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center bg-neutral-900/50 rounded min-h-[60px]">
              <span className="text-xs text-neutral-500">Processing...</span>
            </div>
          )}

          {/* Play/pause controls */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handlePlayPause}
              className="w-7 h-7 flex items-center justify-center bg-violet-600 hover:bg-violet-500 rounded transition-colors"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Progress bar / scrubber */}
            <div className="flex-1 h-1 bg-neutral-700 rounded-full overflow-hidden relative">
              {audioRef.current?.duration && isFinite(audioRef.current.duration) && (
                <div
                  className="h-full bg-violet-500 transition-all"
                  style={{ width: `${(currentTime / audioRef.current.duration) * 100}%` }}
                />
              )}
            </div>

            {/* Current time */}
            <span className="text-[10px] text-neutral-500 min-w-[32px] text-right">
              {formatTime(currentTime)}
            </span>
          </div>

          {/* Remove button */}
          <button
            onClick={handleRemove}
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-800/60 transition-colors"
        >
          <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
          </svg>
          <span className="text-xs text-neutral-500 mt-2">
            Drop audio or click
          </span>
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        id="audio"
        data-handletype="audio"
        style={{ background: "rgb(167, 139, 250)" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="audio"
        data-handletype="audio"
        style={{ background: "rgb(167, 139, 250)" }}
      />
    </BaseNode>
  );
}
