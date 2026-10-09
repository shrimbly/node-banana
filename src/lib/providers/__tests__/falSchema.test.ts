import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FalSchemaError, clearFalSchemaCache, fetchFalInputSchema, inputSchemaOf, retryAfterMs } from "../falSchema";

const mockFetch = vi.fn();

function searchResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  };
}

const spec = {
  paths: { "/fal-ai/nano-banana-lite": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NanoBananaLiteInput" } } } } } } },
  components: { schemas: { NanoBananaLiteInput: { properties: { prompt: { type: "string" }, num_images: { type: "integer", default: 1 } } } } },
};
const found = () => searchResponse(200, { models: [{ endpoint_id: "google/nano-banana-2-lite", openapi: spec }] });

describe("fetchFalInputSchema", () => {
  beforeEach(() => {
    clearFalSchemaCache();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the Model Search API once per model and serves the schema from its cache", async () => {
    mockFetch.mockResolvedValueOnce(found());
    const first = await fetchFalInputSchema("google/nano-banana-2-lite", "key");
    expect(first.schema).toBe(spec.components.schemas.NanoBananaLiteInput);
    expect(first.components).toBe(spec.components.schemas);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.fal.ai/v1/models?endpoint_id=google%2Fnano-banana-2-lite&expand=openapi-3.0",
      expect.objectContaining({ headers: { Authorization: "Key key" } }),
    );
    await fetchFalInputSchema("google/nano-banana-2-lite", "key");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shares one request between callers that ask while it is in flight", async () => {
    let release!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const a = fetchFalInputSchema("google/nano-banana-2-lite", null);
    const b = fetchFalInputSchema("google/nano-banana-2-lite", null);
    release(found());
    expect((await a).schema).toBe((await b).schema);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 after the delay it names, then succeeds", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce(searchResponse(429, { error: "Too Many Requests" }, { "retry-after": "4" })).mockResolvedValueOnce(found());
    const pending = fetchFalInputSchema("google/nano-banana-2-lite", null);
    await vi.advanceTimersByTimeAsync(3999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).schema.properties).toHaveProperty("prompt");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up on a rate limit that persists, with the status and a reason, and does not cache it", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(searchResponse(429, {}, { "retry-after": "1" }));
    const pending = fetchFalInputSchema("google/nano-banana-2-lite", null);
    const outcome = pending.then(() => "ok", (error) => error);
    // The hold doubles on each refusal: 1, 2, 4 and 8 s before the last attempt
    await vi.advanceTimersByTimeAsync(14999);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(FalSchemaError);
    expect(error).toMatchObject({ status: 429, message: expect.stringContaining("rate limiting") });
    expect(mockFetch).toHaveBeenCalledTimes(5);
    // Not remembered: the next lookup waits out the hold (16 s now) and asks again
    mockFetch.mockResolvedValueOnce(found());
    const again = fetchFalInputSchema("google/nano-banana-2-lite", null);
    await vi.advanceTimersByTimeAsync(16000);
    await expect(again).resolves.toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it("holds other lookups back while a rate limit is in force, instead of retrying as a burst", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce(searchResponse(429, {}, { "retry-after": "2" })).mockResolvedValue(found());
    const first = fetchFalInputSchema("google/nano-banana-2-lite", null);
    await vi.advanceTimersByTimeAsync(0);
    const second = fetchFalInputSchema("fal-ai/nano-banana-2", null);
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("reports a rejected key with its status", async () => {
    mockFetch.mockResolvedValueOnce(searchResponse(401, { error: { type: "authorization_error" } }));
    await expect(fetchFalInputSchema("google/nano-banana-2-lite", "bad")).rejects.toMatchObject({ status: 401, message: expect.stringContaining("rejected the API key") });
  });

  it("reports a model fal does not list, and one without a schema", async () => {
    mockFetch.mockResolvedValueOnce(searchResponse(200, { models: [] }));
    await expect(fetchFalInputSchema("fal-ai/nano-banana-2-lite", null)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('no model "fal-ai/nano-banana-2-lite"') });
    mockFetch.mockResolvedValueOnce(searchResponse(200, { models: [{ endpoint_id: "x", openapi: { paths: {} } }] }));
    await expect(fetchFalInputSchema("x", null)).rejects.toMatchObject({ status: 502 });
  });

  it("stops waiting when the caller's signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(searchResponse(429, {}, { "retry-after": "4" }));
    const pending = fetchFalInputSchema("google/nano-banana-2-lite", null, controller.signal);
    const outcome = pending.then(() => "ok", (error) => error);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("timed out"));
    expect(await outcome).toMatchObject({ message: "timed out" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("reads Retry-After within bounds", () => {
    const withHeader = (value?: string) => ({ headers: new Headers(value === undefined ? {} : { "retry-after": value }) }) as unknown as Response;
    expect(retryAfterMs(withHeader("4"))).toBe(4000);
    expect(retryAfterMs(withHeader("0"))).toBe(250);
    expect(retryAfterMs(withHeader("60"))).toBe(8000);
    expect(retryAfterMs(withHeader())).toBe(4000);
    expect(retryAfterMs(withHeader("soon"))).toBe(4000);
  });

  it("finds the request body's schema, inline or by $ref", () => {
    expect(inputSchemaOf(spec)?.schema).toBe(spec.components.schemas.NanoBananaLiteInput);
    const inline = { paths: { "/": { post: { requestBody: { content: { "application/json": { schema: { properties: { prompt: {} } } } } } } } } };
    expect(inputSchemaOf(inline)?.schema).toEqual({ properties: { prompt: {} } });
    expect(inputSchemaOf({ paths: { "/": { get: {} } } })).toBeNull();
  });
});
