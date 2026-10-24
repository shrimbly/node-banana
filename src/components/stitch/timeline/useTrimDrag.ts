import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { trimDragAt, trimTargets, type TrimDragResult, type TrimDragStart } from "@/lib/stitch/trimDrag";
import { draftSpans } from "@/lib/stitch/draft";
import { sourceKey, trimClip, trimClipInPlace, type ClipSpan } from "@/lib/stitch/timeline";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { StitchTimelineClip } from "@/types";
import { pause } from "../editorActions";
import { clearTextSelection, clickClip, isContextClick, isToggleClick } from "../selectionActions";
import { DRAG_START_PX } from "./autoScroll";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Dragging a clip's In or Out handle. While the pointer moves, the trim is
 * this hook's state only; on release it is applied to the draft once, so a
 * drag is one undo step and nothing reaches the workflow store. A press
 * that never moves changes nothing. Shift turns snapping off for the move it
 * is held on; Escape cancels. The editor's other keys and the ⌘ wheel zoom
 * wait while it runs (useStitchEditorKeys, Timeline), and a release onto a
 * draft that changed under the drag anyway is dropped.
 *
 * In Stacked a trim keeps the frames where they are in time: an In edge
 * moves the clip's start with it (never before 0:00), and no other clip
 * moves. The drag carries the timeline release applies, every clip pinned,
 * and Shift pressed or let go while the pointer rests re-places the edge.
 *
 * A press with ⌘ (Ctrl off a Mac) or ⇧ is first a click on the clip: a
 * handle lies under most ⌘- and ⇧-clicks near a clip's edge. Released
 * within 4px it changes the selection (clickClip) and trims nothing; past
 * that it trims from then on, measured from the press, as a plain press
 * does from the start.
 */

export interface TrimLive {
  clipId: string;
  edge: "in" | "out";
  start: TrimDragStart;
  result: TrimDragResult;
  /** The lane content's top-left on screen, and the visible lanes' sides, for the frame popover outside the lane. */
  laneLeft: number;
  laneTop: number;
  viewLeft: number;
  viewRight: number;
  /** Stacked: what release applies, the trim with its frames fixed in time; null in Track. */
  timeline: StitchTimelineClip[] | null;
}

