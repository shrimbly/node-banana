// @vitest-environment node
import * as path from "path";
import { describe, expect, it } from "vitest";

import type { RecordAssetMeta } from "@/lib/assets/types";
import { HttpError } from "../http";
import {
  MAX_EXISTS_IDS,
  MAX_SELECTION_IDS,
  parseBulkRequest,
  parseCleanupRequest,
  parseExistsIds,
  parseExportRequest,
  parseImportRequest,
  parseMediaHashes,
  parsePatch,
  parsePutRunRequest,
  parseQuery,
  parseRecordRequest,
  parseRevealRequest,
  parseScanProjectsRequest,
  parseSelection,
  parseSetLibraryRoot,
  parseWorkflowEntry,
  sniffPosterType,
} from "../validate";

const ASSET = "a0123456789abc";
const RUN = "r0123456789abc";
const SHA = "ab".repeat(32);
/** An absolute folder on whatever platform runs the tests. */
const DIR = path.resolve("/tmp-nb-assets", "project");

function meta(overrides: Partial<Record<keyof RecordAssetMeta, unknown>> = {}) {
  return {
    id: ASSET,
    kind: "image",
    origin: "generated",
    createdAt: 1_700_000_000_000,
    producer: { nodeId: "n1", nodeType: "nanoBanana" },
    workflowId: "wf_1700000000000_abc",
    workflowName: "Cats",
    runId: RUN,
    ...overrides,
  };
}

function expect400(fn: () => unknown, message?: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    if (message) expect((error as HttpError).message).toMatch(message);
    return;
  }
  throw new Error("expected a 400");
}

describe("parseRecordRequest", () => {
  it("accepts a full upload request and keeps only known fields", () => {
    const request = parseRecordRequest({
      meta: meta({
        mime: "image/png",
        prompt: "a cat",
        model: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana", extra: 1 },
        parameters: { seed: 4 },
        aspectRatio: "1:1",
        resolution: "1K",
        cost: { amount: 0.04, currency: "USD", estimated: true },
        producer: { nodeId: "n1", nodeType: "comfyApp", nodeTitle: "Mine", outputHandle: "image", batchIndex: 2 },
        projectDir: DIR,
        width: 1024,
        height: 768,
        durationSec: 2.5,
        tags: ["cats"],
        bogus: "dropped",
      } as never),
      source: { type: "upload" },
    });
    expect(request.source).toEqual({ type: "upload" });
    expect(request.meta).toMatchObject({
      model: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
      producer: { nodeId: "n1", nodeType: "comfyApp", nodeTitle: "Mine", outputHandle: "image", batchIndex: 2 },
      projectDir: DIR,
      tags: ["cats"],
    });
    expect(request.meta).not.toHaveProperty("bogus");
    expect(request.meta.model).not.toHaveProperty("extra");
  });

  it("accepts a url source and a null workflow name or project", () => {
    const request = parseRecordRequest({
      meta: meta({ workflowName: null, projectDir: null }),
      source: { type: "url", url: "https://cdn.example.com/v.mp4" },
    });
    expect(request.source).toEqual({ type: "url", url: "https://cdn.example.com/v.mp4" });
    expect(request.meta.workflowName).toBeNull();
    expect(request.meta.projectDir).toBeNull();
  });

  it("takes an upload with the display name it is recorded under, trimmed, and drops an empty one", () => {
    const upload = parseRecordRequest({
      meta: meta({ kind: "video", origin: "uploaded", name: "  sunset.mp4 ", producer: { nodeId: "upload", nodeType: "upload", operation: "upload" } }),
      source: { type: "upload" },
    });
    expect(upload.meta).toMatchObject({ kind: "video", origin: "uploaded", name: "sunset.mp4" });
    expect(parseRecordRequest({ meta: meta({ name: "  " }), source: { type: "upload" } }).meta).not.toHaveProperty("name");
    expect(parseRecordRequest({ meta: meta(), source: { type: "upload" } }).meta).not.toHaveProperty("name");
  });

  it("refuses ids, kinds and sources that do not fit the contract", () => {
    const cases: [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ meta: meta({ id: "../x" }), source: { type: "upload" } }, /meta\.id/],
      [{ meta: meta({ runId: "a0123456789abc" }), source: { type: "upload" } }, /meta\.runId/],
      [{ meta: meta({ workflowId: "has space" }), source: { type: "upload" } }, /meta\.workflowId/],
      [{ meta: meta({ kind: "pdf" }), source: { type: "upload" } }, /meta\.kind/],
      [{ meta: meta({ origin: "found" }), source: { type: "upload" } }, /meta\.origin/],
      [{ meta: meta({ name: 4 }), source: { type: "upload" } }, /meta\.name must be a string/],
      [{ meta: meta({ name: "x".repeat(121) }), source: { type: "upload" } }, /meta\.name is longer than 120 characters/],
      [{ meta: meta({ name: "Day one\nfinal.mov" }), source: { type: "upload" } }, /meta\.name must be one line/],
      [{ meta: meta({ createdAt: "today" }), source: { type: "upload" } }, /meta\.createdAt/],
      [{ meta: meta({ producer: { nodeId: "n1" } }), source: { type: "upload" } }, /meta\.producer\.nodeType/],
      [{ meta: meta({ producer: { nodeId: "n1", nodeType: "x", batchIndex: 1.5 } }), source: { type: "upload" } }, /batchIndex/],
      [{ meta: meta({ width: -1 }), source: { type: "upload" } }, /meta\.width/],
      [{ meta: meta({ cost: { amount: 1, currency: "EUR" } }), source: { type: "upload" } }, /currency/],
      [{ meta: meta({ tags: ["ok", ""] }), source: { type: "upload" } }, /meta\.tags\[1\]/],
      [{ meta: meta({ parameters: [1, 2] }), source: { type: "upload" } }, /meta\.parameters/],
      [{ meta: meta(), source: { type: "file" } }, /source\.type/],
      [{ meta: meta(), source: { type: "url", url: "not a url" } }, /source\.url/],
      [{ meta: meta(), source: { type: "url", url: "file:///etc/passwd" } }, /source\.url/],
    ];
    for (const [body, message] of cases) expect400(() => parseRecordRequest(body), message);
  });
});

