// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryJobStatus, RecordAssetMeta, RecordAssetResult } from "../../types";
import {
  __assetLibraryForTests,
  __drainAssetLibraryForTests,
  __resetAssetLibraryForTests,
  beginRecord,
  bulkAssets,
  cancelJob,
  completeUpload,
  getFacets,
  getJob,
  getLibraryStatus,
  listAssets,
  openMedia,
  patchAsset,
  putMedia,
  putRun,
  setLibraryRoot,
  startCleanup,
  startExport,
  startImport,
  upsertWorkflowEntry,
} from "../index";
import { Ingestor } from "../ingest";
import { JobRunner, runExport, runImport, runMove, validateMoveTarget, type JobContext } from "../jobs";
import { AssetLibrary } from "../library";
import { newAssetId } from "../../client/ids";
import { createEdit, listEdits } from "@/lib/edits/server";
import { installBridge, makePng, makeWav, md5, meta, sha256, streamOf, tempDir, TINY_MP4 } from "./helpers";

let base: string;
let home: string;
let bridge: ReturnType<typeof installBridge>;

beforeEach(async () => {
  base = tempDir();
  home = path.join(base, "home");
  fs.mkdirSync(home);
  bridge = installBridge(path.join(base, "OS Trash"));
  delete process.env.NODE_BANANA_ASSET_LIBRARY;
  // No env override: resolve the default under a fake home, so the library can be moved.
  await __resetAssetLibraryForTests({
    pathContext: { platform: process.platform, env: {}, homedir: home, winDocumentsDir: path.join(home, "Documents") },
  });
});

afterEach(async () => {
  await __resetAssetLibraryForTests();
  bridge.remove();
  fs.rmSync(base, { recursive: true, force: true });
});

let seed = 300;

async function record(overrides: Partial<RecordAssetMeta> = {}, buffer: Buffer = makePng(4, 4, seed++)): Promise<RecordAssetResult> {
  const started = await beginRecord({ meta: meta(overrides), source: { type: "upload" } });
  if ("result" in started) return started.result;
  return completeUpload(started.ticket.uploadId, streamOf(buffer), null);
}

function jobContext(): JobContext {
  return { signal: new AbortController().signal, update: () => {}, addBytes: () => {}, step: () => {}, checkCancelled: () => {} };
}

async function finished(job: LibraryJobStatus): Promise<LibraryJobStatus> {
  await __drainAssetLibraryForTests();
  return getJob(job.id)!;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return out.sort();
}

