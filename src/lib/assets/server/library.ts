/**
 * The asset index for one library root.
 *
 * Sidecars (`.nodebanana/assets/<id>.json`) are the source of truth. This
 * class holds all of them in memory — records, a newest-first array, and
 * hash→ids / path→ids maps — built lazily by one scan. Every mutation writes
 * its sidecar and then appends a line to `.nodebanana/journal.ndjson`; each
 * process remembers how far into the journal it has read, so before serving
 * a query it replays only the tail (another process's writes). The journal's
 * first line is a generation marker (`{"gen":…}`) that compaction rewrites,
 * so a process rescans whenever the file it would read from its old offset
 * is a different file. `del` lines double as the tombstones behind
 * `exists → gone`.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { cleanAssetName } from "../name";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../query";
import {
  ASSET_KINDS,
  ASSET_ORIGINS,
  type AssetBulkOp,
  type AssetBulkRequest,
  type AssetBulkResult,
  type AssetExistence,
  type AssetFacets,
  type AssetFileLocation,
  type AssetOrigin,
  type AssetPage,
  type AssetPageRequest,
  type AssetPatch,
  type AssetRecord,
  type AssetSelection,
  type AssetView,
  type LibraryWorkflowEntry,
} from "../types";
import { errnoCode, LibraryError, pausedError } from "./errors";
import {
  atomicWriteFile,
  foldsCase,
  hashFile,
  isInsideRoot,
  KeyedMutex,
  mapConcurrent,
  pathKey,
  rebasePath,
  unlinkWithRetry,
  withFsRetry,
} from "./fsutil";
import { acquireLock, DATA_DIR, isLiveLock, libraryLayout, LOCK_HEARTBEAT_MS, readLock, type LibraryLayout } from "./layout";
import { RunStore } from "./runs";
import {
  compareNewest,
  comparatorFor,
  compileQuery,
  computeFacets,
  decodeCursor,
  encodeCursor,
  indexAfter,
  indexAtOrAfter,
  recordSearchText,
  type QueryContext,
} from "./search";
import {
  extOf,
  isAssetId,
  isMd5,
  isMediaExtension,
  isRunId,
  isSha256,
  isWorkflowId,
  MAX_SIDECAR_BYTES,
  normaliseTags,
  safeFileName,
  scrubRecord,
  validatePatch,
} from "./validate";
import { WorkflowTable, type WorkflowEntryInput } from "./workflows";

const SIDECAR_NAME = /^a[0-9a-z]{12,24}\.json$/;
/** Compact the journal past this size, keeping only `del` lines. */
const JOURNAL_COMPACT_BYTES = 5 * 1024 * 1024;
/** Tombstones kept through a compaction. */
const MAX_TOMBSTONES = 50_000;
/** A tail larger than this is cheaper to handle with a rescan. */
const MAX_TAIL_BYTES = 32 * 1024 * 1024;
/** How long a file check (stat) is trusted before a page stats it again. */
export const MISSING_TTL_MS = 30_000;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a look at the lock for another process's move is trusted. */
const MOVE_CHECK_MS = 1000;
/** How often a move looks again for another process's writes to finish. */
const WRITERS_POLL_MS = 100;
/** How often sidecars that could not be read are tried again while serving queries. */
const UNREADABLE_RECHECK_MS = 30_000;

/** `interactive: false` — nobody asked for this just now, so no route that may prompt (Finder's Automation request). */
export type TrashHook = (files: string[], options?: { interactive?: boolean }) => Promise<unknown>;

export interface AssetLibraryOptions {
  platform?: NodeJS.Platform;
  /** Sends files to the OS Trash in one go (desktop.ts in production, a fake in tests). */
  trash?: TrashHook;
  now?: () => number;
}

interface JournalLine {
  t: number;
  op: "put" | "del";
  id: string;
  pid: number;
  /** The writing instance, so a process skips its own lines on replay. */
  i: string;
}

/** Longest generation line read from the head of the journal. */
const JOURNAL_HEADER_BYTES = 256;

/** The generation marker on the journal's first line ("" for none: an empty, missing or pre-marker journal). */
function journalGeneration(head: Buffer): string {
  const newline = head.indexOf(0x0a);
  if (newline < 0) return "";
  try {
    const parsed = JSON.parse(head.subarray(0, newline).toString("utf8")) as { gen?: unknown };
    return typeof parsed.gen === "string" ? parsed.gen : "";
  } catch {
    return "";
  }
}

function isAbsent(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/* ------------------------------------------------------------------ */
/* Sidecar parsing                                                     */
/* ------------------------------------------------------------------ */

/** Absolute path of a library-relative location, or null when it would leave the root or enter `.nodebanana`. */
export function libraryRelToPath(root: string, rel: unknown): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) return null;
  const segments = rel.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\:\0]/.test(segment))) {
    return null;
  }
  const absolute = path.join(root, ...segments);
  if (!isInsideRoot(root, absolute)) return null;
  if (isInsideRoot(path.join(root, DATA_DIR), absolute, { allowEqual: true })) return null;
  return absolute;
}

export function relFromPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Checks a sidecar read from a folder the user can edit (and sync). A record
 * whose file location escapes the root, or points at a non-media external
 * file, is dropped rather than trusted for streaming or deleting.
 */
export function parseRecord(value: unknown, expectedId: string, root: string, rawBytes = 0): AssetRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.id !== expectedId || !isAssetId(raw.id)) return null;
  if (!(ASSET_KINDS as readonly unknown[]).includes(raw.kind)) return null;
  if (!(ASSET_ORIGINS as readonly unknown[]).includes(raw.origin)) return null;
  if (typeof raw.mime !== "string" || typeof raw.ext !== "string" || !isMediaExtension(raw.ext)) return null;
  if (!isSha256(raw.sha256) || !isMd5(raw.md5)) return null;
  const bytes = optionalNumber(raw.bytes);
  const createdAt = optionalNumber(raw.createdAt);
  if (bytes === undefined || bytes < 0 || createdAt === undefined) return null;
  if (!isWorkflowId(raw.workflowId) || typeof raw.runId !== "string" || typeof raw.filename !== "string") return null;

  const fileValue = raw.file as Record<string, unknown> | undefined;
  let file: AssetFileLocation;
  if (fileValue?.root === "library") {
    if (!libraryRelToPath(root, fileValue.rel)) return null;
    file = { root: "library", rel: fileValue.rel as string };
  } else if (fileValue?.root === "external") {
    const external = fileValue.path;
    if (typeof external !== "string" || !path.isAbsolute(external) || !isMediaExtension(extOf(external))) return null;
    file = { root: "external", path: external };
  } else {
    return null;
  }

  // The name is only ever a label or an export name: never let it carry a path.
  const filename =
    safeFileName(raw.filename) ??
    safeFileName(file.root === "library" ? file.rel : file.path) ??
    `${raw.id}.${raw.ext.toLowerCase()}`;

  const producer = (raw.producer ?? {}) as Record<string, unknown>;
  const record: AssetRecord = {
    ...(raw as unknown as AssetRecord),
    v: 1,
    bytes,
    createdAt,
    file,
    filename,
    producer: {
      ...(producer as unknown as AssetRecord["producer"]),
      nodeId: typeof producer.nodeId === "string" ? producer.nodeId : "",
      nodeType: typeof producer.nodeType === "string" ? producer.nodeType : "",
    },
    workflowName: typeof raw.workflowName === "string" ? raw.workflowName : null,
    tags: normaliseTags(raw.tags),
    favorite: raw.favorite === true,
  };
  if (optionalNumber(raw.trashedAt) === undefined) delete record.trashedAt;
  const name = cleanAssetName(raw.name);
  if (name === undefined) delete record.name;
  else record.name = name;
  if (raw.unreadable === true) record.unreadable = true;
  else delete record.unreadable;
  for (const key of ["width", "height", "durationSec"] as const) {
    if (optionalNumber(raw[key]) === undefined) delete record[key];
  }
  return rawBytes > MAX_SIDECAR_BYTES ? scrubRecord(record) : record;
}

