import { describe, expect, it } from "vitest";
import { timelineLayout } from "../timeline/timelineLayout";

// The top edge (1) and the ruler (28), the video part, then the audio rows and the 28px strip with "+ Audio"

describe("timelineLayout", () => {
  it("is 189 in Track with one audio row, 265 with that row expanded, whatever the clips", () => {
    for (const clips of [0, 1, 2, 6]) {
      expect(timelineLayout(clips, 1, null, false)).toMatchObject({ height: 1 + 28 + 80 + 52 + 28, videoHeight: 80 });
      expect(timelineLayout(clips, 1, 0, false).height).toBe(1 + 28 + 80 + 128 + 28);
    }
    // No audio at all draws one placeholder row
    expect(timelineLayout(1, 0, null, false).height).toBe(189);
  });

  it("takes Stacked's rows as they need, up to three and a half", () => {
    expect(timelineLayout(1, 1, null, true)).toMatchObject({ height: 1 + 28 + 52 + 80, videoHeight: 52 });
    expect(timelineLayout(2, 1, null, true).videoHeight).toBe(104);
    expect(timelineLayout(3, 1, null, true)).toMatchObject({ height: 1 + 28 + 156 + 80, videoHeight: 156 });
    // Six: capped at three and a half rows
    expect(timelineLayout(6, 1, null, true)).toMatchObject({ height: 1 + 28 + 182 + 80, videoHeight: 182 });
    // An empty Stacked keeps one row's room
    expect(timelineLayout(0, 1, null, true).videoHeight).toBe(52);
  });

  it("shows two audio rows before the rest scroll", () => {
    expect(timelineLayout(1, 2, null, false).height).toBe(1 + 28 + 80 + 104 + 28);
    expect(timelineLayout(1, 3, null, false).height).toBe(241);
    expect(timelineLayout(1, 3, null, false).audio.maxScroll).toBe(52);
    expect(timelineLayout(1, 2, 1, false).height).toBe(1 + 28 + 80 + 180 + 28);
  });

  it("gives up Stacked's rows first, then the audio view, under the cap, and never goes below 189", () => {
    const wanted = timelineLayout(4, 3, 0, true);
    expect(wanted.height).toBe(1 + 28 + 182 + 180 + 28);
    const capped = timelineLayout(4, 3, 0, true, 360);
    expect(capped.height).toBe(360);
    // Stacked's rows view gives way first; the audio view keeps its 180
    expect(capped.videoHeight).toBe(360 - 1 - 28 - 208);
    expect(capped.audio.viewHeight).toBe(180);
    // Tighter still: the rows view stops at one and a half rows and the audio view shrinks
    const tight = timelineLayout(4, 3, 0, true, 300);
    expect(tight.videoHeight).toBe(78);
    expect(tight.audio.viewHeight).toBe(300 - 1 - 28 - 78 - 28);
    expect(tight.height).toBe(300);
    // Never below one audio row, and never below 189 in all
    const tiny = timelineLayout(4, 3, 0, true, 100);
    expect(tiny.audio.viewHeight).toBe(54);
    expect(tiny.height).toBe(189);
    // Room to spare changes nothing
    expect(timelineLayout(4, 3, 0, true, 1000)).toEqual(wanted);
  });

  it("takes a chosen height: the rows' views grow past their caps into it, Stacked's first, and give way under it", () => {
    // Stacked, six clips and three audio rows: 182 + 104 by default, 343 in all
    const grown = timelineLayout(6, 3, null, true, Infinity, 500);
    expect(grown.height).toBe(500);
    // 157 to spare: the rows view takes all six rows (312), the audio view the 27 left
    expect(grown.videoHeight).toBe(312);
    expect(grown.audio.viewHeight).toBe(104 + 27);
    // Track's clips row stays; the audio view shows every row, and the rest stays empty
    const track = timelineLayout(6, 3, null, false, Infinity, 500);
    expect(track).toMatchObject({ height: 500, videoHeight: 80 });
    expect(track.audio).toMatchObject({ viewHeight: 156, maxScroll: 0 });
    // Under what the rows need they give way as under the cap
    expect(timelineLayout(4, 3, 0, true, Infinity, 360)).toEqual(timelineLayout(4, 3, 0, true, 360));
    // Within the cap, and never below 189
    expect(timelineLayout(6, 3, null, true, 400, 500).height).toBe(400);
    expect(timelineLayout(6, 3, null, true, Infinity, 50).height).toBe(189);
  });

  it("keeps Track's clips row whole under the cap and gives up audio rows instead", () => {
    const capped = timelineLayout(4, 3, 0, false, 300);
    expect(capped).toMatchObject({ height: 300, videoHeight: 80 });
    expect(capped.audio.viewHeight).toBe(300 - 1 - 28 - 80 - 28);
    const tiny = timelineLayout(4, 3, 0, false, 100);
    expect(tiny).toMatchObject({ height: 189, videoHeight: 80 });
    expect(tiny.audio.viewHeight).toBe(52);
  });
});
