import { useEffect, useRef, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { isSaveShortcut } from "@/utils/saveShortcut";
import { editorKeyAction, isBrowserKey, isCanvasKey, isTypingTarget, NO_REPEAT, type EditorKeyAction } from "./editorKeys";
import { copySelection, cutSelection, duplicateSelection, pasteClipboard } from "./clipboardActions";
import type { TimelineZoom } from "./timeline/useTimelineZoom";
import { hasTextSelection, selectAllAudioClips, selectAllClips } from "./selectionActions";
import {
  endSelectedAtPlayhead,
  endSelectedAudioAtPlayhead,
  moveSelectedAudioRow,
  moveSelectedRow,
  nudgeSelectedAudio,
  nudgeSelectedClip,
  pause,
  play,
  removeAudioSelection,
  removeSelection,
  setAudioEdgeAtPlayhead,
  setEdgeAtPlayheadForSelection,
  splitAtPlayhead,
  splitSelectedAudioAtPlayhead,
  startSelectedAtPlayhead,
  startSelectedAudioAtPlayhead,
  stepBack,
  toggleMusicMute,
  togglePlay,
  toggleSelectedAudioMute,
  toggleSelectedClipMute,
} from "./editorActions";

/** A dialog stacked over the editor (the discard sheet, the picker, anything else): it owns the keys. */
function stackedDialogOpen(root: HTMLElement | null): boolean {
  const s = useStitchEditorStore.getState();
  if (s.discardOpen || s.pickerOpen !== false) return true;
  const overlays = document.querySelectorAll("[data-dialog-overlay]");
  const top = overlays[overlays.length - 1];
  return Boolean(top && root && !top.contains(root));
}

export interface StitchEditorKeyOptions {
  /** A key that is no editor key, before the canvas shield: true means it was handled (it is then prevented and stopped). */
  onOtherKey?: (e: KeyboardEvent) => boolean;
  /** Something of the caller's own over the editor (a menu) owns the keys, as a stacked dialog does. */
  isStacked?: () => boolean;
  /** The timeline's zoom, for − = and ⇧Z (the same as the control row's −, + and Fit, which a narrow row drops). */
  zoom?: Pick<TimelineZoom, "zoomIn" | "zoomOut" | "fit">;
}

/**
 * Each action is handled in either layout; the ones that place a video clip in time or change its row do nothing in
 * Track. With audio clips selected, the clip keys act on them (audio always has a start and a row); M mutes them.
 */
function run(
  action: EditorKeyAction,
  e: Pick<KeyboardEvent, "shiftKey" | "repeat">,
  requestClose: () => void,
  zoom: StitchEditorKeyOptions["zoom"],
): void {
  const s = useStitchEditorStore.getState();
  if (s.selection?.kind === "audio") {
    switch (action) {
      case "setIn":
        return setAudioEdgeAtPlayhead("in");
      case "setOut":
        return setAudioEdgeAtPlayhead("out");
      case "split":
        return splitSelectedAudioAtPlayhead();
      case "remove":
        return removeAudioSelection();
      case "toggleMusicMute":
      case "toggleClipMute":
        return toggleSelectedAudioMute();
      case "nudgeEarlier":
        return nudgeSelectedAudio(-1, e.shiftKey, e.repeat);
      case "nudgeLater":
        return nudgeSelectedAudio(1, e.shiftKey, e.repeat);
      case "rowUp":
        return moveSelectedAudioRow(-1);
      case "rowDown":
        return moveSelectedAudioRow(1);
      case "startAtPlayhead":
        return startSelectedAudioAtPlayhead();
      case "endAtPlayhead":
        return endSelectedAudioAtPlayhead();
      case "selectAll":
        return selectAllAudioClips();
      default:
        // Playback, history, Escape and the clipboard (which reads the selection's kind itself)
        break;
    }
  }
  switch (action) {
    case "togglePlay":
      return togglePlay();
    case "play":
      return play();
    case "pause":
      return pause();
    case "back":
      return stepBack();
    case "setIn":
      return setEdgeAtPlayheadForSelection("in");
    case "setOut":
      return setEdgeAtPlayheadForSelection("out");
    case "split":
      return splitAtPlayhead();
    case "remove":
      return removeSelection();
    case "toggleMusicMute":
      return toggleMusicMute();
    case "toggleClipMute":
      return toggleSelectedClipMute();
    case "nudgeEarlier":
      return nudgeSelectedClip(-1, e.shiftKey, e.repeat);
    case "nudgeLater":
      return nudgeSelectedClip(1, e.shiftKey, e.repeat);
    case "rowUp":
      return moveSelectedRow(-1);
    case "rowDown":
      return moveSelectedRow(1);
    case "startAtPlayhead":
      return startSelectedAtPlayhead();
    case "endAtPlayhead":
      return endSelectedAtPlayhead();
    case "copy":
      copySelection();
      return;
    case "cut":
      return cutSelection();
    case "paste":
      return pasteClipboard();
    case "duplicate":
      return duplicateSelection();
    case "selectAll":
      return selectAllClips();
    case "zoomIn":
      return zoom?.zoomIn();
    case "zoomOut":
      return zoom?.zoomOut();
    case "zoomFit":
      return zoom?.fit();
    case "undo":
      return s.undo();
    case "redo":
      return s.redo();
    case "escape":
      if (s.cancelGesture) return s.cancelGesture();
      return requestClose();
  }
}

/**
 * The editor's keys, taken at the window in the capture phase while it is
 * open: before React Flow's document listener, before WorkflowCanvas's
 * window listener, and before the Dialog's own Escape. An editor key is
 * handled and stopped. Every other key the canvas would act on (⌘Z, ⌘↵,
 * Shift+letters, ⌘V, ?) is stopped too, without preventDefault, so nothing
 * runs behind the dialog while Tab, the arrows and Enter keep their native
 * behaviour. ⌘S still saves. A text field, a stacked dialog and the clip
 * menu each keep their own keys, though ⌘D and ⌘A still never reach the
 * browser there. While a trim, move or reorder drag runs, Escape cancels it
 * and the other editor keys are swallowed. ⌥ with an arrow is an editor key
 * in Track too, where it does nothing: Alt+← would otherwise go Back in a
 * browser on Windows. ⌘C, ⌘X, ⌘V, ⌘D and ⌘A act on clips, except that with
 * text selected on the page ⌘C and ⌘X copy the text, natively. The Edit
 * video view hands in its own view keys (`onOtherKey`) and menus
 * (`isStacked`); the node's dialog its header's menu (`isStacked`) and ?
 * (`onOtherKey`); both their timeline's zoom (`zoom`), which − = and ⇧Z
 * drive.
 */
export function useStitchEditorKeys(
  rootRef: RefObject<HTMLElement | null>,
  requestClose: () => void,
  options: StitchEditorKeyOptions = {},
): void {
  const isOpen = useStitchEditorStore((s) => s.isOpen);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!isOpen) return;
    const stacked = () => stackedDialogOpen(rootRef.current) || optionsRef.current.isStacked?.() === true;

    const onKeyDown = (e: KeyboardEvent) => {
      const shield = () => {
        if (isCanvasKey(e) && !isTypingTarget(e.target)) e.stopImmediatePropagation();
      };
      if (isSaveShortcut(e)) return;

      // A stacked dialog hears its own Escape (its Dialog listener); canvas keys stay off
      if (stacked()) {
        if (isBrowserKey(e)) e.preventDefault();
        if (e.key !== "Escape") shield();
        return;
      }

      // The clip menu: Escape closes it and nothing else; its own onKeyDown moves between rows
      const s = useStitchEditorStore.getState();
      if (s.menu) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          s.openMenu(null);
          return;
        }
        if (isBrowserKey(e)) e.preventDefault();
        shield();
        return;
      }

      // A trim, move or reorder drag: Escape cancels it, wherever focus is
      if (s.cancelGesture && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        s.cancelGesture();
        return;
      }

      // A timecode field keeps its keys (Enter commits, Escape reverts, native undo); ⌘D still does not bookmark
      if (isTypingTarget(e.target)) {
        if (isBrowserKey(e)) e.preventDefault();
        return;
      }

      const action = editorKeyAction(e);
      // Rail text selected with the mouse: the browser copies it, and nothing behind the dialog hears the key
      if ((action === "copy" || action === "cut") && hasTextSelection()) {
        e.stopImmediatePropagation();
        return;
      }
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat && NO_REPEAT.has(action)) return;
        // The drag applies what it measured at the press on release: nothing may edit the draft under it (K only pauses)
        if (s.cancelGesture && action !== "pause") return;
        run(action, e, requestClose, optionsRef.current.zoom);
        return;
      }
      if (!s.cancelGesture && optionsRef.current.onOtherKey?.(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      shield();
    };

    // A focused button would click on Space's keyup; the keydown already played
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || isTypingTarget(e.target)) return;
      if (stacked() || useStitchEditorStore.getState().menu) return;
      e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [isOpen, rootRef, requestClose]);
}
