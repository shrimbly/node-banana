import { Node, Edge } from "@xyflow/react";

// Node Types
export type NodeType =
  | "imageInput"
  | "annotation"
  | "prompt"
  | "nanoBanana"
  | "llmGenerate"
  | "output";

// Aspect Ratios (supported by both Nano Banana and Nano Banana Pro)
export type AspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

// Resolution Options (only supported by Nano Banana Pro)
export type Resolution = "1K" | "2K" | "4K";

// Image Generation Model Options
export type ModelType = "nano-banana" | "nano-banana-pro" | "azure-flux-pro" | "azure-gpt-image";

// Size options for Azure FLUX model
export type AzureFluxSize = "1024x1024" | "1024x768" | "768x1024" | "1536x1024" | "1024x1536";

// Size options for Azure GPT Image model
export type AzureGptImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";

// Quality options for Azure GPT Image model
export type AzureGptImageQuality = "low" | "medium" | "high";

// LLM Provider Options
export type LLMProvider = "google" | "openai";

// LLM Model Options
export type LLMModelType =
  | "gemini-2.5-flash"
  | "gemini-3-pro-preview"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano";

// Node Status
export type NodeStatus = "idle" | "loading" | "complete" | "error";

// Base node data - using Record to satisfy React Flow's type constraints
export interface BaseNodeData extends Record<string, unknown> {
  label?: string;
}

// Image Input Node Data
export interface ImageInputNodeData extends BaseNodeData {
  image: string | null;
  filename: string | null;
  dimensions: { width: number; height: number } | null;
}

// Annotation Shape Types
export type ShapeType = "rectangle" | "circle" | "arrow" | "freehand" | "text";

export interface BaseShape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export interface RectangleShape extends BaseShape {
  type: "rectangle";
  width: number;
  height: number;
  fill: string | null;
}

export interface CircleShape extends BaseShape {
  type: "circle";
  radiusX: number;
  radiusY: number;
  fill: string | null;
}

export interface ArrowShape extends BaseShape {
  type: "arrow";
  points: number[];
}

export interface FreehandShape extends BaseShape {
  type: "freehand";
  points: number[];
}

export interface TextShape extends BaseShape {
  type: "text";
  text: string;
  fontSize: number;
  fill: string;
}

export type AnnotationShape =
  | RectangleShape
  | CircleShape
  | ArrowShape
  | FreehandShape
  | TextShape;

// Annotation Node Data
export interface AnnotationNodeData extends BaseNodeData {
  sourceImage: string | null;
  annotations: AnnotationShape[];
  outputImage: string | null;
}

// Prompt Node Data
export interface PromptNodeData extends BaseNodeData {
  prompt: string;
}

// Image History Item (for tracking generated images)
export interface ImageHistoryItem {
  id: string;
  image: string;          // Base64 data URL
  timestamp: number;      // For display & sorting
  prompt: string;         // The prompt used
  aspectRatio: AspectRatio;
  model: ModelType;
}

// Nano Banana Node Data (Image Generation)
export interface NanoBananaNodeData extends BaseNodeData {
  inputImages: string[]; // Now supports multiple images
  inputPrompt: string | null;
  outputImage: string | null;
  aspectRatio: AspectRatio;
  resolution: Resolution; // Only used by Nano Banana Pro
  model: ModelType;
  useGoogleSearch: boolean; // Only available for Nano Banana Pro
  size: AzureFluxSize; // Only used by Azure FLUX
  gptImageSize: AzureGptImageSize; // Only used by Azure GPT Image
  gptImageQuality: AzureGptImageQuality; // Only used by Azure GPT Image
  status: NodeStatus;
  error: string | null;
}

// LLM Generate Node Data (Text Generation)
export interface LLMGenerateNodeData extends BaseNodeData {
  inputPrompt: string | null;
  outputText: string | null;
  provider: LLMProvider;
  model: LLMModelType;
  temperature: number;
  maxTokens: number;
  status: NodeStatus;
  error: string | null;
}

// Output Node Data
export interface OutputNodeData extends BaseNodeData {
  image: string | null;
}

// Union of all node data types
export type WorkflowNodeData =
  | ImageInputNodeData
  | AnnotationNodeData
  | PromptNodeData
  | NanoBananaNodeData
  | LLMGenerateNodeData
  | OutputNodeData;

// Workflow Node with typed data (extended with optional groupId)
export type WorkflowNode = Node<WorkflowNodeData, NodeType> & {
  groupId?: string;
};

// Workflow Edge Data
export interface WorkflowEdgeData extends Record<string, unknown> {
  hasPause?: boolean;
}

// Workflow Edge
export type WorkflowEdge = Edge<WorkflowEdgeData>;

// Handle Types for connections
export type HandleType = "image" | "text";

// API Request/Response types for Image Generation
export interface GenerateRequest {
  images: string[]; // Now supports multiple images
  prompt: string;
  aspectRatio?: AspectRatio;
  resolution?: Resolution; // Only for Nano Banana Pro
  model?: ModelType;
  useGoogleSearch?: boolean; // Only for Nano Banana Pro
  size?: AzureFluxSize; // Only for Azure FLUX model
  gptImageSize?: AzureGptImageSize; // Only for Azure GPT Image model
  gptImageQuality?: AzureGptImageQuality; // Only for Azure GPT Image model
}

export interface GenerateResponse {
  success: boolean;
  image?: string;
  error?: string;
}

// API Request/Response types for LLM Text Generation
export interface LLMGenerateRequest {
  prompt: string;
  provider: LLMProvider;
  model: LLMModelType;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMGenerateResponse {
  success: boolean;
  text?: string;
  error?: string;
}

// Tool Types for annotation
export type ToolType = "select" | "rectangle" | "circle" | "arrow" | "freehand" | "text";

// Tool Options
export interface ToolOptions {
  strokeColor: string;
  strokeWidth: number;
  fillColor: string | null;
  fontSize: number;
  opacity: number;
}

// Auto-save configuration stored in localStorage
export interface WorkflowSaveConfig {
  workflowId: string;
  name: string;
  directoryPath: string;
  generationsPath: string | null;
  lastSavedAt: number | null;
}

// Group background color options (dark mode tints)
export type GroupColor =
  | "neutral"
  | "blue"
  | "green"
  | "purple"
  | "orange"
  | "red";

// Group definition stored in workflow
export interface NodeGroup {
  id: string;
  name: string;
  color: GroupColor;
  position: { x: number; y: number };
  size: { width: number; height: number };
}
