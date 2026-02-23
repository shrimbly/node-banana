import { create } from "zustand";
import { MaskElement, MaskTool } from "@/types";

interface MaskPainterStore {
  // Modal state
  isModalOpen: boolean;
  sourceNodeId: string | null;
  sourceImage: string | null;

  // Elements (strokes + shapes)
  strokes: MaskElement[];

  // History for undo/redo
  history: MaskElement[][];
  historyIndex: number;

  // Tool state
  currentTool: MaskTool;
  brushSize: number;

  // Modal actions
  openModal: (nodeId: string, image: string, existingStrokes?: MaskElement[]) => void;
  closeModal: () => void;

  // Element actions
  addStroke: (stroke: MaskElement) => void;
  clear: () => void;

  // History actions
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;

  // Tool actions
  setTool: (tool: MaskTool) => void;
  setBrushSize: (size: number) => void;
}

export const useMaskPainterStore = create<MaskPainterStore>((set, get) => ({
  isModalOpen: false,
  sourceNodeId: null,
  sourceImage: null,
  strokes: [],
  history: [[]],
  historyIndex: 0,
  currentTool: "brush",
  brushSize: 30,

  openModal: (nodeId: string, image: string, existingStrokes: MaskElement[] = []) => {
    set({
      isModalOpen: true,
      sourceNodeId: nodeId,
      sourceImage: image,
      strokes: existingStrokes,
      history: [existingStrokes],
      historyIndex: 0,
      currentTool: "brush",
    });
  },

  closeModal: () => {
    set({
      isModalOpen: false,
      sourceNodeId: null,
      sourceImage: null,
      strokes: [],
      history: [[]],
      historyIndex: 0,
    });
  },

  addStroke: (stroke: MaskElement) => {
    const { pushHistory } = get();
    pushHistory();
    set((state) => ({
      strokes: [...state.strokes, stroke],
    }));
  },

  clear: () => {
    const { pushHistory } = get();
    pushHistory();
    set({
      strokes: [],
    });
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
        };
      }
      return state;
    });
  },

  setTool: (tool: MaskTool) => {
    set({ currentTool: tool });
  },

  setBrushSize: (size: number) => {
    set({ brushSize: size });
  },
}));
