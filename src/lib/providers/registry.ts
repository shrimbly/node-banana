/**
 * Model Registry
 *
 * Lists models across every configured provider (Replicate, fal.ai, Gemini,
 * WaveSpeed, Kie.ai, OpenAI, Comfy Router). This is the body of
 * GET /api/models, kept here so other server code (the in-app agent) can list
 * models with the same keys, caching, filtering and sorting as the route.
 *
 * Gemini, Kie.ai and OpenAI are static catalogs; Comfy Router offers its
 * bound models the Router currently serves (./comfyRouter/catalog); Replicate,
 * fal.ai and WaveSpeed come from the model catalog (./catalog): their lists
 * are fetched at once, each under its own deadline, kept on disk, served
 * straight away and refreshed behind the request when they age. Replicate's
 * list is built from its curated collections, so it holds the models
 * Replicate itself recommends for each capability rather than whatever was
 * uploaded last.
 *
 * Server only.
 */

import { ProviderType } from "@/types";
import { OPENAI_IMAGE_25_MODELS } from "./openaiImages";
import { GEMINI_OMNI_MODELS } from "./geminiOmni";
import { ProviderModel, ModelCapability } from "./types";
import { setCachedWaveSpeedSchemas, WaveSpeedApiSchema } from "./cache";
import { getProviderCatalog, type CatalogFetcher, type CatalogStatus } from "./catalog";
import { startDeadline } from "./deadline";
import { comfyRouterBoundModels, comfyRouterProviderModels } from "./comfyRouter/catalog";
import { isValidReplicateModelId } from "./ids";
import { awaitFalCooldown, noteFalRateLimit } from "./falSchema";
import type { ProviderKeys } from "./keys";

// API base URLs
const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const FAL_API_BASE = "https://api.fal.ai/v1";

const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";

// Categories we care about for image/video/3D/audio generation (fal.ai)
const RELEVANT_CATEGORIES = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "text-to-3d",
  "image-to-3d",
  "text-to-speech",
  "text-to-music",
  "text-to-sound-effects",
  "audio-to-video",
];

