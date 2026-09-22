/**
 * Comfy Router catalog.
 *
 * Comfy Router (https://api.comfy.org/v2/models/{provider}/{model}) fronts
 * two hundred partner models behind one key, but its catalog endpoint lists
 * only ids and each model keeps its partner's native request and response
 * shape. So the app carries its own list: which models to offer, what to
 * call them, which parameters to expose, and which *family* they belong to.
 * The family is what the server module keys on to build the request body
 * and read the result back (src/app/api/generate/providers/comfy.ts).
 *
 * Model ids are the Router's own, `{provider}/{model}`, so the schema route
 * receives them URL-encoded and the page link resolves on docs.comfy.org.
 */
import type { ModelCapability, ModelInput, ModelParameter, ProviderModel } from "./types";

export const COMFY_ROUTER_BASE_URL = "https://api.comfy.org";
export const COMFY_ROUTER_KEYS_URL = "https://platform.comfy.org/profile/api-keys?onboarding=router";
export const COMFY_ROUTER_MODELS_URL = "https://docs.comfy.org/development/comfy-router/models";

/** One request builder and one result reader per family. */
export type ComfyRouterFamily =
  | "flux2"
  | "fluxKontext"
  | "flux11"
  | "flux11Ultra"
  | "gptImage"
  | "geminiImage"
  | "seedream"
  | "grokImage"
  | "ideogramV4"
  | "recraft"
  | "qwenImage"
  | "klingImage"
  | "seedance"
  | "klingText"
  | "klingOmni"
  | "kling3Turbo"
  | "veo"
  | "grokVideo"
  | "runwayGen4"
  | "ltx"
  | "minimax"
  | "wanVideo"
  | "lumaRay";

export interface ComfyRouterModel {
  /** Router id, `{provider}/{model}`. */
  id: string;
  name: string;
  description: string;
  family: ComfyRouterFamily;
  capabilities: ModelCapability[];
  parameters: ModelParameter[];
  inputs: ModelInput[];
}

const PROMPT: ModelInput = { name: "prompt", type: "text", required: true, label: "Prompt" };
const IMAGES: ModelInput = { name: "image", type: "image", required: false, label: "Image", isArray: true };
const FIRST_FRAME: ModelInput = { name: "image", type: "image", required: false, label: "First frame" };
const LAST_FRAME: ModelInput = { name: "last_frame", type: "image", required: false, label: "Last frame" };

const seed = (min = 0): ModelParameter => ({ name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: min });

const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"];

// ------------------------------------------------------------------ image

const flux2: Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> = {
  family: "flux2",
  capabilities: ["text-to-image", "image-to-image"],
  parameters: [
    { name: "width", type: "integer", description: "Output width in pixels", default: 1024, minimum: 256, maximum: 2048 },
    { name: "height", type: "integer", description: "Output height in pixels", default: 1024, minimum: 256, maximum: 2048 },
    { name: "output_format", type: "string", description: "Output image format", enum: ["jpeg", "png"], default: "jpeg" },
    { name: "prompt_upsampling", type: "boolean", description: "Let the model expand the prompt", default: true },
    { name: "safety_tolerance", type: "integer", description: "Moderation tolerance, 0 strict to 5 permissive", default: 2, minimum: 0, maximum: 5 },
    seed(),
  ],
  inputs: [PROMPT, { ...IMAGES, label: "Reference images", description: "Up to 9 images" }],
};

const fluxKontext: Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> = {
  family: "fluxKontext",
  capabilities: ["text-to-image", "image-to-image"],
  parameters: [
    { name: "aspect_ratio", type: "string", description: "Output aspect ratio; defaults to the input image's", enum: IMAGE_ASPECTS },
    { name: "output_format", type: "string", description: "Output image format", enum: ["png", "jpeg", "webp"], default: "png" },
    { name: "prompt_upsampling", type: "boolean", description: "Let the model expand the prompt", default: false },
    { name: "safety_tolerance", type: "integer", description: "Moderation tolerance, 0 strict to 6 permissive", default: 2, minimum: 0, maximum: 6 },
    seed(),
  ],
  inputs: [PROMPT, { ...IMAGES, label: "Image to edit", description: "Up to 4 images" }],
};

