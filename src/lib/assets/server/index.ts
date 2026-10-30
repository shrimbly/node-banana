/**
 * Server-side asset library: the facade the /api/assets routes call.
 *
 * Internal modules live next to this file (paths, fsutil, validate, media,
 * layout, library, search, workflows, runs, ingest, download, thumbs, jobs,
 * projects, readable, desktop, registry, known, projectMove). Routes import only from here and must not reach into them.
 *
 * All functions throw `LibraryError` for expected failures; routes map
 * `status` to the HTTP status and `message` to `{ error }` (and send
 * `Retry-After` when `retryAfter` is set, e.g. code "paused" during a move).
 *
 * State lives in one runtime object on `globalThis`, so Next's per-route
 * module copies and dev reloads share one index, one ticket table and one
 * job runner per process.
 */

import { promises as fs } from "fs";
import path from "path";
import type {
  AssetBulkRequest,
  AssetBulkResult,
  AssetExistence,
  AssetFacets,
  AssetPage,
  AssetPageRequest,
  AssetPatch,
  AssetRecord,
  AssetView,
  AssetWorkflowResult,
  BringInProjectsRequest,
  BringInProjectsResult,
  CleanupRequest,
  ExportAssetsRequest,
  ImportProjectsRequest,
  KnownProject,
  LibraryJobStatus,
  LibraryStatus,
  LibraryWorkflowEntry,
  ProjectFolderName,
  ProjectsOfferRequest,
  ProjectsOverview,
  PutRunRequest,
  PutRunResult,
  RecordAssetRequest,
  RecordAssetResult,
  ReportProjectsRequest,
  ReportProjectsResult,
  ScanProjectsRequest,
  ScanProjectsResult,
  SetLibraryRootRequest,
  UploadTicket,
  WorkflowEntryUpdate,
} from "../types";
import { MAX_IMPORT_PROJECTS } from "../types";
import { openFolder, revealFile } from "./desktop";
import { LibraryError, pausedError } from "./errors";
import { hideOnWindows, isInsideRoot, mapConcurrent, pathKey, sweepStaleTemps } from "./fsutil";
import { Ingestor, STALE_PARTIAL_MS } from "./ingest";
import {
  isUnfinishedMoveTarget,
  JobRunner,
  normaliseImportDirs,
  prepareExportDest,
  recoverInterruptedMove,
  runCleanup,
  runExport,
  runImport,
  runMove,
  validateMoveTarget,
  type JobContext,
} from "./jobs";
import {
  folderBytes,
  generationsStamp,
  listKnownProjects,
  looksLikeProjectsFolder,
  outermost,
  projectFolderName,
  sizeBudget,
  summariseElsewhere,
} from "./known";
import { libraryLayout } from "./layout";
import { AssetLibrary } from "./library";
import {
  currentPathContext,
  envVar,
  initLibraryLocation,
  isHostedServer,
  detectSynced,
  pathApi,
  probeWritable,
  resetPathCachesForTests,
  writeLibraryConfig,
  type LocationResult,
  type PathContext,
  type ResolvedLocation,
} from "./paths";
import { normaliseMoveDirs, recoverProjectMove, runProjectsMove, unfinishedProjectCopy } from "./projectMove";
import { findProjects, resolveScanRoot } from "./projects";
import { assessReadable, findUnreadable } from "./readable";
import { ProjectRegistry, registryDir } from "./registry";
import { runMeta } from "./runs";
import { Thumbnailer } from "./thumbs";
import { extOf, isAssetId, isMediaExtension, isSha256, requireSha256 } from "./validate";

export { LibraryError } from "./errors";

