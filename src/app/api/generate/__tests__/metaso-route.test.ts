import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as generate } from "../route";
import { POST as poll } from "../poll/route";

const originalEnv = { ...process.env };

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

describe("metaso public generation routes", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.METASO_API_KEY;
    delete process.env.METASO_API_BASE_URL;
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns 401 when the public generate route has no metaso key", async () => {
    const response = await generate(
      request({
        prompt: "A sunrise",
        mediaType: "video",
        selectedModel: { provider: "metaso", modelId: "MiniMax-H3", displayName: "MiniMax H3" },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: expect.stringContaining("METASO_API_KEY") });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("submits through /api/generate and returns client polling metadata", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task_id: "metaso-task-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await generate(
      request(
        {
          prompt: "A sunrise",
          mediaType: "video",
          parameters: { resolution: "2K", duration: 4, ratio: "16:9" },
          selectedModel: { provider: "metaso", modelId: "MiniMax-H3", displayName: "MiniMax H3" },
        },
        { "X-Metaso-API-Key": "test-key" }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      polling: true,
      taskId: "metaso-task-1",
      pollProvider: "metaso",
      pollModelId: "MiniMax-H3",
      pollModelName: "MiniMax H3",
      pollMediaType: "video",
    });
    expect(mockFetch.mock.calls[0][0]).toBe("https://metaso.cn/api/minimax/v2/video_generation");
  });

  it("preserves an upstream error status and message", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down", http_code: "429" } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await generate(
      request(
        {
          prompt: "A sunrise",
          mediaType: "video",
          selectedModel: { provider: "metaso", modelId: "MiniMax-H3", displayName: "MiniMax H3" },
        },
        { "X-Metaso-API-Key": "test-key" }
      )
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: "Slow down" });
  });

  it("returns polling metadata for queued tasks", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task: { id: "task-1", status: "queued" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await poll(
      request(
        {
          taskId: "task-1",
          provider: "metaso",
          modelId: "MiniMax-H3",
          modelName: "MiniMax H3",
          mediaType: "video",
        },
        { "X-Metaso-API-Key": "test-key" }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, polling: true, pollProvider: "metaso" });
  });

  it("returns the time-limited video URL for a succeeded task", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ task: { id: "task-1", status: "succeeded", content: { url: "https://cdn.metaso.cn/output.mp4" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await poll(
      request(
        {
          taskId: "task-1",
          provider: "metaso",
          modelId: "MiniMax-H3",
          modelName: "MiniMax H3",
          mediaType: "video",
        },
        { "X-Metaso-API-Key": "test-key" }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      videoUrl: "https://cdn.metaso.cn/output.mp4",
      contentType: "video",
    });
  });
});
