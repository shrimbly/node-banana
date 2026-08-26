/**
 * fal.ai Provider for Generate API Route
 *
 * Handles image/video generation using fal.ai's Queue API.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import type { GenerationCostReceipt } from "@/types";
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
  requiredParams: Set<string>;
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

function finiteNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function parseBillableUnits(value: string | null): number | null {
  if (!value || value.trim() === "") return null;
  return finiteNonNegativeNumber(Number(value));
}

interface FalBillingEvent {
  request_id?: unknown;
  output_units?: unknown;
  unit_price?: unknown;
  cost_total?: unknown;
  cost_estimate_nano_usd?: unknown;
}

function formatFieldName(name: string): string {
  return name
    .replace(/_url$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function hasRequestValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

async function describeFalHttpError(response: Response): Promise<string> {
  const errorText = await response.text();
  if (!errorText) return `HTTP ${response.status}`;

  try {
    const errorJson = JSON.parse(errorText) as {
      error?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    if (typeof errorJson.error === "object" && errorJson.error && "message" in errorJson.error) {
      const message = (errorJson.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (Array.isArray(errorJson.detail)) {
      return errorJson.detail.map((detail) => {
        const item = detail as { msg?: unknown; loc?: unknown };
        const field = Array.isArray(item.loc)
          ? item.loc.filter((part): part is string => typeof part === "string" && part !== "body").at(-1)
          : undefined;
        if (typeof item.msg === "string") {
          return field && /^field required$/i.test(item.msg)
            ? `Missing required field: ${formatFieldName(field)}`
            : field ? `${formatFieldName(field)}: ${item.msg}` : item.msg;
        }
        return JSON.stringify(detail);
      }).join("; ");
    }
    if (typeof errorJson.detail === "string") return errorJson.detail;
    if (typeof errorJson.message === "string") return errorJson.message;
    if (typeof errorJson.error === "string") return errorJson.error;
  } catch {
    // Preserve non-JSON provider error bodies below.
  }

  return errorText;
}

/**
 * Build a request-level cost receipt from fal's billing event for this exact
 * request. Model pricing may be fallback compute pricing rather than the
 * amount charged for a marketplace model.
 */
async function buildFalGenerationCost(
  modelId: string,
  requestId: string,
  units: number | null,
  apiKey: string | null
): Promise<GenerationCostReceipt> {
  const unavailable: GenerationCostReceipt = {
    provider: "fal",
    requestId,
    modelId,
    units,
    unit: null,
    unitPrice: null,
    currency: null,
    cost: null,
  };

  if (!apiKey) return unavailable;

  try {
    const url = new URL("https://api.fal.ai/v1/models/billing-events");
    url.searchParams.set("request_id", requestId);
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
    });

    if (!response.ok) {
      console.warn(`[fal.ai] Billing lookup failed for ${requestId}: ${response.status}`);
      return unavailable;
    }

    const data = await response.json() as { billing_events?: unknown };
    const event = Array.isArray(data.billing_events)
      ? data.billing_events.find(
        (item: FalBillingEvent) => item.request_id === requestId
      ) as FalBillingEvent | undefined
      : null;
    const eventUnits = finiteNonNegativeNumber(event?.output_units);
    const unitPrice = finiteNonNegativeNumber(event?.unit_price);
    const directCost = finiteNonNegativeNumber(event?.cost_total);
    const nanoCost = finiteNonNegativeNumber(event?.cost_estimate_nano_usd);
    const cost = directCost ?? (nanoCost === null ? null : nanoCost / 1_000_000_000);

    return {
      ...unavailable,
      units: eventUnits ?? units,
      unitPrice,
      currency: cost === null ? null : "USD",
      cost,
    };
  } catch (error) {
    console.warn(
      `[fal.ai] Billing lookup failed for ${requestId}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return unavailable;
  }
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
  const requiredParams = new Set<string>();

  try {
    // Use fal.ai Model Search API with OpenAPI expansion
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Key ${apiKey}`;
    }

    const url = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams };
    }

    const data = await response.json();
    const modelData = data.models?.[0];
    if (!modelData?.openapi) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams };
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
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams };
    }

    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    if (!properties) return { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams };

    const required = inputSchema.required;
    for (const name of Array.isArray(required) ? required : []) {
      if (typeof name === "string") requiredParams.add(name);
    }

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

    const result = { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams };
    falInputMappingCache.set(modelId, { result, timestamp: Date.now() });
    return result;
  } catch {
    // Schema parsing failed - return defaults without caching so next call retries
    return { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams };
  }
}

export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MB

