/**
 * The projects the app knows about, for the Open view and the Storage
 * page: every project in the Node Banana folder (found by walking it), the
 * registry's folders that still hold a workflow file, and the project
 * folders the workflows table names. Also what goes with them: the stamp
 * the auto-index compares, folder sizes, the "live in other folders"
 * summary, and the folder name a new project gets. Nothing here writes.
 */

import { promises as fs, type Dirent } from "fs";
import os from "os";
import path from "path";
import type { KnownProject, ProjectFolderName, ProjectsElsewhere } from "../types";
import { isInsideRoot, mapConcurrent, pathKey } from "./fsutil";
import { findProjects, inspectProject, isWorkflowFile, type ScanLimits, type ScannedProject } from "./projects";

/** The Node Banana folder is walked on every listing, so it answers sooner than a search the user asked for. */
export const KNOWN_SCAN_LIMITS: Partial<ScanLimits> = { timeoutMs: 5_000 };
/** Folders outside the Node Banana folder looked at per listing. */
export const MAX_OUTSIDE_PROJECTS = 500;
/** Folder names a project never gets: the library's own. Compared case-insensitively. */
export const RESERVED_FOLDER_NAMES: readonly string[] = ["generations", ".nodebanana", "edits"];
/** Longest folder name a project gets from its name. */
const MAX_FOLDER_NAME = 80;
const DESCRIBE_CONCURRENCY = 8;

export interface KnownProjectsInput {
  /** The Node Banana folder. */
  root: string;
  /** Never searched: the library's Generations and data folders, the thumbnail cache. */
  exclude: readonly string[];
  /** The registry's folders: listed while they still hold a workflow file. */
  registryDirs: readonly string[];
  /** The workflows table's project folders: listed while they are projects. */
  workflowDirs: readonly string[];
  platform?: NodeJS.Platform;
  limits?: Partial<ScanLimits>;
}

/** Relative to `root` with "/" separators when `dir` is inside it, else null. */
export function relativeToRoot(root: string, dir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!isInsideRoot(root, dir, { platform })) return null;
  const api = platform === "win32" ? path.win32 : path.posix;
  // By length, not api.relative: on a disk that folds case the two may be spelled differently.
  return api.resolve(dir).slice(api.resolve(root).length).replace(/^[\\/]+/, "").split(/[\\/]/).join("/");
}

function toKnown(project: ScannedProject, root: string, platform: NodeJS.Platform): KnownProject {
  const relativePath = relativeToRoot(root, project.dir, platform);
  return {
    dir: project.dir,
    name: project.name,
    relativePath,
    inRoot: relativePath !== null,
    lastModified: project.lastModified ?? 0,
    mediaCount: project.mediaCount,
  };
}

/** Every known project, each once, newest first. */
export async function listKnownProjects(input: KnownProjectsInput): Promise<KnownProject[]> {
  const platform = input.platform ?? process.platform;
  const found = new Map<string, ScannedProject>();
  try {
    const scan = await findProjects(input.root, {
      match: "project",
      includeRoot: false,
      exclude: input.exclude,
      limits: { ...KNOWN_SCAN_LIMITS, ...input.limits },
      platform,
    });
    for (const project of scan.projects) found.set(pathKey(project.dir, platform), project);
  } catch {
    // The folder can't be read right now: the projects elsewhere are still worth listing.
  }

  const candidates = new Map<string, { dir: string; requireWorkflow: boolean }>();
  const consider = (dir: string, requireWorkflow: boolean) => {
    const key = pathKey(dir, platform);
    if (found.has(key)) return;
    if (input.exclude.some((excluded) => isInsideRoot(excluded, dir, { platform, allowEqual: true }))) return;
    if (isInsideRoot(dir, input.root, { platform, allowEqual: true })) return;
    const existing = candidates.get(key);
    if (existing) existing.requireWorkflow &&= requireWorkflow;
    else candidates.set(key, { dir, requireWorkflow });
  };
  for (const dir of input.workflowDirs) consider(dir, false);
  for (const dir of input.registryDirs) consider(dir, true);

  const described = await mapConcurrent([...candidates.values()].slice(0, MAX_OUTSIDE_PROJECTS), DESCRIBE_CONCURRENCY, (candidate) =>
    inspectProject(candidate.dir, { requireWorkflow: candidate.requireWorkflow }),
  );
  for (const project of described) if (project) found.set(pathKey(project.dir, platform), project);

  return [...found.values()]
    .map((project) => toKnown(project, input.root, platform))
    .sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name) || (a.dir < b.dir ? -1 : 1));
}

/**
 * `<dir>/generations` as the auto-index compares it: mtime and entry count
 * (a file added or removed changes one or both). Null when there is no
 * such folder.
 */
