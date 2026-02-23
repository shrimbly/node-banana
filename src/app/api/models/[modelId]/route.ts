/**
 * Model Schema API Endpoint
 *
 * Fetches parameter schema for a specific model from its provider.
 * Returns simplified parameter list for UI rendering.
 *
 * GET /api/models/:modelId?provider=replicate|fal|wavespeed
 *
 * Headers:
 *   - X-Replicate-Key: Required for Replicate models
 *   - X-Fal-Key: Optional for fal.ai models
 *   - X-WaveSpeed-Key: Optional for WaveSpeed models
 *
 * Response:
 *   {
 *     success: true,
 *     parameters: ModelParameter[],
 *     cached: boolean
 *   }
 *
 * WaveSpeed models fetch schemas dynamically from the /api/v3/models endpoint,
 * with fallback to static definitions for models without api_schema.
 */

import { NextRequest, NextResponse } from "next/server";
import { ProviderType } from "@/types";
import { ModelParameter, ModelInput } from "@/lib/providers/types";
import {
  getCachedWaveSpeedSchema,
  setCachedWaveSpeedSchema,
  WaveSpeedApiSchema,
} from "@/lib/providers/cache";

// Cache for model schemas (10 minute TTL)
const schemaCache = new Map<string, { parameters: ModelParameter[]; inputs: ModelInput[]; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Image input property patterns
const IMAGE_INPUT_PATTERNS = [
  "image_url",
  "image_urls",
  "image",
  "images",
  "image_input",
  "input_image",
  "first_frame",
  "last_frame",
  "tail_image_url",
  "start_image",
  "end_image",
  "reference_image",
  "init_image",
  "mask_image",
  "mask_url",
  "mask",
  "control_image",
];

// Text input properties
const TEXT_INPUT_NAMES = ["prompt", "negative_prompt"];

// Properties that start with "image_" but are NOT image inputs
const IMAGE_PREFIX_EXCLUSIONS = ["image_size"];

// Parameters to filter out (internal/system params)
const EXCLUDED_PARAMS = new Set([
  "webhook",
  "webhook_events_filter",
  "sync_mode",
  "disable_safety_checker",
  "go_fast",
  "enable_safety_checker",
  "output_format",
  "output_quality",
  "request_id",
]);

// Parameters we want to surface (user-relevant)
const PRIORITY_PARAMS = new Set([
  "seed",
  "num_inference_steps",
  "inference_steps",
  "steps",
  "guidance_scale",
  "guidance",
  "negative_prompt",
  "width",
  "height",
  "image_size",
  "num_outputs",
  "num_images",
  "scheduler",
  "strength",
  "cfg_scale",
  "lora_scale",
]);

interface SchemaSuccessResponse {
  success: true;
  parameters: ModelParameter[];
  inputs: ModelInput[];
  cached: boolean;
}

interface SchemaErrorResponse {
  success: false;
  error: string;
}

type SchemaResponse = SchemaSuccessResponse | SchemaErrorResponse;

/**
 * Convert property name to human-readable label
 */
function toLabel(name: string): string {
  return name
    .replace(/_url$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Check if property is an image input based on BOTH schema type AND name.
 *
 * Image inputs must be strings (URLs or base64) or arrays of strings.
 * Integers, booleans, numbers with "image" in the name are NOT image inputs.
 */
function isImageInput(name: string, prop: Record<string, unknown>): boolean {
  // First check: must be a string type (images are URLs or base64 strings)
  // Integers, booleans, numbers are NEVER image inputs regardless of name
  const propType = prop.type as string | undefined;
  if (propType !== "string" && propType !== "array") {
    return false;
  }

  // For arrays, check if items are strings (or unspecified - be lenient)
  if (propType === "array") {
    const items = prop.items as Record<string, unknown> | undefined;
    // Only reject if items.type is explicitly specified AND not "string"
    // Many schemas don't specify items type for image arrays
    if (items && items.type && items.type !== "string") {
      return false;
    }
  }

  // Check exclusions (e.g., image_size is a parameter, not an image input)
  if (IMAGE_PREFIX_EXCLUSIONS.includes(name)) {
    return false;
  }

  // Check format hints (OpenAPI format field) - strong signal for image URLs
  const format = prop.format as string | undefined;
  if (format === "uri" || format === "data-uri" || format === "binary") {
    // Only treat as image if name also suggests it's an image
    if (IMAGE_INPUT_PATTERNS.includes(name) ||
        name.endsWith("_image") ||
        name.startsWith("image_") ||
        name.includes("_image_")) {
      return true;
    }
  }

  // Check description for image-related keywords
  const description = (prop.description as string || "").toLowerCase();
  if (description.includes("image url") ||
      description.includes("base64 image") ||
      description.includes("data uri") ||
      description.includes("image file") ||
      description.includes("url of the image") ||
      description.includes("path to image")) {
    return true;
  }

  // Check explicit patterns (exact matches like "image_url", "image")
  if (IMAGE_INPUT_PATTERNS.includes(name)) {
    return true;
  }

  // More restrictive name pattern matching for strings
  // Exclude names that suggest counts or settings rather than actual images
  if (name.includes("_images") ||    // max_images, num_images
      name.includes("guidance") ||   // image_guidance_scale
      name.includes("generation") || // sequential_image_generation
      name.includes("_count") ||     // image_count
      name.includes("_size") ||      // image_size (already in exclusions but belt-and-suspenders)
      name.includes("_scale")) {     // image_scale
    return false;
  }

  // Finally, check name patterns for remaining string types
  return name.endsWith("_image") ||
         name.endsWith("_image_url") ||
         name.startsWith("image_") ||
         name.includes("_image_");
}

/**
 * Check if property is a text input
 */
function isTextInput(name: string): boolean {
  return TEXT_INPUT_NAMES.includes(name);
}

/**
 * Check if a resolved schema is an "image URL wrapper" object.
 * fal.ai defines image inputs as objects like ImageUrl: { type: "object", properties: { url: { type: "string" } } }
 * These should be treated as string type for input detection purposes.
 */
function isImageUrlWrapperObject(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object") return false;
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return false;
  // Has a "url" property that is a string — this is an image/file URL wrapper
  return props.url !== undefined && props.url.type === "string";
}

/**
 * Resolve a $ref reference in OpenAPI schema
 * E.g., "#/components/schemas/AspectRatio" -> schema object
 */
function resolveRef(
  ref: string,
  schemaComponents: Record<string, unknown>
): Record<string, unknown> | null {
  // Parse reference path like "#/components/schemas/AspectRatio"
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return null;

  const schemaName = match[1];
  const resolved = schemaComponents[schemaName] as Record<string, unknown> | undefined;
  return resolved || null;
}

/**
 * Convert OpenAPI schema property to ModelParameter
 */
function convertSchemaProperty(
  name: string,
  prop: Record<string, unknown>,
  required: string[],
  schemaComponents?: Record<string, unknown>
): ModelParameter | null {
  // Skip excluded parameters
  if (EXCLUDED_PARAMS.has(name)) {
    return null;
  }

  // Determine type and extract enum from allOf/$ref if present
  let type: ModelParameter["type"] = "string";
  let enumValues: unknown[] | undefined;
  let resolvedDefault: unknown;
  let resolvedDescription: string | undefined;

  const schemaType = prop.type as string | undefined;
  const allOf = prop.allOf as Array<Record<string, unknown>> | undefined;

  if (schemaType === "integer") {
    type = "integer";
  } else if (schemaType === "number") {
    type = "number";
  } else if (schemaType === "boolean") {
    type = "boolean";
  } else if (schemaType === "array") {
    type = "array";
  } else if (allOf && allOf.length > 0 && schemaComponents) {
    // Handle allOf with $ref - resolve references and extract enum/type
    for (const item of allOf) {
      const itemRef = item.$ref as string | undefined;
      if (itemRef) {
        const resolved = resolveRef(itemRef, schemaComponents);
        if (resolved) {
          // Extract type from resolved schema
          if (resolved.type === "integer") type = "integer";
          else if (resolved.type === "number") type = "number";
          else if (resolved.type === "boolean") type = "boolean";

          // Extract enum from resolved schema
          if (Array.isArray(resolved.enum)) {
            enumValues = resolved.enum;
          }
          // Extract default from resolved schema
          if (resolved.default !== undefined && resolvedDefault === undefined) {
            resolvedDefault = resolved.default;
          }
          // Extract description from resolved schema
          if (resolved.description && !resolvedDescription) {
            resolvedDescription = resolved.description as string;
          }
        }
      } else if (Array.isArray(item.enum)) {
        // Direct enum in allOf item
        enumValues = item.enum;
      }
    }
  }

  const parameter: ModelParameter = {
    name,
    type,
    description: (prop.description as string | undefined) || resolvedDescription,
    default: prop.default !== undefined ? prop.default : resolvedDefault,
    required: required.includes(name),
  };

  // Add constraints
  if (typeof prop.minimum === "number") {
    parameter.minimum = prop.minimum;
  }
  if (typeof prop.maximum === "number") {
    parameter.maximum = prop.maximum;
  }

  // Use enum from property directly, or from resolved $ref
  if (Array.isArray(prop.enum)) {
    parameter.enum = prop.enum;
  } else if (enumValues) {
    parameter.enum = enumValues;
  }

  return parameter;
}

interface ExtractedSchema {
  parameters: ModelParameter[];
  inputs: ModelInput[];
}

/**
 * Fetch and parse schema from Replicate
 */
async function fetchReplicateSchema(
  modelId: string,
  apiKey: string
): Promise<ExtractedSchema> {
  const [owner, name] = modelId.split("/");

  const response = await fetch(
    `https://api.replicate.com/v1/models/${owner}/${name}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Replicate API error: ${response.status}`);
  }

  const data = await response.json();

  // Extract schema from latest_version.openapi_schema
  const openApiSchema = data.latest_version?.openapi_schema;
  if (!openApiSchema) {
    return { parameters: [], inputs: [] };
  }

  // Navigate to Input schema
  const inputSchema = openApiSchema.components?.schemas?.Input;
  if (!inputSchema || typeof inputSchema !== "object") {
    return { parameters: [], inputs: [] };
  }

  // Pass components.schemas for $ref resolution
  const schemaComponents = openApiSchema.components?.schemas as Record<string, unknown> | undefined;
  return extractParametersFromSchema(inputSchema as Record<string, unknown>, schemaComponents);
}

/**
 * Fetch and parse schema from fal.ai using Model Search API
 * Uses: GET https://api.fal.ai/v1/models?endpoint_id={modelId}&expand=openapi-3.0
 */
async function fetchFalSchema(
  modelId: string,
  apiKey: string | null
): Promise<ExtractedSchema> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Key ${apiKey}`;
  }

  // Use fal.ai Model Search API with OpenAPI expansion
  const url = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;

  const response = await fetch(url, { headers });

  if (!response.ok) {
    // Return empty params if API fails so generation still works
    return { parameters: [], inputs: [] };
  }

  const data = await response.json();

  // Response is { models: [{ openapi: {...}, ... }] }
  const modelData = data.models?.[0];
  if (!modelData?.openapi) {
    return { parameters: [], inputs: [] };
  }

  const spec = modelData.openapi;

  // Find POST endpoint with requestBody - paths are keyed by full endpoint path
  let inputSchema: Record<string, unknown> | null = null;

  for (const pathObj of Object.values(spec.paths || {})) {
    const postOp = (pathObj as Record<string, unknown>)?.post as Record<string, unknown> | undefined;
    const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
    const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
    const jsonContent = content?.["application/json"];

    if (jsonContent?.schema) {
      const schema = jsonContent.schema as Record<string, unknown>;

      // Handle $ref - resolve from components.schemas
      if (schema.$ref && typeof schema.$ref === "string") {
        const refPath = schema.$ref.replace("#/components/schemas/", "");
        const resolvedSchema = spec.components?.schemas?.[refPath] as Record<string, unknown> | undefined;
        if (resolvedSchema) {
          inputSchema = resolvedSchema;
          break;
        }
      } else if (schema.properties) {
        inputSchema = schema;
        break;
      }
    }
  }

  if (!inputSchema) {
    return { parameters: [], inputs: [] };
  }

  // Pass components.schemas for $ref resolution
  const schemaComponents = spec.components?.schemas as Record<string, unknown> | undefined;
  return extractParametersFromSchema(inputSchema, schemaComponents);
}

/**
 * Extract ModelParameters and ModelInputs from an OpenAPI schema object
 */
function extractParametersFromSchema(
  schema: Record<string, unknown>,
  schemaComponents?: Record<string, unknown>
): ExtractedSchema {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties) {
    return { parameters: [], inputs: [] };
  }

  const parameters: ModelParameter[] = [];
  const inputs: ModelInput[] = [];

  for (const [name, rawProp] of Object.entries(properties)) {
    // Resolve $ref if present (property-level references like { "$ref": "#/components/schemas/ImageUrl" })
    let prop = rawProp;
    if (rawProp.$ref && typeof rawProp.$ref === "string" && schemaComponents) {
      const resolved = resolveRef(rawProp.$ref as string, schemaComponents);
      if (resolved) {
        // Image URL wrapper objects (e.g. ImageUrl: {type: "object", properties: {url: ...}})
        // should be treated as string type for input detection
        const resolvedType = isImageUrlWrapperObject(resolved) ? "string" : resolved.type;
        prop = { ...resolved, ...rawProp, type: resolvedType || rawProp.type };
      }
    }
    // Handle anyOf/oneOf (common in OpenAPI 3.1 for nullable types, e.g. anyOf: [{$ref: "..."}, {type: "null"}])
    if (!prop.type && (prop.anyOf || prop.oneOf) && Array.isArray(prop.anyOf || prop.oneOf)) {
      const variants = (prop.anyOf || prop.oneOf) as Record<string, unknown>[];
      const nonNull = variants.find((s) => s.type !== "null");
      if (nonNull) {
        if (nonNull.$ref && typeof nonNull.$ref === "string" && schemaComponents) {
          const resolved = resolveRef(nonNull.$ref as string, schemaComponents);
          if (resolved) {
            const resolvedType = isImageUrlWrapperObject(resolved) ? "string" : resolved.type;
            prop = { ...prop, ...resolved, type: resolvedType };
          }
        } else if (nonNull.type) {
          prop = { ...prop, type: nonNull.type };
        }
      }
    }

    // Check if this is a connectable input (image or text)
    // Pass both name AND resolved prop to check schema type, not just name
    if (isImageInput(name, prop)) {
      inputs.push({
        name,
        type: "image",
        required: required.includes(name),
        label: toLabel(name),
        description: (prop.description || rawProp.description) as string | undefined,
        isArray: prop.type === "array",
      });
      continue;
    }

    if (isTextInput(name)) {
      inputs.push({
        name,
        type: "text",
        required: required.includes(name),
        label: toLabel(name),
        description: (prop.description || rawProp.description) as string | undefined,
        isArray: prop.type === "array",
      });
      continue;
    }

    // Otherwise it's a parameter (pass resolved prop for better type detection)
    const param = convertSchemaProperty(name, prop, required, schemaComponents);
    if (param) {
      parameters.push(param);
    }
  }

  // Sort parameters: priority params first, then alphabetically
  parameters.sort((a, b) => {
    const aIsPriority = PRIORITY_PARAMS.has(a.name);
    const bIsPriority = PRIORITY_PARAMS.has(b.name);
    if (aIsPriority && !bIsPriority) return -1;
    if (!aIsPriority && bIsPriority) return 1;
    return a.name.localeCompare(b.name);
  });

  // Sort inputs: required first, then by type (image before text), then alphabetically
  inputs.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    if (a.type !== b.type) return a.type === "image" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { parameters, inputs };
}

/**
 * Get hardcoded schema for Kie.ai models
 * Kie.ai doesn't have a schema discovery API, so we define these manually
 */
function getKieSchema(modelId: string): ExtractedSchema {
  // Common parameters for image models
  const imageParams: ModelParameter[] = [
    { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
    { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
  ];

  // Flux-2 aspect ratios (includes auto and additional ratios)
  const flux2AspectRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "auto"];

  // Model-specific schemas
  const schemas: Record<string, ExtractedSchema> = {
    // ============ Image models ============
    "z-image": {
      parameters: imageParams,
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "seedream/4.5-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], default: "1:1" },
        { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "seedream/4.5-edit": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], default: "1:1" },
        { name: "quality", type: "string", description: "Output quality", enum: ["basic", "high"], default: "basic" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "gpt-image/1.5-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2"], default: "3:2" },
        { name: "quality", type: "string", description: "Output quality", enum: ["medium", "high"], default: "medium" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "gpt-image/1.5-image-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2"], default: "3:2" },
        { name: "quality", type: "string", description: "Output quality", enum: ["medium", "high"], default: "medium" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "flux-2/pro-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "flux-2/pro-image-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "flux-2/flex-text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "flux-2/flex-image-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: flux2AspectRatios, default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K"], default: "1K" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "nano-banana-pro": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["1:1", "2:3", "3:2", "4:3", "16:9", "9:16", "21:9", "auto"], default: "1:1" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["1K", "2K", "4K"], default: "1K" },
        { name: "output_format", type: "string", description: "Output format", enum: ["png", "jpg"], default: "png" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "image_input", type: "image", required: false, label: "Image", isArray: true },
      ],
    },
    "grok-imagine/text-to-image": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "1:1" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "grok-imagine/image-to-image": {
      parameters: [],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    // ============ Audio/TTS models ============
    "elevenlabs/turbo-v2.5": {
      parameters: [
        { name: "voice_id", type: "string", description: "Voice ID to use for synthesis" },
        { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
        { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Text" }],
    },
    "elevenlabs/multilingual-v2": {
      parameters: [
        { name: "voice_id", type: "string", description: "Voice ID to use for synthesis" },
        { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
        { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Text" }],
    },
    "elevenlabs/text-to-dialogue-v3": {
      parameters: [
        { name: "stability", type: "number", description: "Voice stability (0-1)", default: 0.5, minimum: 0, maximum: 1 },
        { name: "similarity_boost", type: "number", description: "Similarity boost (0-1)", default: 0.75, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Text / Dialogue Script" }],
    },
    "elevenlabs/sound-effect-v2": {
      parameters: [
        { name: "duration_seconds", type: "number", description: "Duration in seconds (0.5-22)", minimum: 0.5, maximum: 22 },
        { name: "loop", type: "boolean", description: "Enable smooth looping", default: false },
        { name: "prompt_influence", type: "number", description: "How closely to follow the prompt (0-1)", default: 0.3, minimum: 0, maximum: 1 },
        { name: "output_format", type: "string", description: "Audio output format", enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"], default: "mp3_44100_128" },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Sound Description" }],
    },
    // ============ Video models ============
    "grok-imagine/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "2:3" },
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["6", "10"], default: "6" },
        { name: "mode", type: "string", description: "Generation mode", enum: ["fun", "normal", "spicy"], default: "normal" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "grok-imagine/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["2:3", "3:2", "1:1", "16:9", "9:16"], default: "2:3" },
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["6", "10"], default: "6" },
        { name: "mode", type: "string", description: "Generation mode", enum: ["fun", "normal", "spicy"], default: "normal" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "kling-2.6/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "sound", type: "boolean", description: "Enable sound generation", default: true },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "kling-2.6/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "sound", type: "boolean", description: "Enable sound generation", default: true },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "kling-2.6/motion-control": {
      parameters: [
        { name: "mode", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "720p" },
        { name: "character_orientation", type: "string", description: "Character orientation source", enum: ["image", "video"], default: "video" },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "input_urls", type: "image", required: true, label: "Image", isArray: true },
        { name: "video_urls", type: "image", required: true, label: "Video", isArray: true },
      ],
    },
    "kling/v2-5-turbo-text-to-video-pro": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "cfg_scale", type: "number", description: "Guidance scale", minimum: 0, maximum: 1, default: 0.5 },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
      ],
    },
    "kling/v2-5-turbo-image-to-video-pro": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
        { name: "duration", type: "string", description: "Video duration", enum: ["5", "10"], default: "5" },
        { name: "cfg_scale", type: "number", description: "Guidance scale", minimum: 0, maximum: 1, default: 0.5 },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "negative_prompt", type: "text", required: false, label: "Negative Prompt" },
        { name: "image_url", type: "image", required: true, label: "Image" },
        { name: "tail_image_url", type: "image", required: false, label: "Tail Image" },
      ],
    },
    "wan/2-6-text-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10", "15"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "wan/2-6-image-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10", "15"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "image_urls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "wan/2-6-video-to-video": {
      parameters: [
        { name: "duration", type: "string", description: "Video duration in seconds", enum: ["5", "10"], default: "5" },
        { name: "resolution", type: "string", description: "Output resolution", enum: ["720p", "1080p"], default: "1080p" },
        { name: "seed", type: "integer", description: "Random seed for reproducibility", minimum: 0 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: false, label: "Prompt" },
        { name: "video_urls", type: "image", required: true, label: "Video", isArray: true },
      ],
    },
    "topaz/video-upscale": {
      parameters: [
        { name: "upscale_factor", type: "string", description: "Upscale factor", enum: ["1", "2", "4"], default: "2" },
      ],
      inputs: [
        { name: "video_url", type: "image", required: true, label: "Video" },
      ],
    },
    "veo3/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "veo3/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "imageUrls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
    "veo3-fast/text-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [{ name: "prompt", type: "text", required: true, label: "Prompt" }],
    },
    "veo3-fast/image-to-video": {
      parameters: [
        { name: "aspect_ratio", type: "string", description: "Output aspect ratio", enum: ["16:9", "9:16"], default: "16:9" },
        { name: "seeds", type: "integer", description: "Random seed (10000-99999)", minimum: 10000, maximum: 99999 },
      ],
      inputs: [
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "imageUrls", type: "image", required: true, label: "Image", isArray: true },
      ],
    },
  };

  return schemas[modelId] || { parameters: [], inputs: [] };
}

/**
 * Get static schema for WaveSpeed models (fallback when dynamic schema not available)
 */
function getStaticWaveSpeedSchema(modelId: string): ExtractedSchema {
  const modelIdLower = modelId.toLowerCase();

  // Common image generation parameters for FLUX, SD3, etc.
  const imageParams: ModelParameter[] = [
    {
      name: "num_inference_steps",
      type: "integer",
      description: "Number of denoising steps. More steps usually lead to higher quality but slower generation.",
      default: 28,
      minimum: 1,
      maximum: 100,
    },
    {
      name: "guidance_scale",
      type: "number",
      description: "Guidance scale for classifier-free guidance. Higher values follow the prompt more closely.",
      default: 3.5,
      minimum: 0,
      maximum: 20,
    },
    {
      name: "seed",
      type: "integer",
      description: "Random seed for reproducibility. Use -1 for random.",
      default: -1,
    },
    {
      name: "image_size",
      type: "string",
      description: "Output image dimensions",
      default: "1024x1024",
      enum: ["512x512", "768x768", "1024x1024", "1024x576", "576x1024", "1024x768", "768x1024", "1280x720", "720x1280"],
    },
  ];

  // Image inputs for image-to-image models
  const imageInputs: ModelInput[] = [];

  // Video model parameters (WAN, Kling, Luma, etc.)
  const videoParams: ModelParameter[] = [
    {
      name: "num_frames",
      type: "integer",
      description: "Number of frames to generate",
      default: 81,
      minimum: 16,
      maximum: 256,
    },
    {
      name: "fps",
      type: "integer",
      description: "Frames per second for the output video",
      default: 16,
      minimum: 8,
      maximum: 30,
    },
    {
      name: "seed",
      type: "integer",
      description: "Random seed for reproducibility. Use -1 for random.",
      default: -1,
    },
    {
      name: "resolution",
      type: "string",
      description: "Output video resolution",
      default: "480p",
      enum: ["480p", "720p", "1080p"],
    },
  ];

  // Check if it's a video model
  const isVideoModel =
    modelIdLower.includes("wan") ||
    modelIdLower.includes("video") ||
    modelIdLower.includes("kling") ||
    modelIdLower.includes("luma") ||
    modelIdLower.includes("minimax") ||
    modelIdLower.includes("t2v") ||
    modelIdLower.includes("i2v");

  // Check if it's an image-to-image model
  const isImg2ImgModel =
    modelIdLower.includes("kontext") ||
    modelIdLower.includes("img2img") ||
    modelIdLower.includes("edit") ||
    modelIdLower.includes("inpaint") ||
    modelIdLower.includes("controlnet");

  if (isVideoModel) {
    // For i2v models, add image input
    if (modelIdLower.includes("i2v")) {
      imageInputs.push({
        name: "image",  // i2v models typically use singular "image"
        type: "image",
        required: true,
        label: "Input Image",
        description: "Starting image for video generation",
      });
    }
    return { parameters: videoParams, inputs: imageInputs };
  }

  // Image generation model
  if (isImg2ImgModel) {
    imageInputs.push({
      name: "images",  // WaveSpeed edit models expect "images" (plural array)
      type: "image",
      required: true,
      label: "Input Image",
      description: "Image to transform or edit",
      isArray: true,  // Signal that this should be sent as an array
    });

    // Add strength parameter for img2img
    imageParams.push({
      name: "strength",
      type: "number",
      description: "How much to transform the input image. 0 = no change, 1 = ignore input completely.",
      default: 0.8,
      minimum: 0,
      maximum: 1,
    });
  }

  return { parameters: imageParams, inputs: imageInputs };
}

// WaveSpeed API base URL
const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";

/**
 * Fetch WaveSpeed schema dynamically from cache or API
 * Falls back to static schema if dynamic schema not available
 */
async function fetchWaveSpeedSchema(
  modelId: string,
  apiKey: string | null
): Promise<ExtractedSchema> {
  // First check if we have a cached schema from the models list
  const cachedSchema = getCachedWaveSpeedSchema(modelId);
  if (cachedSchema) {
    console.log(`[WaveSpeed Schema] Using cached schema for ${modelId}`);
    const result = extractWaveSpeedSchema(cachedSchema, modelId);
    if (result.parameters.length > 0 || result.inputs.length > 0) {
      return result;
    }
  }

  // If no cache and we have an API key, try fetching the model directly
  if (apiKey) {
    try {
      console.log(`[WaveSpeed Schema] Fetching schema for ${modelId} from API`);
      const response = await fetch(`${WAVESPEED_API_BASE}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        const models = data.models || data.data || data.results || [];

        // Find the model by ID
        const model = models.find((m: Record<string, unknown>) => {
          const id = m.model_id || m.id || m.modelId || m.name;
          return id === modelId;
        });

        if (model?.api_schema) {
          // Cache the schema for future use
          setCachedWaveSpeedSchema(modelId, model.api_schema as WaveSpeedApiSchema);

          const result = extractWaveSpeedSchema(model.api_schema as WaveSpeedApiSchema, modelId);
          if (result.parameters.length > 0 || result.inputs.length > 0) {
            console.log(`[WaveSpeed Schema] Found dynamic schema with ${result.parameters.length} params, ${result.inputs.length} inputs`);
            return result;
          }
        }
      }
    } catch (error) {
      console.warn(`[WaveSpeed Schema] Failed to fetch from API: ${error}`);
    }
  }

  // Fall back to static schema
  console.log(`[WaveSpeed Schema] Using static fallback for ${modelId}`);
  return getStaticWaveSpeedSchema(modelId);
}

