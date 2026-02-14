/**
 * API Types
 *
 * Request and response types for API routes including
 * image generation and LLM text generation.
 */

import type { AspectRatio, Resolution, ModelType } from "./models";
import type { LLMProvider, LLMModelType } from "./providers";

// API Request/Response types for Image Generation
export interface GenerateRequest {
  images: string[]; // Now supports multiple images
  prompt: string;
  aspectRatio?: AspectRatio;
  resolution?: Resolution; // Only for Nano Banana Pro
  model?: ModelType;
  useGoogleSearch?: boolean; // Only for Nano Banana Pro
  mediaType?: "image" | "video" | "3d"; // Indicates expected output type for provider routing
}

export interface GenerateResponse {
  success: boolean;
  image?: string;
  video?: string;
  videoUrl?: string; // For large videos, return URL directly
  model3dUrl?: string; // For 3D models, return GLB URL directly
  contentType?: "image" | "video" | "3d";
  error?: string;
}

// API Request/Response types for LLM Text Generation
export interface LLMGenerateRequest {
  prompt: string;
  images?: string[];
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
