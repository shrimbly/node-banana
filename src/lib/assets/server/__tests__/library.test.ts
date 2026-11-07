// @vitest-environment node
import fs from "fs";
import path from "path";
import { gunzipSync } from "zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetPageRequest, RecordAssetMeta, RecordAssetResult, SnapshotWorkflow } from "../../types";
import {
  __assetLibraryForTests,
  __drainAssetLibraryForTests,
  __resetAssetLibraryForTests,
  assetExistence,
  beginRecord,
  bulkAssets,
  completeUpload,
  getAsset,
  getAssetWorkflow,
  getFacets,
  getLibraryStatus,
  listAssets,
  mediaHas,
  newestFromNode,
  openAssetFile,
  openMedia,
  patchAsset,
  putMedia,
  putRun,
  upsertWorkflowEntry,
} from "../index";
import { Ingestor } from "../ingest";
import { runCleanup, type JobContext } from "../jobs";
import { AssetLibrary } from "../library";
import { fakeRecord, installBridge, makePng, makeWav, meta, runId, sha256, streamOf, tempDir } from "./helpers";

let base: string;
let root: string;
let bridge: ReturnType<typeof installBridge>;

beforeEach(async () => {
  base = tempDir();
  root = path.join(base, "Library");
  process.env.NODE_BANANA_ASSET_LIBRARY = root;
  bridge = installBridge(path.join(base, "OS Trash"));
  await __resetAssetLibraryForTests();
});

afterEach(async () => {
  await __resetAssetLibraryForTests();
  bridge.remove();
  delete process.env.NODE_BANANA_ASSET_LIBRARY;
  fs.rmSync(base, { recursive: true, force: true });
});

let seed = 100;

async function record(overrides: Partial<RecordAssetMeta> = {}, buffer: Buffer = makePng(4, 4, seed++)): Promise<RecordAssetResult> {
  const started = await beginRecord({ meta: meta(overrides), source: { type: "upload" } });
  if ("result" in started) return started.result;
  return completeUpload(started.ticket.uploadId, streamOf(buffer), null);
}

/** "Delete permanently" as the app offers it: from the Trash. */
async function deleteForGood(assetIds: string[], options: { deleteProjectFiles?: boolean } = {}) {
  await bulkAssets({ selection: { mode: "ids", ids: assetIds }, op: { action: "trash" } });
  return bulkAssets({ selection: { mode: "ids", ids: assetIds }, op: { action: "delete", ...options } });
}

async function ids(request: AssetPageRequest = {}): Promise<string[]> {
  return (await listAssets(request)).assets.map((asset) => asset.id);
}

