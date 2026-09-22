import { afterEach, describe, expect, it, vi } from "vitest";
import { pollGenerateTask } from "../pollTaskCompletion";

/** Drive the poller against canned poll responses and record each wait it schedules. */
async function waitsFor(responses: object[]) {
  const fetchMock = vi.fn();
  for (const body of responses) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }
  vi.stubGlobal("fetch", fetchMock);
  const timeouts: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    timeouts.push(ms ?? 0);
    return realSetTimeout(fn, 0);
  }) as typeof setTimeout);
  const result = await pollGenerateTask({
    taskId: "t",
    provider: "comfy",
    modelId: "m",
    modelName: "M",
    mediaType: "image",
    headers: {},
  });
  return { result, timeouts, fetchMock };
}

describe("pollGenerateTask", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("ramps from 3s when the server suggests nothing", async () => {
    const { timeouts } = await waitsFor([
      { success: true, polling: true },
      { success: true, polling: true },
      { success: true, image: "data:image/png;base64,AA==" },
    ]);
    expect(timeouts).toEqual([3000, 3500, 4000]);
  });

  it("honours a server-suggested wait longer than the ramp", async () => {
    const { timeouts } = await waitsFor([
      { success: true, polling: true, retryAfterMs: 20000 },
      { success: true, image: "x" },
    ]);
    expect(timeouts[1]).toBe(20000);
  });

  it("caps an oversized server-suggested wait at 60s", async () => {
    const { timeouts, result } = await waitsFor([
      { success: true, polling: true, retryAfterMs: 5 * 60 * 1000 },
      { success: true, image: "x" },
    ]);
    expect(timeouts[1]).toBe(60000);
    expect(result.success).toBe(true);
  });
});
