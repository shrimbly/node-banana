"use client";

import React, { RefObject, useEffect, useRef, useState } from "react";
import { cn } from "./cn";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { soundAudible, useVideoSoundStore } from "@/store/videoSoundStore";
import { VIDEO_PIN_EVENT } from "@/hooks/useVideoAutoplay";

interface ScrubRowProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Re-binds listeners when the source changes. */
  src?: string | null;
  className?: string;
  /** Slots at either end (history arrows). */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

/** The pointer rests on the sound button this long before the volume opens. */
export const VOLUME_HOVER_DELAY_MS = 300;

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const buttonClass =
  "w-5 h-5 rounded-[6px] squircle flex items-center justify-center hover:text-white hover:bg-white/10 transition-colors shrink-0";

/**
 * Play/pause, a scrubber, `0:03 / 0:08` and the sound button, driving the
 * node's own <video>. Lives in the gap row.
 *
 * Sound is one setting shared by every player (useVideoSoundStore). The
 * button toggles it and pins playback, so the video is heard from then on;
 * resting on the button opens the volume above it. Hover previews stay
 * silent whatever the button says (useVideoAutoplay). Under 240px of row
 * the time readout hides first and the button stays.
 */
export function ScrubRow({ videoRef, src, className, leading, trailing }: ScrubRowProps) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const soundOn = useVideoSoundStore((s) => s.on);
  const volume = useVideoSoundStore((s) => s.volume);
  const audible = soundAudible({ on: soundOn, volume });

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

  useEffect(() => () => clearTimeout(openTimer.current), []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  // Scrubbing is looking at frames: hold the video on the chosen one. The
  // pause counts as the user's, so a hover preview will not restart it.
  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) video.pause();
    video.currentTime = t;
    setTime(t);
  };

  // Turning sound on is asking to hear this video: pin its playback.
  const toggleSound = () => {
    const next = !soundOn;
    useVideoSoundStore.getState().setOn(next);
    if (next) videoRef.current?.dispatchEvent(new Event(VIDEO_PIN_EVENT));
  };

  const openVolumeSoon = () => {
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setVolumeOpen(true), VOLUME_HOVER_DELAY_MS);
  };
  const closeVolume = () => {
    clearTimeout(openTimer.current);
    setVolumeOpen(false);
  };

  return (
    <div className={cn("nodrag nopan @container flex items-center gap-1.5 h-full px-1 select-none", className)}>
      {leading}
      <button
        type="button"
        onClick={toggle}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
        className={cn(buttonClass, "text-neutral-400")}
      >
        {playing ? (
          <Pause size={12} strokeWidth={0} fill="currentColor" />
        ) : (
          <Play size={12} strokeWidth={0} fill="currentColor" />
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
      <span className="text-node text-neutral-400 tabular-nums shrink-0 @max-[239px]:hidden">
        {formatTime(time)} / {formatTime(duration)}
      </span>
      <div
        className="relative shrink-0 flex items-center"
        onPointerEnter={openVolumeSoon}
        onPointerLeave={closeVolume}
      >
        <button
          type="button"
          onClick={toggleSound}
          title={audible ? "Sound on" : "Sound off"}
          aria-label={audible ? "Sound on" : "Sound off"}
          aria-pressed={audible}
          className={cn(buttonClass, audible ? "text-white" : "text-neutral-400")}
        >
          {audible ? <Volume2 size={12} strokeWidth={1.75} /> : <VolumeX size={12} strokeWidth={1.75} />}
        </button>
        {volumeOpen && (
          <div
            role="group"
            aria-label="Volume"
            className="absolute right-0 bottom-full mb-1.5 flex items-center gap-[7px] w-[92px] h-7 px-2.5 rounded-well squircle bg-panel border border-chrome-border shadow-menu"
          >
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => useVideoSoundStore.getState().setVolume(parseFloat(e.target.value))}
              aria-label="Volume level"
              className="flex-1 min-w-0 h-1 accent-neutral-300 cursor-pointer"
            />
            <span className="w-4 text-right text-[9px] leading-none text-neutral-400 tabular-nums">{Math.round(volume * 100)}</span>
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}
