/**
 * fal.ai Provider Implementation
 *
 * Implements ProviderInterface for fal.ai's AI model marketplace.
 * Provides model discovery via fal.ai's REST API and self-registers
 * in the provider registry when imported.
 *
 * Usage:
 *   import "@/lib/providers/fal"; // Just importing registers the provider
 *
 *   // Or get it from registry:
 *   import { getProvider } from "@/lib/providers";
 *   const fal = getProvider("fal");
 *
 * Note: fal.ai works without an API key but with rate limits.
 * Providing a key enables higher rate limits.
 */

import {
  ProviderInterface,
  ProviderModel,
  ModelCapability,
  GenerationInput,
  GenerationOutput,
  registerProvider,
} from "@/lib/providers";

const FAL_API_BASE = "https://api.fal.ai/v1";
const PROVIDER_SETTINGS_KEY = "node-banana-provider-settings";

/**
 * Categories we care about for image/video generation
 */
const RELEVANT_CATEGORIES = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
];

/**
 * Response schema from fal.ai models endpoint
 */
interface FalModelsResponse {
  models: FalModel[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Model schema from fal.ai API
 */
interface FalModel {
  endpoint_id: string;
  metadata: {
    display_name: string;
    category: string;
    description: string;
    status: "active" | "deprecated";
    tags: string[];
    updated_at: string;
    is_favorited: boolean | null;
    thumbnail_url: string;
    model_url: string;
    date: string;
    highlighted: boolean;
    pinned: boolean;
    thumbnail_animated_url?: string;
    github_url?: string;
    license_type?: "commercial" | "research" | "private";
  };
  openapi?: Record<string, unknown>;
}

/**
 * Generation response from fal.ai
 * Different models may return different structures
 */
interface FalGenerationResponse {
  images?: Array<{ url: string; content_type?: string }>;
  image?: { url: string; content_type?: string };
  output?: string;
}

/**
 * Get API key from localStorage (client-side only)
 * Returns null when running on server or if not configured
 */
function getApiKeyFromStorage(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const settingsJson = localStorage.getItem(PROVIDER_SETTINGS_KEY);
    if (!settingsJson) return null;

    const settings = JSON.parse(settingsJson);
    return settings?.providers?.fal?.apiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Map fal.ai category to ModelCapability
 * Returns the capability if it's one we support, null otherwise
 */
function mapCategoryToCapability(category: string): ModelCapability | null {
  if (RELEVANT_CATEGORIES.includes(category)) {
    return category as ModelCapability;
  }
  return null;
}

/**
 * Check if a model has a relevant category
 */
function isRelevantModel(model: FalModel): boolean {
  return RELEVANT_CATEGORIES.includes(model.metadata.category);
}

/**
 * Map fal.ai model to our normalized ProviderModel format
 */
function mapToProviderModel(model: FalModel): ProviderModel {
  const capability = mapCategoryToCapability(model.metadata.category);

  return {
    id: model.endpoint_id,
    name: model.metadata.display_name,
    description: model.metadata.description,
    provider: "fal",
    capabilities: capability ? [capability] : [],
    coverImage: model.metadata.thumbnail_url,
  };
}

/**
 * Build authorization headers for fal.ai API
 * 修改版：优先使用传入的 Key (来自客户端)，如果没有，则尝试读取服务端的只读 Key
 */
function buildHeaders(apiKey: string | null): HeadersInit {
  const headers: HeadersInit = {};
  
  // 1. 优先使用传入的 Key
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
    return headers;
  }

  // 2. 调试模式：暂时硬编码写死 Key
  // 请把你的 FAL_READ_ONLY_KEY (sk-fal-...) 填在下面引号里
  const hardcodedKey = "0b81bc63-205f-43b1-bf8d-56a9efc89b73:7337c42ba26d72561e8863d9b7f2ef06"; 
  
  if (hardcodedKey) {
    console.log("[Debug] Using Hardcoded Key for Fal List");
    headers["Authorization"] = `Key ${hardcodedKey}`;
  }

  return headers;
}
/**
 * fal.ai provider implementation
 */
const falProvider: ProviderInterface = {
  id: "fal",
  name: "fal.ai",

  async listModels(): Promise<ProviderModel[]> {
    const apiKey = getApiKeyFromStorage();

    try {
      // Fetch all active models, filter client-side
      // Note: fal.ai API only accepts single category param, so we fetch all and filter
      const url = `${FAL_API_BASE}/models?status=active`;
      const response = await fetch(url, {
        headers: buildHeaders(apiKey),
      });

      if (!response.ok) {
        throw new Error(`fal.ai API error: ${response.status}`);
      }

      const data: FalModelsResponse = await response.json();

      // Filter to relevant categories and map to ProviderModel
      return data.models.filter(isRelevantModel).map(mapToProviderModel);
    } catch (error) {
      console.error("[fal.ai] Failed to list models:", error);
      return [];
    }
  },

  async searchModels(query: string): Promise<ProviderModel[]> {
    const apiKey = getApiKeyFromStorage();

    try {
      // Search with query, filter client-side
      // Note: fal.ai API only accepts single category param, so we fetch all and filter
      const url = `${FAL_API_BASE}/models?q=${encodeURIComponent(query)}&status=active`;
      const response = await fetch(url, {
        headers: buildHeaders(apiKey),
      });

      if (!response.ok) {
        throw new Error(`fal.ai API error: ${response.status}`);
      }

      const data: FalModelsResponse = await response.json();

      // Filter to relevant categories and map to ProviderModel
      return data.models.filter(isRelevantModel).map(mapToProviderModel);
    } catch (error) {
      console.error("[fal.ai] Failed to search models:", error);
      return [];
    }
  },

  async getModel(modelId: string): Promise<ProviderModel | null> {
    const apiKey = getApiKeyFromStorage();

    try {
      // Fetch specific model by endpoint_id
      const url = `${FAL_API_BASE}/models?endpoint_id=${encodeURIComponent(modelId)}`;
      const response = await fetch(url, {
        headers: buildHeaders(apiKey),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`fal.ai API error: ${response.status}`);
      }

      const data: FalModelsResponse = await response.json();

      if (data.models.length === 0) {
        return null;
      }

      const model = data.models[0];

      // Check if it's a relevant model type
      if (!isRelevantModel(model)) {
        console.warn(`[fal.ai] Model ${modelId} is not an image/video model`);
        return null;
      }

      return mapToProviderModel(model);
    } catch (error) {
      console.error("[fal.ai] Failed to get model:", error);
      return null;
    }
  },

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    const apiKey = getApiKeyFromStorage();
    // Note: fal.ai works without API key but with rate limits

    try {
      const modelId = input.model.id;

      // Build request body
      // fal.ai models typically expect "prompt" as input
      const requestBody: Record<string, unknown> = {
        prompt: input.prompt,
        ...input.parameters,
      };

      // Note: Image inputs are skipped for now (Phase 5 adds URL server)
      // input.images would need to be converted to URLs for fal.ai

      // POST to fal.run/{modelId}
      const response = await fetch(`https://fal.run/${modelId}`, {
        method: "POST",
        headers: {
          ...buildHeaders(apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `fal.ai API error: ${response.status} - ${errorText}`,
        };
      }

      const result: FalGenerationResponse = await response.json();

      // fal.ai response typically has "images" array with url field
      // or "image" object with url field depending on the model
      let imageUrl: string | null = null;

      if (result.images && Array.isArray(result.images) && result.images.length > 0) {
        imageUrl = result.images[0].url;
      } else if (result.image && result.image.url) {
        imageUrl = result.image.url;
      } else if (result.output && typeof result.output === "string") {
        // Some models return URL directly in output
        imageUrl = result.output;
      }

      if (!imageUrl) {
        return {
          success: false,
          error: "No image URL in response",
        };
      }

      // Fetch the image and convert to base64
      const imageResponse = await fetch(imageUrl);

      if (!imageResponse.ok) {
        return {
          success: false,
          error: `Failed to fetch output image: ${imageResponse.status}`,
        };
      }

      const imageArrayBuffer = await imageResponse.arrayBuffer();
      const imageBase64 = Buffer.from(imageArrayBuffer).toString("base64");

      // Determine MIME type from response
      const contentType =
        imageResponse.headers.get("content-type") || "image/png";

      return {
        success: true,
        outputs: [
          {
            type: "image",
            data: `data:${contentType};base64,${imageBase64}`,
            url: imageUrl,
          },
        ],
      };
    } catch (error) {
      console.error("[fal.ai] Generation failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Generation failed",
      };
    }
  },

  isConfigured(): boolean {
    // fal.ai works without API key (with rate limits)
    // Return true if key exists, but note that provider is usable without it
    return !!getApiKeyFromStorage();
  },

  getApiKey(): string | null {
    return getApiKeyFromStorage();
  },
};

// Self-register when module is imported
registerProvider(falProvider);

export default falProvider;
