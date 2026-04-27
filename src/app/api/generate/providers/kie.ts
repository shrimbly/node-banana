/**
 * Kie.ai Provider for Generate API Route
 *
 * Handles image/video generation using Kie.ai API.
 * Supports standard createTask endpoint and Veo-specific endpoints.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";

const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Get default required parameters for a Kie model
 * Many Kie models require specific parameters to be present even if not user-specified
 */
export function getKieModelDefaults(modelId: string): Record<string, unknown> {
  switch (modelId) {
    // GPT Image models
    case "gpt-image/1.5-text-to-image":
    case "gpt-image/1.5-image-to-image":
      return {
        aspect_ratio: "3:2",
        quality: "medium",
      };

    case "gpt-image-2/text-to-image":
    case "gpt-image-2/image-to-image":
      return {
        aspect_ratio: "1:1",
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

    // Nano Banana 2 (Kie)
    case "nano-banana-2":
      return {
        aspect_ratio: "auto",
        resolution: "1K",
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

    // Imagen 4 models
    case "google/imagen4":
    case "google/imagen4-ultra":
      return {};

    case "google/imagen4-fast":
      return {
        aspect_ratio: "16:9",
        num_images: 1,
      };

    // Seedream 5.0 Lite models
    case "seedream/5-lite-text-to-image":
    case "seedream/5-lite-image-to-image":
      return {
        aspect_ratio: "1:1",
        quality: "basic",
      };

    // Wan 2.7 Image
    case "wan/2-7-image":
      return {
        resolution: "2K",
        n: 4,
      };

    // Grok Imagine image models
    case "grok-imagine/text-to-image":
      return {
        aspect_ratio: "1:1",
      };

    case "grok-imagine/image-to-image":
      return {};

    // Seedance 2.0 models
    case "bytedance/seedance-2/text-to-video":
    case "bytedance/seedance-2/image-to-video":
    case "bytedance/seedance-2-fast/text-to-video":
    case "bytedance/seedance-2-fast/image-to-video":
      return {
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: 5,
        generate_audio: true,
        web_search: false,
      };

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

    // Kling 3.0 video models
    case "kling-3.0/video/text-to-video":
    case "kling-3.0/video/image-to-video":
      return {
        aspect_ratio: "16:9",
        duration: "5",
        mode: "pro",
      };

    // Kling 3.0 motion control
    case "kling-3.0/motion-control":
      return {
        mode: "720p",
        character_orientation: "video",
        background_source: "input_video",
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

    // Wan 2.7 video models
    case "wan/2-7-text-to-video":
      return {
        duration: 5,
        resolution: "1080p",
        ratio: "16:9",
      };

    case "wan/2-7-image-to-video":
      return {
        duration: 5,
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

    // ElevenLabs TTS models
    case "elevenlabs/turbo-v2.5":
    case "elevenlabs/multilingual-v2":
    case "elevenlabs/text-to-dialogue-v3":
      return {
        output_format: "mp3_44100_128",
      };

    // ElevenLabs Sound Effects
    case "elevenlabs/sound-effect-v2":
      return {
        output_format: "mp3_44100_128",
        prompt_influence: 0.3,
      };

    default:
      return {};
  }
}

/**
 * Get the correct image input parameter name for a Kie model
 */
export function getKieImageInputKey(modelId: string): string {
  // Model-specific parameter names
  if (modelId === "nano-banana-2") return "image_input";
  if (modelId === "nano-banana-pro") return "image_input";
  if (modelId === "seedream/4.5-edit") return "image_urls";
  if (modelId === "gpt-image/1.5-image-to-image") return "input_urls";
  if (modelId === "gpt-image-2/image-to-image") return "input_urls";
  // Flux-2 I2I models use input_urls
  if (modelId === "flux-2/pro-image-to-image" || modelId === "flux-2/flex-image-to-image") return "input_urls";
  // Wan 2.7 Image uses input_urls
  if (modelId === "wan/2-7-image") return "input_urls";
  // Seedance I2V models use first_frame_url (singular)
  if (modelId === "bytedance/seedance-2/image-to-video" || modelId === "bytedance/seedance-2-fast/image-to-video") return "first_frame_url";
  // Kling 2.5 turbo I2V uses singular image_url
  if (modelId === "kling/v2-5-turbo-image-to-video-pro") return "image_url";
  // Kling 3.0 motion control uses input_urls
  if (modelId === "kling-3.0/motion-control") return "input_urls";
  // Kling 2.6 motion control uses input_urls
  if (modelId === "kling-2.6/motion-control") return "input_urls";
  // Wan 2.7 I2V uses first_frame_url (singular)
  if (modelId === "wan/2-7-image-to-video") return "first_frame_url";
  // Topaz video upscale uses video_url (singular)
  if (modelId === "topaz/video-upscale") return "video_url";
  // Veo 3 models use imageUrls
  if (modelId.startsWith("veo3")) return "imageUrls";
  // Default for most models
  return "image_urls";
}


/**
 * Detect media type from binary data (magic bytes), with fallback to declared MIME type
 */
export function detectMediaType(buffer: Buffer, declaredMimeType?: string): { mimeType: string; ext: string } {
  // Check image magic bytes
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
  // Check video magic bytes (MP4: "ftyp" at offset 4)
  if (buffer.length > 7 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return { mimeType: "video/mp4", ext: "mp4" };
  }
  // Check WebM magic bytes (starts with 0x1A 0x45 0xDF 0xA3 - EBML header)
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return { mimeType: "video/webm", ext: "webm" };
  }

  // Fall back to declared MIME type if magic bytes didn't match
  if (declaredMimeType && declaredMimeType !== "image/png") {
    const extMap: Record<string, string> = {
      "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
      "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
      "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    };
    const ext = extMap[declaredMimeType] || declaredMimeType.split("/")[1] || "bin";
    return { mimeType: declaredMimeType, ext };
  }

  // Default to PNG
  return { mimeType: "image/png", ext: "png" };
}

/**
 * Upload a base64 media file (image, video, or audio) to Kie.ai and get a URL
 * Required because Kie doesn't accept base64 directly — needs hosted URLs
 * Uses base64 upload endpoint (same as official Kie client)
 */
export async function uploadMediaToKie(
  requestId: string,
  apiKey: string,
  base64Media: string
): Promise<string> {
  // Extract mime type and data from data URL
  let declaredMimeType = "image/png";
  let mediaData = base64Media;

  if (base64Media.startsWith("data:")) {
    const matches = base64Media.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      declaredMimeType = matches[1];
      mediaData = matches[2];
    }
  }

  // Convert base64 to binary to detect actual type
  const binaryData = Buffer.from(mediaData, "base64");

  if (binaryData.length > MAX_UPLOAD_SIZE) {
    throw new Error(`[API:${requestId}] File too large to upload (${(binaryData.length / (1024 * 1024)).toFixed(1)}MB, max ${MAX_UPLOAD_SIZE / (1024 * 1024)}MB)`);
  }

  // Detect actual media type from magic bytes, falling back to declared MIME type
  const detected = detectMediaType(binaryData, declaredMimeType);
  const mimeType = detected.mimeType;
  const ext = detected.ext;

  const filename = `upload_${Date.now()}.${ext}`;
  const uploadPath = mimeType.startsWith("video/") ? "videos" : mimeType.startsWith("audio/") ? "audio" : "images";

  console.log(`[API:${requestId}] Uploading media to Kie.ai: ${filename} (${(binaryData.length / 1024).toFixed(1)}KB) [declared: ${declaredMimeType}, actual: ${mimeType}, path: ${uploadPath}]`);

  // Use base64 upload endpoint (same as official Kie client)
  // Format: data:{mime_type};base64,{data}
  const dataUrl = `data:${mimeType};base64,${mediaData}`;

  const response = await fetch("https://kieai.redpandaai.co/api/file-base64-upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64Data: dataUrl,
      uploadPath,
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

  console.log(`[API:${requestId}] Media uploaded: ${downloadUrl.substring(0, 80)}...`);
  return downloadUrl;
}

/** @deprecated Use uploadMediaToKie instead */
export const uploadImageToKie = uploadMediaToKie;

/**
 * Poll Kie.ai task status until completion
 */
export async function pollKieTaskCompletion(
  requestId: string,
  apiKey: string,
  taskId: string,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  const maxWaitTime = 10 * 60 * 1000; // 10 minutes for video
  let pollInterval = 2000; // start at 2s
  const maxInterval = 10000; // cap at 10s
  const startTime = Date.now();
  let lastStatus = "";
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  const pollUrl = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      return { success: false, error: "Generation timed out after 10 minutes" };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));

    let response: Response;
    try {
      response = await fetch(pollUrl, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      });
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[API:${requestId}] Kie poll network error (${consecutiveErrors}/${maxConsecutiveErrors}):`, err);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { success: false, error: `Polling failed after ${maxConsecutiveErrors} consecutive network errors` };
      }
      pollInterval = Math.min(pollInterval + 1000, maxInterval);
      continue;
    }

    if (!response.ok) {
      // 404/422 = task not registered yet, 429 = rate limited, 5xx = server error — all transient
      if (response.status === 404 || response.status === 422 || response.status === 429 || response.status >= 500) {
        consecutiveErrors++;
        console.log(`[API:${requestId}] Kie poll returned ${response.status} (${consecutiveErrors}/${maxConsecutiveErrors}) — retrying`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          return { success: false, error: `Polling failed after ${maxConsecutiveErrors} consecutive HTTP ${response.status} errors` };
        }
        pollInterval = Math.min(pollInterval + 1000, maxInterval);
        continue;
      }
      return { success: false, error: `Failed to poll status: ${response.status}` };
    }

    let result: Record<string, unknown>;
    try {
      result = await response.json();
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[API:${requestId}] Kie poll JSON parse error (${consecutiveErrors}/${maxConsecutiveErrors}):`, err);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { success: false, error: `Polling failed after ${maxConsecutiveErrors} consecutive parse errors` };
      }
      pollInterval = Math.min(pollInterval + 1000, maxInterval);
      continue;
    }

    // Reset on any successful poll response
    consecutiveErrors = 0;

    // Kie API can return HTTP 200 with code != 200 (e.g. "recordInfo is null")
    if (result.code && result.code !== 200) {
      console.log(`[API:${requestId}] Kie poll returned code ${result.code}: ${(result as Record<string, unknown>).msg || ""} — retrying`);
      pollInterval = Math.min(pollInterval + 1000, maxInterval);
      continue;
    }

    // Kie API returns "state" in result.data.state (not "status")
    const data = result.data as Record<string, unknown> | undefined;
    const state = ((data?.state || result.state || result.status || "") as string).toUpperCase();

    if (state !== lastStatus) {
      console.log(`[API:${requestId}] Kie task state: ${state}`);
      lastStatus = state;
    }

    if (state === "SUCCESS" || state === "COMPLETED") {
      return { success: true, data: data || result };
    }

    if (state === "FAIL" || state === "FAILED" || state === "ERROR") {
      console.error(`[API:${requestId}] Kie task failed. Full response:`, JSON.stringify(result).substring(0, 1000));
      const errorMessage = data?.failMsg || data?.errorMessage || result.error || result.message || "Generation failed";
      return { success: false, error: errorMessage as string };
    }

    // Continue polling for: WAITING, QUEUING, GENERATING, PROCESSING, etc.
    pollInterval = Math.min(pollInterval + 1000, maxInterval);
  }
}


