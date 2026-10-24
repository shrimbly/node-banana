import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_ID_PATTERN,
  type AssetRunContext,
  type LibraryStatus,
  type PutRunRequest,
  type RecordAssetInput,
  type RecordAssetMeta,
  type RecordAssetRequest,
  type RecordAssetResult,
} from "../../types";
import type { CapturedGraph } from "../snapshot";
import {
  assetView,
  dataUrlOf,
  fakeMediaServer,
  jsonBody,
  jsonResponse,
  libraryStatus,
  readBytes,
  readText,
  recordResult,
  sha256Of,
  type FetchCall,
} from "./helpers";

const { ensurePoster } = vi.hoisted(() => ({ ensurePoster: vi.fn(async () => true) }));
vi.mock("../poster", () => ({ ensurePoster }));

type Recorder = typeof import("../recorder");
let recorder: Recorder;

beforeEach(async () => {
  // Queue, runs and status live in the module: each test gets a fresh one.
  vi.resetModules();
  recorder = await import("../recorder");
  ensurePoster.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RUN: AssetRunContext = {
  runId: "r0000000000001abcdefghij",
  workflowId: "wf_1_cats",
  workflowName: "Cats",
  projectDir: "/Users/test/Projects/Cats",
  startedAt: 1_000,
};

function input(media: string | Blob, overrides: Partial<RecordAssetInput> = {}): RecordAssetInput {
  return {
    kind: "image",
    origin: "generated",
    media,
    prompt: "a cat",
    model: { provider: "gemini", modelId: "nano-banana" },
    producer: { nodeId: "nanoBanana-1", nodeType: "nanoBanana" },
    ...overrides,
  };
}

function graph(nodes: unknown[] = [{ id: "prompt-1", type: "prompt", data: { prompt: "a cat" } }]): CapturedGraph {
  return { nodes, edges: [], edgeStyle: "curved", workflowId: RUN.workflowId, workflowName: RUN.workflowName };
}

async function resultFor(meta: RecordAssetMeta, bytes: Uint8Array): Promise<RecordAssetResult> {
  return recordResult(
    assetView({
      id: meta.id,
      kind: meta.kind,
      origin: meta.origin,
      mime: meta.mime ?? "application/octet-stream",
      bytes: bytes.length,
      sha256: await sha256Of(bytes),
      producer: meta.producer,
      runId: meta.runId,
      workflowId: meta.workflowId,
    }),
  );
}

/** The record, upload, run and workflow routes, in memory. `route` answers first. */
function fakeLibrary(
  options: { status?: LibraryStatus; route?: (call: FetchCall) => Response | undefined | Promise<Response | undefined> } = {},
) {
  const tickets = new Map<string, RecordAssetMeta>();
  const records: RecordAssetRequest[] = [];
  const uploads: { meta: RecordAssetMeta; blob: Blob }[] = [];
  const runs: { runId: string; body: PutRunRequest }[] = [];
  const entries: { id: string; body: Record<string, unknown> }[] = [];
  let tickets_ = 0;
  const server = fakeMediaServer(async (call) => {
    const answered = await options.route?.(call);
    if (answered) return answered;
    if (call.url === "/api/assets/library") return jsonResponse(options.status ?? libraryStatus());
    if (call.url === "/api/assets" && call.method === "POST") {
      const request = jsonBody<RecordAssetRequest>(call);
      records.push(request);
      if (request.source.type === "url") return jsonResponse({ result: await resultFor(request.meta, new TextEncoder().encode(request.source.url)) });
      const uploadId = `u${++tickets_}`;
      tickets.set(uploadId, request.meta);
      return jsonResponse({ ticket: { uploadId, expiresAt: Date.now() + 600_000 } });
    }
    const upload = /^\/api\/assets\/uploads\/(.+)$/.exec(call.url);
    if (upload) {
      const meta = tickets.get(upload[1])!;
      const blob = call.body as Blob;
      uploads.push({ meta, blob });
      const result = await resultFor(meta, await readBytes(blob));
      // Snapshot refs resolve to asset files as well as the media store.
      server.media.set(result.asset.sha256, blob);
      return jsonResponse(result);
    }
    const workflow = /^\/api\/assets\/workflows\/(.+)$/.exec(call.url);
    if (workflow) {
      const body = jsonBody(call);
      entries.push({ id: decodeURIComponent(workflow[1]), body });
      return jsonResponse({ id: decodeURIComponent(workflow[1]), ...body, createdAt: 1, updatedAt: 1 });
    }
    const run = /^\/api\/assets\/runs\/(.+)$/.exec(call.url);
    if (run) {
      runs.push({ runId: run[1], body: jsonBody<PutRunRequest>(call) });
      return jsonResponse({ missingMedia: [] });
    }
    return undefined;
  });
  return { ...server, tickets, records, uploads, runs, entries };
}

/** Lets queued jobs and their follow-ups run. */
async function settleAll() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("initAssetLibrary", () => {
  it("asks once, shares the request, and enables recording when available", async () => {
    const server = fakeLibrary();
    const seen: LibraryStatus[] = [];
    recorder.onLibraryStatus((status) => seen.push(status));
    expect(recorder.isRecorderEnabled()).toBe(false);

    const [a, b] = await Promise.all([recorder.initAssetLibrary(), recorder.initAssetLibrary()]);
    await recorder.initAssetLibrary();
    expect(a).toEqual(b);
    expect(server.calls.filter((call) => call.url === "/api/assets/library")).toHaveLength(1);
    expect(recorder.isRecorderEnabled()).toBe(true);
    expect(recorder.getRecorderLibraryStatus()).toMatchObject({ available: true });
    expect(seen).toHaveLength(1);
  });

  it("stays off while the library is unavailable, asking again every minute until it comes back", async () => {
    vi.useFakeTimers();
    let status = libraryStatus({ available: false, reason: "Node Banana can't write to the library folder." });
    const server = fakeLibrary({ route: (call) => (call.url === "/api/assets/library" ? jsonResponse(status) : undefined) });
    const statusCalls = () => server.calls.filter((call) => call.url === "/api/assets/library").length;
    const seen: boolean[] = [];
    recorder.onLibraryStatus((next) => seen.push(next.available));
    await expect(recorder.initAssetLibrary()).resolves.toMatchObject({ available: false });
    expect(recorder.isRecorderEnabled()).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusCalls()).toBe(2);
    expect(recorder.isRecorderEnabled()).toBe(false);
    // The same answer again is not news.
    expect(seen).toEqual([false]);

    // The drive is plugged back in.
    status = libraryStatus();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusCalls()).toBe(3);
    expect(recorder.isRecorderEnabled()).toBe(true);
    expect(seen).toEqual([false, true]);
    const later = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(100);
    await expect(later.done).resolves.not.toBeNull();

    // Available: no more polling.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(statusCalls()).toBe(3);
  });

  it.each(["hosted", "guard"] as const)("does not poll a library that is off for good (%s), but still asks on returning to the page", async (reasonCode) => {
    vi.useFakeTimers();
    const server = fakeLibrary({ status: libraryStatus({ available: false, reason: "Not here", reasonCode }) });
    const statusCalls = () => server.calls.filter((call) => call.url === "/api/assets/library").length;
    await recorder.initAssetLibrary();
    expect(recorder.isRecorderEnabled()).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(statusCalls()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls()).toBe(2);
    // Throttled as before
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusCalls()).toBe(2);
  });

  it("asks again 15 s after the library went away, then every minute", async () => {
    vi.useFakeTimers();
    let status = libraryStatus();
    const server = fakeLibrary({ route: (call) => (call.url === "/api/assets/library" ? jsonResponse(status) : undefined) });
    const statusCalls = () => server.calls.filter((call) => call.url === "/api/assets/library").length;
    await recorder.initAssetLibrary();

    // A focus re-check right after the machine wakes, before the disk is back
    status = libraryStatus({ available: false, reason: "The library folder is gone.", reasonCode: "unavailable" });
    await vi.advanceTimersByTimeAsync(31_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.isRecorderEnabled()).toBe(false);
    expect(statusCalls()).toBe(2);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(statusCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusCalls()).toBe(3);

    // Still gone: the usual minute
    await vi.advanceTimersByTimeAsync(59_000);
    expect(statusCalls()).toBe(3);
    status = libraryStatus();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusCalls()).toBe(4);
    expect(recorder.isRecorderEnabled()).toBe(true);
  });

  it("does not poll from a hidden page, and asks on its return", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const server = fakeLibrary({ status: libraryStatus({ available: false, reason: "Unplugged" }) });
    await recorder.initAssetLibrary();
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(180_000);
    expect(server.calls).toHaveLength(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(2);
  });

  it("asks again on returning to the page, at most every 30 s, and turns recording off when the library went away", async () => {
    vi.useFakeTimers();
    let status = libraryStatus();
    const server = fakeLibrary({ route: (call) => (call.url === "/api/assets/library" ? jsonResponse(status) : undefined) });
    await recorder.initAssetLibrary();
    expect(recorder.isRecorderEnabled()).toBe(true);

    status = libraryStatus({ available: false, reason: "The library folder is gone." });
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(25_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(2);
    expect(recorder.isRecorderEnabled()).toBe(false);
    expect(recorder.getRecorderLibraryStatus()?.reason).toBe("The library folder is gone.");
  });

  it("watches the page even when the status was asked for before init", async () => {
    vi.useFakeTimers();
    const server = fakeLibrary();
    await recorder.refreshAssetLibrary();
    await recorder.initAssetLibrary();
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(2);
  });

  it("takes a switch made in Settings, and ignores an older answer that arrives after it", async () => {
    let answer!: (response: Response) => void;
    fakeLibrary({
      route: (call) => (call.url === "/api/assets/library" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined),
    });
    const init = recorder.initAssetLibrary();
    recorder.applyLibraryStatus(libraryStatus({ root: "/Volumes/New/Node Banana" }));
    answer(jsonResponse(libraryStatus({ available: false, reason: "Unplugged", root: "/Volumes/Old/Node Banana" })));
    await init;
    expect(recorder.isRecorderEnabled()).toBe(true);
    expect(recorder.getRecorderLibraryStatus()?.root).toBe("/Volumes/New/Node Banana");
  });

  it("asks again every 30 s after a failed status request", async () => {
    vi.useFakeTimers();
    let up = false;
    const server = fakeLibrary({ route: (call) => (!up && call.url === "/api/assets/library" ? jsonResponse({ error: "down" }, { status: 502 }) : undefined) });
    await expect(recorder.initAssetLibrary()).resolves.toBeNull();
    expect(recorder.isRecorderEnabled()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.calls).toHaveLength(2);
    expect(recorder.isRecorderEnabled()).toBe(false);

    up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.calls).toHaveLength(3);
    expect(recorder.isRecorderEnabled()).toBe(true);
    await expect(recorder.initAssetLibrary()).resolves.toMatchObject({ available: true });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.calls).toHaveLength(3);
  });

  it("takes a status the caller already has", async () => {
    const seen: boolean[] = [];
    recorder.onLibraryStatus((status) => seen.push(status.available));
    recorder.applyLibraryStatus(libraryStatus({ available: true }));
    expect(recorder.isRecorderEnabled()).toBe(true);
    expect(seen).toEqual([true]);
  });
});

