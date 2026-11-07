/**
 * Long library operations as background jobs, one at a time: move the
 * library, import existing project folders, clean up unused data, export a
 * selection. The route returns at once; the UI follows progress through
 * `LibraryStatus.job` and `GET /api/assets/jobs/[id]`, and can cancel.
 */

import { createHash, randomUUID } from "crypto";
import { constants as fsConstants, promises as fs } from "fs";
import path from "path";
import { newAssetId, newRunId } from "../client/ids";
import { MAX_IMPORT_PROJECTS, type AssetModelRef, type AssetRecord, type LibraryJobStatus, type LibraryJobType } from "../types";
import { errnoCode, LibraryError } from "./errors";
import {
  atomicWriteFile,
  copyFileVerified,
  foldsCase,
  hashFile,
  isInsideRoot,
  pathKey,
  PARTIAL_SUFFIX,
  sweepStaleTemps,
  unlinkWithRetry,
} from "./fsutil";
import { acquireLock, DATA_DIR, EDITS_DIR, GENERATIONS_DIR, WRITERS_DIR } from "./layout";
import type { AssetLibrary } from "./library";
import { decideMediaType, imageDimensionsFromFile, probeAudioVideo, readHead } from "./media";
import { isUnreadableFile } from "./readable";
import type { Thumbnailer } from "./thumbs";
import { extOf, isMediaExtension, isWorkflowId, mediaTypeForExt, normaliseProjectDir, safeFileName } from "./validate";

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

export interface JobContext {
  signal: AbortSignal;
  update(patch: Partial<Pick<LibraryJobStatus, "done" | "total" | "bytesDone" | "bytesTotal" | "message" | "moved">>): void;
  addBytes(bytes: number): void;
  step(): void;
  /** Throws when the job was cancelled. */
  checkCancelled(): void;
}

interface JobEntry {
  status: LibraryJobStatus;
  controller: AbortController;
  promise: Promise<void>;
  /** Started by the app itself (the auto-index): never shown in the library status. */
  quiet: boolean;
}

/** Finished jobs stay visible in the library status this long. */
const FINISHED_VISIBLE_MS = 5 * 60 * 1000;
const MAX_REMEMBERED_JOBS = 20;

function cancelled(): LibraryError {
  return new LibraryError("Cancelled", 499, "cancelled");
}

export class JobRunner {
  private readonly jobs = new Map<string, JobEntry>();
  private running: JobEntry | null = null;

  /**
   * Starts `work` as a job, or throws when another job is running. A
   * `quiet` job is one the app started on its own: it holds the runner like
   * any other, but the library status never shows it.
   */
  start(type: LibraryJobType, work: (ctx: JobContext) => Promise<string | void>, options: { quiet?: boolean } = {}): LibraryJobStatus {
    if (this.running) {
      throw new LibraryError("Another library task is running. Wait for it to finish or cancel it.", 409, "busy");
    }
    const controller = new AbortController();
    const status: LibraryJobStatus = {
      id: `j${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      type,
      state: "running",
      done: 0,
      total: 0,
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: Date.now(),
    };
    const ctx: JobContext = {
      signal: controller.signal,
      update: (patch) => Object.assign(status, patch),
      addBytes: (bytes) => {
        status.bytesDone += bytes;
      },
      step: () => {
        status.done++;
      },
      checkCancelled: () => {
        if (controller.signal.aborted) throw cancelled();
      },
    };
    const entry: JobEntry = { status, controller, promise: Promise.resolve(), quiet: options.quiet === true };
    entry.promise = (async () => {
      try {
        const message = await work(ctx);
        status.state = "done";
        if (message) status.message = message;
      } catch (error) {
        if (controller.signal.aborted || (error instanceof LibraryError && error.code === "cancelled")) {
          status.state = "cancelled";
        } else {
          status.state = "failed";
          status.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        status.finishedAt = Date.now();
        if (this.running === entry) this.running = null;
      }
    })();
    this.jobs.set(status.id, entry);
    this.running = entry;
    while (this.jobs.size > MAX_REMEMBERED_JOBS) {
      const oldest = [...this.jobs.values()].find((job) => job.status.state !== "running");
      if (!oldest) break;
      this.jobs.delete(oldest.status.id);
    }
    return { ...status };
  }

  /**
   * Stops a quiet job holding the runner and waits for it to end, so a job
   * the user asked for never meets a task they can't see (the app starts
   * the quiet one again later).
   */
  async yieldQuiet(): Promise<void> {
    while (this.running?.quiet) {
      const entry = this.running;
      entry.controller.abort();
      await entry.promise;
    }
  }

  /** {@link start} for a job the user asked for: a quiet job holding the runner makes way first. */
  async startOverQuiet(type: LibraryJobType, work: (ctx: JobContext) => Promise<string | void>): Promise<LibraryJobStatus> {
    await this.yieldQuiet();
    return this.start(type, work);
  }

  /**
   * Records a job that ended outside this runner — a move stopped by the
   * app quitting, found at the next start — so the library status reports
   * it like any finished job.
   */
  note(type: LibraryJobType, outcome: { error: string } | { message: string }): LibraryJobStatus {
    const now = Date.now();
    const status: LibraryJobStatus = {
      id: `j${now.toString(36)}${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      type,
      state: "error" in outcome ? "failed" : "done",
      done: 0,
      total: 0,
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: now,
      finishedAt: now,
      ...outcome,
    };
    this.jobs.set(status.id, { status, controller: new AbortController(), promise: Promise.resolve(), quiet: false });
    return { ...status };
  }

  get(id: string): LibraryJobStatus | null {
    const entry = this.jobs.get(id);
    return entry ? { ...entry.status } : null;
  }

  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || entry.status.state !== "running") return false;
    entry.controller.abort();
    return true;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** The running job, else the most recent one if it finished in the last few minutes (quiet ones never). */
  visible(now: number = Date.now()): LibraryJobStatus | null {
    if (this.running && !this.running.quiet) return { ...this.running.status };
    let latest: LibraryJobStatus | null = null;
    for (const { status, quiet } of this.jobs.values()) {
      if (!quiet && status.finishedAt && now - status.finishedAt < FINISHED_VISIBLE_MS && (!latest || status.finishedAt > latest.finishedAt!)) {
        latest = status;
      }
    }
    return latest ? { ...latest } : null;
  }

