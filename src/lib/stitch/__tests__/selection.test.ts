import { describe, expect, it } from "vitest";
import { createAudioClip, normalizeAudioClips } from "../audioClips";
import { boxHits, clipIdsOf, makeSelection, rangeTo, selectAll, toggleClip, type ClipSelection } from "../selection";

const order = ["a", "b", "c", "d", "e"];
const one = (clipId: string): ClipSelection => ({ kind: "clip", clipId });

describe("clipIdsOf", () => {
  it("reads the lead alone, or every id in timeline order, dropping ids that are gone", () => {
    expect(clipIdsOf(null, order)).toEqual([]);
    expect(clipIdsOf(one("c"), order)).toEqual(["c"]);
    expect(clipIdsOf(one("x"), order)).toEqual([]);
    expect(clipIdsOf({ clipId: "d", clipIds: ["d", "x", "b"] }, order)).toEqual(["b", "d"]);
  });
});

describe("makeSelection", () => {
  it("sorts by the order, drops duplicates and unknown ids", () => {
    expect(makeSelection(order, ["d", "b", "d", "x"], "d")).toEqual({ kind: "clip", clipId: "d", clipIds: ["b", "d"] });
  });

  it("leaves clipIds out for a lone id", () => {
    expect(makeSelection(order, ["c", "c"])).toEqual({ kind: "clip", clipId: "c" });
  });

  it("falls back to the first id for a lead that is not selected, and drops such an anchor", () => {
    expect(makeSelection(order, ["e", "b"], "a", "x")).toEqual({ kind: "clip", clipId: "b", clipIds: ["b", "e"] });
  });

  it("keeps an anchor other than the lead, and leaves one equal to it out", () => {
    expect(makeSelection(order, ["a", "c"], "c", "a")).toEqual({
      kind: "clip",
      clipId: "c",
      clipIds: ["a", "c"],
      anchorId: "a",
    });
    expect(makeSelection(order, ["a", "c"], "c", "c")).toEqual({ kind: "clip", clipId: "c", clipIds: ["a", "c"] });
  });

  it("gives null when nothing is in the order", () => {
    expect(makeSelection(order, [])).toBeNull();
    expect(makeSelection(order, ["x"])).toBeNull();
  });

  it("is idempotent", () => {
    const first = makeSelection(order, ["e", "a", "c"], "c", "a")!;
    expect(makeSelection(order, clipIdsOf(first, order), first.clipId, first.anchorId)).toEqual(first);
  });
});

describe("toggleClip", () => {
  it("adds a clip, which leads and anchors", () => {
    const next = toggleClip(order, one("a"), "c");
    expect(next).toEqual({ kind: "clip", clipId: "c", clipIds: ["a", "c"] });
    expect(toggleClip(order, null, "b")).toEqual(one("b"));
  });

  it("moves an existing anchor to the clip that joins, so a range starts from it", () => {
    const pair: ClipSelection = { kind: "clip", clipId: "c", clipIds: ["a", "c"], anchorId: "a" };
    const joined = toggleClip(order, pair, "e");
    expect(joined).toEqual({ kind: "clip", clipId: "e", clipIds: ["a", "c", "e"] });
    expect(rangeTo(order, joined, "d")).toEqual({ kind: "clip", clipId: "d", clipIds: ["d", "e"], anchorId: "e" });
  });

  it("takes a clip out; the first remaining leads when the lead leaves", () => {
    const group: ClipSelection = { kind: "clip", clipId: "c", clipIds: ["a", "c", "e"], anchorId: "e" };
    expect(toggleClip(order, group, "a")).toEqual({ kind: "clip", clipId: "c", clipIds: ["c", "e"], anchorId: "e" });
    expect(toggleClip(order, group, "c")).toEqual({ kind: "clip", clipId: "a", clipIds: ["a", "e"], anchorId: "e" });
  });

  it("gives null when the last clip leaves", () => {
    expect(toggleClip(order, one("b"), "b")).toBeNull();
  });
});

