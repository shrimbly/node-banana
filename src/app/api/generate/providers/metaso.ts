/**
 * metaso MiniMax-H3 V2 provider.
 *
 * This adapter intentionally implements the H3 V2 task protocol directly.
 * It does not reuse the Kie.ai transport or the legacy Hailuo V1 contract.
 */

import type { GenerationInput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";

export const METASO_DEFAULT_BASE_URL = "https://metaso.cn/api/minimax/";
export const METASO_MODEL_ID = "MiniMax-H3";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const RESOLUTIONS = new Set(["768P", "2K"]);
const RATIOS = new Set(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);
const AUDIO_MIME_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"]);

type MetasoMediaKind = "image" | "video" | "audio";
type MetasoRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio";

interface MetasoErrorEnvelope {
  type?: string;
  error?: {
    type?: string;
    message?: string;
    http_code?: string;
  };
  request_id?: string;
}

interface MetasoTask {
  id?: string;
  model?: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code?: string; message?: string };
  content?: { url?: string };
}

interface MetasoQueryResponse {
  task?: MetasoTask;
}

export class MetasoApiError extends Error {
  status: number;
  errorType?: string;
  requestId?: string;

  constructor(message: string, status: number, errorType?: string, requestId?: string) {
    super(message);
    this.name = "MetasoApiError";
    this.status = status;
    this.errorType = errorType;
    this.requestId = requestId;
  }
}

export interface MetasoTaskCheckResult {
  status: "processing" | "completed" | "failed";
  error?: string;
  url?: string;
}

export function normalizeMetasoBaseUrl(baseUrl = METASO_DEFAULT_BASE_URL): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Invalid metaso API base URL");
  }

  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error("Invalid metaso API base URL");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("metaso API base URL must not include query parameters or a fragment");
  }

  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
  return parsed.toString();
}

export function buildMetasoUrl(path: string, baseUrl = METASO_DEFAULT_BASE_URL): string {
  const normalizedBase = normalizeMetasoBaseUrl(baseUrl);
  return new URL(path.replace(/^\/+/, ""), normalizedBase).toString();
}

function asStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

function estimateDataUriBytes(value: string): number | null {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return null;
  const encoded = match[2].replace(/\s/g, "");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function validateMediaLocation(value: string, kind: MetasoMediaKind): void {
  if (value.startsWith("https://") || value.startsWith("http://")) {
    const validation = validateMediaUrl(value);
    if (!validation.valid) {
      throw new Error(`Invalid public ${kind} URL: ${validation.error}`);
    }
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      throw new Error(`Invalid public ${kind} URL: credentials are not allowed`);
    }
    return;
  }
  if (value.startsWith("mm_file://")) {
    return;
  }

  const match = value.match(/^data:([^;,]+);base64,/);
  if (!match) {
    throw new Error(`${kind} input must be an HTTP URL, mm_file reference, or base64 data URI`);
  }

  const mimeType = match[1].toLowerCase();
  const allowed = kind === "image" ? IMAGE_MIME_TYPES : kind === "video" ? VIDEO_MIME_TYPES : AUDIO_MIME_TYPES;
  if (!allowed.has(mimeType)) {
    throw new Error(`Unsupported ${kind} MIME type: ${mimeType}`);
  }

  const bytes = estimateDataUriBytes(value);
  if (bytes === null) {
    throw new Error(`Malformed ${kind} base64 data URI`);
  }
  const limit = kind === "image" ? MAX_IMAGE_BYTES : kind === "video" ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
  if (bytes > limit) {
    throw new Error(`${kind} input exceeds the ${Math.round(limit / (1024 * 1024))}MB limit`);
  }
}

function mediaContent(kind: MetasoMediaKind, url: string, role: MetasoRole) {
  validateMediaLocation(url, kind);
  const type = `${kind}_url` as "image_url" | "video_url" | "audio_url";
  return {
    type,
    [type]: { url },
    role,
  };
}

