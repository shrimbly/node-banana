import { create, type StoreApi, type UseBoundStore } from "zustand";
import { coverEditMedia } from "@/lib/edits/document";
import { audioRowCount, hasMusicClip, type AudioDurations } from "@/lib/stitch/audioClips";
import { sameCurve } from "@/lib/stitch/curve";
import { sameDraft, type ClipOrigin, type StitchDraft } from "@/lib/stitch/draft";
import type { LibraryKind } from "@/lib/stitch/libraryRequest";
import { clipIdsOf, makeSelection, type ClipSelection, type SelectionIds } from "@/lib/stitch/selection";
import { edgeIdsInOrder, type SourceDurations, type SourceKey } from "@/lib/stitch/timeline";

/**
 * The Stitch editor's working state: the draft being edited with its own
 * undo history, and the editor's UI state. Nothing here reaches the workflow
 * store until Done writes the draft in one updateNodeData.
 *
 * History holds whole drafts: `past` the ones before the current draft,
 * `future` the ones Undo stepped back over. A pointer gesture applies once,
 * on pointer up; a slider or a run of arrow keys shares a `gestureKey`, so it
 * coalesces into one step until endGesture.
 *
 * A session edits an Edit Video node (`nodeId`, the dialog) or an edit
 * project (`editId`, the Edit video view), never both. The view parks its
 * session when it is left (`park`), which frees the store for the dialog,
 * and puts it back on return (`restore`).
 */

/** Several audio clips selected; shaped like ClipSelection so its pure maths (selection.ts) apply. */
export interface AudioSelection extends SelectionIds {
  kind: "audio";
  /** The lead's selected curve point (single selection, expanded row only). */
  point: number | null;
  /**
   * The last press or key on the lead's curve changed it (a point added, moved or removed, an ⌥ line drag): ⌫ then
   * removes a point or nothing, never the clip. A press on a box body, a click on another clip, or Escape clears it.
   */
  onCurve: boolean;
}

/** Video clips or audio clips, never both. */
export type StitchSelection = ClipSelection | AudioSelection | null;

/** An audio selection of the ids selection.ts's maths gave (they come back as a video selection). */
export function audioSelectionOf(ids: SelectionIds, point: number | null = null, onCurve = false): AudioSelection {
  return {
    kind: "audio",
    clipId: ids.clipId,
    ...(ids.clipIds !== undefined ? { clipIds: ids.clipIds } : {}),
    ...(ids.anchorId !== undefined ? { anchorId: ids.anchorId } : {}),
    point,
    onCurve,
  };
}

export interface StitchContextMenu {
  /** A video clip's menu or an audio clip's. */
  kind: "clip" | "audio";
  clipId: string;
  x: number;
  y: number;
}

export interface StitchEditorState {
  isOpen: boolean;
  nodeId: string | null;
  /** The edit project this session edits; null for a node session or none. */
  editId: string | null;
  canvasGeneration: number | null;
  /** As opened or last saved; the editor is dirty while the draft differs from it. */
  initial: StitchDraft | null;
  draft: StitchDraft | null;
  past: StitchDraft[];
  future: StitchDraft[];
  /** Coalesces a slider drag or arrow keys into one undo step. */
  gestureKey: string | null;
  selection: StitchSelection;
  /** Pushed by the editor from the media caches; not undoable. */
  durations: SourceDurations;
  /** The audio sources' decoded lengths, apart from durations so video layouts do not recompute when audio loads. */
  audioDurations: AudioDurations;
  /**
   * The video sources whose media is still loading, pushed by the editor. An edit that pins a lined-up stack (a
   * Stacked add, paste or duplicate) waits for them: the pins would come from a length not known yet.
   */
  clipsLoading: ReadonlySet<SourceKey>;
  /** The one audio row grown to edit its volume lines, by its header's toggle only; not undoable, never written. */
  audioExpandedRow: number | null;
  /**
   * The non-loop edge into the node's audio socket at open (dimmed or not), or as of the last Save; null with none.
   * Done and Save drop the draft's music clips when it is gone by then (the music was disconnected on the canvas).
   */
  musicEdgeIdAtOpen: string | null;
  /**
   * A draft of this session has held a music clip (at open or after any edit). Removing every music clip disconnects
   * the music only then, never for music a Save picked up that the draft never held. Unlike `past`, never capped.
   */
  musicHeld: boolean;
  /**
   * The video edges the draft referenced when the dialog opened. Done disconnects only these when their clips are
   * gone: a Save moves `initial`, and an edge it picked up was never in the draft, so it must not count as removed.
   */
  edgeIdsAtOpen: readonly string[];
  /**
   * Sequence seconds. While the preview plays it trails the frame loop's clock by up to PLAYHEAD_WRITE_SEC (written
   * that often, so what re-renders on it does not do so every frame) and is exact at a pause, a key or a pointer
   * press; the playhead drawn every frame is livePlayhead().
   */
  playhead: number;
  playing: boolean;
  /** Kept across opens. */
  snap: boolean;
  /** Preview sound, kept across opens. */
  soundOn: boolean;
  /** null = Fit. */
  pxPerSec: number | null;
  menu: StitchContextMenu | null;
  discardOpen: boolean;
  /** Add media (the library picker), and the kind its filter opens on ("all": the media pane's Add media). */
  pickerOpen: false | LibraryKind;
  /** Set by a drag hook while a pointer gesture runs; Escape calls it. */
  cancelGesture: (() => void) | null;
  /**
   * The clips a paste or duplicate made and the ones a cut took, by id, for the discard sheet. Outside the history:
   * an undo or redo brings back the same ids, so their tags stay true.
   */
  clipOrigins: ReadonlyMap<string, ClipOrigin>;