/** A file the route streams to the client (supports Range). */
export interface ServedFile {
  path: string;
  mime: string;
  bytes: number;
  /** ETag source. */
  sha256: string;
  /** Suggested download name. */
  filename: string;
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

const RUNTIME_VERSION = 2;
const HOSTED_REASON = "The asset library needs Node Banana running on your own computer.";
/** How often a healthy location is checked for its data folder (a drive can be unplugged). */
const RECHECK_OK_MS = 60_000;
/** How often an unavailable location is retried (a drive can be plugged back in). */
const RECHECK_FAILED_MS = 10_000;
/** How often library.json is stat'ed for a switch made by the other build. */
const CONFIG_STAMP_MS = 2_000;
/** A move keeps its lock this long after switching, so the other build has re-read library.json before it writes again. */
const MOVE_SETTLE_MS = CONFIG_STAMP_MS + 500;
/** How soon the auto-index looks again when another job (or a move) was in its way. */
const AUTO_INDEX_RETRY_MS = 30_000;

interface ResolvedState {
  key: string;
  result: LocationResult;
  checkedAt: number;
  stampAt: number;
  configStamp: string;
}

interface Runtime {
  version: number;
  ctxOverride: PathContext | null;
  resolved: ResolvedState | null;
  resolving: Promise<LocationResult> | null;
  library: AssetLibrary | null;
  thumbs: Thumbnailer | null;
  ingest: Ingestor;
  jobs: JobRunner;
  paused: boolean;
  /** Writes other than recordings in flight (edits, snapshots, media, workflow rows). */
  writes: number;
  writeWaiters: (() => void)[];
  initialised: Set<string>;
  background: Set<Promise<unknown>>;
  /** One per registry file, so this process's changes to it are serialised. */
  registries: Map<string, ProjectRegistry>;
  autoIndex: { running: boolean; again: boolean; retry: ReturnType<typeof setTimeout> | null };
}

const globalState = globalThis as typeof globalThis & { __nodeBananaAssetLibrary?: Runtime };

function createRuntime(): Runtime {
  const rt = {
    version: RUNTIME_VERSION,
    ctxOverride: null,
    resolved: null,
    resolving: null,
    library: null,
    thumbs: null,
    jobs: new JobRunner(),
    paused: false,
    writes: 0,
    writeWaiters: [],
    initialised: new Set<string>(),
    background: new Set<Promise<unknown>>(),
    registries: new Map<string, ProjectRegistry>(),
    autoIndex: { running: false, again: false, retry: null },
  } as unknown as Runtime;
  rt.ingest = new Ingestor({
    library: () => {
      if (!rt.library) throw new LibraryError("The asset library is not available", 503, "unavailable");
      return rt.library;
    },
    thumbs: () => rt.thumbs,
    isPaused: () => rt.paused,
  });
  return rt;
}

function runtime(): Runtime {
  const existing = globalState.__nodeBananaAssetLibrary;
  // After a dev reload the object may come from an older version of this module.
  if (existing && existing.version === RUNTIME_VERSION) return existing;
  const created = createRuntime();
  globalState.__nodeBananaAssetLibrary = created;
  return created;
}

function track(rt: Runtime, promise: Promise<unknown>): void {
  const tracked = promise.catch((error) => console.warn("[assets]", error)).finally(() => rt.background.delete(tracked));
  rt.background.add(tracked);
}

function pathContext(rt: Runtime): PathContext {
  return rt.ctxOverride ?? currentPathContext();
}

function contextKey(ctx: PathContext): string {
  return [
    ctx.platform,
    ctx.homedir,
    envVar(ctx, "NODE_BANANA_ASSET_LIBRARY") ?? "",
    envVar(ctx, "NODE_BANANA_DEFAULT_LIBRARY") ?? "",
  ].join("\0");
}

async function fileStamp(file: string | undefined): Promise<string> {
  if (!file) return "";
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

/**
 * The current location, re-resolved when the environment changed, when
 * library.json changed (the other build switched or moved the library), and
 * periodically so an unplugged or reconnected drive is noticed.
 */
async function activeLocation(rt: Runtime): Promise<LocationResult> {
  const ctx = pathContext(rt);
  const key = contextKey(ctx);
  const now = Date.now();
  const state = rt.resolved;
  if (state && state.key === key) {
    const age = now - state.checkedAt;
    let fresh = state.result.ok ? true : age < RECHECK_FAILED_MS;
    if (state.result.ok && age >= RECHECK_OK_MS) {
      // A cheap look rather than a write probe, so a synced folder doesn't churn.
      fresh = (await fileStamp(path.join(state.result.location.root, ".nodebanana"))) !== "absent";
      if (fresh) state.checkedAt = now;
    }
    if (fresh) {
      if (now - state.stampAt < CONFIG_STAMP_MS) return state.result;
      const stamp = await fileStamp(state.result.location?.configFile);
      state.stampAt = now;
      if (stamp === state.configStamp) return state.result;
    }
  }
  rt.resolving ??= (async () => {
    try {
      const result = await initLibraryLocation(ctx);
      rt.resolved = {
        key,
        result,
        checkedAt: Date.now(),
        stampAt: Date.now(),
        configStamp: await fileStamp(result.location?.configFile),
      };
      return result;
    } finally {
      rt.resolving = null;
    }
  })();
  return rt.resolving;
}

/** The index for a location, created (and initialised in the background) on first use. */
function libraryFor(rt: Runtime, location: ResolvedLocation): AssetLibrary {
  if (!rt.library || rt.library.root !== location.root) {
    const previous = rt.library;
    rt.library = new AssetLibrary(location.root);
    if (previous) track(rt, previous.drain());
  }
  if (!rt.thumbs || rt.thumbs.dir !== path.join(location.cacheDir, "thumbs")) {
    rt.thumbs = new Thumbnailer(location.cacheDir, () => rt.library, {
      onUndecodable: (sha256, file) => track(rt, markUndecodable(rt, sha256, file)),
    });
  }
  const library = rt.library;
  if (!rt.initialised.has(location.root)) {
    rt.initialised.add(location.root);
    track(rt, initialiseRoot(rt, library));
  }
  return library;
}

/**
 * Once per root and process: the library marker, hidden data folder on
 * Windows, recovery of a move that stopped part-way, a sweep of stale
 * partial files, the index scan (then, off to the side, a look at the files
 * of records that may be unreadable), then auto-empty of Trash items older
 * than 30 days and a thumbnail cache trim.
 */
async function initialiseRoot(rt: Runtime, library: AssetLibrary): Promise<void> {
  const layout = library.layout;
  await fs.mkdir(layout.assets, { recursive: true });
  hideOnWindows(layout.data);
  try {
    await fs.writeFile(layout.libraryFile, `${JSON.stringify({ v: 1, createdAt: Date.now() })}\n`, { flag: "wx" });
  } catch {
    // Already marked.
  }
  await noteInterruptedMove(rt, library);
  // A project move quitting cut short: its partial copy goes before anything lists it.
  if (!rt.jobs.isRunning) await recoverProjectMove(layout.root);
  await library.ensureLoaded();
  track(rt, findUnreadable(library).then((ids) => markUnreadable(rt, library, ids)));
  const dirs = [layout.data, layout.assets, layout.runs, layout.media, layout.posters, layout.pendingReleases];
  try {
    for (const day of await fs.readdir(layout.generations)) dirs.push(path.join(layout.generations, day));
  } catch {
    // No generations yet.
  }
  for (const dir of dirs) await sweepStaleTemps(dir, STALE_PARTIAL_MS);
  if (!rt.paused && !(await library.movingElsewhere())) {
    await counted(rt, () => library.writing(() => library.emptyExpiredTrash()));
  }
  await rt.thumbs?.trim();
  scheduleAutoIndex(rt);
}

/**
 * Marks records whose bytes nothing can open, so they are no longer listed.
 * Counted and published like any write; skipped (not queued) while a move
 * runs — the flag can always be found again, and the next start looks again.
 */
async function markUnreadable(rt: Runtime, library: AssetLibrary, ids: readonly string[]): Promise<void> {
  if (!ids.length || rt.paused || rt.library !== library) return;
  try {
    if (await library.movingElsewhere()) return;
    await counted(rt, () => library.writing(() => library.markUnreadable(ids)));
  } catch (error) {
    if (error instanceof LibraryError && error.code === "paused") return;
    throw error;
  }
}

/**
 * sharp could not decode an image asset's file while making its thumbnail.
 * Its records are marked only if the file is unreadable by the same careful
 * test as everywhere else (readable.ts), not on the strength of one failure.
 */
async function markUndecodable(rt: Runtime, sha256: string, file: string): Promise<void> {
  const library = rt.library;
  if (!library) return;
  const records = library.recordsWithHash(sha256).filter((record) => record.kind === "image" && !record.unreadable);
  // Same hash, same size: a file of another size is no longer these records' bytes.
  if (!records.length || (await assessReadable(file, "image", records[0].bytes)) !== "unreadable") return;
  await markUnreadable(rt, library, records.map((record) => record.id));
}

/** Undoes a move of this library that stopped part-way, and says so in the library status. */
async function noteInterruptedMove(rt: Runtime, library: AssetLibrary): Promise<void> {
  const recovered = await recoverInterruptedMove(library);
  if (!recovered) return;
  rt.jobs.note("move", {
    error:
      `Moving the library to "${recovered.toRoot}" was interrupted before it finished. ` +
      "Your library is still here, and the partial copy there was removed. You can move it again.",
  });
}

async function availableLibrary(rt: Runtime): Promise<{ library: AssetLibrary; location: ResolvedLocation }> {
  if (isHostedServer()) throw new LibraryError(HOSTED_REASON, 503, "unavailable");
  const result = await activeLocation(rt);
  if (!result.ok) throw new LibraryError(result.reason, 503, "unavailable");
  return { library: libraryFor(rt, result.location), location: result.location };
}

async function readyLibrary(): Promise<AssetLibrary> {
  const { library } = await availableLibrary(runtime());
  await library.ready();
  return library;
}

/** Writes wait while a move copies the library (they would be lost from the copy). */
function assertWritable(rt: Runtime): void {
  if (rt.paused) throw pausedError();
}

/** Writes also wait while the other build moves this library (its lock says so). */
async function assertNoMoveElsewhere(library: AssetLibrary): Promise<void> {
  if (await library.movingElsewhere()) throw pausedError();
}

/**
 * Runs a write against the ready library, counted so a move here can wait
 * for it, and published so a move in the other build can too. The pause
 * check and the count happen with no await between them.
 */
async function write<T>(fn: (library: AssetLibrary) => Promise<T>): Promise<T> {
  const rt = runtime();
  assertWritable(rt);
  const library = await readyLibrary();
  await assertNoMoveElsewhere(library);
  return counted(rt, () => library.writing(() => fn(library)));
}

/** The active library root, for reads. Throws 503 "unavailable" when there is no library (hosted, or the root can't be used). */
export async function libraryRootForRead(): Promise<string> {
  return (await availableLibrary(runtime())).location.root;
}

/**
 * Runs `fn` with the active root as a counted library write, for files the
 * library keeps beside its own (the edit files): refused with 503 "paused"
 * while a move copies, and waited for by a move.
 */
export async function writeInLibraryRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return write((library) => fn(library.root));
}

/** Counts `fn` as an in-flight write (after checking the pause, synchronously). */
async function counted<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
  assertWritable(rt);
  rt.writes++;
  try {
    return await fn();
  } finally {
    rt.writes--;
    if (rt.writes === 0) {
      const waiters = rt.writeWaiters;
      rt.writeWaiters = [];
      waiters.forEach((wake) => wake());
    }
  }
}

