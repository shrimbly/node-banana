/**
 * The asset recorder: the one path by which the browser saves an asset.
 *
 * - `initAssetLibrary()` is called once from the page. It asks the server for
 *   the library status and enables recording only when it is `available`.
 *   Until then (and on hosted/read-only servers, or when the request guard
 *   refuses) `isRecorderEnabled()` is false and callers fall back to today's
 *   project-only save path. The status is asked again: every 30 s while the
 *   request itself fails, every minute while the library is unavailable
 *   (unless it is off for good: a hosted server, or the request guard), on
 *   returning to the page (at most every 30 s), and at once when a recording
 *   is refused in a way that suggests the library is gone. Settings hands in
 *   the answers it gets with `applyLibraryStatus()`.
 * - `recordAsset()` mints the asset id, turns data:/blob: media into a Blob
 *   synchronously-at-call (a blob: URL revoked later must not lose the bytes),
 *   queues the upload (concurrency 2, its own queue: never counted in the
 *   store's pendingMediaSaves, so tabs stay usable), and returns at once.
 *   Failures are retried while the library is temporarily unavailable, then
 *   reported once through `onRecorderError`. One answer that the library is
 *   gone is not enough to drop the bytes (a disk remounting after sleep is
 *   back within seconds): the write backs off and tries again, and only a
 *   library that is off for good (hosted, guard) fails it at once. The
 *   handle's `held` says when the library holds a recording up (a move, an
 *   outage), so a project run can save to its own folder rather than wait,
 *   and its `failed` says why a recording failed, for a caller that tells
 *   the user itself (`quiet`, which keeps the recorder's own notice back).
 * - `beginRun()` / `endRun()` bracket a run. The start graph is held by
 *   reference and only encoded/uploaded when the run records its first
 *   asset. `endRun(id, graph)` writes the final snapshot if the run recorded
 *   anything; `endRun(id, null)` means the canvas was replaced mid-run and no
 *   final snapshot must be written. `holdRun()` keeps a run open past its
 *   end for a recording it may still make.
 */

import type {
  AssetRunContext,
  AssetView,
  LibraryStatus,
  RecordAssetInput,
  RecordAssetMeta,
  RecordAssetResult,
  RecordedAssetHandle,
} from "../types";
import {
  AssetApiError,
  beginRecord,
  fetchAsset,
  fetchLibraryStatus,
  putRun,
  uploadAssetBytes,
  uploadMedia,
  upsertWorkflowEntry,
} from "./api";
import { mapWithConcurrency, withRetry } from "./async";
import { createEmitter } from "./emitter";
import { newAssetId } from "./ids";
import { rebaseProjectPath } from "./projects";
import { libraryOffForGood } from "./libraryStatus";
import { dataUrlMime, dataUrlToBlob, isBlobUrl, isDataUrl, isMediaString } from "./mediaBlob";
import { ensurePoster } from "./poster";
import {
  encodeSnapshot,
  prefetchBlobUrls,
  rememberMediaHash,
  type CapturedGraph,
  type PrefetchedMedia,
} from "./snapshot";

const CONCURRENCY = 2;
/** After the status request itself failed. */
const STATUS_RETRY_MS = 30_000;
/** While the library is known to be unavailable: a drive plugged back in, a folder fixed elsewhere. */
const UNAVAILABLE_POLL_MS = 60_000;
/**
 * The first check after the library went away comes sooner: a disk or share
 * remounting after sleep is back within seconds, and the server holds a
 * failed check for 10 s.
 */
const LOST_RECHECK_MS = 15_000;
/** Coming back to the page asks again, at most this often. */
const FOCUS_REFRESH_MS = 30_000;
/** How long a write paused by a library move waits before checking the library is still there. */
const PAUSED_CHECK_MS = 2 * 60_000;
/** The same failure is reported at most once in this window. */
const ERROR_REPEAT_MS = 60_000;
/** Runs are sequential, so more open than this means some never got an endRun; the oldest are let go. */
const MAX_OPEN_RUNS = 32;

/* Library status ----------------------------------------------------- */

