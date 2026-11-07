// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAssetLibraryForTests, beginRecord, completeUpload } from "@/lib/assets/server";
import { installBridge, meta, sha256, streamOf, tempDir, TINY_MP4 } from "@/lib/assets/server/__tests__/helpers";
import { AssetLibrary } from "@/lib/assets/server/library";
import { createClip } from "@/lib/stitch/timeline";
import { emptyEditSequence } from "../document";
import {
  __resetEditsForTests,
  createEdit,
  deleteEdit,
  editConflictOf,
  listEdits,
  patchEdit,
  readEdit,
  revealEdit,
  revealEditsFolder,
  saveEdit,
  trashEditFile,
  type EditsDeps,
} from "../server";
import type { EditDocument, EditSequence, SaveEditRequest } from "../types";

let base: string;
let root: string;
let edits: string;
let bridge: ReturnType<typeof installBridge>;
let now: number;
const deps: EditsDeps = { now: () => now };

beforeEach(async () => {
  base = tempDir("nb-edits-");
  root = path.join(base, "Library");
  edits = path.join(root, "Edits");
  process.env.NODE_BANANA_ASSET_LIBRARY = root;
  bridge = installBridge(path.join(base, "OS Trash"));
  now = 1_000_000;
  __resetEditsForTests();
  await __resetAssetLibraryForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await __resetAssetLibraryForTests();
  bridge.remove();
  delete process.env.NODE_BANANA_ASSET_LIBRARY;
  delete process.env.VERCEL;
  fs.rmSync(base, { recursive: true, force: true });
});

const A = "a0000000000001";
const B = "a0000000000002";

function sequenceOf(...assetIds: string[]): EditSequence {
  return { ...emptyEditSequence(), timeline: assetIds.map((assetId, i) => createClip({ kind: "asset", assetId }, { id: `c${i}` })) };
}

function saveOf(doc: EditDocument, overrides: Partial<SaveEditRequest> = {}): SaveEditRequest {
  return {
    baseUpdatedAt: doc.updatedAt,
    sequence: doc.sequence,
    media: doc.media,
    assets: doc.assets,
    summary: doc.summary,
    renders: doc.renders,
    ...overrides,
  };
}

const files = () => (fs.existsSync(edits) ? fs.readdirSync(edits).sort() : []);
const stored = (fileName: string) => JSON.parse(fs.readFileSync(path.join(edits, fileName), "utf8")) as EditDocument;
const stamp = (fileName: string) => {
  const stat = fs.statSync(path.join(edits, fileName));
  return `${stat.mtimeMs}:${fs.readFileSync(path.join(edits, fileName), "utf8")}`;
};

