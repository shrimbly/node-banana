/**
 * Atlas Cloud Provider for Generate API Route
 *
 * Handles image/video generation using Atlas Cloud's media API.
 * Uses async task submission + polling, the same shape as the WaveSpeed
 * provider, with three Atlas-specific differences:
 *   - the model id travels in the request body, not the URL path
 *   - input images travel in one newline-separated `images` field
 *   - the endpoint is chosen from the model's capabilities
 *     (/generateImage vs /generateVideo)
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";

type AtlasStatus = "processing" | "queued" | "pending" | "starting" | "completed" | "failed";

/** Atlas submit response: { code, message, data: { id, status, urls: { get } } } */
interface AtlasSubmitResponse {
  code?: number;
  message?: string;
  msg?: string;
  data?: {
    id?: string;
    status?: AtlasStatus;
    urls?: { get?: string };
  };
}

/** Atlas prediction response: { code, message, data: { id, status, outputs, error } } */
interface AtlasPredictionResponse {
  code?: number;
  message?: string;
  msg?: string;
  data?: {
    id?: string;
    status?: AtlasStatus;
    outputs?: string[] | null;
    error?: string;
  };
}

const ATLAS_API_BASE = "https://api.atlascloud.ai/api/v1/model";
// api.atlascloud.ai answers a missing/default User-Agent with 403 (error code
// 1010), so every request to the API host sends an explicit one. The result CDN
// does not need it.
const ATLAS_USER_AGENT = "node-banana/1";
const ATLAS_MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB, matching the other providers

/**
 * Generate image/video using Atlas Cloud
 * Uses async task submission + polling
 */