let libraryStatus: LibraryStatus | null = null;
/** The latest status request (what initAssetLibrary hands out). */
let statusRequest: Promise<LibraryStatus | null> | null = null;
/** A request still waiting for its answer, shared by the recorder's own re-checks. */
let statusInFlight: Promise<LibraryStatus | null> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
/** When the status was last asked for or handed in; throttles the focus re-check. */
let statusAskedAt = 0;
/** Requests are numbered so a slow, older answer never replaces a newer one. */
let statusSeq = 0;
let appliedSeq = 0;

const recordedListeners = createEmitter<RecordAssetResult>();
const errorListeners = createEmitter<string>();
const statusListeners = createEmitter<LibraryStatus>();

function clearStatusTimer(): void {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Arms the next status check unless one is armed already. A hidden page waits for the focus re-check instead. */
function scheduleStatusCheck(ms: number): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (!pageHidden()) void askStatus();
  }, ms);
}

/** Off for good (a hosted server, the request guard): polling would only add a refusal to the server's log every minute. */
function offForGood(status: LibraryStatus | null = libraryStatus): boolean {
  return libraryOffForGood(status);
}

function setStatus(status: LibraryStatus, seq: number): void {
  appliedSeq = seq;
  const changed = JSON.stringify(status) !== JSON.stringify(libraryStatus);
  const lost = libraryStatus?.available === true && !status.available;
  libraryStatus = status;
  // Returning to the page still asks again (throttled), off for good or not.
  if (status.available || offForGood(status)) {
    clearStatusTimer();
  } else if (lost) {
    clearStatusTimer();
    scheduleStatusCheck(LOST_RECHECK_MS);
  } else {
    scheduleStatusCheck(UNAVAILABLE_POLL_MS);
  }
  if (changed) statusListeners.emit(status);
}

async function loadStatus(): Promise<LibraryStatus | null> {
  const seq = ++statusSeq;
  statusAskedAt = Date.now();
  try {
    const status = await fetchLibraryStatus();
    // A newer answer (or one handed in by Settings) already applies.
    if (seq < appliedSeq) return libraryStatus;
    setStatus(status, seq);
    return status;
  } catch (error) {
    console.warn("The asset library is not reachable yet:", error instanceof Error ? error.message : error);
    if (seq > appliedSeq) scheduleStatusCheck(STATUS_RETRY_MS);
    return null;
  }
}

function askStatus(): Promise<LibraryStatus | null> {
  clearStatusTimer();
  const request = loadStatus();
  statusRequest = request;
  statusInFlight = request;
  void request.finally(() => {
    if (statusInFlight === request) statusInFlight = null;
  });
  return request;
}

/** The recorder's own re-checks (focus, a refused recording, a long pause) share a request under way. */
function recheckStatus(): Promise<LibraryStatus | null> {
  return statusInFlight ?? askStatus();
}

const WATCHERS = Symbol.for("node-banana.assetLibraryStatusWatchers");
type Watchers = { focus: () => void; visibility: () => void };
let watching = false;

/**
 * Coming back to the page asks for the status again: the library may have
 * been fixed, switched or unplugged meanwhile. A hot reload runs this module
 * again, so the previous copy's listeners are replaced rather than stacked.
 */
function watchPage(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const onReturn = () => {
    if (pageHidden() || Date.now() - statusAskedAt < FOCUS_REFRESH_MS) return;
    void recheckStatus();
  };
  const holder = globalThis as typeof globalThis & { [WATCHERS]?: Watchers };
  const previous = holder[WATCHERS];
  if (previous) {
    window.removeEventListener("focus", previous.focus);
    document.removeEventListener("visibilitychange", previous.visibility);
  }
  const watchers: Watchers = { focus: onReturn, visibility: onReturn };
  window.addEventListener("focus", watchers.focus);
  document.addEventListener("visibilitychange", watchers.visibility);
  holder[WATCHERS] = watchers;
}

/**
 * Idempotent: every call before the answer shares the one request. From then
 * on the status is asked again on returning to the page (at most every
 * 30 s), every minute while the library is unavailable, and at once when a
 * recording is refused because the library is gone.
 */
export function initAssetLibrary(): Promise<LibraryStatus | null> {
  // The library is the browser's to record into; a server render has nothing to ask.
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!watching) {
    watching = true;
    watchPage();
  }
  return statusRequest ?? askStatus();
}

/** Asks the server again, e.g. after Settings moved or switched the library. */
export function refreshAssetLibrary(): Promise<LibraryStatus | null> {
  return askStatus();
}

