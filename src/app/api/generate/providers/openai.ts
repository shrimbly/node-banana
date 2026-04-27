/**
 * OpenAI Provider for Generate API Route
 *
 * Handles image generation using OpenAI's Images API.
 *
 * Supported models:
 *   - gpt-image-2 (text-to-image via /v1/images/generations,
 *                  image-to-image via /v1/images/edits)
 *
 * Reference: https://developers.openai.com/api/docs/models/gpt-image-2
 *
 * Notes:
 * - gpt-image-2 always returns base64 in `data[].b64_json` (no `response_format`).
 * - The edits endpoint is multipart/form-data and accepts up to 16 source images,
 *   each PNG/WEBP/JPG and <50MB.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";

const OPENAI_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits";

const MAX_EDIT_IMAGES = 16;
const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB per edit source

/**
 * Parameters that we forward verbatim to OpenAI's Images API for gpt-image-2.
 *
 * Anything not in this list is dropped to avoid surfacing UI-only knobs as
 * unknown OpenAI parameters (which would 400 the request).
 */
const GPT_IMAGE_2_FORWARDED_PARAMS = new Set([
  "size",
  "quality",
  "n",
  "output_format",
  "output_compression",
  "background",
  "moderation",
  "thinking",
  "user",
]);

/**
 * Coerce a possibly-numeric param value into a sensible JSON value.
 * The schema endpoint may emit numbers as strings ("1") from <input> elements;
 * OpenAI is strict about types for `n` and `output_compression`.
 */
function coerceNumericIfNeeded(name: string, value: unknown): unknown {
  if (name === "n" || name === "output_compression") {
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return value;
}

/**
 * Build the JSON body for /v1/images/generations from a GenerationInput.
 */
function buildGenerationBody(input: GenerationInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model.id,
    prompt: input.prompt,
  };

  if (input.parameters) {
    for (const [key, rawValue] of Object.entries(input.parameters)) {
      if (!GPT_IMAGE_2_FORWARDED_PARAMS.has(key)) continue;
      if (rawValue === null || rawValue === undefined || rawValue === "") continue;
      body[key] = coerceNumericIfNeeded(key, rawValue);
    }
  }

  return body;
}

/**
 * Convert a base64 data URL or raw base64 into a Blob suitable for FormData.
 *
 * Returns a tuple of (blob, filename). The filename's extension reflects the
 * detected mime type so OpenAI accepts it.
 */
function base64ToBlob(input: string, indexHint: number): { blob: Blob; filename: string } {
  let mimeType = "image/png";
  let dataPart = input;

  if (input.startsWith("data:")) {
    const m = input.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      mimeType = m[1];
      dataPart = m[2];
    }
  }

  const buffer = Buffer.from(dataPart, "base64");

  if (buffer.length > MAX_EDIT_IMAGE_BYTES) {
    throw new Error(
      `Image #${indexHint + 1} too large for OpenAI edits (${(buffer.length / (1024 * 1024)).toFixed(1)}MB > 50MB)`
    );
  }

  let ext = "png";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") ext = "jpg";
  else if (mimeType === "image/webp") ext = "webp";

  // Node 18+ has Blob in globals; new Blob expects a Uint8Array view.
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  return { blob, filename: `image_${indexHint + 1}.${ext}` };
}

/**
 * Collect all image inputs for an edit request, preferring dynamicInputs over
 * the legacy `images` array but falling back to it if no dynamic inputs were
 * routed to a known image key.
 */
function collectEditImages(input: GenerationInput): string[] {
  const collected: string[] = [];

  if (input.dynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs)) {
      // gpt-image-2 only accepts an "image" field on edits; we accept any
      // image-shaped input the schema may have surfaced.
      if (
        key !== "image" &&
        key !== "images" &&
        key !== "image_urls" &&
        key !== "input_urls"
      ) {
        continue;
      }
      if (value === null || value === undefined || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item) collected.push(item);
        }
      } else if (typeof value === "string") {
        collected.push(value);
      }
    }
  }

  if (collected.length === 0 && input.images && input.images.length > 0) {
    collected.push(...input.images);
  }

  return collected;
}

/**
 * Fetch a remote URL and return base64 — used so we can submit URL-only inputs
 * to /v1/images/edits, which only accepts file uploads.
 */
async function urlToBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url.substring(0, 80)}: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "image/png";
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

interface OpenAIImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Pull the first image from an OpenAI Images API response and convert it into
 * a base64 data URL the rest of Node Banana expects.
 */
function extractFirstImageDataUrl(json: OpenAIImagesResponse, fallbackMime = "image/png"): string | null {
  const first = json.data?.[0];
  if (!first) return null;
  if (first.b64_json) {
    return `data:${fallbackMime};base64,${first.b64_json}`;
  }
  // gpt-image-2 doesn't currently return URLs, but handle it defensively
  // in case OpenAI changes the response shape later.
  if (first.url) {
    return first.url;
  }
  return null;
}

/**
 * Determine the output mime type for a given response so the data URL is
 * well-formed when the user picked a non-default output_format.
 */
function inferOutputMimeType(parameters?: Record<string, unknown>): string {
  const fmt = parameters?.output_format;
  if (fmt === "jpeg" || fmt === "jpg") return "image/jpeg";
  if (fmt === "webp") return "image/webp";
  return "image/png";
}

/**
 * Decide whether this generation should hit the edits endpoint or the
 * generations endpoint.
 */
