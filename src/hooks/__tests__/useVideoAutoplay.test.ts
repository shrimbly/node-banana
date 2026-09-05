import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVideoAutoplay, VIDEO_HOVER_DELAY_MS } from "../useVideoAutoplay";

let hoveredNodeId: string | null = null;
vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (s: { hoveredNodeId: string | null }) => unknown) => selector({ hoveredNodeId }),
}));

function attach(result: { current: React.RefObject<HTMLVideoElement | null> }) {
  const video = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() } as unknown as HTMLVideoElement;
  result.current.current = video;
  return video;
}

describe("useVideoAutoplay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoveredNodeId = null;
  });
  afterEach(() => vi.useRealTimers());

  it("plays after the hover delay and pauses on leave", () => {
    const { result, rerender } = renderHook(() => useVideoAutoplay("n1"));
    const video = attach(result);
    hoveredNodeId = "n1";
    rerender();
    expect(video.play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(VIDEO_HOVER_DELAY_MS);
    expect(video.play).toHaveBeenCalledTimes(1);
    hoveredNodeId = null;
    rerender();
    expect(video.pause).toHaveBeenCalled();
  });

  it("does not play a selected node that is not hovered", () => {
    // Selection is no longer an input: only the hovered node plays
    const { result, rerender } = renderHook(() => useVideoAutoplay("n1"));
    const video = attach(result);
    hoveredNodeId = "other";
    rerender();
    vi.advanceTimersByTime(VIDEO_HOVER_DELAY_MS * 2);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("drops a pending play when the pointer leaves before the delay", () => {
    const { result, rerender } = renderHook(() => useVideoAutoplay("n1"));
    const video = attach(result);
    hoveredNodeId = "n1";
    rerender();
    hoveredNodeId = null;
    rerender();
    vi.advanceTimersByTime(VIDEO_HOVER_DELAY_MS * 2);
    expect(video.play).not.toHaveBeenCalled();
  });
});
