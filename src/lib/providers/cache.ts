/**
 * Model Caching Utility
 *
 * Simple in-memory cache for model lists from providers.
 * Reduces API calls to external providers by caching results with TTL.
 *
 * Features:
 * - 1-hour default TTL
 * - Per-provider cache keys
 * - Optional search query in cache key
 * - Manual invalidation support
 * - WaveSpeed schema caching (raw API schemas by model ID)
 *
 * Note: Cache is cleared on server restart (no persistence).
 */

import { ProviderModel } from "./types";
import { ProviderType } from "@/types";

/**
 * Cache entry with data and timestamp
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * WaveSpeed raw schema from API
 * Structure: { api_schemas: [{ request_schema: {...} }] }
 */
export interface WaveSpeedApiSchema {
  api_schemas?: Array<{
    request_schema?: Record<string, unknown>;
    response_schema?: Record<string, unknown>;
  }>;
}

/**
 * ModelRunner OpenAPI schema for a model.
 * Structure: { components: { schemas: { Input: {...}, ...enums } } }
 */
export interface ModelRunnerApiSchema {
  components?: {
    schemas?: Record<string, unknown>;
  };
}

/**
 * Default cache TTL: 1 hour
 */
const DEFAULT_TTL = 60 * 60 * 1000;

/**
 * Maximum number of keys retained per cache Map.
 *
 * Search-based cache keys (`provider:search:<query>`) are unbounded — every
 * distinct debounced query fragment produces a new key — so without a cap the
 * Maps grow monotonically in a long-running server. Maps preserve insertion
 * order, so evicting the first key removes the oldest entry (approximate LRU).
 */
const MAX_CACHE_SIZE = 100;

/**
 * Maximum number of keys retained in the WaveSpeed schema cache.
 *
 * A single catalogue fetch bulk-inserts one entry per model, which can exceed
 * the small search-cache cap and immediately evict entries from that same
 * fetch. The schema cache is keyed by model id (a bounded set), so it gets a
 * larger cap sized to hold a full catalogue.
 */
const MAX_SCHEMA_CACHE_SIZE = 1000;

/**
 * Sweep expired entries and enforce the size cap on a cache Map.
 *
 * Called on every write so the Maps cannot grow without bound. Expired entries
 * are removed first; if still over capacity, oldest entries (by insertion
 * order) are evicted until within the cap.
 *
 * @param map - Cache Map to prune
 * @param ttl - TTL used to determine expiry
 * @param maxSize - Maximum keys to retain (defaults to the search-cache cap)
 */
function pruneCache<T>(
  map: Map<string, CacheEntry<T>>,
  ttl: number,
  maxSize: number = MAX_CACHE_SIZE
): void {
  const now = Date.now();

  for (const [key, entry] of map) {
    if (now - entry.timestamp > ttl) {
      map.delete(key);
    }
  }

  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

/**
 * In-memory cache storage for models
 */
const cache: Map<string, CacheEntry<ProviderModel[]>> = new Map();

/**
 * In-memory cache for WaveSpeed raw schemas (keyed by model_id)
 * This allows the schema endpoint to retrieve schemas without re-fetching all models
 */
const wavespeedSchemaCache: Map<string, CacheEntry<WaveSpeedApiSchema>> = new Map();

/**
 * ModelRunner OpenAPI schemas, keyed by "owner/alias" endpoint.
 */
const modelrunnerSchemaCache: Map<string, CacheEntry<ModelRunnerApiSchema>> = new Map();

/**
 * Get cached models for a key if not expired
 *
 * @param key - Cache key (use getCacheKey to generate)
 * @param ttl - Optional custom TTL in milliseconds
 * @returns Cached models or null if not in cache or expired
 */
export function getCachedModels(
  key: string,
  ttl: number = DEFAULT_TTL
): ProviderModel[] | null {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  const now = Date.now();
  if (now - entry.timestamp > ttl) {
    // Cache expired, remove entry
    cache.delete(key);
    return null;
  }

  return entry.data;
}

/**
 * Store models in cache with current timestamp
 *
 * @param key - Cache key (use getCacheKey to generate)
 * @param models - Models to cache
 */
export function setCachedModels(key: string, models: ProviderModel[]): void {
  cache.set(key, {
    data: models,
    timestamp: Date.now(),
  });
  pruneCache(cache, DEFAULT_TTL);
}

/**
 * Invalidate cache entries
 *
 * @param key - Optional specific key to invalidate. If not provided, clears entire cache.
 */
export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/**
 * Generate a cache key for provider models
 *
 * @param provider - Provider type
 * @param search - Optional search query
 * @returns Cache key string
 *
 * @example
 * getCacheKey("replicate")           // "replicate:models"
 * getCacheKey("fal", "flux")         // "fal:search:flux"
 */
export function getCacheKey(provider: ProviderType, search?: string): string {
  if (search) {
    return `${provider}:search:${search}`;
  }
  return `${provider}:models`;
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: Array.from(cache.keys()),
  };
}

