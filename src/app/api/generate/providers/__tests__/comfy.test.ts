import { afterEach, describe, it, expect, vi } from "vitest";
import { checkComfyTaskOnce, comfyRunsSynchronously, fetchComfyMediaResult, parseRetryAfter, prepareRouterInput, readRouterResult, runComfySynchronously, servingProvider, submitComfyTask } from "../comfy";
import { nodeParameters, primeRouterSchema, servingProviders } from "@/lib/providers/comfyRouter/catalog";
import { routerBinding, type RouterBinding } from "@/lib/providers/comfyRouter/families";
import { buildRouterBody } from "@/lib/providers/comfyRouter/request";
import type { DerivedParam } from "@/lib/providers/comfyRouter/schema";
import type { GenerationInput } from "@/lib/providers/types";

/**
 * The Comfy Router provider end to end, below the network: node input →
 * encoded media → request body, and native result → found asset.
 *
 * Every partner has its own wire format (families.json). These pin down,
 * for the formats the app shipped with, the image encoding each partner
 * expects and the result path each returns, so a change to a binding shows
 * up here as well as in the schema suite.
 */

const PNG_B64 = "iVBORw0KGgo=";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const JPG_B64 = "/9j/4AAQSkZJRg==";
const JPG_URL = `data:image/jpeg;base64,${JPG_B64}`;

function binding(id: string): RouterBinding {
  const found = routerBinding(id);
  if (!found) throw new Error(`no binding for ${id}`);
  return found;
}

/** Settings the test sends, placed where the family's schema keeps them. */
function params(b: RouterBinding, names: string[]): DerivedParam[] {
  return names.map((name) => ({ name, type: "string", at: b.params.at ?? "" }));
}

function makeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: { id: "bfl/flux-2-pro", name: "FLUX.2 Pro", description: null, provider: "comfy", capabilities: ["text-to-image"] },
    prompt: "a photo of a cat",
    images: [],
    parameters: {},
    ...overrides,
  };
}

async function bodyFor(id: string, input: Partial<GenerationInput>, settings: string[] = []) {
  const b = binding(id);
  const prepared = await prepareRouterInput(b, makeInput(input), "key");
  return buildRouterBody(b, params(b, settings), { ...prepared, randomSeed: () => 1234 });
}

