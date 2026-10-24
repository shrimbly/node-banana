// @vitest-environment node
/**
 * The Node Banana folder's projects through the facade: the registry a page
 * load reports into, adopting the old workflows folder, bringing projects
 * in (use, move, leave), the projects move job, the auto-index, the offer
 * and new-project folder names.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryJobStatus, RecordAssetMeta, RecordAssetResult } from "../../types";
import {
  __assetLibraryForTests,
  __drainAssetLibraryForTests,
  __resetAssetLibraryForTests,
  beginRecord,
  bringInProjects,
  completeUpload,
  getAsset,
  getJob,
  getLibraryStatus,
  getProjectFolderName,
  listAssets,
  listProjects,
  reportProjects,
  setLibraryRoot,
  setProjectsOffer,
  upsertWorkflowEntry,
} from "../index";
import type { JobContext } from "../jobs";
import { PROJECT_MOVE_MARKER, recoverProjectMove, runProjectsMove } from "../projectMove";
import { ProjectRegistry, readRegistry } from "../registry";
import { installBridge, makePng, meta, sha256, streamOf, tempDir } from "./helpers";

let base: string;
let home: string;
let defaultRoot: string;
let registryFile: string;
let bridge: ReturnType<typeof installBridge>;

beforeEach(async () => {
  base = tempDir("nb-folder-");
  home = path.join(base, "home");
  fs.mkdirSync(home);
  defaultRoot = path.join(home, "Documents", "Node Banana");
  registryFile = path.join(home, ".node-banana", "projects.json");
  bridge = installBridge(path.join(base, "OS Trash"));
  delete process.env.NODE_BANANA_ASSET_LIBRARY;
  // No env override: the default root under a fake home, so it can be switched and moved.
  await __resetAssetLibraryForTests({ pathContext: { platform: process.platform, env: {}, homedir: home } });
});

afterEach(async () => {
  await __resetAssetLibraryForTests();
  bridge.remove();
  fs.rmSync(base, { recursive: true, force: true });
});

let seed = 900;

async function record(overrides: Partial<RecordAssetMeta> = {}): Promise<RecordAssetResult> {
  const started = await beginRecord({ meta: meta(overrides), source: { type: "upload" } });
  if ("result" in started) return started.result;
  return completeUpload(started.ticket.uploadId, streamOf(makePng(4, 4, seed++)), null);
}

async function finished(job: LibraryJobStatus | null): Promise<LibraryJobStatus> {
  expect(job).not.toBeNull();
  await __drainAssetLibraryForTests();
  return getJob(job!.id)!;
}

function workflowJson(name: string): string {
  return JSON.stringify({ version: 1, id: `wf_${name.replace(/\W/g, "")}`, name, nodes: [], edges: [], edgeStyle: "curved" });
}

/** A saved project: its workflow file and, when asked, media in generations/. */
function project(dir: string, name: string, media = 0): string {
  fs.mkdirSync(path.join(dir, "generations"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), workflowJson(name));
  for (let i = 0; i < media; i++) fs.writeFileSync(path.join(dir, "generations", `old_${i}.png`), makePng(3, 3, 50 + i));
  return dir;
}