/** Takes a status the caller already has (a PUT /library answer) without asking again. */
export function applyLibraryStatus(status: LibraryStatus): void {
  statusAskedAt = Date.now();
  setStatus(status, ++statusSeq);
}

export function isRecorderEnabled(): boolean {
  return libraryStatus?.available === true;
}

/** The last status the recorder saw (null before init). */
export function getRecorderLibraryStatus(): LibraryStatus | null {
  return libraryStatus;
}

/** Known to be unavailable (as opposed to not asked yet). */
function knownUnavailable(): boolean {
  return libraryStatus !== null && !libraryStatus.available;
}

/** An answer that may mean the library itself is gone: the guard refused, or the root failed its check. */
function mayMeanLibraryGone(error: unknown): boolean {
  if (!(error instanceof AssetApiError)) return false;
  return error.status === 403 || error.status === 404 || error.code === "unavailable";
}

/** Not worth another try: the library is off, so the caller falls back (a project's own folder) at once. */
function libraryOff(fallback?: unknown): Error {
  const reason = libraryStatus?.reason || (fallback instanceof Error && fallback.message) || "The asset library is not available.";
  return new Error(reason);
}

/** Worth another try after a backoff: the library is gone, but may be back in a moment. */
function libraryGoneForNow(fallback: unknown): AssetApiError {
  return new AssetApiError(libraryOff(fallback).message, 503, undefined, "unavailable");
}

/**
 * `withRetry` for the library's writes. It gives up at once when the
 * library is off for good (a hosted server, the request guard). When an
 * answer suggests the library is gone it asks for the status first: if that
 * confirms it, recording turns off (so `isRecorderEnabled()` sends later
 * runs down the fallback path), but this write keeps its bytes and backs
 * off as for any other outage. One answer is not enough to drop them: a disk
 * or share remounting after sleep is back within seconds. A write that gets
 * through meanwhile asks for the status again, which turns recording back on.
 *
 * A library move pauses writes for as long as it copies, which can be far
 * longer than any fixed budget. The bytes are already held, so the write
 * keeps waiting, checking the status every few minutes, and gives up only
 * when the status says the library is no longer available.
 *
 * `onHeld` hears whenever the library makes the write wait (a pause, or a
 * library gone for now), so a caller with a folder of its own can save there
 * rather than wait with it.
 */
function retry<T>(task: (attempt: number) => Promise<T>, onHeld?: () => void): Promise<T> {
  return withRetry(
    async (attempt) => {
      if (offForGood()) throw libraryOff();
      if (knownUnavailable()) onHeld?.();
      let result: T;
      try {
        result = await task(attempt);
      } catch (error) {
        if (mayMeanLibraryGone(error)) {
          const status = await recheckStatus();
          if (status && !status.available) {
            if (offForGood(status)) throw libraryOff(error);
            onHeld?.();
            throw libraryGoneForNow(error);
          }
        }
        throw error;
      }
      // It is back before the status said so
      if (knownUnavailable()) void recheckStatus();
      return result;
    },
    {
      pausedBudgetMs: PAUSED_CHECK_MS,
      onPaused: onHeld,
      keepWaiting: async () => {
        const status = await recheckStatus();
        // Unreachable is not "gone": the server may be restarting mid-move.
        if (status && !status.available) throw libraryOff();
        return true;
      },
    },
  );
}

/* Errors -------------------------------------------------------------- */

const lastReported = new Map<string, number>();