/** Resolves once no recording or other write is in flight (false after `timeoutMs`). */
async function waitForWrites(rt: Runtime, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (!(await rt.ingest.waitIdle(timeoutMs))) return false;
  if (rt.writes === 0) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    rt.writeWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/* Location and status ------------------------------------------------ */

function emptyStatus(reason: string, reasonCode: NonNullable<LibraryStatus["reasonCode"]>, platform: string): LibraryStatus {
  return {
    available: false,
    reason,
    reasonCode,
    root: null,
    source: "default",
    defaultRoot: "",
    cacheDir: "",
    platform,
    synced: null,
    counts: { assets: 0, trashed: 0, bytes: 0 },
    empty: true,
    job: null,
  };
}

/** A cheap "anything recorded yet?" while the first scan is still running. */
async function hasAnySidecar(assetsDir: string): Promise<boolean> {
  let dir: import("fs").Dir | null = null;
  try {
    dir = await fs.opendir(assetsDir);
    for (let checked = 0; checked < 64; checked++) {
      const entry = await dir.read();
      if (!entry) return false;
      if (/^a[0-9a-z]{12,24}\.json$/.test(entry.name)) return true;
    }
    return true;
  } catch {
    return false;
  } finally {
    await dir?.close().catch(() => {});
  }
}

/**
 * Resolves (and on first use, creates and persists) the library root. Never
 * throws for an unwritable root: returns `available: false` with a reason,
 * and a `reasonCode` that tells a lasting answer ("hosted") from one worth
 * asking again ("unwritable", "unavailable").
 */
export async function getLibraryStatus(): Promise<LibraryStatus> {
  const rt = runtime();
  const ctx = pathContext(rt);
  if (isHostedServer()) return emptyStatus(HOSTED_REASON, "hosted", ctx.platform);
  try {
    const result = await activeLocation(rt);
    const location = result.location;
    const base = {
      root: location?.root ?? null,
      source: location?.source ?? "default",
      defaultRoot: location?.defaultRoot ?? "",
      ...(location?.fallbackReason ? { fallbackReason: location.fallbackReason } : {}),
      cacheDir: location?.cacheDir ?? "",
      platform: ctx.platform,
      synced: location ? detectSynced(location.root, ctx) : null,
      job: rt.jobs.visible(),
    };
    if (!result.ok || !location) {
      return {
        ...base,
        available: false,
        reason: result.ok ? "Unavailable" : result.reason,
        reasonCode: result.ok ? "unavailable" : result.code,
        counts: { assets: 0, trashed: 0, bytes: 0 },
        empty: true,
      };
    }
    const library = libraryFor(rt, location);
    // Kick off the scan; answer with counts if it finishes quickly.
    const loading = library.ensureLoaded().then(() => library.refresh());
    loading.catch(() => {});
    await Promise.race([loading, new Promise((resolve) => setTimeout(resolve, 1500))]);
    const counts = library.loaded ? library.stats() : { assets: 0, trashed: 0, bytes: 0 };
    const empty = library.loaded ? library.isEmpty() : !(await hasAnySidecar(library.layout.assets));
    // Still scanning: the zeros are not the library's, and the page must not show them as fact.
    return { ...base, available: true, counts, empty, job: rt.jobs.visible(), ...(library.loaded ? {} : { counting: true }) };
  } catch (error) {
    return emptyStatus(error instanceof Error ? error.message : String(error), "unavailable", ctx.platform);
  }
}

/** `switch` changes the root now; `move` starts a background move job and switches when it verifies. */
export async function setLibraryRoot(request: SetLibraryRootRequest): Promise<LibraryStatus> {
  const rt = runtime();
  if (isHostedServer()) throw new LibraryError(HOSTED_REASON, 503, "unavailable");
  if (!request || typeof request !== "object" || (request.mode !== "move" && request.mode !== "switch")) {
    throw new LibraryError("mode must be move or switch", 400, "bad_request");
  }
  const ctx = pathContext(rt);
  const result = await activeLocation(rt);
  const location = result.location;
  if (location?.source === "env") {
    throw new LibraryError(
      "The library folder is set by NODE_BANANA_ASSET_LIBRARY, so it can't be changed here.",
      409,
      "forbidden",
    );
  }
  // The auto-index makes way: the user never sees it, so it must never refuse them.
  await rt.jobs.yieldQuiet();
  if (rt.jobs.isRunning) {
    throw new LibraryError("Another library task is running. Wait for it to finish or cancel it.", 409, "busy");
  }
  const api = pathApi(ctx.platform);
  if (typeof request.root !== "string" || !api.isAbsolute(request.root) || request.root.includes("\0")) {
    throw new LibraryError("Choose a folder for the library", 400, "bad_request");
  }
  const configFile = location?.configFile;
  if (!configFile) throw new LibraryError("The library location can't be changed", 500, "unavailable");

  const switchTo = async (root: string) => {
    await writeLibraryConfig(configFile, { root, setBy: "user" });
    rt.resolved = null;
    const next = await activeLocation(rt);
    if (next.ok) libraryFor(rt, next.location);
    // A root this process used before is not initialised again, so its projects are looked at here.
    scheduleAutoIndex(rt);
  };

  if (request.mode === "switch") {
    const root = api.resolve(request.root);
    if (location && root === location.root) return getLibraryStatus();
    if (await isUnfinishedMoveTarget(root)) {
      throw new LibraryError(
        "That folder holds a library move that didn't finish, so it isn't a whole library. Move the library there again, or choose another folder.",
        409,
        "conflict",
      );
    }
    const failure = await probeWritable(root);
    if (failure) {
      throw new LibraryError(`Node Banana can't write to "${root}" (${failure.code}).`, 400, "bad_request");
    }
    await switchTo(root);
    return getLibraryStatus();
  }

  if (!result.ok || !location) throw new LibraryError(result.ok ? "Unavailable" : result.reason, 503, "unavailable");
  const library = libraryFor(rt, location);
  await library.ready();
  // A retry after a move that stopped part-way: its partial copy goes first, so the same folder is accepted.
  await noteInterruptedMove(rt, library);
  const toRoot = await validateMoveTarget(location.root, request.root, ctx.platform);
  const failure = await probeWritable(toRoot);
  if (failure) throw new LibraryError(`Node Banana can't write to "${toRoot}" (${failure.code}).`, 400, "bad_request");
  // The old folder's projects that follow the library, checked now so a folder that can't move is left out up front.
  const projectDirs = await movableProjects(request.projects, toRoot, ctx.homedir);
  // The probe leaves an empty data folder behind; the move copies into it.
  await rt.jobs.startOverQuiet("move", async (job) => {
    const message = await runMove(job, {
      library,
      waitForWrites: (timeoutMs) => waitForWrites(rt, timeoutMs),
      toRoot,
      setPaused: (paused) => {
        rt.paused = paused;
      },
      switchRoot: switchTo,
      settleMs: MOVE_SETTLE_MS,
    });
    if (!projectDirs.length) return message;
    return [message, await followWithProjects(rt, job, projectDirs, toRoot)].filter(Boolean).join(" ");
  });
  return getLibraryStatus();
}

/** The folders of `value` a projects move into `root` would take; the rest are left where they are. */
async function movableProjects(value: unknown, root: string, home: string): Promise<string[]> {
  if (!Array.isArray(value) || !value.length) return [];
  const dirs: string[] = [];
  for (const dir of value) {
    try {
      dirs.push(...(await normaliseMoveDirs([dir], root, { home })));
    } catch {
      // Gone, or more than a project: it stays, still listed where it is.
    }
  }
  return outermost(dirs);
}

/**
 * "Move everything there": once the library has moved, the old folder's
 * projects move into the new one as the same job, so the page that asked
 * can close. A failure here leaves the library moved and says so.
 */
async function followWithProjects(rt: Runtime, job: JobContext, dirs: readonly string[], toRoot: string): Promise<string> {
  const next = await activeLocation(rt);
  if (!next.ok || pathKey(next.location.root) !== pathKey(toRoot)) return "The projects stayed in the old folder.";
  const present: string[] = [];
  for (const dir of dirs) if (await isDirectory(dir)) present.push(dir);
  if (!present.length) return "";
  job.update({ done: 0, bytesDone: 0 });
  const location = next.location;
  try {
    return await runProjectsMove(job, { library: libraryFor(rt, location), root: location.root, registry: registryFor(rt, location) }, present);
  } catch (error) {
    if (error instanceof LibraryError && error.code === "cancelled") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return `The projects didn't all move: ${reason}`;
  }
}

/* Browsing ----------------------------------------------------------- */

export async function listAssets(request: AssetPageRequest): Promise<AssetPage> {
  const library = await readyLibrary();
  return library.query(request ?? {});
}

export async function getFacets(): Promise<AssetFacets> {
  const library = await readyLibrary();
  return library.facets();
}

export async function getAsset(id: string): Promise<AssetView | null> {
  if (!isAssetId(id)) return null;
  const library = await readyLibrary();
  const record = await library.find(id);
  if (!record) return null;
  await library.verifyFiles([record]);
  return library.toView(record);
}

/**
 * What node `nodeId` of workflow `workflowId` saved in its newest `runs`
 * runs, newest first: the results of a node that keeps no carousel of asset
 * ids (a ComfyUI app, the image and video tools). Trashed ones count, since
 * the node still shows its last result.
 */
export async function newestFromNode(workflowId: string, nodeId: string, runs: number): Promise<AssetView[]> {
  if (!workflowId || !nodeId || runs < 1) return [];
  const library = await readyLibrary();
  const found: AssetRecord[] = [];
  const seenRuns = new Set<string>();
  for (const record of library.allRecords()) {
    if (record.workflowId !== workflowId || record.producer?.nodeId !== nodeId || record.unreadable) continue;
    // A run can save several results (a ComfyUI app's outputs); each run counts once.
    const run = record.runId || record.id;
    if (!seenRuns.has(run)) {
      if (seenRuns.size >= runs) break;
      seenRuns.add(run);
    }
    found.push(record);
  }
  return found.map((record) => library.toView(record));
}

/** Never throws for an unavailable library: every id is then `unknown`. */
export async function assetExistence(ids: string[]): Promise<Record<string, AssetExistence>> {
  if (!Array.isArray(ids)) throw new LibraryError("ids must be a list", 400, "bad_request");
  const list = ids.filter((id): id is string => typeof id === "string").slice(0, 5000);
  try {
    const library = await readyLibrary();
    return await library.existence(list);
  } catch (error) {
    if (error instanceof LibraryError && error.code !== "unavailable") throw error;
    return Object.fromEntries(list.map((id) => [id, "unknown" as const]));
  }
}

/* Mutations ---------------------------------------------------------- */

export async function patchAsset(id: string, patch: AssetPatch): Promise<AssetView | null> {
  if (!isAssetId(id)) return null;
  return write((library) => library.patch(id, patch));
}

export async function bulkAssets(request: AssetBulkRequest): Promise<AssetBulkResult> {
  return write((library) => library.bulk(request));
}

/* Recording ---------------------------------------------------------- */

/** `upload` source → a ticket for PUT /uploads/[id]; `url` source → downloads and records now. */
export async function beginRecord(
  request: RecordAssetRequest,
): Promise<{ ticket: UploadTicket } | { result: RecordAssetResult }> {
  const rt = runtime();
  assertWritable(rt);
  await assertNoMoveElsewhere(await readyLibrary());
  return rt.ingest.begin(request);
}

/** Streams the upload body to disk while hashing, then finalises the record. */
export async function completeUpload(
  uploadId: string,
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
): Promise<RecordAssetResult> {
  const rt = runtime();
  // Refused before the ticket is used, so the client can resend it after Retry-After.
  await assertNoMoveElsewhere(await readyLibrary());
  return rt.ingest.complete(uploadId, body, contentType);
}

/* Files -------------------------------------------------------------- */

/** The record's file, re-checked: inside the library, or exactly the recorded external media path. */
async function verifiedFile(library: AssetLibrary, record: AssetRecord): Promise<{ file: string; bytes: number } | null> {
  const file = library.filePath(record);
  if (!file) return null;
  if (record.file.root === "library" && !isInsideRoot(library.root, file)) return null;
  if (record.file.root === "external" && (file !== record.file.path || !isMediaExtension(extOf(file)))) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      library.setMissing(record.id, true);
      return null;
    }
    library.setMissing(record.id, false);
    return { file, bytes: stat.size };
  } catch (error) {
    // Only "no such file" marks it missing; a permission or I/O error can't tell.
    library.noteFileError(record.id, error);
    return null;
  }
}

