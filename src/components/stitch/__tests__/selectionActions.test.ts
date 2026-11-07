import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import type { StitchDraft } from "@/lib/stitch/draft";
import { createAudioClip } from "@/lib/stitch/audioClips";
import { createClip } from "@/lib/stitch/timeline";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import {
  applyAudioBoxSelection,
  applyBoxSelection,
  clearClipSelection,
  clearTextSelection,
  clickAudioClip,
  clickClip,
  hasTextSelection,
  isContextClick,
  isToggleClick,
  keepAudioGroupSelected,
  keepGroupSelected,
  pressAudioGroup,
  pressGroup,
  selectAllAudioClips,
  selectAllClips,
} from "../selectionActions";
import { restoreStoreActions } from "@/test/storeActions";

const store = () => useStitchEditorStore.getState();

function openOn(mode: "track" | "stacked" = "track") {
  const draft: StitchDraft = {
    timeline: ["a", "b", "c", "d"].map((id) => createClip({ kind: "edge", edgeId: `e-${id}` }, { id })),
    // Audio order: row, then start, then id
    audioClips: [
      createAudioClip({ kind: "music" }, { id: "m", row: 0, startSec: 0 }),
      createAudioClip({ kind: "asset", assetId: "t1" }, { id: "x2", row: 0, startSec: 5 }),
      createAudioClip({ kind: "asset", assetId: "t2" }, { id: "x1", row: 1, startSec: 1 }),
    ],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: { ...DEFAULT_SEQUENCE_LAYOUT, mode },
  };
  store().open({ nodeId: "n1", draft, canvasGeneration: 1 });
}

function selectText(): Text {
  const text = document.createTextNode("Clip 1, Clip 3 and Clip 4");
  const p = document.createElement("p");
  p.appendChild(text);
  document.body.appendChild(p);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 6);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  return text;
}

