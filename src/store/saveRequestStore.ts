import { create } from "zustand";

/** Where a save was asked for; the toast on failure reads differently for each. */
export type SaveReason = "shortcut" | "button" | "menu" | "desktop";

interface SaveRequestState {
  /** A pending request to save the current workflow; the floating menu consumes it. */
  request: { reason: SaveReason; at: number; name?: string } | null;
  /** `name` fills in the first-save dialog, when the workflow has no folder yet (the agent's chosen name). */
  requestSave: (reason: SaveReason, name?: string) => void;
  consumeRequest: () => void;
}

/**
 * One way to ask for a save from anywhere: Cmd/Ctrl+S on the canvas, the
 * desktop app's File › Save, or any view without the floating menu in reach.
 * The floating menu hosts the first-save dialog, so it is the one that
 * answers: it saves a configured workflow, and asks for a name and location
 * for one that has none.
 */
export const useSaveRequestStore = create<SaveRequestState>((set) => ({
  request: null,
  requestSave: (reason, name) => set({ request: { reason, at: Date.now(), ...(name ? { name } : {}) } }),
  consumeRequest: () => set({ request: null }),
}));

export const requestSave = (reason: SaveReason, name?: string) => useSaveRequestStore.getState().requestSave(reason, name);
