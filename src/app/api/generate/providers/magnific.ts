/**
 * Magnific provider.
 *
 * Every Magnific model is one POST under api.magnific.com/v1/ai that
 * answers with a task id, and a GET that reports the task: `status`
 * (CREATED, IN_PROGRESS, COMPLETED, FAILED) and, once done, `generated`
 * (URLs that expire within the hour, so the output is downloaded at once).
 * Which fields a model takes and how its media go in come from the binding
 * (src/lib/providers/magnific). This module does the I/O around that:
 * encoding the node's media, the submit, one look at the task, and turning
 * the result into the app's image, video or audio output.
 *
 * Magnific has no idempotency key, so a submit is never repeated after an
 * answer that leaves its outcome unknown (a 5xx, a dropped connection): a
 * second request could be a second, paid run. Only a rate limit, which
 * means the request was not taken, is tried again.
 */
import type { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { MAGNIFIC_API_BASE, magnificHeaders } from "@/lib/providers/magnific/api";
import {
  buildMagnificBody,
  magnificBinding,
  missingMagnificInputs,
  type MagnificBinding,
  type MagnificRequestInput,
} from "@/lib/providers/magnific/bindings";
import { chooseEncoding, encodeMagnificMedia } from "@/lib/providers/magnific/media";
import type { ComfyMediaValue } from "@/lib/providers/comfyRouter/template";
import { validateMediaUrl } from "@/utils/urlValidation";

const MAX_MEDIA_SIZE = 500 * 1024 * 1024;
const INLINE_LIMIT = 20 * 1024 * 1024;
const SUBMIT_TIMEOUT_MS = 90_000;
const FETCH_TIMEOUT_MS = 120_000;
const RATE_LIMIT_WAIT_MS = 5_000;
/** A task can read COMPLETED a moment before its URLs are there. */
const EMPTY_COMPLETION_LOOKS = 3;
const EMPTY_COMPLETION_WAIT_MS = 1_500;

export const MAGNIFIC_HEADER = "X-Magnific-Key";

/** The key for a server request: the header first, then the env variable. */
export function resolveMagnificKey(headerValue: string | null): string | null {
  return headerValue || process.env.MAGNIFIC_API_KEY || null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ inputs */

function listOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string" && item.length > 0);
}

/**
 * The node's media per handle. Nodes send each connected value under its
 * handle's name, and also collect every image into `images`. When the first
 * image handle did not arrive by name (a node that has not loaded its
 * schema yet) it takes `images`, minus anything that arrived under another
 * handle, so a mask or a last frame is never also sent as the reference.
 */
function mediaByHandle(binding: MagnificBinding, input: GenerationInput): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const handle of binding.inputs) {
    if (handle.type === "text") continue;
    const unique = [...new Set(listOf(input.dynamicInputs?.[handle.name]))];
    if (unique.length) out[handle.name] = unique.slice(0, handle.max ?? 1);
  }
  const first = binding.inputs.find((handle) => handle.type === "image");
  if (first && !out[first.name] && input.images?.length) {
    const claimed = new Set(Object.values(out).flat());
    const rest = [...new Set(input.images)].filter((value) => !claimed.has(value));
    if (rest.length) out[first.name] = rest.slice(0, first.max ?? 1);
  }
  return out;
}

/** Everything the request template needs, with media encoded (and uploaded) per handle. */
export async function prepareMagnificInput(
  binding: MagnificBinding,
  input: GenerationInput,
  apiKey: string
): Promise<MagnificRequestInput> {
  const raw = mediaByHandle(binding, input);
  const media: Record<string, ComfyMediaValue[]> = {};
  const encodings: MagnificRequestInput["encodings"] = {};
  for (const handle of binding.inputs) {
    const values = raw[handle.name];
    if (!values?.length) continue;
    const encoding = chooseEncoding(handle, values);
    encodings[handle.name] = encoding;
    media[handle.name] = await Promise.all(
      values.map((value) => encodeMagnificMedia(value, encoding, apiKey, { needsMime: handle.needsMime }))
    );
  }
  return {
    prompt: input.prompt || listOf(input.dynamicInputs?.prompt)[0] || "",
    negativePrompt: listOf(input.dynamicInputs?.negative_prompt)[0],
    parameters: input.parameters,
    media,
    encodings,
  };
}

/* ------------------------------------------------------------------ transport */

interface MagnificProblem {
  message?: unknown;
  detail?: unknown;
  title?: unknown;
  error?: unknown;
  invalid_params?: Array<{ name?: string; field?: string; reason?: string }>;
}