  open(payload: {
    nodeId: string;
    draft: StitchDraft;
    canvasGeneration: number;
    /** Absent = null (no music edge, or an edit without a node). */
    musicEdgeIdAtOpen?: string | null;
  }): void;
  /** An edit project's session: editId set, nodeId null; the first clip selected, as open does. */
  openEdit(payload: { editId: string; draft: StitchDraft }): void;
  /**
   * Leaves an edit session: cancels a running gesture, stops playing, closes, and hands back what restore needs.
   * Null, changing nothing, when no edit session is open.
   */
  park(): StitchParkedSession | null;
  /** Puts a parked session back (isOpen, nodeId null). */
  restore(parked: StitchParkedSession): void;
  /** "Save as a new edit": the session now edits that edit, its history kept. */
  setEditId(editId: string): void;
  /** Resets all but snap and soundOn. Asks nothing: the UI confirms first. */
  close(): void;
  /**
   * Save wrote this to the node: Cancel and the discard sheet count from it now. The undo history stays. With
   * musicEdgeId, the music edge after the write is the one the next Save compares against; omitted, it is kept.
   */
  markSaved(saved: StitchDraft, musicEdgeId?: string | null): void;
  apply(recipe: (draft: StitchDraft) => StitchDraft, opts?: { gestureKey?: string }): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(selection: StitchSelection): void;
  setDurations(durations: SourceDurations): void;
  setAudioDurations(durations: AudioDurations): void;
  /** Kept when the keys are the same. */
  setClipsLoading(keys: ReadonlySet<SourceKey>): void;
  setAudioExpandedRow(row: number | null): void;
  /** Clamped to >= 0. */
  setPlayhead(t: number): void;
  setPlaying(playing: boolean): void;
  setSnap(on: boolean): void;
  setSoundOn(on: boolean): void;
  setZoom(pxPerSec: number | null): void;
  openMenu(menu: StitchContextMenu | null): void;
  setDiscardOpen(open: boolean): void;
  setPickerOpen(open: false | LibraryKind): void;
  setCancelGesture(cancel: (() => void) | null): void;
  /** A clip keeps the first tag it gets: a pasted clip cut and brought back by undo is still a pasted clip. */
  tagClips(ids: readonly string[], origin: ClipOrigin): void;
  /** A clip removed without ⌘X loses its "cut" tag: the tag names how a clip last left, and it left another way. */
  untagCut(ids: readonly string[]): void;
}

export const STITCH_HISTORY_LIMIT = 100;

const EMPTY_DURATIONS: SourceDurations = new Map();
const EMPTY_AUDIO_DURATIONS: AudioDurations = new Map();
const NO_LOADING: ReadonlySet<SourceKey> = new Set();
const NO_ORIGINS: ReadonlyMap<string, ClipOrigin> = new Map();

type SessionState = Pick<
  StitchEditorState,
  | "isOpen"
  | "nodeId"
  | "editId"
  | "canvasGeneration"
  | "initial"
  | "draft"
  | "past"
  | "future"
  | "gestureKey"
  | "selection"
  | "durations"
  | "audioDurations"
  | "clipsLoading"
  | "audioExpandedRow"
  | "musicEdgeIdAtOpen"
  | "musicHeld"
  | "edgeIdsAtOpen"
  | "playhead"
  | "playing"
  | "pxPerSec"
  | "menu"
  | "discardOpen"
  | "pickerOpen"
  | "cancelGesture"
  | "clipOrigins"
