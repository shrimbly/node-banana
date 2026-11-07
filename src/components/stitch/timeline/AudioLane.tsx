"use client";

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
} from "react";
import { cn } from "@/components/nodes/ui/cn";
import { audioSelectionOf, selectedAudioIds, useStitchEditorStore } from "@/store/stitchEditorStore";
import { audioClipLength, audioSourceKey, type AudioDurations } from "@/lib/stitch/audioClips";
import { audioSnapText } from "@/lib/stitch/audioDrag";
import type { AudioSectionLayout } from "@/lib/stitch/audioLayout";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { StitchAudioClip } from "@/types";
import { EDITOR_CHIP, GEOMETRY } from "../editorStyles";
import type { AudioClipView } from "../useStitchEditorMedia";
import { AudioClipBox } from "./AudioClipBox";
import { keepFocus } from "./ClipBox";
import { useLaneFocus } from "./ClipsLane";
import { releaseTypingFocus } from "./releaseTypingFocus";
import { SnapGuide } from "./TrimOverlay";
import { audioBlockHeight, type AudioDragLive } from "./useAudioClipDrag";

/** The "Connect audio" box is never narrower than its copy. */
const CONNECT_MIN_WIDTH = 260;
/** The room under each row's block, px. */
const ROW_GAP = GEOMETRY.audioRow - GEOMETRY.audioBlock;
/** The move chip's gap from the moving box, and its height, px. */
const CHIP_GAP = 12;
const CHIP_HEIGHT = 22;

/** One audio clip as the lane draws it at rest. */
export interface AudioBox {
  clip: StitchAudioClip;
  /** Its length as drawn: decoded, else the library record's, else 0 (a fixed-width box). */
  length: number;
  /** The decoded length is known: it can be trimmed and split. */
  known: boolean;
  x: number;
  width: number;
}

/** Each clip's box: at its start, as long as its length (decoded, else the record's), else EMPTY_SLOT wide. */
export function audioBoxes(
  axis: TimeAxis,
  clips: readonly StitchAudioClip[],
  views: ReadonlyMap<string, AudioClipView>,
  durations: AudioDurations,
): AudioBox[] {
  return clips.map((clip) => {
    const decoded = durations.get(audioSourceKey(clip.source));
    const view = views.get(clip.id);
    const known = decoded !== undefined && !view?.missing;
    const length = audioClipLength(clip, known ? decoded : (view?.recordDuration ?? undefined));
    const x = axis.timeToX(clip.startSec);
    return { clip, length, known, x, width: length > 0 ? axis.timeToX(clip.startSec + length) - x : GEOMETRY.emptySlot };
  });
}

/** "Audio 2". */
export const audioRowName = (row: number) => `Audio ${row + 1}`;

/**
 * Opens the audio clip menu at a point, selecting the clip unless it is one of the selection; not over a drag.
 */
function openAudioMenuAt(clipId: string, x: number, y: number): void {
  const s = useStitchEditorStore.getState();
  if (s.cancelGesture) return;
  if (!selectedAudioIds(s).includes(clipId)) s.select(audioSelectionOf({ clipId }));
  s.openMenu({ kind: "audio", clipId, x, y });
}

/** An audio box's contextmenu event: at the pointer, or under the box when the keyboard sent it. */
export function openAudioClipMenu(event: MouseEvent<HTMLElement>, clipId: string): void {
  event.preventDefault();
  if (useStitchEditorStore.getState().cancelGesture) return;
  releaseTypingFocus(event.currentTarget);
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    openAudioMenuAt(clipId, rect.left, rect.bottom + 4);
    return;
  }
  openAudioMenuAt(clipId, event.clientX, event.clientY);
}

/**
 * The audio listbox's keys: ← and → the previous or next clip in audio order, Home and End the first and last, ↑ and
 * ↓ the clip on the row above or below whose start is nearest; each selects one clip and takes focus. The
 * context-menu key or ⇧F10 opens the clip's menu.
 */
