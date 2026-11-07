/**
 * Model Types
 *
 * Types for image generation model configuration including
 * aspect ratios, resolutions, and model identifiers.
 */

// Aspect Ratios (all models support the base 10; Nano Banana 2 and 2.1 add 1:4, 1:8, 4:1, 8:1)
export type AspectRatio =
  | "1:1"
  | "1:4"
  | "1:8"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:1"
  | "4:3"
  | "4:5"
  | "5:4"
  | "8:1"
  | "9:16"
  | "16:9"
  | "21:9";

// Resolution Options (supported by Nano Banana Pro, Nano Banana 2 and 2.1)
export type Resolution = "512" | "1K" | "2K" | "4K";

// Image Generation Model Options
export type ModelType = "nano-banana" | "nano-banana-pro" | "nano-banana-2" | "nano-banana-2.1" | "nano-banana-2-lite";

// Display names for image generation models
export const MODEL_DISPLAY_NAMES: Record<ModelType, string> = {
  "nano-banana": "Nano Banana",
  "nano-banana-pro": "Nano Banana Pro",
  "nano-banana-2": "Nano Banana 2",
  "nano-banana-2.1": "Nano Banana 2.1",
  "nano-banana-2-lite": "Nano Banana 2 Lite",
};

export const GEMINI_IMAGE_MODELS: ReadonlyArray<{ value: ModelType; label: string }> = [
  { value: "nano-banana", label: MODEL_DISPLAY_NAMES["nano-banana"] },
  { value: "nano-banana-2", label: MODEL_DISPLAY_NAMES["nano-banana-2"] },
  { value: "nano-banana-2.1", label: MODEL_DISPLAY_NAMES["nano-banana-2.1"] },
  { value: "nano-banana-2-lite", label: MODEL_DISPLAY_NAMES["nano-banana-2-lite"] },
  { value: "nano-banana-pro", label: MODEL_DISPLAY_NAMES["nano-banana-pro"] },
];

export const BASE_ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const EXTENDED_ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

export interface GeminiImageOptions {
  aspectRatios: readonly AspectRatio[];
  /** Empty: the model has no resolution setting (it makes 1K). */
  resolutions: readonly Resolution[];
  googleSearch: boolean;
  imageSearch: boolean;
}

/**
 * The settings each Gemini image model takes. The node, the split-grid
 * editor, the Gemini provider, its parameter schema and the agent all read
 * this, so a new model is one entry here.
 */
export const GEMINI_IMAGE_OPTIONS: Record<ModelType, GeminiImageOptions> = {
  "nano-banana": { aspectRatios: BASE_ASPECT_RATIOS, resolutions: [], googleSearch: false, imageSearch: false },
  "nano-banana-2": { aspectRatios: EXTENDED_ASPECT_RATIOS, resolutions: ["512", "1K", "2K", "4K"], googleSearch: true, imageSearch: true },
  "nano-banana-2.1": { aspectRatios: EXTENDED_ASPECT_RATIOS, resolutions: ["1K", "2K", "4K"], googleSearch: true, imageSearch: true },
  "nano-banana-2-lite": { aspectRatios: BASE_ASPECT_RATIOS, resolutions: [], googleSearch: false, imageSearch: false },
  "nano-banana-pro": { aspectRatios: BASE_ASPECT_RATIOS, resolutions: ["1K", "2K", "4K"], googleSearch: true, imageSearch: false },
};

/** A Gemini image model's settings; an id this build does not know gets plain Nano Banana's. */
export function geminiImageOptions(model: string | null | undefined): GeminiImageOptions {
  return model && Object.prototype.hasOwnProperty.call(GEMINI_IMAGE_OPTIONS, model) ? GEMINI_IMAGE_OPTIONS[model as ModelType] : GEMINI_IMAGE_OPTIONS["nano-banana"];
}