describe("Router request bodies", () => {
  it("FLUX.2: raw base64 into input_image, input_image_2; empty settings dropped", async () => {
    const body = await bodyFor(
      "bfl/flux-2-pro",
      { images: [PNG_URL, JPG_URL], parameters: { width: 1024, height: 768, seed: 7, output_format: "" } },
      ["width", "height", "seed", "output_format"]
    );
    expect(body).toEqual({ prompt: "a photo of a cat", input_image: PNG_B64, input_image_2: JPG_B64, width: 1024, height: 768, seed: 7 });
  });

  it("FLUX.2: no image fields for text to image", async () => {
    expect(await bodyFor("bfl/flux-2-pro", {})).toEqual({ prompt: "a photo of a cat" });
  });

  it("FLUX 3 Image: one images list of raw base64, settings beside it", async () => {
    const body = await bodyFor(
      "bfl/flux-3-image",
      { images: [PNG_URL, JPG_URL], parameters: { aspect_ratio: "16:9", resolution: "2k" } },
      ["aspect_ratio", "resolution"]
    );
    expect(body).toEqual({ prompt: "a photo of a cat", images: [PNG_B64, JPG_B64], aspect_ratio: "16:9", resolution: "2k" });
    expect(await bodyFor("bfl/flux-3-image", {})).toEqual({ prompt: "a photo of a cat" });
  });

  it("Ideogram 4.5: source images and a mask as data URLs, one image", async () => {
    const body = await bodyFor("ideogram/ideogram-4-5", { dynamicInputs: { image: PNG_URL, mask: JPG_URL } });
    expect(body).toEqual({ prompt: "a photo of a cat", images: [PNG_URL], mask: JPG_URL, num_images: 1 });
    expect(await bodyFor("ideogram/ideogram-4-5", {})).toEqual({ prompt: "a photo of a cat", num_images: 1 });
  });

  it("named handles win over the images list, so a mask is never also a reference", async () => {
    const body = await bodyFor("openai/gpt-image-1.5", {
      images: [PNG_URL, JPG_URL],
      dynamicInputs: { image: PNG_URL, mask: JPG_URL },
    });
    expect(body.image).toEqual([PNG_URL]);
    expect(body.mask).toBe(JPG_URL);
  });

  it("GPT Image: data URLs, one output, png", async () => {
    const body = await bodyFor("openai/gpt-image-1.5", { images: [PNG_URL], parameters: { size: "1024x1024", quality: "high" } }, ["size", "quality"]);
    expect(body).toEqual({ prompt: "a photo of a cat", n: 1, output_format: "png", image: [PNG_URL], size: "1024x1024", quality: "high" });
    expect(await bodyFor("openai/gpt-image-1.5", {})).not.toHaveProperty("image");
  });

  it("Gemini image: inlineData parts, settings inside imageConfig", async () => {
    const body = await bodyFor(
      "vertexai/gemini-3-pro-image",
      { images: [PNG_URL, JPG_URL], parameters: { aspectRatio: "16:9", imageSize: "2K" } },
      ["aspectRatio", "imageSize"]
    );
    const contents = body.contents as Array<{ parts: unknown[] }>;
    expect(contents[0]!.parts).toEqual([
      { text: "a photo of a cat" },
      { inlineData: { mimeType: "image/png", data: PNG_B64 } },
      { inlineData: { mimeType: "image/jpeg", data: JPG_B64 } },
    ]);
    expect(body.generationConfig).toMatchObject({ imageConfig: { aspectRatio: "16:9", imageSize: "2K" } });
  });

  it("Seedance: first and last frame with content roles, no watermark", async () => {
    const body = await bodyFor(
      "byteplus/dreamina-seedance-2-0-260128",
      { images: [PNG_URL], dynamicInputs: { last_frame: JPG_URL }, parameters: { duration: 5, ratio: "adaptive" } },
      ["duration", "ratio"]
    );
    expect(body.content).toEqual([
      { type: "text", text: "a photo of a cat" },
      { type: "image_url", image_url: { url: PNG_URL }, role: "first_frame" },
      { type: "image_url", image_url: { url: JPG_URL }, role: "last_frame" },
    ]);
    expect(body).toMatchObject({ watermark: false, duration: 5, ratio: "adaptive" });
    expect((await bodyFor("byteplus/dreamina-seedance-2-0-260128", {})).content).toEqual([{ type: "text", text: "a photo of a cat" }]);
  });

  it("Veo: frames as bytesBase64Encoded with their mime type, settings under parameters", async () => {
    const body = await bodyFor(
      "veo/veo-3.1-generate-001",
      { images: [PNG_URL], dynamicInputs: { last_frame: JPG_URL }, parameters: { aspectRatio: "16:9", durationSeconds: 8 } },
      ["aspectRatio", "durationSeconds"]
    );
    expect(body).toEqual({
      instances: [
        {
          prompt: "a photo of a cat",
          image: { bytesBase64Encoded: PNG_B64, mimeType: "image/png" },
          lastFrame: { bytesBase64Encoded: JPG_B64, mimeType: "image/jpeg" },
        },
      ],
      parameters: { aspectRatio: "16:9", durationSeconds: 8, sampleCount: 1, personGeneration: "allow_adult" },
    });
  });

  it("Runway Gen-4 Turbo: first frame as promptImage with a seed", async () => {
    const body = await bodyFor("runway/gen4_turbo", { images: [PNG_URL], parameters: { duration: 10, ratio: "720:1280" } }, ["duration", "ratio"]);
    expect(body).toEqual({ promptText: "a photo of a cat", promptImage: PNG_URL, seed: 1234, duration: 10, ratio: "720:1280" });
  });

  it("Kling: negative prompt from its own handle, no watermark", async () => {
    const body = await bodyFor("kling/kling-v3", { dynamicInputs: { negative_prompt: "blurry" } });
    expect(body).toEqual({ prompt: "a photo of a cat", negative_prompt: "blurry", watermark_info: { enabled: false } });
  });

  it("downloads an http input for a partner that takes bytes", async () => {
    const original = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } })) as unknown as typeof fetch;
    try {
      const body = await bodyFor("bfl/flux-2-pro", { images: ["https://example.com/ref.jpg"] });
      expect(body.input_image).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    } finally {
      global.fetch = original;
    }
  });
});