describe("move", () => {
  it("copies the library, verifies it, switches, and removes only what it copied", async () => {
    const status = await getLibraryStatus();
    const oldRoot = path.join(home, "Documents", "Node Banana");
    expect(status).toMatchObject({ available: true, root: oldRoot, source: "default" });

    const project = path.join(base, "Project");
    fs.mkdirSync(project);
    const inLibrary = await record({ prompt: "keep me" });
    const inProject = await record({ projectDir: project });
    await patchAsset(inLibrary.asset.id, { tags: ["moved"] });
    const media = makePng(2, 2, 1);
    await putMedia(sha256(media), streamOf(media), "image/png");
    fs.writeFileSync(path.join(oldRoot, "notes.txt"), "the user's own file");

    const newRoot = path.join(base, "External", "NB Library");
    const moving = await setLibraryRoot({ root: newRoot, mode: "move" });
    expect(moving.job?.type).toBe("move");
    const job = await finished(moving.job!);
    expect(job).toMatchObject({ state: "done", done: job.total });
    expect(job.message).toMatch(/^Moved \d+ files\.$/);
    expect(job.bytesDone).toBe(job.bytesTotal);

    const after = await getLibraryStatus();
    expect(after).toMatchObject({ root: newRoot, source: "config" });
    const config = JSON.parse(fs.readFileSync(path.join(home, ".node-banana", "library.json"), "utf8"));
    expect(config).toMatchObject({ root: newRoot, setBy: "user" });

    // Old root: only what the library didn't own is left.
    expect(walk(oldRoot)).toEqual(["notes.txt"]);
    const moved = walk(newRoot);
    expect(moved).toContain(inLibrary.asset.file.root === "library" ? inLibrary.asset.file.rel : "");
    expect(moved).toContain(`.nodebanana/assets/${inLibrary.asset.id}.json`);
    expect(moved).toContain(`.nodebanana/media/${sha256(media)}.png`);

    const page = await listAssets({});
    const movedView = page.assets.find((asset) => asset.id === inLibrary.asset.id)!;
    expect(movedView.displayPath.startsWith(newRoot)).toBe(true);
    expect(movedView.tags).toEqual(["moved"]);
    expect(page.assets.find((asset) => asset.id === inProject.asset.id)?.displayPath).toBe(inProject.asset.displayPath);
    expect(await openMedia(sha256(media))).not.toBeNull();

    // Recording continues into the new root.
    const next = await record();
    expect(next.asset.displayPath.startsWith(newRoot)).toBe(true);
  });

  it("refuses targets inside or around the library, or holding another library", async () => {
    const root = path.join(base, "Lib");
    fs.mkdirSync(path.join(root, ".nodebanana"), { recursive: true });
    await expect(validateMoveTarget(root, path.join(root, "Inner"))).rejects.toThrow(/inside the library/);
    await expect(validateMoveTarget(root, base)).rejects.toThrow(/inside the library/);
    await expect(validateMoveTarget(root, root)).rejects.toThrow(/already the library/);
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect(validateMoveTarget(root, path.join(root.toUpperCase(), "x"))).rejects.toThrow(/inside the library/);
    }
    const occupied = path.join(base, "Occupied");
    fs.mkdirSync(path.join(occupied, ".nodebanana", "assets"), { recursive: true });
    fs.writeFileSync(path.join(occupied, ".nodebanana", "assets", "a0000000000001.json"), "{}");
    await expect(validateMoveTarget(root, occupied)).rejects.toMatchObject({ code: "conflict" });
    await expect(validateMoveTarget(root, "relative/path")).rejects.toMatchObject({ status: 400 });
    expect(await validateMoveTarget(root, path.join(base, "Fresh"))).toBe(path.join(base, "Fresh"));
    // A root the library left, where the other build (not yet following the move) put its writers folder again.
    const left = path.join(base, "Left");
    fs.mkdirSync(path.join(left, ".nodebanana", "writers"), { recursive: true });
    expect(await validateMoveTarget(root, left)).toBe(left);
    // Another library's edits: the copy would write over them.
    const edits = path.join(base, "Edits left");
    fs.mkdirSync(path.join(edits, "Edits", "generations"), { recursive: true });
    expect(await validateMoveTarget(root, edits)).toBe(edits);
    // Finder's clutter, or a project called Edits, is no other library's edits.
    fs.writeFileSync(path.join(edits, "Edits", ".DS_Store"), "x");
    fs.writeFileSync(path.join(edits, "Edits", "Edits.json"), "{}");
    expect(await validateMoveTarget(root, edits)).toBe(edits);
    fs.writeFileSync(path.join(edits, "Edits", "Trip.nbedit"), "{}");
    await expect(validateMoveTarget(root, edits)).rejects.toMatchObject({ code: "conflict" });
  });

  it("carries the edit files, and only those, from the Edits folder", async () => {
    const oldRoot = (await getLibraryStatus()).root!;
    await record();
    const edit = await createEdit({ name: "Trip" });
    fs.writeFileSync(path.join(oldRoot, "Edits", "notes.txt"), "the user's own file");

    const newRoot = path.join(base, "External", "NB");
    expect(await finished((await setLibraryRoot({ root: newRoot, mode: "move" })).job!)).toMatchObject({ state: "done" });
    expect(walk(path.join(newRoot, "Edits"))).toEqual(["Trip.nbedit"]);
    expect(walk(path.join(oldRoot, "Edits"))).toEqual(["notes.txt"]);
    expect((await listEdits()).edits.map((e) => [e.id, e.name])).toEqual([[edit.id, "Trip"]]);
    expect((await listEdits()).folder).toBe(path.join(newRoot, "Edits"));
  });

  it("leaves no data folder in the old root, so the library can be moved back there", async () => {
    const oldRoot = (await getLibraryStatus()).root!;
    const r = await record();
    await patchAsset(r.asset.id, { tags: ["round trip"] });
    const newRoot = path.join(base, "External", "NB");
    expect(await finished((await setLibraryRoot({ root: newRoot, mode: "move" })).job!)).toMatchObject({ state: "done" });
    expect(fs.existsSync(path.join(oldRoot, ".nodebanana"))).toBe(false);

    const back = await finished((await setLibraryRoot({ root: oldRoot, mode: "move" })).job!);
    expect(back).toMatchObject({ state: "done" });
    expect((await getLibraryStatus()).root).toBe(oldRoot);
    expect(fs.existsSync(path.join(newRoot, ".nodebanana"))).toBe(false);
    const page = await listAssets({});
    expect(page.assets.map((asset) => [asset.id, asset.tags])).toEqual([[r.asset.id, ["round trip"]]]);
    expect(page.assets[0].displayPath.startsWith(oldRoot)).toBe(true);
  }, 20_000);

  it("answers writes with 503 + Retry-After while a move has recording paused", async () => {
    const r = await record();
    const rt = (globalThis as { __nodeBananaAssetLibrary?: { paused: boolean } }).__nodeBananaAssetLibrary!;
    rt.paused = true;
    try {
      const paused = { status: 503, code: "paused", retryAfter: expect.any(Number) };
      await expect(beginRecord({ meta: meta(), source: { type: "upload" } })).rejects.toMatchObject(paused);
      await expect(patchAsset(r.asset.id, { favorite: true })).rejects.toMatchObject(paused);
      await expect(putMedia("0".repeat(64), streamOf(Buffer.from("x")), "image/png")).rejects.toMatchObject(paused);
      // Reads carry on from the old root.
      expect((await listAssets({})).total).toBe(1);
    } finally {
      rt.paused = false;
    }
    expect((await patchAsset(r.asset.id, { favorite: true }))?.favorite).toBe(true);
  });

  it("is refused while the root comes from NODE_BANANA_ASSET_LIBRARY", async () => {
    await __resetAssetLibraryForTests({
      pathContext: { platform: process.platform, env: { NODE_BANANA_ASSET_LIBRARY: path.join(base, "EnvLib") }, homedir: home },
    });
    await expect(setLibraryRoot({ root: path.join(base, "Elsewhere"), mode: "switch" })).rejects.toMatchObject({
      status: 409,
      code: "forbidden",
    });
  });

  it("marks a running move in both folders, and leaves no marker once it is done", async () => {
    const root = path.join(base, "Marked");
    const library = new AssetLibrary(root);
    await library.ready();
    const day = path.join(root, "Generations", "2026-09-27");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "a.png"), makePng(2, 2, 1));
    fs.writeFileSync(path.join(day, "b.png"), makePng(2, 2, 2));
    const target = path.join(base, "MarkedTarget");
    let atSwitch: { marker: unknown; target: unknown; log: string[] } | null = null;
    await runMove(jobContext(), {
      library,
      waitForWrites: async () => true,
      toRoot: target,
      setPaused: () => {},
      switchRoot: async () => {
        atSwitch = {
          marker: JSON.parse(fs.readFileSync(path.join(root, ".nodebanana", "move.json"), "utf8")),
          target: JSON.parse(fs.readFileSync(path.join(target, ".nodebanana", "move-source.json"), "utf8")),
          log: fs.readFileSync(path.join(root, ".nodebanana", "move-copied.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
        };
      },
    });
    expect(atSwitch).toMatchObject({
      marker: { toRoot: target, pid: process.pid, state: "switching" },
      target: { fromRoot: root },
    });
    expect(atSwitch!.log).toEqual(expect.arrayContaining(["Generations/2026-09-27/a.png", "Generations/2026-09-27/b.png"]));
    expect(fs.existsSync(path.join(target, ".nodebanana", "move-source.json"))).toBe(false);
    expect(walk(path.join(root, ".nodebanana"))).toEqual([]);
    expect(walk(path.join(target, "Generations"))).toEqual(["2026-09-27/a.png", "2026-09-27/b.png"]);
    await library.drain();
  });

  it("copies what changed while it was copying (another process's write already in flight)", async () => {
    const root = path.join(base, "Busy");
    const library = new AssetLibrary(root);
    await library.ready();
    const day = path.join(root, "Generations", "2026-09-27");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "a.png"), makePng(2, 2, 1));
    fs.writeFileSync(path.join(day, "b.png"), makePng(2, 2, 2));
    const target = path.join(base, "BusyTarget");
    let steps = 0;
    const ctx = jobContext();
    ctx.step = () => {
      if (++steps !== 1) return;
      fs.writeFileSync(path.join(day, "late.png"), makePng(2, 2, 3));
      fs.rmSync(path.join(day, walk(day).find((name) => fs.existsSync(path.join(target, "Generations", "2026-09-27", name)))!));
    };
    await runMove(ctx, { library, waitForWrites: async () => true, toRoot: target, setPaused: () => {}, switchRoot: async () => {} });
    const moved = walk(path.join(target, "Generations"));
    expect(moved).toContain("2026-09-27/late.png");
    // The one deleted after it was copied is not resurrected in the new root.
    expect(moved).toHaveLength(2);
    await library.drain();
  });

  it("undoes a move that stopped part-way at the next start, and moves to that folder again", async () => {
    await getLibraryStatus();
    const oldRoot = path.join(home, "Documents", "Node Banana");
    const kept = await record({ prompt: "still here" });
    const keptRel = kept.asset.file.root === "library" ? kept.asset.file.rel : "";
    const target = path.join(base, "Half Copied");
    await __drainAssetLibraryForTests();
    // What quitting mid-copy leaves: part of a copy, both markers, the log, and the dead process's lock.
    const dead = 999_999;
    fs.mkdirSync(path.join(target, path.dirname(keptRel)), { recursive: true });
    fs.copyFileSync(kept.asset.displayPath, path.join(target, keptRel));
    fs.writeFileSync(path.join(target, path.dirname(keptRel), "0000.partial"), "half a file");
    fs.mkdirSync(path.join(target, ".nodebanana", "assets"), { recursive: true });
    const sidecarRel = `.nodebanana/assets/${kept.asset.id}.json`;
    fs.copyFileSync(path.join(oldRoot, sidecarRel), path.join(target, sidecarRel));
    fs.writeFileSync(path.join(target, ".nodebanana", "move-source.json"), JSON.stringify({ fromRoot: oldRoot, startedAt: Date.now() }));
    fs.writeFileSync(path.join(target, "notes.txt"), "the user's own file");
    fs.writeFileSync(
      path.join(oldRoot, ".nodebanana", "move.json"),
      JSON.stringify({ v: 1, toRoot: target, startedAt: Date.now(), pid: dead, state: "copying" }),
    );
    fs.writeFileSync(path.join(oldRoot, ".nodebanana", "move-copied.ndjson"), `${JSON.stringify(keptRel)}\n${JSON.stringify(sidecarRel)}\n`);
    fs.writeFileSync(path.join(oldRoot, ".nodebanana", "lock"), JSON.stringify({ pid: dead, at: Date.now(), purpose: "move" }));

    // The next start.
    await __resetAssetLibraryForTests({
      pathContext: { platform: process.platform, env: {}, homedir: home, winDocumentsDir: path.join(home, "Documents") },
    });
    await getLibraryStatus();
    await __drainAssetLibraryForTests();
    const status = await getLibraryStatus();
    expect(status.root).toBe(oldRoot);
    expect(status.job).toMatchObject({ type: "move", state: "failed", error: expect.stringContaining("interrupted") });
    expect(walk(target)).toEqual(["notes.txt"]);
    expect(fs.existsSync(path.join(oldRoot, ".nodebanana", "move.json"))).toBe(false);
    expect((await listAssets({})).assets.map((asset) => asset.id)).toEqual([kept.asset.id]);

    // The same folder is accepted again, and this time the move completes.
    const retried = await finished((await setLibraryRoot({ root: target, mode: "move" })).job!);
    expect(retried.state).toBe("done");
    expect((await getLibraryStatus()).root).toBe(target);
    expect((await listAssets({})).assets[0].displayPath.startsWith(target)).toBe(true);
  });

  it("leaves the other build's move markers alone when that move holds the lock, so it can still be undone", async () => {
    const root = path.join(base, "Shared");
    const library = new AssetLibrary(root, { trash: async () => {} });
    await library.ready();
    const rel = "Generations/2026-09-27/x.png";
    fs.mkdirSync(path.join(root, "Generations", "2026-09-27"), { recursive: true });
    fs.writeFileSync(path.join(root, rel), makePng(2, 2, 1));
    // The other build (a live process) is moving this library to X and has copied x.png so far.
    const x = path.join(base, "X");
    fs.mkdirSync(path.join(x, "Generations", "2026-09-27"), { recursive: true });
    fs.mkdirSync(path.join(x, ".nodebanana"), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(x, rel));
    fs.writeFileSync(path.join(x, ".nodebanana", "move-source.json"), JSON.stringify({ fromRoot: root, startedAt: Date.now() }));
    const markerFile = path.join(root, ".nodebanana", "move.json");
    const logFile = path.join(root, ".nodebanana", "move-copied.ndjson");
    fs.writeFileSync(markerFile, JSON.stringify({ v: 1, toRoot: x, startedAt: Date.now(), pid: process.ppid, state: "copying" }));
    fs.writeFileSync(logFile, `${JSON.stringify(rel)}\n`);
    fs.writeFileSync(library.layout.lock, JSON.stringify({ pid: process.ppid, at: Date.now(), purpose: "move" }));

    const y = path.join(base, "Y");
    const move = () => runMove(jobContext(), { library, waitForWrites: async () => true, toRoot: y, setPaused: () => {}, switchRoot: async () => {} });
    await expect(move()).rejects.toMatchObject({ code: "busy" });
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(fs.existsSync(logFile)).toBe(true);

    // The other build then dies mid-copy. The next move here undoes its partial copy before starting its own.
    fs.writeFileSync(library.layout.lock, JSON.stringify({ pid: 999_999, at: Date.now(), purpose: "move" }));
    await move();
    expect(walk(x)).toEqual([]);
    expect(walk(path.join(y, "Generations"))).toEqual(["2026-09-27/x.png"]);
    await expect(validateMoveTarget(root, x)).resolves.toBe(x);
    await library.drain();
  });

  it("waits for a recording the other build began before the move, so the copy has it", async () => {
    await record();
    // This runtime plays the other build: it starts an upload that is still arriving.
    const root = (await __assetLibraryForTests()).root;
    const started = await beginRecord({ meta: meta(), source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    const png = makePng(64, 64, 2);
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(png.subarray(0, 100)));
        await new Promise((resolve) => setTimeout(resolve, 500));
        controller.enqueue(new Uint8Array(png.subarray(100)));
        controller.close();
      },
    });
    const uploading = completeUpload(started.ticket.uploadId, slow, null);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Meanwhile this build, with its own index, moves the same library.
    const mover = new AssetLibrary(root, { trash: async () => {} });
    await mover.ready();
    const target = path.join(base, "Moved");
    await runMove(jobContext(), { library: mover, waitForWrites: async () => true, toRoot: target, setPaused: () => {}, switchRoot: async () => {} });
    const saved = await uploading;
    const sidecar = path.join(".nodebanana", "assets", `${saved.asset.id}.json`);
    expect(fs.existsSync(path.join(target, sidecar))).toBe(true);
    expect(fs.existsSync(path.join(root, sidecar))).toBe(false);
    expect(fs.existsSync(path.join(target, ".nodebanana", "writers"))).toBe(false);
    await mover.drain();
  });

  it("refuses a write as soon as the other build's move holds the lock", async () => {
    const r = await record();
    const library = await __assetLibraryForTests();
    const started = await beginRecord({ meta: meta(), source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    // Just looked at the lock, and found no move.
    await patchAsset(r.asset.id, { favorite: true });
    fs.writeFileSync(library.layout.lock, JSON.stringify({ pid: process.ppid, at: Date.now(), purpose: "move" }));
    const paused = { status: 503, code: "paused" };
    await expect(completeUpload(started.ticket.uploadId, streamOf(makePng(2, 2, 78)), "image/png")).rejects.toMatchObject(paused);
    await expect(patchAsset(r.asset.id, { favorite: false })).rejects.toMatchObject(paused);
    expect((await listAssets({})).assets.map((asset) => [asset.id, asset.favorite])).toEqual([[r.asset.id, true]]);

    // Once the move is over, the refused upload's ticket is still good.
    fs.rmSync(library.layout.lock);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await completeUpload(started.ticket.uploadId, streamOf(makePng(2, 2, 78)), "image/png")).asset.id).toBeTruthy();
  });

  it("won't switch to a folder a move stopped copying into", async () => {
    await getLibraryStatus();
    const target = path.join(base, "Unfinished");
    fs.mkdirSync(path.join(target, ".nodebanana"), { recursive: true });
    fs.writeFileSync(path.join(target, ".nodebanana", "move-source.json"), JSON.stringify({ fromRoot: "/somewhere", startedAt: 1 }));
    await expect(setLibraryRoot({ root: target, mode: "switch" })).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("answers writes with 503 while the other build is moving the library", async () => {
    const r = await record();
    const library = await __assetLibraryForTests();
    const started = await beginRecord({ meta: meta(), source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    // The other build's move holds the lock: a live process, a fresh heartbeat.
    fs.writeFileSync(library.layout.lock, JSON.stringify({ pid: process.ppid, at: Date.now(), purpose: "move" }));
    const paused = { status: 503, code: "paused", retryAfter: expect.any(Number) };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(beginRecord({ meta: meta(), source: { type: "upload" } })).rejects.toMatchObject(paused);
    await expect(patchAsset(r.asset.id, { favorite: true })).rejects.toMatchObject(paused);
    await expect(completeUpload(started.ticket.uploadId, streamOf(makePng(2, 2, 77)), "image/png")).rejects.toMatchObject(paused);
    expect((await listAssets({})).total).toBe(1);

    // A lock left by a process that is gone pauses nothing — and the upload's ticket is still good.
    fs.writeFileSync(library.layout.lock, JSON.stringify({ pid: 999_999, at: Date.now(), purpose: "move" }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await completeUpload(started.ticket.uploadId, streamOf(makePng(2, 2, 77)), "image/png")).asset.id).toBeTruthy();
    fs.rmSync(library.layout.lock);
  });

  it("moves only the library's own day folders, never a project's files that sit under Generations", async () => {
    const root = path.join(base, "Owned");
    const library = new AssetLibrary(root);
    await library.ready();
    const day = path.join(root, "Generations", "2026-09-27");
    fs.mkdirSync(path.join(day, "generations"), { recursive: true });
    fs.writeFileSync(path.join(day, "own.png"), makePng(2, 2, 1));
    // From before projects inside the library were refused: a project at <day>, its files in <day>/generations.
    const projectFile = path.join(day, "generations", "p.png");
    const png = makePng(2, 2, 2);
    fs.writeFileSync(projectFile, png);
    await library.addRecord({
      v: 1,
      id: "a" + "p".repeat(13),
      kind: "image",
      origin: "generated",
      mime: "image/png",
      ext: "png",
      bytes: png.length,
      sha256: sha256(png),
      md5: md5(png),
      file: { root: "external", path: projectFile },
      filename: "p.png",
      createdAt: Date.now(),
      producer: { nodeId: "n", nodeType: "nanoBanana" },
      workflowId: "wf_p",
      workflowName: null,
      runId: "r" + "p".repeat(13),
      tags: [],
      favorite: false,
    });
    fs.writeFileSync(path.join(root, "Generations", "loose.png"), makePng(2, 2, 3));

    const target = path.join(base, "OwnedTarget");
    await runMove(jobContext(), {
      library,
      waitForWrites: async () => true,
      toRoot: target,
      setPaused: () => {},
      switchRoot: async () => {},
    });
    expect(walk(path.join(target, "Generations"))).toEqual(["2026-09-27/own.png"]);
    expect(fs.existsSync(projectFile)).toBe(true);
    expect(fs.existsSync(path.join(root, "Generations", "loose.png"))).toBe(true);
    await library.drain();
  });

  it("pauses writes while copying, switches while paused, and cleans up after a cancel", async () => {
    const root = path.join(base, "Direct");
    const library = new AssetLibrary(root);
    await library.ready();
    for (let i = 0; i < 3; i++) {
      const png = makePng(3, 3, 900 + i);
      const dir = path.join(root, "Generations", "2026-09-27");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `f${i}.png`), png);
    }
    const paused: boolean[] = [];
    let pausedAtSwitch: boolean | null = null;
    let isPaused = false;
    const ingest = new Ingestor({ library: () => library, thumbs: () => null, isPaused: () => isPaused });
    let waitedWhilePaused = false;

    const runner = new JobRunner();
    const target = path.join(base, "Target");
    const job = runner.start("move", (ctx) =>
      runMove(ctx, {
        library,
        waitForWrites: async (timeoutMs) => {
          waitedWhilePaused = isPaused;
          return ingest.waitIdle(timeoutMs);
        },
        toRoot: target,
        setPaused: (value) => {
          isPaused = value;
          paused.push(value);
        },
        switchRoot: async () => {
          pausedAtSwitch = isPaused;
        },
      }),
    );
    await runner.drain();
    expect(runner.get(job.id)?.state).toBe("done");
    expect(paused).toEqual([true, false]);
    expect(waitedWhilePaused).toBe(true);
    expect(pausedAtSwitch).toBe(true);
    expect(walk(path.join(root, "Generations"))).toEqual([]);

    // Cancel before the switch: copies are removed, the source is untouched.
    const source = path.join(base, "Source");
    const sourceLibrary = new AssetLibrary(source);
    await sourceLibrary.ready();
    const dir = path.join(source, "Generations", "2026-09-27");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `g${i}.png`), makePng(3, 3, 950 + i));
    let switched = false;
    const controller = new AbortController();
    let steps = 0;
    const ctx: JobContext = {
      signal: controller.signal,
      update: () => {},
      addBytes: () => {},
      step: () => {
        if (++steps === 2) controller.abort();
      },
      checkCancelled: () => {
        if (controller.signal.aborted) throw Object.assign(new Error("Cancelled"), { code: "cancelled" });
      },
    };
    const cancelledTarget = path.join(base, "Cancelled");
    await expect(
      runMove(ctx, {
        library: sourceLibrary,
        waitForWrites: async () => true,
        toRoot: cancelledTarget,
        setPaused: () => {},
        switchRoot: async () => {
          switched = true;
        },
      }),
    ).rejects.toThrow(/Cancelled/);
    expect(switched).toBe(false);
    expect(walk(cancelledTarget)).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(4);
    // A move that ended (even badly) leaves no marker to recover from.
    expect(walk(path.join(source, ".nodebanana")).filter((file) => file.startsWith("move"))).toEqual([]);
  });
});

