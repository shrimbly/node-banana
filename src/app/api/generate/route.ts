/**
 * Generate API Route
 * 
 * TIMEOUT CONFIGURATION:
 * - maxDuration: Only applies on Vercel, not locally
 * - AbortSignal.timeout: Controls outgoing fetch to providers
 * - For local development, server.requestTimeout must be set in server.js (Node.js default is 5 minutes)
 * 
 * FAL.AI QUEUE API NOTE:
 * The generateWithFalQueue function exists but is NOT used because fal.ai's queue API
 * has file size limitations that are too restrictive for our use case. We use the blocking
 * fal.run endpoint instead, which requires the server timeout to be extended for video generation.
 */
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { GenerateRequest, GenerateResponse, ModelType, SelectedModel, ProviderType } from "@/types";
import { GenerationInput, GenerationOutput, ProviderModel } from "@/lib/providers/types";
import { uploadImageForUrl, shouldUseImageUrl, deleteImages } from "@/lib/images";
import { validateMediaUrl } from "@/utils/urlValidation";

export const maxDuration = 300; // 5 minute timeout (Vercel hobby plan limit)
export const dynamic = 'force-dynamic'; // Ensure this route is always dynamic

// Map model types to Gemini model IDs
const MODEL_MAP: Record<ModelType, string> = {
  "nano-banana": "gemini-2.5-flash-image", // Updated to correct model name
  "nano-banana-pro": "gemini-3-pro-image-preview",
};

/**
 * Extended request format that supports both legacy and multi-provider requests
 */
interface MultiProviderGenerateRequest extends GenerateRequest {
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  /** Dynamic inputs from schema-based connections (e.g., image_url, tail_image_url, prompt) */
  dynamicInputs?: Record<string, string | string[]>;
}

/**
 * Generate image using Gemini API (legacy/default path)
 */
async function generateWithGemini(
  requestId: string,
  apiKey: string,
  prompt: string,
  images: string[],
  model: ModelType,
  aspectRatio?: string,
  resolution?: string,
  useGoogleSearch?: boolean
): Promise<NextResponse<GenerateResponse>> {
  console.log(`[API:${requestId}] Gemini generation - Model: ${model}, Images: ${images?.length || 0}, Prompt: ${prompt?.length || 0} chars`);

  // Extract base64 data and MIME types from data URLs
  const imageData = (images || []).map((image, idx) => {
    if (image.includes("base64,")) {
      const [header, data] = image.split("base64,");
      // Extract MIME type from header (e.g., "data:image/png;" -> "image/png")
      const mimeMatch = header.match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
      console.log(`[API:${requestId}]   Image ${idx + 1}: ${mimeType}, ${(data.length / 1024).toFixed(1)}KB`);
      return { data, mimeType };
    }
    console.log(`[API:${requestId}]   Image ${idx + 1}: raw, ${(image.length / 1024).toFixed(1)}KB`);
    return { data: image, mimeType: "image/png" };
  });

  // Initialize Gemini client
  const ai = new GoogleGenAI({ apiKey });

  // Build request parts array with prompt and all images
  const requestParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
    ...imageData.map(({ data, mimeType }) => ({
      inlineData: {
        mimeType,
        data,
      },
    })),
  ];

  // Build config object based on model capabilities
  const config: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
  };

  // Add imageConfig for both models (both support aspect ratio)
  if (aspectRatio) {
    config.imageConfig = {
      aspectRatio,
    };
  }

  // Add resolution only for Nano Banana Pro
  if (model === "nano-banana-pro" && resolution) {
    if (!config.imageConfig) {
      config.imageConfig = {};
    }
    (config.imageConfig as Record<string, unknown>).imageSize = resolution;
  }

  // Add tools array for Google Search (only Nano Banana Pro)
  const tools = [];
  if (model === "nano-banana-pro" && useGoogleSearch) {
    tools.push({ googleSearch: {} });
  }

  console.log(`[API:${requestId}] Config: ${JSON.stringify(config)}`);

  // Make request to Gemini
  const geminiStartTime = Date.now();

  const response = await ai.models.generateContent({
    model: MODEL_MAP[model],
    contents: [
      {
        role: "user",
        parts: requestParts,
      },
    ],
    config,
    ...(tools.length > 0 && { tools }),
  });

  const geminiDuration = Date.now() - geminiStartTime;
  console.log(`[API:${requestId}] Gemini API completed in ${geminiDuration}ms`);

  // Extract image from response
  const candidates = response.candidates;

  if (!candidates || candidates.length === 0) {
    console.error(`[API:${requestId}] No candidates in Gemini response`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No response from AI model",
      },
      { status: 500 }
    );
  }

  const parts = candidates[0].content?.parts;
  console.log(`[API:${requestId}] Response parts: ${parts?.length || 0}`);

  if (!parts) {
    console.error(`[API:${requestId}] No parts in Gemini candidate content`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No content in response",
      },
      { status: 500 }
    );
  }

  // Find image part in response
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      const mimeType = part.inlineData.mimeType || "image/png";
      const imgData = part.inlineData.data;
      const imageSizeKB = (imgData.length / 1024).toFixed(1);

      console.log(`[API:${requestId}] Output image: ${mimeType}, ${imageSizeKB}KB`);

      const dataUrl = `data:${mimeType};base64,${imgData}`;

      const responsePayload = { success: true, image: dataUrl };
      const responseSize = JSON.stringify(responsePayload).length;
      const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);

      if (responseSize > 4.5 * 1024 * 1024) {
        console.warn(`[API:${requestId}] Response size (${responseSizeMB}MB) approaching Next.js 5MB limit`);
      }

      console.log(`[API:${requestId}] SUCCESS - Returning ${responseSizeMB}MB payload`);

      // Create response with explicit headers to handle large payloads
      const resp = NextResponse.json<GenerateResponse>(responsePayload);
      resp.headers.set('Content-Type', 'application/json');
      resp.headers.set('Content-Length', responseSize.toString());

      return resp;
    }
  }

  // If no image found, check for text error
  for (const part of parts) {
    if (part.text) {
      console.error(`[API:${requestId}] Gemini returned text instead of image: ${part.text.substring(0, 100)}`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: `Model returned text instead of image: ${part.text.substring(0, 200)}`,
        },
        { status: 500 }
      );
    }
  }

  console.error(`[API:${requestId}] No image or text found in Gemini response`);
  return NextResponse.json<GenerateResponse>(
    {
      success: false,
      error: "No image in response",
    },
    { status: 500 }
  );
}

