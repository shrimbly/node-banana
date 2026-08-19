/**
 * Unified Models API Endpoint
 *
 * Aggregates models from all configured providers (Replicate, fal.ai, Gemini, Kie.ai, WaveSpeed, metaso).
 * Uses in-memory caching to reduce external API calls.
 *
 * GET /api/models
 *
 * Query params:
 *   - provider: Optional, filter to a specific provider
 *   - search: Optional, search query
 *   - refresh: Optional, bypass cache if "true"
 *   - capabilities: Optional, filter by capabilities (comma-separated)
 *
 * Headers:
 *   - X-Replicate-Key: Replicate API key
 *   - X-Fal-Key: fal.ai API key (optional, works without but rate limited)
 *   - X-WaveSpeed-Key: WaveSpeed API key
 *   - X-Metaso-API-Key: metaso API key
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
  setCachedWaveSpeedSchemas,
  WaveSpeedApiSchema,
} from "@/lib/providers/cache";

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

// metaso models (hardcoded - the H3 V2 endpoint has no model discovery route)
const METASO_MODELS: ProviderModel[] = [
  {
    id: "MiniMax-H3",
    name: "MiniMax H3",
    description: "MiniMax-H3 V2 video generation through metaso. Supports text, first/last frames, and reference image, video, or audio inputs.",
    provider: "metaso",
    capabilities: ["text-to-video", "image-to-video", "audio-to-video"],
    coverImage: "/providers/metaso.ico",
    pricingDescription: "768P ¥0.09/output s · 2K ¥0.15/output s · first 5 images free, then ¥0.05/image · audio free · reference video uses the same output-second rate",
    pageUrl: "https://metaso.cn/",
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
  /** All providers that have API keys configured (env or client header) */
  availableProviders: string[];
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
 * Fetch a single Replicate model by its full "owner/name" id.
 *
 * The bulk listing in fetchReplicateModels only covers the first ~15 pages of
 * Replicate's catalogue, so most models (e.g. topazlabs/video-upscale) never
 * appear there. This direct lookup is the fallback used when a user searches by
 * an exact model id. Returns null on a malformed id or any non-OK response
 * (including 404) so a typo never fails the whole /api/models request.
 */