const gptImage: Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> = {
  family: "gptImage",
  capabilities: ["text-to-image", "image-to-image"],
  parameters: [
    { name: "size", type: "string", description: "Output size", enum: ["auto", "1024x1024", "1536x1024", "1024x1536"], default: "auto" },
    { name: "quality", type: "string", description: "Rendering quality", enum: ["low", "medium", "high"], default: "medium" },
    { name: "background", type: "string", description: "Background transparency", enum: ["opaque", "transparent"], default: "opaque" },
    { name: "output_format", type: "string", description: "Output image format", enum: ["png", "webp", "jpeg"], default: "png" },
  ],
  inputs: [PROMPT, { ...IMAGES, label: "Images to edit" }],
};

const geminiImage = (sizes: string[]): Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> => ({
  family: "geminiImage",
  capabilities: ["text-to-image", "image-to-image"],
  parameters: [
    { name: "aspectRatio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], default: "1:1" },
    ...(sizes.length > 1 ? [{ name: "imageSize", type: "string" as const, description: "Output resolution", enum: sizes, default: sizes[0] }] : []),
  ],
  inputs: [PROMPT, IMAGES],
});

const seedream: Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> = {
  family: "seedream",
  capabilities: ["text-to-image", "image-to-image"],
  parameters: [
    { name: "size", type: "string", description: "Output resolution class", enum: ["1K", "2K", "4K"], default: "2K" },
    { name: "watermark", type: "boolean", description: "Add the provider watermark", default: false },
    seed(-1),
  ],
  inputs: [PROMPT, { ...IMAGES, label: "Reference images" }],
};

const grokImage = (withQuality: boolean): Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> => ({
  family: "grokImage",
  capabilities: ["text-to-image"],
  parameters: [
    { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "1:2", "2:1"], default: "auto" },
    { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k"], default: "1k" },
    ...(withQuality ? [{ name: "quality", type: "string" as const, description: "Quality tier", enum: ["low", "medium", "high"], default: "medium" }] : []),
  ],
  inputs: [PROMPT],
});

const IMAGE_MODELS: ComfyRouterModel[] = [
  { id: "bfl/flux-2-pro", name: "FLUX.2 Pro", description: "Black Forest Labs' production FLUX.2. Text to image and multi-reference editing at up to 2048px.", ...flux2 },
  { id: "bfl/flux-2-max", name: "FLUX.2 Max", description: "The largest FLUX.2, for the most demanding prompts and references.", ...flux2 },
  { id: "bfl/flux-kontext-pro", name: "FLUX Kontext Pro", description: "Instruction-based image editing that keeps the subject consistent.", ...fluxKontext },
  { id: "bfl/flux-kontext-max", name: "FLUX Kontext Max", description: "Kontext with more capacity for typography and complex edits.", ...fluxKontext },
  {
    id: "bfl/flux-pro-1.1", name: "FLUX 1.1 Pro", description: "Fast, reliable FLUX text to image.",
    family: "flux11", capabilities: ["text-to-image"],
    parameters: [
      { name: "width", type: "integer", description: "Output width in pixels", default: 1024, minimum: 256, maximum: 1440 },
      { name: "height", type: "integer", description: "Output height in pixels", default: 768, minimum: 256, maximum: 1440 },
      { name: "output_format", type: "string", description: "Output image format", enum: ["jpeg", "png", "webp"], default: "jpeg" },
      { name: "safety_tolerance", type: "integer", description: "Moderation tolerance, 0 strict to 6 permissive", default: 2, minimum: 0, maximum: 6 },
      seed(),
    ],
    inputs: [PROMPT],
  },
  {
    id: "bfl/flux-pro-1.1-ultra", name: "FLUX 1.1 Pro Ultra", description: "FLUX at 4MP with an optional raw, less processed look.",
    family: "flux11Ultra", capabilities: ["text-to-image", "image-to-image"],
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: IMAGE_ASPECTS, default: "16:9" },
      { name: "raw", type: "boolean", description: "Less processed, more natural output", default: false },
      { name: "image_prompt_strength", type: "number", description: "Blend towards the image prompt, 0 to 1", default: 0.1, minimum: 0, maximum: 1 },
      { name: "output_format", type: "string", description: "Output image format", enum: ["jpeg", "png", "webp"], default: "jpeg" },
      { name: "safety_tolerance", type: "integer", description: "Moderation tolerance, 0 strict to 6 permissive", default: 2, minimum: 0, maximum: 6 },
      seed(),
    ],
    inputs: [PROMPT, { name: "image", type: "image", required: false, label: "Image prompt" }],
  },
  { id: "openai/gpt-image-2", name: "GPT Image 2", description: "OpenAI's latest image model. Generation and edits with strong text rendering.", ...gptImage },
  { id: "openai/gpt-image-1.5", name: "GPT Image 1.5", description: "OpenAI's GPT Image 1.5 for generation and edits.", ...gptImage },
  { id: "vertexai/gemini-3-pro-image", name: "Nano Banana Pro", description: "Gemini 3 Pro Image through Comfy. Reasoning-led generation and editing up to 4K.", ...geminiImage(["1K", "2K", "4K"]) },
  { id: "vertexai/gemini-3.1-flash-image", name: "Nano Banana 2", description: "Gemini 3.1 Flash Image through Comfy. Fast generation and editing up to 4K.", ...geminiImage(["1K", "2K", "4K"]) },
  { id: "vertexai/gemini-2.5-flash-image", name: "Nano Banana", description: "Gemini 2.5 Flash Image through Comfy. Quick generation and editing.", ...geminiImage(["1K"]) },
  { id: "byteplus/seedream-5-0-260128", name: "Seedream 5.0", description: "ByteDance's Seedream 5.0. Generation and multi-image editing.", ...seedream },
  { id: "byteplus/seedream-4-5-251128", name: "Seedream 4.5", description: "ByteDance's Seedream 4.5. Strong photoreal generation and editing.", ...seedream },
  { id: "xai/grok-imagine-image-2.0", name: "Grok Imagine Image 2.0", description: "xAI's Grok Imagine with quality tiers.", ...grokImage(true) },
  { id: "xai/grok-imagine-image", name: "Grok Imagine Image", description: "xAI's Grok Imagine image model.", ...grokImage(false) },
  {
    id: "ideogram/ideogram-v4", name: "Ideogram v4", description: "Ideogram's fourth generation, with a knack for text and design.",
    family: "ideogramV4", capabilities: ["text-to-image"],
    parameters: [
      { name: "rendering_speed", type: "string", description: "Speed against quality", enum: ["DEFAULT", "TURBO", "QUALITY"], default: "DEFAULT" },
      { name: "resolution", type: "string", description: "Output resolution as WIDTHxHEIGHT; leave empty to let the model choose" },
    ],
    inputs: [PROMPT],
  },
  {
    id: "recraft/recraftv4", name: "Recraft V4", description: "Recraft's V4 for illustration, vector-style art and realistic images.",
    family: "recraft", capabilities: ["text-to-image"],
    parameters: [
      { name: "size", type: "string", description: "Output size", enum: ["1024x1024", "1365x1024", "1024x1365", "1536x1024", "1024x1536", "1820x1024", "1024x1820", "1024x2048", "2048x1024", "1434x1024", "1024x1434", "1024x1280", "1280x1024", "1024x1707", "1707x1024"], default: "1024x1024" },
      { name: "style", type: "string", description: "Rendering style", enum: ["realistic_image", "digital_illustration", "vector_illustration"], default: "realistic_image" },
    ],
    inputs: [PROMPT],
  },
  {
    id: "qwen/qwen-image-3.0", name: "Qwen Image 3.0", description: "Alibaba's Qwen Image 3.0. Generation and editing with up to three references.",
    family: "qwenImage", capabilities: ["text-to-image", "image-to-image"],
    parameters: [
      { name: "size", type: "string", description: "Output resolution", enum: ["1328*1328", "1024*1024", "1664*928", "928*1664", "1472*1104", "1104*1472"], default: "1328*1328" },
      { name: "negative_prompt", type: "string", description: "What to keep out of the image" },
      { name: "prompt_extend", type: "boolean", description: "Let the model rewrite the prompt", default: true },
      seed(),
    ],
    inputs: [PROMPT, { ...IMAGES, label: "Reference images", description: "Up to 3 images" }],
  },
  {
    id: "kling/kling-image-o1", name: "Kling Image O1", description: "Kling's image model with reference images and 4K output.",
    family: "klingImage", capabilities: ["text-to-image", "image-to-image"],
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"], default: "auto" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1k", "2k", "4k"], default: "1k" },
    ],
    inputs: [PROMPT, { ...IMAGES, label: "Reference images" }],
  },
];

