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
import type { ComfyAppDefinition, ComfyWorkflowInspection } from "@/lib/comfy/types";

export type { ComfyAppDefinition, ComfyWorkflowInspection };

/**
 * All available node types in the workflow editor
 */
export type NodeType =
  | "imageInput"
  | "audioInput"
  | "videoInput"
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
  | "removeBackground"
  | "imageResize"
  | "gifEncoder"
  | "router"
  | "switch"
  | "conditionalSwitch"
  | "generate3d"
  | "glbViewer"
  | "comfyApp";

/**
 * Node execution status
 */
export type NodeStatus = "idle" | "loading" | "complete" | "error" | "skipped";

/**
 * Image input node - loads/uploads images into the workflow
 */
export interface ImageInputNodeData extends BaseNodeData {
  image: string | null;
  imageRef?: string; // External image reference for storage optimization
  filename: string | null;
  dimensions: { width: number; height: number } | null;
  isOptional?: boolean;
}

/**
 * Audio input node - loads/uploads audio files into the workflow
 */
export interface AudioInputNodeData extends BaseNodeData {
  audioFile: string | null;      // Base64 data URL of the audio file
  audioFileRef?: string;         // External audio reference for storage optimization
  filename: string | null;       // Original filename for display
  duration: number | null;       // Duration in seconds
  format: string | null;         // MIME type (audio/mp3, audio/wav, etc.)
  isOptional?: boolean;
}

/**
 * Video input node - loads/uploads video files into the workflow
 */
export interface VideoInputNodeData extends BaseNodeData {
  video: string | null;          // Base64 data URL or blob URL
  videoRef?: string;             // External video reference for storage optimization
  filename: string | null;
  duration: number | null;       // Duration in seconds
  dimensions: { width: number; height: number } | null;
  format: string | null;         // MIME type (video/mp4, video/webm, etc.)
  isOptional?: boolean;
}

/**
 * Prompt node - text input for AI generation
 */
export interface PromptNodeData extends BaseNodeData {
  prompt: string;
  variableName?: string; // Optional variable name for use in PromptConstructor templates
  isOptional?: boolean;
  mediaHeight?: number; // Height of the text surface, set by dragging its grip
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
  batchMode: boolean; // When true, all items are sent as a batch to downstream generate nodes
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
  unresolvedVars: string[];
  mediaHeight?: number; // Height of the text surface, set by dragging its grip
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
  /** A Gemini model, or a free-form producer name (e.g. a ComfyUI app). */
  model: ModelType | string;
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
  type: "image" | "text" | "audio" | "video";
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
  fallbackParameters?: Record<string, unknown>; // Parameters for fallback model
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  imageHistory: CarouselImageItem[]; // Carousel history (IDs only)
  selectedHistoryIndex: number; // Currently selected image in carousel
  fallbackModel?: SelectedModel; // JSON-compatible with Node Banana Pro
  __usedFallback?: boolean; // Set by runWithFallback on successful fallback
  __fallbackModelUsed?: string; // Display name of fallback model that succeeded
  __primaryError?: string; // Error message from the primary attempt
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
  fallbackParameters?: Record<string, unknown>; // Parameters for fallback model
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  videoHistory: CarouselVideoItem[]; // Carousel history (IDs only)
  selectedVideoHistoryIndex: number; // Currently selected video in carousel
  fallbackModel?: SelectedModel; // JSON-compatible with Node Banana Pro
  __usedFallback?: boolean; // Set by runWithFallback on successful fallback
  __fallbackModelUsed?: string; // Display name of fallback model that succeeded
  __primaryError?: string; // Error message from the primary attempt
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
  fallbackParameters?: Record<string, unknown>; // Parameters for fallback model
  inputSchema?: ModelInputDef[];
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  fallbackModel?: SelectedModel; // JSON-compatible with Node Banana Pro
  __usedFallback?: boolean; // Set by runWithFallback on successful fallback
  __fallbackModelUsed?: string; // Display name of fallback model that succeeded
  __primaryError?: string; // Error message from the primary attempt
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
  fallbackParameters?: Record<string, unknown>; // Parameters for fallback model
  inputSchema?: ModelInputDef[]; // Model's input schema for dynamic handles
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  status: NodeStatus;
  error: string | null;
  audioHistory: CarouselAudioItem[]; // Carousel history (IDs only)
  selectedAudioHistoryIndex: number; // Currently selected audio in carousel
  duration: number | null; // Duration in seconds
  format: string | null; // MIME type (audio/mp3, audio/wav, etc.)
  fallbackModel?: SelectedModel; // JSON-compatible with Node Banana Pro
  __usedFallback?: boolean; // Set by runWithFallback on successful fallback
  __fallbackModelUsed?: string; // Display name of fallback model that succeeded
  __primaryError?: string; // Error message from the primary attempt
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
  fallbackParameters?: Record<string, unknown>; // Parameters for fallback model (temperature, maxTokens)
  parametersExpanded?: boolean; // Collapse state for inline parameter display
  mediaHeight?: number; // Height of the text surface, set by dragging its grip
  status: NodeStatus;
  error: string | null;
  fallbackModel?: SelectedModel; // JSON-compatible with Node Banana Pro
  __usedFallback?: boolean; // Set by runWithFallback on successful fallback
  __fallbackModelUsed?: string; // Display name of fallback model that succeeded
  __primaryError?: string; // Error message from the primary attempt
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
  imageRefs?: string[]; // External storage refs for images
  videos?: string[]; // Array of video URLs from connected nodes
  videoRefs?: string[]; // External storage refs for videos
}

