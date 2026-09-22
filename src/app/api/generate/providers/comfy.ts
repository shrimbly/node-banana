/**
 * Comfy Router provider.
 *
 * Every model runs through the Router's queue: submit, poll the status URL,
 * collect the native result. The request body and the result reader are
 * chosen by the model's family (src/lib/providers/comfyRouter.ts), because
 * the Router forwards each partner's own wire format rather than
 * normalising it. Outputs are downloaded and inlined as data URLs, the same
 * 20MB inline / 500MB ceiling as the Kie provider.
 */
import { randomUUID } from "crypto";

import type { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { COMFY_ROUTER_BASE_URL, getComfyRouterModel, type ComfyRouterFamily } from "@/lib/providers/comfyRouter";
import { validateMediaUrl } from "@/utils/urlValidation";

const MAX_MEDIA_SIZE = 500 * 1024 * 1024;
const INLINE_LIMIT = 20 * 1024 * 1024;
const SUBMIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;

export const COMFY_ROUTER_HEADER = "X-Comfy-Router-Key";

/** The key for a server request: header first, then either Comfy env var. */
export function resolveComfyRouterKey(headerValue: string | null): string | null {
  return headerValue || process.env.COMFY_API_KEY || process.env.COMFY_CLOUD_API_KEY || null;
}

/* ------------------------------------------------------------------ inputs */

type Json = Record<string, unknown>;

interface Media {
  /** Full data URL, as the app stores images. */
  dataUrl: string;
  mimeType: string;
  /** Payload without the `data:…;base64,` prefix. */
  base64: string;
}

function toMedia(value: string): Media | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(value);
  if (match) return { dataUrl: value, mimeType: match[1]!, base64: match[2]! };
  if (/^https?:\/\//.test(value)) return { dataUrl: value, mimeType: "", base64: "" };
  return null;
}

function listOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string" && item.length > 0);
}

/** Reference images: the generic image handle plus any schema `image` input. */
function referenceImages(input: GenerationInput): Media[] {
  const seen = new Set<string>();
  const out: Media[] = [];
  for (const value of [...(input.images ?? []), ...listOf(input.dynamicInputs?.image)]) {
    if (seen.has(value)) continue;
    seen.add(value);
    const media = toMedia(value);
    if (media) out.push(media);
  }
  return out;
}

function firstFrame(input: GenerationInput): Media | null {
  return referenceImages(input)[0] ?? null;
}

function lastFrame(input: GenerationInput): Media | null {
  const value = listOf(input.dynamicInputs?.last_frame)[0];
  return value ? toMedia(value) : null;
}

/** A media value for a partner that takes raw base64 or a URL in one field. */
function rawOrUrl(media: Media): string {
  return media.base64 || media.dataUrl;
}

function param<T>(input: GenerationInput, name: string): T | undefined {
  const value = input.parameters?.[name];
  return value === undefined || value === null || value === "" ? undefined : (value as T);
}

