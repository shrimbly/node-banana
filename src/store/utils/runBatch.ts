/**
 * Batch runs: "Run 10×" runs the same scope again and again, one run after
 * another. The count belongs to the workflow (saved in its file); the batch
 * in progress lives in the store, and its tag rides on every output a run
 * makes so the carousel, the recent list and the asset library can say which
 * run it came from.
 */

import type { RunBatchTag } from "@/types";

/** Most runs in one batch: a generate node's carousel keeps 50 entries. */
export const MAX_RUN_COUNT = 50;

/** What a batch repeats: the Run menu's three rows, and a group (its nodes). */
export type RunScope =
  | { kind: "all" }
  | { kind: "from"; nodeId: string }
  | { kind: "nodes"; nodeIds: string[] };

/** The batch in progress. `stopping`: Stop was pressed once, so this run is the last. */
export interface RunBatch extends RunBatchTag {
  stopping: boolean;
}

/** A whole number from 1 to MAX_RUN_COUNT; anything unreadable is 1. */
export function clampRunCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(MAX_RUN_COUNT, Math.round(parsed)));
}

export function newBatchId(): string {
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The tag an output carries, without the store's own `stopping` flag. */
export function batchTag(batch: RunBatch | null | undefined): RunBatchTag | undefined {
  return batch ? { id: batch.id, index: batch.index, count: batch.count } : undefined;
}

/** How one run went, as the batch loop needs to know it. */
export interface RunOutcome {
  /** False when the run never started (already running, server offline, nothing to run). */
  started: boolean;
  failed: boolean;
}

/**
 * Run `count` times, one after another. Stops early when a run did not start
 * or failed, or when `keepGoing` says no (Stop pressed, a pause edge, the
 * canvas replaced). `setIndex` is called before each run so the run reads its
 * own index.
 *
 * `toleratedFailures`: a batch of images goes on past a failed run, since
 * each image is its own job, and stops only after this many failures in a row
 * (a missing key or an offline provider fails every run alike).
 */
export async function runBatchLoop(options: {
  count: number;
  setIndex: (index: number) => void;
  runOnce: () => Promise<RunOutcome>;
  keepGoing: () => boolean;
  toleratedFailures?: number;
}): Promise<number> {
  const { count, setIndex, runOnce, keepGoing, toleratedFailures = 0 } = options;
  let completed = 0;
  let failedInARow = 0;
  for (let index = 1; index <= count; index++) {
    setIndex(index);
    const outcome = await runOnce();
    if (!outcome.started) break;
    completed = index;
    failedInARow = outcome.failed ? failedInARow + 1 : 0;
    if (failedInARow > toleratedFailures || !keepGoing()) break;
  }
  return completed;
}

/** Failed runs in a row after which a batch of images stops. */
export const IMAGE_BATCH_TOLERATED_FAILURES = 2;