export async function openAssetFile(id: string): Promise<ServedFile | null> {
  if (!isAssetId(id)) return null;
  const library = await readyLibrary();
  const record = await library.find(id);
  if (!record) return null;
  const verified = await verifiedFile(library, record);
  if (!verified) return null;
  return { path: verified.file, mime: record.mime, bytes: verified.bytes, sha256: record.sha256, filename: record.filename };
}

/** Stores a browser-made poster (video/3D) and derives its thumbnails. */
export async function putPoster(id: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (!isAssetId(id)) throw new LibraryError("Invalid asset id", 400, "bad_request");
  const rt = runtime();
  await write(async (library) => {
    const record = await library.find(id);
    if (!record) throw new LibraryError("Asset not found", 404, "not_found");
    if (!rt.thumbs) throw new LibraryError("The asset library is not available", 503, "unavailable");
    await rt.thumbs.putPoster(record, bytes, mime);
    await library.setHasPoster(id);
  });
}

/** Returns a cached webp thumbnail, rendering it on a miss (bounded concurrency). Null → the client draws a placeholder. */
export async function getThumbnail(sha256: string, width: 320 | 640): Promise<ServedFile | null> {
  if (!isSha256(sha256)) return null;
  const rt = runtime();
  try {
    // Tiles don't need the journal replayed first; the thumbnail is keyed by content.
    const { library } = await availableLibrary(rt);
    await library.ensureLoaded();
  } catch {
    return null;
  }
  return (await rt.thumbs?.get(sha256, width)) ?? null;
}