/** Copy the listed parameters that have a value. */
function pick(input: GenerationInput, names: string[]): Json {
  const out: Json = {};
  for (const name of names) {
    const value = param(input, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The Router request body for a model, by its family. */
export function buildComfyRouterBody(family: ComfyRouterFamily, input: GenerationInput): Json {
  const prompt = input.prompt || "";
  const images = referenceImages(input);

  switch (family) {
    case "flux2": {
      const body: Json = { prompt, ...pick(input, ["width", "height", "output_format", "prompt_upsampling", "safety_tolerance", "seed"]) };
      images.slice(0, 9).forEach((media, index) => {
        body[index === 0 ? "input_image" : `input_image_${index + 1}`] = media.base64 || media.dataUrl;
      });
      return body;
    }
    case "fluxKontext": {
      const body: Json = { prompt, ...pick(input, ["aspect_ratio", "output_format", "prompt_upsampling", "safety_tolerance", "seed"]) };
      images.slice(0, 4).forEach((media, index) => {
        body[index === 0 ? "input_image" : `input_image_${index + 1}`] = rawOrUrl(media);
      });
      return body;
    }
    case "flux11":
      return { prompt, ...pick(input, ["width", "height", "output_format", "safety_tolerance", "seed"]) };
    case "flux11Ultra": {
      const body: Json = { prompt, ...pick(input, ["aspect_ratio", "raw", "output_format", "safety_tolerance", "seed"]) };
      if (images[0]) {
        body.image_prompt = images[0].base64 || images[0].dataUrl;
        const strength = param<number>(input, "image_prompt_strength");
        if (strength !== undefined) body.image_prompt_strength = strength;
      }
      return body;
    }
    case "gptImage": {
      const body: Json = { prompt, n: 1, ...pick(input, ["size", "quality", "background", "output_format"]) };
      if (images.length > 0) body.image = images.length === 1 ? images[0]!.dataUrl : images.map((media) => media.dataUrl);
      return body;
    }
    case "geminiImage": {
      const parts: Json[] = [{ text: prompt }];
      for (const media of images) {
        if (media.base64) parts.push({ inlineData: { mimeType: media.mimeType, data: media.base64 } });
      }
      const imageConfig: Json = {};
      const aspectRatio = param<string>(input, "aspectRatio");
      const imageSize = param<string>(input, "imageSize");
      if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
      if (imageSize) imageConfig.imageSize = imageSize;
      return {
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
      };
    }
    case "seedream": {
      const body: Json = {
        prompt,
        response_format: "url",
        sequential_image_generation: "disabled",
        watermark: param<boolean>(input, "watermark") ?? false,
        ...pick(input, ["size", "seed"]),
      };
      if (images.length > 0) body.image = images.length === 1 ? images[0]!.dataUrl : images.map((media) => media.dataUrl);
      return body;
    }
    case "grokImage":
      return { prompt, n: 1, response_format: "url", ...pick(input, ["aspect_ratio", "resolution", "quality"]) };
    case "ideogramV4":
      return { text_prompt: prompt, ...pick(input, ["rendering_speed", "resolution"]) };
    case "recraft":
      return { prompt, n: 1, response_format: "url", ...pick(input, ["size", "style"]) };
    case "qwenImage": {
      const content: Json[] = images.slice(0, 3).map((media) => ({ image: media.dataUrl }));
      content.push({ text: prompt });
      return {
        input: { messages: [{ role: "user", content }] },
        parameters: { n: 1, watermark: false, ...pick(input, ["size", "negative_prompt", "prompt_extend", "seed"]) },
      };
    }
    case "klingImage": {
      const body: Json = { prompt, n: 1, ...pick(input, ["aspect_ratio", "resolution"]) };
      if (images.length > 0) body.image_list = images.map((media) => ({ image: rawOrUrl(media) }));
      return body;
    }

    case "seedance": {
      const content: Json[] = [{ type: "text", text: prompt }];
      const first = firstFrame(input);
      const last = lastFrame(input);
      if (first) content.push({ type: "image_url", image_url: { url: first.dataUrl }, role: "first_frame" });
      if (last) content.push({ type: "image_url", image_url: { url: last.dataUrl }, role: "last_frame" });
      return {
        content,
        watermark: false,
        ...pick(input, ["duration", "ratio", "resolution", "generate_audio", "seed"]),
      };
    }
    case "klingText":
      return { prompt, ...pick(input, ["aspect_ratio", "duration", "mode", "sound", "negative_prompt", "cfg_scale"]) };
    case "klingOmni": {
      const body: Json = { prompt, ...pick(input, ["aspect_ratio", "duration", "mode", "sound"]) };
      const frames: Json[] = [];
      const first = firstFrame(input);
      const last = lastFrame(input);
      if (first) frames.push({ image_url: rawOrUrl(first), type: "first_frame" });
      if (last) frames.push({ image_url: rawOrUrl(last), type: "end_frame" });
      if (frames.length > 0) body.image_list = frames;
      return body;
    }
    case "kling3Turbo":
      return { prompt, settings: pick(input, ["aspect_ratio", "duration", "resolution"]) };
    case "veo": {
      const instance: Json = { prompt };
      const first = firstFrame(input);
      const last = lastFrame(input);
      if (first?.base64) instance.image = { bytesBase64Encoded: first.base64, mimeType: first.mimeType };
      if (last?.base64) instance.lastFrame = { bytesBase64Encoded: last.base64, mimeType: last.mimeType };
      return {
        instances: [instance],
        parameters: {
          sampleCount: 1,
          personGeneration: "allow_adult",
          ...pick(input, ["aspectRatio", "durationSeconds", "resolution", "generateAudio", "negativePrompt"]),
        },
      };
    }
    case "grokVideo": {
      const body: Json = { prompt, ...pick(input, ["aspect_ratio", "duration"]) };
      const first = firstFrame(input);
      if (first) body.image = { type: "image_url", url: first.dataUrl };
      return body;
    }
    case "runwayGen4": {
      const first = firstFrame(input);
      return {
        promptText: prompt,
        promptImage: first?.dataUrl,
        seed: Math.floor(Math.random() * 4294967295),
        duration: param<number>(input, "duration") ?? 5,
        ratio: param<string>(input, "ratio") ?? "1280:720",
      };
    }
    case "ltx":
      return { prompt, ...pick(input, ["duration", "resolution", "fps", "generate_audio"]) };
    case "minimax": {
      const content: Json[] = [{ type: "text", text: prompt }];
      const first = firstFrame(input);
      if (first) content.push({ type: "image_url", image_url: { url: first.dataUrl }, role: "first_frame" });
      return {
        content,
        duration: param<number>(input, "duration") ?? 5,
        resolution: param<string>(input, "resolution") ?? "768P",
        ...pick(input, ["ratio"]),
      };
    }
    case "wanVideo": {
      const inputBlock: Json = { prompt, ...pick(input, ["negative_prompt"]) };
      const first = firstFrame(input);
      if (first) inputBlock.media = [{ type: "first_frame", url: first.dataUrl }];
      return {
        input: inputBlock,
        parameters: { watermark: false, ...pick(input, ["duration", "ratio", "resolution", "audio", "seed"]) },
      };
    }
    case "lumaRay":
      return { prompt, ...pick(input, ["aspect_ratio", "duration", "resolution", "loop"]) };
  }
}

/* ------------------------------------------------------------------ transport */

interface RouterError {
  detail?: unknown;
  error_type?: string;
}

async function routerErrorMessage(response: Response): Promise<string> {
  let body: RouterError | null = null;
  try {
    body = (await response.json()) as RouterError;
  } catch {
    body = null;
  }
  const detail = body?.detail;
  if (typeof detail === "string" && detail) return `${detail} (${body?.error_type ?? response.status})`;
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    if (first?.msg) return `${(first.loc ?? []).slice(1).join(".") || "input"}: ${first.msg}`;
  }
  if (response.status === 401) return "Comfy API key was rejected";
  if (response.status === 402) return "Comfy workspace has no credits";
  if (response.status === 429) return "Comfy Router rate limit reached, try again shortly";
  return `Comfy Router error ${response.status}`;
}

function headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "X-API-Key": apiKey, "Content-Type": "application/json", ...extra };
}