describe("the projects move", () => {
  it("moves a project in, and the library, workflow rows, snapshot references and registry follow", async () => {
    await getLibraryStatus();
    const source = project(path.join(base, "Elsewhere", "Cats"), "Cats");
    fs.mkdirSync(path.join(source, "inputs", "deep"), { recursive: true });
    fs.writeFileSync(path.join(source, "inputs", "deep", "ref.txt"), "reference");
    const recorded = await record({ projectDir: source, workflowId: "wf_cats", workflowName: "Cats" });
    await upsertWorkflowEntry("wf_cats", { name: "Cats", projectPath: source });
    const file = path.join(source, "generations", recorded.filename);
    expect(fs.existsSync(file)).toBe(true);
    const library = await __assetLibraryForTests();
    const bytes = fs.readFileSync(file);
    await library.runs.retainReference(sha256(bytes), file, bytes.length);

    const job = await finished((await bringInProjects({ dirs: [source], mode: "move" })).job);
    const dest = path.join(defaultRoot, "Cats");
    expect(job).toMatchObject({ type: "projects", state: "done", moved: [{ from: source, to: dest }] });
    expect(job.message).toBe("Moved 1 project into Node Banana.");
    expect(job.total).toBe(3);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(dest, "inputs", "deep", "ref.txt"), "utf8")).toBe("reference");

    const asset = await getAsset(recorded.asset.id);
    expect(asset?.file).toEqual({ root: "external", path: path.join(dest, "generations", recorded.filename) });
    expect(asset?.missing).toBeFalsy();
    expect(library.getWorkflow("wf_cats")?.projectPath).toBe(dest);
    expect(await library.runs.referencedFile(sha256(bytes))).toMatchObject({ path: path.join(dest, "generations", recorded.filename) });
    expect((await readRegistry(registryFile)).projects.map((entry) => entry.dir)).toEqual([dest]);

    // Listed as a project of the Node Banana folder now
    const overview = await listProjects();
    expect(overview.projects).toMatchObject([{ dir: dest, name: "Cats", relativePath: "Cats", inRoot: true }]);
    expect(overview.elsewhere).toBeNull();
    expect(overview.rootBytes).toBeGreaterThan(bytes.length);
  });

  it("numbers past a taken name, and moves a nested project with its parent", async () => {
    await getLibraryStatus();
    fs.mkdirSync(path.join(defaultRoot, "project"), { recursive: true });
    const parent = project(path.join(base, "Old", "Project"), "Project");
    const nested = project(path.join(parent, "Nested"), "Nested");
    const other = project(path.join(base, "Other", "Project"), "Project");

    const job = await finished((await bringInProjects({ dirs: [nested, parent, other], mode: "move" })).job);
    expect(job.state).toBe("done");
    expect(job.moved?.map((moved) => [moved.from, path.basename(moved.to)])).toEqual([
      [parent, "Project 2"],
      [other, "Project 3"],
    ]);
    expect(fs.existsSync(path.join(defaultRoot, "Project 2", "Nested", "Nested.json"))).toBe(true);
    expect(job.message).toBe("Moved 2 projects into Node Banana.");
  });

  it("refuses a folder that holds the Node Banana folder, and has nothing to do for one inside it", async () => {
    await getLibraryStatus();
    await expect(bringInProjects({ dirs: [home], mode: "move" })).rejects.toMatchObject({ status: 400 });
    const inside = project(path.join(defaultRoot, "Here"), "Here");
    await expect(bringInProjects({ dirs: [inside], mode: "move" })).rejects.toMatchObject({ status: 400 });
    await expect(bringInProjects({ dirs: [path.join(base, "nope")], mode: "move" })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a personal folder, or one holding more than a project, and leaves it alone", async () => {
    await getLibraryStatus();
    const downloads = project(path.join(home, "Downloads"), "Loose");
    await expect(bringInProjects({ dirs: [downloads], mode: "move" })).rejects.toMatchObject({ status: 400 });
    const mixed = project(path.join(base, "Mixed"), "Mixed");
    fs.writeFileSync(path.join(mixed, "taxes.pdf"), "private");
    await expect(bringInProjects({ dirs: [mixed], mode: "move" })).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(path.join(downloads, "Loose.json"))).toBe(true);
    expect(fs.existsSync(path.join(mixed, "taxes.pdf"))).toBe(true);
  });

  it("stops between files when cancelled, removing only the project it was copying", async () => {
    await getLibraryStatus();
    const library = await __assetLibraryForTests();
    const first = project(path.join(base, "A", "First"), "First", 2);
    const second = project(path.join(base, "A", "Second"), "Second", 3);
    let steps = 0;
    const status: Partial<LibraryJobStatus> = {};
    const ctx: JobContext = {
      signal: new AbortController().signal,
      update: (patch) => Object.assign(status, patch),
      addBytes: () => {},
      step: () => {
        steps++;
      },
      checkCancelled: () => {
        // First has 3 files; stop two files into Second.
        if (steps >= 5) throw Object.assign(new Error("Cancelled"), { code: "cancelled" });
      },
    };
    const registry = new ProjectRegistry(registryFile);
    await expect(runProjectsMove(ctx, { library, root: defaultRoot, registry }, [first, second])).rejects.toThrow("Cancelled");
    expect(status.moved).toEqual([{ from: first, to: path.join(defaultRoot, "First") }]);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.readdirSync(path.join(defaultRoot, "First", "generations"))).toHaveLength(2);
    expect(fs.existsSync(path.join(defaultRoot, "Second"))).toBe(false);
    expect(fs.readdirSync(path.join(second, "generations"))).toHaveLength(3);
  });

  function quietCtx(status: Partial<LibraryJobStatus> = {}): JobContext {
    return {
      signal: new AbortController().signal,
      update: (patch) => Object.assign(status, patch),
      addBytes: () => {},
      step: () => {},
      checkCancelled: () => {},
    };
  }

  it("keeps the files' and folders' times, so Open keeps its order", async () => {
    await getLibraryStatus();
    const source = project(path.join(base, "Old", "Dated"), "Dated", 1);
    const when = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
    fs.utimesSync(path.join(source, "Dated.json"), when, when);
    fs.utimesSync(path.join(source, "generations"), when, when);
    const job = await finished((await bringInProjects({ dirs: [source], mode: "move" })).job);
    expect(job.state).toBe("done");
    const dest = path.join(defaultRoot, "Dated");
    expect(fs.statSync(path.join(dest, "Dated.json")).mtimeMs).toBe(when.getTime());
    expect(fs.statSync(path.join(dest, "generations")).mtimeMs).toBe(when.getTime());
  });

  it("copies a file saved at the same size just before the source goes", async () => {
    await getLibraryStatus();
    const library = await __assetLibraryForTests();
    const source = project(path.join(base, "Old", "Busy"), "Busy");
    fs.mkdirSync(path.join(source, "inputs"));
    const note = path.join(source, "inputs", "note.txt");
    fs.writeFileSync(note, "aaaa");
    const registry = new ProjectRegistry(registryFile);
    const relocate = registry.relocate.bind(registry);
    vi.spyOn(registry, "relocate").mockImplementation(async (from, to) => {
      // A save lands while the library follows the copy: same size, later time.
      fs.writeFileSync(note, "bbbb");
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(note, later, later);
      await relocate(from, to);
    });
    await runProjectsMove(quietCtx(), { library, root: defaultRoot, registry }, [source]);
    expect(fs.readFileSync(path.join(defaultRoot, "Busy", "inputs", "note.txt"), "utf8")).toBe("bbbb");
    expect(fs.existsSync(source)).toBe(false);
  });

  it("puts everything back when the library can't follow the copy", async () => {
    await getLibraryStatus();
    const library = await __assetLibraryForTests();
    const source = project(path.join(base, "Old", "Paused"), "Paused", 1);
    const recorded = await record({ projectDir: source, workflowId: "wf_paused", workflowName: "Paused" });
    const registry = new ProjectRegistry(registryFile);
    await registry.add([{ dir: source }]);
    vi.spyOn(registry, "relocate").mockRejectedValueOnce(new Error("paused"));
    await expect(runProjectsMove(quietCtx(), { library, root: defaultRoot, registry }, [source])).rejects.toThrow("paused");
    expect(fs.existsSync(path.join(defaultRoot, "Paused"))).toBe(false);
    expect(fs.existsSync(path.join(source, "Paused.json"))).toBe(true);
    expect((await getAsset(recorded.asset.id))?.file).toEqual({ root: "external", path: path.join(source, "generations", recorded.filename) });
    expect((await readRegistry(registryFile)).projects.map((entry) => entry.dir)).toEqual([source]);
    expect(fs.existsSync(path.join(defaultRoot, ".nodebanana", PROJECT_MOVE_MARKER))).toBe(false);
  });

  // The status call starts the root's initialisation in the background and
  // answers before it ends. Its recovery step, finding no marker, removes the
  // marker path (force) with an async rm; a marker written in that window
  // went with it on CI's Linux runners, and the half copy was listed. So the
  // initialisation is waited for before the marker goes down.
  it("never lists a copy quitting cut short, and removes it at the next start", async () => {
    await getLibraryStatus();
    await __drainAssetLibraryForTests();
    const source = project(path.join(base, "Old", "Half"), "Half", 2);
    const dest = project(path.join(defaultRoot, "Half"), "Half", 1);
    const marker = path.join(defaultRoot, ".nodebanana", PROJECT_MOVE_MARKER);
    fs.writeFileSync(marker, JSON.stringify({ from: source, dest, phase: "copying" }));
    const listed = (await listProjects()).projects.map((known) => known.dir);
    expect(listed).not.toContain(dest);

    await recoverProjectMove(defaultRoot);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readdirSync(path.join(source, "generations"))).toHaveLength(2);
  });

  it("keeps a copy the library already follows", async () => {
    await getLibraryStatus();
    const source = project(path.join(base, "Old", "Kept"), "Kept");
    const dest = project(path.join(defaultRoot, "Kept"), "Kept");
    const marker = path.join(defaultRoot, ".nodebanana", PROJECT_MOVE_MARKER);
    fs.writeFileSync(marker, JSON.stringify({ from: source, dest, phase: "relocated" }));
    await recoverProjectMove(defaultRoot);
    expect(fs.existsSync(path.join(dest, "Kept.json"))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the copy and says so when the old folder can't be removed",
    async () => {
      await getLibraryStatus();
      const parent = path.join(base, "Locked");
      const source = project(path.join(parent, "Stuck"), "Stuck", 1);
      fs.chmodSync(source, 0o555);
      fs.chmodSync(path.join(source, "generations"), 0o555);
      try {
        const job = await finished((await bringInProjects({ dirs: [source], mode: "move" })).job);
        expect(job.state).toBe("done");
        expect(job.moved).toEqual([{ from: source, to: path.join(defaultRoot, "Stuck"), leftovers: true }]);
        expect(job.message).toContain("could not be removed");
        expect(fs.existsSync(path.join(defaultRoot, "Stuck", "generations", "old_0.png"))).toBe(true);
      } finally {
        fs.chmodSync(path.join(source, "generations"), 0o755);
        fs.chmodSync(source, 0o755);
      }
    },
  );
});

