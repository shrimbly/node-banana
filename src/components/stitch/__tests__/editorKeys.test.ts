import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { createAudioClip, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import type { StitchDraft } from "@/lib/stitch/draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import { editorKeyAction, isBrowserKey, isCanvasKey, isTypingTarget, NO_REPEAT, type KeyLike } from "../editorKeys";
import { useStitchEditorKeys } from "../useStitchEditorKeys";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: mods.code ?? "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
});

describe("editorKeyAction", () => {
  it.each([
    [key(" "), "togglePlay"],
    [key("i"), "setIn"],
    [key("o"), "setOut"],
    [key("s"), "split"],
    [key("m"), "toggleMusicMute"],
    [key("Backspace"), "remove"],
    [key("Delete"), "remove"],
    [key("Escape"), "escape"],
    [key("j"), "back"],
    [key("k"), "pause"],
    [key("l"), "play"],
    [key("z", { metaKey: true }), "undo"],
    [key("z", { ctrlKey: true }), "undo"],
    [key("Z", { metaKey: true, shiftKey: true }), "redo"],
    [key("y", { ctrlKey: true }), "redo"],
    // ⌥M on a Mac types "µ"; the physical key decides
    [key("µ", { altKey: true, code: "KeyM" }), "toggleClipMute"],
  ] as const)("%o → %s", (event, action) => {
    expect(editorKeyAction(event)).toBe(action);
  });

  it("leaves other keys alone", () => {
    expect(editorKeyAction(key("x"))).toBeNull();
    expect(editorKeyAction(key("S", { shiftKey: true }))).toBeNull();
    expect(editorKeyAction(key("s", { metaKey: true }))).toBeNull();
    expect(editorKeyAction(key("Enter"))).toBeNull();
    expect(editorKeyAction(key("ArrowLeft"))).toBeNull();
    expect(editorKeyAction(key("Tab"))).toBeNull();
  });

  it.each([
    [key("ArrowLeft", { altKey: true }), "nudgeEarlier"],
    [key("ArrowRight", { altKey: true }), "nudgeLater"],
    // ⇧ is the big step, read by the caller
    [key("ArrowLeft", { altKey: true, shiftKey: true }), "nudgeEarlier"],
    [key("ArrowRight", { altKey: true, shiftKey: true }), "nudgeLater"],
    [key("ArrowUp", { altKey: true }), "rowUp"],
    [key("ArrowDown", { altKey: true }), "rowDown"],
    [key("["), "startAtPlayhead"],
    [key("]"), "endAtPlayhead"],
    // A German Mac types [ and ] with ⌥5 and ⌥6; German Windows with AltGr (Ctrl+Alt) 8 and 9
    [key("[", { altKey: true, code: "Digit5" }), "startAtPlayhead"],
    [key("]", { ctrlKey: true, altKey: true, code: "Digit9" }), "endAtPlayhead"],
  ] as const)("the selected clip's placing keys: %o → %s", (event, action) => {
    expect(editorKeyAction(event)).toBe(action);
  });

  it.each([
    [key("-"), "zoomOut"],
    [key("="), "zoomIn"],
    // + is ⇧= on many keyboards, and its own key on others and the number pad
    [key("+", { shiftKey: true }), "zoomIn"],
    [key("+"), "zoomIn"],
    [key("Z", { shiftKey: true }), "zoomFit"],
  ] as const)("the timeline's zoom: %o → %s", (event, action) => {
    expect(editorKeyAction(event)).toBe(action);
  });

  it("leaves ⌘− and ⌘= to the browser, and ⌥ or ⌘ with ⇧Z alone", () => {
    expect(editorKeyAction(key("-", { metaKey: true }))).toBeNull();
    expect(editorKeyAction(key("=", { ctrlKey: true }))).toBeNull();
    expect(editorKeyAction(key("Z", { shiftKey: true, altKey: true }))).toBeNull();
    expect(editorKeyAction(key("Z", { shiftKey: true, metaKey: true }))).toBe("redo");
    // A held − or = keeps zooming; a held ⇧Z fits once
    expect(NO_REPEAT.has("zoomIn")).toBe(false);
    expect(NO_REPEAT.has("zoomFit")).toBe(true);
  });

  it("leaves [ and ] with ⌘ or a plain Ctrl to the browser, and ⇧⌥↑ ⇧⌥↓ alone", () => {
    expect(editorKeyAction(key("[", { metaKey: true }))).toBeNull();
    expect(editorKeyAction(key("]", { ctrlKey: true }))).toBeNull();
    expect(editorKeyAction(key("ArrowUp", { altKey: true, shiftKey: true }))).toBeNull();
    expect(editorKeyAction(key("ArrowDown", { altKey: true, shiftKey: true }))).toBeNull();
    // ⌥M still mutes the clip
    expect(editorKeyAction(key("µ", { altKey: true, code: "KeyM" }))).toBe("toggleClipMute");
  });

  it("lets the nudges repeat and nothing else that places a clip", () => {
    for (const action of ["rowUp", "rowDown", "startAtPlayhead", "endAtPlayhead"] as const) {
      expect(NO_REPEAT.has(action)).toBe(true);
    }
    expect(NO_REPEAT.has("nudgeEarlier")).toBe(false);
    expect(NO_REPEAT.has("nudgeLater")).toBe(false);
  });
});

