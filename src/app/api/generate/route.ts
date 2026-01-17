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
import { annotateDynamicAccess } from "next/dist/server/app-render/dynamic-rendering";

export const maxDuration = 600; // 10 minute timeout for video generation (Vercel only)
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
  dynamicInputs?: Record<string, string>;
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
 * Fetch fal.ai model schema and extract input parameter mappings
 * Uses the Model Search API with OpenAPI expansion (same as /api/models/[modelId])
 */
// 修改 route.ts 中的 getFalInputMapping 函数头部
async function getFalInputMapping(modelId: string, _unusedApiKey: string | null): Promise<FalInputMapping> {
  // 强制使用环境变量中的只读 Key
  // 这样无论前端传什么 Key，获取 Schema 都只走官方免费/低成本通道
  const readOnlyKey = process.env.FAL_READ_ONLY_KEY;

  const paramMap: Record<string, string> = {};
  const arrayParams = new Set<string>();
  const schemaArrayParams = new Set<string>();
  const parameterTypes: ParameterTypeInfo = {};

  try {
    const headers: Record<string, string> = {};
    if (readOnlyKey) {
      headers["Authorization"] = `Key ${readOnlyKey}`;
    }

    // URL 保持不变，指向 Fal 官方获取元数据
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

  return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
}

/**
 * Generate image using fal.ai API
 */
async function generateWithFal(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] fal.ai generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;
  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}, API key: ${apiKey ? "yes" : "no"}`);

  // Fetch schema for type coercion and input mapping (only one API call)
  const { paramMap, arrayParams, schemaArrayParams, parameterTypes } = await getFalInputMapping(modelId, apiKey);

  // Build request body, coercing parameter types from schema
  // If we have dynamic inputs, they take precedence (they already contain prompt, image_url, etc.)
  const requestBody: Record<string, unknown> = {
    ...coerceParameterTypes(input.parameters, parameterTypes),
  };

  // Add dynamic inputs if provided (these come from schema-mapped connections)
  // Filter out empty/null/undefined values to avoid sending invalid inputs to fal.ai
  if (hasDynamicInputs) {
    const filteredInputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        // Wrap in array if schema expects array but we have a single value
        if (schemaArrayParams.has(key) && !Array.isArray(value)) {
          filteredInputs[key] = [value];
        } else {
          filteredInputs[key] = value;
        }
      }
    }
    Object.assign(requestBody, filteredInputs);
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names

    // Map prompt input
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      requestBody[promptParam] = input.prompt;
    }

    // Map image input - use array or string format based on schema
    if (input.images && input.images.length > 0) {
      const imageParam = paramMap.image || "image_url";
      if (arrayParams.has("image")) {
        requestBody[imageParam] = input.images;
      } else {
        requestBody[imageParam] = input.images[0];
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

  // POST to fal.run/{modelId}
  // Use 10 minute timeout to handle long-running video generation
  console.log(`[API:${requestId}] Calling fal.ai API with inputs: ${Object.keys(requestBody).join(", ")}`);
  const response = await fetch(`https://fal.run/${modelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(10 * 60 * 1000), // 10 minute timeout
  });

  if (!response.ok) {
    const errorText = await response.text();

    let errorDetail = errorText || `HTTP ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      // Handle various fal.ai error formats
      if (typeof errorJson.error === 'object' && errorJson.error?.message) {
        errorDetail = errorJson.error.message;
      } else if (errorJson.detail) {
        // Handle array of validation errors
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

    // Handle rate limits
    if (response.status === 429) {
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

  const result = await response.json();

  // fal.ai response can have different structures:
  // - images: array with url field (image models)
  // - image: object with url field (image models)
  // - video: object with url field (video models)
  // - output: string URL (some models)
  let mediaUrl: string | null = null;
  let isVideoModel = false;

  // Check for video output first (video models)
  if (result.video && result.video.url) {
    mediaUrl = result.video.url;
    isVideoModel = true;
  } else if (result.images && Array.isArray(result.images) && result.images.length > 0) {
    mediaUrl = result.images[0].url;
  } else if (result.image && result.image.url) {
    mediaUrl = result.image.url;
  } else if (result.output && typeof result.output === "string") {
    // Some models return URL directly in output
    mediaUrl = result.output;
  }

  if (!mediaUrl) {
    console.error(`[API:${requestId}] No media URL found in fal.ai response`);
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

  // Determine MIME type from response
  const contentType = mediaResponse.headers.get("content-type") || (isVideoModel ? "video/mp4" : "image/png");
  const isVideo = contentType.startsWith("video/") || isVideoModel;

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
 * Generate video using fal.ai Queue API
 * Uses async queue submission + polling to handle long-running video generation
 * that would otherwise timeout with the blocking fal.run endpoint.
 * 
 * NOTE: This function is NOT currently used because fal.ai's queue API has file size
 * limitations that are too restrictive. We use the blocking fal.run endpoint instead
 * with an extended server timeout configured in server.js.
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

  // Build request body (same logic as generateWithFal)
  const requestBody: Record<string, unknown> = {
    ...input.parameters,
  };

  if (hasDynamicInputs) {
    const { schemaArrayParams } = await getFalInputMapping(modelId, apiKey);

    const filteredInputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        if (schemaArrayParams.has(key) && !Array.isArray(value)) {
          filteredInputs[key] = [value];
        } else {
          filteredInputs[key] = value;
        }
      }
    }
    Object.assign(requestBody, filteredInputs);
  } else {
    const { paramMap, arrayParams } = await getFalInputMapping(modelId, apiKey);

    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      requestBody[promptParam] = input.prompt;
    }

    if (input.images && input.images.length > 0) {
      const imageParam = paramMap.image || "image_url";
      if (arrayParams.has("image")) {
        requestBody[imageParam] = input.images;
      } else {
        requestBody[imageParam] = input.images[0];
      }
    }

    if (input.parameters) {
      for (const [key, value] of Object.entries(input.parameters)) {
        const mappedKey = paramMap[key] || key;
        requestBody[mappedKey] = value;
      }
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
  const pollInterval = 2000; // 2 seconds
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

      // Extract video URL from result (same logic as generateWithFal)
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

/**
 * Generate using Yunwu API (Fal Proxy)
 * [已修改] 增加 Schema 获取失败时的容错处理 (Blind Pass Mode)
 */
// src/app/api/generate/route.ts

// ==============================================================================
// 1. 类型定义与全量配置
// ==============================================================================

type HandlerType = "yunwu_video_unified" | "yunwu_image_openai" | "kling_native" | "yunwu_gemini_native";

interface RouteConfig {
  type: HandlerType;
  targetId?: string;     
  endpoint?: string;     
  extraParams?: any;     
}

// ==============================================================================
// 1. 全量硬编码映射表 (精确控制每一个按钮)
// ==============================================================================

const MODEL_MAPPINGS: Record<string, RouteConfig> = {
  // === Veo 3.1 系列 (根据你的截图一一对应) ===
  
  // 1. Veo 3.1 (文生视 / 图生视通用)
  "fal-ai/veo3.1": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1" 
  },
  
  // 2. Veo 3.1 - image-to-video (其实还是调用的 veo3.1，只是前端入口不同)
  "fal-ai/veo3.1/image-to-video": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1" 
  },

  // 3. Veo 3.1 - reference-to-video
  "fal-ai/veo3.1/reference-to-video": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1-components" 
  },

  // 4. Veo 3.1 Fast (快速版)
  "fal-ai/veo3.1/fast": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1-fast" 
  },

  // 5. Veo 3.1 Fast - image-to-video
  "fal-ai/veo3.1/fast/image-to-video": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1-fast" 
  },

  // === 特殊模型：首尾帧 (Frames) ===
  // 如果云雾区分了 specialized model，可以在这里指定
  // 如果云雾没区分，就还是填 "veo3.1" 或 "veo3.1-fast"
  
  // 6. Veo 3.1 - first-last-frame
  "fal-ai/veo3.1/first-last-frame-to-video": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1" // 或者 "veo3.1-frames"，取决于云雾文档
  },

  // 7. Veo 3.1 Fast - first-last-frame
  "fal-ai/veo3.1/fast/first-last-frame-to-video": { 
      type: "yunwu_video_unified", 
      targetId: "veo3.1-fast" // 或者 "veo3.1-fast-frames"
  },

// === ✅ 接管 Nano 模型 (使用 Gemini 原生协议) ===
  "nano-banana": { 
      type: "yunwu_gemini_native",  // 指定使用原生处理器
      targetId: "gemini-2.5-flash-image-preview" // 🔥 云雾文档指定的真实ID
  },
  "nano-banana-pro": { 
      type: "yunwu_gemini_native", 
      targetId: "gemini-3-pro-image-preview" // 两个都指向这个模型
  },

  // === 旧版 Veo 3 系列 ===
  "fal-ai/veo3":      { type: "yunwu_video_unified", targetId: "veo3" },
  "fal-ai/veo3/fast": { type: "yunwu_video_unified", targetId: "veo3-fast" },

  // === 可灵 (Kling) ===
  "fal-ai/kling-video/v2.6/pro/text-to-video": { type: "kling_native", targetId: "kling-v2-6" },
  "fal-ai/kling-video/v2.6/pro/image-to-video": { type: "kling_native", targetId: "kling-v2-6" },

  // === sora ===
  "fal-ai/sora-2/text-to-video":     { type: "yunwu_video_unified", targetId: "sora-2-all" },
  "fal-ai/sora-2/image-to-video": { type: "yunwu_video_unified", targetId: "sora-2-all" },

  // 🟢 [新增] 即梦 Jimeng 4.5
  // 注意：如果您前端传来的 ID 是其他名字（比如 "fal-ai/jimeng-4.5"），请把 key 改成对应的
  "fal-ai/bytedance/seedream/v4.5/text-to-image": { type: "yunwu_image_openai", targetId: "jimeng-4.5" },
};

// ==============================================================================
// 2. 主调度函数 (Dispatcher)
// ==============================================================================

async function generateWithYunwu(
  requestId: string,
  modelId: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  // 🔴【重要】请填入你的真实 Key (注意保留双引号)
  const apiKey = "sk-G9OD26R2tuusKudilRLdt8XT8HbxE1o09LeddI9vkEpDSoUG"; 
  
  const YUNWU_BASE = (process.env.YUNWU_BASE_URL || "https://yunwu.ai").replace(/\/$/, "");

  if (!apiKey || apiKey.includes("你的真实Key")) {
    return { success: false, error: "Server Error: API Key not configured." };
  }

  // 1. 确定路由策略
  let config = MODEL_MAPPINGS[modelId];

  // 2. 如果表里没查到，记录一个警告，或者给个默认值
  if (!config) {
    console.warn(`[API:${requestId}] ⚠️ Warning: Unknown model ID "${modelId}". Falling back to Flux.`);
    // 兜底策略：防止前端传了个新 ID 导致报错
    config = { type: "yunwu_image_openai", targetId: "flux-dev" };
  }

  console.log(`[API:${requestId}] 🚀 Routing: ${modelId} -> [${config.type}] -> Target: ${config.targetId}`);

  // 3. 分发执行
  try {
    switch (config.type) {
      case "yunwu_video_unified":
        return await handleYunwuVideo(requestId, apiKey, YUNWU_BASE, config, input);
      case "yunwu_image_openai":
        return await handleYunwuImage(requestId, apiKey, YUNWU_BASE, config, input);
      case "kling_native":
        return await handleKling(requestId, apiKey, YUNWU_BASE, config, input);

      // ✅✅✅ [新增] Gemini 原生协议分支
      case "yunwu_gemini_native":
        return await handleYunwuGeminiNative(requestId, apiKey, YUNWU_BASE, config, input);

      default:
        throw new Error(`Unknown handler type: ${config.type}`);
    }
  } catch (error: any) {
    console.error(`[API:${requestId}] Error:`, error);
    return { success: false, error: error.message || "Generation failed" };
  }
}

// ==============================================================================
// 3. 策略处理器 (Handlers)
// ==============================================================================

// 🟢 处理器 A: 云雾统一视频接口 (/v1/video/create)
// 🟢 处理器: 云雾视频接口 (Sora-2 + Veo/Kling 全能兼容版 - 修复红线版)
async function handleYunwuVideo(
  reqId: string, apiKey: string, baseUrl: string, config: RouteConfig, input: GenerationInput
): Promise<GenerationOutput> {
  const url = `${baseUrl}/v1/video/create`;

  // 🛡️ 修复红线关键步骤：确保 modelId 永远是字符串，不是 undefined
  const modelId = config.targetId || ""; 
  
  // 1. 获取前端参数
  const p = input.parameters || {};
  const rawRatio = p.aspectRatio || p.aspect_ratio || "16:9"; 
  const rawDuration = p.duration || 10;
  
  // 2. 初始化 Body
  const body: any = {
    model: modelId, // 使用安全的变量
    prompt: input.prompt,
    watermark: false,
  };

  // ---------------------------------------------------------
  // 🔀 分支 A: 如果是 Sora-2
  // ---------------------------------------------------------
  if (modelId.includes("sora")) { // 👈 这里使用 modelId 就不报错了
    
    // 1. 翻译画幅
    const ratioStr = String(rawRatio).toLowerCase();
    if (ratioStr.includes("9:") || ratioStr.includes("port") || ratioStr === "1:1") {
      body.orientation = "portrait";
    } else {
      body.orientation = "landscape";
    }

    // 2. 翻译分辨率
    const rawSize = p.resolution || p.size || "1080p";
    if (String(rawSize).includes("720") || String(rawSize).includes("small")) {
      body.size = "small";
    } else {
      body.size = "large";
    }

    // 3. 翻译时长
    body.duration = parseInt(String(rawDuration)) || 10;
    body.private = false;

    // 4. 图片处理
    const imgs = extractImages(input);
    if (imgs.length > 0) body.images = imgs;

  } 
  // ---------------------------------------------------------
  // 🔀 分支 B: 如果是 Veo / Kling
  // ---------------------------------------------------------
  else {
    body.enhance_prompt = true;
    body.aspect_ratio = rawRatio;
    
    const dynamicParams = input.dynamicInputs || {};
    const startImg = dynamicParams["image_url"] || p["image_url"] || p["image"];
    if (startImg) body.image_url = startImg;
    
    const endImg = dynamicParams["reference_image"] || p["end_frame_url"];
    if (endImg) body.end_frame_url = endImg;

    // Kling 兼容逻辑
    if (modelId.includes("kling")) { // 👈 这里也修复了
        const imgs = extractImages(input);
        if (imgs.length > 0) body.images = imgs;
    }
  }

  // 3. 发送请求
  return await sendAndPoll(reqId, url, apiKey, body, (data) => {
    return data.id ? `${baseUrl}/v1/video/query?id=${data.id}` : null;
  });
}

// 🟢 处理器 B: OpenAI 绘图接口
// src/app/api/generate/route.ts

// 🟢 处理器 B: OpenAI 绘图接口 (已升级兼容 Jimeng)
async function handleYunwuImage(
  reqId: string, apiKey: string, baseUrl: string, config: RouteConfig, input: GenerationInput
): Promise<GenerationOutput> {
  const url = `${baseUrl}/v1/images/generations`;
  
  // 1. 基础参数构造
  const body: any = {
    model: config.targetId, // 例如 "jimeng-4.5"
    prompt: input.prompt,
    n: 1,
    size: "1024x1024", // 默认兜底
    ...config.extraParams
  };
  
  // 2. 🟢 智能参数提取 (兼容 Jimeng/OpenAI/Fal 各种写法)
  const p = input.parameters || {};

  // 优先级：size (标准) > aspect_ratio (Fal常用) > image_size (Fal旧版) > aspectRatio
  const userSize = p.size || p.aspect_ratio || p.image_size || p.aspectRatio;

  if (userSize) {
      // 情况 A: 字符串直接透传 (例如 "1024x1024" 或 Jimeng 支持的 "2:3")
      if (typeof userSize === 'string') {
          body.size = userSize;
      } 
      // 情况 B: 对象格式 {width: 1024, height: 768} -> 转字符串
      else if ((userSize as any).width && (userSize as any).height) {
          body.size = `${(userSize as any).width}x${(userSize as any).height}`;
      }
  }

  console.log(`[API:${reqId}] POST Image: ${url} | Model: ${body.model} | Size: ${body.size}`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
      const errText = await res.text();
      console.error(`[API:${reqId}] Image Error:`, errText);
      throw new Error(errText);
  }
  
  const data = await res.json();

  // 3. 解析结果 (标准 OpenAI 格式)
  if (data.data?.[0]?.url) {
    return { success: true, outputs: [{ type: "image", data: data.data[0].url, url: data.data[0].url }] };
  }
  
  // 4. 容错：如果返回的是 b64_json (部分 API 可能会返回这个)
  if (data.data?.[0]?.b64_json) {
      const base64 = data.data[0].b64_json;
      const dataUrl = `data:image/png;base64,${base64}`;
      return { success: true, outputs: [{ type: "image", data: dataUrl, url: dataUrl }] };
  }

  throw new Error("Unknown image response format: " + JSON.stringify(data));
}

// 🟢 [新增] 处理器 D: 云雾 Gemini 原生协议专用
// 专门处理 gemini-3-pro-image-preview 模型，支持原生 aspectRatio 和 resolution
async function handleYunwuGeminiNative(
  reqId: string, 
  apiKey: string, 
  baseUrl: string, 
  config: RouteConfig, 
  input: GenerationInput
): Promise<GenerationOutput> {
  // 1. 构造精确的 URL
  // 您的文档端点: /v1beta/models/gemini-3-pro-image-preview:generateContent
  // config.targetId 稍后会在映射表里填 "gemini-3-pro-image-preview"
  const url = `${baseUrl}/v1beta/models/${config.targetId}:generateContent`;

  console.log(`[API:${reqId}] POST Yunwu-Gemini Native: ${url}`);

  // 2. 提取参数
  // 我们稍后会在 POST 函数里把 aspectRatio 和 resolution 塞进 parameters 里
  const params = input.parameters || {};
  const aspectRatio = params.aspect_ratio || params.aspectRatio; 
  const resolution = params.resolution; // 例如 "4K", "1K"

  console.log(`[API:${reqId}] Gemini Config: Ratio=${aspectRatio || "Default"}, Res=${resolution || "Default"}`);

  // 3. 构造 Google 原生请求体 (严格遵守 Google REST API 标准)
  const body: any = {
    contents: [
      {
        parts: [{ text: input.prompt }]
      }
    ],
    generationConfig: {
      responseModalities: ["IMAGE"], // 🔥 关键：告诉模型我们要生成图片
      imageConfig: {} 
    }
  };

  // 4. 注入参数 (透传给云雾)
  // 如果有宽高比 (如 "16:9")
  if (aspectRatio) {
      body.generationConfig.imageConfig.aspectRatio = aspectRatio;
  }
  
  // 如果有分辨率 (如 "4K")
  // Google 原生支持 "imageSize" 字段来接收 "4K" 这种字符串
  if (resolution) {
       body.generationConfig.imageConfig.imageSize = resolution;
  }

  // 5. 发送请求
  const res = await fetch(url, {
    method: "POST",
    headers: {
        "Authorization": `Bearer ${apiKey}`, // 云雾验证通常用 Bearer
        "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
      const errText = await res.text();
      console.error(`[API:${reqId}] Gemini Native Error:`, errText);
      throw new Error(`Cloud API Failed: ${errText}`);
  }

  const data = await res.json();
  
  // 6. 解析 Google 原生返回结构 (Base64)
  // 结构路径: candidates[0].content.parts[0].inlineData.data
  try {
      const candidate = data.candidates?.[0];
      const part = candidate?.content?.parts?.[0];
      
      // 检查是否有图片数据
      if (part?.inlineData?.data) {
          const base64Data = part.inlineData.data;
          const mimeType = part.inlineData.mimeType || "image/png";
          
          // 构造完整的 Data URL 返回给前端
          const dataUrl = `data:${mimeType};base64,${base64Data}`;
          return { success: true, outputs: [{ type: "image", data: dataUrl, url: dataUrl }] };
      }
  } catch (e) {
      console.error(`[API:${reqId}] Parse Error:`, e);
  }

  throw new Error("Unknown Gemini native response format");
}

// 🟢 处理器 C: Kling 专用 (v2.6 纯净版：无前缀 Base64 + 严格文档结构)
async function handleKling(
  reqId: string, apiKey: string, baseUrl: string, config: RouteConfig, input: GenerationInput
): Promise<GenerationOutput> {
  const images = extractImages(input);
  const isI2V = images.length > 0;
  
  // 1. 路径永远是 v1
  const typePath = isI2V ? "image2video" : "text2video";
  const url = `${baseUrl}/kling/v1/videos/${typePath}`;

  // 2. 准备 Duration
  let duration = "5"; 
  if (input.parameters?.duration) {
      const d = String(input.parameters.duration);
      if (d === "10" || d.includes("10")) duration = "10";
  }

  // 3. 准备 Mode (必填)
  let mode = "std";
  const modelIdLower = (config.targetId || "").toLowerCase();
  if (modelIdLower.includes("pro") || config.targetId === "kling-v2-6") {
      mode = "pro";
  }

  // 4. 构造基础请求体
  const body: any = {
    model_name: config.targetId || "kling-v2-6", 
    mode: mode,
    duration: duration,
    prompt: input.prompt,
    cfg_scale: 0.5,
    ...config.extraParams
  };

  // 5. 处理图片 (纯净 Base64)
  if (isI2V) {
    const imageUrl = images[0];
    console.log(`[API:${reqId}] 🔄 Converting Image URL to Pure Base64...`);
    
    try {
        let base64Str = "";
        
        if (imageUrl.startsWith("http")) {
            base64Str = await imageUrlToBase64(imageUrl);
        } else if (imageUrl.startsWith("data:")) {
            // 如果已经是 data URI，去掉前缀
            base64Str = imageUrl.split(",")[1];
        } else {
            base64Str = imageUrl;
        }

        // 🧹 彻底清洗：去掉可能存在的空格或换行符
        base64Str = base64Str.replace(/\s/g, "");
        
        // ❌ 移除所有 data:image 前缀，只保留纯字符
        // 很多后端只能解析纯字符
        body.image = base64Str; 
        
        // 🔍 调试：确保是以字符开头，不是 data:
        console.log(`[API:${reqId}] Base64 Start: "${base64Str.substring(0, 15)}..."`);

    } catch (e) {
        throw new Error(`Failed to process image: ${e}`);
    }
  }

  console.log(`[API:${reqId}] POST Kling Pure-Base64: ${url}`);
  console.log(`[API:${reqId}] Params: mode=${mode}, duration=${duration}`);

  // 6. 发送并轮询
  return await sendAndPoll(reqId, url, apiKey, body, (data) => {
    const tid = data.task_id || data.id || data.data?.task_id;
    if (!tid) {
        console.error(`[API:${reqId}] ❌ Submission Failed. Response:`, JSON.stringify(data));
        return null;
    }
    return `${baseUrl}/kling/v1/videos/${typePath}/${tid}`;
  });
}

// ==============================================================================
// 4. 通用发送与轮询 (完美适配 Kling v2.6 结构)
// ==============================================================================

async function sendAndPoll(
  reqId: string, 
  url: string, 
  apiKey: string, 
  body: any, 
  getQueryUrl: (data: any) => string | null
): Promise<GenerationOutput> {
  console.log(`[API:${reqId}] POST: ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  console.log(`[API:${reqId}] Submit Success: ${JSON.stringify(data)}`);

  // 1. 同步返回检查
  if (data.video_url || data.data?.video_url || data.data?.[0]?.url) {
     const vUrl = data.video_url || data.data?.video_url || data.data[0].url;
     return { success: true, outputs: [{ type: "video", data: vUrl, url: vUrl }] };
  }

  // 2. 轮询
  const queryUrl = getQueryUrl(data);
  if (!queryUrl) throw new Error(`No polling URL determined from: ${JSON.stringify(data)}`);

  console.log(`[API:${reqId}] Polling Start: ${queryUrl}`);
  const maxTime = 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxTime) {
    await new Promise(r => setTimeout(r, 3000));
    const qRes = await fetch(queryUrl, { headers: { "Authorization": `Bearer ${apiKey}` } });
    
    if (!qRes.ok) {
       if (qRes.status !== 404) console.warn(`[API:${reqId}] Poll status: ${qRes.status}`);
       continue;
    }
    
    const qData = await qRes.json();
    
    // 获取状态
    const rawStatus = 
        qData.data?.task_status || 
        qData.task_status || 
        qData.status || 
        qData.state;
    const status = String(rawStatus).toLowerCase();
    
    console.log(`[API:${reqId}] Status: "${rawStatus}"`);

    const successKeywords = [
        "succeed", "success", "succeeded", "completed", "finished", "done", 
        "video_generation_completed", "video_upsampling_completed"
    ];

    const failedKeywords = ["failed", "error", "cancelled", "timeout"];

    if (successKeywords.includes(status)) {
       // 🟢【核心修复】适配 Kling v2.6 的 videos 数组结构
       const finalUrl = 
           qData.data?.task_result?.videos?.[0]?.url || // <--- 命中这里！
           qData.data?.task_result?.video_url || 
           qData.data?.video_url || 
           qData.data?.video?.url || 
           qData.video_url || 
           qData.output?.video;
       
       if (finalUrl) {
           console.log(`[API:${reqId}] ✅ Success! URL: ${finalUrl}`);
           return { success: true, outputs: [{ type: "video", data: finalUrl, url: finalUrl }] };
       } else {
           console.log(`[API:${reqId}] Status OK but URL missing. Structure:`, JSON.stringify(qData));
       }
    }
    
    if (failedKeywords.includes(status)) {
       const errorMsg = qData.data?.task_status_msg || qData.task_status_msg || "Unknown Error";
       return { success: false, error: `Cloud Error: ${errorMsg}` };
    }
  }
  
  return { success: false, error: "Timeout: Generation took too long." };
}