describe("parsePatch", () => {
  it("keeps tags, favorite and trashed", () => {
    expect(parsePatch({ tags: ["a", "b"], favorite: true, trashed: false, other: 1 })).toEqual({
      tags: ["a", "b"],
      favorite: true,
      trashed: false,
    });
    expect(parsePatch({ tags: [] })).toEqual({ tags: [] });
  });

  it("refuses an empty patch and wrong types", () => {
    expect400(() => parsePatch({}), /changes nothing: send tags, favorite, trashed or name/);
    expect400(() => parsePatch({ favorite: "yes" }), /favorite/);
    expect400(() => parsePatch({ tags: "a" }), /tags/);
    expect400(() => parsePatch({ tags: ["x".repeat(201)] }), /longer than/);
  });

  it("keeps a display name trimmed, and an empty one as the request to clear it", () => {
    expect(parsePatch({ name: "  Sunset over the bay " })).toEqual({ name: "Sunset over the bay" });
    expect(parsePatch({ name: "" })).toEqual({ name: "" });
    expect(parsePatch({ name: "   " })).toEqual({ name: "" });
    expect(parsePatch({ name: "x".repeat(120), favorite: true })).toEqual({ name: "x".repeat(120), favorite: true });
  });

  it("refuses a display name that is not a string, too long or more than one line", () => {
    expect400(() => parsePatch({ name: 3 }), /^name must be a string\.$/);
    expect400(() => parsePatch({ name: null }), /^name must be a string\.$/);
    expect400(() => parsePatch({ name: "x".repeat(121) }), /^name is longer than 120 characters\.$/);
    expect400(() => parsePatch({ name: "Sun\nset" }), /^name must be one line\.$/);
    expect400(() => parsePatch({ name: "Sun\u2028set" }), /^name must be one line\.$/);
  });
});

describe("parseQuery / parseSelection", () => {
  it("normalises a query through the URL codec", () => {
    expect(
      parseQuery({ scope: "trash", q: "cat", kinds: ["image", "video"], favorite: false, from: 5, sort: "oldest" }, "q"),
    ).toEqual({ scope: "trash", q: "cat", kinds: ["image", "video"], favorite: false, from: 5, sort: "oldest" });
    expect(parseQuery({ scope: "library", sort: "newest" }, "q")).toEqual({});
    expect(parseQuery({ q: "x".repeat(500) }, "q").q).toHaveLength(200);
  });

  it("refuses unknown enum values instead of widening the selection", () => {
    expect400(() => parseQuery({ scope: "everything" }, "q"), /q\.scope/);
    expect400(() => parseQuery({ kinds: ["pdf"] }, "q"), /q\.kinds\[0\]/);
    expect400(() => parseQuery({ sort: "random" }, "q"), /q\.sort/);
    expect400(() => parseQuery({ tags: "a" }, "q"), /q\.tags/);
  });

  it("accepts an id selection and a query selection", () => {
    expect(parseSelection({ mode: "ids", ids: [ASSET] })).toEqual({ mode: "ids", ids: [ASSET] });
    expect(parseSelection({ mode: "query", query: { scope: "trash" } })).toEqual({
      mode: "query",
      query: { scope: "trash" },
      excludeIds: [],
    });
  });

  it("refuses bad ids, empty and oversized selections", () => {
    expect400(() => parseSelection({ mode: "ids", ids: ["../x"] }), /selection\.ids\[0\]/);
    expect400(() => parseSelection({ mode: "ids", ids: [] }), /empty/);
    expect400(
      () => parseSelection({ mode: "ids", ids: new Array(MAX_SELECTION_IDS + 1).fill(ASSET) }),
      /more than/,
    );
    expect400(() => parseSelection({ mode: "query", query: {}, excludeIds: ["x"] }), /excludeIds/);
    expect400(() => parseSelection({ mode: "all" }), /selection\.mode/);
  });
});

