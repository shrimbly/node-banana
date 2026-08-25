import { describe, expect, it, vi } from "vitest";
import { getServerGenerationRun, startServerGenerationRun } from "../runRegistry";

describe("generation run broker", () => {
  it("keeps a provider response available after the original caller is gone", async () => {
    const runId = `registry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const execute = vi.fn(async () =>
      Response.json({ success: true, videoUrl: "https://cdn.example/video.mp4" })
    );

    expect(startServerGenerationRun(runId, execute)).toBe("started");
    expect(startServerGenerationRun(runId, execute)).toBe("existing");

    await vi.waitFor(() => {
      expect(getServerGenerationRun(runId)).toMatchObject({
        state: "completed",
        responseStatus: 200,
        result: { success: true, videoUrl: "https://cdn.example/video.mp4" },
      });
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("records background failures", async () => {
    const runId = `registry-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    startServerGenerationRun(runId, async () => {
      throw new Error("provider unavailable");
    });

    await vi.waitFor(() => {
      expect(getServerGenerationRun(runId)).toMatchObject({
        state: "failed",
        error: "provider unavailable",
      });
    });
  });
});