// Map internal model IDs to the API model value expected by Kie
// Seedance models use a base ID without the capability suffix
function getKieApiModelId(modelId: string): string {
  if (modelId.startsWith("bytedance/seedance-2/")) return "bytedance/seedance-2";
  if (modelId.startsWith("bytedance/seedance-2-fast/")) return "bytedance/seedance-2-fast";
  return modelId;
}

export function isVeoModel(modelId: string): boolean {
  return modelId.startsWith("veo3/") || modelId.startsWith("veo3-fast/");
}

export function getVeoApiModelId(modelId: string): string {
  if (modelId.startsWith("veo3-fast/")) return "veo3_fast";
  return "veo3";
}

export async function pollVeoTaskCompletion(
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
 * Submit a Kie.ai task (upload images, build params, create task).
 * Returns the taskId and whether it's a Veo model.
 */
export async function submitKieTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ taskId: string; isVeo: boolean }> {
  const modelId = input.model.id;

  console.log(`[API:${requestId}] Kie.ai generation - Model: ${modelId}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  // Build the input object (all parameters go inside "input" for Kie API)
  const modelDefaults = getKieModelDefaults(modelId);
  const inputParams: Record<string, unknown> = { ...modelDefaults };

  if (input.prompt) {
    inputParams.prompt = input.prompt;
  }

  if (input.parameters) {
    Object.assign(inputParams, input.parameters);
  }

  // GPT Image 1.5 does NOT support 'size' parameter
  if (modelId.startsWith("gpt-image/1.5")) {
    delete inputParams.size;
  }

  // Handle dynamic inputs FIRST (from schema-mapped connections) - these take priority
  const handledImageKeys = new Set<string>();

  if (input.dynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs)) {
      if (value !== null && value !== undefined && value !== '') {
        if (typeof value === 'string' && value.startsWith('data:')) {
          const url = await uploadMediaToKie(requestId, apiKey, value);
          if (key === "image_url" || key === "video_url" || key === "tail_image_url" || key === "first_frame_url" || key === "last_frame_url" || key === "first_clip_url") {
            inputParams[key] = url;
          } else {
            inputParams[key] = [url];
          }
          handledImageKeys.add(key);
        } else if (Array.isArray(value)) {
          const processedArray: string[] = [];
          for (const item of value) {
            if (typeof item === 'string' && item.startsWith('data:')) {
              const url = await uploadMediaToKie(requestId, apiKey, item);
              processedArray.push(url);
            } else if (typeof item === 'string' && item.startsWith('http')) {
              processedArray.push(item);
            } else if (typeof item === 'string') {
              processedArray.push(item);
            }
          }
          if (processedArray.length > 0) {
            if (key === "image_url" || key === "video_url" || key === "tail_image_url" || key === "first_frame_url" || key === "last_frame_url" || key === "first_clip_url") {
              inputParams[key] = processedArray[0];
            } else {
              inputParams[key] = processedArray;
            }
            handledImageKeys.add(key);
          }
        } else {
          inputParams[key] = value;
        }
      }
    }
  }

  // Handle image inputs (fallback - only if dynamicInputs didn't already handle any image key).
  // If the schema-driven dynamic inputs already placed images into specific fields
  // (e.g. reference_image_urls), don't also populate the default key — some models
  // treat these fields as mutually exclusive and reject the request.
  const imageKey = getKieImageInputKey(modelId);
  if (input.images && input.images.length > 0 && handledImageKeys.size === 0) {
    const imageUrls: string[] = [];
    for (const image of input.images) {
      if (image.startsWith("http")) {
        imageUrls.push(image);
      } else {
        const url = await uploadMediaToKie(requestId, apiKey, image);
        imageUrls.push(url);
      }
    }

    if (imageKey === "image_url" || imageKey === "video_url" || imageKey === "first_frame_url" || imageKey === "last_frame_url" || imageKey === "first_clip_url") {
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

    if (inputParams.imageUrls) {
      veoBody.imageUrls = Array.isArray(inputParams.imageUrls)
        ? inputParams.imageUrls
        : [inputParams.imageUrls];
    }

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
        throw new Error(`${input.model.name}: Rate limit exceeded. Try again in a moment.`);
      }
      throw new Error(`${input.model.name}: ${errorDetail}`);
    }

    const createResult = await createResponse.json();
    if (createResult.code && createResult.code !== 200) {
      throw new Error(`${input.model.name}: ${createResult.msg || "API error"}`);
    }

    const taskId = createResult.data?.taskId || createResult.taskId;
    if (!taskId) {
      console.error(`[API:${requestId}] No taskId in Veo response:`, createResult);
      throw new Error("No task ID in Veo response");
    }

    console.log(`[API:${requestId}] Veo task created: ${taskId}`);
    return { taskId, isVeo: true };
  }

  // ElevenLabs models use "text" instead of "prompt"
  if (modelId.startsWith("elevenlabs/")) {
    if (inputParams.prompt) {
      inputParams.text = inputParams.prompt;
      delete inputParams.prompt;
    }
  }

  // All remaining Kie models use the standard createTask endpoint
  const apiModelId = getKieApiModelId(modelId);
  const requestBody: Record<string, unknown> = {
    model: apiModelId,
    input: inputParams,
  };

  const createUrl = "https://api.kie.ai/api/v1/jobs/createTask";

  console.log(`[API:${requestId}] Calling Kie.ai API: ${createUrl}`);
  const bodyForLogging = { ...requestBody };
  if (bodyForLogging.input && typeof bodyForLogging.input === 'object') {
    const inputForLogging = { ...(bodyForLogging.input as Record<string, unknown>) };
    if (typeof inputForLogging.prompt === 'string' && (inputForLogging.prompt as string).length > 200) {
      inputForLogging.prompt = (inputForLogging.prompt as string).substring(0, 200) + '...[truncated]';
    }
    bodyForLogging.input = inputForLogging;
  }
  console.log(`[API:${requestId}] Request body:`, JSON.stringify(bodyForLogging, null, 2));

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
      throw new Error(`${input.model.name}: Rate limit exceeded. Try again in a moment.`);
    }

    throw new Error(`${input.model.name}: ${errorDetail}`);
  }

  const createResult = await createResponse.json();

  if (createResult.code && createResult.code !== 200) {
    const errorMsg = createResult.msg || createResult.message || "API error";
    console.error(`[API:${requestId}] Kie API error (code ${createResult.code}):`, errorMsg);
    throw new Error(`${input.model.name}: ${errorMsg}`);
  }

  const taskId = createResult.taskId || createResult.data?.taskId || createResult.id;

  if (!taskId) {
    console.error(`[API:${requestId}] No taskId in Kie response:`, createResult);
    throw new Error("No task ID in response");
  }

  console.log(`[API:${requestId}] Kie task created: ${taskId}`);
  return { taskId, isVeo: false };
}

/**
 * Check a Kie.ai task status once (no polling loop).
 * Returns the current status and data if completed.
 */
export async function checkKieTaskOnce(
  requestId: string,
  apiKey: string,
  taskId: string,
  isVeo: boolean
): Promise<{ status: "processing" | "completed" | "failed"; data?: Record<string, unknown>; error?: string; taskState?: string }> {
  if (isVeo) {
    const pollUrl = `https://api.kie.ai/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`;

    let response: Response;
    try {
      response = await fetch(pollUrl, {
        headers: { "Authorization": `Bearer ${apiKey}` },
      });
    } catch (err) {
      console.warn(`[API:${requestId}] Veo poll network error:`, err);
      return { status: "processing", taskState: "NETWORK_ERROR" };
    }

    if (!response.ok) {
      if (response.status === 404 || response.status === 422 || response.status === 429 || response.status >= 500) {
        return { status: "processing", taskState: `HTTP_${response.status}` };
      }
      return { status: "failed", error: `Failed to poll status: ${response.status}` };
    }

    let result: Record<string, unknown>;
    try {
      result = await response.json();
    } catch {
      return { status: "processing", taskState: "PARSE_ERROR" };
    }

    const successFlag = (result.data as Record<string, unknown> | undefined)?.successFlag ?? -1;
    console.log(`[API:${requestId}] Veo task successFlag: ${successFlag}`);

    if (successFlag === 1) {
      return { status: "completed", data: result.data as Record<string, unknown> };
    }
    if (successFlag === 2 || successFlag === 3) {
      const errorMessage = (result.data as Record<string, unknown>)?.errorMessage || "Generation failed";
      return { status: "failed", error: errorMessage as string };
    }
    return { status: "processing", taskState: `successFlag=${successFlag}` };
  }

  // Standard Kie polling
  const pollUrl = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;

  let response: Response;
  try {
    response = await fetch(pollUrl, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.warn(`[API:${requestId}] Kie poll network error:`, err);
    return { status: "processing", taskState: "NETWORK_ERROR" };
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 422 || response.status === 429 || response.status >= 500) {
      return { status: "processing", taskState: `HTTP_${response.status}` };
    }
    return { status: "failed", error: `Failed to poll status: ${response.status}` };
  }

  let result: Record<string, unknown>;
  try {
    result = await response.json();
  } catch {
    return { status: "processing", taskState: "PARSE_ERROR" };
  }

  // Kie API can return HTTP 200 with code != 200
  if (result.code && result.code !== 200) {
    console.log(`[API:${requestId}] Kie poll returned code ${result.code}: ${(result as Record<string, unknown>).msg || ""}`);
    return { status: "processing", taskState: `code=${result.code}` };
  }

  const data = result.data as Record<string, unknown> | undefined;
  const state = ((data?.state || result.state || result.status || "") as string).toUpperCase();

  console.log(`[API:${requestId}] Kie task state: ${state}`);

  if (state === "SUCCESS" || state === "COMPLETED") {
    return { status: "completed", data: data || result };
  }

  if (state === "FAIL" || state === "FAILED" || state === "ERROR") {
    console.error(`[API:${requestId}] Kie task failed. Full response:`, JSON.stringify(result).substring(0, 1000));
    const errorMessage = data?.failMsg || data?.errorMessage || result.error || result.message || "Generation failed";
    return { status: "failed", error: errorMessage as string };
  }

  return { status: "processing", taskState: state };
}