describe("parseBulkRequest", () => {
  const selection = { mode: "ids", ids: [ASSET] };

  it("accepts every operation", () => {
    expect(parseBulkRequest({ selection, op: { action: "tag", tags: ["x"] } }).op).toEqual({ action: "tag", tags: ["x"] });
    expect(parseBulkRequest({ selection, op: { action: "untag", tags: ["x"] } }).op).toEqual({
      action: "untag",
      tags: ["x"],
    });
    for (const action of ["favorite", "unfavorite", "trash", "restore", "delete"]) {
      expect(parseBulkRequest({ selection, op: { action } }).op).toEqual({ action });
    }
    expect(parseBulkRequest({ selection, op: { action: "delete", deleteProjectFiles: true } }).op).toEqual({
      action: "delete",
      deleteProjectFiles: true,
    });
  });

  it("refuses unknown operations and tag operations without tags", () => {
    expect400(() => parseBulkRequest({ selection, op: { action: "shred" } }), /op\.action/);
    expect400(() => parseBulkRequest({ selection, op: { action: "tag", tags: [] } }), /op\.tags is empty/);
    expect400(() => parseBulkRequest({ selection, op: { action: "delete", deleteProjectFiles: "yes" } }), /deleteProjectFiles/);
    expect400(() => parseBulkRequest({ op: { action: "trash" } }), /selection/);
  });
});

describe("small bodies", () => {
  it("parseExistsIds takes any strings, up to the cap", () => {
    expect(parseExistsIds({ ids: [ASSET, "legacy-id"] })).toEqual([ASSET, "legacy-id"]);
    expect400(() => parseExistsIds({ ids: [1] }), /ids\[0\]/);
    expect400(() => parseExistsIds({ ids: new Array(MAX_EXISTS_IDS + 1).fill(ASSET) }), /more than 1,000/);
  });

  it("parseRevealRequest takes an asset id or the root", () => {
    expect(parseRevealRequest({ id: ASSET })).toEqual({ id: ASSET });
    expect(parseRevealRequest({ target: "root" })).toEqual({ target: "root" });
    expect400(() => parseRevealRequest({ id: "/etc/passwd" }), /id/);
    expect400(() => parseRevealRequest({}));
  });

  it("parseMediaHashes takes sha256 hashes only", () => {
    expect(parseMediaHashes({ hashes: [SHA] })).toEqual([SHA]);
    expect400(() => parseMediaHashes({ hashes: [SHA.toUpperCase()] }), /hashes\[0\]/);
    expect400(() => parseMediaHashes({ hashes: new Array(5001).fill(SHA) }), /more than 5,000/);
  });

  it("sniffPosterType reads the format from the bytes", () => {
    const webp = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffPosterType(webp)).toBe("image/webp");
    expect(sniffPosterType(png)).toBe("image/png");
    expect(sniffPosterType(jpeg)).toBe("image/jpeg");
    expect(sniffPosterType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffPosterType(new Uint8Array(0))).toBeNull();
  });
});

