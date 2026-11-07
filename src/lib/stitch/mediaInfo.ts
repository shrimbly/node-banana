/**
 * What the Stitch card and editor know about each clip's video: its length,
 * size and frame rate, and up to FILMSTRIP_FRAMES frames. A browser-only
 * module cache, shared by every card and the editor, never written into the
 * workflow store (frames are object URLs owned here).
 *
 * The length is measured the engine's way (measureVideoTrackDuration in
 * video-probing, with a mediabunny probe), so a clip lasts what the timeline
 * shows. A <video> element's duration is only the fallback when mediabunny
 * cannot open the file; a file it opens without a video track, or with one
 * of no length, is unreadable here as it is to the encode.
 *
 * One job runs at a time, in priority order: every pending metadata job,
 * then posters, then filmstrips. Entries no one retains are kept in an LRU
 * of LRU_LIMIT; eviction revokes their frames.
 */

export const FILMSTRIP_FRAMES = 12;
/** ≈ 29% in. */
export const POSTER_FRAME = 3;
/** JPEG at 0.7; the height follows the video's aspect. */
export const FRAME_WIDTH = 160;

const LRU_LIMIT = 48;
const LOAD_TIMEOUT_MS = 20_000;
const SEEK_TIMEOUT_MS = 10_000;
/** A probe still running after this is abandoned for the element, so one stalled source never holds the queue. */
const PROBE_TIMEOUT_MS = LOAD_TIMEOUT_MS;

export type MediaInfoLevel = "metadata" | "poster" | "filmstrip";

export interface StitchMediaInfo {
  status: "loading" | "ready" | "error";
  /** The source duration D, as the engine measures it; the element's duration only as a fallback. */
  duration: number | null;
  /** Display size. */
  width: number | null;
  height: number | null;
  /** computePacketStats(120).averagePacketRate, for display; null when not probed. */
  fps: number | null;
  /** FILMSTRIP_FRAMES slots of object URLs; the poster level fills POSTER_FRAME only. */
  frames: ReadonlyArray<string | null>;
  /** The highest level completed. */
  level: MediaInfoLevel | null;
}

/** What the mediabunny probe reads. */
export interface MediaProbe {
  /** D; 0 when the file has no video track, or one of no length (the encode drops such a clip). */
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
}

/** An opened <video>. */
export interface MediaElementHandle {
  /** The element's own duration; can be NaN or Infinity. */
  duration: number;
  width: number;
  height: number;
  /** The frame at this time as an object URL, or null when it cannot be drawn. */
  frame(time: number): Promise<string | null>;
  close(): void;
}

/** How the worker reads a source. Tests swap it in with __setMediaExtractorForTests. */
export interface MediaExtractor {
  /** Throws when mediabunny cannot open the source. Stops reading once `signal` aborts (the probe timed out). */
  probe(src: string, signal?: AbortSignal): Promise<MediaProbe>;
  /** Throws when the element cannot load the source. */
  open(src: string): Promise<MediaElementHandle>;
}

const LEVEL_RANK: Record<MediaInfoLevel, number> = { metadata: 0, poster: 1, filmstrip: 2 };

interface Entry {
  key: string;
  src: string;
  /** The highest level asked for. */
  want: number;
  info: StitchMediaInfo;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
const retainCounts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let clock = 0;
let running = false;
/** Bumped by the test reset, so a job still in flight from before stops there. */
let generation = 0;

/** Characters of a data: URL the fingerprint reads, spread across all of it, besides its last DATA_KEY_TAIL. */
const DATA_KEY_SAMPLES = 8192;
const DATA_KEY_TAIL = 256;

/**
 * data: URLs are keyed by a fingerprint, anything else by itself. The fingerprint is the length and an FNV-1a hash
 * of characters spread over the whole payload plus its tail: two takes of fixed-length audio or video have the same
 * length and often the same tail (silence, a tag), but differ all through. Sampling keeps it cheap enough to compute
 * on a render for a payload of megabytes.
 */
export function mediaKeyOf(src: string): string {
  if (!src.startsWith("data:")) return src;
  const n = src.length;
  let hash = 0x811c9dc5;
  const mix = (code: number) => {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193);
  };
  const body = Math.max(0, n - DATA_KEY_TAIL);
  const stride = Math.max(1, body / DATA_KEY_SAMPLES);
  for (let i = 0; i < body; i += stride) mix(src.charCodeAt(Math.floor(i)));
  for (let i = body; i < n; i++) mix(src.charCodeAt(i));
  return `d:${n}:${(hash >>> 0).toString(36)}`;
}