/**
 * Input parameter patterns - maps generic input types to possible schema parameter names
 */
const INPUT_PATTERNS: Record<string, string[]> = {
  // Text/prompt inputs
  prompt: ["prompt", "text", "caption", "input_text", "description", "query"],
  negativePrompt: ["negative_prompt", "negative", "neg_prompt", "negative_text"],

  // Image inputs
  image: ["image_url", "image_urls", "image", "first_frame", "start_image", "init_image",
          "reference_image", "input_image", "image_input", "source_image", "img", "photo"],

  // Video/media settings
  aspectRatio: ["aspect_ratio", "ratio", "size", "dimensions", "output_size"],
  duration: ["duration", "length", "num_frames", "seconds", "video_length"],
  fps: ["fps", "frame_rate", "framerate", "frames_per_second"],

  // Audio settings
  audio: ["audio_enabled", "with_audio", "enable_audio", "audio", "sound"],

  // Generation settings
  seed: ["seed", "random_seed", "noise_seed"],
  steps: ["steps", "num_steps", "num_inference_steps", "inference_steps"],
  guidance: ["guidance_scale", "guidance", "cfg_scale", "cfg"],

  // Model-specific
  scheduler: ["scheduler", "sampler", "sampler_name"],
  strength: ["strength", "denoise", "denoising_strength"],
};

/**
 * Input mapping result from schema parsing
 */
interface InputMapping {
  // Maps our generic names to model-specific parameter names
  paramMap: Record<string, string>;
  // Track which generic params expect array types (e.g., "image")
  arrayParams: Set<string>;
  // Track actual schema param names that expect array types (e.g., "image_urls")
  schemaArrayParams: Set<string>;
}

/**
 * Parameter type information extracted from OpenAPI schema
 */
interface ParameterTypeInfo {
  [paramName: string]: "string" | "integer" | "number" | "boolean" | "array" | "object";
}

/**
 * Extract parameter types from OpenAPI schema
 */
function getParameterTypesFromSchema(schema: Record<string, unknown> | undefined): ParameterTypeInfo {
  const typeInfo: ParameterTypeInfo = {};

  if (!schema) return typeInfo;

  try {
    const components = schema.components as Record<string, unknown> | undefined;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const input = schemas?.Input as Record<string, unknown> | undefined;
    const properties = input?.properties as Record<string, unknown> | undefined;

    if (!properties) return typeInfo;

    for (const [propName, prop] of Object.entries(properties)) {
      const property = prop as Record<string, unknown>;
      const type = property?.type as string | undefined;
      if (type && ["string", "integer", "number", "boolean", "array", "object"].includes(type)) {
        typeInfo[propName] = type as ParameterTypeInfo[string];
      }
    }
  } catch {
    // Schema parsing failed
  }

  return typeInfo;
}

/**
 * Coerce parameter values to their expected types based on schema
 * This handles cases where values were incorrectly stored as strings (e.g., from UI enum selects)
 */
function coerceParameterTypes(
  parameters: Record<string, unknown> | undefined,
  typeInfo: ParameterTypeInfo
): Record<string, unknown> {
  if (!parameters) return {};

  const result = { ...parameters };

  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null) continue;

    const expectedType = typeInfo[key];
    if (!expectedType) continue;

    // Coerce string values to their expected types
    if (typeof value === "string") {
      if (expectedType === "integer") {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed)) result[key] = parsed;
      } else if (expectedType === "number") {
        const parsed = parseFloat(value);
        if (!isNaN(parsed)) result[key] = parsed;
      } else if (expectedType === "boolean") {
        result[key] = value === "true";
      }
    }
  }

  return result;
}

/**
 * Extract input parameter mappings from OpenAPI schema
 * Returns a mapping of generic parameter names to model-specific names
 */
function getInputMappingFromSchema(schema: Record<string, unknown> | undefined): InputMapping {
  const paramMap: Record<string, string> = {};
  const arrayParams = new Set<string>();
  const schemaArrayParams = new Set<string>();

  if (!schema) return { paramMap, arrayParams, schemaArrayParams };

  try {
    // Navigate to input schema properties
    const components = schema.components as Record<string, unknown> | undefined;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const input = schemas?.Input as Record<string, unknown> | undefined;
    const properties = input?.properties as Record<string, unknown> | undefined;

    if (!properties) return { paramMap, arrayParams, schemaArrayParams };

    // First pass: detect all array-typed properties by their actual schema name
    for (const [propName, prop] of Object.entries(properties)) {
      const property = prop as Record<string, unknown>;
      if (property?.type === "array") {
        schemaArrayParams.add(propName);
      }
    }

    const propertyNames = Object.keys(properties);

    // For each input type pattern, find the matching schema property
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
  } catch {
    // Schema parsing failed
  }

  return { paramMap, arrayParams, schemaArrayParams };
}

/**
 * Generate image using Replicate API
 */
