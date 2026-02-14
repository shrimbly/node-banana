/**
 * Provider Abstraction Types
 *
 * Defines the interface contract for all AI providers (Gemini, Replicate, fal.ai).
 * Each provider implements ProviderInterface to enable uniform access to different
 * AI services for model discovery and generation.
 */

import { ProviderType } from "@/types";

/**
 * Model capabilities - what operations a model can perform
 */
export type ModelCapability =
  | "text-to-image"
  | "image-to-image"
  | "text-to-video"
  | "image-to-video"
  | "text-to-3d"
  | "image-to-3d";

/**
 * Model parameter schema for dynamic UI generation
 */
export interface ModelParameter {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  required?: boolean;
}

/**
 * Connectable model input - for dynamic handle generation
 * These are inputs that can receive connections from other nodes
 */
export interface ModelInput {
  /** Property name from schema (e.g., "image_url", "tail_image_url", "prompt") */
  name: string;
  /** Handle type for connections */
  type: "image" | "text";
  /** Whether this input is required */
  required: boolean;
  /** Human-readable label for the handle */
  label: string;
  /** Optional description from schema */
  description?: string;
  /** Whether schema expects array format (e.g., image_urls: string[] vs image_url: string) */
  isArray?: boolean;
}

/**
 * Represents a model from any provider with normalized metadata
 */
export interface ProviderModel {
  /** Provider-specific model ID (e.g., "stability-ai/sdxl" for Replicate) */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Model description, may be null */
  description: string | null;
  /** Which provider this model belongs to */
  provider: ProviderType;
  /** What capabilities this model supports */
  capabilities: ModelCapability[];
  /** Thumbnail/cover image URL for UI display */
  coverImage?: string;
  /** Optional pricing information */
  pricing?: {
    type: "per-run" | "per-second";
    amount: number;
    currency: string;
  };
  /** Optional URL to the model's page on the provider's website */
  pageUrl?: string;
}

/**
 * Unified input format for generation across all providers
 */
export interface GenerationInput {
  /** The model to use for generation */
  model: ProviderModel;
  /** Text prompt for the generation */
  prompt: string;
  /** Input images as base64 data URLs or HTTP URLs */
  images?: string[];
  /** Model-specific parameters (varies by provider/model) */
  parameters?: Record<string, unknown>;
  /** Dynamic inputs mapped from schema (e.g., { "image_url": "data:...", "tail_image_url": "data:..." }) */
  dynamicInputs?: Record<string, string | string[]>;
}

/**
 * Unified output format for generation results
 */
export interface GenerationOutput {
  /** Whether the generation succeeded */
  success: boolean;
  /** Generated outputs (images or videos) */
  outputs?: Array<{
    /** Type of output */
    type: "image" | "video" | "3d";
    /** Base64 data URL of the output (empty string for 3D/large video URL-only responses) */
    data: string;
    /** Original URL if applicable (e.g., from provider CDN) */
    url?: string;
  }>;
  /** Error message if success is false */
  error?: string;
}

/**
 * Contract that all provider implementations must fulfill.
 * Enables uniform access to model discovery and generation across
 * different AI service providers.
 */
export interface ProviderInterface {
  /** Provider identifier matching ProviderType */
  id: ProviderType;
  /** Human-readable provider name */
  name: string;

  // --- Model Discovery ---

  /**
   * List all available models from this provider
   */
  listModels(): Promise<ProviderModel[]>;

  /**
   * Get a specific model by ID
   * @param modelId - The provider-specific model ID
   * @returns The model or null if not found
   */
  getModel(modelId: string): Promise<ProviderModel | null>;

  /**
   * Search for models matching a query
   * @param query - Search query string
   * @returns Matching models
   */
  searchModels(query: string): Promise<ProviderModel[]>;

  // --- Generation ---

  /**
   * Generate content using the specified model
   * @param input - Generation input with model, prompt, and optional images/parameters
   * @returns Generation result with outputs or error
   */
  generate(input: GenerationInput): Promise<GenerationOutput>;

  // --- Utilities ---

  /**
   * Check if this provider is configured with a valid API key
   */
  isConfigured(): boolean;

  /**
   * Get the API key for this provider (null if not configured)
   */
  getApiKey(): string | null;
}