export async function revealAsset(id: string): Promise<void> {
  if (!isAssetId(id)) throw new LibraryError("Invalid asset id", 400, "bad_request");
  const library = await readyLibrary();
  const record = await library.find(id);
  if (!record) throw new LibraryError("Asset not found", 404, "not_found");
  const verified = await verifiedFile(library, record);
  if (!verified) throw new LibraryError("The file can't be found where it was saved.", 404, "not_found");
  await revealFile(verified.file);
}

/** Opens the library root folder in Finder/Explorer. */
export async function revealLibraryRoot(): Promise<void> {
  const { library } = await availableLibrary(runtime());
  await fs.mkdir(library.root, { recursive: true });
  await openFolder(library.root);
}

/* Workflow snapshots ------------------------------------------------- */

export async function getAssetWorkflow(id: string): Promise<AssetWorkflowResult | null> {
  if (!isAssetId(id)) return null;
  const library = await readyLibrary();
  const record = await library.find(id);
  if (!record || record.imported) return null;
  const run = await library.runs.get(record.runId);
  if (!run) return null;
  const which = run.final ? "final" : run.start ? "start" : null;
  if (!which) return null;
  return { asset: library.toView(record), run: runMeta(run), which, workflow: run[which]! };
}

/** Returns the hashes the server does not hold. */
export async function mediaHas(hashes: string[]): Promise<string[]> {
  if (!Array.isArray(hashes)) throw new LibraryError("hashes must be a list", 400, "bad_request");
  const library = await readyLibrary();
  return library.runs.missing(hashes.filter(isSha256));
}

