import { describe, expect, it } from "vitest";
import {
  hiddenAudioRows,
  AUDIO_STRIP_PX,
  audioSectionLayout,
  clampAudioScroll,
  revealAudioRow,
  scrollKeepingRowBottom,
  type AudioSectionLayout,
} from "../audioLayout";

describe("audioSectionLayout", () => {
  it("draws one row (a placeholder for none) with the strip under it", () => {
    for (const rows of [0, 1]) {
      const layout = audioSectionLayout(rows, null);
      expect(layout).toMatchObject({ rowTops: [0], rowHeights: [52], rowsHeight: 52, viewHeight: 52, maxScroll: 0 });
      expect(layout.sectionHeight).toBe(52 + 28);
    }
  });

  it("shows two rows and scrolls the rest", () => {
    expect(audioSectionLayout(3, null)).toMatchObject({
      rowTops: [0, 52, 104],
      rowsHeight: 156,
      viewHeight: 104,
      sectionHeight: 132,
      maxScroll: 52,
    });
  });

  it("makes the expanded row 128 px, and the view 180 px with it", () => {
    expect(audioSectionLayout(3, 1)).toMatchObject({
      rowTops: [0, 52, 180],
      rowHeights: [52, 128, 52],
      viewHeight: 180,
      maxScroll: 52,
    });
    expect(audioSectionLayout(1, 0).viewHeight).toBe(128);
    expect(audioSectionLayout(2, 5).rowHeights).toEqual([52, 52]);
  });

  it("gives up height to the cap, never below one row", () => {
    expect(audioSectionLayout(2, 0, 128)).toMatchObject({ viewHeight: 128, maxScroll: 52 });
    expect(audioSectionLayout(3, null, 10).viewHeight).toBe(52);
    expect(audioSectionLayout(3, null, Number.NaN).viewHeight).toBe(104);
  });
});

describe("scrolling", () => {
  const layout = audioSectionLayout(4, null);

  it("counts the rows cut off above and below the view", () => {
    expect(hiddenAudioRows(0, layout)).toEqual({ above: 0, below: 2 });
    expect(hiddenAudioRows(26, layout)).toEqual({ above: 1, below: 2 });
    expect(hiddenAudioRows(104, layout)).toEqual({ above: 2, below: 0 });
    expect(hiddenAudioRows(0, audioSectionLayout(2, null))).toEqual({ above: 0, below: 0 });
  });

  it("clamps", () => {
    expect(clampAudioScroll(-5, layout)).toBe(0);
    expect(clampAudioScroll(500, layout)).toBe(104);
    expect(clampAudioScroll(Number.NaN, layout)).toBe(0);
  });

  it("reveals a row, scrolling as little as it can", () => {
    expect(revealAudioRow(0, 3, layout)).toBe(104);
    expect(revealAudioRow(0, 2, layout)).toBe(52);
    expect(revealAudioRow(104, 0, layout)).toBe(0);
    expect(revealAudioRow(52, 1, layout)).toBe(52);
    expect(revealAudioRow(52, 9, layout)).toBe(52);
    // Taller than the view: its top
    const tall = audioSectionLayout(4, 2, 100);
    expect(revealAudioRow(0, 2, tall)).toBe(104);
  });
});

describe("scrollKeepingRowBottom", () => {
  /** A row's bottom on screen, from the section's bottom edge. */
  const rowBottom = (layout: AudioSectionLayout, row: number, scroll: number) =>
    -AUDIO_STRIP_PX - layout.viewHeight + layout.rowTops[row] + layout.rowHeights[row] - scroll;

  it("keeps the toggled row's bottom in place, expanding and collapsing, at either end of the scroll", () => {
    for (const maxView of [Infinity, 128]) {
      const collapsed = audioSectionLayout(3, null, maxView);
      for (const row of [0, 1, 2]) {
        const expanded = audioSectionLayout(3, row, maxView);
        for (const scroll of [0, collapsed.maxScroll]) {
          const opened = scrollKeepingRowBottom(scroll, row, collapsed, expanded);
          expect(opened).toBeGreaterThanOrEqual(0);
          expect(opened).toBeLessThanOrEqual(expanded.maxScroll);
          expect(rowBottom(expanded, row, opened)).toBe(rowBottom(collapsed, row, scroll));
          const closed = scrollKeepingRowBottom(opened, row, expanded, collapsed);
          expect(rowBottom(collapsed, row, closed)).toBe(rowBottom(expanded, row, opened));
        }
      }
    }
  });

  it("keeps a row in place when another row takes over the expansion", () => {
    const first = audioSectionLayout(3, 0);
    const third = audioSectionLayout(3, 2);
    expect(scrollKeepingRowBottom(52, 2, first, third)).toBe(52);
    expect(rowBottom(third, 2, 52)).toBe(rowBottom(first, 2, 52));
  });

  it("keeps a lone row's bottom as it grows", () => {
    expect(scrollKeepingRowBottom(0, 0, audioSectionLayout(1, null), audioSectionLayout(1, 0))).toBe(0);
  });
});
