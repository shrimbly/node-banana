import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listModels, PROVIDER_TIMEOUT_MS, REPLICATE_COLLECTIONS, type ListModelsResult, type ListModelsSuccess } from "../registry";
import { getModelSchema } from "../schema";
import { CATALOG_DIR_ENV, resetCatalog } from "../catalog";

const mockFetch = vi.fn();
let catalogDir: string;

type ReplicateFixture = { owner: string; name: string; description?: string | null; run_count?: number; cover_image_url?: string };

/** A fetch that answers Replicate's collections: the given ones with models, the rest empty. */
function replicateCollections(
  collections: Record<string, ReplicateFixture[]>,
  other?: (url: string, init?: RequestInit) => unknown,
) {
  return (url: string, init?: RequestInit) => {
    const match = /\/v1\/collections\/([^/?]+)$/.exec(url);
    if (match) {
      const models = (collections[match[1]] ?? []).map((m) => ({ visibility: "public", run_count: 1, description: null, ...m }));
      return Promise.resolve(jsonResponse({ models }));
    }
    return other ? other(url, init) : Promise.resolve(jsonResponse({}, false, 404));
  };
}

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
    catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-registry-"));
    process.env[CATALOG_DIR_ENV] = catalogDir;
    resetCatalog();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    resetCatalog();
    delete process.env[CATALOG_DIR_ENV];
    fs.rmSync(catalogDir, { recursive: true, force: true });
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

    it("lists the bound Comfy Router models the Router serves, with the key", async () => {
      // The Router's live list: two bound models and one the app does not drive.
      const live = ["bfl/flux-2-pro", "veo/veo-3.1-generate-001", "anthropic/claude-opus-5"];
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).startsWith("https://api.comfy.org/v2/models")
            ? jsonResponse({ data: live.map((id) => ({ id })), has_more: false, next_cursor: null })
            : jsonResponse({}, false, 404)
        )
      );
      const result = expectOk(await listModels({ provider: "comfy" }, { comfy: "comfyui-key" }));
      expect(result.models.map((m) => m.id).sort()).toEqual(["bfl/flux-2-pro", "veo/veo-3.1-generate-001"]);
      expect(result.availableProviders).toEqual(["gemini", "comfy"]);
      expect(mockFetch.mock.calls[0][1].headers["X-API-Key"]).toBe("comfyui-key");
    });

    it("aggregates every keyed static provider and Comfy Router, sorted by provider then name", async () => {
      const result = expectOk(await listModels({}, { kie: "k", openai: "o", comfy: "c" }));

      expect(Object.keys(result.providers)).toEqual(["gemini", "kie", "openai", "comfy"]);
      expect(result.availableProviders).toEqual(["gemini", "kie", "openai", "comfy"]);
      const total = Object.values(result.providers).reduce((sum, p) => sum + p.count, 0);
      expect(result.models).toHaveLength(total);

      const sorted = [...result.models].sort((a, b) =>
        a.provider !== b.provider ? a.provider.localeCompare(b.provider) : a.name.localeCompare(b.name)
      );
      expect(result.models.map((m) => `${m.provider}:${m.id}`)).toEqual(sorted.map((m) => `${m.provider}:${m.id}`));
      // Only the Router's model list is asked for (cached ten minutes)
      expect(fetchedUrls().every((url) => url.startsWith("https://api.comfy.org/v2/models"))).toBe(true);
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
    it("lists Replicate from its curated collections, fresh then from the catalog", async () => {
      mockFetch.mockImplementation(replicateCollections({ "text-to-image": [{ owner: "stability-ai", name: "sdxl", description: "SDXL image model" }] }));

      const first = expectOk(await listModels({ provider: "replicate" }, { replicate: "rep" }));
      expect(first.models.map((m) => m.id)).toEqual(["stability-ai/sdxl"]);
      expect(first.providers.replicate).toEqual({
        success: true, count: 1, cached: false, fetchedAt: expect.any(Number), stale: false, refreshing: false,
      });
      expect(first.cached).toBe(false);
      // Every collection, all at once, with the key
      const urls = fetchedUrls();
      expect(urls).toHaveLength(REPLICATE_COLLECTIONS.length);
      for (const { slug } of REPLICATE_COLLECTIONS) expect(urls).toContain(`https://api.replicate.com/v1/collections/${slug}`);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.replicate.com/v1/collections/text-to-image",
        expect.objectContaining({ headers: { Authorization: "Bearer rep" }, signal: expect.any(AbortSignal) })
      );

      const second = expectOk(await listModels({ provider: "replicate" }, { replicate: "rep" }));
      expect(second.providers.replicate.cached).toBe(true);
      expect(second.cached).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(REPLICATE_COLLECTIONS.length);
    });

    it("gives a Replicate model every collection's capability, ranks by runs, and drops base64 covers", async () => {
      mockFetch.mockImplementation(
        replicateCollections({
          "text-to-image": [
            { owner: "google", name: "nano-banana", run_count: 100, cover_image_url: "https://replicate.delivery/cover.png" },
            { owner: "oitoito", name: "depth-pro", run_count: 5, cover_image_url: "https://replicate.comdata:image/jpeg;base64,/9j/4AAQ" },
          ],
          "sketch-to-image": [{ owner: "google", name: "nano-banana", run_count: 100 }],
          "wan-video": [
            { owner: "wavespeedai", name: "wan-2.1-i2v-720p", run_count: 50 },
            { owner: "wavespeedai", name: "wan-2.1-t2v-480p", run_count: 60 },
          ],
          "3d-models": [
            { owner: "firtoz", name: "trellis", description: "Image to 3D", run_count: 9 },
            { owner: "x", name: "shap-e", description: "Text prompt to 3D shape", run_count: 8 },
          ],
          lipsync: [{ owner: "sync", name: "lipsync-2", run_count: 7 }],
        })
      );
      const result = expectOk(await listModels({ provider: "replicate" }, { replicate: "rep" }));
      const byId = Object.fromEntries(result.models.map((m) => [m.id, m]));
      expect(byId["google/nano-banana"].capabilities).toEqual(["text-to-image", "image-to-image"]);
      expect(byId["google/nano-banana"].coverImage).toBe("https://replicate.delivery/cover.png");
      expect(byId["google/nano-banana"].popularity).toBe(100);
      expect(byId["oitoito/depth-pro"].coverImage).toBeUndefined();
      expect(byId["wavespeedai/wan-2.1-i2v-720p"].capabilities).toEqual(["image-to-video"]);
      expect(byId["wavespeedai/wan-2.1-t2v-480p"].capabilities).toEqual(["text-to-video"]);
      expect(byId["firtoz/trellis"].capabilities).toEqual(["image-to-3d"]);
      expect(byId["x/shap-e"].capabilities).toEqual(["text-to-3d"]);
      expect(byId["sync/lipsync-2"].capabilities).toEqual(["audio-to-video"]);
      // Most run first
      expect(result.models.map((m) => m.id).slice(0, 3)).toEqual(["google/nano-banana", "wavespeedai/wan-2.1-t2v-480p", "wavespeedai/wan-2.1-i2v-720p"]);
    });

    it("skips a collection that errors but fails on a rejected key", async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith("/collections/flux") ? jsonResponse({}, false, 500) : replicateCollections({ "text-to-image": [{ owner: "a", name: "b" }] })(url))
      );
      const result = expectOk(await listModels({ provider: "replicate" }, { replicate: "rep" }));
      expect(result.models.map((m) => m.id)).toEqual(["a/b"]);
      expect(result.providers.replicate.success).toBe(true);
    });

    it("fetches every provider at once rather than one after another", async () => {
      let releaseFal: () => void = () => {};
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("fal.ai")) return new Promise((resolve) => (releaseFal = () => resolve(jsonResponse({ models: [], has_more: false, next_cursor: null }))));
        return replicateCollections({})(url);
      });
      const listing = listModels({}, { replicate: "rep", fal: "fal" });
      // fal is still pending, yet Replicate's collections have all been asked for
      await vi.waitFor(() => expect(fetchedUrls().filter((u) => u.includes("replicate.com"))).toHaveLength(REPLICATE_COLLECTIONS.length));
      expect(fetchedUrls().some((u) => u.includes("fal.ai"))).toBe(true);
      releaseFal();
      const result = expectOk(await listing);
      expect(result.providers.replicate.success).toBe(true);
      expect(result.providers.fal.success).toBe(true);
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

    it("waits out a rate-limited fal.ai page and asks for it again", async () => {
      vi.useFakeTimers();
      const page = (id: string, more: boolean) => jsonResponse({
        models: [{ endpoint_id: id, metadata: { display_name: id, category: "text-to-image", description: "" } }],
        has_more: more, next_cursor: more ? "next" : null,
      });
      mockFetch
        .mockResolvedValueOnce(page("fal-ai/one", true))
        .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "retry-after": "1" }), json: () => Promise.resolve({ error: "Too Many Requests" }) })
        .mockResolvedValueOnce(page("fal-ai/two", false));
      const listing = listModels({ provider: "fal" }, { fal: "fal" });
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      const result = expectOk(await listing);
      expect(result.models.map((m) => m.id)).toEqual(["fal-ai/one", "fal-ai/two"]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("follows fal.ai's cursor to the last page", async () => {
      let page = 0;
      mockFetch.mockImplementation(() => {
        page++;
        return Promise.resolve(
          jsonResponse({
            models: [{ endpoint_id: `fal-ai/m${page}`, metadata: { display_name: `M${page}`, category: "text-to-image", description: "" } }],
            has_more: page < 20,
            next_cursor: page < 20 ? `c${page}` : null,
          })
        );
      });
      const result = expectOk(await listModels({ provider: "fal" }, { fal: "fal" }));
      expect(result.models).toHaveLength(20);
      expect(page).toBe(20);
      expect(fetchedUrls()[1]).toContain("cursor=c1");
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

    it("searches the stored list without touching the network", async () => {
      mockFetch.mockImplementation(replicateCollections({ "text-to-image": [{ owner: "a", name: "flux-dev" }, { owner: "b", name: "sdxl" }] }));
      await listModels({ provider: "replicate" }, { replicate: "rep" });
      mockFetch.mockClear();
      const result = expectOk(await listModels({ provider: "replicate", search: "flux" }, { replicate: "rep" }));
      expect(result.models.map((m) => m.id)).toEqual(["a/flux-dev"]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("never looks up a malformed Replicate id directly, even in a deep search", async () => {
      mockFetch.mockImplementation(replicateCollections({}));
      const result = expectOk(
        await listModels({ provider: "replicate", search: "owner/name?x=1", deep: true }, { replicate: "rep" })
      );
      expect(result.models).toEqual([]);
      expect(fetchedUrls().some((url) => url.startsWith("https://api.replicate.com/v1/models/"))).toBe(false);
    });

    it("deep search asks Replicate's search and looks a well-formed id up directly", async () => {
      mockFetch.mockImplementation(
        replicateCollections({ "text-to-image": [{ owner: "a", name: "flux-dev" }] }, (url: string) => {
          if (url === "https://api.replicate.com/v1/models/topazlabs/video-upscale") {
            return Promise.resolve(jsonResponse({ owner: "topazlabs", name: "video-upscale", description: "Upscale video footage" }));
          }
          if (url.startsWith("https://api.replicate.com/v1/search?query=")) {
            return Promise.resolve(jsonResponse({ results: [{ model: { owner: "obscure", name: "video-upscale-lite", description: "video upscale" } }] }));
          }
          return Promise.resolve(jsonResponse({}, false, 404));
        })
      );

      const result = expectOk(
        await listModels({ provider: "replicate", search: "topazlabs/video-upscale", deep: true }, { replicate: "rep" })
      );
      expect(result.models.map((m) => m.id).sort()).toEqual(["obscure/video-upscale-lite", "topazlabs/video-upscale"]);
      expect(result.models.find((m) => m.id === "topazlabs/video-upscale")?.capabilities).toContain("image-to-video");
    });

    it("deep search asks fal.ai's server-side search too", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("q=rare")) {
          return Promise.resolve(jsonResponse({ models: [{ endpoint_id: "fal-ai/rare", metadata: { display_name: "Rare", category: "text-to-image", description: "" } }], has_more: false, next_cursor: null }));
        }
        return Promise.resolve(jsonResponse({ models: [{ endpoint_id: "fal-ai/flux", metadata: { display_name: "Flux", category: "text-to-image", description: "" } }], has_more: false, next_cursor: null }));
      });
      const shallow = expectOk(await listModels({ provider: "fal", search: "rare" }, { fal: "fal" }));
      expect(shallow.models).toEqual([]);
      const deep = expectOk(await listModels({ provider: "fal", search: "rare", deep: true }, { fal: "fal" }));
      expect(deep.models.map((m) => m.id)).toEqual(["fal-ai/rare"]);
    });
  });
});

describe("listModels: a search that matches nothing", () => {
  it("is an empty list, not a failure, when only static providers were searched", async () => {
    const result = await listModels({ provider: "gemini", search: "no-such-model-zzz" }, {});
    expect(result).toMatchObject({ ok: true, models: [] });
  });
});
