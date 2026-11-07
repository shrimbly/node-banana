/**
 * Recording: bytes in, file and record out.
 *
 * Uploads are two-step so no body is ever buffered: `begin` checks the
 * metadata and hands out a ticket (10 minutes), then `complete` streams the
 * PUT body into a `.partial` file in the destination folder, hashing as it
 * goes. URL sources are downloaded the same way. Then, serialised per
 * SHA-256: reuse a file with the same bytes in the destination if there is
 * one, else rename the partial into place; measure it; write the sidecar.
 * Uploads share files only with uploads (see `findReusableFile`), and one
 * in a format the library doesn't store is refused. Bytes nothing can open
 * (readable.ts) are still written and recorded — a recording is never
 * refused or lost for that — but the record is marked `unreadable`, so it
 * is not listed.
 *
 * Every recording gets its own record under the client-minted id — records
 * are never collapsed, only bytes are shared.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type {
  AssetFileLocation,
  AssetRecord,
  RecordAssetMeta,
  RecordAssetRequest,
  RecordAssetResult,
  UploadTicket,
} from "../types";
import { downloadToPartial, MAX_DOWNLOAD_BYTES, type DownloadOptions } from "./download";
import { LibraryError, PAUSED_RETRY_AFTER, pausedError } from "./errors";
import {
  commitPartial,
  discardPartial,
  isInsideRoot,
  pathKey,
  streamToPartial,
  sweepStaleTemps,
  unlinkWithRetry,
  type StreamedFile,
} from "./fsutil";
import { relFromPath, type AssetLibrary } from "./library";
import { decideMediaType, imageDimensionsFromFile, probeAudioVideo, type ProbeResult } from "./media";
import { isUnreadableFile } from "./readable";
import type { Thumbnailer } from "./thumbs";
import {
  libraryFileName,
  localDay,
  mediaExtFromUrl,
  normaliseProjectDir,
  projectFileName,
  validateRecordMeta,
} from "./validate";

export const UPLOAD_TICKET_TTL_MS = 10 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
const MAX_OPEN_TICKETS = 2000;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Partial files older than this are leftovers from a crash or an abandoned upload. */
export const STALE_PARTIAL_MS = 60 * 60 * 1000;

type Destination =
  | { type: "library"; dir: string }
  | { type: "project"; dir: string; projectDir: string };

interface Ticket {
  meta: RecordAssetMeta;
  expiresAt: number;
}

export interface IngestDeps {
  /** The current library (it changes when the root is switched or moved). */
  library(): AssetLibrary;
  thumbs(): Thumbnailer | null;
  /** True while a library move is copying files. */
  isPaused(): boolean;
  download?: DownloadOptions;
  now?: () => number;
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** The library root itself, or a folder inside its Generations or data folder. */
function isLibraryFolder(library: AssetLibrary, dir: string): boolean {
  const options = { platform: library.platform, allowEqual: true };
  return (
    pathKey(dir, library.platform) === pathKey(library.root, library.platform) ||
    isInsideRoot(library.layout.generations, dir, options) ||
    isInsideRoot(library.layout.data, dir, options)
  );
}

function withoutUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

export class Ingestor {
  private readonly tickets = new Map<string, Ticket>();
  private readonly sweptDirs = new Set<string>();
  private active = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: IngestDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Recordings currently streaming or finalising. */
  get inFlight(): number {
    return this.active;
  }

  /** Resolves when no recording is in flight (or after `timeoutMs`). */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Counts a recording as in flight. The pause check sits here, with no
   * await before the count, so a move here never misses one; the library
   * publishes it for a move in the other build (which then waits for it).
   */
  private async track<T>(work: (library: AssetLibrary) => Promise<T>): Promise<T> {
    this.assertNotPaused();
    this.active++;
    try {
      const library = this.deps.library();
      return await library.writing(() => work(library));
    } finally {
      this.active--;
      if (this.active === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        waiters.forEach((wake) => wake());
      }
    }
  }

  private assertNotPaused(): void {
    if (this.deps.isPaused()) {
      throw pausedError("The library is being moved. Recording resumes in a moment.");
    }
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(id);
  }

  /** `upload` → a ticket for the PUT; `url` → downloads and records now. */
  async begin(request: RecordAssetRequest): Promise<{ ticket: UploadTicket } | { result: RecordAssetResult }> {
    if (!request || typeof request !== "object" || !request.source) {
      throw new LibraryError("meta and source are required", 400, "bad_request");
    }
    const meta = validateRecordMeta(request.meta, this.now());
    this.assertNotPaused();

    // A retry of a recording that already finished gets the same answer again.
    const library = this.deps.library();
    const existing = await library.find(meta.id);
    if (existing) return { result: this.resultFor(library, existing, true) };

    if (request.source.type === "url") {
      if (typeof request.source.url !== "string") throw new LibraryError("source.url is required", 400, "bad_request");
      return { result: await this.recordFromUrl(meta, request.source.url) };
    }
    if (request.source.type !== "upload") throw new LibraryError("Unknown source type", 400, "bad_request");

    this.sweepExpired();
    if (this.tickets.size >= MAX_OPEN_TICKETS) {
      throw new LibraryError("Too many uploads are waiting. Try again shortly.", 503, "busy", PAUSED_RETRY_AFTER);
    }
    const uploadId = randomUUID();
    const expiresAt = this.now() + UPLOAD_TICKET_TTL_MS;
    this.tickets.set(uploadId, { meta, expiresAt });
    return { ticket: { uploadId, expiresAt } };
  }