async function generateWithReplicate(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] Replicate generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const REPLICATE_API_BASE = "https://api.replicate.com/v1";

  // Get the latest version of the model
  const modelId = input.model.id;
  const [owner, name] = modelId.split("/");

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

  // Build input for the prediction, coercing parameter types from schema
  const predictionInput: Record<string, unknown> = {
    ...coerceParameterTypes(input.parameters, parameterTypes),
  };

  // Add dynamic inputs if provided (these come from schema-mapped connections)
  if (hasDynamicInputs) {
    const { schemaArrayParams } = getInputMappingFromSchema(schema);

    // Apply array wrapping based on schema type
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        if (schemaArrayParams.has(key) && !Array.isArray(value)) {
          predictionInput[key] = [value];  // Wrap in array
        } else {
          predictionInput[key] = value;
        }
      }
    }
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    const { paramMap, arrayParams } = getInputMappingFromSchema(schema);

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

    // Map any parameters that might need renaming (use coerced values)
    const coercedParams = coerceParameterTypes(input.parameters, parameterTypes);
    for (const [key, value] of Object.entries(coercedParams)) {
      const mappedKey = paramMap[key] || key;
      predictionInput[mappedKey] = value;
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

  // Poll for completion
  const maxWaitTime = 5 * 60 * 1000; // 5 minutes
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
        error: `${input.model.name}: Generation timed out after 5 minutes. Video models may take longer - try again.`,
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

  // Output can be a single URL string or an array of URLs
  const outputUrls: string[] = Array.isArray(output) ? output : [output];

  if (outputUrls.length === 0) {
    return {
      success: false,
      error: "No output from prediction",
    };
  }

  // Fetch the first output and convert to base64
  const mediaUrl = outputUrls[0];
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

  const mediaArrayBuffer = await mediaResponse.arrayBuffer();
  const mediaSizeBytes = mediaArrayBuffer.byteLength;
  const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

  console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL directly instead of base64
  if (isVideo && mediaSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: mediaUrl, // Return URL directly for very large videos
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
  } catch {
    // Schema parsing failed - continue with empty mapping
  }

  const result = { paramMap, arrayParams, schemaArrayParams, parameterTypes };
  falInputMappingCache.set(modelId, { result, timestamp: Date.now() });
  return result;
}

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MB

/**
 * Upload a base64 data URL image to fal.ai CDN storage.
 * Returns the CDN URL to use in API requests instead of inline base64.
 * If the input is already a URL (not base64), returns it as-is.
 */
