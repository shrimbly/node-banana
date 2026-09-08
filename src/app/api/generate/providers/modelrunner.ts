/**
 * ModelRunner Provider for Generate API Route
 *
 * Handles image/video/audio generation using the ModelRunner API.
 * Uses async queue submission + polling.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";

const MODELRUNNER_QUEUE_BASE = "https://queue.modelrunner.run";
const MODELRUNNER_REST_BASE = "https://modelrunner.run";
const MODELRUNNER_MEDIA_HOST = "media.modelrunner.ai";

/** Queue lifecycle states. Note these differ from other queue APIs — there is no "PENDING". */
type ModelRunnerStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** Submit response: { status, request_id, response_url, queue_position? } */
interface ModelRunnerSubmitResponse {
  status?: ModelRunnerStatus;
  request_id?: string;
  response_url?: string;
  queue_position?: number;
  error?: string;
  message?: string;
}

interface ModelRunnerStatusResponse {
  status?: ModelRunnerStatus;
  queue_position?: number;
  error?: string;
}

/** Result response: the model's own output lives under `output`. */
interface ModelRunnerResultResponse {
  status?: ModelRunnerStatus;
  output?: unknown;
  error?: string;
}

interface InitiateUploadResponse {
  file_url?: string;
  upload_url?: string;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150; // 5 minutes
const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB
const LARGE_VIDEO_THRESHOLD_MB = 20;

/**
 * S3 signs Content-Disposition for the types the API forces to download, and the
 * PUT has to repeat it verbatim or the signature fails.
 */
const CONTENT_DISPOSITION_SIGNED_TYPES = new Map([["image/svg+xml", "attachment"]]);

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Upload a base64 data URL and return the hosted URL.
 *
 * ModelRunner takes file inputs as URLs, so any data URL coming from the canvas
 * has to be uploaded before it can be referenced in a generation request.
 */
async function uploadDataUrl(
  requestId: string,
  apiKey: string,
  dataUrl: string
): Promise<string> {
  // [\s\S] rather than the `s` flag: the repo's tsconfig target predates es2018.
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) {
    throw new Error("Malformed data URL");
  }

  const contentType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = isBase64
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf-8");

  const extension = contentType.split("/")[1]?.split("+")[0] || "bin";
  const initiateResponse = await fetch(
    `${MODELRUNNER_REST_BASE}/storage/upload/initiate`,
    {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        content_type: contentType,
        file_name: `${Date.now()}.${extension}`,
      }),
    }
  );

  if (!initiateResponse.ok) {
    const detail = await initiateResponse.text();
    throw new Error(
      `Upload initiate failed: ${initiateResponse.status} ${detail.substring(0, 200)}`
    );
  }

  const { file_url: fileUrl, upload_url: uploadUrl }: InitiateUploadResponse =
    await initiateResponse.json();
  if (!fileUrl || !uploadUrl) {
    throw new Error("Upload initiate returned no URLs");
  }

  const disposition = CONTENT_DISPOSITION_SIGNED_TYPES.get(contentType);
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    body: new Uint8Array(body),
    headers: {
      "Content-Type": contentType,
      ...(disposition ? { "Content-Disposition": disposition } : {}),
    },
  });

  if (!putResponse.ok) {
    throw new Error(`Upload failed: ${putResponse.status}`);
  }

  console.log(
    `[API:${requestId}] ModelRunner uploaded ${(body.length / 1024).toFixed(0)}KB → ${fileUrl}`
  );
  return fileUrl;
}

/** Upload any data URL in a value; pass http(s) URLs and plain values through. */
async function resolveValue(
  requestId: string,
  apiKey: string,
  value: string | string[]
): Promise<string | string[]> {
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item) => resolveValue(requestId, apiKey, item) as Promise<string>)
    );
  }
  if (typeof value === "string" && value.startsWith("data:")) {
    return uploadDataUrl(requestId, apiKey, value);
  }
  return value;
}

/**
 * Pull the media URL out of a completed request's output.
 *
 * The output shape is defined by the model, not the platform: most media models
 * return a bare URL string, others wrap it in an object or return a list.
 */