/** Maximum size for downloaded result media (mirrors kie.ts / wavespeed.ts) */
const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB

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
 * Submit a job to the fal.ai queue and return its durable task id.
 *
 * This intentionally does not wait for the result: holding a request open for
 * the length of a generation breaks once the wait exceeds a proxy or fetch
 * timeout, and it loses the job entirely on reload. Callers poll with
 * `checkFalTaskOnce` and collect output with `fetchFalMediaResult`.
 *
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */
export async function submitFalTask(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput
): Promise<{ taskId: string } | { error: string }> {
  console.log(`[API:${requestId}] fal.ai queue generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;
  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}, API key: ${apiKey ? "yes" : "no"}`);

  // Fetch schema for type coercion and input mapping (cached)
  const { paramMap, arrayParams, schemaArrayParams, parameterTypes, requiredParams } = await getFalInputMapping(modelId, apiKey);

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
        } else if (!schemaArrayParams.has(key) && Array.isArray(processedValue)) {
          // Unwrap array to single value if schema expects a string (e.g. image_url)
          if (processedValue.length > 0) {
            filteredInputs[key] = processedValue[0];
          }
        } else {
          filteredInputs[key] = processedValue;
        }
      }
    }
    Object.assign(requestBody, filteredInputs);

    // Ensure prompt is included even when dynamicInputs are present
    // (executor sends prompt as top-level field, not in dynamicInputs)
    const promptParam = paramMap.prompt || "prompt";
    if (input.prompt && !requestBody[promptParam]) {
      requestBody[promptParam] = input.prompt;
    }
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

  const missingFields = [...requiredParams].filter((name) => !hasRequestValue(requestBody[name]));
  if (missingFields.length > 0) {
    return {
      error: `${input.model.name}: Missing required field${missingFields.length === 1 ? "" : "s"}: ${missingFields.map(formatFieldName).join(", ")}`,
    };
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
    const errorDetail = await describeFalHttpError(submitResponse);

    if (submitResponse.status === 429) {
      return {
        error: `${input.model.name}: Rate limit exceeded. ${apiKey ? "Try again in a moment." : "Add an API key in settings for higher limits."}`,
      };
    }

    return { error: `${input.model.name}: ${errorDetail}` };
  }

  const submitResult = await submitResponse.json();
  console.log(`[API:${requestId}] Queue submit response:`, JSON.stringify(submitResult).substring(0, 500));
  const falRequestId = submitResult.request_id;

  if (!falRequestId) {
    console.error(`[API:${requestId}] No request_id in queue submit response`);
    return { error: "No request_id in queue response" };
  }

  const statusUrl = getFalQueueUrl(submitResult.status_url, true);
  const responseUrl = getFalQueueUrl(submitResult.response_url, false);
  console.log(`[API:${requestId}] Queue request submitted: ${falRequestId}`);

  // Some models return queue URLs that cannot be inferred solely from their
  // endpoint id. Keep Fal's URLs in the durable task id so reload recovery
  // polls exactly the endpoint that accepted the job.
  return {
    taskId: createFalTaskId(modelId, falRequestId, statusUrl, responseUrl),
  };
}

interface FalTaskIdParts {
  modelId: string;
  falRequestId: string;
  statusUrl?: string;
  responseUrl?: string;
}