function isEditRequest(input: GenerationInput): boolean {
  if (input.images && input.images.length > 0) return true;
  if (input.dynamicInputs) {
    for (const key of ["image", "images", "image_urls", "input_urls"] as const) {
      const value = input.dynamicInputs[key];
      if (value === null || value === undefined || value === "") continue;
      if (Array.isArray(value) && value.some((v) => typeof v === "string" && v)) return true;
      if (typeof value === "string" && value) return true;
    }
  }
  return false;
}

/**
 * Build a friendly error string from an OpenAI error response body.
 */
async function readOpenAIError(response: Response, modelName: string): Promise<string> {
  const text = await response.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as OpenAIImagesResponse;
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // keep raw text
  }
  if (response.status === 429) {
    return `${modelName}: Rate limit exceeded. Try again in a moment.`;
  }
  if (response.status === 401) {
    return `${modelName}: OpenAI rejected the API key (401). Check OPENAI_API_KEY in Settings.`;
  }
  return `${modelName}: ${detail.substring(0, 500)}`;
}

/**
 * POST /v1/images/generations for text-to-image.
 */
async function generateOpenAITextToImage(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const body = buildGenerationBody(input);

  console.log(
    `[API:${requestId}] OpenAI generations - Model: ${input.model.id}, Prompt: ${input.prompt.length} chars`
  );

  const response = await fetch(OPENAI_GENERATIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return { success: false, error: await readOpenAIError(response, input.model.name) };
  }

  const json = (await response.json()) as OpenAIImagesResponse;
  const dataUrl = extractFirstImageDataUrl(json, inferOutputMimeType(input.parameters));
  if (!dataUrl) {
    return { success: false, error: `${input.model.name}: No image data in OpenAI response` };
  }

  console.log(`[API:${requestId}] SUCCESS - Returning OpenAI image`);
  return {
    success: true,
    outputs: [{ type: "image", data: dataUrl }],
  };
}

/**
 * POST /v1/images/edits (multipart) for image editing / multi-image composition.
 *
 * gpt-image-2 supports up to 16 source images shared across one prompt.
 */
async function generateOpenAIImageEdit(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const sourceImages = collectEditImages(input);
  if (sourceImages.length === 0) {
    // Should be unreachable (caller picks the endpoint), but guard explicitly.
    return generateOpenAITextToImage(requestId, apiKey, input);
  }

  if (sourceImages.length > MAX_EDIT_IMAGES) {
    return {
      success: false,
      error: `${input.model.name}: ${sourceImages.length} images exceeds OpenAI's ${MAX_EDIT_IMAGES}-image limit for edits.`,
    };
  }

  console.log(
    `[API:${requestId}] OpenAI edits - Model: ${input.model.id}, Images: ${sourceImages.length}, Prompt: ${input.prompt.length} chars`
  );

  // Convert all sources into base64 data URLs first so we can attach them as
  // file parts. Plain http(s) URLs get fetched server-side.
  const normalized: string[] = [];
  for (const source of sourceImages) {
    if (source.startsWith("data:image")) {
      normalized.push(source);
    } else if (source.startsWith("http")) {
      normalized.push(await urlToBase64(source));
    } else {
      // Treat anything else as raw base64 (legacy behaviour)
      normalized.push(`data:image/png;base64,${source}`);
    }
  }

  const formData = new FormData();
  formData.append("model", input.model.id);
  formData.append("prompt", input.prompt);

  // Forward known params as form fields
  if (input.parameters) {
    for (const [key, rawValue] of Object.entries(input.parameters)) {
      if (!GPT_IMAGE_2_FORWARDED_PARAMS.has(key)) continue;
      if (rawValue === null || rawValue === undefined || rawValue === "") continue;
      formData.append(key, String(coerceNumericIfNeeded(key, rawValue)));
    }
  }

  // Attach source images. gpt-image-2 accepts the same field name repeated.
  normalized.forEach((dataUrl, idx) => {
    const { blob, filename } = base64ToBlob(dataUrl, idx);
    formData.append("image", blob, filename);
  });

  const response = await fetch(OPENAI_EDITS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // NOTE: do NOT set Content-Type; the runtime fills in the multipart boundary.
    },
    body: formData,
  });

  if (!response.ok) {
    return { success: false, error: await readOpenAIError(response, input.model.name) };
  }

  const json = (await response.json()) as OpenAIImagesResponse;
  const dataUrl = extractFirstImageDataUrl(json, inferOutputMimeType(input.parameters));
  if (!dataUrl) {
    return { success: false, error: `${input.model.name}: No image data in OpenAI edits response` };
  }

  console.log(`[API:${requestId}] SUCCESS - Returning OpenAI edited image`);
  return {
    success: true,
    outputs: [{ type: "image", data: dataUrl }],
  };
}

/**
 * Public entry point used by the generate route.
 *
 * Routes to the edits endpoint if any image input was provided, otherwise
 * falls through to text-to-image generation.
 */
export async function generateWithOpenAI(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  try {
    if (isEditRequest(input)) {
      return await generateOpenAIImageEdit(requestId, apiKey, input);
    }
    return await generateOpenAITextToImage(requestId, apiKey, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAI image generation failed";
    console.error(`[API:${requestId}] OpenAI generation error: ${message}`);
    return { success: false, error: `${input.model.name}: ${message}` };
  }
}
