"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type UIEvent,
} from "react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { audioRowCount } from "@/lib/stitch/audioClips";
import { libraryDropAt } from "@/lib/stitch/libraryInsert";
import { clampAudioScroll, revealAudioRow, scrollKeepingRowBottom, type AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { clipName } from "@/lib/stitch/labels";
import { gaps as envelopeGaps, weightPieces, type WeightPiece } from "@/lib/stitch/placement";
import { stackedInsertionY } from "@/lib/stitch/reorder";
import { clipIdsOf, type HitBox } from "@/lib/stitch/selection";
import { DEFAULT_SEQUENCE_LAYOUT, effectiveOverlapSec } from "@/lib/stitch/stack";
import {
  clipSpans,
  isPlaced,
  layoutSpans,
  moveClip,
  pinStarts,
  shiftRows,
  spansEnvelope,
  topSpanAt,
  type ClipSpan,
} from "@/lib/stitch/timeline";
import type { StitchAudioClip, StitchTimelineClip } from "@/types";
import { buildTimeAxis } from "@/lib/stitch/timeAxis";
import { insetBox, laneBoxes, liveSpans, stackedBoxes, trimEdgeX } from "@/lib/stitch/laneLayout";
import { liveFitZoom } from "../liveFitZoom";
import { GEOMETRY, LANE_TRAILING_PX, EDITOR_PANEL_SELECTOR, TIMELINE_EDGE_PX } from "../editorStyles";
import { drawnPlayhead, editorAudioLengthOf } from "../editorActions";
import { applyAudioBoxSelection, clearClipSelection } from "../selectionActions";
import type { AudioClipView, ClipMediaView } from "../useStitchEditorMedia";
import { AudioLane, audioBoxes } from "./AudioLane";
import { keepFocus } from "./ClipBox";
import { ClipContextMenu } from "./ClipContextMenu";
import { ClipsLane } from "./ClipsLane";
import { libraryDrop } from "./libraryDrop";
import { LibraryDropMarker } from "./LibraryDropMarker";
import { MoveOverlay } from "./MoveOverlay";
import { Playhead } from "./Playhead";
import { AudioRowControls, StackedRowHandles, TimelineFoot, type AudioRowState } from "./RowControls";
import { Ruler } from "./Ruler";
import { StackedClipsLane, type LaneMarks } from "./StackedClipsLane";
import { TrimMarks, TrimOverlay } from "./TrimOverlay";
import { useClipMove } from "./useClipMove";
import { useAudioClipDrag } from "./useAudioClipDrag";
import { useClipReorder } from "./useClipReorder";
import { useMarqueeSelect } from "./useMarqueeSelect";
import type { TimelineZoom } from "./useTimelineZoom";
import { timelineLayout } from "./timelineLayout";
import { useTrimDrag } from "./useTrimDrag";

/** Lane pixels drawn beyond each side of the view, so a short scroll shows no blank edge. */
const OVERSCAN = 120;
/** ⌘ wheel / pinch: zoom by e^(−deltaY / this). */
const WHEEL_ZOOM_SCALE = 200;
const NO_CLIPS: StitchTimelineClip[] = [];
const NO_AUDIO: StitchAudioClip[] = [];
const NO_GAPS: ReadonlyArray<{ fromSec: number; toSec: number }> = [];
/** A clip moved by the keys or the rail to a place out of view is scrolled to this far inside the lanes' left, px. */
const REVEAL_INSET_PX = 64;
/**
 * A fade at an edge of Stacked's rows view: a 0px sticky line in the lanes' flow (over the rows, under the playhead's
 * line and the ruler), hidden until paintRowFades marks it shown.
 */
const ROWS_FADE = "pointer-events-none sticky z-1 h-0 opacity-0 transition-opacity duration-150 data-shown:opacity-100";

/** The scroller as measured after layout; until then, what the height leaves without a scrollbar. */
interface RowsMeasure {
  /** The lanes' horizontal scrollbar now, px (0 while it is hidden, or drawn over the lanes). */
  hBar: number;
  /** The lanes' visible height, scrollbar aside. */
  client: number;
  /** A horizontal scrollbar's thickness on this system, shown or not (0 where scrollbars are drawn over the content), px. */
  bar: number;
}

/** Scrolls Stacked's rows just enough to show row `index` whole in a viewport `viewport` px tall. */
function revealRow(el: HTMLElement | null, index: number, viewport: number): void {
  if (!el || index < 0) return;
  const top = index * GEOMETRY.stackRow;
  const bottom = top + GEOMETRY.stackRow;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + viewport) el.scrollTop = bottom - viewport;
}

/**
 * Stacked's rows fade into the ruler and the audio section where more of them are scrolled out of view that way: a
 * row cut by either edge then reads as one that scrolls, not one the edge covers. Written straight to the fades on
 * each scroll, as the grips' transform is.
 */
function paintRowFades(
  el: HTMLElement | null,
  fades: { top: HTMLElement | null; bottom: HTMLElement | null },
  rows: { overflow: boolean; height: number; viewport: number },
): void {
  if (!el) return;
  const scroll = el.scrollTop;
  const set = (fade: HTMLElement | null, shown: boolean) => {
    if (!fade) return;
    if (shown) fade.dataset.shown = "";
    else delete fade.dataset.shown;
  };
  set(fades.top, rows.overflow && scroll > 0.5);
  set(fades.bottom, rows.overflow && scroll < rows.height - rows.viewport - 0.5);
}

/** Stacked's rows view grew by `grown` px at its top: the rows scroll up by as much, so they stay put on screen. */
function showRowsAbove(el: HTMLElement | null, grown: number): void {
  if (!el || !(grown > 0) || el.scrollTop <= 0) return;
  el.scrollTop = Math.max(0, el.scrollTop - grown);
}

/** Scrolls the lanes so a box wholly out of view sits REVEAL_INSET_PX inside their left; whether they scrolled. */
function revealBox(el: HTMLElement | null, box: { x: number; width: number }): boolean {
  if (!el) return false;
  if (box.x + box.width > el.scrollLeft && box.x < el.scrollLeft + el.clientWidth) return false;
  el.scrollLeft = Math.max(0, box.x - REVEAL_INSET_PX);
  return true;
}


