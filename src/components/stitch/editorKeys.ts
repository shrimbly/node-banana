/**
 * The Stitch editor's keys, as pure functions of a keydown: which editor
 * action a key means, whether focus is in a text field, and which keys the
 * canvas behind the dialog would act on (WorkflowCanvas's window handler
 * only guards bare A and C against dialogs, so the editor shields the rest).
 */

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type EditorKeyAction =
  | "togglePlay"
  | "setIn"
  | "setOut"
  | "split"
  | "remove"
  | "toggleMusicMute"
  | "toggleClipMute"
  | "undo"
  | "redo"
  | "escape"
  | "back"
  | "pause"
  | "play"
  | "nudgeEarlier"
  | "nudgeLater"
  | "rowUp"
  | "rowDown"
  | "startAtPlayhead"
  | "endAtPlayhead"
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "selectAll"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit";

/** Inputs that take no typing: a focused slider or switch leaves the editor's keys working. */
const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset"]);

/** textarea, select, [contenteditable], or an input whose type is not range, checkbox, radio or button. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest("[contenteditable=''], [contenteditable='true']") !== null;
}

/**
 * Keys WorkflowCanvas's window handler acts on, with its own modifier rules
 * (it checks fewer modifiers than it might, so this matches them, not a
 * tidier subset): ? (any modifier but ⌘/Ctrl), ⌥↵ and ⌘↵, ⌘C, ⌘V and ⌘Z
 * (Alt or Shift allowed), Shift+letter without ⌘/Ctrl (adds a node, Alt
 * allowed), V and G with any modifiers (arranges the selected nodes), and
 * bare A, C and E (the views). Shielding only stops propagation, never the default, so a
 * wide net costs nothing: ⌘C still copies selected text natively.
 */
export function isCanvasKey(e: KeyLike): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.key === "?" && !mod) return true;
  if (e.key === "Enter" && (mod || e.altKey)) return true;
  if (mod && (key === "c" || key === "v" || key === "z")) return true;
  if (e.shiftKey && !mod && /^[a-z]$/.test(key)) return true;
  if (key === "v" || key === "g") return true;
  return !mod && !e.altKey && !e.shiftKey && (key === "a" || key === "c" || key === "e");
}

/**
 * ⌘D (bookmark) always, and ⌘A (select the page) outside a text field: keys a stacked dialog or the clip menu, which
 * keep the editor's keys for themselves, must still keep from the browser.
 */
export function isBrowserKey(e: KeyLike & { target: EventTarget | null }): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  const key = e.key.toLowerCase();
  return key === "d" || (key === "a" && !isTypingTarget(e.target));
}

/**
 * The editor action a key means, or null. Repeat is the caller's to check, and so is ⇧ on the nudges (a big step).
 * [ and ] are read by the character typed, before any modifier rule: on a German Mac it is ⌥5 and ⌥6, on German
 * Windows AltGr+8 and AltGr+9 (Ctrl+Alt). ⌘ (or Ctrl) with Z, Y, C, X, V, D and A are the editor's; any other stays
 * the browser's.
 */
export function editorKeyAction(e: KeyLike): EditorKeyAction | null {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape") return "escape";
  if ((e.key === "[" || e.key === "]") && !e.metaKey && !(e.ctrlKey && !e.altKey)) {
    return e.key === "[" ? "startAtPlayhead" : "endAtPlayhead";
  }
  if (mod && !e.altKey) {
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y" && !e.shiftKey) return "redo";
    if (e.shiftKey) return null;
    switch (key) {
      case "c":
        return "copy";
      case "x":
        return "cut";
      case "v":
        return "paste";
      case "d":
        return "duplicate";
      case "a":
        return "selectAll";
      default:
        return null;
    }
  }
  if (e.altKey) {
    // The selected clip's modifier: ⌥← ⌥→ nudge it (⇧ further), ⌥↑ ⌥↓ change its row
    if (e.key === "ArrowLeft") return "nudgeEarlier";
    if (e.key === "ArrowRight") return "nudgeLater";
    if (e.shiftKey) return null;
    if (e.key === "ArrowUp") return "rowUp";
    if (e.key === "ArrowDown") return "rowDown";
    // ⌥M: on a Mac e.key is "µ", so read the physical key
    return e.code === "KeyM" ? "toggleClipMute" : null;
  }
  if (e.key === "Backspace" || e.key === "Delete") return "remove";
  // The timeline's zoom: − and = (or +, which some keyboards type with ⇧), and ⇧Z for Fit. ⌘− and ⌘= stay the browser's
  if (e.key === "-") return "zoomOut";
  if (e.key === "=" || e.key === "+") return "zoomIn";
  if (e.shiftKey && key === "z") return "zoomFit";
  if (e.shiftKey) return null;
  switch (key) {
    case " ":
      return "togglePlay";
    case "i":
      return "setIn";
    case "o":
      return "setOut";
    case "s":
      return "split";
    case "m":
      return "toggleMusicMute";
    case "j":
      return "back";
    case "k":
      return "pause";
    case "l":
      return "play";
    default:
      return null;
  }
}

/**
 * Actions a held key must not repeat: a toggle would flicker, a split would cut again, a row move would run away, a
 * paste would paste again. The nudges repeat, as one undo step.
 */
export const NO_REPEAT: ReadonlySet<EditorKeyAction> = new Set([
  "togglePlay",
  "split",
  "toggleMusicMute",
  "toggleClipMute",
  "escape",
  "remove",
  "rowUp",
  "rowDown",
  "startAtPlayhead",
  "endAtPlayhead",
  "copy",
  "cut",
  "paste",
  "duplicate",
  "selectAll",
  "zoomFit",
]);