  /** Resolves when the job has ended, however it ended. */
  async wait(id: string): Promise<void> {
    await this.jobs.get(id)?.promise;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.promise));
  }
}

/* ------------------------------------------------------------------ */
/* Import existing projects                                            */
/* ------------------------------------------------------------------ */

interface CarouselMatch {
  item: Record<string, unknown>;
  nodeId: string;
  nodeType: string;
  data: Record<string, unknown>;
}

interface ProjectWorkflow {
  id: string | null;
  name: string | null;
  carousel: Map<string, CarouselMatch>;
}

const HISTORY_FIELDS = ["imageHistory", "videoHistory", "audioHistory"] as const;

/** The project's newest workflow JSON (by mtime), as /api/workflow?load=true picks it. */
export async function readProjectWorkflow(projectDir: string): Promise<ProjectWorkflow | null> {
  let names: string[];
  try {
    names = (await fs.readdir(projectDir)).filter((name) => name.toLowerCase().endsWith(".json"));
  } catch {
    return null;
  }
  const candidates: { file: string; mtime: number }[] = [];
  for (const name of names) {
    const file = path.join(projectDir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.size < 512 * 1024 * 1024) candidates.push({ file, mtime: stat.mtimeMs });
    } catch {
      // Unreadable; skip.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      if (typeof parsed.version !== "number" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) continue;
      const carousel = new Map<string, CarouselMatch>();
      for (const node of parsed.nodes as Record<string, unknown>[]) {
        const data = (node?.data ?? {}) as Record<string, unknown>;
        for (const field of HISTORY_FIELDS) {
          const items = data[field];
          if (!Array.isArray(items)) continue;
          for (const item of items as Record<string, unknown>[]) {
            if (item && typeof item.id === "string") {
              carousel.set(item.id, {
                item,
                nodeId: typeof node.id === "string" ? node.id : "",
                nodeType: typeof node.type === "string" ? node.type : "",
                data,
              });
            }
          }
        }
      }
      return {
        id: isWorkflowId(parsed.id) ? parsed.id : null,
        name: typeof parsed.name === "string" ? parsed.name : null,
        carousel,
      };
    } catch {
      // Not a workflow file.
    }
  }
  return null;
}

/** The model a carousel entry ran, with provider and label from its node when they agree. */
function carouselModel(match: CarouselMatch): AssetModelRef | undefined {
  const generation = match.item.generation as { modelId?: unknown } | undefined;
  const modelId =
    typeof generation?.modelId === "string" ? generation.modelId : typeof match.item.model === "string" ? match.item.model : null;
  if (!modelId) return undefined;
  const selected = match.data.selectedModel as { provider?: unknown; modelId?: unknown; displayName?: unknown } | undefined;
  if (selected && selected.modelId === modelId) {
    return {
      provider: typeof selected.provider === "string" ? selected.provider : "",
      modelId,
      ...(typeof selected.displayName === "string" ? { displayName: selected.displayName } : {}),
    };
  }
  return { provider: modelId.startsWith("nano-banana") ? "gemini" : "", modelId };
}

interface ImportDeps {
  library: AssetLibrary;
  thumbs: Thumbnailer | null;
}

/**
 * A project file's record: hashed, measured, with what the project's
 * workflow JSON knows about it. Null when the file's bytes are unreadable
 * (readable.ts): it is left where it is and not indexed.
 */
