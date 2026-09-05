import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the route module to test internal functions
// We'll test via the GET endpoint behavior

// Store original env and fetch
const originalEnv = { ...process.env };
const originalFetch = global.fetch;

// Mock fetch for provider API calls
const mockFetch = vi.fn();

// Counter to generate unique model IDs (avoids cache collisions between tests)
let testCounter = 0;

// Helper to create mock NextRequest for GET with dynamic params
function createMockSchemaRequest(
  modelId: string,
  provider: string,
  headers?: Record<string, string>
): NextRequest {
  const url = new URL(`http://localhost:3000/api/models/${encodeURIComponent(modelId)}`);
  url.searchParams.set("provider", provider);

  return {
    nextUrl: url,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

// Helper to create Replicate model response with OpenAPI schema
function createReplicateModelResponse(inputProperties: Record<string, unknown>, required: string[] = []) {
  return {
    ok: true,
    json: () => Promise.resolve({
      latest_version: {
        id: "version123",
        openapi_schema: {
          components: {
            schemas: {
              Input: {
                type: "object",
                properties: inputProperties,
                required,
              },
            },
          },
        },
      },
    }),
  };
}

// Helper to create fal.ai model response with OpenAPI schema
function createFalModelResponse(inputProperties: Record<string, unknown>, required: string[] = []) {
  return {
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
                        type: "object",
                        properties: inputProperties,
                        required,
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
  };
}

// Import the route after mocks are set up
import { GET } from "../route";

describe("/api/models/[modelId] schema endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.REPLICATE_API_KEY = "test-replicate-key";
    process.env.FAL_API_KEY = "test-fal-key";
    global.fetch = mockFetch;
    testCounter++;  // Ensure unique model IDs per test to avoid cache
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe("isImageInput classification", () => {
    it("should NOT classify boolean params with 'image' in name as image inputs", async () => {
      // This was the original bug: sequential_image_generation (boolean) was misclassified
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          sequential_image_generation: {
            type: "boolean",
            description: "Enable sequential image generation mode",
            default: false,
          },
          prompt: {
            type: "string",
            description: "Text prompt",
          },
        })
      );

      const modelId = `test/model-boolean-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // sequential_image_generation should be a parameter, NOT an input
      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(paramNames).toContain("sequential_image_generation");
      expect(inputNames).not.toContain("sequential_image_generation");
    });

    it("should NOT classify integer params with 'image' in name as image inputs", async () => {
      // max_images, num_images should be parameters, not inputs
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          max_images: {
            type: "integer",
            description: "Maximum number of images",
            default: 1,
            minimum: 1,
            maximum: 15,
          },
          num_images: {
            type: "integer",
            description: "Number of images to generate",
          },
          image_count: {
            type: "integer",
            description: "Image count",
          },
        })
      );

      const modelId = `test/model-integer-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(paramNames).toContain("max_images");
      expect(paramNames).toContain("num_images");
      expect(paramNames).toContain("image_count");
      expect(inputNames).not.toContain("max_images");
      expect(inputNames).not.toContain("num_images");
      expect(inputNames).not.toContain("image_count");
    });

    it("should NOT classify number params with 'image' in name as image inputs", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          image_guidance_scale: {
            type: "number",
            description: "Image guidance scale",
            default: 1.5,
          },
          image_scale: {
            type: "number",
            description: "Scale factor for image",
          },
        })
      );

      const modelId = `test/model-number-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(paramNames).toContain("image_guidance_scale");
      expect(paramNames).toContain("image_scale");
      expect(inputNames).not.toContain("image_guidance_scale");
      expect(inputNames).not.toContain("image_scale");
    });

    it("should classify string params matching IMAGE_INPUT_PATTERNS as image inputs", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          image_url: {
            type: "string",
            description: "URL of the input image",
          },
          image_input: {
            type: "string",
            description: "Input image",
          },
          reference_image: {
            type: "string",
            description: "Reference image URL",
          },
          first_frame: {
            type: "string",
            description: "First frame image",
          },
        })
      );

      const modelId = `test/model-string-inputs-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(inputNames).toContain("image_url");
      expect(inputNames).toContain("image_input");
      expect(inputNames).toContain("reference_image");
      expect(inputNames).toContain("first_frame");
    });

    it("should classify array params without items.type as image inputs when name matches", async () => {
      // This was a bug: arrays without items.type specification were rejected
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          image_input: {
            type: "array",
            // Note: no items.type specified - some schemas omit this
            description: "Input images for generation",
          },
          image_urls: {
            type: "array",
            items: { type: "string" },
            description: "List of image URLs",
          },
        })
      );

      const modelId = `test/model-array-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      // Both should be classified as image inputs
      expect(inputNames).toContain("image_input");
      expect(inputNames).toContain("image_urls");
    });

    it("should NOT classify array params with non-string items as image inputs", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          image_sizes: {
            type: "array",
            items: { type: "integer" },
            description: "List of image sizes",
          },
        })
      );

      const modelId = `test/model-array-nonstring-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(paramNames).toContain("image_sizes");
      expect(inputNames).not.toContain("image_sizes");
    });

    it("should classify prompt and negative_prompt as text inputs", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          prompt: {
            type: "string",
            description: "Text prompt for generation",
          },
          negative_prompt: {
            type: "string",
            description: "Negative prompt",
          },
        }, ["prompt"])
      );

      const modelId = `test/model-text-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const textInputs = data.inputs.filter((i: { type: string }) => i.type === "text");
      const textInputNames = textInputs.map((i: { name: string }) => i.name);

      expect(textInputNames).toContain("prompt");
      expect(textInputNames).toContain("negative_prompt");
    });

    it("should exclude image_size from image inputs (explicit exclusion)", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          image_size: {
            type: "string",
            description: "Output image size",
            enum: ["512x512", "1024x1024"],
          },
        })
      );

      const modelId = `test/model-imagesize-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      // image_size should be a parameter (for selecting output size), not an image input
      expect(paramNames).toContain("image_size");
      expect(inputNames).not.toContain("image_size");
    });

    it("should handle mixed schema with correct classification", async () => {
      // Simulate the seedream-4.5 schema that caused the original bug
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          prompt: {
            type: "string",
            description: "Text prompt",
          },
          image_input: {
            type: "array",
            description: "Input images",
          },
          max_images: {
            type: "integer",
            description: "Max images",
            default: 1,
          },
          sequential_image_generation: {
            type: "string",  // enum stored as string
            description: "Generation mode",
            enum: ["disabled", "auto"],
          },
          width: {
            type: "integer",
            description: "Image width",
          },
          height: {
            type: "integer",
            description: "Image height",
          },
        }, ["prompt"])
      );

      const modelId = `bytedance/seedream-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const imageInputNames = data.inputs.filter((i: { type: string }) => i.type === "image").map((i: { name: string }) => i.name);
      const textInputNames = data.inputs.filter((i: { type: string }) => i.type === "text").map((i: { name: string }) => i.name);

      // Image inputs
      expect(imageInputNames).toContain("image_input");
      expect(imageInputNames).toHaveLength(1);

      // Text inputs
      expect(textInputNames).toContain("prompt");

      // Parameters (NOT inputs)
      expect(paramNames).toContain("max_images");
      expect(paramNames).toContain("sequential_image_generation");
      expect(paramNames).toContain("width");
      expect(paramNames).toContain("height");

      // These should NOT be in inputs
      expect(imageInputNames).not.toContain("max_images");
      expect(imageInputNames).not.toContain("sequential_image_generation");
    });
  });

  describe("isVideoInput classification", () => {
    it("should NOT classify string settings like video_size as video inputs", async () => {
      // Regression: string enums such as video_size ("720p"/"1080p") matched the
      // video_ name pattern and surfaced as a bogus video handle instead of a
      // settings parameter.
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          video_size: {
            type: "string",
            description: "Output resolution of the generated video",
            enum: ["720p", "1080p"],
            default: "720p",
          },
          prompt: {
            type: "string",
            description: "Text prompt",
          },
        })
      );

      const modelId = `test/model-video-size-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const videoInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "video")
        .map((i: { name: string }) => i.name);

      expect(paramNames).toContain("video_size");
      expect(videoInputNames).not.toContain("video_size");
    });

    it("should classify mid-name video params like ref_video_url as video inputs", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          ref_video_url: {
            type: "string",
            description: "Reference clip",
          },
        })
      );

      const modelId = `test/model-mid-video-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      const videoInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "video")
        .map((i: { name: string }) => i.name);

      expect(videoInputNames).toContain("ref_video_url");
    });

    it("should classify params described as a source video as video inputs", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          media_reference: {
            type: "string",
            description: "URL of the source video to restyle",
          },
        })
      );

      const modelId = `test/model-source-video-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      const videoInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "video")
        .map((i: { name: string }) => i.name);

      expect(videoInputNames).toContain("media_reference");
    });
  });

  describe("fal.ai provider", () => {
    it("should correctly classify inputs from fal.ai schema", async () => {
      mockFetch.mockResolvedValueOnce(
        createFalModelResponse({
          prompt: {
            type: "string",
            description: "Text prompt",
          },
          image_url: {
            type: "string",
            format: "uri",
            description: "Input image URL",
          },
          num_inference_steps: {
            type: "integer",
            description: "Number of inference steps",
          },
        }, ["prompt"])
      );

      const modelId = `fal-ai/flux-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const imageInputNames = data.inputs.filter((i: { type: string }) => i.type === "image").map((i: { name: string }) => i.name);
      const textInputNames = data.inputs.filter((i: { type: string }) => i.type === "text").map((i: { name: string }) => i.name);
      const paramNames = data.parameters.map((p: { name: string }) => p.name);

      expect(imageInputNames).toContain("image_url");
      expect(textInputNames).toContain("prompt");
      expect(paramNames).toContain("num_inference_steps");
    });
  });

  describe("real Fal Kling v2.6 pro image-to-video schema", () => {
    it("should detect both start_image_url and end_image_url as image inputs", async () => {
      // Exact schema structure from Fal API for fal-ai/kling-video/v2.6/pro/image-to-video
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          models: [{
            openapi: {
              openapi: "3.0.4",
              components: {
                schemas: {
                  KlingVideoV26ProImageToVideoInput: {
                    title: "ImageToVideoV26ProRequest",
                    type: "object",
                    properties: {
                      prompt: {
                        title: "Prompt",
                        type: "string",
                        maxLength: 2500,
                      },
                      duration: {
                        enum: ["5", "10"],
                        title: "Duration",
                        type: "string",
                        description: "The duration of the generated video in seconds",
                        default: "5",
                      },
                      generate_audio: {
                        title: "Generate Audio",
                        type: "boolean",
                        description: "Whether to generate native audio for the video.",
                        default: true,
                      },
                      start_image_url: {
                        description: "URL of the image to be used for the video",
                        type: "string",
                        title: "Start Image Url",
                      },
                      end_image_url: {
                        title: "End Image Url",
                        type: "string",
                        description: "URL of the image to be used for the end of the video",
                      },
                      negative_prompt: {
                        title: "Negative Prompt",
                        type: "string",
                        maxLength: 2500,
                        default: "blur, distort, and low quality",
                      },
                    },
                    required: ["prompt", "start_image_url"],
                  },
                },
              },
              paths: {
                "/fal-ai/kling-video/v2.6/pro/image-to-video": {
                  post: {
                    requestBody: {
                      required: true,
                      content: {
                        "application/json": {
                          schema: {
                            $ref: "#/components/schemas/KlingVideoV26ProImageToVideoInput",
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

      const modelId = `fal-ai/kling-video-real-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      const imageInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "image")
        .map((i: { name: string }) => i.name);
      const textInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "text")
        .map((i: { name: string }) => i.name);
      const paramNames = data.parameters.map((p: { name: string }) => p.name);

      // Both image URL fields should be detected as image inputs
      expect(imageInputNames).toContain("start_image_url");
      expect(imageInputNames).toContain("end_image_url");

      // Text inputs
      expect(textInputNames).toContain("prompt");
      expect(textInputNames).toContain("negative_prompt");

      // Parameters (not image or text inputs)
      expect(paramNames).toContain("duration");
      expect(paramNames).toContain("generate_audio");

      // Image inputs should NOT appear as parameters
      expect(paramNames).not.toContain("start_image_url");
      expect(paramNames).not.toContain("end_image_url");
    });
  });

  describe("anyOf/oneOf nullable schema patterns", () => {
    // Helper to create fal.ai response with components.schemas for $ref resolution
    function createFalModelResponseWithComponents(
      inputProperties: Record<string, unknown>,
      required: string[] = [],
      components?: Record<string, unknown>
    ) {
      return {
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
                            $ref: "#/components/schemas/Input",
                          },
                        },
                      },
                    },
                  },
                },
              },
              components: {
                schemas: {
                  Input: {
                    type: "object",
                    properties: inputProperties,
                    required,
                  },
                  ...components,
                },
              },
            },
          }],
        }),
      };
    }

    it("should detect anyOf nullable string as image input (Kling pattern)", async () => {
      // Exact pattern from Kling v2.6 image-to-video on Fal
      mockFetch.mockResolvedValueOnce(
        createFalModelResponseWithComponents({
          prompt: {
            type: "string",
            description: "Text prompt",
          },
          image_url: {
            type: "string",
            description: "The URL of the image",
          },
          end_image_url: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The URL of the end image",
          },
        }, ["prompt", "image_url"])
      );

      const modelId = `fal-ai/kling-anyof-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const imageInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "image")
        .map((i: { name: string }) => i.name);

      // Both image_url and end_image_url should be image inputs
      expect(imageInputNames).toContain("image_url");
      expect(imageInputNames).toContain("end_image_url");
    });

    it("should detect anyOf with format: uri as image input", async () => {
      mockFetch.mockResolvedValueOnce(
        createFalModelResponseWithComponents({
          reference_image: {
            anyOf: [
              { type: "string", format: "uri" },
              { type: "null" },
            ],
            description: "Reference image URL",
          },
        })
      );

      const modelId = `fal-ai/anyof-uri-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const imageInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "image")
        .map((i: { name: string }) => i.name);

      expect(imageInputNames).toContain("reference_image");
    });

    it("should NOT detect anyOf with non-string types as image input", async () => {
      mockFetch.mockResolvedValueOnce(
        createFalModelResponseWithComponents({
          image_guidance_scale: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "Image guidance scale",
          },
          image_count: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Number of images",
          },
        })
      );

      const modelId = `fal-ai/anyof-nonstring-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(paramNames).toContain("image_guidance_scale");
      expect(paramNames).toContain("image_count");
      expect(inputNames).not.toContain("image_guidance_scale");
      expect(inputNames).not.toContain("image_count");
    });

    it("should handle oneOf pattern same as anyOf", async () => {
      mockFetch.mockResolvedValueOnce(
        createFalModelResponseWithComponents({
          start_image: {
            oneOf: [{ type: "string" }, { type: "null" }],
            description: "The start image URL",
          },
        })
      );

      const modelId = `fal-ai/oneof-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const imageInputNames = data.inputs
        .filter((i: { type: string }) => i.type === "image")
        .map((i: { name: string }) => i.name);

      expect(imageInputNames).toContain("start_image");
    });

    it("should resolve anyOf parameter types correctly (not default to string)", async () => {
      mockFetch.mockResolvedValueOnce(
        createFalModelResponseWithComponents({
          seed: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Random seed",
          },
          guidance_scale: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "Guidance scale",
            default: 7.5,
          },
        })
      );

      const modelId = `fal-ai/anyof-types-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const seedParam = data.parameters.find((p: { name: string }) => p.name === "seed");
      const guidanceParam = data.parameters.find((p: { name: string }) => p.name === "guidance_scale");

      expect(seedParam?.type).toBe("integer");
      expect(guidanceParam?.type).toBe("number");
    });

    it("should NOT classify anyOf boolean with image in name as image input", async () => {
      mockFetch.mockResolvedValueOnce(
        createFalModelResponseWithComponents({
          enable_image_enhancement: {
            anyOf: [{ type: "boolean" }, { type: "null" }],
            description: "Enable image enhancement",
            default: false,
          },
        })
      );

      const modelId = `fal-ai/anyof-bool-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "fal");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);

      const paramNames = data.parameters.map((p: { name: string }) => p.name);
      const inputNames = data.inputs.map((i: { name: string }) => i.name);

      expect(paramNames).toContain("enable_image_enhancement");
      expect(inputNames).not.toContain("enable_image_enhancement");
    });
  });

  describe("error handling", () => {
    it("should return 400 for invalid provider", async () => {
      const request = createMockSchemaRequest("test/model", "invalid");
      const response = await GET(request, { params: Promise.resolve({ modelId: "test/model" }) });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid or missing provider");
    });

    it("should return 401 for Replicate without API key", async () => {
      delete process.env.REPLICATE_API_KEY;

      const modelId = `test/model-nokey-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Replicate API key required");
    });

    it("should handle API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const modelId = `test/model-error-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });
  });

  describe("caching", () => {
    it("should return cached results on subsequent requests", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          prompt: { type: "string" },
        })
      );

      const modelId = `cached/model-${testCounter}`;
      const request1 = createMockSchemaRequest(modelId, "replicate");
      const response1 = await GET(request1, { params: Promise.resolve({ modelId }) });
      const data1 = await response1.json();

      expect(response1.status).toBe(200);
      expect(data1.cached).toBe(false);

      // Second request should use cache
      const request2 = createMockSchemaRequest(modelId, "replicate");
      const response2 = await GET(request2, { params: Promise.resolve({ modelId }) });
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(data2.cached).toBe(true);

      // Fetch should only have been called once
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("isVideoInput classification", () => {
    it("should classify video_url as a video input (not image)", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          video_url: { type: "string", format: "uri", description: "URL of the input video" },
          upscale_factor: { type: "string", enum: ["2", "4"], default: "2" },
        }, ["video_url"])
      );

      const modelId = `topazlabs/video-upscale-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      const videoInput = data.inputs.find((i: { name: string }) => i.name === "video_url");
      expect(videoInput).toBeDefined();
      expect(videoInput.type).toBe("video");
    });

    it("should keep first_frame/last_frame as image inputs while bare 'video' is a video input", async () => {
      mockFetch.mockResolvedValueOnce(
        createReplicateModelResponse({
          first_frame: { type: "string", format: "uri", description: "First frame image" },
          last_frame: { type: "string", format: "uri", description: "Last frame image" },
          video: { type: "string", format: "uri", description: "Input video to process" },
        })
      );

      const modelId = `test/frames-${testCounter}`;
      const request = createMockSchemaRequest(modelId, "replicate");
      const response = await GET(request, { params: Promise.resolve({ modelId }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      const byName: Record<string, string> = Object.fromEntries(
        data.inputs.map((i: { name: string; type: string }) => [i.name, i.type])
      );
      expect(byName.first_frame).toBe("image");
      expect(byName.last_frame).toBe("image");
      expect(byName.video).toBe("video");
    });
  });
});