describe("recordAsset", () => {
  beforeEach(() => {
    recorder.applyLibraryStatus(libraryStatus());
  });

  it("returns a minted id at once and uploads the decoded bytes with the run's metadata", async () => {
    const server = fakeLibrary();
    const recorded: RecordAssetResult[] = [];
    recorder.onAssetRecorded((result) => recorded.push(result));
    const handle = recorder.recordAsset(
      input(dataUrlOf("PNGDATA"), {
        width: 640,
        height: 480,
        parameters: { seed: 4, mask: dataUrlOf("MASK"), nested: { ref: "blob:http://localhost/x", keep: "yes" } },
      }),
      RUN,
    );
    expect(handle.assetId).toMatch(ASSET_ID_PATTERN);

    const result = await handle.done;
    expect(result?.asset.id).toBe(handle.assetId);
    expect(recorded).toEqual([result]);

    const [request] = server.records;
    expect(request.source).toEqual({ type: "upload" });
    expect(request.meta).toMatchObject({
      id: handle.assetId,
      kind: "image",
      origin: "generated",
      mime: "image/png",
      prompt: "a cat",
      workflowId: RUN.workflowId,
      workflowName: "Cats",
      projectDir: RUN.projectDir,
      runId: RUN.runId,
      width: 640,
      height: 480,
      parameters: { seed: 4, nested: { keep: "yes" } },
    });
    expect(typeof request.meta.createdAt).toBe("number");

    const [upload] = server.uploads;
    expect(upload.blob.type).toBe("image/png");
    await expect(readText(upload.blob)).resolves.toBe("PNGDATA");
    const put = server.calls.find((call) => call.url.startsWith("/api/assets/uploads/"))!;
    expect(put.headers["content-type"]).toBe("image/png");
  });

  it("sends the batch tag of a run that is one of a batch, and none otherwise", async () => {
    const server = fakeLibrary();
    const batch = { id: "batch-1", index: 2, count: 4 };
    await recorder.recordAsset(input(dataUrlOf("A")), { ...RUN, batch }).done;
    await recorder.recordAsset(input(dataUrlOf("B")), RUN).done;
    expect(server.records[0].meta.batch).toEqual(batch);
    expect("batch" in server.records[1].meta).toBe(false);
  });

  it("decodes a data: URL with parameters, and one that is percent-encoded", async () => {
    const server = fakeLibrary();
    await recorder.recordAsset(input("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E"), RUN).done;
    await recorder.recordAsset(input(`data:image/webp;charset=binary;base64,${btoa("WEBP")}`), RUN).done;
    expect(server.records.map((record) => record.meta.mime)).toEqual(["image/svg+xml", "image/webp"]);
    await expect(readText(server.uploads[0].blob)).resolves.toBe("<svg/>");
    await expect(readText(server.uploads[1].blob)).resolves.toBe("WEBP");
  });

  it("fetches a blob: URL when called, so revoking it afterwards loses nothing", async () => {
    const server = fakeLibrary();
    const url = "blob:http://localhost/clip";
    server.blobs.set(url, new Blob(["CLIP"], { type: "video/mp4" }));
    const handle = recorder.recordAsset(input(url, { kind: "video", producer: { nodeId: "videoTrim-1", nodeType: "videoTrim", operation: "trim" }, origin: "edited" }), RUN);
    expect(server.calls.map((call) => call.url)).toEqual([url]);
    server.blobs.delete(url);

    const result = await handle.done;
    expect(result).not.toBeNull();
    expect(server.records[0].meta.mime).toBe("video/mp4");
    await expect(readText(server.uploads[0].blob)).resolves.toBe("CLIP");
  });

  it("uploads a Blob as it is", async () => {
    const server = fakeLibrary();
    const blob = new Blob(["GIF89a"], { type: "image/gif" });
    await recorder.recordAsset(input(blob, { origin: "edited" }), RUN).done;
    expect(server.uploads[0].blob).toBe(blob);
    expect(server.records[0].meta.mime).toBe("image/gif");
  });

  it("lets the server download an https URL", async () => {
    const server = fakeLibrary();
    const result = await recorder.recordAsset(input("https://cdn.example.com/model.glb", { kind: "3d", mime: "model/gltf-binary" }), RUN).done;
    expect(result).not.toBeNull();
    expect(server.records[0].source).toEqual({ type: "url", url: "https://cdn.example.com/model.glb" });
    expect(server.records[0].meta.mime).toBe("model/gltf-binary");
    expect(server.uploads).toHaveLength(0);
  });

  it("reports media it cannot read and resolves null", async () => {
    fakeLibrary();
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));
    await expect(recorder.recordAsset(input("ftp://example.com/x.png"), RUN).done).resolves.toBeNull();
    await expect(recorder.recordAsset(input("blob:http://localhost/revoked"), RUN).done).resolves.toBeNull();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/can't be saved/);
  });

  it("uploads two at a time and counts what is pending", async () => {
    const gates: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const server = fakeLibrary({
      route: (call) => {
        if (!(call.url === "/api/assets" && call.method === "POST")) return undefined;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          gates.push(() => {
            inFlight -= 1;
            resolve(jsonResponse({ result: recordResult(assetView({ id: jsonBody<RecordAssetRequest>(call).meta.id })) }));
          });
        });
      },
    });

    const handles = Array.from({ length: 5 }, (_, i) => recorder.recordAsset(input(dataUrlOf(`IMG${i}`)), RUN));
    expect(recorder.pendingRecordings()).toBe(5);
    await settleAll();
    expect(gates).toHaveLength(2);

    while (gates.length) {
      gates.shift()!();
      await settleAll();
    }
    await Promise.all(handles.map((handle) => handle.done));
    expect(maxInFlight).toBe(2);
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(5);
    expect(recorder.pendingRecordings()).toBe(0);
  });

  it("retries a 503, honouring Retry-After", async () => {
    vi.useFakeTimers();
    let refusals = 1;
    const server = fakeLibrary({
      route: (call) =>
        call.url === "/api/assets" && refusals-- > 0
          ? jsonResponse({ error: "The library is moving" }, { status: 503, headers: { "Retry-After": "5" } })
          : undefined,
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(server.records).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await expect(handle.done).resolves.not.toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(2);
  });

  it("keeps waiting through a long library move rather than dropping the asset", async () => {
    vi.useFakeTimers();
    let refusals = 8;
    const server = fakeLibrary({
      route: (call) =>
        call.url === "/api/assets" && refusals-- > 0
          ? jsonResponse({ error: "The library is moving" }, { status: 503, headers: { "Retry-After": "30" } })
          : undefined,
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(8 * 30_000 + 1_000);
    await expect(handle.done).resolves.not.toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(9);
  });

  it("keeps waiting through a move that takes longer than ten minutes", async () => {
    vi.useFakeTimers();
    const pausedUntil = 20 * 60_000;
    const server = fakeLibrary({
      route: (call) =>
        call.url === "/api/assets" && Date.now() < pausedUntil
          ? jsonResponse({ error: "The library is being moved.", code: "paused" }, { status: 503, headers: { "Retry-After": "5" } })
          : undefined,
    });
    vi.setSystemTime(0);
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(pausedUntil + 10_000);
    await expect(handle.done).resolves.not.toBeNull();
    // It checked the library was still there now and then, not on every refusal.
    const checks = server.calls.filter((call) => call.url === "/api/assets/library").length;
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThanOrEqual(10);
  });

  it("says when a library move holds a recording up, and still records it once the move ends", async () => {
    vi.useFakeTimers();
    let refusals = 3;
    fakeLibrary({
      route: (call) =>
        call.url === "/api/assets" && refusals-- > 0
          ? jsonResponse({ error: "The library is being moved.", code: "paused" }, { status: 503, headers: { "Retry-After": "5" } })
          : undefined,
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    let held = false;
    void handle.held.then(() => (held = true));
    await vi.advanceTimersByTimeAsync(10);
    // A project run can save to its own folder now rather than wait out the move
    expect(held).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(handle.done).resolves.not.toBeNull();
  });

  it("says when the library is gone for now, at once for a recording made while it is known to be", async () => {
    vi.useFakeTimers();
    const reason = "The library folder is not reachable.";
    fakeLibrary({
      status: libraryStatus({ available: false, reason, reasonCode: "unavailable" }),
      route: (call) => (call.url === "/api/assets" ? jsonResponse({ error: reason, code: "unavailable" }, { status: 503 }) : undefined),
    });
    const first = recorder.recordAsset(input(dataUrlOf("A")), RUN);
    let firstHeld = false;
    void first.held.then(() => (firstHeld = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(firstHeld).toBe(true);

    const second = recorder.recordAsset(input(dataUrlOf("B")), RUN);
    let secondHeld = false;
    void second.held.then(() => (secondHeld = true));
    await Promise.resolve();
    expect(secondHeld).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(Promise.all([first.done, second.done])).resolves.toEqual([null, null]);
  });

  it("does not say a recording that goes straight through was held up", async () => {
    fakeLibrary();
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    let held = false;
    void handle.held.then(() => (held = true));
    await expect(handle.done).resolves.not.toBeNull();
    await settleAll();
    expect(held).toBe(false);
  });

  it("stops waiting for a move once the status says the library is gone", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));
    fakeLibrary({
      status: libraryStatus({ available: false, reason: "The move failed and the old folder is gone." }),
      route: (call) =>
        call.url === "/api/assets"
          ? jsonResponse({ error: "The library is being moved.", code: "paused" }, { status: 503, headers: { "Retry-After": "5" } })
          : undefined,
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await expect(handle.done).resolves.toBeNull();
    expect(recorder.isRecorderEnabled()).toBe(false);
    expect(errors).toEqual(["Couldn't save an asset to the library: The move failed and the old folder is gone."]);
  });

  it("retries network failures with backoff, then reports once", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));
    const server = fakeLibrary({
      route: (call) => (call.url === "/api/assets" ? Promise.reject(new TypeError("Failed to fetch")) : undefined),
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(handle.done).resolves.toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(5);
    expect(errors).toEqual(["Couldn't save an asset to the library: Couldn't reach the asset library."]);
  });

  it("re-reads the status when the library is gone, turns recording off, and gives up only after backing off", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));
    const reason = "Node Banana can't write to \"/Volumes/Drive/Node Banana\" (ENOENT).";
    const server = fakeLibrary({
      status: libraryStatus({ available: false, reason, reasonCode: "unavailable" }),
      route: (call) =>
        call.url === "/api/assets" ? jsonResponse({ error: reason, code: "unavailable" }, { status: 503 }) : undefined,
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), { ...RUN, projectDir: null });
    let done: unknown = "pending";
    void handle.done.then((result) => (done = result));
    await vi.advanceTimersByTimeAsync(10);
    // One answer turns recording off for later runs, but does not drop these bytes
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(1);
    expect(server.calls.filter((call) => call.url === "/api/assets/library")).toHaveLength(1);
    expect(recorder.isRecorderEnabled()).toBe(false);
    expect(done).toBe("pending");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(done).toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(5);
    expect(errors).toEqual([`Couldn't save an asset to the library: ${reason}`]);
  });

  it("keeps a recording through a library that is gone for a few seconds, and turns recording back on", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // A share still remounting after the machine woke: the server holds its failed check for 10 s
    const backAt = 10_000;
    const gone = () => Date.now() < backAt;
    const reason = "The library folder is not reachable.";
    const server = fakeLibrary({
      route: (call) => {
        if (call.url === "/api/assets/library") {
          return jsonResponse(gone() ? libraryStatus({ available: false, reason, reasonCode: "unavailable" }) : libraryStatus());
        }
        if (call.url === "/api/assets" && gone()) return jsonResponse({ error: reason, code: "unavailable" }, { status: 503 });
        return undefined;
      },
    });
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));

    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), { ...RUN, projectDir: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(recorder.isRecorderEnabled()).toBe(false);
    // A later output of the same run is not dropped either
    const later = recorder.recordAsset(input(dataUrlOf("PNG2")), { ...RUN, projectDir: null });

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(handle.done).resolves.not.toBeNull();
    await expect(later.done).resolves.not.toBeNull();
    expect(server.uploads).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(recorder.isRecorderEnabled()).toBe(true);
  });

  it("turns recording off after a guard refusal, and gives up at once", async () => {
    const server = fakeLibrary({
      status: libraryStatus({
        available: false,
        reason: "The asset library only answers Node Banana's own page on this computer.",
        reasonCode: "guard",
      }),
      route: (call) => (call.url === "/api/assets" ? jsonResponse({ error: "Refused", code: "forbidden" }, { status: 403 }) : undefined),
    });
    await expect(recorder.recordAsset(input(dataUrlOf("PNG")), RUN).done).resolves.toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(1);
    expect(server.calls.filter((call) => call.url === "/api/assets/library")).toHaveLength(1);
    expect(recorder.isRecorderEnabled()).toBe(false);
  });

  it("records nothing while the library is off for good", async () => {
    const server = fakeLibrary();
    recorder.applyLibraryStatus(libraryStatus({ available: false, reason: "Hosted", reasonCode: "hosted" }));
    await expect(recorder.recordAsset(input(dataUrlOf("PNG")), RUN).done).resolves.toBeNull();
    expect(server.calls).toHaveLength(0);
  });

  it("keeps retrying an unavailable answer the status does not confirm", async () => {
    vi.useFakeTimers();
    let refusals = 1;
    const server = fakeLibrary({
      route: (call) =>
        call.url === "/api/assets" && refusals-- > 0
          ? jsonResponse({ error: "The asset library is not available", code: "unavailable" }, { status: 503 })
          : undefined,
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(handle.done).resolves.not.toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(2);
    expect(recorder.isRecorderEnabled()).toBe(true);
  });

  it("drops queued recordings at once when the library turns out to be off for good", async () => {
    const gates: (() => void)[] = [];
    const server = fakeLibrary({
      status: libraryStatus({ available: false, reason: "Refused", reasonCode: "guard" }),
      route: (call) =>
        call.url === "/api/assets"
          ? new Promise<Response>((resolve) => gates.push(() => resolve(jsonResponse({ error: "Refused", code: "forbidden" }, { status: 403 }))))
          : undefined,
    });
    const handles = Array.from({ length: 4 }, (_, i) => recorder.recordAsset(input(dataUrlOf(`IMG${i}`)), RUN));
    await settleAll();
    expect(gates).toHaveLength(2);
    gates.splice(0).forEach((open) => open());
    await expect(Promise.all(handles.map((handle) => handle.done))).resolves.toEqual([null, null, null, null]);
    // The two queued behind them never asked.
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(2);
  });

  it("does not retry a refusal, and reports the same message once a minute", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));
    const server = fakeLibrary({
      route: (call) => (call.url === "/api/assets" ? jsonResponse({ error: "Invalid asset metadata" }, { status: 400 }) : undefined),
    });

    await expect(recorder.recordAsset(input(dataUrlOf("A")), RUN).done).resolves.toBeNull();
    await expect(recorder.recordAsset(input(dataUrlOf("B")), RUN).done).resolves.toBeNull();
    expect(server.calls.filter((call) => call.url === "/api/assets")).toHaveLength(2);
    expect(errors).toEqual(["Couldn't save an asset to the library: Invalid asset metadata"]);

    await vi.advanceTimersByTimeAsync(60_000);
    await recorder.recordAsset(input(dataUrlOf("C")), RUN).done;
    expect(errors).toHaveLength(2);
  });

  it("says why a recording failed before done resolves null, and nothing for one that went through", async () => {
    let refusals = 1;
    fakeLibrary({
      route: (call) =>
        call.url === "/api/assets" && refusals-- > 0 ? jsonResponse({ error: "The file is empty" }, { status: 400 }) : undefined,
    });
    const refused = recorder.recordAsset(input(dataUrlOf("A")), RUN);
    const order: string[] = [];
    void refused.failed.then(() => order.push("failed"));
    void refused.done.then(() => order.push("done"));
    await expect(refused.done).resolves.toBeNull();
    await expect(refused.failed).resolves.toBe("The file is empty.");
    expect(order).toEqual(["failed", "done"]);

    const kept = recorder.recordAsset(input(dataUrlOf("B")), RUN);
    let failed = false;
    void kept.failed.then(() => (failed = true));
    await expect(kept.done).resolves.not.toBeNull();
    await settleAll();
    expect(failed).toBe(false);
  });

  it("says why when the library is off for good or the media can't be read", async () => {
    fakeLibrary();
    const unreadable = recorder.recordAsset(input("ftp://example.com/x.png"), RUN);
    await expect(unreadable.failed).resolves.toBe("That kind of media can't be saved.");
    recorder.applyLibraryStatus(libraryStatus({ available: false, reason: "The library is off on this server", reasonCode: "hosted" }));
    const off = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await expect(off.done).resolves.toBeNull();
    await expect(off.failed).resolves.toBe("The library is off on this server.");
  });

  it("keeps its own notice back for a caller that tells the user itself", async () => {
    const errors: string[] = [];
    recorder.onRecorderError((message) => errors.push(message));
    fakeLibrary({
      route: (call) => (call.url === "/api/assets" ? jsonResponse({ error: "Invalid asset metadata" }, { status: 400 }) : undefined),
    });
    const quiet = recorder.recordAsset(input(dataUrlOf("A")), RUN, { quiet: true });
    await expect(quiet.done).resolves.toBeNull();
    await expect(quiet.failed).resolves.toBe("Invalid asset metadata.");
    const unreadable = recorder.recordAsset(input("ftp://example.com/x.png"), RUN, { quiet: true });
    await expect(unreadable.done).resolves.toBeNull();
    expect(errors).toEqual([]);

    // A quiet failure does not stand in for the notice of a later one
    await recorder.recordAsset(input(dataUrlOf("B")), RUN).done;
    expect(errors).toEqual(["Couldn't save an asset to the library: Invalid asset metadata"]);
  });

  it("sends the display name it was given, and none otherwise", async () => {
    const server = fakeLibrary();
    const file = new File(["VIDEO"], "sunset.mp4", { type: "video/mp4" });
    await recorder.recordAsset(input(file, { kind: "video", origin: "uploaded", name: "sunset.mp4", prompt: undefined, model: undefined }), RUN).done;
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    expect(server.records[0].meta).toMatchObject({ kind: "video", origin: "uploaded", name: "sunset.mp4", mime: "video/mp4" });
    expect(server.uploads[0].blob).toBe(file);
    expect("name" in server.records[1].meta).toBe(false);
  });

  it("treats a 409 on a retry as the earlier attempt having landed", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let id = "";
    fakeLibrary({
      route: (call) => {
        if (call.url === "/api/assets" && call.method === "POST") {
          attempt += 1;
          id = jsonBody<RecordAssetRequest>(call).meta.id;
          return attempt === 1 ? Promise.reject(new TypeError("Failed to fetch")) : jsonResponse({ error: "Exists" }, { status: 409 });
        }
        if (call.url === `/api/assets/${id}`) return jsonResponse(assetView({ id, filename: "cat_abc.png" }));
        return undefined;
      },
    });
    const handle = recorder.recordAsset(input(dataUrlOf("PNG")), RUN);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(handle.done).resolves.toMatchObject({ asset: { id: handle.assetId }, legacyId: "cat_abc" });
  });

  it("remembers a recorded data: URL's hash for snapshots", async () => {
    const media = dataUrlOf("OUTPUT");
    const server = fakeLibrary();
    const result = await recorder.recordAsset(input(media), RUN).done;
    const digest = vi.spyOn(crypto.subtle, "digest");
    const { encodeSnapshot } = await import("../snapshot");
    const { workflow } = await encodeSnapshot(graph([{ id: "n", type: "nanoBanana", data: { outputImage: media } }]));
    expect(digest).not.toHaveBeenCalled();
    // The server resolves refs to asset files too, so the bytes are not sent twice.
    expect(server.calls.filter((call) => call.url.startsWith("/api/assets/media/") && call.method === "PUT")).toHaveLength(0);
    expect((workflow.nodes[0] as { data: { outputImage: unknown } }).data.outputImage).toEqual({
      $nbMedia: result!.asset.sha256,
      mime: "image/png",
      bytes: 6,
    });
  });

  it("makes sure a recorded video gets a poster, with retries", async () => {
    fakeLibrary();
    const result = await recorder.recordAsset(input(new Blob(["MP4"], { type: "video/mp4" }), { kind: "video" }), RUN).done;
    expect(ensurePoster).toHaveBeenCalledWith(result!.asset);
    expect(result!.asset).toMatchObject({ kind: "video", mime: "video/mp4" });
    await recorder.recordAsset(input(dataUrlOf("PNG")), RUN).done;
    expect(ensurePoster).toHaveBeenCalledTimes(1);
  });
});

