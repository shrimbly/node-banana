// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordAssetMeta, RecordAssetResult } from "../../types";
import {
  __assetLibraryForTests,
  __resetAssetLibraryForTests,
  beginRecord,
  completeUpload,
  getLibraryStatus,
  LibraryError,
} from "../index";
import { localDay, localTime } from "../validate";
import { installBridge, makePng, makeWav, md5, meta, sha256, streamOf, tempDir, TINY_MP4 } from "./helpers";

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

async function record(buffer: Buffer, overrides: Partial<RecordAssetMeta> = {}, contentType = "image/png"): Promise<RecordAssetResult> {
  const started = await beginRecord({ meta: meta(overrides), source: { type: "upload" } });
  if ("result" in started) return started.result;
  return completeUpload(started.ticket.uploadId, streamOf(buffer), contentType);
}

/** What `recordUpload` sends, less the id, run and kind. */
const UPLOAD = {
  origin: "uploaded" as const,
  prompt: undefined,
  model: undefined,
  producer: { nodeId: "upload", nodeType: "upload", operation: "upload" },
  workflowId: "uploads",
  workflowName: "Uploads",
};

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

describe("status", () => {
  it("is available under the env override, and empty until the first recording", async () => {
    const status = await getLibraryStatus();
    expect(status).toMatchObject({ available: true, root, source: "env", empty: true, counts: { assets: 0, trashed: 0, bytes: 0 } });
    expect(status.cacheDir).toBe(path.join(root, ".nodebanana", "cache"));
    expect(fs.existsSync(path.join(root, ".nodebanana", "library.json"))).toBe(true);

    const png = makePng();
    await record(png);
    const after = await getLibraryStatus();
    expect(after).toMatchObject({ empty: false, counts: { assets: 1, trashed: 0, bytes: png.length } });
  });

  it("reports an unwritable env root as unavailable without throwing", async () => {
    const file = path.join(base, "not-a-folder");
    fs.writeFileSync(file, "x");
    process.env.NODE_BANANA_ASSET_LIBRARY = path.join(file, "Library");
    await __resetAssetLibraryForTests();
    const status = await getLibraryStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/NODE_BANANA_ASSET_LIBRARY/);
    await expect(beginRecord({ meta: meta(), source: { type: "upload" } })).rejects.toMatchObject({ status: 503, code: "unavailable" });
  });

  it("is unavailable on a hosted server", async () => {
    process.env.VERCEL = "1";
    try {
      const status = await getLibraryStatus();
      expect(status.available).toBe(false);
      expect(status.root).toBeNull();
    } finally {
      delete process.env.VERCEL;
    }
  });
});