async function uploadImageToFal(base64DataUrl: string, apiKey: string | null): Promise<string> {
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

  // Step 2: PUT the binary data to the signed URL
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
async function generateWithFalQueue(
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

  // Build request body, coercing parameter types from schema
  const requestBody: Record<string, unknown> = {
    ...coerceParameterTypes(input.parameters, parameterTypes),
  };

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
  const falRequestId = submitResult.request_id;

  if (!falRequestId) {
    console.error(`[API:${requestId}] No request_id in queue submit response`);
    return {
      success: false,
      error: "No request_id in queue response",
    };
  }

  console.log(`[API:${requestId}] Queue request submitted: ${falRequestId}`);

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
      `https://queue.fal.run/${modelId}/requests/${falRequestId}/status`,
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
        `https://queue.fal.run/${modelId}/requests/${falRequestId}`,
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

      // Extract video URL from result
      let mediaUrl: string | null = null;

      if (result.video && result.video.url) {
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

      // Fetch the media and convert to base64
      console.log(`[API:${requestId}] Fetching output from: ${mediaUrl.substring(0, 80)}...`);
      const mediaResponse = await fetch(mediaUrl);

      if (!mediaResponse.ok) {
        return {
          success: false,
          error: `Failed to fetch output: ${mediaResponse.status}`,
        };
      }

      const contentType = mediaResponse.headers.get("content-type") || "video/mp4";
      const isVideo = contentType.startsWith("video/");

      const mediaArrayBuffer = await mediaResponse.arrayBuffer();
      const mediaSizeBytes = mediaArrayBuffer.byteLength;
      const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

      console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

      // For very large videos (>20MB), return URL directly instead of base64
      if (isVideo && mediaSizeMB > 20) {
        console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
        return {
          success: true,
          outputs: [
            {
              type: "video",
              data: mediaUrl,
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

// ============ Kie.ai Helpers ============

/**
 * Get default required parameters for a Kie model
 * Many Kie models require specific parameters to be present even if not user-specified
 */
function getKieModelDefaults(modelId: string): Record<string, unknown> {
  switch (modelId) {
    // GPT Image models
    case "gpt-image/1.5-text-to-image":
    case "gpt-image/1.5-image-to-image":
      return {
        aspect_ratio: "3:2",
        quality: "medium",
      };

    // Z-Image model
    case "z-image":
      return {
        aspect_ratio: "1:1",
      };

    // Seedream models
    case "seedream/4.5-text-to-image":
    case "seedream/4.5-edit":
      return {
        aspect_ratio: "1:1",
        quality: "basic",
      };

    // Nano Banana Pro (Kie)
    case "nano-banana-pro":
      return {
        aspect_ratio: "1:1",
        resolution: "1K",
      };

    // Flux-2 models
    case "flux-2/pro-text-to-image":
    case "flux-2/pro-image-to-image":
    case "flux-2/flex-text-to-image":
    case "flux-2/flex-image-to-image":
      return {
        aspect_ratio: "1:1",
      };

    // Grok Imagine image models
    case "grok-imagine/text-to-image":
      return {
        aspect_ratio: "1:1",
      };

    case "grok-imagine/image-to-image":
      return {};

    // Grok Imagine video models
    case "grok-imagine/text-to-video":
      return {
        aspect_ratio: "2:3",
        duration: "6",
        mode: "normal",
      };

    case "grok-imagine/image-to-video":
      return {
        aspect_ratio: "2:3",
        duration: "6",
        mode: "normal",
      };

    // Kling 2.6 video models
    case "kling-2.6/text-to-video":
    case "kling-2.6/image-to-video":
      return {
        aspect_ratio: "16:9",
        duration: "5",
        sound: true,
      };

    // Kling 2.6 motion control
    case "kling-2.6/motion-control":
      return {
        mode: "720p",
        character_orientation: "video",
      };

    // Kling 2.5 turbo models
    case "kling/v2-5-turbo-text-to-video-pro":
    case "kling/v2-5-turbo-image-to-video-pro":
      return {
        aspect_ratio: "16:9",
        duration: "5",
        cfg_scale: 0.5,
      };

    // Wan video models
    case "wan/2-6-text-to-video":
    case "wan/2-6-image-to-video":
      return {
        duration: "5",
        resolution: "1080p",
      };

    case "wan/2-6-video-to-video":
      return {
        duration: "5",
        resolution: "1080p",
      };

    // Topaz video upscale
    case "topaz/video-upscale":
      return {
        upscale_factor: "2",
      };

    // Veo 3 models
    case "veo3/text-to-video":
    case "veo3/image-to-video":
    case "veo3-fast/text-to-video":
    case "veo3-fast/image-to-video":
      return {
        aspect_ratio: "16:9",
      };

    default:
      return {};
  }
}

/**
 * Get the correct image input parameter name for a Kie model
 */
function getKieImageInputKey(modelId: string): string {
  // Model-specific parameter names
  if (modelId === "nano-banana-pro") return "image_input";
  if (modelId === "seedream/4.5-edit") return "image_urls";
  if (modelId === "gpt-image/1.5-image-to-image") return "input_urls";
  // Flux-2 I2I models use input_urls
  if (modelId === "flux-2/pro-image-to-image" || modelId === "flux-2/flex-image-to-image") return "input_urls";
  // Kling 2.5 turbo I2V uses singular image_url
  if (modelId === "kling/v2-5-turbo-image-to-video-pro") return "image_url";
  // Kling 2.6 motion control uses input_urls
  if (modelId === "kling-2.6/motion-control") return "input_urls";
  // Topaz video upscale uses video_url (singular)
  if (modelId === "topaz/video-upscale") return "video_url";
  // Veo 3 models use imageUrls
  if (modelId.startsWith("veo3")) return "imageUrls";
  // Default for most models
  return "image_urls";
}


/**
 * Detect actual image type from binary data (magic bytes)
 */
function detectImageType(buffer: Buffer): { mimeType: string; ext: string } {
  // Check magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { mimeType: "image/png", ext: "png" };
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mimeType: "image/jpeg", ext: "jpg" };
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return { mimeType: "image/webp", ext: "webp" };
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { mimeType: "image/gif", ext: "gif" };
  }
  // Default to PNG
  return { mimeType: "image/png", ext: "png" };
}

/**
 * Upload a base64 image to Kie.ai and get a URL
 * Required for image-to-image models since Kie doesn't accept base64 directly
 * Uses base64 upload endpoint (same as official Kie client)
 */
async function uploadImageToKie(
  requestId: string,
  apiKey: string,
  base64Image: string
): Promise<string> {
  // Extract mime type and data from data URL
  let declaredMimeType = "image/png";
  let imageData = base64Image;

  if (base64Image.startsWith("data:")) {
    const matches = base64Image.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      declaredMimeType = matches[1];
      imageData = matches[2];
    }
  }

  // Convert base64 to binary to detect actual type
  const binaryData = Buffer.from(imageData, "base64");

  // Detect actual image type from magic bytes (don't trust the declared MIME type)
  const detected = detectImageType(binaryData);
  const mimeType = detected.mimeType;
  const ext = detected.ext;

  const filename = `upload_${Date.now()}.${ext}`;

  console.log(`[API:${requestId}] Uploading image to Kie.ai: ${filename} (${(binaryData.length / 1024).toFixed(1)}KB) [declared: ${declaredMimeType}, actual: ${mimeType}]`);

  // Use base64 upload endpoint (same as official Kie client)
  // Format: data:{mime_type};base64,{data}
  const dataUrl = `data:${mimeType};base64,${imageData}`;

  const response = await fetch("https://kieai.redpandaai.co/api/file-base64-upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64Data: dataUrl,
      uploadPath: "images",
      fileName: filename,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload image: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`[API:${requestId}] Kie upload response:`, JSON.stringify(result).substring(0, 300));

  // Check for error in response
  if (result.code && result.code !== 200 && !result.success) {
    throw new Error(`Upload failed: ${result.msg || 'Unknown error'}`);
  }

  // Response format: { success: true, code: 200, data: { downloadUrl: "...", fileName: "...", fileSize: 123 } }
  const downloadUrl = result.data?.downloadUrl || result.downloadUrl || result.url;

  if (!downloadUrl) {
    console.error(`[API:${requestId}] Upload response has no URL:`, result);
    throw new Error(`No download URL in upload response. Response: ${JSON.stringify(result).substring(0, 200)}`);
  }

  console.log(`[API:${requestId}] Image uploaded: ${downloadUrl.substring(0, 80)}...`);
  return downloadUrl;
}

/**
 * Poll Kie.ai task status until completion
 */
async function pollKieTaskCompletion(
  requestId: string,
  apiKey: string,
  taskId: string,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  const maxWaitTime = 10 * 60 * 1000; // 10 minutes for video
  const pollInterval = 2000; // 2 seconds
  const startTime = Date.now();
  let lastStatus = "";

  const pollUrl = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      return { success: false, error: "Generation timed out after 10 minutes" };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const response = await fetch(pollUrl, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      return { success: false, error: `Failed to poll status: ${response.status}` };
    }

    const result = await response.json();
    // Kie API returns "state" in result.data.state (not "status")
    const state = (result.data?.state || result.state || result.status || "").toUpperCase();

    if (state !== lastStatus) {
      console.log(`[API:${requestId}] Kie task state: ${state}`);
      lastStatus = state;
    }

    if (state === "SUCCESS" || state === "COMPLETED") {
      return { success: true, data: result.data || result };
    }

    if (state === "FAIL" || state === "FAILED" || state === "ERROR") {
      const errorMessage = result.data?.failMsg || result.data?.errorMessage || result.error || result.message || "Generation failed";
      return { success: false, error: errorMessage };
    }

    // Continue polling for: WAITING, QUEUING, GENERATING, PROCESSING, etc.
  }
}

// ============ Veo 3 Helpers ============

function isVeoModel(modelId: string): boolean {
  return modelId.startsWith("veo3/") || modelId.startsWith("veo3-fast/");
}

function getVeoApiModelId(modelId: string): string {
  if (modelId.startsWith("veo3-fast/")) return "veo3_fast";
  return "veo3";
}

async function pollVeoTaskCompletion(
  requestId: string,
  apiKey: string,
  taskId: string,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  const maxWaitTime = 10 * 60 * 1000;
  const pollInterval = 2000;
  const startTime = Date.now();
  let lastStatus = -1;

  const pollUrl = `https://api.kie.ai/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      return { success: false, error: "Generation timed out after 10 minutes" };
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const response = await fetch(pollUrl, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return { success: false, error: `Failed to poll status: ${response.status}` };
    }

    const result = await response.json();
    const successFlag = result.data?.successFlag ?? -1;

    if (successFlag !== lastStatus) {
      console.log(`[API:${requestId}] Veo task successFlag: ${successFlag}`);
      lastStatus = successFlag;
    }

    if (successFlag === 1) {
      return { success: true, data: result.data };
    }
    if (successFlag === 2 || successFlag === 3) {
      const errorMessage = result.data?.errorMessage || "Generation failed";
      return { success: false, error: errorMessage };
    }
    // successFlag === 0 means still generating, continue polling
  }
}

/**
 * Generate image/video using Kie.ai API
 */
async function generateWithKie(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const modelId = input.model.id;

  console.log(`[API:${requestId}] Kie.ai generation - Model: ${modelId}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  // Build the input object (all parameters go inside "input" for Kie API)
  // Start with model-specific required defaults
  const modelDefaults = getKieModelDefaults(modelId);
  const inputParams: Record<string, unknown> = { ...modelDefaults };

  // Add prompt
  if (input.prompt) {
    inputParams.prompt = input.prompt;
  }

  // Add model parameters (user params override defaults)
  if (input.parameters) {
    Object.assign(inputParams, input.parameters);
  }

  // GPT Image 1.5 does NOT support 'size' parameter - only 'aspect_ratio'
  // Remove any stale 'size' values from old workflow data
  if (modelId.startsWith("gpt-image/1.5")) {
    delete inputParams.size;
  }

  // Handle dynamic inputs FIRST (from schema-mapped connections) - these take priority
  // Track which image keys dynamicInputs already handled to avoid double-uploads
  const handledImageKeys = new Set<string>();

  if (input.dynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs)) {
      if (value !== null && value !== undefined && value !== '') {
        // Check if this is an image input that needs uploading
        if (typeof value === 'string' && value.startsWith('data:image')) {
          // Single data URL - upload it
          const url = await uploadImageToKie(requestId, apiKey, value);
          // Singular keys get a string, plural keys get an array
          if (key === "image_url" || key === "video_url" || key === "tail_image_url") {
            inputParams[key] = url;
          } else {
            inputParams[key] = [url];
          }
          handledImageKeys.add(key);
        } else if (Array.isArray(value)) {
          // Array of values - check if they're data URLs that need uploading
          const processedArray: string[] = [];
          for (const item of value) {
            if (typeof item === 'string' && item.startsWith('data:image')) {
              const url = await uploadImageToKie(requestId, apiKey, item);
              processedArray.push(url);
            } else if (typeof item === 'string' && item.startsWith('http')) {
              processedArray.push(item);
            } else if (typeof item === 'string') {
              processedArray.push(item);
            }
          }
          if (processedArray.length > 0) {
            inputParams[key] = processedArray;
            handledImageKeys.add(key);
          }
        } else {
          inputParams[key] = value;
        }
      }
    }
  }

  // Handle image inputs (fallback - only if dynamicInputs didn't already set the image key)
  const imageKey = getKieImageInputKey(modelId);
  if (input.images && input.images.length > 0 && !handledImageKeys.has(imageKey)) {
    // Upload images to get URLs (Kie requires URLs, not base64)
    const imageUrls: string[] = [];
    for (const image of input.images) {
      if (image.startsWith("http")) {
        imageUrls.push(image);
      } else {
        // Upload base64 image
        const url = await uploadImageToKie(requestId, apiKey, image);
        imageUrls.push(url);
      }
    }

    // Some models use singular string, others use arrays
    if (imageKey === "image_url" || imageKey === "video_url") {
      inputParams[imageKey] = imageUrls[0];
    } else {
      inputParams[imageKey] = imageUrls;
    }
  }

  // Veo 3 models use a different API endpoint and request format
  if (isVeoModel(modelId)) {
    const veoBody: Record<string, unknown> = {
      prompt: inputParams.prompt,
      model: getVeoApiModelId(modelId),
      aspect_ratio: inputParams.aspect_ratio || "16:9",
    };

    // Add image URLs if present (for image-to-video)
    if (inputParams.imageUrls) {
      veoBody.imageUrls = Array.isArray(inputParams.imageUrls)
        ? inputParams.imageUrls
        : [inputParams.imageUrls];
    }

    // Add optional seed
    if (inputParams.seeds !== undefined) {
      veoBody.seeds = inputParams.seeds;
    }

    const veoUrl = "https://api.kie.ai/api/v1/veo/generate";
    console.log(`[API:${requestId}] Calling Veo API: ${veoUrl}`);
    console.log(`[API:${requestId}] Veo request body:`, JSON.stringify(veoBody, null, 2));

    const createResponse = await fetch(veoUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(veoBody),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      let errorDetail = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorDetail = errorJson.message || errorJson.error || errorJson.detail || errorText;
      } catch {
        // Keep original text
      }
      if (createResponse.status === 429) {
        return { success: false, error: `${input.model.name}: Rate limit exceeded. Try again in a moment.` };
      }
      return { success: false, error: `${input.model.name}: ${errorDetail}` };
    }

    const createResult = await createResponse.json();
    if (createResult.code && createResult.code !== 200) {
      return { success: false, error: `${input.model.name}: ${createResult.msg || "API error"}` };
    }

    const taskId = createResult.data?.taskId || createResult.taskId;
    if (!taskId) {
      console.error(`[API:${requestId}] No taskId in Veo response:`, createResult);
      return { success: false, error: "No task ID in Veo response" };
    }

    console.log(`[API:${requestId}] Veo task created: ${taskId}`);

    // Poll with Veo-specific polling
    const pollResult = await pollVeoTaskCompletion(requestId, apiKey, taskId);
    if (!pollResult.success) {
      return { success: false, error: `${input.model.name}: ${pollResult.error}` };
    }

    // Extract video URL from Veo response format
    const data = pollResult.data;
    let mediaUrl: string | null = null;

    const responseObj = data?.response as Record<string, unknown> | undefined;
    const resultUrls = (responseObj?.resultUrls || data?.resultUrls) as string[] | undefined;
    if (resultUrls && resultUrls.length > 0) {
      mediaUrl = resultUrls[0];
    }

    if (!mediaUrl) {
      console.error(`[API:${requestId}] No media URL found in Veo response:`, data);
      return { success: false, error: "No output URL in Veo response" };
    }

    // Validate URL before fetching
    const mediaUrlCheck = validateMediaUrl(mediaUrl);
    if (!mediaUrlCheck.valid) {
      return { success: false, error: `Invalid media URL: ${mediaUrlCheck.error}` };
    }

    // Fetch the video and convert to base64
    console.log(`[API:${requestId}] Fetching Veo output from: ${mediaUrl.substring(0, 80)}...`);
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      return { success: false, error: `Failed to fetch output: ${mediaResponse.status}` };
    }

    const MAX_MEDIA_SIZE = 500 * 1024 * 1024;
    const mediaContentLength = parseInt(mediaResponse.headers.get("content-length") || "0", 10);
    if (mediaContentLength > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(mediaContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
    }

    const contentType = mediaResponse.headers.get("content-type") || "video/mp4";
    const mediaArrayBuffer = await mediaResponse.arrayBuffer();
    const mediaSizeMB = mediaArrayBuffer.byteLength / (1024 * 1024);

    console.log(`[API:${requestId}] Veo output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

    // For very large videos (>20MB), return URL directly
    if (mediaSizeMB > 20) {
      console.log(`[API:${requestId}] SUCCESS - Returning URL for large Veo video`);
      return {
        success: true,
        outputs: [{ type: "video", data: mediaUrl, url: mediaUrl }],
      };
    }

    const mediaBase64 = Buffer.from(mediaArrayBuffer).toString("base64");
    console.log(`[API:${requestId}] SUCCESS - Returning Veo video`);
    return {
      success: true,
      outputs: [{ type: "video", data: `data:${contentType};base64,${mediaBase64}`, url: mediaUrl }],
    };
  }

  // All remaining Kie models use the standard createTask endpoint
  const requestBody: Record<string, unknown> = {
    model: modelId,
    input: inputParams,
  };

  const createUrl = "https://api.kie.ai/api/v1/jobs/createTask";

  console.log(`[API:${requestId}] Calling Kie.ai API: ${createUrl}`);
  // Log full request body for debugging (truncate very long prompts)
  const bodyForLogging = { ...requestBody };
  if (bodyForLogging.input && typeof bodyForLogging.input === 'object') {
    const inputForLogging = { ...(bodyForLogging.input as Record<string, unknown>) };
    if (typeof inputForLogging.prompt === 'string' && (inputForLogging.prompt as string).length > 200) {
      inputForLogging.prompt = (inputForLogging.prompt as string).substring(0, 200) + '...[truncated]';
    }
    bodyForLogging.input = inputForLogging;
  }
  console.log(`[API:${requestId}] Request body:`, JSON.stringify(bodyForLogging, null, 2));

  // Create task
  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.message || errorJson.error || errorJson.detail || errorText;
    } catch {
      // Keep original text
    }

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

  const createResult = await createResponse.json();

  // Kie API returns HTTP 200 even on errors, check the response code
  if (createResult.code && createResult.code !== 200) {
    const errorMsg = createResult.msg || createResult.message || "API error";
    console.error(`[API:${requestId}] Kie API error (code ${createResult.code}):`, errorMsg);
    return {
      success: false,
      error: `${input.model.name}: ${errorMsg}`,
    };
  }

  const taskId = createResult.taskId || createResult.data?.taskId || createResult.id;

  if (!taskId) {
    console.error(`[API:${requestId}] No taskId in Kie response:`, createResult);
    return {
      success: false,
      error: "No task ID in response",
    };
  }

  console.log(`[API:${requestId}] Kie task created: ${taskId}`);

  // Poll for completion
  const pollResult = await pollKieTaskCompletion(requestId, apiKey, taskId);

  if (!pollResult.success) {
    return {
      success: false,
      error: `${input.model.name}: ${pollResult.error}`,
    };
  }

  // Extract output URL from result
  // Kie API returns: { data: { status: "success", resultJson: { resultUrls: ["url1", "url2"] } } }
  const data = pollResult.data;
  let mediaUrl: string | null = null;
  let isVideo = false;

  console.log(`[API:${requestId}] Kie poll result data:`, JSON.stringify(data).substring(0, 500));

  // Try various response formats - Kie uses resultJson.resultUrls
  // Note: resultJson is often a JSON string that needs parsing
  if (data) {
    let resultJson = data.resultJson as Record<string, unknown> | string | undefined;

    // Parse resultJson if it's a string (Kie API returns it as escaped JSON string)
    if (typeof resultJson === 'string') {
      try {
        resultJson = JSON.parse(resultJson) as Record<string, unknown>;
      } catch {
        // Not valid JSON, keep as-is
        resultJson = undefined;
      }
    }

    const resultUrls = ((resultJson as Record<string, unknown> | undefined)?.resultUrls || data.resultUrls) as string[] | undefined;

    if (resultUrls && resultUrls.length > 0) {
      mediaUrl = resultUrls[0];
      // Check if it's a video based on URL
      isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('video');
    }
    // Fallback to other formats
    else if (data.videoUrl) {
      mediaUrl = data.videoUrl as string;
      isVideo = true;
    } else if (data.video_url) {
      mediaUrl = data.video_url as string;
      isVideo = true;
    } else if (data.output && typeof data.output === 'string' && (data.output as string).includes('.mp4')) {
      mediaUrl = data.output as string;
      isVideo = true;
    }
    // Image outputs
    else if (data.imageUrl) {
      mediaUrl = data.imageUrl as string;
    } else if (data.image_url) {
      mediaUrl = data.image_url as string;
    } else if (data.output && typeof data.output === 'string') {
      mediaUrl = data.output as string;
    } else if (data.url) {
      mediaUrl = data.url as string;
    } else if (Array.isArray(data.images) && data.images.length > 0) {
      mediaUrl = (data.images[0] as { url?: string })?.url || data.images[0] as string;
    }
  }

  if (!mediaUrl) {
    console.error(`[API:${requestId}] No media URL found in Kie response:`, data);
    return {
      success: false,
      error: "No output URL in response",
    };
  }

  // Detect video from URL if not already detected
  if (!isVideo && (mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('video'))) {
    isVideo = true;
  }

  // Validate URL before fetching
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

  // Check file size before downloading body
  const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB
  const mediaContentLength = parseInt(mediaResponse.headers.get("content-length") || "0", 10);
  if (mediaContentLength > MAX_MEDIA_SIZE) {
    return { success: false, error: `Media too large: ${(mediaContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }

  const contentType = mediaResponse.headers.get("content-type") || (isVideo ? "video/mp4" : "image/png");
  if (contentType.startsWith("video/")) {
    isVideo = true;
  }

  const mediaArrayBuffer = await mediaResponse.arrayBuffer();
  const mediaSizeBytes = mediaArrayBuffer.byteLength;
  const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

  console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL directly
  if (isVideo && mediaSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: mediaUrl,
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

/**
 * WaveSpeed task status from API
 * Values: created → processing → completed/failed
 */
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
async function generateWithWaveSpeed(
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
  const isVideoModel = input.model.capabilities.includes("text-to-video") ||
                       input.model.capabilities.includes("image-to-video");

  // Build WaveSpeed payload
  const payload: Record<string, unknown> = {
    prompt: input.prompt,
    ...input.parameters,
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
  if (wsContentLength > MAX_MEDIA_SIZE_WS) {
    return { success: false, error: `Media too large: ${(wsContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }

  const outputArrayBuffer = await outputResponse.arrayBuffer();
  const outputSizeMB = outputArrayBuffer.byteLength / (1024 * 1024);

  const rawContentType = outputResponse.headers.get("content-type");
  const contentType =
    (rawContentType && rawContentType !== "application/octet-stream")
      ? rawContentType
      : (isVideoModel ? "video/mp4" : "image/png");

  console.log(`[API:${requestId}] Output: ${contentType}, ${outputSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL directly instead of base64
  if (isVideoModel && outputSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: outputUrl,
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

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`\n[API:${requestId}] ========== NEW GENERATE REQUEST ==========`);

  try {
    const body: MultiProviderGenerateRequest = await request.json();
    const {
      images,
      prompt,
      model = "nano-banana-pro",
      aspectRatio,
      resolution,
      useGoogleSearch,
      selectedModel,
      parameters,
      dynamicInputs,
      mediaType,
    } = body;

    // Prompt is required unless:
    // - Provided via dynamicInputs
    // - Images are provided (image-to-video/image-to-image models)
    // - Dynamic inputs contain image frames (first_frame, last_frame, etc.)
    const hasPrompt = prompt || (dynamicInputs && (
      typeof dynamicInputs.prompt === 'string'
        ? dynamicInputs.prompt
        : Array.isArray(dynamicInputs.prompt) && dynamicInputs.prompt.length > 0
    ));
    const hasImages = (images && images.length > 0);
    const hasImageInputs = dynamicInputs && Object.keys(dynamicInputs).some(key =>
      key.includes('frame') || key.includes('image')
    );

    if (!hasPrompt && !hasImages && !hasImageInputs) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "Prompt or image input is required",
        },
        { status: 400 }
      );
    }

    // Determine which provider to use
    const provider: ProviderType = selectedModel?.provider || "gemini";
    console.log(`[API:${requestId}] Provider: ${provider}, Model: ${selectedModel?.modelId || model}`);

    // Route to appropriate provider
    if (provider === "replicate") {
      // User-provided key takes precedence over env variable
      const replicateApiKey = request.headers.get("X-Replicate-API-Key") || process.env.REPLICATE_API_KEY;
      if (!replicateApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "Replicate API key not configured. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Keep Data URIs as-is since localhost URLs won't work (provider can't reach them)
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values, keep Data URIs
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          // Keep the value as-is (Data URIs work with Replicate)
          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel!.modelId,
          name: selectedModel!.displayName,
          provider: "replicate",
          capabilities: mediaType === "video" ? ["text-to-video"] : ["text-to-image"],
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await generateWithReplicate(requestId, replicateApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: result.error || "Generation failed",
          },
          { status: 500 }
        );
      }

      // Return first output (image or video)
      const output = result.outputs?.[0];
      if (!output?.data) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No output in generation result",
          },
          { status: 500 }
        );
      }

      // Return appropriate fields based on output type
      if (output.type === "video") {
        // Check if data is a URL (for large videos) or base64
        const isUrl = output.data.startsWith("http");
        return NextResponse.json<GenerateResponse>({
          success: true,
          video: isUrl ? undefined : output.data,
          videoUrl: isUrl ? output.data : undefined,
          ...(output.url && { sourceUrl: output.url }),
          contentType: "video",
        });
      }

      return NextResponse.json<GenerateResponse>({
        success: true,
        image: output.data,
        ...(output.url && { sourceUrl: output.url }),
        contentType: "image",
      });
    }

    if (provider === "fal") {
      // User-provided key takes precedence over env variable
      const falApiKey = request.headers.get("X-Fal-API-Key") || process.env.FAL_API_KEY || null;

      if (!falApiKey) {
        console.warn(`[API:${requestId}] No FAL API key configured. Proceeding without auth (rate-limited).`);
      }

      // Pass images as-is; generateWithFalQueue uploads base64 to CDN internally
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          // Keep the value as-is; CDN upload happens in generateWithFalQueue
          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel!.modelId,
          name: selectedModel!.displayName,
          provider: "fal",
          capabilities: mediaType === "video" ? ["text-to-video"] : ["text-to-image"],
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await generateWithFalQueue(requestId, falApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: result.error || "Generation failed",
          },
          { status: 500 }
        );
      }

      // Return first output (image or video)
      const output = result.outputs?.[0];
      if (!output?.data) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No output in generation result",
          },
          { status: 500 }
        );
      }

      // Return appropriate fields based on output type
      if (output.type === "video") {
        // Check if data is a URL (for large videos) or base64
        const isUrl = output.data.startsWith("http");
        return NextResponse.json<GenerateResponse>({
          success: true,
          video: isUrl ? undefined : output.data,
          videoUrl: isUrl ? output.data : undefined,
          ...(output.url && { sourceUrl: output.url }),
          contentType: "video",
        });
      }

      return NextResponse.json<GenerateResponse>({
        success: true,
        image: output.data,
        ...(output.url && { sourceUrl: output.url }),
        contentType: "image",
      });
    }

    if (provider === "kie") {
      // User-provided key takes precedence over env variable
      const kieApiKey = request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY;
      if (!kieApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "Kie.ai API key not configured. Add KIE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Process images - Kie requires URLs, we'll upload base64 images in generateWithKie
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel!.modelId,
          name: selectedModel!.displayName,
          provider: "kie",
          capabilities: mediaType === "video" ? ["text-to-video"] : ["text-to-image"],
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await generateWithKie(requestId, kieApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: result.error || "Generation failed",
          },
          { status: 500 }
        );
      }

      // Return first output (image or video)
      const output = result.outputs?.[0];
      if (!output?.data) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No output in generation result",
          },
          { status: 500 }
        );
      }

      // Return appropriate fields based on output type
      if (output.type === "video") {
        // Check if data is a URL (for large videos) or base64
        const isUrl = output.data.startsWith("http");
        return NextResponse.json<GenerateResponse>({
          success: true,
          video: isUrl ? undefined : output.data,
          videoUrl: isUrl ? output.data : undefined,
          ...(output.url && { sourceUrl: output.url }),
          contentType: "video",
        });
      }

      return NextResponse.json<GenerateResponse>({
        success: true,
        image: output.data,
        ...(output.url && { sourceUrl: output.url }),
        contentType: "image",
      });
    }

    if (provider === "wavespeed") {
      // User-provided key takes precedence over env variable
      const wavespeedApiKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY;
      if (!wavespeedApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "WaveSpeed API key not configured. Add WAVESPEED_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Keep Data URIs as-is since localhost URLs won't work
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel!.modelId,
          name: selectedModel!.displayName,
          provider: "wavespeed",
          capabilities: mediaType === "video" ? ["text-to-video"] : ["text-to-image"],
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      const result = await generateWithWaveSpeed(requestId, wavespeedApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: result.error || "Generation failed",
          },
          { status: 500 }
        );
      }

      // Return first output (image or video)
      const output = result.outputs?.[0];
      if (!output?.data) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: "No output in generation result",
          },
          { status: 500 }
        );
      }

      // Return appropriate fields based on output type
      if (output.type === "video") {
        const isUrl = output.data.startsWith("http");
        return NextResponse.json<GenerateResponse>({
          success: true,
          video: isUrl ? undefined : output.data,
          videoUrl: isUrl ? output.data : undefined,
          ...(output.url && { sourceUrl: output.url }),
          contentType: "video",
        });
      }

      return NextResponse.json<GenerateResponse>({
        success: true,
        image: output.data,
        ...(output.url && { sourceUrl: output.url }),
        contentType: "image",
      });
    }

    // Default: Use Gemini
    // User-provided key (from settings) takes precedence over env variable
    const geminiApiKey = request.headers.get("X-Gemini-API-Key") || process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "API key not configured. Add GEMINI_API_KEY to .env.local or configure in Settings.",
        },
        { status: 500 }
      );
    }

    // Use selectedModel.modelId if available (new format), fallback to legacy model field
    const geminiModel = (selectedModel?.modelId as ModelType) || model;

    return await generateWithGemini(
      requestId,
      geminiApiKey,
      prompt,
      images || [],
      geminiModel,
      aspectRatio,
      resolution,
      useGoogleSearch
    );
  } catch (error) {
    // Extract error information
    let errorMessage = "Generation failed";
    let errorDetails = "";

    if (error instanceof Error) {
      errorMessage = error.message;
      if ("cause" in error && error.cause) {
        errorDetails = JSON.stringify(error.cause);
      }
    }

    // Try to extract more details from API errors
    if (error && typeof error === "object") {
      const apiError = error as Record<string, unknown>;
      if (apiError.status) {
        errorDetails += ` Status: ${apiError.status}`;
      }
      if (apiError.statusText) {
        errorDetails += ` ${apiError.statusText}`;
      }
    }

    // Handle rate limiting
    if (errorMessage.includes("429")) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "Rate limit reached. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    console.error(`[API:${requestId}] Generation error: ${errorMessage}${errorDetails ? ` (${errorDetails.substring(0, 200)})` : ""}`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
