/**
 * Node Types
 *
 * Types for workflow nodes including all node data interfaces,
 * handle types, and workflow node definitions.
 */

import { Node } from "@xyflow/react";
import type {
  AnnotationNodeData,
  AnnotationShape,
  BaseNodeData,
} from "./annotation";

// Re-export types from annotation for convenience
export type { AnnotationNodeData, BaseNodeData };

// Import from domain files to avoid circular dependencies
import type { AspectRatio, Resolution, ModelType } from "./models";
import type { LLMProvider, LLMModelType, SelectedModel } from "./providers";

/**
 * All available node types in the workflow editor
 */
export type NodeType =
  | "imageInput"
  | "annotation"
  | "prompt"
  | "nanoBanana"
  | "generateVideo"
  | "llmGenerate"
  | "splitGrid"
  | "imageCompare"
  | "maskInpaint"
  | "imageFilter"
  | "colorPalette"
  | "loop"
  | "batchVariations"
  | "conditionalBranch"
  | "output";

/**
 * Node execution status
 */
export type NodeStatus = "idle" | "loading" | "complete" | "error";

/**
 * Image input node - loads/uploads images into the workflow
 */
export interface ImageInputNodeData extends BaseNodeData {
  image: string | null;
  imageRef?: string; // External image reference for storage optimization
  filename: string | null;
  dimensions: { width: number; height: number } | null;
}

/**
 * Prompt node - text input for AI generation
 */
export interface PromptNodeData extends BaseNodeData {
  prompt: string;
}

/**
 * Image history item for tracking generated images
 */
export interface ImageHistoryItem {
  id: string;
  image: string; // Base64 data URL
  timestamp: number; // For display & sorting
  prompt: string; // The prompt used
  aspectRatio: AspectRatio;
  model: ModelType;
}

/**
 * Carousel image item for per-node history (IDs only, images stored externally)
 */
export interface CarouselImageItem {
  id: string;
  timestamp: number;
  prompt: string;
  aspectRatio: AspectRatio;
  model: ModelType;
}

/**
 * Carousel video item for per-node video history
 */
export interface CarouselVideoItem {
  id: string;
  timestamp: number;
  prompt: string;
  model: string; // Model ID for video (not ModelType since external providers)
}

/**
 * Model input definition for dynamic handles
 */
export interface ModelInputDef {
  name: string;
  type: "image" | "text";
  required: boolean;
  label: string;
  description?: string;
}

/**
 * Nano Banana node - AI image generation
 */
export interface NanoBananaNodeData extends BaseNodeData {
  inputImages: string[]; // Now supports multiple images
  inputImageRefs?: string[]; // External image references for storage optimization
  inputPrompt: string | null;
  outputImage: string | null;
  outputImageRef?: string; // External image reference for storage optimization
  aspectRatio: AspectRatio;
  resolution: Resolution; // Only used by Nano Banana Pro
  model: ModelType;
  selectedModel?: SelectedModel; // Multi-provider model selection (optional for backward compat)
  useGoogleSearch: boolean; // Only available for Nano Banana Pro
  parameters?: Record<string, unknown>; // Model-specific parameters for external providers
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  status: NodeStatus;
  error: string | null;
  imageHistory: CarouselImageItem[]; // Carousel history (IDs only)
  selectedHistoryIndex: number; // Currently selected image in carousel
}

/**
 * Generate Video node - AI video generation
 */
export interface GenerateVideoNodeData extends BaseNodeData {
  inputImages: string[];
  inputImageRefs?: string[]; // External image references for storage optimization
  inputPrompt: string | null;
  outputVideo: string | null; // Video data URL or URL
  outputVideoRef?: string; // External video reference for storage optimization
  selectedModel?: SelectedModel; // Required for video generation (no legacy fallback)
  parameters?: Record<string, unknown>; // Model-specific parameters
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  status: NodeStatus;
  error: string | null;
  videoHistory: CarouselVideoItem[]; // Carousel history (IDs only)
  selectedVideoHistoryIndex: number; // Currently selected video in carousel
}

/**
 * LLM Generate node - AI text generation
 */
export interface LLMGenerateNodeData extends BaseNodeData {
  inputPrompt: string | null;
  inputImages: string[];
  inputImageRefs?: string[]; // External image references for storage optimization
  outputText: string | null;
  provider: LLMProvider;
  model: LLMModelType;
  temperature: number;
  maxTokens: number;
  status: NodeStatus;
  error: string | null;
}

/**
 * Output node - displays final workflow results
 */
export interface OutputNodeData extends BaseNodeData {
  image: string | null;
  imageRef?: string; // External image reference for storage optimization
  video?: string | null; // Video data URL or HTTP URL
  contentType?: "image" | "video"; // Explicit content type hint
}