function onAudioLaneKeyDown(event: KeyboardEvent<HTMLDivElement>, clips: readonly StitchAudioClip[], tabStop: string | null) {
  const at = clips.findIndex((c) => c.id === tabStop);
  const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  const optionOf = (id: string) => options.find((el) => el.dataset.audioClipId === id);
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    const option = at === -1 ? undefined : optionOf(clips[at].id);
    if (!option) return;
    event.preventDefault();
    const rect = option.getBoundingClientRect();
    openAudioMenuAt(clips[at].id, rect.left, rect.bottom + 4);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || clips.length === 0) return;
  let next: StitchAudioClip | undefined;
  if (event.key === "ArrowRight") next = clips[Math.min(clips.length - 1, at + 1)];
  else if (event.key === "ArrowLeft") next = clips[Math.max(0, at - 1)];
  else if (event.key === "Home") next = clips[0];
  else if (event.key === "End") next = clips[clips.length - 1];
  else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && at !== -1) {
    const current = clips[at];
    const rows = [...new Set(clips.map((c) => c.row))].sort((a, b) => a - b);
    const row = rows[rows.indexOf(current.row) + (event.key === "ArrowUp" ? -1 : 1)];
    const onRow = row === undefined ? [] : clips.filter((c) => c.row === row);
    next = onRow.reduce<StitchAudioClip | undefined>(
      (best, c) => (!best || Math.abs(c.startSec - current.startSec) < Math.abs(best.startSec - current.startSec) ? c : best),
      undefined,
    );
    if (!next) {
      event.preventDefault();
      return;
    }
  } else return;
  if (!next) return;
  event.preventDefault();
  useStitchEditorStore.getState().select(audioSelectionOf({ clipId: next.id }));
  optionOf(next.id)?.focus();
}

/**
 * The audio section under the video, in both layouts: its rows (52px, the
 * one expanded by its volume-curve toggle 128px), each holding audio clips
 * that do not overlap, then the 28px strip (where "+ Audio" sits, drawn by
 * the timeline). It depends on the rows and the expanded row only, never on
 * the selection, so a click moves nothing. Past two rows (fewer when the
 * window is short) the rows scroll inside it by a translate the timeline
 * owns, shared with their controls. With no audio at all one empty row is
 * drawn as a dashed outline ("+ Audio" under it adds some; in a node's
 * dialog it says audio can be connected to the node).
 *
 * During a body drag the moving boxes leave the rows' clip and follow the
 * pointer over the section; the landing is drawn where release puts it: a
 * band on the rows it lands on, a line where an overlap inserts a row under
 * the target, or "New row" in the strip. The chip beside the lead names
 * where it plays, how far it moved and what it snapped to.
 */