// ------------------------------------------------------------------ video

const seedance = (opts: { audio: boolean; maxDuration: number }): Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> => ({
  family: "seedance",
  capabilities: ["text-to-video", "image-to-video"],
  parameters: [
    { name: "duration", type: "integer", description: "Length in seconds", default: 5, minimum: 4, maximum: opts.maxDuration },
    { name: "ratio", type: "string", description: "Aspect ratio; adaptive follows the first frame", enum: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "9:21"], default: "adaptive" },
    { name: "resolution", type: "string", description: "Output resolution", enum: ["480p", "720p", "1080p"], default: "720p" },
    ...(opts.audio ? [{ name: "generate_audio", type: "boolean" as const, description: "Generate a soundtrack", default: true }] : []),
    seed(-1),
  ],
  inputs: [PROMPT, FIRST_FRAME, LAST_FRAME],
});

const klingText: Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> = {
  family: "klingText",
  capabilities: ["text-to-video"],
  parameters: [
    { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
    { name: "duration", type: "string", description: "Length in seconds", enum: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"], default: "5" },
    { name: "mode", type: "string", description: "std is cheaper, pro is sharper", enum: ["std", "pro"], default: "std" },
    { name: "sound", type: "string", description: "Generate sound with the video", enum: ["off", "on"], default: "off" },
    { name: "negative_prompt", type: "string", description: "What to keep out of the video" },
    { name: "cfg_scale", type: "number", description: "Prompt adherence, 0 loose to 1 strict", default: 0.5, minimum: 0, maximum: 1 },
  ],
  inputs: [PROMPT],
};

const veo = (opts: { lastFrame: boolean; fourK: boolean }): Pick<ComfyRouterModel, "family" | "capabilities" | "parameters" | "inputs"> => ({
  family: "veo",
  capabilities: ["text-to-video", "image-to-video"],
  parameters: [
    { name: "aspectRatio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
    { name: "durationSeconds", type: "integer", description: "Length in seconds", enum: [4, 6, 8], default: 8 },
    { name: "resolution", type: "string", description: "Output resolution", enum: opts.fourK ? ["720p", "1080p", "4k"] : ["720p", "1080p"], default: "720p" },
    { name: "generateAudio", type: "boolean", description: "Generate audio with the video", default: true },
    { name: "negativePrompt", type: "string", description: "What to keep out of the video" },
  ],
  inputs: opts.lastFrame ? [PROMPT, FIRST_FRAME, LAST_FRAME] : [PROMPT, FIRST_FRAME],
});

const VIDEO_MODELS: ComfyRouterModel[] = [
  { id: "byteplus/dreamina-seedance-2-5-260628", name: "Seedance 2.5", description: "ByteDance's newest Seedance. Audio, first and last frames, up to 30 seconds.", ...seedance({ audio: true, maxDuration: 30 }) },
  { id: "byteplus/dreamina-seedance-2-0-260128", name: "Seedance 2.0", description: "Seedance 2.0 with native audio and frame conditioning.", ...seedance({ audio: true, maxDuration: 15 }) },
  { id: "byteplus/dreamina-seedance-2-0-fast-260128", name: "Seedance 2.0 Fast", description: "The quick Seedance 2.0 tier.", ...seedance({ audio: true, maxDuration: 15 }) },
  { id: "byteplus/seedance-1-5-pro-251215", name: "Seedance 1.5 Pro", description: "Seedance 1.5 Pro, with audio.", ...seedance({ audio: true, maxDuration: 12 }) },
  { id: "kling/kling-v3", name: "Kling V3", description: "Kling's V3 text to video with optional sound.", ...klingText },
  { id: "kling/kling-v2-6", name: "Kling V2.6", description: "Kling V2.6 text to video.", ...klingText },
  {
    id: "kling/kling-v3-omni", name: "Kling V3 Omni", description: "Kling V3 with first and last frame conditioning.",
    family: "klingOmni", capabilities: ["text-to-video", "image-to-video"],
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
      { name: "duration", type: "string", description: "Length in seconds", enum: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"], default: "5" },
      { name: "mode", type: "string", description: "std is 720p and cheaper, pro is sharper", enum: ["std", "pro"], default: "pro" },
      { name: "sound", type: "string", description: "Generate sound with the video", enum: ["off", "on"], default: "off" },
    ],
    inputs: [PROMPT, FIRST_FRAME, LAST_FRAME],
  },
  {
    id: "kling/kling-3.0-turbo", name: "Kling 3.0 Turbo", description: "Kling's fast 3.0 tier, up to 1080p.",
    family: "kling3Turbo", capabilities: ["text-to-video"],
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
      { name: "duration", type: "integer", description: "Length in seconds", default: 5, minimum: 3, maximum: 15 },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "720p" },
    ],
    inputs: [PROMPT],
  },
  { id: "veo/veo-3.1-generate-001", name: "Veo 3.1", description: "Google's Veo 3.1 with audio, first and last frames, up to 4K.", ...veo({ lastFrame: true, fourK: true }) },
  { id: "veo/veo-3.1-fast-generate-001", name: "Veo 3.1 Fast", description: "The quick Veo 3.1 tier.", ...veo({ lastFrame: true, fourK: false }) },
  { id: "veo/veo-3.0-generate-001", name: "Veo 3", description: "Google's Veo 3 with audio.", ...veo({ lastFrame: false, fourK: false }) },
  {
    id: "xai/grok-imagine-video-1.5", name: "Grok Imagine Video 1.5", description: "xAI's Grok Imagine video, text or image to video up to 15 seconds.",
    family: "grokVideo", capabilities: ["text-to-video", "image-to-video"],
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"], default: "16:9" },
      { name: "duration", type: "integer", description: "Length in seconds", default: 8, minimum: 1, maximum: 15 },
    ],
    inputs: [PROMPT, FIRST_FRAME],
  },
  {
    id: "runway/gen4_turbo", name: "Runway Gen-4 Turbo", description: "Runway's Gen-4 Turbo image to video. Needs a first frame.",
    family: "runwayGen4", capabilities: ["image-to-video"],
    parameters: [
      { name: "duration", type: "integer", description: "Length in seconds", enum: [5, 10], default: 5 },
      { name: "ratio", type: "string", description: "Output size", enum: ["1280:720", "720:1280", "1104:832", "832:1104", "960:960", "1584:672", "1280:768", "768:1280"], default: "1280:720" },
    ],
    inputs: [{ ...PROMPT, required: false }, { ...FIRST_FRAME, required: true }],
  },
  {
    id: "ltx/ltx-2-5-pro", name: "LTX 2.5 Pro", description: "Lightricks' LTX 2.5 with audio, up to 4K.",
    family: "ltx", capabilities: ["text-to-video"],
    parameters: [
      { name: "duration", type: "integer", description: "Length in seconds", enum: [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20], default: 5 },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1280x720", "720x1280", "1920x1080", "1080x1920", "2560x1440", "1440x2560", "3840x2160", "2160x3840"], default: "1280x720" },
      { name: "fps", type: "integer", description: "Frame rate", enum: [24, 25, 48, 50], default: 25 },
      { name: "generate_audio", type: "boolean", description: "Generate audio with the video", default: true },
    ],
    inputs: [PROMPT],
  },
  {
    id: "ltx/ltx-2-5-fast", name: "LTX 2.5 Fast", description: "The quick LTX 2.5 tier.",
    family: "ltx", capabilities: ["text-to-video"],
    parameters: [
      { name: "duration", type: "integer", description: "Length in seconds", enum: [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20], default: 5 },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["1280x720", "720x1280", "1920x1080", "1080x1920"], default: "1280x720" },
      { name: "fps", type: "integer", description: "Frame rate", enum: [24, 25, 48, 50], default: 25 },
      { name: "generate_audio", type: "boolean", description: "Generate audio with the video", default: true },
    ],
    inputs: [PROMPT],
  },
  {
    id: "minimax/minimax-h3", name: "MiniMax H3", description: "MiniMax's H3 video model, text or first frame, 5 to 15 seconds.",
    family: "minimax", capabilities: ["text-to-video", "image-to-video"],
    parameters: [
      { name: "duration", type: "integer", description: "Length in seconds", default: 5, minimum: 5, maximum: 15 },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["768P", "2K"], default: "768P" },
      { name: "ratio", type: "string", description: "Aspect ratio; adaptive follows the first frame", enum: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], default: "adaptive" },
    ],
    inputs: [PROMPT, FIRST_FRAME],
  },
  {
    id: "wan/wan2.7-t2v", name: "Wan 2.7", description: "Alibaba's Wan 2.7 text to video with audio.",
    family: "wanVideo", capabilities: ["text-to-video"],
    parameters: [
      { name: "duration", type: "integer", description: "Length in seconds", default: 5, minimum: 2, maximum: 15 },
      { name: "ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1", "4:3", "3:4"], default: "16:9" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["480P", "720P", "1080P"], default: "720P" },
      { name: "audio", type: "boolean", description: "Generate audio with the video", default: true },
      { name: "negative_prompt", type: "string", description: "What to keep out of the video" },
      seed(),
    ],
    inputs: [PROMPT],
  },
  {
    id: "wan/wan2.7-i2v", name: "Wan 2.7 Image to Video", description: "Wan 2.7 from a first frame, with audio.",
    family: "wanVideo", capabilities: ["image-to-video"],
    parameters: [
      { name: "duration", type: "integer", description: "Length in seconds", default: 5, minimum: 2, maximum: 15 },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["480P", "720P", "1080P"], default: "720P" },
      { name: "audio", type: "boolean", description: "Generate audio with the video", default: true },
      { name: "negative_prompt", type: "string", description: "What to keep out of the video" },
      seed(),
    ],
    inputs: [PROMPT, { ...FIRST_FRAME, required: true }],
  },
  {
    id: "luma/ray-2", name: "Luma Ray 2", description: "Luma's Ray 2 text to video.",
    family: "lumaRay", capabilities: ["text-to-video"],
    parameters: [
      { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21"], default: "16:9" },
      { name: "duration", type: "string", description: "Length", enum: ["5s", "9s"], default: "5s" },
      { name: "resolution", type: "string", description: "Output resolution", enum: ["540p", "720p", "1080p", "4k"], default: "720p" },
      { name: "loop", type: "boolean", description: "Make the video loop", default: false },
    ],
    inputs: [PROMPT],
  },
];

export const COMFY_ROUTER_MODELS: ComfyRouterModel[] = [...IMAGE_MODELS, ...VIDEO_MODELS];

const BY_ID = new Map(COMFY_ROUTER_MODELS.map((model) => [model.id, model]));

export function getComfyRouterModel(id: string): ComfyRouterModel | undefined {
  return BY_ID.get(id);
}

/** The catalog as the registry route serves it. */
export function comfyRouterProviderModels(): ProviderModel[] {
  return COMFY_ROUTER_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    provider: "comfy",
    capabilities: model.capabilities,
    pageUrl: `${COMFY_ROUTER_MODELS_URL}#${model.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
  }));
}

/** Parameters and inputs for the schema route; null when the id is not in the catalog. */
export function comfyRouterSchema(id: string): { parameters: ModelParameter[]; inputs: ModelInput[] } | null {
  const model = BY_ID.get(id);
  return model ? { parameters: model.parameters, inputs: model.inputs } : null;
}
