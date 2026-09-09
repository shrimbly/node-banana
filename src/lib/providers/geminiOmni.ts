import type { ModelInput, ModelParameter, ProviderModel } from "./types";

// Google model IDs and REST contract: https://ai.google.dev/gemini-api/docs/omni
export const GEMINI_OMNI_MODELS: ProviderModel[] = [
  { id: "gemini-omni-1.1-flash", name: "Gemini Omni 1.1 Flash" },
  { id: "gemini-omni-flash-preview", name: "Gemini Omni Flash Preview" },
].map((model) => ({
  ...model,
  provider: "gemini",
  description: "Generate or edit video with text, images, video and audio. Describe motion, sound and duration (3–10 seconds) in the prompt. Video inputs for editing or extension must be 10 seconds or shorter.",
  capabilities: ["text-to-video", "image-to-video", "audio-to-video"],
  pageUrl: "https://ai.google.dev/gemini-api/docs/omni",
}));

export function isGeminiOmni(modelId: string | undefined): boolean {
  return GEMINI_OMNI_MODELS.some((model) => model.id === modelId);
}

export const GEMINI_OMNI_PARAMETERS: ModelParameter[] = [
  { name: "aspectRatio", type: "string", enum: ["16:9", "9:16"], default: "16:9", description: "Output aspect ratio" },
  { name: "resolution", type: "string", enum: ["360p", "720p", "1080p", "4k"], default: "720p", description: "Output resolution; 1080p and 4K are upscaled" },
  { name: "task", type: "string", enum: ["auto", "text_to_video", "image_to_video", "reference_to_video", "edit", "extend"], default: "auto", description: "Auto infers the task from your prompt. Choose a task only when you need explicit control." },
];

export const GEMINI_OMNI_INPUTS: ModelInput[] = [
  { name: "prompt", type: "text", required: true, label: "Prompt", description: "Describe the scene, changes, audio and desired duration (3–10 seconds)" },
  { name: "image", type: "image", required: false, label: "Reference images", isArray: true },
  { name: "video", type: "video", required: false, label: "Video", description: "Video to edit or extend, up to 10 seconds" },
  { name: "audio", type: "audio", required: false, label: "Audio" },
];
