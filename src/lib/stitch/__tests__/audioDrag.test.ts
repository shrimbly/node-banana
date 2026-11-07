import { describe, expect, it } from "vitest";
import type { StitchTimelineClip } from "@/types";
import { audioSpans, createAudioClip, type AudioDurations, type AudioSourceKey } from "../audioClips";
import { audioMoveAt, audioMoveTargets, audioRowAt, audioSnapText, audioTrimAt } from "../audioDrag";
import { buildTimeAxis } from "../timeAxis";
import { clipSpans, createClip, type SourceDurations, type SourceKey } from "../timeline";

const video = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const videoDurations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);
const D: AudioDurations = new Map<AudioSourceKey, number>([
  ["music", 20],
  ["asset:atone00000001", 3],
]);

/** 10 s at 10 px/s from x 16: x = 16 + 10·t. */
const linear = () => buildTimeAxis(clipSpans([video("a", "e1")], videoDurations({ "edge:e1": 10 }), 0), 10);
/** 4 s, an empty slot (160 px) at t = 4 (x 56..216), then 6 s. */
const slotted = () =>
  buildTimeAxis(
    clipSpans([video("a", "e1"), video("gap", "e2"), video("b", "e3")], videoDurations({ "edge:e1": 4, "edge:e3": 6 }), 0),
    10,
  );
const videoSpans = clipSpans([video("a", "e1"), video("b", "e2")], videoDurations({ "edge:e1": 4, "edge:e2": 6 }), 0);
const clips = [
  createAudioClip({ kind: "music" }, { id: "m", startSec: 0 }),
  createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id: "t", row: 1, startSec: 6.5 }),
];
const spans = audioSpans(clips, D);
const names = (span: { clip: { id: string } }) => (span.clip.id === "m" ? "music.m4a" : "tone.m4a");

describe("audioMoveTargets", () => {
  it("takes the playhead, 0:00, the end, the video clips' edges and the other audio clips' edges", () => {
    const targets = audioMoveTargets(spans, videoSpans, new Set(["m"]), 3, 10, names);
    expect(targets.map((t) => [t.label, t.t])).toEqual([
      ["the playhead", 3],
      ["the start", 0],
      ["the end", 10],
      ["Clip 1's start", 0],
      ["Clip 1's end", 4],
      ["Clip 2's start", 4],
      ["Clip 2's end", 10],
      ["tone.m4a's start", 6.5],
      ["tone.m4a's end", 9.5],
    ]);
  });
});

describe("audioMoveAt", () => {
  const targets = audioMoveTargets(spans, videoSpans, new Set(["t"]), 3, 10, names);

  it("moves linearly in Stacked's axis, and turns snapping off with ⇧", () => {
    expect(audioMoveAt(linear(), { start: 6.5, length: 3 }, 12, targets, { snap: false }).deltaSec).toBeCloseTo(1.2, 9);
    expect(audioMoveAt(linear(), { start: 6.5, length: 3 }, 0, targets, { snap: false }).deltaSec).toBe(0);
  });

  it("does not jump across a Track slot", () => {
    // From 3 s (x 46), 20 px right: into the slot (x 66), whose pixels all read 4 s
    const into = audioMoveAt(slotted(), { start: 3, length: 1 }, 20, [], { snap: false });
    expect(into.deltaSec).toBeCloseTo(1, 9);
    // Past the slot (x 236): 4 s + the 20 px after it
    const past = audioMoveAt(slotted(), { start: 3, length: 1 }, 190, [], { snap: false });
    expect(past.deltaSec).toBeCloseTo(6 - 3, 9);
  });

  it("snaps within 8 px, the lead's own start first on a tie, then the playhead", () => {
    // Lead at 2.9 s, length 3: its start is 1 px from the playhead at 3
    const near = audioMoveAt(linear(), { start: 2.9, length: 3 }, 0, targets, { snap: true });
    expect(near.snapped?.label).toBe("where it was");
    const toPlayhead = audioMoveAt(linear(), { start: 2.9, length: 3 }, 1, targets, { snap: true });
    expect(toPlayhead.snapped?.label).toBe("the playhead");
    expect(toPlayhead.deltaSec).toBeCloseTo(0.1, 9);
    expect(audioSnapText(toPlayhead)).toBe("Snapped to the playhead");
  });

  it("snaps its end edge to the end and to a video clip's end", () => {
    // Lead 1..5 moved 5.1 s: its end lands 0.1 s from the end at 10
    const result = audioMoveAt(linear(), { start: 1, length: 4 }, 51, targets, { snap: true });
    expect(result.snappedEdge).toBe("end");
    expect(result.deltaSec).toBeCloseTo(5, 9);
    expect(audioSnapText(result)).toBe("End snapped to the end");
    const clipEnd = targets.filter((t) => t.label === "Clip 1's end");
    const toClip = audioMoveAt(linear(), { start: 0, length: 1.5 }, 26, clipEnd, { snap: true });
    expect(toClip.deltaSec).toBeCloseTo(2.5, 9);
    expect(audioSnapText(toClip)).toBe("End snapped to Clip 1's end");
  });

  it("skips a target that would start the lead before 0:00, and clamps to the group's room", () => {
    // The end edge at 0:00 would start a 3 s lead at −3
    const result = audioMoveAt(linear(), { start: 0.4, length: 3 }, -20, [{ t: 0, kind: "edge", label: "x", edge: "end" }], {
      snap: true,
    });
    expect(result.snapped).toBeNull();
    expect(result.deltaSec).toBeCloseTo(-0.4, 9);
    expect(audioMoveAt(linear(), { start: 5, length: 1, min: 2 }, -100, [], { snap: false }).deltaSec).toBe(-3);
    expect(audioMoveAt(linear(), { start: 5, length: 1, max: 7 }, 1000, [], { snap: false }).deltaSec).toBe(2);
  });
});

