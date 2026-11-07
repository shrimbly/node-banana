/**
 * The audio section's geometry: its rows, the view they scroll in, and the
 * strip under them. It depends on the row count, the expanded row and the
 * height the timeline leaves it, never on the selection, so selecting a
 * clip moves nothing. Pure: no React, no DOM.
 */

/** A 44px clip block and the 8px under it. */
export const AUDIO_ROW_PX = 52;
/** The one row whose volume line is open for editing: a 120px block and the 8px under it. */
export const AUDIO_ROW_EXPANDED_PX = 128;
/** The strip under the rows that holds "+ Audio", and the "New row" drop target. */
export const AUDIO_STRIP_PX = 28;
/** Rows shown before the rest scroll. */
export const AUDIO_ROWS_CAP = 2;

export interface AudioSectionLayout {
  /** Content coordinates inside the rows block, empty rows included. */
  rowTops: number[];
  rowHeights: number[];
  rowsHeight: number;
  /** min(rowsHeight, the rows cap (taller by the expanded row's extra when one is expanded), maxView); at least one row. */
  viewHeight: number;
  sectionHeight: number;
  maxScroll: number;
}

/**
 * rowCount 0 draws one placeholder row. maxView: what the timeline's height cap leaves for the rows (Infinity when
 * uncapped). rowsCap: the rows shown before the rest scroll (more when the timeline is dragged taller).
 */
export function audioSectionLayout(
  rowCount: number,
  expandedRow: number | null,
  maxView = Infinity,
  rowsCap = AUDIO_ROWS_CAP,
): AudioSectionLayout {
  const rows = Math.max(1, Math.floor(Number.isFinite(rowCount) ? rowCount : 0));
  const expanded = expandedRow !== null && expandedRow >= 0 && expandedRow < rows ? expandedRow : null;
  const rowHeights = Array.from({ length: rows }, (_, row) => (row === expanded ? AUDIO_ROW_EXPANDED_PX : AUDIO_ROW_PX));
  const rowTops: number[] = [];
  let rowsHeight = 0;
  for (const height of rowHeights) {
    rowTops.push(rowsHeight);
    rowsHeight += height;
  }
  const cap = rowsCap * AUDIO_ROW_PX + (expanded !== null ? AUDIO_ROW_EXPANDED_PX - AUDIO_ROW_PX : 0);
  const viewHeight = Math.max(AUDIO_ROW_PX, Math.min(rowsHeight, cap, Number.isNaN(maxView) ? Infinity : maxView));
  return {
    rowTops,
    rowHeights,
    rowsHeight,
    viewHeight,
    sectionHeight: viewHeight + AUDIO_STRIP_PX,
    maxScroll: Math.max(0, rowsHeight - viewHeight),
  };
}

export function clampAudioScroll(scroll: number, layout: AudioSectionLayout): number {
  return Number.isFinite(scroll) ? Math.min(Math.max(scroll, 0), layout.maxScroll) : 0;
}

/** How many rows are cut off, wholly or in part, above and below the view at this scroll. */
export function hiddenAudioRows(scroll: number, layout: AudioSectionLayout): { above: number; below: number } {
  const top = clampAudioScroll(scroll, layout);
  const bottom = top + layout.viewHeight;
  let above = 0;
  let below = 0;
  layout.rowTops.forEach((rowTop, row) => {
    if (rowTop < top - 0.5) above++;
    else if (rowTop + layout.rowHeights[row] > bottom + 0.5) below++;
  });
  return { above, below };
}

/** The least scroll that shows `row` whole (its top, when it is taller than the view). */
export function revealAudioRow(scroll: number, row: number, layout: AudioSectionLayout): number {
  const current = clampAudioScroll(scroll, layout);
  if (!(row >= 0 && row < layout.rowTops.length)) return current;
  const top = layout.rowTops[row];
  const bottom = top + layout.rowHeights[row];
  if (top < current || bottom - top > layout.viewHeight) return clampAudioScroll(top, layout);
  if (bottom > current + layout.viewHeight) return clampAudioScroll(bottom - layout.viewHeight, layout);
  return current;
}

/**
 * The scroll after the expanded row changes from `before` to `after`, keeping row `toggled`'s bottom edge (and the
 * toggle placed from it) where it was on screen. The section is anchored at its bottom, so a row's bottom sits at
 * sectionBottom − strip − viewHeight + rowBottom − scroll; holding that fixed gives
 * scroll + (rowBottom after − rowBottom before) − (viewHeight after − viewHeight before), clamped.
 */
export function scrollKeepingRowBottom(
  scroll: number,
  toggled: number,
  before: AudioSectionLayout,
  after: AudioSectionLayout,
): number {
  const bottom = (layout: AudioSectionLayout) =>
    toggled >= 0 && toggled < layout.rowTops.length ? layout.rowTops[toggled] + layout.rowHeights[toggled] : 0;
  const next = scroll + (bottom(after) - bottom(before)) - (after.viewHeight - before.viewHeight);
  return clampAudioScroll(next, after);
}