// Kie.ai models (hardcoded - no discovery API available)
const KIE_MODELS: ProviderModel[] = [
  // ============ Image Models (11) ============
  {
    id: "z-image",
    name: "Z-Image",
    description: "Fast, affordable text-to-image generation. Great for quick iterations.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.004, currency: "USD" },
    pageUrl: "https://kie.ai/z-image",
  },
  {
    id: "seedream/4.5-text-to-image",
    name: "Seedream 4.5",
    description: "High-quality text-to-image generation with excellent prompt following.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.032, currency: "USD" },
    pageUrl: "https://kie.ai/seedream",
  },
  {
    id: "seedream/4.5-edit",
    name: "Seedream 4.5 Edit",
    description: "Image editing and transformation using Seedream 4.5.",
    provider: "kie",
    capabilities: ["image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.032, currency: "USD" },
    pageUrl: "https://kie.ai/seedream",
  },
  {
    id: "gpt-image/1.5-text-to-image",
    name: "GPT Image 1.5",
    description: "OpenAI-style image generation with excellent prompt understanding.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.06, currency: "USD" },
    pageUrl: "https://kie.ai/gpt-image-1",
  },
  {
    id: "gpt-image/1.5-image-to-image",
    name: "GPT Image 1.5 Edit",
    description: "Image editing using GPT Image 1.5 model.",
    provider: "kie",
    capabilities: ["image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.06, currency: "USD" },
    pageUrl: "https://kie.ai/gpt-image-1",
  },
  {
    id: "flux-2/pro-text-to-image",
    name: "FLUX.2 Pro",
    description: "FLUX.2 Pro text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/flux-2",
  },
  {
    id: "flux-2/pro-image-to-image",
    name: "FLUX.2 Pro Edit",
    description: "FLUX.2 Pro image editing via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-image"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/flux-2",
  },
  {
    id: "flux-2/flex-text-to-image",
    name: "FLUX.2 Flex",
    description: "FLUX.2 Flex text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/flux-2",
  },
  {
    id: "flux-2/flex-image-to-image",
    name: "FLUX.2 Flex Edit",
    description: "FLUX.2 Flex image editing via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-image"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/flux-2",
  },
  {
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    description: "Google Gemini 3 Pro image generation via Kie.ai. Supports text-to-image and image-to-image with up to 8 input images.",
    provider: "kie",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/google/pro-image-to-image",
  },
  {
    id: "nano-banana-2",
    name: "Nano Banana 2 (Kie)",
    description: "Google Gemini 3.1 Flash image generation via Kie.ai. Supports text-to-image and image-to-image with resolution control.",
    provider: "kie",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/google/nanobanana2",
  },
  {
    id: "google/imagen4",
    name: "Imagen 4",
    description: "Google Imagen 4 high-quality text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/google/imagen4",
  },
  {
    id: "google/imagen4-fast",
    name: "Imagen 4 Fast",
    description: "Google Imagen 4 fast text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/google/imagen4-fast",
  },
  {
    id: "google/imagen4-ultra",
    name: "Imagen 4 Ultra",
    description: "Google Imagen 4 Ultra highest-quality text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/google/imagen4-ultra",
  },
  {
    id: "seedream/5-lite-text-to-image",
    name: "Seedream 5.0 Lite",
    description: "Seedream 5.0 Lite text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/seedream/5-lite",
  },
  {
    id: "seedream/5-lite-image-to-image",
    name: "Seedream 5.0 Lite Edit",
    description: "Seedream 5.0 Lite image editing via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/seedream/5-lite",
  },
  {
    id: "wan/2-7-image",
    name: "Wan 2.7 Image",
    description: "Wan 2.7 image generation. Supports text-to-image and image-to-image via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/wan/2-7-image",
  },
  {
    id: "grok-imagine/text-to-image",
    name: "Grok Imagine",
    description: "Grok Imagine text-to-image generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-image"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/grok-imagine",
  },
  {
    id: "grok-imagine/image-to-image",
    name: "Grok Imagine Edit",
    description: "Grok Imagine image editing via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-image"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/grok-imagine",
  },
  // ============ Video Models ============
  {
    id: "bytedance/seedance-2/text-to-video",
    name: "Seedance 2.0",
    description: "ByteDance Seedance 2.0 text-to-video generation via Kie.ai. Supports audio generation and web search.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/bytedance/seedance-2",
  },
  {
    id: "bytedance/seedance-2/image-to-video",
    name: "Seedance 2.0 I2V",
    description: "ByteDance Seedance 2.0 image-to-video generation via Kie.ai. Supports audio generation and web search.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/bytedance/seedance-2",
  },
  {
    id: "bytedance/seedance-2-fast/text-to-video",
    name: "Seedance 2.0 Fast",
    description: "ByteDance Seedance 2.0 Fast text-to-video generation via Kie.ai. Supports audio generation and web search.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/bytedance/seedance-2-fast",
  },
  {
    id: "bytedance/seedance-2-fast/image-to-video",
    name: "Seedance 2.0 Fast I2V",
    description: "ByteDance Seedance 2.0 Fast image-to-video generation via Kie.ai. Supports audio generation and web search.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/bytedance/seedance-2-fast",
  },
  {
    id: "grok-imagine/text-to-video",
    name: "Grok Imagine Video",
    description: "Grok Imagine text-to-video generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/grok-imagine",
  },
  {
    id: "grok-imagine/image-to-video",
    name: "Grok Imagine I2V",
    description: "Grok Imagine image-to-video generation via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/grok-imagine",
  },
  {
    id: "kling-2.6/text-to-video",
    name: "Kling 2.6",
    description: "Kling 2.6 video generation from text.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.60, currency: "USD" },
    pageUrl: "https://kie.ai/kling-2-6",
  },
  {
    id: "kling-2.6/image-to-video",
    name: "Kling 2.6 Image-to-Video",
    description: "Kling 2.6 video generation from images.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.60, currency: "USD" },
    pageUrl: "https://kie.ai/kling-2-6",
  },
  {
    id: "kling-2.6/motion-control",
    name: "Kling 2.6 Motion Control",
    description: "Motion transfer from video to static image. Supports 720p and 1080p output.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/kling-2-6",
  },
  {
    id: "kling-3.0/video/text-to-video",
    name: "Kling 3.0",
    description: "Kling 3.0 text-to-video generation via Kie.ai. Supports 3-15 second videos with sound.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/kling/3-0",
  },
  {
    id: "kling-3.0/video/image-to-video",
    name: "Kling 3.0 I2V",
    description: "Kling 3.0 image-to-video generation via Kie.ai. Supports up to 2 reference images.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/kling/3-0",
  },
  {
    id: "kling-3.0/motion-control",
    name: "Kling 3.0 Motion Control",
    description: "Kling 3.0 motion transfer from video to static image via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/kling/3-0-motion",
  },
  {
    id: "kling/v2-5-turbo-text-to-video-pro",
    name: "Kling 2.5 Turbo",
    description: "Kling 2.5 Turbo text-to-video generation via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/kling-2-6",
  },
  {
    id: "kling/v2-5-turbo-image-to-video-pro",
    name: "Kling 2.5 Turbo I2V",
    description: "Kling 2.5 Turbo image-to-video generation via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/kling-2-6",
  },
  {
    id: "wan/2-6-text-to-video",
    name: "Wan 2.6",
    description: "Wan 2.6 video generation from text.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.90, currency: "USD" },
    pageUrl: "https://kie.ai/wan-2-6",
  },
  {
    id: "wan/2-6-image-to-video",
    name: "Wan 2.6 Image-to-Video",
    description: "Wan 2.6 video generation from images.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.90, currency: "USD" },
    pageUrl: "https://kie.ai/wan-2-6",
  },
  {
    id: "wan/2-6-video-to-video",
    name: "Wan 2.6 V2V",
    description: "Wan 2.6 video-to-video transformation via Kie.ai.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/wan-2-6",
  },
  {
    id: "wan/2-7-text-to-video",
    name: "Wan 2.7",
    description: "Wan 2.7 text-to-video generation via Kie.ai. Supports prompt extension and watermark control.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/wan/2-7-t2v",
  },
  {
    id: "wan/2-7-image-to-video",
    name: "Wan 2.7 I2V",
    description: "Wan 2.7 image-to-video generation via Kie.ai. Supports first and last frame control.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/market/wan/2-7-i2v",
  },
  {
    id: "topaz/video-upscale",
    name: "Topaz Video Upscale",
    description: "AI video upscaling. Supports 1x, 2x, and 4x scaling factors.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://kie.ai/topaz",
  },
  {
    id: "veo3/text-to-video",
    name: "Veo 3",
    description: "Google Veo 3.1 high-quality text-to-video generation with audio via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/veo3-api/quickstart",
  },
  {
    id: "veo3/image-to-video",
    name: "Veo 3 I2V",
    description: "Google Veo 3.1 image-to-video generation via Kie.ai. Supports 1-2 reference images.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/veo3-api/quickstart",
  },
  {
    id: "veo3-fast/text-to-video",
    name: "Veo 3 Fast",
    description: "Google Veo 3.1 fast text-to-video generation with audio via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/veo3-api/quickstart",
  },
  {
    id: "veo3-fast/image-to-video",
    name: "Veo 3 Fast I2V",
    description: "Google Veo 3.1 fast image-to-video generation via Kie.ai. Supports 1-2 reference images.",
    provider: "kie",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pageUrl: "https://docs.kie.ai/veo3-api/quickstart",
  },
  // ============ Audio/TTS Models (4) ============
  {
    id: "elevenlabs/turbo-v2.5",
    name: "ElevenLabs Turbo v2.5",
    description: "Fast, high-quality text-to-speech with natural-sounding voices from ElevenLabs via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-audio"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
    pageUrl: "https://kie.ai/elevenlabs-tts",
  },
  {
    id: "elevenlabs/multilingual-v2",
    name: "ElevenLabs Multilingual v2",
    description: "Multilingual text-to-speech supporting multiple languages with natural voices via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-audio"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
    pageUrl: "https://kie.ai/elevenlabs-tts",
  },
  {
    id: "elevenlabs/text-to-dialogue-v3",
    name: "ElevenLabs Eleven V3",
    description: "ElevenLabs' most expressive text-to-speech model with emotional nuance, supporting 70+ languages and audio tags for dialogue via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-audio"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.06, currency: "USD" },
    pageUrl: "https://kie.ai/elevenlabs/text-to-dialogue-v3",
  },
  {
    id: "elevenlabs/sound-effect-v2",
    name: "ElevenLabs Sound Effects v2",
    description: "Generate sound effects from text descriptions. Supports looping, 0.5-22 second duration, and multiple output formats via Kie.ai.",
    provider: "kie",
    capabilities: ["text-to-audio"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.02, currency: "USD" },
    pageUrl: "https://kie.ai/elevenlabs-sound-effect",
  },
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
    id: "nano-banana-2",
    name: "Nano Banana 2",
    description: "High-efficiency image generation with Gemini 3.1 Flash. Supports resolution control (512/1K/2K/4K), Google Search grounding, and up to 10 reference images.",
    provider: "gemini",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.067, currency: "USD" },
  },
  {
    id: "nano-banana-2-lite",
    name: "Nano Banana 2 Lite",
    description: "Fast, low-cost image generation with Gemini 3.1 Flash Lite. Supports text-to-image and image-to-image with up to 10 reference images at 1K resolution.",
    provider: "gemini",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.034, currency: "USD" },
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

