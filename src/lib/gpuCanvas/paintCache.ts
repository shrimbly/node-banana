/**
 * The disk cache of painted node images, so reopening a workflow shows its
 * nodes without painting them again.
 *
 * Each image is stored under its paint key and tier (see paintKey.ts) as raw
 * RGBA, deflated: lossless, and decoded without a canvas (a 2D canvas would
 * premultiply and round the shadows' edges). Alongside it go the node's
 * measured height and handle anchors, which the scene needs before it can
 * draw the node in place. Entries live in IndexedDB, which the browser keeps
 * on disk per origin (the desktop app's origin is fixed), and the oldest
 * used are dropped above the size cap.
 */

export interface CachedPaint {
  /** Paint key and tier. */
  key: string;
  /** The image's size in texels. */
  width: number;
  height: number;
  /** The node's measured height, in flow units. */
  nodeHeight: number;
  /** Handle anchors: [key, x, y]. */
  handles: [string, number, number][];
  /** Deflated RGBA. */
  bytes: Blob;
  size: number;
  usedAt: number;
}

export interface PaintStore {
  get(key: string): Promise<CachedPaint | undefined>;
  /** Every key held. */
  keys(): Promise<Set<string>>;
  put(entry: CachedPaint): Promise<void>;
  /** Marks entries used, so they outlive older ones. */
  touch(keys: readonly string[]): Promise<void>;
  /** Drops the least recently used entries until the total is at most `bytes`. */
  trim(bytes: number): Promise<void>;
  clear(): Promise<void>;
}

/** Total size the cache keeps, compressed. */
export const PAINT_CACHE_BYTES = 512 * 2 ** 20;

export function cacheKey(paintKey: string, tier: number) {
  return `${paintKey}@${tier}`;
}

async function transform(bytes: BlobPart, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
}

export function compressionAvailable() {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

export async function deflate(pixels: Uint8Array): Promise<Blob> {
  return new Blob([await transform(pixels as BlobPart, new CompressionStream("deflate-raw"))]);
}

export async function inflate(bytes: Blob): Promise<Uint8Array> {
  return new Uint8Array(await transform(bytes, new DecompressionStream("deflate-raw")));
}

/** An in-memory store, for tests and for browsers without IndexedDB. */
export class MemoryPaintStore implements PaintStore {
  readonly entries = new Map<string, CachedPaint>();
  async get(key: string) {
    return this.entries.get(key);
  }
  async keys() {
    return new Set(this.entries.keys());
  }
  async put(entry: CachedPaint) {
    this.entries.set(entry.key, entry);
  }
  async touch(keys: readonly string[]) {
    const now = Date.now();
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) entry.usedAt = now;
    }
  }
  async trim(bytes: number) {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    for (const entry of [...this.entries.values()].sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= bytes) break;
      this.entries.delete(entry.key);
      total -= entry.size;
    }
  }
  async clear() {
    this.entries.clear();
  }
}

const DB_NAME = "node-banana-paint-cache";
const STORE = "images";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbPaintStore implements PaintStore {
  private db: Promise<IDBDatabase>;

  constructor(name = DB_NAME) {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("usedAt", "usedAt");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async store(mode: IDBTransactionMode) {
    return (await this.db).transaction(STORE, mode).objectStore(STORE);
  }

  async get(key: string) {
    return (await request((await this.store("readonly")).get(key))) as CachedPaint | undefined;
  }

  async put(entry: CachedPaint) {
    await request((await this.store("readwrite")).put(entry));
  }

  async keys() {
    return new Set((await request((await this.store("readonly")).getAllKeys())) as string[]);
  }

  async touch(keys: readonly string[]) {
    if (!keys.length) return;
    const store = await this.store("readwrite");
    const now = Date.now();
    await Promise.all(keys.map(async (key) => {
      const entry = (await request(store.get(key))) as CachedPaint | undefined;
      if (entry) {
        entry.usedAt = now;
        await request(store.put(entry));
      }
    }));
  }

  async trim(bytes: number) {
    const store = await this.store("readwrite");
    const sizes = (await request(store.index("usedAt").getAll())) as CachedPaint[];
    let total = sizes.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of sizes) {
      if (total <= bytes) break;
      store.delete(entry.key);
      total -= entry.size;
    }
  }

  async clear() {
    await request((await this.store("readwrite")).clear());
  }
}

/** The cache the painter uses: IndexedDB where it exists and compression works, else none. */
export function openPaintStore(): PaintStore | null {
  if (typeof indexedDB === "undefined" || !compressionAvailable()) return null;
  try {
    return new IndexedDbPaintStore();
  } catch {
    return null;
  }
}
