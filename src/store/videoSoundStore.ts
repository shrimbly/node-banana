import { create } from "zustand";

/**
 * Sound for the canvas's video players: one setting shared by every player
 * and kept between sessions, as in a video app. Hover previews start many
 * videos at once and stay silent whatever this says; sound plays only once
 * the user has pinned playback (see useVideoAutoplay).
 */
export const VIDEO_SOUND_STORAGE_KEY = "node-banana-video-sound";

export interface VideoSoundState {
  /** The sound button: on shows the speaker with its waves. */
  on: boolean;
  /** 0–1; 0 plays silent even when on. */
  volume: number;
  setOn: (on: boolean) => void;
  toggle: () => void;
  setVolume: (volume: number) => void;
}

function readStored(): { on: boolean; volume: number } {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(VIDEO_SOUND_STORAGE_KEY);
    if (!raw) return { on: false, volume: 1 };
    const parsed = JSON.parse(raw) as { on?: unknown; volume?: unknown };
    const volume = typeof parsed.volume === "number" && Number.isFinite(parsed.volume) ? Math.min(1, Math.max(0, parsed.volume)) : 1;
    return { on: parsed.on === true, volume };
  } catch {
    return { on: false, volume: 1 };
  }
}

function persist(state: { on: boolean; volume: number }): void {
  try {
    localStorage.setItem(VIDEO_SOUND_STORAGE_KEY, JSON.stringify({ on: state.on, volume: state.volume }));
  } catch {
    // A full or blocked store only loses the preference for next time.
  }
}

export const useVideoSoundStore = create<VideoSoundState>((set, get) => ({
  ...readStored(),
  setOn: (on) => {
    set({ on });
    persist(get());
  },
  toggle: () => {
    set({ on: !get().on });
    persist(get());
  },
  setVolume: (volume) => {
    set({ volume: Math.min(1, Math.max(0, volume)) });
    persist(get());
  },
}));

/** Whether a player that the user has pinned should be heard. */
export function soundAudible(state: Pick<VideoSoundState, "on" | "volume">): boolean {
  return state.on && state.volume > 0;
}
