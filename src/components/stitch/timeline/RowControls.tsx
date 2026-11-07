"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
} from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Spline, Volume1, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { hiddenAudioRows, type AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { formatSeconds } from "@/lib/stitch/timecode";
import type { ClipSpan } from "@/lib/stitch/timeline";
import {
  canLineUp,
  lineUpClips,
  openLibraryPicker,
  toggleAudioRowExpanded,
  toggleMusicMute,
  toggleRowMute,
} from "../editorActions";
import { EDITOR_PANEL_SELECTOR, GEOMETRY, TEXT_GHOST } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import { audioRowName } from "./AudioLane";
import { keepFocus } from "./ClipBox";
import { openClipMenu } from "./ClipsLane";

/** A row control's square, px: the 20px side padding holds it, 2px clear of either edge. */
const CONTROL_PX = 16;
/**
 * How far in from the timeline's left edge the controls sit, px: their focus ring clears the hairline beside the
 * timeline (the media pane's edge) and, as the padding is 20px, the playhead's line at 0:00.
 */
const CONTROL_INSET_PX = 2;
/** An audio row's group: its two controls stacked, 2px apart. */
const AUDIO_GROUP_PX = CONTROL_PX * 2 + 2;
/** The room under each audio row's block, px. */
const ROW_GAP = GEOMETRY.audioRow - GEOMETRY.audioBlock;

/**
 * A row control: 16px, quiet until hovered, white while on (a muted row, an open curve). Its focus ring is drawn inside
 * it, as the padding it sits in has no room around it.
 */
const ROW_CONTROL =
  "inline-flex shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors hover:bg-white/8 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * A group shown only on its row's hover or keyboard focus (its layer passes presses through to the lanes): hidden, it
 * takes no press but keeps its tab stops.
 */
const groupShown = (shown: boolean) =>
  shown ? "pointer-events-auto opacity-100" : "opacity-0 focus-within:pointer-events-auto focus-within:opacity-100";

/**
 * The row under the pointer in a layer (by its top and bottom on screen), from pointer moves anywhere over the
 * timeline: a row is hovered across its whole width, the lanes included. Null off the layer and while a button is
 * held for a drag that started elsewhere (a drag shows no row's controls). A press on the layer's own controls keeps
 * their row until its release, however the pointer drifts, so the click still lands on them. Only a change renders.
 */
function useHoveredRow(
  rootRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  rowAt: (y: number) => number | null,
): number | null {
  const [row, setRow] = useState<number | null>(null);
  const rowAtRef = useRef(rowAt);
  useEffect(() => {
    rowAtRef.current = rowAt;
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // A press on one of the layer's controls, until its release
    let held = false;
    const rowFor = (event: PointerEvent) => {
      const layer = layerRef.current;
      if (!layer) return null;
      const rect = layer.getBoundingClientRect();
      const inside = event.clientY >= rect.top && event.clientY < rect.bottom;
      return inside ? rowAtRef.current(event.clientY - rect.top) : null;
    };
    const onMove = (event: PointerEvent) => {
      if (held) return;
      setRow(event.buttons !== 0 ? null : rowFor(event));
    };
    const onRelease = (event: PointerEvent) => {
      held = false;
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
      const rect = root.getBoundingClientRect();
      const over =
        event.type === "pointerup" &&
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom;
      setRow(over ? rowFor(event) : null);
    };
    const onDown = (event: PointerEvent) => {
      const layer = layerRef.current;
      if (held || !layer || !(event.target instanceof Node) || !layer.contains(event.target)) return;
      held = true;
      window.addEventListener("pointerup", onRelease, true);
      window.addEventListener("pointercancel", onRelease, true);
    };
    const onLeave = () => {
      if (!held) setRow(null);
    };
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
    };
  }, [rootRef, layerRef]);
  return row;
}

/**
 * The row of the audio clip that has keyboard focus, if one has: read from the draft at render, so a clip moved to
 * another row with the keys (⌥↑ / ⌥↓), which keeps its box and its focus, takes its row's controls with it.
 */