describe("recording into the library", () => {
  it("writes Generations/<day>/HHMMSS_<snippet>_<sha8>.<ext>, the sidecar, then a journal line", async () => {
    const png = makePng(40, 30);
    const createdAt = new Date(2026, 8, 27, 14, 3, 9).getTime();
    const m = meta({ createdAt, prompt: "Neon koi, rainy street" });
    const started = await beginRecord({ meta: m, source: { type: "upload" } });
    expect("ticket" in started).toBe(true);
    if (!("ticket" in started)) return;
    expect(started.ticket.expiresAt).toBeGreaterThan(Date.now() + 9 * 60 * 1000);

    const result = await completeUpload(started.ticket.uploadId, streamOf(png), "image/png");
    const sha = sha256(png);
    const expectedName = `${localTime(createdAt)}_neon_koi_rainy_street_${sha.slice(0, 8)}.png`;
    const dayDir = path.join(root, "Generations", localDay(createdAt));
    expect(result.filename).toBe(expectedName);
    expect(result.legacyId).toBe(expectedName.replace(/\.png$/, ""));
    expect(result.reusedFile).toBe(false);
    expect(listFiles(dayDir)).toEqual([expectedName]);
    expect(fs.readFileSync(path.join(dayDir, expectedName)).equals(png)).toBe(true);

    expect(result.asset).toMatchObject({
      id: m.id,
      kind: "image",
      mime: "image/png",
      ext: "png",
      bytes: png.length,
      sha256: sha,
      md5: md5(png),
      width: 40,
      height: 30,
      file: { root: "library", rel: `Generations/${localDay(createdAt)}/${expectedName}` },
      displayPath: path.join(dayDir, expectedName),
      workflow: { id: m.workflowId, name: "Test flow", projectPath: null },
      tags: [],
      favorite: false,
    });

    const sidecar = JSON.parse(fs.readFileSync(path.join(root, ".nodebanana", "assets", `${m.id}.json`), "utf8"));
    expect(sidecar).toMatchObject({ v: 1, id: m.id, sha256: sha, prompt: "Neon koi, rainy street" });
    const journal = fs.readFileSync(path.join(root, ".nodebanana", "journal.ndjson"), "utf8").split("\n").filter(Boolean);
    // The generation marker, then one line for the record.
    expect(journal).toHaveLength(2);
    expect(typeof JSON.parse(journal[0]).gen).toBe("string");
    expect(JSON.parse(journal[1])).toMatchObject({ op: "put", id: m.id, pid: process.pid });
  });

  it("measures video and audio", async () => {
    const video = await record(TINY_MP4, { kind: "video", prompt: "clip" }, "video/mp4");
    expect(video.asset).toMatchObject({ kind: "video", ext: "mp4", width: 64, height: 48 });
    expect(video.asset.durationSec).toBeGreaterThan(0.4);
    const audio = await record(makeWav(0.25), { kind: "audio", prompt: "hum" }, "audio/wav");
    expect(audio.asset).toMatchObject({ kind: "audio", ext: "wav", mime: "audio/wav" });
    expect(audio.asset.durationSec).toBeCloseTo(0.25, 2);
  });

  it("records an upload under the name it came with, the file named by the library, and the same file twice as two records", async () => {
    const upload = {
      kind: "video" as const,
      origin: "uploaded" as const,
      name: "sunset.mp4",
      prompt: undefined,
      model: undefined,
      producer: { nodeId: "upload", nodeType: "upload", operation: "upload" },
      workflowId: "uploads",
      workflowName: "Uploads",
    };
    const first = await record(TINY_MP4, upload, "video/mp4");
    expect(first.asset).toMatchObject({ kind: "video", origin: "uploaded", name: "sunset.mp4", workflowName: "Uploads" });
    expect(first.asset.filename).toMatch(/^\d{6}_upload_[0-9a-f]{8}\.mp4$/);
    const sidecar = JSON.parse(fs.readFileSync(path.join(root, ".nodebanana", "assets", `${first.asset.id}.json`), "utf8"));
    expect(sidecar).toMatchObject({ origin: "uploaded", name: "sunset.mp4" });

    const again = await record(TINY_MP4, upload, "video/mp4");
    expect(again.asset.id).not.toBe(first.asset.id);
    expect(again).toMatchObject({ reusedFile: true, filename: first.asset.filename, asset: { name: "sunset.mp4" } });
  });

  it("refuses an upload in a format the library doesn't store, rather than keep it under the kind's default", async () => {
    const avi = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 1), Buffer.from("AVI LIST"), Buffer.alloc(64, 2)]);
    const m = meta({ ...UPLOAD, kind: "video" });
    const started = await beginRecord({ meta: m, source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    await expect(completeUpload(started.ticket.uploadId, streamOf(avi), "video/x-msvideo")).rejects.toMatchObject({
      status: 415,
      code: "unsupported",
      message: "The file isn't in a video or audio format the library can keep",
    });
    expect(listFiles(path.join(root, "Generations", localDay(m.createdAt)))).toEqual([]);
    expect(fs.existsSync(path.join(root, ".nodebanana", "assets", `${m.id}.json`))).toBe(false);

    // Bytes no sniffer knows are kept when their type is one the library stores (an old QuickTime movie)
    const oldMovie = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("wide"), Buffer.alloc(64, 3)]);
    const movie = await record(oldMovie, { ...UPLOAD, kind: "video", mime: "video/quicktime" }, "video/quicktime");
    expect(movie.asset).toMatchObject({ ext: "mov", mime: "video/quicktime" });
    // Anything else keeps the kind's default, as before
    const generated = await record(avi, { kind: "video" }, "video/x-msvideo");
    expect(generated.asset).toMatchObject({ ext: "mp4", origin: "generated" });
  });

  it("keeps the client's dimensions when the file can't be measured", async () => {
    const result = await record(Buffer.from("v 0 0 0\n"), { kind: "3d", mime: "model/obj", width: 100, height: 50 }, "model/obj");
    expect(result.asset).toMatchObject({ kind: "3d", ext: "obj", width: 100, height: 50 });
  });

  it("answers a retried recording with the record it already made", async () => {
    const m = meta();
    const first = await beginRecord({ meta: m, source: { type: "upload" } });
    if (!("ticket" in first)) throw new Error("expected a ticket");
    await completeUpload(first.ticket.uploadId, streamOf(makePng()), "image/png");
    const again = await beginRecord({ meta: m, source: { type: "upload" } });
    expect("result" in again && again.result.asset.id).toBe(m.id);
  });

  it("refuses unknown, reused and malformed uploads", async () => {
    await expect(completeUpload("00000000-0000-4000-8000-000000000000", streamOf(makePng()), null)).rejects.toMatchObject({
      status: 404,
    });
    await expect(completeUpload("../../etc", streamOf(makePng()), null)).rejects.toMatchObject({ status: 400 });
    const started = await beginRecord({ meta: meta(), source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    await completeUpload(started.ticket.uploadId, streamOf(makePng()), null);
    await expect(completeUpload(started.ticket.uploadId, streamOf(makePng()), null)).rejects.toMatchObject({ status: 404 });
    await expect(beginRecord({ meta: { ...meta(), id: "x" }, source: { type: "upload" } })).rejects.toBeInstanceOf(LibraryError);
  });

  it("refuses an empty upload and leaves no partial file", async () => {
    const m = meta();
    const started = await beginRecord({ meta: m, source: { type: "upload" } });
    if (!("ticket" in started)) throw new Error("expected a ticket");
    await expect(completeUpload(started.ticket.uploadId, streamOf(Buffer.alloc(0)), null)).rejects.toMatchObject({ status: 400 });
    const dayDir = path.join(root, "Generations", localDay(m.createdAt));
    expect(listFiles(dayDir)).toEqual([]);
  });
});

