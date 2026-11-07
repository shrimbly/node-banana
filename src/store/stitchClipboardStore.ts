import { create } from "zustand";
import type { StitchClipboard } from "@/lib/stitch/clipboard";

/**
 * The Edit Video editor's clipboard: the clips ⌘C or ⌘X took, in memory for
 * as long as the page lives. It outlives an editing session, so clips paste
 * into another node; nothing persists it, and the system clipboard is never
 * written.
 */

export interface StitchClipboardState {
  clipboard: StitchClipboard | null;
  setClipboard(clipboard: StitchClipboard | null): void;
}

export const useStitchClipboard = create<StitchClipboardState>((set) => ({
  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard }),
}));
