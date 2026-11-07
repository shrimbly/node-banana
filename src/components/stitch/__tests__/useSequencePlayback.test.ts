import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { livePlayhead, PLAYHEAD_WRITE_SEC, useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import { clipSpans, createClip, layoutSpans, spansEnd, type SourceKey } from "@/lib/stitch/timeline";
import { useSequencePlayback, type AudioPlaybackClip, type SequencePlaybackOptions } from "../useSequencePlayback";

// The preview engine against stand-in media elements and a hand-driven frame loop. A playing stand-in advances with
// the frames' timestamps, as a real element runs on its own; a seek can take time (seekMs) before it lands, and a start
// (startMs: an element with sound waits for the sound output) before it moves; its sound turned on while it plays
// silent counts a switch (soundSwitches).

interface FakeMedia {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  readyState: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  style: { opacity: string };
  /** currentTime writes. */
  writes: number;
  /**
   * Times its sound was turned on while it played silent (unmuted, or raised from 0): a browser moves such an element's
   * sound to the speakers then, and its picture stops while it does.
   */
  soundSwitches: number;
  /** Stands still while playing (a stall, as on a buffer underrun). */
  frozen: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  /** Moves a playing element on by `ms` of the frames' time, and lands a seek whose time has come. */
  advance(ms: number, now: number): void;
  requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => number;
  /**
   * Shows a frame of `mediaTime`, sent to the screen now (the last frame's time): what requestVideoFrameCallback
   * reports, only when called, so a test decides.
   */
  present(mediaTime: number): void;
}

/** Every stand-in made since the test began, advanced by flushFrame. */
let made: FakeMedia[] = [];

function fakeMedia({
  duration = Number.NaN,
  seekMs = 0,
  startMs = 0,
}: { duration?: number; seekMs?: number; startMs?: number } = {}): FakeMedia {
  let time = 0;
  // Still until then after a play()
  let startsAt: number | null = null;
  let starting = false;
  let muted = false;
  let volume = 1;
  let landsAt: number | null = null;
  let target = 0;
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener({ currentTarget: media } as unknown as Event);
  };
  const media: FakeMedia = {
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      media.writes++;
      media.ended = false;
      time = value;
      if (seekMs <= 0) return;
      // Reports the new time at once, as a real element does, but stands still until the seek lands seekMs after the
      // next frame
      media.seeking = true;
      target = value;
      landsAt = null;
    },
    paused: true,
    ended: false,
    seeking: false,
    get muted() {
      return muted;
    },
    set muted(value: boolean) {
      if (!value && muted && volume > 0 && !media.paused) media.soundSwitches++;
      muted = value;
    },
    get volume() {
      return volume;
    },
    set volume(value: number) {
      if (value > 0 && volume === 0 && !muted && !media.paused) media.soundSwitches++;
      volume = value;
    },
    playbackRate: 1,
    readyState: 4,
    duration,
    videoWidth: 1280,
    videoHeight: 720,
    style: { opacity: "" },
    writes: 0,
    soundSwitches: 0,
    frozen: false,
    play: vi.fn(() => {
      if (media.paused) starting = startMs > 0;
      media.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      media.paused = true;
    }),
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    advance(ms: number, now: number) {
      if (media.seeking) {
        landsAt ??= now + seekMs;
        if (now < landsAt) return;
        media.seeking = false;
        landsAt = null;
        time = target;
        emit("seeked");
        return;
      }
      if (media.paused || media.frozen || ms <= 0) return;
      if (starting) {
        startsAt ??= now - ms + startMs;
        if (now < startsAt) return;
        ms = now - startsAt;
        starting = false;
        startsAt = null;
      }
      time += (ms / 1000) * media.playbackRate;
      if (Number.isFinite(media.duration) && time >= media.duration) {
        time = media.duration;
        media.ended = true;
        media.paused = true;
      }
    },
  };
  let frameCallbacks: VideoFrameRequestCallback[] = [];
  media.requestVideoFrameCallback = (callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  media.present = (mediaTime) => {
    const callbacks = frameCallbacks;
    frameCallbacks = [];
    for (const callback of callbacks) {
      callback(lastNow, { mediaTime, presentationTime: lastNow } as VideoFrameCallbackMetadata);
    }
  };
  made.push(media);
  return media;
}

