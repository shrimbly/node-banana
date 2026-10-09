import { describe, it, expect, beforeEach } from "vitest";
import { VIDEO_SOUND_STORAGE_KEY, soundAudible, useVideoSoundStore } from "../videoSoundStore";

describe("videoSoundStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useVideoSoundStore.setState({ on: false, volume: 1 });
  });

  it("starts silent at full volume and remembers each change", () => {
    expect(useVideoSoundStore.getState()).toMatchObject({ on: false, volume: 1 });
    useVideoSoundStore.getState().toggle();
    expect(JSON.parse(localStorage.getItem(VIDEO_SOUND_STORAGE_KEY)!)).toEqual({ on: true, volume: 1 });
    useVideoSoundStore.getState().setVolume(0.4);
    expect(JSON.parse(localStorage.getItem(VIDEO_SOUND_STORAGE_KEY)!)).toEqual({ on: true, volume: 0.4 });
    useVideoSoundStore.getState().setOn(false);
    expect(JSON.parse(localStorage.getItem(VIDEO_SOUND_STORAGE_KEY)!)).toEqual({ on: false, volume: 0.4 });
  });

  it("keeps the volume within 0 and 1", () => {
    useVideoSoundStore.getState().setVolume(4);
    expect(useVideoSoundStore.getState().volume).toBe(1);
    useVideoSoundStore.getState().setVolume(-1);
    expect(useVideoSoundStore.getState().volume).toBe(0);
  });

  it("is audible only when on and above zero", () => {
    expect(soundAudible({ on: true, volume: 0.5 })).toBe(true);
    expect(soundAudible({ on: true, volume: 0 })).toBe(false);
    expect(soundAudible({ on: false, volume: 1 })).toBe(false);
  });
});
