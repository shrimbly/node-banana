/**
 * Unified Models API Endpoint
 *
 * Aggregates models from all configured providers (Replicate, fal.ai).
 * Uses in-memory caching to reduce external API calls.
 *
 * GET /api/models
 *
 * Query params:
 *   - provider: Optional, filter to specific provider ("replicate" | "fal")
 *   - search: Optional, search query
 *   - refresh: Optional, bypass cache if "true"
 *
 * Headers:
 *   - X-Replicate-Key: Replicate API key
 *   - X-Fal-Key: fal.ai API key (optional, works without but rate limited)
 *
 * Response:
 *   {
 *     success: true,
 *     models: ProviderModel[],
 *     cached: boolean,
 *     providers: { [provider]: { success, count, cached?, error? } },
 *     errors?: string[]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { ProviderType } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers";
import {
  getCachedModels,
  setCachedModels,
  getCacheKey,
} from "@/lib/providers/cache";

// API base URLs
const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const FAL_API_BASE = "https://api.fal.ai/v1";

// Categories we care about for image/video generation (fal.ai)
const RELEVANT_CATEGORIES = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
];

// Gemini image models (hardcoded - these don't come from an external API)
const GEMINI_IMAGE_MODELS: ProviderModel[] = [
  {
    id: "nano-banana",
    name: "Nano Banana",
    description: "Fast image generation with Gemini 2.5 Flash. Supports text-to-image and image-to-image with aspect ratio control.",
    provider: "gemini",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.039, currency: "USD" },
  },
  {
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    description: "High-quality image generation with Gemini 3 Pro. Supports text-to-image, image-to-image, resolution control (1K/2K/4K), and Google Search grounding.",
    provider: "gemini",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.134, currency: "USD" },
  },
];

// ============ Replicate Types ============

interface ReplicateModelsResponse {
  next: string | null;
  previous: string | null;
  results: ReplicateModel[];
}

interface ReplicateModel {
  url: string;
  owner: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  github_url?: string;
  paper_url?: string;
  license_url?: string;
  run_count: number;
  cover_image_url?: string;
  default_example?: Record<string, unknown>;
  latest_version?: {
    id: string;
    openapi_schema?: Record<string, unknown>;
  };
}

// ============ Fal.ai Types ============

interface FalModelsResponse {
  models: FalModel[];
  next_cursor: string | null;
  has_more: boolean;
}

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


// ============ Response Types ============

interface ProviderResult {
  success: boolean;
  count: number;
  cached?: boolean;
  error?: string;
}

interface ModelsSuccessResponse {
  success: true;
  models: ProviderModel[];
  cached: boolean;
  providers: Record<string, ProviderResult>;
  errors?: string[];
}

interface ModelsErrorResponse {
  success: false;
  error: string;
}

type ModelsResponse = ModelsSuccessResponse | ModelsErrorResponse;

// ============ Replicate Helpers ============

function inferReplicateCapabilities(model: ReplicateModel): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  const searchText = `${model.name} ${model.description ?? ""}`.toLowerCase();

  // Check for video-related keywords first
  const isVideoModel =
    searchText.includes("video") ||
    searchText.includes("animate") ||
    searchText.includes("motion") ||
    searchText.includes("luma") ||
    searchText.includes("kling") ||
    searchText.includes("minimax");

  if (isVideoModel) {
    // Video model - determine video capability type
    if (
      searchText.includes("img2vid") ||
      searchText.includes("image-to-video") ||
      searchText.includes("i2v")
    ) {
      capabilities.push("image-to-video");
    } else {
      capabilities.push("text-to-video");
    }
  } else {
    // Image model - default to text-to-image
    capabilities.push("text-to-image");

    // Check for image-to-image capability
    if (
      searchText.includes("img2img") ||
      searchText.includes("image-to-image") ||
      searchText.includes("inpaint") ||
      searchText.includes("controlnet") ||
      searchText.includes("upscale") ||
      searchText.includes("restore")
    ) {
      capabilities.push("image-to-image");
    }
  }

  return capabilities;
}

function mapReplicateModel(model: ReplicateModel): ProviderModel {
  return {
    id: `${model.owner}/${model.name}`,
    name: model.name,
    description: model.description,
    provider: "replicate",
    capabilities: inferReplicateCapabilities(model),
    coverImage: model.cover_image_url,
  };
}

async function fetchReplicateModels(apiKey: string): Promise<ProviderModel[]> {
  const allModels: ProviderModel[] = [];

  // Always fetch from the models endpoint - search endpoint is unreliable
  let url: string | null = `${REPLICATE_API_BASE}/models`;

  // Paginate through results (limit to 15 pages to avoid timeout)
  let pageCount = 0;
  const maxPages = 15;

  while (url && pageCount < maxPages) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Replicate API error: ${response.status}`);
    }

    const data: ReplicateModelsResponse = await response.json();
    if (data.results) {
      allModels.push(...data.results.map(mapReplicateModel));
    }
    url = data.next;
    pageCount++;
  }

  return allModels;
}

/**
 * Filter models by search query (client-side filtering for Replicate)
 */
