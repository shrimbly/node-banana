/**
 * WaveSpeed Provider for Generate API Route
 *
 * Handles image/video generation using WaveSpeed API.
 * Uses async task submission + polling.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";

type WaveSpeedStatus = "created" | "pending" | "processing" | "completed" | "failed";

/**
 * WaveSpeed submit response
 * Format: { code: 200, message: "success", data: { id, model, status, urls, created_at } }
 */
interface WaveSpeedSubmitResponse {
  code?: number;
  message?: string;
  data?: {
    id: string;
    model?: string;
    status?: WaveSpeedStatus;
    urls?: {
      get?: string;
    };
    created_at?: string;
  };
  // Fallback fields for other response formats
  id?: string;
  status?: WaveSpeedStatus;
  error?: string;
}

/**
 * WaveSpeed prediction/poll response (inner data object)
 */
interface WaveSpeedPredictionData {
  id: string;
  status: WaveSpeedStatus;
  outputs?: string[];
  output?: {
    images?: string[];
    videos?: string[];
  };
  timings?: {
    inference?: number;
  };
  created_at?: string;
  error?: string;
}

/**
 * WaveSpeed prediction/poll response wrapper
 * Format: { code: 200, message: "success", data: { id, status, outputs, ... } }
 */
interface WaveSpeedPredictionResponse {
  code?: number;
  message?: string;
  data?: WaveSpeedPredictionData;
  // Fallback: some responses might have fields at top level
  id?: string;
  status?: WaveSpeedStatus;
  outputs?: string[];
  error?: string;
}

/**
 * Generate image/video using WaveSpeed API
 * Uses async task submission + polling
 */