/**
 * Image Compare node - side-by-side comparison of two images with slider overlay
 */
export interface ImageCompareNodeData extends BaseNodeData {
  imageA: string | null; // First image (left/before)
  imageARef?: string; // External image reference for storage optimization
  imageB: string | null; // Second image (right/after)
  imageBRef?: string; // External image reference for storage optimization
  sliderPosition: number; // 0-100 percentage position of the slider
  zoomLevel: number; // Current zoom level (1 = 100%)
  panPosition: { x: number; y: number }; // Pan offset for zoomed view
  syncZoom: boolean; // Whether to sync zoom between images (always true for this node)
}

/**
 * Mask stroke for inpainting - stores brush stroke path
 */
export interface MaskStroke {
  id: string;
  points: number[]; // Flattened [x1, y1, x2, y2, ...] for Konva Line
  brushSize: number;
  isEraser: boolean; // true = erase mask, false = add to mask
}

/**
 * Mask Inpaint node - selective image editing with brush masks
 * User paints areas to edit, connects prompt describing changes
 */
export interface MaskInpaintNodeData extends BaseNodeData {
  sourceImage: string | null; // Original image to edit
  sourceImageRef?: string; // External image reference for storage optimization
  maskStrokes: MaskStroke[]; // Brush strokes defining the mask
  maskImage: string | null; // Rendered mask as base64 (white = edit area, black = preserve)
  maskImageRef?: string; // External mask reference for storage optimization
  outputImage: string | null; // Result after inpainting
  outputImageRef?: string; // External image reference for storage optimization
  inputPrompt: string | null; // What to generate in masked area
  brushSize: number; // Current brush size (1-100)
  maskFeather: number; // Edge feathering amount (0-50 pixels)
  maskExpansion: number; // Expand mask by N pixels (-20 to 50)
  status: NodeStatus;
  error: string | null;
  imageHistory: CarouselImageItem[]; // History of generated results
  selectedHistoryIndex: number;
}

/**
 * Filter preset names for quick application of common filter combinations
 */
export type FilterPreset =
  | "none"
  | "vintage"
  | "noir"
  | "vivid"
  | "warm"
  | "cool"
  | "sepia"
  | "dramatic";

/**
 * Image filter settings with all adjustable parameters
 */
export interface ImageFilterSettings {
  brightness: number; // -100 to 100, default 0
  contrast: number; // -100 to 100, default 0
  saturation: number; // -100 to 100, default 0
  hueRotate: number; // 0 to 360 degrees, default 0
  blur: number; // 0 to 20 pixels, default 0
  sharpen: number; // 0 to 100, default 0 (simulated via contrast/unsharp mask)
  opacity: number; // 0 to 100, default 100
  invert: number; // 0 to 100 percentage, default 0
  grayscale: number; // 0 to 100 percentage, default 0
}

/**
 * Image Filter node - applies visual filters and adjustments to images
 * Includes sliders for brightness, contrast, saturation, hue rotation, blur, sharpen
 * Plus preset filters (vintage, noir, vivid) with real-time preview
 */
export interface ImageFilterNodeData extends BaseNodeData {
  sourceImage: string | null; // Input image to filter
  sourceImageRef?: string; // External image reference for storage optimization
  outputImage: string | null; // Filtered result
  outputImageRef?: string; // External image reference for storage optimization
  filterSettings: ImageFilterSettings; // Current filter values
  activePreset: FilterPreset; // Currently applied preset (or "none" for custom)
  status: NodeStatus;
  error: string | null;
}

/**
 * Split Grid node - splits image into grid cells for parallel processing
 */
export interface SplitGridNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string; // External image reference for storage optimization
  targetCount: number; // 4, 6, 8, 9, or 10
  defaultPrompt: string;
  generateSettings: {
    aspectRatio: AspectRatio;
    resolution: Resolution;
    model: ModelType;
    useGoogleSearch: boolean;
  };
  childNodeIds: Array<{
    imageInput: string;
    prompt: string;
    nanoBanana: string;
  }>;
  gridRows: number;
  gridCols: number;
  isConfigured: boolean;
  status: NodeStatus;
  error: string | null;
}

/**
 * Condition operator for comparisons
 */
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "greater_or_equal"
  | "less_or_equal"
  | "contains"
  | "not_contains";

/**
 * Property types that can be analyzed from an image
 */
export type ImagePropertyType =
  | "width"
  | "height"
  | "aspect_ratio"
  | "brightness"
  | "dominant_color"
  | "is_grayscale"
  | "has_transparency";

