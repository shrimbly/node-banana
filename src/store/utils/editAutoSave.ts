import { useToast } from "@/components/Toast";
import { saveShortcutLabel } from "@/utils/saveShortcut";
import type { StitchDraft } from "@/lib/stitch/draft";
import {
  currentEditSession,
  editSaveInFlight,
  sessionIsDirty,
  useEditProjectStore,
} from "../editProjectStore";
import { useStitchEditorStore } from "../stitchEditorStore";
import { useWorkflowStore } from "../workflowStore";
import { createAutoSave, type AutoSave, type AutoSaveState, type AutoSaveTimers } from "./autoSave";

/**
 * The open edit's autosave: the workflow autosave's scheduler (settle, ceiling, one retry, then a backoff with one
 * notice) over the edit's state mapped onto the workflow's shape. On while "Save automatically" is, except while a
 * conflict or a gone edit waits for the user. A library paused by a move reads as a run until its retry time, so the
 * scheduler looks again every few seconds and counts no failure.
 */

/** The dirty check, kept per draft pair: the editor store changes at frame rate while it plays. */
let dirtyMemo: { initial: StitchDraft | null; draft: StitchDraft | null; dirty: boolean } | null = null;

function dirtyOf(initial: StitchDraft | null, draft: StitchDraft | null): boolean {
  if (dirtyMemo && dirtyMemo.initial === initial && dirtyMemo.draft === draft) return dirtyMemo.dirty;
  const dirty = sessionIsDirty({ initial, draft });
  dirtyMemo = { initial, draft, dirty };
  return dirty;
}

export function editAutoSaveState(now: number = Date.now()): AutoSaveState {
  const { open, save } = useEditProjectStore.getState();
  const session = currentEditSession();
  return {
    autoSaveEnabled: useWorkflowStore.getState().autoSaveEnabled && save.state !== "conflict" && save.state !== "gone",
    // A renamed media item's snapshot counts too: nothing else would send it
    hasUnsavedChanges: session ? dirtyOf(session.initial, session.draft) || open?.snapshotStale === true : false,
    workflowId: open?.id,
    workflowName: open?.name,
    saveDirectoryPath: open ? "edits" : null,
    isRunning: save.state === "waiting" && save.retryAt !== null && now < save.retryAt,
    isSaving: editSaveInFlight(),
    pendingMediaSaves: 0,
    nodes: session?.draft ?? null,
    edges: null,
    groups: null,
    edgeStyle: null,
    edgeAppearance: null,
  };
}

export function createEditAutoSave(timers?: AutoSaveTimers): AutoSave {
  const now = () => (timers ? timers.now() : Date.now());
  return createAutoSave({
    getState: () => editAutoSaveState(now()),
    subscribe: (listener) => {
      let last = editAutoSaveState(now());
      const onChange = () => {
        const next = editAutoSaveState(now());
        const previous = last;
        last = next;
        listener(next, previous);
      };
      const unsubscribers = [
        useStitchEditorStore.subscribe(onChange),
        useEditProjectStore.subscribe(onChange),
        useWorkflowStore.subscribe((state, prev) => {
          if (state.autoSaveEnabled !== prev.autoSaveEnabled) onChange();
        }),
      ];
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
    // A paused library is no failure: the retry time it set reads as a run, and the scheduler looks again after it
    save: async () => (await useEditProjectStore.getState().saveNow("auto")) !== "failed",
    onFailure: (error) => {
      const detail = useEditProjectStore.getState().save.error ?? (error instanceof Error ? error.message : "");
      useToast
        .getState()
        .show(`Autosave is paused: it couldn't save the edit${detail ? ` (${detail})` : ""}. Save with ${saveShortcutLabel()} to try now.`, "error");
    },
    ...(timers ? { timers } : {}),
  });
}

/** Starts the edit autosave with the window's blur and hidden-tab flush; returns the stop. Mounted once, with the page. */
export function startEditAutoSave(): () => void {
  const autoSave = createEditAutoSave();
  autoSave.start();
  const flush = () => void autoSave.flush();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  window.addEventListener("blur", flush);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    autoSave.stop();
    window.removeEventListener("blur", flush);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
