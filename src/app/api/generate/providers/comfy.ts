/**
 * Comfy Router provider.
 *
 * Most models run through the Router's queue: submit, poll the status URL,
 * collect the native result. A binary partner (ElevenLabs) runs on the
 * model's own route in one request, since the queue cannot store its bytes
 * (`transport` on the binding). What goes in the request and where the result
 * sits are described per wire format in src/lib/providers/comfyRouter
 * (families.json, read by template.ts), and each model's settings come from
 * its published schema. This module does the I/O around that: encoding the
 * node's media the way each partner wants it (uploading to Comfy storage
 * for partners that take URLs only), the queue, and turning the result into
 * the app's image, video, audio or 3D output.
 */
import { randomUUID } from "crypto";

import type { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { COMFY_ROUTER_BASE_URL } from "@/lib/providers/comfyRouter";
import { ROUTER_PROVIDER_PARAM, resolveRouterModel } from "@/lib/providers/comfyRouter/catalog";
import type { RouterBinding, RouterOutput } from "@/lib/providers/comfyRouter/families";
import { encodeMedia } from "@/lib/providers/comfyRouter/media";
import { buildRouterBody, missingInputs, type RouterRequestInput } from "@/lib/providers/comfyRouter/request";
import { findMedia, findMediaAnywhere, resultError, type ComfyMediaValue, type FoundMedia, type Json } from "@/lib/providers/comfyRouter/template";
import { routerBinding } from "@/lib/providers/comfyRouter/families";
import { validateMediaUrl } from "@/utils/urlValidation";

const MAX_MEDIA_SIZE = 500 * 1024 * 1024;
const INLINE_LIMIT = 20 * 1024 * 1024;
const SUBMIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;
/** A synchronous run is the whole render in one request. */
const SYNC_TIMEOUT_MS = 180_000;

export const COMFY_ROUTER_HEADER = "X-Comfy-Router-Key";

/** The key for a server request: header first, then either Comfy env var. */
export function resolveComfyRouterKey(headerValue: string | null): string | null {
  return headerValue || process.env.COMFY_API_KEY || process.env.COMFY_CLOUD_API_KEY || null;
}

/* ------------------------------------------------------------------ inputs */

function listOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string" && item.length > 0);
}

/**
 * The node's media per handle. Nodes send each connected value under its
 * handle's schema name, and also collect every image into `images`. When the
 * first image handle did not arrive by name (older nodes, or a node that has
 * not loaded its schema yet) it takes `images`, minus anything that arrived
 * under another handle, so a mask or a last frame is never also sent as the
 * reference.
 */
function mediaByHandle(binding: RouterBinding, input: GenerationInput): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const handle of binding.inputs) {
    if (handle.type === "text") continue;
    const unique = [...new Set(listOf(input.dynamicInputs?.[handle.name]))];
    if (unique.length) out[handle.name] = unique.slice(0, handle.max ?? unique.length);
  }
  const first = binding.inputs.find((handle) => handle.type === "image");
  if (first && !out[first.name] && input.images?.length) {
    const claimed = new Set(Object.values(out).flat());
    const rest = [...new Set(input.images)].filter((value) => !claimed.has(value));
    if (rest.length) out[first.name] = rest.slice(0, first.max ?? rest.length);
  }
  return out;
}

/** Does the template ask for this handle's duration anywhere? */
function wantsDuration(binding: RouterBinding, handle: string): boolean {
  return JSON.stringify(binding.body).includes(`input.${handle}[0].duration`);
}

/**
 * Everything the template needs, with media encoded (and uploaded) per handle.
 * Through an alternate provider, media the model would take inline as a data
 * URL go up as Comfy storage URLs instead: Seedance served by Higgsfield
 * refuses a data-URL first frame and accepts the same image by URL. Raw
 * base64 fields (Gemini's inlineData, Veo's bytes) cannot take a URL and stay.
 */
