/** Direct OpenAI Images API generation and reference-image editing. */
import type { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { estimateOpenAIImage25Cost, validateOpenAIImageParameters } from "@/lib/providers/openaiImages";
import type { ImageGenerationMetadata } from "@/types/api";

const OPENAI_API_BASE = "https://api.openai.com/v1/images";
const OPENAI_IMAGE_TIMEOUT_MS = 240_000;
const MAX_REFERENCE_IMAGES = 16;
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const IMAGE_MIME_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: "png" | "jpeg" | "webp";
  usage?: {
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { image_tokens?: number };
  };
};

function referenceBlob(image: string): { blob: Blob; extension: string } {
  if (typeof image !== "string" || /^https?:/i.test(image)) {
    throw new Error("OpenAI references must contain image data. Load the image into an Image Input node first.");
  }
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(image);
  const mimeType = match?.[1] ?? "image/png";
  const base64 = match?.[2] ?? image;
  if (!(mimeType in IMAGE_MIME_TYPES) || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("OpenAI references must be base64-encoded PNG, JPEG or WebP images.");
  }
  if (base64.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4) {
    throw new Error("Each OpenAI reference image must be smaller than 50 MB.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length >= MAX_REFERENCE_BYTES) {
    throw new Error("Each OpenAI reference image must contain image data and be smaller than 50 MB.");
  }
  return { blob: new Blob([bytes], { type: mimeType }), extension: IMAGE_MIME_TYPES[mimeType as keyof typeof IMAGE_MIME_TYPES] };
}

function getUsage(data: OpenAIImageResponse): ImageGenerationMetadata["usage"] {
  const textInputTokens = data.usage?.input_tokens_details?.text_tokens;
  const imageInputTokens = data.usage?.input_tokens_details?.image_tokens;
  const imageOutputTokens = data.usage?.output_tokens_details?.image_tokens ?? data.usage?.output_tokens;
  if (![textInputTokens, imageInputTokens, imageOutputTokens].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined;
  return { textInputTokens: textInputTokens!, imageInputTokens: imageInputTokens!, imageOutputTokens: imageOutputTokens! };
}

async function upstreamError(response: Response, modelName: string): Promise<GenerationOutput> {
  let detail = `HTTP ${response.status}`;
  let errorCode: string | undefined;
  try {
    const data = JSON.parse(await response.text());
    if (typeof data.error?.message === "string") detail = data.error.message;
    if (typeof data.error?.code === "string") errorCode = data.error.code;
    else if (typeof data.error?.type === "string") errorCode = data.error.type;
  } catch {
    // Gateway HTML is not a useful node error message.
  }
  if (response.status >= 500) detail = `OpenAI is temporarily unavailable (${detail}). Please try again.`;
  else if (response.status === 429 && errorCode !== "insufficient_quota" && errorCode !== "billing_hard_limit_reached") {
    detail = `Rate limit exceeded. ${detail}`;
  }
  return {
    success: false,
    error: `${modelName}: ${detail}`,
    statusCode: response.status >= 500 ? 502 : response.status,
    errorCode,
    retryAfter: response.headers?.get("retry-after") ?? undefined,
  };
}

export async function generateWithOpenAI(requestId: string, apiKey: string, input: GenerationInput): Promise<GenerationOutput> {
  const parameters = input.parameters ?? {};
  const invalid = validateOpenAIImageParameters(input.model.id, parameters);
  if (invalid) return { success: false, statusCode: 400, errorCode: "invalid_parameters", error: invalid };
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32_000) {
    return { success: false, statusCode: 400, errorCode: "invalid_prompt", error: "OpenAI requires a prompt between 1 and 32,000 characters." };
  }

  const dynamicImages = input.dynamicInputs?.image;
  const images = input.images?.length ? input.images : dynamicImages ? (Array.isArray(dynamicImages) ? dynamicImages : [dynamicImages]) : [];
  if (!Array.isArray(images) || images.length > MAX_REFERENCE_IMAGES) {
    return { success: false, statusCode: 400, errorCode: "invalid_images", error: "OpenAI supports at most 16 reference images per request." };
  }

  const settings: Record<string, unknown> = { size: "auto", quality: "auto", background: "auto", output_format: "png", n: 1 };
  for (const key of ["size", "quality", "background", "output_format"] as const) {
    if (parameters[key] !== undefined) settings[key] = parameters[key];
  }
  if (["jpeg", "webp"].includes(String(settings.output_format)) && parameters.output_compression !== undefined) {
    settings.output_compression = parameters.output_compression;
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: string | FormData;
  if (images.length) {
    const form = new FormData();
    form.append("model", input.model.id);
    form.append("prompt", input.prompt);
    for (const [key, value] of Object.entries(settings)) form.append(key, String(value));
    try {
      images.forEach((image, index) => {
        const { blob, extension } = referenceBlob(image);
        form.append("image[]", blob, `reference-${index + 1}.${extension}`);
      });
    } catch (error) {
      return { success: false, statusCode: 400, errorCode: "invalid_image", error: (error as Error).message };
    }
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model: input.model.id, prompt: input.prompt, ...settings });
  }

  const timeout = AbortSignal.timeout(OPENAI_IMAGE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    console.log(`[API:${requestId}] OpenAI model=${input.model.id}, references=${images.length}`);
    const response = await fetch(`${OPENAI_API_BASE}/${images.length ? "edits" : "generations"}`, { method: "POST", headers, body, signal });
    if (!response.ok) return await upstreamError(response, input.model.name);
    const data: OpenAIImageResponse = await response.json();
    const base64 = data.data?.[0]?.b64_json;
    if (typeof base64 !== "string" || !base64) return { success: false, error: "No image returned from OpenAI" };
    const format = data.output_format ?? settings.output_format as "png" | "jpeg" | "webp";
    if (!["png", "jpeg", "webp"].includes(format)) return { success: false, statusCode: 502, error: "OpenAI returned an unsupported image format." };
    const usage = getUsage(data);
    return {
      success: true,
      outputs: [{ type: "image", data: `data:image/${format};base64,${base64}` }],
      generation: {
        modelId: input.model.id,
        parameters: settings,
        size: data.size ?? (settings.size === "auto" ? undefined : String(settings.size)),
        quality: data.quality ?? String(settings.quality),
        background: data.background ?? String(settings.background),
        outputFormat: format,
        usage,
        cost: estimateOpenAIImage25Cost(input.model.id, usage),
      },
    };
  } catch (error) {
    if (input.signal?.aborted) return { success: false, statusCode: 499, errorCode: "cancelled", error: "OpenAI generation cancelled." };
    if (timeout.aborted || (error as Error).name === "TimeoutError") return { success: false, statusCode: 504, errorCode: "timeout", error: "OpenAI generation timed out." };
    return { success: false, statusCode: 502, errorCode: "upstream_error", error: "Could not complete the OpenAI request. Please try again." };
  }
}
