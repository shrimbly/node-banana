import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkMagnificTaskOnce, fetchMagnificMediaResult, generateWithMagnific, resolveMagnificKey, submitMagnificTask } from "../magnific";
import { clearMagnificUploads } from "@/lib/providers/magnific/media";
import type { GenerationInput } from "@/lib/providers/types";

/**
 * The Magnific provider below the network: node input → request, and task
 * answer → the app's output. Every model shares one task shape, so these
 * pin the transport once; what each model's body holds is the binding
 * suite's (src/lib/providers/magnific/__tests__).
 */

const PNG_B64 = "iVBORw0KGgo=";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

function makeInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: { id: "text-to-image/flux-2-pro", name: "Flux 2 Pro", description: null, provider: "magnific", capabilities: ["text-to-image"] },
    prompt: "a photo of a cat",
    images: [],
    parameters: {},
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearMagnificUploads();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveMagnificKey", () => {
  it("takes the header, then the env variable", () => {
    vi.stubEnv("MAGNIFIC_API_KEY", "");
    expect(resolveMagnificKey(null)).toBeNull();
    vi.stubEnv("MAGNIFIC_API_KEY", "from-env");
    expect(resolveMagnificKey(null)).toBe("from-env");
    expect(resolveMagnificKey("from-header")).toBe("from-header");
  });
});

describe("submitMagnificTask", () => {
  it("posts the model's body to its route with the key, and returns the task id", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { task_id: "t-1", status: "CREATED" } }));
    const { taskId } = await submitMagnificTask("r", "key", makeInput({ images: [PNG_URL], parameters: { width: 1024 } }));
    expect(taskId).toBe("t-1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.magnific.com/v1/ai/text-to-image/flux-2-pro");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-magnific-api-key": "key", "Content-Type": "application/json" });
    // Flux takes base64: the image handle fell back to `images`, with no upload.
    expect(JSON.parse(init.body)).toEqual({ prompt: "a photo of a cat", input_image: PNG_B64, width: 1024 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads what a field takes only by URL, and sends the URL", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ files: [{ upload_url: "https://storage.example.com/put", headers: {}, asset_url: "https://cdn.example.com/a.png" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({ data: { task_id: "t-2" } }));
    await submitMagnificTask(
      "r",
      "key",
      makeInput({
        model: { id: "text-to-image/nano-banana-pro", name: "Nano Banana Pro", description: null, provider: "magnific", capabilities: ["text-to-image"] },
        dynamicInputs: { reference_images: [PNG_URL] },
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[2]![1].body);
    expect(body).toEqual({ prompt: "a photo of a cat", reference_images: [{ image: "https://cdn.example.com/a.png", mime_type: "image/png" }] });
  });

  it("reads a task id that is not wrapped in data", async () => {
    fetchMock.mockResolvedValueOnce(json({ task_id: "t-3" }));
    expect((await submitMagnificTask("r", "key", makeInput())).taskId).toBe("t-3");
  });

  it("says which required handle is missing, before any request", async () => {
    const input = makeInput({ model: { id: "image-upscaler", name: "Upscaler", description: null, provider: "magnific", capabilities: ["image-to-image"] }, prompt: "" });
    await expect(submitMagnificTask("r", "key", input)).rejects.toThrow("Magnific Upscaler Creative needs image");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a model the app does not bind", async () => {
    const input = makeInput({ model: { id: "loras/styles", name: "x", description: null, provider: "magnific", capabilities: [] } });
    await expect(submitMagnificTask("r", "key", input)).rejects.toThrow(/not a Magnific model this app can run/);
  });

  it("names the field Magnific refused, and why", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Validation error", invalid_params: [{ name: "body", field: "aspect_ratio", reason: "must be one of 1:1, 16:9" }] }, 400));
    await expect(submitMagnificTask("r", "key", makeInput())).rejects.toThrow("Flux 2 Pro: aspect_ratio: must be one of 1:1, 16:9");
  });

  it("passes on Magnific's own message", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Invalid API key" }, 401));
    await expect(submitMagnificTask("r", "key", makeInput())).rejects.toThrow("Flux 2 Pro: Invalid API key");
  });

  it("tries once more after a rate limit, which means the request was not taken", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ message: "slow down" }, 429)).mockResolvedValueOnce(json({ data: { task_id: "t-4" } }));
    const pending = submitMagnificTask("r", "key", makeInput());
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await pending).taskId).toBe("t-4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never repeats a submit whose outcome is unknown", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "upstream error" }, 502));
    await expect(submitMagnificTask("r", "key", makeInput())).rejects.toThrow(/upstream error\. The run may have started/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(submitMagnificTask("r", "key", makeInput())).rejects.toThrow(/did not answer \(fetch failed\)\. The run may have started/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("checkMagnificTaskOnce", () => {
  it("reads the task on the model's status route", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { task_id: "t", status: "IN_PROGRESS", generated: [] } }));
    expect(await checkMagnificTaskOnce("r", "key", "video/kling-v3-pro", "t 1")).toEqual({ status: "processing" });
    const [url, init] = fetchMock.mock.calls[0]!;
    // Kling 3 Pro is made at video/kling-v3-pro and read at video/kling-v3.
    expect(url).toBe("https://api.magnific.com/v1/ai/video/kling-v3/t%201");
    expect(init.headers).toEqual({ "x-magnific-api-key": "key" });
  });

  it("treats a status it has never seen as still running", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { status: "QUEUED" } }));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "processing" });
  });

  it("returns the first output of a finished task", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { status: "COMPLETED", generated: ["https://cdn.example.com/out.png", "https://cdn.example.com/out2.png"] } }));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "completed", url: "https://cdn.example.com/out.png" });
  });

  it("reads a task that is not wrapped in data", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "COMPLETED", generated: ["https://cdn.example.com/out.mp4"] }));
    expect(await checkMagnificTaskOnce("r", "key", "video/kling-v3-pro", "t")).toEqual({ status: "completed", url: "https://cdn.example.com/out.mp4" });
  });

  it("looks again when a task reads COMPLETED before its URLs are there", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ data: { status: "COMPLETED", generated: [] } }))
      .mockResolvedValueOnce(json({ data: { status: "COMPLETED", generated: ["https://cdn.example.com/out.png"] } }));
    const pending = checkMagnificTaskOnce("r", "key", "mystic", "t");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ status: "completed", url: "https://cdn.example.com/out.png" });
  });

  it("fails a task that stays finished with nothing, saying so when it was flagged", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json({ data: { status: "COMPLETED", generated: [], has_nsfw: [true] } }));
    const pending = checkMagnificTaskOnce("r", "key", "mystic", "t");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({
      status: "failed",
      error: "Magnific finished the run without an output (flagged NSFW, so the output may have been withheld)",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("carries the reason of a failed task, wherever Magnific put it", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { status: "FAILED", message: "content policy" } }));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "failed", error: "content policy" });
    fetchMock.mockResolvedValueOnce(json({ data: { status: "FAILED" } }));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "failed", error: "Magnific failed the run and gave no reason" });
  });

  it("keeps polling through a rate limit or an outage, after the wait it names", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "slow down" }, 429, { "Retry-After": "7" }));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "processing", retryAfterMs: 7000 });
    fetchMock.mockResolvedValueOnce(json({ message: "down" }, 503));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "processing", retryAfterMs: undefined });
  });

  it("reports a refused check with Magnific's status, so the caller can tell it from a failed run", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Invalid API key" }, 401));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "failed", error: "Invalid API key", statusCode: 401 });
    fetchMock.mockResolvedValueOnce(json({ message: "Task not found" }, 404));
    expect(await checkMagnificTaskOnce("r", "key", "mystic", "t")).toEqual({ status: "failed", error: "Task not found", statusCode: 404 });
  });
});

