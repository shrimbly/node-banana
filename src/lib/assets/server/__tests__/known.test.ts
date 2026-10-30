// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  folderBytes,
  generationsStamp,
  holdsOnlyProjectContent,
  isPersonalFolder,
  listKnownProjects,
  looksLikeProjectsFolder,
  outermost,
  projectFolderName,
  sanitiseFolderName,
  shortenHome,
  summariseElsewhere,
  uniqueFolderName,
} from "../known";
import type { KnownProject } from "../../types";
import { isWorkflowFile } from "../projects";
import { makePng, tempDir } from "./helpers";

let base: string;
let root: string;

beforeEach(() => {
  base = tempDir("nb-known-");
  root = path.join(base, "Node Banana");
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function workflow(name: string | null): string {
  return JSON.stringify({ version: 1, id: "wf_1", ...(name === null ? {} : { name }), nodes: [], edges: [], edgeStyle: "curved" });
}

function setMtime(file: string, ms: number): void {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

/** A project folder: a workflow file (unless `name` is undefined) and `media` in generations/. */
function project(dir: string, options: { name?: string | null; media?: number; mtime?: number } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  if (options.name !== undefined) {
    const file = path.join(dir, "workflow.json");
    fs.writeFileSync(file, workflow(options.name));
    if (options.mtime) setMtime(file, options.mtime);
  }
  if (options.media !== undefined) {
    fs.mkdirSync(path.join(dir, "generations"), { recursive: true });
    for (let i = 0; i < options.media; i++) fs.writeFileSync(path.join(dir, "generations", `g${i}.png`), makePng(2, 2, i));
  }
  return dir;
}

function input(overrides: Partial<Parameters<typeof listKnownProjects>[0]> = {}) {
  return {
    root,
    exclude: [path.join(root, "Generations"), path.join(root, ".nodebanana")],
    registryDirs: [],
    workflowDirs: [],
    ...overrides,
  };
}

describe("listKnownProjects", () => {
  it("lists the Node Banana folder's projects: a workflow file or a generations folder, media or not", async () => {
    project(path.join(root, "Cats"), { name: "Cat shots", mtime: 3_000 });
    project(path.join(root, "Only generations"), { media: 0 });
    project(path.join(root, "Group", "Nested"), { name: null, media: 2, mtime: 2_000 });
    fs.mkdirSync(path.join(root, "Just a folder"));
    fs.writeFileSync(path.join(root, "Just a folder", "data.json"), JSON.stringify({ rows: [] }));
    // The library's own folders are never projects
    project(path.join(root, "Generations", "2026-09-27"), { name: "Not one", media: 1 });
    fs.writeFileSync(path.join(root, "loose.json"), workflow("Loose"));

    const projects = await listKnownProjects(input());
    expect(projects).toHaveLength(3);
    expect(projects.map((found) => found.relativePath).sort()).toEqual(["Cats", "Group/Nested", "Only generations"]);
    const cats = projects.find((found) => found.name === "Cat shots")!;
    expect(cats).toMatchObject({ relativePath: "Cats", inRoot: true, lastModified: 3_000, mediaCount: 0 });
    const nested = projects.find((found) => found.relativePath === "Group/Nested")!;
    expect(nested).toMatchObject({ name: "Nested", lastModified: 2_000, mediaCount: 2, inRoot: true });
    expect(projects.find((found) => found.relativePath === "Only generations")).toMatchObject({ name: "Only generations", mediaCount: 0 });
    // Newest first
    expect(projects.map((found) => found.lastModified)).toEqual([...projects.map((found) => found.lastModified)].sort((a, b) => b - a));
  });

  it("adds registry folders that still hold a workflow file, and workflow rows' project folders", async () => {
    const elsewhere = project(path.join(base, "Old", "Kept"), { name: "Kept", mtime: 5_000 });
    const gone = path.join(base, "Old", "Deleted");
    const noWorkflow = project(path.join(base, "Old", "Media only"), { media: 1 });
    const fromRow = project(path.join(base, "Rows", "Row project"), { media: 1 });
    const inRoot = project(path.join(root, "Here"), { name: "Here", mtime: 1_000 });

    const projects = await listKnownProjects(
      input({
        registryDirs: [elsewhere, gone, noWorkflow, inRoot, `${elsewhere}${path.sep}`, base],
        workflowDirs: [fromRow, path.join(root, "Generations")],
      }),
    );
    // Newest first: the folder dated by its folder (just made) before the fixed workflow times
    expect(projects.map((found) => [found.dir, found.inRoot, found.relativePath])).toEqual([
      [fromRow, false, null],
      [elsewhere, false, null],
      [inRoot, true, "Here"],
    ]);
    expect(projects.map((found) => found.dir).sort()).toEqual([elsewhere, fromRow, inRoot].sort());
  });

  it("still lists projects elsewhere when the Node Banana folder can't be read", async () => {
    const elsewhere = project(path.join(base, "Elsewhere"), { name: "E" });
    const projects = await listKnownProjects(input({ root: path.join(base, "missing"), registryDirs: [elsewhere] }));
    expect(projects.map((found) => found.dir)).toEqual([elsewhere]);
  });
});

describe("isWorkflowFile", () => {
  it("needs version, nodes and edges, reading only the ends of a large file", async () => {
    const good = path.join(base, "good.json");
    fs.writeFileSync(good, workflow("x"));
    const noEdges = path.join(base, "no-edges.json");
    fs.writeFileSync(noEdges, JSON.stringify({ version: 1, nodes: [] }));
    const huge = path.join(base, "huge.json");
    fs.writeFileSync(huge, `{"version":1,"nodes":[${'{"id":"n"},'.repeat(200_000)}{}],"edges":[]}`);
    const other = path.join(base, "package.json");
    fs.writeFileSync(other, JSON.stringify({ name: "x", version: "1" }));
    expect(await isWorkflowFile(good)).toBe(true);
    expect(await isWorkflowFile(noEdges)).toBe(false);
    expect(await isWorkflowFile(huge)).toBe(true);
    expect(await isWorkflowFile(other)).toBe(false);
    expect(await isWorkflowFile(path.join(base, "nope.json"))).toBe(false);
  });
});

describe("generationsStamp", () => {
  it("changes when a file is added, and is null without a generations folder", async () => {
    const dir = project(path.join(base, "P"), { media: 1 });
    const first = await generationsStamp(dir);
    expect(first).toMatch(/^\d+:1$/);
    fs.writeFileSync(path.join(dir, "generations", "new.png"), makePng());
    expect(await generationsStamp(dir)).not.toBe(first);
    expect(await generationsStamp(path.join(base, "none"))).toBeNull();
  });
});

describe("folderBytes and outermost", () => {
  it("sums every file under a folder, without following links", async () => {
    const dir = path.join(base, "Sized");
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "one"), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, "a", "b", "two"), Buffer.alloc(50));
    const outside = path.join(base, "big");
    fs.writeFileSync(outside, Buffer.alloc(10_000));
    try {
      fs.symlinkSync(outside, path.join(dir, "link"));
    } catch {
      // No links on this machine
    }
    expect(await folderBytes(dir)).toBe(150);
    expect(await folderBytes(dir, { files: 0, deadline: Date.now() + 1000 })).toBe(0);
  });

  it("keeps only the folders no other contains", () => {
    expect(outermost(["/a/b", "/a", "/c/d", "/a/b/c", "/c/de", "/a/"], "linux")).toEqual(["/a", "/c/d", "/c/de"]);
  });
});

