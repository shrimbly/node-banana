import { useToast } from "@/components/Toast";
import {
  selectedAudioIds,
  selectedClipIds,
  useStitchEditorStore,
  type StitchEditorState,
} from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  copyClips,
  copyItems,
  duplicateAt,
  pastableItems,
  pasteIntoTimeline,
  skippedMessage,
  type ClipboardAudioItem,
  type ClipboardItem,
  type ClipboardOrigin,
  type ClipboardVideoItem,
  type PasteTarget,
} from "@/lib/stitch/clipboard";
import { copyAudioItems, duplicateAudioClips, pasteAudioClips, type AudioRowMap } from "@/lib/stitch/audioClips";
import { draftSpans, type ClipOrigin } from "@/lib/stitch/draft";
import { makeSelection } from "@/lib/stitch/selection";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { pinWaitsForLoading } from "@/lib/stitch/libraryInsert";
import {
  drawnPlayhead,
  editorAudioLengthOf,
  keepZoom,
  placementDurations,
  remapExpandedRow,
  removeAudioClipsById,
  removeClipsById,
  selectAudioClips,
} from "./editorActions";
import type { StitchAudioClip } from "@/types";

/**
 * ⌘C, ⌘X, ⌘V and ⌘D in the editor, and the clip menu's Copy, Cut, Paste and
 * Duplicate. Each reads the stores at call time, as editorActions does; each
 * edit is one undo step.
 */

/** Past this many clips in Stacked, a paste or duplicate says the preview may slow down (one <video> per clip). */
export const MANY_STACKED_CLIPS = 24;

const editor = () => useStitchEditorStore.getState();

/**
 * What the editor edits, as a paste target: the edit project, or the node (the editor is always on the active tab: it
 * closes on a switch).
 */
export function pasteTarget(s: Pick<StitchEditorState, "nodeId" | "editId">): PasteTarget | null {
  if (s.editId !== null) return { kind: "edit", editId: s.editId };
  if (!s.nodeId) return null;
  const wf = useWorkflowStore.getState();
  return {
    kind: "node",
    nodeId: s.nodeId,
    tabId: wf.activeTabId,
    workflowId: wf.workflowId,
    liveEdgeIds: stitchVideoEdgeIds(s.nodeId, wf.edges),
  };
}

/** Paste is offered whenever something was copied and a draft is open; what cannot be pasted is said by the notice. */
export function canPaste(hasClipboard: boolean, s: Pick<StitchEditorState, "draft">): boolean {
  return hasClipboard && s.draft !== null;
}

/**
 * Where the clips are copied: the edit project, or this node in this tab and workflow (an unsaved workflow is given
 * its id first). null with neither.
 */
function copyOrigin(s: Pick<StitchEditorState, "nodeId" | "editId">): ClipboardOrigin | null {
  if (s.editId !== null) return { kind: "edit", editId: s.editId };
  if (!s.nodeId) return null;
  const wf = useWorkflowStore.getState();
  return { kind: "node", nodeId: s.nodeId, tabId: wf.activeTabId, workflowId: wf.ensureWorkflowId() };
}

/**
 * ⌘C: the selected clips to the clipboard, video or audio as the selection holds. An unsaved workflow is given its id
 * first, so a clip from a connected video (or the music) still knows its own node after a tab switch. False when
 * nothing is selected (the clipboard is kept).
 */
export function copySelection(): boolean {
  const s = editor();
  if (!s.draft) return false;
  const audio = s.selection?.kind === "audio";
  const ids = audio ? selectedAudioIds(s) : selectedClipIds(s);
  if (ids.length === 0) return false;
  const origin = copyOrigin(s);
  if (!origin) return false;
  if (audio) {
    const items = copyAudioItems(s.draft.audioClips, ids);
    if (items.length === 0) return false;
    useStitchClipboard.getState().setClipboard({ origin, items });
    return true;
  }
  const clipboard = copyClips(s.draft, s.durations, ids, origin);
  if (!clipboard) return false;
  useStitchClipboard.getState().setClipboard(clipboard);
  return true;
}

/** ⌘X: copy, then remove the selected clips in one step; the clip now at the first removed place is selected. */
export function cutSelection(): void {
  const s = editor();
  const audio = s.selection?.kind === "audio";
  const ids = audio ? selectedAudioIds(s) : selectedClipIds(s);
  if (!copySelection()) return;
  const removed = audio ? removeAudioClipsById(ids) : removeClipsById(ids);
  editor().tagClips(removed, "cut");
}

function videoItems(items: readonly ClipboardItem[]): ClipboardVideoItem[] {
  return items.filter((item): item is ClipboardVideoItem => item.track === "video");
}

function audioItems(items: readonly ClipboardItem[]): ClipboardAudioItem[] {
  return items.filter((item): item is ClipboardAudioItem => item.track === "audio");
}