describe("runs and snapshots", () => {
  beforeEach(() => {
    recorder.applyLibraryStatus(libraryStatus());
  });

  it("writes nothing for a run until it records an asset", async () => {
    const server = fakeLibrary();
    recorder.beginRun(RUN, graph());
    await settleAll();
    recorder.endRun(RUN.runId, graph());
    await settleAll();
    expect(server.calls).toHaveLength(0);
    expect(recorder.pendingRecordings()).toBe(0);
  });

  it("classifies the workflow and stores the start snapshot on the first asset", async () => {
    const server = fakeLibrary();
    const start = graph([{ id: "imageInput-1", type: "imageInput", data: { image: dataUrlOf("INPUT", "image/jpeg") } }]);
    recorder.beginRun(RUN, start);
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    await recorder.recordAsset(input(dataUrlOf("B")), RUN).done;
    await settleAll();

    // Stamped with the run's start: a rename saved while it ran is newer and wins.
    expect(server.entries).toEqual([{ id: RUN.workflowId, body: { name: "Cats", projectPath: RUN.projectDir, asOf: RUN.startedAt } }]);
    expect(server.runs).toHaveLength(1);
    const [put] = server.runs;
    expect(put.runId).toBe(RUN.runId);
    expect(put.body).toMatchObject({
      phase: "start",
      meta: { id: RUN.runId, workflowId: RUN.workflowId, workflowName: "Cats", projectPath: RUN.projectDir, startedAt: 1_000 },
      mediaHashes: [await sha256Of("INPUT")],
    });
    expect((put.body.workflow.nodes[0] as { data: { image: unknown } }).data.image).toMatchObject({ $nbMedia: await sha256Of("INPUT") });
    expect(server.media.has(await sha256Of("INPUT"))).toBe(true);
  });

  it("writes the final snapshot after the start one", async () => {
    const server = fakeLibrary();
    recorder.beginRun(RUN, graph());
    const result = await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    const final = graph([{ id: "nanoBanana-1", type: "nanoBanana", data: { outputImage: dataUrlOf("A") } }]);
    recorder.endRun(RUN.runId, final);
    expect(recorder.pendingRecordings()).toBeGreaterThan(0);
    await settleAll();

    expect(server.runs.map((run) => run.body.phase)).toEqual(["start", "final"]);
    expect(server.runs[1].body.mediaHashes).toEqual([result!.asset.sha256]);
    expect(recorder.pendingRecordings()).toBe(0);
  });

  it("writes no final snapshot when the canvas was replaced", async () => {
    const server = fakeLibrary();
    recorder.beginRun(RUN, graph());
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    recorder.endRun(RUN.runId, null);
    await settleAll();
    expect(server.runs.map((run) => run.body.phase)).toEqual(["start"]);
  });

  it("waits for recordings still uploading when the run ends", async () => {
    let release!: () => void;
    const server = fakeLibrary({
      route: (call) =>
        call.url.startsWith("/api/assets/uploads/") && !release
          ? new Promise<undefined>((resolve) => {
              release = () => resolve(undefined);
            })
          : undefined,
    });
    recorder.beginRun(RUN, graph());
    const handle = recorder.recordAsset(input(dataUrlOf("A")), RUN);
    await settleAll();
    recorder.endRun(RUN.runId, graph([{ id: "n", type: "nanoBanana", data: { outputImage: dataUrlOf("A") } }]));
    await settleAll();
    expect(server.runs).toHaveLength(0);

    release();
    await handle.done;
    await settleAll();
    expect(server.runs.map((run) => run.body.phase)).toEqual(["start", "final"]);
  });

  it("keeps a held run open for a recording made after it ended, which then gets the run's snapshots", async () => {
    const server = fakeLibrary();
    recorder.beginRun(RUN, graph());
    const release = recorder.holdRun(RUN.runId);
    recorder.endRun(RUN.runId, graph([{ id: "n", type: "videoTrim", data: {} }]));
    await settleAll();
    expect(server.runs).toHaveLength(0);

    // Recorded, then let go (twice: the second does nothing) before it lands
    const handle = recorder.recordAsset(input(dataUrlOf("A")), RUN);
    release();
    release();
    const result = await handle.done;
    await settleAll();
    expect(result?.asset.runId).toBe(RUN.runId);
    expect(server.runs.map((run) => `${run.runId}:${run.body.phase}`)).toEqual([`${RUN.runId}:start`, `${RUN.runId}:final`]);
  });

  it("finishes a held run that recorded nothing once let go, and holds nothing for a run it does not know", async () => {
    const server = fakeLibrary();
    recorder.beginRun(RUN, graph());
    const release = recorder.holdRun(RUN.runId);
    recorder.endRun(RUN.runId, graph());
    release();
    // Finished: a recording now names a run that has no snapshot
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    await settleAll();
    expect(server.runs).toHaveLength(0);
    expect(() => recorder.holdRun("r-unknown")()).not.toThrow();
  });

  it("forgets a run whose recordings all failed", async () => {
    const server = fakeLibrary({
      route: (call) => (call.url === "/api/assets" ? jsonResponse({ error: "Refused" }, { status: 400 }) : undefined),
    });
    recorder.beginRun(RUN, graph());
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    recorder.endRun(RUN.runId, graph());
    await settleAll();
    expect(server.runs).toHaveLength(0);
    expect(server.entries).toHaveLength(0);
  });

  it("lets go of the oldest runs when endRun never came", async () => {
    const server = fakeLibrary();
    recorder.beginRun(RUN, graph());
    for (let i = 0; i < 32; i++) recorder.beginRun({ ...RUN, runId: `r-other-${i}` }, graph());
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    await recorder.recordAsset(input(dataUrlOf("B")), { ...RUN, runId: "r-other-31" }).done;
    await settleAll();
    expect(server.runs.map((run) => run.runId)).toEqual(["r-other-31"]);
  });

  it("ignores endRun for a run it does not know", () => {
    const server = fakeLibrary();
    expect(() => recorder.endRun("r-unknown", graph())).not.toThrow();
    expect(server.calls).toHaveLength(0);
  });

  it("uploads media the run PUT still reports missing", async () => {
    let missing: string[] = [];
    const server = fakeLibrary({
      route: (call) => {
        if (!call.url.startsWith("/api/assets/runs/")) return undefined;
        const answer = jsonResponse({ missingMedia: missing });
        missing = [];
        return answer;
      },
    });
    const start = graph([{ id: "i", type: "imageInput", data: { image: dataUrlOf("INPUT") } }]);
    missing = [await sha256Of("INPUT")];
    server.media.set(missing[0], new Blob(["stale"]));
    recorder.beginRun(RUN, start);
    await recorder.recordAsset(input(dataUrlOf("A")), RUN).done;
    await settleAll();
    const uploads = server.calls.filter((call) => call.method === "PUT" && call.url.startsWith("/api/assets/media/"));
    expect(uploads.map((call) => call.url)).toEqual([`/api/assets/media/${await sha256Of("INPUT")}`]);
  });
});