describe("creating (T-SRV-1, T-SRV-7, T-SRV-14)", () => {
  it("names new edits Untitled edit, then Untitled edit 2, each in its own file", async () => {
    const first = await createEdit({}, deps);
    const second = await createEdit({}, deps);
    expect([first.name, second.name]).toEqual(["Untitled edit", "Untitled edit 2"]);
    expect(first.id).toMatch(/^ed[0-9a-z]{12,32}$/);
    expect(second.id).not.toBe(first.id);
    expect(files()).toEqual(["Untitled edit 2.nbedit", "Untitled edit.nbedit"]);
    expect(stored("Untitled edit.nbedit")).toEqual(first);
    const text = fs.readFileSync(path.join(edits, "Untitled edit.nbedit"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "kind": "node-banana-edit"');
  });

  it("gives two edits created at the same moment their own names and files", async () => {
    const [a, b] = await Promise.all([createEdit({}, deps), createEdit({}, deps)]);
    expect(new Set([a.name, b.name])).toEqual(new Set(["Untitled edit", "Untitled edit 2"]));
    expect(files()).toHaveLength(2);
  });

  it("takes a name, numbered when its file is taken in any case", async () => {
    await createEdit({ name: " Holiday  cut " }, deps);
    expect((await createEdit({ name: "holiday cut" }, deps)).name).toBe("holiday cut 2");
    expect(files()).toEqual(["Holiday cut.nbedit", "holiday cut 2.nbedit"]);
  });

  it("duplicates: a new id, '<name> copy', the sequence and snapshot copied, the renders not", async () => {
    const original = await createEdit({ name: "Trip", sequence: sequenceOf(A), assets: { [A]: { name: "a.mp4", kind: "video", project: null, durationSec: 2 } }, summary: { clipCount: 1, audioClipCount: 0, durationSec: 2, posterAssetId: A } }, deps);
    await patchEdit(original.id, { op: "addRender", render: { assetId: B, renderedAt: 5, durationSec: 2 } }, deps);
    const copy = await createEdit({ from: original.id }, deps);
    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({ name: "Trip copy", sequence: original.sequence, assets: original.assets, renders: [], summary: original.summary });
    expect((await createEdit({ from: original.id }, deps)).name).toBe("Trip copy 2");
  });

  it("saves as a new edit under the next free name", async () => {
    await createEdit({ name: "Trip" }, deps);
    const fresh = await createEdit({ name: "Trip", sequence: sequenceOf(A, B), summary: { clipCount: 9, audioClipCount: 0, durationSec: 4.5, posterAssetId: null } }, deps);
    expect(fresh.name).toBe("Trip 2");
    expect(fresh.sequence.timeline).toHaveLength(2);
    // The counts and poster follow the sequence; the length is the browser's.
    expect(fresh.summary).toEqual({ clipCount: 2, audioClipCount: 0, durationSec: 4.5, posterAssetId: A });
  });

  it("answers 404 for a duplicate of an edit that is gone", async () => {
    await expect(createEdit({ from: "ed0000000000000099" }, deps)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("listing (T-SRV-2, T-SRV-10)", () => {
  async function recordVideo(): Promise<string> {
    const started = await beginRecord({ meta: meta({ kind: "video", prompt: "clip" }), source: { type: "upload" } });
    if ("result" in started) return started.result.asset.id;
    return (await completeUpload(started.ticket.uploadId, streamOf(TINY_MP4), "video/mp4")).asset.id;
  }

  it("lists newest first, with the summary and the poster's library record", async () => {
    const assetId = await recordVideo();
    now = 1_000;
    const older = await createEdit({ name: "Older", sequence: sequenceOf(assetId), summary: { clipCount: 1, audioClipCount: 0, durationSec: 0.6, posterAssetId: assetId } }, deps);
    now = 2_000;
    await createEdit({ name: "Newer" }, deps);
    let list = await listEdits();
    expect(list.folder).toBe(edits);
    expect(list.problems).toEqual([]);
    expect(list.edits.map((edit) => edit.name)).toEqual(["Newer", "Older"]);
    expect(list.edits[1]).toEqual({
      id: older.id,
      name: "Older",
      createdAt: 1_000,
      updatedAt: 1_000,
      clipCount: 1,
      audioClipCount: 0,
      durationSec: 0.6,
      posterAssetId: assetId,
      renderCount: 0,
      fileName: "Older.nbedit",
      poster: { sha256: sha256(TINY_MP4), hasPoster: false },
    });
    expect(list.edits[0].poster).toBeNull();

    now = 3_000;
    await saveEdit(older.id, saveOf(older), deps);
    list = await listEdits();
    expect(list.edits.map((edit) => edit.name)).toEqual(["Older", "Newer"]);
  });

  it("answers an empty list before the Edits folder exists, and creates nothing", async () => {
    expect(await listEdits()).toEqual({ edits: [], problems: [], folder: edits });
    expect(fs.existsSync(edits)).toBe(false);
  });

  it("lists unreadable and newer files as problems and never writes them", async () => {
    const edit = await createEdit({ name: "Fine" }, deps);
    fs.writeFileSync(path.join(edits, "Broken.nbedit"), "{ not json");
    fs.writeFileSync(path.join(edits, "Future.nbedit"), JSON.stringify({ ...edit, id: "ed0000000000000077", name: "From the future", version: 2 }));
    fs.writeFileSync(path.join(edits, "notes.txt"), "not an edit");
    const before = ["Broken.nbedit", "Future.nbedit"].map(stamp);
    const list = await listEdits();
    expect(list.edits.map((e) => e.name)).toEqual(["Fine"]);
    expect(list.problems).toEqual([
      { fileName: "Broken.nbedit", problem: "unreadable", name: null },
      { fileName: "Future.nbedit", problem: "newer", name: "From the future" },
    ]);
    await createEdit({}, deps);
    await saveEdit(edit.id, saveOf(edit), deps);
    expect(["Broken.nbedit", "Future.nbedit"].map(stamp)).toEqual(before);
    await expect(readEdit("ed0000000000000077")).rejects.toMatchObject({ status: 422, code: "newer_version" });
    await expect(saveEdit("ed0000000000000077", saveOf(edit, { force: true }), deps)).rejects.toMatchObject({ status: 422 });
    expect(["Broken.nbedit", "Future.nbedit"].map(stamp)).toEqual(before);
  });
});

describe("saving (T-SRV-3, T-SRV-4, T-SRV-5, T-SRV-14)", () => {
  it("writes with the right base, and updatedAt strictly increases even when the clock steps back", async () => {
    const edit = await createEdit({}, deps);
    now += 10;
    const saved = await saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(A) }), deps);
    expect(saved.updatedAt).toBe(edit.updatedAt + 10);
    expect(saved.createdAt).toBe(edit.createdAt);
    now = 5;
    const again = await saveEdit(edit.id, saveOf(saved), deps);
    expect(again.updatedAt).toBe(saved.updatedAt + 1);
    expect(await readEdit(edit.id)).toEqual(again);
    expect(stored("Untitled edit.nbedit")).toEqual(again);
  });

  it("lets one of two saves sent at once on the same base win, and refuses the other with 409", async () => {
    const edit = await createEdit({}, deps);
    now += 1;
    const results = await Promise.allSettled([
      saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(A) }), deps),
      saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(B) }), deps),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ status: 409, code: "conflict" });
  });

  it("refuses a stale base with 409 and the stored edit, and writes with force", async () => {
    const edit = await createEdit({}, deps);
    now += 1;
    const theirs = await saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(A) }), deps);
    let caught: unknown;
    await saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(B) }), deps).catch((error) => (caught = error));
    expect(caught).toMatchObject({ status: 409, code: "conflict" });
    expect(editConflictOf(caught)).toEqual(theirs);
    expect(stored("Untitled edit.nbedit")).toEqual(theirs);

    now += 1;
    const mine = await saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(B), force: true }), deps);
    expect(mine.sequence.timeline[0].source).toEqual({ kind: "asset", assetId: B });
    expect(mine.updatedAt).toBeGreaterThan(theirs.updatedAt);
  });

  it("keeps a render added in one window when another saves without it; a render keeps updatedAt", async () => {
    const edit = await createEdit({}, deps);
    now += 1;
    const withRender = await patchEdit(edit.id, { op: "addRender", render: { assetId: B, renderedAt: 50, durationSec: 3 } }, deps);
    expect(withRender.document.updatedAt).toBe(edit.updatedAt);
    expect(withRender.previousUpdatedAt).toBe(edit.updatedAt);
    // Window A still has the edit as it opened it, with no renders and the same base.
    const saved = await saveEdit(edit.id, saveOf(edit, { renders: [{ assetId: A, renderedAt: 40, durationSec: null }] }), deps);
    expect(saved.renders).toEqual([
      { assetId: A, renderedAt: 40, durationSec: null },
      { assetId: B, renderedAt: 50, durationSec: 3 },
    ]);
    const twice = await patchEdit(edit.id, { op: "addRender", render: { assetId: B, renderedAt: 60, durationSec: 3 } }, deps);
    expect(twice.document.renders).toHaveLength(2);
  });

  it("answers 404 for an edit with no file, with and without force", async () => {
    const edit = await createEdit({}, deps);
    fs.rmSync(path.join(edits, "Untitled edit.nbedit"));
    await expect(saveEdit(edit.id, saveOf(edit), deps)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(saveEdit(edit.id, saveOf(edit, { force: true }), deps)).rejects.toMatchObject({ status: 404 });
    expect(files()).toEqual([]);
  });
});