const platform = (value: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(value);

describe("selectionActions", () => {
  beforeEach(() => {
    store().close();
    openOn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreStoreActions(useStitchEditorStore);
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("selects the clip alone on a plain click, collapsing a group", () => {
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "b"] });
    clickClip("c", { toggle: false, range: false });
    expect(store().selection).toEqual({ kind: "clip", clipId: "c" });
  });

  it("adds and removes a clip on a toggle click", () => {
    clickClip("c", { toggle: true, range: false });
    expect(store().selection).toEqual({ kind: "clip", clipId: "c", clipIds: ["a", "c"] });
    clickClip("a", { toggle: true, range: false });
    expect(store().selection).toEqual({ kind: "clip", clipId: "c" });
  });

  it("selects a range from the last plain click, in Track and in Stacked alike", () => {
    for (const mode of ["track", "stacked"] as const) {
      store().close();
      openOn(mode);
      clickClip("b", { toggle: false, range: false });
      clickClip("d", { toggle: false, range: true });
      expect(store().selection).toEqual({ kind: "clip", clipId: "d", clipIds: ["b", "c", "d"], anchorId: "b" });
      // ⇧ wins over ⌘
      clickClip("a", { toggle: true, range: true });
      expect(store().selection).toEqual({ kind: "clip", clipId: "a", clipIds: ["a", "b"], anchorId: "b" });
    }
  });

  it("starts a new clip selection when the selection is audio", () => {
    store().select(audioSelectionOf({ clipId: "m" }));
    clickClip("b", { toggle: true, range: false });
    expect(store().selection).toEqual({ kind: "clip", clipId: "b" });
  });

  it("does nothing while the clip menu is open", () => {
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "c"] });
    store().openMenu({ kind: "clip", clipId: "c", x: 0, y: 0 });
    clickClip("c", { toggle: false, range: false });
    expect(store().selection).toEqual({ kind: "clip", clipId: "a", clipIds: ["a", "c"] });
  });

  it("toggles with ⌘ on a Mac and Ctrl elsewhere; a Mac's Ctrl-click is a context click", () => {
    platform("MacIntel");
    expect(isToggleClick({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isToggleClick({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(isContextClick({ ctrlKey: true, button: 0 })).toBe(true);
    expect(isContextClick({ ctrlKey: false, button: 0 })).toBe(false);
    platform("Win32");
    expect(isToggleClick({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(isToggleClick({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isContextClick({ ctrlKey: true, button: 0 })).toBe(false);
  });

  it("selects every clip with ⌘A, keeping the lead, and clears a text selection", () => {
    store().select({ kind: "clip", clipId: "c" });
    selectText();
    expect(hasTextSelection()).toBe(true);
    selectAllClips();
    expect(store().selection).toEqual({ kind: "clip", clipId: "c", clipIds: ["a", "b", "c", "d"] });
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("writes the box's selection once: the clips it touched, or added to the base", () => {
    const base = { kind: "clip", clipId: "d", clipIds: ["a", "d"] } as const;
    const select = vi.spyOn(store(), "select");
    applyBoxSelection(base, ["c", "b"], false);
    expect(select).toHaveBeenCalledTimes(1);
    expect(store().selection).toEqual({ kind: "clip", clipId: "b", clipIds: ["b", "c"] });
    applyBoxSelection(base, ["c", "b"], true);
    expect(store().selection).toEqual({ kind: "clip", clipId: "d", clipIds: ["a", "b", "c", "d"] });
    applyBoxSelection(base, ["d", "c"], false);
    expect(store().selection).toEqual({ kind: "clip", clipId: "d", clipIds: ["c", "d"] });
    applyBoxSelection(base, [], true);
    expect(store().selection).toEqual(base);
    applyBoxSelection(base, [], false);
    expect(store().selection).toBeNull();
  });

  it("a video box that touches nothing clears an audio selection, unless it adds; one that touches clips replaces it", () => {
    const audio = audioSelectionOf({ clipId: "m" }, 1);
    store().select(audio);
    applyBoxSelection(null, [], true);
    expect(store().selection).toBe(audio);
    applyBoxSelection(null, [], false);
    expect(store().selection).toBeNull();
    store().select(audio);
    applyBoxSelection(null, ["b"], true);
    expect(store().selection).toEqual({ kind: "clip", clipId: "b" });
  });

  it("clears the selection of either kind on an empty-space click", () => {
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "b"] });
    clearClipSelection();
    expect(store().selection).toBeNull();
    store().select(audioSelectionOf({ clipId: "m" }, 1));
    clearClipSelection();
    expect(store().selection).toBeNull();
  });

  it("clicks audio clips in audio order: alone, ⌘ to add or remove, ⇧ for a range; a video selection is replaced", () => {
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "b"] });
    clickAudioClip("x1", { toggle: true, range: false });
    expect(store().selection).toEqual({ kind: "audio", clipId: "x1", point: null, onCurve: false });
    clickAudioClip("m", { toggle: false, range: false });
    clickAudioClip("x1", { toggle: false, range: true });
    // m, x2 (row 0), then x1 (row 1)
    expect(store().selection).toEqual({
      kind: "audio",
      clipId: "x1",
      clipIds: ["m", "x2", "x1"],
      anchorId: "m",
      point: null,
      onCurve: false,
    });
    clickAudioClip("x2", { toggle: true, range: false });
    expect(store().selection).toEqual({
      kind: "audio",
      clipId: "x1",
      clipIds: ["m", "x1"],
      anchorId: "m",
      point: null,
      onCurve: false,
    });
  });

  it("a plain click on an audio box leaves the curve: no point, onCurve off", () => {
    store().select(audioSelectionOf({ clipId: "m" }, 2, true));
    clickAudioClip("m", { toggle: false, range: false });
    expect(store().selection).toEqual({ kind: "audio", clipId: "m", point: null, onCurve: false });
  });

  it("does not change an audio selection while the menu is open", () => {
    const selection = audioSelectionOf({ clipId: "m", clipIds: ["m", "x1"] });
    store().select(selection);
    store().openMenu({ kind: "audio", clipId: "x1", x: 0, y: 0 });
    clickAudioClip("x1", { toggle: false, range: false });
    expect(store().selection).toBe(selection);
  });

  it("⌘A with audio selected selects every audio clip, keeping the lead", () => {
    store().select(audioSelectionOf({ clipId: "x2" }));
    selectAllAudioClips();
    expect(store().selection).toEqual({ kind: "audio", clipId: "x2", clipIds: ["m", "x2", "x1"], point: null, onCurve: false });
  });

  it("writes an audio box's selection once, added to the audio selection when additive", () => {
    store().select({ kind: "clip", clipId: "a" });
    const select = vi.spyOn(store(), "select");
    applyAudioBoxSelection(["x1", "x2"], false);
    expect(select).toHaveBeenCalledTimes(1);
    // A video selection is replaced, even by an additive box
    expect(store().selection).toEqual({ kind: "audio", clipId: "x2", clipIds: ["x2", "x1"], point: null, onCurve: false });
    store().select(audioSelectionOf({ clipId: "m" }));
    applyAudioBoxSelection(["x1"], true);
    expect(store().selection).toEqual({ kind: "audio", clipId: "m", clipIds: ["m", "x1"], point: null, onCurve: false });
    applyAudioBoxSelection([], true);
    expect(store().selection).toEqual({ kind: "audio", clipId: "m", clipIds: ["m", "x1"], point: null, onCurve: false });
    applyAudioBoxSelection([], false);
    expect(store().selection).toBeNull();
  });

  it("drags the audio selection from a press on one of its clips, and keeps it selected after", () => {
    store().select(audioSelectionOf({ clipId: "m", clipIds: ["m", "x1"], anchorId: "x1" }));
    expect(pressAudioGroup("x1")).toEqual(["m", "x1"]);
    expect(pressAudioGroup("x2")).toEqual(["x2"]);
    keepAudioGroupSelected(["m", "x1"], "x1");
    expect(store().selection).toEqual({ kind: "audio", clipId: "x1", clipIds: ["m", "x1"], point: null, onCurve: false });
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "b"] });
    expect(pressAudioGroup("m")).toEqual(["m"]);
  });

  it("drags the whole selection from a press on one of its clips, else the pressed clip alone", () => {
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "c"], anchorId: "c" });
    expect(pressGroup("c")).toEqual(["a", "c"]);
    expect(pressGroup("b")).toEqual(["b"]);
    store().select({ kind: "clip", clipId: "a" });
    expect(pressGroup("a")).toEqual(["a"]);
    store().select(audioSelectionOf({ clipId: "m" }));
    expect(pressGroup("a")).toEqual(["a"]);
  });

  it("keeps a dragged group selected, the pressed clip leading and the anchor kept", () => {
    store().select({ kind: "clip", clipId: "a", clipIds: ["a", "c"], anchorId: "c" });
    keepGroupSelected(["a", "c"], "a");
    expect(store().selection).toEqual({ kind: "clip", clipId: "a", clipIds: ["a", "c"], anchorId: "c" });
    keepGroupSelected(["a", "c"], "c");
    expect(store().selection).toEqual({ kind: "clip", clipId: "c", clipIds: ["a", "c"] });
  });

  it("reads and clears a text selection", () => {
    expect(hasTextSelection()).toBe(false);
    selectText();
    expect(hasTextSelection()).toBe(true);
    clearTextSelection();
    expect(hasTextSelection()).toBe(false);
    expect(window.getSelection()!.rangeCount).toBe(0);
  });
});