describe("reportProjects", () => {
  it("adds the page's projects to the registry", async () => {
    const a = project(path.join(base, "Saved", "A"), "A");
    const result = await reportProjects({ projects: [{ dir: a, name: "A", lastOpenedAt: 5 }] });
    expect(result).toEqual({ adopted: false, root: defaultRoot });
    expect((await readRegistry(registryFile)).projects).toMatchObject([{ dir: a, name: "A", lastOpenedAt: 5 }]);
    // Nothing recorded and no workflows folder: the other build's page may still have one
    expect((await readRegistry(registryFile)).adoption.done).toBe(false);
  });

  it("makes the old workflows folder the Node Banana folder when nothing is saved yet", async () => {
    const workflows = path.join(base, "My Workflows");
    project(path.join(workflows, "One"), "One");
    const result = await reportProjects({ workflowsDir: workflows, projects: [] });
    expect(result).toEqual({ adopted: true, root: workflows });
    expect(await getLibraryStatus()).toMatchObject({ root: workflows, source: "config" });
    expect((await readRegistry(registryFile)).adoption.done).toBe(true);

    // Once only
    const again = await reportProjects({ workflowsDir: path.join(base, "Elsewhere"), projects: [] });
    expect(again).toEqual({ adopted: false, root: workflows });
  });

  it("moves the library into the old workflows folder when it already holds assets", async () => {
    await record();
    const workflows = path.join(base, "Workflows");
    fs.mkdirSync(workflows);
    const result = await reportProjects({ workflowsDir: workflows, projects: [] });
    expect(result.adopted).toBe(true);
    await __drainAssetLibraryForTests();
    const status = await getLibraryStatus();
    expect(status).toMatchObject({ root: workflows, counts: { assets: 1 } });
    expect(status.job).toMatchObject({ type: "move", state: "done" });
  });

  it("gives up adopting once the library holds assets and no workflows folder came", async () => {
    await record();
    await reportProjects({ projects: [] });
    expect((await readRegistry(registryFile)).adoption.done).toBe(true);
  });

  it("leaves a root the user chose alone", async () => {
    const chosen = path.join(base, "Chosen");
    fs.mkdirSync(chosen);
    await bringInProjects({ dirs: [], mode: "use", folder: chosen });
    const workflows = path.join(base, "Workflows");
    fs.mkdirSync(workflows);
    expect(await reportProjects({ workflowsDir: workflows, projects: [] })).toEqual({ adopted: false, root: chosen });
  });
});

