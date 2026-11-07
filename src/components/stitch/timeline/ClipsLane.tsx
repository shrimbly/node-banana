"use client";

import {
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plus } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { selectedClipIds, useStitchEditorStore } from "@/store/stitchEditorStore";
import { insetBox, JOIN_INSET_PX, type LaneBox } from "@/lib/stitch/laneLayout";
import { blockInsertionX, insertionX } from "@/lib/stitch/reorder";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { openLibraryPicker } from "../editorActions";
import { GEOMETRY, EDITOR_PANEL_SELECTOR } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { ClipBox, keepFocus, type ClipBoxMode } from "./ClipBox";
import { EmptyClipSlot } from "./EmptyClipSlot";
import { Filmstrip } from "./Filmstrip";
import { releaseTypingFocus } from "./releaseTypingFocus";
import type { ReorderLive } from "./useClipReorder";
import type { TrimLive } from "./useTrimDrag";

/**
 * Opens the clip menu at a point, selecting the clip unless it is one of the selection (the menu then acts on all of
 * them); not over a drag, which applies what it measured on release.
 */
function openMenuAt(clipId: string, x: number, y: number): void {
  const s = useStitchEditorStore.getState();
  // A drag applies what it measured at the press on release: no menu opens over it (a right press mid-trim)
  if (s.cancelGesture) return;
  if (!selectedClipIds(s).includes(clipId)) s.select({ kind: "clip", clipId });
  s.openMenu({ kind: "clip", clipId, x, y });
}

/** A clip's contextmenu event: at the pointer, or under the clip when the keyboard sent it. */
export function openClipMenu(event: MouseEvent<HTMLElement>, clipId: string): void {
  event.preventDefault();
  if (useStitchEditorStore.getState().cancelGesture) return;
  // A right press leaves a focused In/Out field focused (the clip's mousedown keeps focus): it commits now, to
  // the clip it was typed for, before the selection moves
  releaseTypingFocus(event.currentTarget);
  // A context menu from the keyboard can arrive without a pointer position: under the clip then
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(clipId, rect.left, rect.bottom + 4);
    return;
  }
  openMenuAt(clipId, event.clientX, event.clientY);
}

/** The listbox's one tab stop: the selected clip, else the first. */
export function laneTabStop(spans: readonly ClipSpan[], selectedId: string | null): string | null {
  return spans.some((s) => s.clip.id === selectedId) ? selectedId : (spans[0]?.clip.id ?? null);
}

/**
 * The listbox's keys: the arrows along it (←/→, and ↑/↓ too when it runs down the rows), Home and End move the
 * selection and focus; the context-menu key or ⇧F10 opens the clip menu at the clip.
 */
export function onLaneKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  spans: readonly ClipSpan[],
  tabStop: string | null,
  vertical = false,
): void {
  const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  const at = spans.findIndex((s) => s.clip.id === tabStop);
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    const option = options[at];
    if (!option || at === -1) return;
    event.preventDefault();
    const rect = option.getBoundingClientRect();
    openMenuAt(spans[at].clip.id, rect.left, rect.bottom + 4);
    return;
  }
  let next: number | null = null;
  if (event.key === "ArrowRight" || (vertical && event.key === "ArrowDown")) next = Math.min(spans.length - 1, at + 1);
  else if (event.key === "ArrowLeft" || (vertical && event.key === "ArrowUp")) next = Math.max(0, at - 1);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = spans.length - 1;
  if (next === null || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  const clipId = spans[next].clip.id;
  useStitchEditorStore.getState().select({ kind: "clip", clipId });
  options.find((el) => el.dataset.clipId === clipId)?.focus();
}

/**
 * Keeps focus in a lane whose focused clip, placeholder or add slot goes away: it moves to the new tab stop, or to
 * the panel when there is none. Spread onFocus/onBlur on the listbox and the buttons beside it; rowRef on the
 * element that holds them.
 */
export function useLaneFocus() {
  const rowRef = useRef<HTMLDivElement>(null);
  /**
   * Focus is on a clip, the placeholder or the add slot. A focused element that is removed fires no blur, so
   * this outlives it.
   */
  const focusInside = useRef(false);
  const onFocus = () => {
    focusInside.current = true;
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    // A blur some browser fires for the clip's own removal is not focus leaving
    if (!event.relatedTarget && !event.target.isConnected) return;
    focusInside.current = event.currentTarget.contains(event.relatedTarget as Node | null);
  };
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const row = rowRef.current;
    const active = document.activeElement;
    if (!row || (active && active !== document.body && active.isConnected)) return;
    focusInside.current = false;
    const stop = row.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
    (stop ?? row.closest<HTMLElement>(EDITOR_PANEL_SELECTOR))?.focus({ preventScroll: true });
  });
  return { rowRef, onFocus, onBlur };
}