function getFalQueueUrl(value: unknown, isStatusUrl: boolean): string | null {
  if (typeof value !== "string") return null;
  const urlCheck = validateMediaUrl(value);
  if (!urlCheck.valid) return null;

  try {
    const parsed = new URL(value);
    const expectedSuffix = isStatusUrl ? "/status" : "";
    if (
      parsed.origin !== "https://queue.fal.run" ||
      !parsed.pathname.includes("/requests/") ||
      (expectedSuffix && !parsed.pathname.endsWith(expectedSuffix))
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function createFalTaskId(
  modelId: string,
  falRequestId: string,
  statusUrl: string | null,
  responseUrl: string | null
): string {
  if (!statusUrl || !responseUrl) return `${modelId}::${falRequestId}`;
  return `${modelId}::${falRequestId}::${encodeURIComponent(statusUrl)}::${encodeURIComponent(responseUrl)}`;
}

/** Splits the durable task id back into its queue request and provider URLs. */
export function parseFalTaskId(taskId: string): FalTaskIdParts | null {
  const parts = taskId.split("::");
  if (parts.length !== 2 && parts.length !== 4) return null;
  const [modelId, falRequestId, encodedStatusUrl, encodedResponseUrl] = parts;
  // Model ids are path-like (for example, fal-ai/flux/schnell) and queue ids
  // are UUID-like. Keeping this narrow prevents a client-held task id from
  // changing which endpoint the server polls.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(modelId) ||
    modelId.includes("..") ||
    !/^[A-Za-z0-9-]+$/.test(falRequestId)
  ) {
    return null;
  }

  if (!encodedStatusUrl || !encodedResponseUrl) return { modelId, falRequestId };

  try {
    const statusUrl = getFalQueueUrl(decodeURIComponent(encodedStatusUrl), true);
    const responseUrl = getFalQueueUrl(decodeURIComponent(encodedResponseUrl), false);
    return statusUrl && responseUrl ? { modelId, falRequestId, statusUrl, responseUrl } : null;
  } catch {
    return null;
  }
}

function falQueueUrls(
  task: FalTaskIdParts
): { statusUrl: string; responseUrl: string } | null {
  if (task.statusUrl && task.responseUrl) {
    return { statusUrl: task.statusUrl, responseUrl: task.responseUrl };
  }

  const base = `https://queue.fal.run/${task.modelId}/requests/${encodeURIComponent(task.falRequestId)}`;
  // The task id now arrives from the client, so confirm the composed URL still
  // resolves to fal's queue host before we fetch it.
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.origin !== "https://queue.fal.run" || !parsed.pathname.includes("/requests/")) {
    return null;
  }
  return { statusUrl: `${parsed.href}/status`, responseUrl: parsed.href };
}

/**
 * Check a fal queue task once (no polling loop).
 * Network hiccups report as "processing" so a single failed poll does not end
 * a generation that is still running on fal's side.
 */
export async function checkFalTaskOnce(
  requestId: string,
  apiKey: string | null,
  taskId: string
): Promise<{ status: "processing" | "completed" | "failed"; error?: string }> {
  const parsed = parseFalTaskId(taskId);
  if (!parsed) return { status: "failed", error: "Malformed fal task id" };

  const urls = falQueueUrls(parsed);
  if (!urls) return { status: "failed", error: "Malformed fal task id" };
  const { statusUrl } = urls;

  let statusResponse: Response;
  try {
    statusResponse = await fetch(statusUrl, {
      headers: apiKey ? { Authorization: `Key ${apiKey}` } : {},
    });
  } catch (err) {
    console.warn(`[API:${requestId}] fal poll network error:`, err);
    return { status: "processing" };
  }

  if (!statusResponse.ok) {
    if (statusResponse.status === 429 || statusResponse.status >= 500) {
      return { status: "processing" };
    }
    console.error(`[API:${requestId}] Failed to poll status: ${statusResponse.status}`);
    return { status: "failed", error: `Failed to poll status: ${statusResponse.status}` };
  }

  const statusResult = await statusResponse.json().catch(() => null);
  const status = statusResult?.status;

  if (status === "COMPLETED") return { status: "completed" };
  if (status === "FAILED") {
    const errorMessage = statusResult?.error || "Generation failed";
    console.error(`[API:${requestId}] Queue request failed: ${errorMessage}`);
    return { status: "failed", error: String(errorMessage) };
  }

  // IN_QUEUE, IN_PROGRESS, or anything unrecognised: keep waiting.
  return { status: "processing" };
}

export interface FalMediaResultInput {
  taskId: string;
  modelName: string;
  capabilities: string[];
}

/**
 * Fetch the final media for a completed fal queue task.
 */
export async function fetchFalMediaResult(
  requestId: string,
  apiKey: string | null,
  info: FalMediaResultInput
): Promise<GenerationOutput> {
  const parsed = parseFalTaskId(info.taskId);
  if (!parsed) return { success: false, error: "Malformed fal task id" };

  const { modelId, falRequestId } = parsed;
  const urls = falQueueUrls(parsed);
  if (!urls) return { success: false, error: "Malformed fal task id" };
  const { responseUrl } = urls;
  const { capabilities, modelName } = info;

  const resultResponse = await fetch(
    responseUrl,
    { headers: apiKey ? { "Authorization": `Key ${apiKey}` } : {} }
  );

  if (!resultResponse.ok) {
    const errorDetail = await describeFalHttpError(resultResponse);
    console.error(`[API:${requestId}] Failed to fetch result: ${resultResponse.status} ${errorDetail}`);
    return {
      success: false,
      error: `${modelName}: ${errorDetail}`,
    };
  }

  const billedUnits = parseBillableUnits(
    resultResponse.headers?.get?.("x-fal-billable-units") ?? null
  );
  const providerRequestId =
    resultResponse.headers?.get?.("x-fal-request-id") || falRequestId;
  let generationCostPromise: Promise<GenerationCostReceipt> | null = null;
  const getGenerationCost = () => {
    generationCostPromise ??= buildFalGenerationCost(
      modelId,
      providerRequestId,
      billedUnits,
      apiKey
    );
    return generationCostPromise;
  };

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
  } else if (result.model_glb?.url) {
    mediaUrl = result.model_glb.url;
  } else if (result.model_urls?.glb?.url) {
    mediaUrl = result.model_urls.glb.url;
  } else if (result.video && result.video.url) {
    mediaUrl = result.video.url;
  } else if (result.audio && result.audio.url) {
    mediaUrl = result.audio.url;
  } else if (result.images && Array.isArray(result.images) && result.images.length > 0) {
    mediaUrl = result.images[0].url;
  } else if (result.image && result.image.url) {
    mediaUrl = result.image.url;
  } else if (result.output && typeof result.output === "string") {
    mediaUrl = result.output;
  }

  if (!mediaUrl) {
    console.error(`[API:${requestId}] No media URL found in queue result. Result keys: ${Object.keys(result).join(", ")}`);
    return {
      success: false,
      error: "No media URL in response",
    };
  }

  const is3DModel = capabilities.some(c => c.includes("3d"));
  const isVideoModel = capabilities.some(c => c.includes("video"));
  const isAudioModel = capabilities.some(c => c.includes("audio"));

  // For 3D models, return URL directly (GLB files are binary — don't base64 encode)
  if (is3DModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return {
      success: true,
      generationCost: await getGenerationCost(),
      outputs: [
        {
          type: "3d",
          data: "",
          url: mediaUrl,
        },
      ],
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

  // Detect actual media type from response content-type, falling back to model hints
  const rawContentType = mediaResponse.headers.get("content-type") || "";
  const isAudioResponse = rawContentType.startsWith("audio/") || (!rawContentType.startsWith("video/") && !rawContentType.startsWith("image/") && isAudioModel);

  // Enforce max media size via content-length before buffering the body (mirrors kie.ts)
  const mediaContentLength = parseInt(mediaResponse.headers.get("content-length") || "0", 10);
  if (mediaContentLength > MAX_MEDIA_SIZE) {
    const isVideoResponse = rawContentType.startsWith("video/") || (!isAudioResponse && isVideoModel);
    if (isVideoResponse) {
      console.log(`[API:${requestId}] SUCCESS - Returning URL for oversized video (${(mediaContentLength / (1024 * 1024)).toFixed(0)}MB)`);
      return {
        success: true,
        generationCost: await getGenerationCost(),
        outputs: [{ type: "video", data: "", url: mediaUrl }],
      };
    }
    return { success: false, error: `Media too large: ${(mediaContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }

  if (isAudioResponse) {
    const audioContentType = rawContentType.startsWith("audio/") ? rawContentType : "audio/mpeg";
    const audioBuffer = await mediaResponse.arrayBuffer();
    if (audioBuffer.byteLength > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(audioBuffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
    }
    const audioBase64 = Buffer.from(audioBuffer).toString("base64");
    console.log(`[API:${requestId}] SUCCESS - Returning audio`);
    return {
      success: true,
      generationCost: await getGenerationCost(),
      outputs: [{
        type: "audio",
        data: `data:${audioContentType};base64,${audioBase64}`,
        url: mediaUrl,
      }],
    };
  }

  const contentType = rawContentType || (isVideoModel ? "video/mp4" : "image/png");
  const isVideo = contentType.startsWith("video/");

  const mediaArrayBuffer = await mediaResponse.arrayBuffer();
  const mediaSizeBytes = mediaArrayBuffer.byteLength;
  const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

  // Post-download size guard in case content-length was missing/inaccurate (mirrors kie.ts)
  if (mediaSizeBytes > MAX_MEDIA_SIZE) {
    if (isVideo) {
      console.log(`[API:${requestId}] SUCCESS - Returning URL for oversized video (${mediaSizeMB.toFixed(0)}MB)`);
      return {
        success: true,
        generationCost: await getGenerationCost(),
        outputs: [{ type: "video", data: "", url: mediaUrl }],
      };
    }
    return { success: false, error: `Media too large: ${mediaSizeMB.toFixed(0)}MB > 500MB limit` };
  }

  console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL only (data left empty for consumers)
  if (isVideo && mediaSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      generationCost: await getGenerationCost(),
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
    generationCost: await getGenerationCost(),
    outputs: [
      {
        type: isVideo ? "video" : "image",
        data: `data:${contentType};base64,${mediaBase64}`,
        url: mediaUrl,
      },
    ],
  };
}