describe("moving everything to another folder", () => {
  it("moves the old folder's projects after the library, in the same job", async () => {
    await record();
    const fox = project(path.join(defaultRoot, "Fox"), "Fox", 1);
    const target = path.join(base, "New Home");
    const status = await setLibraryRoot({ root: target, mode: "move", projects: [fox, path.join(defaultRoot, "Gone")] });
    const job = await finished(status.job);
    expect(job).toMatchObject({ type: "move", state: "done", moved: [{ from: fox, to: path.join(target, "Fox") }] });
    expect(job.message).toContain("Moved 1 project into New Home.");
    expect(fs.existsSync(fox)).toBe(false);
    expect(fs.existsSync(path.join(target, "Fox", "generations", "old_0.png"))).toBe(true);
    expect(await getLibraryStatus()).toMatchObject({ root: target, counts: { assets: 1 } });
  });
});

describe("bringing projects in", () => {
  it("use: switches to the folder when nothing is saved yet, and lists its projects", async () => {
    const folder = path.join(base, "Existing");
    const one = project(path.join(folder, "One"), "One", 1);
    const result = await bringInProjects({ dirs: [one], mode: "use", folder });
    expect(result).toEqual({ root: folder, job: null });
    await __drainAssetLibraryForTests();
    const overview = await listProjects();
    expect(overview.root).toBe(folder);
    expect(overview.projects).toMatchObject([{ dir: one, relativePath: "One", inRoot: true, mediaCount: 1 }]);
    // The auto-index took in its generations
    expect((await listAssets({})).total).toBe(1);
  });

  it("use: moves the library there when it holds assets", async () => {
    await record();
    const folder = path.join(base, "Existing");
    fs.mkdirSync(folder);
    const result = await bringInProjects({ dirs: [], mode: "use", folder });
    expect(result.job).toMatchObject({ type: "move" });
    await __drainAssetLibraryForTests();
    expect(await getLibraryStatus()).toMatchObject({ root: folder, counts: { assets: 1 } });
  });

  it("leave: lists the projects where they are and indexes their generations once", async () => {
    const kept = project(path.join(base, "Kept", "Kept"), "Kept", 2);
    expect(await bringInProjects({ dirs: [kept], mode: "leave" })).toEqual({ root: defaultRoot, job: null });
    await __drainAssetLibraryForTests();
    expect((await listAssets({})).total).toBe(2);
    const entry = (await readRegistry(registryFile)).projects[0];
    expect(entry).toMatchObject({ dir: kept });
    expect(entry.indexedStamp).toMatch(/^\d+:2$/);
    // The auto-index job is the app's own: the library status never shows it
    expect((await getLibraryStatus()).job).toBeNull();

    const overview = await listProjects();
    expect(overview.projects).toMatchObject([{ dir: kept, inRoot: false, relativePath: null, mediaCount: 2 }]);
    expect(overview.elsewhere).toMatchObject({ count: 1, groups: [{ label: "../Kept".replace("..", path.join(base)), count: 1 }] });

    // Nothing changed: reporting it again starts no job
    await reportProjects({ projects: [{ dir: kept }] });
    await __drainAssetLibraryForTests();
    expect((await listAssets({})).total).toBe(2);
  });
});

