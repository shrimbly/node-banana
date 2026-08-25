import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  submitFalTask,
  fetchFalMediaResult,
  clearFalInputMappingCache,
} from "../fal";
import type { GenerationInput } from "@/lib/providers/types";

/**
 * Tests for prompt passthrough when dynamicInputs are present.
 *
 * Bug: When a generate node has both a prompt AND image input connected,
 * the dynamicInputs code path processes images but never reads input.prompt,
 * causing "prompt is required" errors from the fal.ai API.
 */

// Captured request bodies from fetch calls
let capturedQueueBody: Record<string, unknown> | null = null;

function makeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: {
      id: "fal-ai/test-model",
      name: "Test Model",
      description: null,
      provider: "fal",
      capabilities: ["text-to-image"],
    },
    prompt: "a photo of a cat",
    images: [],
    parameters: {},
    ...overrides,
  };
}

/**
 * Create a mock fetch that intercepts fal.ai API calls.
 * - Schema request: returns OpenAPI spec with prompt + image_url properties
 * - Queue submission: captures body, returns request_id
 * - Status poll: returns COMPLETED
 * - Result fetch: returns images array
 * - Media fetch: returns fake image
 */
function createMockFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    // Account-specific price lookup after a successful result
    if (urlStr.includes("api.fal.ai/v1/models/pricing")) {
      return new Response(
        JSON.stringify({
          prices: [
            {
              endpoint_id: "fal-ai/test-model",
              unit_price: 0.025,
              unit: "megapixels",
              currency: "USD",
            },
          ],
        }),
        { status: 200 }
      );
    }

    // Schema request (fal.ai model search API with OpenAPI expansion)
    if (urlStr.includes("api.fal.ai/v1/models")) {
      return new Response(
        JSON.stringify({
          models: [
            {
              endpoint_id: "fal-ai/test-model",
              openapi: {
                paths: {
                  "/": {
                    post: {
                      requestBody: {
                        content: {
                          "application/json": {
                            schema: {
                              properties: {
                                prompt: { type: "string", description: "Text prompt" },
                                image_url: { type: "string", description: "Input image URL" },
                              },
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
        { status: 200 }
      );
    }

    // Queue submission
    if (urlStr.includes("queue.fal.run/fal-ai/test-model") && init?.method === "POST") {
      capturedQueueBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          request_id: "test-123",
          status_url: "https://queue.fal.run/fal-ai/test-model/requests/test-123/status",
          response_url: "https://queue.fal.run/fal-ai/test-model/requests/test-123",
        }),
        { status: 200 }
      );
    }

    // Status poll
    if (urlStr.includes("/requests/test-123/status")) {
      return new Response(
        JSON.stringify({ status: "COMPLETED" }),
        { status: 200 }
      );
    }

    // Result fetch
    if (urlStr.includes("/requests/test-123") && !urlStr.includes("/status")) {
      return new Response(
        JSON.stringify({
          images: [{ url: "https://cdn.fal.ai/test/image.png" }],
        }),
        {
          status: 200,
          headers: {
            "X-Fal-Billable-Units": "1.5",
            "X-Fal-Request-Id": "provider-request-123",
          },
        }
      );
    }

    // Media fetch (output image)
    if (urlStr.includes("cdn.fal.ai")) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    return new Response("Not Found", { status: 404 });
  });
}

describe("fal.ai prompt passthrough with dynamicInputs", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    capturedQueueBody = null;
    clearFalInputMappingCache();
    mockFetch = createMockFetch();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes prompt when dynamicInputs has image_url but no prompt", async () => {
    const input = makeInput({
      prompt: "a photo of a cat",
      dynamicInputs: {
        image_url: "https://cdn.example.com/img.png",
      },
    });

    await submitFalTask("test-req", "test-api-key", input);

    expect(capturedQueueBody).not.toBeNull();
    expect(capturedQueueBody!.prompt).toBe("a photo of a cat");
    expect(capturedQueueBody!.image_url).toBe("https://cdn.example.com/img.png");
  });

  it("returns a task id that survives the request that created it", async () => {
    const submission = await submitFalTask("test-req", "test-api-key", makeInput());

    expect(submission).toEqual({
      taskId: "fal-ai/test-model::test-123::https%3A%2F%2Fqueue.fal.run%2Ffal-ai%2Ftest-model%2Frequests%2Ftest-123%2Fstatus::https%3A%2F%2Fqueue.fal.run%2Ffal-ai%2Ftest-model%2Frequests%2Ftest-123",
    });
  });

  it("returns the final request cost from billed units and live pricing", async () => {
    const result = await fetchFalMediaResult("test-req", "test-api-key", {
      taskId: "fal-ai/test-model::test-123",
      modelName: "Test Model",
      capabilities: ["text-to-image"],
    });

    expect(result.generationCost).toEqual(expect.objectContaining({
      provider: "fal",
      requestId: "provider-request-123",
      modelId: "fal-ai/test-model",
      units: 1.5,
      unit: "megapixels",
      unitPrice: 0.025,
      currency: "USD",
    }));
    expect(result.generationCost?.cost).toBeCloseTo(0.0375);
  });

  it("does not duplicate prompt when dynamicInputs already contains prompt", async () => {
    const input = makeInput({
      prompt: "a cat",
      dynamicInputs: {
        prompt: "a dog",
        image_url: "https://cdn.example.com/img.png",
      },
    });

    await submitFalTask("test-req", "test-api-key", input);

    expect(capturedQueueBody).not.toBeNull();
    // dynamicInputs value wins - not overwritten by input.prompt
    expect(capturedQueueBody!.prompt).toBe("a dog");
  });

  it("works without dynamicInputs (existing behavior)", async () => {
    const input = makeInput({
      prompt: "a cat",
      dynamicInputs: undefined,
    });

    await submitFalTask("test-req", "test-api-key", input);

    expect(capturedQueueBody).not.toBeNull();
    expect(capturedQueueBody!.prompt).toBe("a cat");
  });
});