describe("readRouterResult", () => {
  it("FLUX: result.sample, or the BFL status", () => {
    expect(readRouterResult(binding("bfl/flux-2-pro"), { status: "Ready", result: { sample: "https://example.com/a.png" } })).toMatchObject({
      source: "https://example.com/a.png",
    });
    expect(() => readRouterResult(binding("bfl/flux-2-pro"), { status: "Content Moderated", result: null })).toThrow(
      "Black Forest Labs: Content Moderated"
    );
    expect(() => readRouterResult(binding("bfl/flux-kontext-pro"), { status: "Ready", result: {} })).toThrow("No image in the FLUX Kontext Pro result");
  });

  it("Ideogram 4.5: the first image URL", () => {
    expect(readRouterResult(binding("ideogram/ideogram-4-5"), { data: [{ url: "https://example.com/i.png", is_image_safe: true }] }).source).toBe(
      "https://example.com/i.png"
    );
  });

  it("GPT Image: b64_json as a png data URL", () => {
    expect(readRouterResult(binding("openai/gpt-image-1.5"), { data: [{ b64_json: "abc" }] }).source).toBe("data:image/png;base64,abc");
  });

  it("Gemini: the first inlineData part, with its own mime type", () => {
    const result = { candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/jpeg", data: "xyz" } }] } }] };
    expect(readRouterResult(binding("vertexai/gemini-3-pro-image"), result).source).toBe("data:image/jpeg;base64,xyz");
    expect(() => readRouterResult(binding("vertexai/gemini-3-pro-image"), { candidates: [], promptFeedback: { blockReason: "SAFETY" } })).toThrow(
      "Blocked: SAFETY"
    );
  });

  it("Kling: the partner's reason on failure, the first URL on success", () => {
    expect(() =>
      readRouterResult(binding("kling/kling-v3"), { data: { task_status: "failed", task_status_msg: "prompt rejected by moderation" } })
    ).toThrow("Kling task failed: prompt rejected by moderation");
    expect(
      readRouterResult(binding("kling/kling-v3"), { data: { task_status: "succeed", task_result: { videos: [{ url: "https://example.com/v.mp4" }] } } })
        .source
    ).toBe("https://example.com/v.mp4");
  });

  it("Veo: every filter reason, or the inline video", () => {
    expect(() =>
      readRouterResult(binding("veo/veo-3.1-generate-001"), {
        response: { videos: [], raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["violence", "celebrity"] },
      })
    ).toThrow("Veo filtered the output: violence, celebrity");
    expect(
      readRouterResult(binding("veo/veo-3.1-generate-001"), { response: { videos: [{ bytesBase64Encoded: "AAAA", mimeType: "video/mp4" }] } }).source
    ).toBe("data:video/mp4;base64,AAAA");
  });

  it("Wan: output.video_url, and the failure message", () => {
    expect(readRouterResult(binding("wan/wan2.7-t2v"), { output: { task_status: "SUCCEEDED", video_url: "https://example.com/w.mp4" } }).source).toBe(
      "https://example.com/w.mp4"
    );
    expect(() => readRouterResult(binding("wan/wan2.7-t2v"), { output: { task_status: "FAILED", message: "quota exceeded" } })).toThrow(
      "Wan: quota exceeded"
    );
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(" 1.5 ")).toBe(1500);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("Tue, 22 Sep 2026 10:00:00 GMT");
    expect(parseRetryAfter("Tue, 22 Sep 2026 10:00:05 GMT", now)).toBe(5000);
  });

  it("ignores absent, zero, past and junk values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("0")).toBeUndefined();
    expect(parseRetryAfter("Tue, 22 Sep 2026 09:00:00 GMT", Date.parse("Tue, 22 Sep 2026 10:00:00 GMT"))).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("fetchComfyMediaResult", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const KLING_VIDEO = { data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example.com/out.bin" }] } } };

  function collectThen(media: Response, result: unknown = { status: "Ready", result: { sample: "https://cdn.example.com/out.bin" } }) {
    const collect = new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    global.fetch = vi.fn().mockResolvedValueOnce(collect).mockResolvedValueOnce(media) as unknown as typeof fetch;
  }

  it("inlines an image", async () => {
    collectThen(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "3" } }));
    const out = await fetchComfyMediaResult("t", "key", "bfl/flux-2-pro", "req");
    expect(out.success).toBe(true);
    expect(out.outputs?.[0]?.data).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
  });

  it("returns the URL for a video above the inline limit without reading it", async () => {
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); } });
    const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
    collectThen(new Response(body, { status: 200, headers: { "Content-Type": "video/mp4", "Content-Length": String(30 * 1024 * 1024) } }), KLING_VIDEO);
    const out = await fetchComfyMediaResult("t", "key", "kling/kling-v3", "req");
    expect(out.outputs?.[0]).toEqual({ type: "video", data: "", url: "https://cdn.example.com/out.bin" });
    expect(cancel).toHaveBeenCalled();
    cancel.mockRestore();
  });

  it("stops reading an unsized video once it passes the inline limit", async () => {
    let served = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({ pull(controller) { served += 1; controller.enqueue(chunk); } });
    collectThen(new Response(body, { status: 200, headers: { "Content-Type": "video/mp4" } }), KLING_VIDEO);
    const out = await fetchComfyMediaResult("t", "key", "kling/kling-v3", "req");
    expect(out.outputs?.[0]).toEqual({ type: "video", data: "", url: "https://cdn.example.com/out.bin" });
    expect(served).toBeLessThan(30);
  });

  it("returns a binary partner's bytes as audio", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(new Uint8Array([9, 9]), { status: 200, headers: { "Content-Type": "audio/mpeg" } })
    ) as unknown as typeof fetch;
    const out = await fetchComfyMediaResult("t", "key", "elevenlabs/eleven_sfx_v2", "req");
    expect(out.outputs?.[0]).toEqual({ type: "audio", data: `data:audio/mpeg;base64,${Buffer.from([9, 9]).toString("base64")}` });
  });

  it("returns a 3D model as its URL", async () => {
    const meshy = binding("meshy/meshy-6");
    const path = meshy.result.media![0]!.split("|")[0]!.replace(/\[\*\]/g, "[0]");
    const result: Record<string, unknown> = {};
    // Build the smallest result document that holds a URL at the binding's first path.
    let node: Record<string, unknown> = result;
    const parts = path.split(".");
    parts.forEach((part, index) => {
      const [, key, idx] = /^([^[]+)(?:\[(\d+)\])?$/.exec(part)!;
      const last = index === parts.length - 1;
      const value = last ? "https://cdn.example.com/model.glb" : {};
      if (idx !== undefined) {
        node[key!] = [value];
      } else {
        node[key!] = value;
      }
      if (!last) node = (idx !== undefined ? (node[key!] as unknown[])[0] : node[key!]) as Record<string, unknown>;
    });
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "SUCCEEDED", ...result }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;
    const out = await fetchComfyMediaResult("t", "key", "meshy/meshy-6", "req");
    expect(out.outputs?.[0]).toEqual({ type: "3d", data: "", url: "https://cdn.example.com/model.glb" });
  });
});