/** Audio copies made by a paste or a duplicate: tagged, selected (the first leading), the expanded row following. */
function insertAudioCopies(
  result: { clips: StitchAudioClip[]; ids: string[]; rowMap?: AudioRowMap },
  origin: Extract<ClipOrigin, "pasted" | "duplicated">,
): void {
  const s = editor();
  if (result.ids.length === 0) return;
  s.apply((d) => ({ ...d, audioClips: result.clips }));
  if (result.rowMap) remapExpandedRow(result.rowMap);
  editor().tagClips(result.ids, origin);
  selectAudioClips(result.ids);
}

/** The notice that Stacked now has many clips, when this edit took it past MANY_STACKED_CLIPS. */
function manyClipsNotice(before: number, after: number, stacked: boolean): string | null {
  if (!stacked || before > MANY_STACKED_CLIPS || after <= MANY_STACKED_CLIPS) return null;
  return `${after} clips: in Stacked each clip loads its own video, so the preview may slow down.`;
}

/** Whether a Stacked paste or duplicate must wait: it pins every clip, and some clip is still loading. A notice says so. */
function stackedPinWaits(s: StitchEditorState): boolean {
  if (!s.draft || s.draft.sequenceLayout.mode !== "stacked") return false;
  const reason = pinWaitsForLoading(s.draft, s.clipsLoading);
  if (reason) useToast.getState().show(reason, "info");
  return reason !== null;
}

/**
 * Inserts copies in one step (pasteIntoTimeline), tags them, and selects them, the first leading. One notice holds
 * `skipped` and, in Stacked, the many-clips sentence.
 */
function insertCopies(
  items: readonly ClipboardVideoItem[],
  at: { afterIndex: number; startSec: number },
  origin: Extract<ClipOrigin, "pasted" | "duplicated">,
  skipped: string | null,
): void {
  const s = editor();
  const draft = s.draft;
  if (!draft) return;
  const durations = placementDurations(s);
  const { timeline, ids } = pasteIntoTimeline(draft.timeline, durations, draft.sequenceLayout, items, at);
  if (ids.length > 0) {
    keepZoom(s, timeline);
    s.apply((d) => ({ ...d, timeline }));
    const after = editor();
    after.tagClips(ids, origin);
    after.select(makeSelection(timeline.map((c) => c.id), ids, ids[0]));
  }
  const stacked = draft.sequenceLayout.mode === "stacked";
  const notice = [skipped, manyClipsNotice(draft.timeline.length, timeline.length, stacked)].filter(
    (part): part is string => part !== null,
  );
  if (notice.length > 0) useToast.getState().show(notice.join(" "), "info");
}

/** The index pasted clips go after: the last selected clip, else the last clip. */
function lastSelectedIndex(s: StitchEditorState): number {
  const timeline = s.draft?.timeline ?? [];
  const ids = new Set(selectedClipIds(s));
  let last = -1;
  timeline.forEach((c, i) => {
    if (ids.has(c.id)) last = i;
  });
  return last === -1 ? timeline.length - 1 : last;
}

/**
 * ⌘V, by what the clipboard holds. Video: in Track after the last selected clip (or at the end); in Stacked on new
 * rows below it (or at the bottom), the first at the playhead and the others at their copied offsets. Audio: on new
 * rows under the last, the first at the playhead, the time and row spacing kept. Clips that may not be pasted here
 * are left out and a notice says why; with none left, nothing is written.
 */
export function pasteClipboard(): void {
  const s = editor();
  const clipboard = useStitchClipboard.getState().clipboard;
  const target = pasteTarget(s);
  if (!clipboard || !s.draft || !target) return;
  const { items, skipped } = pastableItems(clipboard, target);
  const track = clipboard.items[0]?.track;
  switch (track) {
    case undefined:
    case "video": {
      if (items.length > 0 && stackedPinWaits(s)) return;
      const at = { afterIndex: lastSelectedIndex(s), startSec: drawnPlayhead(s) };
      return insertCopies(videoItems(items), at, "pasted", skippedMessage(skipped));
    }
    case "audio": {
      // A copy holds one kind: audio pastes on new rows under the last, the first at the playhead, whatever is selected
      insertAudioCopies(pasteAudioClips(s.draft.audioClips, audioItems(items), drawnPlayhead(s)), "pasted");
      const notice = skippedMessage(skipped);
      if (notice) useToast.getState().show(notice, "info");
      return;
    }
    default: {
      const unknown: never = track;
      return unknown;
    }
  }
}

/**
 * ⌘D: copies of the selected clips right after them (Stacked: starting where the selection ends). Audio copies start
 * where the selection ends, on their own rows when they fit there, else on new rows under it. The clipboard is kept.
 */
export function duplicateSelection(): void {
  const s = editor();
  if (s.selection?.kind === "audio") {
    if (!s.draft) return;
    const ids = selectedAudioIds(s);
    if (ids.length === 0) return;
    return insertAudioCopies(duplicateAudioClips(s.draft.audioClips, editorAudioLengthOf(s), ids), "duplicated");
  }
  const ids = selectedClipIds(s);
  if (!s.draft || ids.length === 0 || stackedPinWaits(s)) return;
  const durations = placementDurations(s);
  const items = copyItems(s.draft, durations, ids);
  insertCopies(items, duplicateAt(draftSpans(s.draft, durations), new Set(ids)), "duplicated", null);
}
