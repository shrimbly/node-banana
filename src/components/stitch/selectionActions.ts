import {
  audioSelectionOf,
  selectedAudioIds,
  selectedClipIds,
  useStitchEditorStore,
  type AudioSelection,
  type StitchEditorState,
} from "@/store/stitchEditorStore";
import {
  clipIdsOf,
  makeSelection,
  rangeTo,
  selectAll,
  toggleClip,
  type ClipSelection,
} from "@/lib/stitch/selection";

/**
 * How clicks, ⌘A and the selection box change which clips are selected. A
 * selection holds video clips or audio clips, never both: a click, ⌘A or a
 * box of the other kind starts a new selection of that kind. A selection
 * change is not an undo step.
 */

const editor = () => useStitchEditorStore.getState();

const orderOf = (s: StitchEditorState): string[] => s.draft?.timeline.map((c) => c.id) ?? [];
const clipSelectionOf = (s: StitchEditorState): ClipSelection | null =>
  s.selection?.kind === "clip" ? s.selection : null;
/** Audio order: row, then start, then id (the draft keeps its audio clips sorted so). */
const audioOrderOf = (s: StitchEditorState): string[] => s.draft?.audioClips.map((c) => c.id) ?? [];
const audioSelectionIn = (s: StitchEditorState): AudioSelection | null =>
  s.selection?.kind === "audio" ? s.selection : null;
const asAudio = (selection: ClipSelection | null): AudioSelection | null =>
  selection ? audioSelectionOf(selection) : null;

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** ⌘ on a Mac, Ctrl elsewhere: adds a clip to the selection or takes it out. */
export function isToggleClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** A Mac's Ctrl-click: its contextmenu opens the clip menu, so no press handler acts on it. */
export function isContextClick(e: { ctrlKey: boolean; button: number }): boolean {
  return isMac() && e.ctrlKey && e.button === 0;
}

/** Text selected on the page (rail text selected with the mouse): ⌘C and ⌘X then copy it. */
export function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== "";
}

/** A lane press prevents the browser's mousedown, which would have cleared a text selection, so it clears it here. */
export function clearTextSelection(): void {
  if (hasTextSelection()) window.getSelection()?.removeAllRanges();
}

/**
 * A click on a clip: with range (⇧) the run from the anchor, else with toggle (⌘) the clip joins or leaves, else
 * the clip alone. Nothing while the clip menu is open: a Mac's Ctrl-click opens it and must keep a group.
 */
export function clickClip(clipId: string, mods: { toggle: boolean; range: boolean }): void {
  const s = editor();
  if (s.menu !== null) return;
  if (mods.range) {
    s.select(rangeTo(orderOf(s), clipSelectionOf(s), clipId));
  } else if (mods.toggle) {
    s.select(toggleClip(orderOf(s), clipSelectionOf(s), clipId));
  } else {
    s.select({ kind: "clip", clipId });
  }
}

/** The clips a press on clipId drags: the selection when it holds clipId and others, else clipId alone. */
export function pressGroup(clipId: string): string[] {
  const ids = selectedClipIds(editor());
  return ids.length > 1 && ids.includes(clipId) ? ids : [clipId];
}

/** After a group drag: the same clips selected, the one pressed leading. */
export function keepGroupSelected(ids: readonly string[], lead: string): void {
  const s = editor();
  s.select(makeSelection(orderOf(s), ids, lead, clipSelectionOf(s)?.anchorId));
}

/** ⌘A: every clip, the lead kept. */
export function selectAllClips(): void {
  const s = editor();
  if (!s.draft) return;
  const selection = selectAll(orderOf(s), clipSelectionOf(s));
  if (selection) s.select(selection);
  clearTextSelection();
}

/**
 * The selection box's release: the clips it touched, added to `base` when additive. The base lead stays when it is
 * still selected, else the first clip touched leads. No clip selected after it → nothing selected, as a click on
 * empty lane space leaves it (an additive box changes nothing then).
 */
export function applyBoxSelection(base: ClipSelection | null, hitIds: readonly string[], additive: boolean): void {
  const s = editor();
  const order = orderOf(s);
  const ids = additive ? [...clipIdsOf(base, order), ...hitIds] : [...hitIds];
  const hits = new Set(hitIds);
  const lead = base && ids.includes(base.clipId) ? base.clipId : order.find((id) => hits.has(id));
  const next = makeSelection(order, ids, lead, base?.anchorId);
  // An additive box never takes anything away
  if (next === null) return additive ? undefined : clearClipSelection();
  s.select(next);
}

/** A click on empty space in any lane, video or audio: nothing selected, whichever kind the selection holds. */
export function clearClipSelection(): void {
  const s = editor();
  if (s.selection !== null) s.select(null);
}

/**
 * A click on an audio clip, as clickClip in audio order. A press on the box body leaves the curve (no point, onCurve
 * off). Nothing while the clip menu is open.
 */
export function clickAudioClip(clipId: string, mods: { toggle: boolean; range: boolean }): void {
  const s = editor();
  if (s.menu !== null) return;
  if (mods.range) s.select(asAudio(rangeTo(audioOrderOf(s), audioSelectionIn(s), clipId)));
  else if (mods.toggle) s.select(asAudio(toggleClip(audioOrderOf(s), audioSelectionIn(s), clipId)));
  else s.select(audioSelectionOf({ clipId }));
}

/** The audio clips a press on clipId drags: the selection when it holds clipId and others, else clipId alone. */
export function pressAudioGroup(clipId: string): string[] {
  const ids = selectedAudioIds(editor());
  return ids.length > 1 && ids.includes(clipId) ? ids : [clipId];
}

/** After an audio group drag: the same clips selected, the one pressed leading. */
export function keepAudioGroupSelected(ids: readonly string[], lead: string): void {
  const s = editor();
  s.select(asAudio(makeSelection(audioOrderOf(s), ids, lead, audioSelectionIn(s)?.anchorId)));
}

/** ⌘A with audio selected: every audio clip, the lead kept. */
export function selectAllAudioClips(): void {
  const s = editor();
  if (!s.draft) return;
  const selection = asAudio(selectAll(audioOrderOf(s), audioSelectionIn(s)));
  if (selection) s.select(selection);
  clearTextSelection();
}

/**
 * The selection box's release on the audio rows: the audio clips it touched, added to the audio selection when
 * additive (a video selection is replaced). Nothing touched → nothing selected, or no change when additive.
 */
export function applyAudioBoxSelection(hitIds: readonly string[], additive: boolean): void {
  const s = editor();
  const order = audioOrderOf(s);
  const base = audioSelectionIn(s);
  const ids = additive ? [...clipIdsOf(base, order), ...hitIds] : [...hitIds];
  const hits = new Set(hitIds);
  const lead = base && ids.includes(base.clipId) ? base.clipId : order.find((id) => hits.has(id));
  const next = asAudio(makeSelection(order, ids, lead, base?.anchorId));
  if (next === null) return additive ? undefined : clearClipSelection();
  s.select(next);
}
