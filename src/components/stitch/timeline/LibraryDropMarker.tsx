"use client";

import { useSyncExternalStore } from "react";
import type { AudioSectionLayout } from "@/lib/stitch/audioLayout";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { GEOMETRY } from "../editorStyles";
import { libraryDrop } from "./libraryDrop";

/** A sound or video of unknown length is drawn this wide. */
const UNKNOWN_WIDTH_PX = 48;
/** Where the item lands: a dashed outline, so it never reads as a selected clip (a solid white ring). */
const GHOST = "pointer-events-none absolute z-30 rounded-md border border-dashed border-white/40 bg-white/6";
const BAR = "pointer-events-none absolute z-30 bg-neutral-100";

/**
 * Where a library drag from the Edit video view's pane would drop, in the lanes' content: Track's insertion bar
 * between clips, Stacked's new row (a bar at the row boundary and the clip's box at its start), or an audio row's box.
 * Drawn from the drag channel's target, which is what release applies; nothing while there is none (always, in the
 * node's dialog).
 */
export function LibraryDropMarker({
  axis,
  boxes,
  contentWidth,
  audioLayout,
  audioScroll,
  sectionContentTop,
}: {
  axis: TimeAxis;
  /** The clip boxes at rest (Track's lane boxes). */
  boxes: ReadonlyArray<{ x: number; width: number }>;
  contentWidth: number;
  audioLayout: AudioSectionLayout;
  audioScroll: number;
  /** The audio section's top in the lanes' content, now. */
  sectionContentTop: () => number;
}) {
  const target = useSyncExternalStore(libraryDrop.subscribe, libraryDrop.get, () => null);
  const item = useSyncExternalStore(libraryDrop.subscribe, libraryDrop.item, () => null);
  if (!target || !item) return null;
  const width = item.durationSec !== null ? Math.max(4, item.durationSec * axis.pxPerSec) : UNKNOWN_WIDTH_PX;

  if (target.lane === "clips") {
    if (target.mode === "track") {
      const last = boxes[boxes.length - 1];
      const x = target.index < boxes.length ? boxes[target.index].x : last ? last.x + last.width : GEOMETRY.origin;
      return (
        <div
          data-testid="library-drop-marker"
          className={`${BAR} w-0.5`}
          style={{ left: x - 1, top: GEOMETRY.ruler + GEOMETRY.clipTop, height: GEOMETRY.clipHeight }}
        />
      );
    }
    if (target.mode !== "stacked") return null;
    const y = GEOMETRY.ruler + target.row * GEOMETRY.stackRow;
    return (
      <div data-testid="library-drop-marker">
        <div className={`${BAR} h-0.5`} style={{ left: 0, width: contentWidth, top: y - 1 }} />
        <div
          className={GHOST}
          style={{ left: axis.timeToX(target.startSec), width, top: y + GEOMETRY.stackClipTop, height: GEOMETRY.stackClipHeight }}
        />
      </div>
    );
  }

  const top = sectionContentTop();
  const left = axis.timeToX(target.startSec);
  if (target.newRow) {
    const boundary =
      target.row < audioLayout.rowTops.length ? audioLayout.rowTops[target.row] - audioScroll : audioLayout.viewHeight;
    const y = top + Math.min(Math.max(boundary, 0), audioLayout.viewHeight);
    return (
      <div data-testid="library-drop-marker">
        <div className={`${BAR} h-0.5`} style={{ left: 0, width: contentWidth, top: y - 1 }} />
        <div className={GHOST} style={{ left, width, top: y + 3, height: GEOMETRY.audioStrip - 6 }} />
      </div>
    );
  }
  const rowTop = top + (audioLayout.rowTops[target.row] ?? 0) - audioScroll;
  return (
    <div
      data-testid="library-drop-marker"
      className={GHOST}
      style={{ left, width, top: rowTop + GEOMETRY.audioBlockTop, height: GEOMETRY.audioBlock }}
    />
  );
}
