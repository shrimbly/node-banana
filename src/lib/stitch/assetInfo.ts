import { fetchAsset } from "@/lib/assets/client/api";
import type { AssetView } from "@/lib/assets/types";
import { assetMediaKey, rereadMediaInfo } from "./mediaInfo";

/**
 * What the library says about the assets a Stitch timeline uses: the record
 * the picker returned, or one read again with fetchAsset when a timeline is
 * opened. null means the library no longer has it. A browser-only module
 * cache for labels and the "gone" state; the node keeps nothing about an
 * asset but its id.
 */

const records = new Map<string, AssetView | null>();
const listeners = new Set<() => void>();
/** Asked for and not answered yet, in order; read one at a time. */
const queue: string[] = [];
let reading = false;
let version = 0;
/** Bumped by the test reset, so a read still in flight from before it writes nothing. */
let generation = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** The records a page of the library already returned, so a picked clip is labelled at once. */
export function primeAssetInfo(views: readonly AssetView[]): void {
  if (views.length === 0) return;
  for (const view of views) records.set(view.id, view);
  notify();
}

/** undefined: not known yet; null: gone from the library. */
export function getAssetInfo(id: string): AssetView | null | undefined {
  return records.get(id);
}

/** Changes on every answer; a snapshot for useSyncExternalStore. */
export function getAssetInfoVersion(): number {
  return version;
}

export function subscribeAssetInfo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function readQueue(): Promise<void> {
  if (reading) return;
  reading = true;
  const mine = generation;
  try {
    while (queue.length > 0) {
      const id = queue[0];
      let answer: AssetView | null | undefined;
      try {
        answer = await fetchAsset(id);
      } catch {
        // Unreachable or refused: the record stays as it was (unknown, or the last answer), and is asked
        // again the next time a timeline is opened
      }
      if (generation !== mine) return;
      if (answer !== undefined) records.set(id, answer);
      // The record says its file is missing (as after a run's 404 for it): a length and frames read from the file
      // before no longer stand, so it is read again, and its clip counts only if it still reads. A record that is
      // gone needs no read: its clip is gone whatever the file did
      if (answer?.missing === true) rereadMediaInfo(assetMediaKey(id));
      queue.shift();
      notify();
    }
  } finally {
    if (generation === mine) reading = false;
  }
}

/**
 * Reads the ids not known yet, one request at a time. With refresh, the known
 * ones are read again too (an editor being opened: an asset may have been
 * deleted, or its file found again, since it was read); each keeps its record
 * until the new answer comes, so its label does not flicker.
 */
export function requestAssetInfo(ids: readonly string[], { refresh = false }: { refresh?: boolean } = {}): void {
  for (const id of ids) {
    if ((refresh || !records.has(id)) && !queue.includes(id)) queue.push(id);
  }
  void readQueue();
}

export function __resetAssetInfoForTests(): void {
  generation++;
  records.clear();
  listeners.clear();
  queue.length = 0;
  reading = false;
  version = 0;
}