export async function generateWithAtlas(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] Atlas generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;

  // Validate modelId — it goes in the request body, but keep the same guard the
  // other providers apply so a malformed id fails before the network call.
  if (/[^a-zA-Z0-9\-_/.]/.test(modelId) || modelId.includes("..")) {
    return { success: false, error: `Invalid model ID: ${modelId}` };
  }

  const isVideoModel =
    input.model.capabilities.includes("text-to-video") ||
    input.model.capabilities.includes("image-to-video") ||
    input.model.capabilities.includes("audio-to-video");

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Build the payload — spread parameters first so the explicit prompt wins
  const payload: Record<string, unknown> = {
    ...input.parameters,
    model: modelId,
    prompt: input.prompt,
  };

  // Atlas takes every input image in ONE newline-separated field, so collect
  // images from dynamic inputs and the images array into a single list.
  const collectedImages: string[] = [];
  if (hasDynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value === null || value === undefined || value === "") continue;
      const values = Array.isArray(value) ? value : [value];
      if (key === "images" || key === "image" || key.endsWith("image_url")) {
        collectedImages.push(...values.filter((v): v is string => typeof v === "string" && v !== ""));
      } else {
        payload[key] = Array.isArray(value) ? value[0] : value;
      }
    }
  }
  if (collectedImages.length === 0 && input.images && input.images.length > 0) {
    collectedImages.push(...input.images);
  }
  if (collectedImages.length > 0) {
    payload.images = collectedImages.join("\n");
  }

  // Video models reject an empty shot_type, and Seedance 2.0 generates synced
  // audio by default — a generated score that trips the provider's copyright
  // check fails the whole task — so both get an explicit default here.
  if (isVideoModel) {
    if (payload.shot_type === undefined || payload.shot_type === "") {
      payload.shot_type = "single";
    }
    if (payload.generate_audio === undefined) {
      payload.generate_audio = false;
    }
  }

  // Size controls differ per model family: nano-banana models ignore `size` and
  // honour `aspect_ratio`; seedream models honour `size` in `width*height` form.
  if (typeof payload.size === "string" && payload.size.includes("x")) {
    payload.size = (payload.size as string).replace("x", "*");
  }
  if (modelId.includes("nano-banana") && payload.size) {
    console.log(`[API:${requestId}] ${modelId} ignores size; dropping it in favour of aspect_ratio`);
    delete payload.size;
  }

  const endpoint = isVideoModel ? "generateVideo" : "generateImage";
  const submitUrl = `${ATLAS_API_BASE}/${endpoint}`;
  console.log(`[API:${requestId}] Atlas submit URL: ${submitUrl} with inputs: ${Object.keys(payload).join(", ")}`);

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": ATLAS_USER_AGENT,
    },
    body: JSON.stringify(payload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error || errorJson.message || errorJson.msg || errorText || `HTTP ${submitResponse.status}`;
    } catch {
      // Keep original text
    }

    console.error(`[API:${requestId}] Atlas submit failed: ${submitResponse.status} - ${errorDetail}`);

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name || "Atlas"}: Rate limit exceeded. Try again in a moment.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name || "Atlas"}: ${errorDetail}`,
    };
  }

  const submitResult: AtlasSubmitResponse = await submitResponse.json();
  console.log(`[API:${requestId}] Atlas submit response:`, JSON.stringify(submitResult).substring(0, 500));

  const taskId = submitResult.data?.id;
  if (!taskId) {
    console.error(`[API:${requestId}] No prediction ID in Atlas submit response`);
    return {
      success: false,
      error: "Atlas: No prediction ID returned from API",
    };
  }

  // Prefer the polling URL the API hands back, with the same SSRF guard the
  // WaveSpeed provider applies to its own host.
  let providedPollUrl: string | undefined = submitResult.data?.urls?.get;
  if (providedPollUrl) {
    const pollUrlCheck = validateMediaUrl(providedPollUrl);
    if (!pollUrlCheck.valid || !providedPollUrl.startsWith("https://api.atlascloud.ai")) {
      console.warn(`[API:${requestId}] Atlas provided invalid poll URL: ${providedPollUrl} — falling back to constructed URL`);
      providedPollUrl = undefined;
    }
  }

  console.log(`[API:${requestId}] Atlas prediction submitted: ${taskId}`);

  // Poll for completion. Status flow: processing → completed/failed.
  // Video generation routinely takes minutes, so the ceiling matches the
  // slowest provider here rather than the image-only case.
  const maxWaitTime = 10 * 60 * 1000; // 10 minutes
  const pollInterval = 3000; // 3 seconds — the API is not a per-second endpoint
  const startTime = Date.now();
  let lastStatus = "";
  let resultData: AtlasPredictionResponse | null = null;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] Atlas prediction timed out after 10 minutes`);
      return {
        success: false,
        error: `${input.model.name}: Generation timed out after 10 minutes`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const pollUrl = providedPollUrl || `${ATLAS_API_BASE}/prediction/${encodeURIComponent(taskId)}`;
      const pollResponse = await fetch(pollUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": ATLAS_USER_AGENT,
        },
      });

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      console.log(`[API:${requestId}] Atlas poll (${elapsedSec}s): ${pollResponse.status}`);

      if (pollResponse.status === 404) {
        lastStatus = "pending";
        continue;
      }

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        let errorDetail = errorText || `HTTP ${pollResponse.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson.error || errorJson.message || errorJson.msg || errorDetail;
        } catch {
          // Keep original text
        }
        console.error(`[API:${requestId}] Atlas poll failed: ${pollResponse.status} - ${errorDetail}`);
        return {
          success: false,
          error: `${input.model.name}: ${errorDetail}`,
        };
      }

      const pollData: AtlasPredictionResponse = await pollResponse.json();
      const currentStatus = pollData.data?.status;
      const currentError = pollData.data?.error;

      if (currentStatus !== lastStatus) {
        console.log(`[API:${requestId}] Atlas status changed: ${lastStatus} → ${currentStatus}`);
        lastStatus = currentStatus || "";
      }

      if (currentStatus === "completed") {
        console.log(`[API:${requestId}] Atlas prediction completed`);
        resultData = pollData;
        break;
      }

      if (currentStatus === "failed") {
        const failureReason = currentError || pollData.message || pollData.msg || "Generation failed";
        console.error(`[API:${requestId}] Atlas prediction failed: ${failureReason}`);
        return {
          success: false,
          error: `${input.model.name}: ${failureReason}`,
        };
      }

      // Continue polling for processing/queued/pending/starting
    } catch (pollError) {
      const message = pollError instanceof Error ? pollError.message : String(pollError);
      console.error(`[API:${requestId}] Atlas poll error: ${message}`);
      return {
        success: false,
        error: `${input.model.name}: ${message}`,
      };
    }
  }

  const outputUrls = resultData?.data?.outputs ?? [];
  if (!Array.isArray(outputUrls) || outputUrls.length === 0) {
    console.error(`[API:${requestId}] No outputs in Atlas result. Response:`, JSON.stringify(resultData).substring(0, 500));
    return {
      success: false,
      error: `${input.model.name}: No outputs in generation result`,
    };
  }

  const outputUrl = outputUrls[0];
  const outputUrlCheck = validateMediaUrl(outputUrl);
  if (!outputUrlCheck.valid) {
    return { success: false, error: `Invalid output URL: ${outputUrlCheck.error}` };
  }

  console.log(`[API:${requestId}] Fetching Atlas output from: ${outputUrl.substring(0, 80)}...`);

  const outputResponse = await fetch(outputUrl);
  if (!outputResponse.ok) {
    return {
      success: false,
      error: `Failed to fetch output: ${outputResponse.status}`,
    };
  }

  const declaredLength = parseInt(outputResponse.headers.get("content-length") || "0", 10);
  if (!isNaN(declaredLength) && declaredLength > ATLAS_MAX_MEDIA_SIZE) {
    return { success: false, error: `Media too large: ${(declaredLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }

  const outputArrayBuffer = await outputResponse.arrayBuffer();
  if (outputArrayBuffer.byteLength > ATLAS_MAX_MEDIA_SIZE) {
    return { success: false, error: `Media too large: ${(outputArrayBuffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }
  const outputSizeMB = outputArrayBuffer.byteLength / (1024 * 1024);

  // The container is not fixed per model — the same Atlas model returned PNG on
  // one call and JPEG on the next — so trust the response header, then the
  // model's modality, rather than assuming from the model id.
  const rawContentType = outputResponse.headers.get("content-type");
  const contentType =
    rawContentType && (rawContentType.startsWith("video/") || rawContentType.startsWith("image/") || rawContentType.startsWith("audio/"))
      ? rawContentType
      : isVideoModel
        ? "video/mp4"
        : "image/png";

  console.log(`[API:${requestId}] Output: ${contentType}, ${outputSizeMB.toFixed(2)}MB`);

  // Match the other providers: very large videos come back as a URL only.
  if (isVideoModel && outputSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [{ type: "video", data: "", url: outputUrl }],
    };
  }

  const outputBase64 = Buffer.from(outputArrayBuffer).toString("base64");

  console.log(`[API:${requestId}] SUCCESS - Returning ${isVideoModel ? "video" : "image"}`);

  return {
    success: true,
    outputs: [
      {
        type: isVideoModel ? "video" : "image",
        data: `data:${contentType};base64,${outputBase64}`,
        url: outputUrl,
      },
    ],
  };
}