/** A media element whose play() stays pending until pause() rejects it with AbortError, as browsers do. */
function pendingPlayMedia(): FakeMedia {
  const media = fakeMedia();
  let reject: ((error: unknown) => void) | null = null;
  media.play.mockImplementation(() => {
    media.paused = false;
    return new Promise<void>((_, rej) => {
      reject = rej;
    });
  });
  media.pause.mockImplementation(() => {
    media.paused = true;
    reject?.(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
    reject = null;
  });
  return media;
}

/** Two clips, 5 s of source "a" then 5 s of source "b". */
function twoSourceOptions(): SequencePlaybackOptions {
  const first = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
  const second = createClip({ kind: "edge", edgeId: "e2" }, { id: "c2" });
  const spans = clipSpans(
    [first, second],
    new Map<SourceKey, number>([
      ["edge:e1", 5],
      ["edge:e2", 5],
    ]),
    0,
  );
  return {
    spans,
    total: 10,
    srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
    audio: { clips: [] },
    soundOn: true,
  };
}

const asVideo = (m: FakeMedia) => m as unknown as HTMLVideoElement;
/** Silent the preview's way: playing out at an inaudible volume, never muted (a browser stalls one it unmutes). */
const expectSilent = (m: FakeMedia) => {
  expect(m.muted).toBe(false);
  expect(m.volume).toBeGreaterThan(0);
  expect(m.volume).toBeLessThan(1e-4);
};
const asAudio = (m: FakeMedia) => m as unknown as HTMLAudioElement;

let frames: FrameRequestCallback[] = [];
let lastNow = 0;
/** One animation frame at `now` ms: the playing stand-ins move on by the time since the last, then the loop runs. */
const flushFrame = (now: number) =>
  act(() => {
    const elapsed = now - lastNow;
    lastNow = now;
    for (const media of made) media.advance(elapsed, now);
    const queue = frames;
    frames = [];
    for (const cb of queue) cb(now);
  });

const editor = () => useStitchEditorStore.getState();

/** An audio clip as the editor passes it: the music read from a node without audio clips by default. */
const audioClip = (init: Partial<AudioPlaybackClip> = {}): AudioPlaybackClip => ({
  id: "audio:music",
  src: "music.mp3",
  startSec: 0,
  inSec: 0,
  outSec: null,
  muted: false,
  curve: [],
  ...init,
});

/** One 10 s clip of source "a" (served at `url`), with music from "music.mp3". */
function options(url = "blob:a", music: string | null = "music.mp3", clips?: AudioPlaybackClip[]): SequencePlaybackOptions {
  const clip = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
  const spans = clipSpans([clip], new Map<SourceKey, number>([["edge:e1", 10]]), 0);
  return {
    spans,
    total: 10,
    srcFor: () => url,
    audio: { clips: clips ?? [audioClip({ src: music })] },
    soundOn: true,
  };
}

beforeEach(() => {
  frames = [];
  made = [];
  lastNow = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  act(() => {
    editor().close();
    editor().setPlayhead(0);
    editor().setPlaying(false);
  });
});

afterEach(() => {
  act(() => editor().setPlaying(false));
  vi.unstubAllGlobals();
});

describe("useSequencePlayback", () => {
  it("does not re-render per playhead write while the same source stays under it", () => {
    let renders = 0;
    const opts = options();
    renderHook(() => {
      renders++;
      return useSequencePlayback(opts);
    });
    const before = renders;
    act(() => {
      editor().setPlayhead(1);
      editor().setPlayhead(2);
      editor().setPlayhead(3);
    });
    expect(renders).toBe(before);
  });

  it("moves the playhead on the frames' time, from where Play left it", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlayhead(2));
    act(() => editor().setPlaying(true));
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(2);
    flushFrame(0);
    expect(livePlayhead()).toBe(2);
    // Set off once the clip moves, from where it is
    flushFrame(500);
    expect(livePlayhead()).toBeCloseTo(2.5, 9);
    flushFrame(1000);
    expect(livePlayhead()).toBeCloseTo(3, 9);
    // Paused: the clock stops
    act(() => editor().setPlaying(false));
    flushFrame(3000);
    expect(livePlayhead()).toBeCloseTo(3, 9);
  });

  it("draws the playhead every frame but writes the store's at most every PLAYHEAD_WRITE_SEC, exactly at a pause or a key", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    // The editor's key hook, set up after this one, stops every key it handles from going further
    const editorKeys = (e: KeyboardEvent) => e.stopImmediatePropagation();
    window.addEventListener("keydown", editorKeys, true);
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    let writes = 0;
    const unsubscribe = useStitchEditorStore.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead) writes++;
    });
    for (let now = 116; now <= 1092; now += 16) flushFrame(now);
    // 62 frames over a second: the store's playhead every 7th (a 16 ms frame past 0.1 s)
    expect(livePlayhead()).toBeCloseTo(1.092, 9);
    expect(writes).toBeLessThanOrEqual(Math.ceil(1 / PLAYHEAD_WRITE_SEC));
    expect(writes).toBeGreaterThanOrEqual(8);
    // A key while playing: written where the clock is, before what the key does reads it
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    });
    expect(editor().playhead).toBeCloseTo(1.092, 9);
    flushFrame(1108);
    // A pause: exactly where the clock was
    act(() => editor().setPlaying(false));
    expect(editor().playhead).toBeCloseTo(1.108, 9);
    unsubscribe();
    window.removeEventListener("keydown", editorKeys, true);
  });

  it("holds the picture after a move back while playing, never preparing the clip still on screen", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    // The first clip's element takes 300 ms to seek back
    const a = fakeMedia({ duration: 5, seekMs: 300 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(6));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    expect(b.style.opacity).toBe("1");
    const writes = b.writes;
    // Back to 2 s: "a" seeks; meanwhile the picture stays on "b", still, and "b" (the next clip, from 0) waits
    act(() => editor().setPlayhead(2));
    flushFrame(116);
    flushFrame(232);
    expect(a.seeking).toBe(true);
    expect(b.style.opacity).toBe("1");
    expect(b.paused).toBe(true);
    expect(b.writes).toBe(writes);
    expect(a.style.opacity).toBe("0");
    // Landed and moving: "a" shows, and only now is "b" put at its In for later
    for (let now = 248; now <= 600; now += 16) flushFrame(now);
    expect(a.style.opacity).toBe("1");
    expect(b.style.opacity).toBe("0");
    expect(b.currentTime).toBe(0);
  });

  it("keeps the playhead moving while the clip's element stalls, and catches it up with one seek", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(1000);
    expect(livePlayhead()).toBe(1);
    // The element stands still: the clock does not
    video.frozen = true;
    flushFrame(1200);
    expect(livePlayhead()).toBeCloseTo(1.2, 9);
    // 0.2 s behind: played faster, not seeked
    expect(video.playbackRate).toBe(1.05);
    expect(video.writes).toBe(0);
    // Past 0.25 s: seeked once, to where the clock will be when the seek lands
    flushFrame(1500);
    expect(livePlayhead()).toBeCloseTo(1.5, 9);
    expect(video.writes).toBe(1);
    expect(video.currentTime).toBeCloseTo(1.6, 9);
    expect(video.playbackRate).toBe(1);
    // Still stuck: no seek after seek, only the rate, until a second's cooldown
    flushFrame(1700);
    flushFrame(1900);
    expect(video.writes).toBe(1);
  });

  it("waits for the clip in front to move before the clock and the music set off", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia({ seekMs: 300 });
    const music = fakeMedia({ duration: 30 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlayhead(2));
    act(() => editor().setPlaying(true));
    // The paused seek to 2 is still running: nothing moves, the music waits
    flushFrame(0);
    flushFrame(200);
    expect(video.seeking).toBe(true);
    expect(livePlayhead()).toBe(2);
    expect(music.play).not.toHaveBeenCalled();
    // Landed, then moving: the clock sets off from where the picture is, the music with it
    flushFrame(400);
    expect(livePlayhead()).toBe(2);
    flushFrame(450);
    expect(livePlayhead()).toBeCloseTo(2.05, 9);
    expect(music.play).toHaveBeenCalledTimes(1);
    expect(music.currentTime).toBeCloseTo(2.1, 9);
  });

  it("stops at the sequence's end", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlayhead(9.5));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(600);
    expect(editor().playing).toBe(false);
    expect(livePlayhead()).toBe(10);
    expect(video.paused).toBe(true);
  });

  it("starts the music again after a jump back from past its end", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia({ duration: 3 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    expect(music.play).toHaveBeenCalledTimes(1);

    // Play on past the music's 3 s: it stops
    flushFrame(5000);
    expect(livePlayhead()).toBe(5);
    expect(music.paused).toBe(true);

    // Go to start while playing: the music comes back from there once the picture moves again
    act(() => editor().setPlayhead(0));
    flushFrame(5100);
    expect(video.currentTime).toBe(0);
    flushFrame(5200);
    expect(livePlayhead()).toBeCloseTo(0.1, 9);
    expect(music.play).toHaveBeenCalledTimes(2);
    expect(music.paused).toBe(false);
    expect(music.currentTime).toBeCloseTo(0.15, 9);
  });

  it("asks a music element whose play() was refused only once, not every frame", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia({ duration: 30 });
    music.play.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(1000);
    flushFrame(2000);
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("drives the music read from a legacy node on the clock, at its curve's gain", () => {
    const curve = [
      { t: 0, gain: 0 },
      { t: 4, gain: 1 },
    ];
    const opts = options("blob:a", "music.mp3", [audioClip({ curve })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia({ duration: 30 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Started where the clock will be when it moves (its start latency on)
    expect(music.play).toHaveBeenCalledTimes(1);
    expect(music.currentTime).toBeCloseTo(0.15, 9);
    // The gain at the playhead, on the curve's own clock: sequence seconds for an untouched music clip
    flushFrame(1000);
    expect(music.volume).toBeCloseTo(gainAt(curve, 1), 6);
    // These stand-ins move at once, so it is 0.05 s ahead: slowed, never seeked
    expect(music.currentTime).toBeCloseTo(1.05, 9);
    expect(music.playbackRate).toBe(0.98);
    flushFrame(2000);
    flushFrame(3000);
    flushFrame(3500);
    // Back within 10 ms: its rate is 1 again
    expect(Math.abs(music.currentTime - 3.5)).toBeLessThan(0.01);
    expect(music.playbackRate).toBe(1);
    expect(music.writes).toBe(1);
    // A drift past 0.25 s is seeked, to where the clock will be when it lands
    music.currentTime = 4.1;
    flushFrame(3500);
    expect(music.currentTime).toBeCloseTo(3.6, 9);
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("starts a clip that begins at 2 s just ahead of 2 s, from its In, at its curve's gain there", () => {
    const curve = [
      { t: 1, gain: 0.25 },
      { t: 3, gain: 1 },
    ];
    const opts = options("blob:a", null, [audioClip({ id: "aclip_1", src: "tone.m4a", startSec: 2, inSec: 1, curve })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const tone = fakeMedia({ duration: 10 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("aclip_1", asAudio(tone));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Coming up: put at its In ahead, paused
    flushFrame(1500);
    expect(tone.paused).toBe(true);
    expect(tone.play).not.toHaveBeenCalled();
    expect(tone.currentTime).toBe(1);
    expect(tone.writes).toBe(1);
    // Its start latency before its start: played from there, so it is moving as the clock reaches it
    flushFrame(1960);
    expect(tone.play).toHaveBeenCalledTimes(1);
    // Inside its span: its In plus the time since its start, at the gain there, never seeked again
    flushFrame(2500);
    expect(tone.currentTime).toBeCloseTo(1.54, 9);
    expect(tone.volume).toBeCloseTo(gainAt(curve, 1.5), 6);
    expect(tone.writes).toBe(1);
  });

  it("pauses a clip past its Out and a muted clip stays silent", () => {
    const opts = options("blob:a", null, [audioClip({ id: "aclip_1", src: "tone.m4a", startSec: 0, inSec: 0, outSec: 2, muted: true })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const tone = fakeMedia({ duration: 10 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("aclip_1", asAudio(tone));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    expectSilent(tone);
    expect(tone.play).toHaveBeenCalledTimes(1);
    flushFrame(2500);
    expect(tone.paused).toBe(true);
  });

  it("hands playback to a <video> remounted under the playhead", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const first = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(first)));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(1000);
    expect(livePlayhead()).toBe(1);

    // React swaps the clip's element: the old one is paused as it leaves, the new one picks up where the clock is
    const second = fakeMedia();
    act(() => {
      result.current.registerVideo("c1", null);
      result.current.registerVideo("c1", asVideo(second));
    });
    expect(first.paused).toBe(true);
    flushFrame(1000);
    expect(second.play).toHaveBeenCalledTimes(1);
    // Where the clock will be when it moves: its start latency on, which the first start taught (the least, 0.01 s:
    // these stand-ins move at once)
    expect(second.currentTime).toBeCloseTo(1.01, 9);
    expect(editor().playing).toBe(true);

    // And it plays on with the clock
    flushFrame(2000);
    expect(livePlayhead()).toBe(2);
    expect(Math.abs(second.currentTime - 2)).toBeLessThan(0.06);
  });

  it("keeps playing when a move to another source aborts the previous element's pending play()", async () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = pendingPlayMedia();
    const b = pendingPlayMedia();
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlaying(true));
    // Moved from outside into the second source's clip: "a" is hidden at once and paused the next frame, before its
    // play() resolved
    act(() => editor().setPlayhead(6));
    flushFrame(0);
    flushFrame(16);
    await act(async () => {
      await Promise.resolve();
    });
    expect(a.pause).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
  });

  it("keeps playing when play starts in a clip's last frame and moves on before play() resolved", async () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = pendingPlayMedia();
    const b = pendingPlayMedia();
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(4.98));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    // "a" reaches its Out while the clock waits for it: "b" is in front now, and the clock waits for it instead
    flushFrame(60);
    expect(livePlayhead()).toBe(4.98);
    flushFrame(120);
    await act(async () => {
      await Promise.resolve();
    });
    // Set off from where "b" is
    expect(livePlayhead()).toBeCloseTo(5.06, 9);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
  });

  it("cuts on the clock, or a hair early when the outgoing element has reached its Out", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(4.9));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    // 20 ms before the cut, in step: the first clip still shows
    flushFrame(80);
    expect(a.style.opacity).toBe("1");
    expect(b.style.opacity).toBe("0");
    // Its element is at its Out already (ahead of the clock): the next clip shows rather than a frame past it
    a.currentTime = 5;
    flushFrame(90);
    expect(livePlayhead()).toBeCloseTo(4.99, 9);
    expect(a.style.opacity).toBe("0");
    expect(b.style.opacity).toBe("1");
    expect(b.muted).toBe(false);
  });

  it("hands a cut over prepared: the next clip timed, then moving before it, the previous paused after, the music untouched", () => {
    const opts: SequencePlaybackOptions = { ...twoSourceOptions(), audio: { clips: [audioClip()] } };
    const { result } = renderHook(() => useSequencePlayback(opts));
    // Seeks take 40 ms, as a real element's do; "a" plays the first 5 s of a longer file, so only the cut stops it
    const a = fakeMedia({ duration: 10, seekMs: 40 });
    const b = fakeMedia({ duration: 5, seekMs: 40 });
    const music = fakeMedia({ duration: 30, seekMs: 40 });
    let bAskedAt: number | null = null;
    b.play.mockImplementation(() => {
      bAskedAt ??= livePlayhead();
      b.paused = false;
      return Promise.resolve();
    });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlayhead(4));
    act(() => editor().setPlaying(true));
    let now = 0;
    const musicWrites = () => music.writes;
    let atStart: number | null = null;
    // Up to the cut: a frame every 16 ms
    while (livePlayhead() < 5) {
      flushFrame(now);
      if (atStart === null && !music.paused) atStart = musicWrites();
      now += 16;
    }
    // b was test-started at its In and put back there (its one seek, long before the cut), then asked to play before
    // the cut
    expect(b.writes).toBe(1);
    expect(b.play).toHaveBeenCalledTimes(2);
    expect(bAskedAt).not.toBeNull();
    expect(bAskedAt!).toBeLessThan(5);
    // The cut: shown and heard at once, moving; a hidden and silent, still playing until the next frame
    expect(b.style.opacity).toBe("1");
    expect(b.muted).toBe(false);
    expect(b.paused).toBe(false);
    expect(b.currentTime).toBeGreaterThan(0);
    expect(a.style.opacity).toBe("0");
    expectSilent(a);
    expect(a.paused).toBe(false);
    flushFrame(now);
    expect(a.paused).toBe(true);
    expect(a.pause).toHaveBeenCalledTimes(1);
    // The music was seeked once, to start, and never across the cut
    for (let k = 0; k < 10; k++) flushFrame((now += 16));
    expect(atStart).toBe(1);
    expect(music.writes).toBe(1);
    expect(music.paused).toBe(false);
  });

  it("times a slow-starting clip by a test start, so a cut into its first frame shows it moving", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    // "b" has sound: every start waits a quarter of a second for the sound output
    const a = fakeMedia({ duration: 10 });
    const b = fakeMedia({ duration: 5, startMs: 250 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(3.5));
    act(() => editor().setPlaying(true));
    let now = 0;
    while (b.style.opacity !== "1") flushFrame((now += 16));
    // Shown at the cut already moving from its first frame, a frame's margin early at most, never still
    expect(livePlayhead()).toBeGreaterThanOrEqual(5);
    expect(b.currentTime).toBeGreaterThan(0.005);
    expect(b.currentTime).toBeLessThan(0.06);
    const shownAt = b.currentTime;
    flushFrame((now += 16));
    expect(b.currentTime).toBeGreaterThan(shownAt);
    expect(b.writes).toBe(1);
  });

  describe.each([
    ["Track", null],
    ["Stacked", { crossfade: false }],
  ] as const)("a cut into a slow-starting clip's first frame, in %s", (_layout, stack) => {
    it.each([24, 60])("shows it moving at %i fps, never a frame behind, and holds nothing past the cut", (fps) => {
      const first = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
      const second = createClip({ kind: "edge", edgeId: "e2" }, { id: "c2" });
      const opts: SequencePlaybackOptions = {
        spans: clipSpans(
          [first, second],
          new Map<SourceKey, number>([
            ["edge:e1", 5],
            ["edge:e2", 5],
          ]),
          0,
        ),
        total: 10,
        srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
        audio: { clips: [] },
        soundOn: true,
        stack,
      };
      const { result } = renderHook(() => useSequencePlayback(opts));
      const a = Object.assign(fakeMedia({ duration: 10 }), { src: "blob:a" });
      // Its decoder and sound output start with it: still for a quarter of a second after each play()
      const b = Object.assign(fakeMedia({ duration: 5, startMs: 250 }), { src: "blob:b" });
      act(() => {
        result.current.registerVideo("c1", asVideo(a));
        result.current.registerVideo("c2", asVideo(b));
      });
      act(() => editor().setPlayhead(3.5));
      act(() => editor().setPlaying(true));
      // The frame of its file each element shows: the one its time is in, at the clip's rate
      const frameOf = (m: FakeMedia) => Math.floor(m.currentTime * fps + 1e-6) / fps;
      let now = 0;
      while (b.style.opacity !== "1") {
        flushFrame((now += 1000 / 60));
        for (const m of [a, b]) if (!m.paused) act(() => m.present(frameOf(m)));
      }
      // At the cut, or a hair early as "a" reached its Out: never a refresh after it
      expect(livePlayhead()).toBeGreaterThan(4.97);
      expect(livePlayhead()).toBeLessThan(5 + 1 / 60 + 1e-6);
      // Its frame the clock's or a little on, never a frame behind; and moving
      const target = Math.max(0, livePlayhead() - 5);
      expect(frameOf(b)).toBeGreaterThanOrEqual(target - 1 / fps - 1e-6);
      expect(b.currentTime - target).toBeLessThan(0.05);
      const shown = b.currentTime;
      flushFrame((now += 1000 / 60));
      expect(b.currentTime).toBeGreaterThan(shown);
      expect(b.soundSwitches).toBe(0);
    });
  });

  it("learns a start's latency from the frames it shows, up to a slower one at once", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    // Its file has sound: an element of it moves a quarter of a second after play()
    const first = Object.assign(fakeMedia({ startMs: 250 }), { src: "blob:a" });
    act(() => result.current.registerVideo("c1", asVideo(first)));
    act(() => editor().setPlaying(true));
    let now = 0;
    while (livePlayhead() < 1) {
      flushFrame((now += 16));
      if (!first.paused) act(() => first.present(first.currentTime));
    }
    // Another element of the file takes over: started where the clock will be when it moves, by that start
    const second = Object.assign(fakeMedia({ startMs: 250 }), { src: "blob:a" });
    act(() => {
      result.current.registerVideo("c1", null);
      result.current.registerVideo("c1", asVideo(second));
    });
    flushFrame((now += 16));
    expect(second.play).toHaveBeenCalledTimes(1);
    expect(second.currentTime - livePlayhead()).toBeGreaterThan(0.23);
    expect(second.currentTime - livePlayhead()).toBeLessThan(0.27);
  });

  it("starts a trimmed clip's pre-roll from where it waits, never moved back for its margin", () => {
    // One source cut in two at 2.5 s, in Track: the second piece waits half a second before its In
    const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
    const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 0),
      total: 5,
      srcFor: () => "blob:a",
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5, startMs: 250 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(0.5));
    act(() => editor().setPlaying(true));
    let now = 0;
    let started = 0;
    // A frame every 4 ms, so the start lands within a hair of when it is due
    while (b.style.opacity !== "1") {
      flushFrame((now += 4));
      if (b.play.mock.calls.length === 2 && started === 0) started = b.writes;
    }
    // Its seeks: to the pre-roll point, and back there after its test start; none at its start
    expect(started).toBe(2);
    expect(b.writes).toBe(2);
    expect(b.currentTime).toBeGreaterThan(2.5);
    expect(b.currentTime).toBeLessThan(2.56);
  });

  it("holds a cut on the outgoing picture until the incoming element has shown a frame of where it is", () => {
    // One source cut in two at 2.5 s, in Track
    const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
    const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 0),
      total: 5,
      srcFor: () => "blob:a",
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(1.5));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Prepared at its pre-roll point, and that frame shown (as a browser does after a seek)
    expect(b.currentTime).toBeCloseTo(2, 9);
    act(() => b.present(2));
    // It plays on towards its In, but the browser shows no newer frame of it: past the cut, the picture stays on
    // "a", still
    let now = 100;
    while (livePlayhead() < 2.55) flushFrame((now += 16));
    expect(b.paused).toBe(false);
    expect(b.currentTime).toBeGreaterThan(2.5);
    expect(a.style.opacity).toBe("1");
    expect(a.paused).toBe(true);
    expect(b.style.opacity).toBe("0");
    expectSilent(b);
    // A frame of where it is: the cut goes through
    act(() => b.present(b.currentTime));
    flushFrame((now += 16));
    expect(b.style.opacity).toBe("1");
    expect(b.muted).toBe(false);
    expect(a.style.opacity).toBe("0");
  });

  it("never turns a playing element's sound on from silent: not at a cut, a fade from 0 or the sound toggle", () => {
    const fade = audioClip({ curve: [{ t: 0, gain: 0 }, { t: 6, gain: 1 }] });
    let opts: SequencePlaybackOptions = { ...twoSourceOptions(), audio: { clips: [fade] } };
    const { result, rerender } = renderHook((o: SequencePlaybackOptions) => useSequencePlayback(o), { initialProps: opts });
    const a = fakeMedia({ duration: 10 });
    const b = fakeMedia({ duration: 5 });
    const music = fakeMedia({ duration: 30 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlayhead(4));
    act(() => editor().setPlaying(true));
    let now = 0;
    // Through the cut at 5 s, the music rising from silence
    while (livePlayhead() < 5.5) {
      flushFrame(now);
      act(() => b.present(b.currentTime));
      now += 16;
    }
    expect(b.style.opacity).toBe("1");
    expect(b.volume).toBe(1);
    // Sound off and on again while playing
    opts = { ...opts, soundOn: false };
    rerender(opts);
    flushFrame((now += 16));
    expectSilent(b);
    expectSilent(music);
    opts = { ...opts, soundOn: true };
    rerender(opts);
    flushFrame((now += 16));
    expect(b.volume).toBe(1);
    expect(music.volume).toBeGreaterThan(0.5);
    expect(a.soundSwitches + b.soundSwitches + music.soundSwitches).toBe(0);
  });

  it("gives up holding for a fresher frame after a tenth of a second", () => {
    const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
    const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 0),
      total: 5,
      srcFor: () => "blob:a",
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(1.5));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    act(() => b.present(2));
    let now = 100;
    // A browser that shows no frame of the hidden element: the cut waits a tenth of a second, then goes through
    while (livePlayhead() < 2.55) flushFrame((now += 16));
    expect(b.style.opacity).toBe("0");
    while (livePlayhead() < 2.65) flushFrame((now += 16));
    expect(b.style.opacity).toBe("1");
    expect(a.style.opacity).toBe("0");
  });

  it("loads ahead only the clips shown, playing and coming up", () => {
    const clip = (id: string, edgeId: string) => createClip({ kind: "edge", edgeId }, { id });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans(
        [clip("c1", "e1"), clip("c2", "e2"), clip("c3", "e3")],
        new Map<SourceKey, number>([
          ["edge:e1", 5],
          ["edge:e2", 5],
          ["edge:e3", 5],
        ]),
        0,
      ),
      total: 15,
      srcFor: (clipId) => `blob:${clipId}`,
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const media = [fakeMedia({ duration: 5 }), fakeMedia({ duration: 5 }), fakeMedia({ duration: 5 })];
    const preload = () => media.map((m) => (m as unknown as { preload?: string }).preload ?? "metadata");
    act(() => media.forEach((m, i) => result.current.registerVideo(`c${i + 1}`, asVideo(m))));
    act(() => editor().setPlayhead(1));
    expect(preload()).toEqual(["auto", "metadata", "metadata"]);
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Playing c1: c2 is next
    expect(preload()).toEqual(["auto", "auto", "metadata"]);
  });

  it("stops when the element playing now refuses to play", async () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    video.play.mockImplementation(() => Promise.reject(new DOMException("No autoplay", "NotAllowedError")));
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlaying(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor().playing).toBe(false);
  });

  it("drops a paused seek still in flight when playback starts", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    const onSeeked = video.addEventListener.mock.calls.find(([type]) => type === "seeked")![1] as (e: Event) => void;

    // Paused, Go to end while a seek is still running: the target waits for 'seeked'
    video.seeking = true;
    act(() => editor().setPlayhead(9.5));
    // Space before it lands: playback starts at 9.5 and later runs on
    act(() => editor().setPlaying(true));
    video.seeking = false;
    video.currentTime = 9.6;
    onSeeked({ currentTarget: video } as unknown as Event);
    expect(video.currentTime).toBe(9.6);
  });

  describe("Stacked", () => {
    /** c1 then c2, 5 s each from sources "a" and "b", overlapping by 1 s: c1 0–5, c2 4–9. */
    function stackedOptions(crossfade = true, volume = 1): SequencePlaybackOptions {
      const first = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", volume });
      const second = createClip({ kind: "edge", edgeId: "e2" }, { id: "c2" });
      const durations = new Map<SourceKey, number>([
        ["edge:e1", 5],
        ["edge:e2", 5],
      ]);
      return {
        spans: clipSpans([first, second], durations, 1),
        total: 9,
        srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
        audio: { clips: [] },
        soundOn: true,
        stack: { crossfade },
      };
    }

    function mount(opts: SequencePlaybackOptions) {
      const hook = renderHook(() => useSequencePlayback(opts));
      const a = fakeMedia({ duration: 5 });
      const b = fakeMedia({ duration: 5 });
      act(() => {
        hook.result.current.registerVideo("c1", asVideo(a));
        hook.result.current.registerVideo("c2", asVideo(b));
      });
      a.writes = 0;
      b.writes = 0;
      return { ...hook, a, b };
    }

    it("shows both clips of an overlap while paused, the later at the blend's share", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(4.25));
      expect(a.currentTime).toBe(4.25);
      expect(b.currentTime).toBe(0.25);
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0.25");
      // Out of the overlap: only the clip under the playhead
      act(() => editor().setPlayhead(6));
      expect(a.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("1");
      expect(b.currentTime).toBe(2);
    });

    it("starts the later clip hidden just before an overlap, timed by a test start, without pausing the earlier one", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      expect(a.play).toHaveBeenCalledTimes(1);
      // The later clip is next: test-started from its In, hidden and silent, to time its start
      flushFrame(0);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.style.opacity).toBe("0");
      expectSilent(b);
      // Once it moves, put back at its In to wait
      flushFrame(600);
      expect(b.paused).toBe(true);
      expect(b.currentTime).toBe(0);
      expect(b.writes).toBe(1);
      // Its own start latency before its start: it plays, hidden and silent
      flushFrame(980);
      expect(b.play).toHaveBeenCalledTimes(2);
      expect(b.style.opacity).toBe("0");
      expectSilent(b);
      // Its start: shown and heard, moving and in step
      flushFrame(1050);
      expect(Number(b.style.opacity)).toBeCloseTo(0.05, 9);
      expect(b.muted).toBe(false);
      expect(b.currentTime).toBeCloseTo(0.07, 9);
      expect(b.play).toHaveBeenCalledTimes(2);
      expect(b.writes).toBe(1);
      expect(a.pause).not.toHaveBeenCalled();
      expect(livePlayhead()).toBeCloseTo(4.05, 9);
    });

    it("ramps the two volumes on equal power, times each clip's own volume", () => {
      const { a, b } = mount(stackedOptions(true, 0.8));
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(350);
      const angle = (0.25 * Math.PI) / 2;
      expect(a.volume).toBeCloseTo(0.8 * Math.cos(angle), 9);
      expect(b.volume).toBeCloseTo(Math.sin(angle), 9);
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0.25");
    });

    it("blends in a clip with sound from silent, never from muted or 0", () => {
      const { a, b } = mount(stackedOptions(true));
      act(() => editor().setPlayhead(3.5));
      act(() => editor().setPlaying(true));
      for (let now = 0; now <= 1600; now += 16) flushFrame(now);
      expect(b.volume).toBe(1);
      expect(a.soundSwitches + b.soundSwitches).toBe(0);
    });

    it("plays the later clip on through the earlier one's Out, with no seek", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(600);
      expect(b.paused).toBe(false);
      const writes = b.writes;
      // The earlier clip reaches its Out: it is paused and hidden, the later one plays on as it is
      flushFrame(1100);
      expect(b.writes).toBe(writes);
      expect(livePlayhead()).toBeCloseTo(5, 9);
      expect(a.paused).toBe(true);
      expect(a.style.opacity).toBe("0");
      flushFrame(2100);
      expect(livePlayhead()).toBeCloseTo(6, 9);
      expect(Math.abs(b.currentTime - 2)).toBeLessThan(0.05);
      expect(b.writes).toBe(writes);
      expect(editor().playing).toBe(true);
    });

    it("draws an overlap's blend on the canvas while playing, the elements hidden under it", () => {
      const { a, b, result } = mount(stackedOptions());
      const draws: Array<[unknown, number]> = [];
      const ctx = {
        globalAlpha: 1,
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn((el: unknown) => draws.push([el, ctx.globalAlpha])),
      };
      const canvas = { style: { opacity: "" }, width: 0, height: 0, clientWidth: 640, clientHeight: 360, getContext: vi.fn(() => ctx) };
      act(() => result.current.registerCanvas(canvas as unknown as HTMLCanvasElement));
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      // One clip: it shows itself
      expect(canvas.style.opacity).toBe("0");
      expect(a.style.opacity).toBe("1");
      // The overlap: both drawn in row order at their shares, letterboxed into the canvas, on black
      flushFrame(350);
      expect(canvas.style.opacity).toBe("1");
      expect(a.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("0");
      expect(canvas.width).toBe(640);
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 640, 360);
      expect(draws).toEqual([
        [a, 1],
        [b, 0.25],
      ]);
      expect(ctx.drawImage).toHaveBeenLastCalledWith(b, 0, 0, 640, 360);
      // Both still heard, at their shares
      expect(a.muted).toBe(false);
      expect(b.muted).toBe(false);
      // Past the overlap: the later clip shows itself again
      flushFrame(1200);
      expect(canvas.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("1");
      // Paused in an overlap the elements blend themselves
      act(() => editor().setPlaying(false));
      act(() => editor().setPlayhead(4.5));
      expect(canvas.style.opacity).toBe("0");
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0.5");
    });

    it("nudges a layer that falls behind by its rate, never seeking it", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(4.2));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      const writes = b.writes;
      // b stands still for a tenth of a second: 0.1 s behind, played 2 % faster
      b.frozen = true;
      flushFrame(200);
      b.frozen = false;
      flushFrame(216);
      expect(b.playbackRate).toBe(1.02);
      expect(b.writes).toBe(writes);
      // Caught up: its rate is 1 again
      for (let now = 232; now <= 6000 && b.playbackRate !== 1; now += 16) flushFrame(now);
      expect(b.playbackRate).toBe(1);
      expect(b.writes).toBe(writes);
      expect(a.writes).toBe(1);
    });

    it("keeps the earlier clip in front with Crossfade off, both heard in full", () => {
      const { a, b } = mount(stackedOptions(false));
      act(() => editor().setPlayhead(4.5));
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0");
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      expect(b.paused).toBe(false);
      expect(a.volume).toBe(1);
      expect(b.volume).toBe(1);
      expect(b.style.opacity).toBe("0");
    });

    it("plays a cut between two pieces of one video from the next piece's pre-roll", () => {
      const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
      const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
      const opts: SequencePlaybackOptions = {
        spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 1),
        total: 5,
        srcFor: () => "blob:a",
        audio: { clips: [] },
        soundOn: true,
        stack: { crossfade: true },
      };
      expect(opts.spans[1].start).toBe(2.5);
      const { a, b } = mount(opts);
      act(() => editor().setPlayhead(1.4));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      // Test-started at its pre-roll point, half a second before its In, and put back there to wait
      expect(livePlayhead()).toBeCloseTo(1.5, 9);
      expect(b.currentTime).toBeCloseTo(2, 9);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.writes).toBe(2);
      expect(b.paused).toBe(true);
      // Started the pre-roll and its start latency before the cut, from there
      flushFrame(580);
      expect(b.play).toHaveBeenCalledTimes(2);
      expect(b.writes).toBe(2);
      expect(b.style.opacity).toBe("0");
      expectSilent(b);
      // The cut: shown at its In, the earlier piece hidden and silent at once and paused a frame later
      flushFrame(1100);
      expect(livePlayhead()).toBeCloseTo(2.5, 9);
      expect(b.style.opacity).toBe("1");
      expect(b.currentTime).toBeCloseTo(2.52, 9);
      expect(a.style.opacity).toBe("0");
      expectSilent(a);
      expect(a.paused).toBe(false);
      flushFrame(1116);
      expect(a.paused).toBe(true);
      expect(b.writes).toBe(2);
      expect(b.play).toHaveBeenCalledTimes(2);
    });

    it("seeks a clip back to the playhead when its URL changes and the new file's metadata loads", () => {
      const { a } = mount(stackedOptions());
      act(() => editor().setPlayhead(2));
      expect(a.currentTime).toBe(2);
      const onLoaded = a.addEventListener.mock.calls.find(([type]) => type === "loadedmetadata")![1] as () => void;
      // The data: to blob: swap keeps the element and sends it back to 0
      a.currentTime = 0;
      onLoaded();
      expect(a.currentTime).toBe(2);
    });

    it("picks a clip up where the clock is when its URL changes while playing", () => {
      const { a } = mount(stackedOptions());
      act(() => editor().setPlayhead(1));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(1000);
      expect(livePlayhead()).toBe(2);
      // The load pauses the element and sends it back to 0, keeping it
      const onLoaded = a.addEventListener.mock.calls.find(([type]) => type === "loadedmetadata")![1] as () => void;
      a.paused = true;
      a.currentTime = 0;
      onLoaded();
      flushFrame(1000);
      expect(a.play).toHaveBeenCalledTimes(2);
      // Its start latency on, as its first start taught (the least: these stand-ins move at once)
      expect(a.currentTime).toBeCloseTo(2.01, 9);
      expect(editor().playing).toBe(true);
      flushFrame(1500);
      expect(livePlayhead()).toBeCloseTo(2.5, 9);
    });

    describe("placed", () => {
      /** One clip per entry, in row order: [id, source length, startSec]; each from its own source "blob:<id>". */
      function placedOptions(rows: Array<[string, number, number]>, crossfade = true): SequencePlaybackOptions {
        const timeline = rows.map(([id, , startSec]) => createClip({ kind: "edge", edgeId: id }, { id, startSec }));
        const durations = new Map<SourceKey, number>(rows.map(([id, length]) => [`edge:${id}` as SourceKey, length]));
        const spans = layoutSpans(timeline, durations, { mode: "stacked", overlapSec: 1, crossfade });
        return {
          spans,
          total: spansEnd(spans),
          srcFor: (clipId) => `blob:${clipId}`,
          audio: { clips: [] },
          soundOn: true,
          stack: { crossfade, placed: true },
        };
      }

      function mountRows(opts: SequencePlaybackOptions) {
        const hook = renderHook(() => useSequencePlayback(opts));
        const media = new Map(opts.spans.map((span) => [span.clip.id, fakeMedia({ duration: span.length })]));
        act(() => {
          for (const [id, m] of media) hook.result.current.registerVideo(id, asVideo(m));
        });
        for (const m of media.values()) m.writes = 0;
        return { ...hook, media, el: (id: string) => media.get(id)! };
      }

      const opacities = (media: Map<string, FakeMedia>) => [...media.values()].map((m) => Number(m.style.opacity));

      // placed-three: A [0,5), B [2,7), C [3.5,9.5), top to bottom
      const placedThree = () =>
        placedOptions([
          ["A", 5, 0],
          ["B", 5, 2],
          ["C", 6, 3.5],
        ]);

      it("hides every element while paused in a gap", () => {
        const { media } = mountRows(
          placedOptions([
            ["A", 2, 0],
            ["B", 3, 4],
          ]),
        );
        act(() => editor().setPlayhead(1));
        expect(opacities(media)).toEqual([1, 0]);
        act(() => editor().setPlayhead(3));
        expect(opacities(media)).toEqual([0, 0]);
      });

      it("plays through a gap on the clock and starts the next clip at its start without stopping", () => {
        const { el, media } = mountRows(
          placedOptions([
            ["A", 2, 0],
            ["B", 3, 4],
          ]),
        );
        act(() => editor().setPlayhead(1.5));
        act(() => editor().setPlaying(true));
        flushFrame(0);
        // A reaches its Out: nothing plays until B, and the clock goes on
        flushFrame(500);
        expect(livePlayhead()).toBe(2);
        expect(editor().playing).toBe(true);
        flushFrame(516);
        expect(opacities(media)).toEqual([0, 0]);
        flushFrame(2000);
        expect(livePlayhead()).toBeCloseTo(3.5, 9);
        expect(el("B").play).not.toHaveBeenCalled();
        // Started its start latency and margin ahead, from its In
        flushFrame(2440);
        expect(editor().playing).toBe(true);
        expect(el("B").play).toHaveBeenCalledTimes(1);
        expect(el("B").currentTime).toBe(0);
        flushFrame(3500);
        expect(livePlayhead()).toBeCloseTo(5, 9);
        // Early by its first-guess latency and margin at most: these stand-ins move at once
        expect(Math.abs(el("B").currentTime - 1)).toBeLessThan(0.09);
        expect(el("B").writes).toBe(0);
      });

      it("holds the frame across a gap under a slot, paused and playing, as the encode does", () => {
        const { el, media } = mountRows(
          placedOptions([
            ["A", 5, 0],
            ["C", 5, 5.01],
          ]),
        );
        act(() => editor().setPlayhead(5.005));
        expect(opacities(media)).toEqual([1, 0]);
        act(() => editor().setPlayhead(4.9));
        act(() => editor().setPlaying(true));
        flushFrame(1000);
        // The clock reaches C's start: it plays with no frame of black before it
        flushFrame(1105);
        expect(opacities(media)).toEqual([1, 0]);
        flushFrame(1110);
        expect(editor().playing).toBe(true);
        expect(livePlayhead()).toBeCloseTo(5.01, 9);
        expect(opacities(media)).toEqual([0, 1]);
        expect(el("C").play).toHaveBeenCalledTimes(1);
      });

      it("starts from a gap on the clock", () => {
        const { el } = mountRows(
          placedOptions([
            ["A", 2, 0],
            ["B", 3, 4],
          ]),
        );
        act(() => editor().setPlayhead(3));
        act(() => editor().setPlaying(true));
        expect(editor().playing).toBe(true);
        flushFrame(0);
        flushFrame(500);
        expect(livePlayhead()).toBeCloseTo(3.5, 9);
        expect(el("A").play).not.toHaveBeenCalled();
      });

      it("plays and pauses a clip inside the one below, which plays on", () => {
        // B on the higher row, wholly inside A
        const { el } = mountRows(
          placedOptions([
            ["B", 2, 3],
            ["A", 10, 0],
          ]),
        );
        act(() => editor().setPlayhead(2));
        act(() => editor().setPlaying(true));
        expect(el("A").play).toHaveBeenCalledTimes(1);
        flushFrame(0);
        flushFrame(1500);
        expect(el("B").paused).toBe(false);
        expect(livePlayhead()).toBe(3.5);
        flushFrame(3500);
        expect(el("B").paused).toBe(true);
        expect(el("A").pause).not.toHaveBeenCalled();
        expect(livePlayhead()).toBe(5.5);
      });

      it("gives three layers their opacities in row order, the DOM's", () => {
        const { media } = mountRows(placedThree());
        act(() => editor().setPlayhead(4.75));
        const [a, b, c] = opacities(media);
        expect(a).toBeCloseTo(1, 2);
        expect(b).toBeCloseTo(0.908, 2);
        expect(c).toBeCloseTo(0.092, 2);
        // C is hidden under B here
        act(() => editor().setPlayhead(4));
        const [a4, b4, c4] = opacities(media);
        expect(a4).toBeCloseTo(1, 2);
        expect(b4).toBeCloseTo(0.667, 2);
        expect(c4).toBe(0);
      });

      it("keeps a hidden clip's element playing, at opacity 0, in step", () => {
        const { el } = mountRows(placedThree());
        act(() => editor().setPlayhead(3.9));
        act(() => editor().setPlaying(true));
        flushFrame(0);
        flushFrame(100);
        expect(el("C").paused).toBe(false);
        expect(el("C").style.opacity).toBe("0");
        expect(el("C").currentTime).toBeCloseTo(0.5, 9);
      });
    });
  });
});
