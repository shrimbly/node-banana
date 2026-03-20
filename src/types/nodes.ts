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
  | "array"
  | "promptConstructor"
  | "nanoBanana"
  | "generateVideo"
  | "generateAudio"
  | "llmGenerate"
  | "splitGrid"
  | "output"
  | "outputGallery"
  | "imageCompare"
  | "videoStitch"
  | "easeCurve"
  | "videoTrim"
  | "videoFrameGrab"
  | "router"
  | "switch"
  | "conditionalSwitch"
  | "generate3d"
  | "glbViewer"
  | "inpaint";

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
  variableName?: string; // Optional variable name for use in PromptConstructor templates (image variable)
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

export type ArraySplitMode = "delimiter" | "newline" | "regex";

/**
 * Array node - converts one text input into ordered text items.
 */
export interface ArrayNodeData extends BaseNodeData {
  inputText: string | null;
  splitMode: ArraySplitMode;
  delimiter: string;
  regexPattern: string;
  trimItems: boolean;
  removeEmpty: boolean;
  selectedOutputIndex: number | null;
  outputItems: string[];
  outputText: string | null; // JSON array string for the primary text output
  error: string | null;
}

/**
 * Prompt Constructor node - template-based prompt builder with @variable interpolation
 */
export interface PromptConstructorNodeData extends BaseNodeData {
  template: string;
  outputText: string | null;
  outputParts: PromptPart[] | null; // Multimodal parts with interleaved text and image references
  unresolvedVars: string[];
}

/**
 * Available variable from connected Prompt nodes (for PromptConstructor autocomplete)
 */
export interface AvailableVariable {
  name: string;
  value: string;
  nodeId: string;
  variableType: "text" | "image"; // Whether this variable holds text or image data
}

/**
 * A single part of a multimodal prompt (text or image reference)
 */
export type PromptPart =
  | { type: "text"; value: string }
  | { type: "image"; name: string; value: string }; // value is base64 data URL

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
  useGoogleSearch: boolean; // Only available for Nano Banana Pro and Nano Banana 2
  useImageSearch: boolean; // Only available for Nano Banana 2
  parameters?: Record<string, unknown>; // Model-specific parameters for external providers
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
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
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  videoHistory: CarouselVideoItem[]; // Carousel history (IDs only)
  selectedVideoHistoryIndex: number; // Currently selected video in carousel
}

/**
 * Generate 3D node - AI 3D model generation
 */
export interface Generate3DNodeData extends BaseNodeData {
  inputImages: string[];
  inputImageRefs?: string[];
  inputPrompt: string | null;
  output3dUrl: string | null;
  savedFilename: string | null;
  savedFilePath: string | null;
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  inputSchema?: ModelInputDef[];
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
}

/**
 * Carousel audio item for per-node audio history
 */
export interface CarouselAudioItem {
  id: string;
  timestamp: number;
  prompt: string;
  model: string; // Model ID for audio (not ModelType since external providers)
}

/**
 * Generate Audio node - AI audio/TTS generation
 */