describe("summariseElsewhere", () => {
  it("counts the outermost folders outside the root, by parent folder", async () => {
    const home = path.join(base, "home");
    const a = project(path.join(home, "Old", "A"), { name: "A" });
    const b = project(path.join(home, "Old", "B"), { name: "B" });
    fs.mkdirSync(path.join(b, "inputs"));
    fs.writeFileSync(path.join(b, "inputs", "big.bin"), Buffer.alloc(1000));
    const nested = project(path.join(b, "Nested"), { name: "N" });
    const c = project(path.join(base, "Other", "C"), { name: "C" });
    const known: KnownProject[] = [a, b, nested, c].map((dir) => ({
      dir,
      name: path.basename(dir),
      relativePath: null,
      inRoot: false,
      lastModified: 0,
      mediaCount: 0,
    }));
    known.push({ dir: path.join(root, "In"), name: "In", relativePath: "In", inRoot: true, lastModified: 0, mediaCount: 0 });
    const summary = await summariseElsewhere(known, { home });
    expect(summary).toMatchObject({
      count: 3,
      groups: [
        { label: "~/Old", count: 2 },
        { label: path.join(base, "Other"), count: 1 },
      ],
    });
    expect(summary!.bytes).toBeGreaterThan(1000);
    expect(await summariseElsewhere(known.slice(4), { home })).toBeNull();
  });

  it("never offers a personal folder or one holding more than a project", async () => {
    const home = path.join(base, "home");
    const downloads = project(path.join(home, "Downloads"), { name: "Loose" });
    const mixed = project(path.join(base, "Mixed"), { name: "Mixed" });
    fs.writeFileSync(path.join(mixed, "taxes.pdf"), "private");
    const inner = project(path.join(mixed, "Inner"), { name: "Inner" });
    const clean = project(path.join(base, "Clean"), { name: "Clean", media: 1 });
    fs.mkdirSync(path.join(clean, "inputs"));
    fs.mkdirSync(path.join(clean, ".images"));
    fs.writeFileSync(path.join(clean, ".DS_Store"), "");
    const known: KnownProject[] = [downloads, mixed, inner, clean].map((dir) => ({
      dir,
      name: path.basename(dir),
      relativePath: null,
      inRoot: false,
      lastModified: 0,
      mediaCount: 0,
    }));
    // The project inside the mixed folder can still move on its own
    expect(await summariseElsewhere(known, { home })).toMatchObject({ count: 2, dirs: [inner, clean] });
  });

  it("shortens the home folder to ~", () => {
    expect(shortenHome("/home/me/Documents/x", "/home/me", "linux")).toBe("~/Documents/x");
    expect(shortenHome("/home/me", "/home/me", "linux")).toBe("~");
    expect(shortenHome("/srv/x", "/home/me", "linux")).toBe("/srv/x");
  });
});

