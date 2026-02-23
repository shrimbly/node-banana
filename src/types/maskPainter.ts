/**
 * Mask Painter Types
 *
 * Types for the mask painting system used in inpainting workflows.
 * The mask painter allows drawing black brush strokes on a source image,
 * outputting a white-on-black mask (white = area to inpaint).
 */

import type { BaseNodeData } from "./annotation";

/**
 * A single mask brush stroke
 */
export interface MaskStroke {
  id: string;
  type: "stroke";
  points: number[];      // [x0, y0, x1, y1, ...]
  strokeWidth: number;
  tool: "brush" | "eraser";
}

/**
 * A mask rectangle shape (filled by default)
 */
export interface MaskRect {
  id: string;
  type: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
  tool: "brush" | "eraser";
}

/**
 * A mask circle/ellipse shape (filled by default)
 */
export interface MaskCircle {
  id: string;
  type: "circle";
  x: number;       // center x
  y: number;       // center y
  radiusX: number;
  radiusY: number;
  tool: "brush" | "eraser";
}

/**
 * Union of all mask drawing elements
 */
export type MaskElement = MaskStroke | MaskRect | MaskCircle;

/**
 * Mask Painter node data - stores source image with painted mask strokes and shapes
 */
export interface MaskPainterNodeData extends BaseNodeData {
  sourceImage: string | null;
  strokes: MaskElement[];
  outputMask: string | null;       // White-on-black mask data URL
  brushSize: number;               // Default 30
  blurRadius: number;              // Post-blur in pixels, default 0
  invertMask: boolean;             // Default false
}

/**
 * Tool type for mask painter
 */
export type MaskTool = "brush" | "eraser" | "rectangle" | "circle";
