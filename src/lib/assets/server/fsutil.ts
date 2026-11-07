/**
 * Filesystem primitives for the library: crash-safe writes, streamed media
 * writes that hash as they go, path containment, and the bounded retries
 * Windows needs when a file is held open (a playing video, the indexer,
 * antivirus).
 */

import { createHash, randomUUID } from "crypto";
import { createReadStream, promises as fs } from "fs";
import path from "path";
import { errnoCode, LibraryError } from "./errors";

/* ------------------------------------------------------------------ */
/* Containment                                                         */
/* ------------------------------------------------------------------ */

function apiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** APFS and NTFS are case-insensitive by default, so paths compare folded there. */
export function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * True when `candidate` is strictly inside `root` (or equal to it with
 * `allowEqual`). Both are resolved with the platform's path module, so
 * `C:\a/b`, trailing separators and `..` segments compare correctly, and
 * `C:\rootx` is not inside `C:\root`.
 */
export function isInsideRoot(
  root: string,
  candidate: string,
  options: { platform?: NodeJS.Platform; allowEqual?: boolean } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const api = apiFor(platform);
  let a = api.resolve(root);
  let b = api.resolve(candidate);
  if (foldsCase(platform)) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = api.relative(a, b);
  if (rel === "") return options.allowEqual === true;
  return rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/**
 * `candidate` moved along with `fromDir` to `toDir`: the same place under
 * `toDir`, or null when it is not `fromDir` or inside it. The tail is cut by
 * length, since on a disk that folds case the two may be spelled differently.
 */
export function rebasePath(
  fromDir: string,
  toDir: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isInsideRoot(fromDir, candidate, { platform, allowEqual: true })) return null;
  const api = apiFor(platform);
  const rest = api.resolve(candidate).slice(api.resolve(fromDir).length).replace(/^[\\/]+/, "");
  return rest ? api.join(api.resolve(toDir), rest) : api.resolve(toDir);
}

/** A map key for a path: resolved, and case-folded where the filesystem folds case. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = apiFor(platform).resolve(p);
  return foldsCase(platform) ? resolved.toLowerCase() : resolved;
}

/* ------------------------------------------------------------------ */
/* Retries                                                             */
/* ------------------------------------------------------------------ */

const RETRY_DELAYS_MS = [40, 80, 160, 320, 640];

function isRetryable(error: unknown): boolean {
  const code = errnoCode(error);
  // EPERM is a transient sharing violation on Windows; elsewhere it is a real refusal.
  return code === "EBUSY" || (code === "EPERM" && process.platform === "win32");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries a rename/unlink of an existing file a few times while something else holds it. */
export async function withFsRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryable(error)) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function renameWithRetry(from: string, to: string): Promise<void> {
  return withFsRetry(() => fs.rename(from, to));
}