function filterModelsBySearch(
  models: ProviderModel[],
  searchQuery: string
): ProviderModel[] {
  const searchLower = searchQuery.toLowerCase();
  return models.filter((model) => {
    const nameMatch = model.name.toLowerCase().includes(searchLower);
    const descMatch =
      model.description?.toLowerCase().includes(searchLower) || false;
    const idMatch = model.id.toLowerCase().includes(searchLower);
    return nameMatch || descMatch || idMatch;
  });
}

// ============ Fal.ai Helpers ============

function mapFalCategory(category: string): ModelCapability | null {
  if (RELEVANT_CATEGORIES.includes(category)) {
    return category as ModelCapability;
  }
  return null;
}

function isRelevantFalModel(model: FalModel): boolean {
  return RELEVANT_CATEGORIES.includes(model.metadata.category);
}

function mapFalModel(model: FalModel): ProviderModel {
  const capability = mapFalCategory(model.metadata.category);

  return {
    id: model.endpoint_id,
    name: model.metadata.display_name,
    description: model.metadata.description,
    provider: "fal",
    capabilities: capability ? [capability] : [],
    coverImage: model.metadata.thumbnail_url,
  };
}

async function fetchFalModels(
  apiKey: string | null,
  searchQuery?: string
): Promise<ProviderModel[]> {
  const allModels: ProviderModel[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  const headers: HeadersInit = {};
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
  }

  // Paginate through results (limit to 15 pages to avoid timeout)
  let pageCount = 0;
  const maxPages = 15;

  while (hasMore && pageCount < maxPages) {
    let url = `${FAL_API_BASE}/models?status=active`;
    if (searchQuery) {
      url += `&q=${encodeURIComponent(searchQuery)}`;
    }
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`fal.ai API error: ${response.status}`);
    }

    const data: FalModelsResponse = await response.json();
    allModels.push(...data.models.filter(isRelevantFalModel).map(mapFalModel));

    cursor = data.next_cursor;
    hasMore = data.has_more;
    pageCount++;
  }

  // Note: Pricing not fetched - external provider pricing is unreliable
  // CostDialog shows model links instead of prices for fal.ai/Replicate

  return allModels;
}

// ============ Main Handler ============