/**
 * Image Compare node - side-by-side image comparison with draggable slider
 */
export interface ImageCompareNodeData extends BaseNodeData {
  imageA: string | null;
  imageARef?: string;            // External image reference for storage optimization
  imageB: string | null;
  imageBRef?: string;            // External image reference for storage optimization
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
 * Background removal model quality preset (IMG.LY v1.7+)
 */
export type BackgroundRemovalModel = "isnet_quint8" | "isnet_fp16" | "isnet";

/**
 * Remove Background node - removes image backgrounds client-side
 */
export interface RemoveBackgroundNodeData extends BaseNodeData {
  model: BackgroundRemovalModel;
  outputImage: string | null;
  outputImageRef?: string;
  status: NodeStatus;
  error: string | null;
  progress: number;
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
 * A node within a split-grid cell template. Positions are in main-canvas
 * coordinate space, relative to the template's bounding box.
 */
export interface SplitGridTemplateNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  /** Node dimensions; falls back to defaultNodeDimensions when absent */
  size?: { width: number; height: number };
  /** Partial node data overrides applied on top of createDefaultNodeData(type) */
  data?: Record<string, unknown>;
}

export interface SplitGridTemplateEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/**
 * One terminal wired into the template's fixed downstream-router port. Each
 * connection designates a template node whose output feeds the single shared
 * Router materialized to the right of the whole cell grid.
 */
export interface SplitGridTemplateRouterConnection {
  /** Template node id whose output feeds the router */
  source: string;
  /** That node's output handle id ("image" | "text" | …) */
  sourceHandle: string;
  /** Resolved Router input type id (equals the source handle's type) */
  targetHandle: string;
}

/**
 * Per-cell node template for a split-grid node. Always contains a base
 * image node (`baseNodeId`) that receives the split cell image.
 */
export interface SplitGridTemplate {
  baseNodeId: string;
  nodes: SplitGridTemplateNode[];
  edges: SplitGridTemplateEdge[];
  /**
   * Optional shared downstream router: terminal outputs wired into the fixed
   * router port. Absent/empty ⇒ no router is materialized. The router is
   * created once (not per cell) to the right of the whole grid; every cell's
   * copy of each listed terminal connects into it.
   */
  router?: SplitGridTemplateRouterConnection[];
}

/**
 * One materialized cell: the real canvas nodes instantiated from the template.
 */
export interface SplitGridCell {
  /** Real node id of the imageInput that receives this cell's split image */
  baseImageNodeId: string;
  /** All real node ids instantiated for this cell (includes the base) */
  nodeIds: string[];
  /** Group created around this cell's nodes */
  groupId?: string;
}

/**
 * Split Grid node - splits image into grid cells for parallel processing
 */
export interface SplitGridNodeData extends BaseNodeData {
  sourceImage: string | null;
  sourceImageRef?: string; // External image reference for storage optimization
  gridRows: number;
  gridCols: number;
  /**
   * Interior column boundary positions, normalized to (0,1), strictly
   * ascending, length gridCols-1. Absent/invalid → uniform slicing. Set by
   * dragging the preview's vertical grid lines.
   */
  colOffsets?: number[];
  /** Interior row boundary positions; see colOffsets. Length gridRows-1. */
  rowOffsets?: number[];
  /** Per-cell node template; undefined on legacy saves (treated as image-only default) */
  template?: SplitGridTemplate;
  /** Materialized cells; undefined on legacy saves (falls back to childNodeIds) */
  cells?: SplitGridCell[];
  /** Snapshot key of rows/cols/template at last materialization, for staleness detection */
  materializedKey?: string | null;
  /**
   * Real node id of the shared downstream Router materialized from the
   * template's router port; null/undefined when no terminal is wired to the
   * port. Persisted so grid-resize rematerializations reuse (reposition +
   * re-wire) the same Router node, preserving the user's onward wiring.
   */
  routerNodeId?: string | null;
  /** @deprecated Legacy pre-template field, kept for backward compatibility */
  targetCount: number;
  /** @deprecated Legacy pre-template field, kept for backward compatibility */
  defaultPrompt: string;
  /** @deprecated Legacy pre-template field, kept for backward compatibility */
  generateSettings: {
    aspectRatio: AspectRatio;
    resolution: Resolution;
    model: ModelType;
    useGoogleSearch: boolean;
    useImageSearch: boolean;
  };
  /** @deprecated Legacy pre-template cell tracking; new workflows use `cells` */
  childNodeIds: Array<{
    imageInput: string;
    prompt: string;
    nanoBanana: string;
  }>;
  /** @deprecated Legacy configuration gate; template-based nodes are always usable */
  isConfigured: boolean;
  status: NodeStatus;
  error: string | null;
}

/**
 * Image Resize node - resize, refit, and re-encode a single image
 */
export type ImageResizeMode = "exact" | "maxEdge" | "scale";
export type ImageResizeFit = "contain" | "cover" | "stretch";
export type ImageResizeFormat = "keep" | "png" | "jpeg" | "webp";

export interface ImageResizeNodeData extends BaseNodeData {
  sourceImage: string | null;
  outputImage: string | null;
  mode: ImageResizeMode;
  width: number;          // used in exact mode
  height: number;         // used in exact mode
  maxEdge: number;        // used in maxEdge mode
  scalePct: number;       // used in scale mode (0-400)
  fit: ImageResizeFit;
  padColor: string;       // hex color for "contain" letterboxing
  format: ImageResizeFormat;
  quality: number;        // 0-1 for jpeg/webp
  outputDimensions: { width: number; height: number } | null;
  outputBytes: number | null;
  status: NodeStatus;
  error: string | null;
}

/**
 * Gif Encoder node - assembles N image frames into an animated GIF
 */
export interface GifEncoderNodeData extends BaseNodeData {
  clipOrder: string[];          // edge IDs in user-defined order
  outputGif: string | null;     // GIF data URL
  fps: number;                  // 1-30
  loopCount: number;            // 0 = infinite, otherwise N
  colorCount: number;           // 2-256
  dither: boolean;
  targetMaxBytes: number | null; // when set, auto-tune until under this size
  outputBytes: number | null;
  outputDimensions: { width: number; height: number } | null;
  status: NodeStatus;
  error: string | null;
  progress: number;             // 0-100
}

/**
 * GLB 3D Viewer node - loads and displays 3D models, captures viewport as image
 */
export interface GLBViewerNodeData extends BaseNodeData {
  glbUrl: string | null;       // Object URL for the loaded GLB file
  filename: string | null;     // Original filename for display
  capturedImage: string | null; // Base64 PNG snapshot of the 3D viewport
  capturedImageRef?: string;    // External image reference for storage optimization
}

/**
 * Comfy App node — a ComfyUI workflow bound as a node.
 *
 * The workflow's App Mode configuration (or, failing that, its detected
 * loaders and sinks) defines the node's handles: `app.inputs` become typed
 * target handles, `app.params` become inline settings, and `app.outputs`
 * become typed source handles.
 *
 * The whole `app` is embedded rather than referenced, so a saved Node Banana
 * workflow stays runnable without the original ComfyUI file — and so sharing a
 * workflow shares the pipeline with it.
 */
export interface ComfyAppNodeData extends BaseNodeData {
  app: ComfyAppDefinition | null;
  /**
   * The full candidate list the import produced, kept so the choice of inputs,
   * settings and outputs can be revisited later.
   *
   * `app` only records what was *picked*; everything the user declined is here.
   * Re-deriving it from `app.graph` would work but would lose the author's App
   * Mode curation — which widgets they meant to expose, and what they called
   * them — because that lives in the uploaded file, not the runnable graph.
   */
  inspection?: ComfyWorkflowInspection;
  /**
   * The library entry this node was created from, when it came from a saved
   * node rather than an import.
   *
   * Saving is a snapshot, so this node and that entry drift apart the moment
   * either is changed. Knowing which entry it was lets the dialog offer to
   * update that one, instead of leaving "save again" as the only way back and
   * a pile of near-identical entries as the result.
   */
  savedNodeId?: string;
  /** Values for `app.params`, keyed by param id. */
  paramValues: Record<string, unknown>;
  /** Derived from `app.inputs` — drives dynamic handles and `dynamicInputs`. */
  inputSchema?: ModelInputDef[];
  /** Produced media, keyed by `ComfyAppOutput.id`. */
  outputs: Record<string, string>;
  /** External refs for produced media, for storage optimization. */
  outputRefs?: Record<string, string>;
  /** Convenience mirrors of the first output of each type, for downstream nodes. */
  outputImage: string | null;
  outputVideo: string | null;
  outputAudio: string | null;
  outputText: string | null;
  output3dUrl: string | null;
  /** Engine job id, kept so a run survives a page refresh mid-render. */
  jobId?: string | null;
  /** Engine-reported status while running (e.g. "queued", "in_progress"). */
  runStatus?: string | null;
  parametersExpanded?: boolean;
  mediaHeight?: number; // Height of the text preview, set by dragging its grip
  /** Set when the node is created from the connection menu, so it opens the
   *  import dialog immediately — it has no handles until a workflow is chosen. */
  _autoOpenImport?: boolean;
  /**
   * A workflow dropped onto the canvas, handed to the node that was created
   * for it. Consumed and cleared on mount — it is the upload, not part of the
   * node's state, and must never reach a saved file.
   */
  _pendingWorkflow?: { workflow: unknown; filename: string } | null;
  status: NodeStatus;
  error: string | null;
}

/**
 * Union of all node data types
 */
export type WorkflowNodeData =
  | ImageInputNodeData
  | AudioInputNodeData
  | VideoInputNodeData
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
  | RemoveBackgroundNodeData
  | ImageResizeNodeData
  | GifEncoderNodeData
  | RouterNodeData
  | SwitchNodeData
  | ConditionalSwitchNodeData
  | GLBViewerNodeData
  | ComfyAppNodeData;

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