/** Stores snapshot media; verifies the body hashes to `sha256`. */
export async function putMedia(
  sha256: string,
  body: ReadableStream<Uint8Array>,
  mime: string,
): Promise<{ sha256: string; bytes: number }> {
  requireSha256(sha256);
  return write((library) => library.runs.putMedia(sha256, body, mime));
}

export async function openMedia(sha256: string): Promise<ServedFile | null> {
  if (!isSha256(sha256)) return null;
  const library = await readyLibrary();
  const media = await library.runs.openMedia(sha256);
  return media ? { ...media, sha256 } : null;
}

export async function putRun(runId: string, request: PutRunRequest): Promise<PutRunResult> {
  return write((library) => library.runs.put(runId, request));
}

export async function upsertWorkflowEntry(
  id: string,
  entry: WorkflowEntryUpdate,
): Promise<LibraryWorkflowEntry> {
  if (!entry || typeof entry !== "object") throw new LibraryError("Invalid workflow entry", 400, "bad_request");
  return write((library) =>
    library.upsertWorkflow(id, {
      name: typeof entry.name === "string" ? entry.name : null,
      projectPath: typeof entry.projectPath === "string" ? entry.projectPath : null,
      ...(entry.forkedFrom !== undefined ? { forkedFrom: entry.forkedFrom } : {}),
      ...(typeof entry.asOf === "number" && Number.isFinite(entry.asOf) ? { asOf: entry.asOf } : {}),
    }),
  );
}

/* Jobs --------------------------------------------------------------- */

export async function startImport(request: ImportProjectsRequest): Promise<LibraryJobStatus> {
  const rt = runtime();
  const dirs = normaliseImportDirs(request?.projectDirs);
  assertWritable(rt);
  const library = await readyLibrary();
  await assertNoMoveElsewhere(library);
  return rt.jobs.startOverQuiet("import", (job) => runImport(job, { library, thumbs: rt.thumbs }, dirs));
}

/**
 * The Node Banana projects under a folder, nested ones included, for the
 * import to offer (projects.ts). It only reads, so it runs during a move
 * too. The library's own Generations and data folders and the thumbnail
 * cache are never searched.
 */
export async function scanProjects(request: ScanProjectsRequest): Promise<ScanProjectsResult> {
  const rt = runtime();
  if (isHostedServer()) throw new LibraryError(HOSTED_REASON, 503, "unavailable");
  if (!request || typeof request !== "object") throw new LibraryError("Invalid request", 400, "bad_request");
  const root = await resolveScanRoot(request.root);
  // A library that isn't available still has folders to leave out.
  const location = (await activeLocation(rt).catch(() => null))?.location;
  const exclude: string[] = [];
  if (location) {
    const layout = libraryLayout(location.root);
    exclude.push(layout.generations, layout.data, location.cacheDir);
  }
  const result = await findProjects(root, { exclude });
  // What a bring-in shows: each project's size, and whether the folder already looks like a Node Banana folder.
  const budget = sizeBudget();
  const sizes = await mapConcurrent(result.projects, 4, (project) => folderBytes(project.dir, budget));
  return {
    ...result,
    projects: result.projects.map((project, index) => ({ ...project, bytes: sizes[index] })),
    recommendUse: await looksLikeProjectsFolder(root, result.projects.map((project) => project.dir)),
  };
}

export async function startCleanup(request: CleanupRequest): Promise<LibraryJobStatus> {
  const rt = runtime();
  const unusedMedia = request?.unusedMedia === true;
  const thumbnails = request?.thumbnails === true;
  if (!unusedMedia && !thumbnails) throw new LibraryError("Choose what to clean up", 400, "bad_request");
  assertWritable(rt);
  const library = await readyLibrary();
  await assertNoMoveElsewhere(library);
  return rt.jobs.startOverQuiet("cleanup", (job) => runCleanup(job, { library, thumbs: rt.thumbs }, { unusedMedia, thumbnails }));
}

export async function startExport(request: ExportAssetsRequest): Promise<LibraryJobStatus> {
  const rt = runtime();
  if (!request || typeof request !== "object") throw new LibraryError("Invalid request", 400, "bad_request");
  const library = await readyLibrary();
  const ids = library.resolveSelection(request.selection);
  if (!ids.length) throw new LibraryError("Nothing is selected", 400, "bad_request");
  const dest = await prepareExportDest(request.dest, library);
  return rt.jobs.startOverQuiet("export", (job) => runExport(job, library, ids, dest));
}

export function getJob(id: string): LibraryJobStatus | null {
  if (typeof id !== "string") return null;
  return runtime().jobs.get(id);
}

