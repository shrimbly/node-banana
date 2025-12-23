import { create } from "zustand";
import { GridDetectionResult, GridCell } from "@/utils/gridSplitter";

export type CropMode = "grid" | "freeform";

export interface CropRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropperStore {
  // Modal state
  isOpen: boolean;
  sourceImage: string | null;
  sourceNodeId: string | null;
  imageDimensions: { width: number; height: number } | null;

  // Grid mode state
  gridResult: GridDetectionResult | null;
  selectedCells: Set<number>; // indices of selected cells
  customRows: number;
  customCols: number;

  // Freeform mode state
  cropMode: CropMode;
  cropRegions: CropRegion[];
  currentRegion: CropRegion | null; // region being drawn
  selectedRegionId: string | null;

  // Extracted results
  extractedImages: string[];

  // Actions
  openModal: (sourceImage: string, sourceNodeId?: string) => void;
  closeModal: () => void;
  setImageDimensions: (dimensions: { width: number; height: number }) => void;

  // Grid actions
  setGridResult: (result: GridDetectionResult | null) => void;
  setCustomGrid: (rows: number, cols: number) => void;
  toggleCellSelection: (index: number) => void;
  selectAllCells: () => void;
  clearCellSelection: () => void;

  // Freeform actions
  setCropMode: (mode: CropMode) => void;
  startRegion: (x: number, y: number) => void;
  updateRegion: (x: number, y: number) => void;
  finishRegion: () => void;
  deleteRegion: (id: string) => void;
  selectRegion: (id: string | null) => void;
  clearRegions: () => void;

  // Results
  setExtractedImages: (images: string[]) => void;
  clearExtractedImages: () => void;
  reset: () => void;
}

const initialState = {
  isOpen: false,
  sourceImage: null,
  sourceNodeId: null,
  imageDimensions: null,
  gridResult: null,
  selectedCells: new Set<number>(),
  customRows: 2,
  customCols: 2,
  cropMode: "grid" as CropMode,
  cropRegions: [] as CropRegion[],
  currentRegion: null,
  selectedRegionId: null,
  extractedImages: [] as string[],
};

export const useCropperStore = create<CropperStore>((set, get) => ({
  ...initialState,

  openModal: (sourceImage: string, sourceNodeId?: string) => {
    set({
      isOpen: true,
      sourceImage,
      sourceNodeId: sourceNodeId || null,
      // Reset other state
      gridResult: null,
      selectedCells: new Set<number>(),
      cropRegions: [],
      currentRegion: null,
      selectedRegionId: null,
      extractedImages: [],
    });
  },

  closeModal: () => {
    set({ isOpen: false });
  },

  setImageDimensions: (dimensions) => {
    set({ imageDimensions: dimensions });
  },

  setGridResult: (result) => {
    set({ gridResult: result });
    // Auto-select all cells when grid is set
    if (result) {
      const allCells = new Set<number>();
      for (let i = 0; i < result.cells.length; i++) {
        allCells.add(i);
      }
      set({ selectedCells: allCells });
    }
  },

  setCustomGrid: (rows, cols) => {
    set({ customRows: rows, customCols: cols });
  },

  toggleCellSelection: (index) => {
    const { selectedCells } = get();
    const newSelection = new Set(selectedCells);
    if (newSelection.has(index)) {
      newSelection.delete(index);
    } else {
      newSelection.add(index);
    }
    set({ selectedCells: newSelection });
  },

  selectAllCells: () => {
    const { gridResult } = get();
    if (!gridResult) return;
    const allCells = new Set<number>();
    for (let i = 0; i < gridResult.cells.length; i++) {
      allCells.add(i);
    }
    set({ selectedCells: allCells });
  },

  clearCellSelection: () => {
    set({ selectedCells: new Set<number>() });
  },

  setCropMode: (mode) => {
    set({ cropMode: mode });
  },

  startRegion: (x, y) => {
    const id = `region-${Date.now()}`;
    set({
      currentRegion: { id, x, y, width: 0, height: 0 },
    });
  },

  updateRegion: (x, y) => {
    const { currentRegion } = get();
    if (!currentRegion) return;

    const width = x - currentRegion.x;
    const height = y - currentRegion.y;

    set({
      currentRegion: {
        ...currentRegion,
        width,
        height,
      },
    });
  },

  finishRegion: () => {
    const { currentRegion, cropRegions } = get();
    if (!currentRegion) return;

    // Normalize negative width/height
    let { x, y, width, height } = currentRegion;
    if (width < 0) {
      x += width;
      width = Math.abs(width);
    }
    if (height < 0) {
      y += height;
      height = Math.abs(height);
    }

    // Only add if region is meaningful (at least 10x10 pixels)
    if (width >= 10 && height >= 10) {
      const normalizedRegion: CropRegion = {
        ...currentRegion,
        x,
        y,
        width,
        height,
      };
      set({
        cropRegions: [...cropRegions, normalizedRegion],
        currentRegion: null,
      });
    } else {
      set({ currentRegion: null });
    }
  },

  deleteRegion: (id) => {
    set((state) => ({
      cropRegions: state.cropRegions.filter((r) => r.id !== id),
      selectedRegionId: state.selectedRegionId === id ? null : state.selectedRegionId,
    }));
  },

  selectRegion: (id) => {
    set({ selectedRegionId: id });
  },

  clearRegions: () => {
    set({ cropRegions: [], currentRegion: null, selectedRegionId: null });
  },

  setExtractedImages: (images) => {
    set({ extractedImages: images });
  },

  clearExtractedImages: () => {
    set({ extractedImages: [] });
  },

  reset: () => {
    set(initialState);
  },
}));

/**
 * Helper function to extract a crop region from an image
 */
export async function extractRegion(
  imageDataUrl: string,
  region: CropRegion | GridCell
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        if (!ctx) {
          reject(new Error("Could not get canvas context"));
          return;
        }

        canvas.width = region.width;
        canvas.height = region.height;

        ctx.drawImage(
          img,
          region.x,
          region.y,
          region.width,
          region.height,
          0,
          0,
          region.width,
          region.height
        );

        resolve(canvas.toDataURL("image/png"));
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      reject(new Error("Failed to load image"));
    };

    img.src = imageDataUrl;
  });
}

/**
 * Helper function to extract multiple regions from an image
 */
export async function extractRegions(
  imageDataUrl: string,
  regions: (CropRegion | GridCell)[]
): Promise<string[]> {
  const results: string[] = [];
  for (const region of regions) {
    const extracted = await extractRegion(imageDataUrl, region);
    results.push(extracted);
  }
  return results;
}
