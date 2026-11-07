"use client";

import type { MouseEvent, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { Volume1, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { clipName } from "@/lib/stitch/labels";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { setClipMuted } from "../editorActions";
import { GEOMETRY, LIFTED_CLIP, MOVING_CLIP, SELECTED_RING } from "../editorStyles";
import { isToggleClick } from "../selectionActions";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { Filmstrip } from "./Filmstrip";

/**
 * At rest; "dimmed" while another clip is being dragged to a new place; "lifted" while this one is; "moving" while
 * Stacked's body drag carries it in time and across rows.
 */
export type ClipBoxMode = "rest" | "dimmed" | "lifted" | "moving";

/** ⌘ (Ctrl off a Mac) or ⇧: a click on the box under the sound button, which then selects instead of muting. */
const selectsClip = (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) =>
  isToggleClick(event) || event.shiftKey;
const stopPress = (event: ReactPointerEvent) => {
  if (!selectsClip(event)) event.stopPropagation();
};
/** Each handle takes at most this share of a narrow clip, so its middle third stays a body to press and drag. */
const HANDLE_SHARE = 1 / 3;
/** A handle narrower than this shows no grip. */
const MIN_GRIP_HANDLE_PX = 4;
/** The handles' width on a clip drawn this wide: the boards' 10px, narrower on a clip too short for two. */
export const handleWidthFor = (width: number) => Math.min(GEOMETRY.handle, width * HANDLE_SHARE);
/** A box narrower than this shows no length chip. */
const MIN_CHIP_BOX_PX = 56;
/** The length chip, at the box's bottom right, clear of the Out handle: shown on hover, and live while trimming. */
export const LENGTH_CHIP =
  "pointer-events-none absolute bottom-1 right-3 z-2 rounded-[4px] bg-black/60 px-1 text-[10px] leading-4 tabular-nums text-neutral-100";
/**
 * A compact box narrower than this has no hover mute button, and its muted badge is a mark the press passes through:
 * on a short box they would cover most of the body, which is what a drag holds.
 */
const MIN_SOUND_BUTTON_BOX_PX = 96;
/** A muted clip's mark (video or audio): an 18px VolumeX square, placed by the box. */
export const MUTED_BADGE =
  "pointer-events-none absolute z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-300";
/** A mouse press takes no focus: a focused clip or button would be unmounted by its own action and drop focus out of the editor. */
export const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * A clip's In or Out handle, on a video box or an audio box: shown on hover (white on the one selected clip), and
 * while its edge is dragged. Hidden, it still takes a press at the box's edge.
 */
export function EdgeHandle({
  side,
  width,
  selected,
  active,
  onPointerDown,
}: {
  side: "in" | "out";
  width: number;
  selected: boolean;
  active: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      role="presentation"
      data-trim-handle={side}
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-0 z-1 flex items-center justify-center cursor-ew-resize",
        side === "in" ? "left-0" : "right-0",
        active
          ? "bg-neutral-200"
          : cn("opacity-0 group-hover:opacity-100", selected ? "bg-neutral-100" : "bg-white/18"),
      )}
      style={{ width }}
    >
      {/* The grip, where the handle has room for it */}
      {width >= MIN_GRIP_HANDLE_PX && (
        <span
          aria-hidden="true"
          className={cn("h-3.5 w-0.5 rounded-[1px]", active || selected ? "bg-neutral-900" : "bg-white/80")}
        />
      )}
    </div>
  );
}

/**
 * One clip on the lane: at rest only its frames, on the edit-field ground
 * with 6px corners, and the muted badge on a muted clip. Selected (one of
 * several too, or while an edge is dragged) it is ringed in white over its
 * frames. On hover: its trimmed length at the bottom right (also while
 * trimming, to two decimals), its trim handles, and its sound button (the
 * badge unmutes, or a button mutes). Those buttons are pointer shortcuts,
 * hidden from the accessibility tree and the tab order: an option holds no
 * controls, and ⌥M and the clip menu do the same. Its name is its
 * accessible name; a box lifted to be dragged shows it.
 *
 * Compact (a Stacked row's 40px box): the sound badges centred at the left.
 * Its accessible name says where it starts, and a box under 96px keeps its
 * middle for the body drag: no hover mute button, and the muted badge only
 * marks it (⌥M and the menu unmute).
 */
