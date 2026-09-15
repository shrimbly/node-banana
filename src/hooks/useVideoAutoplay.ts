import { useRef, useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

/** How long the pointer rests on a node before its video starts. */
export const VIDEO_HOVER_DELAY_MS = 300;

/**
 * Plays a node's video while the node is hovered.
 *
 * Videos are paused by default. Hovering the node for a moment starts the
 * video; leaving pauses it where it is, so it resumes from the same frame.
 * Selecting a node does not play its video, so a selected video node stays
 * still while the user works around it.
 *
 * @param nodeId - The node's unique ID
 * @returns A ref to attach to the video element
 */
export function useVideoAutoplay(nodeId: string): React.RefObject<HTMLVideoElement | null> {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isHovered = useWorkflowStore((s) => s.hoveredNodeId === nodeId);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!isHovered) {
      video.pause();
      return;
    }

    const timeout = setTimeout(() => {
      video.play().catch((e) => {
        if (e.name !== "AbortError") {
          console.warn("Video play failed:", e);
        }
      });
    }, VIDEO_HOVER_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [isHovered, nodeId]);

  return videoRef;
}