export async function GET(
  request: NextRequest
): Promise<NextResponse<ModelsResponse>> {
  // Parse query params
  const providerFilter = request.nextUrl.searchParams.get("provider") as
    | ProviderType
    | null;
  const searchQuery = request.nextUrl.searchParams.get("search") || undefined;
  const refresh = request.nextUrl.searchParams.get("refresh") === "true";
  const capabilitiesParam = request.nextUrl.searchParams.get("capabilities");
  const capabilitiesFilter: ModelCapability[] | null = capabilitiesParam
    ? (capabilitiesParam.split(",") as ModelCapability[])
    : null;

  // Get API keys from headers, falling back to env variables
  const replicateKey = request.headers.get("X-Replicate-Key") || process.env.REPLICATE_API_KEY || null;
  const falKey = request.headers.get("X-Fal-Key") || process.env.FAL_API_KEY || null;

  // Determine which providers to fetch from (excluding gemini - handled separately)
  const providersToFetch: ProviderType[] = [];
  let includeGemini = false;

  if (providerFilter) {
    if (providerFilter === "gemini") {
      // Only Gemini requested - no external API calls needed
      includeGemini = true;
    } else if (providerFilter === "replicate" && replicateKey) {
      providersToFetch.push("replicate");
    } else if (providerFilter === "fal") {
      // fal.ai works without key
      providersToFetch.push("fal");
    }
  } else {
    // Include all providers
    includeGemini = true; // Gemini always available
    if (replicateKey) {
      providersToFetch.push("replicate");
    }
    // fal.ai always included (works without key)
    providersToFetch.push("fal");
  }

  // Gemini is always available, so we don't fail if no external providers
  if (providersToFetch.length === 0 && !includeGemini) {
    return NextResponse.json<ModelsErrorResponse>(
      {
        success: false,
        error:
          "No providers available. Add REPLICATE_API_KEY or FAL_API_KEY to .env.local or configure in Settings.",
      },
      { status: 400 }
    );
  }

  const allModels: ProviderModel[] = [];
  const providerResults: Record<string, ProviderResult> = {};
  const errors: string[] = [];
  let anyFromCache = false;
  let allFromCache = true;

  // Add Gemini models first if included (they appear at the top)
  if (includeGemini) {
    // Filter by search query if provided
    let geminiModels = GEMINI_IMAGE_MODELS;
    if (searchQuery) {
      geminiModels = filterModelsBySearch(geminiModels, searchQuery);
    }
    allModels.push(...geminiModels);
    providerResults["gemini"] = {
      success: true,
      count: geminiModels.length,
      cached: true, // Hardcoded models are effectively "cached"
    };
    anyFromCache = true;
  }

  // Fetch from each provider
  for (const provider of providersToFetch) {
    // For Replicate, always use base cache key since we filter client-side
    // For fal.ai, include search in cache key since their API supports search
    const cacheKey =
      provider === "replicate"
        ? getCacheKey(provider)
        : getCacheKey(provider, searchQuery);
    let models: ProviderModel[] | null = null;
    let fromCache = false;

    // Check cache first (unless refresh=true)
    if (!refresh) {
      const cached = getCachedModels(cacheKey);
      if (cached) {
        models = cached;
        fromCache = true;
        anyFromCache = true;

        // For Replicate, apply client-side search filtering on cached models
        if (provider === "replicate" && searchQuery) {
          models = filterModelsBySearch(models, searchQuery);
        }
      }
    }

    // Fetch from API if cache miss
    if (!models) {
      allFromCache = false;
      try {
        if (provider === "replicate") {
          // Fetch all models (no search param - we filter client-side)
          const allReplicateModels = await fetchReplicateModels(replicateKey!);
          // Cache the full list
          setCachedModels(cacheKey, allReplicateModels);
          // Apply search filter if needed
          models = searchQuery
            ? filterModelsBySearch(allReplicateModels, searchQuery)
            : allReplicateModels;
        } else if (provider === "fal") {
          models = await fetchFalModels(falKey, searchQuery);
          // Cache the results (fal.ai handles search server-side)
          setCachedModels(cacheKey, models);
        } else {
          models = [];
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`[Models] ${provider}: ${errorMessage}`);
        errors.push(`${provider}: ${errorMessage}`);
        providerResults[provider] = {
          success: false,
          count: 0,
          error: errorMessage,
        };
        continue;
      }
    }

    // Add to results
    allModels.push(...models);
    providerResults[provider] = {
      success: true,
      count: models.length,
      cached: fromCache,
    };
  }

  // Check if we got any models
  if (allModels.length === 0 && errors.length === providersToFetch.length) {
    // All providers failed
    return NextResponse.json<ModelsErrorResponse>(
      {
        success: false,
        error: `All providers failed: ${errors.join("; ")}`,
      },
      { status: 500 }
    );
  }

  // Filter by capabilities if specified
  let filteredModels = allModels;
  if (capabilitiesFilter && capabilitiesFilter.length > 0) {
    filteredModels = allModels.filter((model) =>
      model.capabilities.some((cap) => capabilitiesFilter.includes(cap))
    );
  }

  // Sort models by provider, then by name
  filteredModels.sort((a, b) => {
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    return a.name.localeCompare(b.name);
  });

  const response: ModelsSuccessResponse = {
    success: true,
    models: filteredModels,
    cached: anyFromCache && allFromCache,
    providers: providerResults,
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  return NextResponse.json<ModelsSuccessResponse>(response);
}
