/**
 * fal.ai model schemas, fetched once and shared.
 *
 * The Model Search API (api.fal.ai/v1/models?endpoint_id=…&expand=openapi-3.0)
 * rate-limits bursts: about ten quick requests, then 429 with a Retry-After of
 * a few seconds. A catalog refresh pages through the same API, every node asks
 * it for its settings, and every generation asked it again for the input
 * mapping, so a new user who had just opened the model browser hit the limit
 * at once. A non-OK answer then counted as "this model has no settings" and
 * was cached for two days, which showed as a blank settings card (the
 * Discord report of 2026-10-09).
 *
 * Now one fetch per model serves both the node and the generate path, a 429
 * is retried after the delay it names, and a failure is an error with the
 * reason and the HTTP status, never an empty schema, and is not cached.
 */

const MODEL_SEARCH_URL = "https://api.fal.ai/v1/models";
const CACHE_TTL = 30 * 60 * 1000;
const MAX_RETRIES = 4;
/** When Retry-After is missing or unreadable; fal says 4 s today. */
const DEFAULT_RETRY_DELAY = 4000;
const MAX_RETRY_DELAY = 8000;
/** Repeated refusals double the shared hold, up to this: fal's window is longer than the 4 s it names. */
const MAX_COOLDOWN = 32000;

export class FalSchemaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FalSchemaError";
  }
}

/** The request body's schema (its `properties` are the settings and inputs) and the spec's components for `$ref`s. */
export interface FalInputSchema {
  schema: Record<string, unknown>;
  components?: Record<string, unknown>;
}

const cache = new Map<string, { value: FalInputSchema; timestamp: number }>();
const inFlight = new Map<string, Promise<FalInputSchema>>();

export function clearFalSchemaCache(): void {
  cache.clear();
  inFlight.clear();
  cooldownUntil = 0;
  lastCooldown = 0;
}

// Requests to the Model Search API go a few at a time, and a 429 from any of
// them holds every other back for the delay it names: a workflow of a dozen
// fal nodes opening at once would otherwise retry as one burst and be
// refused again.
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];
let cooldownUntil = 0;
let lastCooldown = 0;

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try { return await work(); } finally { active--; waiting.shift()?.(); }
}

/** Waits out a rate limit another request ran into. */
export async function awaitFalCooldown(signal?: AbortSignal): Promise<void> {
  const remaining = cooldownUntil - Date.now();
  if (remaining > 0) await sleep(remaining, signal);
}

/**
 * Records a 429 so every request to the API waits: the delay it names the
 * first time, doubling while refusals keep coming (fal's window outlasts
 * the 4 s it names), reset once a request gets through.
 */
export function noteFalRateLimit(response: Response): number {
  const now = Date.now();
  const named = retryAfterMs(response);
  const delay = Math.min(cooldownUntil > now - 1000 && lastCooldown ? Math.max(named, lastCooldown * 2) : named, MAX_COOLDOWN);
  lastCooldown = delay;
  cooldownUntil = Math.max(cooldownUntil, now + delay);
  return delay;
}

function noteFalSuccess(): void {
  lastCooldown = 0;
}

/** The delay a 429 asks for, in ms, within sensible bounds. */
export function retryAfterMs(response: Response): number {
  const header = response.headers?.get?.("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_DELAY;
  return Math.min(Math.max(seconds * 1000, 250), MAX_RETRY_DELAY);
}

/** Waits, unless the signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describeStatus(status: number): string {
  if (status === 429) return "fal.ai is rate limiting model lookups. Try again in a few seconds.";
  if (status === 401 || status === 403) return "fal.ai rejected the API key. Check it in Settings → Providers.";
  return `fal.ai answered ${status} when asked for the model's schema.`;
}

/** The POST request body's schema in a fal OpenAPI document, with `$ref` resolved. */
export function inputSchemaOf(spec: Record<string, unknown>): FalInputSchema | null {
  const components = (spec.components as Record<string, unknown> | undefined)?.schemas as Record<string, unknown> | undefined;
  for (const pathObj of Object.values((spec.paths as Record<string, unknown>) || {})) {
    const postOp = (pathObj as Record<string, unknown>)?.post as Record<string, unknown> | undefined;
    const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
    const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
    const schema = content?.["application/json"]?.schema as Record<string, unknown> | undefined;
    if (!schema) continue;
    if (typeof schema.$ref === "string") {
      const resolved = components?.[schema.$ref.replace("#/components/schemas/", "")] as Record<string, unknown> | undefined;
      if (resolved) return { schema: resolved, components };
    } else if (schema.properties) {
      return { schema, components };
    }
  }
  return null;
}

/**
 * The model's input schema from fal's Model Search API: cached for half an
 * hour, one request at a time per model, a 429 retried after the delay it
 * names. Throws FalSchemaError (with the HTTP status) when fal refuses or has
 * no schema, and the fetch's own error when the network or the signal fails.
 */
export function fetchFalInputSchema(modelId: string, apiKey: string | null, signal?: AbortSignal): Promise<FalInputSchema> {
  const cached = cache.get(modelId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return Promise.resolve(cached.value);
  const pending = inFlight.get(modelId);
  if (pending) return pending;
  const request = (async () => {
    try {
      const value = await requestSchema(modelId, apiKey, signal);
      cache.set(modelId, { value, timestamp: Date.now() });
      return value;
    } finally {
      inFlight.delete(modelId);
    }
  })();
  inFlight.set(modelId, request);
  return request;
}

async function requestSchema(modelId: string, apiKey: string | null, signal?: AbortSignal): Promise<FalInputSchema> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Key ${apiKey}`;
  const url = `${MODEL_SEARCH_URL}?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;
  for (let attempt = 0; ; attempt++) {
    await awaitFalCooldown(signal);
    const response = await withSlot(() => fetch(url, { headers, ...(signal && { signal }) }));
    if (response.status === 429) {
      noteFalRateLimit(response);
      if (attempt < MAX_RETRIES) continue;
    }
    if (!response.ok) throw new FalSchemaError(describeStatus(response.status), response.status);
    noteFalSuccess();
    const data = await response.json();
    const model = data?.models?.[0];
    if (!model) throw new FalSchemaError(`fal.ai has no model "${modelId}".`, 404);
    const input = model.openapi ? inputSchemaOf(model.openapi) : null;
    if (!input) throw new FalSchemaError(`fal.ai published no input schema for "${modelId}".`, 502);
    return input;
  }
}