describe("the clip keys", () => {
  const CLIP_KEYS = [
    ["c", "copy"],
    ["x", "cut"],
    ["v", "paste"],
    ["d", "duplicate"],
    ["a", "selectAll"],
  ] as const;

  it.each(CLIP_KEYS)("⌘%s and Ctrl+%s → %s", (k, action) => {
    expect(editorKeyAction(key(k, { metaKey: true }))).toBe(action);
    expect(editorKeyAction(key(k, { ctrlKey: true }))).toBe(action);
    // Caps Lock or a layout that sends the capital
    expect(editorKeyAction(key(k.toUpperCase(), { metaKey: true }))).toBe(action);
  });

  it("leaves them with ⇧ or ⌥ alone, and the bare letters as they were", () => {
    for (const [k] of CLIP_KEYS) {
      expect(editorKeyAction(key(k.toUpperCase(), { metaKey: true, shiftKey: true }))).toBeNull();
      expect(editorKeyAction(key(k, { metaKey: true, altKey: true }))).toBeNull();
      expect(editorKeyAction(key(k, { ctrlKey: true, altKey: true }))).toBeNull();
    }
    expect(editorKeyAction(key("c"))).toBeNull();
    expect(editorKeyAction(key("x"))).toBeNull();
    expect(editorKeyAction(key("a"))).toBeNull();
    expect(editorKeyAction(key("d"))).toBeNull();
  });

  it("does not repeat any of them", () => {
    for (const [, action] of CLIP_KEYS) expect(NO_REPEAT.has(action)).toBe(true);
  });

  it("keeps ⌘D always and ⌘A outside a text field from the browser", () => {
    const field = document.createElement("input");
    const button = document.createElement("button");
    const on = (target: EventTarget | null, k: string, mods: Partial<KeyLike> = { metaKey: true }) =>
      isBrowserKey({ ...key(k, mods), target });
    expect(on(button, "d")).toBe(true);
    expect(on(field, "d")).toBe(true);
    expect(on(button, "a")).toBe(true);
    expect(on(button, "a", { ctrlKey: true })).toBe(true);
    // A text field's ⌘A selects its text
    expect(on(field, "a")).toBe(false);
    expect(on(button, "c")).toBe(false);
    expect(on(button, "d", { metaKey: true, shiftKey: true })).toBe(false);
    expect(on(button, "d", { metaKey: true, altKey: true })).toBe(false);
    expect(on(button, "d", {})).toBe(false);
  });
});