describe("recording into a project", () => {
  it("writes <project>/generations/<snippet>_<md5>.<ext> and indexes it in place", async () => {
    const project = path.join(base, "My Project");
    fs.mkdirSync(project);
    const png = makePng(8, 8, 3);
    const result = await record(png, { projectDir: `${project}/./`, prompt: "A cat in a hat" });
    const expected = path.join(project, "generations", `a_cat_in_a_hat_${md5(png)}.png`);
    expect(result.filename).toBe(path.basename(expected));
    expect(result.legacyId).toBe(`a_cat_in_a_hat_${md5(png)}`);
    expect(result.asset.file).toEqual({ root: "external", path: expected });
    expect(fs.readFileSync(expected).equals(png)).toBe(true);
    expect(listFiles(path.join(root, "Generations"))).toEqual([]);
  });

  it("falls back to the library when the project folder does not exist", async () => {
    const result = await record(makePng(), { projectDir: path.join(base, "gone") });
    expect(result.asset.file.root).toBe("library");
    expect(fs.existsSync(path.join(base, "gone"))).toBe(false);
  });

  it("records into the library when the 'project folder' is the library itself", async () => {
    await getLibraryStatus();
    let seed = 40;
    for (const projectDir of [root, path.join(root, "Generations"), path.join(root, "Generations", "2026-09-27"), path.join(root, ".nodebanana")]) {
      fs.mkdirSync(projectDir, { recursive: true });
      const result = await record(makePng(4, 4, seed++), { projectDir });
      expect(result.asset.file.root).toBe("library");
    }
    // No project-style `generations` folder was made inside the library.
    expect(listFiles(root)).not.toContain("generations");
    expect(listFiles(path.join(root, "Generations", "2026-09-27"))).not.toContain("generations");
  });
});

