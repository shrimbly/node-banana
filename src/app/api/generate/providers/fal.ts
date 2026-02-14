/**
 * fal.ai Provider for Generate API Route
 *
 * Handles image/video generation using fal.ai's Queue API.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";
import {
  INPUT_PATTERNS,
  InputMapping,
  ParameterTypeInfo,
  coerceParameterTypes,
} from "../schemaUtils";

/**
 * Extended input mapping with parameter types for fal.ai
 */
interface FalInputMapping extends InputMapping {
  parameterTypes: ParameterTypeInfo;
}

/**
 * In-memory cache for fal.ai schema mappings to avoid extra API call per generation
 */
const falInputMappingCache = new Map<string, { result: FalInputMapping; timestamp: number }>();
const FAL_MAPPING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/** Clear the fal schema mapping cache (exported for testing) */
export function clearFalInputMappingCache() {
  falInputMappingCache.clear();
}

/**
 * Fetch fal.ai model schema and extract input parameter mappings
 * Uses the Model Search API with OpenAPI expansion (same as /api/models/[modelId])
 * Results are cached in-memory for 30 minutes per model.
 */
async function getFalInputMapping(modelId: string, apiKey: string | null): Promise<FalInputMapping> {
  // Check cache first
  const cached = falInputMappingCache.get(modelId);
  if (cached && Date.now() - cached.timestamp < FAL_MAPPING_CACHE_TTL) {
    return cached.result;
  }
  const paramMap: Record<string, string> = {};
  const arrayParams = new Set<string>();
  const schemaArrayParams = new Set<string>();
  const parameterTypes: ParameterTypeInfo = {};

  try {
    // Use fal.ai Model Search API with OpenAPI expansion
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Key ${apiKey}`;
    }

    const url = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    }

    const data = await response.json();
    const modelData = data.models?.[0];
    if (!modelData?.openapi) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    }

    // Extract input schema from OpenAPI spec (same logic as /api/models/[modelId])
    const spec = modelData.openapi;
    let inputSchema: Record<string, unknown> | null = null;

    for (const pathObj of Object.values(spec.paths || {})) {
      const postOp = (pathObj as Record<string, unknown>)?.post as Record<string, unknown> | undefined;
      const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
      const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
      const jsonContent = content?.["application/json"];

      if (jsonContent?.schema) {
        const schema = jsonContent.schema as Record<string, unknown>;
        if (schema.$ref && typeof schema.$ref === "string") {
          const refPath = schema.$ref.replace("#/components/schemas/", "");
          inputSchema = spec.components?.schemas?.[refPath] as Record<string, unknown>;
          break;
        } else if (schema.properties) {
          inputSchema = schema;
          break;
        }
      }
    }

    if (!inputSchema) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    }

    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    if (!properties) return { paramMap, arrayParams, schemaArrayParams, parameterTypes };

    // First pass: detect all array-typed properties and extract parameter types
    // This is used for dynamicInputs which use schema names directly
    for (const [propName, prop] of Object.entries(properties)) {
      const property = prop as Record<string, unknown>;
      if (property?.type === "array") {
        schemaArrayParams.add(propName);
      }
      // Extract parameter type for type coercion
      const type = property?.type as string | undefined;
      if (type && ["string", "integer", "number", "boolean", "array", "object"].includes(type)) {
        parameterTypes[propName] = type as ParameterTypeInfo[string];
      }
    }

    // Second pass: match properties to INPUT_PATTERNS and detect array types
    const propertyNames = Object.keys(properties);
    for (const [genericName, patterns] of Object.entries(INPUT_PATTERNS)) {
      for (const pattern of patterns) {
        let matchedParam: string | null = null;

        // Check for exact match first
        if (properties[pattern]) {
          matchedParam = pattern;
        } else {
          // Check for case-insensitive partial match
          const match = propertyNames.find(name =>
            name.toLowerCase().includes(pattern.toLowerCase()) ||
            pattern.toLowerCase().includes(name.toLowerCase())
          );
          if (match) {
            matchedParam = match;
          }
        }

        if (matchedParam) {
          paramMap[genericName] = matchedParam;
          // Check if this property expects an array type
          const property = properties[matchedParam] as Record<string, unknown>;
          if (property?.type === "array") {
            arrayParams.add(genericName);
          }
          break;
        }
      }
    }

    const result = { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    falInputMappingCache.set(modelId, { result, timestamp: Date.now() });
    return result;
  } catch {
    // Schema parsing failed - return defaults without caching so next call retries
    return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
  }
}

export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MB

/**
 * Upload a base64 data URL image to fal.ai CDN storage.
 * Returns the CDN URL to use in API requests instead of inline base64.
 * If the input is already a URL (not base64), returns it as-is.
 */
export async function uploadImageToFal(base64DataUrl: string, apiKey: string | null): Promise<string> {
  // Already a URL, not base64
  if (!base64DataUrl.startsWith("data:")) return base64DataUrl;

  const match = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return base64DataUrl;

  const estimatedBytes = Math.ceil(match[2].length * 3 / 4);
  if (estimatedBytes > MAX_UPLOAD_SIZE) {
    throw new Error(`Image too large to upload (${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB, max ${MAX_UPLOAD_SIZE / (1024 * 1024)} MB)`);
  }

  const contentType = match[1];
  const binaryData = Buffer.from(match[2], "base64");

  const authHeaders: Record<string, string> = {};
  if (apiKey) authHeaders["Authorization"] = `Key ${apiKey}`;

  // Step 1: Initiate upload to get a signed PUT URL
  const ext = contentType.split("/")[1] || "png";
  const initiateResponse = await fetch(
    "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({
        content_type: contentType,
        file_name: `${Date.now()}.${ext}`,
      }),
    }
  );

  if (!initiateResponse.ok) {
    throw new Error(`Failed to initiate fal CDN upload: ${initiateResponse.status}`);
  }

  const { upload_url: uploadUrl, file_url: fileUrl } = await initiateResponse.json();

  // Validate both URLs before using them (SSRF protection)
  if (!uploadUrl || !fileUrl) {
    throw new Error("fal CDN initiate response missing upload_url or file_url");
  }

  const uploadUrlCheck = validateMediaUrl(uploadUrl);
  if (!uploadUrlCheck.valid || !uploadUrl.startsWith('https://')) {
    throw new Error(`fal CDN upload_url failed validation: ${uploadUrlCheck.error || 'not HTTPS'}`);
  }

  const fileUrlCheck = validateMediaUrl(fileUrl);
  if (!fileUrlCheck.valid || !fileUrl.startsWith('https://')) {
    throw new Error(`fal CDN file_url failed validation: ${fileUrlCheck.error || 'not HTTPS'}`);
  }

  // Step 2: PUT the binary data to the validated signed URL
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: binaryData,
  });

  if (!putResponse.ok) {
    throw new Error(`Failed to upload to fal CDN: ${putResponse.status}`);
  }

  return fileUrl;
}

/**
 * Generate using fal.ai Queue API
 * Uses async queue submission + polling (1s interval) instead of blocking fal.run.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */
export async function generateWithFalQueue(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] fal.ai queue generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;
  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}, API key: ${apiKey ? "yes" : "no"}`);

  // Fetch schema for type coercion and input mapping (cached)
  const { paramMap, arrayParams, schemaArrayParams, parameterTypes } = await getFalInputMapping(modelId, apiKey);

  // Build request body - parameters are applied per-path below to avoid double-spreading
  const requestBody: Record<string, unknown> = {};

  // Upload base64 images to fal CDN to avoid sending large payloads inline
  const uploadImage = async (value: string | string[]): Promise<string | string[]> => {
    if (Array.isArray(value)) {
      return Promise.all(value.map(v => typeof v === "string" && v.startsWith("data:") ? uploadImageToFal(v, apiKey) : Promise.resolve(v)));
    }
    if (typeof value === "string" && value.startsWith("data:")) {
      return uploadImageToFal(value, apiKey);
    }
    return value;
  };

  if (hasDynamicInputs) {
    // Apply coerced parameters first, then dynamic inputs override
    Object.assign(requestBody, coerceParameterTypes(input.parameters, parameterTypes));
    const filteredInputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        let processedValue: unknown = value;
        // Upload base64 images to CDN
        if (typeof value === "string" || Array.isArray(value)) {
          processedValue = await uploadImage(value);
        }
        // Wrap in array if schema expects array but we have a single value
        if (schemaArrayParams.has(key) && !Array.isArray(processedValue)) {
          filteredInputs[key] = [processedValue];
        } else {
          filteredInputs[key] = processedValue;
        }
      }
    }
    Object.assign(requestBody, filteredInputs);
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      requestBody[promptParam] = input.prompt;
    }

    if (input.images && input.images.length > 0) {
      // Upload images to CDN before sending
      const uploadedImages = await Promise.all(
        input.images.map(img => uploadImageToFal(img, apiKey))
      );
      const imageParam = paramMap.image || "image_url";
      if (arrayParams.has("image")) {
        requestBody[imageParam] = uploadedImages;
      } else {
        requestBody[imageParam] = uploadedImages[0];
      }
    }

    // Map any parameters that might need renaming (use coerced values)
    const coercedParams = coerceParameterTypes(input.parameters, parameterTypes);
    for (const [key, value] of Object.entries(coercedParams)) {
      const mappedKey = paramMap[key] || key;
      requestBody[mappedKey] = value;
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
  }

  // Submit to queue
  console.log(`[API:${requestId}] Submitting to fal.ai queue with inputs: ${Object.keys(requestBody).join(", ")}`);
  const submitResponse = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (typeof errorJson.error === 'object' && errorJson.error?.message) {
        errorDetail = errorJson.error.message;
      } else if (errorJson.detail) {
        if (Array.isArray(errorJson.detail)) {
          errorDetail = errorJson.detail.map((d: { msg?: string; loc?: string[] }) =>
            d.msg || JSON.stringify(d)
          ).join('; ');
        } else {
          errorDetail = errorJson.detail;
        }
      } else if (errorJson.message) {
        errorDetail = errorJson.message;
      } else if (typeof errorJson.error === 'string') {
        errorDetail = errorJson.error;
      }
    } catch {
      // Keep original text if not JSON
    }

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. ${apiKey ? "Try again in a moment." : "Add an API key in settings for higher limits."}`,
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
    };
  }

  const submitResult = await submitResponse.json();
  console.log(`[API:${requestId}] Queue submit response:`, JSON.stringify(submitResult).substring(0, 500));
  const falRequestId = submitResult.request_id;

  if (!falRequestId) {
    console.error(`[API:${requestId}] No request_id in queue submit response`);
    return {
      success: false,
      error: "No request_id in queue response",
    };
  }

  // Use URLs from response if provided, with SSRF validation; fall back to constructed URLs
  const fallbackStatusUrl = `https://queue.fal.run/${modelId}/requests/${falRequestId}/status`;
  const fallbackResponseUrl = `https://queue.fal.run/${modelId}/requests/${falRequestId}`;
  let statusUrl = fallbackStatusUrl;
  let responseUrl = fallbackResponseUrl;

  if (submitResult.status_url) {
    const statusCheck = validateMediaUrl(submitResult.status_url);
    if (statusCheck.valid && submitResult.status_url.startsWith('https://queue.fal.run/')) {
      statusUrl = submitResult.status_url;
    } else {
      console.warn(`[API:${requestId}] fal.ai provided invalid status URL: ${submitResult.status_url} — falling back to constructed URL`);
    }
  }
  if (submitResult.response_url) {
    const responseCheck = validateMediaUrl(submitResult.response_url);
    if (responseCheck.valid && submitResult.response_url.startsWith('https://queue.fal.run/')) {
      responseUrl = submitResult.response_url;
    } else {
      console.warn(`[API:${requestId}] fal.ai provided invalid response URL: ${submitResult.response_url} — falling back to constructed URL`);
    }
  }

  console.log(`[API:${requestId}] Queue request submitted: ${falRequestId}, status URL: ${statusUrl}`);

  // Poll for completion
  const maxWaitTime = 10 * 60 * 1000; // 10 minutes for video
  const pollInterval = 1000; // 1 second (matches Replicate/WaveSpeed)
  const startTime = Date.now();
  let lastStatus = "";

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] Queue request timed out after 10 minutes`);
      return {
        success: false,
        error: `${input.model.name}: Video generation timed out after 10 minutes`,
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(
      statusUrl,
      { headers: apiKey ? { "Authorization": `Key ${apiKey}` } : {} }
    );

    if (!statusResponse.ok) {
      console.error(`[API:${requestId}] Failed to poll status: ${statusResponse.status}`);
      return {
        success: false,
        error: `Failed to poll status: ${statusResponse.status}`,
      };
    }

    const statusResult = await statusResponse.json();
    const status = statusResult.status;

    if (status !== lastStatus) {
      console.log(`[API:${requestId}] Queue status: ${status}`);
      lastStatus = status;
    }

    if (status === "COMPLETED") {
      // Fetch the result
      const resultResponse = await fetch(
        responseUrl,
        { headers: apiKey ? { "Authorization": `Key ${apiKey}` } : {} }
      );

      if (!resultResponse.ok) {
        console.error(`[API:${requestId}] Failed to fetch result: ${resultResponse.status}`);
        return {
          success: false,
          error: `Failed to fetch result: ${resultResponse.status}`,
        };
      }

      const result = await resultResponse.json();

      // Extract media URL from result
      let mediaUrl: string | null = null;

      // Check for 3D model output (GLB mesh) — must check before images
      if (result.model_mesh?.url) {
        mediaUrl = result.model_mesh.url;
      } else if (result.mesh?.url) {
        mediaUrl = result.mesh.url;
      } else if (result.glb?.url) {
        mediaUrl = result.glb.url;
      } else if (result.video && result.video.url) {
        mediaUrl = result.video.url;
      } else if (result.images && Array.isArray(result.images) && result.images.length > 0) {
        mediaUrl = result.images[0].url;
      } else if (result.image && result.image.url) {
        mediaUrl = result.image.url;
      } else if (result.output && typeof result.output === "string") {
        mediaUrl = result.output;
      }

      if (!mediaUrl) {
        console.error(`[API:${requestId}] No media URL found in queue result`);
        return {
          success: false,
          error: "No media URL in response",
        };
      }

      // Validate URL before fetching (SSRF protection)
      const mediaUrlCheck = validateMediaUrl(mediaUrl);
      if (!mediaUrlCheck.valid) {
        return { success: false, error: `Invalid media URL: ${mediaUrlCheck.error}` };
      }

      // Fetch the media and convert to base64
      console.log(`[API:${requestId}] Fetching output from: ${mediaUrl.substring(0, 80)}...`);
      const mediaResponse = await fetch(mediaUrl);

      if (!mediaResponse.ok) {
        return {
          success: false,
          error: `Failed to fetch output: ${mediaResponse.status}`,
        };
      }

      const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
      const isVideoModel = input.model.capabilities.some(c => c.includes("video"));

      // For 3D models, return URL directly (GLB files are binary — don't base64 encode)
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

      const contentType = mediaResponse.headers.get("content-type") || (isVideoModel ? "video/mp4" : "image/png");
      const isVideo = contentType.startsWith("video/");

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

    if (status === "FAILED") {
      const errorMessage = statusResult.error || "Video generation failed";
      console.error(`[API:${requestId}] Queue request failed: ${errorMessage}`);
      return {
        success: false,
        error: `${input.model.name}: ${errorMessage}`,
      };
    }

    // Continue polling for IN_QUEUE, IN_PROGRESS, etc.
  }
}