// Gemini video models (native Veo via Gemini API)
const GEMINI_VIDEO_MODELS: ProviderModel[] = [
  ...GEMINI_OMNI_MODELS,
  {
    id: "veo-3.1/text-to-video",
    name: "Veo 3.1",
    description: "Highest quality video generation with Veo 3.1. Supports 720p/1080p/4k, 4-8 second clips, and native audio via Gemini API.",
    provider: "gemini",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pricing: { type: "per-second", amount: 0.40, currency: "USD" },
  },
  {
    id: "veo-3.1/image-to-video",
    name: "Veo 3.1 I2V",
    description: "Image-to-video generation with Veo 3.1. Supports 720p/1080p/4k, 4-8 second clips, and native audio via Gemini API.",
    provider: "gemini",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pricing: { type: "per-second", amount: 0.40, currency: "USD" },
  },
  {
    id: "veo-3.1-fast/text-to-video",
    name: "Veo 3.1 Fast",
    description: "Fast, cost-effective video generation with Veo 3.1 Fast. Supports 720p/1080p/4k, 4-8 second clips via Gemini API.",
    provider: "gemini",
    capabilities: ["text-to-video"],
    coverImage: undefined,
    pricing: { type: "per-second", amount: 0.15, currency: "USD" },
  },
  {
    id: "veo-3.1-fast/image-to-video",
    name: "Veo 3.1 Fast I2V",
    description: "Fast image-to-video generation with Veo 3.1 Fast. Supports 720p/1080p/4k, 4-8 second clips via Gemini API.",
    provider: "gemini",
    capabilities: ["image-to-video"],
    coverImage: undefined,
    pricing: { type: "per-second", amount: 0.15, currency: "USD" },
  },
];

// OpenAI image models (hardcoded - no public image model discovery API)
// NOTE: `pricing.amount` is a flat per-run ESTIMATE. OpenAI image pricing varies
// by size and quality; cost tracking treats this as an approximation.
const OPENAI_IMAGE_MODELS: ProviderModel[] = [
  ...OPENAI_IMAGE_25_MODELS,
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    description: "OpenAI's state-of-the-art image generation model (gpt-image-2). Best-in-class text rendering, photorealism, and precise editing. Supports text-to-image and image-to-image.",
    provider: "openai",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
    pageUrl: "https://platform.openai.com/docs/guides/images",
  },
  {
    id: "gpt-image-1",
    name: "GPT Image 1",
    description: "OpenAI's gpt-image-1 model for high-quality image generation. Supports text-to-image and image-to-image with size, quality, and background controls.",
    provider: "openai",
    capabilities: ["text-to-image", "image-to-image"],
    coverImage: undefined,
    pricing: { type: "per-run", amount: 0.05, currency: "USD" },
    pageUrl: "https://platform.openai.com/docs/guides/images",
  },
];

// WaveSpeed models are now fetched dynamically from https://api.wavespeed.ai/api/v3/models

// ============ Replicate Types ============

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

// ============ Replicate Helpers ============

