import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getModelSchema, isSchemaProvider, type ModelSchemaResult, type ModelSchemaSuccess } from "../schema";
import { primeRouterSchema } from "../comfyRouter/catalog";
import { clearFalSchemaCache } from "../falSchema";

const mockFetch = vi.fn();

// The schema cache lives for the module; unique ids keep fetched cases apart.
let counter = 0;
const uniqueId = (base: string) => `${base}-${Date.now()}-${++counter}`;

function expectOk(result: ModelSchemaResult): ModelSchemaSuccess {
  if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.error}`);
  return result;
}

function replicateSchemaResponse(properties: Record<string, unknown>, required: string[] = []) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        latest_version: {
          openapi_schema: { components: { schemas: { Input: { type: "object", properties, required } } } },
        },
      }),
  };
}

describe("getModelSchema", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearFalSchemaCache();
  });

  describe("static schemas", () => {
    it("serves a Gemini image model", async () => {
      const result = expectOk(await getModelSchema("gemini", "nano-banana-pro", {}));
      expect(result.parameters.map((p) => p.name)).toEqual(["aspectRatio", "resolution", "useGoogleSearch"]);
      expect(result.inputs).toEqual([
        { name: "prompt", type: "text", required: true, label: "Prompt" },
        { name: "image", type: "image", required: false, label: "Image", isArray: true },
      ]);
    });

    it("serves a Gemini (Veo) video model", async () => {
      const result = expectOk(await getModelSchema("gemini", "veo-3.1/image-to-video", {}));
      expect(result.parameters.map((p) => p.name)).toEqual(["aspectRatio", "durationSeconds", "resolution", "seed"]);
      expect(result.inputs).toContainEqual({ name: "image", type: "image", required: true, label: "Image" });
    });

    it("serves an OpenAI model", async () => {
      const result = expectOk(await getModelSchema("openai", "gpt-image-1", {}));
      expect(result.parameters.map((p) => p.name)).toEqual(["size", "quality", "background"]);
      expect(result.inputs.map((i) => i.name)).toEqual(["prompt", "image"]);
    });

    it("serves a Kie model", async () => {
      const result = expectOk(await getModelSchema("kie", "seedream/4.5-edit", {}));
      expect(result.parameters.map((p) => p.name)).toEqual(["aspect_ratio", "quality", "seed"]);
      expect(result.inputs).toContainEqual({ name: "image_urls", type: "image", required: true, label: "Image", isArray: true });
    });

    it("serves a Comfy Router model's settings from its published schema", async () => {
      primeRouterSchema("bfl/flux-2-pro", {
        paths: {
          "/v2/models/bfl/flux-2-pro": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["prompt"],
                      properties: {
                        prompt: { type: "string" },
                        input_image: { type: "string" },
                        width: { type: "integer", minimum: 256, maximum: 2048, default: 1024 },
                        height: { type: "integer", minimum: 256, maximum: 2048, default: 1024 },
                        seed: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      const result = expectOk(await getModelSchema("comfy", "bfl/flux-2-pro", {}));
      expect(result.parameters.map((p) => p.name)).toEqual(expect.arrayContaining(["width", "height", "seed"]));
      expect(result.inputs.find((i) => i.name === "prompt")).toMatchObject({ type: "text", required: true });
      // Served from the Router schema cache
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("needs no key and makes no request for static providers", async () => {
      await getModelSchema("gemini", "nano-banana", {});
      await getModelSchema("openai", "gpt-image-2", {});
      await getModelSchema("kie", "z-image", {});
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("answers a repeat lookup from the cache", async () => {
      const id = "nano-banana-2-lite";
      await getModelSchema("gemini", id, {});
      const again = expectOk(await getModelSchema("gemini", id, {}));
      expect(again.cached).toBe(true);
    });
  });

  describe("unknown ids and providers", () => {
    it("404s an id outside the Comfy Router catalog", async () => {
      expect(await getModelSchema("comfy", "nobody/no-such-model", {})).toEqual({
        ok: false,
        error: "Unknown Comfy Router model",
        status: 404,
      });
    });

    it.each(["gemini", "kie", "openai"])("returns empty lists for an unknown %s id", async (provider) => {
      const result = expectOk(await getModelSchema(provider, uniqueId("no-such-model"), {}));
      expect(result.parameters).toEqual([]);
      expect(result.inputs).toEqual([]);
    });

    it.each([null, undefined, "", "anthropic", "nonsense"])("rejects provider %s with 400", async (provider) => {
      const result = await getModelSchema(provider, "nano-banana", {});
      expect(result).toMatchObject({ ok: false, status: 400 });
      if (!result.ok) expect(result.error).toMatch(/^Invalid or missing provider/);
    });

    it("recognises the schema providers", () => {
      expect(["replicate", "fal", "kie", "wavespeed", "gemini", "openai", "comfy"].every(isSchemaProvider)).toBe(true);
      expect(isSchemaProvider("anthropic")).toBe(false);
      expect(isSchemaProvider(null)).toBe(false);
    });
  });

  describe("fal.ai (network mocked)", () => {
    const falResponse = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: () => Promise.resolve(body),
    });
    const falSpec = {
      paths: { "/fal-ai/nano-banana-lite": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Input" } } } } } } },
      components: { schemas: { Input: { properties: {
        prompt: { type: "string" },
        aspect_ratio: { anyOf: [{ type: "string", enum: ["auto", "1:1", "16:9"] }, { type: "null" }], default: "auto" },
        num_images: { type: "integer", minimum: 1, maximum: 4, default: 1 },
      } } } },
    };

    it("needs a key (401) before asking fal", async () => {
      expect(await getModelSchema("fal", uniqueId("google/nano-banana-2-lite"), {})).toMatchObject({ ok: false, status: 401 });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("turns the model's schema into settings and a prompt input", async () => {
      const modelId = uniqueId("google/nano-banana-2-lite");
      mockFetch.mockResolvedValueOnce(falResponse(200, { models: [{ endpoint_id: modelId, openapi: falSpec }] }));
      const result = expectOk(await getModelSchema("fal", modelId, { fal: "fal-key" }));
      expect(result.parameters.map((p) => p.name)).toEqual(["num_images", "aspect_ratio"]);
      expect(result.parameters[1]).toMatchObject({ type: "string", enum: ["auto", "1:1", "16:9"], default: "auto" });
      expect(result.inputs).toEqual([{ name: "prompt", type: "text", required: false, label: "Prompt", description: undefined, isArray: false }]);
      expect(mockFetch.mock.calls[0][1].headers).toEqual({ Authorization: "Key fal-key" });
    });

    it("reports a rate limit as an error with its status, and asks again next time rather than remembering it", async () => {
      vi.useFakeTimers();
      const modelId = uniqueId("google/nano-banana-2-lite");
      mockFetch.mockResolvedValue(falResponse(429, { error: "Too Many Requests" }, { "retry-after": "1" }));
      const pending = getModelSchema("fal", modelId, { fal: "fal-key" });
      await vi.advanceTimersByTimeAsync(20000);
      expect(await pending).toEqual({ ok: false, status: 429, error: expect.stringContaining("rate limiting") });
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(falResponse(200, { models: [{ endpoint_id: modelId, openapi: falSpec }] }));
      // The refusal is not cached; the next lookup waits out the hold it left, then asks again
      const again = getModelSchema("fal", modelId, { fal: "fal-key" });
      await vi.advanceTimersByTimeAsync(32000);
      expect(expectOk(await again).parameters).toHaveLength(2);
    });

    it("reports a rejected key (401) and an unknown model (404) instead of an empty schema", async () => {
      mockFetch.mockResolvedValueOnce(falResponse(401, {}));
      expect(await getModelSchema("fal", uniqueId("google/nano-banana-2-lite"), { fal: "bad" })).toMatchObject({ ok: false, status: 401 });
      mockFetch.mockResolvedValueOnce(falResponse(200, { models: [] }));
      expect(await getModelSchema("fal", uniqueId("fal-ai/nano-banana-2-lite"), { fal: "fal-key" })).toMatchObject({ ok: false, status: 404 });
    });
  });

  describe("Replicate (network mocked)", () => {
    it.each(["owner", "owner/name/extra", "owner/name?x=1", "../../v1/account", "owner/na me", "owner/name#frag", "/name", "owner/"])(
      "refuses the malformed id %s with 400 and no request",
      async (modelId) => {
        const result = await getModelSchema("replicate", modelId, { replicate: "rep" });
        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(mockFetch).not.toHaveBeenCalled();
      }
    );

    it("needs a key (401)", async () => {
      expect(await getModelSchema("replicate", uniqueId("owner/model"), {})).toEqual({
        ok: false,
        error: "Replicate API key required. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
        status: 401,
      });
    });

    it("extracts the schema, then serves it from the cache", async () => {
      mockFetch.mockResolvedValueOnce(
        replicateSchemaResponse(
          {
            prompt: { type: "string" },
            image: { type: "string", format: "uri" },
            num_inference_steps: { type: "integer", default: 28, minimum: 1, maximum: 50 },
          },
          ["prompt"]
        )
      );
      const modelId = uniqueId("owner/model.v1_x");

      const first = expectOk(await getModelSchema("replicate", modelId, { replicate: "rep" }));
      expect(first.cached).toBe(false);
      expect(first.parameters).toEqual([
        { name: "num_inference_steps", type: "integer", description: undefined, default: 28, required: false, minimum: 1, maximum: 50 },
      ]);
      expect(first.inputs.map((i) => [i.name, i.type, i.required])).toEqual([
        ["prompt", "text", true],
        ["image", "image", false],
      ]);
      expect(mockFetch).toHaveBeenCalledWith(`https://api.replicate.com/v1/models/${modelId}`, {
        headers: { Authorization: "Bearer rep" },
      });

      const second = expectOk(await getModelSchema("replicate", modelId, { replicate: "rep" }));
      expect(second.cached).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("offers video_size as a setting, not a video input, and still finds clips by name or description (#135)", async () => {
      mockFetch.mockResolvedValueOnce(
        replicateSchemaResponse({
          prompt: { type: "string" },
          video_size: { type: "string", description: "Output resolution of the generated video", enum: ["720p", "1080p"], default: "720p" },
          num_videos: { type: "integer", default: 1 },
          ref_video_url: { type: "string", description: "Reference clip" },
          media_reference: { type: "string", description: "URL of the source video to restyle" },
        })
      );
      const result = expectOk(await getModelSchema("replicate", uniqueId("owner/model"), { replicate: "rep" }));
      expect(result.parameters.map((p) => p.name).sort()).toEqual(["num_videos", "video_size"]);
      expect(result.inputs.filter((i) => i.type === "video").map((i) => i.name).sort()).toEqual(["media_reference", "ref_video_url"]);
    });

    it("passes the caller's abort signal to the request", async () => {
      mockFetch.mockResolvedValueOnce(replicateSchemaResponse({ prompt: { type: "string" } }));
      const controller = new AbortController();
      await getModelSchema("replicate", uniqueId("owner/model"), { replicate: "rep" }, { signal: controller.signal });
      expect(mockFetch.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    });

    it("reports a provider error as 500", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });
      expect(await getModelSchema("replicate", uniqueId("owner/model"), { replicate: "rep" })).toEqual({
        ok: false,
        error: "Replicate API error: 404",
        status: 500,
      });
    });
  });

  describe("fal.ai (network mocked)", () => {
    it("needs a key (401)", async () => {
      const result = await getModelSchema("fal", uniqueId("fal-ai/model"), {});
      expect(result).toMatchObject({ ok: false, status: 401 });
    });

    it("encodes the id and extracts the request schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                openapi: {
                  paths: {
                    "/": {
                      post: {
                        requestBody: {
                          content: {
                            "application/json": {
                              schema: {
                                properties: { prompt: { type: "string" }, image_url: { type: "string" } },
                                required: ["prompt", "image_url"],
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          }),
      });
      const modelId = uniqueId("fal-ai/kling/v2 pro");
      const result = expectOk(await getModelSchema("fal", modelId, { fal: "fal" }));
      expect(result.inputs.map((i) => i.name)).toEqual(["image_url", "prompt"]);
      expect(String(mockFetch.mock.calls[0][0])).toContain(`endpoint_id=${encodeURIComponent(modelId)}`);
    });
  });
});
