import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetApiError,
  assetFileUrl,
  assetThumbUrl,
  beginRecord,
  bringInProjects,
  bulkAssets,
  cancelJob,
  dismissProjectsOffer,
  fetchAsset,
  fetchAssetBlob,
  fetchAssetExistence,
  fetchAssetPage,
  fetchAssetWorkflow,
  fetchFacets,
  fetchJob,
  fetchLibraryStatus,
  fetchProjectFolderName,
  fetchProjects,
  mediaHas,
  parseRetryAfter,
  patchAsset,
  putRun,
  reportProjects,
  revealAsset,
  revealLibraryRoot,
  scanProjects,
  startImport,
  uploadAssetBytes,
  uploadMedia,
  uploadPoster,
  upsertWorkflowEntry,
} from "../api";
import { assetView, blobResponse, jsonBody, jsonResponse, libraryStatus, readText, recordResult, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("asset api", () => {
  it("encodes a page request into the list URL and fills missing page fields", async () => {
    const { calls } = stubFetch(() => jsonResponse({ assets: [assetView()], nextCursor: "c2", total: 3 }));
    const page = await fetchAssetPage({ kinds: ["image", "video"], q: "cat", sort: "oldest", cursor: "c1", limit: 50 });

    expect(calls[0].url).toBe("/api/assets?q=cat&kind=image&kind=video&sort=oldest&cursor=c1&limit=50");
    expect(calls[0].method).toBe("GET");
    expect(page).toMatchObject({ nextCursor: "c2", headCursor: null, total: 3, totalBytes: 0 });
    expect(page.assets).toHaveLength(1);
  });

  it("asks the bare list route for an empty request", async () => {
    const { calls } = stubFetch(() => jsonResponse({ assets: [], nextCursor: null, headCursor: null, total: 0, totalBytes: 0 }));
    await fetchAssetPage({});
    expect(calls[0].url).toBe("/api/assets");
  });

  it("rejects a non-2xx answer with the route's error message and status", async () => {
    stubFetch(() => jsonResponse({ error: "No such asset" }, { status: 400 }));
    const error = await patchAsset("a1", { favorite: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssetApiError);
    expect(error).toMatchObject({ message: "No such asset", status: 400 });
  });

  it("carries the route's error code", async () => {
    stubFetch(() => jsonResponse({ error: "The asset library is not available", code: "unavailable" }, { status: 503 }));
    await expect(beginRecord({ meta: {} as never, source: { type: "upload" } })).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
      retryAfterMs: undefined,
    });
    stubFetch(() => jsonResponse({ error: "No such asset" }, { status: 404 }));
    await expect(patchAsset("a1", { favorite: true })).rejects.toMatchObject({ status: 404, code: undefined });
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    stubFetch(() => jsonResponse("", { status: 500 }));
    await expect(fetchFacets()).rejects.toMatchObject({ status: 500, message: "500 Error" });
  });

  it("carries Retry-After from a 503", async () => {
    stubFetch(() => jsonResponse({ error: "The library is moving" }, { status: 503, headers: { "Retry-After": "7" } }));
    await expect(fetchLibraryStatus()).rejects.toMatchObject({ status: 503, retryAfterMs: 7000, message: "The library is moving" });
  });

  it("turns a network failure into status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(fetchLibraryStatus()).rejects.toMatchObject({ name: "AssetApiError", status: 0 });
  });

  it("lets an abort through as an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }));
    await expect(fetchAssetPage({}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reads the library status", async () => {
    stubFetch(() => jsonResponse(libraryStatus({ root: "/lib" })));
    await expect(fetchLibraryStatus()).resolves.toMatchObject({ available: true, root: "/lib" });
  });

  it("answers null for a missing asset and unwraps a wrapped one", async () => {
    stubFetch(({ url }) => (url.endsWith("/missing") ? jsonResponse({ error: "Not found" }, { status: 404 }) : jsonResponse({ asset: assetView() })));
    await expect(fetchAsset("missing")).resolves.toBeNull();
    await expect(fetchAsset("a1")).resolves.toMatchObject({ id: assetView().id });
  });

  it("sends a rename as a PATCH of the display name and answers the asset", async () => {
    const { calls } = stubFetch(() => jsonResponse(assetView({ name: "Sunset" })));
    await expect(patchAsset("a1", { name: "Sunset" })).resolves.toMatchObject({ name: "Sunset" });
    expect(calls[0]).toMatchObject({ url: "/api/assets/a1", method: "PATCH" });
    expect(jsonBody(calls[0])).toEqual({ name: "Sunset" });
  });

  it("answers null for an asset with no workflow snapshot", async () => {
    stubFetch(() => jsonResponse({ error: "No snapshot" }, { status: 404 }));
    await expect(fetchAssetWorkflow("a1")).resolves.toBeNull();
  });

  describe("fetchAssetExistence", () => {
    it("never rejects: every id is unknown when the request fails", async () => {
      stubFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));
      await expect(fetchAssetExistence(["a1", "a2"])).resolves.toEqual({ a1: "unknown", a2: "unknown" });
    });

    it("keeps the states the server gave and unknown for the rest", async () => {
      const { calls } = stubFetch(() => jsonResponse({ states: { a1: "present", a2: "gone", a3: "bogus" } }));
      await expect(fetchAssetExistence(["a1", "a2", "a3", "a4", "a1"])).resolves.toEqual({
        a1: "present",
        a2: "gone",
        a3: "unknown",
        a4: "unknown",
      });
      expect(calls).toHaveLength(1);
      expect(jsonBody(calls[0])).toEqual({ ids: ["a1", "a2", "a3", "a4"] });
    });

    it("asks in batches and asks nothing for no ids", async () => {
      const { calls } = stubFetch(() => jsonResponse({ states: {} }));
      await fetchAssetExistence([]);
      expect(calls).toHaveLength(0);
      await fetchAssetExistence(Array.from({ length: 1001 }, (_, i) => `a${i}`));
      expect(calls.map((call) => (jsonBody<{ ids: string[] }>(call).ids.length))).toEqual([500, 500, 1]);
    });
  });

  it("starts a recording and tells a ticket from a finished result", async () => {
    const result = recordResult(assetView());
    stubFetch(({ body }) =>
      jsonResponse(String(body).includes('"url"') ? { result } : { ticket: { uploadId: "u1", expiresAt: 1 } }),
    );
    const meta = { ...assetView(), producer: assetView().producer } as never;
    await expect(beginRecord({ meta, source: { type: "upload" } })).resolves.toEqual({ ticket: { uploadId: "u1", expiresAt: 1 } });
    await expect(beginRecord({ meta, source: { type: "url", url: "https://cdn/x.mp4" } })).resolves.toEqual({ result });
  });

  it("uploads bytes as the raw body with the Blob's type", async () => {
    const result = recordResult(assetView());
    const { calls } = stubFetch(() => jsonResponse(result));
    const blob = new Blob(["hello"], { type: "image/png" });
    await expect(uploadAssetBytes("u1", blob)).resolves.toEqual(result);
    expect(calls[0]).toMatchObject({ url: "/api/assets/uploads/u1", method: "PUT" });
    expect(calls[0].headers["content-type"]).toBe("image/png");
    expect(calls[0].body).toBe(blob);
  });

  it("uploads snapshot media with its type in x-nb-mime", async () => {
    const { calls } = stubFetch(() => jsonResponse({ sha256: "f".repeat(64), bytes: 3 }));
    const blob = new Blob(["abc"], { type: "video/mp4" });
    await uploadMedia("f".repeat(64), blob);
    expect(calls[0].url).toBe(`/api/assets/media/${"f".repeat(64)}`);
    expect(calls[0].headers["x-nb-mime"]).toBe("video/mp4");
    expect(calls[0].headers["content-type"]).toBe("video/mp4");
    expect(calls[0].body).toBe(blob);
  });

  it("uploads a poster to the asset's poster route", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    await uploadPoster("a1", new Blob(["x"], { type: "image/webp" }));
    expect(calls[0]).toMatchObject({ url: "/api/assets/a1/poster", method: "PUT" });
    expect(calls[0].headers["content-type"]).toBe("image/webp");
  });

  it("asks which media is missing, and nothing for no hashes", async () => {
    const { calls } = stubFetch(() => jsonResponse({ missing: ["h2", 4] }));
    await expect(mediaHas([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
    await expect(mediaHas(["h1", "h2"])).resolves.toEqual(["h2"]);
    expect(jsonBody(calls[0])).toEqual({ hashes: ["h1", "h2"] });
  });

  it("puts a run and defaults missingMedia", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const request = {
      meta: { id: "r1", workflowId: "wf", workflowName: null, projectPath: null, startedAt: 1 },
      phase: "start" as const,
      workflow: { version: 1 as const, name: "", nodes: [], edges: [], edgeStyle: "curved" },
      mediaHashes: [],
    };
    await expect(putRun("r1", request)).resolves.toEqual({ missingMedia: [] });
    expect(calls[0]).toMatchObject({ url: "/api/assets/runs/r1", method: "PUT" });
    expect(jsonBody(calls[0])).toEqual(request);
  });

  it("encodes the workflow id in the workflow entry route", async () => {
    const entry = { id: "wf_1:a/b", name: "Cats", projectPath: null, createdAt: 1, updatedAt: 1 };
    const { calls } = stubFetch(() => jsonResponse(entry));
    await expect(upsertWorkflowEntry("wf_1:a/b", { name: "Cats", projectPath: null })).resolves.toEqual(entry);
    expect(calls[0].url).toBe("/api/assets/workflows/wf_1%3Aa%2Fb");
    expect(jsonBody(calls[0])).toEqual({ name: "Cats", projectPath: null });
  });

  it("fetches an asset's file through the file route", async () => {
    const { calls } = stubFetch(() => blobResponse(new Blob(["png"], { type: "image/png" })));
    const blob = await fetchAssetBlob("a1");
    expect(calls[0].url).toBe(assetFileUrl("a1"));
    await expect(readText(blob)).resolves.toBe("png");
  });

  it("reveals an asset or the library folder", async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    await revealAsset("a1");
    await revealLibraryRoot();
    expect(calls.map((call) => jsonBody(call))).toEqual([{ id: "a1" }, { target: "root" }]);
  });

  it("unwraps a started job and answers null for an unknown one", async () => {
    const job = { id: "j1", type: "import", state: "running", done: 0, total: 2, bytesDone: 0, bytesTotal: 0, startedAt: 1 };
    stubFetch(({ url, method }) => {
      if (method === "POST") return jsonResponse({ job });
      if (method === "DELETE") return jsonResponse({ ok: true });
      return url.endsWith("/gone") ? jsonResponse({ error: "No job" }, { status: 404 }) : jsonResponse(job);
    });
    await expect(startImport({ projectDirs: ["/p"] })).resolves.toEqual(job);
    await expect(fetchJob("j1")).resolves.toEqual(job);
    await expect(fetchJob("gone")).resolves.toBeNull();
    await expect(cancelJob("j1")).resolves.toBeUndefined();
  });

  it("asks the scan route to search a folder and reads its answer", async () => {
    const found = {
      root: "/work",
      projects: [{ dir: "/work/Campaign", name: "Campaign", mediaCount: 12 }],
      truncated: true,
      unreadable: 2,
    };
    const { calls } = stubFetch(() => jsonResponse(found));
    await expect(scanProjects("/work/")).resolves.toEqual(found);
    expect(calls[0]).toMatchObject({ url: "/api/assets/import/scan", method: "POST" });
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(jsonBody(calls[0])).toEqual({ root: "/work/" });
  });

  it("fills a partial scan answer and drops rows it can't use", async () => {
    stubFetch(() => jsonResponse({ projects: [{ dir: "/a", name: "A" }, { dir: 5 }, null, "x"] }));
    await expect(scanProjects("/work")).resolves.toEqual({
      root: "/work",
      projects: [{ dir: "/a", name: "A", mediaCount: 0 }],
      truncated: false,
      unreadable: 0,
    });
  });

  it("keeps a scan's sizes and its suggestion to use the folder", async () => {
    stubFetch(() => jsonResponse({ root: "/w", projects: [{ dir: "/w/A", name: "A", mediaCount: 1, bytes: 99 }], recommendUse: true }));
    await expect(scanProjects("/w")).resolves.toEqual({
      root: "/w",
      projects: [{ dir: "/w/A", name: "A", mediaCount: 1, bytes: 99 }],
      truncated: false,
      unreadable: 0,
      recommendUse: true,
    });
  });

  it("rejects a refused scan with the route's reason", async () => {
    stubFetch(() => jsonResponse({ error: '"/gone" doesn\'t exist.', code: "not_found" }, { status: 404 }));
    await expect(scanProjects("/gone")).rejects.toMatchObject({ status: 404, code: "not_found", message: '"/gone" doesn\'t exist.' });
  });

  it("fills a partial bulk answer", async () => {
    stubFetch(() => jsonResponse({ affected: 2 }));
    await expect(bulkAssets({ selection: { mode: "ids", ids: ["a1", "a2"] }, op: { action: "trash" } })).resolves.toEqual({
      affected: 2,
      ids: [],
      errors: [],
    });
  });

  it("builds file and thumbnail URLs", () => {
    expect(assetFileUrl("a1")).toBe("/api/assets/a1/file");
    expect(assetFileUrl("a1", true)).toBe("/api/assets/a1/file?download=1");
    expect(assetThumbUrl("f".repeat(64), 320)).toBe(`/api/assets/thumb/${"f".repeat(64)}?w=320`);
  });

  it("parses Retry-After as seconds or a date, capped", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
    expect(parseRetryAfter("999999")).toBe(600_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  describe("projects", () => {
    it("reads the overview, dropping rows it can't use and an empty elsewhere", async () => {
      const { calls } = stubFetch(() =>
        jsonResponse({
          root: "/nb",
          projects: [
            { dir: "/nb/A", name: "A", relativePath: "A", inRoot: true, lastModified: 5, mediaCount: 2 },
            { dir: "/old/B", name: "B" },
            { name: "no dir" },
          ],
          elsewhere: { count: 1, dirs: ["/old/B", 4], bytes: 10, groups: [{ label: "~/old", count: 1 }, { label: 3 }] },
          offerDismissed: true,
        }),
      );
      await expect(fetchProjects()).resolves.toEqual({
        root: "/nb",
        projects: [
          { dir: "/nb/A", name: "A", relativePath: "A", inRoot: true, lastModified: 5, mediaCount: 2 },
          { dir: "/old/B", name: "B", relativePath: null, inRoot: false, lastModified: 0, mediaCount: 0 },
        ],
        elsewhere: { count: 1, dirs: ["/old/B"], bytes: 10, groups: [{ label: "~/old", count: 1 }] },
        offerDismissed: true,
      });
      expect(calls[0]).toMatchObject({ url: "/api/assets/projects", method: "GET" });

      stubFetch(() => jsonResponse({ root: "/nb", projects: [], elsewhere: { count: 0, bytes: 0, groups: [] } }));
      await expect(fetchProjects()).resolves.toMatchObject({ elsewhere: null, offerDismissed: false });
    });

    it("reports, brings in and dismisses through their routes", async () => {
      const job = { id: "j1", type: "projects", state: "running", done: 0, total: 1, bytesDone: 0, bytesTotal: 0, startedAt: 1 };
      const { calls } = stubFetch(({ url }) => {
        if (url.endsWith("/report")) return jsonResponse({ adopted: true, root: "/w" });
        if (url.endsWith("/bring-in")) return jsonResponse({ root: "/nb", job }, { status: 202 });
        return jsonResponse({ ok: true });
      });
      const report = { workflowsDir: "/w", projects: [{ dir: "/p", name: "P", lastOpenedAt: 1 }] };
      await expect(reportProjects(report)).resolves.toEqual({ adopted: true, root: "/w" });
      expect(jsonBody(calls[0])).toEqual(report);
      await expect(bringInProjects({ dirs: ["/p"], mode: "move" })).resolves.toEqual({ root: "/nb", job });
      expect(calls[1]).toMatchObject({ url: "/api/assets/projects/bring-in", method: "POST" });
      await expect(dismissProjectsOffer()).resolves.toBeUndefined();
      expect(calls[2]).toMatchObject({ url: "/api/assets/projects/offer", method: "POST" });
      expect(jsonBody(calls[2])).toEqual({ dismissed: true });
    });

    it("asks for a new project's folder name, encoded", async () => {
      const { calls } = stubFetch(() => jsonResponse({ folder: "A B 2", path: "/nb/A B 2", taken: true }));
      await expect(fetchProjectFolderName("A/B")).resolves.toEqual({ folder: "A B 2", path: "/nb/A B 2", taken: true });
      expect(calls[0].url).toBe("/api/assets/projects/folder-name?name=A%2FB");
      stubFetch(() => jsonResponse({}));
      await expect(fetchProjectFolderName("x")).rejects.toBeInstanceOf(AssetApiError);
    });
  });
});