// 辅助函数
function extractImages(input: GenerationInput): string[] {
  const imgs: string[] = [];
  if (input.images) imgs.push(...input.images);
  if (input.dynamicInputs) {
    for (const val of Object.values(input.dynamicInputs)) {
      if (typeof val === 'string' && val.startsWith('http')) imgs.push(val);
    }
  }
  return imgs;
}

function extractModelName(falId: string): string {
  const parts = falId.split('/');
  return parts[parts.length - 1]; 
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
    const hasPrompt = prompt || (dynamicInputs && dynamicInputs.prompt);
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
      let processedDynamicInputs: Record<string, string> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
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
          capabilities: ["text-to-image"],
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
          contentType: "video",
        });
      }

      return NextResponse.json<GenerateResponse>({
        success: true,
        image: output.data,
        contentType: "image",
      });
    }

    if (provider === "fal") {
      // === 修改开始：不再获取用户 Key，不再检查 X-Fal-API-Key ===
      
      // 保持原本的图片/动态参数处理逻辑
      const processedImages: string[] = images ? [...images] : [];
      let processedDynamicInputs: Record<string, string> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];
          if (value !== null && value !== undefined && value !== '') {
            processedDynamicInputs[key] = value;
          }
        }
      }

      // === [修复点] 安全构建 genInput，防止 selectedModel 为空导致崩溃 ===
      // 如果 selectedModel 不存在，就用外层的 model 变量兜底
      const targetModelId = selectedModel?.modelId || model;
      const targetModelName = selectedModel?.displayName || model;

      const genInput: GenerationInput = {
        model: {
          id: targetModelId,
          name: targetModelName,
          provider: "fal",
          capabilities: ["text-to-image"], 
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      // 打印调试日志，确认参数构建成功
      console.log(`[API:${requestId}] Calling Yunwu with Model ID: ${targetModelId}`);

      // === 核心修改：调用 generateWithYunwu ===
      const result = await generateWithYunwu(requestId, targetModelId, genInput);
      
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
          contentType: "video",
        });
      }

      return NextResponse.json<GenerateResponse>({
        success: true,
        image: output.data,
        contentType: "image",
      });
    }

    // ... (上方是 if (provider === "fal") { ... } 的结束大括号)

    // =================================================================
    // 4. Default: Gemini SDK & Legacy Nano Interception (云雾接管)
    // =================================================================
    
    // 🟢 核心拦截逻辑：检查当前模型是否在我们的映射表里 (比如 nano-banana)
    if (MODEL_MAPPINGS[model]) {
        console.log(`[API:${requestId}] 🔄 Takeover: Redirecting Legacy Model "${model}" to Yunwu API`);

        // 1. 参数重组：把前端散落在外的 aspectRatio 和 resolution 收集起来
        const finalParams = { ...(parameters || {}) };
        
        // 把根目录的 aspectRatio (如 "16:9") 移入 parameters
        if (aspectRatio) {
            finalParams.aspect_ratio = aspectRatio; 
            finalParams.aspectRatio = aspectRatio;
        }
        // 把根目录的 resolution (如 "4K") 移入 parameters
        if (resolution) {
            finalParams.resolution = resolution;
        }

        // 2. 构造通用 Input 对象
        const genInput: GenerationInput = {
            model: {
                id: model, // 例如 "nano-banana-pro"
                name: model,
                provider: "yunwu_internal" as any,
                capabilities: ["text-to-image"],
                description: null,
            },
            prompt: prompt || "",
            images: images ? [...images] : [],
            parameters: finalParams, // ✅ 包含宽高比和分辨率
            dynamicInputs: dynamicInputs,
        };

        // 3. 直接调用云雾处理函数 (❌ 彻底绕过 Google SDK)
        const result = await generateWithYunwu(requestId, model, genInput);

        // 4. 处理返回结果
        if (!result.success) {
            return NextResponse.json<GenerateResponse>(
                { success: false, error: result.error || "Generation failed" },
                { status: 500 }
            );
        }

        const output = result.outputs?.[0];
        if (!output?.data) {
            return NextResponse.json<GenerateResponse>(
                { success: false, error: "No output data" },
                { status: 500 }
            );
        }

        // 返回前端能识别的 JSON
        return NextResponse.json<GenerateResponse>({
            success: true,
            image: output.data,
            contentType: "image",
        });
    }

    // 🔴 下面是旧的 Google SDK 代码 (作为兜底保留)
    // 只有当模型 ID 不在您的 MODEL_MAPPINGS 里时，才会走到这里
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

    return await generateWithGemini(
      requestId,
      geminiApiKey,
      prompt,
      images || [],
      model,
      aspectRatio,
      resolution,
      useGoogleSearch
    );

  } catch (error) {
    // ... (catch 块保持不变)
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

// 🟢 辅助函数：将图片 URL 下载并转换为 Base64 字符串
async function imageUrlToBase64(url: string): Promise<string> {
  try {
    console.log(`[ImageUtils] Downloading image to convert to Base64: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download image: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString('base64');
  } catch (error) {
    console.error("Base64 conversion failed:", error);
    throw error;
  }
}