async function importedRecord(
  file: string,
  mtime: number,
  source: { workflow: ProjectWorkflow | null; workflowId: string; workflowName: string; runId: string },
  signal: AbortSignal,
): Promise<AssetRecord | null> {
  const digest = await hashFile(file, signal);
  const ext = extOf(file);
  const hinted = mediaTypeForExt(ext);
  if (!hinted) throw new Error("unsupported type");
  const head = await readHead(file, 64 * 1024);
  const type = decideMediaType({ head, kind: hinted.kind, hintExt: ext });
  const filename = path.basename(file);
  const match = source.workflow?.carousel.get(filename.slice(0, filename.length - ext.length - 1));
  let dims: { width?: number; height?: number; durationSec?: number } = {};
  if (type.kind === "image") dims = (await imageDimensionsFromFile(file, ext, head)) ?? {};
  else if (type.kind === "video" || type.kind === "audio") dims = await probeAudioVideo({ path: file }, type.kind);
  if (await isUnreadableFile(file, type, dims)) return null;

  const generation = match?.item.generation as { parameters?: unknown; cost?: unknown } | undefined;
  const cost = generation?.cost as { amount?: unknown; estimated?: unknown } | undefined;
  return {
    v: 1,
    id: newAssetId(),
    kind: type.kind,
    origin: "generated",
    mime: type.mime,
    ext,
    bytes: digest.bytes,
    sha256: digest.sha256,
    md5: digest.md5,
    file: { root: "external", path: file },
    filename,
    ...(dims.width && dims.height ? { width: dims.width, height: dims.height } : {}),
    ...(dims.durationSec ? { durationSec: dims.durationSec } : {}),
    createdAt: Math.floor(mtime),
    ...(typeof match?.item.prompt === "string" && match.item.prompt ? { prompt: match.item.prompt } : {}),
    ...(match && carouselModel(match) ? { model: carouselModel(match) } : {}),
    ...(generation?.parameters && typeof generation.parameters === "object"
      ? { parameters: generation.parameters as Record<string, unknown> }
      : {}),
    ...(typeof match?.item.aspectRatio === "string" ? { aspectRatio: match.item.aspectRatio } : {}),
    ...(cost && typeof cost.amount === "number"
      ? { cost: { amount: cost.amount, currency: "USD" as const, estimated: cost.estimated === true } }
      : {}),
    producer: { nodeId: match?.nodeId ?? "", nodeType: match?.nodeType ?? "import" },
    workflowId: source.workflowId,
    workflowName: source.workflowName,
    runId: source.runId,
    tags: [],
    favorite: false,
    imported: true,
  };
}

/**
 * Indexes the files in each project's `generations/` folder in place:
 * hashes, measures, and attaches what the newest workflow JSON knows about
 * each file (its carousel entry: prompt, model, parameters). Files whose
 * bytes nothing can open are left alone and counted in the message.
 */
export async function runImport(ctx: JobContext, deps: ImportDeps, projectDirs: string[]): Promise<string> {
  const { library } = deps;
  await library.ready();
  const plan: { projectDir: string; files: { file: string; size: number; mtime: number }[] }[] = [];
  let skippedDirs = 0;
  for (const dir of projectDirs) {
    ctx.checkCancelled();
    const generations = path.join(dir, "generations");
    let names: string[];
    try {
      names = await fs.readdir(generations);
    } catch {
      skippedDirs++;
      continue;
    }
    const files: { file: string; size: number; mtime: number }[] = [];
    for (const name of names.sort()) {
      if (name.endsWith(PARTIAL_SUFFIX) || !isMediaExtension(extOf(name))) continue;
      const file = path.join(generations, name);
      if (library.recordsAtPath(file).length) continue;
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0) files.push({ file, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // Vanished; skip.
      }
    }
    // Oldest first, so of several copies of the same bytes the first one made is the one kept
    files.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
    plan.push({ projectDir: dir, files });
  }
  ctx.update({
    total: plan.reduce((sum, entry) => sum + entry.files.length, 0),
    bytesTotal: plan.reduce((sum, entry) => sum + entry.files.reduce((s, f) => s + f.size, 0), 0),
  });

  let imported = 0;
  let unreadable = 0;
  let duplicates = 0;
  let failed = 0;
  for (const { projectDir, files } of plan) {
    const workflow = await readProjectWorkflow(projectDir);
    const folderId = `import_${createHash("sha1").update(pathKey(projectDir)).digest("hex").slice(0, 16)}`;
    let workflowId = workflow?.id ?? folderId;
    let forkedFrom: string | undefined;
    const claimed = library.getWorkflow(workflowId)?.projectPath;
    if (workflowId !== folderId && claimed && pathKey(claimed) !== pathKey(projectDir)) {
      // That id already belongs to another project (a copied folder, a shared community workflow):
      // file these under this folder's own id rather than moving the other project's assets here.
      forkedFrom = workflowId;
      workflowId = folderId;
    }
    const workflowName = workflow?.name ?? path.basename(projectDir);
    // Importing is an explicit "these files belong to this folder"; a name set in the app since is kept.
    const existing = library.getWorkflow(workflowId);
    await library.upsertWorkflow(workflowId, {
      name: existing?.name ?? workflowName,
      projectPath: projectDir,
      ...(forkedFrom ? { forkedFrom } : {}),
    });
    const runId = newRunId();
    for (const { file, size, mtime } of files) {
      ctx.checkCancelled();
      try {
        const record = await importedRecord(file, mtime, { workflow, workflowId, workflowName, runId }, ctx.signal);
        if (record && hasCopyInFolder(library, record, file)) {
          // The same bytes under another name in this folder (older saves wrote gallery
          // images again on every save): one asset, not one per copy.
          duplicates++;
        } else if (record) {
          // Published, so a move in the other build waits for this record and refuses the next one.
          const saved = await library.writing(() => library.addRecord(record));
          deps.thumbs?.enqueue(saved, file);
          imported++;
        } else {
          unreadable++;
        }
      } catch (error) {
        if (error instanceof LibraryError && (error.code === "cancelled" || error.code === "paused")) throw error;
        failed++;
      }
      ctx.addBytes(size);
      ctx.step();
    }
  }
  const parts = [`Imported ${imported} ${imported === 1 ? "file" : "files"}.`];
  if (unreadable) parts.push(`${unreadable} unreadable ${unreadable === 1 ? "file" : "files"} skipped.`);
  if (duplicates) parts.push(`${duplicates} ${duplicates === 1 ? "copy" : "copies"} of files already imported skipped.`);
  if (failed) parts.push(`${failed} could not be read.`);
  if (skippedDirs) parts.push(`${skippedDirs} ${skippedDirs === 1 ? "folder has" : "folders have"} no generations folder.`);
  return parts.join(" ");
}