describe("move: edit files", () => {
  it("removes the edit files it copied when cancelled, and leaves the source's", async () => {
    const source = path.join(base, "Source");
    const library = new AssetLibrary(source);
    await library.ready();
    const editsDir = path.join(source, "Edits");
    fs.mkdirSync(editsDir);
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(editsDir, `Edit ${i}.nbedit`), `{"n":${i}}`);
    const target = path.join(base, "Cancelled");
    const controller = new AbortController();
    let copiedEdits: string[] = [];
    const ctx: JobContext = {
      ...jobContext(),
      signal: controller.signal,
      checkCancelled: () => {
        // Cancelled once both edit files are in the target.
        copiedEdits = walk(path.join(target, "Edits"));
        if (copiedEdits.length === 2) controller.abort();
        if (controller.signal.aborted) throw Object.assign(new Error("Cancelled"), { code: "cancelled" });
      },
    };
    let switched = false;
    await expect(
      runMove(ctx, {
        library,
        waitForWrites: async () => true,
        toRoot: target,
        setPaused: () => {},
        switchRoot: async () => {
          switched = true;
        },
      }),
    ).rejects.toThrow(/Cancelled/);
    expect(copiedEdits).toEqual(["Edit 0.nbedit", "Edit 1.nbedit"]);
    expect(switched).toBe(false);
    expect(walk(target)).toEqual([]);
    expect(fs.readdirSync(editsDir).sort()).toEqual(["Edit 0.nbedit", "Edit 1.nbedit"]);
  });
});