describe("fetchMagnificMediaResult", () => {
  it("inlines an image as a data URL of the type it was served as", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from(PNG_B64, "base64"), { status: 200, headers: { "content-type": "image/webp" } }));
    const result = await fetchMagnificMediaResult("r", "mystic", "https://cdn.example.com/out.webp");
    expect(result).toEqual({ success: true, outputs: [{ type: "image", data: `data:image/webp;base64,${PNG_B64}`, url: "https://cdn.example.com/out.webp" }] });
  });

  it("types the output by the model when the server does not say", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "application/octet-stream" } }));
    const result = await fetchMagnificMediaResult("r", "video/kling-v3-pro", "https://cdn.example.com/out");
    expect(result.outputs?.[0]).toMatchObject({ type: "video", data: expect.stringMatching(/^data:video\/mp4;base64,/) });
  });

  it("returns a large video as its URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(30 * 1024 * 1024) } }));
    const result = await fetchMagnificMediaResult("r", "video/kling-v3-pro", "https://cdn.example.com/out.mp4");
    expect(result).toEqual({ success: true, outputs: [{ type: "video", data: "", url: "https://cdn.example.com/out.mp4" }] });
  });

  it("answers a download the CDN refused as final, and one it fumbled as worth another look", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await fetchMagnificMediaResult("r", "mystic", "https://cdn.example.com/out.png")).toMatchObject({ success: false, statusCode: 422 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    expect(await fetchMagnificMediaResult("r", "mystic", "https://cdn.example.com/out.png")).toMatchObject({ success: false, statusCode: 503 });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const dropped = await fetchMagnificMediaResult("r", "mystic", "https://cdn.example.com/out.png");
    expect(dropped.success).toBe(false);
    expect(dropped.statusCode).toBeUndefined();
  });

  it("will not fetch an output from a private address", async () => {
    expect(await fetchMagnificMediaResult("r", "mystic", "http://127.0.0.1/out.png")).toMatchObject({ success: false, statusCode: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generateWithMagnific", () => {
  it("submits, waits and downloads", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ data: { task_id: "t-9" } }))
      .mockResolvedValueOnce(json({ data: { status: "IN_PROGRESS" } }))
      .mockResolvedValueOnce(json({ data: { status: "COMPLETED", generated: ["https://cdn.example.com/out.png"] } }))
      .mockResolvedValueOnce(new Response(Buffer.from(PNG_B64, "base64"), { status: 200, headers: { "content-type": "image/png" } }));
    const pending = generateWithMagnific("r", "key", makeInput());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ success: true, outputs: [{ type: "image", data: PNG_URL, url: "https://cdn.example.com/out.png" }] });
  });

  it("says so when there is no key", async () => {
    expect(await generateWithMagnific("r", null, makeInput())).toEqual({ success: false, error: "Magnific API key not configured" });
  });
});