describe("synchronous partners", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("marks the ElevenLabs families, and only them, as running in one request", () => {
    expect(comfyRunsSynchronously("elevenlabs/eleven_v4")).toBe(true);
    expect(comfyRunsSynchronously("elevenlabs/eleven_sfx_v2")).toBe(true);
    expect(comfyRunsSynchronously("bfl/flux-2-pro")).toBe(false);
    expect(binding("elevenlabs/eleven_v4").transport).toBe("sync");
    expect(binding("bfl/flux-2-pro").transport).toBe("queue");
  });

  it("runs ElevenLabs on the model's own route and returns the bytes as audio", async () => {
    primeRouterSchema("elevenlabs/eleven_sfx_v2", { openapi: "3.1.0", info: { title: "sfx", version: "1" }, paths: {}, components: { schemas: {} } });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { "Content-Type": "audio/mpeg", "X-Comfy-Credits-Used": "3" } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await runComfySynchronously("t", "key", makeInput({
      model: { id: "elevenlabs/eleven_sfx_v2", name: "Eleven SFX", description: null, provider: "comfy", capabilities: ["text-to-audio"] },
      prompt: "a door creaks",
      parameters: { duration_seconds: 1 },
    }));
    expect(out).toEqual({ success: true, outputs: [{ type: "audio", data: `data:audio/mpeg;base64,${Buffer.from([7, 7, 7]).toString("base64")}` }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.comfy.org/v2/models/elevenlabs/eleven_sfx_v2");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("key");
    expect(JSON.parse(init.body as string)).toMatchObject({ text: "a door creaks" });
  });

  it("reports the Router's refusal with its reason", async () => {
    primeRouterSchema("elevenlabs/eleven_v4", { openapi: "3.1.0", info: { title: "v4", version: "1" }, paths: {}, components: { schemas: {} } });
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Comfy workspace has no credits", error_type: "payment_required" }), { status: 402, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;
    const out = await runComfySynchronously("t", "key", makeInput({
      model: { id: "elevenlabs/eleven_v4", name: "Eleven v4", description: null, provider: "comfy", capabilities: ["text-to-audio"] },
      prompt: "hello",
    }));
    expect(out).toEqual({ success: false, error: "Comfy workspace has no credits (payment_required)" });
  });

  it("never queues a synchronous model", async () => {
    primeRouterSchema("elevenlabs/eleven_v4", { openapi: "3.1.0", info: { title: "v4", version: "1" }, paths: {}, components: { schemas: {} } });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(submitComfyTask("t", "key", makeInput({
      model: { id: "elevenlabs/eleven_v4", name: "Eleven v4", description: null, provider: "comfy", capabilities: ["text-to-audio"] },
      prompt: "hello",
    }))).rejects.toThrow(/runs in one request/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("serving provider", () => {
  it("reads Kling 3.0 Turbo served by Higgsfield, which answers in classic Kling form", () => {
    const result = { data: { task_id: "t", task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example.com/k.mp4" }] } }, request_id: "t" };
    expect(readRouterResult(binding("kling/kling-3.0-turbo"), result).source).toBe("https://cdn.example.com/k.mp4");
  });

  const nanoBananaPro = () => binding("vertexai/gemini-3-pro-image");


  it("reads the providers from the schema's x-comfy-router-alt-providers, falling back to the binding", () => {
    const doc = { "x-comfy-router-alt-providers": [{ provider: "fal" }, { provider: "wavespeed" }] };
    expect(servingProviders(doc, nanoBananaPro())).toEqual(["comfy", "fal", "wavespeed"]);
    expect(servingProviders({}, nanoBananaPro())).toEqual(["comfy", "fal", "runware", "wavespeed"]);
    expect(servingProviders({}, binding("bfl/flux-2-pro"))).toEqual(["comfy"]);
  });

  it("offers the providers as the first setting, Comfy by default", () => {
    const [first] = nodeParameters([], ["comfy", "fal"]);
    expect(first).toMatchObject({ name: "model_provider", enum: ["comfy", "fal"], default: "comfy" });
    expect(nodeParameters([], ["comfy"])).toEqual([]);
  });

  it("asks for an alternate only when one is picked and offered", () => {
    const providers = ["comfy", "fal", "runware", "wavespeed"];
    expect(servingProvider(providers, "fal")).toBe("fal");
    expect(servingProvider(providers, "comfy")).toBeNull();
    expect(servingProvider(providers, "higgsfield")).toBeNull();
    expect(servingProvider(["comfy"], "fal")).toBeNull();
  });

  it("sends data-URL media by URL through an alternate provider, raw base64 stays", async () => {
    const original = global.fetch;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/customers/storage")) return new Response(JSON.stringify({ upload_url: "https://up/x", download_url: "https://cdn.comfy/x.png" }));
      return new Response("", { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const seedance = binding("byteplus/dreamina-seedance-2-0-260128");
      const viaHiggsfield = await prepareRouterInput(seedance, makeInput({ images: [PNG_URL] }), "key", "higgsfield");
      const body = buildRouterBody(seedance, [], viaHiggsfield);
      expect((body.content as Array<Record<string, unknown>>)[1]).toMatchObject({ image_url: { url: "https://cdn.comfy/x.png" }, role: "first_frame" });
      const gemini = binding("vertexai/gemini-3-pro-image");
      const viaFal = await prepareRouterInput(gemini, makeInput({ images: [PNG_URL] }), "key", "fal");
      const parts = (buildRouterBody(gemini, [], viaFal).contents as Array<{ parts: unknown[] }>)[0]!.parts;
      expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_B64 } });
    } finally {
      global.fetch = original;
    }
  });

  it("submits to ?model_provider= and keeps the setting out of the body", async () => {
    primeRouterSchema("kling/kling-v3", {
      paths: { "/v2/models/kling/kling-v3": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { prompt: { type: "string" }, duration: { type: "string" } } } } } } } } },
    });
    const original = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request_id: "r1" }), { status: 202 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await submitComfyTask("t", "key", makeInput({ model: { ...makeInput().model, id: "kling/kling-v3" }, parameters: { model_provider: "higgsfield", duration: "5" } }));
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.comfy.org/v2/models/kling/kling-v3/requests?model_provider=higgsfield");
      const body = JSON.parse(String(init.body));
      expect(body).not.toHaveProperty("model_provider");
      expect(body.duration).toBe("5");
    } finally {
      global.fetch = original;
    }
  });
});

describe("checkComfyTaskOnce", () => {
  it("keeps polling through a transient 503 or 429 from the status route", async () => {
    const original = global.fetch;
    try {
      for (const status of [503, 429]) {
        global.fetch = vi.fn().mockResolvedValue(new Response("busy", { status, headers: { "Retry-After": "4" } })) as unknown as typeof fetch;
        expect(await checkComfyTaskOnce("t", "key", "kling/kling-v3", "r1")).toEqual({ status: "processing", retryAfterMs: 4000 });
      }
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "nope" }), { status: 404 })) as unknown as typeof fetch;
      expect((await checkComfyTaskOnce("t", "key", "kling/kling-v3", "r1")).status).toBe("failed");
    } finally {
      global.fetch = original;
    }
  });
});