function modelPath(modelId: string): string {
  const [provider, ...rest] = modelId.split("/");
  return `${COMFY_ROUTER_BASE_URL}/v2/models/${encodeURIComponent(provider ?? "")}/${encodeURIComponent(rest.join("/"))}`;
}

/** Queue a run. Returns the Router request id, which the poll route carries. */
export async function submitComfyTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ taskId: string }> {
  const model = getComfyRouterModel(input.model.id);
  if (!model) throw new Error(`${input.model.id} is not in the Comfy Router catalog`);

  const body = buildComfyRouterBody(model.family, input);
  console.log(`[API:${requestId}] Comfy Router submit ${model.id} (${model.family})`);

  const response = await fetch(`${modelPath(model.id)}/requests`, {
    method: "POST",
    headers: headers(apiKey, { "Idempotency-Key": randomUUID() }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(await routerErrorMessage(response));

  const submitted = (await response.json()) as { request_id?: string };
  if (!submitted.request_id) throw new Error("Comfy Router returned no request id");
  return { taskId: submitted.request_id };
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP-date; undefined when absent or unusable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? Math.round(seconds * 1000) : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

export type ComfyTaskStatus =
  | { status: "processing"; retryAfterMs?: number }
  | { status: "failed"; error: string }
  | { status: "completed" };

/** One look at the queue: is the run still going, done, or failed? */
export async function checkComfyTaskOnce(
  requestId: string,
  apiKey: string,
  modelId: string,
  taskId: string
): Promise<ComfyTaskStatus> {
  const response = await fetch(`${modelPath(modelId)}/requests/${encodeURIComponent(taskId)}/status`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 410) return { status: "failed", error: "Comfy Router result expired" };
  if (!response.ok) return { status: "failed", error: await routerErrorMessage(response) };

  const status = (await response.json()) as { status?: string; error_type?: string; queue_position?: number };
  if (status.status === "COMPLETED") {
    if (status.error_type) return { status: "failed", error: `Comfy Router: ${status.error_type}` };
    return { status: "completed" };
  }
  console.log(`[API:${requestId}] Comfy Router ${taskId}: ${status.status ?? "?"}${status.queue_position ? ` (queue ${status.queue_position})` : ""}`);
  return { status: "processing", retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")) };
}

/* ------------------------------------------------------------------ results */

interface Found {
  /** An http(s) URL to download, or a data URL ready to return. */
  source: string;
  mimeType?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fail(message: string | undefined, fallback: string): never {
  throw new Error(message || fallback);
}

/** The finished asset from a family's native result, or a thrown error carrying the partner's reason. */
export function readComfyRouterResult(family: ComfyRouterFamily, result: Json): Found {
  const dataUrlFrom = (b64: string | undefined, mime: string) => (b64 ? `data:${mime};base64,${b64}` : undefined);

  switch (family) {
    case "flux2":
    case "fluxKontext":
    case "flux11":
    case "flux11Ultra": {
      const status = str(result.status);
      const sample = str(obj(result.result)?.sample);
      if (sample) return { source: sample };
      return fail(status && status !== "Ready" ? `Black Forest Labs: ${status}` : undefined, "No image in the FLUX result");
    }
    case "gptImage": {
      const first = obj(arr(result.data)[0]);
      const format = str(result.output_format) ?? "png";
      const source = dataUrlFrom(str(first?.b64_json), `image/${format}`) ?? str(first?.url);
      return source ? { source } : fail(undefined, "No image in the GPT Image result");
    }
    case "geminiImage": {
      const feedback = obj(result.promptFeedback);
      for (const candidate of arr(result.candidates)) {
        for (const part of arr(obj(obj(candidate)?.content)?.parts)) {
          const inline = obj(obj(part)?.inlineData);
          const source = dataUrlFrom(str(inline?.data), str(inline?.mimeType) ?? "image/png");
          if (source) return { source };
        }
      }
      return fail(str(feedback?.blockReasonMessage) ?? (str(feedback?.blockReason) && `Blocked: ${str(feedback?.blockReason)}`), "No image in the Gemini result");
    }
    case "seedream": {
      const error = obj(result.error);
      if (error && (str(error.message) || str(error.code))) fail(`Seedream: ${str(error.message) ?? str(error.code)}`, "Seedream failed");
      const first = obj(arr(result.data)[0]);
      const source = str(first?.url) ?? dataUrlFrom(str(first?.b64_json), "image/jpeg");
      return source ? { source } : fail(undefined, "No image in the Seedream result");
    }
    case "grokImage": {
      const blocked = str(result.block_reason);
      if (blocked) fail(`Blocked: ${blocked}`, "Blocked");
      const first = obj(arr(result.data)[0]);
      const source = str(first?.url) ?? dataUrlFrom(str(first?.b64_json), str(first?.mime_type) ?? "image/jpeg");
      return source ? { source } : fail(undefined, "No image in the Grok result");
    }
    case "ideogramV4":
    case "recraft": {
      const first = obj(arr(result.data)[0]);
      const source = str(first?.url) ?? dataUrlFrom(str(first?.b64_json), "image/png");
      return source ? { source } : fail(undefined, "No image in the result");
    }
    case "qwenImage": {
      if (str(result.code)) fail(`Qwen: ${str(result.message) ?? str(result.code)}`, "Qwen failed");
      for (const choice of arr(obj(result.output)?.choices)) {
        for (const item of arr(obj(obj(choice)?.message)?.content)) {
          const source = str(obj(item)?.image);
          if (source) return { source };
        }
      }
      return fail(undefined, "No image in the Qwen result");
    }
    case "klingImage":
    case "klingText":
    case "klingOmni": {
      const data = obj(result.data);
      const status = str(data?.task_status);
      if (status === "failed") fail(`Kling: ${str(data?.task_status_msg) ?? str(result.message)}`, "Kling failed");
      const taskResult = obj(data?.task_result);
      const items = family === "klingImage" ? arr(taskResult?.images) : arr(taskResult?.videos);
      const source = str(obj(items[0])?.url);
      return source ? { source } : fail(str(result.message), "No output in the Kling result");
    }
    case "kling3Turbo": {
      const task = obj(arr(result.data)[0]);
      if (str(task?.status) === "failed") fail(`Kling: ${str(task?.message) ?? str(result.message)}`, "Kling failed");
      for (const output of arr(task?.outputs)) {
        const item = obj(output);
        if (str(item?.type) === "video" && str(item?.url)) return { source: str(item?.url)! };
      }
      return fail(str(result.message), "No video in the Kling result");
    }
    case "seedance": {
      const error = obj(result.error);
      if (str(result.status) === "failed" || (error && str(error.message))) fail(`Seedance: ${str(error?.message) ?? str(error?.code) ?? str(result.status)}`, "Seedance failed");
      const source = str(obj(result.content)?.video_url);
      return source ? { source } : fail(undefined, "No video in the Seedance result");
    }
    case "veo": {
      const error = obj(result.error);
      if (error && str(error.message)) fail(`Veo: ${str(error.message)}`, "Veo failed");
      const response = obj(result.response);
      const video = obj(arr(response?.videos)[0]);
      const mime = str(video?.mimeType) ?? "video/mp4";
      const source = dataUrlFrom(str(video?.bytesBase64Encoded), mime) ?? str(video?.gcsUri);
      if (source && !source.startsWith("gs://")) return { source, mimeType: mime };
      const filtered = Number(response?.raiMediaFilteredCount) || 0;
      return fail(filtered > 0 ? `Veo filtered the output: ${arr(response?.raiMediaFilteredReasons).join(", ")}` : undefined, "No video in the Veo result");
    }
    case "grokVideo": {
      const blocked = str(result.block_reason);
      if (blocked) fail(`Blocked: ${blocked}`, "Blocked");
      const source = str(obj(result.video)?.url);
      return source ? { source } : fail(undefined, "No video in the Grok result");
    }
    case "runwayGen4": {
      const status = str(result.status);
      if (status && status !== "SUCCEEDED") fail(`Runway: ${status}`, "Runway failed");
      const source = str(arr(result.output)[0]);
      return source ? { source } : fail(undefined, "No video in the Runway result");
    }
    case "ltx": {
      const error = obj(result.error);
      if (str(result.status) === "failed" || error) fail(`LTX: ${str(error?.message) ?? "failed"}`, "LTX failed");
      const source = str(obj(result.result)?.video_url);
      return source ? { source } : fail(undefined, "No video in the LTX result");
    }
    case "minimax": {
      const task = obj(result.task);
      const error = obj(task?.error);
      if (str(task?.status) === "failed" || error) fail(`MiniMax: ${str(error?.message) ?? str(task?.status)}`, "MiniMax failed");
      const source = str(obj(task?.content)?.url);
      return source ? { source } : fail(undefined, "No video in the MiniMax result");
    }
    case "wanVideo": {
      const output = obj(result.output);
      if (str(result.code) || str(output?.code)) fail(`Wan: ${str(result.message) ?? str(output?.message) ?? str(result.code)}`, "Wan failed");
      if (str(output?.task_status) === "FAILED") fail(`Wan: ${str(output?.message) ?? "failed"}`, "Wan failed");
      const source = str(output?.video_url);
      return source ? { source } : fail(undefined, "No video in the Wan result");
    }
    case "lumaRay": {
      if (str(result.state) === "failed") fail(`Luma: ${str(result.failure_reason) ?? "failed"}`, "Luma failed");
      const source = str(obj(result.assets)?.video);
      return source ? { source } : fail(undefined, "No video in the Luma result");
    }
  }
}

/**
 * Read a body up to `limit` bytes. Past the limit the stream is cancelled
 * and `null` comes back, so a large file never sits in memory.
 */
async function readBounded(response: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > limit ? null : buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Download an output and inline it as a data URL. Images are always
 * inlined, because the image response carries no URL field; videos above
 * the inline limit come back as their URL instead, as with Kie.
 */
async function materialise(
  requestId: string,
  found: Found,
  type: "image" | "video"
): Promise<NonNullable<GenerationOutput["outputs"]>[number]> {
  if (found.source.startsWith("data:")) return { type, data: found.source };

  const check = validateMediaUrl(found.source);
  if (!check.valid) throw new Error(`Invalid media URL: ${check.error}`);

  const response = await fetch(found.source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to fetch output: ${response.status}`);
  }
  const contentType = found.mimeType || response.headers.get("content-type")?.split(";")[0] || (type === "video" ? "video/mp4" : "image/png");

  const buffer = await readBounded(response, type === "video" ? INLINE_LIMIT : MAX_MEDIA_SIZE);
  if (!buffer) {
    if (type === "video") {
      console.log(`[API:${requestId}] Comfy Router video above ${INLINE_LIMIT / 1048576}MB, returning its URL`);
      return { type, data: "", url: found.source };
    }
    throw new Error(`Media too large: over the ${MAX_MEDIA_SIZE / 1048576}MB limit`);
  }
  console.log(`[API:${requestId}] Comfy Router output ${contentType}, ${(buffer.byteLength / 1048576).toFixed(2)}MB`);
  return { type, data: `data:${contentType};base64,${buffer.toString("base64")}`, url: found.source };
}

/** Collect a completed run and turn it into the app's output. */
export async function fetchComfyMediaResult(
  requestId: string,
  apiKey: string,
  modelId: string,
  taskId: string,
  mediaType: string
): Promise<GenerationOutput> {
  const model = getComfyRouterModel(modelId);
  if (!model) return { success: false, error: `${modelId} is not in the Comfy Router catalog` };

  try {
    const response = await fetch(`${modelPath(modelId)}/requests/${encodeURIComponent(taskId)}`, {
      headers: headers(apiKey),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 202) return { success: false, error: "Comfy Router result is not ready yet" };
    if (response.status === 410) return { success: false, error: "Comfy Router result expired" };
    if (!response.ok) return { success: false, error: await routerErrorMessage(response) };

    const credits = response.headers.get("X-Comfy-Credits-Used");
    if (credits) console.log(`[API:${requestId}] Comfy Router credits used: ${credits}`);

    const result = (await response.json()) as Json;
    const found = readComfyRouterResult(model.family, result);
    const type = mediaType === "video" || model.capabilities.some((c) => c.endsWith("-video")) ? "video" : "image";
    const output = await materialise(requestId, found, type);
    return { success: true, outputs: [output] };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Comfy Router result failed" };
  }
}

/**
 * Submit and wait, for callers that cannot poll (tests, scripts). The
 * app's generate route returns the polling envelope instead.
 */
export async function generateWithComfy(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput,
  options: { maxWaitMs?: number } = {}
): Promise<GenerationOutput> {
  if (!apiKey) return { success: false, error: "Comfy API key not configured" };
  try {
    const { taskId } = await submitComfyTask(requestId, apiKey, input);
    const deadline = Date.now() + (options.maxWaitMs ?? 4 * 60_000);
    let delay = 2000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const status = await checkComfyTaskOnce(requestId, apiKey, input.model.id, taskId);
      if (status.status === "failed") return { success: false, error: status.error };
      if (status.status === "completed") break;
      delay = Math.min(status.retryAfterMs ?? delay * 1.5, 10_000);
    }
    const mediaType = input.model.capabilities.some((c) => c.endsWith("-video")) ? "video" : "image";
    return await fetchComfyMediaResult(requestId, apiKey, input.model.id, taskId, mediaType);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Comfy Router generation failed" };
  }
}
