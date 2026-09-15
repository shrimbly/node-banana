/**
 * Replicate Provider for Generate API Route
 *
 * Handles image/video generation using Replicate's prediction API.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";
import {
  getParameterTypesFromSchema,
  coerceParameterTypes,
  getInputMappingFromSchema,
} from "../schemaUtils";

/**
 * Generate image using Replicate API
 */
export async function generateWithReplicate(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] Replicate generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const REPLICATE_API_BASE = "https://api.replicate.com/v1";

  // Get the latest version of the model
  const modelId = input.model.id;
  const [owner, name] = modelId.split("/");

  if (!owner || !name) {
    return {
      success: false,
      error: `Invalid Replicate model ID "${modelId}": expected "owner/name" format`,
    };
  }

  // First, get the model to find the latest version
  const modelResponse = await fetch(
    `${REPLICATE_API_BASE}/models/${owner}/${name}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!modelResponse.ok) {
    return {
      success: false,
      error: `Failed to get model info: ${modelResponse.status}`,
    };
  }

  const modelData = await modelResponse.json();
  const version = modelData.latest_version?.id;

  if (!version) {
    return {
      success: false,
      error: "Model has no available version",
    };
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Model version: ${version}, Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Get schema for type coercion and input mapping
  const schema = modelData.latest_version?.openapi_schema as Record<string, unknown> | undefined;
  const parameterTypes = getParameterTypesFromSchema(schema);
  const parameters = coerceParameterTypes(input.parameters, parameterTypes);
  // Replicate rejects null arrays even for schemas advertising nullable:true
  // (e.g. Reve 2.1). Treat saved null defaults as unset; keep real arrays intact.
  for (const [key, value] of Object.entries(parameters)) {
    if (value === null && parameterTypes[key] === "array") delete parameters[key];
  }

  // Build input for the prediction - parameters are applied per-path below to avoid double-spreading
  const predictionInput: Record<string, unknown> = {};

  // Add dynamic inputs if provided (these come from schema-mapped connections)
  if (hasDynamicInputs) {
    // Apply coerced parameters first, then dynamic inputs override
    Object.assign(predictionInput, parameters);
    const { paramMap, schemaArrayParams } = getInputMappingFromSchema(schema);

    // Apply array wrapping based on schema type
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        if (schemaArrayParams.has(key) && !Array.isArray(value)) {
          predictionInput[key] = [value];  // Wrap in array
        } else if (!schemaArrayParams.has(key) && Array.isArray(value)) {
          predictionInput[key] = value[0];  // Unwrap array to single value
        } else {
          predictionInput[key] = value;
        }
      }
    }

    // Ensure prompt is included even when dynamicInputs are present
    // (executor sends prompt as top-level field, not in dynamicInputs)
    const promptParam = paramMap.prompt || "prompt";
    if (input.prompt && !predictionInput[promptParam]) {
      predictionInput[promptParam] = input.prompt;
    }
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    const { paramMap, arrayParams } = getInputMappingFromSchema(schema);

    // Apply saved settings first so live connections cannot be overwritten by
    // stale defaults left in workflows created before a schema was recognised.
    for (const [key, value] of Object.entries(parameters)) {
      const mappedKey = paramMap[key] || key;
      predictionInput[mappedKey] = value;
    }

    // Map prompt input
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      predictionInput[promptParam] = input.prompt;
    }

    // Map image input - use array or string format based on schema
    if (input.images && input.images.length > 0) {
      const imageParam = paramMap.image || "image";
      if (arrayParams.has("image")) {
        predictionInput[imageParam] = input.images;
      } else {
        predictionInput[imageParam] = input.images[0];
      }
    }
  }

  // Create a prediction
  const createResponse = await fetch(`${REPLICATE_API_BASE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version,
      input: predictionInput,
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.detail || errorJson.message || errorJson.error || errorText;
    } catch {
      // Keep original text if not JSON
    }

    // Handle rate limits
    if (createResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. Try again in a moment.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
    };
  }

  const prediction = await createResponse.json();
  console.log(`[API:${requestId}] Prediction created: ${prediction.id}`);

  // Poll for completion — video models get a longer timeout
  const isVideoModel = input.model.capabilities.some(c => c.includes("video"));
  const maxWaitTime = isVideoModel ? 10 * 60 * 1000 : 5 * 60 * 1000;
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();

  let currentPrediction = prediction;
  let lastStatus = "";

  while (
    currentPrediction.status !== "succeeded" &&
    currentPrediction.status !== "failed" &&
    currentPrediction.status !== "canceled"
  ) {
    if (Date.now() - startTime > maxWaitTime) {
      return {
        success: false,
        error: `${input.model.name}: Generation timed out after ${maxWaitTime / 60000} minutes.`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const pollResponse = await fetch(
      `${REPLICATE_API_BASE}/predictions/${currentPrediction.id}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!pollResponse.ok) {
      return {
        success: false,
        error: `Failed to poll prediction: ${pollResponse.status}`,
      };
    }

    currentPrediction = await pollResponse.json();
    if (currentPrediction.status !== lastStatus) {
      console.log(`[API:${requestId}] Prediction status: ${currentPrediction.status}`);
      lastStatus = currentPrediction.status;
    }
  }

  if (currentPrediction.status === "failed") {
    const failureReason = currentPrediction.error || "Prediction failed";
    return {
      success: false,
      error: `${input.model.name}: ${failureReason}`,
    };
  }

  if (currentPrediction.status === "canceled") {
    return {
      success: false,
      error: "Prediction was canceled",
    };
  }

  // Extract output
  const output = currentPrediction.output;
  if (!output) {
    return {
      success: false,
      error: "No output from prediction",
    };
  }

  // Output can be a single URL string or an array — filter to valid strings only
  const rawOutputs = Array.isArray(output) ? output : [output];
  const outputUrls: string[] = rawOutputs.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );

  if (outputUrls.length === 0) {
    return {
      success: false,
      error: "No output from prediction",
    };
  }

  // Fetch the first output and convert to base64
  const mediaUrl = outputUrls[0];

  // Validate URL before fetching (SSRF protection)
  const mediaUrlCheck = validateMediaUrl(mediaUrl);
  if (!mediaUrlCheck.valid) {
    console.error(`[API:${requestId}] Invalid media URL from Replicate: ${mediaUrl}`);
    return { success: false, error: `Invalid media URL: ${mediaUrlCheck.error}` };
  }

  // Check if this is a 3D model — return URL directly (GLB files are binary).
  // Short-circuit before fetching so we never download the potentially large GLB binary.
  const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
  if (is3DModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return {
      success: true,
      outputs: [
        {
          type: "3d",
          data: "",
          url: mediaUrl,
        },
      ],
    };
  }

  console.log(`[API:${requestId}] Fetching output from: ${mediaUrl.substring(0, 80)}...`);
  const mediaResponse = await fetch(mediaUrl);

  if (!mediaResponse.ok) {
    return {
      success: false,
      error: `Failed to fetch output: ${mediaResponse.status}`,
    };
  }

  // Determine MIME type from response
  const contentType = mediaResponse.headers.get("content-type") || "image/png";
  const isVideo = contentType.startsWith("video/");
  const isConcreteMedia = contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType.startsWith("image/");
  const isAudio = contentType.startsWith("audio/") ||
    (!isConcreteMedia && input.model.capabilities.some(c => c.includes("audio")));

  const mediaArrayBuffer = await mediaResponse.arrayBuffer();
  const mediaSizeBytes = mediaArrayBuffer.byteLength;
  const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

  console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL only (data left empty for consumers)
  if (isVideo && mediaSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: "",
          url: mediaUrl,
        },
      ],
    };
  }

  const mediaBase64 = Buffer.from(mediaArrayBuffer).toString("base64");

  if (isAudio) {
    const audioContentType = contentType.startsWith("audio/") ? contentType : "audio/mpeg";
    console.log(`[API:${requestId}] SUCCESS - Returning audio`);
    return {
      success: true,
      outputs: [
        {
          type: "audio",
          data: `data:${audioContentType};base64,${mediaBase64}`,
          url: mediaUrl,
        },
      ],
    };
  }

  console.log(`[API:${requestId}] SUCCESS - Returning ${isVideo ? "video" : "image"}`);

  return {
    success: true,
    outputs: [
      {
        type: isVideo ? "video" : "image",
        data: `data:${contentType};base64,${mediaBase64}`,
        url: mediaUrl,
      },
    ],
  };
}
