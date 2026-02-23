import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Use vi.hoisted to define mocks that work with hoisted vi.mock
const { mockGenerateContent, MockGoogleGenAI } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();

  // Use a class to properly support `new` keyword
  class MockGoogleGenAI {
    apiKey: string;
    models = {
      generateContent: mockGenerateContent,
    };

    constructor(config: { apiKey: string }) {
      this.apiKey = config.apiKey;
      // Track calls to constructor
      MockGoogleGenAI.lastCalledWith = config;
      MockGoogleGenAI.callCount++;
    }

    static lastCalledWith: { apiKey: string } | null = null;
    static callCount = 0;
    static reset() {
      MockGoogleGenAI.lastCalledWith = null;
      MockGoogleGenAI.callCount = 0;
    }
  }

  return { mockGenerateContent, MockGoogleGenAI };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: MockGoogleGenAI,
}));

// Mock image upload utilities (not used in Gemini path but imported)
vi.mock("@/lib/images", () => ({
  uploadImageForUrl: vi.fn(),
  shouldUseImageUrl: vi.fn().mockReturnValue(false),
  deleteImages: vi.fn(),
}));

import { POST, clearFalInputMappingCache } from "../route";

// Store original env
const originalEnv = { ...process.env };

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

// Helper to create successful Gemini response with image
function createGeminiImageResponse(mimeType = "image/png", data = "base64ImageData") {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType,
                data,
              },
            },
          ],
        },
      },
    ],
  };
}

// Helper to create Gemini response with text only (no image)
function createGeminiTextResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text,
            },
          ],
        },
      },
    ],
  };
}

