import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ScrubRow, VOLUME_HOVER_DELAY_MS, formatTime } from "../ScrubRow";
import { useVideoSoundStore } from "@/store/videoSoundStore";
import { VIDEO_PIN_EVENT } from "@/hooks/useVideoAutoplay";

function video(paused = false) {
  return {
    paused,
    currentTime: 0,
    duration: 8,
    readyState: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("ScrubRow", () => {
  it("formats times", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.4)).toBe("1:05");
    expect(formatTime(NaN)).toBe("0:00");
  });

  it("scrubbing pauses a playing video and holds the chosen frame", () => {
    const v = video(false);
    render(<ScrubRow videoRef={{ current: v }} src="blob:a" />);
    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "3.5" } });
    expect(v.pause).toHaveBeenCalledTimes(1);
    expect(v.currentTime).toBe(3.5);
  });

  it("scrubbing a paused video only seeks", () => {
    const v = video(true);
    render(<ScrubRow videoRef={{ current: v }} src="blob:a" />);
    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "2" } });
    expect(v.pause).not.toHaveBeenCalled();
    expect(v.currentTime).toBe(2);
  });

  describe("sound", () => {
    beforeEach(() => {
      localStorage.clear();
      useVideoSoundStore.setState({ on: false, volume: 1 });
    });
    afterEach(() => vi.useRealTimers());

    it("starts silent, and turning sound on pins the video's playback", () => {
      const v = video(true);
      render(<ScrubRow videoRef={{ current: v }} src="blob:a" />);
      const button = screen.getByRole("button", { name: "Sound off" });
      expect(button).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(button);
      expect(useVideoSoundStore.getState().on).toBe(true);
      expect(screen.getByRole("button", { name: "Sound on" })).toHaveAttribute("aria-pressed", "true");
      expect(v.dispatchEvent).toHaveBeenCalledTimes(1);
      expect((v.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0].type).toBe(VIDEO_PIN_EVENT);
    });

    it("turning sound off leaves playback as it is", () => {
      useVideoSoundStore.setState({ on: true, volume: 1 });
      const v = video(false);
      render(<ScrubRow videoRef={{ current: v }} src="blob:a" />);
      fireEvent.click(screen.getByRole("button", { name: "Sound on" }));
      expect(useVideoSoundStore.getState().on).toBe(false);
      expect(v.dispatchEvent).not.toHaveBeenCalled();
      expect(v.pause).not.toHaveBeenCalled();
    });

    it("reads as silent at volume zero even when on", () => {
      useVideoSoundStore.setState({ on: true, volume: 0 });
      render(<ScrubRow videoRef={{ current: video(true) }} src="blob:a" />);
      expect(screen.getByRole("button", { name: "Sound off" })).toBeInTheDocument();
    });

    it("opens the volume after resting on the button, sets the level, and closes on leave", () => {
      vi.useFakeTimers();
      const v = video(true);
      render(<ScrubRow videoRef={{ current: v }} src="blob:a" />);
      const button = screen.getByRole("button", { name: "Sound off" });
      fireEvent.pointerEnter(button.parentElement!);
      expect(screen.queryByRole("group", { name: "Volume" })).not.toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(VOLUME_HOVER_DELAY_MS); });
      expect(screen.getByRole("group", { name: "Volume" })).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Volume level"), { target: { value: "0.4" } });
      expect(useVideoSoundStore.getState().volume).toBeCloseTo(0.4);
      expect(screen.getByText("40")).toBeInTheDocument();
      fireEvent.pointerLeave(button.parentElement!);
      expect(screen.queryByRole("group", { name: "Volume" })).not.toBeInTheDocument();
    });

    it("does not open the volume when the pointer leaves before the delay", () => {
      vi.useFakeTimers();
      render(<ScrubRow videoRef={{ current: video(true) }} src="blob:a" />);
      const wrap = screen.getByRole("button", { name: "Sound off" }).parentElement!;
      fireEvent.pointerEnter(wrap);
      fireEvent.pointerLeave(wrap);
      act(() => { vi.advanceTimersByTime(VOLUME_HOVER_DELAY_MS); });
      expect(screen.queryByRole("group", { name: "Volume" })).not.toBeInTheDocument();
    });
  });

  it("the button plays a paused video and pauses a playing one", () => {
    const v = video(true);
    render(<ScrubRow videoRef={{ current: v }} src="blob:a" />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(v.play).toHaveBeenCalledTimes(1);
  });
});
