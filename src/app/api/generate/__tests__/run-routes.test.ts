import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as submitRun } from "../submit/route";
import { GET as getRun } from "../run/route";

describe("persistent generation run routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["fal", "X-Fal-API-Key"],
    ["replicate", "X-Replicate-API-Key"],
    ["wavespeed", "X-WaveSpeed-Key"],
    ["gemini", "X-Gemini-API-Key"],
    ["kie", "X-Kie-Key"],
  ])("starts a %s request once and exposes its eventual result", async (provider, keyHeader) => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ success: true, videoUrl: "https://cdn.example/result.mp4" })
    );
    vi.stubGlobal("fetch", providerFetch);
    const runId = `route-run-${provider}-${Date.now()}`;
    const request = new NextRequest("http://localhost/api/generate/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [keyHeader]: "secret-provider-key",
      },
      body: JSON.stringify({
        clientRunId: runId,
        mediaType: "video",
        selectedModel: {
          provider,
          modelId: `${provider}/video`,
          displayName: `${provider} Video`,
        },
      }),
    });

    const accepted = await submitRun(request);
    expect(accepted.status).toBe(202);

    await vi.waitFor(async () => {
      const status = await getRun(
        new NextRequest(`http://localhost/api/generate/run?runId=${runId}`)
      );
      expect(await status.json()).toMatchObject({
        state: "completed",
        result: { success: true, videoUrl: "https://cdn.example/result.mp4" },
      });
    });

    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [url, init] = providerFetch.mock.calls[0];
    expect(String(url)).toBe("http://localhost/api/generate");
    expect(new Headers(init?.headers).get(keyHeader)).toBe("secret-provider-key");
  });

  it("rejects missing run ids", async () => {
    const response = await submitRun(
      new NextRequest("http://localhost/api/generate/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: "video" }),
      })
    );

    expect(response.status).toBe(400);
  });
});
