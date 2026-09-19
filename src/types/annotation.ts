/**
 * Annotation Types
 *
 * Types for the annotation/drawing system including shapes, tools, and node data.
 * Used by the annotation node and Konva-based canvas drawing.
 */

/**
 * Base node data - using Record to satisfy React Flow's type constraints.
 * Defined here to avoid circular dependencies (nodes.ts imports from annotation.ts).
 */
export interface BaseNodeData extends Record<string, unknown> {
  label?: string;
  customTitle?: string;
  comment?: string;
  /**
   * Where the bundled noodles on a handle split, in px from the handle, keyed
   * by "source:<handleId>" or "target:<handleId>". Set by dragging the clamp.
   */
  bundleClamps?: Record<string, number>;
}

// Shape type discriminator
export type ShapeType = "rectangle" | "circle" | "arrow" | "freehand" | "text";

/**
 * Base shape properties shared by all annotation shapes
 */
export interface BaseShape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/**
 * Rectangle shape for box annotations
 */
export interface RectangleShape extends BaseShape {
  type: "rectangle";
  width: number;
  height: number;
  fill: string | null;
}

/**
 * Circle/ellipse shape for circular annotations
 */
export interface CircleShape extends BaseShape {
  type: "circle";
  radiusX: number;
  radiusY: number;
  fill: string | null;
}

/**
 * Arrow shape for directional annotations
 */
export interface ArrowShape extends BaseShape {
  type: "arrow";
  points: number[];
}

/**
 * Freehand drawing shape
 */
export interface FreehandShape extends BaseShape {
  type: "freehand";
  points: number[];
}

/**
 * Text annotation shape
 */
export interface TextShape extends BaseShape {
  type: "text";
  text: string;
  fontSize: number;
  fill: string;
}

/**
 * Union of all annotation shape types
 */
export type AnnotationShape =
  | RectangleShape
  | CircleShape
  | ArrowShape
  | FreehandShape
  | TextShape;

/**
 * Annotation node data - stores image with drawn annotations
 */
export interface AnnotationNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string; // External image reference for storage optimization
  annotations: AnnotationShape[];
  outputImage: string | null;
  outputImageRef?: string; // External image reference for storage optimization
}

// Tool type for annotation editor
export type ToolType =
  | "select"
  | "rectangle"
  | "circle"
  | "arrow"
  | "freehand"
  | "text";

/**
 * Tool options for annotation drawing
 */
export interface ToolOptions {
  strokeColor: string;
  strokeWidth: number;
  fillColor: string | null;
  fontSize: number;
  opacity: number;
}