describe("rangeTo", () => {
  it("runs forwards and backwards from the anchor, the clicked clip leading and the anchor kept", () => {
    const from = { kind: "clip", clipId: "d", clipIds: ["b", "d"], anchorId: "b" } as ClipSelection;
    expect(rangeTo(order, from, "e")).toEqual({ kind: "clip", clipId: "e", clipIds: ["b", "c", "d", "e"], anchorId: "b" });
    expect(rangeTo(order, from, "a")).toEqual({ kind: "clip", clipId: "a", clipIds: ["a", "b"], anchorId: "b" });
  });

  it("ranges from the lead when there is no anchor, and keeps it as the anchor", () => {
    expect(rangeTo(order, one("b"), "d")).toEqual({ kind: "clip", clipId: "d", clipIds: ["b", "c", "d"], anchorId: "b" });
  });

  it("ranges from the lead when the anchor is gone, and from the clicked clip when the lead is gone too", () => {
    expect(rangeTo(order, { clipId: "c", anchorId: "x" }, "a")).toEqual({
      kind: "clip",
      clipId: "a",
      clipIds: ["a", "b", "c"],
      anchorId: "c",
    });
    expect(rangeTo(order, { clipId: "y", anchorId: "x" }, "b")).toEqual(one("b"));
    expect(rangeTo(order, null, "b")).toEqual(one("b"));
  });
});

describe("selectAll", () => {
  it("selects every clip and keeps the lead", () => {
    expect(selectAll(order, one("c"))).toEqual({ kind: "clip", clipId: "c", clipIds: order });
    expect(selectAll(order, one("x"))).toEqual({ kind: "clip", clipId: "a", clipIds: order });
    expect(selectAll(order, null)).toEqual({ kind: "clip", clipId: "a", clipIds: order });
  });

  it("gives null for an empty sequence", () => {
    expect(selectAll([], one("a"))).toBeNull();
  });
});

describe("boxHits", () => {
  const boxes = [
    { x: 0, width: 100, top: 34, height: 72 },
    { x: 102, width: 100, top: 86, height: 40 },
    // An empty clip's slot
    { x: 210, width: 12, top: 138, height: 40 },
  ];

  it("tests x only in Track", () => {
    expect(boxHits(boxes, { left: 50, right: 150, top: 0, bottom: 1 }, "x")).toEqual([0, 1]);
  });

  it("needs both axes in Stacked", () => {
    expect(boxHits(boxes, { left: 50, right: 150, top: 0, bottom: 40 }, "xy")).toEqual([0]);
    expect(boxHits(boxes, { left: 50, right: 300, top: 110, bottom: 150 }, "xy")).toEqual([1, 2]);
  });

  it("counts touching edges", () => {
    expect(boxHits(boxes, { left: 100, right: 101, top: 0, bottom: 200 }, "xy")).toEqual([0]);
    expect(boxHits(boxes, { left: 202, right: 210, top: 126, bottom: 138 }, "xy")).toEqual([1, 2]);
  });

  it("hits an empty clip's slot", () => {
    expect(boxHits(boxes, { left: 215, right: 216, top: 150, bottom: 151 }, "xy")).toEqual([2]);
  });
});

describe("on an audio order", () => {
  // Row, then start, then id: the same five ids as `order`
  const audioOrder = normalizeAudioClips([
    createAudioClip({ kind: "music" }, { id: "d", row: 1, startSec: 0 }),
    createAudioClip({ kind: "music" }, { id: "a", row: 0, startSec: 0 }),
    createAudioClip({ kind: "music" }, { id: "e", row: 1, startSec: 5 }),
    createAudioClip({ kind: "music" }, { id: "c", row: 0, startSec: 4 }),
    createAudioClip({ kind: "music" }, { id: "b", row: 0, startSec: 2 }),
  ]).map((clip) => clip.id);
  // An audio selection carries more than the ids; only the ids are read
  const audio = { kind: "audio" as const, clipId: "b", clipIds: ["b", "d"], anchorId: "d", point: null, onCurve: false };
  const video: ClipSelection = { kind: "clip", clipId: "b", clipIds: ["b", "d"], anchorId: "d" };

  it("gives what the same ids give on a video order", () => {
    expect(audioOrder).toEqual(order);
    expect(clipIdsOf(audio, audioOrder)).toEqual(clipIdsOf(video, order));
    expect(toggleClip(audioOrder, audio, "e")).toEqual(toggleClip(order, video, "e"));
    expect(rangeTo(audioOrder, audio, "a")).toEqual(rangeTo(order, video, "a"));
    expect(selectAll(audioOrder, audio)).toEqual(selectAll(order, video));
  });
});