async function fetchReplicateModelById(
  apiKey: string,
  modelId: string
): Promise<ProviderModel | null> {
  const parts = modelId.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [owner, name] = parts;

  try {
    const response = await fetch(`${REPLICATE_API_BASE}/models/${owner}/${name}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
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
async function searchReplicateModels(apiKey: string, query: string): Promise<ProviderModel[]> {
  // 1) GET /v1/search?query=... (searches models, collections, docs)
  try {
    const response = await fetch(
      `${REPLICATE_API_BASE}/search?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
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
    coverImage: model.thumbnail_url || model.cover_image || model.coverImage,
    pricing: model.pricing
      ? {
          type: "per-run",
          amount: model.pricing.amount || 0,
          currency: model.pricing.currency || "USD",
        }
      : undefined,
  };
}

async function fetchWaveSpeedModels(apiKey: string): Promise<ProviderModel[]> {
  const response = await fetch(`${WAVESPEED_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
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
  const kieKey = request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY || null;
  const wavespeedKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY || null;
  const openaiKey = request.headers.get("X-OpenAI-API-Key") || process.env.OPENAI_API_KEY || null;
  const metasoKey = request.headers.get("X-Metaso-API-Key") || process.env.METASO_API_KEY || null;

  // Build list of all available providers (have keys from env or client headers)
  const availableProviders: string[] = ["gemini"]; // Gemini always available
  if (falKey) availableProviders.push("fal");
  if (replicateKey) availableProviders.push("replicate");
  if (kieKey) availableProviders.push("kie");
  if (wavespeedKey) availableProviders.push("wavespeed");
  if (openaiKey) availableProviders.push("openai");
  if (metasoKey) availableProviders.push("metaso");

  // Determine which providers to fetch from (gemini/kie/openai handled separately as hardcoded)
  const providersToFetch: ProviderType[] = [];
  let includeGemini = false;
  let includeKie = false;
  let includeOpenai = false;
  let includeMetaso = false;

  if (providerFilter) {
    if (providerFilter === "gemini") {
      // Only Gemini requested - no external API calls needed
      includeGemini = true;
    } else if (providerFilter === "kie") {
      // Only Kie requested - no external API calls needed (hardcoded models)
      if (kieKey) {
        includeKie = true;
      } else {
        return NextResponse.json<ModelsErrorResponse>(
          {
            success: false,
            error: "Kie API key required. Add KIE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 400 }
        );
      }
    } else if (providerFilter === "wavespeed") {
      if (wavespeedKey) {
        // WaveSpeed requested with key - fetch from API
        providersToFetch.push("wavespeed");
      } else {
        // WaveSpeed requested but no key configured
        return NextResponse.json<ModelsErrorResponse>(
          {
            success: false,
            error:
              "WaveSpeed API key required. Add WAVESPEED_API_KEY to .env.local or configure in Settings.",
          },
          { status: 400 }
        );
      }
    } else if (providerFilter === "openai") {
      // Only OpenAI requested - no external API calls needed (hardcoded models)
      if (openaiKey) {
        includeOpenai = true;
      } else {
        return NextResponse.json<ModelsErrorResponse>(
          {
            success: false,
            error: "OpenAI API key required. Add OPENAI_API_KEY to .env.local or configure in Settings.",
          },
          { status: 400 }
        );
      }
    } else if (providerFilter === "metaso") {
      if (metasoKey) {
        includeMetaso = true;
      } else {
        return NextResponse.json<ModelsErrorResponse>(
          {
            success: false,
            error: "metaso API key required. Add METASO_API_KEY to .env.local or configure in Settings.",
          },
          { status: 400 }
        );
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
    includeMetaso = metasoKey ? true : false; // metaso only if API key is configured
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

  // Gemini/Kie/OpenAI are handled as hardcoded, so we don't fail if no external providers
  if (providersToFetch.length === 0 && !includeGemini && !includeKie && !includeOpenai && !includeMetaso) {
    return NextResponse.json<ModelsErrorResponse>(
      {
        success: false,
        error:
          "No providers available. Add REPLICATE_API_KEY, FAL_API_KEY, KIE_API_KEY, WAVESPEED_API_KEY, OPENAI_API_KEY, or METASO_API_KEY to .env.local or configure in Settings.",
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

  // Add metaso models if included (hardcoded, no discovery API call needed)
  if (includeMetaso) {
    let metasoModels = METASO_MODELS;
    if (searchQuery) {
      metasoModels = filterModelsBySearch(metasoModels, searchQuery);
    }
    allModels.push(...metasoModels);
    providerResults["metaso"] = {
      success: true,
      count: metasoModels.length,
      cached: true,
    };
    anyFromCache = true;
  }

  // Fetch from each provider (replicate, fal, wavespeed)
  for (const provider of providersToFetch) {
    // For Replicate and WaveSpeed, always use base cache key since we filter client-side
    // For fal.ai, include search in cache key since their API supports search
    const cacheKey =
      provider === "replicate" || provider === "wavespeed"
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

        // For Replicate and WaveSpeed, apply client-side search filtering on cached models
        if ((provider === "replicate" || provider === "wavespeed") && searchQuery) {
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
        } else if (provider === "wavespeed") {
          // Fetch all models from WaveSpeed API
          const allWaveSpeedModels = await fetchWaveSpeedModels(wavespeedKey!);
          // Cache the full list
          setCachedModels(cacheKey, allWaveSpeedModels);
          // Apply search filter if needed (client-side filtering like Replicate)
          models = searchQuery
            ? filterModelsBySearch(allWaveSpeedModels, searchQuery)
            : allWaveSpeedModels;
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

    // Replicate search: the cached catalogue only covers ~15 pages, so a
    // fragment search (e.g. "topaz") can't find models outside that window.
    // Always run the comprehensive search for a query so models beyond the
    // cached pages are discoverable even when the local list already has a few
    // matches; results are cached per query so repeat searches stay fast.
    if (provider === "replicate" && searchQuery) {
      const searchCacheKey = getCacheKey(provider, searchQuery);
      let searchModels = refresh ? null : getCachedModels(searchCacheKey);
      if (!searchModels) {
        searchModels = await searchReplicateModels(replicateKey!, searchQuery);
        setCachedModels(searchCacheKey, searchModels);
      }
      if (searchModels.length > 0) {
        const seen = new Set(models.map((m) => m.id.toLowerCase()));
        const fresh: ProviderModel[] = [];
        for (const m of searchModels) {
          const key = m.id.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            fresh.push(m);
          }
        }
        if (fresh.length > 0) {
          models = [...models, ...fresh];
        }
      }
    }

    // Replicate fallback: if the user searched by an exact "owner/name" id that
    // isn't in the paginated catalogue, resolve it directly so any public model
    // is reachable (O(1) lookup rather than unbounded extra pagination).
    if (
      provider === "replicate" &&
      searchQuery &&
      searchQuery.includes("/") &&
      !models.some((m) => m.id.toLowerCase() === searchQuery.toLowerCase())
    ) {
      const byId = await fetchReplicateModelById(replicateKey!, searchQuery);
      if (byId) {
        models = [...models, byId];
        // Warm the cached full list so repeat searches resolve without a refetch.
        const cachedFull = getCachedModels(cacheKey);
        if (
          cachedFull &&
          !cachedFull.some((m) => m.id.toLowerCase() === byId.id.toLowerCase())
        ) {
          setCachedModels(cacheKey, [...cachedFull, byId]);
        }
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
    availableProviders,
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  return NextResponse.json<ModelsSuccessResponse>(response);
}
