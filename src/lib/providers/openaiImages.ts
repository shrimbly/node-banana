import type { ModelParameter, ProviderModel } from "./types";

export const OPENAI_IMAGE_25_MODELS: ProviderModel[] = [
  {
    id: "gpt-image-2.5-sunburst",
    name: "GPT Image 2.5 Sunburst",
    description: "OpenAI image generation and editing with a focus on quality and editing precision.",
    provider: "openai",
    capabilities: ["text-to-image", "image-to-image"],
    pageUrl: "https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst",
  },
  {
    id: "gpt-image-2.5-flare",
    name: "GPT Image 2.5 Flare",
    description: "OpenAI image generation and editing with a focus on speed for everyday use.",
    provider: "openai",
    capabilities: ["text-to-image", "image-to-image"],
    pageUrl: "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
  },
];

export function isOpenAIImage25(modelId: string): boolean {
  return /^gpt-image-2\.5-(sunburst|flare)(-2026-09-08)?$/.test(modelId);
}

export const OPENAI_IMAGE_SIZE_PRESETS = [
  "auto", "1024x1024", "1536x1024", "1024x1536", "1536x864", "864x1536",
  "2048x1152", "1152x2048", "2048x2048", "3840x2160", "2160x3840",
];

export const OPENAI_IMAGE_25_PARAMETERS: ModelParameter[] = [
  { name: "size", type: "string", description: "Output dimensions. Sizes above 2560×1440 are experimental.", default: "auto" },
  { name: "quality", type: "string", enum: ["auto", "low", "medium", "high", "xhigh", "max"], default: "auto" },
  { name: "background", type: "string", enum: ["auto", "opaque", "transparent"], default: "auto" },
  { name: "output_format", type: "string", enum: ["png", "jpeg", "webp"], default: "png" },
  { name: "output_compression", type: "integer", description: "JPEG or WebP compression quality", minimum: 0, maximum: 100, default: 100 },
];

/** Shared by the settings UI and API so invalid custom sizes never reach OpenAI. */
export function validateOpenAIImageSize(size: unknown): string | null {
  if (size === "auto") return null;
  if (typeof size !== "string" || !/^\d+x\d+$/.test(size)) {
    return "Use auto or dimensions such as 1536x864.";
  }
  const [width, height] = size.split("x").map(Number);
  if (!width || !height || width % 16 || height % 16 || width > 3840 || height > 3840) {
    return "Width and height must be positive multiples of 16, at most 3840 pixels.";
  }
  if (width / height > 3 || height / width > 3) {
    return "Aspect ratio must be between 1:3 and 3:1.";
  }
  if (width * height < 655_360 || width * height > 8_294_400) {
    return "Image size must be between 655,360 and 8,294,400 pixels.";
  }
  return null;
}

export function validateOpenAIImageParameters(modelId: string, params: Record<string, unknown>): string | null {
  if (params.n !== undefined && params.n !== 1) return "OpenAI nodes currently support one output image per run (n=1).";
  if (params.size !== undefined && isOpenAIImage25(modelId)) {
    const error = validateOpenAIImageSize(params.size);
    if (error) return error;
  }
  const quality = isOpenAIImage25(modelId)
    ? ["auto", "low", "medium", "high", "xhigh", "max"]
    : ["auto", "low", "medium", "high"];
  for (const [key, allowed] of Object.entries({ quality, background: ["auto", "opaque", "transparent"], output_format: ["png", "jpeg", "webp"] })) {
    if (params[key] !== undefined && !allowed.includes(params[key] as string)) return `Unsupported OpenAI ${key}.`;
  }
  if (params.background === "transparent" && params.output_format === "jpeg") {
    return "Transparent backgrounds require PNG or WebP. Change the output format or background.";
  }
  const compression = params.output_compression;
  if (compression !== undefined && (typeof compression !== "number" || !Number.isInteger(compression) || compression < 0 || compression > 100)) {
    return "Output compression must be an integer from 0 to 100.";
  }
  return null;
}

/**
 * USD token rates verified 2026-09-09 on the Sunburst/Flare model pages.
 * The Images response does not document a reliable cache breakdown, so this
 * uses uncached rates and remains an estimate even though token counts are real.
 */
export function estimateOpenAIImage25Cost(modelId: string, usage?: import("@/types/api").ImageGenerationMetadata["usage"]): import("@/types/api").ImageGenerationMetadata["cost"] {
  if (!isOpenAIImage25(modelId) || !usage) return undefined;
  const { textInputTokens, imageInputTokens, imageOutputTokens } = usage;
  if (![textInputTokens, imageInputTokens, imageOutputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  return {
    amount: (textInputTokens * 5 + imageInputTokens * 8 + imageOutputTokens * 30) / 1_000_000,
    currency: "USD",
    estimated: true,
  };
}
