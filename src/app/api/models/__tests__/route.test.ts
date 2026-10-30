import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { CATALOG_DIR_ENV, resetCatalog } from "@/lib/providers/catalog";
import { REPLICATE_COLLECTIONS } from "@/lib/providers/registry";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const mockFetch = vi.fn();
let catalogDir: string;

function createMockGetRequest(params: Record<string, string> = {}, headers?: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/models");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return { nextUrl: url, headers: new Headers(headers) } as unknown as NextRequest;
}

type ReplicateFixture = { owner: string; name: string; description?: string | null; run_count?: number };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

/** Replicate's collections: the named ones hold these models, every other one is empty. */
function replicateCollection(url: string, collections: Record<string, ReplicateFixture[]>) {
  const match = /\/v1\/collections\/([^/?]+)$/.exec(url);
  if (!match) return null;
  const models = (collections[match[1]] ?? []).map((m) => ({ visibility: "public", run_count: 1000, description: null, ...m }));
  return jsonResponse({ models });
}

function falResponse(models: Array<{ id: string; name: string; category: string; description?: string }>, hasMore = false, cursor: string | null = null) {
  return jsonResponse({
    models: models.map((m) => ({
      endpoint_id: m.id,
      metadata: { display_name: m.name, category: m.category, description: m.description || "", status: "active", tags: [], thumbnail_url: "" },
    })),
    has_more: hasMore,
    next_cursor: cursor,
  });
}

/** Routes fetches by host: Replicate collections and one fal.ai page. */
function providers({ replicate = {}, fal = [] as Array<{ id: string; name: string; category: string; description?: string }> } = {}) {
  return (url: string) => {
    if (url.includes("replicate.com")) {
      const collection = replicateCollection(url, replicate);
      return Promise.resolve(collection ?? jsonResponse({}, false, 404));
    }
    if (url.includes("fal.ai")) return Promise.resolve(falResponse(fal));
    return Promise.reject(new Error(`Unknown URL ${url}`));
  };
}

async function get(params: Record<string, string> = {}, headers?: Record<string, string>) {
  const response = await GET(createMockGetRequest(params, headers));
  return { response, data: await response.json() };
}

