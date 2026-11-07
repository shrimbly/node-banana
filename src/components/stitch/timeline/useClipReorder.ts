import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { blockDropIndexAt, dropIndexAt, stackedDropIndex } from "@/lib/stitch/reorder";
import { moveClipRows, moveClipsTo, moveClipTo } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import {
  clearTextSelection,
  clickClip,
  isContextClick,
  isToggleClick,
  keepGroupSelected,
  pressGroup,
} from "../selectionActions";
import { DRAG_START_PX } from "./autoScroll";
import { releaseTypingFocus } from "./releaseTypingFocus";
import { groupTravel } from "./useClipMove";

/**
 * A pointer down on a clip's body: a click selects it, and a move of more
 * than 4px lifts it and drags it to a new place in the sequence. The place
 * is this hook's state until release, which moves the clip once (one undo
 * step). Escape puts it back. A release onto a draft that changed under the
 * drag is dropped (the editor's keys wait while it runs).
 *
 * In Stacked it serves the rows' grips only (a box's body moves its clip in
 * time and across rows, useClipMove): the drag is vertical, the place comes
 * from the lifted box's centre crossing half a row, and the rows scroll by
 * themselves while the pointer is near their top or bottom.
 *
 * A click applies ⌘ (Ctrl off a Mac) and ⇧ to the selection (clickClip). A
 * press on one of several selected clips drags them all. In Track they move
 * as one block, in their order, to the drop point; the block is armed only
 * once the drop point has left where the press found it, so a wobble never
 * gathers clips that were apart. In Stacked (a row's grip) they move rows
 * together, their spacing kept and the group stopped at the first and last
 * rows.
 */

export interface ReorderLive {
  /** The pressed clip. */
  clipId: string;
  /** Every clip the drag carries, the pressed one among them ([clipId] alone for one clip). */
  clipIds: readonly string[];
  index: number;
  /** Pointer travel since the press across the lane's content, px: a scroll during the drag (a wheel, the playback follow) counts, so the clip stays under the pointer. */
  dx: number;
  /** The same down the rows (Stacked; 0 in Track). A group's is clamped once for the whole group (groupTravel). */
  dy: number;
  dropIndex: number;
  /** Track, a group: the drop index at the press. One clip: its own index. */
  liftIndex: number;
  /** The drop index has left liftIndex at least once: only then does a group's release move it, and its bar show. */
  armed: boolean;
}

export interface ReorderOptions {
  /** Rows, not a row: the drag is vertical. */
  stacked?: boolean;
  rowCount?: number;
  /** The visible rows' band on screen (clientY), for the auto-scroll; null while it is not laid out. */
  rowsView?: () => { top: number; bottom: number } | null;
}

/** Stacked: the rows scroll while the pointer is this near their top or bottom, this far each frame. */
const AUTO_SCROLL_EDGE_PX = 20;
const AUTO_SCROLL_STEP_PX = 6;

