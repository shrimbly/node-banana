import { describe, it, expect, vi } from "vitest";
import {
  AUTOSAVE_BACKOFF_MS,
  AUTOSAVE_CEILING_MS,
  AUTOSAVE_RETRY_MS,
  AUTOSAVE_SETTLE_MS,
  autoSaveAllowed,
  autoSaveWanted,
  createAutoSave,
  type AutoSaveState,
} from "../autoSave";

/** A tiny store with zustand's subscribe shape and fake timers the test drives. */
function harness(initial: Partial<AutoSaveState> = {}, busy?: () => boolean) {
  let state: AutoSaveState = {
    autoSaveEnabled: true,
    hasUnsavedChanges: false,
    workflowId: "wf-1",
    workflowName: "Fox",
    saveDirectoryPath: "/projects/fox",
    isRunning: false,
    isSaving: false,
    pendingMediaSaves: 0,
    nodes: [],
    edges: [],
    groups: {},
    edgeStyle: "bezier",
    edgeAppearance: {},
    ...initial,
  };
  const listeners = new Set<(s: AutoSaveState, p: AutoSaveState) => void>();
  const setState = (patch: Partial<AutoSaveState>) => {
    const previous = state;
    state = { ...state, ...patch };
    for (const l of listeners) l(state, previous);
  };
  let now = 0;
  const pending: { at: number; callback: () => void }[] = [];
  const timers = {
    setTimeout: (callback: () => void, ms: number) => { const id = { at: now + ms, callback }; pending.push(id); return id; },
    clearTimeout: (id: unknown) => { const i = pending.indexOf(id as (typeof pending)[number]); if (i >= 0) pending.splice(i, 1); },
    now: () => now,
  };
  /** Advance the clock, firing due timers in order, and let promises settle. */
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      const next = pending[0];
      if (!next || next.at > target) break;
      now = next.at;
      pending.shift();
      next.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
  };
  const save = vi.fn(async () => {
    setState({ isSaving: true });
    await Promise.resolve();
    setState({ isSaving: false, hasUnsavedChanges: false });
    return true;
  });
  const onFailure = vi.fn();
  const auto = createAutoSave({ getState: () => state, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); }, save, onFailure, busy, timers });
  const edit = () => setState({ hasUnsavedChanges: true, nodes: [{}] });
  const dueIn = () => (pending.length ? Math.min(...pending.map((p) => p.at)) - now : null);
  return { auto, save, onFailure, setState, edit, advance, dueIn, state: () => state };
}

describe("autoSaveWanted / autoSaveAllowed", () => {
  it("wants a save only for a dirty, enabled, saved workflow", () => {
    const h = harness();
    expect(autoSaveWanted(h.state())).toBe(false);
    h.edit();
    expect(autoSaveWanted(h.state())).toBe(true);
    h.setState({ autoSaveEnabled: false });
    expect(autoSaveWanted(h.state())).toBe(false);
    h.setState({ autoSaveEnabled: true, saveDirectoryPath: "" });
    expect(autoSaveWanted(h.state())).toBe(false);
  });

  it("allows a save only when nothing else is using the workflow", () => {
    const h = harness();
    expect(autoSaveAllowed(h.state())).toBe(true);
    h.setState({ isRunning: true });
    expect(autoSaveAllowed(h.state())).toBe(false);
    h.setState({ isRunning: false, pendingMediaSaves: 1 });
    expect(autoSaveAllowed(h.state())).toBe(false);
  });
});

describe("createAutoSave", () => {
  it("saves a few seconds after the last edit, not before", async () => {
    const h = harness();
    h.auto.start();
    h.edit();
    expect(h.dueIn()).toBe(AUTOSAVE_SETTLE_MS);
    await h.advance(AUTOSAVE_SETTLE_MS - 1000);
    h.edit();
    await h.advance(1500);
    expect(h.save).not.toHaveBeenCalled();
    await h.advance(AUTOSAVE_SETTLE_MS);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.state().hasUnsavedChanges).toBe(false);
  });

  it("saves at the ceiling while editing never stops", async () => {
    const h = harness();
    h.auto.start();
    h.edit();
    let elapsed = 0;
    while (elapsed < AUTOSAVE_CEILING_MS + 2000 && h.save.mock.calls.length === 0) {
      await h.advance(1000);
      elapsed += 1000;
      if (h.save.mock.calls.length === 0) h.edit();
    }
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThanOrEqual(AUTOSAVE_CEILING_MS + 1000);
  });

  it("does nothing when the workflow is clean, disabled or unsaved", async () => {
    const h = harness({ saveDirectoryPath: "" });
    h.auto.start();
    h.edit();
    await h.advance(AUTOSAVE_CEILING_MS);
    expect(h.save).not.toHaveBeenCalled();
    h.setState({ saveDirectoryPath: "/projects/fox", autoSaveEnabled: false, nodes: [{}, {}] });
    await h.advance(AUTOSAVE_CEILING_MS);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("waits out a run, then saves once it ends", async () => {
    const h = harness({ isRunning: true });
    h.auto.start();
    h.edit();
    await h.advance(AUTOSAVE_SETTLE_MS * 3);
    expect(h.save).not.toHaveBeenCalled();
    h.setState({ isRunning: false });
    await h.advance(AUTOSAVE_SETTLE_MS);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("waits out a canvas gesture, but not past the ceiling", async () => {
    let gesture = true;
    const h = harness({}, () => gesture);
    h.auto.start();
    h.edit();
    await h.advance(AUTOSAVE_SETTLE_MS * 2);
    expect(h.save).not.toHaveBeenCalled();
    gesture = false;
    await h.advance(1_000);
    expect(h.save).toHaveBeenCalledTimes(1);

    gesture = true;
    h.edit();
    await h.advance(AUTOSAVE_CEILING_MS);
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it("retries once after a failure, then backs off with one notice", async () => {
    const h = harness();
    h.save.mockImplementation(async () => false);
    h.auto.start();
    h.edit();
    await h.advance(AUTOSAVE_SETTLE_MS);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.dueIn()).toBe(AUTOSAVE_RETRY_MS);
    await h.advance(AUTOSAVE_RETRY_MS);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.onFailure).toHaveBeenCalledTimes(1);
    expect(h.dueIn()).toBe(AUTOSAVE_BACKOFF_MS);
    await h.advance(AUTOSAVE_BACKOFF_MS);
    expect(h.save).toHaveBeenCalledTimes(3);
    expect(h.onFailure).toHaveBeenCalledTimes(1);
  });

  it("flushes at once when asked, and not when a save would be refused", async () => {
    const h = harness();
    h.auto.start();
    h.edit();
    await expect(h.auto.flush()).resolves.toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    h.edit();
    h.setState({ isRunning: true });
    await expect(h.auto.flush()).resolves.toBe(false);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly and never fires afterwards", async () => {
    const h = harness();
    h.auto.start();
    h.edit();
    h.auto.stop();
    await h.advance(AUTOSAVE_CEILING_MS);
    expect(h.save).not.toHaveBeenCalled();
  });
});
