/**
 * The on-disk layout of one library root (see `../types.ts` for the picture)
 * and the lock file that serialises journal compaction and library moves
 * across processes.
 */

import { promises as fs } from "fs";
import path from "path";
import { errnoCode } from "./errors";

export const GENERATIONS_DIR = "Generations";
export const DATA_DIR = ".nodebanana";
/** The Edit video view's edit files (`<name>.nbedit`), outside any workflow project. */
export const EDITS_DIR = "Edits";
/** In the data folder: one file per process with writes in flight. Not library data — see {@link LibraryLayout.writers}. */
export const WRITERS_DIR = "writers";

export interface LibraryLayout {
  root: string;
  generations: string;
  edits: string;
  data: string;
  assets: string;
  runs: string;
  media: string;
  posters: string;
  workflowsFile: string;
  journal: string;
  lock: string;
  libraryFile: string;
  /**
   * One file per process with writes in flight here, so a move in another
   * process waits for them. A move neither copies it nor counts it as a
   * library: the other build, not yet following a move, can recreate it
   * (empty) in the root the library left.
   */
  writers: string;
  /**
   * One file per permanent delete that had to keep its runs and files while
   * a record couldn't be read; a later delete or cleanup releases them.
   */
  pendingReleases: string;
}

export function libraryLayout(root: string): LibraryLayout {
  const data = path.join(root, DATA_DIR);
  return {
    root,
    generations: path.join(root, GENERATIONS_DIR),
    edits: path.join(root, EDITS_DIR),
    data,
    assets: path.join(data, "assets"),
    runs: path.join(data, "runs"),
    media: path.join(data, "media"),
    posters: path.join(data, "posters"),
    workflowsFile: path.join(data, "workflows.json"),
    journal: path.join(data, "journal.ndjson"),
    lock: path.join(data, "lock"),
    libraryFile: path.join(data, "library.json"),
    writers: path.join(data, WRITERS_DIR),
    pendingReleases: path.join(data, "pending-release"),
  };
}

/** A lock is abandoned when its holder has not refreshed it for this long. */
export const LOCK_STALE_MS = 60_000;
export const LOCK_HEARTBEAT_MS = 20_000;

/** Why the lock is held: a move pauses writes in every process; compaction pauses nothing. */
export type LockPurpose = "compact" | "move";

export interface HeldLock {
  release(): Promise<void>;
}

export interface LockInfo {
  pid: number;
  at: number;
  purpose: LockPurpose | null;
}

/** Whether a process with this id is running (a process we may not signal still counts). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/** The lock's contents, or null when there is no readable lock. */
export async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { pid?: unknown; at?: unknown; purpose?: unknown };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      purpose: parsed.purpose === "move" || parsed.purpose === "compact" ? parsed.purpose : null,
    };
  } catch {
    return null;
  }
}

/** A lock whose holder refreshed it recently and is still running. */
export function isLiveLock(lock: LockInfo | null, now: number = Date.now()): lock is LockInfo {
  return Boolean(lock && now - lock.at < LOCK_STALE_MS && processAlive(lock.pid));
}

/**
 * Takes `.nodebanana/lock` ({pid, at, purpose}), or returns null when a live
 * holder has it. A lock older than {@link LOCK_STALE_MS}, or whose process is
 * gone, is taken over. Long holders (a library move) pass `heartbeat` so
 * their lock never looks stale.
 */
export async function acquireLock(
  file: string,
  options: { heartbeat?: boolean; purpose?: LockPurpose } = {},
): Promise<HeldLock | null> {
  const body = () => JSON.stringify({ pid: process.pid, at: Date.now(), ...(options.purpose ? { purpose: options.purpose } : {}) });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body(), { flag: "wx" });
      let timer: ReturnType<typeof setInterval> | undefined;
      if (options.heartbeat) {
        timer = setInterval(() => {
          fs.writeFile(file, body()).catch(() => {});
        }, LOCK_HEARTBEAT_MS);
        timer.unref?.();
      }
      return {
        release: async () => {
          if (timer) clearInterval(timer);
          await fs.rm(file, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") return null;
      if (isLiveLock(await readLock(file))) return null;
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  return null;
}