/** Quiet filled slots that add clips: the empty lane's placeholder and the + after the last clip. */
const ADD_SLOT =
  "absolute flex items-center justify-center rounded-md bg-edit-slot text-ink-3 transition-colors hover:bg-white/4 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

/** The placeholder across an empty lane: it opens Add media for videos (off while the library is). */
export function EmptyLaneButton({
  libraryOn,
  left,
  top,
  width,
  height,
  onFocus,
  onBlur,
}: {
  libraryOn: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      data-testid="stitch-empty-lane"
      aria-label="Add media"
      title={libraryOn ? "Add media" : undefined}
      disabled={!libraryOn}
      onClick={() => openLibraryPicker("video")}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(ADD_SLOT, "disabled:pointer-events-none")}
      style={{ left, top, width, height }}
    >
      {libraryOn && <Plus size={16} strokeWidth={1.5} />}
    </button>
  );
}

/** The + after the last clip, which opens Add media for videos (off while the library is). */
export function AddSlotButton({
  libraryOn,
  left,
  top,
  height,
  onFocus,
  onBlur,
}: {
  libraryOn: boolean;
  left: number;
  top: number;
  height: number;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      data-testid="stitch-add-slot"
      aria-label="Add media"
      title={libraryOn ? "Add media" : "The asset library is off"}
      disabled={!libraryOn}
      onClick={() => openLibraryPicker("video")}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(ADD_SLOT, "disabled:opacity-40 disabled:hover:bg-edit-slot disabled:hover:text-ink-3")}
      style={{ left, top, width: GEOMETRY.addSlot, height }}
    >
      <Plus size={16} strokeWidth={1.5} />
    </button>
  );
}

/**
 * The clips row: one box per clip (a fixed slot for a clip with no length),
 * the trim ghost, and the insertion bar while a clip is dragged to a new
 * place. After the last clip a quiet + slot opens Add media; an empty
 * sequence shows a placeholder across the lane that does the same (both off
 * while the library is).
 *
 * It is a listbox: the selected clip (the lead of several) is its one tab
 * stop, the arrows, Home and End select one clip, and the context-menu key
 * (or ⇧F10) opens the clip menu at the clip. Every selected clip is ringed;
 * a press on empty space in it starts the selection box (onLanePointerDown),
 * and a drag of one of several selected clips lifts them all. A mouse press does not focus a clip (the selection
 * ring shows which one is chosen). When the focused clip goes (⌫, or an undo
 * or redo that takes it away), focus moves to the new tab stop, or to the
 * panel when no clip is left, so it never drops out of the dialog. The same
 * holds for the empty lane's placeholder and the add slot (a redo that
 * brings clips back unmounts a focused placeholder).
 */
