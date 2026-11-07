"use client";

import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { clipName } from "@/lib/stitch/labels";
import type { LaneBox } from "@/lib/stitch/laneLayout";
import type { WeightPiece } from "@/lib/stitch/placement";
import { formatSeconds } from "@/lib/stitch/timecode";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { spansEnd, type ClipSpan } from "@/lib/stitch/timeline";
import { EDITOR_CHIP, GEOMETRY } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { ClipBox, keepFocus, type ClipBoxMode } from "./ClipBox";
import { AddSlotButton, EmptyLaneButton, laneTabStop, onLaneKeyDown, openClipMenu, useLaneFocus } from "./ClipsLane";
import { CrossfadeMarks, LayerMarks } from "./CrossfadeMark";
import { EmptyClipSlot } from "./EmptyClipSlot";
import { Filmstrip } from "./Filmstrip";
import type { MoveLive } from "./useClipMove";
import type { ReorderLive } from "./useClipReorder";
import type { TrimLive } from "./useTrimDrag";

const ROW = GEOMETRY.stackRow;
const BOX_TOP = GEOMETRY.stackClipTop;
const BOX_HEIGHT = GEOMETRY.stackClipHeight;
/** A ghost narrower than this is not drawn. */
const MIN_GHOST_PX = 1;
/** A gap band narrower than this has no "Gap 1.0 s" label: the chip's 63px and the band's two 1px borders. */
const MIN_GAP_LABEL_PX = 64;
/** Each character the label has past "Gap 1.0 s" ("Gap 10.0 s") asks this much more of the band, px. */
const GAP_LABEL_CHAR_PX = 7;
/** The gap label's drop below the sticky ruler, px. */
const GAP_LABEL_TOP = GEOMETRY.ruler + 6;

/** A placed stack's marks: each clip's share of the picture (weightPieces), by clip id, and the covering clips' names. */
export interface LaneMarks {
  pieces: ReadonlyMap<string, readonly WeightPiece[]>;
  /** The name of the clip in a row of the timeline the marks were built from ("Clip 3"). */
  coverName: (row: number) => string;
}

/**
 * Stacked's clip rows, inside the rows block under the sticky ruler: one
 * 52px row per clip, its 40px compact box at the clip's own start on a
 * linear axis (an empty clip is a 160px slot at its instant), the marks of
 * how it layers, a black band over each gap, and after the latest end, in
 * the last row, the + slot that opens Add media. A lined-up stack
 * marks its overlaps (CrossfadeMarks); a placed one marks each clip's share
 * of the picture (LayerMarks), hidden stretches included.
 *
 * While a trim runs the boxes are drawn from the spans release will give,
 * so nothing jumps on release; the ghost shows the frames the trim cuts, on
 * the side of the box they leave from.
 * While a clip's box is dragged it follows the pointer in time and across
 * rows, with a line where it will land; the others keep their places. While
 * a row's grip is dragged its box is lifted, at the start it will have in
 * its new place (lined up) or at its own (placed). Either way every box is
 * marked as release will leave it. A drag of one of several selected clips
 * carries them all: each box at its own start plus the one time delta, and
 * its own row plus the one travel, clamped for the group as a whole.
 *
 * The same listbox as Track's (one tab stop, focus kept in the lane, the
 * clip menu from the keyboard, every selected clip ringed and its row
 * tinted, the selection box on empty space), running down: ↑/↓ as well as
 * ←/→.
 */
