import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollLocalGenerationRun, submitPersistentGeneration } from "../persistentGeneration";
import { loadGenerationRuns } from "@/store/utils/generationRuns";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

describe("persistent generation client", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists the node binding before submitting and returns the broker result", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/generate/submit") {
        const body = JSON.parse(String(init?.body));
        expect(loadGenerationRuns()).toHaveLength(1);
        expect(body.clientRunId).toBe(loadGenerationRuns()[0].runId);
        return Response.json({ success: true, runId: body.clientRunId }, { status: 202 });
      }
      if (url.startsWith("/api/generate/run?")) {
        return Response.json({
          state: "completed",
          responseStatus: 200,
          result: { success: true, videoUrl: "https://cdn.example/video.mp4" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { run, result } = await submitPersistentGeneration({
      workflowId: "workflow-1",
      nodeId: "video-1",
      model: { provider: "replicate", modelId: "owner/video", displayName: "Video" },
      prompt: "A short film",
      headers: { "Content-Type": "application/json" },
      payload: { mediaType: "video" },
    });

    expect(run).toMatchObject({
      workflowId: "workflow-1",
      nodeId: "video-1",
      provider: "replicate",
    });
    expect(result.videoUrl).toBe("https://cdn.example/video.mp4");
  });

  it("retries transient broker failures instead of losing the run", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ state: "running" }, { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          state: "completed",
          responseStatus: 200,
          result: { success: true, videoUrl: "https://cdn.example/recovered.mp4" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = pollLocalGenerationRun("run-transient");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      videoUrl: "https://cdn.example/recovered.mp4",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