export function ClipBox({
  span,
  view,
  x,
  width,
  selected,
  focusable,
  mode,
  trimEdge,
  inSec,
  lengthSec,
  pxPerSec,
  viewLeft,
  viewRight,
  top = GEOMETRY.clipTop,
  height = GEOMETRY.clipHeight,
  compact = false,
  multi = false,
  overlay,
  onBodyPointerDown,
  onHandlePointerDown,
  onContextMenu,
}: {
  span: ClipSpan;
  view: ClipMediaView | undefined;
  x: number;
  width: number;
  selected: boolean;
  /** The listbox's one tab stop. */
  focusable: boolean;
  mode: ClipBoxMode;
  /** The edge being dragged on this clip, if any. */
  trimEdge: "in" | "out" | null;
  /** Live while trimming: the In and the length the drag gives. */
  inSec: number;
  lengthSec: number;
  pxPerSec: number;
  viewLeft: number;
  viewRight: number;
  /** In its row: Track's clips row by default, a Stacked row's box otherwise. */
  top?: number;
  height?: number;
  compact?: boolean;
  /** One of several selected clips: its handles show on hover only, since a trim acts on one clip. */
  multi?: boolean;
  /** Drawn over the frames, under the badges and handles (Stacked's crossfade marks). */
  overlay?: ReactNode;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, edge: "in" | "out") => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { clip } = span;
  const name = clipName(span.index);
  const atRest = mode === "rest";
  const showHandles = atRest;
  const handleWidth = handleWidthFor(width);
  // White on the one selected clip; a trim acts on one clip, so several selected keep the quiet ones
  const handlesWhite = selected && !multi;
  // The badges make room for the handles while they show
  const badgeLeft = trimEdge ? "left-4" : "left-1.5 group-hover:left-4";
  const badgeTop = compact ? "top-[11px]" : "top-1.5";
  const soundButtons = !compact || width >= MIN_SOUND_BUTTON_BOX_PX;
  const ringed = (selected || trimEdge !== null) && (mode === "rest" || mode === "dimmed");

  return (
    <div
      data-clip-id={clip.id}
      aria-label={compact ? `${name}, starts ${formatTimecode(span.start)}` : name}
      aria-selected={selected}
      role="option"
      tabIndex={focusable ? 0 : -1}
      onPointerDown={onBodyPointerDown}
      onMouseDown={keepFocus}
      onContextMenu={onContextMenu}
      className={cn(
        // The focus ring, outside the box, marks the focused clip apart from the others a group selection rings
        "group absolute overflow-hidden rounded-md bg-edit-field select-none outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane",
        mode === "moving"
          ? MOVING_CLIP
          : mode === "lifted"
            ? cn(LIFTED_CLIP, "ring-1 ring-white/20")
            : mode === "dimmed" && "opacity-40",
        trimEdge === "in" && "z-1",
        // Stacked: the body drags on both axes; only the row grip's drag lifts a box, up or down
        compact && mode === "rest" && "cursor-grab",
        compact && mode === "lifted" && "cursor-ns-resize",
      )}
      style={{ left: x, top, width, height }}
    >
      <Filmstrip
        frames={view?.frames ?? []}
        duration={view?.duration ?? null}
        inSec={inSec}
        pxPerSec={pxPerSec}
        width={width}
        boxX={x}
        viewLeft={viewLeft}
        viewRight={viewRight}
      />
      {overlay}
      {ringed && <span aria-hidden="true" data-selected-ring="" className={SELECTED_RING} />}

      {/* A box lifted to a new place says which clip it is */}
      {mode === "lifted" && (
        <span className={cn(LENGTH_CHIP, "left-1.5 right-auto font-medium")}>{name}</span>
      )}
      {/* A box in motion keeps its length, without the buttons a press would reach */}
      {(atRest || mode === "moving") && width >= MIN_CHIP_BOX_PX && (
        // On hover, and on keyboard focus (the box is the group), as the length is drawn nowhere else
        <span
          className={cn(
            LENGTH_CHIP,
            trimEdge || mode === "moving" ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        >
          {formatSeconds(lengthSec, trimEdge ? 2 : 1)}
        </span>
      )}

      {clip.muted && ((atRest && !soundButtons) || mode === "moving") && (
        <span aria-hidden="true" data-muted-mark="" className={cn(MUTED_BADGE, badgeTop, badgeLeft)}>
          <VolumeX size={11} strokeWidth={2} />
        </span>
      )}
      {atRest && clip.muted && soundButtons && (
        <button
          type="button"
          aria-label="Unmute clip audio"
          aria-hidden="true"
          tabIndex={-1}
          title="Clip audio muted"
          onPointerDown={stopPress}
          onMouseDown={keepFocus}
          onClick={(event) => {
            if (!selectsClip(event)) setClipMuted(clip.id, false);
          }}
          className={cn(
            "absolute z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-300 hover:text-neutral-100",
            badgeTop,
            badgeLeft,
          )}
        >
          <VolumeX size={11} strokeWidth={2} />
        </button>
      )}
      {atRest && !clip.muted && !trimEdge && soundButtons && (
        <button
          type="button"
          aria-label="Mute clip audio"
          aria-hidden="true"
          tabIndex={-1}
          onPointerDown={stopPress}
          onMouseDown={keepFocus}
          onClick={(event) => {
            if (!selectsClip(event)) setClipMuted(clip.id, true);
          }}
          className={cn(
            "absolute z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-100 opacity-0 group-hover:opacity-100",
            badgeTop,
            compact ? badgeLeft : "right-4",
          )}
        >
          <Volume1 size={11} strokeWidth={2} />
        </button>
      )}

      {showHandles && (
        <>
          <EdgeHandle
            side="in"
            width={handleWidth}
            selected={handlesWhite}
            active={trimEdge === "in"}
            onPointerDown={(event) => onHandlePointerDown(event, "in")}
          />
          <EdgeHandle
            side="out"
            width={handleWidth}
            selected={handlesWhite}
            active={trimEdge === "out"}
            onPointerDown={(event) => onHandlePointerDown(event, "out")}
          />
        </>
      )}
    </div>
  );
}