const T0 = new Date(2026, 8, 20, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

describe("queries", () => {
  let a: RecordAssetResult;
  let b: RecordAssetResult;
  let c: RecordAssetResult;
  let d: RecordAssetResult;

  beforeEach(async () => {
    a = await record({ createdAt: T0, prompt: "Red fox in snow", model: { provider: "gemini", modelId: "nano-banana" } });
    b = await record({
      createdAt: T0 + HOUR,
      prompt: "Blue whale",
      origin: "edited",
      producer: { nodeId: "annotation-1", nodeType: "annotation", operation: "annotate" },
      model: { provider: "fal", modelId: "flux-pro", displayName: "FLUX Pro" },
      workflowId: "wf_other",
      workflowName: "Ocean",
    });
    c = await record({ createdAt: T0 + 2 * HOUR, prompt: "Green forest", tags: ["Hero", "cover"] });
    d = await record({ createdAt: T0 + 3 * HOUR, prompt: "red panda", workflowId: "wf_other", workflowName: "Ocean" });
  });

  it("sorts newest first by default, oldest on request", async () => {
    expect(await ids()).toEqual([d, c, b, a].map((r) => r.asset.id));
    expect(await ids({ sort: "oldest" })).toEqual([a, b, c, d].map((r) => r.asset.id));
  });

  it("ANDs across groups and ORs within one", async () => {
    expect(await ids({ q: "red" })).toEqual([d.asset.id, a.asset.id]);
    expect(await ids({ q: "RED fox" })).toEqual([a.asset.id]);
    expect(await ids({ origins: ["edited"] })).toEqual([b.asset.id]);
    expect(await ids({ workflowIds: ["wf_other"], q: "red" })).toEqual([d.asset.id]);
    expect(await ids({ models: ["flux-pro"] })).toEqual([b.asset.id]);
    expect(await ids({ models: ["flux-pro", "nano-banana"] })).toHaveLength(4);
    expect(await ids({ tags: ["hero", "missing-tag"] })).toEqual([c.asset.id]);
    expect(await ids({ from: T0 + HOUR, to: T0 + 3 * HOUR })).toEqual([c.asset.id, b.asset.id]);
    expect(await ids({ kinds: ["video"] })).toEqual([]);
    // The search also covers the model label, the workflow name and tags.
    expect(await ids({ q: "flux" })).toEqual([b.asset.id]);
    expect(await ids({ q: "ocean" })).toEqual([d.asset.id, b.asset.id]);
    expect(await ids({ q: "cover" })).toEqual([c.asset.id]);
  });

  it("filters by the workflow's current project, and by 'not in a project'", async () => {
    const project = path.join(base, "Proj");
    await upsertWorkflowEntry("wf_other", { name: "Ocean (renamed)", projectPath: project });
    expect(await ids({ projects: [project] })).toEqual([d.asset.id, b.asset.id]);
    expect(await ids({ projects: [""] })).toEqual([c.asset.id, a.asset.id]);
    expect(await ids({ q: "renamed" })).toEqual([d.asset.id, b.asset.id]);
    const view = await getAsset(b.asset.id);
    expect(view?.workflow).toEqual({ id: "wf_other", name: "Ocean (renamed)", projectPath: project });
  });

  it("pages with a keyset cursor that stays stable while new assets arrive", async () => {
    const first = await listAssets({ limit: 2 });
    expect(first.assets.map((x) => x.id)).toEqual([d.asset.id, c.asset.id]);
    expect(first.total).toBe(4);
    expect(first.totalBytes).toBe([a, b, c, d].reduce((sum, r) => sum + r.asset.bytes, 0));
    expect(first.nextCursor).toBeTruthy();

    const newest = await record({ createdAt: T0 + 10 * HOUR });
    const second = await listAssets({ limit: 2, cursor: first.nextCursor! });
    expect(second.assets.map((x) => x.id)).toEqual([b.asset.id, a.asset.id]);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(5);

    const arrivals = await listAssets({ newerThan: first.headCursor! });
    expect(arrivals.assets.map((x) => x.id)).toEqual([newest.asset.id]);
    expect(arrivals.headCursor).not.toBe(first.headCursor);
    expect((await listAssets({ newerThan: arrivals.headCursor! })).assets).toEqual([]);
  });

  it("hands out more arrivals than fit one poll over several, newest last, with no gap", async () => {
    const head = (await listAssets({ limit: 1 })).headCursor!;
    const arrived: string[] = [];
    for (let i = 1; i <= 5; i++) arrived.push((await record({ createdAt: T0 + 10 * HOUR + i })).asset.id);
    const seen: string[] = [];
    let cursor = head;
    for (let poll = 0; poll < 5; poll++) {
      const page = await listAssets({ newerThan: cursor, limit: 2 });
      if (!page.assets.length) break;
      seen.push(...page.assets.map((asset) => asset.id));
      // The head moves to the newest item returned, never past what the client holds.
      expect(page.headCursor).not.toBeNull();
      cursor = page.headCursor!;
    }
    expect(seen.sort()).toEqual([...arrived].sort());
    expect((await listAssets({ newerThan: cursor, limit: 2 })).assets).toEqual([]);
  });

  it("pages oldest-first too", async () => {
    const first = await listAssets({ sort: "oldest", limit: 3 });
    expect(first.assets.map((x) => x.id)).toEqual([a, b, c].map((r) => r.asset.id));
    const second = await listAssets({ sort: "oldest", limit: 3, cursor: first.nextCursor! });
    expect(second.assets.map((x) => x.id)).toEqual([d.asset.id]);
  });

  it("lists an upload with everything else, finds it by its name, and counts it by origin", async () => {
    const upload = await record(
      {
        createdAt: T0 + 4 * HOUR,
        kind: "audio",
        origin: "uploaded",
        name: "Morning hum.wav",
        prompt: undefined,
        model: undefined,
        producer: { nodeId: "upload", nodeType: "upload", operation: "upload" },
        workflowId: "uploads",
        workflowName: "Uploads",
      },
      makeWav(0.1),
    );
    expect(await ids()).toEqual([upload, d, c, b, a].map((r) => r.asset.id));
    expect(await ids({ kinds: ["audio"] })).toEqual([upload.asset.id]);
    expect(await ids({ origins: ["uploaded"] })).toEqual([upload.asset.id]);
    expect(await ids({ q: "morning hum" })).toEqual([upload.asset.id]);
    const facets = await getFacets();
    expect(facets.origins).toEqual({ generated: 3, edited: 1, uploaded: 1 });
    expect(facets.workflows.find((w) => w.id === "uploads")).toMatchObject({ name: "Uploads", count: 1 });
  });

  it("rejects a forged cursor", async () => {
    await expect(listAssets({ cursor: "zz.../../x" })).rejects.toMatchObject({ status: 400 });
  });

  it("counts facets over live assets", async () => {
    await patchAsset(a.asset.id, { favorite: true });
    await patchAsset(b.asset.id, { trashed: true });
    const facets = await getFacets();
    expect(facets.total).toBe(3);
    expect(facets.trash).toBe(1);
    expect(facets.favorites).toBe(1);
    expect(facets.kinds.image).toBe(3);
    expect(facets.origins).toEqual({ generated: 3, edited: 0, uploaded: 0 });
    expect(facets.models.find((m) => m.modelId === "nano-banana")?.count).toBe(3);
    expect(facets.tags).toEqual([
      { tag: "cover", count: 1 },
      { tag: "Hero", count: 1 },
    ]);
    expect(facets.workflows.map((w) => [w.id, w.count])).toEqual([
      ["wf_other", 1],
      ["wf_test_1", 2],
    ]);
    expect(facets.projects).toEqual([{ path: null, name: "Not in a project", count: 3 }]);
  });
});

describe("newestFromNode", () => {
  it("lists what one node of one workflow saved, newest run first, a run's results together, trashed ones too", async () => {
    const app = { nodeId: "comfyApp-1", nodeType: "comfyApp" };
    const first = runId();
    const second = runId();
    const old = await record({ createdAt: T0, producer: app, runId: first });
    const image = await record({ createdAt: T0 + HOUR, producer: { ...app, outputHandle: "1" }, runId: second });
    const video = await record({ createdAt: T0 + HOUR, producer: { ...app, outputHandle: "2" }, runId: second });
    // Another node, and the same node id in another workflow.
    await record({ createdAt: T0 + 2 * HOUR, runId: runId() });
    await record({ createdAt: T0 + 2 * HOUR, producer: app, workflowId: "wf_other", runId: runId() });
    await bulkAssets({ selection: { mode: "ids", ids: [image.asset.id] }, op: { action: "trash" } });

    const latest = (await newestFromNode("wf_test_1", "comfyApp-1", 1)).map((asset) => asset.id);
    expect(latest.sort()).toEqual([image.asset.id, video.asset.id].sort());
    expect((await newestFromNode("wf_test_1", "comfyApp-1", 2)).map((asset) => asset.id).at(-1)).toBe(old.asset.id);
    expect(await newestFromNode("wf_test_1", "nanoBanana-9", 4)).toEqual([]);
    expect(await newestFromNode("", "comfyApp-1", 4)).toEqual([]);
  });
});

describe("mutations", () => {
  it("patches tags, favorite and trash state, and lists the trash scope", async () => {
    const r = await record();
    const patched = await patchAsset(r.asset.id, { tags: [" hero ", "Hero", "final"], favorite: true });
    expect(patched).toMatchObject({ tags: ["hero", "final"], favorite: true });
    const trashed = await patchAsset(r.asset.id, { trashed: true });
    expect(trashed?.trashedAt).toBeGreaterThan(0);
    expect(await ids()).toEqual([]);
    expect(await ids({ scope: "trash" })).toEqual([r.asset.id]);
    const restored = await patchAsset(r.asset.id, { trashed: false });
    expect(restored?.trashedAt).toBeUndefined();
    expect(await ids()).toEqual([r.asset.id]);
    await expect(patchAsset(r.asset.id, { favorite: "yes" as unknown as boolean })).rejects.toMatchObject({ status: 400 });
    expect(await patchAsset("a0000000000000", { favorite: true })).toBeNull();

    // The sidecar on disk is the source of truth.
    const sidecar = JSON.parse(fs.readFileSync(path.join(root, ".nodebanana", "assets", `${r.asset.id}.json`), "utf8"));
    expect(sidecar).toMatchObject({ tags: ["hero", "final"], favorite: true });
    expect(sidecar.trashedAt).toBeUndefined();
  });

  it("names an asset, finds it by that name, and clears the name with an empty one", async () => {
    const r = await record({ prompt: "A cat in a hat" });
    const sidecarPath = path.join(root, ".nodebanana", "assets", `${r.asset.id}.json`);
    const renamed = await patchAsset(r.asset.id, { name: "  Sunset over the bay " });
    expect(renamed).toMatchObject({ name: "Sunset over the bay", filename: r.asset.filename });
    expect((await getAsset(r.asset.id))?.name).toBe("Sunset over the bay");
    expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8")).name).toBe("Sunset over the bay");
    expect(await ids({ q: "sunset BAY" })).toEqual([r.asset.id]);
    expect(await ids({ q: "cat" })).toEqual([r.asset.id]);

    // Another process reads it from the sidecar, and its rename reaches this one through the journal.
    const other = new AssetLibrary(root);
    await other.ready();
    expect((await other.query({ q: "sunset" })).assets.map((x) => x.id)).toEqual([r.asset.id]);
    await other.patch(r.asset.id, { name: "Dusk" });
    expect((await getAsset(r.asset.id))?.name).toBe("Dusk");
    await other.drain();

    const cleared = await patchAsset(r.asset.id, { name: "" });
    expect(cleared?.name).toBeUndefined();
    expect(cleared?.filename).toBe(r.asset.filename);
    expect("name" in JSON.parse(fs.readFileSync(sidecarPath, "utf8"))).toBe(false);
    expect(await ids({ q: "dusk" })).toEqual([]);
    await expect(patchAsset(r.asset.id, { name: "Sun\nset" })).rejects.toMatchObject({ status: 400 });
    await expect(patchAsset(r.asset.id, { name: "x".repeat(121) })).rejects.toMatchObject({ status: 400 });
  });

  it("applies bulk ops to ids and to query selections", async () => {
    const one = await record({ prompt: "alpha" });
    const two = await record({ prompt: "beta" });
    const three = await record({ prompt: "alpha beta" });

    const tagged = await bulkAssets({ selection: { mode: "ids", ids: [one.asset.id, two.asset.id] }, op: { action: "tag", tags: ["set"] } });
    expect(tagged).toMatchObject({ affected: 2, errors: [] });
    expect(await ids({ tags: ["set"] })).toEqual([two.asset.id, one.asset.id]);

    const byQuery = await bulkAssets({
      selection: { mode: "query", query: { q: "alpha" }, excludeIds: [three.asset.id] },
      op: { action: "favorite" },
    });
    expect(byQuery.ids).toEqual([one.asset.id]);
    expect(await ids({ favorite: true })).toEqual([one.asset.id]);

    await bulkAssets({ selection: { mode: "query", query: {}, excludeIds: [] }, op: { action: "untag", tags: ["SET"] } });
    expect(await ids({ tags: ["set"] })).toEqual([]);

    const trashed = await bulkAssets({ selection: { mode: "query", query: { q: "beta" }, excludeIds: [] }, op: { action: "trash" } });
    expect(trashed.affected).toBe(2);
    const restored = await bulkAssets({ selection: { mode: "query", query: { scope: "trash" }, excludeIds: [] }, op: { action: "restore" } });
    expect(restored.affected).toBe(2);
    expect((await listAssets({})).total).toBe(3);

    const missing = await bulkAssets({ selection: { mode: "ids", ids: ["a0000000000000"] }, op: { action: "favorite" } });
    expect(missing).toMatchObject({ affected: 0, errors: [{ id: "a0000000000000" }] });
    await expect(bulkAssets({ selection: { mode: "ids", ids: [] }, op: { action: "nope" } as never })).rejects.toMatchObject({ status: 400 });
  });
});

describe("permanent delete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function trashedPaths(): string[] {
    return bridge.calls.filter((call) => call.type === "trash").map((call) => call.path!);
  }

  it("sends an unshared library file to the OS Trash", async () => {
    const r = await record();
    const file = r.asset.displayPath;
    const result = await deleteForGood([r.asset.id]);
    expect(result).toMatchObject({ affected: 1, errors: [] });
    expect(trashedPaths()).toEqual([file]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(root, ".nodebanana", "assets", `${r.asset.id}.json`))).toBe(false);
    const journal = fs.readFileSync(path.join(root, ".nodebanana", "journal.ndjson"), "utf8");
    expect(journal).toContain(`"op":"del","id":"${r.asset.id}"`);
  });

  it("deletes only from the Trash, or a live record whose file is gone", async () => {
    const live = await record();
    const missing = await record();
    const cameBack = await record();
    const refused = await bulkAssets({ selection: { mode: "ids", ids: [live.asset.id] }, op: { action: "delete" } });
    expect(refused).toMatchObject({ affected: 0, errors: [{ id: live.asset.id, error: "Not in the Trash" }] });
    const everything = await bulkAssets({
      selection: { mode: "query", query: { scope: "library" }, excludeIds: [] },
      op: { action: "delete" },
    });
    expect(everything.affected).toBe(0);
    expect(trashedPaths()).toEqual([]);
    expect((await listAssets({})).total).toBe(3);

    // "Remove from library" of a file that is gone.
    fs.unlinkSync(missing.asset.displayPath);
    expect(await deleteForGoodFromMissing(missing.asset.id)).toMatchObject({ affected: 1, errors: [] });
    expect(await assetExistence([missing.asset.id])).toEqual({ [missing.asset.id]: "gone" });

    // Shown as missing, then put back (Finder's Put Back) before "Remove from library" was clicked.
    const aside = `${cameBack.asset.displayPath}.aside`;
    fs.renameSync(cameBack.asset.displayPath, aside);
    const library = await __assetLibraryForTests();
    await library.verifyFiles([library.get(cameBack.asset.id)!], 0);
    expect(await ids({ scope: "missing" })).toEqual([cameBack.asset.id]);
    fs.renameSync(aside, cameBack.asset.displayPath);
    expect(await deleteForGoodFromMissing(cameBack.asset.id)).toMatchObject({
      affected: 0,
      errors: [{ id: cameBack.asset.id, error: "Not in the Trash" }],
    });
    expect(trashedPaths()).toEqual([]);
    expect(fs.existsSync(cameBack.asset.displayPath)).toBe(true);
    expect(await ids({ scope: "missing" })).toEqual([]);
    expect(await ids()).toEqual([cameBack.asset.id, live.asset.id]);
  });

  async function deleteForGoodFromMissing(id: string) {
    return bulkAssets({ selection: { mode: "ids", ids: [id] }, op: { action: "delete" } });
  }

  it("keeps a file another record (even a trashed one) still uses", async () => {
    const png = makePng(3, 3, 55);
    const first = await record({}, png);
    const second = await record({}, png);
    await patchAsset(second.asset.id, { trashed: true });
    await deleteForGood([first.asset.id]);
    expect(trashedPaths()).toEqual([]);
    expect(fs.existsSync(first.asset.displayPath)).toBe(true);
    await deleteForGood([second.asset.id]);
    expect(trashedPaths()).toEqual([first.asset.displayPath]);
  });

  async function storeRun(owner: RecordAssetResult, mediaHashes: string[], phase: "start" | "final" = "start") {
    await putRun(owner.asset.runId, {
      meta: { id: owner.asset.runId, workflowId: owner.asset.workflowId, workflowName: null, projectPath: null, startedAt: Date.now() },
      phase,
      workflow: snapshot(),
      mediaHashes,
    });
  }

  function runFile(runId: string): string {
    return path.join(root, ".nodebanana", "runs", `${runId}.json.gz`);
  }

  it("moves bytes a surviving run's snapshot references into media/", async () => {
    const png = makePng(3, 3, 56);
    const r = await record({}, png);
    const next = await record();
    const sha = sha256(png);
    // The next run started with r's output still on the canvas.
    await storeRun(next, [sha, next.asset.sha256]);
    await deleteForGood([r.asset.id]);
    expect(trashedPaths()).toEqual([]);
    expect(fs.existsSync(r.asset.displayPath)).toBe(false);
    const kept = path.join(root, ".nodebanana", "media", `${sha}.png`);
    expect(fs.readFileSync(kept).equals(png)).toBe(true);
    expect(await openMedia(sha)).toMatchObject({ path: kept, mime: "image/png", bytes: png.length });
  });

  it("deletes the run of its last asset, so the asset's own bytes go to the OS Trash", async () => {
    const png = makePng(3, 3, 57);
    const r = await record({}, png);
    // Every run's final snapshot holds its own output.
    await storeRun(r, [sha256(png)], "final");
    expect(fs.existsSync(runFile(r.asset.runId))).toBe(true);
    await deleteForGood([r.asset.id]);
    expect(trashedPaths()).toEqual([r.asset.displayPath]);
    expect(fs.existsSync(runFile(r.asset.runId))).toBe(false);
    expect(fs.existsSync(path.join(root, ".nodebanana", "media", `${sha256(png)}.png`))).toBe(false);
    expect(await openMedia(sha256(png))).toBeNull();
  });

  it("keeps a run while any of its assets (even a trashed one) remains", async () => {
    const run = runId();
    const first = await record({ runId: run });
    const second = await record({ runId: run });
    await storeRun(first, [first.asset.sha256, second.asset.sha256], "final");
    await patchAsset(second.asset.id, { trashed: true });
    await deleteForGood([first.asset.id]);
    expect(fs.existsSync(runFile(run))).toBe(true);
    // The survivor's snapshot still shows the deleted asset's output.
    expect(await openMedia(first.asset.sha256)).not.toBeNull();
    await deleteForGood([second.asset.id]);
    expect(fs.existsSync(runFile(run))).toBe(false);
  });

  it("keeps a checked reference to a kept project file a surviving run needs, not a second copy", async () => {
    const project = path.join(base, "Proj");
    fs.mkdirSync(project);
    const png = makePng(3, 3, 58);
    const sha = sha256(png);
    const inProject = await record({ projectDir: project }, png);
    const file = inProject.asset.displayPath;
    const later = await record();
    await storeRun(later, [sha]);
    await deleteForGood([inProject.asset.id]);
    expect(fs.existsSync(file)).toBe(true);
    expect(trashedPaths()).toEqual([]);
    const media = path.join(root, ".nodebanana", "media");
    expect(fs.readdirSync(media)).toEqual([`${sha}.ref`]);
    expect(await openMedia(sha)).toMatchObject({ path: file, mime: "image/png", bytes: png.length });
    expect(await mediaHas([sha])).toEqual([]);

    // Changed in another app (same size): the reference no longer holds those bytes, so they are asked for.
    const edited = Buffer.from(png);
    edited[edited.length - 1] ^= 0xff;
    fs.writeFileSync(file, edited);
    fs.utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 1));
    expect(await openMedia(sha)).toBeNull();
    expect(await mediaHas([sha])).toEqual([sha]);
    fs.writeFileSync(file, png);
    expect(await openMedia(sha)).toMatchObject({ path: file });

    // The app removes the project file later (a new record of it, deleted with its project file):
    // the bytes move into media/ first, replacing the reference.
    const again = await record({ projectDir: project }, png);
    expect(again).toMatchObject({ reusedFile: true, asset: { displayPath: file } });
    await deleteForGood([again.asset.id], { deleteProjectFiles: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(media)).toEqual([`${sha}.png`]);
    expect(await openMedia(sha)).toMatchObject({ path: path.join(media, `${sha}.png`) });
  });

  it("keeps bytes rather than trash them when a snapshot can't be read right now", async () => {
    const png = makePng(3, 3, 59);
    const r = await record({}, png);
    const later = await record();
    await storeRun(later, [sha256(png)]);
    await patchAsset(r.asset.id, { trashed: true });
    // Another process, with nothing cached, meets a snapshot it can't read (and no usable hash list).
    fs.rmSync(path.join(root, ".nodebanana", "runs", `${later.asset.runId}.hashes.json`));
    const readFile = fs.promises.readFile;
    vi.spyOn(fs.promises, "readFile").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
      String(file) === runFile(later.asset.runId)
        ? Promise.reject(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }))
        : (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof readFile);
    const other = new AssetLibrary(root, { trash: async () => {} });
    await other.deleteRecords([r.asset.id]);
    await other.drain();
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(root, ".nodebanana", "media", `${sha256(png)}.png`))).toBe(true);
    // Not remembered as "references nothing": once readable, the reference is there.
    expect((await other.runs.referencedHashes()).hashes.has(sha256(png))).toBe(true);
  });

  it("reads each run's small hash list rather than inflating the snapshot", async () => {
    const r = await record();
    await storeRun(r, [r.asset.sha256]);
    const other = new AssetLibrary(root);
    const readFile = vi.spyOn(fs.promises, "readFile");
    expect((await other.runs.referencedHashes()).hashes).toEqual(new Set([r.asset.sha256]));
    expect(readFile.mock.calls.map(([file]) => String(file))).not.toContain(runFile(r.asset.runId));
    vi.restoreAllMocks();
  });

  it("keeps project files unless asked, then trashes them too", async () => {
    const project = path.join(base, "Proj");
    fs.mkdirSync(project);
    const kept = await record({ projectDir: project });
    await deleteForGood([kept.asset.id]);
    expect(fs.existsSync(kept.asset.displayPath)).toBe(true);
    expect(trashedPaths()).toEqual([]);

    const removed = await record({ projectDir: project });
    await deleteForGood([removed.asset.id], { deleteProjectFiles: true });
    expect(trashedPaths()).toEqual([removed.asset.displayPath]);
  });

  it("leaves a file alone when it no longer matches its record", async () => {
    const r = await record();
    fs.appendFileSync(r.asset.displayPath, "edited in another app");
    await deleteForGood([r.asset.id]);
    expect(trashedPaths()).toEqual([]);
    expect(fs.existsSync(r.asset.displayPath)).toBe(true);
  });

  it("empties Trash items older than 30 days when the library starts", async () => {
    const old = await record();
    const recent = await record();
    await patchAsset(old.asset.id, { trashed: true });
    await patchAsset(recent.asset.id, { trashed: true });
    const sidecarPath = path.join(root, ".nodebanana", "assets", `${old.asset.id}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    sidecar.trashedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));

    await __resetAssetLibraryForTests();
    await getLibraryStatus();
    await __drainAssetLibraryForTests();
    expect(await assetExistence([old.asset.id, recent.asset.id])).toEqual({
      [old.asset.id]: "gone",
      [recent.asset.id]: "present",
    });
    // To the OS Trash, as a manual delete would (here the desktop app's bridge).
    expect(trashedPaths()).toEqual([old.asset.displayPath]);
    expect(fs.existsSync(old.asset.displayPath)).toBe(false);
    expect(fs.existsSync(recent.asset.displayPath)).toBe(true);
  });

  it("asks the OS Trash for no route that could prompt when it empties the Trash unprompted", async () => {
    const calls: { files: string[]; options?: { interactive?: boolean } }[] = [];
    const library = new AssetLibrary(root, {
      trash: async (files, options) => {
        calls.push({ files, options });
        files.forEach((file) => fs.rmSync(file));
      },
    });
    await library.ready();
    const expired = await library.addRecord(fakeRecord({ trashedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
    const byHand = await library.addRecord(fakeRecord({ trashedAt: Date.now() }));
    for (const made of [expired, byHand]) {
      fs.mkdirSync(path.dirname(library.filePath(made)!), { recursive: true });
      fs.writeFileSync(library.filePath(made)!, Buffer.from(made.id));
    }
    expect(await library.emptyExpiredTrash()).toBe(1);
    await library.deleteRecords([byHand.id]);
    expect(calls).toEqual([
      { files: [library.filePath(expired)], options: { interactive: false } },
      { files: [library.filePath(byHand)], options: { interactive: true } },
    ]);
    await library.drain();
  });

  it("sends a whole batch to the OS Trash in one call", async () => {
    const batches: string[][] = [];
    const library = new AssetLibrary(root, {
      trash: async (files) => {
        batches.push(files);
        files.forEach((file) => fs.rmSync(file));
      },
    });
    await library.ready();
    const made = [];
    for (let i = 0; i < 3; i++) {
      const record = fakeRecord({ createdAt: T0 + i, trashedAt: T0 });
      const file = path.join(root, record.file.root === "library" ? record.file.rel : "");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(record.id));
      made.push(await library.addRecord(record));
    }
    await library.deleteRecords(made.map((record) => record.id));
    expect(batches).toHaveLength(1);
    expect(batches[0].sort()).toEqual(made.map((record) => library.filePath(record)!).sort());
    await library.drain();
  });

  it("never releases a file a concurrent recording has chosen to reuse", async () => {
    const library = new AssetLibrary(root, {
      trash: async (files) => ([] as string[]).concat(files).forEach((file) => fs.rmSync(file)),
    });
    await library.ready();
    const ingest = new Ingestor({ library: () => library, thumbs: () => null, isPaused: () => false });
    const recordWith = async (buffer: Buffer) => {
      const started = await ingest.begin({ meta: meta(), source: { type: "upload" } });
      if (!("ticket" in started)) throw new Error("expected a ticket");
      return ingest.complete(started.ticket.uploadId, streamOf(buffer), "image/png");
    };
    const png = makePng(3, 3, 71);
    const trashed = await recordWith(png);
    await library.patch(trashed.asset.id, { trashed: true });

    // Hold the second recording between choosing the file and indexing its record.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let arrived!: () => void;
    const atIndex = new Promise<void>((resolve) => (arrived = resolve));
    const addRecord = library.addRecord.bind(library);
    vi.spyOn(library, "addRecord").mockImplementation(async (record) => {
      arrived();
      await gate;
      return addRecord(record);
    });
    const second = recordWith(png);
    await atIndex;
    const emptying = library.deleteRecords([trashed.asset.id]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    const [saved] = await Promise.all([second, emptying]);
    expect(saved.reusedFile).toBe(true);
    expect(saved.asset.displayPath).toBe(trashed.asset.displayPath);
    expect(fs.existsSync(saved.asset.displayPath)).toBe(true);
    await library.drain();
  });
});

describe("existence", () => {
  it("tells present, gone and unknown apart", async () => {
    const live = await record();
    const trashed = await record();
    const deleted = await record();
    const vanished = await record();
    await patchAsset(trashed.asset.id, { trashed: true });
    await deleteForGood([deleted.asset.id]);
    fs.unlinkSync(vanished.asset.displayPath);
    const library = await __assetLibraryForTests();
    await library.verifyFiles([library.get(vanished.asset.id)!], 0);

    expect(
      await assetExistence([live.asset.id, trashed.asset.id, deleted.asset.id, vanished.asset.id, "a0000000000000", "nonsense"]),
    ).toEqual({
      [live.asset.id]: "present",
      [trashed.asset.id]: "present",
      [deleted.asset.id]: "gone",
      [vanished.asset.id]: "gone",
      a0000000000000: "unknown",
      nonsense: "unknown",
    });
  });

  it("answers unknown, not gone, for a project file whose folder is unreachable", async () => {
    const project = path.join(base, "External Drive", "Proj");
    fs.mkdirSync(project, { recursive: true });
    const onDrive = await record({ projectDir: project });
    const deletedFile = await record({ projectDir: project });
    fs.unlinkSync(deletedFile.asset.displayPath);
    const library = await __assetLibraryForTests();
    // File checks are cached for 30 s; expire them as time would.
    await library.verifyFiles([library.get(deletedFile.asset.id)!], 0);
    expect(await assetExistence([deletedFile.asset.id])).toEqual({ [deletedFile.asset.id]: "gone" });

    fs.rmSync(path.join(base, "External Drive"), { recursive: true, force: true });
    await library.verifyFiles([library.get(onDrive.asset.id)!], 0);
    expect(await assetExistence([onDrive.asset.id])).toEqual({ [onDrive.asset.id]: "unknown" });
  });

  it("answers unknown, never gone, when the file can't be checked (no permission, I/O error)", async () => {
    const r = await record();
    const stat = fs.promises.stat;
    const spy = vi.spyOn(fs.promises, "stat").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
      String(file) === r.asset.displayPath
        ? Promise.reject(Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" }))
        : (stat as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof stat);
    try {
      expect(await openAssetFile(r.asset.id)).toBeNull();
      expect(await assetExistence([r.asset.id])).toEqual({ [r.asset.id]: "unknown" });
      expect((await getAsset(r.asset.id))?.missing).toBeUndefined();
      expect(await ids({ scope: "missing" })).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    // Once it can be checked again, it is simply there.
    const library = await __assetLibraryForTests();
    await library.verifyFiles([library.get(r.asset.id)!], 0);
    expect(await assetExistence([r.asset.id])).toEqual({ [r.asset.id]: "present" });
  });

  it("answers unknown for everything when the library is unavailable", async () => {
    process.env.VERCEL = "1";
    try {
      expect(await assetExistence(["a0000000000001"])).toEqual({ a0000000000001: "unknown" });
    } finally {
      delete process.env.VERCEL;
    }
  });
});

describe("missing files", () => {
  it("serves present files and lists missing ones in their own scope", async () => {
    const r = await record();
    expect(await openAssetFile(r.asset.id)).toMatchObject({ path: r.asset.displayPath, mime: "image/png", sha256: r.asset.sha256 });
    fs.unlinkSync(r.asset.displayPath);
    expect(await openAssetFile(r.asset.id)).toBeNull();
    expect(await ids({ scope: "missing" })).toEqual([r.asset.id]);
    expect((await getFacets()).missing).toBe(1);
    expect((await listAssets({})).assets[0].missing).toBe(true);
  });
});

describe("two processes on one library", () => {
  it("see each other's records, edits and deletes through the journal", async () => {
    const mine = await record({ prompt: "from the web build" });
    const other = new AssetLibrary(root);
    await other.ready();
    expect((await other.query({})).assets.map((x) => x.id)).toEqual([mine.asset.id]);

    await other.patch(mine.asset.id, { tags: ["from-desktop"] });
    expect((await getAsset(mine.asset.id))?.tags).toEqual(["from-desktop"]);

    const theirs = await other.addRecord({
      ...(await other.readSidecar(mine.asset.id))!,
      id: "a" + "z".repeat(13),
      createdAt: mine.asset.createdAt + 1,
      tags: [],
    });
    expect(await ids()).toEqual([theirs.id, mine.asset.id]);

    await other.patch(theirs.id, { trashed: true });
    await other.deleteRecords([theirs.id]);
    expect(await assetExistence([theirs.id])).toEqual({ [theirs.id]: "gone" });
    expect(await ids()).toEqual([mine.asset.id]);
    await other.drain();
  });

  it("rescans after the journal is compacted", async () => {
    const r = await record();
    const other = new AssetLibrary(root);
    await other.ready();
    await other.patch(r.asset.id, { trashed: true });
    await other.deleteRecords([r.asset.id]);
    expect(await other.compactJournal()).toBe(true);
    const journal = fs.readFileSync(path.join(root, ".nodebanana", "journal.ndjson"), "utf8").trim().split("\n");
    // A fresh generation marker, then the tombstones.
    expect(typeof JSON.parse(journal[0]).gen).toBe("string");
    expect(journal.slice(1).map((line) => JSON.parse(line).op)).toEqual(["del"]);
    expect(await ids()).toEqual([]);
    expect(await assetExistence([r.asset.id])).toEqual({ [r.asset.id]: "gone" });
    await other.drain();
  });

  it("rescans a journal another process compacted, even when it grew back past this one's offset", async () => {
    const a = new AssetLibrary(root, { trash: async () => {} });
    const b = new AssetLibrary(root, { trash: async () => {} });
    await a.ready();
    await b.ready();
    const made = [];
    for (let i = 0; i < 12; i++) made.push(await a.addRecord(fakeRecord({ createdAt: T0 + i })));
    await a.deleteRecords(made.slice(0, 8).map((r) => r.id));
    expect(await a.compactJournal()).toBe(true);
    // The compacted journal (8 tombstones) is longer than what b last read.
    await b.ready();
    expect(b.allRecords().map((r) => r.id).sort()).toEqual(made.slice(8).map((r) => r.id).sort());
    await a.drain();
    await b.drain();
  });
});

describe("journal failures", () => {
  function failOnce(method: "appendFile") {
    return vi
      .spyOn(fs.promises, method)
      .mockRejectedValueOnce(Object.assign(new Error("EIO: i/o error, append"), { code: "EIO" }));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a recording whose sidecar is written when the journal append fails", async () => {
    const png = makePng(5, 5, 901);
    const started = await beginRecord({ meta: meta(), source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    const spy = failOnce("appendFile");
    const result = await completeUpload(started.ticket.uploadId, streamOf(png), null);
    expect(spy).toHaveBeenCalled();
    expect(fs.existsSync(result.asset.displayPath)).toBe(true);
    expect(await openAssetFile(result.asset.id)).toMatchObject({ path: result.asset.displayPath });
  });

  it("still releases files when the journal append of a delete fails", async () => {
    const r = await record();
    await patchAsset(r.asset.id, { trashed: true });
    failOnce("appendFile");
    const result = await bulkAssets({ selection: { mode: "ids", ids: [r.asset.id] }, op: { action: "delete" } });
    expect(result).toMatchObject({ affected: 1, errors: [] });
    expect(fs.existsSync(r.asset.displayPath)).toBe(false);
  });
});

describe("unreadable sidecars", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Reads of these files fail with EIO, as an offline cloud placeholder's would. */
  function unreadable(...files: string[]) {
    const readFile = fs.promises.readFile;
    vi.spyOn(fs.promises, "readFile").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
      files.includes(String(file))
        ? Promise.reject(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }))
        : (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof readFile);
  }

  const sidecarOf = (id: string) => path.join(root, ".nodebanana", "assets", `${id}.json`);

  it("keeps the run, media and poster of a record it couldn't read at startup through a cleanup", async () => {
    const r = await record();
    const input = makePng(2, 2, 902);
    await putMedia(sha256(input), streamOf(input), "image/png");
    await putRun(r.asset.runId, {
      meta: { id: r.asset.runId, workflowId: r.asset.workflowId, workflowName: null, projectPath: null, startedAt: 1 },
      phase: "start",
      workflow: snapshot(),
      mediaHashes: [sha256(input), r.asset.sha256],
    });
    const run = path.join(root, ".nodebanana", "runs", `${r.asset.runId}.json.gz`);
    const longAgo = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(run, longAgo, longAgo);
    const poster = path.join(root, ".nodebanana", "posters", `${r.asset.sha256}.webp`);
    fs.mkdirSync(path.dirname(poster), { recursive: true });
    fs.writeFileSync(poster, "poster");

    // The next start, with that sidecar offline.
    unreadable(sidecarOf(r.asset.id));
    const fresh = new AssetLibrary(root, { trash: async () => {} });
    await fresh.ready();
    expect(fresh.allRecords()).toEqual([]);
    const job: JobContext = { signal: new AbortController().signal, update: () => {}, addBytes: () => {}, step: () => {}, checkCancelled: () => {} };
    expect(await runCleanup(job, { library: fresh, thumbs: null }, { unusedMedia: true })).toMatch(/couldn't be read/);
    expect(fs.existsSync(run)).toBe(true);
    expect(fs.existsSync(path.join(root, ".nodebanana", "media", `${sha256(input)}.png`))).toBe(true);
    expect(fs.existsSync(poster)).toBe(true);

    // Readable again: the record comes back.
    vi.restoreAllMocks();
    expect(await fresh.hasUnreadable()).toBe(false);
    expect(fresh.allRecords().map((x) => x.id)).toEqual([r.asset.id]);
    await fresh.drain();
  });

  it("releases no file or run a record it couldn't read may share", async () => {
    const png = makePng(3, 3, 903);
    const run = runId();
    const deleted = await record({ runId: run }, png);
    const sharing = await record({ runId: run }, png);
    expect(sharing.reusedFile).toBe(true);
    await patchAsset(deleted.asset.id, { trashed: true });

    unreadable(sidecarOf(sharing.asset.id));
    const trashed: string[] = [];
    const fresh = new AssetLibrary(root, { trash: async (files) => void trashed.push(...files) });
    await fresh.ready();
    await putRun(run, {
      meta: { id: run, workflowId: deleted.asset.workflowId, workflowName: null, projectPath: null, startedAt: 1 },
      phase: "final",
      workflow: snapshot(),
      mediaHashes: [sha256(png)],
    });
    expect(await fresh.deleteRecords([deleted.asset.id])).toMatchObject({ affected: 1 });
    expect(trashed).toEqual([]);
    expect(fs.existsSync(sharing.asset.displayPath)).toBe(true);
    expect(fs.existsSync(path.join(root, ".nodebanana", "runs", `${run}.json.gz`))).toBe(true);

    // Readable again, and it did share them: the release noted for later leaves both where they are.
    vi.restoreAllMocks();
    expect(await runCleanup(jobContext(), { library: fresh, thumbs: null }, { unusedMedia: true })).toBe("Nothing to clean up.");
    expect(trashed).toEqual([]);
    expect(fs.existsSync(sharing.asset.displayPath)).toBe(true);
    expect(fs.existsSync(path.join(root, ".nodebanana", "runs", `${run}.json.gz`))).toBe(true);
    expect(pendingReleases()).toEqual([]);
    await fresh.drain();
  });

  const jobContext = (): JobContext => ({ signal: new AbortController().signal, update: () => {}, addBytes: () => {}, step: () => {}, checkCancelled: () => {} });

  function pendingReleases(): string[] {
    const dir = path.join(root, ".nodebanana", "pending-release");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  /** A trashed asset deleted for good while an unrelated record's sidecar can't be read. */
  async function deleteWhileUnreadable() {
    const deleted = await record();
    const unrelated = await record();
    await patchAsset(deleted.asset.id, { trashed: true });
    unreadable(sidecarOf(unrelated.asset.id));
    const trashed: string[] = [];
    const fresh = new AssetLibrary(root, { trash: async (files) => void trashed.push(...files) });
    await fresh.ready();
    expect(await fresh.deleteRecords([deleted.asset.id])).toMatchObject({ affected: 1, errors: [] });
    expect(trashed).toEqual([]);
    expect(fs.existsSync(deleted.asset.displayPath)).toBe(true);
    vi.restoreAllMocks();
    return { deleted, trashed, fresh };
  }

  it("releases a deleted asset's file with the next delete, once every record reads again", async () => {
    const { deleted, trashed, fresh } = await deleteWhileUnreadable();
    const next = await record();
    await patchAsset(next.asset.id, { trashed: true });
    await fresh.ready();
    expect(await fresh.deleteRecords([next.asset.id])).toMatchObject({ affected: 1 });
    expect(trashed.sort()).toEqual([deleted.asset.displayPath, next.asset.displayPath].sort());
    expect(pendingReleases()).toEqual([]);
    await fresh.drain();
  });

  it("releases a deleted asset's file with the next cleanup, once every record reads again", async () => {
    const { deleted, trashed, fresh } = await deleteWhileUnreadable();
    expect(await runCleanup(jobContext(), { library: fresh, thumbs: null }, { unusedMedia: true })).toMatch(/^Removed 1 file \(/);
    expect(trashed).toEqual([deleted.asset.displayPath]);
    expect(pendingReleases()).toEqual([]);
    expect(await runCleanup(jobContext(), { library: fresh, thumbs: null }, { unusedMedia: true })).toBe("Nothing to clean up.");
    expect(trashed).toHaveLength(1);
    await fresh.drain();
  });

  it("leaves a kept file alone when it no longer holds the deleted bytes by the time it can be released", async () => {
    const { deleted, trashed, fresh } = await deleteWhileUnreadable();
    const bytes = fs.readFileSync(deleted.asset.displayPath);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(deleted.asset.displayPath, bytes);
    expect(await runCleanup(jobContext(), { library: fresh, thumbs: null }, { unusedMedia: true })).toBe("Nothing to clean up.");
    expect(trashed).toEqual([]);
    expect(fs.existsSync(deleted.asset.displayPath)).toBe(true);
    expect(pendingReleases()).toEqual([]);
    await fresh.drain();
  });

  // chmod can't make a file unreadable on Windows or for root.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the note for a kept file it can't read right now, and releases it on a later pass",
    async () => {
      const { deleted, trashed, fresh } = await deleteWhileUnreadable();
      // Offline placeholder, antivirus lock…: stat works, reading fails.
      fs.chmodSync(deleted.asset.displayPath, 0o000);
      try {
        expect(await runCleanup(jobContext(), { library: fresh, thumbs: null }, { unusedMedia: true })).toBe("Nothing to clean up.");
        expect(trashed).toEqual([]);
        expect(pendingReleases()).toHaveLength(1);
      } finally {
        fs.chmodSync(deleted.asset.displayPath, 0o644);
      }
      expect(await runCleanup(jobContext(), { library: fresh, thumbs: null }, { unusedMedia: true })).toMatch(/^Removed 1 file \(/);
      expect(trashed).toEqual([deleted.asset.displayPath]);
      expect(pendingReleases()).toEqual([]);
      await fresh.drain();
    },
  );

  it("reports an error for a sidecar it can't read right now, without dropping the record", async () => {
    const r = await record();
    const sidecar = path.join(root, ".nodebanana", "assets", `${r.asset.id}.json`);
    const readFile = fs.promises.readFile;
    vi.spyOn(fs.promises, "readFile").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
      String(file) === sidecar
        ? Promise.reject(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }))
        : (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof readFile);
    const result = await bulkAssets({ selection: { mode: "ids", ids: [r.asset.id] }, op: { action: "favorite" } });
    expect(result.affected).toBe(0);
    expect(result.errors).toEqual([{ id: r.asset.id, error: expect.stringContaining("EIO") }]);
    vi.restoreAllMocks();
    expect(await ids()).toEqual([r.asset.id]);
    expect((await bulkAssets({ selection: { mode: "ids", ids: [r.asset.id] }, op: { action: "favorite" } })).affected).toBe(1);
  });
});

describe("loading sidecars", () => {
  it("accepts only exact sidecar names and drops records that point outside the library", async () => {
    const r = await record();
    const assets = path.join(root, ".nodebanana", "assets");
    const sidecar = JSON.parse(fs.readFileSync(path.join(assets, `${r.asset.id}.json`), "utf8"));
    // Sync-conflict copies and temp files are not records.
    fs.writeFileSync(path.join(assets, `${r.asset.id}-DESKTOP-1.json`), JSON.stringify({ ...sidecar, id: `${r.asset.id}-DESKTOP-1` }));
    fs.writeFileSync(path.join(assets, `${r.asset.id}.json.1234.tmp`), "{");
    const escaping = "a" + "e".repeat(13);
    fs.writeFileSync(
      path.join(assets, `${escaping}.json`),
      JSON.stringify({ ...sidecar, id: escaping, file: { root: "library", rel: "../../outside.png" } }),
    );
    const notMedia = "a" + "f".repeat(13);
    fs.writeFileSync(
      path.join(assets, `${notMedia}.json`),
      JSON.stringify({ ...sidecar, id: notMedia, file: { root: "external", path: path.join(base, "secret.txt") } }),
    );
    const intoData = "a" + "g".repeat(13);
    fs.writeFileSync(
      path.join(assets, `${intoData}.json`),
      JSON.stringify({ ...sidecar, id: intoData, file: { root: "library", rel: ".nodebanana/journal.ndjson" } }),
    );
    fs.writeFileSync(path.join(assets, `${"a" + "h".repeat(13)}.json`), "not json");
    // A torn journal line from a crash is ignored.
    fs.appendFileSync(path.join(root, ".nodebanana", "journal.ndjson"), '{"op":"put","id":');

    const fresh = new AssetLibrary(root);
    await fresh.ready();
    expect(fresh.allRecords().map((x) => x.id)).toEqual([r.asset.id]);

    // A write after the torn line still reaches other processes.
    await fresh.patch(r.asset.id, { tags: ["after-crash"] });
    expect((await getAsset(r.asset.id))?.tags).toEqual(["after-crash"]);
    await fresh.drain();
  });
});

describe("loading a display name", () => {
  it("keeps one a rename could have set, trimmed, and drops any other without dropping the record", async () => {
    const assets = path.join(root, ".nodebanana", "assets");
    const names: unknown[] = ["  Sunset ", "Sun\nset", "x".repeat(121), "", 7];
    const recorded: RecordAssetResult[] = [];
    for (let i = 0; i < names.length; i++) recorded.push(await record());
    recorded.forEach((r, i) => {
      const file = path.join(assets, `${r.asset.id}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), name: names[i] }));
    });

    const fresh = new AssetLibrary(root);
    await fresh.ready();
    const loaded = recorded.map((r) => fresh.allRecords().find((x) => x.id === r.asset.id));
    expect(loaded.every(Boolean)).toBe(true);
    expect(loaded[0]?.name).toBe("Sunset");
    for (const record of loaded.slice(1)) expect(record && "name" in record).toBe(false);
    await fresh.drain();
  });
});