describe("renaming (T-SRV-6)", () => {
  it("renames the file, also when only the case changes", async () => {
    const edit = await createEdit({ name: "Trip" }, deps);
    now += 1;
    const renamed = await patchEdit(edit.id, { op: "rename", name: "Summer: trip" }, deps);
    expect(renamed.previousUpdatedAt).toBe(edit.updatedAt);
    expect(renamed.document).toMatchObject({ name: "Summer: trip", updatedAt: edit.updatedAt + 1 });
    expect(files()).toEqual(["Summer trip.nbedit"]);
    now += 1;
    await patchEdit(edit.id, { op: "rename", name: "summer: TRIP" }, deps);
    expect(files()).toEqual(["summer TRIP.nbedit"]);
    expect(stored("summer TRIP.nbedit").name).toBe("summer: TRIP");
  });

  it("refuses a name another edit's file has, in any case", async () => {
    await createEdit({ name: "Taken" }, deps);
    const edit = await createEdit({ name: "Mine" }, deps);
    await expect(patchEdit(edit.id, { op: "rename", name: "taken" }, deps)).rejects.toMatchObject({ status: 409, code: "name_taken" });
    expect(files()).toEqual(["Mine.nbedit", "Taken.nbedit"]);
  });

  it("names the file again at the next save when a rename stopped before the file moved", async () => {
    const edit = await createEdit({ name: "Before" }, deps);
    const file = path.join(edits, "Before.nbedit");
    const interrupted = { ...stored("Before.nbedit"), name: "After", updatedAt: edit.updatedAt + 1 };
    fs.writeFileSync(file, JSON.stringify(interrupted));
    __resetEditsForTests();
    now += 5;
    await saveEdit(edit.id, saveOf(interrupted), deps);
    expect(files()).toEqual(["After.nbedit"]);
  });
});