export function AudioLane({
  axis,
  boxes,
  views,
  layout,
  scroll,
  expandedRow,
  selectedIds,
  leadId,
  selectedPoint,
  drag,
  viewLeft,
  viewRight,
  visibleRight,
  contentWidth,
  contentRef,
  viewRef,
  guideTop,
  scrollLeft,
  laneWidth,
  onBodyPointerDown,
  onHandlePointerDown,
  onLanePointerDown,
  onViewScroll,
}: {
  axis: TimeAxis;
  boxes: readonly AudioBox[];
  views: ReadonlyMap<string, AudioClipView>;
  layout: AudioSectionLayout;
  /** The rows' scroll, px. */
  scroll: number;
  expandedRow: number | null;
  /** Every audio clip drawn selected (while a selection box runs, what it would select). */
  selectedIds: ReadonlySet<string>;
  /** The lead of the audio selection: the listbox's tab stop. */
  leadId: string | null;
  selectedPoint: number | null;
  drag: AudioDragLive | null;
  viewLeft: number;
  viewRight: number;
  visibleRight: number;
  contentWidth: number;
  contentRef: RefObject<HTMLDivElement | null>;
  /** The rows' view, for the drag's up-and-down auto-scroll. */
  viewRef: RefObject<HTMLDivElement | null>;
  /** The foot of the playhead's head in the section's own box (negative: above it), where a snap guide starts. */
  guideTop: number;
  scrollLeft: number;
  laneWidth: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, edge: "in" | "out") => void;
  /** A press on empty row space: the selection box. */
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** The view was scrolled by the browser (focus moved into a hidden row): the scroll joins the shared translate. */
  onViewScroll: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const { rowRef, onFocus, onBlur } = useLaneFocus();
  // An edit project has no node to connect music to
  const inEdit = useStitchEditorStore((s) => s.editId !== null);
  const clips = boxes.map((b) => b.clip);
  const tabStop = clips.some((c) => c.id === leadId) ? leadId : (clips[0]?.id ?? null);
  const multi = selectedIds.size > 1;
  const endX = axis.timeToX(axis.total);
  const move = drag?.kind === "move" ? drag : null;
  const trim = drag?.kind === "trim" ? drag : null;
  const moving = new Set(move?.clipIds ?? []);
  const rowTop = (row: number) => layout.rowTops[row] ?? layout.rowsHeight;
  const rowExpanded = (row: number) => row === expandedRow;
  const blockTop = (row: number) => rowTop(row) + GEOMETRY.audioBlockTop;

  const boxFor = (box: AudioBox, opts: { moving: boolean; top: number; xShift?: number; startShift?: number }) => {
    const view = views.get(box.clip.id);
    const live = trim && trim.clipId === box.clip.id ? trim.clip : box.clip;
    const startShift = opts.startShift ?? 0;
    // A trim draws the clip as release leaves it; a move carries it by its delta
    let start = live.startSec + startShift;
    let length = box.length;
    if (live !== box.clip && box.known) {
      length = audioClipLength(live, view?.duration ?? undefined);
      start = live.startSec;
    }
    const x = axis.timeToX(start);
    const width = length > 0 ? axis.timeToX(start + length) - x : GEOMETRY.emptySlot;
    const selected = selectedIds.has(box.clip.id);
    const single = selected && !multi;
    return (
      <AudioClipBox
        key={box.clip.id}
        clip={live}
        start={start}
        length={length}
        view={view}
        rowLabel={audioRowName(box.clip.row)}
        x={x}
        width={width}
        top={opts.top}
        expanded={rowExpanded(box.clip.row)}
        selected={selected}
        multi={multi}
        focusable={!opts.moving && tabStop === box.clip.id}
        editable={!opts.moving && single && rowExpanded(box.clip.row) && !box.clip.muted && box.length > 0}
        selectedPoint={single ? selectedPoint : null}
        moving={opts.moving}
        trimEdge={trim?.clipId === box.clip.id ? trim.edge : null}
        axis={axis}
        endX={endX}
        viewLeft={viewLeft}
        viewRight={viewRight}
        visibleRight={visibleRight}
        lanesLeft={scrollLeft + GEOMETRY.origin}
        contentWidth={contentWidth}
        contentRef={contentRef}
        onBodyPointerDown={(event) => onBodyPointerDown(event, box.clip.id)}
        onHandlePointerDown={box.known && !opts.moving ? (event, edge) => onHandlePointerDown(event, box.clip.id, edge) : null}
        onContextMenu={(event) => openAudioClipMenu(event, box.clip.id)}
      />
    );
  };

  const landing = move?.landing ?? null;
  const lead = move ? boxes.find((b) => b.clip.id === move.clipId) : undefined;
  const movingTop = (row: number) => blockTop(row) - (move?.scrollAtPress ?? 0) + (move?.dy ?? 0);
  const leadX = lead && move ? axis.timeToX(lead.clip.startSec + move.result.deltaSec) : 0;
  const leadBottom = lead ? movingTop(lead.clip.row) + audioBlockHeight(rowExpanded(lead.clip.row)) : 0;
  const snapText = move ? audioSnapText(move.result) : null;

  // The chip goes right of the lead box when it fits in the visible lanes, else left of it
  const chipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = chipRef.current;
    if (!el || !lead || !move) return;
    const width = el.offsetWidth;
    const right = leadX + (lead.length > 0 ? axis.timeToX(lead.clip.startSec + move.result.deltaSec + lead.length) - leadX : lead.width);
    const viewEnd = scrollLeft + laneWidth;
    let x = right + CHIP_GAP;
    if (laneWidth > 0 && x + width > viewEnd) {
      const before = leadX - CHIP_GAP - width;
      x = before >= scrollLeft ? before : Math.max(scrollLeft, viewEnd - width);
    }
    el.style.left = `${x}px`;
  });

  const moveChip = (() => {
    if (!move || !lead) return null;
    const from = lead.clip.startSec + move.result.deltaSec;
    const where = lead.length > 0 ? `${formatTimecode(from)}–${formatTimecode(from + lead.length)}` : formatTimecode(from);
    const count = move.clipIds.length > 1 ? `${move.clipIds.length} clips · ` : "";
    const newRow = landing?.kind === "insert" || landing?.kind === "append" ? " · New row" : "";
    return `${count}${where} · ${formatSeconds(move.result.deltaSec, 2, { signed: true })}${newRow}`;
  })();

  const trimBox = trim ? boxes.find((b) => b.clip.id === trim.clipId) : undefined;
  const trimChip = trim
    ? trim.edge === "in"
      ? `In ${formatTimecode(trim.clip.inSec)}`
      : `Out ${formatTimecode(trim.clip.outSec ?? views.get(trim.clipId)?.duration ?? 0)}`
    : null;
  const trimEdgeX = (() => {
    if (!trim || !trimBox) return 0;
    if (trim.edge === "in") return axis.timeToX(trim.clip.startSec);
    const length = audioClipLength(trim.clip, views.get(trim.clipId)?.duration ?? undefined);
    return axis.timeToX(trim.clip.startSec + length);
  })();
  const trimTop = trimBox ? blockTop(trimBox.clip.row) - scroll : 0;

  const empty = boxes.length === 0;
  const toLaneEnd = Math.max(0, contentWidth - GEOMETRY.origin - GEOMETRY.endMargin);
  const blockWidth = Math.max(0, endX - axis.timeToX(0));

  return (
    <div
      data-audio-section=""
      data-testid="stitch-audio-section"
      className="relative bg-pane"
      style={{ height: layout.sectionHeight }}
    >
      <div
        ref={viewRef}
        data-testid="stitch-audio-view"
        className="relative overflow-hidden"
        style={{ height: layout.viewHeight }}
        onScroll={onViewScroll}
      >
        <div
          ref={rowRef}
          role="listbox"
          aria-label="Audio clips"
          aria-multiselectable="true"
          onKeyDown={(event) => onAudioLaneKeyDown(event, clips, tabStop)}
          onPointerDown={onLanePointerDown}
          onMouseDown={keepFocus}
          onFocus={onFocus}
          onBlur={onBlur}
          data-testid="stitch-audio-rows"
          className="absolute inset-x-0 top-0"
          style={{ height: Math.max(layout.rowsHeight, layout.viewHeight), transform: `translateY(${-scroll}px)` }}
        >
          {layout.rowTops.map((top, row) => (
            <div
              key={row}
              aria-hidden="true"
              data-testid="stitch-audio-row"
              data-row={row}
              className={cn(
                "pointer-events-none absolute inset-x-0",
                landing?.kind === "rows" && landing.rows.has(row) && "bg-white/6",
              )}
              style={{ top, height: layout.rowHeights[row] }}
            />
          ))}
          {/* An empty row, not a button: "+ Audio" under it adds audio. A node's dialog says audio can come from the node */}
          {empty && (
            <div
              data-testid="stitch-audio-placeholder"
              aria-hidden={inEdit ? true : undefined}
              className="pointer-events-none absolute flex items-center justify-center overflow-hidden whitespace-nowrap rounded-md border border-dashed border-edit-line px-3 text-xs text-ink-3"
              style={{
                left: GEOMETRY.origin,
                top: GEOMETRY.audioBlockTop,
                width: Math.min(Math.max(blockWidth, CONNECT_MIN_WIDTH), Math.max(toLaneEnd, CONNECT_MIN_WIDTH)),
                height: GEOMETRY.audioBlock,
              }}
            >
              {inEdit ? null : "Connect audio to the node"}
            </div>
          )}
          {boxes.map((box) => (moving.has(box.clip.id) ? null : boxFor(box, { moving: false, top: blockTop(box.clip.row) })))}
          {landing?.kind === "insert" && (
            <div
              aria-hidden="true"
              data-testid="stitch-audio-insertion"
              className="pointer-events-none absolute inset-x-0 z-1 h-[3px] rounded-[2px] bg-neutral-100"
              // In the gap under the row it inserts after
              style={{ top: rowTop(landing.after) + (layout.rowHeights[landing.after] ?? 0) - ROW_GAP / 2 - 1.5 }}
            />
          )}
        </div>
      </div>
      <div
        data-testid="stitch-audio-strip"
        className="relative"
        style={{ height: GEOMETRY.audioStrip }}
      >
        {landing?.kind === "append" && (
          <div
            data-testid="stitch-audio-new-row"
            className="absolute inset-x-1 inset-y-1 flex items-center rounded-md border border-dashed border-white/15 text-xs text-neutral-300"
            style={{ paddingLeft: Math.max(8, scrollLeft + 8) }}
          >
            New row
          </div>
        )}
      </div>

      {/* Over the section, out of the rows' clip: the moving boxes follow the pointer anywhere, the strip included */}
      {move && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
          {boxes.map((box) =>
            moving.has(box.clip.id)
              ? boxFor(box, { moving: true, top: movingTop(box.clip.row), startShift: move.result.deltaSec })
              : null,
          )}
          {moveChip && lead && (
            <div
              ref={chipRef}
              data-testid="stitch-audio-move-chip"
              className={cn(EDITOR_CHIP, "absolute z-20 whitespace-nowrap tabular-nums text-neutral-200")}
              // Beside the box, never below the section: a box dragged onto the strip runs past it
              style={{ left: leadX + lead.width + CHIP_GAP, top: Math.min(movingTop(lead.clip.row) + 10, layout.sectionHeight - CHIP_HEIGHT) }}
            >
              {moveChip}
            </div>
          )}
          {move.result.snapped && snapText && (
            <SnapGuide
              x={axis.timeToX(move.result.snapped.t)}
              top={guideTop}
              bottom={leadBottom}
              chipTop={leadBottom + 8}
              text={snapText}
            />
          )}
        </div>
      )}
      {trim && trimChip && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
          <div
            data-testid="stitch-audio-trim-chip"
            className={cn(EDITOR_CHIP, "absolute whitespace-nowrap tabular-nums text-neutral-200")}
            style={{ left: trimEdgeX + 8, top: trimTop + 4 }}
          >
            {trimChip}
          </div>
          {trim.snapped && (
            <SnapGuide
              x={axis.timeToX(trim.snapped.t)}
              top={guideTop}
              bottom={trimTop + audioBlockHeight(trimBox ? rowExpanded(trimBox.clip.row) : false)}
              chipTop={trimTop + 30}
              text={`Snapped to ${trim.snapped.label}`}
            />
          )}
        </div>
      )}
    </div>
  );
}