describe("snapshots and workflows", () => {
  const run = {
    meta: { id: RUN, workflowId: "wf_1", workflowName: null, projectPath: null, startedAt: 1 },
    phase: "start",
    workflow: { version: 1, name: "Cats", nodes: [], edges: [], edgeStyle: "curved" },
    mediaHashes: [SHA],
  };

  it("parsePutRunRequest accepts a snapshot for the run in the URL", () => {
    expect(parsePutRunRequest(RUN, run)).toMatchObject({ meta: { id: RUN }, phase: "start", mediaHashes: [SHA] });
  });

  it("parsePutRunRequest refuses a mismatched run, phase, workflow or hash", () => {
    expect400(() => parsePutRunRequest("r9999999999999", run), /does not match/);
    expect400(() => parsePutRunRequest(RUN, { ...run, phase: "middle" }), /phase/);
    expect400(() => parsePutRunRequest(RUN, { ...run, workflow: { ...run.workflow, nodes: {} } }), /workflow\.nodes/);
    expect400(() => parsePutRunRequest(RUN, { ...run, workflow: { ...run.workflow, version: 2 } }), /version/);
    expect400(() => parsePutRunRequest(RUN, { ...run, mediaHashes: ["x"] }), /mediaHashes\[0\]/);
  });

  it("parseWorkflowEntry resolves the project folder and checks the fork id", () => {
    expect(parseWorkflowEntry({ name: "Cats", projectPath: `${DIR}${path.sep}` })).toEqual({
      name: "Cats",
      projectPath: DIR,
    });
    expect(parseWorkflowEntry({ name: null, projectPath: null, forkedFrom: "wf_0" })).toEqual({
      name: null,
      projectPath: null,
      forkedFrom: "wf_0",
    });
    expect400(() => parseWorkflowEntry({ name: "x", projectPath: "relative/dir" }), /projectPath: Path must be absolute/);
    expect400(() => parseWorkflowEntry({ name: "x", projectPath: null, forkedFrom: "a b" }), /forkedFrom/);
    expect400(() => parseWorkflowEntry({ name: 3, projectPath: null }), /name/);
  });

  it("parseWorkflowEntry takes asOf as a finite number of milliseconds", () => {
    expect(parseWorkflowEntry({ name: "Cats", projectPath: null, asOf: 1_700_000_000_000 })).toEqual({
      name: "Cats",
      projectPath: null,
      asOf: 1_700_000_000_000,
    });
    expect(parseWorkflowEntry({ name: "Cats", projectPath: null, asOf: null })).toEqual({ name: "Cats", projectPath: null });
    expect400(() => parseWorkflowEntry({ name: "x", projectPath: null, asOf: "1700000000000" }), /asOf/);
    expect400(() => parseWorkflowEntry({ name: "x", projectPath: null, asOf: {} }), /asOf/);
  });
});

describe("library and jobs", () => {
  it("parseSetLibraryRoot resolves the folder and checks the mode", () => {
    expect(parseSetLibraryRoot({ root: DIR, mode: "move" })).toEqual({ root: DIR, mode: "move" });
    expect400(() => parseSetLibraryRoot({ root: DIR, mode: "copy" }), /mode/);
    expect400(() => parseSetLibraryRoot({ root: `${DIR}${path.sep}..${path.sep}x`, mode: "switch" }), /traversal/);
  });

  it("parseImportRequest dedupes folders and needs at least one", () => {
    expect(parseImportRequest({ projectDirs: [DIR, DIR] })).toEqual({ projectDirs: [DIR] });
    expect400(() => parseImportRequest({ projectDirs: [] }), /at least one/);
    expect400(() => parseImportRequest({ projectDirs: ["rel"] }), /projectDirs\[0\]/);
  });

  it("parseScanProjectsRequest resolves the folder to search", () => {
    expect(parseScanProjectsRequest({ root: `${DIR}${path.sep}` })).toEqual({ root: DIR });
    expect400(() => parseScanProjectsRequest({ root: "rel" }), /root/);
    expect400(() => parseScanProjectsRequest({ root: `${DIR}${path.sep}..${path.sep}x` }), /traversal/);
    expect400(() => parseScanProjectsRequest({}), /root must be a string/);
    expect400(() => parseScanProjectsRequest(null), /The request must be an object/);
  });

  it("parseCleanupRequest needs something to do", () => {
    expect(parseCleanupRequest({ thumbnails: true })).toEqual({ thumbnails: true });
    expect(parseCleanupRequest({ unusedMedia: true, thumbnails: false })).toEqual({ unusedMedia: true, thumbnails: false });
    expect400(() => parseCleanupRequest({}), /Nothing to clean up/);
    expect400(() => parseCleanupRequest({ thumbnails: "yes" }), /thumbnails/);
  });

  it("parseExportRequest checks the selection and the destination", () => {
    expect(parseExportRequest({ selection: { mode: "ids", ids: [ASSET] }, dest: DIR })).toEqual({
      selection: { mode: "ids", ids: [ASSET] },
      dest: DIR,
    });
    expect400(() => parseExportRequest({ selection: { mode: "ids", ids: [ASSET] }, dest: "out" }), /dest/);
  });
});