/** Unlinks a file; a file that is already gone counts as success. */
export async function unlinkWithRetry(file: string): Promise<void> {
  try {
    await withFsRetry(() => fs.unlink(file));
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Small-file writes                                                   */
/* ------------------------------------------------------------------ */

async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Some filesystems refuse directory fsync; the rename itself is durable enough there.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Writes via a uniquely named temp file and a rename, so readers (including
 * another process) see the old file or the new one, never a torn write.
 * `fsync` is for first writes of records that must survive a crash; rewrites
 * of mutable state skip it (a lost tag toggle is acceptable, a slow bulk tag
 * of 20k sidecars is not).
 */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  options: {
    fsync: boolean;
    /** A short temp name in the same folder, for a file whose own name leaves no room for the suffix (255 bytes). */
    shortTemp?: boolean;
  },
): Promise<void> {
  const temporary = options.shortTemp
    ? path.join(path.dirname(file), `.${randomUUID()}.tmp`)
    : `${file}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o644);
    await handle.writeFile(data);
    if (options.fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, file);
    if (options.fsync) await fsyncDirectory(path.dirname(file));
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Streamed media writes                                               */
/* ------------------------------------------------------------------ */

export const PARTIAL_SUFFIX = ".partial";
/** Bytes kept from the start of a stream for type sniffing. */
export const SNIFF_BYTES = 64 * 1024;

export interface StreamedFile {
  /** `<dir>/<uuid>.partial` — renamed into place by the caller, or discarded. */
  partialPath: string;
  bytes: number;
  sha256: string;
  md5: string;
  /** The first {@link SNIFF_BYTES} bytes. */
  head: Buffer;
}

export interface StreamOptions {
  maxBytes: number;
  /** Abort when no bytes arrive for this long. */
  idleTimeoutMs?: number;
  /** Called on an idle timeout or when the cap is exceeded, to cancel the source (e.g. abort a fetch). */
  onAbort?: () => void;
  signal?: AbortSignal;
}

type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/**
 * A web stream is read through its reader even though it is also async
 * iterable: the reader's `cancel()` settles a read that is still waiting,
 * whereas the iterator's `return()` waits for that read — so a stalled
 * upload could never be let go of.
 */
function iterate(source: ByteSource): AsyncIterator<Uint8Array> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    return {
      next: () => reader.read() as Promise<IteratorResult<Uint8Array>>,
      return: async () => {
        await reader.cancel().catch(() => {});
        return { done: true, value: undefined };
      },
    };
  }
  return (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
}

/** Waits for `promise`, but no longer than `ms` (a source that won't close must not hold us). */
async function settleWithin(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!promise) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

async function nextWithTimeout(
  iterator: AsyncIterator<Uint8Array>,
  timeoutMs: number | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (!timeoutMs) return iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LibraryError("The download stalled and was abandoned.", 504, "timeout")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams bytes into `<dir>/<uuid>.partial`, hashing (SHA-256 and MD5) as
 * they arrive, with a running size cap and an idle timeout, then fsyncs.
 * The `.partial` name is never a media extension, so listings ignore it and
 * a crash leaves nothing that looks like a finished file.
 */
export async function streamToPartial(source: ByteSource, dir: string, options: StreamOptions): Promise<StreamedFile> {
  await fs.mkdir(dir, { recursive: true });
  const partialPath = path.join(dir, `${randomUUID()}${PARTIAL_SUFFIX}`);
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let bytes = 0;
  const iterator = iterate(source);
  const handle = await fs.open(partialPath, "wx", 0o644);
  let finished = false;
  try {
    for (;;) {
      if (options.signal?.aborted) throw new LibraryError("Cancelled", 499, "cancelled");
      const { done, value } = await nextWithTimeout(iterator, options.idleTimeoutMs);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        throw new LibraryError(
          `The file is larger than the ${Math.round(options.maxBytes / (1024 * 1024))} MB limit.`,
          413,
          "too_large",
        );
      }
      sha256.update(chunk);
      md5.update(chunk);
      if (headBytes < SNIFF_BYTES) {
        const slice = chunk.subarray(0, SNIFF_BYTES - headBytes);
        headChunks.push(Buffer.from(slice));
        headBytes += slice.byteLength;
      }
      await handle.write(chunk);
    }
    await handle.sync();
    finished = true;
  } catch (error) {
    options.onAbort?.();
    await settleWithin(iterator.return?.(), 1000);
    throw error;
  } finally {
    await handle.close().catch(() => {});
    if (!finished) await fs.rm(partialPath, { force: true }).catch(() => {});
  }
  return {
    partialPath,
    bytes,
    sha256: sha256.digest("hex"),
    md5: md5.digest("hex"),
    head: Buffer.concat(headChunks),
  };
}

export async function discardPartial(file: StreamedFile | string): Promise<void> {
  const target = typeof file === "string" ? file : file.partialPath;
  await fs.rm(target, { force: true }).catch(() => {});
}

/** Moves a finished `.partial` into place (replacing a stale file of the same name). */
export async function commitPartial(partialPath: string, finalPath: string): Promise<void> {
  await renameWithRetry(partialPath, finalPath);
}

/** Removes `.partial` and `.tmp` leftovers older than `olderThanMs` from one folder. */
export async function sweepStaleTemps(dir: string, olderThanMs: number, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(PARTIAL_SUFFIX) && !name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || now - stat.mtimeMs < olderThanMs) continue;
      await unlinkWithRetry(file);
      removed++;
    } catch {
      // Held open or already gone; the next sweep gets it.
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* Hashing and copying                                                 */
/* ------------------------------------------------------------------ */

export interface FileDigest {
  bytes: number;
  sha256: string;
  md5: string;
}

export async function hashFile(file: string, signal?: AbortSignal): Promise<FileDigest> {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new LibraryError("Cancelled", 499, "cancelled");
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      sha256.update(buffer);
      md5.update(buffer);
    }
  } finally {
    stream.destroy();
  }
  return { bytes, sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}

/**
 * Copies a file through a `.partial` next to the destination, hashing the
 * source as it is read, then re-reads the copy and checks size and hash
 * (and `expectSha256`, when given) before renaming it into place. Returns
 * the verified digest.
 */
export async function copyFileVerified(
  source: string,
  destination: string,
  options: { signal?: AbortSignal; onBytes?: (bytes: number) => void; expectSha256?: string } = {},
): Promise<FileDigest> {
  const stream = createReadStream(source, { highWaterMark: 1024 * 1024 });
  const counted = (async function* () {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      options.onBytes?.(buffer.byteLength);
      yield new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
  })();
  let written: StreamedFile;
  try {
    written = await streamToPartial(counted, path.dirname(destination), {
      maxBytes: Number.MAX_SAFE_INTEGER,
      signal: options.signal,
    });
  } finally {
    stream.destroy();
  }
  try {
    const check = await hashFile(written.partialPath, options.signal);
    if (
      check.bytes !== written.bytes ||
      check.sha256 !== written.sha256 ||
      (options.expectSha256 !== undefined && check.sha256 !== options.expectSha256)
    ) {
      throw new LibraryError(`The copy of ${path.basename(source)} did not verify.`, 500, "hash_mismatch");
    }
    await commitPartial(written.partialPath, destination);
  } catch (error) {
    await discardPartial(written);
    throw error;
  }
  return { bytes: written.bytes, sha256: written.sha256, md5: written.md5 };
}

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** An async mutex per key: callers with the same key run one at a time, in arrival order. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Waits for `key` and holds it until the returned function is called (for holding several keys at once). */
  acquire(key: string): Promise<() => void> {
    return new Promise((acquired) => {
      void this.run(key, () => new Promise<void>((release) => acquired(release)));
    });
  }

  get size(): number {
    return this.tails.size;
  }
}

/** A counting semaphore. */
export class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Marks a folder hidden on Windows (best effort; dot-folders are hidden elsewhere). */
export function hideOnWindows(dir: string): void {
  if (process.platform !== "win32") return;
  import("child_process")
    .then(({ execFile }) => {
      execFile("attrib", ["+h", dir], { windowsHide: true, timeout: 5000 }, () => {});
    })
    .catch(() => {});
}
