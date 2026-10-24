import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { boxHits, clipIdsOf, type HitBox, type LaneRect, type SelectionIds } from "@/lib/stitch/selection";
import {
  applyBoxSelection,
  clearClipSelection,
  clearTextSelection,
  isContextClick,
  isToggleClick,
} from "../selectionActions";
import { armed, DRAG_START_PX, edgeSpeed } from "./autoScroll";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * The selection box: a press on empty lane space (the listbox itself, not a
 * clip in it) that travels more than 4px draws a rectangle, and the clips it
 * touches are drawn selected (in Track every clip it crosses sideways, in
 * Stacked every box it touches on both axes). ⇧ or ⌘ (Ctrl off a Mac) at the
 * press adds them to the selection. Release writes the selection once;
 * Escape drops the rectangle and puts the scroll back. A press that does not
 * travel clears the selection, unless a modifier was held. The audio rows
 * use the same gesture with their own kind, commit and clear. The lanes
 * scroll by themselves near their edges, as for a body drag, and the
 * rectangle takes in rows scrolled out of view under it.
 */

export interface MarqueeLive {
  /** The rectangle in lane content px, clamped to the rows (Track: the whole clips row). */
  rect: LaneRect;
  /** The rectangle as drawn: clipped to the visible rows, so it never paints over the sticky ruler or audio row. */
  drawn: LaneRect;
  /** The clips the rectangle touches. */
  hitIds: ReadonlySet<string>;
  /** What is drawn selected: the hits, with the selection at the press when the box adds. */
  selectedIds: ReadonlySet<string>;
}

export interface MarqueeOptions {
  stacked: boolean;
  /** Each clip's box as drawn, by timeline index, in lane content px. */
  hitBoxes: () => HitBox[];
  /** The timeline's clip ids. */
  order: () => string[];
  /** The visible rows' band on screen (clientY); null in Track, where the rows do not scroll. */
  rowsView: () => { top: number; bottom: number } | null;
  /** The y range the rectangle is clamped to, lane content px. */
  bounds: () => { top: number; bottom: number };
  /** The kind of clip the box selects; an additive box adds to a selection of that kind only. Default "clip". */
  kind?: "clip" | "audio";
  /** The release with the clips touched, in order. Default: applyBoxSelection over the selection at the press. */
  commit?: (hitIds: string[], additive: boolean) => void;
  /** A press that did not travel, without a modifier. Default: clearClipSelection. */
  clear?: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function useMarqueeSelect(contentRef: RefObject<HTMLDivElement | null>, options: MarqueeOptions) {
  const [marquee, setMarquee] = useState<MarqueeLive | null>(null);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  // From the press to the release: the ⌘ wheel waits, so nothing zooms under the press before the lift
  const pressing = useRef(false);
  useEffect(() => {
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const onLanePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // A Mac's Ctrl-press opens no box and clears nothing; a press on a clip or a slot is theirs
      if (event.button !== 0 || isContextClick(event) || event.target !== event.currentTarget) return;
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      stop.current?.();
      pressing.current = true;
      const additive = event.shiftKey || isToggleClick(event);
      const selection = useStitchEditorStore.getState().selection;
      const kind = latestOptions.current.kind ?? "clip";
      const base: SelectionIds | null = selection?.kind === kind ? selection : null;
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const scroller = contentRef.current?.parentElement ?? null;
      const scrollAtStart = { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };
      const contentRect = () => contentRef.current?.getBoundingClientRect();
      const startLaneX = startX - (contentRect()?.left ?? 0);
      const startLaneY = startY - (contentRect()?.top ?? 0);
      let lastClientX = startX;
      let lastClientY = startY;
      let lifted = false;
      let current: MarqueeLive | null = null;

      const place = () => {
        const content = contentRect();
        const x = lastClientX - (content?.left ?? 0);
        const y = lastClientY - (content?.top ?? 0);
        const { stacked, hitBoxes, order, rowsView, bounds } = latestOptions.current;
        const { top, bottom } = bounds();
        // Track selects by x alone, so its rectangle covers the whole clips row whatever the pointer's y
        const rect = {
          left: Math.min(startLaneX, x),
          right: Math.max(startLaneX, x),
          top: stacked ? clamp(Math.min(startLaneY, y), top, bottom) : top,
          bottom: stacked ? clamp(Math.max(startLaneY, y), top, bottom) : bottom,
        };
        const ids = order();
        const hitIds = new Set(boxHits(hitBoxes(), rect, stacked ? "xy" : "x").map((i) => ids[i]));
        const selectedIds = additive ? new Set([...clipIdsOf(base, ids), ...hitIds]) : hitIds;
        const rows = rowsView();
        const viewTop = rows ? rows.top - (content?.top ?? 0) : top;
        const viewBottom = rows ? rows.bottom - (content?.top ?? 0) : bottom;
        const drawnTop = Math.max(rect.top, viewTop);
        const drawn = { ...rect, top: drawnTop, bottom: Math.max(drawnTop, Math.min(rect.bottom, viewBottom)) };
        current = { rect, drawn, hitIds, selectedIds };
        setMarquee(current);
      };
      const onScroll = () => {
        if (current) place();
      };

      // Near a side of the lanes, or the top or bottom of the rows, they scroll; each scroll re-draws the rectangle
      let speedX = 0;
      let speedY = 0;
      let frame = 0;
      const step = () => {
        frame = 0;
        if (!current || !scroller || (speedX === 0 && speedY === 0)) return;
        if (speedX !== 0) scroller.scrollLeft += speedX;
        if (speedY !== 0) scroller.scrollTop += speedY;
        flushSync(place);
        frame = requestAnimationFrame(step);
      };
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
        scroller?.removeEventListener("scroll", onScroll);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speedX = 0;
        speedY = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setMarquee(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === cancel) s.setCancelGesture(null);
      };
      // Escape: the selection stays as it was, and the lanes go back to where the press found them
      const cancel = () => {
        if (scroller) {
          scroller.scrollLeft = scrollAtStart.left;
          scroller.scrollTop = scrollAtStart.top;
        }
        end();
      };
      const onMove = (e: PointerEvent) => {
        if (!lifted) {
          if (Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY)) <= DRAG_START_PX) return;
          lifted = true;
          target.setPointerCapture?.(pointerId);
          // Selecting changes no draft, so the preview plays on; the editor's keys wait
          useStitchEditorStore.getState().setCancelGesture(cancel);
          scroller?.addEventListener("scroll", onScroll, { passive: true });
        }
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        place();
        autoScroll(e.clientX, e.clientY);
      };
      const onUp = () => {
        const drawn = current;
        const wasLifted = lifted;
        end();
        const { commit, clear } = latestOptions.current;
        if (!wasLifted) {
          if (!additive) (clear ?? clearClipSelection)();
          return;
        }
        if (!drawn) return;
        const hits = latestOptions.current.order().filter((id) => drawn.hitIds.has(id));
        if (commit) commit(hits, additive);
        else applyBoxSelection(selection?.kind === "clip" ? selection : null, hits, additive);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      stop.current = end;
    },
    [contentRef],
  );

  return { marquee, onLanePointerDown, pressing };
}
