import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithAtlas } from "../atlas";
import type { GenerationInput } from "@/lib/providers/types";

/**
 * Tests for the Atlas provider payload contract.
 *
 * Atlas differs from the other async providers in three ways that are easy to
 * get wrong, so each one is pinned here:
 *   - the model id goes in the request BODY (WaveSpeed puts it in the path)
 *   - input images travel in ONE newline-separated `images` string
 *   - video requests need an explicit shot_type, and Seedance generates audio
 *     by default (a blocked score fails the whole task), so both get defaults
 */

let capturedSubmitBody: Record<string, unknown> | null = null;
let capturedSubmitUrl = "";
let capturedHeaders: Record<string, string> = {};

function makeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: {
      id: "bytedance/seedream-v4",
      name: "Seedream v4",
      description: null,
      provider: "atlas",
      capabilities: ["text-to-image"],
    },
    prompt: "a photo of a cat",
    images: [],
    parameters: {},
    ...overrides,
  };
}

function createMockFetch(outputContentType = "image/png") {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    if (urlStr.includes("/generateImage") || urlStr.includes("/generateVideo")) {
      capturedSubmitUrl = urlStr;
      capturedSubmitBody = JSON.parse(String(init?.body));
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, data: { id: "pred-1", status: "processing" } }),
      } as Response;
    }

    if (urlStr.includes("/prediction/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          data: { id: "pred-1", status: "completed", outputs: ["https://cdn.example/out.bin"] },
        }),
      } as Response;
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": outputContentType, "content-length": "8" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
    } as unknown as Response;
  });
}

describe("generateWithAtlas", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    capturedSubmitBody = null;
    capturedSubmitUrl = "";
    capturedHeaders = {};
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("sends the model id in the body and hits the image endpoint", async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    const result = await generateWithAtlas("req-1", "test-key", makeInput());

    expect(result.success).toBe(true);
    expect(capturedSubmitUrl).toContain("/generateImage");
    expect(capturedSubmitBody?.model).toBe("bytedance/seedream-v4");
    expect(capturedSubmitBody?.prompt).toBe("a photo of a cat");
    // api.atlascloud.ai rejects a default User-Agent with 403 (error code 1010)
    expect(capturedHeaders["User-Agent"]).toBeTruthy();
  });

  it("keeps the prompt when dynamicInputs are present and joins images with newlines", async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    const result = await generateWithAtlas(
      "req-2",
      "test-key",
      makeInput({
        model: {
          id: "bytedance/seedream-v4/edit",
          name: "Seedream v4 Edit",
          description: null,
          provider: "atlas",
          capabilities: ["image-to-image"],
        },
        dynamicInputs: { images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] },
      })
    );

    expect(result.success).toBe(true);
    expect(capturedSubmitBody?.prompt).toBe("a photo of a cat");
    expect(capturedSubmitBody?.images).toBe("data:image/png;base64,AAA\ndata:image/png;base64,BBB");
  });

  it("defaults shot_type and generate_audio for video models", async () => {
    global.fetch = createMockFetch("video/mp4") as unknown as typeof fetch;

    const result = await generateWithAtlas(
      "req-3",
      "test-key",
      makeInput({
        model: {
          id: "bytedance/seedance-2.0/text-to-video",
          name: "Seedance 2.0",
          description: null,
          provider: "atlas",
          capabilities: ["text-to-video"],
        },
      })
    );

    expect(result.success).toBe(true);
    expect(capturedSubmitUrl).toContain("/generateVideo");
    // An empty shot_type is rejected by the API
    expect(capturedSubmitBody?.shot_type).toBe("single");
    // Seedance 2.0 generates synced audio by default and a blocked score fails
    // the whole task, so this stays off unless asked for
    expect(capturedSubmitBody?.generate_audio).toBe(false);
    expect(result.outputs?.[0].type).toBe("video");
  });

  it("normalises size to the asterisk form and drops it for nano-banana", async () => {
    global.fetch = createMockFetch() as unknown as typeof fetch;

    await generateWithAtlas(
      "req-4",
      "test-key",
      makeInput({ parameters: { size: "1280x720" } })
    );
    expect(capturedSubmitBody?.size).toBe("1280*720");

    await generateWithAtlas(
      "req-5",
      "test-key",
      makeInput({
        model: {
          id: "google/nano-banana-pro/text-to-image",
          name: "Nano Banana Pro",
          description: null,
          provider: "atlas",
          capabilities: ["text-to-image"],
        },
        parameters: { size: "1280x720", aspect_ratio: "16:9" },
      })
    );
    // Measured: this family ignores size and honours aspect_ratio
    expect(capturedSubmitBody?.size).toBeUndefined();
    expect(capturedSubmitBody?.aspect_ratio).toBe("16:9");
    // Two sequential generations, each waiting one poll interval
  }, 20000);

  it("surfaces a failed prediction", async () => {
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/generateImage")) {
        return { ok: true, status: 200, json: async () => ({ data: { id: "pred-9" } }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { status: "failed", error: "content policy" } }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await generateWithAtlas("req-6", "test-key", makeInput());
    expect(result.success).toBe(false);
    expect(result.error).toContain("content policy");
  });
});
