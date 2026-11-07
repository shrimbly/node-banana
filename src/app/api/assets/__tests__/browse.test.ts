// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/assets/server", async (importOriginal) =>
  (await import("./support")).mockFacade(await importOriginal()),
);
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as facade from "@/lib/assets/server";
import { LibraryError } from "@/lib/assets/server";
import { encodeAssetPageRequest } from "@/lib/assets/query";
import type { AssetPage } from "@/lib/assets/types";
import { GET as getAsset, PATCH as patchAsset } from "../[id]/route";
import { GET as getWorkflow } from "../[id]/workflow/route";
import { POST as bulk } from "../bulk/route";
import { POST as exists } from "../exists/route";
import { GET as getFacets } from "../facets/route";
import { POST as reveal } from "../reveal/route";
import { GET as list, POST as record } from "../route";
import { ASSET_ID, RUN_ID, assetView, crossSite, ctx, page, unvouch, vouch } from "./support";

const EMPTY_PAGE: AssetPage = { assets: [], nextCursor: null, headCursor: null, total: 0, totalBytes: 0 };

function recordBody(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      id: ASSET_ID,
      kind: "image",
      origin: "generated",
      createdAt: 1,
      producer: { nodeId: "n1", nodeType: "nanoBanana" },
      workflowId: "wf_1",
      workflowName: null,
      runId: RUN_ID,
      ...overrides,
    },
    source: { type: "upload" },
  };
}

beforeEach(vouch);
afterEach(() => {
  unvouch();
  vi.resetAllMocks();
});