/**
 * The timeline under the stage, on the pane colour under a hairline, with
 * no track headers: the lanes run its full width, 0:00 sitting 20px in. They
 * scroll sideways and hold the ruler, the video (Track's clips row or
 * Stacked's rows), the audio section at the bottom and the playhead. What
 * the headers did floats in the 20px left padding (RowControls): an audio
 * row's mute and volume-curve toggle on the row's hover or keyboard focus,
 * and Stacked's row grips on hover only (from the keys, ⌥↑ / ⌥↓ and the clip
 * menu move rows); scrolled sideways, the lanes pass under that padding,
 * which covers them there. "+ Audio" (with Line up in Stacked) is a
 * quiet line under the last audio row, and the playhead's line ends above it. The zoom comes from useTimelineZoom (shared
 * with the control row); ⌘ wheel or a pinch zooms around the pointer, any
 * other wheel scrolls. Selection is a white ring; the selection box is a
 * faint white rectangle.
 *
 * Its height (timelineLayout) is what its rows need for the layout in use:
 * the ruler, Track's clips row or Stacked's rows, the audio rows and the
 * strip, within the room the editor leaves it (maxHeight), plus the room a
 * horizontal scrollbar takes on this system, kept whether it shows or not
 * (none where scrollbars are drawn over the content), so zooming past Fit
 * moves nothing. Selecting anything never changes it. A switch of
 * Track | Stacked does, which would move the control row (the toggle in it)
 * from under the pointer: while the pointer is over that row the editor
 * holds the height the timeline had (heldHeight), and it settles once the
 * pointer leaves. Its top edge drags it taller or shorter (chosenHeight,
 * TimelineResizeHandle): the rows' views grow into the room past their caps,
 * Stacked's rows first. The audio section is the same in both layouts: its rows
 * scroll inside it by a translate this component owns (audioScroll), shared
 * with their controls. A row's volume-curve toggle expands it upward with
 * the scroll corrected, so the toggle stays under the pointer.
 *
 * Stacked has one 52px row per clip, up to three and a half rows high; more
 * scroll vertically between a sticky ruler and the sticky audio section, in
 * the same scroller as the sideways scroll, and the row grips follow the
 * scroll through a transform written straight to them (no render per
 * scroll). The rows fade into the ruler and into the audio section where
 * more of them are out of view that way, so the half row the view ends on
 * reads as one that scrolls; a view that grows (the height settling after
 * the control row's hold) shows the rows above first. A plain wheel over
 * the audio section scrolls the audio rows (when they overflow) and nothing
 * else; elsewhere it scrolls Stacked's rows when they overflow; ⇧ wheel
 * scrolls along the timeline. The row of the clip
 * that drives the preview, or of a clip selected by a key, is scrolled into
 * view, and so is an audio clip's row.
 *
 * In Stacked a clip's box drags it in time and across rows (useClipMove),
 * its row's grip across rows only (useClipReorder). A placed stack (some
 * clip placed by hand) marks how each clip layers and where the gaps are;
 * every drag draws them from the timeline its release will leave. Audio
 * boxes drag in time and across audio rows, and trim by their edges, in
 * either layout (useAudioClipDrag). A clip moved out of view by the rail or
 * the keys is scrolled back into view, and so is a new clip that becomes the
 * selection (a paste, a duplicate).
 *
 * Several clips can be selected (a ⌘- or ⇧-click, the selection box drawn
 * on empty lane space, ⌘A); a drag of one of them carries them all. A
 * selection holds video clips or audio clips: the box selects the kind of
 * lane it starts on.
 */
