import { useRef, useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { soundAudible, useVideoSoundStore } from "@/store/videoSoundStore";
import { useIsPaintedNode } from "@/components/nodes/paintMode";

/** How long the pointer rests on a node before its video starts. */
export const VIDEO_HOVER_DELAY_MS = 300;

/**
 * Dispatched on the video element by the scrub row's sound button: the user
 * wants to hear this video, so playback is pinned as if play had been
 * pressed, and it starts if it was paused.
 */
export const VIDEO_PIN_EVENT = "nodebanana:pin";

/**
 * What the user last asked of this video.
 *
 * - `hover`: untouched. The video previews while the node is hovered and
 *   pauses where it is when the pointer leaves.
 * - `playing`: the user pressed play. Playback is pinned and ignores hover.
 * - `paused`: the user paused or scrubbed. The frame holds and hover does
 *   not restart it; only pressing play does.
 */
export type VideoPlaybackIntent = "hover" | "playing" | "paused";

/**
 * Where each node's video was left, by node id. On the GPU canvas a node
 * stops being live once the pointer leaves it, so its card unmounts; the next
 * one to mount picks up the paused frame and what the user asked, instead of
 * starting again from 0:00 on hover.
 */
const leftAt = new Map<string, { src: string | null | undefined; intent: VideoPlaybackIntent; time: number }>();
const LEFT_AT_LIMIT = 500;

export function __resetVideoPlaybackMemoryForTests() {
  leftAt.clear();
}

/**
 * Drives a node's video from hover and the user's own play, pause and scrub
 * actions, so the two never fight.
 *
 * The hook plays and pauses the element itself for hover previews and marks
 * those transitions so it can tell them apart from the user's. Any play or
 * pause it did not ask for becomes the user's intent, which takes precedence
 * over hover until the source changes or the video ends on its own.
 *
 * Sound follows the shared setting (useVideoSoundStore) but only while the
 * user has pinned playback: a hover preview is always silent.
 *
 * @param nodeId - The node's unique ID
 * @param src - The current source; a change resets the intent to hover
 * @returns A ref to attach to the video element
 */
export function useVideoAutoplay(nodeId: string, src?: string | null): React.RefObject<HTMLVideoElement | null> {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // A painted copy is never hovered: hover state would be baked into its picture.
  const painted = useIsPaintedNode();
  const isHovered = useWorkflowStore((s) => !painted && s.hoveredNodeId === nodeId);
  const soundOn = useVideoSoundStore((s) => s.on);
  const volume = useVideoSoundStore((s) => s.volume);
  const intent = useRef<VideoPlaybackIntent>("hover");
  /** A transition this hook started, so its event is not read as the user's. */
  const expected = useRef<"play" | "pause" | null>(null);
  const bound = useRef<HTMLVideoElement | null>(null);
  /** The element where it was left has been put back on, for this source. */
  const restored = useRef<HTMLVideoElement | null>(null);

  /** Mutes a preview, and a pinned video unless the user wants sound. */
  const applySound = (video: HTMLVideoElement) => {
    const audible = intent.current === "playing" && soundAudible(useVideoSoundStore.getState());
    if (video.muted !== !audible) video.muted = !audible;
    const level = useVideoSoundStore.getState().volume;
    if (video.volume !== level) video.volume = level;
  };

  // A new source is a new video: forget what the user did with the last one.
  useEffect(() => {
    intent.current = "hover";
    expected.current = null;
    restored.current = null;
  }, [src]);

  // The sound setting changed while this video is up: a pinned one hears it at once.
  useEffect(() => {
    const video = videoRef.current;
    if (video) applySound(video);
    // applySound reads the store directly; the deps are what makes it rerun.
  }, [soundOn, volume]);

  // Listen for the user's own transitions. The element may mount after the
  // first render, so rebind whenever the ref points somewhere new.
  useEffect(() => {
    const video = videoRef.current;
    if (video === bound.current) return;
    const onPlay = () => {
      if (expected.current === "play") expected.current = null;
      else intent.current = "playing";
      applySound(video!);
    };
    const onPause = () => {
      if (expected.current === "pause") expected.current = null;
      else intent.current = "paused";
    };
    const onEnded = () => {
      // It ran out on its own: hovering again replays it from the start.
      intent.current = "hover";
      expected.current = null;
    };
    const onPin = () => {
      intent.current = "playing";
      expected.current = null;
      applySound(video!);
      if (video!.paused) video!.play().catch(() => {});
    };
    bound.current?.removeEventListener("play", onPlay);
    bound.current = video;
    if (!video) return;
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener(VIDEO_PIN_EVENT, onPin);
    if (!painted && restored.current !== video) {
      restored.current = video;
      const left = leftAt.get(nodeId);
      if (left && left.src === src) {
        // A video stopped by the unmount holds its frame like a user's pause.
        intent.current = left.intent === "hover" ? "hover" : "paused";
        if (left.time > 0) {
          const seek = () => {
            if (video.currentTime === 0) video.currentTime = left.time;
          };
          if (video.readyState >= 1) seek();
          else video.addEventListener("loadedmetadata", seek, { once: true });
        }
      }
    }
    applySound(video);
    return () => {
      if (!painted) {
        leftAt.delete(nodeId);
        if (intent.current !== "hover" || video.currentTime > 0) {
          leftAt.set(nodeId, { src, intent: intent.current, time: video.currentTime });
          if (leftAt.size > LEFT_AT_LIMIT) leftAt.delete(leftAt.keys().next().value!);
        }
      }
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener(VIDEO_PIN_EVENT, onPin);
      if (bound.current === video) bound.current = null;
    };
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || intent.current !== "hover") return;

    if (!isHovered) {
      if (!video.paused) {
        expected.current = "pause";
        video.pause();
      }
      return;
    }

    const timeout = setTimeout(() => {
      if (intent.current !== "hover" || !video.paused) return;
      expected.current = "play";
      applySound(video); // a preview is silent
      video.play().catch((e) => {
        expected.current = null;
        if (e.name !== "AbortError") {
          console.warn("Video play failed:", e);
        }
      });
    }, VIDEO_HOVER_DELAY_MS);
    return () => clearTimeout(timeout);
    // applySound reads refs and the store; isHovered/src are the triggers.
  }, [isHovered, nodeId, src]);

  return videoRef;
}