/** Another record, not in the Trash, holds these bytes in the same folder as `file`. */
function hasCopyInFolder(library: AssetLibrary, record: AssetRecord, file: string): boolean {
  const folder = pathKey(path.dirname(file));
  return library
    .recordsWithHash(record.sha256)
    .some((other) => other.trashedAt === undefined && other.file.root === "external" && pathKey(path.dirname(other.file.path)) === folder);
}

/** Checks and normalises the folders of an import request. */
export function normaliseImportDirs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LibraryError("Choose at least one project folder", 400, "bad_request");
  }
  if (value.length > MAX_IMPORT_PROJECTS) throw new LibraryError("Too many folders", 400, "bad_request");
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of value) {
    const dir = normaliseProjectDir(entry);
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

interface CleanupDeps {
  library: AssetLibrary;
  thumbs: Thumbnailer | null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A snapshot with no asset is kept this long: a run still recording writes it a moment before its asset lands. */
export const ORPHAN_RUN_GRACE_MS = 60 * 60 * 1000;

/**
 * `unusedMedia`: delete the snapshots of runs no asset belongs to any more,
 * release the files deletes kept while a record couldn't be read, then
 * snapshot media no remaining run references (none at all when a snapshot
 * can't be read right now), posters of assets that no longer exist, stale
 * partial files, and trim the thumbnail cache. While an asset record can't
 * be read, none of the first four: they may be its.
 * `thumbnails`: empty the thumbnail cache.
 */
export async function runCleanup(
  ctx: JobContext,
  deps: CleanupDeps,
  request: { unusedMedia?: boolean; thumbnails?: boolean },
): Promise<string> {
  const { library, thumbs } = deps;
  await library.ready();
  let files = 0;
  let bytes = 0;
  let keptForUnreadable = false;
  let keptForUnreadableRecords = false;
  const remove = async (file: string) => {
    try {
      const stat = await fs.stat(file);
      await unlinkWithRetry(file);
      files++;
      bytes += stat.size;
    } catch {
      // Held open or gone.
    }
  };

  if (request.unusedMedia) {
    // A record whose sidecar can't be read has a run, media and a poster this can't see: keep them all.
    keptForUnreadableRecords = await library.hasUnreadable();
    if (!keptForUnreadableRecords) {
      const runsInUse = new Set(library.allRecords().map((record) => record.runId));
      const orphans = await library.runs.removeOrphans(runsInUse, Date.now() - ORPHAN_RUN_GRACE_MS);
      files += orphans.files;
      bytes += orphans.bytes;
      // What deletes had to keep while a record couldn't be read, now that every one reads.
      const deferred = await library.releaseDeferred();
      files += deferred.files;
      bytes += deferred.bytes;
      ctx.checkCancelled();
      const { hashes: referenced, incomplete } = await library.runs.referencedHashes();
      keptForUnreadable = incomplete;
      const media = incomplete ? [] : await library.runs.mediaEntries();
      let posterNames: string[] = [];
      try {
        posterNames = await fs.readdir(library.layout.posters);
      } catch {
        posterNames = [];
      }
      ctx.update({ total: media.length + posterNames.length });
      for (const entry of media) {
        ctx.checkCancelled();
        if (!referenced.has(entry.sha256)) {
          await remove(entry.path);
          library.runs.forgetMedia(entry.sha256);
        }
        ctx.step();
      }
      for (const name of posterNames) {
        ctx.checkCancelled();
        const sha = name.split(".")[0];
        if (library.recordsWithHash(sha).length === 0) await remove(path.join(library.layout.posters, name));
        ctx.step();
      }
    }
    const layout = library.layout;
    for (const dir of [layout.data, layout.assets, layout.runs, layout.media, layout.posters, layout.pendingReleases]) {
      await sweepStaleTemps(dir, 60 * 60 * 1000);
    }
    await thumbs?.trim();
  }
  if (request.thumbnails && thumbs) {
    ctx.checkCancelled();
    files += await thumbs.clear();
  }
  const summary = files
    ? `Removed ${files} ${files === 1 ? "file" : "files"}${bytes ? ` (${formatBytes(bytes)})` : ""}.`
    : "Nothing to clean up.";
  if (keptForUnreadableRecords) {
    return `${summary} Some asset records couldn't be read, so no workflow data was removed. Try again later.`;
  }
  return keptForUnreadable
    ? `${summary} Some workflow snapshots couldn't be read, so their media was kept. Try again later.`
    : summary;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** `name.ext`, then `name (2).ext`, … — whichever does not exist yet (created exclusively), always directly in `dir`. */
async function copyToUniqueName(source: string, dir: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let n = 1; n < 10_000; n++) {
    const target = path.join(dir, n === 1 ? filename : `${base} (${n})${ext}`);
    if (path.dirname(target) !== path.resolve(dir)) {
      throw new LibraryError(`Can't export a file named ${filename}`, 400, "bad_request");
    }
    try {
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
  throw new LibraryError(`Too many files named ${filename} in the destination`, 409, "conflict");
}

/** Checks an export destination: absolute, and not inside the library's own data folder. */
export async function prepareExportDest(value: unknown, library: AssetLibrary): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new LibraryError("Choose a folder to export to", 400, "bad_request");
  }
  const dest = path.resolve(value);
  if (isInsideRoot(library.layout.data, dest, { allowEqual: true })) {
    throw new LibraryError("Choose a folder outside the library's data folder", 400, "bad_request");
  }
  await fs.mkdir(dest, { recursive: true });
  return dest;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copies each asset's file into `dest` under its own name (reduced to a
 * bare file name: a sidecar is user-editable and never picks the folder).
 * Only a source that is not there marks an asset missing; when the
 * destination goes away (an unplugged drive), the job stops with that.
 */
export async function runExport(ctx: JobContext, library: AssetLibrary, ids: string[], dest: string): Promise<string> {
  const records = ids
    .map((id) => library.get(id))
    .filter((record): record is AssetRecord => Boolean(record));
  ctx.update({ total: records.length, bytesTotal: records.reduce((sum, record) => sum + record.bytes, 0) });
  let copied = 0;
  let missing = 0;
  let failed = 0;
  for (const record of records) {
    ctx.checkCancelled();
    const file = library.filePath(record);
    let found = false;
    if (file) {
      try {
        found = (await fs.stat(file)).isFile();
      } catch (error) {
        library.noteFileError(record.id, error);
      }
    }
    if (!found) {
      missing++;
    } else {
      const name = safeFileName(record.filename) ?? safeFileName(file) ?? `${record.id}.${record.ext}`;
      try {
        await copyToUniqueName(file!, dest, name);
        copied++;
      } catch (error) {
        if (!(await isDirectory(dest))) {
          throw new LibraryError(
            `The export folder is no longer available (${dest}). ${copied} ${copied === 1 ? "file was" : "files were"} copied before it went.`,
            409,
            "gone",
          );
        }
        console.warn("[assets] could not export", file, error);
        failed++;
      }
    }
    ctx.addBytes(record.bytes);
    ctx.step();
  }
  const parts = [`Exported ${copied} ${copied === 1 ? "file" : "files"}.`];
  if (missing) parts.push(`${missing} could not be found.`);
  if (failed) parts.push(`${failed} could not be copied.`);
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Move                                                                */
/* ------------------------------------------------------------------ */

/** realpath of the nearest existing ancestor, with the rest re-appended (the target may not exist yet). */
async function realpathNearest(target: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `dir` holds anything but the names in `ignore`. */
async function isNonEmptyDir(dir: string, ignore: readonly string[] = []): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((name) => !ignore.includes(name));
  } catch {
    return false;
  }
}

/** Whether `dir` holds an edit file (what the move copies from Edits/), not only Finder clutter or a project's files. */
async function holdsEditFiles(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).some(
      (dirent) => dirent.isFile() && dirent.name.toLowerCase().endsWith(".nbedit"),
    );
  } catch {
    return false;
  }
}