/** A failure's reason as a sentence of its own: "The file is empty." */
function reasonSentence(reason: string): string {
  const text = reason.trim() || "The asset could not be saved";
  const capitalised = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** Logs a failed recording and, unless the caller tells the user itself (`quiet`), notifies once a minute. Returns the reason. */
function reportError(error: unknown, quiet = false): string {
  const reason = error instanceof Error ? error.message : String(error);
  const message = `Couldn't save an asset to the library: ${reason}`;
  console.error(message);
  if (!quiet) {
    const now = Date.now();
    for (const [text, at] of lastReported) if (now - at >= ERROR_REPEAT_MS) lastReported.delete(text);
    if (!lastReported.has(message)) {
      lastReported.set(message, now);
      errorListeners.emit(message);
    }
  }
  return reasonSentence(reason);
}

/* Media --------------------------------------------------------------- */

type TakenMedia =
  | { kind: "bytes"; blob: Promise<Blob>; mime?: string; key?: string }
  | { kind: "url"; url: string; mime?: string };

/** Reads the bytes now: a data: URL is decoded, a blob: or same-origin URL is fetched (which binds it). */
function takeMedia(input: RecordAssetInput): TakenMedia {
  const { media } = input;
  if (typeof media !== "string") return { kind: "bytes", blob: Promise.resolve(media), mime: input.mime || media.type || undefined };
  if (isDataUrl(media)) {
    const mime = input.mime || dataUrlMime(media) || undefined;
    return { kind: "bytes", blob: Promise.resolve(dataUrlToBlob(media, mime)), mime, key: media };
  }
  if (/^https?:\/\//i.test(media)) return { kind: "url", url: media, mime: input.mime };
  if (isBlobUrl(media) || media.startsWith("/")) {
    const blob = fetch(media).then(
      (response) => {
        if (!response.ok) throw new Error(`its media could not be read (${response.status})`);
        return response.blob();
      },
      () => {
        throw new Error("its media was gone before it could be read");
      },
    );
    // Handled when the job runs; until then the rejection is expected, not unhandled.
    blob.catch(() => {});
    return { kind: "bytes", blob, mime: input.mime, key: isBlobUrl(media) ? media : undefined };
  }
  throw new Error("that kind of media can't be saved");
}

/** Keeps request bodies small: parameters never need inline media (the server drops it anyway). */
function scrubParameters(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return isMediaString(value) ? undefined : value;
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.map((item) => scrubParameters(item, depth + 1)).filter((item) => item !== undefined);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const scrubbed = scrubParameters(child, depth + 1);
    if (scrubbed !== undefined) result[key] = scrubbed;
  }
  return result;
}

function buildMeta(assetId: string, input: RecordAssetInput, run: AssetRunContext, mime: string | undefined): RecordAssetMeta {
  const meta: RecordAssetMeta = {
    id: assetId,
    kind: input.kind,
    origin: input.origin,
    createdAt: Date.now(),
    producer: input.producer,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    projectDir: run.projectDir,
    runId: run.runId,
  };
  if (run.batch) meta.batch = run.batch;
  if (mime) meta.mime = mime;
  if (input.name) meta.name = input.name;
  if (input.prompt) meta.prompt = input.prompt;
  if (input.model) meta.model = input.model;
  if (input.parameters) meta.parameters = scrubParameters(input.parameters) as Record<string, unknown>;
  if (input.aspectRatio) meta.aspectRatio = input.aspectRatio;
  if (input.resolution) meta.resolution = input.resolution;
  if (input.cost) meta.cost = input.cost;
  if (input.width) meta.width = input.width;
  if (input.height) meta.height = input.height;
  if (input.durationSec) meta.durationSec = input.durationSec;
  return meta;
}

function resultFromView(asset: AssetView): RecordAssetResult {
  return { asset, filename: asset.filename, legacyId: asset.filename.replace(/\.[^.]+$/, ""), reusedFile: false };
}

async function upload(meta: RecordAssetMeta, media: TakenMedia, onHeld: () => void): Promise<RecordAssetResult> {
  const blob = media.kind === "bytes" ? await media.blob : null;
  if (blob && !meta.mime && blob.type) meta.mime = blob.type;
  return retry(async (attempt) => {
    try {
      const begun = await beginRecord({
        meta,
        source: media.kind === "url" ? { type: "url", url: media.url } : { type: "upload" },
      });
      if ("result" in begun) return begun.result;
      if (!blob) throw new Error("the library asked for bytes it was meant to download");
      return await uploadAssetBytes(begun.ticket.uploadId, blob);
    } catch (error) {
      // An earlier attempt may have landed with only its answer lost.
      if (attempt > 1 && error instanceof AssetApiError && error.status === 409) {
        const asset = await fetchAsset(meta.id).catch(() => null);
        if (asset) return resultFromView(asset);
      }
      throw error;
    }
  }, onHeld);
}

/* Queue --------------------------------------------------------------- */

const queue: (() => Promise<void>)[] = [];
let active = 0;

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active += 1;
    void job().finally(() => {
      active -= 1;
      pump();
    });
  }
}