/** Info needed to fetch the final media result from completed poll data */
export interface KieMediaResultInput {
  pollData: Record<string, unknown>;
  isVeo: boolean;
  modelName: string;
  capabilities: string[];
}

/**
 * Fetch the final media result from completed Kie poll data.
 * Extracts media URL, downloads, converts to base64.
 */
export async function fetchKieMediaResult(
  requestId: string,
  info: KieMediaResultInput
): Promise<GenerationOutput> {
  const { pollData: data, isVeo, modelName, capabilities } = info;

  if (isVeo) {
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

    const mediaUrlCheck = validateMediaUrl(mediaUrl);
    if (!mediaUrlCheck.valid) {
      return { success: false, error: `Invalid media URL: ${mediaUrlCheck.error}` };
    }

    console.log(`[API:${requestId}] Fetching Veo output from: ${mediaUrl.substring(0, 80)}...`);
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      return { success: false, error: `Failed to fetch output: ${mediaResponse.status}` };
    }

    const mediaContentLength = parseInt(mediaResponse.headers.get("content-length") || "0", 10);
    if (mediaContentLength > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(mediaContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
    }

    const contentType = mediaResponse.headers.get("content-type") || "video/mp4";
    const mediaArrayBuffer = await mediaResponse.arrayBuffer();
    if (mediaArrayBuffer.byteLength > MAX_MEDIA_SIZE) {
      return { success: false, error: `Media too large: ${(mediaArrayBuffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
    }
    const mediaSizeMB = mediaArrayBuffer.byteLength / (1024 * 1024);

    console.log(`[API:${requestId}] Veo output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

    if (mediaSizeMB > 20) {
      console.log(`[API:${requestId}] SUCCESS - Returning URL for large Veo video`);
      return {
        success: true,
        outputs: [{ type: "video", data: "", url: mediaUrl }],
      };
    }

    const mediaBase64 = Buffer.from(mediaArrayBuffer).toString("base64");
    console.log(`[API:${requestId}] SUCCESS - Returning Veo video`);
    return {
      success: true,
      outputs: [{ type: "video", data: `data:${contentType};base64,${mediaBase64}`, url: mediaUrl }],
    };
  }

  // Standard Kie result extraction
  let mediaUrl: string | null = null;
  let isVideo = false;
  let isAudio = false;
  const isAudioModel = capabilities.some(c => c.includes("audio"));

  console.log(`[API:${requestId}] Kie poll result data:`, JSON.stringify(data).substring(0, 500));

  if (data) {
    let resultJson = data.resultJson as Record<string, unknown> | string | undefined;

    if (typeof resultJson === 'string') {
      try {
        resultJson = JSON.parse(resultJson) as Record<string, unknown>;
      } catch {
        resultJson = undefined;
      }
    }

    const resultUrls = ((resultJson as Record<string, unknown> | undefined)?.resultUrls || data.resultUrls) as string[] | undefined;

    if (resultUrls && resultUrls.length > 0) {
      mediaUrl = resultUrls[0];
      isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('video');
    } else if (data.videoUrl) {
      mediaUrl = data.videoUrl as string;
      isVideo = true;
    } else if (data.video_url) {
      mediaUrl = data.video_url as string;
      isVideo = true;
    } else if (data.output && typeof data.output === 'string' && (data.output as string).includes('.mp4')) {
      mediaUrl = data.output as string;
      isVideo = true;
    } else if (data.imageUrl) {
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
    return { success: false, error: "No output URL in response" };
  }

  if (!isVideo && !isAudio && (mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('video'))) {
    isVideo = true;
  }
  if (!isVideo && !isAudio && (mediaUrl.includes('.mp3') || mediaUrl.includes('.wav') || mediaUrl.includes('.ogg') || mediaUrl.includes('.flac'))) {
    isAudio = true;
  }

  const mediaUrlCheck = validateMediaUrl(mediaUrl);
  if (!mediaUrlCheck.valid) {
    return { success: false, error: `Invalid media URL: ${mediaUrlCheck.error}` };
  }

  console.log(`[API:${requestId}] Fetching output from: ${mediaUrl.substring(0, 80)}...`);
  const mediaResponse = await fetch(mediaUrl);

  if (!mediaResponse.ok) {
    return { success: false, error: `Failed to fetch output: ${mediaResponse.status}` };
  }

  const mediaContentLength = parseInt(mediaResponse.headers.get("content-length") || "0", 10);
  if (mediaContentLength > MAX_MEDIA_SIZE) {
    return { success: false, error: `Media too large: ${(mediaContentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }

  const rawContentType = mediaResponse.headers.get("content-type") || "";
  const isConcreteMedia = rawContentType.startsWith("audio/") || rawContentType.startsWith("video/") || rawContentType.startsWith("image/");
  if (rawContentType.startsWith("video/")) {
    isVideo = true;
    isAudio = false;
  } else if (rawContentType.startsWith("audio/")) {
    isAudio = true;
    isVideo = false;
  } else if (!isConcreteMedia && !isVideo && !isAudio && isAudioModel) {
    isAudio = true;
  }
  const contentType = rawContentType || (isVideo ? "video/mp4" : isAudio ? "audio/mpeg" : "image/png");

  const mediaArrayBuffer = await mediaResponse.arrayBuffer();
  if (mediaArrayBuffer.byteLength > MAX_MEDIA_SIZE) {
    return { success: false, error: `Media too large: ${(mediaArrayBuffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit` };
  }
  const mediaSizeMB = mediaArrayBuffer.byteLength / (1024 * 1024);

  console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

  if (isAudio) {
    const audioBase64 = Buffer.from(mediaArrayBuffer).toString("base64");
    console.log(`[API:${requestId}] SUCCESS - Returning audio`);
    return {
      success: true,
      outputs: [{
        type: "audio",
        data: `data:${contentType};base64,${audioBase64}`,
        url: mediaUrl,
      }],
    };
  }

  if (isVideo && mediaSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [{ type: "video", data: "", url: mediaUrl }],
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
 * Generate image/video using Kie.ai API
 * Composes submitKieTask + polling + fetchKieMediaResult for backward compatibility.
 */
export async function generateWithKie(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  try {
    const { taskId, isVeo } = await submitKieTask(requestId, apiKey, input);

    // Poll for completion using existing polling functions
    const pollResult = isVeo
      ? await pollVeoTaskCompletion(requestId, apiKey, taskId)
      : await pollKieTaskCompletion(requestId, apiKey, taskId);

    if (!pollResult.success) {
      return {
        success: false,
        error: `${input.model.name}: ${pollResult.error}`,
      };
    }

    return await fetchKieMediaResult(requestId, {
      pollData: pollResult.data!,
      isVeo,
      modelName: input.model.name,
      capabilities: input.model.capabilities,
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Generation failed",
    };
  }
}