describe("import", () => {
  it("indexes project generations in place with the newest workflow's carousel metadata", async () => {
    const project = path.join(base, "Old Project");
    const generations = path.join(project, "generations");
    fs.mkdirSync(generations, { recursive: true });
    const png = makePng(20, 10, 1);
    const pngName = `a_cat_${md5(png)}`;
    fs.writeFileSync(path.join(generations, `${pngName}.png`), png);
    fs.writeFileSync(path.join(generations, `generation_${md5(TINY_MP4)}.mp4`), TINY_MP4);
    fs.writeFileSync(path.join(generations, `voice_${md5(makeWav())}.wav`), makeWav());
    fs.writeFileSync(path.join(generations, "leftover.partial"), "x");
    fs.writeFileSync(path.join(generations, "notes.txt"), "x");
    const mtime = new Date(2025, 4, 1, 10, 0, 0);
    fs.utimesSync(path.join(generations, `${pngName}.png`), mtime, mtime);

    const workflow = {
      version: 1,
      id: "wf_old_project",
      name: "Old flow",
      nodes: [
        {
          id: "nanoBanana-3",
          type: "nanoBanana",
          data: {
            selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
            imageHistory: [
              {
                id: pngName,
                prompt: "a cat",
                model: "nano-banana-pro",
                aspectRatio: "2:1",
                timestamp: 1,
                generation: { modelId: "nano-banana-pro", parameters: { seed: 4 }, cost: { amount: 0.1, currency: "USD", estimated: false } },
              },
            ],
          },
        },
      ],
      edges: [],
    };
    fs.writeFileSync(path.join(project, "older.json"), JSON.stringify({ ...workflow, id: "wf_stale", name: "Stale" }));
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(project, "older.json"), older, older);
    fs.writeFileSync(path.join(project, "Old flow.json"), JSON.stringify(workflow));

    const empty = path.join(base, "No Generations");
    fs.mkdirSync(empty);

    const job = await finished(await startImport({ projectDirs: [project, `${project}/`, empty] }));
    expect(job).toMatchObject({ state: "done", total: 3, done: 3 });
    expect(job.message).toBe("Imported 3 files. 1 folder has no generations folder.");

    const page = await listAssets({ sort: "oldest" });
    expect(page.total).toBe(3);
    const image = page.assets.find((asset) => asset.kind === "image")!;
    expect(image).toMatchObject({
      imported: true,
      origin: "generated",
      filename: `${pngName}.png`,
      file: { root: "external", path: path.join(generations, `${pngName}.png`) },
      createdAt: mtime.getTime(),
      width: 20,
      height: 10,
      prompt: "a cat",
      aspectRatio: "2:1",
      model: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
      parameters: { seed: 4 },
      cost: { amount: 0.1, currency: "USD", estimated: false },
      producer: { nodeId: "nanoBanana-3", nodeType: "nanoBanana" },
      workflow: { id: "wf_old_project", name: "Old flow", projectPath: project },
    });
    const video = page.assets.find((asset) => asset.kind === "video")!;
    expect(video).toMatchObject({ width: 64, height: 48, producer: { nodeType: "import" } });
    expect(page.assets.find((asset) => asset.kind === "audio")?.durationSec).toBeGreaterThan(0);

    // Running it again finds nothing new.
    const again = await finished(await startImport({ projectDirs: [project] }));
    expect(again.message).toBe("Imported 0 files.");
  });

  it("takes one asset per content: copies of the same bytes under other names are skipped, the oldest kept", async () => {
    const project = path.join(base, "Gallery Project");
    const generations = path.join(project, "generations");
    fs.mkdirSync(generations, { recursive: true });
    const png = makePng(6, 6, 41);
    const at = (minutes: number) => new Date(2026, 8, 27, 7, minutes, 0);
    for (const [name, minute] of [["img-late.png", 30], ["img-first.png", 6], ["img-middle.png", 21]] as const) {
      fs.writeFileSync(path.join(generations, name), png);
      fs.utimesSync(path.join(generations, name), at(minute), at(minute));
    }
    fs.writeFileSync(path.join(generations, "other.png"), makePng(6, 6, 42));

    const job = await finished(await startImport({ projectDirs: [project] }));
    expect(job.message).toBe("Imported 2 files. 2 copies of files already imported skipped.");
    const names = (await listAssets({})).assets.map((asset) => asset.filename).sort();
    expect(names).toEqual(["img-first.png", "other.png"]);
    // The copies stay on disk; they are just not assets of their own
    expect(fs.readdirSync(generations).sort()).toEqual(["img-first.png", "img-late.png", "img-middle.png", "other.png"]);
  });

  it("forgets imported records that repeat the same bytes in the same folder, keeping files and anything touched", async () => {
    const project = path.join(base, "Old Copies");
    const generations = path.join(project, "generations");
    fs.mkdirSync(generations, { recursive: true });
    const png = makePng(6, 6, 51);
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) fs.writeFileSync(path.join(generations, name), png);
    await finished(await startImport({ projectDirs: [project] }));
    const library = await __assetLibraryForTests();
    const [kept] = library.allRecords();
    // What earlier imports did: one record per copy
    for (const [index, name] of ["b.png", "c.png", "d.png"].entries()) {
      await library.addRecord({
        ...kept!,
        id: newAssetId(kept!.createdAt + index + 1),
        file: { root: "external", path: path.join(generations, name) },
        filename: name,
        createdAt: kept!.createdAt + index + 1,
      });
    }
    const tagged = library.allRecords().find((record) => record.filename === "c.png")!;
    await patchAsset(tagged.id, { tags: ["keep"] });
    expect(library.allRecords()).toHaveLength(4);

    // One record per content is left: the tagged one, since tagging is the user's own work
    expect(await library.forgetDuplicateImports()).toBe(3);
    expect(library.allRecords().map((record) => record.filename)).toEqual(["c.png"]);
    expect(fs.readdirSync(generations).sort()).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(await library.forgetDuplicateImports()).toBe(0);
  });

  it("files a folder under its own id when its workflow id already belongs to another project", async () => {
    const first = path.join(base, "A");
    const second = path.join(base, "B");
    fs.mkdirSync(path.join(second, "generations"), { recursive: true });
    fs.writeFileSync(path.join(second, "generations", "x.png"), makePng(2, 2, 5));
    fs.writeFileSync(path.join(second, "flow.json"), JSON.stringify({ version: 1, id: "wf_shared", name: "Shared", nodes: [], edges: [] }));
    await upsertWorkflowEntry("wf_shared", { name: "Shared", projectPath: first });

    await finished(await startImport({ projectDirs: [second] }));
    const [asset] = (await listAssets({})).assets;
    expect(asset.workflowId).toMatch(/^import_/);
    expect(asset.workflow).toMatchObject({ projectPath: second, name: "Shared" });
    const library = await __assetLibraryForTests();
    expect(library.getWorkflow("wf_shared")?.projectPath).toBe(first);
    expect(library.getWorkflow(asset.workflowId)?.forkedFrom).toBe("wf_shared");
  });

  it("stops, adding nothing more, once the other build's move holds the lock", async () => {
    const project = path.join(base, "Moving Project");
    fs.mkdirSync(path.join(project, "generations"), { recursive: true });
    fs.writeFileSync(path.join(project, "generations", "a.png"), makePng(2, 2, 11));
    fs.writeFileSync(path.join(project, "generations", "b.png"), makePng(2, 2, 12));
    const library = await __assetLibraryForTests();
    fs.writeFileSync(library.layout.lock, JSON.stringify({ pid: process.ppid, at: Date.now(), purpose: "move" }));
    await expect(runImport(jobContext(), { library, thumbs: null }, [project])).rejects.toMatchObject({ code: "paused" });
    expect(library.allRecords()).toHaveLength(0);
    fs.rmSync(library.layout.lock);
  });

  it("keeps imported assets with their folder when a twin folder sharing the workflow id runs later", async () => {
    const twin = path.join(base, "P", "A");
    const imported = path.join(base, "P", "B");
    for (const dir of [twin, imported]) {
      fs.mkdirSync(path.join(dir, "generations"), { recursive: true });
      fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ version: 1, id: "wf_twin", name: "Twin", nodes: [], edges: [] }));
    }
    fs.writeFileSync(path.join(imported, "generations", "x.png"), makePng(2, 2, 6));
    await finished(await startImport({ projectDirs: [imported] }));
    // Later the Finder duplicate is opened and run: its run classifies the shared id there.
    await upsertWorkflowEntry("wf_twin", { name: "Twin copy", projectPath: twin });

    const [asset] = (await listAssets({ projects: [imported] })).assets;
    expect(asset.workflow).toEqual({ id: "wf_twin", name: "Twin", projectPath: imported });
    expect((await listAssets({ projects: [twin] })).total).toBe(0);
    expect((await getFacets()).projects).toEqual([expect.objectContaining({ path: imported, count: 1 })]);
  });

  it("refuses a bad folder list and a second job while one runs", async () => {
    await expect(startImport({ projectDirs: [] })).rejects.toMatchObject({ status: 400 });
    await expect(startImport({ projectDirs: ["relative"] })).rejects.toMatchObject({ status: 400 });
    const dirs = Array.from({ length: 3 }, (_, i) => {
      const dir = path.join(base, `P${i}`, "generations");
      fs.mkdirSync(dir, { recursive: true });
      for (let j = 0; j < 20; j++) fs.writeFileSync(path.join(dir, `f${j}.png`), makePng(2, 2, i * 100 + j));
      return path.dirname(dir);
    });
    const first = await startImport({ projectDirs: dirs });
    await expect(startCleanup({ thumbnails: true })).rejects.toMatchObject({ status: 409, code: "busy" });
    expect(cancelJob(first.id)).toBe(true);
    const done = await finished(first);
    expect(done.state).toBe("cancelled");
    expect(cancelJob(first.id)).toBe(false);
  });
});