/**
 * Checks a move destination before the job starts: absolute, not the
 * current root, neither inside the other (after resolving symlinks such as
 * macOS's /var → /private/var, case-folded where the disk folds case), and
 * not already holding a library (nor another library's edits, which the
 * copy would overwrite).
 */
export async function validateMoveTarget(fromRoot: string, target: unknown, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) {
    throw new LibraryError("Choose a folder for the library", 400, "bad_request");
  }
  const to = path.resolve(target);
  const [realFrom, realTo] = await Promise.all([realpathNearest(fromRoot), realpathNearest(to)]);
  const fold = (value: string) => (foldsCase(platform) ? value.toLowerCase() : value);
  if (fold(realFrom) === fold(realTo)) throw new LibraryError("That is already the library folder", 400, "bad_request");
  if (isInsideRoot(realFrom, realTo, { platform }) || isInsideRoot(realTo, realFrom, { platform })) {
    throw new LibraryError("The new folder can't be inside the library, or contain it", 400, "bad_request");
  }
  try {
    const stat = await fs.stat(to);
    if (!stat.isDirectory()) throw new LibraryError("That is a file, not a folder", 400, "bad_request");
  } catch (error) {
    if (error instanceof LibraryError) throw error;
  }
  // A writers folder alone is no library: the other build can recreate it in a root the library just left.
  if (
    (await isNonEmptyDir(path.join(to, DATA_DIR), [WRITERS_DIR])) ||
    (await isNonEmptyDir(path.join(to, GENERATIONS_DIR))) ||
    (await holdsEditFiles(path.join(to, EDITS_DIR)))
  ) {
    throw new LibraryError(
      "That folder already holds a Node Banana library. Use it as it is, or choose an empty folder.",
      409,
      "conflict",
    );
  }
  return to;
}