describe("GET /api/assets", () => {
  it("decodes the query string and answers the page", async () => {
    vi.mocked(facade.listAssets).mockResolvedValue({ ...EMPTY_PAGE, total: 3 });
    const query = encodeAssetPageRequest({ scope: "trash", kinds: ["image", "video"], q: "cat", limit: 50 });
    const response = await list(page(`/api/assets?${query}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...EMPTY_PAGE, total: 3 });
    expect(facade.listAssets).toHaveBeenCalledWith({ scope: "trash", kinds: ["image", "video"], q: "cat", limit: 50 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes a library refusal of the cursor through as its status", async () => {
    vi.mocked(facade.listAssets).mockRejectedValue(new LibraryError("That cursor is not valid.", 400, "bad_cursor"));
    const response = await list(page("/api/assets?cursor=zzz"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That cursor is not valid.", code: "bad_cursor" });
  });

  it("answers an unexpected failure with 500", async () => {
    vi.mocked(facade.listAssets).mockRejectedValue(new Error("index exploded"));
    const response = await list(page("/api/assets"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "index exploded", code: "internal" });
  });

  it("refuses another website with 403 and never asks the library", async () => {
    const response = await list(crossSite("/api/assets", "GET"));
    expect(response.status).toBe(403);
    expect(facade.listAssets).not.toHaveBeenCalled();
  });
});

describe("POST /api/assets", () => {
  it("answers a ticket for an upload", async () => {
    vi.mocked(facade.beginRecord).mockResolvedValue({ ticket: { uploadId: "up_1", expiresAt: 9 } });
    const response = await record(page("/api/assets", { json: recordBody() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ticket: { uploadId: "up_1", expiresAt: 9 } });
    expect(facade.beginRecord).toHaveBeenCalledWith(expect.objectContaining({ source: { type: "upload" } }));
    expect(vi.mocked(facade.beginRecord).mock.calls[0][0].meta).toMatchObject({ id: ASSET_ID, runId: RUN_ID });
  });

  it("passes an upload's origin and display name through", async () => {
    vi.mocked(facade.beginRecord).mockResolvedValue({ ticket: { uploadId: "up_1", expiresAt: 9 } });
    const response = await record(page("/api/assets", { json: recordBody({ kind: "video", origin: "uploaded", name: "sunset.mp4" }) }));
    expect(response.status).toBe(200);
    expect(vi.mocked(facade.beginRecord).mock.calls[0][0].meta).toMatchObject({ kind: "video", origin: "uploaded", name: "sunset.mp4" });
  });

  it("answers the result for a url source", async () => {
    const result = { asset: assetView(), filename: "x.png", legacyId: "x", reusedFile: false };
    vi.mocked(facade.beginRecord).mockResolvedValue({ result });
    const body = { ...recordBody(), source: { type: "url", url: "https://cdn.example.com/x.png" } };
    const response = await record(page("/api/assets", { json: body }));
    expect(await response.json()).toEqual({ result });
  });

  it("answers 503 with Retry-After while the library is moving", async () => {
    vi.mocked(facade.beginRecord).mockRejectedValue(new LibraryError("The library is moving.", 503, "paused"));
    const response = await record(page("/api/assets", { json: recordBody() }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "The library is moving.", code: "paused" });
  });

  it("refuses a malformed request with 400", async () => {
    const response = await record(page("/api/assets", { json: recordBody({ id: "../../etc" }) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/meta\.id/);
    expect(facade.beginRecord).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, and one over 1 MB", async () => {
    const notJson = await record(page("/api/assets", { method: "POST", body: "{", headers: { "content-type": "application/json" } }));
    expect(notJson.status).toBe(400);
    const tooBig = await record(page("/api/assets", { json: recordBody({ prompt: "x".repeat(1024 * 1024) }) }));
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toMatchObject({ code: "too_large" });
  });

  it("refuses a cross-site form post", async () => {
    expect((await record(crossSite("/api/assets"))).status).toBe(403);
  });
});

describe("GET /api/assets/facets", () => {
  it("answers the facets", async () => {
    const facets = { total: 1 } as unknown as Awaited<ReturnType<typeof facade.getFacets>>;
    vi.mocked(facade.getFacets).mockResolvedValue(facets);
    const response = await getFacets(page("/api/assets/facets"));
    expect(await response.json()).toEqual({ total: 1 });
  });
});

describe("GET/PATCH /api/assets/[id]", () => {
  it("answers the asset", async () => {
    vi.mocked(facade.getAsset).mockResolvedValue(assetView());
    const response = await getAsset(page(`/api/assets/${ASSET_ID}`), ctx({ id: ASSET_ID }));
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(ASSET_ID);
    expect(facade.getAsset).toHaveBeenCalledWith(ASSET_ID);
  });

  it("answers 404 for an asset the library does not have", async () => {
    vi.mocked(facade.getAsset).mockResolvedValue(null);
    const response = await getAsset(page(`/api/assets/${ASSET_ID}`), ctx({ id: ASSET_ID }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("refuses an id that is not an asset id before asking the library", async () => {
    for (const id of ["..", "a0123456789ABC", "a01%2F..", "x"]) {
      const response = await getAsset(page(`/api/assets/x`), ctx({ id }));
      expect(response.status, id).toBe(400);
    }
    expect(facade.getAsset).not.toHaveBeenCalled();
  });

  it("patches tags, favorite and trashed", async () => {
    vi.mocked(facade.patchAsset).mockResolvedValue(assetView({ favorite: true }));
    const response = await patchAsset(
      page(`/api/assets/${ASSET_ID}`, { method: "PATCH", json: { favorite: true, tags: ["cats"] } }),
      ctx({ id: ASSET_ID }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).favorite).toBe(true);
    expect(facade.patchAsset).toHaveBeenCalledWith(ASSET_ID, { favorite: true, tags: ["cats"] });
  });

  it("passes a display name through trimmed, and refuses one of more than one line", async () => {
    vi.mocked(facade.patchAsset).mockResolvedValue(assetView({ name: "Sunset" }));
    const response = await patchAsset(
      page(`/api/assets/${ASSET_ID}`, { method: "PATCH", json: { name: " Sunset " } }),
      ctx({ id: ASSET_ID }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).name).toBe("Sunset");
    expect(facade.patchAsset).toHaveBeenCalledWith(ASSET_ID, { name: "Sunset" });

    const refused = await patchAsset(
      page(`/api/assets/${ASSET_ID}`, { method: "PATCH", json: { name: "Sun\nset" } }),
      ctx({ id: ASSET_ID }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "name must be one line.", code: "bad_request" });
    expect(facade.patchAsset).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty patch, and answers 404 for a missing asset", async () => {
    const empty = await patchAsset(page(`/api/assets/${ASSET_ID}`, { method: "PATCH", json: {} }), ctx({ id: ASSET_ID }));
    expect(empty.status).toBe(400);
    vi.mocked(facade.patchAsset).mockResolvedValue(null);
    const missing = await patchAsset(
      page(`/api/assets/${ASSET_ID}`, { method: "PATCH", json: { favorite: false } }),
      ctx({ id: ASSET_ID }),
    );
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/assets/[id]/workflow", () => {
  it("answers the stored workflow", async () => {
    const result = { which: "final" } as unknown as Awaited<ReturnType<typeof facade.getAssetWorkflow>>;
    vi.mocked(facade.getAssetWorkflow).mockResolvedValue(result);
    const response = await getWorkflow(page(`/api/assets/${ASSET_ID}/workflow`), ctx({ id: ASSET_ID }));
    expect(await response.json()).toEqual({ which: "final" });
  });

  it("answers 404 when there is none", async () => {
    vi.mocked(facade.getAssetWorkflow).mockResolvedValue(null);
    const response = await getWorkflow(page(`/api/assets/${ASSET_ID}/workflow`), ctx({ id: ASSET_ID }));
    expect(response.status).toBe(404);
  });

  it("refuses a bad asset id", async () => {
    const response = await getWorkflow(page(`/api/assets/x/workflow`), ctx({ id: "r0123456789abc" }));
    expect(response.status).toBe(400);
    expect(facade.getAssetWorkflow).not.toHaveBeenCalled();
  });
});

describe("POST /api/assets/bulk", () => {
  it("runs the operation over the selection", async () => {
    vi.mocked(facade.bulkAssets).mockResolvedValue({ affected: 1, ids: [ASSET_ID], errors: [] });
    const body = { selection: { mode: "query", query: { scope: "trash" } }, op: { action: "delete" } };
    const response = await bulk(page("/api/assets/bulk", { json: body }));
    expect(await response.json()).toEqual({ affected: 1, ids: [ASSET_ID], errors: [] });
    expect(facade.bulkAssets).toHaveBeenCalledWith({
      selection: { mode: "query", query: { scope: "trash" }, excludeIds: [] },
      op: { action: "delete" },
    });
  });

  it("refuses an unknown scope rather than acting on the whole library", async () => {
    const body = { selection: { mode: "query", query: { scope: "trashh" } }, op: { action: "delete" } };
    const response = await bulk(page("/api/assets/bulk", { json: body }));
    expect(response.status).toBe(400);
    expect(facade.bulkAssets).not.toHaveBeenCalled();
  });
});

describe("POST /api/assets/exists", () => {
  it("answers a state for every id, asking the library only about asset ids", async () => {
    vi.mocked(facade.assetExistence).mockResolvedValue({ [ASSET_ID]: "gone" });
    const response = await exists(page("/api/assets/exists", { json: { ids: [ASSET_ID, "legacy_123", ASSET_ID] } }));
    expect(await response.json()).toEqual({ states: { [ASSET_ID]: "gone", legacy_123: "unknown" } });
    expect(facade.assetExistence).toHaveBeenCalledWith([ASSET_ID]);
  });

  it("does not trouble the library when no id could be an asset", async () => {
    const response = await exists(page("/api/assets/exists", { json: { ids: ["legacy"] } }));
    expect(await response.json()).toEqual({ states: { legacy: "unknown" } });
    expect(facade.assetExistence).not.toHaveBeenCalled();
  });

  it("refuses more than 1,000 ids", async () => {
    const response = await exists(page("/api/assets/exists", { json: { ids: new Array(1001).fill(ASSET_ID) } }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/assets/reveal", () => {
  it("reveals an asset", async () => {
    vi.mocked(facade.revealAsset).mockResolvedValue();
    const response = await reveal(page("/api/assets/reveal", { json: { id: ASSET_ID } }));
    expect(await response.json()).toEqual({ ok: true });
    expect(facade.revealAsset).toHaveBeenCalledWith(ASSET_ID);
    expect(facade.revealLibraryRoot).not.toHaveBeenCalled();
  });

  it("reveals the library folder", async () => {
    vi.mocked(facade.revealLibraryRoot).mockResolvedValue();
    const response = await reveal(page("/api/assets/reveal", { json: { target: "root" } }));
    expect(response.status).toBe(200);
    expect(facade.revealLibraryRoot).toHaveBeenCalled();
  });

  it("maps a missing file to the library's status", async () => {
    vi.mocked(facade.revealAsset).mockRejectedValue(new LibraryError("File not found.", 404, "missing"));
    const response = await reveal(page("/api/assets/reveal", { json: { id: ASSET_ID } }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "File not found.", code: "missing" });
  });

  it("refuses a path instead of an id", async () => {
    const response = await reveal(page("/api/assets/reveal", { json: { id: "/etc/passwd" } }));
    expect(response.status).toBe(400);
  });
});