describe("/api/generate route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockGoogleGenAI.reset();
    // Reset env to original
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Gemini provider", () => {
    it("should generate image successfully with prompt only", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "A beautiful sunset over mountains",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.image).toBe("data:image/png;base64,base64ImageData");
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-3-pro-image-preview",
          contents: [
            {
              role: "user",
              parts: [{ text: "A beautiful sunset over mountains" }],
            },
          ],
        })
      );
    });

    it("should generate image with prompt and input images", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Transform this image to oil painting style",
        images: ["data:image/png;base64,inputImageData"],
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Transform this image to oil painting style" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "inputImageData",
                  },
                },
              ],
            },
          ],
        })
      );
    });

    it("should apply aspect ratio config", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "A landscape photo",
        model: "nano-banana-pro",
        aspectRatio: "16:9",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            imageConfig: { aspectRatio: "16:9" },
          }),
        })
      );
    });

    it("should apply resolution config for nano-banana-pro model", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "High resolution image",
        model: "nano-banana-pro",
        resolution: "1024x1024",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            imageConfig: { imageSize: "1024x1024" },
          }),
        })
      );
    });

    it("should apply both aspectRatio and resolution for nano-banana-pro", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "High resolution landscape",
        model: "nano-banana-pro",
        aspectRatio: "16:9",
        resolution: "1024x1024",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            imageConfig: {
              aspectRatio: "16:9",
              imageSize: "1024x1024",
            },
          }),
        })
      );
    });

    it("should apply Google Search tool for nano-banana-pro", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Latest technology trends",
        model: "nano-banana-pro",
        useGoogleSearch: true,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [{ googleSearch: {} }],
        })
      );
    });

    it("should NOT apply Google Search tool for nano-banana model", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana",
        useGoogleSearch: true,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // For nano-banana, tools should not be included even if useGoogleSearch is true
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.not.objectContaining({
          tools: expect.anything(),
        })
      );
    });

    it("should use nano-banana-pro as default model", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Test prompt without model specified",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-3-pro-image-preview", // nano-banana-pro maps to this
        })
      );
    });

    it("should use X-Gemini-API-Key header over env var", async () => {
      process.env.GEMINI_API_KEY = "env-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          model: "nano-banana-pro",
        },
        { "X-Gemini-API-Key": "header-gemini-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Verify GoogleGenAI was called with header key (takes precedence)
      expect(MockGoogleGenAI.lastCalledWith).toEqual({
        apiKey: "header-gemini-key",
      });
    });

    it("should return 500 when API key missing", async () => {
      delete process.env.GEMINI_API_KEY;

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("API key not configured");
    });

    it("should return 429 on rate limit errors", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockRejectedValueOnce(new Error("429 Resource exhausted"));

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Rate limit reached. Please wait and try again.");
    });

    it("should handle no candidates in response", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        candidates: [],
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No response from AI model");
    });

    it("should handle null candidates in response", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        candidates: null,
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No response from AI model");
    });

    it("should handle text-only response (no image)", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(
        createGeminiTextResponse("I cannot generate that image because...")
      );

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Model returned text instead of image");
      expect(data.error).toContain("I cannot generate that image");
    });

    it("should handle response with no parts", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: null,
            },
          },
        ],
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No content in response");
    });

    it("should handle response with empty parts array", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [],
            },
          },
        ],
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("No image in response");
    });

    it("should handle generic API errors", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockRejectedValueOnce(new Error("Internal server error"));

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Internal server error");
    });

    it("should use correct model mapping for nano-banana", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-2.5-flash-image",
        })
      );
    });

    it("should extract MIME type from data URL correctly", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Edit this JPEG",
        images: ["data:image/jpeg;base64,jpegImageData"],
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Edit this JPEG" },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: "jpegImageData",
                  },
                },
              ],
            },
          ],
        })
      );
    });

    it("should fall back to image/png for raw base64", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Edit this image",
        images: ["rawBase64DataWithoutPrefix"],
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Edit this image" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "rawBase64DataWithoutPrefix",
                  },
                },
              ],
            },
          ],
        })
      );
    });
  });

  describe("Input validation", () => {
    it("should reject request with no prompt, images, or dynamic inputs", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      const request = createMockPostRequest({
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Prompt or image input is required");
    });

    it("should accept request with only images (image-to-image)", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        images: ["data:image/png;base64,imageOnlyData"],
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Gemini is called with undefined prompt (which becomes empty text)
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it("should accept request with dynamicInputs containing prompt", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        dynamicInputs: {
          prompt: "Dynamic prompt text",
        },
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should accept request with dynamicInputs containing image frames", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        dynamicInputs: {
          first_frame: "data:image/png;base64,firstFrameData",
          last_frame: "data:image/png;base64,lastFrameData",
        },
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should accept request with dynamicInputs containing image_url", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        dynamicInputs: {
          image_url: "data:image/png;base64,imageUrlData",
        },
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should handle multiple images in request", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Combine these images",
        images: [
          "data:image/png;base64,image1Data",
          "data:image/jpeg;base64,image2Data",
          "data:image/webp;base64,image3Data",
        ],
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Combine these images" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "image1Data",
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: "image2Data",
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/webp",
                    data: "image3Data",
                  },
                },
              ],
            },
          ],
        })
      );
    });
  });

  describe("Provider routing", () => {
    it("should route to Gemini when no selectedModel provided", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Gemini mock should have been called
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it("should route to Gemini when selectedModel.provider is gemini", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(createGeminiImageResponse());

      const request = createMockPostRequest({
        prompt: "Test prompt",
        model: "nano-banana-pro",
        selectedModel: {
          provider: "gemini",
          modelId: "gemini-3-pro-image-preview",
          displayName: "Gemini 3 Pro",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it("should return 401 for Replicate provider without API key", async () => {
      delete process.env.REPLICATE_API_KEY;

      const request = createMockPostRequest({
        prompt: "Test prompt",
        selectedModel: {
          provider: "replicate",
          modelId: "stability-ai/sdxl",
          displayName: "SDXL",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Replicate API key not configured");
    });
  });

  describe("Response handling", () => {
    it("should return proper response structure with image", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      mockGenerateContent.mockResolvedValueOnce(
        createGeminiImageResponse("image/jpeg", "jpegOutputData")
      );

      const request = createMockPostRequest({
        prompt: "Generate a photo",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toMatchObject({
        success: true,
        image: "data:image/jpeg;base64,jpegOutputData",
      });
    });

    it("should handle response with default MIME type", async () => {
      process.env.GEMINI_API_KEY = "test-gemini-key";

      // Response with no mimeType specified
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: "noMimeTypeData",
                    // mimeType intentionally omitted
                  },
                },
              ],
            },
          },
        ],
      });

      const request = createMockPostRequest({
        prompt: "Generate image",
        model: "nano-banana-pro",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      // Should default to image/png
      expect(data.image).toBe("data:image/png;base64,noMimeTypeData");
    });
  });

  describe("Replicate provider", () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = mockFetch;
      mockFetch.mockReset();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("should generate image successfully via Replicate", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "starting",
        }),
      });

      // Poll prediction (succeeded immediately)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "A beautiful landscape",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.image).toContain("data:image/png;base64,");
      expect(data.contentType).toBe("image");

      // Verify API key was passed correctly
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("replicate.com/v1/models/stability-ai/sdxl"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-replicate-key",
          }),
        })
      );
    });

    it("should generate video successfully via Replicate", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version456", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction456",
          status: "starting",
        }),
      });

      // Poll prediction (succeeded)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction456",
          status: "succeeded",
          output: ["https://replicate.delivery/output.mp4"],
        }),
      });

      // Fetch output media (video)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
      });

      const request = createMockPostRequest(
        {
          prompt: "A cinematic video",
          selectedModel: {
            provider: "replicate",
            modelId: "luma/ray",
            displayName: "Luma Ray",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.video).toContain("data:video/mp4;base64,");
      expect(data.contentType).toBe("video");
    });

    it("should return 401 when Replicate API key missing", async () => {
      delete process.env.REPLICATE_API_KEY;

      const request = createMockPostRequest({
        prompt: "Test prompt",
        selectedModel: {
          provider: "replicate",
          modelId: "stability-ai/sdxl",
          displayName: "SDXL",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Replicate API key not configured");
    });

    it("should handle rate limit (429) from Replicate", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction returns 429
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve(JSON.stringify({ detail: "Rate limit exceeded" })),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Rate limit exceeded");
    });

    it("should handle prediction failure", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "starting",
        }),
      });

      // Poll prediction (failed)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "failed",
          error: "NSFW content detected",
        }),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("NSFW content detected");
    });

    it("should handle prediction timeout (5 min max)", async () => {
      vi.useFakeTimers();

      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "starting",
        }),
      });

      // Repeatedly return "processing" status
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "processing",
        }),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      // Start the POST request
      const responsePromise = POST(request);

      // Advance time past the 5-minute timeout
      // We need to run pending timers multiple times to simulate polling
      for (let i = 0; i < 310; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      const response = await responsePromise;
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("timed out");

      vi.useRealTimers();
    });

    it("should poll for prediction completion", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "starting",
        }),
      });

      // Poll 1: still starting
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "starting",
        }),
      });

      // Poll 2: processing
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "processing",
        }),
      });

      // Poll 3: succeeded
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify polling occurred (model fetch + create + 3 polls + media fetch = 6 calls)
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it("should return video URL for large videos (>20MB)", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "starting",
        }),
      });

      // Poll prediction (succeeded)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/large-video.mp4"],
        }),
      });

      // Fetch output media (large video > 20MB)
      const largeBuffer = new ArrayBuffer(25 * 1024 * 1024); // 25MB
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: () => Promise.resolve(largeBuffer),
      });

      const request = createMockPostRequest(
        {
          prompt: "Generate a long video",
          selectedModel: {
            provider: "replicate",
            modelId: "luma/ray",
            displayName: "Luma Ray",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.videoUrl).toBe("https://replicate.delivery/large-video.mp4");
      expect(data.video).toBeUndefined();
      expect(data.contentType).toBe("video");
    });

    it("should pass dynamicInputs to prediction input", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction - capture the request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
          dynamicInputs: {
            prompt: "Dynamic prompt from connection",
            image_url: "data:image/png;base64,testImageData",
            guidance_scale: "7.5",
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify dynamicInputs were passed to prediction
      const createPredictionCall = mockFetch.mock.calls[1];
      const requestBody = JSON.parse(createPredictionCall[1].body);
      expect(requestBody.input).toEqual(
        expect.objectContaining({
          prompt: "Dynamic prompt from connection",
          image_url: "data:image/png;base64,testImageData",
          guidance_scale: "7.5",
        })
      );
    });

    it("should wrap Replicate dynamicInputs in array when schema type is 'array'", async () => {
      // Model info fetch - with schema showing image_urls has type: "array"
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: {
            id: "version123",
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    properties: {
                      image_urls: { type: "array", items: { type: "string" } },
                      prompt: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "replicate",
            modelId: "some-model/with-array-input",
            displayName: "Array Input Model",
          },
          dynamicInputs: {
            prompt: "Test prompt",
            image_urls: "data:image/png;base64,singleImage",  // Single string sent
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify image_urls was wrapped in array because schema says type: "array"
      const createPredictionCall = mockFetch.mock.calls[1];
      const requestBody = JSON.parse(createPredictionCall[1].body);
      expect(requestBody.input.image_urls).toEqual(["data:image/png;base64,singleImage"]);
      expect(requestBody.input.prompt).toBe("Test prompt");
    });

    it("should unwrap Replicate dynamicInputs array to single value when schema type is NOT 'array'", async () => {
      // Model info fetch - with schema showing image_url has type: "string" (NOT array)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: {
            id: "version123",
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    properties: {
                      image_url: { type: "string" },  // Single string, not array
                      prompt: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "replicate",
            modelId: "some-model/with-string-input",
            displayName: "String Input Model",
          },
          dynamicInputs: {
            prompt: "Test prompt",
            image_url: ["data:image/png;base64,image1", "data:image/png;base64,image2"],  // Array sent for string param
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Verify image_url was unwrapped to first element because schema says type: "string"
      const createPredictionCall = mockFetch.mock.calls[1];
      const requestBody = JSON.parse(createPredictionCall[1].body);
      expect(requestBody.input.image_url).toBe("data:image/png;base64,image1");
      expect(Array.isArray(requestBody.input.image_url)).toBe(false);
      expect(requestBody.input.prompt).toBe("Test prompt");
    });

    it("should use env var API key when header not provided", async () => {
      process.env.REPLICATE_API_KEY = "env-replicate-key";

      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        selectedModel: {
          provider: "replicate",
          modelId: "stability-ai/sdxl",
          displayName: "SDXL",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify env var key was used
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("replicate.com/v1/models"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer env-replicate-key",
          }),
        })
      );
    });

    it("should pass parameters to prediction input", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
          parameters: {
            seed: 42,
            num_inference_steps: 30,
            guidance_scale: 7.5,
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify parameters were passed to prediction
      const createPredictionCall = mockFetch.mock.calls[1];
      const requestBody = JSON.parse(createPredictionCall[1].body);
      expect(requestBody.input).toEqual(
        expect.objectContaining({
          seed: 42,
          num_inference_steps: 30,
          guidance_scale: 7.5,
        })
      );
    });

    it("should merge parameters with dynamicInputs (dynamicInputs take precedence)", async () => {
      // Model info fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          latest_version: { id: "version123", openapi_schema: {} },
        }),
      });

      // Create prediction
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: "prediction123",
          status: "succeeded",
          output: ["https://replicate.delivery/output.png"],
        }),
      });

      // Fetch output media
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      });

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "replicate",
            modelId: "stability-ai/sdxl",
            displayName: "SDXL",
          },
          parameters: {
            seed: 42,
            guidance_scale: 7.5,
          },
          dynamicInputs: {
            prompt: "Dynamic prompt",
            guidance_scale: "10.0", // Should override parameters
          },
        },
        { "X-Replicate-API-Key": "test-replicate-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify dynamicInputs override parameters
      const createPredictionCall = mockFetch.mock.calls[1];
      const requestBody = JSON.parse(createPredictionCall[1].body);
      expect(requestBody.input).toEqual(
        expect.objectContaining({
          seed: 42,
          prompt: "Dynamic prompt",
          guidance_scale: "10.0", // dynamicInputs value
        })
      );
    });
  });

  describe("fal.ai provider", () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = mockFetch;
      mockFetch.mockReset();
      clearFalInputMappingCache();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    // Helper: mock the fal queue flow (submit → poll COMPLETED → fetch result → fetch media)
    function mockFalQueueSuccess(resultPayload: Record<string, unknown>, mediaContentType: string, mediaSize: number) {
      // Queue submit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "test-req-id" }),
      });
      // Status poll → COMPLETED
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "COMPLETED" }),
      });
      // Result fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(resultPayload),
      });
      // Media fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": mediaContentType }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(mediaSize)),
      });
    }

    // Helper: mock two-step CDN upload for a base64 image
    // Step 1: POST initiate → { upload_url, file_url }
    // Step 2: PUT binary data → ok
    function mockFalCdnUpload(cdnUrl = "https://fal.ai/cdn/uploaded.png") {
      // Initiate upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upload_url: "https://fal.ai/cdn/put-target", file_url: cdnUrl }),
      });
      // PUT binary data
      mockFetch.mockResolvedValueOnce({
        ok: true,
      });
    }

    it("should generate image successfully via fal.ai (images array response)", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "A beautiful landscape",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.image).toContain("data:image/png;base64,");
      expect(data.contentType).toBe("image");

      // Verify API key was passed correctly (check queue submit call, which is the 2nd call after schema fetch)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("queue.fal.run/fal-ai/flux/schnell"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Key test-fal-key",
          }),
        })
      );
    });

    it("should generate video successfully via fal.ai (video object response)", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { video: { url: "https://fal.media/output.mp4" } },
        "video/mp4",
        2048
      );

      const request = createMockPostRequest(
        {
          prompt: "A cinematic video",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/runway-gen3",
            displayName: "Runway Gen3",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.video).toContain("data:video/mp4;base64,");
      expect(data.contentType).toBe("video");
    });

    it("should proceed without API key (rate-limited)", async () => {
      delete process.env.FAL_API_KEY;

      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://example.com/image.png" }] },
        "image/png",
        8
      );

      const request = createMockPostRequest({
        prompt: "A beautiful landscape",
        selectedModel: {
          provider: "fal",
          modelId: "fal-ai/flux/schnell",
          displayName: "Flux Schnell",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      // Should proceed without key (no 401 early return)
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should handle rate limit (429) with API key", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue submit returns 429
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve(JSON.stringify({ detail: "Rate limit exceeded" })),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Rate limit exceeded");
      expect(data.error).toContain("Try again in a moment");
    });

    it("should handle rate limit (429) without API key", async () => {
      delete process.env.FAL_API_KEY;

      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue submit returns 429 since no auth
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve(JSON.stringify({ detail: "Rate limit exceeded" })),
      });

      const request = createMockPostRequest({
        prompt: "Test prompt",
        selectedModel: {
          provider: "fal",
          modelId: "fal-ai/flux/schnell",
          displayName: "Flux Schnell",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      // Without API key, request proceeds but may get rate-limited by fal.ai
      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Rate limit exceeded");
    });

    it("should handle image object response format", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result (image object) → media
      mockFalQueueSuccess(
        { image: { url: "https://fal.media/output.png" } },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "A beautiful landscape",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/some-model",
            displayName: "Some Model",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.image).toContain("data:image/png;base64,");
    });

    it("should handle output string response format", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result (output string) → media
      mockFalQueueSuccess(
        { output: "https://fal.media/output.png" },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "A beautiful landscape",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/another-model",
            displayName: "Another Model",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.image).toContain("data:image/png;base64,");
    });

    it("should return video URL for large videos (>20MB)", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media (large video)
      const largeBuffer = new ArrayBuffer(25 * 1024 * 1024); // 25MB
      // Queue submit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "test-req-id" }),
      });
      // Status poll → COMPLETED
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "COMPLETED" }),
      });
      // Result fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ video: { url: "https://fal.media/large-video.mp4" } }),
      });
      // Media fetch (large video > 20MB)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: () => Promise.resolve(largeBuffer),
      });

      const request = createMockPostRequest(
        {
          prompt: "Generate a long video",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/runway-gen3",
            displayName: "Runway Gen3",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.videoUrl).toBe("https://fal.media/large-video.mp4");
      expect(data.video).toBeUndefined();
      expect(data.contentType).toBe("video");
    });

    it("should filter empty dynamicInputs values", async () => {
      // Schema fetch (for array type detection with dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // CDN upload for tail_image_url (base64 data URI)
      mockFalCdnUpload("https://fal.ai/cdn/tail.png");

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
          dynamicInputs: {
            prompt: "Valid prompt",
            image_url: "", // Empty - should be filtered
            tail_image_url: "data:image/png;base64,tailData",
            empty_field: "", // Empty - should be filtered
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Find the queue submit call (the one to queue.fal.run)
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      expect(requestBody).toEqual({
        prompt: "Valid prompt",
        tail_image_url: "https://fal.ai/cdn/tail.png", // Uploaded to CDN
      });
      expect(requestBody).not.toHaveProperty("image_url");
      expect(requestBody).not.toHaveProperty("empty_field");
    });

    it("should pass dynamicInputs to fal.ai request", async () => {
      // Schema fetch (for array type detection with dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // CDN upload for image_url (base64 data URI)
      mockFalCdnUpload("https://fal.ai/cdn/uploaded.png");

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
          dynamicInputs: {
            prompt: "Dynamic prompt from connection",
            image_url: "data:image/png;base64,testImageData",
            num_inference_steps: "25",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Find the queue submit call
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      expect(requestBody).toEqual(
        expect.objectContaining({
          prompt: "Dynamic prompt from connection",
          image_url: "https://fal.ai/cdn/uploaded.png", // Uploaded to CDN
          num_inference_steps: "25",
        })
      );
    });

    it("should use env var API key when header not provided", async () => {
      process.env.FAL_API_KEY = "env-fal-key";

      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest({
        prompt: "Test prompt",
        selectedModel: {
          provider: "fal",
          modelId: "fal-ai/flux/schnell",
          displayName: "Flux Schnell",
        },
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify env var key was used (check the queue submit call)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("queue.fal.run"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Key env-fal-key",
          }),
        })
      );
    });

    it("should pass parameters to fal.ai request body", async () => {
      // Schema fetch (for array type detection with dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
          dynamicInputs: {
            prompt: "Test prompt",
          },
          parameters: {
            seed: 12345,
            num_inference_steps: 28,
            guidance_scale: 3.5,
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Find the queue submit call
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      expect(requestBody).toEqual(
        expect.objectContaining({
          seed: 12345,
          num_inference_steps: 28,
          guidance_scale: 3.5,
        })
      );
    });

    it("should merge parameters with dynamicInputs (dynamicInputs take precedence)", async () => {
      // Schema fetch (for array type detection with dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
          parameters: {
            seed: 42,
            num_inference_steps: 25,
          },
          dynamicInputs: {
            prompt: "Dynamic prompt",
            num_inference_steps: "30", // Should override parameters
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Find the queue submit call
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      expect(requestBody).toEqual(
        expect.objectContaining({
          seed: 42,
          prompt: "Dynamic prompt",
          num_inference_steps: "30", // dynamicInputs value
        })
      );
    });

    it("should wrap dynamicInputs in array when schema type is 'array'", async () => {
      // Schema fetch - return schema showing image_urls has type: "array"
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          models: [{
            openapi: {
              paths: {
                "/": {
                  post: {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: {
                            properties: {
                              image_urls: { type: "array", items: { type: "string" } },
                              prompt: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }],
        }),
      });

      // CDN upload for image_urls (base64 data URI)
      mockFalCdnUpload("https://fal.ai/cdn/uploaded-single.png");

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux-2/turbo/edit",
            displayName: "Flux 2 Turbo Edit",
          },
          dynamicInputs: {
            prompt: "Edit this image",
            image_urls: "data:image/png;base64,singleImage",  // Single string sent
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Find the queue submit call
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      // image_urls was uploaded to CDN then wrapped in array because schema says type: "array"
      expect(requestBody.image_urls).toEqual(["https://fal.ai/cdn/uploaded-single.png"]);
      expect(requestBody.prompt).toBe("Edit this image");
    });

    it("should NOT wrap dynamicInputs when schema type is NOT 'array'", async () => {
      // Schema fetch - return schema showing image_url has type: "string" (NOT array)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          models: [{
            openapi: {
              paths: {
                "/": {
                  post: {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: {
                            properties: {
                              image_url: { type: "string" },  // Single string, not array
                              prompt: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }],
        }),
      });

      // CDN upload for image_url (base64 data URI)
      mockFalCdnUpload("https://fal.ai/cdn/single.png");

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
          dynamicInputs: {
            prompt: "Test prompt",
            image_url: "data:image/png;base64,singleImage",  // Single string
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Find the queue submit call
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      // image_url was uploaded to CDN but remains a string (not wrapped in array)
      expect(requestBody.image_url).toBe("https://fal.ai/cdn/single.png");
      expect(requestBody.prompt).toBe("Test prompt");
    });

    it("should unwrap array dynamicInputs to single value when schema type is NOT 'array'", async () => {
      // Schema fetch - return schema showing image_url has type: "string" (NOT array)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          models: [{
            openapi: {
              paths: {
                "/": {
                  post: {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: {
                            properties: {
                              image_url: { type: "string" },  // Single string, not array
                              prompt: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }],
        }),
      });

      // CDN uploads for both images in the array
      // Promise.all fires both initiates concurrently before either PUT,
      // so mock order is: initiate1, initiate2, PUT1, PUT2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upload_url: "https://fal.ai/cdn/put-target-1", file_url: "https://fal.ai/cdn/first.png" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ upload_url: "https://fal.ai/cdn/put-target-2", file_url: "https://fal.ai/cdn/second.png" }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true }); // PUT 1
      mockFetch.mockResolvedValueOnce({ ok: true }); // PUT 2

      // Queue flow: submit → poll → result → media
      mockFalQueueSuccess(
        { images: [{ url: "https://fal.media/output.png" }] },
        "image/png",
        1024
      );

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
          dynamicInputs: {
            prompt: "Test prompt",
            image_url: ["data:image/png;base64,image1", "data:image/png;base64,image2"],  // Array of images
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Find the queue submit call
      const queueSubmitCall = mockFetch.mock.calls.find(
        (call: [string, ...unknown[]]) => typeof call[0] === "string" && call[0].includes("queue.fal.run") && !call[0].includes("/requests/")
      );
      expect(queueSubmitCall).toBeDefined();
      const requestBody = JSON.parse((queueSubmitCall![1] as { body: string }).body);
      // image_url should be unwrapped to a single CDN URL string (first element), not an array
      expect(requestBody.image_url).toBe("https://fal.ai/cdn/first.png");
      expect(Array.isArray(requestBody.image_url)).toBe(false);
      expect(requestBody.prompt).toBe("Test prompt");
    });

    it("should handle error response with error.message format", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue submit returns error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({
          error: { message: "Invalid input parameters" },
        })),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid input parameters");
    });

    it("should handle error response with detail array format", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue submit returns validation errors
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve(JSON.stringify({
          detail: [
            { msg: "Field required", loc: ["body", "prompt"] },
            { msg: "Invalid value", loc: ["body", "steps"] },
          ],
        })),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Field required");
      expect(data.error).toContain("Invalid value");
    });

    it("should handle no media URL in response", async () => {
      // Schema fetch (for input mapping when no dynamicInputs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue submit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "test-req-id" }),
      });
      // Status poll → COMPLETED
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "COMPLETED" }),
      });
      // Result fetch returns empty response (no media URL)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/flux/schnell",
            displayName: "Flux Schnell",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("No media URL in response");
    });

    it("should handle model_glb.url response format (Hunyuan 3D)", async () => {
      // Schema fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result (model_glb format) → media fetch
      // Queue submit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "test-req-id" }),
      });
      // Status poll → COMPLETED
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "COMPLETED" }),
      });
      // Result fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ model_glb: { url: "https://fal.media/hunyuan3d-output.glb" } }),
      });

      const request = createMockPostRequest(
        {
          prompt: "A 3D model of a chair",
          mediaType: "3d",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/hunyuan3d/mini",
            displayName: "Hunyuan 3D Mini",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.contentType).toBe("3d");
      expect(data.model3dUrl).toBe("https://fal.media/hunyuan3d-output.glb");
    });

    it("should handle model_urls.glb.url response format (Hunyuan 3D variant)", async () => {
      // Schema fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue flow: submit → poll → result (model_urls.glb format) → media fetch
      // Queue submit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "test-req-id" }),
      });
      // Status poll → COMPLETED
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "COMPLETED" }),
      });
      // Result fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ model_urls: { glb: { url: "https://fal.media/hunyuan3d-v2-output.glb" } } }),
      });

      const request = createMockPostRequest(
        {
          prompt: "A 3D model of a tree",
          mediaType: "3d",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/hunyuan3d/standard",
            displayName: "Hunyuan 3D Standard",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.contentType).toBe("3d");
      expect(data.model3dUrl).toBe("https://fal.media/hunyuan3d-v2-output.glb");
    });

    it("should include Result keys in error log when no media URL found", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Schema fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      // Queue submit
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ request_id: "test-req-id" }),
      });
      // Status poll → COMPLETED
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "COMPLETED" }),
      });
      // Result fetch returns unrecognized format
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ unknown_field: "data", another: 123 }),
      });

      const request = createMockPostRequest(
        {
          prompt: "Test prompt",
          selectedModel: {
            provider: "fal",
            modelId: "fal-ai/some-model",
            displayName: "Some Model",
          },
        },
        { "X-Fal-API-Key": "test-fal-key" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain("No media URL in response");

      // Verify the enhanced error log includes Result keys
      const errorCalls = consoleSpy.mock.calls;
      const resultKeysLog = errorCalls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Result keys:")
      );
      expect(resultKeysLog).toBeDefined();
      expect(resultKeysLog![0]).toContain("unknown_field");
      expect(resultKeysLog![0]).toContain("another");

      consoleSpy.mockRestore();
    });
  });
});
