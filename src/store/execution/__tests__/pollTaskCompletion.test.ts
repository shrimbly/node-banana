import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationStillRunningError, POLL_SAFETY_NET_MS, pollGenerateTask } from "../pollTaskCompletion";

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

const RUNNING = { success: true, polling: true };
const DONE = { success: true, video: "data:video/mp4;base64,AA==" };

function json(body: object) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

/**
 * Poll on fake time: `answer` is asked, at each poll, what the server says
 * then. Returns the poll's settled outcome and when each poll was made.
 */
async function pollOnFakeTime(answer: (elapsed: number) => object, options: { signal?: AbortSignal; abortAfter?: number } = {}) {
  vi.useFakeTimers();
  const start = Date.now();
  const pollTimes: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const elapsed = Date.now() - start;
    pollTimes.push(elapsed);
    return answer(elapsed);
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const controller = new AbortController();
  const settled = pollGenerateTask({
    taskId: "3544457f",
    provider: "comfy",
    modelId: "byteplus/dreamina-seedance-2-5-260628",
    modelName: "Seedance 2.5",
    mediaType: "video",
    headers: {},
    signal: options.signal ?? controller.signal,
  }).then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null, error })
  );
  if (options.abortAfter !== undefined) {
    await vi.advanceTimersByTimeAsync(options.abortAfter);
    controller.abort("user-cancelled");
  }
  await vi.runAllTimersAsync();
  return { ...(await settled), pollTimes };
}

describe("pollGenerateTask", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("keeps polling past ten minutes while the provider says the run is going", async () => {
    const { result, error } = await pollOnFakeTime((elapsed) => json(elapsed < 25 * 60_000 ? RUNNING : DONE));
    expect(error).toBeNull();
    expect(result).toEqual(DONE);
  });

  it("takes one last look at the net and reports a run that finished meanwhile", async () => {
    // Running at every poll before the net, finished by the time of the one made there
    const { result, pollTimes } = await pollOnFakeTime((elapsed) => json(elapsed < POLL_SAFETY_NET_MS ? RUNNING : DONE));
    expect(result).toEqual(DONE);
    expect(pollTimes.at(-1)).toBe(POLL_SAFETY_NET_MS);
  });

  it("reports a refusal that arrives at the last look", async () => {
    const refused = { ok: false, status: 422, text: () => Promise.resolve(JSON.stringify({ success: false, error: "Seedance 2.5: refused" })) };
    const { result } = await pollOnFakeTime((elapsed) => (elapsed < POLL_SAFETY_NET_MS ? json(RUNNING) : refused));
    expect(result).toEqual({ success: false, error: "Seedance 2.5: refused" });
  });

  it("stops at the net with the request id when the provider still says running", async () => {
    const { error, pollTimes } = await pollOnFakeTime(() => json(RUNNING));
    expect(error).toBeInstanceOf(GenerationStillRunningError);
    expect((error as GenerationStillRunningError).taskId).toBe("3544457f");
    expect((error as Error).message).toBe(
      "Seedance 2.5: still running on Comfy Router after 90 minutes (request 3544457f). The node keeps the request; pick it up again from the node."
    );
    // The last poll is the one made at the net, not one before it
    expect(pollTimes.at(-1)).toBe(POLL_SAFETY_NET_MS);
  });

  it("waits only until the net when a Retry-After reaches past it", async () => {
    const { pollTimes } = await pollOnFakeTime((elapsed) =>
      json(elapsed >= POLL_SAFETY_NET_MS - 20_000 ? { ...RUNNING, retryAfterMs: 60_000 } : RUNNING)
    );
    const late = pollTimes.filter((t) => t >= POLL_SAFETY_NET_MS - 20_000);
    expect(late).toHaveLength(2);
    expect(late[1]).toBe(POLL_SAFETY_NET_MS);
  });

  it("stops waiting after ten failed tries in a row, keeping the request", async () => {
    const { error, pollTimes } = await pollOnFakeTime(() => ({ ok: false, status: 502, text: () => Promise.resolve(JSON.stringify({ success: false, error: "fetch failed" })) }));
    expect(error).toBeInstanceOf(GenerationStillRunningError);
    expect((error as Error).message).toBe(
      "Seedance 2.5: stopped checking after 10 failed tries (fetch failed), and the run may still be going on Comfy Router (request 3544457f). The node keeps the request; pick it up again from the node."
    );
    expect(pollTimes).toHaveLength(10);
  });

  it("stops waiting on a refused key, keeping the request: it says nothing about the run", async () => {
    const { error, pollTimes } = await pollOnFakeTime(() => ({ ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ success: false, error: "Comfy API key not configured" })) }));
    expect(error).toBeInstanceOf(GenerationStillRunningError);
    expect((error as Error).message).toBe(
      "Seedance 2.5: could not check on the run (Comfy API key not configured), and it may still be going on Comfy Router (request 3544457f). The node keeps the request; pick it up again from the node."
    );
    expect(pollTimes).toHaveLength(1);
  });

  it("throws an AbortError when the run is stopped, whatever the net", async () => {
    const { error, pollTimes } = await pollOnFakeTime(() => json(RUNNING), { abortAfter: 60_000 });
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(pollTimes.at(-1)).toBeLessThan(60_000);
  });
});