/** axisNow: the lane's axis for the editor's state at the press (useTimelineZoom), after the field's blur. */
export function useTrimDrag(axisNow: () => TimeAxis, contentRef: RefObject<HTMLDivElement | null>) {
  const [trim, setTrim] = useState<TrimLive | null>(null);
  const live = useRef<TrimLive | null>(null);
  /** The clip a release just trimmed, until the lane has drawn it: the lane's reveal of a moved clip leaves it alone. */
  const released = useRef<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, pressed: ClipSpan, edge: "in" | "out") => {
      if (event.button !== 0 || !contentRef.current) return;
      // A Mac's Ctrl-press is the clip menu's: no trim starts under it
      if (isContextClick(event)) return;
      // A focused In/Out field commits (or reverts) now, so the editor's Escape reaches this drag
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      event.preventDefault();
      event.stopPropagation();
      stop.current?.();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;

      /** Starts the trim, from the press or from the moment a modified press travelled; returns its move handler. */
      const beginTrim = (shiftAtStart: boolean): ((e: PointerEvent) => void) | null => {
        // The draft as it is now (the field's blur may just have changed it), not as the last render saw it
        const editor = useStitchEditorStore.getState();
        const draftAtStart = editor.draft;
        if (!draftAtStart || !contentRef.current) return null;
        const timelineAtStart = draftAtStart.timeline;
        const durationsAtStart = editor.durations;
        const spans = draftSpans(draftAtStart, durationsAtStart);
        const span = spans.find((s) => s.clip.id === pressed.clip.id);
        if (!span) return null;
        // In Fit, a length the blur changed changes the zoom the lane re-renders at: measure with that one
        const axis = axisNow();
        handle.setPointerCapture?.(pointerId);
        // The playhead holds still for the drag: it is one of the targets
        pause();
        editor.select({ kind: "clip", clipId: span.clip.id });

        const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
        const stacked = draftAtStart.sequenceLayout.mode === "stacked";
        const start: TrimDragStart = {
          span,
          edge,
          sourceDuration: editor.durations.get(sourceKey(span.clip.source)),
          pointerX: laneX(startClientX),
          pxPerSec: axis.pxPerSec,
          xToTime: axis.xToTime,
          // The playhead as drawn: one left past a sequence that got shorter sits at its end
          targets: trimTargets(spans, span.clip.id, edge, Math.min(editor.playhead, axis.total), stacked ? "stacked" : "track"),
          // Stacked: an In that lengthens the head moves the start earlier, and it stops at 0:00
          minInSec: stacked ? span.clip.inSec - span.start : undefined,
        };
        const overlapSec = draftAtStart.sequenceLayout.overlapSec;
        let moved = false;
        let lastClientX = startClientX;
        let lastShift = shiftAtStart;
        const update = (clientX: number, shiftKey: boolean) => {
          const content = contentRef.current;
          const rect = content?.getBoundingClientRect();
          const visible = content?.parentElement?.getBoundingClientRect();
          // Until the pointer moves, the edge stays where it is (no snap on the press)
          const snap = moved && useStitchEditorStore.getState().snap && !shiftKey;
          const result = trimDragAt(start, moved ? laneX(clientX) : start.pointerX, { snap });
          const patch = edge === "out" ? { outSec: result.outSec } : { inSec: result.inSec };
          const next: TrimLive = {
            clipId: span.clip.id,
            edge,
            start,
            result,
            laneLeft: rect?.left ?? 0,
            laneTop: rect?.top ?? 0,
            viewLeft: visible?.left ?? 0,
            viewRight: visible?.right ?? 0,
            timeline: stacked
              ? trimClipInPlace(timelineAtStart, span.clip.id, durationsAtStart, patch, overlapSec)
              : null,
          };
          live.current = next;
          setTrim(next);
        };

        const end = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", end);
          window.removeEventListener("keydown", onShift);
          window.removeEventListener("keyup", onShift);
          if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
          live.current = null;
          stop.current = null;
          setTrim(null);
          const s = useStitchEditorStore.getState();
          if (s.cancelGesture === end) s.setCancelGesture(null);
        };
        const onMove = (e: PointerEvent) => {
          if (!moved && Math.abs(e.clientX - startClientX) < 1) return;
          moved = true;
          lastClientX = e.clientX;
          lastShift = e.shiftKey;
          update(e.clientX, e.shiftKey);
        };
        // ⇧ pressed or let go while the pointer rests: the edge snaps or lets go where it is
        const onShift = (e: KeyboardEvent) => {
          if (e.key !== "Shift" || e.shiftKey === lastShift) return;
          lastShift = e.shiftKey;
          if (moved) update(lastClientX, lastShift);
        };
        const onUp = (e: PointerEvent) => {
          onMove(e);
          const drawn = live.current;
          end();
          if (!moved || !drawn) return;
          const s = useStitchEditorStore.getState();
          if (s.draft?.timeline !== timelineAtStart) return;
          const { timeline, result } = drawn;
          if (timeline) {
            if (timeline === timelineAtStart) return;
            released.current = span.clip.id;
            s.apply((d) => ({ ...d, timeline }));
            return;
          }
          released.current = span.clip.id;
          const patch = edge === "out" ? { outSec: result.outSec } : { inSec: result.inSec };
          s.apply((d) => ({ ...d, timeline: trimClip(d.timeline, span.clip.id, s.durations, patch) }));
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", end);
        if (stacked) {
          window.addEventListener("keydown", onShift);
          window.addEventListener("keyup", onShift);
        }
        stop.current = end;
        useStitchEditorStore.getState().setCancelGesture(end);
        update(startClientX, shiftAtStart);
        return onMove;
      };

      if (isToggleClick(event) || event.shiftKey) {
        const mods = { toggle: isToggleClick(event), range: event.shiftKey };
        const timelineAtPress = useStitchEditorStore.getState().draft?.timeline;
        const endWait = () => {
          window.removeEventListener("pointermove", onWaitMove);
          window.removeEventListener("pointerup", onWaitUp);
          window.removeEventListener("pointercancel", endWait);
          stop.current = null;
          const s = useStitchEditorStore.getState();
          if (s.cancelGesture === endWait) s.setCancelGesture(null);
        };
        const onWaitMove = (e: PointerEvent) => {
          if (Math.max(Math.abs(e.clientX - startClientX), Math.abs(e.clientY - startClientY)) <= DRAG_START_PX) return;
          endWait();
          if (useStitchEditorStore.getState().draft?.timeline !== timelineAtPress || !handle.isConnected) return;
          beginTrim(e.shiftKey)?.(e);
        };
        const onWaitUp = () => {
          endWait();
          if (useStitchEditorStore.getState().draft?.timeline !== timelineAtPress) return;
          clickClip(pressed.clip.id, mods);
        };
        window.addEventListener("pointermove", onWaitMove);
        window.addEventListener("pointerup", onWaitUp);
        window.addEventListener("pointercancel", endWait);
        stop.current = endWait;
        // The editor's keys and the ⌘ wheel wait from the press, as for any handle press
        useStitchEditorStore.getState().setCancelGesture(endWait);
        return;
      }
      beginTrim(event.shiftKey);
    },
    [axisNow, contentRef],
  );

  /** The clip the last release trimmed, once (see useClipMove's). */
  const takeReleased = useCallback(() => {
    const clipId = released.current;
    released.current = null;
    return clipId;
  }, []);

  return { trim, onHandlePointerDown, takeReleased };
}
