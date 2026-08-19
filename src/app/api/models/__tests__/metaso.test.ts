import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

const originalEnv = { ...process.env };

function request(headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: new URL("http://localhost:3000/api/models?provider=metaso&capabilities=text-to-video"),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

describe("metaso model discovery", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("requires a configured metaso key", async () => {
    delete process.env.METASO_API_KEY;
    const response = await GET(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("METASO_API_KEY") });
  });

  it("returns the independent MiniMax-H3 model and pricing metadata", async () => {
    const response = await GET(request({ "X-Metaso-API-Key": "test-key" }));
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.availableProviders).toContain("metaso");
    expect(data.providers.metaso).toMatchObject({ success: true, count: 1 });
    expect(data.models).toEqual([
      expect.objectContaining({
        id: "MiniMax-H3",
        provider: "metaso",
        capabilities: expect.arrayContaining(["text-to-video", "image-to-video", "audio-to-video"]),
        pricingDescription: "768P ¥0.09/output s · 2K ¥0.15/output s · first 5 images free, then ¥0.05/image · audio free · reference video uses the same output-second rate",
        coverImage: "/providers/metaso.ico",
      }),
    ]);
  });
});