/**
 * Single condition for image analysis
 */
export interface BranchCondition {
  id: string;
  property: ImagePropertyType;
  operator: ConditionOperator;
  value: string | number | boolean;
}

/**
 * Condition group with AND/OR logic
 */
export interface ConditionGroup {
  id: string;
  logic: "AND" | "OR";
  conditions: BranchCondition[];
}

/**
 * Conditional Branch node - routes workflow based on image analysis
 */
export interface ConditionalBranchNodeData extends BaseNodeData {
  inputImage: string | null;
  inputImageRef?: string; // External image reference for storage optimization
  conditionGroups: ConditionGroup[];
  groupLogic: "AND" | "OR"; // Logic between condition groups
  lastEvaluationResult: boolean | null; // Result of last evaluation
  analysisResults: Record<ImagePropertyType, string | number | boolean> | null; // Cached analysis
  status: NodeStatus;
  error: string | null;
}

/**
 * A single color in the palette with its extracted properties
 */
export interface PaletteColor {
  hex: string; // Hex color code (e.g., "#FF5733")
  rgb: { r: number; g: number; b: number }; // RGB values
  percentage: number; // Percentage of image this color represents (0-100)
  name?: string; // Optional color name (e.g., "Coral Red")
}

/**
 * Color Palette node - extracts dominant colors from an image
 * Outputs a palette that can be applied to other images via color mapping
 */
export interface ColorPaletteNodeData extends BaseNodeData {
  sourceImage: string | null; // Input image to extract colors from
  sourceImageRef?: string; // External image reference for storage optimization
  targetImage: string | null; // Optional image to apply palette to
  targetImageRef?: string; // External image reference for storage optimization
  outputImage: string | null; // Result after applying palette to target
  outputImageRef?: string; // External image reference for storage optimization
  extractedPalette: PaletteColor[]; // Extracted dominant colors (5-10)
  colorCount: number; // Number of colors to extract (5-10)
  mode: "extract" | "apply"; // Current mode: extract colors or apply to target
  mappingMethod: "closest" | "histogram" | "luminance"; // How to map colors when applying
  status: NodeStatus;
  error: string | null;
}

/**
 * Loop node - iterates through a set of operations multiple times
 */
export interface LoopNodeData extends BaseNodeData {
  iterationCount: number; // Number of iterations to perform
  loopMode: "count" | "until"; // Loop by count or until condition
  inputImages: string[]; // Input images from connected nodes
  inputText: string | null; // Input text from connected nodes
  currentIteration: number; // Current iteration index (0-based)
  isLooping: boolean; // Whether currently executing loop
  iterationResults: Array<{ image?: string; text?: string }>; // Results from each iteration
  currentImage: string | null; // Current iteration's output image
  currentText: string | null; // Current iteration's output text
  galleryImages: string[]; // All generated images for gallery view
  selectedGalleryIndex: number; // Currently selected gallery image
  status: NodeStatus;
  error: string | null;
}

/**
 * A single variation in the batch
 */
export interface BatchVariationItem {
  id: string;
  image: string; // Base64 image data
  isFavorite: boolean;
}

/**
 * Batch Variations node - generates multiple image variations at once
 */
export interface BatchVariationsNodeData extends BaseNodeData {
  inputImage: string | null;
  inputImageRef?: string; // External image reference for storage optimization
  inputPrompt: string | null;
  variationCount: number; // Number of variations to generate (2-8)
  variations: BatchVariationItem[]; // Generated variations
  selectedVariationIndex: number; // Currently selected variation
  outputImage: string | null; // Selected variation as output
  outputImageRef?: string; // External image reference for storage optimization
  aspectRatio: AspectRatio;
  resolution: Resolution;
  model: ModelType;
  useGoogleSearch: boolean;
  generationProgress: number; // 0-100 progress percentage
  status: NodeStatus;
  error: string | null;
}

/**
 * Union of all node data types
 */
export type WorkflowNodeData =
  | ImageInputNodeData
  | AnnotationNodeData
  | PromptNodeData
  | NanoBananaNodeData
  | GenerateVideoNodeData
  | LLMGenerateNodeData
  | SplitGridNodeData
  | ImageCompareNodeData
  | MaskInpaintNodeData
  | ImageFilterNodeData
  | ColorPaletteNodeData
  | LoopNodeData
  | BatchVariationsNodeData
  | ConditionalBranchNodeData
  | OutputNodeData;

/**
 * Workflow node with typed data (extended with optional groupId)
 */
export type WorkflowNode = Node<WorkflowNodeData, NodeType> & {
  groupId?: string;
};

/**
 * Handle types for node connections
 */
export type HandleType = "image" | "text";