>;

/** Everything one editing session owns; snap and soundOn outlive it. */
const closedSession = (): SessionState => ({
  isOpen: false,
  nodeId: null,
  editId: null,
  canvasGeneration: null,
  initial: null,
  draft: null,
  past: [],
  future: [],
  gestureKey: null,
  selection: null,
  durations: EMPTY_DURATIONS,
  audioDurations: EMPTY_AUDIO_DURATIONS,
  clipsLoading: NO_LOADING,
  audioExpandedRow: null,
  musicEdgeIdAtOpen: null,
  musicHeld: false,
  edgeIdsAtOpen: [],
  playhead: 0,
  playing: false,
  pxPerSec: null,
  menu: null,
  discardOpen: false,
  pickerOpen: false,
  cancelGesture: null,
  clipOrigins: NO_ORIGINS,
});

/** What a parked edit session keeps: its editing state, history and view of the timeline. */
export const PARKED_KEYS = [
  "editId",
  "initial",
  "draft",
  "past",
  "future",
  "selection",
  "durations",
  "audioDurations",
  "audioExpandedRow",
  "playhead",
  "pxPerSec",
  "clipOrigins",
] as const satisfies readonly (keyof SessionState)[];

/** What parking drops: whether a session is open, a node session's links to the canvas, and passing UI state. */
export const TRANSIENT_KEYS = [
  "isOpen",
  "nodeId",
  "canvasGeneration",
  "gestureKey",
  "clipsLoading",
  "musicEdgeIdAtOpen",
  "musicHeld",
  "edgeIdsAtOpen",
  "playing",
  "menu",
  "discardOpen",
  "pickerOpen",
  "cancelGesture",
] as const satisfies readonly (keyof SessionState)[];

export type StitchParkedSession = Pick<StitchEditorState, (typeof PARKED_KEYS)[number]>;

// A session field that is neither parked nor transient fails the typecheck here (and the guard test)
type Unclassified = Exclude<keyof SessionState, (typeof PARKED_KEYS)[number] | (typeof TRANSIENT_KEYS)[number]>;
const everyKeyClassified: [Unclassified] extends [never] ? true : Unclassified = true;
void everyKeyClassified;

/** The fields one session owns, for the parking guard test. */
export const sessionKeys = (): string[] => Object.keys(closedSession());

/** The session's PARKED_KEYS, as they are now. */
export function parkedSessionOf(s: StitchEditorState): StitchParkedSession {
  return Object.fromEntries(PARKED_KEYS.map((key) => [key, s[key]])) as StitchParkedSession;
}

const firstClipSelection = (draft: StitchDraft): StitchSelection =>
  draft.timeline[0] ? { kind: "clip", clipId: draft.timeline[0].id } : null;

const sameIds = (a: SelectionIds, b: SelectionIds) =>
  a.clipId === b.clipId && a.anchorId === b.anchorId && (a.clipIds ?? []).join("\n") === (b.clipIds ?? []).join("\n");

/**
 * After a history move: a selection drops the clips that are gone (the first
 * that remains leads when the lead went; none left, none selected), and an
 * audio selection forgets its point, so ⌫ never removes a point by a stale
 * index.
 */
export function pruneSelection(selection: StitchSelection, draft: StitchDraft): StitchSelection {
  if (selection?.kind === "clip") {
    const order = draft.timeline.map((c) => c.id);
    const next = makeSelection(order, clipIdsOf(selection, order), selection.clipId, selection.anchorId);
    return next !== null && sameIds(next, selection) ? selection : next;
  }
  if (selection?.kind === "audio") {
    const order = draft.audioClips.map((c) => c.id);
    const next = makeSelection(order, clipIdsOf(selection, order), selection.clipId, selection.anchorId);
    if (next === null) return null;
    if (sameIds(next, selection) && selection.point === null) return selection;
    return audioSelectionOf(next, null, selection.onCurve);
  }
  return selection;
}

/** An expanded row a history move took away collapses. */
const clampExpandedRow = (row: number | null, draft: StitchDraft) =>
  row !== null && row >= audioRowCount(draft.audioClips) ? null : row;

