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
import type { LLMProvider, LLMModelType, SelectedModel, ProviderType } from "./providers";

/**
 * All available node types in the workflow editor
 */
export type NodeType =
  | "imageInput"
  | "audioInput"
  | "annotation"
  | "prompt"
  | "promptConstructor"
  | "nanoBanana"
  | "generateVideo"
  | "llmGenerate"
  | "splitGrid"
  | "output"
  | "outputGallery"
  | "imageCompare"
  | "videoStitch"
  | "easeCurve";

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
 * Audio input node - loads/uploads audio files into the workflow
 */
export interface AudioInputNodeData extends BaseNodeData {
  audioFile: string | null;      // Base64 data URL of the audio file
  filename: string | null;       // Original filename for display
  duration: number | null;       // Duration in seconds
  format: string | null;         // MIME type (audio/mp3, audio/wav, etc.)
}

/**
 * Prompt node - text input for AI generation
 */
export interface PromptNodeData extends BaseNodeData {
  prompt: string;
  variableName?: string; // Optional variable name for use in PromptConstructor templates
}

/**
 * Prompt Constructor node - template-based prompt builder with @variable interpolation
 */
export interface PromptConstructorNodeData extends BaseNodeData {
  template: string;
  outputText: string | null;
  unresolvedVars: string[];
}

/**
 * Available variable from connected Prompt nodes (for PromptConstructor autocomplete)
 */
export interface AvailableVariable {
  name: string;
  value: string;
  nodeId: string;
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
  systemPrompt?: string;
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
  outputFilename?: string; // Custom filename for saved outputs (without extension)
}

/**
 * Output Gallery node - displays scrollable thumbnail grid of images with lightbox
 */
export interface OutputGalleryNodeData extends BaseNodeData {
  images: string[]; // Array of base64 data URLs from connected nodes
}

/**
 * Image Compare node - side-by-side image comparison with draggable slider
 */
export interface ImageCompareNodeData extends BaseNodeData {
  imageA: string | null;
  imageB: string | null;
}

/**
 * Video stitch clip - represents a single video clip in the filmstrip
 */
export interface VideoStitchClip {
  edgeId: string;                // Edge ID for disconnect capability
  sourceNodeId: string;          // Source node producing this video
  thumbnail: string | null;      // Base64 JPEG thumbnail
  duration: number | null;       // Clip duration in seconds
  handleId: string;              // Which input handle (video-0, video-1, etc.)
}

/**
 * Video Stitch node - concatenates multiple videos into a single output
 */
export interface VideoStitchNodeData extends BaseNodeData {
  clips: VideoStitchClip[];       // Ordered clip sequence for filmstrip
  clipOrder: string[];            // Edge IDs in user-defined order (drag reorder)
  outputVideo: string | null;     // Stitched video blob URL or data URL
  status: NodeStatus;
  error: string | null;
  progress: number;               // 0-100 processing progress
  encoderSupported: boolean | null; // null = not checked yet, true/false after check
}

/**
 * Ease Curve node - applies speed curve to video using easing functions
 */
export interface EaseCurveNodeData extends BaseNodeData {
  bezierHandles: [number, number, number, number];
  easingPreset: string | null;
  inheritedFrom: string | null;
  outputDuration: number;
  outputVideo: string | null;
  status: NodeStatus;
  error: string | null;
  progress: number;
  encoderSupported: boolean | null;
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
 * Union of all node data types
 */
export type WorkflowNodeData =
  | ImageInputNodeData
  | AudioInputNodeData
  | AnnotationNodeData
  | PromptNodeData
  | PromptConstructorNodeData
  | NanoBananaNodeData
  | GenerateVideoNodeData
  | LLMGenerateNodeData
  | SplitGridNodeData
  | OutputNodeData
  | OutputGalleryNodeData
  | ImageCompareNodeData
  | VideoStitchNodeData
  | EaseCurveNodeData;

/**
 * Workflow node with typed data (extended with optional groupId)
 */
export type WorkflowNode = Node<WorkflowNodeData, NodeType> & {
  groupId?: string;
};

/**
 * Handle types for node connections
 */
export type HandleType = "image" | "text" | "audio" | "video" | "easeCurve";

/**
 * Default settings for node types - stored in localStorage
 */
export interface GenerateImageNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
  aspectRatio?: string;
  resolution?: string;
  useGoogleSearch?: boolean;
}

export interface GenerateVideoNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
}

export interface LLMNodeDefaults {
  provider?: LLMProvider;
  model?: LLMModelType;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface NodeDefaultsConfig {
  generateImage?: GenerateImageNodeDefaults;
  generateVideo?: GenerateVideoNodeDefaults;
  llm?: LLMNodeDefaults;
}
