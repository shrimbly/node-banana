import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { draftSpans } from "@/lib/stitch/draft";
import { moveDragAt, moveRowAt, moveTargets, type MoveDragResult, type MoveDragStart } from "@/lib/stitch/moveDrag";
import { MAX_START_SEC } from "@/lib/stitch/placement";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { placeClip, placeClips } from "@/lib/stitch/timeline";
import type { StitchTimelineClip } from "@/types";
import { moveClipBody, moveClipsBody, pause } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import {
  clearTextSelection,
  clickClip,
  isContextClick,
  isToggleClick,
  keepGroupSelected,
  pressGroup,
} from "../selectionActions";
import { armed, DRAG_START_PX, edgeSpeed } from "./autoScroll";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Stacked's body drag: a press on a clip's box (or an empty clip's slot)
 * moves it in time and across rows in one gesture. A press that never
 * travels 4px only selects the clip, and playback goes on; past that the
 * clip lifts, the preview pauses, and the box follows the pointer on both
 * axes. Its start snaps (⇧ turns that off, also while the pointer rests);
 * it lands in the row under its centre, which changes only past half a row
 * and 4px more. The lanes scroll by themselves while the pointer is near
 * their sides, the rows near their top or bottom, once the pointer has moved
 * toward that edge since the press: a box pressed near an edge and dragged
 * along the other axis scrolls nothing. Until release the move is this
 * hook's state; release applies exactly what was drawn, once (one undo
 * step), and Escape puts the clip and the scroll back. A press whose draft
 * changes before the lift (a key, while the button is down) ends without a
 * drag, and a release onto a draft that changed under the drag is dropped.
 *
 * A click applies ⌘ (Ctrl off a Mac) and ⇧ to the selection (clickClip). A
 * press on one of several selected clips drags them all: by one time and
 * one row delta, their spacing kept, the group stopped as a whole at 0:00,
 * 10:00 and the first and last rows; only the pressed clip snaps.
 *
 * The row grip's drag (rows only) is useClipReorder's.
 */

export interface MoveLive {
  /** The pressed clip. */
  clipId: string;
  /** Every clip the drag carries, the pressed one among them ([clipId] alone for one clip). */
  clipIds: readonly string[];
  /** Its row at the press. */
  index: number;
  /** The row it lands in. */
  dropIndex: number;
  result: MoveDragResult;
  /** What release applies: the press's timeline with the clip at its new start and row, every clip pinned. */
  timeline: StitchTimelineClip[];
  /** The box's left on the press axis, px. */
  x: number;
  /**
   * Pointer travel down the rows since the press, px (a scroll of the rows counts), clamped once for the whole group
   * (groupTravel): the spacing drawn is the spacing release writes, and no box goes past the first or last row.
   */
  dy: number;
}

export interface MoveOptions {
  rowCount: number;
  /** The visible rows' band on screen (clientY), for the auto-scroll; null while it is not laid out. */
  rowsView: () => { top: number; bottom: number } | null;
  /** The lanes' content width as last drawn, px. */
  drawnWidth: () => number;
}

