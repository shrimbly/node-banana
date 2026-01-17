import { create } from "zustand";
import { MaskStroke } from "@/types";

interface MaskInpaintStore {
  // Modal state
  isModalOpen: boolean;
  sourceNodeId: string | null;
  sourceImage: string | null;

  // Mask strokes
  strokes: MaskStroke[];
  selectedStrokeId: string | null;

  // History for undo/redo
  history: MaskStroke[][];
  historyIndex: number;

  // Brush settings
  brushSize: number;
  isEraser: boolean;
  maskFeather: number;
  maskExpansion: number;

  // Modal actions
  openModal: (
    nodeId: string,
    image: string,
    existingStrokes?: MaskStroke[],
    settings?: { brushSize?: number; maskFeather?: number; maskExpansion?: number }
  ) => void;
  closeModal: () => void;

  // Stroke actions
  addStroke: (stroke: MaskStroke) => void;
  updateStroke: (id: string, updates: Partial<MaskStroke>) => void;
  deleteStroke: (id: string) => void;
  clearStrokes: () => void;
  selectStroke: (id: string | null) => void;

  // History actions
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;

  // Brush settings actions
  setBrushSize: (size: number) => void;
  setIsEraser: (isEraser: boolean) => void;
  setMaskFeather: (feather: number) => void;
  setMaskExpansion: (expansion: number) => void;
}

export const useMaskInpaintStore = create<MaskInpaintStore>((set, get) => ({
  isModalOpen: false,
  sourceNodeId: null,
  sourceImage: null,
  strokes: [],
  selectedStrokeId: null,
  history: [[]],
  historyIndex: 0,
  brushSize: 30,
  isEraser: false,
  maskFeather: 5,
  maskExpansion: 0,

  openModal: (
    nodeId: string,
    image: string,
    existingStrokes: MaskStroke[] = [],
    settings?: { brushSize?: number; maskFeather?: number; maskExpansion?: number }
  ) => {
    set({
      isModalOpen: true,
      sourceNodeId: nodeId,
      sourceImage: image,
      strokes: existingStrokes,
      selectedStrokeId: null,
      history: [existingStrokes],
      historyIndex: 0,
      brushSize: settings?.brushSize ?? 30,
      maskFeather: settings?.maskFeather ?? 5,
      maskExpansion: settings?.maskExpansion ?? 0,
    });
  },

  closeModal: () => {
    set({
      isModalOpen: false,
      sourceNodeId: null,
      sourceImage: null,
      strokes: [],
      selectedStrokeId: null,
      history: [[]],
      historyIndex: 0,
    });
  },

  addStroke: (stroke: MaskStroke) => {
    const { pushHistory } = get();
    pushHistory();
    set((state) => ({
      strokes: [...state.strokes, stroke],
    }));
  },

  updateStroke: (id: string, updates: Partial<MaskStroke>) => {
    set((state) => ({
      strokes: state.strokes.map((stroke) =>
        stroke.id === id ? { ...stroke, ...updates } : stroke
      ),
    }));
  },

  deleteStroke: (id: string) => {
    const { pushHistory } = get();
    pushHistory();
    set((state) => ({
      strokes: state.strokes.filter((stroke) => stroke.id !== id),
      selectedStrokeId: state.selectedStrokeId === id ? null : state.selectedStrokeId,
    }));
  },

  clearStrokes: () => {
    const { pushHistory } = get();
    pushHistory();
    set({
      strokes: [],
      selectedStrokeId: null,
    });
  },

  selectStroke: (id: string | null) => {
    set({ selectedStrokeId: id });
  },

  pushHistory: () => {
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push([...state.strokes]);
      return {
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
  },

  undo: () => {
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return {
          historyIndex: newIndex,
          strokes: [...state.history[newIndex]],
          selectedStrokeId: null,
        };
      }
      return state;
    });
  },

  redo: () => {
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return {
          historyIndex: newIndex,
          strokes: [...state.history[newIndex]],
          selectedStrokeId: null,
        };
      }
      return state;
    });
  },

  setBrushSize: (size: number) => {
    set({ brushSize: Math.max(1, Math.min(100, size)) });
  },

  setIsEraser: (isEraser: boolean) => {
    set({ isEraser });
  },

  setMaskFeather: (feather: number) => {
    set({ maskFeather: Math.max(0, Math.min(50, feather)) });
  },

  setMaskExpansion: (expansion: number) => {
    set({ maskExpansion: Math.max(-20, Math.min(50, expansion)) });
  },
}));
