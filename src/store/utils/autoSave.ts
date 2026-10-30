/**
 * Autosave that follows the edits.
 *
 * The old autosave was a 90-second clock: it fired mid-run, fired when the
 * clock said so rather than when the person stopped typing, and showed a
 * toast on every failed tick. This one watches the store: once a saved
 * workflow is dirty it saves a few seconds after the last meaningful change
 * (`AUTOSAVE_SETTLE_MS`), and at the latest `AUTOSAVE_CEILING_MS` after the
 * first change, so continuous editing still lands. It never saves during a
 * run, during another save, while media is still being written, or when
 * nothing changed. While the canvas is mid-gesture (`busy`: a pan, a drag)
 * a due save waits, looking again each second, up to the ceiling from the
 * first change: writing the workflow costs frames the gesture needs. A failed save is retried once, then left alone for
 * `AUTOSAVE_BACKOFF_MS` with one quiet notice.
 *
 * The timers are injected so the tests can drive it.
 */

export const AUTOSAVE_SETTLE_MS = 3_000;
export const AUTOSAVE_CEILING_MS = 30_000;
export const AUTOSAVE_RETRY_MS = 10_000;
export const AUTOSAVE_BACKOFF_MS = 120_000;
export const AUTOSAVE_BUSY_RETRY_MS = 1_000;

/** The slice of the store the scheduler reads. */
export interface AutoSaveState {
  autoSaveEnabled: boolean;
  hasUnsavedChanges: boolean;
  workflowId: string | null | undefined;
  workflowName: string | null | undefined;
  saveDirectoryPath: string | null | undefined;
  isRunning: boolean;
  isSaving: boolean;
  pendingMediaSaves: number;
  /** The fields whose change counts as an edit (compared by reference). */
  nodes: unknown;
  edges: unknown;
  groups: unknown;
  edgeStyle: unknown;
  edgeAppearance: unknown;
}

export interface AutoSaveTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
}

export interface AutoSaveOptions {
  getState: () => AutoSaveState;
  /** Zustand's `subscribe`: calls back after every state change. */
  subscribe: (listener: (state: AutoSaveState, previous: AutoSaveState) => void) => () => void;
  save: () => Promise<boolean>;
  /** Called once when a save has failed twice; the next attempt is after the backoff. */
  onFailure?: (error: unknown) => void;
  /** The canvas is mid-gesture: a due save waits for it, up to the ceiling. */
  busy?: () => boolean;
  timers?: AutoSaveTimers;
}

export interface AutoSave {
  start: () => void;
  stop: () => void;
  /** Save now if the workflow is dirty and a save is allowed (window blur, tab hidden). */
  flush: () => Promise<boolean>;
}

const realTimers: AutoSaveTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Dirty, enabled and saved somewhere: a save would mean something. */
export function autoSaveWanted(state: AutoSaveState): boolean {
  return Boolean(
    state.autoSaveEnabled && state.hasUnsavedChanges && state.workflowId && state.workflowName && state.saveDirectoryPath
  );
}

/** Nothing else is using the workflow or the disk right now. */
export function autoSaveAllowed(state: AutoSaveState): boolean {
  return !state.isRunning && !state.isSaving && state.pendingMediaSaves === 0;
}

function edited(state: AutoSaveState, previous: AutoSaveState): boolean {
  return (
    state.nodes !== previous.nodes ||
    state.edges !== previous.edges ||
    state.groups !== previous.groups ||
    state.edgeStyle !== previous.edgeStyle ||
    state.edgeAppearance !== previous.edgeAppearance ||
    state.workflowName !== previous.workflowName
  );
}

export function createAutoSave({ getState, subscribe, save, onFailure, busy, timers = realTimers }: AutoSaveOptions): AutoSave {
  let unsubscribe: (() => void) | null = null;
  let timer: unknown = null;
  let dirtySince: number | null = null;
  let failures = 0;
  let saving = false;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const scheduleAt = (at: number) => {
    clear();
    timer = timers.setTimeout(() => {
      timer = null;
      void attempt();
    }, Math.max(0, at - timers.now()));
  };

  /** A settle period from now, but never past the ceiling from the first change. */
  const scheduleSettle = () => {
    const now = timers.now();
    if (dirtySince === null) dirtySince = now;
    scheduleAt(Math.min(now + AUTOSAVE_SETTLE_MS, dirtySince + AUTOSAVE_CEILING_MS));
  };

  const attempt = async (force = false): Promise<boolean> => {
    const state = getState();
    if (!autoSaveWanted(state)) {
      dirtySince = null;
      return false;
    }
    if (!autoSaveAllowed(state) || saving) {
      // A run or another save is in flight; look again shortly.
      scheduleAt(timers.now() + AUTOSAVE_SETTLE_MS);
      return false;
    }
    if (!force && busy?.() && dirtySince !== null && timers.now() - dirtySince < AUTOSAVE_CEILING_MS) {
      scheduleAt(Math.min(timers.now() + AUTOSAVE_BUSY_RETRY_MS, dirtySince + AUTOSAVE_CEILING_MS));
      return false;
    }
    saving = true;
    let ok = false;
    let error: unknown = null;
    try {
      ok = await save();
    } catch (caught) {
      error = caught;
    } finally {
      saving = false;
    }
    if (ok) {
      failures = 0;
      dirtySince = null;
      return true;
    }
    failures += 1;
    if (failures === 1) {
      scheduleAt(timers.now() + AUTOSAVE_RETRY_MS);
    } else {
      if (failures === 2) onFailure?.(error);
      scheduleAt(timers.now() + AUTOSAVE_BACKOFF_MS);
    }
    return false;
  };

  const onChange = (state: AutoSaveState, previous: AutoSaveState) => {
    if (!autoSaveWanted(state)) {
      if (!state.hasUnsavedChanges) {
        // Saved, loaded or cleared: nothing pending
        clear();
        dirtySince = null;
      }
      return;
    }
    // A fresh edit pushes the settle period back; anything else only matters
    // when nothing is scheduled (a blocked attempt reschedules itself).
    if (!previous.hasUnsavedChanges || edited(state, previous) || timer === null) scheduleSettle();
  };

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = subscribe(onChange);
      if (autoSaveWanted(getState())) scheduleSettle();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      clear();
      dirtySince = null;
      failures = 0;
    },
    async flush() {
      const state = getState();
      if (!autoSaveWanted(state) || !autoSaveAllowed(state) || saving) return false;
      clear();
      return attempt(true);
    },
  };
}