/** The lanes' width a release was drawn at, on the zoom it was drawn at. */
export interface ReleasedWidth {
  width: number;
  pxPerSec: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * A group's travel down the rows, clamped once for all of it: its first box stops where it rests on the first row,
 * its last where it rests on the last row, so a box dragged past the rows is drawn where release puts it. With one
 * clip (minIdx = maxIdx) it is the clamp for a single box.
 */
export function groupTravel(dy: number, minIdx: number, maxIdx: number, rows: number): number {
  return clamp(dy, -minIdx * GEOMETRY.stackRow, (rows - 1 - maxIdx) * GEOMETRY.stackRow);
}

/** axisNow: the lane's axis for the editor's state at the press (useTimelineZoom), after a field's blur. */
export function useClipMove(
  axisNow: () => TimeAxis,
  contentRef: RefObject<HTMLDivElement | null>,
  options: MoveOptions,
) {
  const [move, setMove] = useState<MoveLive | null>(null);
  /** The width the last release that moved a clip was drawn at: the lanes hold it while they are scrolled into it. */
  const [releasedWidth, setReleasedWidth] = useState<ReleasedWidth | null>(null);
  /** The clip a release just moved, until the lane has drawn it: the lane's reveal of a moved clip leaves it alone. */
  const released = useRef<string | null>(null);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  // From the press to the release: the ⌘ wheel waits, so nothing zooms under the press's axis before the lift
  const pressing = useRef(false);
  useEffect(() => {
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const onMovePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => {
      if (event.button !== 0) return;
      // A Mac's Ctrl-press is the clip menu's: it keeps the selection
      if (isContextClick(event)) return;
      // A focused field commits now, before the drag takes its picture of the draft
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      stop.current?.();
      const mods = { toggle: isToggleClick(event), range: event.shiftKey };
      const group = pressGroup(clipId);
      const groupSet = new Set(group);
      const editor = useStitchEditorStore.getState();
      const draftAtStart = editor.draft;
      if (!draftAtStart) return;
      const durationsAtStart = editor.durations;
      const spansAtStart = draftSpans(draftAtStart, durationsAtStart);
      const span = spansAtStart.find((s) => s.clip.id === clipId);
      if (!span) return;
      const overlapSec = draftAtStart.sequenceLayout.overlapSec;
      const axis = axisNow();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const scroller = contentRef.current?.parentElement ?? null;
      const scrollAtStart = { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };

      const contentRect = () => contentRef.current?.getBoundingClientRect();
      const laneX = (clientX: number) => clientX - (contentRect()?.left ?? 0);
      const laneY = (clientY: number) => clientY - (contentRect()?.top ?? 0);
      const startLaneX = laneX(startX);
      const startLaneY = laneY(startY);
      let lastClientX = startX;
      let lastClientY = startY;
      let lastShift = event.shiftKey;
      let start: MoveDragStart | null = null;
      let current: MoveLive | null = null;
      // Where the last place() measured the pointer in the lanes: a scroll event after the auto-scroll's own re-place
      // finds nothing new
      let placedAt = "";
      pressing.current = true;
      // A group's rows at the press, and the row delta that keeps all of them in range
      const groupRows = draftAtStart.timeline.flatMap((c, i) => (groupSet.has(c.id) ? [i] : []));
      const minIdx = groupRows[0] ?? index;
      const maxIdx = groupRows[groupRows.length - 1] ?? index;

      const place = () => {
        if (!start) return;
        const x = laneX(lastClientX);
        const dy = laneY(lastClientY) - startLaneY;
        const snap = useStitchEditorStore.getState().snap && !lastShift;
        const at = `${x}|${dy}|${snap}`;
        if (current && at === placedAt) return;
        placedAt = at;
        const result = moveDragAt(start, x, { snap });
        const { rowCount } = latestOptions.current;
        const rowAt = moveRowAt(index, dy, current?.dropIndex ?? index, rowCount, GEOMETRY.stackRow);
        const multi = group.length > 1;
        const dropIndex = multi ? clamp(rowAt, index - minIdx, index + (rowCount - 1 - maxIdx)) : rowAt;
        // The same place gives the same timeline: the lane's marks are not built again for a pointer that moved within it
        const timeline =
          current && current.result.startSec === result.startSec && current.dropIndex === dropIndex
            ? current.timeline
            : multi
              ? placeClips(draftAtStart.timeline, durationsAtStart, groupSet, result.deltaSec, dropIndex - index, overlapSec)
              : placeClip(draftAtStart.timeline, durationsAtStart, clipId, result.startSec, dropIndex, overlapSec);
        const drawnDy = groupTravel(dy, minIdx, maxIdx, rowCount);
        current = { clipId, clipIds: group, index, dropIndex, result, timeline, x: axis.timeToX(result.startSec), dy: drawnDy };
        setMove(current);
      };
      const onScroll = () => place();

      // Near a side of the lanes, or the top or bottom of the rows, they scroll; each scroll re-places the clip
      let speedX = 0;
      let speedY = 0;
      let frame = 0;
      // The box is re-placed and drawn in the frame that scrolled, so it never trails the pointer by a frame and the
      // release applies what is on screen
      const step = () => {
        frame = 0;
        if (!current || !scroller || (speedX === 0 && speedY === 0)) return;
        if (speedX !== 0) scroller.scrollLeft += speedX;
        if (speedY !== 0) scroller.scrollTop += speedY;
        flushSync(place);
        frame = requestAnimationFrame(step);
      };
      // An edge the press was already near scrolls only once the pointer heads for it: a sideways drag of a box in a
      // half-shown bottom row keeps its row, and an upward drag of a box pressed by the lanes' right side keeps its time
      const autoScroll = (clientX: number, clientY: number) => {
        const lanes = scroller?.getBoundingClientRect();
        const rows = latestOptions.current.rowsView();
        speedX = lanes && lanes.right > lanes.left ? armed(edgeSpeed(clientX, lanes.left, lanes.right), clientX - startX) : 0;
        speedY = rows ? armed(edgeSpeed(clientY, rows.top, rows.bottom), clientY - startY) : 0;
        if ((speedX !== 0 || speedY !== 0) && !frame) frame = requestAnimationFrame(step);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("keydown", onShift);
        window.removeEventListener("keyup", onShift);
        scroller?.removeEventListener("scroll", onScroll);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speedX = 0;
        speedY = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setMove(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === cancel) s.setCancelGesture(null);
      };
      // Escape: the clip stays where it was, and the lanes go back to where the press found them
      const cancel = () => {
        if (scroller) {
          scroller.scrollLeft = scrollAtStart.left;
          scroller.scrollTop = scrollAtStart.top;
        }
        end();
      };
      const lift = () => {
        target.setPointerCapture?.(pointerId);
        useStitchEditorStore.getState().setCancelGesture(cancel);
        // The playhead stops before it is taken as a target, so the target is where it is drawn
        pause();
        const s = useStitchEditorStore.getState();
        const playhead = Math.min(s.playhead, axis.total);
        if (group.length > 1) {
          // The others move with the pressed clip: they are no targets, and its start keeps the group inside 0–10:00
          const groupStarts = spansAtStart.filter((other) => groupSet.has(other.clip.id)).map((other) => other.start);
          start = {
            clipId,
            startSec: span.start,
            lengthSec: span.length,
            pointerX: startLaneX,
            pxPerSec: axis.pxPerSec,
            targets: moveTargets(spansAtStart, clipId, playhead, overlapSec, groupSet),
            minStartSec: span.start - Math.min(...groupStarts),
            maxStartSec: MAX_START_SEC - (Math.max(...groupStarts) - span.start),
          };
        } else {
          start = {
            clipId,
            startSec: span.start,
            lengthSec: span.length,
            pointerX: startLaneX,
            pxPerSec: axis.pxPerSec,
            targets: moveTargets(spansAtStart, clipId, playhead, overlapSec),
          };
        }
        scroller?.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("keydown", onShift);
        window.addEventListener("keyup", onShift);
      };
      const onMove = (e: PointerEvent) => {
        if (!start) {
          const travel = Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY));
          if (travel <= DRAG_START_PX) return;
          // A key changed the draft while the button was down (or removed the pressed clip): the press's picture of it
          // is stale, so there is nothing to drag
          if (useStitchEditorStore.getState().draft?.timeline !== draftAtStart.timeline || !target.isConnected) {
            end();
            return;
          }
          lift();
        }
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        lastShift = e.shiftKey;
        place();
        autoScroll(e.clientX, e.clientY);
      };
      // ⇧ pressed or let go while the pointer rests: snapping turns off or on where the clip is
      const onShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.shiftKey === lastShift) return;
        lastShift = e.shiftKey;
        place();
      };
      const onUp = () => {
        const moved = current;
        const width = latestOptions.current.drawnWidth();
        end();
        const s = useStitchEditorStore.getState();
        if (s.draft?.timeline !== draftAtStart.timeline) return;
        if (!moved) {
          clickClip(clipId, mods);
          return;
        }
        if (group.length > 1) {
          if (moved.timeline !== draftAtStart.timeline) {
            released.current = clipId;
            setReleasedWidth({ width, pxPerSec: axis.pxPerSec });
            moveClipsBody(group, moved.timeline);
          }
          keepGroupSelected(group, clipId);
          return;
        }
        s.select({ kind: "clip", clipId });
        if (moved.timeline !== draftAtStart.timeline) {
          released.current = clipId;
          setReleasedWidth({ width, pxPerSec: axis.pxPerSec });
          moveClipBody(clipId, moved.timeline);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      stop.current = end;
    },
    [axisNow, contentRef],
  );

  /** The clip the last release moved, once: the lane's reveal asks, and leaves that move where it was drawn. */
  const takeReleased = useCallback(() => {
    const clipId = released.current;
    released.current = null;
    return clipId;
  }, []);

  return { move, onMovePointerDown, pressing, takeReleased, releasedWidth };
}