export function useClipReorder(
  boxes: ReadonlyArray<{ x: number; width: number }>,
  contentRef: RefObject<HTMLDivElement | null>,
  options: ReorderOptions = {},
) {
  const [reorder, setReorder] = useState<ReorderLive | null>(null);
  /** The clip a release just moved, until the lane has drawn it: the lane's reveal of a moved clip leaves it alone. */
  const released = useRef<string | null>(null);
  const latestBoxes = useRef(boxes);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    latestBoxes.current = boxes;
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => {
      if (event.button !== 0) return;
      // A Mac's Ctrl-press is the clip menu's: it keeps the selection
      if (isContextClick(event)) return;
      // A focused In/Out field commits now, before the drag takes its picture of the draft
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      stop.current?.();
      const mods = { toggle: isToggleClick(event), range: event.shiftKey };
      const group = pressGroup(clipId);
      const multi = group.length > 1;
      const groupSet = new Set(group);
      const timelineAtStart = useStitchEditorStore.getState().draft?.timeline;
      const groupIndices = new Set(
        (timelineAtStart ?? []).flatMap((c, i) => (groupSet.has(c.id) ? [i] : [])),
      );
      const minIdx = Math.min(index, ...groupIndices);
      const maxIdx = Math.max(index, ...groupIndices);
      const { stacked = false, rowCount = 0 } = latestOptions.current;
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let current: ReorderLive | null = null;

      const contentRect = () => contentRef.current?.getBoundingClientRect();
      const laneX = (clientX: number) => clientX - (contentRect()?.left ?? 0);
      const laneY = (clientY: number) => clientY - (contentRect()?.top ?? 0);
      const startLaneX = laneX(startX);
      const startLaneY = laneY(startY);
      const liftIndex = multi && !stacked ? blockDropIndexAt(startLaneX, latestBoxes.current, groupIndices) : index;
      let isArmed = false;
      let lastClientX = startX;
      let lastClientY = startY;
      const scroller = contentRef.current?.parentElement ?? null;
      const place = () => {
        const x = laneX(lastClientX);
        const y = laneY(lastClientY);
        const rawDy = stacked ? y - startLaneY : 0;
        let dy = rawDy;
        let dropIndex: number;
        if (!multi) {
          dropIndex = stacked
            ? stackedDropIndex(index, dy, rowCount, GEOMETRY.stackRow)
            : dropIndexAt(x, latestBoxes.current, index);
        } else if (stacked) {
          const row = stackedDropIndex(index, rawDy, rowCount, GEOMETRY.stackRow);
          dropIndex = Math.min(Math.max(row, index - minIdx), index + (rowCount - 1 - maxIdx));
          dy = groupTravel(rawDy, minIdx, maxIdx, rowCount);
        } else {
          dropIndex = blockDropIndexAt(x, latestBoxes.current, groupIndices);
        }
        isArmed ||= dropIndex !== liftIndex;
        current = { clipId, clipIds: group, index, dx: x - startLaneX, dy, dropIndex, liftIndex, armed: isArmed };
        setReorder(current);
      };
      const onScroll = () => {
        if (current) place();
      };

      // Stacked: scroll the rows while the pointer rests near their edge; each scroll re-places the drop
      let speed = 0;
      let frame = 0;
      const step = () => {
        frame = 0;
        if (!current || speed === 0 || !scroller) return;
        scroller.scrollTop += speed;
        frame = requestAnimationFrame(step);
      };
      const autoScroll = (clientY: number) => {
        const view = stacked ? latestOptions.current.rowsView?.() : null;
        speed = !view
          ? 0
          : clientY < view.top + AUTO_SCROLL_EDGE_PX
            ? -AUTO_SCROLL_STEP_PX
            : clientY > view.bottom - AUTO_SCROLL_EDGE_PX
              ? AUTO_SCROLL_STEP_PX
              : 0;
        if (speed !== 0 && !frame) frame = requestAnimationFrame(step);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        scroller?.removeEventListener("scroll", onScroll);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speed = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        stop.current = null;
        setReorder(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        const travel = stacked
          ? Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY))
          : Math.abs(e.clientX - startX);
        if (!current && travel <= DRAG_START_PX) return;
        if (!current) {
          target.setPointerCapture?.(pointerId);
          useStitchEditorStore.getState().setCancelGesture(end);
        }
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        place();
        autoScroll(e.clientY);
      };
      const onUp = () => {
        const moved = current;
        end();
        const s = useStitchEditorStore.getState();
        if (s.draft?.timeline !== timelineAtStart) return;
        if (!moved) {
          clickClip(clipId, mods);
          return;
        }
        if (multi) {
          if (stacked && moved.dropIndex !== index) {
            released.current = clipId;
            moveClipRows(group, moved.dropIndex - index);
          } else if (!stacked && moved.armed) {
            released.current = clipId;
            moveClipsTo(group, moved.dropIndex);
          }
          keepGroupSelected(group, clipId);
          return;
        }
        s.select({ kind: "clip", clipId });
        if (moved.dropIndex !== index) {
          released.current = clipId;
          moveClipTo(clipId, moved.dropIndex);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      stop.current = end;
    },
    [contentRef],
  );

  /** The clip the last release moved, once (see useClipMove's). */
  const takeReleased = useCallback(() => {
    const clipId = released.current;
    released.current = null;
    return clipId;
  }, []);

  return { reorder, onBodyPointerDown, takeReleased };
}
