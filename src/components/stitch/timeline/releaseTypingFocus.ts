import { isTypingTarget } from "../editorKeys";
import { EDITOR_PANEL_SELECTOR } from "../editorStyles";

/**
 * A press on the lanes that cancels its pointerdown (a handle, the ruler)
 * suppresses the browser's own focus change, so a focused In/Out field would
 * keep its focus, its stale text and the editor's keys. This moves focus to
 * the editor's panel first, as a click anywhere else would: the field
 * commits or reverts on blur, and the editor's keys (Escape cancelling the
 * drag) work again.
 */
export function releaseTypingFocus(from: Element): void {
  if (typeof document === "undefined" || !isTypingTarget(document.activeElement)) return;
  from.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)?.focus({ preventScroll: true });
}