/**
 * sameDraft compares the audio with its rows compacted (a row a move emptied is no change to save), but the editor
 * draws that row until a removal: a move that empties one is still an edit.
 */
const sameAudioRows = (a: StitchDraft, b: StitchDraft) =>
  a.audioClips.every((clip) => b.audioClips.find((other) => other.id === clip.id)?.row === clip.row);

/** The audio clip's curve, or undefined for a clip that is not there. */
const curveOf = (draft: StitchDraft, clipId: string) => draft.audioClips.find((c) => c.id === clipId)?.curve;

/** While the preview plays, the store's playhead is written at most this often (seconds). */
export const PLAYHEAD_WRITE_SEC = 0.1;

/** The playhead as drawn this frame, and who draws it. */
const live = { playhead: 0, listeners: new Set<(t: number) => void>() };

/**
 * The playhead as drawn this frame: the store's playhead, or ahead of it while the preview plays (the frame loop
 * moves it every frame, the store's only every PLAYHEAD_WRITE_SEC). The timecode and the timeline's playhead draw
 * from it through subscribeLivePlayhead, writing the DOM, never through a render.
 */
export function livePlayhead(): number {
  return live.playhead;
}

/** The frame loop's write, every frame while playing. */
export function setLivePlayhead(t: number): void {
  if (t === live.playhead) return;
  live.playhead = t;
  for (const listener of live.listeners) listener(t);
}

export function subscribeLivePlayhead(listener: (t: number) => void): () => void {
  live.listeners.add(listener);
  return () => live.listeners.delete(listener);
}

export const useStitchEditorStore: UseBoundStore<StoreApi<StitchEditorState>> = create<StitchEditorState>(
  (set, get) => ({
    ...closedSession(),
    snap: true,
    soundOn: true,

    open: ({ nodeId, draft, canvasGeneration, musicEdgeIdAtOpen = null }) => {
      set({
        ...closedSession(),
        isOpen: true,
        nodeId,
        canvasGeneration,
        musicEdgeIdAtOpen,
        musicHeld: hasMusicClip(draft.audioClips),
        edgeIdsAtOpen: edgeIdsInOrder(draft.timeline),
        initial: draft,
        draft,
        selection: firstClipSelection(draft),
      });
    },

    openEdit: ({ editId, draft }) => {
      set({ ...closedSession(), isOpen: true, editId, initial: draft, draft, selection: firstClipSelection(draft) });
    },

    park: () => {
      const s = get();
      if (!s.isOpen || s.editId === null) return null;
      s.cancelGesture?.();
      // Left while playing: parked where the picture was, not where the store's playhead last caught up
      const now = get();
      const parked = parkedSessionOf(now.playing ? { ...now, playhead: live.playhead } : now);
      set(closedSession());
      return parked;
    },

    restore: (parked) => set({ ...closedSession(), ...parked, isOpen: true }),

    setEditId: (editId) => {
      if (get().editId !== null) set({ editId });
    },

    close: () => set(closedSession()),

    markSaved: (saved, musicEdgeId) =>
      set(musicEdgeId === undefined ? { initial: saved } : { initial: saved, musicEdgeIdAtOpen: musicEdgeId }),

    apply: (recipe, opts) => {
      const { draft, gestureKey, past, selection, musicHeld } = get();
      if (!draft) return;
      // An edit's media holds every asset its clips use, so a clip added any way brings its asset in, in the same step
      const next = coverEditMedia(recipe(draft));
      // Most recipes rebuild the draft object, so an unchanged value is told apart by content
      if (next === draft || (sameDraft(next, draft) && sameAudioRows(next, draft))) return;
      // A point index means nothing once the lead's curve has changed under it
      let nextSelection: StitchSelection = selection;
      if (selection?.kind === "audio" && selection.point !== null) {
        const before = curveOf(draft, selection.clipId);
        const after = curveOf(next, selection.clipId);
        if (before !== after && !(before && after && sameCurve(before, after))) {
          nextSelection = { ...selection, point: null };
        }
      }
      const held = musicHeld || hasMusicClip(next.audioClips);
      if (opts?.gestureKey !== undefined && opts.gestureKey === gestureKey) {
        set({ draft: next, future: [], selection: nextSelection, musicHeld: held });
        return;
      }
      set({
        past: [...past, draft].slice(-STITCH_HISTORY_LIMIT),
        draft: next,
        future: [],
        gestureKey: opts?.gestureKey ?? null,
        selection: nextSelection,
        musicHeld: held,
      });
    },

    endGesture: () => set({ gestureKey: null }),

    undo: () => {
      const { draft, past, future, selection, audioExpandedRow } = get();
      if (!draft || past.length === 0) return;
      const previous = past[past.length - 1];
      set({
        past: past.slice(0, -1),
        draft: previous,
        future: [draft, ...future],
        gestureKey: null,
        selection: pruneSelection(selection, previous),
        audioExpandedRow: clampExpandedRow(audioExpandedRow, previous),
      });
    },

    redo: () => {
      const { draft, past, future, selection, audioExpandedRow } = get();
      if (!draft || future.length === 0) return;
      const [next, ...rest] = future;
      set({
        past: [...past, draft].slice(-STITCH_HISTORY_LIMIT),
        draft: next,
        future: rest,
        gestureKey: null,
        selection: pruneSelection(selection, next),
        audioExpandedRow: clampExpandedRow(audioExpandedRow, next),
      });
    },

    select: (selection) => set({ selection }),
    setDurations: (durations) => set({ durations }),
    setClipsLoading: (keys) => {
      const now = get().clipsLoading;
      if (keys.size !== now.size || [...keys].some((key) => !now.has(key))) set({ clipsLoading: keys });
    },
    setAudioDurations: (audioDurations) => set({ audioDurations }),
    setAudioExpandedRow: (audioExpandedRow) => set({ audioExpandedRow }),
    setPlayhead: (t) => set({ playhead: Number.isFinite(t) ? Math.max(0, t) : 0 }),
    // A pause lands the playhead where the frame loop's clock is, in the same change, so what follows the pause sees it
    setPlaying: (playing) => set(playing || !get().playing ? { playing } : { playing, playhead: live.playhead }),
    setSnap: (on) => set({ snap: on }),
    setSoundOn: (on) => set({ soundOn: on }),
    setZoom: (pxPerSec) => set({ pxPerSec }),
    openMenu: (menu) => set({ menu }),
    setDiscardOpen: (open) => set({ discardOpen: open }),
    setPickerOpen: (open) => set({ pickerOpen: open }),
    setCancelGesture: (cancel) => set({ cancelGesture: cancel }),
    tagClips: (ids, origin) => {
      const current = get().clipOrigins;
      const fresh = ids.filter((id) => !current.has(id));
      if (fresh.length === 0) return;
      const next = new Map(current);
      for (const id of fresh) next.set(id, origin);
      set({ clipOrigins: next });
    },
    untagCut: (ids) => {
      const current = get().clipOrigins;
      const cut = ids.filter((id) => current.get(id) === "cut");
      if (cut.length === 0) return;
      const next = new Map(current);
      for (const id of cut) next.delete(id);
      set({ clipOrigins: next });
    },
  }),
);