interface ManifestEntry {
  rel: string;
  source: string;
  size: number;
  mtimeMs: number;
}

/** In the source's data folder while a move runs: `{ toRoot, startedAt, pid, state }`. */
export const MOVE_MARKER = "move.json";
/** In the source's data folder: each rel path the move is about to copy, one per line. */
export const MOVE_LOG = "move-copied.ndjson";
/** In the target's data folder while a move copies into it: `{ fromRoot, startedAt }`. */
export const MOVE_SOURCE_MARKER = "move-source.json";

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Library-owned files only: the day folders of Generations/, the edit files
 * in Edits/ and .nodebanana/ — never projects (not even a project file that ended up
 * under Generations/), caches, locks, move markers or temp files.
 */
async function buildManifest(root: string, library?: AssetLibrary): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  const data = path.join(root, DATA_DIR);
  const skipDirs = new Set([path.join(data, "cache"), path.join(data, WRITERS_DIR)]);
  const skipFiles = new Set([
    path.join(data, "lock"),
    path.join(data, "config.json"),
    path.join(data, MOVE_MARKER),
    path.join(data, MOVE_LOG),
    path.join(data, MOVE_SOURCE_MARKER),
  ]);
  const walk = async (dir: string, accept: (dirent: import("fs").Dirent) => boolean = () => true) => {
    let names: import("fs").Dirent[];
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      if (!accept(dirent)) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (!skipDirs.has(full)) await walk(full);
      } else if (dirent.isFile()) {
        if (skipFiles.has(full) || dirent.name.endsWith(PARTIAL_SUFFIX) || dirent.name.endsWith(".tmp")) continue;
        if (dirent.name.startsWith(".probe-")) continue;
        if (library?.recordsAtPath(full).some((record) => record.file.root === "external")) continue;
        const stat = await fs.stat(full);
        entries.push({ rel: path.relative(root, full), source: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(path.join(root, GENERATIONS_DIR), (dirent) => dirent.isDirectory() && DAY_FOLDER.test(dirent.name));
  await walk(path.join(root, EDITS_DIR), (dirent) => dirent.isFile() && dirent.name.toLowerCase().endsWith(".nbedit"));
  await walk(data);
  return entries;
}

async function removeEmptyDirs(dirs: Iterable<string>, stopAt: string): Promise<void> {
  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    let current = dir;
    while (isInsideRoot(stopAt, current)) {
      try {
        await fs.rmdir(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
}

export interface MoveDeps {
  library: AssetLibrary;
  /** Resolves true once no write (recording, edit, snapshot) is in flight; false on timeout. */
  waitForWrites(timeoutMs: number): Promise<boolean>;
  toRoot: string;
  setPaused(paused: boolean): void;
  /** Persists the new root and swaps the server over to it. */
  switchRoot(toRoot: string): Promise<void>;
  /**
   * How long the lock is kept after the switch: long enough for another
   * process, refused meanwhile, to have re-read library.json by the time it
   * may write again (so it never writes into the old root).
   */
  settleMs?: number;
  /** How long to wait for writes another process began before the lock (default a minute). */
  otherWritersTimeoutMs?: number;
}

interface MoveMarker {
  v: 1;
  toRoot: string;
  startedAt: number;
  pid: number;
  /** `copying` until the switch starts; only a move stopped while copying left a partial copy to remove. */
  state: "copying" | "switching";
}

/** Re-scans before the switch for writes that were in flight elsewhere when the lock was taken. */
const MOVE_RESCAN_PASSES = 3;

function relKey(rel: string): string {
  return rel.split(path.sep).join("/");
}

/** A target path the move may have written: inside the target's Generations, Edits or data folder. */
function movedPath(toRoot: string, rel: string): string | null {
  const dest = path.join(toRoot, ...rel.split("/"));
  const inside = [GENERATIONS_DIR, EDITS_DIR, DATA_DIR].some((dir) => isInsideRoot(path.join(toRoot, dir), dest));
  return inside ? dest : null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Copies the library-owned files to the new root from a manifest, verifying
 * size and hash per file, with recording (and every other write) paused —
 * in this process by the pause, in the other build by the "move" lock,
 * once the writes that build began before the lock have landed — then
 * re-scans for anything that changed while it copied. Switches the
 * root only once everything verified; then deletes exactly the files it
 * copied from the old root. A failure or cancel before the switch removes
 * the copies and leaves the old library untouched.
 *
 * `move.json` and `move-copied.ndjson` in the source's data folder (and
 * `move-source.json` in the target's) record the move while it runs, so one
 * stopped by the app quitting or crashing is found and undone at the next
 * start ({@link recoverInterruptedMove}), and the same target can be used
 * again.
 */
export async function runMove(ctx: JobContext, deps: MoveDeps): Promise<string> {
  const from = deps.library;
  const fromRoot = from.root;
  const toRoot = deps.toRoot;
  const markerFile = path.join(from.layout.data, MOVE_MARKER);
  const logFile = path.join(from.layout.data, MOVE_LOG);
  const targetMarker = path.join(toRoot, DATA_DIR, MOVE_SOURCE_MARKER);
  deps.setPaused(true);
  const copied = new Map<string, { source: string; dest: string; size: number; mtimeMs: number }>();
  let lock: Awaited<ReturnType<typeof acquireLock>> = null;
  /** The markers are this move's: until then they may be another build's live move, not ours to remove. */
  let ownsMarkers = false;
  let switched = false;
  let switchedAt = 0;
  try {
    if (!(await deps.waitForWrites(60_000))) {
      throw new LibraryError("Recordings are still being saved. Try again in a moment.", 409, "busy");
    }
    lock = await acquireLock(from.layout.lock, { heartbeat: true, purpose: "move" });
    if (!lock) throw new LibraryError("The library is busy in another window. Try again in a moment.", 409, "busy");
    await from.drain();
    // Markers left while we hold the lock are a move whose process died part-way: undo it
    // first, rather than write over the record of what it copied.
    if (await exists(markerFile)) await recoverMoveLocked(fromRoot, markerFile, logFile);
    // Writes the other build began before the lock (a recording still uploading, an edit)
    // land in this root: wait for them, so the copy has them. Later ones are refused.
    if (!(await from.waitForOtherWriters(deps.otherWritersTimeoutMs ?? 60_000))) {
      throw new LibraryError("Recordings are still being saved in another window. Try again in a moment.", 409, "busy");
    }

    const marker: MoveMarker = { v: 1, toRoot, startedAt: Date.now(), pid: process.pid, state: "copying" };
    await atomicWriteFile(markerFile, JSON.stringify(marker), { fsync: true });
    ownsMarkers = true;
    await fs.writeFile(logFile, "");
    await fs.mkdir(path.join(toRoot, DATA_DIR), { recursive: true });
    await atomicWriteFile(targetMarker, JSON.stringify({ fromRoot, startedAt: marker.startedAt }), { fsync: true });

    let total = 0;
    let bytesTotal = 0;
    const copyAll = async (entries: ManifestEntry[]) => {
      total += entries.length;
      bytesTotal += entries.reduce((sum, entry) => sum + entry.size, 0);
      ctx.update({ total, bytesTotal });
      for (const entry of entries) {
        ctx.checkCancelled();
        const rel = relKey(entry.rel);
        const dest = movedPath(toRoot, rel);
        if (!dest) continue;
        // Logged before the copy, so a stop part-way still knows every file it may have left.
        await fs.appendFile(logFile, `${JSON.stringify(rel)}\n`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await copyFileVerified(entry.source, dest, { signal: ctx.signal, onBytes: (bytes) => ctx.addBytes(bytes) });
        copied.set(rel, { source: entry.source, dest, size: entry.size, mtimeMs: entry.mtimeMs });
        ctx.step();
      }
    };
    await copyAll(await buildManifest(fromRoot, from));
    for (let pass = 0; pass < MOVE_RESCAN_PASSES; pass++) {
      const now = await buildManifest(fromRoot, from);
      const present = new Set(now.map((entry) => relKey(entry.rel)));
      for (const [rel, { dest }] of copied) {
        if (present.has(rel)) continue;
        // Deleted (or trashed for good) since it was copied.
        await unlinkWithRetry(dest).catch(() => {});
        copied.delete(rel);
      }
      const changed = now.filter((entry) => {
        const done = copied.get(relKey(entry.rel));
        return !done || done.size !== entry.size || done.mtimeMs !== entry.mtimeMs;
      });
      if (!changed.length) break;
      await copyAll(changed);
    }
    ctx.checkCancelled();
    await atomicWriteFile(markerFile, JSON.stringify({ ...marker, state: "switching" }), { fsync: true });
    await deps.switchRoot(toRoot);
    switched = true;
    switchedAt = Date.now();
    // The target is the library now, not a partial copy.
    await unlinkWithRetry(targetMarker).catch(() => {});
    deps.setPaused(false);
  } catch (error) {
    if (!switched && ownsMarkers) {
      for (const { dest } of copied.values()) await unlinkWithRetry(dest).catch(() => {});
      await unlinkWithRetry(targetMarker).catch(() => {});
      await removeEmptyDirs([...[...copied.values()].map(({ dest }) => path.dirname(dest)), path.join(toRoot, DATA_DIR)], toRoot);
      await unlinkWithRetry(markerFile).catch(() => {});
      await unlinkWithRetry(logFile).catch(() => {});
    }
    await lock?.release();
    deps.setPaused(false);
    throw error;
  }

  // Still holding the lock: the other build's writes are refused until it has followed the switch.
  let leftovers = 0;
  try {
    for (const { source } of copied.values()) {
      try {
        await unlinkWithRetry(source);
      } catch {
        leftovers++;
      }
    }
    const settle = switchedAt + (deps.settleMs ?? 0) - Date.now();
    if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
  } finally {
    await lock?.release();
    await unlinkWithRetry(markerFile).catch(() => {});
    await unlinkWithRetry(logFile).catch(() => {});
  }
  // Never copied, and empty once the writes it named have landed (as the pending-release folder is once
  // what it noted was released); the data folder can go only after them.
  for (const dir of [from.layout.writers, from.layout.pendingReleases]) await fs.rmdir(dir).catch(() => {});
  await removeEmptyDirs([...[...copied.values()].map(({ source }) => path.dirname(source)), from.layout.data], fromRoot);
  const moved = `Moved ${copied.size} ${copied.size === 1 ? "file" : "files"}.`;
  return leftovers
    ? `${moved} ${leftovers} could not be removed from the old folder (${fromRoot}); they are safe to delete.`
    : moved;
}

/**
 * Finds a move of this library that stopped part-way — the app quit, was
 * restarted or crashed while copying — and removes what it had copied into
 * the target (exactly the files its log names, and their partial files), so
 * the library stays here, whole, and the same target can be chosen again.
 * Returns the target it cleaned, or null when there was nothing to recover
 * (or a move is still running in some process).
 */
export async function recoverInterruptedMove(library: AssetLibrary): Promise<{ toRoot: string } | null> {
  const data = library.layout.data;
  const markerFile = path.join(data, MOVE_MARKER);
  const logFile = path.join(data, MOVE_LOG);
  const ownMarker = path.join(data, MOVE_SOURCE_MARKER);
  // This root is the live library: whatever move copied into it finished its switch.
  if (await exists(ownMarker)) await unlinkWithRetry(ownMarker).catch(() => {});
  if (!(await exists(markerFile))) return null;
  // Held while recovering, so no move starts (and writes new markers) halfway; a live holder means
  // the move is still running somewhere, and a dead one's lock is taken over.
  const lock = await acquireLock(library.layout.lock, { purpose: "move" });
  if (!lock) return null;
  try {
    return await recoverMoveLocked(library.root, markerFile, logFile);
  } finally {
    await lock.release();
  }
}

async function recoverMoveLocked(root: string, markerFile: string, logFile: string): Promise<{ toRoot: string } | null> {
  const marker = await readJson<Partial<MoveMarker>>(markerFile);
  const toRoot = typeof marker?.toRoot === "string" && path.isAbsolute(marker.toRoot) ? path.resolve(marker.toRoot) : null;
  let recovered: { toRoot: string } | null = null;
  if (toRoot) {
    // The target still carries this move's marker only while it has never been the live library
    // (starting a library removes it), so what it holds is only this move's copy.
    const target = await readJson<{ fromRoot?: unknown }>(path.join(toRoot, DATA_DIR, MOVE_SOURCE_MARKER));
    if (typeof target?.fromRoot === "string" && pathKey(target.fromRoot) === pathKey(root)) {
      let rels: string[] = [];
      try {
        rels = (await fs.readFile(logFile, "utf8"))
          .split("\n")
          .flatMap((line) => {
            try {
              const rel = JSON.parse(line) as unknown;
              return typeof rel === "string" ? [rel] : [];
            } catch {
              return [];
            }
          });
      } catch {
        rels = [];
      }
      const dirs = new Set<string>();
      for (const rel of rels) {
        const dest = movedPath(toRoot, rel);
        if (!dest) continue;
        dirs.add(path.dirname(dest));
        await unlinkWithRetry(dest).catch(() => {});
      }
      // The file that was being copied when it stopped.
      for (const dir of dirs) await sweepStaleTemps(dir, 0);
      await unlinkWithRetry(path.join(toRoot, DATA_DIR, MOVE_SOURCE_MARKER)).catch(() => {});
      await removeEmptyDirs([...dirs, path.join(toRoot, DATA_DIR)], toRoot);
      recovered = { toRoot };
    }
  }
  await unlinkWithRetry(markerFile).catch(() => {});
  await unlinkWithRetry(logFile).catch(() => {});
  return recovered;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A folder a move into it stopped part-way, still marked as that move's target. */
export async function isUnfinishedMoveTarget(root: string): Promise<boolean> {
  return exists(path.join(root, DATA_DIR, MOVE_SOURCE_MARKER));
}