export interface GenerateAudioNodeData extends BaseNodeData {
  inputPrompt: string | null;
  outputAudio: string | null; // Audio data URL
  outputAudioRef?: string; // External audio reference for storage optimization
  selectedModel?: SelectedModel; // Required for audio generation
  parameters?: Record<string, unknown>; // Model-specific parameters (voice, speed, etc.)
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  audioHistory: CarouselAudioItem[]; // Carousel history (IDs only)
  selectedAudioHistoryIndex: number; // Currently selected audio in carousel
  duration: number | null; // Duration in seconds
  format: string | null; // MIME type (audio/mp3, audio/wav, etc.)
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
  parametersExpanded?: boolean; // Collapse state for inline parameter display
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
  audio?: string | null; // Audio data URL or HTTP URL
  contentType?: "image" | "video" | "audio"; // Explicit content type hint
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
  loopCount: 1 | 2 | 3;          // How many times to repeat the clip sequence (1 = no loop)
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
 * Video Trim node - trims a video clip to a user-defined start/end time range
 */
export interface VideoTrimNodeData extends BaseNodeData {
  startTime: number;          // Trim start in seconds (default 0)
  endTime: number;            // Trim end in seconds (default 0 = full duration, set on video load)
  duration: number | null;    // Source video duration (populated when video loads metadata)
  outputVideo: string | null; // Trimmed video blob URL or data URL
  status: NodeStatus;
  error: string | null;
  progress: number;           // 0-100 processing progress
  encoderSupported: boolean | null;
}

/**
 * Video Frame Grab node - extracts the first or last frame from a video as a full-resolution PNG image
 */
export interface VideoFrameGrabNodeData extends BaseNodeData {
  framePosition: "first" | "last";   // Which frame to extract
  outputImage: string | null;        // Extracted frame as base64 PNG data URL
  status: NodeStatus;
  error: string | null;
}

/**
 * Router node - pure passthrough routing node with dynamic multi-type handles
 */
export interface RouterNodeData extends BaseNodeData {
  // No internal state - all routing is derived from edge connections
}

/**
 * Switch node - toggle-controlled routing with named outputs
 */
export interface SwitchNodeData extends BaseNodeData {
  inputType: HandleType | null;  // Derived from connected input edge, null when disconnected
  switches: Array<{
    id: string;        // Unique identifier for handle mapping
    name: string;      // User-editable label
    enabled: boolean;  // Toggle state
  }>;
}

/**
 * Match mode for conditional switch rules
 */
export type MatchMode = "exact" | "contains" | "starts-with" | "ends-with";

/**
 * Conditional switch rule for text-based routing
 */
export interface ConditionalSwitchRule {
  id: string;           // Unique handle ID, prefixed with "rule-" to avoid collision with reserved "default" keyword
  value: string;        // Comma-separated match values
  mode: MatchMode;      // Match strategy
  label: string;        // User-editable display name
  isMatched: boolean;   // Computed match state
}

/**
 * Conditional Switch node - text-based routing with multi-mode matching
 */
export interface ConditionalSwitchNodeData extends BaseNodeData {
  incomingText: string | null;  // Upstream text for evaluation and display
  rules: ConditionalSwitchRule[]; // User-defined rules
  evaluationPaused?: boolean;   // When true, skips rule evaluation and downstream dimming
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
    useImageSearch: boolean;
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
 * GLB 3D Viewer node - loads and displays 3D models, captures viewport as image
 */
export interface GLBViewerNodeData extends BaseNodeData {
  glbUrl: string | null;       // Object URL for the loaded GLB file
  filename: string | null;     // Original filename for display
  capturedImage: string | null; // Base64 PNG snapshot of the 3D viewport
}

/**
 * Inpaint node - masked image regeneration
 */
export type InpaintProvider = "gemini" | "wavespeed";

export interface InpaintNodeData extends BaseNodeData {
  inputImage: string | null;        // Source image (from connection or stored)
  inputImageRef?: string;
  maskImage: string | null;         // Black/white mask (white = area to regenerate)
  inputPrompt: string | null;       // What to generate in the masked area
  outputImage: string | null;       // Result image
  outputImageRef?: string;
  inpaintProvider: InpaintProvider;  // Which provider to use
  selectedModel?: SelectedModel;    // WaveSpeed model selection
  maskBrushSize: number;            // Last used brush size
  status: NodeStatus;
  error: string | null;
  imageHistory: CarouselImageItem[];
  selectedHistoryIndex: number;
}

/**
 * Union of all node data types
 */
export type WorkflowNodeData =
  | ImageInputNodeData
  | AudioInputNodeData
  | AnnotationNodeData
  | PromptNodeData
  | ArrayNodeData
  | PromptConstructorNodeData
  | NanoBananaNodeData
  | GenerateVideoNodeData
  | Generate3DNodeData
  | GenerateAudioNodeData
  | LLMGenerateNodeData
  | SplitGridNodeData
  | OutputNodeData
  | OutputGalleryNodeData
  | ImageCompareNodeData
  | VideoStitchNodeData
  | EaseCurveNodeData
  | VideoTrimNodeData
  | VideoFrameGrabNodeData
  | RouterNodeData
  | SwitchNodeData
  | ConditionalSwitchNodeData
  | GLBViewerNodeData
  | InpaintNodeData;

/**
 * Workflow node with typed data (extended with optional groupId)
 */
export type WorkflowNode = Node<WorkflowNodeData, NodeType> & {
  groupId?: string;
};

/**
 * Handle types for node connections
 */
export type HandleType = "image" | "text" | "audio" | "video" | "3d" | "easeCurve";

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
  useImageSearch?: boolean;
}

export interface GenerateVideoNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
}

export interface Generate3DNodeDefaults {
  selectedModel?: {
    provider: ProviderType;
    modelId: string;
    displayName: string;
  };
}

export interface GenerateAudioNodeDefaults {
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
}

export interface NodeDefaultsConfig {
  generateImage?: GenerateImageNodeDefaults;
  generateVideo?: GenerateVideoNodeDefaults;
  generate3d?: Generate3DNodeDefaults;
  generateAudio?: GenerateAudioNodeDefaults;
  llm?: LLMNodeDefaults;
}