export function StackedClipsLane({
  axis,
  spans,
  boxes,
  restBoxes,
  media,
  selectedId,
  selectedIds,
  multi,
  trim,
  reorder,
  liftedX,
  move,
  insertionY,
  marks,
  gaps,
  crossfade,
  viewLeft,
  viewRight,
  contentWidth,
  onBodyPointerDown,
  onHandlePointerDown,
  onLanePointerDown,
}: {
  axis: TimeAxis;
  /** As drawn: while a trim runs, the spans it gives. */
  spans: readonly ClipSpan[];
  boxes: readonly LaneBox[];
  /** The boxes at rest, for the trim ghost. */
  restBoxes: readonly LaneBox[];
  media: ReadonlyMap<string, ClipMediaView>;
  /** The lead: the tab stop. */
  selectedId: string | null;
  /** Every clip drawn selected (while the selection box runs, what it would select). */
  selectedIds: ReadonlySet<string>;
  /** Several clips are selected: handles show on hover only. */
  multi: boolean;
  trim: TrimLive | null;
  reorder: ReorderLive | null;
  /**
   * A row grip's drag: each lifted clip's x at its start in the order it would drop into (lined up); null, or a clip
   * not in it, keeps its x.
   */
  liftedX: ReadonlyMap<string, number> | null;
  /** A box's drag, in time and across rows. */
  move: MoveLive | null;
  /** The insertion line of either drag, in rows px; null when the clip would keep its row. */
  insertionY: number | null;
  /** Placed: each box's marks; null for a lined-up stack's overlap marks. */
  marks: LaneMarks | null;
  /** Gaps of at least a slot, in sequence seconds. */
  gaps: ReadonlyArray<{ fromSec: number; toSec: number }>;
  crossfade: boolean;
  viewLeft: number;
  viewRight: number;
  contentWidth: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, span: ClipSpan, edge: "in" | "out") => void;
  /** A press on the listbox itself (a row's free time): the selection box. */
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const { rowRef, onFocus, onBlur } = useLaneFocus();
  const libraryOn = useLibraryAvailable();
  const tabStop = laneTabStop(spans, selectedId);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => onLaneKeyDown(event, spans, tabStop, true);

  if (spans.length === 0) {
    return (
      <div ref={rowRef} className="absolute inset-x-0 top-0 border-b border-white/4" style={{ height: ROW }}>
        <EmptyLaneButton
          libraryOn={libraryOn}
          left={GEOMETRY.origin}
          top={BOX_TOP}
          width={Math.max(0, contentWidth - GEOMETRY.origin - GEOMETRY.endMargin)}
          height={BOX_HEIGHT}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      </div>
    );
  }

  // The frames the trim cuts, drawn where they were on the side they leave from, in source order: the head just left of
  // the box for an In trim (whose left edge moves with the In), the tail just right of it for an Out trim
  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  let ghost: { x: number; width: number; inSec: number; side: "in" | "out" } | null = null;
  if (trim && trimIndex !== -1 && spans[trimIndex].length > 0) {
    const live = boxes[trimIndex];
    const rest = restBoxes[trimIndex];
    const width = live && rest ? (rest.lengthSec - live.lengthSec) * axis.pxPerSec : 0;
    if (live && rest && width >= MIN_GHOST_PX) {
      ghost =
        trim.edge === "out"
          ? { x: live.x + live.width, width, inSec: live.inSec + live.lengthSec, side: "out" }
          : { x: live.x - width, width, inSec: rest.inSec, side: "in" };
    }
  }
  const trimView = trimIndex === -1 ? undefined : media.get(spans[trimIndex].clip.id);

  // After the latest end, and after the last row's own box (an empty slot can reach past the end)
  const last = boxes[boxes.length - 1];
  const slotX = Math.max(axis.timeToX(spansEnd(spans)), last ? last.x + last.width : axis.endX) + GEOMETRY.addSlotGap;

  // Each clip's name for the one above it: the previous clip with a length (an empty clip covers nothing)
  const above: (string | null)[] = [];
  let previous: string | null = null;
  for (const span of spans) {
    above.push(previous);
    if (span.length > 0) previous = clipName(span.index);
  }
  return (
    <>
      {spans.map((span, i) => (
        <div
          key={span.clip.id}
          aria-hidden="true"
          data-stacked-row={span.clip.id}
          className={cn("absolute inset-x-0 border-b border-white/4", selectedIds.has(span.clip.id) && "bg-white/4")}
          style={{ top: i * ROW, height: ROW }}
        />
      ))}
      {gaps.map((gap) => {
        const left = axis.timeToX(gap.fromSec);
        const width = axis.timeToX(gap.toSec) - left;
        const label = `Gap ${formatSeconds(gap.toSec - gap.fromSec, 1)}`;
        const labelFits = width >= MIN_GAP_LABEL_PX + GAP_LABEL_CHAR_PX * Math.max(0, label.length - 9);
        return (
          <div
            key={gap.fromSec}
            aria-hidden="true"
            data-testid="stitch-gap"
            className="pointer-events-none absolute inset-y-0 flex justify-center border-x border-dashed border-white/12 bg-black"
            style={{ left, width }}
          >
            {labelFits && (
              // Sticky under the ruler: it stays at the top of the visible rows while they scroll
              <span
                className={cn(EDITOR_CHIP, "sticky mt-1.5 self-start whitespace-nowrap text-neutral-400")}
                style={{ top: GAP_LABEL_TOP }}
              >
                {label}
              </span>
            )}
          </div>
        );
      })}
      <div
        ref={rowRef}
        role="listbox"
        aria-label="Clips"
        aria-orientation="vertical"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
        onPointerDown={onLanePointerDown}
        onMouseDown={keepFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        className="absolute inset-0"
      >
        {spans.map((span, i) => {
          const view = media.get(span.clip.id);
          const box = boxes[i];
          const moving = move?.clipIds.includes(span.clip.id) ? move : null;
          const mode: ClipBoxMode = moving
            ? "moving"
            : !reorder
              ? "rest"
              : reorder.clipIds.includes(span.clip.id)
                ? "lifted"
                : "dimmed";
          const lifted = mode === "lifted" && reorder;
          // A group's other boxes: their own start plus the pressed clip's delta, their own row plus the group's travel
          const groupMove = moving !== null && moving.clipIds.length > 1;
          const x = moving
            ? groupMove
              ? axis.timeToX(span.start + moving.result.deltaSec)
              : moving.x
            : lifted
              ? (liftedX?.get(span.clip.id) ?? box.x)
              : box.x;
          const top = moving ? i * ROW + BOX_TOP + moving.dy : i * ROW + BOX_TOP + (lifted ? reorder.dy : 0);
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
                width={box.width}
                selected={selected}
                focusable={focusable}
                mode={mode}
                top={top}
                height={BOX_HEIGHT}
                stacked
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
              width={box.width}
              selected={selected}
              focusable={focusable}
              mode={mode}
              trimEdge={trimIndex === i && trim ? trim.edge : null}
              inSec={box.inSec}
              lengthSec={box.lengthSec}
              pxPerSec={axis.pxPerSec}
              viewLeft={viewLeft}
              viewRight={viewRight}
              top={top}
              height={BOX_HEIGHT}
              compact
              multi={multi}
              overlay={
                marks ? (
                  <LayerMarks
                    pieces={marks.pieces.get(span.clip.id) ?? []}
                    pxPerSec={axis.pxPerSec}
                    crossfade={crossfade}
                    coverName={marks.coverName}
                  />
                ) : // A lifted clip's overlaps are those of the place it leaves: not drawn
                mode === "lifted" ? null : (
                  <CrossfadeMarks
                    overlapIn={span.overlapIn}
                    overlapOut={span.overlapOut}
                    pxPerSec={axis.pxPerSec}
                    crossfade={crossfade}
                    coveredBy={above[i]}
                  />
                )
              }
              onBodyPointerDown={onBody}
              onHandlePointerDown={(event, edge) => onHandlePointerDown(event, span, edge)}
              onContextMenu={onMenu}
            />
          );
        })}

        {ghost && (
          <div
            aria-hidden="true"
            data-testid="stitch-trim-ghost"
            className={cn("absolute overflow-hidden", ghost.side === "out" ? "rounded-r-md" : "rounded-l-md")}
            style={{ left: ghost.x, top: trimIndex * ROW + BOX_TOP, width: ghost.width, height: BOX_HEIGHT }}
          >
            <Filmstrip
              frames={trimView?.frames ?? []}
              duration={trimView?.duration ?? null}
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

        {insertionY !== null && (
          <div
            aria-hidden="true"
            data-testid="stitch-insertion-bar"
            className="pointer-events-none absolute inset-x-0 z-20 h-[3px] rounded-[2px] bg-neutral-100"
            style={{ top: insertionY - 1.5 }}
          />
        )}
      </div>
      <AddSlotButton
        libraryOn={libraryOn}
        left={slotX}
        top={(spans.length - 1) * ROW + BOX_TOP}
        height={BOX_HEIGHT}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </>
  );
}