function extractOutputUrls(output: unknown): string[] {
  if (typeof output === "string") {
    return output ? [output] : [];
  }
  if (Array.isArray(output)) {
    return output.flatMap((item) => extractOutputUrls(item));
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    for (const key of [
      "image_url",
      "video_url",
      "audio_url",
      "url",
      "image",
      "video",
      "audio",
      "images",
      "videos",
      "output",
    ]) {
      if (key in record) {
        const found = extractOutputUrls(record[key]);
        if (found.length > 0) return found;
      }
    }
  }
  return [];
}

/**
 * Generate media using the ModelRunner API.
 * Uses async queue submission + polling.
 */
export async function generateWithModelRunner(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const modelId = input.model.id;
  console.log(
    `[API:${requestId}] ModelRunner generation - Model: ${modelId}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`
  );

  // Model ids are `owner/alias` and go straight into the URL path, so reject
  // anything that could escape it.
  if (/[^a-zA-Z0-9\-_/.]/.test(modelId) || modelId.includes("..")) {
    return { success: false, error: `Invalid model ID: ${modelId}` };
  }

  const is3DModel = input.model.capabilities.some((c) => c.includes("3d"));
  const isVideoModel =
    input.model.capabilities.includes("text-to-video") ||
    input.model.capabilities.includes("image-to-video");
  const isAudioModel = input.model.capabilities.some((c) => c.includes("audio"));

  const payload: Record<string, unknown> = {
    ...input.parameters,
    prompt: input.prompt,
  };

  try {
    // File inputs must be hosted URLs, so upload any data URLs first.
    if (input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0) {
      for (const [key, value] of Object.entries(input.dynamicInputs)) {
        if (value === null || value === undefined || value === "") continue;
        payload[key] = await resolveValue(requestId, apiKey, value);
      }
    } else if (input.images && input.images.length > 0) {
      const uploaded = await Promise.all(
        input.images.map(
          (image) => resolveValue(requestId, apiKey, image) as Promise<string>
        )
      );
      payload.image_url = uploaded[0];
      if (uploaded.length > 1) payload.image_urls = uploaded;
    }
  } catch (uploadError) {
    const message =
      uploadError instanceof Error ? uploadError.message : String(uploadError);
    console.error(`[API:${requestId}] ModelRunner input upload failed: ${message}`);
    return { success: false, error: `${input.model.name}: ${message}` };
  }

  console.log(
    `[API:${requestId}] Submitting to ModelRunner with inputs: ${Object.keys(payload).join(", ")}`
  );

  const submitUrl = `${MODELRUNNER_QUEUE_BASE}/${modelId}`;
  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail =
        errorJson.error || errorJson.message || errorJson.detail || errorDetail;
    } catch {
      // Keep original text
    }

    console.error(
      `[API:${requestId}] ModelRunner submit failed: ${submitResponse.status} - ${errorDetail}`
    );

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name || "ModelRunner"}: Rate limit exceeded. Try again in a moment.`,
      };
    }
    if (submitResponse.status === 402) {
      return {
        success: false,
        error: `${input.model.name || "ModelRunner"}: Insufficient balance. Top up at modelrunner.ai.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name || "ModelRunner"}: ${errorDetail}`,
    };
  }

  const submitResult: ModelRunnerSubmitResponse = await submitResponse.json();
  const queueRequestId = submitResult.request_id;
  if (!queueRequestId) {
    return {
      success: false,
      error: `${input.model.name}: No request_id in submit response`,
    };
  }

  console.log(`[API:${requestId}] ModelRunner queued: ${queueRequestId}`);

  const statusUrl = `${submitUrl}/requests/${queueRequestId}/status`;
  const resultUrl = `${submitUrl}/requests/${queueRequestId}`;
  let lastStatus = "";

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let statusData: ModelRunnerStatusResponse;
    try {
      const pollResponse = await fetch(statusUrl, {
        headers: authHeaders(apiKey),
      });
      if (!pollResponse.ok) {
        const detail = await pollResponse.text();
        return {
          success: false,
          error: `${input.model.name}: Status check failed (${pollResponse.status}) ${detail.substring(0, 200)}`,
        };
      }
      statusData = await pollResponse.json();
    } catch (pollError) {
      const message =
        pollError instanceof Error ? pollError.message : String(pollError);
      console.error(`[API:${requestId}] ModelRunner poll error: ${message}`);
      return { success: false, error: `${input.model.name}: ${message}` };
    }

    const currentStatus = statusData.status;
    if (currentStatus && currentStatus !== lastStatus) {
      console.log(
        `[API:${requestId}] ModelRunner status changed: ${lastStatus || "(none)"} → ${currentStatus}`
      );
      lastStatus = currentStatus;
    }

    if (currentStatus === "COMPLETED") break;

    if (currentStatus === "FAILED" || currentStatus === "CANCELLED") {
      const failureReason =
        statusData.error || `Generation ${currentStatus.toLowerCase()}`;
      console.error(`[API:${requestId}] ModelRunner task failed: ${failureReason}`);
      return { success: false, error: `${input.model.name}: ${failureReason}` };
    }

    if (attempt === MAX_POLL_ATTEMPTS - 1) {
      return {
        success: false,
        error: `${input.model.name}: Timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
      };
    }
  }

  const finalResponse = await fetch(resultUrl, { headers: authHeaders(apiKey) });
  if (!finalResponse.ok) {
    return {
      success: false,
      error: `${input.model.name}: Failed to fetch result (${finalResponse.status})`,
    };
  }

  const resultData: ModelRunnerResultResponse = await finalResponse.json();
  const outputUrls = extractOutputUrls(resultData.output);

  if (outputUrls.length === 0) {
    console.error(
      `[API:${requestId}] No outputs in ModelRunner result:`,
      JSON.stringify(resultData).substring(0, 500)
    );
    return {
      success: false,
      error: `${input.model.name}: No outputs in generation result`,
    };
  }

  const outputUrl = outputUrls[0];
  const outputUrlCheck = validateMediaUrl(outputUrl);
  if (!outputUrlCheck.valid) {
    return {
      success: false,
      error: `Invalid output URL: ${outputUrlCheck.error}`,
    };
  }

  // 3D assets are binary and often large — hand back the URL rather than buffering.
  if (is3DModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return { success: true, outputs: [{ type: "3d", data: "", url: outputUrl }] };
  }

  console.log(
    `[API:${requestId}] Fetching ModelRunner output from: ${outputUrl.substring(0, 80)}...`
  );

  const outputResponse = await fetch(outputUrl);
  if (!outputResponse.ok) {
    return {
      success: false,
      error: `Failed to fetch output: ${outputResponse.status}`,
    };
  }

  const declaredLength = parseInt(
    outputResponse.headers.get("content-length") || "0",
    10
  );
  if (!isNaN(declaredLength) && declaredLength > MAX_MEDIA_SIZE) {
    return {
      success: false,
      error: `Media too large: ${(declaredLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit`,
    };
  }

  const outputArrayBuffer = await outputResponse.arrayBuffer();
  if (outputArrayBuffer.byteLength > MAX_MEDIA_SIZE) {
    return {
      success: false,
      error: `Media too large: ${(outputArrayBuffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit`,
    };
  }
  const outputSizeMB = outputArrayBuffer.byteLength / (1024 * 1024);

  const rawContentType = outputResponse.headers.get("content-type");
  const contentType =
    rawContentType &&
    (rawContentType.startsWith("video/") ||
      rawContentType.startsWith("image/") ||
      rawContentType.startsWith("audio/"))
      ? rawContentType
      : isVideoModel
        ? "video/mp4"
        : isAudioModel
          ? "audio/mpeg"
          : "image/png";

  console.log(
    `[API:${requestId}] Output: ${contentType}, ${outputSizeMB.toFixed(2)}MB`
  );

  if (isVideoModel && outputSizeMB > LARGE_VIDEO_THRESHOLD_MB) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return { success: true, outputs: [{ type: "video", data: "", url: outputUrl }] };
  }

  const outputBase64 = Buffer.from(outputArrayBuffer).toString("base64");
  const isAudio = contentType.startsWith("audio/") || isAudioModel;
  const outputType = isVideoModel ? "video" : isAudio ? "audio" : "image";

  console.log(`[API:${requestId}] SUCCESS - ModelRunner ${outputType} generated`);

  return {
    success: true,
    outputs: [
      {
        type: outputType,
        data: `data:${contentType};base64,${outputBase64}`,
        url: outputUrl,
      },
    ],
  };
}

export { MODELRUNNER_MEDIA_HOST, MODELRUNNER_QUEUE_BASE, MODELRUNNER_REST_BASE };
