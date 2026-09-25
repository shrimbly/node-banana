/**
 * API Header Builder Utilities
 *
 * Centralizes the duplicated header-building logic for API calls
 * across executeWorkflow and regenerateNode.
 */

import { ProviderType, ProviderSettings, LLMProvider } from "@/types";
import { getComfyRouterKey } from "@/lib/providers/comfyRouterKey";

/**
 * Header name mapping for each provider
 */
const PROVIDER_HEADER_MAP: Record<ProviderType, string> = {
  gemini: "X-Gemini-API-Key",
  replicate: "X-Replicate-API-Key",
  fal: "X-Fal-API-Key",
  kie: "X-Kie-Key",
  wavespeed: "X-WaveSpeed-Key",
  openai: "X-OpenAI-API-Key",
  anthropic: "X-Anthropic-API-Key",
  comfy: "X-Comfy-Router-Key",
};

/**
 * Build headers for image/video generation API calls.
 * Adds the appropriate API key header based on the provider.
 */
export function buildGenerateHeaders(
  provider: ProviderType | string,
  providerSettings: ProviderSettings
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const providerKey = provider as ProviderType;
  const headerName = PROVIDER_HEADER_MAP[providerKey];
  if (headerName) {
    // Comfy Router accepts the Comfy Cloud key, so fall back to it.
    const apiKey = providerKey === "comfy" ? getComfyRouterKey(providerSettings) : providerSettings.providers[providerKey]?.apiKey;
    if (apiKey) {
      headers[headerName] = apiKey;
    }
  }

  return headers;
}

/** Provider keys for the models routes; null/undefined/empty means "not set". */
export type ModelsApiKeys = Partial<
  Record<"replicate" | "fal" | "kie" | "wavespeed" | "openai" | "gemini" | "comfy", string | null>
>;

/**
 * Header names read by GET /api/models and GET /api/models/:modelId. They
 * differ from PROVIDER_HEADER_MAP for Replicate and fal.ai (the server
 * accepts both spellings; these are the models routes' own).
 */
const MODELS_HEADER_MAP: Record<keyof ModelsApiKeys, string> = {
  replicate: "X-Replicate-Key",
  fal: "X-Fal-Key",
  kie: "X-Kie-Key",
  wavespeed: "X-WaveSpeed-Key",
  openai: "X-OpenAI-API-Key",
  gemini: "X-Gemini-API-Key",
  comfy: "X-Comfy-Router-Key",
};

/**
 * Build headers for the models listing and schema routes, one per key that
 * is present.
 */
export function buildModelsApiHeaders(keys: ModelsApiKeys): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [provider, headerName] of Object.entries(MODELS_HEADER_MAP) as Array<
    [keyof ModelsApiKeys, string]
  >) {
    const apiKey = keys[provider];
    if (apiKey) {
      headers[headerName] = apiKey;
    }
  }
  return headers;
}

/**
 * Build headers for LLM API calls.
 * Maps LLM provider names ("google", "openai") to their API key headers.
 */
export function buildLlmHeaders(
  llmProvider: LLMProvider | string,
  providerSettings: ProviderSettings
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (llmProvider === "google") {
    const geminiConfig = providerSettings.providers.gemini;
    if (geminiConfig?.apiKey) {
      headers["X-Gemini-API-Key"] = geminiConfig.apiKey;
    }
  } else if (llmProvider === "openai") {
    const openaiConfig = providerSettings.providers.openai;
    if (openaiConfig?.apiKey) {
      headers["X-OpenAI-API-Key"] = openaiConfig.apiKey;
    }
  } else if (llmProvider === "anthropic") {
    const anthropicConfig = providerSettings.providers.anthropic;
    if (anthropicConfig?.apiKey) {
      headers["X-Anthropic-API-Key"] = anthropicConfig.apiKey;
    }
  }

  return headers;
}
