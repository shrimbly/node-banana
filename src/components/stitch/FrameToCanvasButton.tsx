"use client";

import { useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import { shownAt } from "@/lib/stitch/framePlan";
import { isPlaced, type ClipSpan } from "@/lib/stitch/timeline";
import { CONTROL_BUTTON } from "./editorStyles";
import { frameToCanvas } from "./frameToCanvas";
import type { ClipMediaView } from "./useStitchEditorMedia";

export interface FrameButtonInput {
  /** A capture is running. */
  busy: boolean;
  clipCount: number;
  /** Some clip's video is still being read. */
  loading: boolean;
  /** Some clip is ready with a size (the header's frame size is known). */
  hasVideo: boolean;
  /** The preview shows nothing at the playhead. */
  gap: boolean;
}

/**
 * The first row that applies wins. Busy comes first, so scrubbing into a gap during a capture neither hides the
 * spinner nor sets `disabled`, which would drop focus. With no clips the whole control row is inert, so that reason is
 * never shown (the empty stage says how to add clips); it still keeps the button off.
 */
export function frameButtonState(input: FrameButtonInput): { enabled: boolean; busy: boolean; reason: string | null } {
  if (input.busy) return { enabled: false, busy: true, reason: "Adding the frame…" };
  if (input.clipCount === 0) return { enabled: false, busy: false, reason: "Add clips to grab a frame" };
  if (input.loading) return { enabled: false, busy: false, reason: "Waiting for the clips to load" };
  if (!input.hasVideo) return { enabled: false, busy: false, reason: "No clip has a video yet" };
  if (input.gap) return { enabled: false, busy: false, reason: "Nothing plays at the playhead" };
  return { enabled: true, busy: false, reason: null };
}

/**
 * Whether no clip shows at the playhead (a gap, or no draft), worked out again only when the playhead or the draft
 * moves: the store calls it on every change.
 */
function gapSelector(spans: readonly ClipSpan[]): (s: StitchEditorState) => boolean {
  let last: { draft: unknown; playhead: number; gap: boolean } | null = null;
  return (s) => {
    if (last && last.draft === s.draft && last.playhead === s.playhead) return last.gap;
    const layout = s.draft?.sequenceLayout;
    const stack =
      layout?.mode === "stacked" ? { crossfade: layout.crossfade, placed: isPlaced(s.draft!.timeline) } : null;
    const gap = !layout || shownAt(spans, s.playhead, stack).size === 0;
    last = { draft: s.draft, playhead: s.playhead, gap };
    return gap;
  };
}

/**
 * Frame to canvas, an icon button in the control row under the video: the same button whatever is selected. Click or
 * Enter; Space plays, as everywhere in the editor. While the preview plays the press pauses it and takes the frame
 * where it stopped. Why it is off (or that it is busy) follows its name in its hover label, and is its accessible
 * description.
 */
export function FrameToCanvasButton({
  media,
  spans,
  frameSize,
  keepFocus,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  spans: readonly ClipSpan[];
  /** The sequence's frame size (the ⋯ menu's line); null while no clip is ready with one. */
  frameSize: { width: number; height: number } | null;
  /** The row's press handler: a click leaves focus where it was, so Space keeps playing. */
  keepFocus?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const reasonId = useId();
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  // Re-renders only when the playhead crosses into or out of a gap
  const gapAt = useMemo(() => gapSelector(spans), [spans]);
  const gap = useStitchEditorStore(gapAt);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const state = frameButtonState({
    busy,
    clipCount: timeline?.length ?? 0,
    loading: (timeline ?? []).some((clip) => media.get(clip.id)?.status === "loading"),
    hasVideo: frameSize !== null,
    gap,
  });

  const onClick = () => {
    if (running.current || !state.enabled || !frameSize) return;
    running.current = true;
    setBusy(true);
    frameToCanvas({ spans, media, size: frameSize })
      .catch((error: unknown) => console.error("[EditVideo] Frame to canvas failed:", error))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };

  return (
    // On the wrapper: a disabled button is never hovered itself
    <div className="group relative flex">
      <button
        type="button"
        aria-label={state.busy ? "Adding frame…" : "Frame to canvas"}
        aria-describedby={state.reason ? reasonId : undefined}
        // Busy stays focusable (aria-disabled, not disabled, which would drop focus) and ignores its clicks
        aria-busy={state.busy || undefined}
        aria-disabled={state.busy || undefined}
        disabled={!state.enabled && !state.busy}
        className={CONTROL_BUTTON}
        onMouseDown={keepFocus}
        onClick={state.busy ? undefined : onClick}
      >
        {state.busy ? (
          <LoaderCircle size={16} strokeWidth={1.5} className="animate-spin motion-reduce:animate-none" />
        ) : (
          <ImagePlus size={16} strokeWidth={1.5} />
        )}
      </button>
      {state.reason && (
        <span id={reasonId} className="sr-only">
          {state.reason}
        </span>
      )}
      {/* Its name always, and why it is off (or that it is busy) after it */}
      <Tooltip label="Frame to canvas" detail={state.reason ?? undefined} placement="top" />
    </div>
  );
}
