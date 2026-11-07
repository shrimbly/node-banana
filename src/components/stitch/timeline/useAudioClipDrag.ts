import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  audioClipLength,
  audioSourceKey,
  audioSpans,
  MIN_AUDIO_CLIP_SEC,
  moveAudioClips,
  type AudioSpan,
} from "@/lib/stitch/audioClips";
import {
  audioMoveAt,
  audioMoveTargets,
  audioRowAt,
  audioTrimAt,
  type AudioMoveResult,
  type AudioMoveTarget,
} from "@/lib/stitch/audioDrag";
import type { AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { MAX_START_SEC } from "@/lib/stitch/placement";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { ClipSpan } from "@/lib/stitch/timeline";
import type { StitchAudioClip } from "@/types";
import { editorAudioLengthOf, moveAudioClipsBody, pause, trimAudioClipBody } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import {
  clearTextSelection,
  clickAudioClip,
  isContextClick,
  isToggleClick,
  keepAudioGroupSelected,
  pressAudioGroup,
} from "../selectionActions";
import { armed, DRAG_START_PX, edgeSpeed } from "./autoScroll";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Dragging audio boxes. A press on a box's body that never travels 4px
 * selects on release (⌘ and ⇧ as on a video clip, clickAudioClip), and
 * playback goes on. Past that the preview pauses and the box (with the rest
 * of the selection, when it is one of several) follows the pointer: in time
 * by the lead's snapped delta (audioMoveAt), across rows by the row under
 * its centre (audioRowAt), on the layout of the press, since no row changes
 * height or number until release. What release applies (moveAudioClips over
 * the clips at the press) is drawn as the landing: the rows it lands on, the
 * line where an overlap inserts a row, or the "New row" strip. A press on an
 * In or Out handle trims that clip alone, its sound kept in place. Release
 * applies once (one undo step); a release onto audio that changed under the
 * drag is dropped; Escape puts the clips and both scrolls back. The lanes
 * scroll sideways near their sides, and the audio rows near the top or
 * bottom of their view, once the pointer heads that way.
 */

/** Where release puts a move, as drawn. */
export type AudioLanding =
  | { kind: "none" }
  /** Onto existing rows (press rows, as numbered at the press). */
  | { kind: "rows"; rows: ReadonlySet<number> }
  /** Onto new rows inserted under this row (an overlap on the target row). */
  | { kind: "insert"; after: number }
  /** Onto a new row appended through the strip. */
  | { kind: "append" };

export interface AudioMoveLive {
  kind: "move";
  /** The pressed clip, which snaps. */
  clipId: string;
  clipIds: readonly string[];
  result: AudioMoveResult;
  /** Pointer travel down the screen since the press, px: the moving boxes follow it. */
  dy: number;
  landing: AudioLanding;
  /** The audio at the press and what release applies. */
  from: StitchAudioClip[];
  next: ReturnType<typeof moveAudioClips>;
  /** The audio scroll at the press. */
  scrollAtPress: number;
}

export interface AudioTrimLive {
  kind: "trim";
  clipId: string;
  edge: "in" | "out";
  /** The clip as release leaves it. */
  clip: StitchAudioClip;
  snapped: AudioMoveTarget | null;
}

export type AudioDragLive = AudioMoveLive | AudioTrimLive;

export interface AudioDragOptions {
  /** The audio section's layout (the press's is kept for the drag). */
  layout: () => AudioSectionLayout;
  scroll: () => number;
  setScroll: (scroll: number) => void;
  /** The audio rows' view on screen, for the up-and-down auto-scroll. */
  viewRect: () => DOMRect | null;
  videoSpans: () => readonly ClipSpan[];
  /** A clip's name in a snap chip: its file name. */
  nameOf: (clipId: string) => string;
}

/** The block's top and height in its row. */
export const audioBlockHeight = (expanded: boolean) => (expanded ? GEOMETRY.audioBlockExpanded : GEOMETRY.audioBlock);

function landingOf(
  from: readonly StitchAudioClip[],
  next: ReturnType<typeof moveAudioClips>,
  ids: ReadonlySet<string>,
): AudioLanding {
  if (next.clips === from) return { kind: "none" };
  if (next.insertedAfter !== null) return { kind: "insert", after: next.insertedAfter };
  const rows = new Set(next.clips.filter((c) => ids.has(c.id)).map((c) => c.row));
  const rowCount = from.reduce((n, c) => Math.max(n, c.row + 1), 0);
  if ([...rows].some((row) => row >= rowCount)) return { kind: "append" };
  return { kind: "rows", rows };
}

/** axisNow: the lane's axis for the editor's state at the press (useTimelineZoom). */
export function useAudioClipDrag(
  axisNow: () => TimeAxis,
  contentRef: RefObject<HTMLDivElement | null>,
  options: AudioDragOptions,
) {
  const [drag, setDrag] = useState<AudioDragLive | null>(null);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  // From the press to the release: the ⌘ wheel waits
  const pressing = useRef(false);
  useEffect(() => {
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  /** Pointer and key listeners for one gesture; returns its end. */
  const listen = useCallback(
    (handlers: {
      onMove: (e: PointerEvent) => void;
      onUp: (e: PointerEvent) => void;
      onShift?: (e: KeyboardEvent) => void;
      onScroll?: () => void;
      end: () => void;
    }) => {
      const scroller = contentRef.current?.parentElement ?? null;
      window.addEventListener("pointermove", handlers.onMove);
      window.addEventListener("pointerup", handlers.onUp);
      window.addEventListener("pointercancel", handlers.end);
      if (handlers.onShift) {
        window.addEventListener("keydown", handlers.onShift);
        window.addEventListener("keyup", handlers.onShift);
      }
      if (handlers.onScroll) scroller?.addEventListener("scroll", handlers.onScroll, { passive: true });
      return () => {
        window.removeEventListener("pointermove", handlers.onMove);
        window.removeEventListener("pointerup", handlers.onUp);
        window.removeEventListener("pointercancel", handlers.end);
        if (handlers.onShift) {
          window.removeEventListener("keydown", handlers.onShift);
          window.removeEventListener("keyup", handlers.onShift);
        }
        if (handlers.onScroll) scroller?.removeEventListener("scroll", handlers.onScroll);
      };
    },
    [contentRef],
  );

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string) => {
      if (event.button !== 0 || isContextClick(event)) return;
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      stop.current?.();
      const mods = { toggle: isToggleClick(event), range: event.shiftKey };
      const editor = useStitchEditorStore.getState();
      const from = editor.draft?.audioClips;
      if (!from) return;
      const lead = from.find((c) => c.id === clipId);
      if (!lead) return;
      const group = pressAudioGroup(clipId);
      const groupSet = new Set(group);
      const lengthOf = editorAudioLengthOf(editor);
      const spans = audioSpans(from, editor.audioDurations);
      const axis = axisNow();
      const layout = latestOptions.current.layout();
      const scrollAtPress = latestOptions.current.scroll();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const scroller = contentRef.current?.parentElement ?? null;
      const scrollLeftAtPress = scroller?.scrollLeft ?? 0;
      const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
      const startLaneX = laneX(startX);
      // The lead's block centre in the rows' content at the press
      const leadExpanded = layout.rowHeights[lead.row] === GEOMETRY.audioRowExpanded;
      const centreAtPress = (layout.rowTops[lead.row] ?? 0) + GEOMETRY.audioBlockTop + audioBlockHeight(leadExpanded) / 2;
      const groupStarts = from.filter((c) => groupSet.has(c.id)).map((c) => c.startSec);
      const leadLength = lengthOf(lead);
      const leadSpan = {
        start: lead.startSec,
        length: Number.isFinite(leadLength) ? leadLength : 0,
        min: lead.startSec - Math.min(...groupStarts),
        max: MAX_START_SEC - (Math.max(...groupStarts) - lead.startSec),
      };
      pressing.current = true;
      let targets: AudioMoveTarget[] = [];
      let lifted = false;
      let lastClientX = startX;
      let lastClientY = startY;
      let lastShift = event.shiftKey;
      let row = lead.row;
      let current: AudioMoveLive | null = null;

      const place = () => {
        if (!lifted) return;
        const snap = useStitchEditorStore.getState().snap && !lastShift;
        const result = audioMoveAt(axis, leadSpan, laneX(lastClientX) - startLaneX, targets, { snap });
        const scrollNow = latestOptions.current.scroll();
        const centre = centreAtPress + (lastClientY - startY) + (scrollNow - scrollAtPress);
        row = audioRowAt(centre, row, layout.rowTops, layout.rowHeights, scrollNow + layout.viewHeight);
        const next = moveAudioClips(from, lengthOf, group, result.deltaSec, row - lead.row);
        current = {
          kind: "move",
          clipId,
          clipIds: group,
          result,
          dy: lastClientY - startY,
          landing: landingOf(from, next, groupSet),
          from,
          next,
          scrollAtPress,
        };
        setDrag(current);
      };

      // Sideways near the lanes' sides, up and down near the rows view's top or bottom
      let speedX = 0;
      let speedY = 0;
      let frame = 0;
      const step = () => {
        frame = 0;
        if (!current || (speedX === 0 && speedY === 0)) return;
        if (speedX !== 0 && scroller) scroller.scrollLeft += speedX;
        if (speedY !== 0) {
          const { scroll, setScroll } = latestOptions.current;
          const next = Math.min(Math.max(scroll() + speedY, 0), layout.maxScroll);
          if (next !== scroll()) flushSync(() => setScroll(next));
        }
        flushSync(place);
        frame = requestAnimationFrame(step);
      };
      const autoScroll = (clientX: number, clientY: number) => {
        const lanes = scroller?.getBoundingClientRect();
        const view = latestOptions.current.viewRect();
        speedX = lanes && lanes.right > lanes.left ? armed(edgeSpeed(clientX, lanes.left, lanes.right), clientX - startX) : 0;
        speedY = view && layout.maxScroll > 0 ? armed(edgeSpeed(clientY, view.top, view.bottom), clientY - startY) : 0;
        if ((speedX !== 0 || speedY !== 0) && !frame) frame = requestAnimationFrame(step);
      };

      let unlisten = () => {};
      const end = () => {
        unlisten();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speedX = 0;
        speedY = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setDrag(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === cancel) s.setCancelGesture(null);
      };
      // Escape: the clips stay where they were, and both scrolls go back to where the press found them
      const cancel = () => {
        if (scroller) scroller.scrollLeft = scrollLeftAtPress;
        latestOptions.current.setScroll(scrollAtPress);
        end();
      };
      const lift = () => {
        lifted = true;
        target.setPointerCapture?.(pointerId);
        useStitchEditorStore.getState().setCancelGesture(cancel);
        // The playhead stops before it is taken as a target, so the target is where it is drawn
        pause();
        const s = useStitchEditorStore.getState();
        const { videoSpans, nameOf } = latestOptions.current;
        targets = audioMoveTargets(spans, videoSpans(), groupSet, Math.min(s.playhead, axis.total), axis.total, (span) =>
          nameOf(span.clip.id),
        );
      };
      const onMove = (e: PointerEvent) => {
        if (!lifted) {
          if (Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY)) <= DRAG_START_PX) return;
          // A key changed the audio while the button was down: the press's picture of it is stale
          if (useStitchEditorStore.getState().draft?.audioClips !== from || !target.isConnected) {
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
      const onShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.shiftKey === lastShift) return;
        lastShift = e.shiftKey;
        place();
      };
      const onUp = () => {
        const moved = current;
        const wasLifted = lifted;
        end();
        if (useStitchEditorStore.getState().draft?.audioClips !== from) return;
        if (!wasLifted) {
          clickAudioClip(clipId, mods);
          return;
        }
        if (moved) moveAudioClipsBody(from, moved.next);
        keepAudioGroupSelected(group, clipId);
      };

      unlisten = listen({ onMove, onUp, onShift, onScroll: place, end });
      stop.current = end;
    },
    [axisNow, contentRef, listen],
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, edge: "in" | "out") => {
      if (event.button !== 0 || isContextClick(event)) return;
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      event.preventDefault();
      event.stopPropagation();
      stop.current?.();
      const editor = useStitchEditorStore.getState();
      const from = editor.draft?.audioClips;
      const clip = from?.find((c) => c.id === clipId);
      const duration = clip ? editor.audioDurations.get(audioSourceKey(clip.source)) : undefined;
      if (!from || !clip || duration === undefined) return;
      const spans = audioSpans(from, editor.audioDurations);
      const span = spans.find((s) => s.clip.id === clipId) as AudioSpan;
      const axis = axisNow();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
      const startLaneX = laneX(startX);
      handle.setPointerCapture?.(pointerId);
      pause();
      editor.select(audioSelectionOf({ clipId }));
      pressing.current = true;

      // trimAudioClip's own limits: 0:00 and the clip before it (In), the file's end and the clip after it (Out)
      const onRow = from.filter((c) => c.row === clip.row && c.id !== clip.id);
      const previous = onRow.filter((c) => c.startSec <= clip.startSec).pop();
      const next = onRow.find((c) => c.startSec > clip.startSec);
      const lengthIn = (c: StitchAudioClip) => audioClipLength(c, editor.audioDurations.get(audioSourceKey(c.source)));
      const previousEnd = previous ? previous.startSec + lengthIn(previous) : 0;
      const effOut = Math.min(clip.outSec ?? duration, duration);
      const bounds =
        edge === "in"
          ? { min: Math.max(0, clip.inSec - (clip.startSec - previousEnd)), max: effOut - MIN_AUDIO_CLIP_SEC }
          : {
              min: clip.inSec + MIN_AUDIO_CLIP_SEC,
              max: Math.min(duration, next ? clip.inSec + (next.startSec - clip.startSec) : Infinity),
            };
      const { videoSpans, nameOf } = latestOptions.current;
      const targets = audioMoveTargets(
        spans,
        videoSpans(),
        new Set([clipId]),
        Math.min(editor.playhead, axis.total),
        axis.total,
        (s) => nameOf(s.clip.id),
      );
      let moved = false;
      let lastClientX = startX;
      let lastShift = event.shiftKey;
      let current: AudioTrimLive | null = null;

      const place = () => {
        const snap = moved && useStitchEditorStore.getState().snap && !lastShift;
        const result = audioTrimAt(axis, span, edge, moved ? laneX(lastClientX) - startLaneX : 0, bounds, targets, { snap });
        const live: StitchAudioClip =
          edge === "in" && result.inSec !== undefined
            ? { ...clip, inSec: result.inSec, startSec: clip.startSec + (result.inSec - clip.inSec) }
            : { ...clip, outSec: result.outSec ?? clip.outSec };
        current = { kind: "trim", clipId, edge, clip: live, snapped: result.snapped };
        setDrag(current);
      };

      let unlisten = () => {};
      const end = () => {
        unlisten();
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setDrag(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        if (!moved && Math.abs(e.clientX - startX) <= DRAG_START_PX) return;
        moved = true;
        lastClientX = e.clientX;
        lastShift = e.shiftKey;
        place();
      };
      const onShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.shiftKey === lastShift) return;
        lastShift = e.shiftKey;
        if (moved) place();
      };
      const onUp = () => {
        const live = current;
        end();
        if (!moved || !live) return;
        trimAudioClipBody(from, clipId, edge === "in" ? { inSec: live.clip.inSec } : { outSec: live.clip.outSec });
      };

      unlisten = listen({ onMove, onUp, onShift, onScroll: () => moved && place(), end });
      stop.current = end;
      useStitchEditorStore.getState().setCancelGesture(end);
      place();
    },
    [axisNow, contentRef, listen],
  );

  return { drag, onBodyPointerDown, onHandlePointerDown, pressing };
}