export function Timeline({
  spans,
  media,
  audio,
  zoom,
  srcFor,
  stacked = false,
  maxHeight = Infinity,
  heldHeight = null,
  chosenHeight = null,
  onHeight,
}: {
  spans: readonly ClipSpan[];
  media: ReadonlyMap<string, ClipMediaView>;
  /** Each audio clip's view (useStitchEditorMedia). */
  audio: ReadonlyMap<string, AudioClipView>;
  zoom: TimelineZoom;
  /** The playable URL of a clip's source, for the frame under a dragged handle. */
  srcFor: (clipId: string) => string | null;
  /** The draft's layout is Stacked: one row per clip, placed anywhere in time. */
  stacked?: boolean;
  /** The most the editor lets the timeline take (the stage keeps GEOMETRY.stageFloor); Infinity while unmeasured. */
  maxHeight?: number;
  /** The height to keep while the pointer is over the control row (what heightRef read as it came in); null otherwise. */
  heldHeight?: number | null;
  /** The height its top edge was dragged to, a scrollbar's room included; null fits the rows. */
  chosenHeight?: number | null;
  /** Told the height the timeline is drawn at as it changes (the editor's hold and its resize handle). */
  onHeight?: (height: number) => void;
}) {
  const { axis, axisNow, scroller, scrollerRef, laneWidth, scrollPosition } = zoom;
  const rootRef = useRef<HTMLDivElement>(null);
  const barProbeRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gripRowsRef = useRef<HTMLDivElement>(null);
  const fadeTopRef = useRef<HTMLDivElement>(null);
  const fadeBottomRef = useRef<HTMLDivElement>(null);
  const audioViewRef = useRef<HTMLDivElement>(null);
  const selectedId = useStitchEditorStore((s) => (s.selection?.kind === "clip" ? s.selection.clipId : null));
  const selection = useStitchEditorStore((s) => s.selection);
  const layout = useStitchEditorStore((s) => s.draft?.sequenceLayout ?? DEFAULT_SEQUENCE_LAYOUT);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline ?? NO_CLIPS);
  const audioClips = useStitchEditorStore((s) => s.draft?.audioClips ?? NO_AUDIO);
  const legacyMuted = useStitchEditorStore((s) => s.draft?.legacyAudio.muted ?? false);
  const expandedRow = useStitchEditorStore((s) => s.audioExpandedRow);
  const durations = useStitchEditorStore((s) => s.durations);
  const audioDurations = useStitchEditorStore((s) => s.audioDurations);
  const overlapSec = effectiveOverlapSec(layout);
  // The lanes' scroll position, for virtualising ticks and frames: the zoom publishes its own scrolls in the same
  // tick, so the drawn range never lags them. Their width is the zoom's own measurement.
  const scrollLeft = useSyncExternalStore(scrollPosition.subscribe, scrollPosition.get, scrollPosition.get);

  const placed = stacked && isPlaced(timeline);
  const order = useMemo(() => timeline.map((c) => c.id), [timeline]);
  const selectedIds = useMemo(
    (): ReadonlySet<string> => new Set(selection?.kind === "clip" ? clipIdsOf(selection, order) : []),
    [selection, order],
  );
  const audioOrder = useMemo(() => audioClips.map((c) => c.id), [audioClips]);
  const selectedAudio = useMemo(
    (): ReadonlySet<string> => new Set(selection?.kind === "audio" ? clipIdsOf(selection, audioOrder) : []),
    [selection, audioOrder],
  );
  const audioLeadId = selection?.kind === "audio" ? selection.clipId : null;
  const selectedPoint = selection?.kind === "audio" ? selection.point : null;

  const { trim, onHandlePointerDown, takeReleased: takeTrimReleased } = useTrimDrag(axisNow, contentRef);
  const restBoxes = useMemo(
    () => (stacked ? stackedBoxes(axis, spans, GEOMETRY.emptySlot) : laneBoxes(axis, spans, null)),
    [stacked, axis, spans],
  );
  // Stacked draws a trim as release leaves it: an In edge moves the clip's start, and nothing else moves
  const trimTimeline = stacked ? (trim?.timeline ?? null) : null;
  const drawnSpans = useMemo(
    () => (trimTimeline ? layoutSpans(trimTimeline, durations, layout) : spans),
    [trimTimeline, spans, durations, layout],
  );
  const boxes = useMemo(() => {
    if (!stacked) return laneBoxes(axis, spans, trim);
    return drawnSpans === spans ? restBoxes : stackedBoxes(axis, drawnSpans, GEOMETRY.emptySlot);
  }, [stacked, axis, spans, trim, drawnSpans, restBoxes]);
  // Where release leaves the playhead: on the live spans' axis while a trim lengthens a clip (Stacked's is linear)
  const playheadAxis = useMemo(() => {
    const live = stacked ? spans : liveSpans(spans, trim);
    return live === spans ? axis : buildTimeAxis(live, axis.pxPerSec, GEOMETRY.origin, GEOMETRY.emptySlot);
  }, [stacked, axis, spans, trim]);

  // The height: what the layout in use needs within the room the editor leaves, whatever is selected, or the height
  // its top edge was dragged to; while the pointer is over the control row, the height it had then. Under the rows it keeps room for a horizontal scrollbar
  // where the system draws one beside the content (none where it is drawn over it), shown or not: zooming in past Fit
  // then changes no height, and moves nothing above
  const audioRowTotal = audioRowCount(audioClips);
  const [measured, setMeasured] = useState<RowsMeasure | null>(null);
  const hBar = measured?.hBar ?? 0;
  const reserve = Math.max(measured?.bar ?? 0, hBar);
  const room = Math.min(maxHeight, heldHeight ?? Infinity) - reserve;
  const sized = useMemo(
    () =>
      timelineLayout(
        spans.length,
        audioRowTotal,
        expandedRow,
        stacked,
        room,
        chosenHeight === null ? null : chosenHeight - reserve,
      ),
    [spans.length, audioRowTotal, expandedRow, stacked, room, chosenHeight, reserve],
  );
  const height = Math.max(sized.height + reserve, heldHeight === null ? 0 : Math.min(heldHeight, maxHeight));
  useLayoutEffect(() => {
    onHeight?.(height);
  }, [onHeight, height]);
  const audioLayout = sized.audio;
  const [audioScrollState, setAudioScroll] = useState(0);
  const audioScroll = clampAudioScroll(audioScrollState, audioLayout);

  // Stacked geometry: the rows' viewport is measured from the scroller, so the scrollbars never clip the audio section
  const rowCount = Math.max(1, spans.length);
  const rowsHeight = rowCount * GEOMETRY.stackRow;
  // The 1px top edge and the scrollbar's room are all between the timeline's height and the scroller's visible height
  const clientHeight = measured?.client ?? height - TIMELINE_EDGE_PX - reserve;
  const rowsViewport = clientHeight - GEOMETRY.ruler - audioLayout.sectionHeight;
  const rowsOverflow = stacked && rowsHeight > rowsViewport;
  const rowsBlock = Math.max(rowsHeight, rowsViewport);
  // The audio section's top in the lanes' visible box (it is pinned to their bottom in both layouts)
  const sectionTop = clientHeight - audioLayout.sectionHeight;

  // Each size change of the scroller (the timeline's height, a scrollbar appearing either way, the page's zoom)
  // measures it again, and the system's scrollbar on a probe that always has one
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (!(el.clientHeight > 0)) return;
      const probe = barProbeRef.current;
      const next = {
        hBar: el.offsetHeight - el.clientHeight,
        client: el.clientHeight,
        bar: probe ? Math.max(0, probe.offsetHeight - probe.clientHeight) : 0,
      };
      setMeasured((prev) =>
        prev && prev.hBar === next.hBar && prev.client === next.client && prev.bar === next.bar ? prev : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scroller]);

  // The volume-line toggle grows or shrinks a row: the scroll keeps the toggled row's bottom (and its toggle) in place
  const shownAudio = useRef<{ expandedRow: number | null; layout: AudioSectionLayout }>({ expandedRow, layout: audioLayout });
  useLayoutEffect(() => {
    const before = shownAudio.current;
    shownAudio.current = { expandedRow, layout: audioLayout };
    if (before.expandedRow === expandedRow) return;
    const toggled = expandedRow ?? before.expandedRow;
    if (toggled === null) return;
    setAudioScroll((scroll) =>
      scrollKeepingRowBottom(clampAudioScroll(scroll, before.layout), toggled, before.layout, audioLayout),
    );
  }, [expandedRow, audioLayout]);

  const rowsView = () => {
    const el = scroller.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top + GEOMETRY.ruler;
    return { top, bottom: top + latest.current.rowsViewport };
  };
  const reorderOptions = { stacked, rowCount: spans.length, rowsView };
  // The lanes' content width as last drawn, for a body drag's release
  const drawnWidth = useRef(0);
  // Track: a clip's body reorders it. Stacked: a row's grip does, and a box's body moves it in time and across rows
  const { reorder, onBodyPointerDown, takeReleased: takeRowReleased } = useClipReorder(restBoxes, contentRef, reorderOptions);
  const { move, onMovePointerDown, pressing, takeReleased: takeMoveReleased, releasedWidth } = useClipMove(axisNow, contentRef, {
    rowCount: spans.length,
    rowsView,
    drawnWidth: () => drawnWidth.current,
  });
  // The selection box hits the boxes as drawn: Track's inset at their joins, Stacked's in their rows
  const hitBoxes = (): HitBox[] => {
    const { stacked: inStacked, restBoxes: rest } = latest.current;
    return rest.map((box, i) =>
      inStacked
        ? {
            x: box.x,
            width: box.width,
            top: GEOMETRY.ruler + i * GEOMETRY.stackRow + GEOMETRY.stackClipTop,
            height: GEOMETRY.stackClipHeight,
          }
        : { ...insetBox(box, i, rest.length), top: GEOMETRY.ruler + GEOMETRY.clipTop, height: GEOMETRY.clipHeight },
    );
  };
  const { marquee, onLanePointerDown, pressing: marqueePressing } = useMarqueeSelect(contentRef, {
    stacked,
    hitBoxes,
    order: () => latest.current.spans.map((span) => span.clip.id),
    rowsView: stacked ? rowsView : () => null,
    bounds: () => ({
      top: GEOMETRY.ruler,
      bottom: GEOMETRY.ruler + (stacked ? spans.length * GEOMETRY.stackRow : GEOMETRY.clipRow),
    }),
  });

  const audioBoxList = useMemo(
    () => audioBoxes(axis, audioClips, audio, audioDurations),
    [axis, audioClips, audio, audioDurations],
  );
  // The audio section's top in the lanes' content: pinned to the visible bottom, so it follows Stacked's scroll
  const sectionContentTop = () => {
    const el = scroller.current;
    return (el?.scrollTop ?? 0) + latest.current.sectionTop;
  };
  const audioDrag = useAudioClipDrag(axisNow, contentRef, {
    layout: () => latest.current.audioLayout,
    scroll: () => latest.current.audioScroll,
    setScroll: setAudioScroll,
    viewRect: () => audioViewRef.current?.getBoundingClientRect() ?? null,
    videoSpans: () => latest.current.spans,
    nameOf: (clipId) => latest.current.audio.get(clipId)?.fileName ?? "Audio",
  });
  const audioMarquee = useMarqueeSelect(contentRef, {
    stacked: true,
    kind: "audio",
    hitBoxes: () => {
      const { audioBoxList: list, audioLayout: l, audioScroll: scroll, expandedRow: expanded } = latest.current;
      const top = sectionContentTop() - scroll;
      return list.map((box) => ({
        x: box.x,
        width: box.width,
        top: top + (l.rowTops[box.clip.row] ?? 0) + GEOMETRY.audioBlockTop,
        height: box.clip.row === expanded ? GEOMETRY.audioBlockExpanded : GEOMETRY.audioBlock,
      }));
    },
    order: () => latest.current.audioBoxList.map((box) => box.clip.id),
    rowsView: () => null,
    bounds: () => {
      const top = sectionContentTop();
      return { top, bottom: top + latest.current.audioLayout.viewHeight };
    },
    commit: applyAudioBoxSelection,
    clear: clearClipSelection,
  });
  // While a box is drawn, what it would select is drawn selected
  const drawnSelectedIds = marquee ? marquee.selectedIds : selectedIds;
  const drawnAudioIds = audioMarquee.marquee ? audioMarquee.marquee.selectedIds : selectedAudio;
  // From what is drawn, so the clips a running box touches already show the group look release gives them.
  const multi = drawnSelectedIds.size > 1;

  // Latest values for the handlers bound once (the wheel, the scroll, the playback follow, the drags)
  const latestValues = {
    zoom,
    stacked,
    rowsOverflow,
    rowsHeight,
    rowsViewport,
    spans,
    restBoxes,
    pressing,
    marqueePressing,
    audio,
    audioBoxList,
    audioLayout,
    audioScroll,
    expandedRow,
    sectionTop,
    audioPressing: audioDrag.pressing,
    audioMarqueePressing: audioMarquee.pressing,
  };
  const latest = useRef(latestValues);
  useEffect(() => {
    latest.current = latestValues;
  });

  // A drag from the Edit video view's media pane asks where it would drop from the lanes as drawn now
  useEffect(
    () =>
      libraryDrop.register(
        (clientX, clientY, item, opts) => {
          const el = scroller.current;
          const content = contentRef.current;
          const s = useStitchEditorStore.getState();
          if (!el || !content || !s.draft) return null;
          const view = el.getBoundingClientRect();
          if (clientX < view.left || clientX >= view.left + el.clientWidth) return null;
          if (clientY < view.top || clientY >= view.top + el.clientHeight) return null;
          const live = latest.current;
          const box = content.getBoundingClientRect();
          const lengthOf = editorAudioLengthOf(s);
          const snapTimes = [
            drawnPlayhead(s),
            ...live.spans.flatMap((span) => (span.length > 0 ? [span.start, span.end] : [])),
            ...s.draft.audioClips.flatMap((clip) => [clip.startSec, clip.startSec + lengthOf(clip)]),
          ];
          return libraryDropAt(
            s.draft,
            item,
            { x: clientX - box.left, viewY: clientY - view.top, contentY: clientY - box.top, snap: opts?.snap ?? false },
            {
              stacked: live.stacked,
              axis: live.zoom.axis,
              boxes: live.restBoxes,
              rowHeight: GEOMETRY.stackRow,
              ruler: GEOMETRY.ruler,
              sectionTop: live.sectionTop,
              audioLayout: live.audioLayout,
              audioScroll: live.audioScroll,
              snapTimes,
            },
            lengthOf,
          );
        },
        () => scroller.current,
      ),
    [scroller],
  );

  // A lined-up stack draws a grip-lifted clip (or each of a lifted group) at the start it will have in the order it
  // would drop into; a placed one keeps every start, so the lifted boxes keep their x
  const liftId = stacked && reorder ? reorder.clipId : null;
  const liftIds = stacked && reorder ? reorder.clipIds : null;
  const liftFrom = reorder?.index ?? -1;
  const liftTo = reorder?.dropIndex ?? -1;
  /** The row move a grip drag's release makes: one clip's, or a group's with its spacing kept. */
  const liftMove = useCallback(
    (from: StitchTimelineClip[]) =>
      liftIds && liftIds.length > 1 ? shiftRows(from, new Set(liftIds), liftTo - liftFrom) : moveClip(from, liftFrom, liftTo),
    [liftIds, liftFrom, liftTo],
  );
  const liftedX = useMemo(() => {
    if (!liftIds || placed) return null;
    const xs = new Map<string, number>();
    for (const span of clipSpans(liftMove(timeline), durations, overlapSec)) {
      if (liftIds.includes(span.clip.id)) xs.set(span.clip.id, axis.timeToX(span.start));
    }
    return xs;
  }, [liftIds, liftMove, placed, timeline, durations, overlapSec, axis]);

  // The timeline the marks are drawn from: the one release would leave while a drag runs (a body drag always pins, so
  // its marks are placed ones in a lined-up stack too), else the draft's
  const markTimeline = useMemo(() => {
    if (!stacked) return null;
    if (move) return move.timeline;
    if (trimTimeline) return trimTimeline;
    if (liftId !== null && placed) return liftMove(pinStarts(timeline, durations, layout.overlapSec));
    return timeline;
  }, [stacked, move, trimTimeline, liftId, liftMove, placed, timeline, durations, layout.overlapSec]);
  const markSpans = useMemo(() => {
    if (!markTimeline || markTimeline === timeline) return spans;
    return markTimeline === trimTimeline ? drawnSpans : layoutSpans(markTimeline, durations, layout);
  }, [markTimeline, timeline, spans, trimTimeline, drawnSpans, durations, layout]);
  const markEnvelope = markTimeline && isPlaced(markTimeline) ? spansEnvelope(markSpans, layout.crossfade) : null;
  const pxPerSec = axis.pxPerSec;
  const marks = useMemo((): LaneMarks | null => {
    if (!markEnvelope || !markTimeline) return null;
    const pieces = new Map<string, readonly WeightPiece[]>();
    for (const span of markSpans) {
      const unit = markEnvelope.units.findIndex((u) => u.row === span.index);
      if (unit !== -1) pieces.set(span.clip.id, weightPieces(markEnvelope, unit, pxPerSec));
    }
    // Rows keep their names until release: a covering clip is named by its row at the press
    const coverName = (row: number) => {
      const id = markTimeline[row]?.id;
      const at = timeline.findIndex((clip) => clip.id === id);
      return clipName(at === -1 ? row : at);
    };
    return { pieces, coverName };
  }, [markEnvelope, markTimeline, markSpans, timeline, pxPerSec]);
  const gapBands = useMemo(() => (markEnvelope ? envelopeGaps(markEnvelope) : NO_GAPS), [markEnvelope]);

  // The rail and the keys move clips from outside the lane: in Fit they keep the zoom this lane draws at
  useLayoutEffect(() => {
    liveFitZoom.set(axis.pxPerSec);
  });
  useEffect(() => () => liveFitZoom.set(null), []);

  useEffect(() => {
    const el = scroller.current;
    const root = rootRef.current;
    if (!el || !root) return;
    // A scroll event comes at most once a frame, before it is painted
    const onScroll = () => {
      scrollPosition.set(el.scrollLeft);
      const rows = gripRowsRef.current;
      if (rows) rows.style.transform = `translateY(${-el.scrollTop}px)`;
      const live = latest.current;
      paintRowFades(
        el,
        { top: fadeTopRef.current, bottom: fadeBottomRef.current },
        { overflow: live.rowsOverflow, height: live.rowsHeight, viewport: live.rowsViewport },
      );
    };
    // Native and non-passive, so a wheel over the timeline neither scrolls the page nor reaches anything behind. Bound on
    // the whole timeline: a wheel over a row's controls (Stacked's grips, an audio row's group) scrolls what the
    // pointer is over, as one over the lanes does
    const onWheel = (event: WheelEvent) => {
      // The clip menu is drawn inside the timeline: a wheel over it is the menu's, and moves nothing behind it
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      event.preventDefault();
      const live = latest.current;
      if (event.ctrlKey || event.metaKey) {
        // Not mid-drag: a drag measures from the zoom it started at, and a box's press (or the selection box's) from
        // its press
        const busy = [live.pressing, live.marqueePressing, live.audioPressing, live.audioMarqueePressing].some((p) => p.current);
        if (useStitchEditorStore.getState().cancelGesture || busy) return;
        const z = live.zoom;
        const viewX = Math.max(0, event.clientX - el.getBoundingClientRect().left);
        z.zoomAround(z.pxPerSec * Math.exp(-event.deltaY / WHEEL_ZOOM_SCALE), viewX);
        return;
      }
      // Over the audio section a vertical wheel is the audio rows' alone: it scrolls them when they overflow, and
      // never Stacked's rows behind. The gutter beside them counts as theirs
      const view = audioViewRef.current?.getBoundingClientRect();
      const overAudio =
        event.target instanceof Element &&
        (event.target.closest("[data-audio-section]") !== null ||
          (event.target.closest("[data-timeline-gutter]") !== null &&
            view !== undefined &&
            event.clientY >= view.top &&
            event.clientY < view.bottom));
      if (overAudio && !event.shiftKey) {
        if (event.deltaY !== 0 && live.audioLayout.maxScroll > 0) {
          setAudioScroll((scroll) => clampAudioScroll(clampAudioScroll(scroll, live.audioLayout) + event.deltaY, live.audioLayout));
        }
        el.scrollLeft += event.deltaX;
        return;
      }
      // Stacked rows that overflow take the vertical wheel; ⇧ keeps it for the sideways scroll
      if (live.rowsOverflow && !event.shiftKey) {
        el.scrollTop += event.deltaY;
        el.scrollLeft += event.deltaX;
        return;
      }
      el.scrollLeft += event.deltaX !== 0 ? event.deltaX : event.deltaY;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", onWheel);
    };
  }, [scroller, scrollPosition]);

  // The rows' view grown (the height settling once the pointer leaves the control row, a taller window) shows the rows
  // above first, as the timeline grows upward: the rows stay where they were on screen. A row a selection revealed in
  // the smaller view stays in view, and a switch to Stacked made with a clip selected no longer leaves Clip 1 half
  // under the ruler
  const shownRows = useRef({ stacked, viewport: rowsViewport });
  useLayoutEffect(() => {
    const before = shownRows.current;
    shownRows.current = { stacked, viewport: rowsViewport };
    const el = scroller.current;
    if (stacked && before.stacked) showRowsAbove(el, rowsViewport - before.viewport);
  }, [stacked, rowsViewport, scroller]);

  // The grips are mounted again on a switch to Stacked: they start where the rows are, and so do the rows' fades
  useLayoutEffect(() => {
    const el = scroller.current;
    const rows = gripRowsRef.current;
    if (el && rows) rows.style.transform = `translateY(${-el.scrollTop}px)`;
    paintRowFades(
      el,
      { top: fadeTopRef.current, bottom: fadeBottomRef.current },
      { overflow: rowsOverflow, height: rowsHeight, viewport: rowsViewport },
    );
  });

  // A switch of layout (the toggle, ⌘Z) swaps the lane and Line up: focus on them is removed with them. It goes to
  // the new lane's tab stop, or the dialog, never <body>, so the arrows and Tab carry on from there
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!focusInside.current || (active && active !== document.body && active.isConnected)) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? root?.closest<HTMLElement>(EDITOR_PANEL_SELECTOR);
    target?.focus({ preventScroll: true });
  }, [stacked]);

  // While the preview plays, the row of the clip it is driven by stays in view (as the playhead does sideways)
  useEffect(
    () =>
      useStitchEditorStore.subscribe((s) => {
        const live = latest.current;
        if (!s.playing || !live.stacked || !live.rowsOverflow) return;
        const span = topSpanAt(live.spans, s.playhead);
        if (span) revealRow(scroller.current, span.index, live.rowsViewport);
      }),
    [scroller],
  );

  // A clip selected some other way (a key, a split), or moved to another row while selected (an undo or redo of a
  // reorder), is scrolled into view
  const selectedRow = selectedId === null ? -1 : spans.findIndex((s) => s.clip.id === selectedId);
  useEffect(() => {
    if (!stacked || selectedRow === -1) return;
    revealRow(scroller.current, selectedRow, latest.current.rowsViewport);
  }, [stacked, selectedId, selectedRow, scroller]);

  // From a press anywhere in the timeline to its release. A press lets a focused field go, and a Start typed there
  // commits then: the lanes must not scroll away from under the pointer
  const pressDown = useRef(false);
  const onPressCapture = () => {
    pressDown.current = true;
    const done = () => {
      pressDown.current = false;
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
    };
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  };

  // The selected clip moved by the rail's Start, the keys or an undo to a place wholly out of view is scrolled to
  // 64px inside the lanes. Never for a move made in the timeline: not while a press is down (a Start committed by the
  // press), and not for what a drag's release applies (a box's body, a row's grip, a trim handle), which lands where
  // it was drawn
  const selectedStart = stacked && selectedRow !== -1 ? spans[selectedRow].start : null;
  const selectedBox = selectedRow === -1 ? null : restBoxes[selectedRow];
  const shownStart = useRef<{ id: string; start: number } | null>(null);
  useEffect(() => {
    const before = shownStart.current;
    shownStart.current = selectedId !== null && selectedStart !== null ? { id: selectedId, start: selectedStart } : null;
    // Each is taken, so a release that moved nothing the reveal watches is not left over for the next change
    const released = [takeMoveReleased(), takeRowReleased(), takeTrimReleased()];
    if (pressDown.current || released.includes(selectedId)) return;
    if (!selectedBox || !before || before.id !== selectedId || before.start === selectedStart) return;
    const el = scroller.current;
    if (el && revealBox(el, selectedBox)) scrollPosition.set(el.scrollLeft);
  }, [selectedId, selectedStart, selectedBox, scroller, scrollPosition, takeMoveReleased, takeRowReleased, takeTrimReleased]);

  // A new clip that becomes the selection (a paste, a duplicate) is brought into view, and takes focus from the clip
  // that had it, so the arrows carry on from there
  const knownIds = useRef<ReadonlySet<string> | null>(null);
  const leadRow = selectedId === null ? -1 : spans.findIndex((s) => s.clip.id === selectedId);
  const leadBox = leadRow === -1 ? null : restBoxes[leadRow];
  useEffect(() => {
    const before = knownIds.current;
    knownIds.current = new Set(order);
    if (!before || selectedId === null || before.has(selectedId) || !leadBox) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active instanceof HTMLElement && active.getAttribute("role") === "option" && root.contains(active)) {
      const option = Array.from(root.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (el) => el.dataset.clipId === selectedId,
      );
      if (option && option !== active) option.focus();
    }
    const el = scroller.current;
    if (el && revealBox(el, leadBox)) scrollPosition.set(el.scrollLeft);
  }, [order, selectedId, leadBox, scroller, scrollPosition]);

  // The lead audio clip's row is scrolled into view when the lead, its row or the set of audio clips changes some
  // way other than a press (a key, a paste, an undo): a click lands where it was drawn. Any other audio edit (a row's
  // mute, a curve) leaves the rows where they are. A new audio clip that becomes the lead (a paste, a duplicate, an
  // add from the library) is brought into view sideways too, and takes focus from a focused audio box
  const audioLead = audioLeadId === null ? null : (audioBoxList.find((box) => box.clip.id === audioLeadId) ?? null);
  const audioLeadRow = audioLead?.clip.row ?? -1;
  const knownAudio = useRef<ReadonlySet<string> | null>(null);
  const revealedLead = useRef<{ id: string | null; row: number } | null>(null);
  useEffect(() => {
    const before = knownAudio.current;
    knownAudio.current = new Set(audioOrder);
    const lead = revealedLead.current;
    revealedLead.current = { id: audioLeadId, row: audioLeadRow };
    const sameIds = before !== null && before.size === audioOrder.length && audioOrder.every((id) => before.has(id));
    if (sameIds && lead?.id === audioLeadId && lead.row === audioLeadRow) return;
    if (!audioLead || pressDown.current) return;
    setAudioScroll((scroll) => revealAudioRow(clampAudioScroll(scroll, latest.current.audioLayout), audioLeadRow, latest.current.audioLayout));
    if (!before || before.has(audioLead.clip.id)) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active instanceof HTMLElement && active.dataset.audioClipId !== undefined && root.contains(active)) {
      root.querySelector<HTMLElement>(`[data-audio-clip-id="${CSS.escape(audioLead.clip.id)}"]`)?.focus({ preventScroll: true });
    }
    const el = scroller.current;
    if (el && revealBox(el, audioLead)) scrollPosition.set(el.scrollLeft);
    // The lead and its row; its box is read when they change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioLeadId, audioLeadRow, audioOrder]);

  const empty = spans.length === 0;
  const stackedRight = stacked
    ? restBoxes.reduce((right, box, i) => (spans[i].length > 0 ? right : Math.max(right, box.x + box.width)), axis.endX)
    : axis.endX;
  // Audio may sit past the last frame: the lanes reach the right-most audio box
  const audioRight = audioBoxList.reduce((right, box) => Math.max(right, box.x + box.width), 0);
  const moveBox = move ? restBoxes[move.index] : undefined;
  // A box dragged past the end widens the lanes with it, so they can scroll on under it
  const movedRight = move && moveBox ? move.x + moveBox.width : 0;
  const audioMove = audioDrag.drag?.kind === "move" ? audioDrag.drag : null;
  const audioMovedRight = audioMove
    ? Math.max(
        0,
        ...audioBoxList
          .filter((box) => audioMove.clipIds.includes(box.clip.id))
          .map((box) => box.x + box.width + audioMove.result.deltaSec * axis.pxPerSec),
      )
    : 0;
  // A body drag that shortens the sequence keeps the width it was drawn at until the lanes scroll back from it: the
  // browser would otherwise pull a scroll at the end back by what was lost, and every box would jump on release
  const heldWidth = releasedWidth && releasedWidth.pxPerSec === axis.pxPerSec ? Math.min(releasedWidth.width, scrollLeft + laneWidth) : 0;
  const contentWidth = Math.max(
    Math.max(stackedRight, movedRight, audioRight, audioMovedRight) + LANE_TRAILING_PX,
    laneWidth,
    heldWidth,
  );
  useLayoutEffect(() => {
    drawnWidth.current = contentWidth;
  });
  const viewLeft = scrollLeft - OVERSCAN;
  const viewRight = scrollLeft + Math.max(laneWidth, 1) + OVERSCAN;
  const visibleRight = laneWidth > 0 ? scrollLeft + laneWidth : contentWidth;
  const trimView = trim ? media.get(trim.clipId) : undefined;
  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  const trimBox = trimIndex === -1 ? null : boxes[trimIndex];
  const edgeX = trim && trimBox ? trimEdgeX(trimBox, trim.edge) : 0;
  const trimRowTop = GEOMETRY.ruler + trimIndex * GEOMETRY.stackRow + GEOMETRY.stackClipTop;
  const trimRow = stacked && trimIndex !== -1 ? { top: trimRowTop, bottom: trimRowTop + GEOMETRY.stackClipHeight } : undefined;
  const rowDrag = stacked ? (reorder ?? move) : null;
  const insertionY = rowDrag ? stackedInsertionY(rowDrag.dropIndex, rowDrag.index, GEOMETRY.stackRow) : null;
  const snappedToPlayhead =
    trim?.result.snapped?.kind === "playhead" ||
    move?.result.snapped?.kind === "playhead" ||
    (audioDrag.drag?.kind === "move" && audioDrag.drag.result.snapped?.kind === "playhead") ||
    (audioDrag.drag?.kind === "trim" && audioDrag.drag.snapped?.kind === "playhead");
  // The moving box as the lane draws it: its row's top plus the travel (clamped to the rows by useClipMove)
  const moveTop = move ? move.index * GEOMETRY.stackRow + GEOMETRY.stackClipTop + move.dy : 0;
  const moveTargetRow = move?.result.snapped?.row ?? null;
  // A group's chip spans every moved clip, read from the timeline release leaves
  const moveGroup = useMemo(() => {
    if (!move || move.clipIds.length <= 1) return null;
    const moved = markSpans.filter((span) => move.clipIds.includes(span.clip.id));
    if (moved.length === 0) return null;
    return { fromSec: Math.min(...moved.map((s) => s.start)), toSec: Math.max(...moved.map((s) => s.end)) };
  }, [move, markSpans]);
  const marqueeRect = marquee?.drawn ?? audioMarquee.marquee?.drawn ?? null;
  const marqueeBox = marqueeRect ? (
    <div
      aria-hidden="true"
      data-testid="stitch-marquee"
      className="pointer-events-none absolute z-20 rounded-[2px] border border-white/40 bg-white/8"
      style={{
        left: marqueeRect.left,
        top: marqueeRect.top,
        width: marqueeRect.right - marqueeRect.left,
        height: marqueeRect.bottom - marqueeRect.top,
      }}
    />
  ) : null;

  const audioRows = useMemo((): AudioRowState[] => {
    const rows = Array.from({ length: audioRowCount(audioClips) }, () => ({ muted: true, hasClips: false }));
    for (const clip of audioClips) {
      rows[clip.row].hasClips = true;
      if (!clip.muted) rows[clip.row].muted = false;
    }
    return rows.map((row) => (row.hasClips ? row : { muted: false, hasClips: false }));
  }, [audioClips]);

  // Focus moved into a row out of view makes the browser scroll that view itself (the row controls' or the lanes'),
  // which would put the controls out of line with their rows: the scroll becomes the rows' shared translate
  const onAudioViewScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const view = event.currentTarget;
    const dy = view.scrollTop;
    if (dy === 0) return;
    view.scrollTop = 0;
    const layout = latest.current.audioLayout;
    setAudioScroll((scroll) => clampAudioScroll(clampAudioScroll(scroll, layout) + dy, layout));
  }, []);

  const audioLane = (
    <AudioLane
      axis={axis}
      boxes={audioBoxList}
      views={audio}
      layout={audioLayout}
      scroll={audioScroll}
      expandedRow={expandedRow}
      selectedIds={drawnAudioIds}
      leadId={audioLeadId}
      selectedPoint={selectedPoint}
      drag={audioDrag.drag}
      viewLeft={viewLeft}
      viewRight={viewRight}
      visibleRight={visibleRight}
      contentWidth={contentWidth}
      contentRef={contentRef}
      viewRef={audioViewRef}
      guideTop={GEOMETRY.playheadHead - sectionTop}
      scrollLeft={scrollLeft}
      laneWidth={laneWidth}
      onBodyPointerDown={audioDrag.onBodyPointerDown}
      onHandlePointerDown={audioDrag.onHandlePointerDown}
      onLanePointerDown={audioMarquee.onLanePointerDown}
      onViewScroll={onAudioViewScroll}
    />
  );

  return (
    <div
      ref={rootRef}
      data-testid="stitch-timeline"
      className="relative flex shrink-0 overflow-hidden border-t border-edit-line bg-pane"
      style={{ height }}
      onPointerDownCapture={onPressCapture}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
      }}
    >
      <div
        ref={scrollerRef}
        data-testid="stitch-lanes"
        className={cn("relative min-w-0 flex-1 overflow-x-auto", rowsOverflow ? "overflow-y-auto" : "overflow-y-hidden")}
        // The scrollbar's room stays under the lanes while it is hidden
        style={{ marginBottom: reserve - hBar }}
      >
        {stacked ? (
          <div
            ref={contentRef}
            className="relative"
            style={{ width: contentWidth, height: GEOMETRY.ruler + rowsBlock + audioLayout.sectionHeight }}
          >
            <div className="sticky top-0 z-4 bg-pane" style={{ height: GEOMETRY.ruler }}>
              <Ruler
                axis={axis}
                axisNow={axisNow}
                viewLeft={viewLeft}
                viewRight={Math.min(viewRight, contentWidth)}
                maxX={contentWidth}
                contentRef={contentRef}
                showLabels={!empty}
              />
              {gapBands.map((gap) => (
                <div
                  key={gap.fromSec}
                  aria-hidden="true"
                  data-testid="stitch-ruler-gap"
                  className="pointer-events-none absolute bottom-0 h-[3px] bg-neutral-800"
                  style={{ left: axis.timeToX(gap.fromSec), width: axis.timeToX(gap.toSec) - axis.timeToX(gap.fromSec) }}
                />
              ))}
              {!empty && <Playhead axis={playheadAxis} limit={axis.total} hideLine={snappedToPlayhead} part="head" />}
            </div>
            {/* Under the ruler: shown while rows are scrolled out of view above (paintRowFades) */}
            <div
              ref={fadeTopRef}
              aria-hidden="true"
              data-testid="stitch-rows-fade-top"
              className={ROWS_FADE}
              style={{ top: GEOMETRY.ruler }}
            >
              <div className="absolute inset-x-0 top-0 h-4 bg-linear-to-b from-pane to-transparent" />
            </div>
            <div data-testid="stitch-rows" className="relative z-0" style={{ height: rowsBlock }}>
              <StackedClipsLane
                axis={axis}
                spans={drawnSpans}
                boxes={boxes}
                restBoxes={restBoxes}
                media={media}
                selectedId={selectedId}
                selectedIds={drawnSelectedIds}
                multi={multi}
                trim={trim}
                reorder={reorder}
                liftedX={liftedX}
                move={move}
                insertionY={insertionY}
                marks={marks}
                gaps={gapBands}
                crossfade={layout.crossfade}
                viewLeft={viewLeft}
                viewRight={viewRight}
                contentWidth={contentWidth}
                onBodyPointerDown={onMovePointerDown}
                onHandlePointerDown={onHandlePointerDown}
                onLanePointerDown={onLanePointerDown}
              />
            </div>
            {/* Over the audio section: shown while rows are scrolled out of view below (paintRowFades) */}
            <div
              ref={fadeBottomRef}
              aria-hidden="true"
              data-testid="stitch-rows-fade-bottom"
              className={ROWS_FADE}
              style={{ bottom: audioLayout.sectionHeight }}
            >
              <div className="absolute inset-x-0 bottom-0 h-4 bg-linear-to-t from-pane to-transparent" />
            </div>
            <div className="sticky bottom-0 z-2">{audioLane}</div>
            {/* Pinned to the rows' view, so the line runs from its top to the strip whatever the rows' scroll */}
            {!empty && (
              <div aria-hidden="true" className="pointer-events-none sticky bottom-0 z-3 h-0">
                <Playhead
                  axis={playheadAxis}
                  limit={axis.total}
                  hideLine={snappedToPlayhead}
                  part="line"
                  top={-clientHeight}
                  bottom={GEOMETRY.audioStrip}
                />
              </div>
            )}
            {trim && trimBox && (
              <TrimMarks trim={trim} axis={playheadAxis} edgeX={edgeX} scrollLeft={scrollLeft} row={trimRow} />
            )}
            {move && moveBox && (
              <MoveOverlay
                move={move}
                axis={axis}
                lengthSec={spans[move.index]?.length ?? 0}
                boxWidth={moveBox.width}
                boxTop={moveTop}
                targetBoxTop={
                  moveTargetRow === null ? null : moveTargetRow * GEOMETRY.stackRow + GEOMETRY.stackClipTop
                }
                scrollLeft={scrollLeft}
                laneWidth={laneWidth}
                group={moveGroup}
              />
            )}
            {marqueeBox}
            <LibraryDropMarker
              axis={axis}
              boxes={restBoxes}
              contentWidth={contentWidth}
              audioLayout={audioLayout}
              audioScroll={audioScroll}
              sectionContentTop={sectionContentTop}
            />
          </div>
        ) : (
          <div ref={contentRef} className="relative h-full" style={{ width: contentWidth }}>
            <Ruler
              axis={axis}
              axisNow={axisNow}
              viewLeft={viewLeft}
              viewRight={Math.min(viewRight, contentWidth)}
              maxX={contentWidth}
              contentRef={contentRef}
              showLabels={!empty}
            />
            <ClipsLane
              axis={axis}
              spans={spans}
              boxes={boxes}
              media={media}
              selectedId={selectedId}
              selectedIds={drawnSelectedIds}
              multi={multi}
              trim={trim}
              reorder={reorder}
              viewLeft={viewLeft}
              viewRight={viewRight}
              laneWidth={contentWidth}
              onBodyPointerDown={onBodyPointerDown}
              onHandlePointerDown={onHandlePointerDown}
              onLanePointerDown={onLanePointerDown}
            />
            <div className="absolute inset-x-0 bottom-0 z-2">{audioLane}</div>
            {trim && trimBox && <TrimMarks trim={trim} axis={playheadAxis} edgeX={edgeX} scrollLeft={scrollLeft} />}
            {/* Snapped to the playhead, the dashed guide stands in for its line, which ends at the strip */}
            {!empty && (
              <Playhead axis={playheadAxis} limit={axis.total} hideLine={snappedToPlayhead} bottom={GEOMETRY.audioStrip} />
            )}
            {marqueeBox}
            <LibraryDropMarker
              axis={axis}
              boxes={restBoxes}
              contentWidth={contentWidth}
              audioLayout={audioLayout}
              audioScroll={audioScroll}
              sectionContentTop={sectionContentTop}
            />
          </div>
        )}
      </div>
      {/* Scrolled, the lanes pass under the 20px side padding the row controls float in: it covers them there, and
          takes the presses, so nothing out of view is pressed through the controls */}
      {scrollLeft > 0 && (
        <div
          aria-hidden="true"
          data-testid="stitch-gutter"
          data-timeline-gutter=""
          className="absolute left-0 top-0 z-5 bg-pane"
          style={{ bottom: reserve, width: GEOMETRY.origin }}
          onMouseDown={keepFocus}
        />
      )}
      {stacked && (
        <StackedRowHandles
          rootRef={rootRef}
          dragging={reorder !== null}
          grips={{
            spans,
            rowsRef: gripRowsRef,
            scrollTop: () => scroller.current?.scrollTop ?? 0,
            viewport: rowsViewport,
            onRowPointerDown: onBodyPointerDown,
          }}
        />
      )}
      <AudioRowControls
        rootRef={rootRef}
        layout={audioLayout}
        scroll={audioScroll}
        expandedRow={expandedRow}
        rows={audioRows}
        legacyMuted={legacyMuted}
        bottom={reserve + GEOMETRY.audioStrip}
        onViewScroll={onAudioViewScroll}
      />
      <TimelineFoot
        layout={audioLayout}
        scroll={audioScroll}
        stacked={stacked}
        bottom={reserve}
        landingNewRow={audioDrag.drag?.kind === "move" && audioDrag.drag.landing?.kind === "append"}
      />
      {trim && trimBox && (
        <TrimOverlay
          trim={trim}
          edgeX={edgeX}
          view={trimView}
          src={srcFor(trim.clipId)}
          contentRef={contentRef}
          rowTop={trimRow?.top}
        />
      )}
      <ClipContextMenu media={media} audio={audio} />
      {/* Always scrolled sideways, so it measures the system's scrollbar (0 where it is drawn over the content) */}
      <div
        ref={barProbeRef}
        aria-hidden="true"
        data-testid="stitch-scrollbar-probe"
        className="pointer-events-none invisible absolute left-0 top-0 h-10 w-10 overflow-x-scroll overflow-y-hidden"
      />
    </div>
  );
}
