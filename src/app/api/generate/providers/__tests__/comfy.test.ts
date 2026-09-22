import { afterEach, describe, it, expect, vi } from "vitest";
import { buildComfyRouterBody, fetchComfyMediaResult, parseRetryAfter, readComfyRouterResult } from "../comfy";
import type { GenerationInput } from "@/lib/providers/types";

/**
 * Tests for the Comfy Router family builders and readers.
 *
 * The Router forwards each partner's native wire format, so every family
 * shapes the request and reads the result differently. These pin down the
 * image encoding each partner expects and the result path each returns.
 */

const PNG_B64 = "iVBORw0KGgo=";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const JPG_B64 = "/9j/4AAQSkZJRg==";
const JPG_URL = `data:image/jpeg;base64,${JPG_B64}`;
const HTTP_URL = "https://example.com/ref.png";

function makeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: {
      id: "bfl/flux-2-pro",
      name: "FLUX.2 Pro",
      description: null,
      provider: "comfy",
      capabilities: ["text-to-image"],
    },
    prompt: "a photo of a cat",
    images: [],
    parameters: {},
    ...overrides,
  };
}

describe("buildComfyRouterBody", () => {
  describe("flux2", () => {
    it("strips data URLs to raw base64 into input_image and input_image_2", () => {
      const body = buildComfyRouterBody(
        "flux2",
        makeInput({
          images: [PNG_URL, JPG_URL],
          parameters: { width: 1024, height: 768, seed: 7, output_format: "" },
        })
      );

      expect(body).toMatchObject({
        prompt: "a photo of a cat",
        width: 1024,
        height: 768,
        seed: 7,
        input_image: PNG_B64,
        input_image_2: JPG_B64,
      });
      // Empty parameters are dropped rather than sent
      expect(body).not.toHaveProperty("output_format");
      // Numbering starts at input_image, then _2, never _1
      expect(body).not.toHaveProperty("input_image_1");
      expect(body).not.toHaveProperty("input_image_3");
    });

    it("keeps http URLs as-is and dedupes across images and the image dynamic input", () => {
      const body = buildComfyRouterBody(
        "flux2",
        makeInput({
          images: [PNG_URL],
          dynamicInputs: { image: [PNG_URL, HTTP_URL] },
        })
      );

      expect(body.input_image).toBe(PNG_B64);
      expect(body.input_image_2).toBe(HTTP_URL);
      expect(body).not.toHaveProperty("input_image_3");
    });

    it("sends no image fields for text to image", () => {
      const body = buildComfyRouterBody("flux2", makeInput());
      expect(body).toEqual({ prompt: "a photo of a cat" });
    });
  });

  describe("gptImage", () => {
    it("keeps data URLs and sends a single image as a string", () => {
      const body = buildComfyRouterBody(
        "gptImage",
        makeInput({ images: [PNG_URL], parameters: { size: "1024x1024", quality: "high" } })
      );

      expect(body).toEqual({
        prompt: "a photo of a cat",
        n: 1,
        size: "1024x1024",
        quality: "high",
        image: PNG_URL,
      });
    });

    it("sends several images as an array of data URLs", () => {
      const body = buildComfyRouterBody("gptImage", makeInput({ images: [PNG_URL, JPG_URL] }));
      expect(body.image).toEqual([PNG_URL, JPG_URL]);
    });

    it("omits the image field without references", () => {
      const body = buildComfyRouterBody("gptImage", makeInput());
      expect(body).not.toHaveProperty("image");
    });
  });

  describe("geminiImage", () => {
    it("builds inlineData parts and asks for TEXT and IMAGE modalities", () => {
      const body = buildComfyRouterBody(
        "geminiImage",
        makeInput({ images: [PNG_URL, JPG_URL], parameters: { aspectRatio: "16:9", imageSize: "2K" } })
      );

      expect(body).toEqual({
        contents: [
          {
            role: "user",
            parts: [
              { text: "a photo of a cat" },
              { inlineData: { mimeType: "image/png", data: PNG_B64 } },
              { inlineData: { mimeType: "image/jpeg", data: JPG_B64 } },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
        },
      });
    });

    it("leaves imageConfig out when no image parameters are set and skips http references", () => {
      const body = buildComfyRouterBody("geminiImage", makeInput({ images: [HTTP_URL] }));

      expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
      const contents = body.contents as Array<{ parts: unknown[] }>;
      expect(contents[0]!.parts).toEqual([{ text: "a photo of a cat" }]);
    });
  });

  describe("seedance", () => {
    it("labels the first and last frame with content roles", () => {
      const body = buildComfyRouterBody(
        "seedance",
        makeInput({
          images: [PNG_URL],
          dynamicInputs: { last_frame: JPG_URL },
          parameters: { duration: 5, ratio: "adaptive", generate_audio: true, seed: -1 },
        })
      );

      expect(body.content).toEqual([
        { type: "text", text: "a photo of a cat" },
        { type: "image_url", image_url: { url: PNG_URL }, role: "first_frame" },
        { type: "image_url", image_url: { url: JPG_URL }, role: "last_frame" },
      ]);
      expect(body).toMatchObject({ watermark: false, duration: 5, ratio: "adaptive", generate_audio: true, seed: -1 });
    });

    it("sends only the text part for text to video", () => {
      const body = buildComfyRouterBody("seedance", makeInput());
      expect(body.content).toEqual([{ type: "text", text: "a photo of a cat" }]);
    });
  });

  describe("veo", () => {
    it("sends frames as bytesBase64Encoded with their mime type", () => {
      const body = buildComfyRouterBody(
        "veo",
        makeInput({
          images: [PNG_URL],
          dynamicInputs: { last_frame: JPG_URL },
          parameters: { aspectRatio: "16:9", durationSeconds: 8, generateAudio: true },
        })
      );

      expect(body).toEqual({
        instances: [
          {
            prompt: "a photo of a cat",
            image: { bytesBase64Encoded: PNG_B64, mimeType: "image/png" },
            lastFrame: { bytesBase64Encoded: JPG_B64, mimeType: "image/jpeg" },
          },
        ],
        parameters: {
          sampleCount: 1,
          personGeneration: "allow_adult",
          aspectRatio: "16:9",
          durationSeconds: 8,
          generateAudio: true,
        },
      });
    });

    it("skips an http first frame, since Veo takes bytes only", () => {
      const body = buildComfyRouterBody("veo", makeInput({ images: [HTTP_URL] }));
      expect(body.instances).toEqual([{ prompt: "a photo of a cat" }]);
    });
  });

  describe("runwayGen4", () => {
    it("sends the first frame as promptImage with a fresh seed and defaults", () => {
      const body = buildComfyRouterBody("runwayGen4", makeInput({ images: [PNG_URL] }));

      expect(body.promptText).toBe("a photo of a cat");
      expect(body.promptImage).toBe(PNG_URL);
      expect(body.duration).toBe(5);
      expect(body.ratio).toBe("1280:720");
      expect(typeof body.seed).toBe("number");
      expect(Number.isInteger(body.seed)).toBe(true);
      expect(body.seed as number).toBeGreaterThanOrEqual(0);
      expect(body.seed as number).toBeLessThan(4294967295);
    });

    it("forwards duration and ratio and leaves promptImage undefined without a frame", () => {
      const body = buildComfyRouterBody(
        "runwayGen4",
        makeInput({ parameters: { duration: 10, ratio: "720:1280" } })
      );

      expect(body.promptImage).toBeUndefined();
      expect(body.duration).toBe(10);
      expect(body.ratio).toBe("720:1280");
    });
  });
});

describe("readComfyRouterResult", () => {
  it("flux: reads result.sample", () => {
    const found = readComfyRouterResult("flux2", {
      status: "Ready",
      result: { sample: "https://example.com/a.png" },
    });
    expect(found).toEqual({ source: "https://example.com/a.png" });
  });

  it("flux: throws with the BFL status when there is no sample", () => {
    expect(() => readComfyRouterResult("flux2", { status: "Content Moderated", result: null })).toThrow(
      "Black Forest Labs: Content Moderated"
    );
    expect(() => readComfyRouterResult("fluxKontext", { status: "Ready", result: {} })).toThrow(
      "No image in the FLUX result"
    );
  });

  it("gptImage: turns b64_json into a data URL in the output format", () => {
    expect(readComfyRouterResult("gptImage", { data: [{ b64_json: "abc" }], output_format: "webp" })).toEqual({
      source: "data:image/webp;base64,abc",
    });
    expect(readComfyRouterResult("gptImage", { data: [{ b64_json: "abc" }] })).toEqual({
      source: "data:image/png;base64,abc",
    });
    expect(() => readComfyRouterResult("gptImage", { data: [] })).toThrow("No image in the GPT Image result");
  });

  it("gemini: reads the first inlineData part", () => {
    const found = readComfyRouterResult("geminiImage", {
      candidates: [
        {
          content: {
            parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/jpeg", data: "xyz" } }],
          },
        },
      ],
    });
    expect(found).toEqual({ source: "data:image/jpeg;base64,xyz" });
  });

  it("gemini: surfaces the block reason when nothing came back", () => {
    expect(() =>
      readComfyRouterResult("geminiImage", { candidates: [], promptFeedback: { blockReason: "SAFETY" } })
    ).toThrow("Blocked: SAFETY");
  });

  it("kling: throws with task_status_msg when the task failed", () => {
    expect(() =>
      readComfyRouterResult("klingText", {
        data: { task_status: "failed", task_status_msg: "prompt rejected by moderation" },
      })
    ).toThrow("Kling: prompt rejected by moderation");
  });

  it("kling: reads the first video or image URL", () => {
    expect(
      readComfyRouterResult("klingText", {
        data: { task_status: "succeed", task_result: { videos: [{ url: "https://example.com/v.mp4" }] } },
      })
    ).toEqual({ source: "https://example.com/v.mp4" });
    expect(
      readComfyRouterResult("klingImage", {
        data: { task_status: "succeed", task_result: { images: [{ url: "https://example.com/i.png" }] } },
      })
    ).toEqual({ source: "https://example.com/i.png" });
  });

  it("veo: throws with the filter reasons when the output was filtered", () => {
    expect(() =>
      readComfyRouterResult("veo", {
        response: { videos: [], raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["violence", "celebrity"] },
      })
    ).toThrow("Veo filtered the output: violence, celebrity");
  });

  it("veo: inlines bytesBase64Encoded with the declared mime type", () => {
    expect(
      readComfyRouterResult("veo", {
        response: { videos: [{ bytesBase64Encoded: "AAAA", mimeType: "video/mp4" }] },
      })
    ).toEqual({ source: "data:video/mp4;base64,AAAA", mimeType: "video/mp4" });
  });

  it("wan: reads output.video_url and surfaces failures", () => {
    expect(
      readComfyRouterResult("wanVideo", {
        output: { task_status: "SUCCEEDED", video_url: "https://example.com/w.mp4" },
      })
    ).toEqual({ source: "https://example.com/w.mp4" });
    expect(() =>
      readComfyRouterResult("wanVideo", { output: { task_status: "FAILED", message: "quota exceeded" } })
    ).toThrow("Wan: quota exceeded");
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

describe("fetchComfyMediaResult download bounds", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const KLING_VIDEO = { data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example.com/out.bin" }] } } };

  function collectThen(media: Response, result: unknown = { status: "Ready", result: { sample: "https://cdn.example.com/out.bin" } }) {
    const collect = new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    global.fetch = vi.fn().mockResolvedValueOnce(collect).mockResolvedValueOnce(media) as unknown as typeof fetch;
  }

  it("inlines an image", async () => {
    collectThen(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "3" } }));
    const out = await fetchComfyMediaResult("t", "key", "bfl/flux-2-pro", "req", "image");
    expect(out.success).toBe(true);
    expect(out.outputs?.[0]?.data).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
  });

  it("returns the URL for a video above the inline limit without reading it", async () => {
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); } });
    const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
    collectThen(new Response(body, { status: 200, headers: { "Content-Type": "video/mp4", "Content-Length": String(30 * 1024 * 1024) } }), KLING_VIDEO);
    const out = await fetchComfyMediaResult("t", "key", "kling/kling-v3", "req", "video");
    expect(out.success).toBe(true);
    expect(out.outputs?.[0]).toEqual({ type: "video", data: "", url: "https://cdn.example.com/out.bin" });
    expect(cancel).toHaveBeenCalled();
    cancel.mockRestore();
  });

  it("stops reading an unsized video once it passes the inline limit", async () => {
    let served = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({ pull(controller) { served += 1; controller.enqueue(chunk); } });
    collectThen(new Response(body, { status: 200, headers: { "Content-Type": "video/mp4" } }), KLING_VIDEO);
    const out = await fetchComfyMediaResult("t", "key", "kling/kling-v3", "req", "video");
    expect(out.outputs?.[0]).toEqual({ type: "video", data: "", url: "https://cdn.example.com/out.bin" });
    expect(served).toBeLessThan(30);
  });
});
