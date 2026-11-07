import { describe, expect, it, vi } from "vitest";
import type { StitchSequenceLayout, StitchTimelineClip, WorkflowEdge, WorkflowNode } from "@/types";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import type { NodeExecutionContext } from "@/store/execution/types";
import { gatherStitchInputs } from "@/store/execution/stitchInputs";
import type { StitchOptions } from "../engineTypes";
import {
  chooseFrameSlot,
  EMPTY_FACTS,
  frameClips,
  frameOptions,
  frameSlot,
  planFrameAt,
  shownAt,
  visibleClipIds,
  type FramePlan,
  type FrameSourceFacts,
} from "../framePlan";
import { envelopeAt } from "../placement";
import { readerRange } from "../placedSchedule";
import { planPicture } from "../picturePlan";
import { secToSlot } from "../sequencePlan";
import { dissolveFrames, sharedCadence } from "../stack";
import { layoutSpans, sourceKey, type SourceKey } from "../timeline";

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ blob: async () => new Blob(["v"], { type: "video/mp4" }) })),
);

const edgeClip = (id: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "edge", edgeId: id },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});

const TRACK: StitchSequenceLayout = { mode: "track", overlapSec: 1, crossfade: true };
const STACKED: StitchSequenceLayout = { mode: "stacked", overlapSec: 1, crossfade: true };

/** A draft's clips and spans, every source measured at its given duration. */
function draft(timeline: StitchTimelineClip[], lengths: Record<string, number>, layout: StitchSequenceLayout) {
  const durations = new Map<SourceKey, number>(timeline.map((clip) => [sourceKey(clip.source), lengths[clip.id]]));
  const placed = layout.mode === "stacked" && timeline.some((clip) => clip.startSec !== undefined);
  const stack = layout.mode === "stacked" ? { crossfade: layout.crossfade, placed } : null;
  return {
    clips: frameClips(timeline, durations, () => "src", placed),
    options: frameOptions(layout, timeline),
    spans: layoutSpans(timeline, durations, layout),
    stack,
  };
}

const layersOf = (plan: FramePlan) => (plan.show.kind === "layers" ? plan.show.layers : []);
const facts24 = (...keys: string[]) =>
  new Map<SourceKey, FrameSourceFacts>(keys.map((key) => [`edge:${key}` as SourceKey, { firstTimestamp: 0, frameRate: 24 }]));

describe("frameSlot", () => {
  it("rounds half up and stays inside the loop", () => {
    expect(frameSlot(0, 10)).toBe(0);
    expect(frameSlot(121 / 120, 10)).toBe(61);
    expect(frameSlot(1.0083, 10)).toBe(60);
    expect(frameSlot(10, 10)).toBe(599);
    expect(frameSlot(99, 10)).toBe(599);
    expect(frameSlot(3, 0)).toBe(0);
    expect(frameSlot(-1, 10)).toBe(0);
  });
});

