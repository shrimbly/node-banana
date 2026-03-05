import { ProviderType } from "@/types";

/**
 * Get the URL to a model's page on its provider's website.
 * Returns null for providers without model pages (e.g., Gemini).
 */
export function getModelPageUrl(
  provider: ProviderType,
  modelId: string,
  pageUrl?: string
): string | null {
  if (pageUrl) return pageUrl;
  switch (provider) {
    case "replicate": {
      const baseModelId = modelId.split(":")[0];
      return `https://replicate.com/${baseModelId}`;
    }
    case "fal":
      return `https://fal.ai/models/${modelId}`;
    case "kie":
      return `https://docs.kie.ai/`;
    case "wavespeed":
      return `https://wavespeed.ai`;
    default:
      return null;
  }
}

/**
 * Get the display name for a provider.
 */
export function getProviderDisplayName(provider: ProviderType): string {
  switch (provider) {
    case "gemini":
      return "Gemini";
    case "replicate":
      return "Replicate";
    case "fal":
      return "fal.ai";
    case "kie":
      return "Kie.ai";
    case "wavespeed":
      return "WaveSpeed";
    default:
      return provider;
  }
}
