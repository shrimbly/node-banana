import { audioSectionLayout, type AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { GEOMETRY, TIMELINE_EDGE_PX as EDGE_PX } from "../editorStyles";

export interface TimelineLayout {
  /** The timeline's height, its top edge included and any horizontal scrollbar left out, px. */
  height: number;
  /** The video part between the ruler and the audio section, px: Track's clips row, or Stacked's rows view. */
  videoHeight: number;
  audio: AudioSectionLayout;
}

/**
 * The timeline's height: what its rows need, for the layout in use. The
 * ruler, then Track's clips row or Stacked's rows (up to three and a half),
 * then the audio rows (two show) and the strip with "+ Audio". It depends
 * on the layout, the number of clips and audio rows and the expanded audio
 * row, never on the selection, so a click moves nothing. Over maxHeight (the
 * room the editor leaves) Stacked's rows view gives way first, down to one
 * and a half rows, then the audio rows view, down to one row; it never goes
 * below GEOMETRY.timeline. The room for a horizontal scrollbar is the
 * timeline's to add.
 *
 * chosenHeight is the height its top edge was dragged to (null fits the
 * rows). It is kept within maxHeight and above GEOMETRY.timeline. Under what
 * the rows need, they give way as under maxHeight. Over it, Stacked's rows
 * view grows past its cap first, then the audio view; what is left stays
 * empty between the video part and the audio section.
 */
export function timelineLayout(
  clipCount: number,
  audioRowCount: number,
  expandedRow: number | null,
  stacked: boolean,
  maxHeight = Infinity,
  chosenHeight: number | null = null,
): TimelineLayout {
  if (chosenHeight !== null) {
    const target = Math.max(GEOMETRY.timeline, Math.min(chosenHeight, maxHeight));
    const fitted = timelineLayout(clipCount, audioRowCount, expandedRow, stacked, target);
    let spare = target - fitted.height;
    if (spare <= 0) return fitted;
    const videoAll = stacked ? Math.max(1, clipCount) * GEOMETRY.stackRow : GEOMETRY.clipRow;
    const videoHeight = Math.min(videoAll, fitted.videoHeight + spare);
    spare -= videoHeight - fitted.videoHeight;
    const audio = audioSectionLayout(audioRowCount, expandedRow, fitted.audio.viewHeight + spare, Infinity);
    return { height: target, videoHeight, audio };
  }
  const videoWanted = stacked
    ? Math.min(Math.max(1, clipCount) * GEOMETRY.stackRow, GEOMETRY.stackRowsCap)
    : GEOMETRY.clipRow;
  const full = audioSectionLayout(audioRowCount, expandedRow);
  const wanted = EDGE_PX + GEOMETRY.ruler + videoWanted + full.sectionHeight;
  if (!(Number.isFinite(maxHeight) && wanted > maxHeight)) {
    return { height: wanted, videoHeight: videoWanted, audio: full };
  }
  const room = Math.max(GEOMETRY.timeline, maxHeight);
  const videoFloor = Math.min(videoWanted, stacked ? GEOMETRY.stackRowsFloor : GEOMETRY.clipRow);
  const videoHeight = Math.min(videoWanted, Math.max(videoFloor, room - EDGE_PX - GEOMETRY.ruler - full.sectionHeight));
  const audio = audioSectionLayout(
    audioRowCount,
    expandedRow,
    room - EDGE_PX - GEOMETRY.ruler - videoHeight - GEOMETRY.audioStrip,
  );
  return { height: EDGE_PX + GEOMETRY.ruler + videoHeight + audio.sectionHeight, videoHeight, audio };
}
