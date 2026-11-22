/**
 * What Magnific's API description cannot say, by hand.
 *
 * Everything else about a model (its route, handles, settings) is read from
 * spec.json by bindings.ts. This file holds the judgment: which endpoints
 * the app leaves out and why, names the summaries get wrong, and settings
 * that are sent fixed or not shown.
 */
import type { ParamOverride } from "../comfyRouter/schema";

export type MagnificOutput = "image" | "video" | "audio";

/**
 * What each group of endpoints (the first path segment) produces. A group
 * that is not here and not excluded below is one the app has not met:
 * `magnificUnplaced()` lists it and the suite fails until it is placed.
 */
export const GROUP_OUTPUT: Record<string, MagnificOutput> = {
  "text-to-image": "image",
  mystic: "image",
  "magnific-one": "image",
  "gemini-2-5-flash-image-preview": "image",
  "ideogram-image-edit": "image",
  "image-change-camera": "image",
  "image-expand": "image",
  "image-relight": "image",
  "image-style-transfer": "image",
  "image-upscaler": "image",
  "image-upscaler-precision": "image",
  "image-upscaler-precision-v2": "image",
  "skin-enhancer": "image",
  "image-to-video": "video",
  "text-to-video": "video",
  "reference-to-video": "video",
  video: "video",
  "video-edit": "video",
  "video-upscaler": "video",
  "video-upscaler-precision": "video",
  "video-upscaler-topaz": "video",
  "lip-sync": "video",
  "music-generation": "audio",
  "sound-effects": "audio",
  voiceover: "audio",
};

/** Endpoints the app does not offer, with the reason. Keyed by endpoint id (the path after /v1/ai/). */
export const EXCLUDED: Record<string, string> = {
  "audio-isolation": "Takes an audio or video file and a description of the sound to pull out; the audio node has no media handle.",
  "beta/remove-background": "Answers in one request from a form-encoded body, not as a task.",
  "beta/text-to-image/reimagine-flux": "Beta endpoint that answers in one request, not as a task.",
  "classifier/image": "Returns a classification, not media.",
  "flows/{flow-id}/run": "Runs a flow saved in the user's Magnific account, not a model.",
  "image-to-prompt": "Returns text, not media.",
  "improve-prompt": "Returns text, not media.",
  "loras/characters": "Trains a LoRA; it produces no media.",
  "loras/styles": "Trains a LoRA; it produces no media.",
  "text-to-icon": "Two-step: the icon is rendered by a second request once the task is done.",
  "text-to-icon/preview": "Two-step: the icon is rendered by a second request once the task is done.",
  "text-to-icon/{task-id}/render/{format}": "The second step of icon generation.",
  "text-to-image": "The classic model answers in one request with inline images, not as a task.",
  "uploads/request-url": "The app's own upload step, not a model.",
  "video/kling-advanced-custom-elements": "Creates a reusable element, not a video.",
};

/** Names where the summary names the wrong thing, or two endpoints the same. */
export const NAMES: Record<string, string> = {
  "text-to-image/gpt-image-2-5": "GPT Image 2.5",
  "text-to-image/gpt-image-2-edit": "GPT Image 2 Edit",
  "text-to-image/gpt-image-2-5-edit": "GPT Image 2.5 Edit",
  "text-to-image/flux-kontext-pro": "Flux Kontext Pro",
  "text-to-image/flux-kontext-max": "Flux Kontext Max",
  "text-to-image/runway": "RunWay Gen-4 Image",
  "voiceover/elevenlabs-turbo-v2-5": "ElevenLabs Turbo v2.5 Voiceover",
  "voiceover/elevenlabs-v3": "ElevenLabs v3 Voiceover",
  "voiceover/elevenlabs-v4": "ElevenLabs v4 Voiceover",
  "image-upscaler": "Magnific Upscaler Creative",
  "image-upscaler-precision": "Magnific Upscaler Precision",
  "image-upscaler-precision-v2": "Magnific Upscaler Precision V2",
  "video-upscaler": "Magnific Video Upscaler",
  "video-upscaler/turbo": "Magnific Video Upscaler Turbo",
  "video-upscaler-precision": "Magnific Video Upscaler Precision",
  "video-upscaler-topaz": "Topaz Video Upscaler",
  "image-relight": "Magnific Relight",
  "image-style-transfer": "Magnific Style Transfer",
  "image-change-camera": "Magnific Change Camera",
  "gemini-2-5-flash-image-preview": "Nano Banana (Gemini 2.5 Flash Image)",
  "sound-effects": "Sound Effects",
  "video/vfx": "Magnific Video VFX",
};

/**
 * Settings never shown or sent. `webhook_url` is for servers that can be
 * called back. A task's first output is the one the node keeps, so asking
 * for more images would be paid for and dropped. A private result URL
 * could not be downloaded by the app.
 */
export const HIDDEN_PARAMS = ["webhook_url", "num_images", "return_private_url"];

/** Per endpoint, a setting narrowed or fixed where the schema is looser than the app wants. */
export const PARAM_OVERRIDES: Record<string, Record<string, ParamOverride>> = {};