describe("project folder names", () => {
  it("sanitises a name for every filesystem", () => {
    expect(sanitiseFolderName("  Spring: hero / shots?  ")).toBe("Spring hero shots");
    expect(sanitiseFolderName("...hidden")).toBe("hidden");
    expect(sanitiseFolderName("trailing. . ")).toBe("trailing");
    expect(sanitiseFolderName("a\u0000b\tc")).toBe("a b c");
    expect(sanitiseFolderName("")).toBe("Untitled");
    expect(sanitiseFolderName("???")).toBe("Untitled");
    expect(sanitiseFolderName("CON")).toBe("CON project");
    expect(sanitiseFolderName("x".repeat(200))).toHaveLength(80);
  });

  it("numbers past a taken folder, case-insensitively, and never uses Generations", async () => {
    fs.mkdirSync(path.join(root, "cats"));
    fs.mkdirSync(path.join(root, "Cats 2"));
    fs.writeFileSync(path.join(root, "Dogs"), "a file takes the name too");
    expect(await uniqueFolderName(root, "Birds")).toEqual({ folder: "Birds", taken: false });
    expect(await uniqueFolderName(root, "Cats")).toEqual({ folder: "Cats 3", taken: true });
    expect(await uniqueFolderName(root, "Dogs")).toEqual({ folder: "Dogs 2", taken: true });
    expect(await uniqueFolderName(root, "Generations")).toEqual({ folder: "Generations 2", taken: true });
    expect(await uniqueFolderName(root, "Edits")).toEqual({ folder: "Edits 2", taken: true });
    expect(await projectFolderName(root, "cats")).toEqual({ folder: "cats 3", path: path.join(root, "cats 3"), taken: true });
    expect(await projectFolderName(path.join(base, "missing"), "New")).toMatchObject({ folder: "New", taken: false });
  });
});

describe("looksLikeProjectsFolder", () => {
  it("passes over the library's Edits folder, as it does Generations", async () => {
    const project = path.join(root, "Spring");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "spring.json"), workflow("Spring"));
    fs.mkdirSync(path.join(root, "Generations"));
    fs.mkdirSync(path.join(root, "Edits"));
    fs.writeFileSync(path.join(root, "Edits", "Trip.nbedit"), "{}");
    expect(await looksLikeProjectsFolder(root, [project])).toBe(true);
    fs.mkdirSync(path.join(root, "Holiday photos"));
    expect(await looksLikeProjectsFolder(root, [project])).toBe(false);
  });
});

describe("isPersonalFolder", () => {
  it("is the home folder, a folder holding it, its standard folders and drive roots", () => {
    const home = "/Users/me";
    for (const dir of ["/", "/Users", home, `${home}/Desktop`, `${home}/downloads`, `${home}/Pictures`, `${home}/OneDrive`, `${home}/OneDrive - Acme/Documents`]) {
      expect(isPersonalFolder(dir, home, "darwin"), dir).toBe(true);
    }
    for (const dir of [`${home}/Documents/Cats`, `${home}/Projects`, "/Volumes/Work/Cats"]) {
      expect(isPersonalFolder(dir, home, "darwin"), dir).toBe(false);
    }
    expect(isPersonalFolder("D:\\", "C:\\Users\\me", "win32")).toBe(true);
    expect(isPersonalFolder("C:\\Users\\me\\Videos", "C:\\Users\\me", "win32")).toBe(true);
    expect(isPersonalFolder("D:\\Work\\Cats", "C:\\Users\\me", "win32")).toBe(false);
  });
});

describe("holdsOnlyProjectContent", () => {
  it("allows workflows, the project's folders and nested projects, nothing else", async () => {
    const dir = project(path.join(base, "P"), { name: "P", media: 1 });
    fs.mkdirSync(path.join(dir, "outputs"));
    project(path.join(dir, "Sub"), { name: "Sub" });
    expect(await holdsOnlyProjectContent(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, "notes.json"), "{}");
    expect(await holdsOnlyProjectContent(dir)).toBe(false);
    fs.rmSync(path.join(dir, "notes.json"));
    fs.mkdirSync(path.join(dir, "Holiday photos"));
    expect(await holdsOnlyProjectContent(dir)).toBe(false);
  });
});