function useFocusedAudioRow(rootRef: RefObject<HTMLElement | null>): number | null {
  const [clipId, setClipId] = useState<string | null>(null);
  const row = useStitchEditorStore((s) =>
    clipId === null ? null : (s.draft?.audioClips.find((c) => c.id === clipId)?.row ?? null),
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = (event: FocusEvent) => {
      setClipId(event.target instanceof HTMLElement ? (event.target.dataset.audioClipId ?? null) : null);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) setClipId(null);
    };
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [rootRef]);
  return row;
}

/** One audio row as its controls show it. */
export interface AudioRowState {
  /** Every clip on it is muted. */
  muted: boolean;
  /** It holds a clip (a row a move emptied holds none until the rows close up). */
  hasClips: boolean;
}

/**
 * What an audio row's header did, in the timeline's 20px left padding: a
 * small floating group per row, its mute (every clip on it; unmuted when all
 * are muted) over the volume-curve toggle, which makes the row taller to
 * edit its clips' curves (one row at a time). A group shows while its row is
 * hovered (anywhere across the lanes), while keyboard focus is in it or on
 * one of its clips, and while its row is open; hidden, it keeps its tab
 * stops and labels. A press on it keeps it shown until its release, so a
 * click whose pointer drifts still lands. It sits at the foot of its row's
 * block in both heights and the row grows upward, so the toggle stays under
 * the pointer. With no audio at all only a legacy node's muted music can be
 * unmuted there, and that button stays. The groups scroll with the rows, by
 * the same translate.
 */