describe("/api/models route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    delete process.env.REPLICATE_API_KEY;
    delete process.env.FAL_API_KEY;
    delete process.env.WAVESPEED_API_KEY;
    global.fetch = mockFetch;
    catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-route-"));
    process.env[CATALOG_DIR_ENV] = catalogDir;
    resetCatalog();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetCatalog();
    process.env = originalEnv;
    global.fetch = originalFetch;
    fs.rmSync(catalogDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("basic functionality", () => {
    it("GET: should return models from fal.ai when no Replicate key", async () => {
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(providers({ fal: [{ id: "fal-ai/flux", name: "Flux", category: "text-to-image" }, { id: "fal-ai/flux-pro", name: "Flux Pro", category: "text-to-image" }] }));

      const { response, data } = await get();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // 2 fal models + 11 gemini models (always included)
      expect(data.models).toHaveLength(13);
      expect(data.providers.fal).toMatchObject({ success: true, count: 2, cached: false, stale: false, refreshing: false });
      expect(data.providers.fal.fetchedAt).toEqual(expect.any(Number));
      expect(data.providers.gemini).toEqual({ success: true, count: 11, cached: true });
    });

    it("GET: should return models from both providers when both keys present", async () => {
      process.env.REPLICATE_API_KEY = "test-replicate-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({
          replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl", description: "SDXL model" }] },
          fal: [{ id: "fal-ai/flux", name: "Flux", category: "text-to-image" }],
        })
      );

      const { response, data } = await get();
      expect(response.status).toBe(200);
      expect(data.models).toHaveLength(13);
      expect(data.providers.replicate.success).toBe(true);
      expect(data.providers.fal.success).toBe(true);
      expect(data.providers.gemini.success).toBe(true);
    });

    it("GET: should return 400 when provider filter is replicate but no key", async () => {
      const { response, data } = await get({ provider: "replicate" });
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("No providers available");
    });

    it("GET: should filter by provider query param", async () => {
      process.env.REPLICATE_API_KEY = "test-replicate-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(providers({ replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }] } }));

      const { response, data } = await get({ provider: "replicate" });
      expect(response.status).toBe(200);
      expect(data.models).toHaveLength(1);
      expect(data.models[0].provider).toBe("replicate");
      expect(data.providers.fal).toBeUndefined();
      expect(mockFetch.mock.calls.every((c) => String(c[0]).includes("replicate.com"))).toBe(true);
    });

    it("GET: should filter by capabilities query param", async () => {
      process.env.REPLICATE_API_KEY = "test-replicate-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({
          replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }], "text-to-video": [{ owner: "luma", name: "ray" }] },
          fal: [{ id: "fal-ai/flux", name: "Flux", category: "text-to-image" }, { id: "fal-ai/luma-ray", name: "Luma Ray", category: "text-to-video" }],
        })
      );

      const { data } = await get({ capabilities: "text-to-video" });
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.models.every((m: { capabilities: string[] }) => m.capabilities.includes("text-to-video"))).toBe(true);
      expect(data.models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(["luma/ray", "fal-ai/luma-ray"]));
    });

    it("GET: should search the stored lists by query param", async () => {
      process.env.REPLICATE_API_KEY = "test-replicate-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({
          replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }, { owner: "black-forest", name: "flux" }] },
          fal: [{ id: "fal-ai/flux", name: "Flux", category: "text-to-image" }, { id: "fal-ai/kling", name: "Kling", category: "text-to-video" }],
        })
      );

      const { data } = await get({ search: "flux" });
      expect(data.models.map((m: { id: string }) => m.id).sort()).toEqual(["black-forest/flux", "fal-ai/flux"]);
      // fal.ai was listed once, not searched server-side
      expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("fal.ai"))).toHaveLength(1);
      expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("q=flux"))).toBe(false);
    });

    it("GET: should use API key from header over env var", async () => {
      process.env.REPLICATE_API_KEY = "env-key";
      mockFetch.mockImplementation(providers({ replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }] } }));

      const { response } = await get({ provider: "replicate" }, { "X-Replicate-Key": "header-key" });
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("api.replicate.com"), expect.objectContaining({ headers: { Authorization: "Bearer header-key" } }));
    });
  });

  describe("catalog behaviour", () => {
    it("GET: serves a second request from the catalog without fetching, with cached=true", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({ replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }] }, fal: [{ id: "fal-ai/flux", name: "Flux", category: "text-to-image" }] })
      );
      const first = await get();
      expect(first.data.cached).toBe(false);
      mockFetch.mockClear();

      const { data } = await get();
      expect(data.cached).toBe(true);
      expect(data.providers.replicate.cached).toBe(true);
      expect(data.providers.fal.cached).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("GET: refresh=true waits for a fresh fetch", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      mockFetch.mockImplementation(providers({ replicate: { "text-to-image": [{ owner: "stability-ai", name: "old-sdxl" }] } }));
      await get({ provider: "replicate" });
      mockFetch.mockImplementation(providers({ replicate: { "text-to-image": [{ owner: "stability-ai", name: "new-sdxl" }] } }));

      const { data } = await get({ provider: "replicate", refresh: "true" });
      expect(data.cached).toBe(false);
      expect(data.models.map((m: { id: string }) => m.id)).toEqual(["stability-ai/new-sdxl"]);
    });

    it("GET: keeps the stored list and reports the error when a refresh fails", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      mockFetch.mockImplementation(providers({ replicate: { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }] } }));
      await get({ provider: "replicate" });
      mockFetch.mockResolvedValue(jsonResponse({}, false, 401));

      const { response, data } = await get({ provider: "replicate", refresh: "true" });
      expect(response.status).toBe(200);
      expect(data.models.map((m: { id: string }) => m.id)).toEqual(["stability-ai/sdxl"]);
      expect(data.providers.replicate).toMatchObject({ success: true, count: 1, stale: true, error: "Replicate API error: 401" });
    });
  });

  describe("error handling", () => {
    it("GET: should handle partial provider failures gracefully", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("replicate.com")) return Promise.resolve(jsonResponse({}, false, 401));
        if (url.includes("fal.ai")) return Promise.resolve(falResponse([{ id: "fal-ai/flux", name: "Flux", category: "text-to-image" }]));
        return Promise.reject(new Error("Unknown URL"));
      });

      const { response, data } = await get();
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.models).toHaveLength(12);
      expect(data.providers.replicate).toEqual({ success: false, count: 0, error: "Replicate API error: 401" });
      expect(data.providers.fal.success).toBe(true);
      expect(data.errors).toContain("replicate: Replicate API error: 401");
    });

    it("GET: should return 500 when all requested providers fail", async () => {
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation((url: string) => (url.includes("fal.ai") ? Promise.resolve(jsonResponse({}, false, 503)) : Promise.reject(new Error("Unknown URL"))));

      const { response, data } = await get({ provider: "fal" });
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("All providers failed");
    });
  });

  describe("fetching", () => {
    it("GET: asks Replicate for every curated collection at once and merges them", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      mockFetch.mockImplementation(
        providers({
          replicate: {
            "text-to-image": [{ owner: "google", name: "nano-banana", run_count: 5 }],
            "image-editing": [{ owner: "google", name: "nano-banana", run_count: 5 }, { owner: "fofr", name: "color-matcher", run_count: 1 }],
          },
        })
      );

      const { data } = await get({ provider: "replicate" });
      expect(data.providers.replicate.count).toBe(2);
      const banana = data.models.find((m: { id: string }) => m.id === "google/nano-banana");
      expect(banana.capabilities).toEqual(["text-to-image", "image-to-image"]);
      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls).toHaveLength(REPLICATE_COLLECTIONS.length);
      expect(urls.every((u) => u.includes("/v1/collections/"))).toBe(true);
    });

    it("GET: should paginate through every fal.ai page", async () => {
      process.env.FAL_API_KEY = "test-fal-key";
      let falPageCount = 0;
      mockFetch.mockImplementation((url: string) => {
        if (!url.includes("fal.ai")) return Promise.reject(new Error("Unknown URL"));
        falPageCount++;
        const last = falPageCount === 17;
        return Promise.resolve(falResponse([{ id: `fal-ai/model${falPageCount}`, name: `Model ${falPageCount}`, category: "text-to-image" }], !last, last ? null : `cursor${falPageCount}`));
      });

      const { data } = await get();
      expect(data.providers.fal.count).toBe(17);
      expect(falPageCount).toBe(17);
    });
  });

  describe("capabilities from collections", () => {
    it("GET: Wan variants are told apart by name, and processing collections land under video", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      mockFetch.mockImplementation(
        providers({
          replicate: {
            "wan-video": [{ owner: "wavespeedai", name: "wan-2.1-i2v-480p" }, { owner: "wavespeedai", name: "wan-2.1-t2v-480p" }],
            "ai-enhance-videos": [{ owner: "topazlabs", name: "video-upscale" }],
            "text-to-speech": [{ owner: "minimax", name: "speech-02" }],
          },
        })
      );

      const { data } = await get({ provider: "replicate" });
      const caps = Object.fromEntries(data.models.map((m: { id: string; capabilities: string[] }) => [m.id, m.capabilities]));
      expect(caps["wavespeedai/wan-2.1-i2v-480p"]).toEqual(["image-to-video"]);
      expect(caps["wavespeedai/wan-2.1-t2v-480p"]).toEqual(["text-to-video"]);
      expect(caps["topazlabs/video-upscale"]).toEqual(["image-to-video"]);
      expect(caps["minimax/speech-02"]).toEqual(["text-to-audio"]);
    });
  });

  describe("fal.ai category mapping", () => {
    it("GET: should map fal.ai categories to ModelCapability", async () => {
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({
          fal: [
            { id: "fal-ai/flux", name: "Flux", category: "text-to-image" },
            { id: "fal-ai/img2img", name: "Img2Img", category: "image-to-image" },
            { id: "fal-ai/t2v", name: "T2V", category: "text-to-video" },
            { id: "fal-ai/i2v", name: "I2V", category: "image-to-video" },
          ],
        })
      );

      const { data } = await get();
      expect(data.models).toHaveLength(15);
      const caps = Object.fromEntries(data.models.map((m: { id: string; capabilities: string[] }) => [m.id, m.capabilities]));
      expect(caps["fal-ai/flux"]).toEqual(["text-to-image"]);
      expect(caps["fal-ai/img2img"]).toEqual(["image-to-image"]);
      expect(caps["fal-ai/t2v"]).toEqual(["text-to-video"]);
      expect(caps["fal-ai/i2v"]).toEqual(["image-to-video"]);
    });

    it("GET: should filter out non-relevant fal.ai categories", async () => {
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({
          fal: [
            { id: "fal-ai/flux", name: "Flux", category: "text-to-image" },
            { id: "fal-ai/whisper", name: "Whisper", category: "speech-to-text" },
            { id: "fal-ai/tts", name: "TTS", category: "text-to-speech" },
          ],
        })
      );

      const { data } = await get();
      expect(data.models).toHaveLength(13);
      expect(data.models.find((m: { id: string }) => m.id === "fal-ai/flux")).toBeDefined();
      expect(data.models.find((m: { id: string }) => m.id === "fal-ai/tts")?.capabilities).toEqual(["text-to-audio"]);
    });
  });

  describe("sorting", () => {
    it("GET: sorts by provider, then most run first where known, then by name", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      process.env.FAL_API_KEY = "test-fal-key";
      mockFetch.mockImplementation(
        providers({
          replicate: { "text-to-image": [{ owner: "z-org", name: "zebra", run_count: 10 }, { owner: "a-org", name: "alpha", run_count: 10 }, { owner: "m-org", name: "mighty", run_count: 500 }] },
          fal: [{ id: "fal-ai/zebra", name: "Zebra", category: "text-to-image" }, { id: "fal-ai/alpha", name: "Alpha", category: "text-to-image" }],
        })
      );

      const { data } = await get();
      expect(data.models.slice(0, 2).map((m: { provider: string; name: string }) => [m.provider, m.name])).toEqual([["fal", "Alpha"], ["fal", "Zebra"]]);
      const geminiModels = data.models.filter((m: { provider: string }) => m.provider === "gemini");
      expect(geminiModels.map((m: { name: string }) => m.name)).toEqual([
        "Gemini Omni 1.1 Flash", "Gemini Omni Flash Preview", "Nano Banana", "Nano Banana 2",
        "Nano Banana 2 Lite", "Nano Banana 2.1", "Nano Banana Pro", "Veo 3.1", "Veo 3.1 Fast", "Veo 3.1 Fast I2V", "Veo 3.1 I2V",
      ]);
      expect(data.models.slice(-3).map((m: { provider: string; name: string }) => [m.provider, m.name]))
        .toEqual([["replicate", "mighty"], ["replicate", "alpha"], ["replicate", "zebra"]]);
    });
  });

  describe("deep search", () => {
    it("GET: deep=true resolves an exact owner/name that the collections lack", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/models/topazlabs/video-upscale")) {
          return Promise.resolve(jsonResponse({ owner: "topazlabs", name: "video-upscale", description: "Professional-grade video upscaling powered by AI.", visibility: "public", run_count: 100 }));
        }
        if (url.includes("/search?query=")) return Promise.resolve(jsonResponse({ results: [] }));
        const collection = replicateCollection(url, { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }] });
        return Promise.resolve(collection ?? jsonResponse({}, false, 404));
      });

      const shallow = await get({ provider: "replicate", search: "topazlabs/video-upscale" });
      expect(shallow.data.models).toEqual([]);

      const { data } = await get({ provider: "replicate", search: "topazlabs/video-upscale", deep: "true" });
      const found = data.models.find((m: { id: string }) => m.id === "topazlabs/video-upscale");
      expect(found).toBeDefined();
      // A video upscaler must land under a video capability (visible in the Video node)
      expect(found.capabilities).toContain("image-to-video");
    });

    it("GET: deep=true finds a model by name fragment via Replicate's search, and a failing search is non-fatal", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      let searchOk = true;
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/search?query=")) {
          return Promise.resolve(searchOk ? jsonResponse({ results: [{ model: { owner: "topazlabs", name: "video-upscale", description: "Professional-grade video upscaling", visibility: "public", run_count: 50 } }] }) : jsonResponse({}, false, 500));
        }
        if (url.includes("/v1/models") && url.startsWith("https://api.replicate.com/v1/models")) return Promise.resolve(jsonResponse({}, false, 404));
        const collection = replicateCollection(url, { "text-to-image": [{ owner: "black-forest", name: "flux" }] });
        return Promise.resolve(collection ?? jsonResponse({}, false, 404));
      });

      const { data } = await get({ provider: "replicate", search: "topaz", deep: "true" });
      expect(data.models.find((m: { id: string }) => m.id === "topazlabs/video-upscale")?.capabilities).toContain("image-to-video");

      searchOk = false;
      const failing = await get({ provider: "replicate", search: "flux", deep: "true" });
      expect(failing.response.status).toBe(200);
      expect(failing.data.models.map((m: { id: string }) => m.id)).toEqual(["black-forest/flux"]);
    });

    it("GET: a non-existent owner/name 404s gracefully without failing the request", async () => {
      process.env.REPLICATE_API_KEY = "test-key";
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/models/ghost/missing-model")) return Promise.resolve(jsonResponse({}, false, 404));
        if (url.includes("/search?query=")) return Promise.resolve(jsonResponse({ results: [] }));
        const collection = replicateCollection(url, { "text-to-image": [{ owner: "stability-ai", name: "sdxl" }] });
        return Promise.resolve(collection ?? jsonResponse({}, false, 404));
      });

      const { response, data } = await get({ provider: "replicate", search: "ghost/missing-model", deep: "true" });
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.models).toEqual([]);
    });
  });

  describe("Comfy Router provider", () => {
    // The Router's live list: three bound models and one the app does not drive.
    const LIVE = ["bfl/flux-2-pro", "bfl/flux-2-max", "veo/veo-3.1-generate-001", "anthropic/claude-opus-5"];

    beforeEach(() => {
      delete process.env.COMFY_API_KEY;
      delete process.env.COMFY_CLOUD_API_KEY;
      mockFetch.mockImplementation((url: string) => {
        if (String(url).startsWith("https://api.comfy.org/v2/models")) {
          return Promise.resolve(jsonResponse({ data: LIVE.map((id) => ({ id })), has_more: false, next_cursor: null }));
        }
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      });
    });

    it("GET: provider=comfy offers the bound models the Router serves", async () => {
      const { response, data } = await get({ provider: "comfy" }, { "X-Comfy-Router-Key": "test-comfy-key" });
      expect(response.status).toBe(200);
      expect(data.models.map((m: { id: string }) => m.id).sort()).toEqual(["bfl/flux-2-max", "bfl/flux-2-pro", "veo/veo-3.1-generate-001"]);
      expect(data.models.every((m: { provider: string }) => m.provider === "comfy")).toBe(true);
      expect(data.providers.comfy).toEqual({ success: true, count: 3, cached: true });
      expect(data.availableProviders).toContain("comfy");
      // The list is read with the user's key
      expect(mockFetch.mock.calls[0][1].headers["X-API-Key"]).toBe("test-comfy-key");
    });

    it("GET: provider=comfy without any key returns 400", async () => {
      const { response, data } = await get({ provider: "comfy" });
      expect(response.status).toBe(400);
      expect(data.error).toBe("Comfy API key required. Add COMFY_API_KEY to .env.local or configure in Settings.");
    });

    it("GET: provider=comfy with a search query filters the catalog", async () => {
      process.env.COMFY_API_KEY = "env-comfy-key";
      const { data } = await get({ provider: "comfy", search: "flux" });
      expect(data.models.map((m: { id: string }) => m.id).sort()).toEqual(["bfl/flux-2-max", "bfl/flux-2-pro"]);
      expect(data.providers.comfy.count).toBe(2);
    });

    it("GET: comfy models join the aggregate when COMFY_CLOUD_API_KEY is set", async () => {
      process.env.COMFY_CLOUD_API_KEY = "env-cloud-key";
      const { data } = await get();
      expect(data.providers.comfy.count).toBe(3);
      expect(data.models).toHaveLength(data.providers.gemini.count + 3);
      expect(data.availableProviders).toEqual(expect.arrayContaining(["gemini", "comfy"]));
    });
  });
});

describe("OpenAI GPT Image 2.5 catalogue", () => {
  it("lists both variants under OpenAI without a fabricated per-image price", async () => {
    const response = await GET(createMockGetRequest({ provider: "openai", search: "2.5" }, { "X-OpenAI-API-Key": "test-key" }));
    const data = await response.json();
    expect(data.models.map((model: { id: string }) => model.id)).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
    for (const model of data.models) {
      expect(model.provider).toBe("openai");
      expect(model.capabilities).toContain("image-to-image");
      expect(model.pricing).toBeUndefined();
    }
  });
});

describe("Gemini Omni catalogue", () => {
  it("lists the stable and preview Omni models under Gemini", async () => {
    const response = await GET(createMockGetRequest({ provider: "gemini", search: "omni", capabilities: "text-to-video" }));
    const data = await response.json();
    expect(data.models.map((model: { id: string }) => model.id)).toEqual(["gemini-omni-1.1-flash", "gemini-omni-flash-preview"]);
    for (const model of data.models) {
      expect(model.provider).toBe("gemini");
      expect(model.capabilities).toEqual(expect.arrayContaining(["text-to-video", "image-to-video", "audio-to-video"]));
    }
  });
});
