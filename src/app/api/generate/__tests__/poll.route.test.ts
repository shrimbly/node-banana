import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "../poll/route";

// Store original env and fetch
const originalEnv = { ...process.env };
const originalFetch = global.fetch;

// Mock fetch for provider API calls
const mockFetch = vi.fn();

// Helper to create mock NextRequest for POST
function createMockPostRequest(
  body: unknown,
  headers?: Record<string, string>
): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

// A JSON response as the Router returns it
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  };
}

// A binary response for the media download
function bytesResponse(bytes: Uint8Array, contentType: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes.byteLength) }),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

const COMFY_HEADERS = { "X-Comfy-Router-Key": "test-comfy-key" };

const comfyPoll = {
  taskId: "req_1",
  provider: "comfy",
  modelId: "bfl/flux-2-pro",
  modelName: "FLUX.2 Pro",
  mediaType: "image",
};

describe("/api/generate/poll route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    delete process.env.KIE_API_KEY;
    delete process.env.COMFY_API_KEY;
    delete process.env.COMFY_CLOUD_API_KEY;
    global.fetch = mockFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("should return 400 when taskId or provider is missing", async () => {
    const response = await POST(createMockPostRequest({ provider: "comfy" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("taskId and provider are required");
  });

  it("should return 400 for an unknown provider", async () => {
    const response = await POST(createMockPostRequest({ ...comfyPoll, provider: "nope" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Unsupported poll provider: nope");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("comfy", () => {
    it("should return 401 when no Comfy API key is configured", async () => {
      const response = await POST(createMockPostRequest(comfyPoll));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ success: false, error: "Comfy API key not configured" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should pass the Router's Retry-After through as retryAfterMs", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "IN_QUEUE", queue_position: 4 }, 200, { "Retry-After": "7" }));
      const response = await POST(createMockPostRequest(comfyPoll, COMFY_HEADERS));
      const data = await response.json();
      expect(data.polling).toBe(true);
      expect(data.retryAfterMs).toBe(7000);
    });

    it("should return the polling envelope while the task is processing", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS", queue_position: 2 }));

      const response = await POST(createMockPostRequest(comfyPoll, COMFY_HEADERS));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        polling: true,
        taskId: "req_1",
        pollProvider: "comfy",
        pollModelId: "bfl/flux-2-pro",
        pollModelName: "FLUX.2 Pro",
        pollMediaType: "image",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/req_1/status");
      expect(init.headers["X-API-Key"]).toBe("test-comfy-key");
    });

    it("should collect the result and return the image when the task is completed", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
        .mockResolvedValueOnce(jsonResponse({ status: "Ready", result: { sample: "https://example.com/a.png" } }))
        .mockResolvedValueOnce(bytesResponse(png, "image/png"));

      const response = await POST(createMockPostRequest(comfyPoll, COMFY_HEADERS));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.contentType).toBe("image");
      expect(data.image).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[0][0]).toBe("https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/req_1/status");
      expect(mockFetch.mock.calls[1][0]).toBe("https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/req_1");
      expect(mockFetch.mock.calls[1][1].headers["X-API-Key"]).toBe("test-comfy-key");
      expect(mockFetch.mock.calls[2][0]).toBe("https://example.com/a.png");
    });

    it("should return 500 with the model name when the task failed", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "COMPLETED", error_type: "content_moderation" }));

      const response = await POST(createMockPostRequest(comfyPoll, COMFY_HEADERS));
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toEqual({ success: false, error: "FLUX.2 Pro: Comfy Router: content_moderation" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should return 500 when the result has expired", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(null, 410));

      const response = await POST(createMockPostRequest(comfyPoll, COMFY_HEADERS));
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("FLUX.2 Pro: Comfy Router result expired");
    });

    it("should return 500 when the collected result carries the partner's failure", async () => {
      process.env.COMFY_API_KEY = "env-comfy-key";
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
        .mockResolvedValueOnce(jsonResponse({ status: "Content Moderated", result: null }));

      const response = await POST(createMockPostRequest(comfyPoll));
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Black Forest Labs: Content Moderated");
      expect(mockFetch.mock.calls[0][1].headers["X-API-Key"]).toBe("env-comfy-key");
    });
  });
});