function parseUpstreamError(body: unknown, status: number): MetasoApiError {
  const envelope = body && typeof body === "object" ? (body as MetasoErrorEnvelope) : {};
  const message = envelope.error?.message || `metaso request failed with HTTP ${status}`;
  return new MetasoApiError(message, status, envelope.error?.type, envelope.request_id);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function buildMetasoVideoRequest(input: GenerationInput): Record<string, unknown> {
  if (input.model.id !== METASO_MODEL_ID) {
    throw new Error(`Unsupported metaso model: ${input.model.id}`);
  }

  const dynamic = input.dynamicInputs || {};
  const dynamicPrompt = asStringArray(dynamic.prompt)[0];
  const prompt = (dynamicPrompt || input.prompt || "").trim();
  if (!prompt) throw new Error("Prompt is required for metaso MiniMax-H3");
  if (prompt.length > 7000) throw new Error("Prompt must be 7000 characters or fewer");

  const resolution = String(input.parameters?.resolution ?? "768P");
  if (!RESOLUTIONS.has(resolution)) throw new Error("resolution must be 768P or 2K");

  const duration = Number(input.parameters?.duration ?? 5);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new Error("duration must be an integer from 4 through 15");
  }

  const firstFrames = asStringArray(dynamic.first_frame);
  const lastFrames = asStringArray(dynamic.last_frame);
  const referenceImages = asStringArray(dynamic.reference_images);
  const referenceVideos = asStringArray(dynamic.reference_videos);
  const referenceAudios = asStringArray(dynamic.reference_audios);

  if (firstFrames.length > 1 || lastFrames.length > 1) {
    throw new Error("MiniMax-H3 accepts at most one first frame and one last frame");
  }
  if (referenceImages.length > 9) throw new Error("MiniMax-H3 accepts at most 9 reference images");
  if (referenceVideos.length > 3) throw new Error("MiniMax-H3 accepts at most 3 reference videos");
  if (referenceAudios.length > 3) throw new Error("MiniMax-H3 accepts at most 3 reference audio files");

  const fallbackImages = input.images || [];
  if (firstFrames.length === 0 && fallbackImages.length > 0) firstFrames.push(fallbackImages[0]);
  if (lastFrames.length === 0 && fallbackImages.length > 1) lastFrames.push(fallbackImages[1]);
  if (fallbackImages.length > 2) {
    throw new Error("Unnamed image inputs support only first and last frame; use reference_images for references");
  }
  if (lastFrames.length > 0 && firstFrames.length === 0) {
    throw new Error("last_frame requires first_frame");
  }

  const hasFrames = firstFrames.length > 0 || lastFrames.length > 0;
  const hasReferences = referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0;
  if (hasFrames && hasReferences) {
    throw new Error("First/last-frame inputs cannot be combined with reference media");
  }

  let ratio = String(input.parameters?.ratio ?? (hasFrames || hasReferences ? "adaptive" : "16:9"));
  if (!RATIOS.has(ratio)) throw new Error("Invalid MiniMax-H3 ratio");
  if (hasFrames) ratio = "adaptive";
  if (!hasFrames && !hasReferences && ratio === "adaptive") {
    throw new Error("Text-to-video requires a concrete ratio");
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const value of firstFrames) content.push(mediaContent("image", value, "first_frame"));
  for (const value of lastFrames) content.push(mediaContent("image", value, "last_frame"));
  for (const value of referenceImages) content.push(mediaContent("image", value, "reference_image"));
  for (const value of referenceVideos) content.push(mediaContent("video", value, "reference_video"));
  for (const value of referenceAudios) content.push(mediaContent("audio", value, "reference_audio"));

  const payload = {
    model: METASO_MODEL_ID,
    content,
    resolution,
    duration,
    ratio,
  };

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("metaso request body exceeds the 64MB limit");
  }
  return payload;
}

export async function submitMetasoTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput,
  baseUrl = METASO_DEFAULT_BASE_URL
): Promise<{ taskId: string }> {
  const url = buildMetasoUrl("v2/video_generation", baseUrl);
  const payload = buildMetasoVideoRequest(input);
  console.log(`[API:${requestId}] metaso task submission - Model: ${input.model.id}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await readJson(response);
  if (!response.ok) throw parseUpstreamError(body, response.status);

  const taskId = body && typeof body === "object" ? (body as { task_id?: unknown }).task_id : undefined;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new MetasoApiError("metaso did not return a task_id", 502);
  }
  return { taskId };
}

export async function checkMetasoTaskOnce(
  requestId: string,
  apiKey: string,
  taskId: string,
  baseUrl = METASO_DEFAULT_BASE_URL
): Promise<MetasoTaskCheckResult> {
  if (!taskId.trim()) throw new Error("taskId is required");
  const url = buildMetasoUrl(`v2/query/video_generation/${encodeURIComponent(taskId)}`, baseUrl);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await readJson(response);
  if (!response.ok) throw parseUpstreamError(body, response.status);

  const task = (body as MetasoQueryResponse | null)?.task;
  if (!task || !task.status) throw new MetasoApiError("Malformed metaso task response", 502);

  if (task.status === "queued" || task.status === "running") {
    return { status: "processing" };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    const detail = task.error?.message || task.error?.code || `Task ${task.status}`;
    return { status: "failed", error: detail };
  }
  if (task.status !== "succeeded") {
    throw new MetasoApiError(`Unknown metaso task status: ${String(task.status)}`, 502);
  }

  const outputUrl = task.content?.url;
  if (!outputUrl) throw new MetasoApiError("Succeeded metaso task did not include content.url", 502);
  const validation = validateMediaUrl(outputUrl);
  if (!validation.valid) {
    throw new MetasoApiError(`Invalid metaso output URL: ${validation.error}`, 502);
  }
  console.log(`[API:${requestId}] metaso task completed`);
  return { status: "completed", url: outputUrl };
}