export function ClipsLane({
  axis,
  spans,
  boxes,
  media,
  selectedId,
  selectedIds,
  multi,
  trim,
  reorder,
  viewLeft,
  viewRight,
  laneWidth,
  onBodyPointerDown,
  onHandlePointerDown,
  onLanePointerDown,
}: {
  axis: TimeAxis;
  spans: readonly ClipSpan[];
  boxes: readonly LaneBox[];
  media: ReadonlyMap<string, ClipMediaView>;
  /** The lead: the tab stop. */
  selectedId: string | null;
  /** Every clip drawn selected (while the selection box runs, what it would select). */
  selectedIds: ReadonlySet<string>;
  /** Several clips are selected: handles show on hover only. */
  multi: boolean;
  trim: TrimLive | null;
  reorder: ReorderLive | null;
  viewLeft: number;
  viewRight: number;
  laneWidth: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, span: ClipSpan, edge: "in" | "out") => void;
  /** A press on the listbox itself: the selection box. */
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const { rowRef, onFocus, onBlur } = useLaneFocus();
  const libraryOn = useLibraryAvailable();
  const tabStop = laneTabStop(spans, selectedId);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => onLaneKeyDown(event, spans, tabStop);

  const rowStyle = { top: GEOMETRY.ruler, height: GEOMETRY.clipRow };
  if (spans.length === 0) {
    return (
      <div ref={rowRef} className="absolute inset-x-0" style={rowStyle}>
        <EmptyLaneButton
          libraryOn={libraryOn}
          left={GEOMETRY.origin}
          top={GEOMETRY.clipTop}
          width={Math.max(0, laneWidth - GEOMETRY.origin - GEOMETRY.endMargin)}
          height={GEOMETRY.clipHeight}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      </div>
    );
  }

  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  const ghost = (() => {
    if (!trim || trimIndex === -1 || !trim.result.ghost) return null;
    const span = spans[trimIndex];
    const base = axis.clipBox(trimIndex);
    const { fromSec, toSec } = trim.result.ghost;
    const raw = { x: base.x + (fromSec - span.start) * axis.pxPerSec, width: (toSec - fromSec) * axis.pxPerSec };
    // The ghost keeps the gap on the side it shares with the clip, and the clip's own rounded outer side
    const out = trim.edge === "out";
    const left = out ? JOIN_INSET_PX : trimIndex > 0 ? JOIN_INSET_PX : 0;
    const right = out ? (trimIndex < spans.length - 1 ? JOIN_INSET_PX : 0) : JOIN_INSET_PX;
    return {
      x: raw.x + left,
      width: Math.max(0, raw.width - left - right),
      inSec: out ? trim.result.edgeSourceTime : span.clip.inSec,
      view: media.get(span.clip.id),
      out,
    };
  })();

  // The add slot sits after the last clip as it is drawn or its resting end, whichever is further right: a
  // lengthening trim pushes it along, a shortening one leaves it after the ghost (the clips close up on release)
  const last = boxes[boxes.length - 1];
  const slotX = Math.max(last ? last.x + last.width : 0, axis.endX) + GEOMETRY.addSlotGap;

  const lifted = new Set(reorder?.clipIds ?? []);
  // One clip's bar shows once it would move; a group's once the drag is armed (useClipReorder)
  const insertionBarX = (() => {
    if (!reorder) return null;
    if (reorder.clipIds.length <= 1) {
      return reorder.dropIndex !== reorder.index ? insertionX(reorder.dropIndex, boxes, reorder.index) : null;
    }
    if (!reorder.armed) return null;
    const indices = new Set(spans.flatMap((span, i) => (lifted.has(span.clip.id) ? [i] : [])));
    return blockInsertionX(reorder.dropIndex, boxes, indices);
  })();

  return (
    <>
      <div
        ref={rowRef}
        role="listbox"
        aria-label="Clips"
        aria-orientation="horizontal"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
        onPointerDown={onLanePointerDown}
        onMouseDown={keepFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        className="absolute inset-x-0"
        style={rowStyle}
      >
        {spans.map((span, i) => {
          const view = media.get(span.clip.id);
          const box = boxes[i];
          const drawn = insetBox(box, i, spans.length);
          const mode: ClipBoxMode = !reorder ? "rest" : lifted.has(span.clip.id) ? "lifted" : "dimmed";
          const x = mode === "lifted" && reorder ? drawn.x + reorder.dx : drawn.x;
          const selected = selectedIds.has(span.clip.id);
          const focusable = tabStop === span.clip.id;
          const onBody = (event: ReactPointerEvent<HTMLElement>) => onBodyPointerDown(event, span.clip.id, i);
          const onMenu = (event: MouseEvent<HTMLElement>) => openClipMenu(event, span.clip.id);
          if (span.length <= 0) {
            return (
              <EmptyClipSlot
                key={span.clip.id}
                span={span}
                view={view}
                x={x}
                width={drawn.width}
                selected={selected}
                focusable={focusable}
                mode={mode}
                onBodyPointerDown={onBody}
                onContextMenu={onMenu}
              />
            );
          }
          return (
            <ClipBox
              key={span.clip.id}
              span={span}
              view={view}
              x={x}
              width={drawn.width}
              selected={selected}
              focusable={focusable}
              mode={mode}
              trimEdge={trimIndex === i && trim ? trim.edge : null}
              inSec={box.inSec}
              lengthSec={box.lengthSec}
              pxPerSec={axis.pxPerSec}
              viewLeft={viewLeft}
              viewRight={viewRight}
              multi={multi}
              onBodyPointerDown={onBody}
              onHandlePointerDown={(event, edge) => onHandlePointerDown(event, span, edge)}
              onContextMenu={onMenu}
            />
          );
        })}

        {ghost && ghost.width > 0 && (
          <div
            aria-hidden="true"
            data-testid="stitch-trim-ghost"
            className={ghost.out ? "absolute overflow-hidden rounded-r-md" : "absolute overflow-hidden rounded-l-md"}
            style={{ left: ghost.x, top: GEOMETRY.clipTop, width: ghost.width, height: GEOMETRY.clipHeight }}
          >
            <Filmstrip
              frames={ghost.view?.frames ?? []}
              duration={ghost.view?.duration ?? null}
              inSec={ghost.inSec}
              pxPerSec={axis.pxPerSec}
              width={ghost.width}
              boxX={ghost.x}
              viewLeft={viewLeft}
              viewRight={viewRight}
              className="opacity-30"
            />
            <div className="absolute inset-0 editor-ghost-hatch" />
          </div>
        )}

        {insertionBarX !== null && (
          <div
            aria-hidden="true"
            data-testid="stitch-insertion-bar"
            className="absolute w-[3px] rounded-[2px] bg-neutral-100"
            style={{
              left: insertionBarX - 1.5,
              top: GEOMETRY.clipTop - 4,
              height: GEOMETRY.clipHeight + 8,
            }}
          />
        )}
      </div>
      <AddSlotButton
        libraryOn={libraryOn}
        left={slotX}
        top={GEOMETRY.ruler + GEOMETRY.clipTop}
        height={GEOMETRY.clipHeight}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </>
  );
}
