import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST as submitRun } from "../submit/route";
import { GET as getRun } from "../run/route";
import { POST as generate } from "../route";

vi.mock("../route", () => ({
  POST: vi.fn(async () =>
    NextResponse.json({ success: true, videoUrl: "https://cdn.example/result.mp4" })
  ),
}));

const generateMock = vi.mocked(generate);

describe("persistent generation run routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    generateMock.mockClear();
  });

  it.each([
    ["fal", "X-Fal-API-Key"],
    ["replicate", "X-Replicate-API-Key"],
    ["wavespeed", "X-WaveSpeed-Key"],
    ["gemini", "X-Gemini-API-Key"],
    ["kie", "X-Kie-Key"],
  ])("starts a %s request once and exposes its eventual result", async (provider, keyHeader) => {
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

    // The generate handler runs in-process; a loopback fetch would be capped by
    // the runtime's 5-minute headers timeout.
    expect(generateMock).toHaveBeenCalledTimes(1);
    const forwarded = generateMock.mock.calls[0][0];
    expect(forwarded.nextUrl.pathname).toBe("/api/generate");
    expect(forwarded.headers.get(keyHeader)).toBe("secret-provider-key");
    expect(await forwarded.json()).toMatchObject({ clientRunId: runId, mediaType: "video" });
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

  it("keeps a generation that outlives the loopback fetch timeout", async () => {
    // Regression: the submit route used to call /api/generate over HTTP, and
    // Node's fetch aborts with "fetch failed" once headers stall past 5 minutes.
    // An in-process call has no such ceiling.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    generateMock.mockImplementationOnce(async () => {
      await pending;
      return NextResponse.json({ success: true, videoUrl: "https://cdn.example/slow.mp4" });
    });

    const runId = `route-run-slow-${Date.now()}`;
    const accepted = await submitRun(
      new NextRequest("http://localhost/api/generate/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRunId: runId, mediaType: "video" }),
      })
    );
    expect(accepted.status).toBe(202);

    const running = await getRun(
      new NextRequest(`http://localhost/api/generate/run?runId=${runId}`)
    );
    expect(await running.json()).toMatchObject({ state: "running" });

    release?.();
    await vi.waitFor(async () => {
      const status = await getRun(
        new NextRequest(`http://localhost/api/generate/run?runId=${runId}`)
      );
      expect(await status.json()).toMatchObject({
        state: "completed",
        result: { success: true, videoUrl: "https://cdn.example/slow.mp4" },
      });
    });
  });
});
