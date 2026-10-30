"use client";

import { memo, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Blend, Magnet, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { livePlayhead, subscribeLivePlayhead, useStitchEditorStore } from "@/store/stitchEditorStore";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from "@/lib/stitch/timeAxis";
import { formatTimecode } from "@/lib/stitch/timecode";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { goToEnd, goToStart, setCrossfade, togglePlay } from "./editorActions";
import { isTypingTarget } from "./editorKeys";
import { CONTROL_BUTTON, EDITOR_PANEL_SELECTOR } from "./editorStyles";
import { FrameToCanvasButton } from "./FrameToCanvasButton";
import { LayoutToggle } from "./LayoutToggle";
import type { TimelineZoom } from "./timeline/useTimelineZoom";
import type { ClipMediaView } from "./useStitchEditorMedia";

/**
 * A click must not take focus from the panel, or Space would press the button instead of playing. A timecode
 * well being edited is settled first (its blur commits), with focus handed to the panel, so the next Space plays
 * rather than typing into it.
 */
const keepFocus = (event: MouseEvent<HTMLElement>) => {
  if (isTypingTarget(document.activeElement)) {
    const panel = event.currentTarget.closest<HTMLElement>(EDITOR_PANEL_SELECTOR);
    if (panel) panel.focus();
    else (document.activeElement as HTMLElement).blur();
  }
  event.preventDefault();
};

/**
 * Where the row drops Fit, then − and +, as it narrows (the row is its own container): below these widths the
 * right-hand group no longer fits beside the time with Play still centred under the video. Twice the group's width
 * plus the middle (116) and the two 12px gaps: Track's group is 277px (five 32px buttons, the toggle's 66 with 4px
 * either side, Fit's 31, 2px between), 244 without Fit, 176 without − and +; Stacked's is wider by Crossfade (34).
 * Their keys (− = and ⇧Z) still zoom. Literal classes, so Tailwind sees them.
 */
const NARROW = {
  track: { fit: "@max-[695px]:hidden", zoom: "@max-[628px]:hidden" },
  stacked: { fit: "@max-[763px]:hidden", zoom: "@max-[696px]:hidden" },
} as const;

/** A button at its limit (Zoom in at the most, Zoom out at the least): dimmed as a disabled one, still focusable. */
const AT_LIMIT =
  "aria-disabled:cursor-default aria-disabled:text-neutral-600 aria-disabled:hover:bg-transparent aria-disabled:hover:text-neutral-600";

/** One of the row's icon buttons, with its hover label above it (into the stage). */
function ControlButton({
  label,
  tip = label,
  shortcut,
  keyshortcuts,
  pressed,
  atLimit = false,
  className,
  onClick,
  children,
}: {
  label: string;
  tip?: string;
  /** The key as the hover label draws it. */
  shortcut?: string;
  /** The key as aria-keyshortcuts names it, when the button has one of its own. */
  keyshortcuts?: string;
  pressed?: boolean;
  /**
   * It can go no further (a zoom at its limit): aria-disabled, its clicks ignored. Not disabled, which would drop the
   * focus of a keyboard user whose Enter took it there, out of the dialog's Tab trap.
   */
  atLimit?: boolean;
  /** On the wrapper, which holds the button and its label. */
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cn("group relative flex", className)}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={keyshortcuts}
        aria-disabled={atLimit || undefined}
        className={cn(CONTROL_BUTTON, AT_LIMIT)}
        onMouseDown={keepFocus}
        onClick={atLimit ? undefined : onClick}
      >
        {children}
      </button>
      <Tooltip label={tip} shortcut={shortcut} placement="top" />
    </div>
  );
}

/**
 * Where the playhead is, as drawn this frame: its text is written as the live playhead moves, never through a render
 * of the row.
 */
function PlayheadTime({ total }: { total: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const show = (t: number) => {
      const text = formatTimecode(Math.min(t, total));
      if (ref.current && ref.current.textContent !== text) ref.current.textContent = text;
    };
    show(livePlayhead());
    return subscribeLivePlayhead(show);
  }, [total]);
  return (
    <span ref={ref} className="text-neutral-100" data-testid="stitch-playhead">
      {formatTimecode(Math.min(livePlayhead(), total))}
    </span>
  );
}

/**
 * The control row under the video, as wide as the video (EditorStage sizes
 * it): the time at the left (where the playhead is, then the length); Go to
 * start, Play and Go to end in the middle; at the right Frame to canvas, Mute
 * all (the preview's sound), Crossfade (Stacked only), Track | Stacked, Snap,
 * the timeline's zoom (−, +) and Fit. Crossfade comes left of the toggle, so a
 * switch of layout never moves the toggle under the pointer. Narrow, the row
 * drops Fit, then − and +; their keys (− = and ⇧Z), ⌘ wheel and pinch still
 * zoom. Inert while the editor has no clips.
 */
