"use client";

import React, { RefObject, useEffect, useState } from "react";
import { cn } from "./cn";

interface ScrubRowProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Re-binds listeners when the source changes. */
  src?: string | null;
  className?: string;
  /** Slots at either end (history arrows). */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Play/pause, a scrubber and `0:03 / 0:08`, driving the node's own <video>.
 * Lives in the gap row.
 */
export function ScrubRow({ videoRef, src, className, leading, trailing }: ScrubRowProps) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setTime(video.currentTime);
    const onMeta = () => setDuration(video.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    if (video.readyState >= 1) onMeta();
    setPlaying(!video.paused);
    setTime(video.currentTime);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
    };
  }, [videoRef, src]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    setTime(t);
  };

  return (
    <div className={cn("nodrag nopan flex items-center gap-1.5 h-full px-1 select-none", className)}>
      {leading}
      <button
        type="button"
        onClick={toggle}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
        className="w-5 h-5 rounded-[6px] squircle flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
      >
        {playing ? (
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(time, duration || 0)}
        onChange={(e) => seek(parseFloat(e.target.value))}
        aria-label="Seek"
        className="flex-1 min-w-0 h-1 accent-neutral-300 cursor-pointer"
      />
      <span className="text-node text-neutral-400 tabular-nums shrink-0">
        {formatTime(time)} / {formatTime(duration)}
      </span>
      {trailing}
    </div>
  );
}