export function AudioRowControls({
  rootRef,
  layout,
  scroll,
  expandedRow,
  rows,
  legacyMuted,
  bottom,
  onViewScroll,
}: {
  /** The timeline: a row is hovered from anywhere over it. */
  rootRef: RefObject<HTMLElement | null>;
  layout: AudioSectionLayout;
  /** The rows' scroll, shared with the lanes. */
  scroll: number;
  expandedRow: number | null;
  rows: readonly AudioRowState[];
  /** No audio clip at all: the one row is a placeholder, and only a legacy node's muted music can be unmuted there. */
  legacyMuted: boolean;
  /** The rows' view's bottom above the timeline's: the strip and the room kept for a horizontal scrollbar, px. */
  bottom: number;
  /** The view was scrolled by the browser (focus moved into a hidden row): the scroll joins the shared translate. */
  onViewScroll: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const placeholder = rows.length === 0;
  const hovered = useHoveredRow(rootRef, layerRef, (y) => {
    const at = y + scroll;
    const row = layout.rowTops.findIndex((top, i) => at >= top && at < top + layout.rowHeights[i]);
    return row === -1 ? null : row;
  });
  const focused = useFocusedAudioRow(rootRef);

  return (
    <div
      ref={layerRef}
      data-audio-section=""
      className="pointer-events-none absolute left-0 z-5 overflow-hidden"
      style={{ bottom, height: layout.viewHeight, width: GEOMETRY.origin }}
      onScroll={onViewScroll}
    >
      <div
        data-testid="stitch-audio-controls"
        className="absolute inset-x-0 top-0"
        style={{ height: layout.rowsHeight, transform: `translateY(${-scroll}px)` }}
      >
        {layout.rowTops.map((top, row) => {
          const info = rows[row];
          const expanded = row === expandedRow;
          const muted = placeholder ? legacyMuted : (info?.muted ?? false);
          const canMute = placeholder ? legacyMuted : (info?.hasClips ?? false);
          if (placeholder && !legacyMuted) return null;
          const muteLabel = muted ? `Unmute ${audioRowName(row)}` : `Mute ${audioRowName(row)}`;
          // Each row's own, as its mute's is: a list of buttons tells the rows apart
          const toggleLabel = `${expanded ? "Hide" : "Show"} volume curve for ${audioRowName(row)}`;
          const shown = hovered === row || focused === row || expanded || placeholder;
          return (
            <div
              key={row}
              role="group"
              aria-label={audioRowName(row)}
              data-audio-row-controls={row}
              className={cn(
                "absolute flex flex-col items-center gap-0.5 rounded-md bg-pane transition-opacity",
                groupShown(shown),
              )}
              style={{
                left: CONTROL_INSET_PX,
                top: top + layout.rowHeights[row] - ROW_GAP - (placeholder ? CONTROL_PX : AUDIO_GROUP_PX),
              }}
            >
              <button
                type="button"
                aria-label={muteLabel}
                title={muteLabel}
                disabled={!canMute}
                onMouseDown={keepFocus}
                onClick={() => (placeholder ? toggleMusicMute() : toggleRowMute(row))}
                className={cn(ROW_CONTROL, muted && "text-neutral-100")}
                style={{ width: CONTROL_PX, height: CONTROL_PX }}
              >
                {muted ? <VolumeX size={12} strokeWidth={1.5} /> : <Volume1 size={12} strokeWidth={1.5} />}
              </button>
              {!placeholder && (
                <button
                  type="button"
                  aria-label={toggleLabel}
                  title={toggleLabel}
                  aria-expanded={expanded}
                  onMouseDown={keepFocus}
                  onClick={() => toggleAudioRowExpanded(row)}
                  className={cn(ROW_CONTROL, expanded && "bg-edit-pressed text-neutral-100")}
                  style={{ width: CONTROL_PX, height: CONTROL_PX }}
                >
                  <Spline size={12} strokeWidth={1.5} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Stacked's rows, for a grip per clip. */
export interface StackedRowGrips {
  spans: readonly ClipSpan[];
  /** The grips' inner block: the timeline writes its translateY as the lanes scroll, with no render. */
  rowsRef: RefObject<HTMLDivElement | null>;
  /** The lanes' vertical scroll now, for the row under the pointer. */
  scrollTop: () => number;
  /** The rows' visible height, under the ruler. */
  viewport: number;
  /**
   * A press on a grip is a press on its clip: a click selects it (⌘ and ⇧ as on its box), a drag moves it up or down,
   * with the rest of the selection when it is one of several.
   */
  onRowPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => void;
}

/**
 * What Stacked's row headers did, in the timeline's 20px left padding: a
 * grip per row, shown while the row is hovered (and through a press on it,
 * until its drag starts), that drags its clip up or down only (a box's body
 * drags it in time too) and opens its clip's menu on a right press. A
 * pointer shortcut, as the header was: ⌥↑ / ⌥↓ and the clip menu move rows
 * from the keyboard. The grips scroll with the rows, through a transform the
 * timeline writes straight to them.
 */
export function StackedRowHandles({
  rootRef,
  dragging,
  grips,
}: {
  rootRef: RefObject<HTMLElement | null>;
  /** A grip's drag is running: the grips give way to the lifted clip. */
  dragging: boolean;
  grips: StackedRowGrips;
}) {
  const { spans, rowsRef, scrollTop, viewport, onRowPointerDown } = grips;
  const layerRef = useRef<HTMLDivElement>(null);
  const hovered = useHoveredRow(rootRef, layerRef, (y) => {
    const row = Math.floor((y + scrollTop()) / GEOMETRY.stackRow);
    return row >= 0 && row < spans.length ? row : null;
  });
  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute left-0 z-5 overflow-hidden"
      style={{ top: GEOMETRY.ruler, height: Math.max(0, viewport), width: GEOMETRY.origin }}
    >
      <div
        ref={rowsRef}
        data-testid="stitch-row-grips"
        className="absolute inset-x-0 top-0"
        style={{ height: Math.max(1, spans.length) * GEOMETRY.stackRow }}
      >
        {spans.map((span, i) => (
          <div
            key={span.clip.id}
            aria-hidden="true"
            data-row-grip={span.clip.id}
            onPointerDown={(event) => onRowPointerDown(event, span.clip.id, i)}
            onMouseDown={keepFocus}
            onContextMenu={(event) => openClipMenu(event, span.clip.id)}
            className={cn(
              "absolute flex cursor-grab items-center justify-center rounded-[5px] bg-pane text-ink-3 transition-opacity select-none hover:text-neutral-100",
              hovered === i && !dragging ? "pointer-events-auto opacity-100" : "opacity-0",
            )}
            style={{
              left: CONTROL_INSET_PX,
              top: i * GEOMETRY.stackRow + GEOMETRY.stackClipTop,
              width: CONTROL_PX,
              height: GEOMETRY.stackClipHeight,
            }}
          >
            <GripVertical size={12} strokeWidth={1.5} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stacked's Line up: every clip back where Overlap lays it out, once some clip has been placed by hand. */
function LineUpButton() {
  const enabled = useStitchEditorStore(canLineUp);
  const overlapSec = useStitchEditorStore((s) => s.draft?.sequenceLayout.overlapSec ?? 0);
  const title = !enabled
    ? "The clips are lined up"
    : overlapSec > 0
      ? `Line up: each clip starts ${formatSeconds(overlapSec, 1)} before the one above ends`
      : "Line up: each clip starts where the one above ends";
  return (
    <button
      type="button"
      title={title}
      disabled={!enabled}
      onClick={(event) => {
        // It is disabled once the clips are lined up: focus on it goes to the panel, never <body>
        const button = event.currentTarget;
        lineUpClips();
        if (document.activeElement === button) button.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)?.focus({ preventScroll: true });
      }}
      className={cn(TEXT_GHOST, "pointer-events-auto")}
    >
      Line up
    </button>
  );
}

/**
 * The quiet line under the last audio row, over the lanes' strip (where a
 * dragged audio clip drops onto a new row): "+ Audio", which opens Add media
 * on audio (off while the library is); in Stacked, Line up; and at the
 * right, how many audio rows are out of view. It gives way to the strip's
 * "New row" while a dragged clip would land there.
 */
export function TimelineFoot({
  layout,
  scroll,
  stacked,
  bottom,
  landingNewRow,
}: {
  layout: AudioSectionLayout;
  scroll: number;
  stacked: boolean;
  /** The room kept under it for a horizontal scrollbar, px. */
  bottom: number;
  landingNewRow: boolean;
}) {
  const libraryOn = useLibraryAvailable();
  // Rows past the view show no edge of their own: the line counts them
  const hidden = hiddenAudioRows(scroll, layout);
  const hiddenTitle = [
    hidden.above > 0 ? `${hidden.above} audio row${hidden.above === 1 ? "" : "s"} above` : "",
    hidden.below > 0 ? `${hidden.below} audio row${hidden.below === 1 ? "" : "s"} below` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      data-testid="stitch-timeline-foot"
      className={cn("pointer-events-none absolute inset-x-0 z-5 flex items-center gap-1 pr-4", landingNewRow && "invisible")}
      // The + of "+ Audio" lines up with 0:00
      style={{ bottom, height: GEOMETRY.audioStrip, paddingLeft: GEOMETRY.origin - 6 }}
    >
      <button
        type="button"
        aria-label="Add audio"
        title={libraryOn ? "Add audio" : "The asset library is off"}
        disabled={!libraryOn}
        onClick={() => openLibraryPicker("audio")}
        className={cn(TEXT_GHOST, "pointer-events-auto")}
      >
        <Plus size={12} strokeWidth={1.5} />
        Audio
      </button>
      {stacked && <LineUpButton />}
      {hiddenTitle && (
        <span
          data-testid="stitch-audio-hidden-rows"
          title={`${hiddenTitle}: scroll over the rows`}
          className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-ink-3"
        >
          <span className="sr-only">{hiddenTitle}</span>
          {hidden.above > 0 && (
            <span aria-hidden="true" className="flex items-center">
              <ChevronUp size={12} strokeWidth={1.5} />
              {hidden.above}
            </span>
          )}
          {hidden.below > 0 && (
            <span aria-hidden="true" className="flex items-center">
              <ChevronDown size={12} strokeWidth={1.5} />
              {hidden.below}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