function inferReplicateCapabilities(model: ReplicateModel): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  const searchText = `${model.name} ${model.description ?? ""}`.toLowerCase();

  // Check for 3D-related keywords first
  const is3DModel =
    searchText.includes("3d") ||
    searchText.includes("mesh") ||
    searchText.includes("triposr") ||
    searchText.includes("tripo") ||
    searchText.includes("hunyuan3d") ||
    searchText.includes("instant-mesh") ||
    searchText.includes("point-e") ||
    searchText.includes("shap-e");

  if (is3DModel) {
    // 3D model - determine if image-to-3d or text-to-3d
    const hasImageInput =
      searchText.includes("image") ||
      searchText.includes("img") ||
      searchText.includes("photo");
    if (hasImageInput) {
      capabilities.push("image-to-3d");
    } else {
      capabilities.push("text-to-3d");
    }
    return capabilities;
  }

  // Check for audio-related keywords
  const isAudioModel =
    searchText.includes("music") ||
    searchText.includes("audio") ||
    searchText.includes("tts") ||
    searchText.includes("text-to-speech") ||
    searchText.includes("speech") ||
    searchText.includes("sound effect") ||
    searchText.includes("voice") ||
    searchText.includes("bark") ||
    searchText.includes("xtts");

  if (isAudioModel) {
    capabilities.push("text-to-audio");
    return capabilities;
  }

  // Video-processing models (upscalers, restorers, frame interpolators) often
  // don't say "video" in their name — gate them on a processing verb paired with
  // a video signal so they still land under the Video node instead of Image.
  const hasVideoProcessingSignal =
    (searchText.includes("upscale") ||
      searchText.includes("restore") ||
      searchText.includes("interpolat")) &&
    (searchText.includes("video") ||
      searchText.includes("clip") ||
      searchText.includes("footage") ||
      searchText.includes("fps") ||
      searchText.includes("frames"));

  // Check for video-related keywords
  const isVideoModel =
    searchText.includes("video") ||
    searchText.includes("animate") ||
    searchText.includes("motion") ||
    searchText.includes("luma") ||
    searchText.includes("kling") ||
    searchText.includes("minimax") ||
    hasVideoProcessingSignal;

  if (isVideoModel) {
    // Video model - determine video capability type. Processing models consume a
    // media (video/frame) input, so treat them as image-to-video rather than text.
    if (
      searchText.includes("img2vid") ||
      searchText.includes("image-to-video") ||
      searchText.includes("i2v") ||
      hasVideoProcessingSignal
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

/**
 * A cover image the browse dialog can show: an http(s) URL of sane length.
 * Replicate serves some covers as base64 data URLs (one is 1.5MB), which
 * would dwarf the whole list; those are dropped.
 */
export function cleanCoverUrl(url: string | undefined | null): string | undefined {
  if (!url || url.length > 2048) return undefined;
  if (!/^https?:\/\//i.test(url) || url.includes("data:")) return undefined;
  return url;
}

function mapReplicateModel(model: ReplicateModel): ProviderModel {
  return {
    id: `${model.owner}/${model.name}`,
    name: model.name,
    description: model.description,
    provider: "replicate",
    capabilities: inferReplicateCapabilities(model),
    coverImage: cleanCoverUrl(model.cover_image_url),
    ...(typeof model.run_count === "number" ? { popularity: model.run_count } : {}),
  };
}

type ReplicateCollectionRule = {
  slug: string;
  capability: ModelCapability | ((model: ReplicateModel) => ModelCapability);
};

const IMAGE_INPUT_WORDS = /\b(image|img|photo|picture|multi-?view|mv)\b|i2v|img2/i;

/** Wan has text-to-video and image-to-video variants side by side; the name says which. */
function videoCapabilityByName(model: ReplicateModel): ModelCapability {
  return /i2v|image-to-video|img2vid/i.test(`${model.name} ${model.description ?? ""}`) ? "image-to-video" : "text-to-video";
}

/** Most 3D models take an image; only ones that say text (and not image) are text-to-3d. */
function threeDCapabilityByName(model: ReplicateModel): ModelCapability {
  const text = `${model.name} ${model.description ?? ""}`;
  if (/\btext\b|prompt/i.test(text) && !IMAGE_INPUT_WORDS.test(text)) return "text-to-3d";
  return "image-to-3d";
}

/**
 * Replicate's curated collections, and the capability each one stands for.
 * Paging /v1/models newest-first returns whatever was uploaded last (mostly
 * one-off user models) with capabilities guessed from keywords; the
 * collections are what Replicate recommends, with categories that are right.
 * A model in several collections gets every one's capability.
 */
export const REPLICATE_COLLECTIONS: ReplicateCollectionRule[] = [
  { slug: "text-to-image", capability: "text-to-image" },
  { slug: "flux", capability: "text-to-image" },
  { slug: "image-editing", capability: "image-to-image" },
  { slug: "super-resolution", capability: "image-to-image" },
  { slug: "ai-image-restoration", capability: "image-to-image" },
  { slug: "remove-backgrounds", capability: "image-to-image" },
  { slug: "control-net", capability: "image-to-image" },
  { slug: "sketch-to-image", capability: "image-to-image" },
  { slug: "face-swap", capability: "image-to-image" },
  { slug: "text-to-video", capability: "text-to-video" },
  { slug: "image-to-video", capability: "image-to-video" },
  { slug: "wan-video", capability: videoCapabilityByName },
  // Video processing takes a clip in; the Video node is where it belongs
  { slug: "video-editing", capability: "image-to-video" },
  { slug: "ai-enhance-videos", capability: "image-to-video" },
  { slug: "lipsync", capability: "audio-to-video" },
  { slug: "3d-models", capability: threeDCapabilityByName },
  { slug: "text-to-speech", capability: "text-to-audio" },
  { slug: "ai-music-generation", capability: "text-to-audio" },
];

/**
 * Replicate's list: every curated collection fetched at once, merged by
 * model, most-run first. A rejected key fails the whole fetch; one
 * collection that is missing or errors is skipped.
 */
async function fetchReplicateModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModel[]> {
  type CollectionResult = { rule: ReplicateCollectionRule; models: ReplicateModel[] } | { rule: ReplicateCollectionRule; status: number };
  const results = await Promise.all(
    REPLICATE_COLLECTIONS.map(async (rule): Promise<CollectionResult> => {
      const response = await fetch(`${REPLICATE_API_BASE}/collections/${rule.slug}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) return { rule, status: response.status };
      const data = (await response.json()) as { models?: ReplicateModel[] };
      return { rule, models: Array.isArray(data.models) ? data.models : [] };
    })
  );

  const byId = new Map<string, ProviderModel>();
  let fetched = 0;
  let lastStatus: number | null = null;
  for (const result of results) {
    if (!("models" in result)) {
      if (result.status === 401 || result.status === 403) throw new Error(`Replicate API error: ${result.status}`);
      lastStatus = result.status;
      continue;
    }
    fetched++;
    for (const model of result.models) {
      if (!model || typeof model.owner !== "string" || typeof model.name !== "string") continue;
      const capability = typeof result.rule.capability === "function" ? result.rule.capability(model) : result.rule.capability;
      const id = `${model.owner}/${model.name}`;
      const existing = byId.get(id);
      if (existing) {
        if (!existing.capabilities.includes(capability)) existing.capabilities.push(capability);
      } else {
        byId.set(id, { ...mapReplicateModel(model), capabilities: [capability] });
      }
    }
  }
  if (fetched === 0) throw new Error(`Replicate API error: ${lastStatus ?? "no collections"}`);
  return [...byId.values()].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
}

/**
 * Fetch a single Replicate model by its full "owner/name" id.
 *
 * The bulk listing in fetchReplicateModels only covers the first ~15 pages of
 * Replicate's catalogue, so most models (e.g. topazlabs/video-upscale) never
 * appear there. This direct lookup is the fallback used when a user searches by
 * an exact model id. Returns null on a malformed id or any non-OK response
 * (including 404) so a typo never fails the whole /api/models request. The id
 * goes into the URL path unencoded, so anything that is not a plain
 * `owner/name` is refused without a request.
 */
async function fetchReplicateModelById(
  apiKey: string,
  modelId: string,
  signal?: AbortSignal
): Promise<ProviderModel | null> {
  if (!isValidReplicateModelId(modelId)) {
    return null;
  }
  const [owner, name] = modelId.split("/");

  try {
    const response = await fetch(`${REPLICATE_API_BASE}/models/${owner}/${name}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const model: ReplicateModel = await response.json();
    return mapReplicateModel(model);
  } catch {
    return null;
  }
}

/**
 * Extract valid Replicate models from a search response. Handles both the
 * /v1/search shape ({ results: [{ model: {...} }] }) and a direct-model shape
 * ({ results: [{...model}] }), skipping non-model results (collections, docs).
 */
function extractReplicateSearchModels(data: unknown): ProviderModel[] {
  const results = (data as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];

  const models: ProviderModel[] = [];
  for (const result of results) {
    const candidate = ((result as { model?: unknown })?.model ?? result) as {
      owner?: unknown;
      name?: unknown;
    };
    if (candidate && typeof candidate.owner === "string" && typeof candidate.name === "string") {
      models.push(mapReplicateModel(candidate as ReplicateModel));
    }
  }
  return models;
}

/**
 * Search Replicate's full catalogue server-side for a text query.
 *
 * The bulk listing only covers the first ~15 pages, so a fragment search like
 * "topaz" can't find models outside that window. This hits Replicate's search
 * so any public model is discoverable by name. Tries the dedicated /v1/search
 * endpoint first, then falls back to QUERY /v1/models. Always returns an array
 * (never throws) so a flaky/again-unreliable search can only ADD results, never
 * break the request — list results and the by-id fallback still apply.
 */
async function searchReplicateModels(
  apiKey: string,
  query: string,
  signal?: AbortSignal
): Promise<ProviderModel[]> {
  // 1) GET /v1/search?query=... (searches models, collections, docs)
  try {
    const response = await fetch(
      `${REPLICATE_API_BASE}/search?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal }
    );
    if (response.ok) {
      const models = extractReplicateSearchModels(await response.json());
      if (models.length > 0) return models;
    }
  } catch {
    // fall through to the models search
  }

  // 2) QUERY /v1/models (dedicated model search; plain-text body)
  try {
    const response = await fetch(`${REPLICATE_API_BASE}/models`, {
      method: "QUERY",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "text/plain",
      },
      body: query,
      signal,
    });
    if (response.ok) {
      return extractReplicateSearchModels(await response.json());
    }
  } catch {
    // ignore — search is best-effort
  }

  return [];
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

// ============ WaveSpeed Types ============

interface WaveSpeedModel {
  // Model ID can be in different fields depending on API version
  model_id?: string;
  id?: string;
  modelId?: string;
  name?: string;
  display_name?: string;
  description?: string;
  category?: string;
  type?: string;
  thumbnail_url?: string;
  cover_image?: string;
  coverImage?: string;
  pricing?: {
    amount?: number;
    currency?: string;
  };
  // Dynamic schema from API (contains api_schemas[] with request_schema)
  api_schema?: WaveSpeedApiSchema;
}

interface WaveSpeedModelsResponse {
  models?: WaveSpeedModel[];
  data?: WaveSpeedModel[];
  results?: WaveSpeedModel[];
}

// ============ WaveSpeed Helpers ============

function inferWaveSpeedCapabilities(model: WaveSpeedModel): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  const modelId = model.model_id?.toLowerCase() || "";
  const name = (model.name || model.display_name || "").toLowerCase();
  const description = (model.description || "").toLowerCase();
  const category = (model.category || model.type || "").toLowerCase();
  const searchText = `${modelId} ${name} ${description} ${category}`;

  // Check for 3D-related keywords first
  const is3DModel =
    searchText.includes("3d") ||
    searchText.includes("mesh") ||
    searchText.includes("tripo") ||
    searchText.includes("hunyuan3d") ||
    category.includes("3d");

  if (is3DModel) {
    const hasImageInput =
      searchText.includes("image") ||
      searchText.includes("img") ||
      searchText.includes("photo");
    if (hasImageInput) {
      capabilities.push("image-to-3d");
    } else {
      capabilities.push("text-to-3d");
    }
    return capabilities;
  }

  // Check for audio-related keywords
  const isAudioModel =
    searchText.includes("music") ||
    searchText.includes("audio") ||
    searchText.includes("tts") ||
    searchText.includes("text-to-speech") ||
    searchText.includes("speech") ||
    searchText.includes("sound effect") ||
    searchText.includes("voice") ||
    category.includes("audio") ||
    category.includes("music") ||
    category.includes("speech");

  if (isAudioModel) {
    capabilities.push("text-to-audio");
    return capabilities;
  }

  // Check for video-related keywords
  const isVideoModel =
    searchText.includes("video") ||
    searchText.includes("animate") ||
    searchText.includes("motion") ||
    searchText.includes("wan") ||
    searchText.includes("kling") ||
    searchText.includes("luma") ||
    searchText.includes("minimax") ||
    searchText.includes("i2v") ||
    searchText.includes("t2v") ||
    category.includes("video");

  if (isVideoModel) {
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
    // Image model
    capabilities.push("text-to-image");

    // Check for image-to-image capability
    if (
      searchText.includes("img2img") ||
      searchText.includes("image-to-image") ||
      searchText.includes("inpaint") ||
      searchText.includes("controlnet") ||
      searchText.includes("upscale") ||
      searchText.includes("edit") ||
      searchText.includes("kontext")
    ) {
      capabilities.push("image-to-image");
    }
  }

  return capabilities.length > 0 ? capabilities : ["text-to-image"];
}

function mapWaveSpeedModel(model: WaveSpeedModel): ProviderModel {
  // Handle different field names for model ID
  const modelId = model.model_id || model.id || model.modelId || model.name || "unknown";
  const displayName = model.display_name || model.name || modelId;

  return {
    id: modelId,
    name: displayName,
    description: model.description || null,
    provider: "wavespeed",
    capabilities: inferWaveSpeedCapabilities(model),
    coverImage: cleanCoverUrl(model.thumbnail_url || model.cover_image || model.coverImage),
    pricing: model.pricing
      ? {
          type: "per-run",
          amount: model.pricing.amount || 0,
          currency: model.pricing.currency || "USD",
        }
      : undefined,
  };
}

async function fetchWaveSpeedModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModel[]> {
  const response = await fetch(`${WAVESPEED_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`WaveSpeed API error: ${response.status}`);
  }

  const data: WaveSpeedModelsResponse = await response.json();

  // Handle different response formats (models, data, or results array)
  const models = data.models || data.data || data.results || [];

  if (!Array.isArray(models)) {
    console.warn("[WaveSpeed] Unexpected response format:", data);
    return [];
  }

  // Log first model structure for debugging (including api_schema if present)
  if (models.length > 0) {
    const firstModel = models[0];
    console.log("[WaveSpeed] First model sample:", JSON.stringify(firstModel, null, 2).substring(0, 1000));
    console.log(`[WaveSpeed] Total models: ${models.length}`);
    console.log(`[WaveSpeed] First model has api_schema: ${!!firstModel.api_schema}`);
  }

  // Extract and cache schemas from models that have them
  const schemaMap = new Map<string, WaveSpeedApiSchema>();
  for (const model of models) {
    const modelId = model.model_id || model.id || model.modelId || model.name;
    if (modelId && model.api_schema) {
      schemaMap.set(modelId, model.api_schema);
    }
  }

  // Bulk cache all schemas
  if (schemaMap.size > 0) {
    console.log(`[WaveSpeed] Caching ${schemaMap.size} model schemas`);
    setCachedWaveSpeedSchemas(schemaMap);
  }

  return models.map(mapWaveSpeedModel);
}

// ============ Fal.ai Helpers ============

const FAL_AUDIO_CATEGORIES: Record<string, ModelCapability> = {
  "text-to-speech": "text-to-audio",
  "text-to-music": "text-to-audio",
  "text-to-sound-effects": "text-to-audio",
};

function mapFalCategory(category: string): ModelCapability | null {
  if (category in FAL_AUDIO_CATEGORIES) {
    return FAL_AUDIO_CATEGORIES[category];
  }
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
    coverImage: cleanCoverUrl(model.metadata.thumbnail_url),
  };
}

async function fetchFalModels(
  apiKey: string | null,
  searchQuery?: string,
  signal?: AbortSignal
): Promise<ProviderModel[]> {
  const allModels: ProviderModel[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  const headers: HeadersInit = {};
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
  }

  // Every page (about 16 of 100 at the time of writing); the cap is a guard
  let pageCount = 0;
  const maxPages = 60;

  while (hasMore && pageCount < maxPages) {
    let url = `${FAL_API_BASE}/models?status=active`;
    if (searchQuery) {
      url += `&q=${encodeURIComponent(searchQuery)}`;
    }
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    // The list pages through the same rate-limited API as the schemas: a
    // 429 holds every request to it for the delay it names, then the page
    // is asked for again, twice.
    await awaitFalCooldown(signal);
    let response = await fetch(url, { headers, signal });
    for (let retry = 0; response.status === 429 && retry < 2; retry++) {
      noteFalRateLimit(response);
      await awaitFalCooldown(signal);
      response = await fetch(url, { headers, signal });
    }

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

// ============ Fixed catalogs ============

/** Providers whose model list is fixed in this file (no discovery request). */
export const STATIC_CATALOG_PROVIDERS = ["gemini", "kie", "openai", "comfy"] as const;
export type StaticCatalogProvider = (typeof STATIC_CATALOG_PROVIDERS)[number];

/**
 * A fixed catalog as it stands, whether or not a key is set. `listModels`
 * leaves a provider out when it has no key; this lets a caller still say
 * which provider's key a model needs ("gpt-image-2.5-flare is an OpenAI
 * model: add the OpenAI key"). No request is made.
 */
export function staticCatalogModels(provider: StaticCatalogProvider): ProviderModel[] {
  switch (provider) {
    case "gemini":
      return [...GEMINI_IMAGE_MODELS, ...GEMINI_VIDEO_MODELS];
    case "kie":
      return [...KIE_MODELS];
    case "openai":
      return [...OPENAI_IMAGE_MODELS];
    case "comfy":
      return comfyRouterBoundModels();
  }
}

// ============ Deadlines ============

/** How long one fetched provider (all its pages and lookups) may take. */
export const PROVIDER_TIMEOUT_MS = 20_000;

// ============ Deep search ============

/** `extra` models not already in `base`, by id. */
function mergeModels(base: ProviderModel[], extra: ProviderModel[]): ProviderModel[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((m) => m.id.toLowerCase()));
  const merged = [...base];
  for (const model of extra) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

/**
 * The provider's own search, for models beyond the stored list: Replicate's
 * search plus an exact owner/name lookup, fal.ai's server-side search.
 * Best-effort under its own deadline; failures add nothing.
 */
async function deepSearch(provider: ProviderType, query: string, keys: ProviderKeys, timeoutMs: number): Promise<ProviderModel[]> {
  const deadline = startDeadline(timeoutMs);
  try {
    if (provider === "replicate" && keys.replicate) {
      const apiKey = keys.replicate;
      const [searched, byId] = await Promise.all([
        deadline.race(searchReplicateModels(apiKey, query, deadline.signal)).catch((): ProviderModel[] => []),
        query.includes("/")
          ? deadline.race(fetchReplicateModelById(apiKey, query, deadline.signal)).catch((): ProviderModel | null => null)
          : Promise.resolve(null),
      ]);
      return byId ? mergeModels(searched, [byId]) : searched;
    }
    if (provider === "fal") {
      return await deadline.race(fetchFalModels(keys.fal ?? null, query, deadline.signal)).catch((): ProviderModel[] => []);
    }
    return [];
  } finally {
    deadline.clear();
  }
}

// ============ Listing ============

export interface ProviderListResult {
  success: boolean;
  count: number;
  /** Served from the stored catalog (static catalogs count as stored). */
  cached?: boolean;
  /** When the provider's list was fetched; null before the first fetch. */
  fetchedAt?: number | null;
  /** The list is older than the catalog's freshness window. */
  stale?: boolean;
  /** A refresh is running in the background; ask again for the new list. */
  refreshing?: boolean;
  /** The provider failed (success false), or its last refresh did (success true, previous list served). */
  error?: string;
}

export interface ListModelsQuery {
  /** One provider only ("replicate" | "fal" | "gemini" | "wavespeed" | "kie" | "openai" | "comfy"). */
  provider?: ProviderType | string | null;
  /** Matched against name, description and id, in the stored lists. */
  search?: string | null;
  /** Keep models with at least one of these capabilities. */
  capabilities?: ModelCapability[] | null;
  /** Wait for a fresh fetch of every listed provider. */
  refresh?: boolean;
  /**
   * With `search`: also ask Replicate's search (and an exact owner/name
   * lookup) and fal.ai's server-side search, for models beyond the stored
   * lists. A network round trip per provider, so callers use it on request.
   */
  deep?: boolean;
}

export interface ListModelsOptions {
  /** Per fetched provider; defaults to PROVIDER_TIMEOUT_MS. */
  providerTimeoutMs?: number;
}

export interface ListModelsSuccess {
  ok: true;
  /** Sorted by provider, then popularity where known, then name. */
  models: ProviderModel[];
  providers: Record<string, ProviderListResult>;
  /** Every provider with a key (Gemini is always listed). */
  availableProviders: string[];
  /** "provider: message" for each fetched provider that failed. */
  errors?: string[];
  /** True when nothing was fetched fresh. */
  cached: boolean;
}

export interface ListModelsFailure {
  ok: false;
  error: string;
  /** The HTTP status GET /api/models answers with. */
  status: number;
}

export type ListModelsResult = ListModelsSuccess | ListModelsFailure;

/**
 * List models across providers, as GET /api/models does.
 *
 * Without `query.provider`, every provider with a key is included (Gemini
 * always). A provider that fails or times out is reported in `providers` and
 * `errors` without failing the listing; `ok: false` means the request itself
 * was unusable (status 400: no key for the requested provider, or no
 * provider at all) or nothing came back and every fetched provider failed
 * (status 500).
 */
export async function listModels(
  query: ListModelsQuery,
  keys: ProviderKeys,
  options: ListModelsOptions = {}
): Promise<ListModelsResult> {
  const providerFilter = (query.provider || null) as ProviderType | null;
  const searchQuery = query.search || undefined;
  const refresh = query.refresh === true;
  const deep = query.deep === true;
  const capabilitiesFilter = query.capabilities ?? null;
  const providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;

  const replicateKey = keys.replicate || null;
  const falKey = keys.fal || null;
  const kieKey = keys.kie || null;
  const wavespeedKey = keys.wavespeed || null;
  const openaiKey = keys.openai || null;
  const comfyKey = keys.comfy || null;

  // Build list of all available providers (have keys from env or client headers)
  const availableProviders: string[] = ["gemini"]; // Gemini always available
  if (falKey) availableProviders.push("fal");
  if (replicateKey) availableProviders.push("replicate");
  if (kieKey) availableProviders.push("kie");
  if (wavespeedKey) availableProviders.push("wavespeed");
  if (openaiKey) availableProviders.push("openai");
  if (comfyKey) availableProviders.push("comfy");

  // Determine which providers to fetch from (gemini/kie/openai/comfy handled separately as hardcoded)
  const providersToFetch: ProviderType[] = [];
  let includeGemini = false;
  let includeKie = false;
  let includeOpenai = false;
  let includeComfy = false;

  if (providerFilter) {
    if (providerFilter === "gemini") {
      // Only Gemini requested - no external API calls needed
      includeGemini = true;
    } else if (providerFilter === "kie") {
      // Only Kie requested - no external API calls needed (hardcoded models)
      if (kieKey) {
        includeKie = true;
      } else {
        return {
          ok: false,
          error: "Kie API key required. Add KIE_API_KEY to .env.local or configure in Settings.",
          status: 400,
        };
      }
    } else if (providerFilter === "wavespeed") {
      if (wavespeedKey) {
        // WaveSpeed requested with key - fetch from API
        providersToFetch.push("wavespeed");
      } else {
        // WaveSpeed requested but no key configured
        return {
          ok: false,
          error:
            "WaveSpeed API key required. Add WAVESPEED_API_KEY to .env.local or configure in Settings.",
          status: 400,
        };
      }
    } else if (providerFilter === "openai") {
      // Only OpenAI requested - no external API calls needed (hardcoded models)
      if (openaiKey) {
        includeOpenai = true;
      } else {
        return {
          ok: false,
          error: "OpenAI API key required. Add OPENAI_API_KEY to .env.local or configure in Settings.",
          status: 400,
        };
      }
    } else if (providerFilter === "comfy") {
      // Only Comfy Router requested - the bound models the Router serves
      if (comfyKey) {
        includeComfy = true;
      } else {
        return {
          ok: false,
          error: "Comfy API key required. Add COMFY_API_KEY to .env.local or configure in Settings.",
          status: 400,
        };
      }
    } else if (providerFilter === "replicate" && replicateKey) {
      providersToFetch.push("replicate");
    } else if (providerFilter === "fal" && falKey) {
      providersToFetch.push("fal");
    }
  } else {
    // Include all providers that have keys configured
    includeGemini = true; // Gemini always available
    includeKie = kieKey ? true : false; // Kie only if API key is configured
    includeOpenai = openaiKey ? true : false; // OpenAI only if API key is configured
    includeComfy = comfyKey ? true : false; // Comfy Router only if API key is configured
    if (wavespeedKey) {
      providersToFetch.push("wavespeed"); // WaveSpeed if key is configured
    }
    if (replicateKey) {
      providersToFetch.push("replicate");
    }
    if (falKey) {
      providersToFetch.push("fal");
    }
  }

  // Gemini/Kie/OpenAI/Comfy are handled as hardcoded, so we don't fail if no external providers
  if (providersToFetch.length === 0 && !includeGemini && !includeKie && !includeOpenai && !includeComfy) {
    return {
      ok: false,
      error:
        "No providers available. Add REPLICATE_API_KEY, FAL_API_KEY, KIE_API_KEY, WAVESPEED_API_KEY, OPENAI_API_KEY, or COMFY_API_KEY to .env.local or configure in Settings.",
      status: 400,
    };
  }

  const allModels: ProviderModel[] = [];
  const providerResults: Record<string, ProviderListResult> = {};
  const errors: string[] = [];
  let anyFromCache = false;
  let allFromCache = true;

  // Add Gemini models first if included (they appear at the top)
  if (includeGemini) {
    // Filter by search query if provided
    let geminiModels = [...GEMINI_IMAGE_MODELS, ...GEMINI_VIDEO_MODELS];
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

  // Add Kie models if included (hardcoded, no API call needed)
  if (includeKie) {
    // Filter by search query if provided
    let kieModels = KIE_MODELS;
    if (searchQuery) {
      kieModels = filterModelsBySearch(kieModels, searchQuery);
    }
    allModels.push(...kieModels);
    providerResults["kie"] = {
      success: true,
      count: kieModels.length,
      cached: true, // Hardcoded models are effectively "cached"
    };
    anyFromCache = true;
  }

  // Add OpenAI models if included (hardcoded, no API call needed)
  if (includeOpenai) {
    // Filter by search query if provided
    let openaiModels = OPENAI_IMAGE_MODELS;
    if (searchQuery) {
      openaiModels = filterModelsBySearch(openaiModels, searchQuery);
    }
    allModels.push(...openaiModels);
    providerResults["openai"] = {
      success: true,
      count: openaiModels.length,
      cached: true, // Hardcoded models are effectively "cached"
    };
    anyFromCache = true;
  }

  // Add Comfy Router models if included: every bound model the Router serves (list cached ten minutes)
  if (includeComfy) {
    // Filter by search query if provided
    let comfyModels = await comfyRouterProviderModels(comfyKey);
    if (searchQuery) {
      comfyModels = filterModelsBySearch(comfyModels, searchQuery);
    }
    allModels.push(...comfyModels);
    providerResults["comfy"] = {
      success: true,
      count: comfyModels.length,
      cached: true, // Hardcoded models are effectively "cached"
    };
    anyFromCache = true;
  }

  // Every fetched provider at once, from the catalog, each under its own deadline.
  const fetched = await Promise.all(
    providersToFetch.map(async (provider) => {
      const fetcher: CatalogFetcher =
        provider === "replicate"
          ? (signal) => fetchReplicateModels(replicateKey!, signal)
          : provider === "fal"
            ? (signal) => fetchFalModels(falKey, undefined, signal)
            : (signal) => fetchWaveSpeedModels(wavespeedKey!, signal);
      try {
        const catalog = await getProviderCatalog(provider, fetcher, { refresh, timeoutMs: providerTimeoutMs });
        let models = searchQuery ? filterModelsBySearch(catalog.models, searchQuery) : catalog.models;
        if (deep && searchQuery) {
          models = mergeModels(models, await deepSearch(provider, searchQuery, keys, providerTimeoutMs));
        }
        return { provider, catalog, models };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[Models] ${provider}: ${message}`);
        return { provider, error: message };
      }
    })
  );

  let failed = 0;
  for (const item of fetched) {
    if ("error" in item) {
      failed++;
      errors.push(`${item.provider}: ${item.error}`);
      providerResults[item.provider] = { success: false, count: 0, error: item.error };
      continue;
    }
    const { provider, catalog, models } = item;
    if (catalog.cached) anyFromCache = true;
    else allFromCache = false;
    allModels.push(...models);
    providerResults[provider] = {
      success: true,
      count: models.length,
      cached: catalog.cached,
      fetchedAt: catalog.fetchedAt,
      stale: catalog.stale,
      refreshing: catalog.refreshing,
      ...(catalog.error ? { error: catalog.error } : {}),
    };
  }

  // Check if we got any models
  // Only a failure when something was fetched and every fetch failed: a search
  // that simply matches nothing (e.g. only static providers) is an empty list.
  if (allModels.length === 0 && providersToFetch.length > 0 && failed === providersToFetch.length) {
    // All providers failed
    return {
      ok: false,
      error: `All providers failed: ${errors.join("; ")}`,
      status: 500,
    };
  }

  // Filter by capabilities if specified
  let filteredModels = allModels;
  if (capabilitiesFilter && capabilitiesFilter.length > 0) {
    filteredModels = allModels.filter((model) =>
      model.capabilities.some((cap) => capabilitiesFilter.includes(cap))
    );
  }

  // By provider, then most run first where the provider says, then by name
  filteredModels.sort((a, b) => {
    if (a.provider !== b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    const popularity = (b.popularity ?? -1) - (a.popularity ?? -1);
    if (popularity !== 0) return popularity;
    return a.name.localeCompare(b.name);
  });

  const result: ListModelsSuccess = {
    ok: true,
    models: filteredModels,
    providers: providerResults,
    availableProviders,
    cached: anyFromCache && allFromCache,
  };

  if (errors.length > 0) {
    result.errors = errors;
  }

  return result;
}
