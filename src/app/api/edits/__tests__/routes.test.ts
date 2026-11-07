// @vitest-environment node
/**
 * The /api/edits routes: the asset routes' guard, statuses and bodies, the
 * 409 conflict carrying the stored edit, and Retry-After while the library
 * is moving. The edits module is mocked; its errors stay real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edits/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edits/server")>();
  return {
    ...actual,
    listEdits: vi.fn(),
    readEdit: vi.fn(),
    createEdit: vi.fn(),
    saveEdit: vi.fn(),
    patchEdit: vi.fn(),
    deleteEdit: vi.fn(),
    revealEdit: vi.fn(),
    revealEditsFolder: vi.fn(),
  };
});
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { crossSite, ctx, page, unvouch, vouch } from "@/app/api/assets/__tests__/support";
import { LibraryError } from "@/lib/assets/server";
import { pausedError } from "@/lib/assets/server/errors";
import * as edits from "@/lib/edits/server";
import { emptyEditSequence } from "@/lib/edits/document";
import { EDIT_KIND, type EditDocument, type EditList } from "@/lib/edits/types";
import * as one from "../[id]/route";
import * as reveal from "../[id]/reveal/route";
import * as folderReveal from "../folder/reveal/route";
import * as root from "../route";

const ID = "ed0000000000000001";

const DOC: EditDocument = {
  kind: EDIT_KIND,
  version: 1,
  id: ID,
  name: "Trip",
  createdAt: 1,
  updatedAt: 2,
  sequence: emptyEditSequence(),
  media: [],
  assets: {},
  renders: [],
  summary: { clipCount: 0, audioClipCount: 0, durationSec: 0, posterAssetId: null },
};

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ROUTES: { path: string; module: Record<string, unknown>; params: Record<string, string> }[] = [
  { path: "/api/edits", module: root, params: {} },
  { path: `/api/edits/${ID}`, module: one, params: { id: ID } },
  { path: `/api/edits/${ID}/reveal`, module: reveal, params: { id: ID } },
  { path: "/api/edits/folder/reveal", module: folderReveal, params: {} },
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const mocked = () =>
  [edits.listEdits, edits.readEdit, edits.createEdit, edits.saveEdit, edits.patchEdit, edits.deleteEdit, edits.revealEdit, edits.revealEditsFolder].map(
    (fn) => vi.mocked(fn),
  );

beforeEach(vouch);
afterEach(() => {
  unvouch();
  vi.resetAllMocks();
});

describe("every /api/edits route", () => {
  it.each(ROUTES)("$path runs on Node and is never statically cached", ({ module }) => {
    expect(module.runtime).toBe("nodejs");
    expect(module.dynamic).toBe("force-dynamic");
  });

  it.each(ROUTES)("$path refuses another website, and a request the server did not vouch for", async ({ path, module, params }) => {
    const handlers = METHODS.filter((method) => typeof module[method] === "function");
    expect(handlers.length).toBeGreaterThan(0);
    for (const method of handlers) {
      const response = await (module[method] as Handler)(crossSite(path, method), ctx(params));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden" });
    }
    unvouch();
    for (const method of handlers) {
      const response = await (module[method] as Handler)(page(path, { method }), ctx(params));
      expect(response.status, `unvouched ${method} ${path}`).toBe(403);
    }
    for (const fn of mocked()) expect(fn).not.toHaveBeenCalled();
  });
});

describe("/api/edits", () => {
  it("lists", async () => {
    const list: EditList = { edits: [], problems: [{ fileName: "x.nbedit", problem: "unreadable", name: null }], folder: "/Lib/Edits" };
    vi.mocked(edits.listEdits).mockResolvedValue(list);
    const response = await root.GET(page("/api/edits"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(list);
  });

  it("creates with 201 and the document, passing the body on", async () => {
    vi.mocked(edits.createEdit).mockResolvedValue(DOC);
    const response = await root.POST(page("/api/edits", { json: { name: "Trip" } }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ document: DOC });
    expect(edits.createEdit).toHaveBeenCalledWith({ name: "Trip" });
  });

  it("answers 400 for a body that is not JSON, and 413 over 1 MB", async () => {
    const bad = await root.POST(page("/api/edits", { method: "POST", body: "{", headers: { "content-type": "application/json" } }));
    expect(bad.status).toBe(400);
    const big = await root.POST(page("/api/edits", { json: { name: "x".repeat(1024 * 1024) } }));
    expect(big.status).toBe(413);
    expect(edits.createEdit).not.toHaveBeenCalled();
  });

  it("maps the module's refusals", async () => {
    vi.mocked(edits.createEdit).mockRejectedValue(new LibraryError("Edits hold media by library id only.", 400, "bad_request"));
    const response = await root.POST(page("/api/edits", { json: { name: "x" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Edits hold media by library id only.", code: "bad_request" });

    vi.mocked(edits.createEdit).mockRejectedValue(new LibraryError("That file is no longer a copy of another edit.", 409, "not_duplicate"));
    const separate = await root.POST(page("/api/edits", { json: { separate: "x.nbedit" } }));
    expect(separate.status).toBe(409);
    expect(await separate.json()).toMatchObject({ code: "not_duplicate" });
  });
});

describe("/api/edits/[id]", () => {
  it("reads", async () => {
    vi.mocked(edits.readEdit).mockResolvedValue(DOC);
    const response = await one.GET(page(`/api/edits/${ID}`), ctx({ id: ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: DOC });
    expect(edits.readEdit).toHaveBeenCalledWith(ID);
  });

  it("refuses an id that is not an edit's, such as /api/edits/folder itself", async () => {
    const response = await one.GET(page("/api/edits/folder"), ctx({ id: "folder" }));
    expect(response.status).toBe(400);
    expect(edits.readEdit).not.toHaveBeenCalled();
  });

  it("answers 404 with its code", async () => {
    vi.mocked(edits.readEdit).mockRejectedValue(new LibraryError("This edit is no longer in the Edits folder.", 404, "not_found"));
    const response = await one.GET(page(`/api/edits/${ID}`), ctx({ id: ID }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This edit is no longer in the Edits folder.", code: "not_found" });
  });

  it("saves", async () => {
    vi.mocked(edits.saveEdit).mockResolvedValue({ ...DOC, updatedAt: 3 });
    const body = { baseUpdatedAt: 2, sequence: emptyEditSequence(), assets: {}, summary: DOC.summary, renders: [] };
    const response = await one.PUT(page(`/api/edits/${ID}`, { method: "PUT", json: body }), ctx({ id: ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: { ...DOC, updatedAt: 3 } });
    expect(edits.saveEdit).toHaveBeenCalledWith(ID, body);
  });

  it("answers a conflict with 409 and the stored edit", async () => {
    vi.mocked(edits.saveEdit).mockRejectedValue(new edits.EditConflictError({ ...DOC, updatedAt: 9 }));
    const response = await one.PUT(page(`/api/edits/${ID}`, { method: "PUT", json: { baseUpdatedAt: 2 } }), ctx({ id: ID }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This edit was changed in another window.",
      code: "conflict",
      current: { ...DOC, updatedAt: 9 },
    });
  });

  it("asks to retry while the library is moving", async () => {
    vi.mocked(edits.saveEdit).mockRejectedValue(pausedError());
    const response = await one.PUT(page(`/api/edits/${ID}`, { method: "PUT", json: { baseUpdatedAt: 2 } }), ctx({ id: ID }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "paused" });
  });

  it("renames and adds renders", async () => {
    vi.mocked(edits.patchEdit).mockResolvedValue({ document: { ...DOC, name: "New" }, previousUpdatedAt: 2 });
    const response = await one.PATCH(page(`/api/edits/${ID}`, { method: "PATCH", json: { op: "rename", name: "New" } }), ctx({ id: ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: { ...DOC, name: "New" }, previousUpdatedAt: 2 });
    expect(edits.patchEdit).toHaveBeenCalledWith(ID, { op: "rename", name: "New" });

    vi.mocked(edits.patchEdit).mockRejectedValue(new LibraryError("Another edit is already called “New”.", 409, "name_taken"));
    const taken = await one.PATCH(page(`/api/edits/${ID}`, { method: "PATCH", json: { op: "rename", name: "New" } }), ctx({ id: ID }));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "name_taken" });
  });

  it("deletes", async () => {
    vi.mocked(edits.deleteEdit).mockResolvedValue(undefined);
    const response = await one.DELETE(page(`/api/edits/${ID}`, { method: "DELETE" }), ctx({ id: ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(edits.deleteEdit).toHaveBeenCalledWith(ID);
  });
});

describe("revealing", () => {
  it("shows an edit's file", async () => {
    vi.mocked(edits.revealEdit).mockResolvedValue(undefined);
    const response = await reveal.POST(page(`/api/edits/${ID}/reveal`, { method: "POST" }), ctx({ id: ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(edits.revealEdit).toHaveBeenCalledWith(ID);
  });

  it("opens the Edits folder", async () => {
    vi.mocked(edits.revealEditsFolder).mockResolvedValue(undefined);
    const response = await folderReveal.POST(page("/api/edits/folder/reveal", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(edits.revealEditsFolder).toHaveBeenCalledTimes(1);
  });
});