describe("isCanvasKey", () => {
  afterEach(() => window.getSelection()?.removeAllRanges());

  it("covers what WorkflowCanvas acts on behind a dialog", () => {
    expect(isCanvasKey(key("?", { shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("Enter", { altKey: true }))).toBe(true);
    expect(isCanvasKey(key("Enter", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("c", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("v", { ctrlKey: true }))).toBe(true);
    expect(isCanvasKey(key("z", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("Z", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("G", { shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("v"))).toBe(true);
    expect(isCanvasKey(key("g"))).toBe(true);
    expect(isCanvasKey(key("a"))).toBe(true);
    expect(isCanvasKey(key("c"))).toBe(true);
    expect(isCanvasKey(key("e"))).toBe(true);
  });

  it("counts bare E (the Edit video view), but not ⌘E, Ctrl+E or ⌥E", () => {
    expect(isCanvasKey(key("e"))).toBe(true);
    expect(isCanvasKey(key("E"))).toBe(true);
    expect(isCanvasKey(key("e", { metaKey: true }))).toBe(false);
    expect(isCanvasKey(key("e", { ctrlKey: true }))).toBe(false);
    expect(isCanvasKey(key("e", { altKey: true }))).toBe(false);
  });

  it("counts ⌘C with text selected (the shield never prevents the native copy, and the canvas would copy nodes)", () => {
    const p = document.createElement("p");
    p.textContent = "0:04.60";
    document.body.appendChild(p);
    window.getSelection()?.selectAllChildren(p);
    expect(isCanvasKey(key("c", { metaKey: true }))).toBe(true);
    p.remove();
  });

  it("matches the canvas's own modifier rules, not a stricter subset", () => {
    // Arrange (two or more nodes selected) reads only the key
    expect(isCanvasKey(key("g", { metaKey: true }))).toBe(true);
    expect(isCanvasKey(key("g", { ctrlKey: true }))).toBe(true);
    expect(isCanvasKey(key("G", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCanvasKey(key("v", { altKey: true }))).toBe(true);
    expect(isCanvasKey(key("g", { altKey: true }))).toBe(true);
    // Undo, paste and copy do not check Alt (Ctrl+Alt is AltGr on Windows)
    expect(isCanvasKey(key("z", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCanvasKey(key("v", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCanvasKey(key("c", { ctrlKey: true, altKey: true }))).toBe(true);
    // Shift+letter adds a node whatever Alt is (Windows and Linux keep the letter)
    expect(isCanvasKey(key("G", { shiftKey: true, altKey: true }))).toBe(true);
    expect(isCanvasKey(key("P", { shiftKey: true, altKey: true }))).toBe(true);
  });

  it("leaves native keys alone", () => {
    expect(isCanvasKey(key("Tab"))).toBe(false);
    expect(isCanvasKey(key("ArrowRight"))).toBe(false);
    expect(isCanvasKey(key("Enter"))).toBe(false);
    expect(isCanvasKey(key("s", { metaKey: true }))).toBe(false);
    expect(isCanvasKey(key("x"))).toBe(false);
  });
});

describe("isTypingTarget", () => {
  const input = (type: string) => {
    const el = document.createElement("input");
    el.type = type;
    return el;
  };

  it("counts text fields", () => {
    expect(isTypingTarget(input("text"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTypingTarget(editable)).toBe(true);
  });

  it("does not count a slider, a checkbox or a button", () => {
    expect(isTypingTarget(input("range"))).toBe(false);
    expect(isTypingTarget(input("checkbox"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});

describe("the editor's keys with an audio selection", () => {
  const TONE = "atone00000001";
  const store = () => useStitchEditorStore.getState();
  const audio = () => store().draft!.audioClips;
  const audioClip = (id: string) => audio().find((c) => c.id === id)!;
  const video = () => store().draft!.timeline;
  const press = (k: string, mods: Partial<KeyLike> = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: mods.code ?? "", bubbles: true, cancelable: true, ...mods }));

  beforeEach(() => {
    store().close();
    const draft: StitchDraft = {
      timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "a" }), createClip({ kind: "edge", edgeId: "e2" }, { id: "b" })],
      audioClips: [
        createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, curve: [{ t: 1, gain: 0.5 }, { t: 2, gain: 0.25 }] }),
        createAudioClip({ kind: "asset", assetId: TONE }, { id: "t", row: 1, startSec: 2 }),
      ],
      legacyAudio: { curve: [], muted: false },
      loopCount: 1,
      sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
    };
    store().open({ nodeId: "n1", draft, canvasGeneration: 1 });
    store().setDurations(
      new Map<SourceKey, number>([
        ["edge:e1", 5],
        ["edge:e2", 5],
      ]),
    );
    store().setAudioDurations(
      new Map([
        ["music", 20],
        [`asset:${TONE}`, 3],
      ]),
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}));
  });
  afterEach(() => {
    store().close();
    document.body.innerHTML = "";
  });

  it("S splits the selected audio clip, not the video under the playhead", () => {
    store().select(audioSelectionOf({ clipId: "t" }));
    store().setPlayhead(3);
    press("s");
    expect(video()).toHaveLength(2);
    expect(audio().filter((c) => c.source.kind === "asset")).toHaveLength(2);
    expect(store().selection).toMatchObject({ kind: "audio" });
    expect(store().selection?.clipId).not.toBe("t");
    // The cut is at the playhead: the left piece keeps the id and ends there, the right one starts there
    expect(audioClip("t")).toMatchObject({ startSec: 2, inSec: 0, outSec: 1, row: 1 });
    expect(audioClip(store().selection!.clipId)).toMatchObject({ startSec: 3, inSec: 1, row: 1 });
  });

  it("S with a video selection still splits video", () => {
    store().select({ kind: "clip", clipId: "a" });
    store().setPlayhead(3);
    press("s");
    expect(video()).toHaveLength(3);
    expect(audio()).toHaveLength(2);
  });

  it("⌫ removes the selected point, then nothing while onCurve, else the clips", () => {
    store().setAudioExpandedRow(0);
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true));
    press("Backspace");
    expect(audioClip(MUSIC_CLIP_ID).curve).toHaveLength(1);
    expect(store().selection).toMatchObject({ point: 0, onCurve: true });
    store().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, null, true));
    press("Delete");
    expect(audio()).toHaveLength(2);
    store().select(audioSelectionOf({ clipId: "t" }));
    press("Backspace");
    expect(audio().map((c) => c.id)).toEqual([MUSIC_CLIP_ID]);
    expect(video()).toHaveLength(2);
  });

  it("M and ⌥M mute the selected audio clips; M without them mutes the music", () => {
    store().select(audioSelectionOf({ clipId: "t" }));
    press("m");
    expect(audio().map((c) => c.muted)).toEqual([false, true]);
    press("µ", { altKey: true, code: "KeyM" });
    expect(audio().map((c) => c.muted)).toEqual([false, false]);
    store().select({ kind: "clip", clipId: "a" });
    press("m");
    expect(audio().map((c) => c.muted)).toEqual([true, false]);
    expect(video().every((c) => !c.muted)).toBe(true);
  });

  it("⌥ arrows nudge and change the row of the selected audio clips, in Track", () => {
    store().select(audioSelectionOf({ clipId: "t" }));
    press("ArrowRight", { altKey: true });
    expect(audioClip("t").startSec).toBeCloseTo(2 + 1 / 60, 9);
    press("ArrowDown", { altKey: true });
    expect(audioClip("t").row).toBe(2);
    press("ArrowUp", { altKey: true });
    expect(audioClip("t").row).toBe(1);
    expect(video().map((c) => c.startSec)).toEqual([undefined, undefined]);
  });

  it("[ and ] place the selected audio clip at the playhead; I and O trim it there", () => {
    store().select(audioSelectionOf({ clipId: "t" }));
    store().setPlayhead(6);
    press("[");
    expect(audioClip("t").startSec).toBe(6);
    press("]");
    expect(audioClip("t").startSec).toBe(3);
    store().setPlayhead(4);
    press("i");
    expect(audioClip("t")).toMatchObject({ inSec: 1, startSec: 4 });
    store().setPlayhead(5);
    press("o");
    expect(audioClip("t")).toMatchObject({ inSec: 1, outSec: 2 });
    expect(video().map((c) => [c.inSec, c.outSec])).toEqual([
      [0, null],
      [0, null],
    ]);
  });

  it("⌘A selects every audio clip with audio selected, else every video clip", () => {
    store().select(audioSelectionOf({ clipId: "t" }));
    press("a", { metaKey: true });
    expect(store().selection).toEqual({ kind: "audio", clipId: "t", clipIds: [MUSIC_CLIP_ID, "t"], point: null, onCurve: false });
    store().select({ kind: "clip", clipId: "b" });
    press("a", { metaKey: true });
    expect(store().selection).toEqual({ kind: "clip", clipId: "b", clipIds: ["a", "b"] });
  });

  it("leaves the keys to the picker while it is open for audio", () => {
    store().select(audioSelectionOf({ clipId: "t" }));
    store().setPickerOpen("audio");
    press("Backspace");
    expect(audio()).toHaveLength(2);
  });
});

describe("useStitchEditorKeys's options (the Edit video view)", () => {
  const store = () => useStitchEditorStore.getState();
  const dispatch = (type: "keydown" | "keyup", k: string, target: EventTarget = window, mods: Partial<KeyLike> = {}) => {
    const event = new KeyboardEvent(type, { key: k, code: mods.code ?? "", bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(event);
    return event;
  };
  let root: HTMLElement;

  beforeEach(() => {
    store().close();
    const draft: StitchDraft = {
      timeline: [createClip({ kind: "asset", assetId: "aclip00000001" }, { id: "a" }), createClip({ kind: "asset", assetId: "aclip00000002" }, { id: "b" })],
      audioClips: [],
      legacyAudio: { curve: [], muted: false },
      loopCount: 1,
      sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
    };
    store().openEdit({ editId: "e1", draft });
    store().setDurations(
      new Map<SourceKey, number>([
        ["asset:aclip00000001", 5],
        ["asset:aclip00000002", 5],
      ]),
    );
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    store().close();
    document.body.innerHTML = "";
  });

  it("with isStacked true: Escape and Space pass untouched, and no editor action runs", () => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.appendChild(item);
    root.appendChild(menu);
    renderHook(() => useStitchEditorKeys({ current: root }, () => store().close(), { isStacked: () => true }));
    store().select({ kind: "clip", clipId: "a" });
    const draft = store().draft;

    expect(dispatch("keydown", "Escape", item).defaultPrevented).toBe(false);
    expect(dispatch("keydown", " ", item).defaultPrevented).toBe(false);
    expect(dispatch("keyup", " ", item).defaultPrevented).toBe(false);
    dispatch("keydown", "Backspace", item);
    dispatch("keydown", "s", item);
    expect(store().isOpen).toBe(true);
    expect(store().playing).toBe(false);
    expect(store().draft).toBe(draft);
    expect(store().selection).toMatchObject({ kind: "clip", clipId: "a" });
  });

  it("with isStacked true, the canvas behind still never hears its keys", () => {
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}, { isStacked: () => true }));
    const canvas = vi.fn();
    window.addEventListener("keydown", canvas);
    try {
      dispatch("keydown", "a", root);
      dispatch("keydown", "e", root);
      expect(canvas).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", canvas);
    }
  });

  it("once isStacked turns false, the editor's keys work again", () => {
    let stacked = true;
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}, { isStacked: () => stacked }));
    store().select({ kind: "clip", clipId: "a" });
    dispatch("keydown", "Backspace", root);
    expect(store().draft!.timeline).toHaveLength(2);
    stacked = false;
    dispatch("keydown", "Backspace", root);
    expect(store().draft!.timeline).toHaveLength(1);
  });

  it("hands a key that is no editor key to onOtherKey first, and stops it when that handles it", () => {
    const onOtherKey = vi.fn((e: KeyboardEvent) => e.key === "e");
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}, { onOtherKey }));
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      const handled = dispatch("keydown", "e", root);
      expect(onOtherKey).toHaveBeenCalledTimes(1);
      expect(handled.defaultPrevented).toBe(true);
      // An editor key never reaches it
      dispatch("keydown", " ", root);
      expect(onOtherKey).toHaveBeenCalledTimes(1);
      expect(store().playing).toBe(true);
      // Not handled: the canvas key is still shielded, without its default prevented
      const passed = dispatch("keydown", "a", root);
      expect(onOtherKey).toHaveBeenCalledTimes(2);
      expect(passed.defaultPrevented).toBe(false);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("never asks onOtherKey while typing or during a drag", () => {
    const onOtherKey = vi.fn(() => true);
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}, { onOtherKey }));
    const field = document.createElement("input");
    root.appendChild(field);
    dispatch("keydown", "e", field);
    expect(onOtherKey).not.toHaveBeenCalled();

    store().setCancelGesture(() => {});
    dispatch("keydown", "e", root);
    expect(onOtherKey).not.toHaveBeenCalled();
  });

  it("zooms the timeline it is given with − and =, and fits it with ⇧Z, keeping them from the canvas", () => {
    const zoom = { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn() };
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}, { zoom }));
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      expect(dispatch("keydown", "=", root).defaultPrevented).toBe(true);
      dispatch("keydown", "-", root);
      dispatch("keydown", "Z", root, { shiftKey: true });
      expect([zoom.zoomIn, zoom.zoomOut, zoom.fit].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
      expect(behind).not.toHaveBeenCalled();
      // Not while typing (a minus in a field), nor during a drag
      const field = document.createElement("input");
      root.appendChild(field);
      dispatch("keydown", "-", field);
      store().setCancelGesture(() => {});
      dispatch("keydown", "=", root);
      expect([zoom.zoomIn, zoom.zoomOut].map((f) => f.mock.calls.length)).toEqual([1, 1]);
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("without options, behaves as the dialog always has: E is shielded, not handled", () => {
    renderHook(() => useStitchEditorKeys({ current: root }, () => {}));
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      const event = dispatch("keydown", "e", root);
      expect(event.defaultPrevented).toBe(false);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });
});