export function assetMediaKey(assetId: string): string {
  return `a:${assetId}`;
}

export function getMediaInfo(key: string): StitchMediaInfo | undefined {
  return entries.get(key)?.info;
}

/** Bumped on every change; a useSyncExternalStore snapshot. */
export function getMediaInfoVersion(): number {
  return version;
}

export function subscribeMediaInfo(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** The middle of the frame's cell: (index + 0.5) · duration / FILMSTRIP_FRAMES. */
export function frameTime(index: number, duration: number): number {
  return ((index + 0.5) * duration) / FILMSTRIP_FRAMES;
}

/** The extracted frame closest to sourceTime, or null when none is. */
export function nearestFrame(info: Pick<StitchMediaInfo, "frames" | "duration">, sourceTime: number): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (let index = 0; index < info.frames.length; index++) {
    const frame = info.frames[index];
    if (!frame) continue;
    if (info.duration === null) return frame;
    const distance = Math.abs(frameTime(index, info.duration) - sourceTime);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

function emptyInfo(): StitchMediaInfo {
  return {
    status: "loading",
    duration: null,
    width: null,
    height: null,
    fps: null,
    frames: Array<string | null>(FILMSTRIP_FRAMES).fill(null),
    level: null,
  };
}

function revokeFrames(info: StitchMediaInfo): void {
  for (const frame of info.frames) if (frame) URL.revokeObjectURL(frame);
}

function isRetained(key: string): boolean {
  return (retainCounts.get(key) ?? 0) > 0;
}

/** Drops the least recently requested entries past the limit, counting only those nothing retains. */
function evict(): void {
  const loose = [...entries.values()].filter((e) => !isRetained(e.key)).sort((a, b) => a.lastUsed - b.lastUsed);
  let changed = false;
  for (let i = 0; i < loose.length - LRU_LIMIT; i++) {
    revokeFrames(loose[i].info);
    entries.delete(loose[i].key);
    changed = true;
  }
  if (changed) notify();
}

/** Idempotent; a higher level upgrades what is already there. An unreadable source is not retried (see retryMediaInfo). */
export function requestMediaInfo(key: string, src: string, level: MediaInfoLevel): void {
  let entry = entries.get(key);
  if (!entry) {
    entry = { key, src, want: LEVEL_RANK[level], info: emptyInfo(), lastUsed: ++clock };
    entries.set(key, entry);
    notify();
  } else {
    entry.want = Math.max(entry.want, LEVEL_RANK[level]);
    entry.lastUsed = ++clock;
  }
  evict();
  void pump();
}

/**
 * Reads a source again that could not be read: a library file keeps its key
 * (a:<id>) while the file itself can come back (a moved folder re-indexed, a
 * read that hit a library job). A no-op unless the entry failed.
 */
export function retryMediaInfo(key: string): void {
  const entry = entries.get(key);
  if (entry?.info.status === "error") reread(entry);
}

/**
 * Reads a source again that did read: a library record says its file (a:<id>)
 * is missing, so the length and frames read from it before no longer stand.
 * A no-op unless the entry is ready; a file found again since reads as before.
 */
export function rereadMediaInfo(key: string): void {
  const entry = entries.get(key);
  if (entry?.info.status === "ready") reread(entry);
}

/** A fresh entry under the same key, so a job still running for the old one writes nothing. */
function reread(entry: Entry): void {
  revokeFrames(entry.info);
  entries.set(entry.key, { ...entry, info: emptyInfo(), lastUsed: ++clock });
  notify();
  void pump();
}

/**
 * Pins keys against eviction while something on screen shows them (reference
 * counted), so a tile never holds a revoked frame. Returns the release.
 */
export function retainMediaInfo(keys: readonly string[]): () => void {
  for (const key of keys) retainCounts.set(key, (retainCounts.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = (retainCounts.get(key) ?? 0) - 1;
      if (count > 0) retainCounts.set(key, count);
      else retainCounts.delete(key);
    }
    evict();
  };
}

function update(entry: Entry, patch: Partial<StitchMediaInfo>): void {
  entry.info = { ...entry.info, ...patch };
  notify();
}

type Job = { entry: Entry; kind: MediaInfoLevel };

function nextJob(): Job | null {
  const all = [...entries.values()];
  const metadata = all.find((e) => e.info.status === "loading");
  if (metadata) return { entry: metadata, kind: "metadata" };
  for (const kind of ["poster", "filmstrip"] as const) {
    const rank = LEVEL_RANK[kind];
    const entry = all.find(
      (e) => e.info.status === "ready" && e.want >= rank && (e.info.level === null || LEVEL_RANK[e.info.level] < rank),
    );
    if (entry) return { entry, kind };
  }
  return null;
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  const started = generation;
  try {
    for (let job = nextJob(); job && started === generation; job = nextJob()) await runJob(job);
  } finally {
    if (started === generation) running = false;
  }
}

const alive = (entry: Entry) => entries.get(entry.key) === entry;

async function runJob({ entry, kind }: Job): Promise<void> {
  if (kind === "metadata") {
    const result = await readMetadata(entry.src);
    if (alive(entry)) update(entry, { ...result, level: result.status === "ready" ? "metadata" : null });
    return;
  }

  const duration = entry.info.duration ?? 0;
  const wanted =
    kind === "poster"
      ? [POSTER_FRAME]
      : Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => i).filter((i) => !entry.info.frames[i]);
  let handle: MediaElementHandle | null = null;
  try {
    handle = await extractor.open(entry.src);
  } catch {
    // No frames for this source; it still has its length
  }
  try {
    for (const index of handle ? wanted : []) {
      if (!alive(entry)) break;
      let frame: string | null = null;
      try {
        frame = await handle!.frame(frameTime(index, duration));
      } catch {
        frame = null;
      }
      if (!alive(entry)) {
        if (frame) URL.revokeObjectURL(frame);
        break;
      }
      if (!frame) continue;
      const frames = [...entry.info.frames];
      frames[index] = frame;
      update(entry, { frames });
    }
  } finally {
    handle?.close();
  }
  // Done even when frames could not be drawn, so the job is not retried forever
  if (alive(entry)) update(entry, { level: kind });
}

/** The probe, abandoned (and its reading stopped) after PROBE_TIMEOUT_MS. */
function probeWithTimeout(src: string): Promise<MediaProbe> {
  const controller = new AbortController();
  return new Promise<MediaProbe>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Timed out probing the video"));
    }, PROBE_TIMEOUT_MS);
    extractor.probe(src, controller.signal).then(
      (probe) => {
        clearTimeout(timer);
        resolve(probe);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readMetadata(src: string): Promise<Partial<StitchMediaInfo>> {
  let probe: MediaProbe | null = null;
  try {
    probe = await probeWithTimeout(src);
  } catch {
    // Not a container mediabunny opens, or not fetched in time; the element may still play it
  }
  if (probe) {
    // mediabunny opened it, as the engine will: no video track, or no length, is a clip the encode drops
    if (Number.isFinite(probe.duration) && probe.duration > 0) {
      return { status: "ready", duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps };
    }
    return { status: "error" };
  }
  let handle: MediaElementHandle | null = null;
  try {
    handle = await extractor.open(src);
    if (Number.isFinite(handle.duration) && handle.duration > 0) {
      return {
        status: "ready",
        duration: handle.duration,
        width: handle.width || null,
        height: handle.height || null,
        fps: null,
      };
    }
  } catch {
    // Unreadable
  } finally {
    handle?.close();
  }
  return { status: "error" };
}

// ---- The browser extractor -------------------------------------------------

/**
 * The engine's measurement: measureVideoTrackDuration over the full-track
 * packet rate from readVideoTrackMetadata, both shared with probeClip in
 * clipProbe.ts. A URL is read without retries, so a source that cannot be
 * fetched fails at once and falls back to the element.
 */
async function probeWithMediabunny(src: string, signal?: AbortSignal): Promise<MediaProbe> {
  const mb = await import("mediabunny");
  const probing = await import("@/lib/video-probing");
  signal?.throwIfAborted();
  const source =
    src.startsWith("data:") || src.startsWith("blob:")
      ? new mb.BlobSource(await (await fetch(src, { signal })).blob())
      : new mb.UrlSource(src, { getRetryDelay: () => null });
  const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
  // A timed-out probe stops its reads: a disposed input rejects them
  const stop = () => input.dispose();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    const track = (await input.getVideoTracks())[0];
    if (!track) return { duration: 0, width: null, height: null, fps: null };
    const { averagePacketRate } = await probing.readVideoTrackMetadata(track);
    const duration = await probing.measureVideoTrackDuration(input, track, averagePacketRate);
    // The 120-packet estimate is for display only (D12)
    const shownRate = await track
      .computePacketStats(120)
      .then((stats) => stats.averagePacketRate)
      .catch(() => 0);
    return {
      duration,
      width: track.displayWidth || null,
      height: track.displayHeight || null,
      fps: Number.isFinite(shownRate) && shownRate > 0 ? shownRate : null,
    };
  } finally {
    signal?.removeEventListener("abort", stop);
    input.dispose();
  }
}

function waitFor(video: HTMLVideoElement, event: "loadedmetadata" | "seeked", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    const onEvent = () => finish();
    const onError = () => finish(new Error("Failed to load video"));
    function finish(error?: Error) {
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    }
    video.addEventListener(event, onEvent);
    video.addEventListener("error", onError);
  });
}