describe("deleting and revealing (T-SRV-8, T-SRV-9)", () => {
  it("sends the file to the trash, then answers 404", async () => {
    const edit = await createEdit({ name: "Gone soon" }, deps);
    const trashed: string[] = [];
    await deleteEdit(edit.id, {
      trash: async (file) => {
        trashed.push(file);
        fs.rmSync(file);
      },
    });
    expect(trashed).toEqual([path.join(edits, "Gone soon.nbedit")]);
    await expect(readEdit(edit.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteEdit(edit.id, { trash: async () => {} })).rejects.toMatchObject({ status: 404 });
  });

  it("uses the OS trash by default", async () => {
    const edit = await createEdit({ name: "Binned" }, deps);
    await deleteEdit(edit.id);
    expect(bridge.calls).toContainEqual({ type: "trash", path: path.join(edits, "Binned.nbedit") });
    expect(files()).toEqual([]);
  });

  it("keeps the file when no trash route moves it, never unlinking it", async () => {
    const edit = await createEdit({ name: "Trip" }, deps);
    const file = path.join(edits, "Trip.nbedit");
    const missing = Object.assign(new Error("spawn gio ENOENT"), { code: "ENOENT" });
    const commands: string[] = [];
    const linux = { platform: "linux" as const, bridge: null, exec: async (command: string) => {
      commands.push(command);
      throw missing;
    } };
    await expect(deleteEdit(edit.id, { trash: (f) => trashEditFile(f, linux) })).rejects.toMatchObject({
      status: 500,
      code: "trash_failed",
    });
    expect(commands).toEqual(["gio"]);
    expect(fs.existsSync(file)).toBe(true);
    expect((await readEdit(edit.id)).name).toBe("Trip");

    const refused = Object.assign(new Error("Not authorized to send Apple events to Finder. (-1743)"), { code: 1 });
    const mac = { platform: "darwin" as const, bridge: null, exec: async (command: string) => {
      throw command === "/usr/bin/trash" ? missing : refused;
    } };
    await expect(trashEditFile(file, mac)).rejects.toMatchObject({ code: "trash_failed" });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("reveals the edit's file, and opens the Edits folder, creating it when missing", async () => {
    const opened: string[] = [];
    await revealEditsFolder({ openFolder: async (dir) => void opened.push(dir) });
    expect(opened).toEqual([edits]);
    expect(fs.statSync(edits).isDirectory()).toBe(true);

    const edit = await createEdit({}, deps);
    const revealed: string[] = [];
    await revealEdit(edit.id, { reveal: async (file) => void revealed.push(file) });
    expect(revealed).toEqual([path.join(edits, "Untitled edit.nbedit")]);
  });
});

describe("copies made outside the app (T-SRV-11)", () => {
  it("lists a copy as a duplicate without writing, and makes it a separate edit on request", async () => {
    const edit = await createEdit({ name: "Trip" }, deps);
    const copy = path.join(edits, "Trip copy.nbedit");
    fs.copyFileSync(path.join(edits, "Trip.nbedit"), copy);
    // Copied later, but also as Finder does it: the same modified time.
    const original = fs.statSync(path.join(edits, "Trip.nbedit"));
    fs.utimesSync(copy, original.atime, original.mtime);
    const before = ["Trip.nbedit", "Trip copy.nbedit"].map(stamp);

    const list = await listEdits();
    expect(list.edits.map((e) => [e.name, e.fileName])).toEqual([["Trip", "Trip.nbedit"]]);
    expect(list.problems).toEqual([{ fileName: "Trip copy.nbedit", problem: "duplicate", name: "Trip" }]);
    expect(["Trip.nbedit", "Trip copy.nbedit"].map(stamp)).toEqual(before);

    // Saving the edit writes its own file, and it stays the edit.
    now += 1;
    await saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(A) }), deps);
    expect(stamp("Trip copy.nbedit")).toBe(before[1]);
    expect((await listEdits()).edits.map((e) => e.fileName)).toEqual(["Trip.nbedit"]);

    now += 1;
    const separate = await createEdit({ separate: "Trip copy.nbedit" }, deps);
    expect(separate.id).not.toBe(edit.id);
    expect(separate.name).toBe("Trip copy");
    const after = await listEdits();
    expect(after.problems).toEqual([]);
    expect(after.edits.map((e) => [e.name, e.fileName])).toEqual([
      ["Trip copy", "Trip copy.nbedit"],
      ["Trip", "Trip.nbedit"],
    ]);

    await expect(createEdit({ separate: "Trip copy.nbedit" }, deps)).rejects.toMatchObject({ status: 409, code: "not_duplicate" });
  });

  it("refuses a separate request that names anything but one edit file", async () => {
    for (const separate of ["../x.nbedit", "x.json", ".hidden.nbedit"]) {
      await expect(createEdit({ separate }, deps)).rejects.toMatchObject({ status: 400 });
    }
    await expect(createEdit({ separate: "x.nbedit", name: "y" }, deps)).rejects.toMatchObject({ status: 400 });
  });
});

