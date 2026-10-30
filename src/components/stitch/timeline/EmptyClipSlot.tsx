"use client";

import { useId, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { Spinner } from "@/components/nodes/ui/Spinner";
import { clipName } from "@/lib/stitch/labels";
import { formatTimecode } from "@/lib/stitch/timecode";
import { clipLength, type ClipSpan } from "@/lib/stitch/timeline";
import { GEOMETRY, LIFTED_CLIP, MOVING_CLIP, SELECTED_RING } from "../editorStyles";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { keepFocus, type ClipBoxMode } from "./ClipBox";

/** Why a clip has no length on the timeline. */
export function emptyReason(
  span: ClipSpan,
  view: ClipMediaView | undefined,
): "gone" | "loading" | "error" | "past-end" | "under-frame" | "empty" {
  if (view?.missing) return "gone";
  if (view?.status === "loading") return "loading";
  if (view?.status === "error") return "error";
  if (view?.status === "ready" && view.duration !== null) {
    if (span.clip.inSec >= view.duration) return "past-end";
    // A source generated again shorter can leave a trim under one output frame, which the encode drops
    if (view.duration > 0 && clipLength(span.clip, view.duration) === 0) return "under-frame";
  }
  return "empty";
}

const COPY = {
  empty: "not generated yet",
  loading: "loading",
  error: "can't read this video",
  gone: "not in the library",
  "past-end": "trim starts past the end",
  "under-frame": "trim is shorter than a frame",
} as const;

/**
 * A clip with no length: a source that has not run, one still being read
 * or one that cannot be, a library video the library no longer has, or a
 * trim that starts past the source's end or leaves less than a frame. It
 * keeps its place in the order as a fixed 160px slot that counts 0 s, and
 * can be selected like a clip (so Reset trim fixes a trim past the end).
 * In Stacked its whole slot is a body that drags it in time and across rows.
 * Why it has no length is its one line of text, in ink-3, and its accessible
 * description.
 */
export function EmptyClipSlot({
  span,
  view,
  x,
  width,
  selected,
  focusable,
  mode,
  top = GEOMETRY.clipTop,
  height = GEOMETRY.clipHeight,
  stacked = false,
  onBodyPointerDown,
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
  /** In its row: Track's clips row by default, a Stacked row's box otherwise. */
  top?: number;
  height?: number;
  /** In a Stacked row: its accessible name says where it starts. */
  stacked?: boolean;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const reason = emptyReason(span, view);
  const name = clipName(span.index);
  const reasonId = useId();
  return (
    <div
      data-clip-id={span.clip.id}
      data-empty-reason={reason}
      aria-label={stacked ? `${name}, starts ${formatTimecode(span.start)}` : name}
      aria-describedby={reasonId}
      aria-selected={selected}
      role="option"
      tabIndex={focusable ? 0 : -1}
      onPointerDown={onBodyPointerDown}
      onMouseDown={keepFocus}
      onContextMenu={onContextMenu}
      className={cn(
        "absolute flex items-center justify-center gap-1.5 overflow-hidden rounded-md border border-dashed border-white/20 bg-white/2 text-[11px] text-ink-3 select-none outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane",
        mode === "lifted" && cn(LIFTED_CLIP, "bg-edit-field"),
        mode === "moving" && cn(MOVING_CLIP, "bg-edit-field"),
        stacked && mode === "rest" && "cursor-grab",
        mode === "dimmed" && "opacity-40",
      )}
      style={{ left: x, top, width, height }}
    >
      {mode === "rest" && selected && (
        // Over the dashed edge, as a clip's ring is over its frames
        <span aria-hidden="true" data-selected-ring="" className={cn(SELECTED_RING, "-inset-px")} />
      )}
      {reason === "loading" ? (
        <Spinner size={13} className="shrink-0" />
      ) : (
        <CircleAlert size={13} strokeWidth={1.75} className="shrink-0" />
      )}
      {/* No side padding, as on the States board, so "not generated yet" fits one line; a longer reason wraps, balanced, rather than lose its end */}
      <span className="line-clamp-2 min-w-0 text-balance leading-[14px]">{`${name} · ${COPY[reason]}`}</span>
      {/* The description alone (its name is the label): hidden, which a description may still point to */}
      <span id={reasonId} hidden>
        {COPY[reason]}
      </span>
    </div>
  );
}