function sameMutableState(a: AssetRecord, b: AssetRecord): boolean {
  return (
    sameLocation(a.file, b.file) &&
    a.favorite === b.favorite &&
    a.trashedAt === b.trashedAt &&
    a.hasPoster === b.hasPoster &&
    a.unreadable === b.unreadable &&
    a.name === b.name &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/** A project file's location changes when its project folder moves (relocateExternal). */
function sameLocation(a: AssetFileLocation, b: AssetFileLocation): boolean {
  if (a.root === "library") return b.root === "library" && a.rel === b.rel;
  return b.root === "external" && a.path === b.path;
}

/** How a bulk op changes one record (delete is handled separately). */
function applyBulkOp(record: AssetRecord, op: Exclude<AssetBulkOp, { action: "delete" }>, now: number): AssetRecord {
  switch (op.action) {
    case "tag": {
      const tags = normaliseTags([...record.tags, ...op.tags]);
      return { ...record, tags };
    }
    case "untag": {
      const remove = new Set(op.tags.map((tag) => tag.toLowerCase()));
      return { ...record, tags: record.tags.filter((tag) => !remove.has(tag.toLowerCase())) };
    }
    case "favorite":
      return { ...record, favorite: true };
    case "unfavorite":
      return { ...record, favorite: false };
    case "trash":
      return record.trashedAt === undefined ? { ...record, trashedAt: now } : record;
    case "restore": {
      const next = { ...record };
      delete next.trashedAt;
      return next;
    }
  }
}

/**
 * One file a permanent delete releases: to the OS Trash, into media/ for a
 * snapshot that needs its bytes, or — a project file the delete keeps — at
 * most a snapshot's reference to it.
 */
interface FileRelease {
  /** Where the record had it: a library file by its relative path, so a release kept for later survives a move. */
  file: AssetFileLocation;
  sha256: string;
  bytes: number;
  ext: string;
  /** A project file the delete leaves in its project. */
  keep: boolean;
}

/** `.nodebanana/pending-release/<uuid>.json`: what one delete had to keep while a record couldn't be read. */
interface PendingRelease {
  v: 1;
  at: number;
  runIds: string[];
  files: FileRelease[];
}

const PENDING_RELEASE_NAME = /^[0-9a-f-]{36}\.json$/;

/** The runs and files a pending-release file names (only the entries that pass the checks a sidecar's would). */
function parsePendingRelease(value: unknown, root: string): { runIds: string[]; files: FileRelease[] } {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const runIds = Array.isArray(raw.runIds) ? raw.runIds.filter(isRunId) : [];
  const files: FileRelease[] = [];
  for (const entry of Array.isArray(raw.files) ? (raw.files as Record<string, unknown>[]) : []) {
    if (!entry || typeof entry !== "object") continue;
    const location = entry.file as Record<string, unknown> | undefined;
    let file: AssetFileLocation;
    if (location?.root === "library" && libraryRelToPath(root, location.rel)) {
      file = { root: "library", rel: location.rel as string };
    } else if (
      location?.root === "external" &&
      typeof location.path === "string" &&
      path.isAbsolute(location.path) &&
      isMediaExtension(extOf(location.path))
    ) {
      file = { root: "external", path: location.path };
    } else {
      continue;
    }
    const bytes = optionalNumber(entry.bytes);
    if (!isSha256(entry.sha256) || bytes === undefined || bytes < 0) continue;
    if (typeof entry.ext !== "string" || !isMediaExtension(entry.ext)) continue;
    files.push({ file, sha256: entry.sha256, bytes, ext: entry.ext, keep: entry.keep === true });
  }
  return { runIds, files };
}

function validateBulkOp(value: unknown): AssetBulkOp {
  const op = value as AssetBulkOp;
  if (!op || typeof op !== "object") throw new LibraryError("op is required", 400, "bad_request");
  switch (op.action) {
    case "tag":
    case "untag": {
      const tags = normaliseTags((op as { tags?: unknown }).tags);
      if (!tags.length) throw new LibraryError("tags are required", 400, "bad_request");
      return { action: op.action, tags };
    }
    case "favorite":
    case "unfavorite":
    case "trash":
    case "restore":
      return { action: op.action };
    case "delete":
      return { action: "delete", deleteProjectFiles: op.deleteProjectFiles === true };
    default:
      throw new LibraryError("Unknown bulk action", 400, "bad_request");
  }
}

/* ------------------------------------------------------------------ */
/* The index                                                           */
/* ------------------------------------------------------------------ */

export class AssetLibrary {
  readonly layout: LibraryLayout;
  readonly platform: NodeJS.Platform;
  readonly runs: RunStore;
  private readonly workflowTable: WorkflowTable;
  private readonly trash: TrashHook;
  private readonly now: () => number;
  private readonly instance = randomUUID().slice(0, 12);

  private records = new Map<string, AssetRecord>();
  /** Every record, `(createdAt desc, id desc)`. */
  private sorted: AssetRecord[] = [];
  private byHash = new Map<string, Set<string>>();
  private byPath = new Map<string, Set<string>>();
  private searchCache = new Map<string, string>();
  private tombstones = new Set<string>();
  /**
   * Sidecars that are there but could not be read (an offline cloud
   * placeholder, EIO), of records this index doesn't hold: what those
   * records use — their run, their file, their poster — is unknown until
   * they read, so nothing is deleted on the strength of the index alone.
   */
  private unreadableSidecars = new Set<string>();
  private unreadableCheckedAt = 0;
  /** The last file check per record; `unknown` when it failed for a reason other than "no such file". */
  private missing = new Map<string, { missing: boolean; unknown?: boolean; at: number }>();
  private journalOffset = 0;
  /** The generation of the journal `journalOffset` points into (null before the first read). */
  private journalGen: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private isLoaded = false;
  private readonly idLocks = new KeyedMutex();
  /**
   * Per content hash: recording holds it from choosing a file to reuse until
   * its record is indexed, and a delete holds it while deciding whether a
   * file is still used and releasing it, so neither sees the other halfway.
   */
  readonly shaLocks = new KeyedMutex();
  /** Serialises this process's passes over `.nodebanana/pending-release/`. */
  private readonly pendingLock = new KeyedMutex();
  /** Bumped on every change that can alter a query or facet result. */
  private revision = 0;
  private facetsCache: { revision: number; facets: AssetFacets } | null = null;
  private statsCache: { revision: number; stats: { assets: number; trashed: number; bytes: number } } | null = null;
  private readonly background = new Set<Promise<unknown>>();
  private compacting = false;
  private moveCheck: { at: number; moving: boolean } | null = null;
  /** Serialises this process's journal appends with compaction, so no line of ours is lost to the rewrite. */
  private readonly journalLock = new KeyedMutex();
  /** Mutations in flight; a full scan waits for them so it never reads a sidecar mid-change. */
  private mutations = 0;
  private mutationWaiters: (() => void)[] = [];
  /** Set while a full scan runs; mutations wait for it so none lands in maps the scan is replacing. */
  private scanGate: Promise<void> | null = null;
  /** Writes through {@link writing} in flight, published in `.nodebanana/writers/` while there are any. */
  private writesInFlight = 0;
  /** Serialises writing, refreshing and removing this index's writer file. */
  private writerQueue: Promise<void> = Promise.resolve();
  private writerHeartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(root: string, options: AssetLibraryOptions = {}) {
    this.layout = libraryLayout(root);
    this.platform = options.platform ?? process.platform;
    this.trash = options.trash ?? (async (files, trashOptions) => (await import("./desktop")).trashFiles(files, trashOptions));
    this.now = options.now ?? Date.now;
    this.workflowTable = new WorkflowTable(this.layout.workflowsFile, this.platform);
    this.runs = new RunStore(this.layout, { assetFileFor: (sha256) => this.assetFileFor(sha256) });
  }

  get root(): string {
    return this.layout.root;
  }

  get loaded(): boolean {
    return this.isLoaded;
  }

  /* Loading and freshness -------------------------------------------- */

  /** Starts the first scan (once). */
  ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.fullScan().then(() => {
      this.isLoaded = true;
      this.track(this.verifyFiles(this.sorted.filter((record) => record.trashedAt === undefined), 0, 8));
    });
    this.loadPromise.catch(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  /** Loaded and caught up with other processes' writes. */
  async ready(): Promise<void> {
    await this.ensureLoaded();
    await this.refresh();
  }

  /** Replays the journal tail and re-reads workflows.json if either changed; now and then retries unreadable sidecars. */
  refresh(): Promise<void> {
    this.refreshPromise ??= (async () => {
      try {
        await this.replayJournal();
        if (await this.workflowTable.refresh()) this.bump();
        if (this.unreadableSidecars.size && this.now() - this.unreadableCheckedAt >= UNREADABLE_RECHECK_MS) await this.hasUnreadable();
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private bump(): void {
    this.revision++;
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error) => console.warn("[assets]", error)).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /**
   * Another process (the other build) holds this library's lock for a move:
   * writes here would miss its copy. Read from disk at most once a second
   * unless `fresh`; {@link writing} always looks again.
   */
  async movingElsewhere(options: { fresh?: boolean } = {}): Promise<boolean> {
    const now = Date.now();
    if (!options.fresh && this.moveCheck && now - this.moveCheck.at < MOVE_CHECK_MS) return this.moveCheck.moving;
    const lock = await readLock(this.layout.lock);
    const moving = Boolean(lock && lock.purpose === "move" && lock.pid !== process.pid && isLiveLock(lock, now));
    this.moveCheck = { at: now, moving };
    return moving;
  }

  /* Writes other processes can see ---------------------------------- */

  private get writerFile(): string {
    return path.join(this.layout.writers, `${process.pid}-${this.instance}.json`);
  }

  private async writeWriterFile(): Promise<void> {
    if (this.writesInFlight === 0) return;
    try {
      await fs.mkdir(this.layout.writers, { recursive: true });
      await atomicWriteFile(this.writerFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { fsync: false });
    } catch (error) {
      console.warn("[assets] could not publish a write in progress", error);
    }
  }

  private queueWriterFile(task: () => Promise<void>): Promise<void> {
    this.writerQueue = this.writerQueue.then(task).catch(() => {});
    return this.writerQueue;
  }

  /**
   * Runs a write to this root where a move in the other build can see it.
   * While any is in flight, a file in `.nodebanana/writers/` names this
   * process (refreshed while the writes last), and a move waits for it to go
   * before it lists what to copy. The file is on disk before this looks at
   * the lock, and a move takes the lock before it looks for writers, so one
   * always sees the other: the write is refused (paused, as a move in this
   * process would) or the move waits for it to land.
   */
  async writing<T>(fn: () => Promise<T>): Promise<T> {
    if (this.writesInFlight++ === 0) {
      void this.queueWriterFile(() => this.writeWriterFile());
      this.writerHeartbeat ??= setInterval(() => void this.queueWriterFile(() => this.writeWriterFile()), LOCK_HEARTBEAT_MS);
      this.writerHeartbeat.unref?.();
    }
    try {
      await this.writerQueue;
      if (await this.movingElsewhere({ fresh: true })) throw pausedError();
      return await fn();
    } finally {
      if (--this.writesInFlight === 0) {
        if (this.writerHeartbeat) clearInterval(this.writerHeartbeat);
        this.writerHeartbeat = null;
        void this.queueWriterFile(async () => {
          if (this.writesInFlight === 0) await fs.rm(this.writerFile, { force: true }).catch(() => {});
        });
      }
    }
  }

  /**
   * Waits until no other process — nor another index in this one — has a
   * write in flight here, as their files in `.nodebanana/writers/` say. A
   * file whose process is gone, or that was not refreshed for a minute,
   * doesn't count and is removed. False when writes are still going on
   * after `timeoutMs`.
   */
  async waitForOtherWriters(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.otherWriters()) === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, WRITERS_POLL_MS));
    }
  }

  private async otherWriters(): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.layout.writers);
    } catch {
      return 0;
    }
    const own = path.basename(this.writerFile);
    let live = 0;
    for (const name of names) {
      if (name === own || !name.endsWith(".json")) continue;
      const file = path.join(this.layout.writers, name);
      const writer = await readLock(file);
      if (!writer) continue;
      if (isLiveLock(writer)) live++;
      else await fs.rm(file, { force: true }).catch(() => {});
    }
    return live;
  }

  /** Waits for background work (file checks, compaction). Tests and shutdown. */
  async drain(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** Marks a mutation as in flight (after any running scan); call the result when it is done. */
  private async beginMutation(): Promise<() => void> {
    while (this.scanGate) await this.scanGate;
    this.mutations++;
    return () => {
      this.mutations--;
      if (this.mutations === 0) {
        const waiters = this.mutationWaiters;
        this.mutationWaiters = [];
        waiters.forEach((wake) => wake());
      }
    };
  }

  private async fullScan(): Promise<void> {
    while (this.scanGate) await this.scanGate;
    let open!: () => void;
    this.scanGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    try {
      while (this.mutations > 0) await new Promise<void>((resolve) => this.mutationWaiters.push(resolve));
      await this.scanNow();
    } finally {
      this.scanGate = null;
      open();
    }
  }

  private async scanNow(): Promise<void> {
    await fs.mkdir(this.layout.assets, { recursive: true });
    let journal = Buffer.alloc(0);
    try {
      journal = await fs.readFile(this.layout.journal);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    const complete = journal.subarray(0, journal.lastIndexOf(0x0a) + 1);
    const tombstones = new Set<string>();
    for (const line of this.parseJournal(complete)) {
      if (line.op === "del") tombstones.add(line.id);
      else tombstones.delete(line.id);
    }

    const names = (await fs.readdir(this.layout.assets)).filter((name) => SIDECAR_NAME.test(name));
    const unreadable = new Set<string>();
    const loaded = await mapConcurrent(names, 32, async (name) => {
      const id = name.slice(0, -5);
      try {
        return await this.readSidecar(id);
      } catch (error) {
        // Held open for a moment (sync client, antivirus): keep what we knew rather than drop it.
        console.warn("[assets] could not read sidecar", id, error);
        const known = this.records.get(id);
        if (!known) unreadable.add(id);
        return known ?? null;
      }
    });

    this.records = new Map();
    this.byHash = new Map();
    this.byPath = new Map();
    this.searchCache = new Map();
    for (const record of loaded) {
      if (!record) continue;
      this.records.set(record.id, record);
      this.indexLinks(record);
      tombstones.delete(record.id);
    }
    this.sorted = [...this.records.values()].sort(compareNewest);
    this.tombstones = tombstones;
    this.unreadableSidecars = unreadable;
    this.unreadableCheckedAt = this.now();
    for (const id of this.missing.keys()) if (!this.records.has(id)) this.missing.delete(id);
    this.journalOffset = complete.length;
    this.journalGen = journalGeneration(journal);
    await this.workflowTable.refresh();
    this.bump();
  }

  private parseJournal(buffer: Buffer): JournalLine[] {
    const lines: JournalLine[] = [];
    for (const text of buffer.toString("utf8").split("\n")) {
      if (!text) continue;
      try {
        const line = JSON.parse(text) as JournalLine;
        if ((line.op === "put" || line.op === "del") && isAssetId(line.id)) lines.push(line);
      } catch {
        // A torn line from a crash mid-append; the sidecars are still the truth.
      }
    }
    return lines;
  }

  /**
   * Reads what other processes appended since the last read. The size and
   * the generation marker come from the same open file as the tail, so a
   * journal replaced by compaction (another generation) is rescanned even
   * when it grew back past this process's offset.
   */
  private async replayJournal(): Promise<void> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.layout.journal, "r");
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    let buffer: Buffer;
    let bytesRead = 0;
    try {
      let size = 0;
      let generation = "";
      if (handle) {
        size = (await handle.stat()).size;
        const head = Buffer.alloc(Math.min(size, JOURNAL_HEADER_BYTES));
        const { bytesRead: headBytes } = await handle.read(head, 0, head.length, 0);
        generation = journalGeneration(head.subarray(0, headBytes));
      }
      if (
        generation !== this.journalGen ||
        size < this.journalOffset ||
        size - this.journalOffset > MAX_TAIL_BYTES
      ) {
        await handle?.close();
        handle = null;
        await this.fullScan();
        return;
      }
      if (!handle || size === this.journalOffset) return;
      const length = size - this.journalOffset;
      buffer = Buffer.alloc(length);
      ({ bytesRead } = await handle.read(buffer, 0, length, this.journalOffset));
    } finally {
      await handle?.close();
    }
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    this.journalOffset += lastNewline + 1;

    const latest = new Map<string, "put" | "del">();
    for (const line of this.parseJournal(buffer.subarray(0, lastNewline + 1))) {
      if (line.i === this.instance) continue;
      latest.set(line.id, line.op);
    }
    const puts: string[] = [];
    for (const [id, op] of latest) {
      if (op === "del") {
        this.removeFromIndex(id);
        this.tombstones.add(id);
        this.missing.delete(id);
        this.unreadableSidecars.delete(id);
      } else {
        puts.push(id);
      }
    }
    // Under the id lock, so a stale read can't land after one of our own writes to the same record.
    await mapConcurrent(puts, 32, (id) =>
      this.idLocks.run(id, async () => {
        try {
          const record = await this.readSidecar(id);
          if (record) this.upsertIndex(record);
        } catch (error) {
          // Unreadable for now: keep the copy we hold.
          console.warn("[assets] could not read sidecar", id, error);
          if (!this.records.has(id)) this.unreadableSidecars.add(id);
        }
      }),
    );
  }

  private journalLine(op: "put" | "del", id: string): string {
    const line: JournalLine = { t: this.now(), op, id, pid: process.pid, i: this.instance };
    return `${JSON.stringify(line)}\n`;
  }

  private static generationLine(): string {
    return `${JSON.stringify({ gen: randomUUID() })}\n`;
  }

  /** Starts a journal that does not exist yet with a generation marker (the first writer wins). */
  private async startJournal(): Promise<void> {
    if (this.journalGen) return;
    const line = AssetLibrary.generationLine();
    try {
      await fs.mkdir(this.layout.data, { recursive: true });
      await fs.writeFile(this.layout.journal, line, { flag: "wx" });
      // Only our own marker: nothing to rescan for.
      if (this.journalOffset === 0 && this.journalGen === "") {
        this.journalGen = journalGeneration(Buffer.from(line));
        this.journalOffset = Buffer.byteLength(line);
      }
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }

  private async appendJournal(lines: string[]): Promise<void> {
    if (!lines.length) return;
    await this.journalLock.run("journal", async () => {
      await this.startJournal();
      // The leading newline seals off a torn last line left by a crash, which would otherwise swallow ours.
      await withFsRetry(() => fs.appendFile(this.layout.journal, `\n${lines.join("")}`));
    });
    if (this.compacting) return;
    try {
      const { size } = await fs.stat(this.layout.journal);
      if (size > JOURNAL_COMPACT_BYTES) this.track(this.compactJournal());
    } catch {
      // Compaction is an optimisation.
    }
  }

  /**
   * Rewrites the journal keeping only `del` lines (the tombstones), under a
   * new generation marker and the library lock. Every process — this one
   * included — then sees another generation and rescans, which also picks
   * up any line appended in the instant between the read and the rename.
   */
  async compactJournal(): Promise<boolean> {
    if (this.compacting) return false;
    this.compacting = true;
    const lock = await acquireLock(this.layout.lock, { purpose: "compact" });
    try {
      if (!lock) return false;
      await this.journalLock.run("journal", async () => {
        const buffer = await fs.readFile(this.layout.journal);
        const deleted: JournalLine[] = [];
        const seen = new Set<string>();
        const lines = this.parseJournal(buffer);
        for (let index = lines.length - 1; index >= 0 && deleted.length < MAX_TOMBSTONES; index--) {
          const line = lines[index];
          if (seen.has(line.id)) continue;
          seen.add(line.id);
          if (line.op === "del") deleted.push(line);
        }
        deleted.reverse();
        const body = AssetLibrary.generationLine() + deleted.map((line) => `${JSON.stringify(line)}\n`).join("");
        await atomicWriteFile(this.layout.journal, body, { fsync: false });
      });
      this.journalOffset = Number.MAX_SAFE_INTEGER;
      this.journalGen = null;
      return true;
    } finally {
      await lock?.release();
      this.compacting = false;
    }
  }

  /* Index maintenance ------------------------------------------------ */

  private addLink(map: Map<string, Set<string>>, key: string, id: string): void {
    const set = map.get(key);
    if (set) set.add(id);
    else map.set(key, new Set([id]));
  }

  private dropLink(map: Map<string, Set<string>>, key: string, id: string): void {
    const set = map.get(key);
    if (!set) return;
    set.delete(id);
    if (!set.size) map.delete(key);
  }

  private indexLinks(record: AssetRecord): void {
    this.addLink(this.byHash, record.sha256, record.id);
    const file = this.filePath(record);
    if (file) this.addLink(this.byPath, pathKey(file, this.platform), record.id);
  }

  private unindexLinks(record: AssetRecord): void {
    this.dropLink(this.byHash, record.sha256, record.id);
    const file = this.filePath(record);
    if (file) this.dropLink(this.byPath, pathKey(file, this.platform), record.id);
  }

  private sortedIndexOf(record: AssetRecord): number {
    const index = indexAtOrAfter(this.sorted, record, compareNewest);
    if (this.sorted[index]?.id === record.id) return index;
    return this.sorted.findIndex((item) => item.id === record.id);
  }

  private upsertIndex(record: AssetRecord): void {
    const previous = this.records.get(record.id);
    if (previous) {
      this.unindexLinks(previous);
      const index = this.sortedIndexOf(previous);
      if (index >= 0) this.sorted.splice(index, 1);
    }
    this.records.set(record.id, record);
    this.indexLinks(record);
    this.sorted.splice(indexAtOrAfter(this.sorted, record, compareNewest), 0, record);
    this.searchCache.delete(record.id);
    this.tombstones.delete(record.id);
    this.unreadableSidecars.delete(record.id);
    this.bump();
  }

  private removeFromIndex(id: string): void {
    const previous = this.records.get(id);
    if (!previous) return;
    this.unindexLinks(previous);
    const index = this.sortedIndexOf(previous);
    if (index >= 0) this.sorted.splice(index, 1);
    this.records.delete(id);
    this.searchCache.delete(id);
    this.bump();
  }

  /* Sidecars --------------------------------------------------------- */

  sidecarPath(id: string): string {
    if (!isAssetId(id)) throw new LibraryError("Invalid asset id", 400, "bad_request");
    return path.join(this.layout.assets, `${id}.json`);
  }

  /**
   * The record as it is on disk now: null when there is no sidecar or it is
   * not a valid record. Any other read failure (a file held open by a sync
   * client or antivirus, EIO) throws, so no caller mistakes "can't read it
   * right now" for "it is gone".
   */
  async readSidecar(id: string): Promise<AssetRecord | null> {
    if (!isAssetId(id)) return null;
    let text: string;
    try {
      text = await withFsRetry(() => fs.readFile(this.sidecarPath(id), "utf8"));
    } catch (error) {
      if (!isAbsent(error)) throw error;
      this.unreadableSidecars.delete(id);
      return null;
    }
    let record: AssetRecord | null = null;
    try {
      record = parseRecord(JSON.parse(text), id, this.root, text.length);
    } catch {
      record = null;
    }
    // Read at last: either nothing to know (no valid record) or its caller indexes it.
    if (!record) this.unreadableSidecars.delete(id);
    return record;
  }

  /**
   * Reads again the sidecars the index could not read. True while any still
   * can't be: until then a run, a shared file or a poster may belong to a
   * record the index doesn't know, so cleanup and deletes keep them. (About
   * sidecars; a record whose media file is `unreadable` is held like any other.)
   */
  async hasUnreadable(): Promise<boolean> {
    if (!this.unreadableSidecars.size) return false;
    this.unreadableCheckedAt = this.now();
    await mapConcurrent([...this.unreadableSidecars], 8, (id) =>
      this.idLocks.run(id, async () => {
        try {
          const record = await this.readSidecar(id);
          if (record) this.upsertIndex(record);
        } catch {
          // Still unreadable.
        }
      }),
    );
    return this.unreadableSidecars.size > 0;
  }

  /** Whether a sidecar exists for `id` (true when that can't be told, so nothing is thrown away on a guess). */
  async hasSidecar(id: string): Promise<boolean> {
    try {
      await fs.stat(this.sidecarPath(id));
      return true;
    } catch (error) {
      return !isAbsent(error);
    }
  }

  private async writeSidecar(record: AssetRecord, fsync: boolean): Promise<void> {
    await atomicWriteFile(this.sidecarPath(record.id), `${JSON.stringify(record)}\n`, { fsync });
  }

  /* Paths and views -------------------------------------------------- */

  /** Absolute path of a record's file (null for a location that fails validation). */
  filePath(record: AssetRecord): string | null {
    return this.locationPath(record.file);
  }

  private locationPath(location: AssetFileLocation): string | null {
    if (location.root === "library") return libraryRelToPath(this.root, location.rel);
    const external = location.path;
    return path.isAbsolute(external) && isMediaExtension(extOf(external)) ? external : null;
  }

  private projectKey = (projectPath: string): string =>
    foldsCase(this.platform) ? path.resolve(projectPath).toLowerCase() : path.resolve(projectPath);

  /** The project folder a project file sits in (`<project>/generations/<file>`), else null. */
  private projectFolderOf(record: AssetRecord): string | null {
    if (record.file.root !== "external") return null;
    const dir = path.dirname(record.file.path);
    return path.basename(dir).toLowerCase() === "generations" ? path.dirname(dir) : null;
  }

  /**
   * A record's workflow as the UI shows it: the workflows table first, the
   * record's own name second. An imported asset stays with the folder it was
   * imported from, even when a twin folder sharing its workflow id (a Finder
   * duplicate) later claims that id's row by running.
   */
  workflowOf(record: AssetRecord): { name: string | null; projectPath: string | null } {
    const entry = this.workflowTable.get(record.workflowId);
    if (record.imported) {
      const folder = this.projectFolderOf(record);
      if (folder && (!entry?.projectPath || this.projectKey(entry.projectPath) !== this.projectKey(folder))) {
        return { name: record.workflowName ?? entry?.name ?? null, projectPath: folder };
      }
    }
    if (entry) return { name: entry.name ?? record.workflowName, projectPath: entry.projectPath };
    // A project file with no workflow row (e.g. from another machine) belongs to the folder it is in.
    return { name: record.workflowName, projectPath: this.projectFolderOf(record) };
  }

  private queryContext(): QueryContext {
    return {
      workflowOf: (record) => this.workflowOf(record),
      isMissing: (id) => this.missing.get(id)?.missing === true,
      searchText: (record) => {
        let text = this.searchCache.get(record.id);
        if (text === undefined) {
          text = recordSearchText(record);
          this.searchCache.set(record.id, text);
        }
        return text;
      },
      projectKey: this.projectKey,
    };
  }

  toView(record: AssetRecord): AssetView {
    const workflow = this.workflowOf(record);
    const view: AssetView = {
      ...record,
      workflow: { id: record.workflowId, name: workflow.name, projectPath: workflow.projectPath },
      displayPath: this.filePath(record) ?? "",
    };
    if (this.missing.get(record.id)?.missing) view.missing = true;
    return view;
  }

  get(id: string): AssetRecord | undefined {
    return this.records.get(id);
  }

  /** From memory, else straight from disk (another process may have just written it). */
  async find(id: string): Promise<AssetRecord | null> {
    if (!isAssetId(id)) return null;
    const known = this.records.get(id);
    if (known) return known;
    const fromDisk = await this.readSidecar(id);
    if (fromDisk) this.upsertIndex(fromDisk);
    return fromDisk;
  }

  recordsWithHash(sha256: string): AssetRecord[] {
    const ids = this.byHash.get(sha256);
    if (!ids) return [];
    return [...ids].map((id) => this.records.get(id)).filter((record): record is AssetRecord => Boolean(record));
  }

  /** Records whose file is this path (live or trashed). */
  recordsAtPath(file: string): AssetRecord[] {
    const ids = this.byPath.get(pathKey(file, this.platform));
    if (!ids) return [];
    return [...ids].map((id) => this.records.get(id)).filter((record): record is AssetRecord => Boolean(record));
  }

  allRecords(): readonly AssetRecord[] {
    return this.sorted;
  }

  /** An asset file on disk holding these bytes (for snapshot media and thumbnails). */
  async assetFileFor(sha256: string): Promise<{ path: string; mime: string; bytes: number; filename: string } | null> {
    for (const record of this.recordsWithHash(sha256)) {
      const file = this.filePath(record);
      if (!file) continue;
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size === record.bytes) {
          return { path: file, mime: record.mime, bytes: stat.size, filename: record.filename };
        }
      } catch (error) {
        this.noteFileError(record.id, error);
      }
    }
    return null;
  }

  /* Missing files ---------------------------------------------------- */

  setMissing(id: string, missing: boolean): void {
    const previous = this.missing.get(id);
    this.missing.set(id, { missing, at: this.now() });
    if ((previous?.missing ?? false) !== missing) this.bump();
  }

  /**
   * Records what a failed look at a record's file says: only "no such file"
   * (ENOENT/ENOTDIR) means missing. Anything else — no permission, a busy
   * or unreachable volume — means "can't tell", which is never reported as
   * gone, so carousels never prune an entry whose file may still be there.
   */
  noteFileError(id: string, error: unknown): void {
    if (isAbsent(error)) {
      this.setMissing(id, true);
      return;
    }
    const previous = this.missing.get(id);
    this.missing.set(id, { missing: false, unknown: true, at: this.now() });
    if (previous?.missing) this.bump();
  }

  isMissing(id: string): boolean {
    return this.missing.get(id)?.missing === true;
  }

  /** The last file check of this record could not tell whether the file exists. */
  isUnverifiable(id: string): boolean {
    return this.missing.get(id)?.unknown === true;
  }

  /** Stats the files of `records` whose last check is older than `maxAgeMs`. */
  async verifyFiles(records: readonly AssetRecord[], maxAgeMs: number = MISSING_TTL_MS, concurrency = 16): Promise<void> {
    const now = this.now();
    const stale = records.filter((record) => {
      const checked = this.missing.get(record.id);
      return !checked || now - checked.at >= maxAgeMs;
    });
    await mapConcurrent(stale, concurrency, async (record) => {
      const file = this.filePath(record);
      if (!file) {
        this.setMissing(record.id, true);
        return;
      }
      try {
        const stat = await fs.stat(file);
        this.setMissing(record.id, !stat.isFile());
      } catch (error) {
        this.noteFileError(record.id, error);
      }
    });
  }

  /* Queries ---------------------------------------------------------- */

  async query(request: AssetPageRequest): Promise<AssetPage> {
    await this.ready();
    const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(request.limit ?? DEFAULT_PAGE_LIMIT)));
    const compare = comparatorFor(request.sort);
    const match = compileQuery(request, this.queryContext());
    const matched: AssetRecord[] = [];
    let totalBytes = 0;
    for (const record of this.sorted) {
      if (!match(record)) continue;
      matched.push(record);
      totalBytes += record.bytes;
    }
    if (request.sort === "oldest") matched.reverse();

    let page: AssetRecord[];
    let nextCursor: string | null = null;
    let headCursor = matched.length ? encodeCursor(matched[0]) : null;
    if (request.newerThan) {
      // New arrivals, nearest the client's head first so they join up with what it holds.
      const end = indexAtOrAfter(matched, decodeCursor(request.newerThan), compare);
      const start = Math.max(0, end - limit);
      page = matched.slice(start, end);
      // More arrived than fit: the head is the newest item returned, so the next poll continues from there.
      if (start > 0 && page.length) headCursor = encodeCursor(page[0]);
    } else {
      const start = request.cursor ? indexAfter(matched, decodeCursor(request.cursor), compare) : 0;
      page = matched.slice(start, start + limit);
      if (start + limit < matched.length && page.length) nextCursor = encodeCursor(page[page.length - 1]);
    }
    await this.verifyFiles(page);
    return {
      assets: page.map((record) => this.toView(record)),
      nextCursor,
      headCursor,
      total: matched.length,
      totalBytes,
    };
  }

  async facets(): Promise<AssetFacets> {
    await this.ready();
    if (this.facetsCache?.revision !== this.revision) {
      this.facetsCache = { revision: this.revision, facets: computeFacets(this.sorted, this.queryContext()) };
    }
    return this.facetsCache.facets;
  }

  /** Live and trashed counts, and the bytes of distinct files (deduplicated files count once), of what the Assets view can show. */
  stats(): { assets: number; trashed: number; bytes: number } {
    if (this.statsCache?.revision !== this.revision) {
      let assets = 0;
      let trashed = 0;
      let bytes = 0;
      const files = new Set<string>();
      for (const record of this.sorted) {
        if (record.unreadable) continue;
        if (record.trashedAt === undefined) assets++;
        else trashed++;
        const file = this.filePath(record);
        const key = file ? pathKey(file, this.platform) : record.id;
        if (!files.has(key)) {
          files.add(key);
          bytes += record.bytes;
        }
      }
      this.statsCache = { revision: this.revision, stats: { assets, trashed, bytes } };
    }
    return this.statsCache.stats;
  }

  /** No asset was ever recorded here (drives the first-run hint). */
  isEmpty(): boolean {
    return this.records.size === 0 && this.tombstones.size === 0;
  }

  async existence(ids: string[]): Promise<Record<string, AssetExistence>> {
    await this.ready();
    const states: Record<string, AssetExistence> = {};
    const known: AssetRecord[] = [];
    for (const id of [...new Set(ids)].slice(0, 5000)) {
      if (!isAssetId(id)) {
        states[id] = "unknown";
        continue;
      }
      let record = this.records.get(id) ?? null;
      if (!record && !this.tombstones.has(id)) {
        try {
          record = await this.find(id);
        } catch {
          states[id] = "unknown";
          continue;
        }
      }
      if (record) known.push(record);
      else states[id] = this.tombstones.has(id) ? "gone" : "unknown";
    }
    await this.verifyFiles(known);
    const unreachable = new Map<string, Promise<boolean>>();
    for (const record of known) {
      if (this.isUnverifiable(record.id)) {
        states[record.id] = "unknown";
        continue;
      }
      if (!this.isMissing(record.id)) {
        states[record.id] = "present";
        continue;
      }
      // A project file whose whole folder is gone (an unplugged drive, a moved project) is not
      // verified absent — carousels must not prune it for good.
      const file = record.file.root === "external" ? this.filePath(record) : null;
      if (file) {
        const dir = path.dirname(file);
        if (!unreachable.has(dir)) {
          unreachable.set(
            dir,
            fs.stat(dir).then(
              (stat) => !stat.isDirectory(),
              () => true,
            ),
          );
        }
        if (await unreachable.get(dir)) {
          states[record.id] = "unknown";
          continue;
        }
      }
      states[record.id] = "gone";
    }
    return states;
  }

  /* Workflows -------------------------------------------------------- */

  getWorkflow(id: string): LibraryWorkflowEntry | undefined {
    return this.workflowTable.get(id);
  }

  /** The project folders the workflows table names, each once. */
  workflowProjectPaths(): string[] {
    const paths = new Map<string, string>();
    for (const entry of this.workflowTable.all()) {
      if (entry.projectPath) paths.set(this.projectKey(entry.projectPath), entry.projectPath);
    }
    return [...paths.values()];
  }

  async upsertWorkflow(id: string, input: WorkflowEntryInput): Promise<LibraryWorkflowEntry> {
    const { entry, changed } = await this.workflowTable.upsert(id, input, this.now());
    if (changed) this.bump();
    return entry;
  }

  /* Mutations -------------------------------------------------------- */

  /** Runs a change to one record under its lock, counted as a mutation so a full scan waits for it. */
  private mutate<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.idLocks.run(id, async () => {
      const done = await this.beginMutation();
      try {
        return await fn();
      } finally {
        done();
      }
    });
  }

  /**
   * Appends journal lines for changes whose sidecars are already committed.
   * The sidecars are the truth and the journal only tells other processes,
   * so a failure here is logged, never turned into a failed (and retried, or
   * undone) write.
   */
  private async publish(lines: string[]): Promise<void> {
    try {
      await this.appendJournal(lines);
    } catch (error) {
      console.warn("[assets] could not append to the journal", error);
    }
  }

  /** Writes a new record (sidecar fsynced, then the journal line). */
  async addRecord(record: AssetRecord): Promise<AssetRecord> {
    const clean = scrubRecord(record);
    return this.mutate(clean.id, async () => {
      await fs.mkdir(this.layout.assets, { recursive: true });
      await this.writeSidecar(clean, true);
      this.upsertIndex(clean);
      this.setMissing(clean.id, false);
      await this.publish([this.journalLine("put", clean.id)]);
      return clean;
    });
  }

  /**
   * Read-modify-write of one record under its lock, re-reading the sidecar
   * from disk so a change made by another process is never overwritten with
   * a stale copy. Returns the journal line for the caller to append.
   */
  private async updateRecord(
    id: string,
    mutate: (record: AssetRecord) => AssetRecord,
  ): Promise<{ record: AssetRecord | null; line?: string }> {
    return this.mutate(id, async () => {
      const current = await this.readSidecar(id);
      if (!current) {
        this.removeFromIndex(id);
        return { record: null };
      }
      const next = mutate(current);
      if (sameMutableState(current, next)) {
        const known = this.records.get(id);
        if (!known || !sameMutableState(known, current)) this.upsertIndex(current);
        return { record: current };
      }
      const clean = scrubRecord(next);
      await this.writeSidecar(clean, false);
      this.upsertIndex(clean);
      return { record: clean, line: this.journalLine("put", id) };
    });
  }

  async patch(id: string, value: AssetPatch): Promise<AssetView | null> {
    if (!isAssetId(id)) return null;
    const patch = validatePatch(value);
    await this.ready();
    const now = this.now();
    const { record, line } = await this.updateRecord(id, (current) => {
      const next: AssetRecord = { ...current };
      if (patch.tags) next.tags = patch.tags;
      if (patch.favorite !== undefined) next.favorite = patch.favorite;
      if (patch.trashed === true && next.trashedAt === undefined) next.trashedAt = now;
      if (patch.trashed === false) delete next.trashedAt;
      if (patch.name) next.name = patch.name;
      else if (patch.name === "") delete next.name;
      return next;
    });
    if (line) await this.publish([line]);
    return record ? this.toView(record) : null;
  }

  async setHasPoster(id: string): Promise<AssetRecord | null> {
    const { record, line } = await this.updateRecord(id, (current) => ({ ...current, hasPoster: true }));
    if (line) await this.publish([line]);
    return record;
  }

  /**
   * A project folder moved from `fromDir` to `toDir`: every project file
   * recorded in it (or under it) is recorded at the same place in the new
   * folder, each sidecar rewritten under its lock like any edit, then the
   * workflow rows' project folders and the snapshot references to its files
   * follow. Returns the records changed.
   */
  async relocateExternal(fromDir: string, toDir: string): Promise<number> {
    await this.ready();
    const ids = this.sorted
      .filter((record) => record.file.root === "external" && isInsideRoot(fromDir, record.file.path, { platform: this.platform }))
      .map((record) => record.id);
    const lines: string[] = [];
    await mapConcurrent(ids, 8, async (id) => {
      const { line } = await this.updateRecord(id, (current) => {
        if (current.file.root !== "external") return current;
        const moved = rebasePath(fromDir, toDir, current.file.path, this.platform);
        return moved ? { ...current, file: { root: "external", path: moved } } : current;
      });
      if (line) lines.push(line);
      this.missing.delete(id);
    });
    await this.publish(lines);
    if (await this.workflowTable.relocate(fromDir, toDir, this.now())) this.bump();
    await this.runs.relocateReferences(fromDir, toDir, this.platform);
    return lines.length;
  }

  /**
   * Forgets imported records that repeat another record of the same bytes in
   * the same folder: older project saves wrote one image several times under
   * new names, and each copy was imported as an asset of its own. A folder
   * keeps one record per content: a live recording if there is one, else the
   * earliest import. Only records nobody has touched go (no tags, not a
   * favourite, not in the Trash). Files are never deleted; the records are
   * index entries rebuilt by an import. Returns how many were forgotten.
   */
  async forgetDuplicateImports(): Promise<number> {
    await this.ready();
    const groups = new Map<string, AssetRecord[]>();
    for (const record of this.sorted) {
      if (record.file.root !== "external" || record.trashedAt !== undefined) continue;
      const key = `${pathKey(path.dirname(record.file.path), this.platform)}\0${record.sha256}`;
      const group = groups.get(key);
      if (group) group.push(record);
      else groups.set(key, [record]);
    }
    const surplus: string[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const untouched = (record: AssetRecord) => record.imported === true && !record.favorite && record.tags.length === 0;
      const keep =
        group.find((record) => !untouched(record)) ??
        [...group].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]!;
      for (const record of group) if (record !== keep && untouched(record)) surplus.push(record.id);
    }
    if (!surplus.length) return 0;
    const lines: string[] = [];
    await mapConcurrent(surplus, 8, (id) =>
      this.mutate(id, async () => {
        const current = await this.readSidecar(id);
        // Changed since the scan above (tagged, favourited, trashed elsewhere): keep it.
        if (!current || current.imported !== true || current.favorite || current.tags.length || current.trashedAt !== undefined) return;
        await unlinkWithRetry(this.sidecarPath(id));
        this.removeFromIndex(id);
        this.tombstones.add(id);
        this.missing.delete(id);
        lines.push(this.journalLine("del", id));
      }),
    );
    await this.publish(lines);
    return lines.length;
  }

  /**
   * Marks records whose file's bytes nothing can read (see readable.ts): the
   * sidecar says `unreadable`, then a journal line tells other processes.
   * The record and its file are kept; it just isn't listed any more. Returns
   * the ids now marked.
   */
  async markUnreadable(ids: readonly string[]): Promise<string[]> {
    const marked: string[] = [];
    const lines: string[] = [];
    await mapConcurrent([...new Set(ids.filter(isAssetId))], 8, async (id) => {
      try {
        const { record, line } = await this.updateRecord(id, (current) => ({ ...current, unreadable: true }));
        if (record?.unreadable) marked.push(id);
        if (line) lines.push(line);
      } catch (error) {
        console.warn("[assets] could not mark", id, "as unreadable", error);
      }
    });
    await this.publish(lines);
    return marked;
  }

  /** The ids a selection covers right now (a query selection is evaluated at call time). */
  resolveSelection(selection: AssetSelection): string[] {
    if (!selection || typeof selection !== "object") throw new LibraryError("selection is required", 400, "bad_request");
    if (selection.mode === "ids") {
      if (!Array.isArray(selection.ids)) throw new LibraryError("selection.ids must be a list", 400, "bad_request");
      return [...new Set(selection.ids.filter(isAssetId))];
    }
    if (selection.mode === "query") {
      const exclude = new Set(Array.isArray(selection.excludeIds) ? selection.excludeIds : []);
      const match = compileQuery(selection.query ?? {}, this.queryContext());
      return this.sorted.filter((record) => !exclude.has(record.id) && match(record)).map((record) => record.id);
    }
    throw new LibraryError("Unknown selection mode", 400, "bad_request");
  }

  async bulk(request: AssetBulkRequest): Promise<AssetBulkResult> {
    if (!request || typeof request !== "object") throw new LibraryError("Invalid request", 400, "bad_request");
    const op = validateBulkOp(request.op);
    await this.ready();
    const ids = this.resolveSelection(request.selection);
    if (op.action === "delete") return this.deleteRecords(ids, { deleteProjectFiles: op.deleteProjectFiles });

    const now = this.now();
    const done = new Set<string>();
    const errors: AssetBulkResult["errors"] = [];
    let lines: string[] = [];
    const flush = async () => {
      const batch = lines;
      lines = [];
      await this.publish(batch);
    };
    await mapConcurrent(ids, 8, async (id) => {
      try {
        const { record, line } = await this.updateRecord(id, (current) => applyBulkOp(current, op, now));
        if (!record) {
          errors.push({ id, error: "Not found" });
          return;
        }
        done.add(id);
        if (line) lines.push(line);
        if (lines.length >= 500) await flush();
      } catch (error) {
        errors.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    });
    await flush();
    const affected = ids.filter((id) => done.has(id));
    return { affected: affected.length, ids: affected, errors };
  }

  /**
   * Whether a record's file is verifiably not there: no such file or folder
   * (ENOENT/ENOTDIR), or a location that fails validation. Anything else —
   * the file is there, or can't be checked — is not gone. Notes the answer
   * as a file check would.
   */
  private async fileIsGone(record: AssetRecord): Promise<boolean> {
    const file = this.filePath(record);
    if (!file) return true;
    try {
      await fs.stat(file);
      this.setMissing(record.id, false);
      return false;
    } catch (error) {
      this.noteFileError(record.id, error);
      return isAbsent(error);
    }
  }

  /**
   * Removes records for good. Only a record in the Trash, or a live one
   * whose file is verifiably gone ("Remove from library"), is removed; any
   * other id comes back in `errors`, whatever the client believed about it.
   * Sidecars go first (with `del` journal lines); then the snapshot of every
   * run none of the remaining records (live or trashed) belongs to; then
   * each file no remaining record uses is released — library files and,
   * with `deleteProjectFiles`, project files. A live record's file is never
   * released: it was gone a moment ago, so one there now came back.
   * Bytes a surviving run's snapshot still references move into
   * `.nodebanana/media` instead of the OS Trash, so "open original workflow"
   * keeps working; for a kept project file, a reference to it goes there.
   * While some record's sidecar can't be read, those runs and files are
   * kept and noted instead, and a later delete or cleanup releases them
   * once every record reads ({@link releaseDeferred}).
   * `purge` (the automatic 30-day empty) uses the OS Trash too, but never
   * a route that asks for permissions at startup: where only that one is
   * left (macOS 14 or earlier in web mode), the files are unlinked.
   */
  async deleteRecords(
    ids: string[],
    options: { deleteProjectFiles?: boolean; purge?: boolean } = {},
  ): Promise<AssetBulkResult> {
    await this.ready();
    const removed: AssetRecord[] = [];
    /** Removed from the Trash: their files are released. */
    const release: AssetRecord[] = [];
    const done = new Set<string>();
    const errors: AssetBulkResult["errors"] = [];
    const lines: string[] = [];
    await mapConcurrent([...new Set(ids.filter(isAssetId))], 8, (id) =>
      this.mutate(id, async () => {
        try {
          const record = await this.readSidecar(id);
          if (!record) {
            this.removeFromIndex(id);
            if (this.tombstones.has(id)) done.add(id);
            else errors.push({ id, error: "Not found" });
            return;
          }
          const trashed = record.trashedAt !== undefined;
          if (!trashed && !(await this.fileIsGone(record))) {
            // Restored elsewhere, or its missing file came back: a live asset, which only the Trash deletes.
            this.upsertIndex(record);
            errors.push({ id, error: "Not in the Trash" });
            return;
          }
          await unlinkWithRetry(this.sidecarPath(id));
          this.removeFromIndex(id);
          this.tombstones.add(id);
          this.missing.delete(id);
          removed.push(record);
          if (trashed) release.push(record);
          lines.push(this.journalLine("del", id));
          done.add(id);
        } catch (error) {
          errors.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    await this.publish(lines);
    const runIds = removed.map((record) => record.runId);
    const files = release.map((record) => this.fileRelease(record, options.deleteProjectFiles === true));
    if (removed.length && (await this.hasUnreadable())) {
      // A record whose sidecar can't be read may share a run or a file with these; keep both
      // (the file stays where it is) rather than guess, and note them so a later delete or
      // cleanup releases them once every record reads.
      console.warn("[assets] some asset records can't be read right now, so the deleted ones' files and snapshots were kept for now");
      await this.deferRelease(runIds, files);
    } else {
      await this.collectRuns(runIds);
      const { retry } = await this.releaseFiles(files, { purge: options.purge === true });
      // A file that couldn't be checked or trashed right now (locked, offline) is noted, not forgotten.
      if (retry.length) await this.deferRelease([], retry);
      await this.releaseDeferred({ purge: options.purge === true });
    }
    const affected = [...new Set(ids)].filter((id) => done.has(id));
    return { affected: affected.length, ids: affected, errors };
  }

  private fileRelease(record: AssetRecord, deleteProjectFiles: boolean): FileRelease {
    return {
      file: record.file,
      sha256: record.sha256,
      bytes: record.bytes,
      ext: record.ext,
      keep: record.file.root === "external" && !deleteProjectFiles,
    };
  }

  /**
   * Notes runs and files a delete had to keep, in a file of its own under
   * `.nodebanana/pending-release/` (so no two deletes, in any process, write
   * over each other's note).
   */
  private async deferRelease(runIds: string[], files: FileRelease[]): Promise<void> {
    if (!runIds.length && !files.length) return;
    const note: PendingRelease = { v: 1, at: this.now(), runIds: [...new Set(runIds)], files };
    try {
      await fs.mkdir(this.layout.pendingReleases, { recursive: true });
      await atomicWriteFile(path.join(this.layout.pendingReleases, `${randomUUID()}.json`), JSON.stringify(note), { fsync: true });
    } catch (error) {
      console.warn("[assets] could not note the deleted assets' files to release later", error);
    }
  }

  /**
   * Finishes the deletes that had to keep their runs and files while a
   * record couldn't be read, once every record reads: the runs no record
   * belongs to are deleted, and each file no record uses — still holding
   * exactly the deleted bytes — is released as the delete would have.
   * Returns what went to the OS Trash.
   */
  async releaseDeferred(options: { purge?: boolean } = {}): Promise<{ files: number; bytes: number }> {
    return this.pendingLock.run("pending", async () => {
      const none = { files: 0, bytes: 0 };
      let names: string[];
      try {
        names = (await fs.readdir(this.layout.pendingReleases)).filter((name) => PENDING_RELEASE_NAME.test(name));
      } catch {
        return none;
      }
      if (!names.length || (await this.hasUnreadable())) return none;
      const notes: string[] = [];
      const runIds = new Set<string>();
      const files: FileRelease[] = [];
      for (const name of names) {
        const note = path.join(this.layout.pendingReleases, name);
        let text: string;
        try {
          text = await withFsRetry(() => fs.readFile(note, "utf8"));
        } catch {
          // Taken by another process, or unreadable for now: the next pass gets it.
          continue;
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Torn or not ours: nothing it names can be trusted, so it goes.
        }
        const pending = parsePendingRelease(parsed, this.root);
        pending.runIds.forEach((runId) => runIds.add(runId));
        files.push(...pending.files);
        notes.push(note);
      }
      await this.collectRuns([...runIds]);
      const { retry, ...released } = await this.releaseFiles(files, { purge: options.purge === true, checkHash: true });
      // Entries that couldn't be checked or trashed this time go into a fresh note first,
      // so a crash between the two steps can't lose them.
      if (retry.length) await this.deferRelease([], retry);
      for (const note of notes) await unlinkWithRetry(note).catch(() => {});
      return released;
    });
  }

  /** Deletes the snapshots of these runs that no record (live or trashed) belongs to any more. */
  private async collectRuns(runIds: readonly string[]): Promise<void> {
    const orphaned = new Set(runIds);
    for (const record of this.sorted) {
      if (!orphaned.size) break;
      orphaned.delete(record.runId);
    }
    for (const runId of orphaned) {
      try {
        await this.runs.remove(runId);
      } catch (error) {
        console.warn("[assets] could not remove the snapshot of", runId, error);
      }
    }
  }

  /**
   * Re-checks that a file is the one being released before anything moves
   * or trashes it: where it should be, and its size — and with `checkHash`
   * (a release kept for later, so the file had time to change) its bytes.
   */
  private async isOwnedFile(release: FileRelease, file: string, checkHash: boolean): Promise<"owned" | "not-owned" | "unknown"> {
    if (release.file.root === "library") {
      if (!isInsideRoot(this.layout.generations, file, { platform: this.platform })) return "not-owned";
    } else if (file !== release.file.path || !isMediaExtension(extOf(file))) {
      return "not-owned";
    }
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size !== release.bytes) return "not-owned";
      if (!checkHash) return "owned";
      return (await hashFile(file)).sha256 === release.sha256 ? "owned" : "not-owned";
    } catch (error) {
      // Gone is an answer; anything else (locked, offline placeholder, permissions) is "not now".
      const code = errnoCode(error);
      return code === "ENOENT" || code === "ENOTDIR" ? "not-owned" : "unknown";
    }
  }

  /**
   * Releases each file no record uses any more. Returns what went to the OS
   * Trash, and `retry`: the entries that couldn't be checked or trashed right
   * now, for the caller to keep for a later pass.
   */
  private async releaseFiles(
    releases: FileRelease[],
    options: { purge: boolean; checkHash?: boolean },
  ): Promise<{ files: number; bytes: number; retry: FileRelease[] }> {
    const released = { files: 0, bytes: 0, retry: [] as FileRelease[] };
    const byFile = new Map<string, { release: FileRelease; file: string }>();
    for (const release of releases) {
      const file = this.locationPath(release.file);
      if (file) byFile.set(pathKey(file, this.platform), { release, file });
    }
    if (!byFile.size) return released;
    const { hashes: referenced, incomplete } = await this.runs.referencedHashes();
    // Held across the check and the release, so a recording that chose one of these files to reuse
    // has indexed its record before we look (sorted, so two deletes never wait on each other).
    const hashes = [...new Set([...byFile.values()].map(({ release }) => release.sha256))].sort();
    const unlocks: (() => void)[] = [];
    for (const sha256 of hashes) unlocks.push(await this.shaLocks.acquire(sha256));
    try {
      const toTrash: string[] = [];
      const trashing: FileRelease[] = [];
      let trashBytes = 0;
      for (const [key, { release, file }] of byFile) {
        if (this.byPath.get(key)?.size) continue;
        const owned = await this.isOwnedFile(release, file, options.checkHash === true);
        if (owned === "unknown") released.retry.push(release);
        if (owned !== "owned") continue;
        try {
          if (release.keep) {
            // The project keeps its file; a snapshot that needs the bytes gets a checked reference to it.
            if (referenced.has(release.sha256)) await this.runs.retainReference(release.sha256, file, release.bytes);
            continue;
          }
          // A snapshot that could not be read may need these bytes: keep them rather than guess.
          const needed = referenced.has(release.sha256) || incomplete;
          if (needed && (await this.runs.adoptFile(release.sha256, release.ext, file))) continue;
          toTrash.push(file);
          trashing.push(release);
          trashBytes += release.bytes;
        } catch (error) {
          console.warn("[assets] could not remove", file, error);
        }
      }
      if (!toTrash.length) return released;
      // The unprompted purge goes to the OS Trash too, by any route that can't put up a prompt.
      try {
        await this.trash(toTrash, { interactive: !options.purge });
        released.files = toTrash.length;
        released.bytes = trashBytes;
      } catch (error) {
        console.warn("[assets] could not remove", toTrash, error);
        // Whatever is still there is kept for a later pass.
        for (const [index, file] of toTrash.entries()) {
          if (await fs.stat(file).then(() => true, () => false)) released.retry.push(trashing[index]);
        }
      }
      return released;
    } finally {
      unlocks.forEach((unlock) => unlock());
    }
  }

  /**
   * Permanently deletes records that have been in the Trash longer than the
   * retention period, by the rules of a manual delete. It runs unprompted
   * at startup, so the files skip the one OS Trash route that asks for
   * rights (Finder's Automation prompt), and are unlinked only where no
   * other route exists.
   */
  async emptyExpiredTrash(retentionMs: number = TRASH_RETENTION_MS): Promise<number> {
    await this.ready();
    const cutoff = this.now() - retentionMs;
    const expired = this.sorted
      .filter((record) => record.trashedAt !== undefined && record.trashedAt <= cutoff)
      .map((record) => record.id);
    if (!expired.length) return 0;
    const result = await this.deleteRecords(expired, { purge: true });
    return result.affected;
  }

  /* Dedupe ----------------------------------------------------------- */

  /**
   * A file already holding these bytes in the destination, so a new record
   * can point at it instead of writing a copy. Library destinations match
   * anywhere under Generations/; project destinations match only that
   * project's generations folder (by index, then by the legacy
   * `_<md5>.<ext>` name). Sizes must match — a truncated file never wins.
   *
   * Uploads and other recordings never share a file. Node Banana 2.2.0 and
   * earlier can't read an upload's record, so they would release a file it
   * shares when they delete the other record for good. An upload reuses
   * only a file another upload holds, never one with no record (such a
   * build may import it); any other recording never reuses an upload's.
   */
  async findReusableFile(input: {
    sha256: string;
    md5: string;
    bytes: number;
    ext: string;
    origin: AssetOrigin;
    destination: { type: "library" } | { type: "project"; dir: string };
  }): Promise<{ file: AssetFileLocation; path: string; filename: string; source?: AssetRecord } | null> {
    const sizeMatches = async (file: string) => {
      try {
        const stat = await fs.stat(file);
        return stat.isFile() && stat.size === input.bytes;
      } catch {
        return false;
      }
    };
    const destination = input.destination;
    const upload = input.origin === "uploaded";
    for (const record of this.recordsWithHash(input.sha256)) {
      const file = this.filePath(record);
      if (!file || record.bytes !== input.bytes || (record.origin === "uploaded") !== upload) continue;
      if (destination.type === "library") {
        if (record.file.root !== "library" || !isInsideRoot(this.layout.generations, file, { platform: this.platform })) continue;
      } else if (record.file.root !== "external" || pathKey(path.dirname(file), this.platform) !== pathKey(destination.dir, this.platform)) {
        continue;
      }
      if (await sizeMatches(file)) {
        return { file: record.file, path: file, filename: path.basename(file), source: record };
      }
    }
    if (destination.type === "project" && !upload) {
      let names: string[] = [];
      try {
        names = await fs.readdir(destination.dir);
      } catch {
        names = [];
      }
      const suffix = `_${input.md5}.${input.ext}`.toLowerCase();
      for (const name of names) {
        if (!name.toLowerCase().endsWith(suffix)) continue;
        const file = path.join(destination.dir, name);
        if (this.recordsAtPath(file).some((record) => record.origin === "uploaded")) continue;
        if (await sizeMatches(file)) return { file: { root: "external", path: file }, path: file, filename: name };
      }
    }
    return null;
  }
}