export async function generateWithWaveSpeed(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] WaveSpeed generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";
  const modelId = input.model.id;

  // Validate modelId to prevent path traversal
  if (/[^a-zA-Z0-9\-_/.]/.test(modelId) || modelId.includes('..')) {
    return { success: false, error: `Invalid model ID: ${modelId}` };
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Determine output type from model capabilities
  const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
  const isVideoModel = input.model.capabilities.includes("text-to-video") ||
                       input.model.capabilities.includes("image-to-video");

  // Build WaveSpeed payload — spread parameters first so explicit prompt wins
  const payload: Record<string, unknown> = {
    ...input.parameters,
    prompt: input.prompt,
  };

  // Apply dynamic inputs (schema-mapped connections)
  // These have the correct parameter names from the schema (e.g., "images" for edit models)
  if (hasDynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        // If the key is "images" and value is not an array, wrap it
        if (key === "images" && !Array.isArray(value)) {
          payload[key] = [value];
        } else {
          payload[key] = value;
        }
      }
    }
  } else if (input.images && input.images.length > 0) {
    // Fallback: if no dynamic inputs but images array is provided
    // Use "image" for single image (default WaveSpeed format)
    payload.image = input.images[0];
  }

  console.log(`[API:${requestId}] Submitting to WaveSpeed with inputs: ${Object.keys(payload).join(", ")}`);

  // Submit task
  // Model ID goes directly in the URL path (slashes are part of the path)
  const submitUrl = `${WAVESPEED_API_BASE}/${modelId}`;
  console.log(`[API:${requestId}] WaveSpeed submit URL: ${submitUrl}`);

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error || errorJson.message || errorJson.detail || errorText || `HTTP ${submitResponse.status}`;
    } catch {
      // Keep original text
    }

    console.error(`[API:${requestId}] WaveSpeed submit failed: ${submitResponse.status} - ${errorDetail}`);

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name || 'WaveSpeed'}: Rate limit exceeded. Try again in a moment.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name || 'WaveSpeed'}: ${errorDetail}`,
    };
  }

  const submitResult: WaveSpeedSubmitResponse = await submitResponse.json();
  console.log(`[API:${requestId}] WaveSpeed submit response:`, JSON.stringify(submitResult).substring(0, 500));

  const taskId = submitResult.data?.id || submitResult.id;
  // Use the polling URL provided by the API if available, with SSRF validation
  let providedPollUrl: string | undefined = submitResult.data?.urls?.get;
  if (providedPollUrl) {
    const pollUrlCheck = validateMediaUrl(providedPollUrl);
    if (!pollUrlCheck.valid || !providedPollUrl.startsWith('https://api.wavespeed.ai')) {
      console.warn(`[API:${requestId}] WaveSpeed provided invalid poll URL: ${providedPollUrl} — falling back to constructed URL`);
      providedPollUrl = undefined;
    }
  }

  if (!taskId) {
    console.error(`[API:${requestId}] No task ID in WaveSpeed submit response`);
    return {
      success: false,
      error: "WaveSpeed: No task ID returned from API",
    };
  }

  console.log(`[API:${requestId}] WaveSpeed task submitted: ${taskId}`);
  if (providedPollUrl) {
    console.log(`[API:${requestId}] WaveSpeed provided poll URL: ${providedPollUrl}`);
  }

  // Poll for completion using the URL from the API response, or construct it
  // Status flow: created → processing → completed/failed
  const maxWaitTime = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();
  let lastStatus = "";

  let resultData: WaveSpeedPredictionResponse | null = null;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] WaveSpeed task timed out after 5 minutes`);
      return {
        success: false,
        error: `${input.model.name}: Generation timed out after 5 minutes`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    // Use provided poll URL if available, otherwise construct it
    const pollUrl = providedPollUrl || `${WAVESPEED_API_BASE}/predictions/${taskId}/result`;
    const pollResponse = await fetch(
      pollUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    // Log poll response status for debugging
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    console.log(`[API:${requestId}] WaveSpeed poll (${elapsedSec}s): ${pollResponse.status} from ${pollUrl}`);

    // 404 means result not ready yet - continue polling
    if (pollResponse.status === 404) {
      lastStatus = "pending";
      continue;
    }

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      let errorDetail = errorText || `HTTP ${pollResponse.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorDetail = errorJson.error || errorJson.message || errorJson.detail || errorDetail;
      } catch {
        // Keep original text
      }
      console.error(`[API:${requestId}] WaveSpeed poll failed: ${pollResponse.status} - ${errorDetail}`);
      return {
        success: false,
        error: `${input.model.name}: ${errorDetail}`,
      };
    }

    const pollData: WaveSpeedPredictionResponse = await pollResponse.json();
    console.log(`[API:${requestId}] WaveSpeed poll data:`, JSON.stringify(pollData).substring(0, 300));

    // Extract status from nested data object (WaveSpeed wraps response in { code, message, data: {...} })
    const currentStatus = pollData.data?.status || pollData.status;
    const currentError = pollData.data?.error || pollData.error;

    // Log status changes
    if (currentStatus !== lastStatus) {
      console.log(`[API:${requestId}] WaveSpeed status changed: ${lastStatus} → ${currentStatus}`);
      lastStatus = currentStatus || "";
    }

    // Check if task is complete
    if (currentStatus === "completed") {
      console.log(`[API:${requestId}] WaveSpeed task completed`);
      resultData = pollData;
      break;
    }

    // Check if task failed
    if (currentStatus === "failed") {
      const failureReason = currentError || pollData.message || "Generation failed";
      console.error(`[API:${requestId}] WaveSpeed task failed: ${failureReason}`);
      return {
        success: false,
        error: `${input.model.name}: ${failureReason}`,
      };
    }

    // Continue polling for "created" or "processing" status
  }

  // Safety check (should never happen since we break on completed)
  if (!resultData) {
    return {
      success: false,
      error: `${input.model.name}: No result received`,
    };
  }

  // Extract outputs - WaveSpeed wraps response in { code, message, data: { outputs: [...] } }
  let outputUrls: string[] = [];
  const resultDataInner = resultData.data;

  // Format 1: data.outputs array (standard WaveSpeed format)
  if (resultDataInner?.outputs && Array.isArray(resultDataInner.outputs) && resultDataInner.outputs.length > 0) {
    outputUrls = resultDataInner.outputs;
  }
  // Format 2: data.output object with images/videos arrays
  else if (resultDataInner?.output) {
    if (isVideoModel && resultDataInner.output.videos && resultDataInner.output.videos.length > 0) {
      outputUrls = resultDataInner.output.videos;
    } else if (resultDataInner.output.images && resultDataInner.output.images.length > 0) {
      outputUrls = resultDataInner.output.images;
    }
  }
  // Format 3: Fallback - outputs at top level (unlikely but safe)
  else if (resultData.outputs && Array.isArray(resultData.outputs) && resultData.outputs.length > 0) {
    outputUrls = resultData.outputs;
  }

  if (outputUrls.length === 0) {
    console.error(`[API:${requestId}] No outputs in WaveSpeed result. Response:`, JSON.stringify(resultData).substring(0, 500));
    return {
      success: false,
      error: `${input.model.name}: No outputs in generation result`,
    };
  }

  // Fetch the first output and convert to base64
  const outputUrl = outputUrls[0];

  // Validate URL before fetching
  const outputUrlCheck = validateMediaUrl(outputUrl);
  if (!outputUrlCheck.valid) {
    return { success: false, error: `Invalid output URL: ${outputUrlCheck.error}` };
  }

  console.log(`[API:${requestId}] Fetching WaveSpeed output from: ${outputUrl.substring(0, 80)}...`);

  const outputResponse = await fetch(outputUrl);

  if (!outputResponse.ok) {
    return {
      success: false,
      error: `Failed to fetch output: ${outputResponse.status}`,
    };
  }

  // Check file size before downloading body
  const MAX_MEDIA_SIZE_WS = 500 * 1024 * 1024; // 500MB
  const wsContentLength = parseInt(outputResponse.headers.get("content-length") || "0", 10);
  if (!isNaN(wsContentLength) && wsContentLength > MAX_MEDIA_SIZE_WS) {
    return { success: false, error: `Media too large: ${(wsContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }

  const outputArrayBuffer = await outputResponse.arrayBuffer();
  if (outputArrayBuffer.byteLength > MAX_MEDIA_SIZE_WS) {
    return { success: false, error: `Media too large: ${(outputArrayBuffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }
  const outputSizeMB = outputArrayBuffer.byteLength / (1024 * 1024);

  // For 3D models, return URL directly (GLB files are binary — don't base64 encode)
  if (is3DModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return {
      success: true,
      outputs: [
        {
          type: "3d",
          data: "",
          url: outputUrl,
        },
      ],
    };
  }

  const rawContentType = outputResponse.headers.get("content-type");
  const contentType =
    (rawContentType && (rawContentType.startsWith("video/") || rawContentType.startsWith("image/")))
      ? rawContentType
      : (isVideoModel ? "video/mp4" : "image/png");

  console.log(`[API:${requestId}] Output: ${contentType}, ${outputSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL only (data left empty for consumers)
  if (isVideoModel && outputSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: "",
          url: outputUrl,
        },
      ],
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