function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  video.load();
}

async function loadVideo(url: string, crossOrigin: boolean): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  if (crossOrigin) video.crossOrigin = "anonymous";
  const loaded = waitFor(video, "loadedmetadata", LOAD_TIMEOUT_MS);
  video.src = url;
  try {
    await loaded;
    return video;
  } catch (error) {
    releaseVideo(video);
    throw error;
  }
}

async function openWithElement(src: string): Promise<MediaElementHandle> {
  let objectUrl: string | null = null;
  if (src.startsWith("data:")) objectUrl = URL.createObjectURL(await (await fetch(src)).blob());
  const url = objectUrl ?? src;
  const remote = !url.startsWith("blob:");
  let video: HTMLVideoElement;
  // Without CORS headers the element still plays the file, but a canvas it draws on is tainted
  let tainted = false;
  try {
    try {
      video = await loadVideo(url, remote);
    } catch (error) {
      if (!remote) throw error;
      video = await loadVideo(url, false);
      tainted = true;
    }
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    throw error;
  }

  return {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    async frame(time) {
      if (tainted) return null;
      const seeked = waitFor(video, "seeked", SEEK_TIMEOUT_MS);
      const end = Number.isFinite(video.duration) ? video.duration : time;
      video.currentTime = Math.min(Math.max(0, time), end);
      await seeked;
      const aspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      const canvas = document.createElement("canvas");
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.max(1, Math.round(FRAME_WIDTH / aspect));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
      return blob ? URL.createObjectURL(blob) : null;
    },
    close() {
      releaseVideo(video);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

const browserExtractor: MediaExtractor = { probe: probeWithMediabunny, open: openWithElement };
let extractor: MediaExtractor = browserExtractor;

// ---- Test hooks ------------------------------------------------------------

/** Puts an entry in the cache as ready (overridable), without running a job. */
export function __setMediaInfoForTests(key: string, info: Partial<StitchMediaInfo>): void {
  const existing = entries.get(key);
  const base: StitchMediaInfo = existing?.info ?? { ...emptyInfo(), status: "ready", level: "filmstrip" };
  entries.set(key, {
    key,
    src: existing?.src ?? key,
    want: LEVEL_RANK.filmstrip,
    info: { ...base, ...info },
    lastUsed: ++clock,
  });
  notify();
}

export function __resetMediaInfoForTests(): void {
  entries.clear();
  retainCounts.clear();
  generation++;
  running = false;
  clock = 0;
  notify();
}

/** null restores the browser extractor. */
export function __setMediaExtractorForTests(next: MediaExtractor | null): void {
  extractor = next ?? browserExtractor;
}

/** The browser probe, for tests that mock mediabunny. */
export const __probeWithMediabunnyForTests = probeWithMediabunny;
