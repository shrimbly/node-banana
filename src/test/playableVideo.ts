import { vi } from "vitest";

export interface PlayableVideoState {
  paused?: boolean;
  currentTime?: number;
  duration?: number;
}

/**
 * Make a jsdom <video> play, keep time and end the way a browser's does:
 * play() and pause() fire their events, setting currentTime fires
 * timeupdate, and end() runs it out. jsdom's own element never plays.
 */
export function makePlayable<T extends HTMLVideoElement>(
  el: T,
  { paused = true, currentTime = 0, duration = 8 }: PlayableVideoState = {}
): T & { end: () => void } {
  const state = { paused, currentTime };
  Object.defineProperties(el, {
    paused: { configurable: true, get: () => state.paused },
    duration: { configurable: true, get: () => duration },
    readyState: { configurable: true, get: () => 1 },
    currentTime: {
      configurable: true,
      get: () => state.currentTime,
      set: (t: number) => {
        state.currentTime = t;
        el.dispatchEvent(new Event("timeupdate"));
      },
    },
  });
  el.play = vi.fn(() => {
    state.paused = false;
    el.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  el.pause = vi.fn(() => {
    state.paused = true;
    el.dispatchEvent(new Event("pause"));
  });
  const end = () => {
    state.paused = true;
    el.dispatchEvent(new Event("pause"));
    el.dispatchEvent(new Event("ended"));
  };
  return Object.assign(el, { end });
}

/** A new <video> that plays (see makePlayable). */
export function playableVideo(state?: PlayableVideoState) {
  return makePlayable(document.createElement("video"), state);
}
