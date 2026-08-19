/**
 * OrcaRouter Provider for Generate API Route
 *
 * Handles image generation through OrcaRouter's OpenAI-compatible Images API
 * (gpt-image-1, gpt-image-2 routed upstream). Supports both text-to-image
 * (/v1/images/generations) and image-to-image (/v1/images/edits).
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";

/**
 * Extract base64 data and MIME type from a data URL
 */
function extractBase64Data(dataUrl: string): { data: string; mimeType: string } {
  if (dataUrl.includes("base64,")) {
    const [header, data] = dataUrl.split("base64,");
    const mimeMatch = header.match(/data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    return { data, mimeType };
  }
  return { data: dataUrl, mimeType: "image/png" };
}

/**
 * Generate image using OrcaRouter Images API (OpenAI-compatible)
 */
export async function generateWithOrcaRouter(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] OrcaRouter generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const ORCAROUTER_API_BASE = "https://api.orcarouter.ai/v1";
  const modelId = input.model.id;

  const hasImages = input.images && input.images.length > 0;
  // If images are provided, use the edits endpoint; otherwise use generations
  const isImageToImage = hasImages;

  // Build parameters from user settings
  const parameters = input.parameters || {};

  // Determine endpoint
  const endpoint = isImageToImage
    ? `${ORCAROUTER_API_BASE}/images/edits`
    : `${ORCAROUTER_API_BASE}/images/generations`;

  let response: Response;

  if (isImageToImage) {
    // Multipart form data for image edits
    const formData = new FormData();
    formData.append("model", modelId);
    formData.append("prompt", input.prompt);
    // gpt-image models return base64 by default; response_format is not a valid parameter

    if (parameters.size) formData.append("size", String(parameters.size));
    if (parameters.quality) formData.append("quality", String(parameters.quality));
    if (parameters.n) formData.append("n", String(parameters.n));
    if (parameters.background) formData.append("background", String(parameters.background));

    // Add first image only (OpenAI edits supports up to 4 images, but single image is the safest default)
    const image = input.images![0];
    const { data, mimeType } = extractBase64Data(image);
    const ext = mimeType === "image/jpeg" ? "jpg" : "png";
    const blob = new Blob([Buffer.from(data, "base64")], { type: mimeType });
    formData.append("image", blob, `image.${ext}`);

    console.log(`[API:${requestId}] OrcaRouter edits request: 1 image, model=${modelId}`);

    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });
  } else {
    // JSON payload for text-to-image generations
    const body: Record<string, unknown> = {
      model: modelId,
      prompt: input.prompt,
      // gpt-image models return base64 by default; response_format is not a valid parameter
    };

    if (parameters.size) body.size = parameters.size;
    if (parameters.quality) body.quality = parameters.quality;
    if (parameters.n) body.n = parameters.n;
    if (parameters.background) body.background = parameters.background;

    console.log(`[API:${requestId}] OrcaRouter generations request: model=${modelId}`);

    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    // Default to a concise, status-based message so we never surface a raw HTML
    // gateway/error page (e.g. a Cloudflare 520) to the user.
    let errorDetail = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error?.message || errorJson.error?.type || errorDetail;
    } catch {
      // Non-JSON body (HTML error page, etc.) — keep the status-based message.
    }
    console.error(`[API:${requestId}] OrcaRouter error ${response.status}: ${errorText.slice(0, 300)}`);

    // Handle rate limits
    if (response.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. Try again in a moment.`,
      };
    }

    // Upstream/gateway errors (500-599, incl. Cloudflare 520-524) are transient.
    if (response.status >= 500) {
      return {
        success: false,
        error: `${input.model.name}: OrcaRouter is temporarily unavailable (${errorDetail}). Please try again.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
    };
  }

  const data = await response.json();

  // Extract base64 image from response
  const firstImage = data.data?.[0];
  const b64Json = firstImage?.b64_json;

  if (!b64Json) {
    console.error(`[API:${requestId}] No b64_json in OrcaRouter response`);
    return {
      success: false,
      error: "No image returned from OrcaRouter",
    };
  }

  // OrcaRouter returns PNG by default for b64_json format
  const mimeType = "image/png";
  const dataUrl = `data:${mimeType};base64,${b64Json}`;
  const imageSizeKB = (b64Json.length / 1024).toFixed(1);

  console.log(`[API:${requestId}] SUCCESS - Returning image: ${mimeType}, ${imageSizeKB}KB`);

  return {
    success: true,
    outputs: [
      {
        type: "image",
        data: dataUrl,
      },
    ],
  };
}