function snapshot(name = "Flow"): SnapshotWorkflow {
  return { version: 1, name, nodes: [{ id: "n1", data: { outputImage: { $nbMedia: "x" } } }], edges: [], edgeStyle: "curved" };
}

describe("run snapshots and media", () => {
  it("stores start then final in one gzip file and reports media it lacks", async () => {
    const r = await record();
    const run = r.asset.runId;
    const other = "f".repeat(64);
    const started = await putRun(run, {
      meta: { id: run, workflowId: r.asset.workflowId, workflowName: "Test flow", projectPath: null, startedAt: 1000 },
      phase: "start",
      workflow: snapshot("Start"),
      mediaHashes: [r.asset.sha256, other],
    });
    expect(started.missingMedia).toEqual([other]);
    expect((await getAssetWorkflow(r.asset.id))?.which).toBe("start");

    await putRun(run, {
      meta: { id: run, workflowId: r.asset.workflowId, workflowName: "Test flow", projectPath: null, startedAt: 2000 },
      phase: "final",
      workflow: snapshot("Final"),
      mediaHashes: [],
    });
    const opened = await getAssetWorkflow(r.asset.id);
    expect(opened).toMatchObject({ which: "final", workflow: { name: "Final" }, run: { id: run, startedAt: 1000 } });

    const stored = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, ".nodebanana", "runs", `${run}.json.gz`))).toString());
    expect(stored.start.name).toBe("Start");
    expect(stored.mediaHashes.sort()).toEqual([r.asset.sha256, other].sort());
  });

  it("has no workflow for an asset whose run was never stored", async () => {
    const r = await record({ runId: runId() });
    expect(await getAssetWorkflow(r.asset.id)).toBeNull();
  });

  it("verifies media uploads against their hash", async () => {
    const png = makePng(2, 2, 77);
    const sha = sha256(png);
    expect(await mediaHas([sha])).toEqual([sha]);
    await expect(putMedia("0".repeat(64), streamOf(png), "image/png")).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(fs.readdirSync(path.join(root, ".nodebanana", "media"))).toEqual([]);
    expect(await putMedia(sha, streamOf(png), "image/png")).toEqual({ sha256: sha, bytes: png.length });
    expect(await mediaHas([sha])).toEqual([]);
    expect(await openMedia(sha)).toMatchObject({ mime: "image/png", bytes: png.length });
    // A second upload of the same bytes is a no-op.
    expect(await putMedia(sha, streamOf(png), "image/png")).toEqual({ sha256: sha, bytes: png.length });
  });

  it("refuses a snapshot for a different run id", async () => {
    await expect(
      putRun(runId(), {
        meta: { id: runId(), workflowId: "wf_1", workflowName: null, projectPath: null, startedAt: 1 },
        phase: "start",
        workflow: snapshot(),
        mediaHashes: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("workflows table", () => {
  it("upserts without rewriting when nothing changed, and records forks", async () => {
    const file = path.join(root, ".nodebanana", "workflows.json");
    const project = path.join(base, "Proj");
    const entry = await upsertWorkflowEntry("wf_a", { name: "A", projectPath: `${project}/` });
    expect(entry).toMatchObject({ id: "wf_a", name: "A", projectPath: project });
    const before = fs.statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const same = await upsertWorkflowEntry("wf_a", { name: "A", projectPath: project });
    expect(same.updatedAt).toBe(entry.updatedAt);
    expect(fs.statSync(file).mtimeMs).toBe(before);

    const fork = await upsertWorkflowEntry("wf_b", { name: "A", projectPath: path.join(base, "Elsewhere"), forkedFrom: "wf_a" });
    expect(fork.forkedFrom).toBe("wf_a");
    const table = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(table.wf_a.projectPath).toBe(project);
    // A late upsert from a run that started before the save knows less; it never clears the row.
    const late = await upsertWorkflowEntry("wf_a", { name: null, projectPath: null });
    expect(late).toMatchObject({ name: "A", projectPath: project });
    const renamed = await upsertWorkflowEntry("wf_a", { name: "A2", projectPath: null });
    expect(renamed).toMatchObject({ name: "A2", projectPath: project });
    expect(await upsertWorkflowEntry("wf_new", { name: null, projectPath: null })).toMatchObject({ name: null, projectPath: null });
    await expect(upsertWorkflowEntry("bad/id", { name: null, projectPath: null })).rejects.toMatchObject({ status: 400 });
    await expect(upsertWorkflowEntry("wf_c", { name: null, projectPath: "relative" })).rejects.toMatchObject({ status: 400 });
  });

  it("never lets a run's late upsert undo a rename or a folder change made during the run", async () => {
    const fox = path.join(base, "Fox");
    const wolf = path.join(base, "Wolf");
    const runStarted = Date.now() - 1000;
    await upsertWorkflowEntry("wf_run", { name: "Fox", projectPath: fox });
    // Saved under a new name and folder while the video rendered.
    await upsertWorkflowEntry("wf_run", { name: "Wolf", projectPath: wolf });
    // The video lands and its run sends what the canvas knew when it started.
    const late = await upsertWorkflowEntry("wf_run", { name: "Fox", projectPath: fox, asOf: runStarted });
    expect(late).toMatchObject({ name: "Wolf", projectPath: wolf });
    expect(JSON.parse(fs.readFileSync(path.join(root, ".nodebanana", "workflows.json"), "utf8")).wf_run).toMatchObject({
      name: "Wolf",
      projectPath: wolf,
    });

    // A newer observation still wins, and an older one still fills in what the row lacks or creates it.
    expect(await upsertWorkflowEntry("wf_run", { name: "Wolf 2", projectPath: wolf, asOf: Date.now() + 1000 })).toMatchObject({ name: "Wolf 2" });
    await upsertWorkflowEntry("wf_unnamed", { name: null, projectPath: null });
    expect(await upsertWorkflowEntry("wf_unnamed", { name: "Named", projectPath: fox, asOf: 1 })).toMatchObject({ name: "Named", projectPath: fox });
    expect(await upsertWorkflowEntry("wf_absent", { name: "New", projectPath: null, asOf: 1 })).toMatchObject({ name: "New" });
  });
});
