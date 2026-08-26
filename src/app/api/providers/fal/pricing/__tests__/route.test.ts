import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

const originalFetch = global.fetch;
const originalFalKey = process.env.FAL_API_KEY;

function createRequest(
  endpointIds: string[],
  withHeader = true,
  apiKey = "test-fal-key"
): NextRequest {
  return new NextRequest("http://localhost:3000/api/providers/fal/pricing", {
    method: "POST",
    headers: withHeader
      ? { "Content-Type": "application/json", "X-Fal-Key": apiKey }
      : { "Content-Type": "application/json" },
    body: JSON.stringify({ endpointIds }),
  });
}

describe("/api/providers/fal/pricing route", () => {
  beforeEach(() => {
    delete process.env.FAL_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalFalKey === undefined) delete process.env.FAL_API_KEY;
    else process.env.FAL_API_KEY = originalFalKey;
    vi.restoreAllMocks();
  });

  it("batches fal.ai lookups, normalizes units, and reuses the memory cache", async () => {
    const endpointIds = Array.from({ length: 51 }, (_, index) => `fal-ai/model-${index}`);
    const mockFetch = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input));
      const ids = url.searchParams.getAll("endpoint_id");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            prices: ids.map((endpointId, index) => ({
              endpoint_id: endpointId,
              unit_price: index === 0 ? 0.025 : 0.05,
              unit: index === 0 ? "megapixels" : "video_second",
              currency: "usd",
            })),
          }),
          { status: 200 }
        )
      );
    });
    global.fetch = mockFetch as typeof fetch;

    const firstResponse = await POST(createRequest(endpointIds));
    const firstData = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstData.success).toBe(true);
    expect(firstData.prices).toHaveLength(51);
    expect(firstData.prices[0]).toEqual({
      endpointId: "fal-ai/model-0",
      pricing: {
        type: "per-run",
        amount: 0.025,
        currency: "USD",
        unit: "megapixels",
      },
    });
    expect(firstData.prices[1].pricing.type).toBe("per-second");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondResponse = await POST(createRequest(endpointIds));
    expect(secondResponse.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const otherAccountResponse = await POST(
      createRequest(endpointIds, true, "another-fal-key")
    );
    expect(otherAccountResponse.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("requires a fal.ai API key", async () => {
    const response = await POST(createRequest(["fal-ai/flux/dev"], false));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "fal.ai API key not configured",
    });
  });
});
