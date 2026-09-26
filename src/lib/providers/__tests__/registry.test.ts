import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listModels, PROVIDER_TIMEOUT_MS, type ListModelsResult, type ListModelsSuccess } from "../registry";
import { getModelSchema } from "../schema";
import { invalidateCache } from "../cache";
import { COMFY_ROUTER_MODELS } from "../comfyRouter";

const mockFetch = vi.fn();

function expectOk(result: ListModelsResult): ListModelsSuccess {
  if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.error}`);
  return result;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

describe("listModels", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResponse({}, false, 404));
    vi.stubGlobal("fetch", mockFetch);
    invalidateCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("static providers", () => {
    it("always lists Gemini, without a key and without a network call", async () => {
      const result = expectOk(await listModels({}, {}));

      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.every((m) => m.provider === "gemini")).toBe(true);
      expect(result.models.map((m) => m.id)).toEqual(
        expect.arrayContaining(["nano-banana", "nano-banana-pro", "veo-3.1/text-to-video"])
      );
      expect(result.providers.gemini).toEqual({ success: true, count: result.models.length, cached: true });
      expect(result.availableProviders).toEqual(["gemini"]);
      expect(result.cached).toBe(true);
      expect(result.errors).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("lists the Kie catalog with a key", async () => {
      const result = expectOk(await listModels({ provider: "kie" }, { kie: "kie-key" }));
      expect(result.models.every((m) => m.provider === "kie")).toBe(true);
      expect(result.models.map((m) => m.id)).toEqual(expect.arrayContaining(["z-image", "veo3/text-to-video"]));
      expect(result.providers).toEqual({ kie: { success: true, count: result.models.length, cached: true } });
    });

    it("lists the OpenAI catalog with a key", async () => {
      const result = expectOk(await listModels({ provider: "openai" }, { openai: "oai" }));
      expect(result.models.map((m) => m.id)).toEqual(expect.arrayContaining(["gpt-image-1", "gpt-image-2"]));
      expect(result.models.every((m) => m.provider === "openai")).toBe(true);
    });

    it("lists the Comfy Router catalog with a key", async () => {
      const result = expectOk(await listModels({ provider: "comfy" }, { comfy: "comfyui-key" }));
      expect(result.models).toHaveLength(COMFY_ROUTER_MODELS.length);
      expect(result.availableProviders).toEqual(["gemini", "comfy"]);
    });

    it("aggregates every keyed static provider, sorted by provider then name", async () => {
      const result = expectOk(await listModels({}, { kie: "k", openai: "o", comfy: "c" }));

      expect(Object.keys(result.providers)).toEqual(["gemini", "kie", "openai", "comfy"]);
      expect(result.availableProviders).toEqual(["gemini", "kie", "openai", "comfy"]);
      const total = Object.values(result.providers).reduce((sum, p) => sum + p.count, 0);
      expect(result.models).toHaveLength(total);

      const sorted = [...result.models].sort((a, b) =>
        a.provider !== b.provider ? a.provider.localeCompare(b.provider) : a.name.localeCompare(b.name)
      );
      expect(result.models.map((m) => `${m.provider}:${m.id}`)).toEqual(sorted.map((m) => `${m.provider}:${m.id}`));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("ignores a Gemini key for listing (Gemini is listed either way)", async () => {
      const result = expectOk(await listModels({}, { gemini: "gem" }));
      expect(result.availableProviders).toEqual(["gemini"]);
    });
  });

  describe("missing keys", () => {
    it.each([
      ["kie", "Kie API key required. Add KIE_API_KEY to .env.local or configure in Settings."],
      ["openai", "OpenAI API key required. Add OPENAI_API_KEY to .env.local or configure in Settings."],
      ["comfy", "Comfy API key required. Add COMFY_API_KEY to .env.local or configure in Settings."],
      ["wavespeed", "WaveSpeed API key required. Add WAVESPEED_API_KEY to .env.local or configure in Settings."],
    ])("provider=%s without a key fails with 400", async (provider, error) => {
      expect(await listModels({ provider }, {})).toEqual({ ok: false, error, status: 400 });
    });

    it.each(["replicate", "fal", "anthropic", "nonsense"])(
      "provider=%s with nothing to list fails with 400 'No providers available'",
      async (provider) => {
        const result = await listModels({ provider }, {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.status).toBe(400);
          expect(result.error).toMatch(/^No providers available\./);
        }
        expect(mockFetch).not.toHaveBeenCalled();
      }
    );
  });

  describe("filters", () => {
    it("keeps only models with one of the requested capabilities", async () => {
      const result = expectOk(
        await listModels({ capabilities: ["text-to-video"] }, { kie: "k", openai: "o", comfy: "c" })
      );
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.every((m) => m.capabilities.includes("text-to-video"))).toBe(true);
      // Provider counts are taken before the capability filter
      expect(result.providers.openai.count).toBeGreaterThan(0);
      expect(result.models.some((m) => m.provider === "openai")).toBe(false);
    });

    it("matches a search against name, description and id", async () => {
      const result = expectOk(await listModels({ provider: "kie", search: "SEEDANCE" }, { kie: "k" }));
      expect(result.models.length).toBeGreaterThan(0);
      for (const model of result.models) {
        const haystack = `${model.name} ${model.description ?? ""} ${model.id}`.toLowerCase();
        expect(haystack).toContain("seedance");
      }
      expect(result.providers.kie.count).toBe(result.models.length);
    });

    it("combines search and capabilities", async () => {
      const result = expectOk(
        await listModels({ provider: "gemini", search: "veo", capabilities: ["image-to-video"] }, {})
      );
      expect(result.models.map((m) => m.id).sort()).toEqual(["veo-3.1-fast/image-to-video", "veo-3.1/image-to-video"]);
    });

    it("treats an empty search and empty capability list as no filter", async () => {
      const all = expectOk(await listModels({}, {}));
      const blank = expectOk(await listModels({ search: "", capabilities: [] }, {}));
      expect(blank.models).toEqual(all.models);
    });
  });

  describe("fetched providers (network mocked)", () => {
    it("lists Replicate models and reports them as fresh, then cached", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          results: [{ owner: "stability-ai", name: "sdxl", description: "SDXL image model", visibility: "public", run_count: 1 }],
          next: null,
          previous: null,
        })
      );

      const first = expectOk(await listModels({ provider: "replicate" }, { replicate: "rep" }));
      expect(first.models.map((m) => m.id)).toEqual(["stability-ai/sdxl"]);
      expect(first.providers.replicate).toEqual({ success: true, count: 1, cached: false });
      expect(first.cached).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.replicate.com/v1/models",
        expect.objectContaining({ headers: { Authorization: "Bearer rep" }, signal: expect.any(AbortSignal) })
      );

      const second = expectOk(await listModels({ provider: "replicate" }, { replicate: "rep" }));
      expect(second.providers.replicate.cached).toBe(true);
      expect(second.cached).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("lists fal.ai models, keeping only relevant categories", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          models: [
            { endpoint_id: "fal-ai/flux", metadata: { display_name: "Flux", category: "text-to-image", description: "" } },
            { endpoint_id: "fal-ai/llm", metadata: { display_name: "LLM", category: "llm", description: "" } },
          ],
          has_more: false,
          next_cursor: null,
        })
      );
      const result = expectOk(await listModels({ provider: "fal" }, { fal: "fal" }));
      expect(result.models.map((m) => m.id)).toEqual(["fal-ai/flux"]);
      expect(result.models[0].capabilities).toEqual(["text-to-image"]);
    });

    it("lists WaveSpeed models and hands their schemas to getModelSchema", async () => {
      const modelId = `wavespeed-ai/registry-test-${Date.now()}`;
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              model_id: modelId,
              name: "Registry Test",
              api_schema: {
                api_schemas: [
                  {
                    request_schema: {
                      properties: {
                        prompt: { type: "string" },
                        seed: { type: "integer", default: -1 },
                      },
                      required: ["prompt"],
                    },
                  },
                ],
              },
            },
          ],
        })
      );

      const result = expectOk(await listModels({ provider: "wavespeed" }, { wavespeed: "ws" }));
      expect(result.models.map((m) => m.id)).toEqual([modelId]);

      const schema = await getModelSchema("wavespeed", modelId, {});
      expect(schema).toMatchObject({
        ok: true,
        parameters: [expect.objectContaining({ name: "seed", type: "integer" })],
        inputs: [expect.objectContaining({ name: "prompt", type: "text", required: true })],
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("reports a failing provider without failing the listing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401));
      const result = expectOk(await listModels({}, { replicate: "bad" }));
      expect(result.providers.replicate).toEqual({ success: false, count: 0, error: "Replicate API error: 401" });
      expect(result.errors).toEqual(["replicate: Replicate API error: 401"]);
      expect(result.providers.gemini.success).toBe(true);
    });

    it("fails with 500 when nothing came back and every fetched provider failed", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 503));
      expect(await listModels({ provider: "fal" }, { fal: "fal" })).toEqual({
        ok: false,
        error: "All providers failed: fal: fal.ai API error: 503",
        status: 500,
      });
    });

    it("gives up on a provider that outlives its deadline and aborts its request", async () => {
      let seenSignal: AbortSignal | undefined;
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        seenSignal = init.signal ?? undefined;
        return new Promise(() => {}); // never settles
      });

      const result = expectOk(await listModels({}, { fal: "fal" }, { providerTimeoutMs: 20 }));
      expect(result.providers.fal).toEqual({ success: false, count: 0, error: "timed out after 0.02s" });
      expect(result.errors).toEqual(["fal: timed out after 0.02s"]);
      expect(result.providers.gemini.success).toBe(true);
      expect(seenSignal?.aborted).toBe(true);
    });

    it("defaults the per-provider deadline to 20 seconds", () => {
      expect(PROVIDER_TIMEOUT_MS).toBe(20_000);
    });

    it("never looks up a malformed Replicate id directly", async () => {
      // Catalogue page, then both search attempts come back empty
      mockFetch.mockResolvedValueOnce(jsonResponse({ results: [], next: null, previous: null }));

      const result = expectOk(
        await listModels({ provider: "replicate", search: "owner/name?x=1" }, { replicate: "rep" })
      );
      expect(result.models).toEqual([]);
      expect(fetchedUrls().some((url) => url.startsWith("https://api.replicate.com/v1/models/"))).toBe(false);
    });

    it("looks up a well-formed Replicate id directly when the listing lacks it", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "https://api.replicate.com/v1/models") {
          return Promise.resolve(jsonResponse({ results: [], next: null, previous: null }));
        }
        if (url === "https://api.replicate.com/v1/models/topazlabs/video-upscale") {
          return Promise.resolve(
            jsonResponse({ owner: "topazlabs", name: "video-upscale", description: "Upscale video footage" })
          );
        }
        return Promise.resolve(jsonResponse({}, false, 404));
      });

      const result = expectOk(
        await listModels({ provider: "replicate", search: "topazlabs/video-upscale" }, { replicate: "rep" })
      );
      expect(result.models.map((m) => m.id)).toEqual(["topazlabs/video-upscale"]);
    });
  });
});

describe("listModels: a search that matches nothing", () => {
  it("is an empty list, not a failure, when only static providers were searched", async () => {
    const result = await listModels({ provider: "gemini", search: "no-such-model-zzz" }, {});
    expect(result).toMatchObject({ ok: true, models: [] });
  });
});