export const EditorTransport = memo(function EditorTransport({
  total,
  empty,
  zoom,
  media,
  spans,
  frameSize,
}: {
  total: number;
  empty: boolean;
  zoom: Pick<TimelineZoom, "zoomIn" | "zoomOut" | "fit" | "pxPerSec">;
  /** Frame to canvas's: the clips' media, their spans and the sequence's frame size. */
  media: ReadonlyMap<string, ClipMediaView>;
  spans: readonly ClipSpan[];
  frameSize: { width: number; height: number } | null;
}) {
  const playing = useStitchEditorStore((s) => s.playing);
  const snap = useStitchEditorStore((s) => s.snap);
  const soundOn = useStitchEditorStore((s) => s.soundOn);
  const setSnap = useStitchEditorStore((s) => s.setSnap);
  const setSoundOn = useStitchEditorStore((s) => s.setSoundOn);
  const stacked = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode === "stacked");
  const crossfade = useStitchEditorStore((s) => s.draft?.sequenceLayout.crossfade ?? false);
  const narrow = stacked ? NARROW.stacked : NARROW.track;

  return (
    <div className={cn("@container w-full", empty && "pointer-events-none opacity-50")} inert={empty}>
      <div data-testid="stitch-controls" className="grid h-12 grid-cols-[1fr_auto_1fr] items-center gap-x-3">
        <div className="min-w-0 truncate whitespace-nowrap text-[13px] tabular-nums">
          <PlayheadTime total={total} />
          {/* A row narrower than its controls (a small window) keeps the playhead's time and drops the length */}
          <span className="text-ink-3 @max-[500px]:hidden">{` / ${formatTimecode(total)}`}</span>
        </div>

        <div className="flex items-center gap-2">
          <ControlButton label="Go to start" onClick={goToStart}>
            <SkipBack size={16} strokeWidth={1.5} />
          </ControlButton>
          <div className="group relative flex">
            <button
              type="button"
              aria-label={playing ? "Pause" : "Play"}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 text-neutral-950 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane"
              onMouseDown={keepFocus}
              onClick={togglePlay}
            >
              {playing ? (
                <Pause size={16} strokeWidth={1.5} fill="currentColor" />
              ) : (
                <Play size={16} strokeWidth={1.5} fill="currentColor" className="translate-x-px" />
              )}
            </button>
            <Tooltip label={playing ? "Pause" : "Play"} shortcut="Space" placement="top" />
          </div>
          <ControlButton label="Go to end" onClick={goToEnd}>
            <SkipForward size={16} strokeWidth={1.5} />
          </ControlButton>
        </div>

        {/* Never narrower than its buttons: below that the middle gives way, not the buttons */}
        <div className="flex items-center justify-end gap-0.5">
          <FrameToCanvasButton media={media} spans={spans} frameSize={frameSize} keepFocus={keepFocus} />
          <ControlButton label="Mute all" pressed={!soundOn} onClick={() => setSoundOn(!soundOn)}>
            {soundOn ? <Volume2 size={16} strokeWidth={1.5} /> : <VolumeX size={16} strokeWidth={1.5} />}
          </ControlButton>
          {stacked && (
            <ControlButton label="Crossfade" pressed={crossfade} onClick={() => setCrossfade(!crossfade)}>
              <Blend size={16} strokeWidth={1.5} />
            </ControlButton>
          )}
          <LayoutToggle className="mx-1" />
          <ControlButton label="Snap" tip="Snap · drag freely with" shortcut="⇧" pressed={snap} onClick={() => setSnap(!snap)}>
            <Magnet size={16} strokeWidth={1.5} />
          </ControlButton>
          <ControlButton
            label="Zoom out"
            shortcut="−"
            keyshortcuts="-"
            className={narrow.zoom}
            atLimit={zoom.pxPerSec <= MIN_PX_PER_SEC}
            onClick={zoom.zoomOut}
          >
            <ZoomOut size={16} strokeWidth={1.5} />
          </ControlButton>
          <ControlButton
            label="Zoom in"
            shortcut="="
            keyshortcuts="="
            className={narrow.zoom}
            atLimit={zoom.pxPerSec >= MAX_PX_PER_SEC}
            onClick={zoom.zoomIn}
          >
            <ZoomIn size={16} strokeWidth={1.5} />
          </ControlButton>
          <div className={cn("group relative flex", narrow.fit)}>
            <button
              type="button"
              // Its visible word first, then what it fits, as its hover label says
              aria-label="Fit the timeline"
              aria-keyshortcuts="Shift+Z"
              className="h-8 shrink-0 rounded-lg px-2 text-[13px] text-ink-3 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              onMouseDown={keepFocus}
              onClick={zoom.fit}
            >
              Fit
            </button>
            <Tooltip label="Fit the timeline" shortcut="⇧Z" placement="top" align="end" />
          </div>
        </div>
      </div>
    </div>
  );
});