/**
 * Extract parameters and inputs from WaveSpeed api_schema
 * Schema structure: { api_schemas: [{ request_schema: { properties, required } }] }
 */
function extractWaveSpeedSchema(
  apiSchema: WaveSpeedApiSchema,
  modelId: string
): ExtractedSchema {
  // WaveSpeed schema structure: api_schema.api_schemas[].request_schema
  const apiSchemas = apiSchema.api_schemas;
  if (!apiSchemas || !Array.isArray(apiSchemas) || apiSchemas.length === 0) {
    console.log(`[WaveSpeed Schema] No api_schemas array found for ${modelId}`);
    return { parameters: [], inputs: [] };
  }

  // Use the first schema (primary request schema)
  const requestSchema = apiSchemas[0]?.request_schema;
  if (!requestSchema || typeof requestSchema !== "object") {
    console.log(`[WaveSpeed Schema] No request_schema found for ${modelId}`);
    return { parameters: [], inputs: [] };
  }

  // Log the schema structure for debugging
  const schemaKeys = Object.keys(requestSchema);
  console.log(`[WaveSpeed Schema] Schema keys for ${modelId}: ${schemaKeys.join(", ")}`);

  // Extract parameters using the shared extraction function
  return extractParametersFromSchema(requestSchema as Record<string, unknown>);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse<SchemaResponse>> {
  // Await params before accessing properties
  const { modelId } = await params;
  const decodedModelId = decodeURIComponent(modelId);
  const provider = request.nextUrl.searchParams.get("provider") as ProviderType | null;

  if (!provider || (provider !== "replicate" && provider !== "fal" && provider !== "kie" && provider !== "wavespeed")) {
    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: "Invalid or missing provider. Use ?provider=replicate, ?provider=fal, ?provider=kie, or ?provider=wavespeed",
      },
      { status: 400 }
    );
  }

  // Check cache
  const cacheKey = `${provider}:${decodedModelId}`;
  const cached = schemaCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json<SchemaSuccessResponse>({
      success: true,
      parameters: cached.parameters,
      inputs: cached.inputs,
      cached: true,
    });
  }

  try {
    let result: ExtractedSchema;

    if (provider === "replicate") {
      // User-provided key takes precedence over env variable
      const apiKey = request.headers.get("X-Replicate-Key") || process.env.REPLICATE_API_KEY;
      if (!apiKey) {
        return NextResponse.json<SchemaErrorResponse>(
          {
            success: false,
            error: "Replicate API key required. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }
      result = await fetchReplicateSchema(decodedModelId, apiKey);
    } else if (provider === "kie") {
      // Kie.ai uses hardcoded schemas (no schema discovery API)
      result = getKieSchema(decodedModelId);
    } else if (provider === "wavespeed") {
      // WaveSpeed uses dynamic schemas from API, with static fallback
      const apiKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY || null;
      result = await fetchWaveSpeedSchema(decodedModelId, apiKey);
    } else {
      // User-provided key takes precedence over env variable
      const apiKey = request.headers.get("X-Fal-Key") || process.env.FAL_API_KEY || null;
      if (!apiKey) {
        return NextResponse.json<SchemaErrorResponse>(
          {
            success: false,
            error: "fal.ai API key not configured. Add FAL_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }
      result = await fetchFalSchema(decodedModelId, apiKey);
    }

    // Cache the result
    schemaCache.set(cacheKey, { ...result, timestamp: Date.now() });

    return NextResponse.json<SchemaSuccessResponse>({
      success: true,
      parameters: result.parameters,
      inputs: result.inputs,
      cached: false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ModelSchema] Error fetching ${decodedModelId}: ${errorMessage}`);
    return NextResponse.json<SchemaErrorResponse>(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
