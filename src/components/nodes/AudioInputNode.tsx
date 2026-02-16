"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { AudioInputNodeData } from "@/types";
import { useAudioVisualization } from "@/hooks/useAudioVisualization";

type AudioInputNodeType = Node<AudioInputNodeData, "audioInput">;

export function AudioInputNode({ id, data, selected }: NodeProps<AudioInputNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Use the audio visualization hook
  const { waveformData, isLoading } = useAudioVisualization(audioBlob);

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

  // Setup audio element
  useEffect(() => {
    if (nodeData.audioFile && !audioRef.current) {
      const audio = new Audio(nodeData.audioFile);
      audioRef.current = audio;

      const handleEnded = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
      const handleTimeUpdate = () => {
        setCurrentTime(audio.currentTime);
      };

      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("timeupdate", handleTimeUpdate);

      return () => {
        audio.removeEventListener("ended", handleEnded);
        audio.removeEventListener("timeupdate", handleTimeUpdate);
        audio.pause();
        audioRef.current = null;
      };
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [nodeData.audioFile]);

  // Helper to draw waveform bars on canvas
  const drawWaveform = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number, peaks: number[]) => {
      ctx.clearRect(0, 0, width, height);

      const barCount = Math.min(peaks.length, width);
      const barWidth = width / barCount;
      const barGap = 1;

      ctx.fillStyle = "rgb(167, 139, 250)"; // violet-400

      for (let i = 0; i < barCount; i++) {
        const peakIndex = Math.floor((i / barCount) * peaks.length);
        const peak = peaks[peakIndex] || 0;
        const barHeight = peak * height;
        const x = i * barWidth;
        const y = (height - barHeight) / 2;

        ctx.fillRect(x, y, barWidth - barGap, barHeight);
      }
    },
    []
  );

  // Effect A: ResizeObserver — only recreated when waveformData changes
  useEffect(() => {
    if (!waveformData || !canvasRef.current || !waveformContainerRef.current) return;

    const canvas = canvasRef.current;
    const container = waveformContainerRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;

        canvas.width = width;
        canvas.height = height;

        drawWaveform(ctx, width, height, waveformData.peaks);
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [waveformData, drawWaveform]);

  // Effect B: Redraw waveform + playback position (lightweight, no ResizeObserver)
  useEffect(() => {
    if (!waveformData || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    if (width === 0 || height === 0) return;

    drawWaveform(ctx, width, height, waveformData.peaks);

    // Draw playback position
    if (isPlaying && nodeData.duration) {
      const progress = currentTime / nodeData.duration;
      const x = progress * width;

      ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }, [isPlaying, currentTime, nodeData.duration, waveformData, drawWaveform]);

  // Animation loop for smooth playback position updates
  useEffect(() => {
    if (isPlaying && audioRef.current) {
      const updatePosition = () => {
        if (audioRef.current) {
          setCurrentTime(audioRef.current.currentTime);
        }
        animationFrameRef.current = requestAnimationFrame(updatePosition);
      };
      animationFrameRef.current = requestAnimationFrame(updatePosition);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying]);

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
    setIsPlaying(false);
    setCurrentTime(0);
    setAudioBlob(null);
    updateNodeData(id, {
      audioFile: null,
      filename: null,
      duration: null,
      format: null,
    });
  }, [id, updateNodeData]);

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !nodeData.duration || !waveformContainerRef.current) return;

    const rect = waveformContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const progress = x / rect.width;
    const newTime = progress * nodeData.duration;

    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [nodeData.duration]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleStartRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64 = event.target?.result as string;
          const audio = new Audio(base64);
          audio.onloadedmetadata = () => {
            updateNodeData(id, {
              audioFile: base64,
              filename: `recording-${Date.now()}.webm`,
              format: "audio/webm",
              duration: audio.duration,
            });
          };
        };
        reader.readAsDataURL(blob);

        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        setRecordingTime(0);
      };

      mediaRecorder.start();
      setIsRecording(true);

      // Start recording timer
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      console.error("Error accessing microphone:", error);
      alert("Could not access microphone. Please check permissions.");
    }
  }, [id, updateNodeData]);

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && isRecording) {
        mediaRecorderRef.current.stop();
      }
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, [isRecording]);

  return (
    <BaseNode
      id={id}
      title="Audio Input"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
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

      {isRecording ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 min-h-[112px] bg-red-950/30 border border-red-500/50 rounded">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            <span className="text-sm text-red-400 font-medium">Recording...</span>
          </div>
          <span className="text-2xl text-neutral-200 font-mono">{formatTime(recordingTime)}</span>
          <button
            onClick={handleStopRecording}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded transition-colors text-sm"
          >
            Stop Recording
          </button>
        </div>
      ) : nodeData.audioFile ? (
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
              {nodeData.duration && (
                <div
                  className="h-full bg-violet-500 transition-all"
                  style={{ width: `${(currentTime / nodeData.duration) * 100}%` }}
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
        <div className="w-full flex-1 min-h-[112px] flex flex-col gap-2">
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            className="flex-1 border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center cursor-pointer hover:border-neutral-500 hover:bg-neutral-700/50 transition-colors"
          >
            <svg className="w-6 h-6 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
            </svg>
            <span className="text-[10px] text-neutral-400 mt-1">
              Drop audio or click
            </span>
          </div>
          <button
            onClick={handleStartRecording}
            className="w-full py-2 bg-violet-600 hover:bg-violet-500 text-white rounded transition-colors text-xs flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            Record Audio
          </button>
        </div>
      )}

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