export function cancelJob(id: string): boolean {
  if (typeof id !== "string") return false;
  return runtime().jobs.cancel(id);
}

/* Projects ----------------------------------------------------------- */

function registryFor(rt: Runtime, location: ResolvedLocation): ProjectRegistry {
  let registry = rt.registries.get(location.registryFile);
  if (!registry) {
    registry = new ProjectRegistry(location.registryFile);
    rt.registries.set(location.registryFile, registry);
  }
  return registry;
}

/** The ready library with its location and registry. */
async function projectsContext(rt: Runtime): Promise<{ library: AssetLibrary; location: ResolvedLocation; registry: ProjectRegistry }> {
  const { library, location } = await availableLibrary(rt);
  await library.ready();
  return { library, location, registry: registryFor(rt, location) };
}

async function knownProjects(location: ResolvedLocation, library: AssetLibrary, registry: ProjectRegistry): Promise<KnownProject[]> {
  const layout = libraryLayout(location.root);
  // A project a move is still copying in isn't one yet (nor something to index).
  const copying = await unfinishedProjectCopy(location.root);
  return listKnownProjects({
    root: location.root,
    exclude: [layout.generations, layout.data, location.cacheDir, ...(copying ? [copying] : [])],
    registryDirs: (await registry.read()).projects.map((project) => project.dir),
    workflowDirs: library.workflowProjectPaths(),
  });
}

/** Library-owned assets (trashed ones too): what a library move would carry. */
function holdsLibraryAssets(library: AssetLibrary): boolean {
  return library.allRecords().some((record) => record.file.root === "library");
}

/**
 * Every project the app knows about, newest first, with the summary of the
 * ones that live outside the Node Banana folder for the "Move them in" offer.
 */
export async function listProjects(): Promise<ProjectsOverview> {
  const rt = runtime();
  const { library, location, registry } = await projectsContext(rt);
  const projects = await knownProjects(location, library, registry);
  const inRoot = outermost(projects.filter((project) => project.inRoot).map((project) => project.dir));
  const budget = sizeBudget();
  const [elsewhere, state, rootSizes] = await Promise.all([
    summariseElsewhere(projects, { home: pathContext(rt).homedir }),
    registry.read(),
    mapConcurrent(inRoot, 4, (dir) => folderBytes(dir, budget)),
  ]);
  const rootBytes = rootSizes.reduce((sum, size) => sum + size, 0);
  return { root: location.root, projects, elsewhere, offerDismissed: state.offer.dismissed, rootBytes };
}

/**
 * Takes in the projects one page load remembers, and once, the old
 * workflows folder: while the Node Banana folder is still the default, a
 * workflows folder the user had becomes it — switched to when nothing is
 * saved here yet, else the library moves there.
 */