// ============ WaveSpeed Schema Cache ============

/**
 * Get cached WaveSpeed schema for a model
 *
 * @param modelId - WaveSpeed model ID (e.g., "wavespeed-ai/flux-dev")
 * @param ttl - Optional custom TTL in milliseconds
 * @returns Cached schema or null if not in cache or expired
 */
export function getCachedWaveSpeedSchema(
  modelId: string,
  ttl: number = DEFAULT_TTL
): WaveSpeedApiSchema | null {
  const entry = wavespeedSchemaCache.get(modelId);

  if (!entry) {
    return null;
  }

  const now = Date.now();
  if (now - entry.timestamp > ttl) {
    wavespeedSchemaCache.delete(modelId);
    return null;
  }

  return entry.data;
}

/**
 * Store WaveSpeed schema in cache
 *
 * @param modelId - WaveSpeed model ID
 * @param schema - Raw API schema to cache
 */
export function setCachedWaveSpeedSchema(
  modelId: string,
  schema: WaveSpeedApiSchema
): void {
  wavespeedSchemaCache.set(modelId, {
    data: schema,
    timestamp: Date.now(),
  });
  pruneCache(wavespeedSchemaCache, DEFAULT_TTL, MAX_SCHEMA_CACHE_SIZE);
}

/**
 * Store multiple WaveSpeed schemas at once (efficient bulk operation)
 *
 * @param schemas - Map of model ID to schema
 */
export function setCachedWaveSpeedSchemas(
  schemas: Map<string, WaveSpeedApiSchema>
): void {
  const now = Date.now();
  for (const [modelId, schema] of schemas) {
    wavespeedSchemaCache.set(modelId, {
      data: schema,
      timestamp: now,
    });
  }
  pruneCache(wavespeedSchemaCache, DEFAULT_TTL, MAX_SCHEMA_CACHE_SIZE);
}

/**
 * Get WaveSpeed schema cache statistics (for debugging)
 */
export function getWaveSpeedSchemaCacheStats(): { size: number; modelIds: string[] } {
  return {
    size: wavespeedSchemaCache.size,
    modelIds: Array.from(wavespeedSchemaCache.keys()),
  };
}


// ============ ModelRunner Schema Cache ============

/**
 * Get cached ModelRunner schema for a model
 *
 * @param modelId - ModelRunner endpoint (e.g., "wan-video/wan/v3.0/text-to-video")
 * @param ttl - Optional custom TTL in milliseconds
 * @returns Cached schema or null if not in cache or expired
 */
export function getCachedModelRunnerSchema(
  modelId: string,
  ttl: number = DEFAULT_TTL
): ModelRunnerApiSchema | null {
  const entry = modelrunnerSchemaCache.get(modelId);

  if (!entry) {
    return null;
  }

  const now = Date.now();
  if (now - entry.timestamp > ttl) {
    modelrunnerSchemaCache.delete(modelId);
    return null;
  }

  return entry.data;
}

/**
 * Store multiple ModelRunner schemas at once.
 *
 * The catalog returns every model's full OpenAPI schema inline, so the whole set
 * is cached in one pass when the model list is fetched and no per-model request
 * is needed afterwards.
 *
 * @param schemas - Map of endpoint to schema
 */
export function setCachedModelRunnerSchemas(
  schemas: Map<string, ModelRunnerApiSchema>
): void {
  const now = Date.now();
  for (const [modelId, schema] of schemas) {
    modelrunnerSchemaCache.set(modelId, {
      data: schema,
      timestamp: now,
    });
  }
  pruneCache(modelrunnerSchemaCache, DEFAULT_TTL, MAX_SCHEMA_CACHE_SIZE);
}