/* Runs ---------------------------------------------------------------- */

interface RunState {
  run: AssetRunContext;
  start: CapturedGraph;
  startMedia: PrefetchedMedia;
  /** Recordings of this run queued or uploading. */
  pending: number;
  recorded: number;
  /** The workflow upsert and start snapshot; never rejects. */
  startWrite: Promise<void> | null;
  ended: { graph: CapturedGraph | null; media: PrefetchedMedia | null } | null;
}

const runs = new Map<string, RunState>();
let snapshotWrites = 0;

/** Counts a background write for pendingRecordings; failures are logged, never thrown. */
function track(label: string, task: () => Promise<void>): Promise<void> {
  snapshotWrites += 1;
  return task()
    .catch((error) => {
      console.warn(`Couldn't store the ${label}:`, error instanceof Error ? error.message : error);
    })
    .finally(() => {
      snapshotWrites -= 1;
    });
}

async function writeSnapshot(run: AssetRunContext, phase: "start" | "final", graph: CapturedGraph, media: PrefetchedMedia | null) {
  const encoded = await retry(() => encodeSnapshot(graph, media ? { prefetched: media } : {}));
  const { missingMedia } = await retry(() =>
    putRun(run.runId, {
      meta: {
        id: run.runId,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        projectPath: run.projectDir,
        startedAt: run.startedAt,
      },
      phase,
      workflow: encoded.workflow,
      mediaHashes: encoded.mediaHashes,
    }),
  );
  // The encoder uploaded what media/has reported missing; this covers media
  // that went missing in between (a cleanup job, a moved library).
  if (!missingMedia.length || !encoded.readMedia) return;
  await mapWithConcurrency(missingMedia, 2, async (sha256) => {
    const blob = await encoded.readMedia!(sha256);
    if (blob) await retry(() => uploadMedia(sha256, blob)).catch((error) => console.warn("Snapshot media upload failed:", error));
  });
}

function startRunSnapshot(state: RunState): void {
  const { run } = state;
  state.startWrite = track("workflow snapshot", async () => {
    try {
      // The name and folder are the run's, as they were when it started: a
      // rename or move saved since then is newer, and the library keeps it.
      const entry = { name: run.workflowName, projectPath: run.projectDir, asOf: run.startedAt };
      await retry(() => upsertWorkflowEntry(run.workflowId, entry));
    } catch (error) {
      console.warn("Couldn't classify the workflow in the library:", error instanceof Error ? error.message : error);
    }
    await writeSnapshot(run, "start", state.start, state.startMedia);
  });
}

function finishRun(state: RunState): void {
  runs.delete(state.run.runId);
  const graph = state.ended?.graph;
  if (!graph || state.recorded === 0) return;
  const media = state.ended?.media ?? null;
  void track("final workflow snapshot", async () => {
    await state.startWrite;
    await writeSnapshot(state.run, "final", graph, media);
  });
}

function settle(state: RunState | undefined, result: RecordAssetResult | null): void {
  if (!state) return;
  state.pending -= 1;
  if (result) {
    state.recorded += 1;
    if (state.recorded === 1) startRunSnapshot(state);
  }
  if (state.ended && state.pending === 0) finishRun(state);
}

/**
 * A project folder moved (a projects move): runs still recording into it
 * record into its new place, so nothing lands in the old folder again.
 */
export function rebaseRunProjects(from: string, to: string): void {
  for (const { run } of runs.values()) {
    const moved = rebaseProjectPath(from, to, run.projectDir);
    if (moved) run.projectDir = moved;
  }
}

export function beginRun(run: AssetRunContext, graph: CapturedGraph): void {
  if (knownUnavailable() || runs.has(run.runId)) return;
  for (const [runId] of runs) {
    if (runs.size < MAX_OPEN_RUNS) break;
    endRun(runId, null);
    runs.delete(runId);
  }
  runs.set(run.runId, {
    run,
    start: graph,
    // Bound now: a node that re-runs revokes its old blob: URL.
    startMedia: prefetchBlobUrls(graph),
    pending: 0,
    recorded: 0,
    startWrite: null,
    ended: null,
  });
}