export async function generationsStamp(dir: string): Promise<string | null> {
  const generations = path.join(dir, "generations");
  try {
    const stat = await fs.stat(generations);
    if (!stat.isDirectory()) return null;
    const names = await fs.readdir(generations);
    return `${Math.floor(stat.mtimeMs)}:${names.length}`;
  } catch {
    return null;
  }
}

/** A shared allowance for sizing folders, so one listing never walks a whole drive. */
export interface SizeBudget {
  files: number;
  deadline: number;
}

export function sizeBudget(files = 200_000, timeMs = 3_000, now: number = Date.now()): SizeBudget {
  return { files, deadline: now + timeMs };
}

/**
 * The bytes in `dir` and everything under it. Links are not followed (a
 * move copies the link, not what it points at). Stops, with what it has,
 * when the budget runs out.
 */
export async function folderBytes(dir: string, budget: SizeBudget = sizeBudget()): Promise<number> {
  let bytes = 0;
  const pending = [dir];
  while (pending.length) {
    if (budget.files <= 0 || Date.now() > budget.deadline) break;
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
    }
    const sizes = await mapConcurrent(files.slice(0, Math.max(0, budget.files)), 16, async (file) => {
      try {
        return (await fs.lstat(file)).size;
      } catch {
        return 0;
      }
    });
    budget.files -= files.length;
    for (const size of sizes) bytes += size;
  }
  return bytes;
}

/** Only the folders no other folder in the list contains (a nested project moves with its parent). */
export function outermost(dirs: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const unique = new Map<string, string>();
  for (const dir of dirs) {
    const key = pathKey(dir, platform);
    if (!unique.has(key)) unique.set(key, dir);
  }
  const sorted = [...unique.values()].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const dir of sorted) {
    if (!kept.some((parent) => isInsideRoot(parent, dir, { platform }))) kept.push(dir);
  }
  return dirs.filter((dir) => kept.includes(dir));
}

/** `~/…` for a folder in the home folder, else the folder itself. */
export function shortenHome(dir: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  const rel = relativeToRoot(home, dir, platform);
  if (rel === null) return isInsideRoot(home, dir, { platform, allowEqual: true }) ? "~" : dir;
  return `~/${rel}`;
}

/**
 * Folders in a home folder that hold a person's own files (and cloud
 * drives' folders of the same name), compared case-insensitively. A
 * workflow opened from one of them makes it look like a project, but a
 * move must never take it whole.
 */
const PERSONAL_FOLDERS = new Set([
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "movies",
  "music",
  "videos",
  "public",
  "library",
  "applications",
  "appdata",
  "favorites",
  "contacts",
  "links",
  "saved games",
  "searches",
  "3d objects",
  "onedrive",
  "dropbox",
  "icloud drive",
  "google drive",
  "creative cloud files",
]);
/** Cloud drives synced into the home folder, whose own Documents, Desktop, … are just as personal. */
const CLOUD_DRIVE = /^(onedrive|dropbox|icloud drive|google drive)\b/i;
/** What the OS leaves in any folder, not the user's. */
const OS_CLUTTER = new Set(["desktop.ini", "thumbs.db", "icon\r"]);
/** What a project folder holds besides its workflow files. */
const PROJECT_FOLDERS = new Set(["generations", "inputs", "outputs", ".images"]);

/** A drive root, the home folder, a folder holding it, or one of its standard folders (Desktop, Documents, …). */
export function isPersonalFolder(dir: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const resolved = api.resolve(dir);
  if (api.parse(resolved).root === resolved || api.dirname(resolved) === resolved) return true;
  if (isInsideRoot(resolved, home, { platform, allowEqual: true })) return true;
  const rel = relativeToRoot(home, resolved, platform);
  if (rel === null) return false;
  const parts = rel.split("/").map((part) => part.toLowerCase());
  if (parts.length === 1) return PERSONAL_FOLDERS.has(parts[0]) || CLOUD_DRIVE.test(parts[0]);
  return parts.length === 2 && CLOUD_DRIVE.test(parts[0]) && PERSONAL_FOLDERS.has(parts[1]);
}

/**
 * Whether the top of `dir` holds only what a project does: workflow files,
 * its generations, inputs, outputs and legacy .images folders, and projects
 * of its own. Hidden files and what the OS leaves are ignored; anything else
 * (a photo, a document, another folder) means it is more than a project.
 */
export async function holdsOnlyProjectContent(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PROJECT_FOLDERS.has(lower)) continue;
      if (!entry.name.startsWith(".") && (await inspectProject(full, { requireWorkflow: true }))) continue;
      return false;
    }
    if (entry.name.startsWith(".") || OS_CLUTTER.has(lower)) continue;
    if (entry.isFile() && lower.endsWith(".json") && (await isWorkflowFile(full))) continue;
    return false;
  }
  return true;
}