describe("audioTrimAt", () => {
  const span = audioSpans([createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id: "t", startSec: 2, inSec: 0.5 })], D)[0];
  const targets = [
    { t: 3, kind: "playhead" as const, label: "the playhead", edge: "both" as const },
    { t: 4, kind: "edge" as const, label: "Clip 1's end", edge: "both" as const },
  ];

  it("reads the In edge where it is drawn, the sound staying in place", () => {
    expect(audioTrimAt(linear(), span, "in", 5, { min: 0, max: 2.9 }, [], { snap: false }).inSec).toBeCloseTo(1, 9);
  });

  it("snaps the In edge to the playhead and the Out edge to a video clip's end", () => {
    const into = audioTrimAt(linear(), span, "in", 9, { min: 0, max: 2.9 }, targets, { snap: true });
    expect(into.inSec).toBeCloseTo(1.5, 9);
    expect(into.snapped?.label).toBe("the playhead");
    // The Out edge from 4.5 s: −4 px is 4.1 s, 1 px from Clip 1's end
    const out = audioTrimAt(linear(), span, "out", -4, { min: 0.6, max: 3 }, targets, { snap: true });
    expect(out.outSec).toBeCloseTo(2.5, 9);
    expect(out.snapped?.label).toBe("Clip 1's end");
  });

  it("clamps to its bounds, and a snap the bounds pulled off is no snap", () => {
    const out = audioTrimAt(linear(), span, "out", 200, { min: 0.6, max: 3 }, targets, { snap: true });
    expect(out.outSec).toBe(3);
    const pulled = audioTrimAt(linear(), span, "in", 9, { min: 0, max: 1.2 }, targets, { snap: true });
    expect(pulled.inSec).toBe(1.2);
    expect(pulled.snapped).toBeNull();
  });
});

describe("audioRowAt", () => {
  // Rows 64, 136 (expanded), 64; the strip under them
  const tops = [0, 64, 200];
  const heights = [64, 136, 64];
  const strip = 264;

  it("keeps the row within its band and 4 px more, on uneven rows", () => {
    expect(audioRowAt(32, 0, tops, heights, strip)).toBe(0);
    expect(audioRowAt(67, 0, tops, heights, strip)).toBe(0);
    expect(audioRowAt(69, 0, tops, heights, strip)).toBe(1);
    expect(audioRowAt(198, 1, tops, heights, strip)).toBe(1);
    expect(audioRowAt(204, 1, tops, heights, strip)).toBe(1);
    expect(audioRowAt(205, 1, tops, heights, strip)).toBe(2);
    expect(audioRowAt(61, 1, tops, heights, strip)).toBe(1);
    expect(audioRowAt(59, 1, tops, heights, strip)).toBe(0);
  });

  it("goes to a new row past the last row's band by 4 px, and stays there", () => {
    expect(audioRowAt(268, 2, tops, heights, strip)).toBe(2);
    expect(audioRowAt(269, 2, tops, heights, strip)).toBe(3);
    expect(audioRowAt(261, 3, tops, heights, strip)).toBe(3);
    expect(audioRowAt(259, 3, tops, heights, strip)).toBe(2);
    expect(audioRowAt(-50, 2, tops, heights, strip)).toBe(0);
    expect(audioRowAt(Number.NaN, 1, tops, heights, strip)).toBe(1);
  });
});
