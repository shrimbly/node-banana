import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationInput } from "@/lib/providers/types";
import {
  METASO_DEFAULT_BASE_URL,
  MetasoApiError,
  buildMetasoUrl,
  buildMetasoVideoRequest,
  checkMetasoTaskOnce,
  submitMetasoTask,
} from "../metaso";

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: {
      id: "MiniMax-H3",
      name: "MiniMax H3",
      description: null,
      provider: "metaso",
      capabilities: ["text-to-video", "image-to-video", "audio-to-video"],
    },
    prompt: "A cinematic ocean sunrise",
    parameters: { resolution: "768P", duration: 5, ratio: "16:9" },
    ...overrides,
  };
}

describe("metaso MiniMax-H3 V2 provider", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("normalizes the default and overridden base URL with one boundary slash", () => {
    expect(buildMetasoUrl("v2/video_generation")).toBe(
      "https://metaso.cn/api/minimax/v2/video_generation"
    );
    expect(buildMetasoUrl("/v2/video_generation", "https://example.com/root")).toBe(
      "https://example.com/root/v2/video_generation"
    );
    expect(buildMetasoUrl("v2/video_generation", "https://example.com/root/")).toBe(
      "https://example.com/root/v2/video_generation"
    );
    expect(METASO_DEFAULT_BASE_URL).toBe("https://metaso.cn/api/minimax/");
  });

  it("rejects invalid base URL configuration", () => {
    expect(() => buildMetasoUrl("v2/video_generation", "file:///tmp/api")).toThrow(
      "Invalid metaso API base URL"
    );
    expect(() => buildMetasoUrl("v2/video_generation", "https://user:secret@example.com/api")).toThrow(
      "Invalid metaso API base URL"
    );
    expect(() => buildMetasoUrl("v2/video_generation", "https://example.com/api?token=secret")).toThrow(
      "must not include query"
    );
  });

  it("builds a text-to-video V2 request", () => {
    expect(buildMetasoVideoRequest(input())).toEqual({
      model: "MiniMax-H3",
      content: [{ type: "text", text: "A cinematic ocean sunrise" }],
      resolution: "768P",
      duration: 5,
      ratio: "16:9",
    });
  });

  it("uses adaptive ratio for first and last frames", () => {
    const payload = buildMetasoVideoRequest(
      input({
        dynamicInputs: {
          first_frame: "https://cdn.example.com/first.png",
          last_frame: "https://cdn.example.com/last.png",
        },
        parameters: { resolution: "2K", duration: 8, ratio: "9:16" },
      })
    );

    expect(payload.ratio).toBe("adaptive");
    expect(payload.content).toEqual([
      { type: "text", text: "A cinematic ocean sunrise" },
      {
        type: "image_url",
        image_url: { url: "https://cdn.example.com/first.png" },
        role: "first_frame",
      },
      {
        type: "image_url",
        image_url: { url: "https://cdn.example.com/last.png" },
        role: "last_frame",
      },
    ]);
  });

  it("pairs a named last frame with an unnamed first-frame input", () => {
    const payload = buildMetasoVideoRequest(
      input({
        images: ["https://cdn.example.com/first.png"],
        dynamicInputs: { last_frame: "https://cdn.example.com/last.png" },
      })
    );

    expect(payload.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "first_frame" }),
        expect.objectContaining({ role: "last_frame" }),
      ])
    );
  });

  it("maps reference image, video, and audio inputs without dropping arrays", () => {
    const payload = buildMetasoVideoRequest(
      input({
        dynamicInputs: {
          reference_images: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.webp"],
          reference_videos: "https://cdn.example.com/reference.mp4",
          reference_audios: "data:audio/mp3;base64,AA==",
        },
        parameters: { resolution: "2K", duration: 15, ratio: "adaptive" },
      })
    );

    expect(payload.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image_url", role: "reference_image" }),
        expect.objectContaining({ type: "video_url", role: "reference_video" }),
        expect.objectContaining({ type: "audio_url", role: "reference_audio" }),
      ])
    );
  });

  it.each([
    ["missing prompt", input({ prompt: "", dynamicInputs: {} }), "Prompt is required"],
    ["invalid model", input({ model: { ...input().model, id: "MiniMax-H3-legacy" } }), "Unsupported metaso model"],
    ["duration below range", input({ parameters: { resolution: "768P", duration: 3, ratio: "16:9" } }), "duration must"],
    ["duration above range", input({ parameters: { resolution: "768P", duration: 16, ratio: "16:9" } }), "duration must"],
    ["invalid resolution", input({ parameters: { resolution: "1080P", duration: 5, ratio: "16:9" } }), "resolution must"],
    ["adaptive text ratio", input({ parameters: { resolution: "768P", duration: 5, ratio: "adaptive" } }), "concrete ratio"],
    ["last without first", input({ dynamicInputs: { last_frame: "https://cdn.example.com/last.png" } }), "requires first_frame"],
    ["non-public media URL", input({ dynamicInputs: { first_frame: "http://127.0.0.1/frame.png" } }), "Invalid public image URL"],
    [
      "mixed frame and reference roles",
      input({ dynamicInputs: { first_frame: "https://cdn.example.com/first.png", reference_images: "https://cdn.example.com/ref.png" } }),
      "cannot be combined",
    ],
    [
      "unsupported media type",
      input({ dynamicInputs: { reference_audios: "data:audio/ogg;base64,AA==" } }),
      "Unsupported audio MIME type",
    ],
  ])("rejects %s", (_name, request, message) => {
    expect(() => buildMetasoVideoRequest(request as GenerationInput)).toThrow(message as string);
  });

  it("submits with bearer auth and parses task_id", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task_id: "task-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(submitMetasoTask("req", "secret-key", input())).resolves.toEqual({ taskId: "task-123" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://metaso.cn/api/minimax/v2/video_generation",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer secret-key",
          "Content-Type": "application/json",
        },
      })
    );
  });

  it("maps structured upstream errors without exposing the bearer key", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Too many requests", http_code: "429" },
          request_id: "request-7",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      )
    );

    const error = await submitMetasoTask("req", "never-log-me", input()).catch((value) => value);
    expect(error).toBeInstanceOf(MetasoApiError);
    expect(error).toMatchObject({ status: 429, errorType: "rate_limit_error", requestId: "request-7" });
    expect(error.message).toBe("Too many requests");
    expect(error.message).not.toContain("never-log-me");
  });

  it("normalizes queued, running, failed, and succeeded task states", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "1", status: "queued" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "1", status: "running" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "1", status: "failed", error: { code: "2013", message: "Rejected" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "1", status: "succeeded", content: { url: "https://cdn.metaso.cn/result.mp4" } } }), { status: 200 }));

    await expect(checkMetasoTaskOnce("req", "key", "1")).resolves.toEqual({ status: "processing" });
    await expect(checkMetasoTaskOnce("req", "key", "1")).resolves.toEqual({ status: "processing" });
    await expect(checkMetasoTaskOnce("req", "key", "1")).resolves.toEqual({ status: "failed", error: "Rejected" });
    await expect(checkMetasoTaskOnce("req", "key", "1")).resolves.toEqual({
      status: "completed",
      url: "https://cdn.metaso.cn/result.mp4",
    });
    expect(mockFetch.mock.calls[0][0]).toBe("https://metaso.cn/api/minimax/v2/query/video_generation/1");
  });

  it("rejects malformed success responses and unsafe output URLs", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: "succeeded" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { status: "succeeded", content: { url: "file:///tmp/result.mp4" } } }), { status: 200 }));

    await expect(checkMetasoTaskOnce("req", "key", "1")).rejects.toThrow("did not include content.url");
    await expect(checkMetasoTaskOnce("req", "key", "1")).rejects.toThrow("Invalid metaso output URL");
  });
});