describe("the offer and folder names", () => {
  it("summarises projects elsewhere until the offer is dismissed", async () => {
    const one = project(path.join(home, "Old", "One"), "One");
    const two = project(path.join(home, "Old", "Two"), "Two");
    fs.writeFileSync(path.join(two, "generations", "big.bin"), Buffer.alloc(2048));
    await reportProjects({ projects: [{ dir: one }, { dir: two }] });
    const overview = await listProjects();
    expect(overview.offerDismissed).toBe(false);
    expect(overview.elsewhere).toMatchObject({ count: 2, groups: [{ label: "~/Old", count: 2 }] });
    expect(overview.elsewhere!.bytes).toBeGreaterThan(2048);

    await setProjectsOffer({ dismissed: true });
    expect((await listProjects()).offerDismissed).toBe(true);
  });

  it("names a new project's folder in the Node Banana folder", async () => {
    await getLibraryStatus();
    fs.mkdirSync(path.join(defaultRoot, "Cats"), { recursive: true });
    expect(await getProjectFolderName("Cats")).toEqual({ folder: "Cats 2", path: path.join(defaultRoot, "Cats 2"), taken: true });
    expect(await getProjectFolderName("A/B: c")).toEqual({ folder: "A B c", path: path.join(defaultRoot, "A B c"), taken: false });
  });
});