/**
 * Why `dir` can't move into the Node Banana folder as a project, or null
 * when it can. A move copies the whole folder and deletes the original, so
 * only a folder that is nothing but a project may go.
 */
export async function moveRefusal(dir: string, options: { home?: string; platform?: NodeJS.Platform } = {}): Promise<string | null> {
  if (isPersonalFolder(dir, options.home, options.platform)) {
    return `"${dir}" is one of your own folders, not a project folder, so it can't be moved.`;
  }
  if (!(await holdsOnlyProjectContent(dir))) {
    return `"${dir}" holds more than a project, so it can't be moved. Move the project into a folder of its own first.`;
  }
  return null;
}

/**
 * The known projects outside the Node Banana folder, summed for the offer;
 * null when there are none. Only folders a move would take count: never a
 * personal folder or one holding more than a project.
 */
export async function summariseElsewhere(
  projects: readonly KnownProject[],
  options: { home?: string; platform?: NodeJS.Platform; budget?: SizeBudget } = {},
): Promise<ProjectsElsewhere | null> {
  const platform = options.platform ?? process.platform;
  const outside = projects.filter((project) => !project.inRoot).map((project) => project.dir);
  const refused = await mapConcurrent(outside, DESCRIBE_CONCURRENCY, (dir) => moveRefusal(dir, { home: options.home, platform }));
  const dirs = outermost(
    outside.filter((_, index) => refused[index] === null),
    platform,
  );
  if (!dirs.length) return null;
  const budget = options.budget ?? sizeBudget();
  const sizes = await mapConcurrent(dirs, 4, (dir) => folderBytes(dir, budget));
  const groups = new Map<string, { label: string; count: number }>();
  const api = platform === "win32" ? path.win32 : path.posix;
  for (const dir of dirs) {
    const parent = api.dirname(dir);
    const key = pathKey(parent, platform);
    const group = groups.get(key) ?? { label: shortenHome(parent, options.home, platform), count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return {
    count: dirs.length,
    dirs,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

/**
 * Whether `folder` looks like a Node Banana folder already: it holds
 * projects, and every visible entry at its top is a project, holds one, is
 * a library's Generations folder or is a loose workflow file. A folder
 * that is itself a project doesn't.
 */
export async function looksLikeProjectsFolder(
  folder: string,
  projectDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!projectDirs.length) return false;
  if (projectDirs.some((dir) => pathKey(dir, platform) === pathKey(folder, platform))) return false;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || OS_CLUTTER.has(entry.name.toLowerCase())) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (projectDirs.some((dir) => isInsideRoot(full, dir, { platform, allowEqual: true }))) continue;
      if (RESERVED_FOLDER_NAMES.includes(entry.name.toLowerCase())) continue;
      // A project with no media yet is one too, though the search reports only those with media.
      if (await inspectProject(full, { requireWorkflow: true })) continue;
      return false;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json") && (await isWorkflowFile(full))) continue;
    return false;
  }
  return true;
}

/** Windows device names, which no folder may be called (with any extension). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A project name as a folder name every platform accepts: characters
 * Windows refuses and control characters become spaces, runs of spaces
 * collapse, leading dots (hidden) and trailing dots or spaces (Windows)
 * go, and it is kept short. Nothing left makes "Untitled".
 */
export function sanitiseFolderName(name: string): string {
  const clean = (value: string) =>
    value
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .replace(/[. ]+$/, "")
      .trim();
  let folder = clean(String(name ?? "").normalize("NFC"));
  if (folder.length > MAX_FOLDER_NAME) folder = clean(folder.slice(0, MAX_FOLDER_NAME));
  if (!folder) folder = "Untitled";
  if (WINDOWS_DEVICE.test(folder)) folder = `${folder} project`;
  return folder;
}

/**
 * `base`, else `base 2`, `base 3`, … — the first name nothing in `root`
 * has (compared case-insensitively, since a folder must not clash on any
 * disk the library may move to), and never a library folder's name.
 */
export async function uniqueFolderName(root: string, base: string): Promise<{ folder: string; taken: boolean }> {
  let names: Set<string>;
  try {
    names = new Set((await fs.readdir(root)).map((name) => name.toLowerCase()));
  } catch {
    names = new Set();
  }
  const free = (name: string) => !names.has(name.toLowerCase()) && !RESERVED_FOLDER_NAMES.includes(name.toLowerCase());
  if (free(base)) return { folder: base, taken: false };
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (free(candidate)) return { folder: candidate, taken: true };
  }
}

/** The folder a new project called `name` is saved in, inside the Node Banana folder. */
export async function projectFolderName(root: string, name: string): Promise<ProjectFolderName> {
  const { folder, taken } = await uniqueFolderName(root, sanitiseFolderName(name));
  return { folder, path: path.join(root, folder), taken };
}