describe("refusals (T-SRV-12, T-SRV-13)", () => {
  it("refuses media in a body, an edit too large to save, and a bad id", async () => {
    const edit = await createEdit({}, deps);
    const media = { ...sequenceOf(A), timeline: [{ ...sequenceOf(A).timeline[0], note: "data:video/mp4;base64,AAAA" }] };
    await expect(saveEdit(edit.id, saveOf(edit, { sequence: media }), deps)).rejects.toMatchObject({ status: 400, message: "Edits hold media by library id only." });
    await expect(createEdit({ name: "blob:http://localhost:3417/1234" }, deps)).rejects.toMatchObject({ status: 400 });

    const huge = sequenceOf(...Array.from({ length: 8000 }, () => A));
    await expect(saveEdit(edit.id, saveOf(edit, { sequence: huge }), deps)).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(stored("Untitled edit.nbedit")).toEqual(edit);

    for (const id of ["folder", "ed", "../x", "EDXXXXXXXXXXXXXX"]) {
      await expect(readEdit(id)).rejects.toMatchObject({ status: 400 });
      await expect(saveEdit(id, saveOf(edit), deps)).rejects.toMatchObject({ status: 400 });
    }
    await expect(saveEdit(edit.id, { ...saveOf(edit), baseUpdatedAt: "now" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(patchEdit(edit.id, { op: "rename" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(patchEdit(edit.id, { op: "addRender", render: { assetId: "../x", renderedAt: 1 } }, deps)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses writes with paused while a move copies the library, and reads carry on", async () => {
    const edit = await createEdit({}, deps);
    const rt = (globalThis as { __nodeBananaAssetLibrary?: { paused: boolean } }).__nodeBananaAssetLibrary!;
    rt.paused = true;
    try {
      const paused = { status: 503, code: "paused", retryAfter: expect.any(Number) };
      await expect(saveEdit(edit.id, saveOf(edit), deps)).rejects.toMatchObject(paused);
      await expect(createEdit({}, deps)).rejects.toMatchObject(paused);
      await expect(patchEdit(edit.id, { op: "rename", name: "x" }, deps)).rejects.toMatchObject(paused);
      await expect(revealEditsFolder({ openFolder: async () => {} })).rejects.toMatchObject(paused);
      expect((await listEdits()).edits).toHaveLength(1);
    } finally {
      rt.paused = false;
    }
  });

  it("answers 503 unavailable without a library", async () => {
    process.env.VERCEL = "1";
    await expect(listEdits()).rejects.toMatchObject({ status: 503, code: "unavailable" });
    await expect(createEdit({}, deps)).rejects.toMatchObject({ status: 503, code: "unavailable" });
  });
});

describe("media (T-SRV-16)", () => {
  const C = "a0000000000003";
  const snapshot = (name: string) => ({ name, kind: "video" as const, project: null, durationSec: 2 });

  it("starts a new edit with no media, and saves as a new edit with the media sent", async () => {
    expect((await createEdit({}, deps)).media).toEqual([]);
    const fresh = await createEdit(
      { name: "Trip", sequence: sequenceOf(A), media: [C, "../x", A, C], assets: { [A]: snapshot("a.mp4"), [C]: snapshot("c.mp4") } },
      deps,
    );
    expect(fresh.media).toEqual([C, A]);
    expect(fresh.assets).toEqual({ [C]: snapshot("c.mp4"), [A]: snapshot("a.mp4") });
    expect(stored("Trip.nbedit").media).toEqual([C, A]);
    expect((await createEdit({ name: "Older", sequence: sequenceOf(B, A) }, deps)).media).toEqual([B, A]);
  });

  it("duplicates the media, the media the timeline does not use and its snapshot included", async () => {
    const original = await createEdit({ name: "Trip", sequence: sequenceOf(A), media: [A, C], assets: { [C]: snapshot("c.mp4") } }, deps);
    const copy = await createEdit({ from: original.id }, deps);
    expect(copy.media).toEqual([A, C]);
    expect(copy.assets).toEqual({ [C]: snapshot("c.mp4") });
    await expect(createEdit({ from: original.id, media: [C] }, deps)).rejects.toMatchObject({
      status: 400,
      message: "Send from or media, not both.",
    });
  });

  it("saves the media sent, appending the sequence's assets it lacks and dropping ids that are not asset ids", async () => {
    const edit = await createEdit({}, deps);
    now += 1;
    const saved = await saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(A, B), media: [C, "aclip", B], assets: { [C]: snapshot("c.mp4") } }), deps);
    expect(saved.media).toEqual([C, B, A]);
    expect(saved.assets).toEqual({ [C]: snapshot("c.mp4") });
    expect(stored("Untitled edit.nbedit")).toEqual(saved);
    expect(await readEdit(edit.id)).toEqual(saved);
  });

  it("keeps the stored media when a save sends none", async () => {
    const edit = await createEdit({ sequence: sequenceOf(A), media: [C, A] }, deps);
    now += 1;
    const request: Record<string, unknown> = { ...saveOf(edit, { sequence: sequenceOf(B) }) };
    delete request.media;
    expect((await saveEdit(edit.id, request, deps)).media).toEqual([C, A, B]);
  });

  it("refuses media that is not a list of strings", async () => {
    const edit = await createEdit({}, deps);
    for (const media of ["a0000000000001", { [A]: true }, [A, 7], null]) {
      await expect(saveEdit(edit.id, { ...saveOf(edit), media }, deps)).rejects.toMatchObject({ status: 400, message: "Invalid media." });
      await expect(createEdit({ sequence: sequenceOf(A), media }, deps)).rejects.toMatchObject({ status: 400, message: "Invalid media." });
    }
    expect(stored("Untitled edit.nbedit")).toEqual(edit);
  });
});

describe("the library's first scan (T-SRV-15)", () => {
  it("holds a save until the scan is done", async () => {
    const edit = await createEdit({}, deps);
    await __resetAssetLibraryForTests();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = AssetLibrary.prototype.ensureLoaded;
    vi.spyOn(AssetLibrary.prototype, "ensureLoaded").mockImplementation(function (this: AssetLibrary) {
      return held.then(() => scan.call(this));
    });
    now += 1;
    let settled = false;
    const saving = saveEdit(edit.id, saveOf(edit, { sequence: sequenceOf(A) }), deps).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(stored("Untitled edit.nbedit")).toEqual(edit);
    release();
    const saved = await saving;
    expect(stored("Untitled edit.nbedit")).toEqual(saved);
  });
});
