/**
 * Keyboard helpers for the agent window.
 */

interface KeyEventLike {
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
}

/**
 * Whether a keydown belongs to an input method (Japanese, Chinese, Korean...)
 * rather than to the page. `isComposing` alone misses WebKit: Safari ends the
 * composition *before* the keydown of the Enter that commits it (or the Escape
 * that cancels it), so that keydown arrives with `isComposing` false. It still
 * carries keyCode 229 ("processed by the IME"), which every engine sets.
 */
export function isImeKeyEvent(event: KeyEventLike): boolean {
  const native = event.nativeEvent ?? event;
  return !!native.isComposing || native.keyCode === 229 || event.keyCode === 229;
}