  /** Streams the PUT body to disk while hashing, then finalises the record. */
  async complete(
    uploadId: string,
    body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    contentType: string | null,
  ): Promise<RecordAssetResult> {
    if (!UPLOAD_ID.test(uploadId)) throw new LibraryError("Invalid upload id", 400, "bad_request");
    const ticket = this.tickets.get(uploadId);
    if (!ticket) throw new LibraryError("This upload expired or was already used. Start it again.", 404, "not_found");
    if (ticket.expiresAt <= this.now()) {
      this.tickets.delete(uploadId);
      throw new LibraryError("This upload expired. Start it again.", 410, "gone");
    }
    // Paused: the ticket stays valid so the client can resend after Retry-After.
    this.assertNotPaused();
    this.tickets.delete(uploadId);
    const meta = ticket.meta;
    let started = false;
    try {
      return await this.track(async (library) => {
        started = true;
        const destination = await this.resolveDestination(library, meta);
        const streamed = await streamToPartial(body, destination.dir, {
          maxBytes: MAX_UPLOAD_BYTES,
          idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
        });
        return this.finalize(library, meta, destination, streamed, { mime: meta.mime ?? contentType });
      });
    } catch (error) {
      // Refused before the body was read (the other build's move took the lock): the ticket stays good.
      if (!started && error instanceof LibraryError && error.code === "paused") this.tickets.set(uploadId, ticket);
      throw error;
    }
  }

  private recordFromUrl(meta: RecordAssetMeta, url: string): Promise<RecordAssetResult> {
    return this.track(async (library) => {
      const destination = await this.resolveDestination(library, meta);
      const download = await downloadToPartial(url, destination.dir, {
        maxBytes: MAX_DOWNLOAD_BYTES,
        ...this.deps.download,
      });
      return this.finalize(library, meta, destination, download.file, {
        mime: meta.mime ?? download.contentType,
        ext: mediaExtFromUrl(download.finalUrl) ?? mediaExtFromUrl(url),
      });
    });
  }

  /**
   * `<project>/generations` when the project folder exists (created if
   * needed), else the library's day folder — an asset is never lost because
   * its project folder moved or was never created. A "project" that is the
   * library root, or inside its Generations or data folder, is the library:
   * its `generations` folder would be the library's own (case-insensitive
   * disks), and a library move would carry the files away from the project.
   */
  private async resolveDestination(library: AssetLibrary, meta: RecordAssetMeta): Promise<Destination> {
    if (meta.projectDir) {
      try {
        const projectDir = normaliseProjectDir(meta.projectDir);
        if (isLibraryFolder(library, projectDir)) throw new Error("the library is not a project");
        const stat = await fs.stat(projectDir);
        if (stat.isDirectory()) {
          const dir = path.join(projectDir, "generations");
          await fs.mkdir(dir, { recursive: true });
          await this.sweepOnce(dir);
          return { type: "project", dir, projectDir };
        }
      } catch {
        // Missing, unreadable or invalid: record into the library instead.
      }
    }
    const dir = path.join(library.layout.generations, localDay(meta.createdAt));
    await fs.mkdir(dir, { recursive: true });
    return { type: "library", dir };
  }

  /** Project folders are not swept at library init, so sweep each once per process on first use. */
  private async sweepOnce(dir: string): Promise<void> {
    if (this.sweptDirs.has(dir)) return;
    this.sweptDirs.add(dir);
    await sweepStaleTemps(dir, STALE_PARTIAL_MS, this.now());
  }

  /** A name in `dir` no record points at (a same-named file with no record is a stale leftover to replace). */
  private freeTarget(library: AssetLibrary, dir: string, filename: string): string {
    let candidate = path.join(dir, filename);
    const dot = filename.lastIndexOf(".");
    for (let n = 2; library.recordsAtPath(candidate).length > 0 && n < 1000; n++) {
      candidate = path.join(dir, `${filename.slice(0, dot)}_${n}${filename.slice(dot)}`);
    }
    return candidate;
  }