export async function reportProjects(request: ReportProjectsRequest): Promise<ReportProjectsResult> {
  const rt = runtime();
  if (!request || typeof request !== "object" || !Array.isArray(request.projects)) {
    throw new LibraryError("Invalid request", 400, "bad_request");
  }
  const { library, location, registry } = await projectsContext(rt);
  const added = await registry.add(request.projects);
  let adopted = false;
  if (location.source === "default" && !(await registry.read()).adoption.done) {
    adopted = await adoptWorkflowsDir(library, location, registry, request.workflowsDir ?? null);
  }
  if (added.length) scheduleAutoIndex(rt);
  const now = (await activeLocation(rt)).location;
  return { adopted, root: now?.root ?? location.root };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function adoptWorkflowsDir(
  library: AssetLibrary,
  location: ResolvedLocation,
  registry: ProjectRegistry,
  workflowsDir: string | null,
): Promise<boolean> {
  const dir = registryDir(workflowsDir);
  const holds = holdsLibraryAssets(library);
  if (!dir || !(await isDirectory(dir))) {
    // Nothing to adopt from this page; the other build's page may still have one, unless this library is already in use.
    if (holds) await registry.markAdopted();
    return false;
  }
  if (pathKey(dir) === pathKey(location.root)) {
    await registry.markAdopted();
    return false;
  }
  try {
    await setLibraryRoot({ root: dir, mode: holds ? "move" : "switch" });
  } catch (error) {
    // Another job is running: the next page load tries again.
    if (error instanceof LibraryError && error.code === "busy") return false;
    console.warn("[assets] could not adopt the workflows folder", dir, error);
    await registry.markAdopted();
    return false;
  }
  await registry.markAdopted();
  return true;
}

/** Starts the projects job: each folder moves into the Node Banana folder. */
async function startProjectsMove(
  rt: Runtime,
  library: AssetLibrary,
  location: ResolvedLocation,
  registry: ProjectRegistry,
  value: unknown,
): Promise<LibraryJobStatus> {
  assertWritable(rt);
  await assertNoMoveElsewhere(library);
  const dirs = await normaliseMoveDirs(value, location.root, { home: pathContext(rt).homedir });
  if (!dirs.length) throw new LibraryError("Those projects are already in the Node Banana folder.", 400, "bad_request");
  return rt.jobs.startOverQuiet("projects", (job) => runProjectsMove(job, { library, root: location.root, registry }, dirs));
}

/**
 * Brings projects from another folder in. `use`: that folder becomes the
 * Node Banana folder (the library moves there when it holds anything, else
 * it is simply switched to). `move`: the project folders move into the
 * Node Banana folder. `leave`: they are listed where they are, and indexed.
 */
export async function bringInProjects(request: BringInProjectsRequest): Promise<BringInProjectsResult> {
  const rt = runtime();
  if (!request || typeof request !== "object" || !Array.isArray(request.dirs)) {
    throw new LibraryError("Invalid request", 400, "bad_request");
  }
  const { library, location, registry } = await projectsContext(rt);
  const additions = request.dirs.map((dir) => ({ dir }));
  switch (request.mode) {
    case "use": {
      const folder = registryDir(request.folder);
      if (!folder) throw new LibraryError("Choose a folder", 400, "bad_request");
      let job: LibraryJobStatus | null = null;
      if (pathKey(folder) !== pathKey(location.root)) {
        const holds = holdsLibraryAssets(library);
        const status = await setLibraryRoot({ root: folder, mode: holds ? "move" : "switch" });
        job = holds ? status.job : null;
      }
      await registry.add(additions);
      scheduleAutoIndex(rt);
      return { root: (await activeLocation(rt)).location?.root ?? null, job };
    }
    case "move": {
      // Listed first, so the move carries their entries (and names) along.
      await registry.add(additions);
      const job = await startProjectsMove(rt, library, location, registry, request.dirs);
      return { root: location.root, job };
    }
    case "leave": {
      await registry.add(additions);
      scheduleAutoIndex(rt);
      return { root: location.root, job: null };
    }
    default:
      throw new LibraryError("mode must be use, move or leave", 400, "bad_request");
  }
}

/** "Keep where they are": the offer to move projects in is not made again. */
export async function setProjectsOffer(request: ProjectsOfferRequest): Promise<void> {
  if (!request || request.dismissed !== true) throw new LibraryError("dismissed must be true", 400, "bad_request");
  const { registry } = await projectsContext(runtime());
  await registry.dismissOffer();
}

/** The folder a new project called `name` would be saved in. */
export async function getProjectFolderName(name: string): Promise<ProjectFolderName> {
  if (typeof name !== "string") throw new LibraryError("name is required", 400, "bad_request");
  const { location } = await availableLibrary(runtime());
  return projectFolderName(location.root, name);
}

/* Auto-index --------------------------------------------------------- */

/**
 * Indexes, in place, the generations of every known project whose
 * `generations/` changed since it was last indexed. Runs after the library
 * is ready, when the root changes and when the registry gains folders; one
 * pass at a time (a request meanwhile runs one more pass after it), and
 * never alongside another job or a move — it looks again a little later.
 */
function scheduleAutoIndex(rt: Runtime): void {
  if (isHostedServer()) return;
  track(rt, autoIndex(rt));
}

function retryAutoIndex(rt: Runtime): void {
  if (rt.autoIndex.retry) return;
  rt.autoIndex.retry = setTimeout(() => {
    rt.autoIndex.retry = null;
    scheduleAutoIndex(rt);
  }, AUTO_INDEX_RETRY_MS);
  rt.autoIndex.retry.unref?.();
}

async function autoIndex(rt: Runtime): Promise<void> {
  if (rt.autoIndex.running) {
    rt.autoIndex.again = true;
    return;
  }
  rt.autoIndex.running = true;
  try {
    do {
      rt.autoIndex.again = false;
      await autoIndexPass(rt);
    } while (rt.autoIndex.again);
  } finally {
    rt.autoIndex.running = false;
  }
}

async function autoIndexPass(rt: Runtime): Promise<void> {
  const result = await activeLocation(rt);
  if (!result.ok) return;
  const location = result.location;
  const library = libraryFor(rt, location);
  await library.ready();
  if (!rt.paused && !rt.jobs.isRunning) {
    // Clears the copies earlier imports took in as assets of their own (see forgetDuplicateImports)
    const forgotten = await library.forgetDuplicateImports().catch(() => 0);
    if (forgotten) console.log(`[assets] forgot ${forgotten} duplicate imported records (files kept)`);
  }
  const registry = registryFor(rt, location);
  const projects = await knownProjects(location, library, registry);
  const indexed = new Map((await registry.read()).projects.map((project) => [pathKey(project.dir), project.indexedStamp]));
  const stamps = await mapConcurrent(projects, 8, (project) => generationsStamp(project.dir));
  const due = projects
    .map((project, index) => ({ dir: project.dir, name: project.name, stamp: stamps[index] }))
    .filter((project): project is { dir: string; name: string; stamp: string } =>
      project.stamp !== null && indexed.get(pathKey(project.dir)) !== project.stamp,
    )
    .slice(0, MAX_IMPORT_PROJECTS);
  if (!due.length) return;
  if (rt.paused || rt.jobs.isRunning || (await library.movingElsewhere())) {
    retryAutoIndex(rt);
    return;
  }
  let job: LibraryJobStatus;
  try {
    job = rt.jobs.start("import", (ctx) => runImport(ctx, { library, thumbs: rt.thumbs }, due.map((project) => project.dir)), {
      quiet: true,
    });
  } catch {
    retryAutoIndex(rt);
    return;
  }
  await rt.jobs.wait(job.id);
  const finished = rt.jobs.get(job.id);
  if (finished?.state === "done") await registry.setIndexed(due);
  // Failed, or stopped to make way for a job the user started: look again later.
  else retryAutoIndex(rt);
}

/* Test hooks --------------------------------------------------------- */

/** Waits for every background task (scans, thumbnails, jobs) to settle. */
export async function __drainAssetLibraryForTests(): Promise<void> {
  const rt = globalState.__nodeBananaAssetLibrary;
  if (!rt) return;
  for (let round = 0; round < 5; round++) {
    await rt.jobs.drain();
    while (rt.background.size) await Promise.all([...rt.background]);
    await rt.library?.drain();
    await rt.thumbs?.drain();
    if (!rt.background.size) break;
  }
}

/** Drains and forgets the process-wide library state, so the next call resolves from scratch. */
export async function __resetAssetLibraryForTests(options: { pathContext?: PathContext | null } = {}): Promise<void> {
  await __drainAssetLibraryForTests();
  const retry = globalState.__nodeBananaAssetLibrary?.autoIndex?.retry;
  if (retry) clearTimeout(retry);
  delete globalState.__nodeBananaAssetLibrary;
  resetPathCachesForTests();
  if (options.pathContext) runtime().ctxOverride = options.pathContext;
}

/** The live index (for tests that inspect it). */
export async function __assetLibraryForTests(): Promise<AssetLibrary> {
  return readyLibrary();
}