/** A Magnific error answer as text: the field it refused and why, or its message. */
async function magnificErrorMessage(response: Response): Promise<string> {
  let body: MagnificProblem | null = null;
  try {
    body = (await response.json()) as MagnificProblem;
  } catch {
    body = null;
  }
  const refused = body?.invalid_params?.find((param) => param?.reason);
  if (refused) {
    const field = refused.field ?? refused.name;
    return field ? `${field}: ${refused.reason}` : String(refused.reason);
  }
  const nested = body?.error && typeof body.error === "object" ? (body.error as { message?: unknown }).message : body?.error;
  for (const candidate of [body?.message, body?.detail, nested, body?.title]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (response.status === 401) return "Magnific API key was rejected";
  if (response.status === 402) return "Magnific account has no credits left";
  if (response.status === 429) return "Magnific rate limit reached, try again shortly";
  return `Magnific error ${response.status}`;
}

function taskUrl(binding: MagnificBinding, taskId: string): string {
  return `${MAGNIFIC_API_BASE}/${binding.poll}/${encodeURIComponent(taskId)}`;
}

/** Start a run. Returns Magnific's task id, which the poll route carries. */
export async function submitMagnificTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ taskId: string }> {
  const binding = magnificBinding(input.model.id);
  if (!binding) throw new Error(`${input.model.id} is not a Magnific model this app can run`);

  const prepared = await prepareMagnificInput(binding, input, apiKey);
  const missing = missingMagnificInputs(binding, prepared);
  if (missing) throw new Error(missing);
  const body = JSON.stringify(buildMagnificBody(binding, prepared));
  console.log(`[API:${requestId}] Magnific submit ${binding.id}`);

  const send = () =>
    fetch(`${MAGNIFIC_API_BASE}/${binding.id}`, {
      method: "POST",
      headers: magnificHeaders(apiKey, true),
      body,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });

  let response: Response;
  try {
    response = await send();
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      await wait(RATE_LIMIT_WAIT_MS);
      response = await send();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${binding.name}: Magnific did not answer (${reason}). The run may have started; check your Magnific account before running it again.`);
  }

  if (!response.ok) {
    const message = await magnificErrorMessage(response);
    if (response.status >= 500) {
      throw new Error(`${binding.name}: ${message}. The run may have started; check your Magnific account before running it again.`);
    }
    throw new Error(`${binding.name}: ${message}`);
  }

  const submitted = (await response.json()) as { data?: { task_id?: string }; task_id?: string };
  const taskId = submitted.data?.task_id ?? submitted.task_id;
  if (!taskId) throw new Error(`${binding.name}: Magnific returned no task id`);
  console.log(`[API:${requestId}] Magnific started ${binding.id} as ${taskId}`);
  return { taskId: String(taskId) };
}

/** `Retry-After` in seconds, as milliseconds; undefined when absent or unusable. */
function retryAfterMs(header: string | null): number | undefined {
  const seconds = header ? Number(header.trim()) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

export type MagnificTaskStatus =
  | { status: "processing"; retryAfterMs?: number }
  /** `statusCode`: Magnific's own answer, when it refused the check rather than reported the run. */
  | { status: "failed"; error: string; statusCode?: number }
  | { status: "completed"; url: string };

interface MagnificTask {
  status?: string;
  generated?: unknown;
  error?: unknown;
  message?: unknown;
  reason?: unknown;
  has_nsfw?: unknown;
}

/** The task object, which most endpoints wrap in `data` and a few do not. */
function taskOf(json: unknown): MagnificTask {
  const root = (json ?? {}) as { data?: unknown };
  return (root.data && typeof root.data === "object" ? root.data : root) as MagnificTask;
}

function reasonOf(task: MagnificTask): string | undefined {
  for (const candidate of [task.error, task.message, task.reason]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function firstUrl(task: MagnificTask): string | undefined {
  const generated = Array.isArray(task.generated) ? task.generated : [];
  return generated.find((item): item is string => typeof item === "string" && /^https?:\/\//.test(item));
}

/** One look at the task: is the run still going, done, or failed? */
export async function checkMagnificTaskOnce(
  requestId: string,
  apiKey: string,
  modelId: string,
  taskId: string
): Promise<MagnificTaskStatus> {
  const binding = magnificBinding(modelId);
  if (!binding) return { status: "failed", error: `${modelId} is not a Magnific model this app can run`, statusCode: 400 };

  for (let look = 1; ; look++) {
    const response = await fetch(taskUrl(binding, taskId), {
      headers: magnificHeaders(apiKey),
      signal: AbortSignal.timeout(30_000),
    });

    // A busy or briefly unavailable API is not a failed run: keep polling.
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      console.log(`[API:${requestId}] Magnific ${taskId}: status check ${response.status}, will retry`);
      return { status: "processing", retryAfterMs: retryAfterMs(response.headers.get("Retry-After")) };
    }
    if (!response.ok) return { status: "failed", error: await magnificErrorMessage(response), statusCode: response.status };

    const task = taskOf(await response.json());
    const status = String(task.status ?? "").toUpperCase();
    if (status === "FAILED" || status === "ERROR") {
      return { status: "failed", error: reasonOf(task) ?? "Magnific failed the run and gave no reason" };
    }
    if (status !== "COMPLETED") {
      console.log(`[API:${requestId}] Magnific ${taskId}: ${status || "?"}`);
      return { status: "processing" };
    }

    const url = firstUrl(task);
    if (url) return { status: "completed", url };
    if (look >= EMPTY_COMPLETION_LOOKS) {
      const withheld = Array.isArray(task.has_nsfw) && task.has_nsfw.some(Boolean) ? " (flagged NSFW, so the output may have been withheld)" : "";
      return { status: "failed", error: `${reasonOf(task) ?? "Magnific finished the run without an output"}${withheld}` };
    }
    await wait(EMPTY_COMPLETION_WAIT_MS);
  }
}

/* ------------------------------------------------------------------ output */

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

const FALLBACK_MIME = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" } as const;

/** A network failure or a timeout, which a later attempt may get past. */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

/**
 * Download a finished task's output. Images are always inlined; video and
 * audio are inlined up to 20MB and returned as their URL above that. A
 * failure's `statusCode` is the one to answer the client with: 422 for an
 * output that cannot be used, none for a network failure, which may pass.
 */
export async function fetchMagnificMediaResult(requestId: string, modelId: string, url: string): Promise<GenerationOutput> {
  const binding = magnificBinding(modelId);
  if (!binding) return { success: false, statusCode: 400, error: `${modelId} is not a Magnific model this app can run` };
  const type = binding.output;

  try {
    const check = validateMediaUrl(url);
    if (!check.valid) return { success: false, statusCode: 422, error: `Invalid media URL: ${check.error}` };

    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // The task is done and its URL stands for a while: a later look can fetch it.
      return { success: false, statusCode: response.status >= 500 ? 503 : 422, error: `${binding.name}: could not download the output (${response.status})` };
    }
    const declared = response.headers.get("content-type")?.split(";")[0] ?? "";
    const contentType = declared.startsWith(`${type}/`) ? declared : FALLBACK_MIME[type];

    const buffer = await readBounded(response, type === "image" ? MAX_MEDIA_SIZE : INLINE_LIMIT);
    if (!buffer) {
      if (type === "image") return { success: false, statusCode: 422, error: `Media too large: over the ${MAX_MEDIA_SIZE / 1048576}MB limit` };
      console.log(`[API:${requestId}] Magnific ${type} above ${INLINE_LIMIT / 1048576}MB, returning its URL`);
      return { success: true, outputs: [{ type, data: "", url }] };
    }
    console.log(`[API:${requestId}] Magnific output ${contentType}, ${(buffer.byteLength / 1048576).toFixed(2)}MB`);
    return { success: true, outputs: [{ type, data: `data:${contentType};base64,${buffer.toString("base64")}`, url }] };
  } catch (error) {
    return {
      success: false,
      ...(isNetworkError(error) ? {} : { statusCode: 422 }),
      error: error instanceof Error ? error.message : "Magnific result failed",
    };
  }
}

/**
 * Submit and wait, for callers that cannot poll (tests, scripts). The app's
 * generate route returns the polling envelope instead.
 */
export async function generateWithMagnific(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput,
  options: { maxWaitMs?: number } = {}
): Promise<GenerationOutput> {
  if (!apiKey) return { success: false, error: "Magnific API key not configured" };
  try {
    const { taskId } = await submitMagnificTask(requestId, apiKey, input);
    const deadline = Date.now() + (options.maxWaitMs ?? 5 * 60_000);
    let delay = 2000;
    while (Date.now() < deadline) {
      await wait(delay);
      const status = await checkMagnificTaskOnce(requestId, apiKey, input.model.id, taskId);
      if (status.status === "failed") return { success: false, error: status.error };
      if (status.status === "completed") return await fetchMagnificMediaResult(requestId, input.model.id, status.url);
      delay = Math.min(status.retryAfterMs ?? delay * 1.5, 10_000);
    }
    return { success: false, error: `Magnific was still running task ${taskId} when the wait ended` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Magnific generation failed" };
  }
}