export async function prepareRouterInput(
  binding: RouterBinding,
  input: GenerationInput,
  apiKey: string,
  provider: string | null = null
): Promise<RouterRequestInput> {
  const raw = mediaByHandle(binding, input);
  const media: Record<string, ComfyMediaValue[]> = {};
  const encodings: Record<string, "base64" | "dataUrl" | "url"> = {};
  for (const handle of binding.inputs) {
    const values = raw[handle.name];
    if (!values?.length) continue;
    const declared = handle.encoding ?? "dataUrl";
    const encoding = provider && declared === "dataUrl" ? "url" : declared;
    if (encoding !== declared) encodings[handle.name] = encoding;
    media[handle.name] = await Promise.all(
      values.map((value) => encodeMedia(value, encoding, apiKey, { needsDuration: wantsDuration(binding, handle.name) }))
    );
  }
  const negative = listOf(input.dynamicInputs?.negative_prompt)[0];
  return {
    prompt: input.prompt || listOf(input.dynamicInputs?.prompt)[0] || "",
    negativePrompt: negative,
    parameters: input.parameters,
    media,
    encodings,
  };
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

/**
 * The provider to ask for, when the user picked one other than the default.
 * Anything not in the model's list is ignored rather than sent, so a stale
 * setting (a model that lost an alternate) falls back to the default.
 */
export function servingProvider(providers: string[], value: unknown): string | null {
  if (typeof value !== "string" || providers.length < 2) return null;
  if (value === providers[0] || !providers.includes(value)) return null;
  return value;
}

/** The model's binding, the request body the node's input fills, and the serving provider asked for. */
async function prepareRouterRequest(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ binding: RouterBinding; body: Json; provider: string | null }> {
  const resolved = await resolveRouterModel(input.model.id, apiKey);
  if (!resolved) throw new Error(`${input.model.id} is not a Comfy Router model this app can run`);
  const { binding, params, providers } = resolved;

  const provider = servingProvider(providers, input.parameters?.[ROUTER_PROVIDER_PARAM]);
  const prepared = await prepareRouterInput(binding, input, apiKey, provider);
  const missing = missingInputs(binding, prepared);
  if (missing) throw new Error(missing);
  const body = buildRouterBody(binding, params, prepared) as Json;
  console.log(`[API:${requestId}] Comfy Router ${binding.transport === "sync" ? "run" : "submit"} ${binding.id} (${binding.family})${provider ? ` via ${provider}` : ""}`);
  return { binding, body, provider };
}

async function refusal(response: Response, provider: string | null): Promise<Error> {
  const message = await routerErrorMessage(response);
  // The Router's refusal names no field; through an alternate provider the
  // usual cause is a setting that provider does not take.
  if (provider && /invalid_input/.test(message)) {
    return new Error(`${message}. Not every setting is available through ${provider}; try the comfy provider or fewer settings.`);
  }
  return new Error(message);
}

/** Does this model run in one request rather than through the queue? */
export function comfyRunsSynchronously(modelId: string): boolean {
  return routerBinding(modelId)?.transport === "sync";
}

/**
 * Run a model on its own route and return the finished output: the whole
 * render in one request, for the partners the queue cannot carry.
 */
export async function runComfySynchronously(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  try {
    const { binding, body, provider } = await prepareRouterRequest(requestId, apiKey, input);
    const response = await fetch(`${modelPath(binding.id)}${provider ? `?model_provider=${encodeURIComponent(provider)}` : ""}`, {
      method: "POST",
      headers: headers(apiKey, { "Idempotency-Key": randomUUID() }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (!response.ok) throw await refusal(response, provider);
    return await outputOf(requestId, binding, response);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Comfy Router generation failed" };
  }
}

/** Queue a run. Returns the Router request id, which the poll route carries. */
export async function submitComfyTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ taskId: string }> {
  const { binding, body, provider } = await prepareRouterRequest(requestId, apiKey, input);
  if (binding.transport === "sync") throw new Error(`${binding.name} runs in one request, not through the queue`);

  const response = await fetch(`${modelPath(binding.id)}/requests${provider ? `?model_provider=${encodeURIComponent(provider)}` : ""}`, {
    method: "POST",
    headers: headers(apiKey, { "Idempotency-Key": randomUUID() }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });

  if (!response.ok) throw await refusal(response, provider);

  const submitted = (await response.json()) as { request_id?: string };
  if (!submitted.request_id) throw new Error("Comfy Router returned no request id");
  console.log(`[API:${requestId}] Comfy Router queued ${binding.id} as ${submitted.request_id}`);
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
  // A busy or briefly unavailable Router is not a failed run: keep polling.
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    console.log(`[API:${requestId}] Comfy Router ${taskId}: status check ${response.status}, will retry`);
    return { status: "processing", retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")) };
  }
  if (!response.ok) return { status: "failed", error: await routerErrorMessage(response) };

  const status = (await response.json()) as { status?: string; error_type?: string; queue_position?: number };
  if (status.status === "COMPLETED") {
    if (status.error_type) return { status: "failed", error: `Comfy Router: ${status.error_type}` };
    return { status: "completed" };
  }
  console.log(`[API:${requestId}] Comfy Router ${taskId}: ${status.status ?? "?"}${status.queue_position ? ` (queue ${status.queue_position})` : ""}`);
  return { status: "processing", retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")) };
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

type OutputType = NonNullable<GenerationOutput["outputs"]>[number]["type"];

const FALLBACK_MIME: Record<OutputType, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  "3d": "model/gltf-binary",
};

/**
 * Turn a found asset into the app's output. Images are always inlined;
 * video and audio are inlined up to 20MB and returned as their URL above
 * that; 3D models are returned as their URL, as the 3D node loads them.
 */
async function materialise(requestId: string, found: FoundMedia, type: OutputType): Promise<NonNullable<GenerationOutput["outputs"]>[number]> {
  if (found.source.startsWith("data:")) return { type, data: type === "3d" ? "" : found.source, ...(type === "3d" ? { url: found.source } : {}) };
  if (type === "3d") return { type, data: "", url: found.source };

  const check = validateMediaUrl(found.source);
  if (!check.valid) throw new Error(`Invalid media URL: ${check.error}`);

  const response = await fetch(found.source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to fetch output: ${response.status}`);
  }
  const contentType = found.mimeType || response.headers.get("content-type")?.split(";")[0] || FALLBACK_MIME[type];

  const buffer = await readBounded(response, type === "image" ? MAX_MEDIA_SIZE : INLINE_LIMIT);
  if (!buffer) {
    if (type !== "image") {
      console.log(`[API:${requestId}] Comfy Router ${type} above ${INLINE_LIMIT / 1048576}MB, returning its URL`);
      return { type, data: "", url: found.source };
    }
    throw new Error(`Media too large: over the ${MAX_MEDIA_SIZE / 1048576}MB limit`);
  }
  console.log(`[API:${requestId}] Comfy Router output ${contentType}, ${(buffer.byteLength / 1048576).toFixed(2)}MB`);
  return { type, data: `data:${contentType};base64,${buffer.toString("base64")}`, url: found.source };
}

function outputType(output: RouterOutput): OutputType {
  return output;
}

/** The asset in a Router result document, or a thrown error carrying the partner's reason. */
export function readRouterResult(binding: RouterBinding, result: Json): FoundMedia {
  const error = resultError(result, binding.result.errors);
  if (error) throw new Error(`${binding.name}: ${error}`);
  const found = findMedia(result, binding.result) ?? findMediaAnywhere(result, binding.output);
  if (found) return found;
  throw new Error(`No ${binding.output === "3d" ? "3D model" : binding.output} in the ${binding.name} result`);
}

/** Collect a completed run and turn it into the app's output. */
export async function fetchComfyMediaResult(
  requestId: string,
  apiKey: string,
  modelId: string,
  taskId: string,
  _mediaType?: string
): Promise<GenerationOutput> {
  const binding = routerBinding(modelId);
  if (!binding) return { success: false, error: `${modelId} is not a Comfy Router model this app can run` };

  try {
    const response = await fetch(`${modelPath(modelId)}/requests/${encodeURIComponent(taskId)}`, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 202) return { success: false, error: "Comfy Router result is not ready yet" };
    if (response.status === 410) return { success: false, error: "Comfy Router result expired" };
    if (!response.ok) return { success: false, error: await routerErrorMessage(response) };

    return await outputOf(requestId, binding, response);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Comfy Router result failed" };
  }
}

/** A 200 from the Router, collected from the queue or answered directly, as the app's output. */
async function outputOf(requestId: string, binding: RouterBinding, response: Response): Promise<GenerationOutput> {
  const type = outputType(binding.output);
  const credits = response.headers.get("X-Comfy-Credits-Used");
  if (credits) console.log(`[API:${requestId}] Comfy Router credits used: ${credits}`);

  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
  // Binary partners (ElevenLabs, …) answer with the asset's own bytes.
  if (binding.result.binary || (contentType && !contentType.includes("json"))) {
    const buffer = await readBounded(response, MAX_MEDIA_SIZE);
    if (!buffer) return { success: false, error: `Media too large: over the ${MAX_MEDIA_SIZE / 1048576}MB limit` };
    const mime = binding.result.mime || (contentType && contentType !== "application/octet-stream" ? contentType : FALLBACK_MIME[type]);
    console.log(`[API:${requestId}] Comfy Router output ${mime}, ${(buffer.byteLength / 1048576).toFixed(2)}MB`);
    const data = `data:${mime};base64,${buffer.toString("base64")}`;
    return { success: true, outputs: [type === "3d" ? { type, data: "", url: data } : { type, data }] };
  }

  const result = (await response.json()) as Json;
  const found = readRouterResult(binding, result);
  const output = await materialise(requestId, found, type);
  return { success: true, outputs: [output] };
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
  if (comfyRunsSynchronously(input.model.id)) return runComfySynchronously(requestId, apiKey, input);
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
    return await fetchComfyMediaResult(requestId, apiKey, input.model.id, taskId);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Comfy Router generation failed" };
  }
}