describe("frameOptions", () => {
  const node = (id: string, type: string, data: Record<string, unknown>) =>
    ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
  const nodes = [node("g1", "generateVideo", { outputVideo: "blob:one" }), node("g2", "generateVideo", { outputVideo: "blob:two" })];
  const edges = [
    { id: "e1", source: "g1", target: "s", sourceHandle: "video", targetHandle: "video-0" },
    { id: "e2", source: "g2", target: "s", sourceHandle: "video", targetHandle: "video-1" },
  ] as WorkflowEdge[];

  /** The options executeVideoStitch builds from gatherStitchInputs, for this layout and timeline. */
  async function executorOptions(layout: StitchSequenceLayout, timeline: StitchTimelineClip[]): Promise<StitchOptions> {
    const stitch = node("s", "videoStitch", { clips: [], clipOrder: ["e1", "e2"], loopCount: 1, timeline, sequenceLayout: layout });
    const all = [stitch, ...nodes];
    const ctx = {
      node: stitch,
      getConnectedInputs: (id: string) => getConnectedInputsPure(id, all, edges),
      getEdges: () => edges,
      getNodes: () => all,
      get: () => ({ dimmedNodeIds: new Set<string>() }),
    } as unknown as NodeExecutionContext;
    const gathered = await gatherStitchInputs(ctx, stitch.data as never);
    return {
      loopCount: gathered.loopCount,
      ...(gathered.placed
        ? { overlapSec: gathered.placed.overlapSec, crossfade: gathered.placed.crossfade, placed: true }
        : gathered.stack
          ? { overlapSec: gathered.stack.overlapSec, crossfade: gathered.stack.crossfade }
          : {}),
    };
  }

  const lined = [edgeClip("a", { source: { kind: "edge", edgeId: "e1" } }), edgeClip("b", { source: { kind: "edge", edgeId: "e2" } })];
  const placed = [lined[0], { ...lined[1], startSec: 6 }];

  it.each([
    ["Track", TRACK, lined],
    ["Stacked lined up", { ...STACKED, crossfade: false }, lined],
    ["Stacked with no overlap", { ...STACKED, overlapSec: 0 }, lined],
    ["Stacked placed", STACKED, placed],
  ] as const)("matches the executor for %s", async (_name, layout, timeline) => {
    expect(frameOptions(layout, timeline)).toEqual(await executorOptions(layout, [...timeline]));
  });
});

describe("frameClips", () => {
  it("leaves out a clip with no src or no duration, and keeps starts only when placed", () => {
    const timeline = [edgeClip("a", { startSec: 2 }), edgeClip("b"), edgeClip("c")];
    const durations = new Map<SourceKey, number>([
      ["edge:a", 5],
      ["edge:b", 5],
    ]);
    const srcOf = (id: string) => (id === "b" ? null : "src");
    expect(frameClips(timeline, durations, srcOf, true)).toEqual([
      { clipId: "a", source: "edge:a", inSec: 0, outSec: null, duration: 5, startSec: 2 },
    ]);
    expect(frameClips(timeline, durations, () => "src", false).map((c) => [c.clipId, c.startSec])).toEqual([
      ["a", undefined],
      ["b", undefined],
    ]);
  });
});

describe("shownAt", () => {
  const ab = [edgeClip("a"), edgeClip("b")];
  const five = { a: 5, b: 5 };

  it("follows the preview's rule for each layout", () => {
    const track = draft(ab, five, TRACK);
    expect([...shownAt(track.spans, 2, track.stack)]).toEqual(["a"]);

    const on = draft(ab, five, STACKED);
    expect([...shownAt(on.spans, 4.5, on.stack)].sort()).toEqual(["a", "b"]);
    // At B's start its opacity is still 0
    expect([...shownAt(on.spans, 4, on.stack)]).toEqual(["a"]);

    const off = draft(ab, five, { ...STACKED, crossfade: false });
    expect([...shownAt(off.spans, 4.5, off.stack)]).toEqual(["a"]);
  });

  it("is empty in a placed gap and holds every live clip of a placed blend", () => {
    const gap = draft([edgeClip("a", { startSec: 0 }), edgeClip("b", { startSec: 6 })], { a: 5, b: 5 }, STACKED);
    expect(shownAt(gap.spans, 5.5, gap.stack).size).toBe(0);

    // b in front, fading in over a across [4, 5)
    const blend = draft([edgeClip("b", { startSec: 4 }), edgeClip("a", { startSec: 0 })], { a: 5, b: 5 }, STACKED);
    expect([...shownAt(blend.spans, 4.5, blend.stack)].sort()).toEqual(["a", "b"]);
  });
});

