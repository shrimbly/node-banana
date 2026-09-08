import { create } from "zustand";

/** One finished generation, or a burst of them collapsed into a single card. */
export interface GenerationToastItem {
  id: string;
  /** Newest first; more than one when a batch landed together. */
  images: string[];
  /** Producer, as recorded in the history item (a Gemini model id or an app name). */
  model: string;
  aspectRatio: string;
  /** Last time the card was created or extended; the dismiss timer runs from here. */
  shownAt: number;
}

interface GenerationToastState {
  toasts: GenerationToastItem[];
  push: (item: { image: string; model: string; aspectRatio: string }) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** How long a card stays before dismissing itself. */
export const GENERATION_TOAST_DURATION_MS = 5000;
/** Generations from the same producer landing within this window share a card. */
export const GENERATION_TOAST_BATCH_MS = 1500;
const MAX_TOASTS = 3;

/**
 * Cards announcing a finished generation, shown under the history button.
 * Kept out of the workflow store because they belong to the session, not the
 * document, and must never be written into a saved workflow.
 */
export const useGenerationToast = create<GenerationToastState>((set) => ({
  toasts: [],
  push: ({ image, model, aspectRatio }) =>
    set((state) => {
      const now = Date.now();
      const [latest, ...rest] = state.toasts;
      if (latest && latest.model === model && now - latest.shownAt < GENERATION_TOAST_BATCH_MS) {
        return {
          toasts: [{ ...latest, images: [image, ...latest.images], shownAt: now }, ...rest],
        };
      }
      const toast: GenerationToastItem = {
        id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
        images: [image],
        model,
        aspectRatio,
        shownAt: now,
      };
      return { toasts: [toast, ...state.toasts].slice(0, MAX_TOASTS) };
    }),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