describe("byte dedupe", () => {
  it("keeps one record per recording but one file per destination", async () => {
    const png = makePng(5, 5, 7);
    const first = await record(png, { prompt: "first" });
    const second = await record(png, { prompt: "second" });
    expect(second.asset.id).not.toBe(first.asset.id);
    expect(second.reusedFile).toBe(true);
    expect(second.asset.file).toEqual(first.asset.file);
    expect(second.filename).toBe(first.filename);
    expect(second.asset.prompt).toBe("second");

    // Another day folder still reuses the library copy.
    const later = await record(png, { createdAt: first.asset.createdAt - 3 * 24 * 60 * 60 * 1000 });
    expect(later.reusedFile).toBe(true);
    expect(later.asset.file).toEqual(first.asset.file);

    // A project gets its own copy, and reuses it after that.
    const project = path.join(base, "P");
    fs.mkdirSync(project);
    const inProject = await record(png, { projectDir: project });
    expect(inProject.reusedFile).toBe(false);
    expect(inProject.asset.file.root).toBe("external");
    const againInProject = await record(png, { projectDir: project, prompt: "other words" });
    expect(againInProject.reusedFile).toBe(true);
    expect(againInProject.filename).toBe(inProject.filename);

    const library = await __assetLibraryForTests();
    expect(library.recordsWithHash(sha256(png))).toHaveLength(5);
  });

  it("never shares a file between an upload and any other asset, which a build that can't read uploads would release", async () => {
    const generated = await record(TINY_MP4, { kind: "video", prompt: "clip" }, "video/mp4");
    const uploaded = await record(TINY_MP4, { ...UPLOAD, kind: "video" }, "video/mp4");
    expect(uploaded.reusedFile).toBe(false);
    expect(uploaded.asset.file).not.toEqual(generated.asset.file);
    // Uploads share with uploads, and other assets with their own kind
    const again = await record(TINY_MP4, { ...UPLOAD, kind: "video" }, "video/mp4");
    expect(again).toMatchObject({ reusedFile: true, filename: uploaded.filename });
    const edited = await record(
      TINY_MP4,
      { kind: "video", origin: "edited", prompt: undefined, producer: { nodeId: "trim-1", nodeType: "videoTrim", operation: "trim" } },
      "video/mp4",
    );
    expect(edited).toMatchObject({ reusedFile: true, filename: generated.filename });

    // The other way round: a generation never takes an upload's file
    const wav = makeWav(0.3);
    const firstUpload = await record(wav, { ...UPLOAD, kind: "audio" }, "audio/wav");
    const sound = await record(wav, { kind: "audio", prompt: "hum" }, "audio/wav");
    expect(sound.reusedFile).toBe(false);
    expect(sound.asset.file).not.toEqual(firstUpload.asset.file);
    for (const result of [generated, uploaded, firstUpload, sound]) {
      expect(fs.existsSync(result.asset.displayPath)).toBe(true);
    }
  });

  it("keeps uploads apart in a project folder too, by record and by the _<md5> name", async () => {
    const project = path.join(base, "P");
    fs.mkdirSync(project);
    const wav = makeWav(0.2);
    const uploaded = await record(wav, { ...UPLOAD, kind: "audio", projectDir: project }, "audio/wav");
    expect(uploaded.asset.file.root).toBe("external");
    const generated = await record(wav, { kind: "audio", projectDir: project }, "audio/wav");
    expect(generated.reusedFile).toBe(false);
    expect(generated.filename).not.toBe(uploaded.filename);

    // A file no record holds is one an older build may import as its own: an upload makes its own copy
    const other = makeWav(0.25);
    const loose = path.join(project, "generations", `old_prompt_${md5(other)}.wav`);
    fs.writeFileSync(loose, other);
    const fromLoose = await record(other, { ...UPLOAD, kind: "audio", projectDir: project }, "audio/wav");
    expect(fromLoose.reusedFile).toBe(false);
    expect(fromLoose.asset.displayPath).not.toBe(loose);
  });

  it("reuses a legacy project file by its _<md5> suffix, but never a truncated one", async () => {
    const project = path.join(base, "Legacy");
    const generations = path.join(project, "generations");
    fs.mkdirSync(generations, { recursive: true });
    const png = makePng(6, 6, 9);
    fs.writeFileSync(path.join(generations, `old_prompt_${md5(png)}.png`), png);
    const reused = await record(png, { projectDir: project });
    expect(reused).toMatchObject({ reusedFile: true, filename: `old_prompt_${md5(png)}.png`, legacyId: `old_prompt_${md5(png)}` });

    const other = makePng(6, 6, 10);
    const truncated = path.join(generations, `a_cat_in_a_hat_${md5(other)}.png`);
    fs.writeFileSync(truncated, other.subarray(0, 10));
    const fresh = await record(other, { projectDir: project });
    expect(fresh.reusedFile).toBe(false);
    expect(fs.readFileSync(truncated).equals(other)).toBe(true);
  });

  it("serialises concurrent recordings of the same bytes", async () => {
    const png = makePng(9, 9, 11);
    const createdAt = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, () => record(png, { createdAt })));
    expect(new Set(results.map((result) => result.asset.id)).size).toBe(6);
    expect(results.filter((result) => !result.reusedFile)).toHaveLength(1);
    const dayDir = path.join(root, "Generations", localDay(createdAt));
    expect(listFiles(dayDir)).toHaveLength(1);
  });
});