// Every change of the store's playhead (a move, a pause, an open) is the drawn one too
useStitchEditorStore.subscribe((s, prev) => {
  if (s.playhead !== prev.playhead) setLivePlayhead(s.playhead);
});

export const selectIsDirty = (s: StitchEditorState): boolean =>
  s.initial !== null && s.draft !== null && !sameDraft(s.initial, s.draft);
export const selectCanUndo = (s: StitchEditorState): boolean => s.past.length > 0;
export const selectCanRedo = (s: StitchEditorState): boolean => s.future.length > 0;

/**
 * The selected clips' ids in timeline order ([] for an audio selection or none). A new array per call: components
 * subscribe to s.selection and derive this in a useMemo, never through a selector.
 */
export function selectedClipIds(s: Pick<StitchEditorState, "selection" | "draft">): string[] {
  if (s.selection?.kind !== "clip" || !s.draft) return [];
  return clipIdsOf(s.selection, s.draft.timeline.map((c) => c.id));
}

/**
 * The selected audio clips' ids in audio order (row, start, id; [] for a video selection or none). A new array per
 * call: derive it in a useMemo, never through a selector.
 */
export function selectedAudioIds(s: Pick<StitchEditorState, "selection" | "draft">): string[] {
  if (s.selection?.kind !== "audio" || !s.draft) return [];
  return clipIdsOf(s.selection, s.draft.audioClips.map((c) => c.id));
}

/** Several clips selected: group actions act on all of them, single-clip ones (trims, Start, In, Out) do nothing. */
export const selectIsMulti = (s: StitchEditorState): boolean => selectedClipIds(s).length > 1;
