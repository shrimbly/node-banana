import { useCallback, useRef, useState, useEffect } from "react";
import { WaveformData } from "./useAudioVisualization";

interface UseAudioPlaybackOptions {
  audioSrc: string | null;
  waveformData: WaveformData | null;
  isLoadingWaveform: boolean;
}

interface UseAudioPlaybackResult {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  waveformContainerRef: React.RefObject<HTMLDivElement | null>;
  isPlaying: boolean;
  currentTime: number;
  handlePlayPause: () => void;
  handleSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
  formatTime: (seconds: number) => string;
  waveformData: WaveformData | null;
  isLoadingWaveform: boolean;
}

export function useAudioPlayback({ audioSrc, waveformData, isLoadingWaveform }: UseAudioPlaybackOptions): UseAudioPlaybackResult {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // Setup audio element
  useEffect(() => {
    if (!audioSrc) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPlaying(false);
      setCurrentTime(0);
      return;
    }

    // Clean up previous audio element
    if (audioRef.current) {
      audioRef.current.pause();
    }

    const audio = new Audio(audioSrc);
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
  }, [audioSrc]);

  // Helper to draw waveform bars on canvas with optional progress indicator
  const drawWaveform = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number, peaks: number[], progress?: number) => {
      ctx.clearRect(0, 0, width, height);

      const barCount = Math.min(peaks.length, width);
      const barWidth = width / barCount;
      const barGap = 1;
      const progressX = progress !== undefined ? progress * width : -1;

      for (let i = 0; i < barCount; i++) {
        const peakIndex = Math.floor((i / barCount) * peaks.length);
        const peak = peaks[peakIndex] || 0;
        const barHeight = peak * height;
        const x = i * barWidth;
        const y = (height - barHeight) / 2;

        // Played bars in the full violet; the rest bright enough to read on
        // the dark clip rather than fading into it.
        ctx.fillStyle = x < progressX ? "rgb(139, 92, 246)" : "rgba(167, 139, 250, 0.75)";
        ctx.fillRect(x, y, Math.max(1, barWidth - barGap), Math.max(1, barHeight));
      }

      // Draw playback position line
      if (progressX > 0) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(progressX, 0);
        ctx.lineTo(progressX, height);
        ctx.stroke();
      }
    },
    []
  );

  // ResizeObserver — only recreated when waveformData changes
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

        // Back the canvas at device resolution so 1px bars stay crisp.
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        drawWaveform(ctx, width, height, waveformData.peaks);
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [waveformData, drawWaveform]);

  // Redraw waveform + playback progress (lightweight, no ResizeObserver)
  useEffect(() => {
    if (!waveformData || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The backing store is device pixels; draw in CSS pixels under the same
    // transform the resize pass set.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    if (width === 0 || height === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const duration = audioRef.current?.duration;
    const progress = duration && isFinite(duration) && currentTime > 0 ? currentTime / duration : undefined;
    drawWaveform(ctx, width, height, waveformData.peaks, progress);
  }, [isPlaying, currentTime, waveformData, drawWaveform]);

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

  const handlePlayPause = useCallback(() => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(() => {
        setIsPlaying(false);
      });
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !audioRef.current.duration || !isFinite(audioRef.current.duration) || !waveformContainerRef.current) return;

    const rect = waveformContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const progress = x / rect.width;
    const newTime = progress * audioRef.current.duration;

    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, []);

  const formatTime = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }, []);

  return {
    audioRef,
    canvasRef,
    waveformContainerRef,
    isPlaying,
    currentTime,
    handlePlayPause,
    handleSeek,
    formatTime,
    waveformData,
    isLoadingWaveform,
  };
}