describe("chooseFrameSlot", () => {
  it("steps back a slot when the rounded slot is already the next clip's", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5.005, b: 5 }, TRACK);
    const before = shownAt(d.spans, 5, d.stack);
    expect(frameSlot(5, planPicture(d.clips.map((c) => ({ ...c, sourceDuration: c.duration })), d.options).loopLength)).toBe(300);
    expect(chooseFrameSlot(d.clips, d.options, 5, before)).toBe(299);
    // Exactly on the join the preview shows b, and so does the slot
    expect(chooseFrameSlot(d.clips, d.options, 5.005, shownAt(d.spans, 5.005, d.stack))).toBe(300);
  });

  it("steps back out of a gap the slot rounds into", () => {
    const d = draft([edgeClip("a", { startSec: 0 }), edgeClip("b", { startSec: 6 })], { a: 5, b: 5 }, STACKED);
    expect(planFrameAt(d.clips, d.options, 300, EMPTY_FACTS).show.kind).toBe("black");
    expect(chooseFrameSlot(d.clips, d.options, 4.995, shownAt(d.spans, 4.995, d.stack))).toBe(299);
  });

  it("takes the outgoing clip's slot at the very start of a dissolve", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, STACKED);
    const slot = chooseFrameSlot(d.clips, d.options, 4, shownAt(d.spans, 4, d.stack));
    expect(slot).toBe(239);
    expect([...visibleClipIds(planFrameAt(d.clips, d.options, slot, EMPTY_FACTS))]).toEqual(["a"]);
  });

  it("keeps the rounded slot when its clips are the preview's, and never goes below 0", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, TRACK);
    expect(chooseFrameSlot(d.clips, d.options, 2, shownAt(d.spans, 2, d.stack))).toBe(120);
    expect(chooseFrameSlot(d.clips, d.options, 0, new Set(["b"]))).toBe(0);
  });
});

