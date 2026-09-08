// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithOpenAI } from "../openai";
import type { GenerationInput } from "@/lib/providers/types";

const mockFetch = vi.fn();
const input = (overrides: Partial<GenerationInput> = {}): GenerationInput => ({
  model: { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", provider: "openai", capabilities: ["text-to-image", "image-to-image"], description: null },
  prompt: "A small red house", ...overrides,
});
const success = (extra = {}) => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }], ...extra }));
beforeEach(() => { mockFetch.mockReset(); vi.stubGlobal("fetch", mockFetch); });
afterEach(() => vi.unstubAllGlobals());

describe("OpenAI Images provider", () => {
  it.each(["sunburst", "flare"])("generates with %s and all supported parameters", async variant => {
    const request = input({ parameters: { size: "2048x1152", quality: "xhigh", output_format: "webp", background: "transparent", output_compression: 80, ignored: true } });
    request.model.id = `gpt-image-2.5-${variant}`;
    mockFetch.mockResolvedValue(success({ output_format: "webp", size: "2048x1152", usage: { input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 2000 } }));
    const result = await generateWithOpenAI("test", "test-key", request);
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ model: request.model.id, prompt: request.prompt, size: "2048x1152", quality: "xhigh", output_format: "webp", background: "transparent", output_compression: 80, n: 1 });
    expect(result.outputs?.[0].data).toBe("data:image/webp;base64,aW1hZ2U=");
    expect(result.generation?.usage).toEqual({ textInputTokens: 100, imageInputTokens: 0, imageOutputTokens: 2000 });
  });

  it("sends every reference in order with correct MIME types and edit settings", async () => {
    mockFetch.mockResolvedValue(success({ output_format: "jpeg" }));
    const result = await generateWithOpenAI("test", "key", input({
      images: ["data:image/png;base64,b25l", "data:image/webp;base64,dHdv"],
      parameters: { output_format: "jpeg", output_compression: 75, size: "1536x864", quality: "max" },
    }));
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
    const form: FormData = mockFetch.mock.calls[0][1].body;
    const files = form.getAll("image[]") as File[];
    expect(files.map(file => [file.name, file.type])).toEqual([["reference-1.png", "image/png"], ["reference-2.webp", "image/webp"]]);
    expect(await Promise.all(files.map(file => file.text()))).toEqual(["one", "two"]);
    expect(form.get("quality")).toBe("max");
    expect(form.get("size")).toBe("1536x864");
    expect(form.get("output_compression")).toBe("75");
    expect(result.outputs?.[0].data).toContain("data:image/jpeg;");
  });

  it("uses schema-connected images when the ordinary images list is empty", async () => {
    mockFetch.mockResolvedValue(success());
    await generateWithOpenAI("test", "key", input({ images: [], dynamicInputs: { image: ["data:image/png;base64,b25l"] } }));
    expect(mockFetch.mock.calls[0][0]).toContain("/edits");
  });

  it.each([
    { parameters: { size: "512x512" } },
    { parameters: { quality: "extreme" } },
    { parameters: { background: "transparent", output_format: "jpeg" } },
    { parameters: { n: 2 } },
    { images: Array(17).fill("data:image/png;base64,b25l") },
    { images: ["https://example.com/image.png"] },
    { images: ["data:text/html;base64,b25l"] },
    { images: ["data:image/png;base64,!!!"] },
    { prompt: "" },
  ])("rejects invalid input without an upstream request: %j", async overrides => {
    const result = await generateWithOpenAI("test", "key", input(overrides));
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("omits compression for PNG and keeps absent usage unknown", async () => {
    mockFetch.mockResolvedValue(success());
    const result = await generateWithOpenAI("test", "key", input({ parameters: { output_compression: 100 } }));
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty("output_compression");
    expect(result.generation?.usage).toBeUndefined();
  });

  it("preserves moderation status, code and message", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "moderation_blocked", type: "image_generation_user_error", message: "Please revise the prompt." } }), { status: 400 }));
    expect(await generateWithOpenAI("test", "key", input())).toMatchObject({ success: false, statusCode: 400, errorCode: "moderation_blocked", error: expect.stringContaining("revise the prompt") });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps quota errors distinct from transient rate limits", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "Check your billing details." } }), { status: 429, headers: { "Retry-After": "30" } }));
    const result = await generateWithOpenAI("test", "key", input());
    expect(result).toMatchObject({ statusCode: 429, errorCode: "insufficient_quota", retryAfter: "30" });
    expect(result.error).not.toContain("Rate limit");
  });

  it("propagates caller cancellation to the upstream fetch", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
      controller.abort();
    }));
    expect(await generateWithOpenAI("test", "key", input({ signal: controller.signal }))).toMatchObject({ statusCode: 499, errorCode: "cancelled" });
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not submit an already cancelled request", async () => {
    expect(await generateWithOpenAI("test", "key", input({ signal: AbortSignal.abort() }))).toMatchObject({ errorCode: "cancelled" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
