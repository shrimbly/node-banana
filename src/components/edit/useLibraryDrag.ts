import { useCallback, useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { AssetView } from "@/lib/assets/types";
import { libraryItemOf, stackedAddBlocked, WAITING_FOR_CLIPS, type LibraryItem } from "@/lib/stitch/libraryInsert";
import { addLibraryItemAt } from "@/components/stitch/editorActions";
import { armed, DRAG_START_PX, edgeSpeed } from "@/components/stitch/timeline/autoScroll";
import { libraryDrop } from "@/components/stitch/timeline/libraryDrop";
import { useStitchEditorStore } from "@/store/stitchEditorStore";

/** The ghost under the pointer while a library tile is dragged. */
export interface LibraryDragGhost {
  asset: AssetView;
  x: number;
  y: number;
  /** "Waiting for the clips to load" over a Stacked place that cannot take it yet. */
  waiting: boolean;
}

/**
 * The ghost lives outside React state: a pointer move redraws the ghost
 * alone (useLibraryDragGhost), never the pane and its tiles.
 */
let ghostNow: LibraryDragGhost | null = null;
const ghostListeners = new Set<() => void>();

function setGhost(ghost: LibraryDragGhost | null): void {
  ghostNow = ghost;
  for (const listener of ghostListeners) listener();
}

function subscribeGhost(listener: () => void): () => void {
  ghostListeners.add(listener);
  return () => {
    ghostListeners.delete(listener);
  };
}

/** The ghost of the tile being dragged, or null. */
export function useLibraryDragGhost(): LibraryDragGhost | null {
  return useSyncExternalStore(subscribeGhost, () => ghostNow, () => null);
}

/**
 * A library tile dragged onto the timeline, with pointer events (the repo's
 * drags draw what release gives and take Escape through the editor's key
 * path, which native drag and drop cannot). A press that travels 4px lifts:
 * playback pauses, a ghost follows the pointer, and the Timeline's probe
 * says where it would drop, which the lanes' marker draws. Release over a
 * target adds the item there as one undo step; release anywhere else,
 * Escape, a cancelled pointer or the window losing focus add nothing. The
 * lanes scroll by themselves near their sides. The tile itself never moves.
 *
 * The click the browser sends after a drag's release (pointer capture sends
 * it to the tile) is not an add: `consumeClick` answers true once for it,
 * also after a cancelled drag.
 */
export function useLibraryDrag() {
  const dragged = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const consumeClick = useCallback(() => {
    if (!dragged.current) return false;
    dragged.current = false;
    return true;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, asset: AssetView) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const item: LibraryItem | null = libraryItemOf(asset);
    if (!item) return;
    stop.current?.();
    dragged.current = false;
    const tile = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let lastX = startX;
    let lastY = startY;
    let shift = event.shiftKey;
    let started = false;
    let frame = 0;
    try {
      tile.setPointerCapture(pointerId);
    } catch {
      // A synthetic pointer (tests) cannot be captured; the listeners still hear it on the tile
    }

    const place = () => {
      const editor = useStitchEditorStore.getState();
      const target = libraryDrop.probe(lastX, lastY, item, { snap: editor.snap && !shift });
      const waiting =
        target !== null && editor.draft !== null && stackedAddBlocked(editor.draft, target, editor.clipsLoading) !== null;
      libraryDrop.set(waiting ? null : target, item);
      setGhost({ asset, x: lastX, y: lastY, waiting });
    };

    // Near a side of the lanes they scroll, once the pointer has headed that way since the press; each scroll re-places
    const step = () => {
      frame = 0;
      const lanes = libraryDrop.lanes();
      if (!started || !lanes) return;
      const rect = lanes.getBoundingClientRect();
      const inside = lastY >= rect.top && lastY <= rect.bottom && lastX >= rect.left - 40 && lastX <= rect.right + 40;
      const speed = inside ? armed(edgeSpeed(lastX, rect.left, rect.right), lastX - startX) : 0;
      if (speed === 0) return;
      lanes.scrollLeft += speed;
      place();
      frame = requestAnimationFrame(step);
    };

    // The click that follows a drag's release is swallowed (consumeClick); one nobody took is dropped after it
    const forgetDrag = () => {
      setTimeout(() => {
        dragged.current = false;
      }, 0);
    };
    const finish = (apply: boolean, pointerUp = false) => {
      cleanup();
      if (!started) return;
      if (pointerUp) forgetDrag();
      else window.addEventListener("pointerup", forgetDrag, { capture: true, once: true });
      const target = libraryDrop.get();
      libraryDrop.set(null);
      setGhost(null);
      useStitchEditorStore.getState().setCancelGesture(null);
      if (apply && target) addLibraryItemAt(asset, target);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      lastX = e.clientX;
      lastY = e.clientY;
      shift = e.shiftKey;
      if (!started) {
        if (Math.hypot(lastX - startX, lastY - startY) <= DRAG_START_PX) return;
        started = true;
        dragged.current = true;
        const editor = useStitchEditorStore.getState();
        editor.setPlaying(false);
        editor.setCancelGesture(() => finish(false));
      }
      place();
      if (!frame) frame = requestAnimationFrame(step);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(true, true);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(false);
    };
    const onBlur = () => finish(false);

    function cleanup() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      tile.removeEventListener("pointermove", onMove);
      tile.removeEventListener("pointerup", onUp);
      tile.removeEventListener("pointercancel", onCancel);
      tile.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("blur", onBlur);
      try {
        if (tile.hasPointerCapture?.(pointerId)) tile.releasePointerCapture(pointerId);
      } catch {
        // Already released
      }
      if (stop.current === halt) stop.current = null;
    }
    const halt = () => finish(false);
    stop.current = halt;

    tile.addEventListener("pointermove", onMove);
    tile.addEventListener("pointerup", onUp);
    tile.addEventListener("pointercancel", onCancel);
    tile.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("blur", onBlur);
  }, []);

  return { onPointerDown, consumeClick, waitingText: WAITING_FOR_CLIPS };
}