export function endRun(runId: string, graph: CapturedGraph | null): void {
  const state = runs.get(runId);
  if (!state || state.ended) return;
  const mayWrite = graph !== null && (state.recorded > 0 || state.pending > 0);
  state.ended = { graph, media: mayWrite ? prefetchBlobUrls(graph) : null };
  // Recordings still uploading decide whether the run recorded anything.
  if (state.pending === 0) finishRun(state);
}

/**
 * Keeps a run open for a recording it may still make after it ends (a node
 * waiting on an earlier run's upload, to record its own copy if that one
 * fails). Until the release, the run waits as it does for a recording under
 * way, so one made meanwhile still gets the run's snapshots; recorded after
 * the run finished, an asset would name a run with none. The release works
 * once. A run that is not open holds nothing.
 */
export function holdRun(runId: string): () => void {
  const state = runs.get(runId);
  if (!state) return () => {};
  state.pending += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    state.pending -= 1;
    if (state.ended && state.pending === 0) finishRun(state);
  };
}

/* Recording ----------------------------------------------------------- */

/** What `recordAsset` hands back: the contract's handle, word of the library holding it up, and why it failed. */
export interface RecordingHandle extends RecordedAssetHandle {
  /**
   * Resolves once the library makes this recording wait: a move pauses its
   * writes, or the library is gone for now. The recording carries on and
   * `done` still settles, but a caller with a folder of its own need not wait
   * with it. Never rejects; stays pending for a recording that goes through.
   */
  held: Promise<void>;
  /**
   * Resolves with the reason, as a sentence, when this recording fails (the
   * library is off for good, the media can't be read, the library refused
   * it), before `done` resolves null. Never rejects; stays pending for a
   * recording that goes through.
   */
  failed: Promise<string>;
}

export interface RecordAssetOptions {
  /** The caller tells the user about a failure itself, so the recorder's own library notice stays quiet for this one. */
  quiet?: boolean;
}

/** For a recording that settled at once: nothing will hold it up. */
const NOT_HELD = new Promise<void>(() => {});

export function recordAsset(input: RecordAssetInput, run: AssetRunContext, options: RecordAssetOptions = {}): RecordingHandle {
  const assetId = newAssetId();
  let fail!: (reason: string) => void;
  const failed = new Promise<string>((resolve) => (fail = resolve));
  // Known to be off for now is not off for good: the write tries, and backs off
  if (offForGood()) {
    fail(reasonSentence(libraryOff().message));
    return { assetId, done: Promise.resolve(null), held: NOT_HELD, failed };
  }

  let media: TakenMedia;
  try {
    media = takeMedia(input);
  } catch (error) {
    fail(reportError(error, options.quiet));
    return { assetId, done: Promise.resolve(null), held: NOT_HELD, failed };
  }

  const meta = buildMeta(assetId, input, run, media.mime);
  const state = runs.get(run.runId);
  if (state) state.pending += 1;

  let hold!: () => void;
  const held = new Promise<void>((resolve) => (hold = resolve));
  // Queued behind other recordings, it would not hear so until its turn
  if (knownUnavailable()) hold();

  const done = new Promise<RecordAssetResult | null>((resolve) => {
    queue.push(async () => {
      let result: RecordAssetResult | null = null;
      try {
        result = await upload(meta, media, hold);
      } catch (error) {
        fail(reportError(error, options.quiet));
      }
      if (result) {
        if (media.kind === "bytes" && media.key) {
          rememberMediaHash(media.key, result.asset.sha256, result.asset.mime, result.asset.bytes);
        }
        recordedListeners.emit(result);
        if (result.asset.kind === "video" && !result.asset.hasPoster) void ensurePoster(result.asset);
      }
      settle(state, result);
      resolve(result);
    });
    pump();
  });
  return { assetId, done, held, failed };
}

/** Recordings queued or uploading, plus snapshot writes (for beforeunload). */
export function pendingRecordings(): number {
  return queue.length + active + snapshotWrites;
}

export function onAssetRecorded(listener: (result: RecordAssetResult) => void): () => void {
  return recordedListeners.on(listener);
}

export function onRecorderError(listener: (message: string) => void): () => void {
  return errorListeners.on(listener);
}

export function onLibraryStatus(listener: (status: LibraryStatus) => void): () => void {
  return statusListeners.on(listener);
}