describe("cleanup", () => {
  it("removes snapshot media nothing references and posters of deleted assets", async () => {
    const keep = makePng(2, 2, 11);
    const drop = makePng(2, 2, 12);
    await putMedia(sha256(keep), streamOf(keep), "image/png");
    await putMedia(sha256(drop), streamOf(drop), "image/png");
    const r = await record();
    await putRun(r.asset.runId, {
      meta: { id: r.asset.runId, workflowId: r.asset.workflowId, workflowName: null, projectPath: null, startedAt: 1 },
      phase: "start",
      workflow: { version: 1, name: "x", nodes: [], edges: [], edgeStyle: "curved" },
      mediaHashes: [sha256(keep)],
    });
    const library = await __assetLibraryForTests();
    const posters = library.layout.posters;
    fs.mkdirSync(posters, { recursive: true });
    fs.writeFileSync(path.join(posters, `${r.asset.sha256}.webp`), "live");
    fs.writeFileSync(path.join(posters, `${"e".repeat(64)}.webp`), "orphan");

    const job = await finished(await startCleanup({ unusedMedia: true }));
    expect(job.state).toBe("done");
    expect(job.message).toMatch(/^Removed 2 files/);
    expect(fs.readdirSync(library.layout.media)).toEqual([`${sha256(keep)}.png`]);
    expect(fs.readdirSync(posters)).toEqual([`${r.asset.sha256}.webp`]);
    await expect(startCleanup({})).rejects.toMatchObject({ status: 400 });
  });

  it("removes a reference to a project file once no snapshot needs it, leaving the file", async () => {
    const project = path.join(base, "Referenced");
    fs.mkdirSync(project);
    const png = makePng(2, 2, 14);
    const inProject = await record({ projectDir: project }, png);
    const later = await record();
    await putRun(later.asset.runId, {
      meta: { id: later.asset.runId, workflowId: later.asset.workflowId, workflowName: null, projectPath: null, startedAt: 1 },
      phase: "start",
      workflow: { version: 1, name: "x", nodes: [], edges: [], edgeStyle: "curved" },
      mediaHashes: [sha256(png)],
    });
    for (const id of [inProject.asset.id, later.asset.id]) {
      await patchAsset(id, { trashed: true });
      await bulkAssets({ selection: { mode: "ids", ids: [id] }, op: { action: "delete" } });
    }
    const library = await __assetLibraryForTests();
    expect(fs.readdirSync(library.layout.media)).toEqual([`${sha256(png)}.ref`]);

    const job = await finished(await startCleanup({ unusedMedia: true }));
    expect(job.state).toBe("done");
    expect(fs.readdirSync(library.layout.media)).toEqual([]);
    expect(fs.readFileSync(inProject.asset.displayPath).equals(png)).toBe(true);
  });

  it("removes old snapshots no asset belongs to, then the media only they referenced", async () => {
    const only = makePng(2, 2, 13);
    await putMedia(sha256(only), streamOf(only), "image/png");
    const r = await record();
    const orphanRun = `r${"0".repeat(12)}orphan`;
    await putRun(orphanRun, {
      meta: { id: orphanRun, workflowId: r.asset.workflowId, workflowName: null, projectPath: null, startedAt: 1 },
      phase: "final",
      workflow: { version: 1, name: "x", nodes: [], edges: [], edgeStyle: "curved" },
      mediaHashes: [sha256(only)],
    });
    const library = await __assetLibraryForTests();
    const orphanFile = path.join(library.layout.runs, `${orphanRun}.json.gz`);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphanFile, old, old);

    const job = await finished(await startCleanup({ unusedMedia: true }));
    expect(job.state).toBe("done");
    expect(fs.existsSync(orphanFile)).toBe(false);
    expect(fs.readdirSync(library.layout.runs)).toEqual([]);
    expect(fs.readdirSync(library.layout.media)).toEqual([]);
  });

  it("deletes no snapshot media while a snapshot can't be read", async () => {
    const needed = makePng(2, 2, 14);
    await putMedia(sha256(needed), streamOf(needed), "image/png");
    const r = await record();
    await putRun(r.asset.runId, {
      meta: { id: r.asset.runId, workflowId: r.asset.workflowId, workflowName: null, projectPath: null, startedAt: 1 },
      phase: "start",
      workflow: { version: 1, name: "x", nodes: [], edges: [], edgeStyle: "curved" },
      mediaHashes: [sha256(needed)],
    });
    const library = await __assetLibraryForTests();
    const file = path.join(library.layout.runs, `${r.asset.runId}.json.gz`);
    // Changed since it was last read (say, by a sync client), and unreadable right now.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, "readFile").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
      String(target) === file
        ? Promise.reject(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }))
        : (readFile as (...args: unknown[]) => Promise<unknown>)(target, ...rest)) as typeof readFile);
    try {
      const job = await finished(await startCleanup({ unusedMedia: true }));
      expect(job.message).toMatch(/couldn't be read/);
      expect(fs.readdirSync(library.layout.media)).toEqual([`${sha256(needed)}.png`]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("export", () => {
  it("copies a selection to a folder with unique names", async () => {
    const png = makePng(3, 3, 21);
    const one = await record({}, png);
    const two = await record({}, png);
    const gone = await record();
    fs.unlinkSync(gone.asset.displayPath);
    const dest = path.join(base, "Export");
    const job = await finished(
      await startExport({ selection: { mode: "ids", ids: [one.asset.id, two.asset.id, gone.asset.id] }, dest }),
    );
    expect(job.message).toBe("Exported 2 files. 1 could not be found.");
    const name = one.filename;
    const stem = name.slice(0, name.lastIndexOf("."));
    expect(fs.readdirSync(dest).sort()).toEqual([name, `${stem} (2).png`].sort());

    const library = await __assetLibraryForTests();
    await expect(startExport({ selection: { mode: "ids", ids: [one.asset.id] }, dest: library.layout.assets })).rejects.toMatchObject({
      status: 400,
    });
    await expect(startExport({ selection: { mode: "ids", ids: [] }, dest })).rejects.toMatchObject({ status: 400 });
  });

  it("never writes outside the chosen folder, whatever a sidecar's file name says", async () => {
    const r = await record();
    const library = await __assetLibraryForTests();
    const sidecar = path.join(library.layout.assets, `${r.asset.id}.json`);
    const raw = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    // A synced library folder: someone else's machine wrote this sidecar.
    fs.writeFileSync(sidecar, JSON.stringify({ ...raw, filename: "../../escape.png" }));
    const other = new AssetLibrary(library.root);
    await other.ready();
    // Reduced to its last segment when read.
    expect(other.get(r.asset.id)?.filename).toBe("escape.png");
    // And a name that never went through a sidecar check still can't leave the folder.
    await other.addRecord({ ...raw, id: "a" + "q".repeat(13), filename: "../../also-escape.png" });

    const dest = path.join(base, "Out", "Inner");
    fs.mkdirSync(dest, { recursive: true });
    const message = await runExport(jobContext(), other, [r.asset.id, "a" + "q".repeat(13)], dest);
    expect(message).toBe("Exported 2 files.");
    expect(fs.existsSync(path.join(base, "escape.png"))).toBe(false);
    expect(fs.existsSync(path.join(base, "also-escape.png"))).toBe(false);
    expect(fs.readdirSync(dest).sort()).toEqual(["also-escape.png", "escape.png"]);
    await other.drain();
  });

  it("stops when the export folder goes away, and marks nothing missing", async () => {
    const one = await record();
    const two = await record();
    const library = await __assetLibraryForTests();
    const dest = path.join(base, "Unplugged");
    await expect(runExport(jobContext(), library, [one.asset.id, two.asset.id], dest)).rejects.toThrow(/no longer available/);
    expect(library.isMissing(one.asset.id)).toBe(false);
    expect(library.isMissing(two.asset.id)).toBe(false);
  });

  it("exports a query selection", async () => {
    const a = await record({ prompt: "sunset one" });
    await record({ prompt: "other" });
    await bulkAssets({ selection: { mode: "ids", ids: [a.asset.id] }, op: { action: "favorite" } });
    const dest = path.join(base, "Favs");
    const job = await finished(await startExport({ selection: { mode: "query", query: { favorite: true }, excludeIds: [] }, dest }));
    expect(job.message).toBe("Exported 1 file.");
    expect(fs.readdirSync(dest)).toEqual([a.filename]);
  });
});

describe("JobRunner", () => {
  /** Work that runs until its job is cancelled. */
  const untilCancelled = (ctx: JobContext) =>
    new Promise<string>((_, reject) => {
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

  it("stops a quiet job so the job a user asked for starts, and still refuses a visible one", async () => {
    const runner = new JobRunner();
    const quiet = runner.start("import", untilCancelled, { quiet: true });
    expect(runner.visible()).toBeNull();
    // A plain start still meets it
    expect(() => runner.start("cleanup", async () => "done")).toThrow("Another library task is running");

    const started = await runner.startOverQuiet("projects", async () => "moved");
    expect(runner.get(quiet.id)?.state).toBe("cancelled");
    await runner.drain();
    expect(runner.get(started.id)).toMatchObject({ type: "projects", state: "done", message: "moved" });

    runner.start("export", untilCancelled);
    await expect(runner.startOverQuiet("cleanup", async () => "done")).rejects.toMatchObject({ code: "busy" });
    await runner.yieldQuiet();
    expect(runner.isRunning).toBe(true);
  });
});