describe("planFrameAt", () => {
  it("is none without clips", () => {
    expect(planFrameAt([], {}, 0, EMPTY_FACTS).show).toEqual({ kind: "none" });
  });

  it("reads a Track clip by Track's slots, holding the clip before", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, TRACK);
    const plan = planFrameAt(d.clips, d.options, 420, EMPTY_FACTS);
    expect(plan.route).toBe("track");
    const [layer] = layersOf(plan);
    expect(layer).toMatchObject({ unit: 1, clipId: "b", weight: 1 });
    expect(layer.read).toEqual({
      by: "slot",
      slot: 420,
      window: { origin: 0, anchorSlot: 300, endSlot: 600, fps: 60 },
      inSec: 0,
      range: readerRange({ inSec: 0, outSec: 5, origin: 0 }, 300, { n0: 420, n1: 421 }),
    });
    expect(layer.held).toMatchObject({ unit: 0, clipId: "a", read: { by: "slot", slot: 299 } });
    // The held clip's source is opened only when b's own read gives no frame
    expect(plan.sources).toEqual(["edge:b"]);
  });

  it("shows the same Track clips whatever the facts", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, TRACK);
    const facts = new Map<SourceKey, FrameSourceFacts>([
      ["edge:a", { firstTimestamp: 0.1, frameRate: 24 }],
      ["edge:b", { firstTimestamp: 0.1, frameRate: 24 }],
    ]);
    for (const slot of [0, 299, 300, 599]) {
      expect([...visibleClipIds(planFrameAt(d.clips, d.options, slot, facts))]).toEqual([
        ...visibleClipIds(planFrameAt(d.clips, d.options, slot, EMPTY_FACTS)),
      ]);
    }
  });

  it("moves a Track clip's origin and range by its first timestamp", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, TRACK);
    const facts = new Map<SourceKey, FrameSourceFacts>([["edge:a", { firstTimestamp: 0.1, frameRate: 24 }]]);
    const [layer] = layersOf(planFrameAt(d.clips, d.options, 60, facts));
    expect(layer.read).toMatchObject({ window: { origin: 0.1 } });
    expect(layer.read.by === "slot" && layer.read.range).toEqual(readerRange({ inSec: 0, outSec: 5, origin: 0.1 }, 0, { n0: 60, n1: 61 }));
  });

  describe("a lined-up stack", () => {
    const d = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, STACKED);
    const p = planPicture(d.clips.map((c) => ({ ...c, sourceDuration: c.duration })), d.options);
    const dissolve = p.sp!.dissolves[0];

    it.each([
      ["a shared cadence", facts24("a", "b")],
      ["no cadence", EMPTY_FACTS],
    ])("blends a dissolve's frames as Render looks them up, with %s", (_name, facts) => {
      const f = dissolveFrames(p.sp!, dissolve, 0, {
        fps: 60,
        cadence: sharedCadence(
          facts.get("edge:a" as SourceKey) ?? { firstTimestamp: 0, frameRate: null },
          facts.get("edge:b" as SourceKey) ?? { firstTimestamp: 0, frameRate: null },
        ),
      });
      const i = f.slots.filter((slot) => slot <= 270).length - 1;
      const layers = layersOf(planFrameAt(d.clips, d.options, 270, facts));
      expect(layers.map((l) => [l.clipId, l.read, l.weight])).toEqual([
        ["a", { by: "time", time: f.outgoingTimes[i] }, 1 - f.alphas[i]],
        ["b", { by: "time", time: f.incomingTimes[i] }, f.alphas[i]],
      ]);
    });

    it("holds the outgoing clip's last solo frame before the dissolve's first frame", () => {
      // A dissolve starting off its 24 fps frames: [3.99, 4.99) begins on slot 239, A's first frame in it lands on 240
      const off = draft([edgeClip("a", { outSec: 4.99 }), edgeClip("b")], { a: 5, b: 5 }, STACKED);
      const withFacts = planFrameAt(off.clips, off.options, 239, facts24("a", "b"));
      expect(layersOf(withFacts).map((l) => [l.clipId, l.read.by, l.weight])).toEqual([["a", "slot", 1]]);
      const empty = planFrameAt(off.clips, off.options, 239, EMPTY_FACTS);
      expect([...visibleClipIds(empty)].sort()).toEqual(["a", "b"]);
      expect(withFacts.sources.every((source) => empty.sources.includes(source))).toBe(true);
    });

    it("reads the incoming clip's solo window from its solo origin", () => {
      const [layer] = layersOf(planFrameAt(d.clips, d.options, 400, EMPTY_FACTS));
      expect(layer).toMatchObject({ clipId: "b", weight: 1 });
      expect(layer.read).toMatchObject({ by: "slot", slot: 400, inSec: 1, window: { origin: 1, anchorSlot: 300, endSlot: 540 } });
      // Held: the clip before, read through its own solo window
      expect(layer.held).toMatchObject({
        unit: 0,
        clipId: "a",
        read: { by: "slot", slot: 239, inSec: 0, window: { origin: 0, anchorSlot: 0, endSlot: 240 } },
      });
      expect(planFrameAt(d.clips, d.options, 400, EMPTY_FACTS).sources).toEqual(["edge:b"]);
    });

    it("shows the earlier clip alone in the overlap with Crossfade off", () => {
      const off = draft([edgeClip("a"), edgeClip("b")], { a: 5, b: 5 }, { ...STACKED, crossfade: false });
      const plan = planFrameAt(off.clips, off.options, 270, EMPTY_FACTS);
      expect(plan.route).toBe("derived");
      expect(layersOf(plan).map((l) => [l.clipId, l.weight])).toEqual([["a", 1]]);
    });
  });

  describe("a placed stack", () => {
    it("is black in a gap, and holds the clip before a gap under a slot", () => {
      const gap = draft([edgeClip("a", { startSec: 0 }), edgeClip("b", { startSec: 6 })], { a: 5, b: 5 }, STACKED);
      expect(planFrameAt(gap.clips, gap.options, 330, EMPTY_FACTS).show).toEqual({ kind: "black" });

      const sliver = draft([edgeClip("a", { startSec: 0 }), edgeClip("b", { startSec: 5.01 })], { a: 5, b: 5 }, STACKED);
      const plan = planFrameAt(sliver.clips, sliver.options, 300, EMPTY_FACTS);
      expect(plan.route).toBe("placed");
      expect(layersOf(plan).map((l) => [l.clipId, l.read.by === "slot" && l.read.slot])).toEqual([["a", 299]]);
    });

    // b (row 1, 0–6 s) under a (row 0, 0.5–5.5 s): a fades in across [0.5, 1) and out across [5, 5.5), and covers b between
    const timeline = [edgeClip("a", { startSec: 0.5 }), edgeClip("b", { startSec: 0 })];
    const lengths = { a: 5, b: 6 };

    it("ends a solo read at its visibility run, not the clip's end", () => {
      const d = draft(timeline, lengths, STACKED);
      const [layer] = layersOf(planFrameAt(d.clips, d.options, 10, EMPTY_FACTS));
      expect(layer).toMatchObject({ clipId: "b", weight: 1 });
      expect(layer.read).toMatchObject({ by: "slot", slot: 10, window: { origin: 0, anchorSlot: 0, endSlot: 60 } });
    });

    it("weighs a blend by the envelope at the middle of the slot, bottom first", () => {
      const d = draft(timeline, lengths, STACKED);
      const p = planPicture(d.clips.map((c) => ({ ...c, sourceDuration: c.duration })), d.options);
      const layers = layersOf(planFrameAt(d.clips, d.options, 45, EMPTY_FACTS));
      const at = new Map(envelopeAt(p.env!, 45.5 / 60).map((l) => [l.unit, l.weight]));
      expect(layers.map((l) => l.clipId)).toEqual(["b", "a"]);
      layers.forEach((layer) => expect(layer.weight).toBeCloseTo(at.get(layer.unit) ?? 0, 12));
      expect(layers[1].weight).toBeCloseTo((45.5 / 60 - 0.5) / 0.5, 9);
    });

    it("shows the top live clip alone with Crossfade off", () => {
      const d = draft(timeline, lengths, { ...STACKED, crossfade: false });
      expect(layersOf(planFrameAt(d.clips, d.options, 45, EMPTY_FACTS)).map((l) => [l.clipId, l.weight])).toEqual([["a", 1]]);
    });
  });

  it("keeps its invariants over random placed layouts", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 40; round++) {
      const count = 2 + Math.floor(random() * 4);
      const ids = Array.from({ length: count }, (_, i) => `c${i}`);
      const lengths = Object.fromEntries(ids.map((id) => [id, 1 + Math.round(random() * 600) / 100]));
      const timeline = ids.map((id) =>
        edgeClip(id, { startSec: Math.round(random() * 800) / 100, inSec: Math.round(random() * 50) / 100 }),
      );
      const crossfade = random() > 0.3;
      const d = draft(timeline, lengths, { ...STACKED, crossfade });
      const facts = new Map<SourceKey, FrameSourceFacts>(
        ids.map((id) => [`edge:${id}` as SourceKey, { firstTimestamp: Math.round(random() * 5) / 100, frameRate: 24 }]),
      );
      const loop = planPicture(d.clips.map((c) => ({ ...c, sourceDuration: c.duration })), d.options).loopLength;
      for (let t = 0; t < loop + 0.5; t += 0.137) {
        const n = frameSlot(t, loop);
        expect(n).toBeLessThan(Math.max(1, secToSlot(loop)));
        const chosen = chooseFrameSlot(d.clips, d.options, t, shownAt(d.spans, t, d.stack));
        expect([n, n - 1]).toContain(chosen);
        const plan = planFrameAt(d.clips, d.options, n, facts);
        const empty = planFrameAt(d.clips, d.options, n, EMPTY_FACTS);
        expect(new Set(plan.sources).size).toBe(plan.sources.length);
        expect(plan.sources.every((source) => empty.sources.includes(source))).toBe(true);
        // Placed layouts have no dissolves, so the facts never change which clips show
        expect([...visibleClipIds(plan)].sort()).toEqual([...visibleClipIds(empty)].sort());
        const layers = layersOf(plan);
        if (layers.length > 0) {
          expect(layers.reduce((sum, l) => sum + l.weight, 0)).toBeCloseTo(1, 9);
          // Bottom first: rows descend
          const rows = layers.map((l) => d.clips.findIndex((c) => c.clipId === l.clipId));
          expect([...rows].sort((a, b) => b - a)).toEqual(rows);
        }
      }
    }
  });
});