  private async finalize(
    library: AssetLibrary,
    meta: RecordAssetMeta,
    destination: Destination,
    streamed: StreamedFile,
    hints: { mime?: string | null; ext?: string | null },
  ): Promise<RecordAssetResult> {
    if (streamed.bytes === 0) {
      await discardPartial(streamed);
      throw new LibraryError("The file is empty", 400, "bad_request");
    }
    const type = decideMediaType({ head: streamed.head, kind: meta.kind, hintMime: hints.mime, hintExt: hints.ext });
    if (meta.origin === "uploaded" && type.assumed) {
      // The user's own file in a format the library doesn't store (AVI, AIFF…): kept, it would be named and
      // served as the kind's default, which it isn't.
      await discardPartial(streamed);
      throw new LibraryError("The file isn't in a video or audio format the library can keep", 415, "unsupported");
    }

    // The library's lock, which a permanent delete takes too before it releases a file with these bytes.
    return library.shaLocks.run(streamed.sha256, async () => {
      const existing = await library.find(meta.id);
      if (existing) {
        await discardPartial(streamed);
        return this.resultFor(library, existing, true);
      }

      const reusable = await library.findReusableFile({
        sha256: streamed.sha256,
        md5: streamed.md5,
        bytes: streamed.bytes,
        ext: type.ext,
        origin: meta.origin,
        destination: destination.type === "library" ? { type: "library" } : { type: "project", dir: destination.dir },
      });

      let location: AssetFileLocation;
      let filename: string;
      let absolute: string;
      let mime = type.mime;
      let ext = type.ext;
      let measured: ProbeResult;
      if (reusable) {
        await discardPartial(streamed);
        location = reusable.file;
        filename = reusable.filename;
        absolute = reusable.path;
        if (reusable.source) {
          mime = reusable.source.mime;
          ext = reusable.source.ext;
        }
        measured = reusable.source
          ? { width: reusable.source.width, height: reusable.source.height, durationSec: reusable.source.durationSec }
          : await this.measure(type.kind, ext, absolute, streamed.head);
      } else {
        const name =
          destination.type === "project"
            ? projectFileName(meta.prompt, streamed.md5, ext)
            : libraryFileName(meta, streamed.sha256, ext);
        absolute = this.freeTarget(library, destination.dir, name);
        filename = path.basename(absolute);
        try {
          await commitPartial(streamed.partialPath, absolute);
        } catch (error) {
          await discardPartial(streamed);
          throw error;
        }
        location =
          destination.type === "project"
            ? { root: "external", path: absolute }
            : { root: "library", rel: relFromPath(library.root, absolute) };
        measured = await this.measure(type.kind, ext, absolute, streamed.head);
      }
      // Bytes nothing can open are still kept, file and record, but not listed. Reused bytes have
      // their answer already.
      const unreadable = reusable?.source
        ? reusable.source.unreadable === true
        : await isUnreadableFile(absolute, type, measured);

      const record: AssetRecord = withoutUndefined({
        v: 1,
        id: meta.id,
        kind: type.kind,
        origin: meta.origin,
        mime,
        ext,
        bytes: streamed.bytes,
        sha256: streamed.sha256,
        md5: streamed.md5,
        file: location,
        filename,
        name: meta.name,
        ...(measured.width && measured.height
          ? { width: measured.width, height: measured.height }
          : meta.width && meta.height
            ? { width: meta.width, height: meta.height }
            : {}),
        durationSec: measured.durationSec ?? meta.durationSec,
        createdAt: meta.createdAt,
        prompt: meta.prompt,
        model: meta.model,
        parameters: meta.parameters,
        aspectRatio: meta.aspectRatio,
        resolution: meta.resolution,
        cost: meta.cost,
        producer: meta.producer,
        workflowId: meta.workflowId,
        workflowName: meta.workflowName,
        runId: meta.runId,
        ...(meta.batch ? { batch: meta.batch } : {}),
        tags: meta.tags ?? [],
        favorite: false,
        ...(unreadable ? { unreadable: true as const } : {}),
      } satisfies AssetRecord);

      let saved: AssetRecord;
      try {
        saved = await library.addRecord(record);
      } catch (error) {
        // A new file with no sidecar would be an orphan; a reused one belongs to another record, and
        // once the sidecar is on disk the file is this record's (a retry answers with it).
        if (!reusable && !(await library.hasSidecar(meta.id))) await unlinkWithRetry(absolute).catch(() => {});
        throw error;
      }
      this.deps.thumbs()?.enqueue(saved, absolute);
      return { asset: library.toView(saved), filename, legacyId: stem(filename), reusedFile: Boolean(reusable) };
    });
  }

  private async measure(kind: AssetRecord["kind"], ext: string, file: string, head: Buffer): Promise<ProbeResult> {
    if (kind === "image") {
      const dims = await imageDimensionsFromFile(file, ext, head);
      return dims ?? {};
    }
    if (kind === "video" || kind === "audio") return probeAudioVideo({ path: file }, kind);
    return {};
  }

  private resultFor(library: AssetLibrary, record: AssetRecord, reusedFile: boolean): RecordAssetResult {
    return { asset: library.toView(record), filename: record.filename, legacyId: stem(record.filename), reusedFile };
  }

  /** Test hook. */
  ticketCount(): number {
    return this.tickets.size;
  }
}
