import { describe, expect, it } from "vitest";
import type { StitchSequenceLayout, StitchTimelineClip } from "@/types";
import {
  copyClips,
  duplicateAt,
  pastableItems,
  pasteIntoTimeline,
  skippedMessage,
  type ClipboardAudioItem,
  type ClipboardOrigin,
  type ClipboardVideoItem,
  type PasteTarget,
  type StitchClipboard,
} from "../clipboard";
import { copyAudioItems, createAudioClip } from "../audioClips";
import {
  createClip,
  layoutSpans,
  MAX_START_SEC,
  spansEnvelope,
  type SourceDurations,
  type SourceKey,
} from "../timeline";

const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const assetClip = (id: string, assetId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "asset", assetId }, { id, ...init });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

const TRACK: StitchSequenceLayout = { mode: "track", overlapSec: 1, crossfade: true };
const STACKED: StitchSequenceLayout = { mode: "stacked", overlapSec: 1, crossfade: true };
const d = durations({ "edge:e1": 5, "edge:e2": 5, "edge:e3": 6, "asset:x": 4 });
const ORIGIN: ClipboardOrigin = { kind: "node", nodeId: "n1", tabId: "t1", workflowId: "w1" };
const ids = (timeline: readonly StitchTimelineClip[]) => timeline.map((c) => c.id);
const counter = (prefix = "p") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

const item = (source: ClipboardVideoItem["source"], offsetSec = 0, rest: Partial<ClipboardVideoItem> = {}): ClipboardVideoItem => ({
  track: "video",
  source,
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  offsetSec,
  ...rest,
});

describe("copyClips", () => {
  const track = [edgeClip("a", "e1"), edgeClip("b", "e2", { inSec: 1, outSec: 4, muted: true, volume: 0.5 }), assetClip("c", "x")];

  it("copies Track clips end to end, in timeline order, with every field", () => {
    const copy = copyClips({ timeline: track, sequenceLayout: TRACK }, d, ["c", "a", "b"], ORIGIN)!;
    expect(copy.origin).toEqual(ORIGIN);
    expect(copy.items.map((i) => i.offsetSec)).toEqual([0, 5, 8]);
    expect(copy.items[1]).toEqual({
      track: "video",
      source: { kind: "edge", edgeId: "e2" },
      inSec: 1,
      outSec: 4,
      muted: true,
      volume: 0.5,
      offsetSec: 5,
    });
  });

  it("measures offsets from the earliest copied start, with the gaps of a placed stack", () => {
    const placed = [edgeClip("a", "e1", { startSec: 9 }), edgeClip("b", "e2", { startSec: 2 }), edgeClip("c", "e3", { startSec: 20 })];
    const copy = copyClips({ timeline: placed, sequenceLayout: STACKED }, d, ["a", "b"], ORIGIN)!;
    expect(copy.items.map((i) => [i.source, i.offsetSec])).toEqual([
      [{ kind: "edge", edgeId: "e1" }, 7],
      [{ kind: "edge", edgeId: "e2" }, 0],
    ]);
  });

  it("keeps the overlaps of a lined-up stack", () => {
    // Lined up at Overlap 1: 0–5, 4–9, 8–14
    const lined = [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
    const copy = copyClips({ timeline: lined, sequenceLayout: STACKED }, d, ["b", "c", "nope"], ORIGIN)!;
    expect(copy.items.map((i) => i.offsetSec)).toEqual([0, 4]);
  });

  it("gives null when no listed clip is in the timeline", () => {
    expect(copyClips({ timeline: track, sequenceLayout: TRACK }, d, [], ORIGIN)).toBeNull();
    expect(copyClips({ timeline: track, sequenceLayout: TRACK }, d, ["nope"], ORIGIN)).toBeNull();
  });
});

describe("pastableItems and skippedMessage", () => {
  const clipboard: StitchClipboard = {
    origin: ORIGIN,
    items: [item({ kind: "asset", assetId: "x" }), item({ kind: "edge", edgeId: "e1" }), item({ kind: "edge", edgeId: "e2" })],
  };
  const own: PasteTarget = { kind: "node", nodeId: "n1", tabId: "t1", workflowId: "w1", liveEdgeIds: ["e1", "e2"] };

  it("pastes everything into its own node while the edges are connected", () => {
    expect(pastableItems(clipboard, own)).toEqual({ items: clipboard.items, skipped: [] });
  });

  it("pastes library clips anywhere, and skips edge clips in any other node, tab or workflow", () => {
    for (const other of [
      { ...own, nodeId: "n2" },
      { ...own, tabId: "t2" },
      { ...own, workflowId: "w2" },
      { ...own, workflowId: null },
    ]) {
      expect(pastableItems(clipboard, other)).toEqual({
        items: [clipboard.items[0]],
        skipped: [{ reason: "otherNode", count: 2 }],
      });
    }
  });

  it("skips an edge clip whose edge is no longer connected to its own node", () => {
    expect(pastableItems(clipboard, { ...own, liveEdgeIds: ["e2"] })).toEqual({
      items: [clipboard.items[0], clipboard.items[2]],
      skipped: [{ reason: "disconnected", count: 1 }],
    });
  });

  it("counts reasons in the order otherNode, disconnected", () => {
    const mixed: StitchClipboard = { ...clipboard, items: [...clipboard.items, item({ kind: "edge", edgeId: "e3" })] };
    // From the same node, e3 is not connected; nothing is from another node
    expect(pastableItems(mixed, own).skipped).toEqual([{ reason: "disconnected", count: 1 }]);
    expect(
      skippedMessage([
        { reason: "otherNode", count: 2 },
        { reason: "disconnected", count: 1 },
      ]),
    ).toBe(
      "2 clips not pasted: clips from connected videos paste only into their own node. 1 clip not pasted: its video is no longer connected.",
    );
  });

  it("words each reason for one clip and for several", () => {
    expect(skippedMessage([{ reason: "otherNode", count: 1 }])).toBe(
      "1 clip not pasted: clips from connected videos paste only into their own node.",
    );
    expect(skippedMessage([{ reason: "otherNode", count: 2 }])).toBe(
      "2 clips not pasted: clips from connected videos paste only into their own node.",
    );
    expect(skippedMessage([{ reason: "disconnected", count: 1 }])).toBe(
      "1 clip not pasted: its video is no longer connected.",
    );
    expect(skippedMessage([{ reason: "disconnected", count: 3 }])).toBe(
      "3 clips not pasted: their videos are no longer connected.",
    );
    expect(skippedMessage([])).toBeNull();
  });
});

describe("pasting with an edit project", () => {
  const EDIT: PasteTarget = { kind: "edit", editId: "ed0000000000a1" };
  const video = [item({ kind: "asset", assetId: "x" }), item({ kind: "edge", edgeId: "e1" }), item({ kind: "edge", edgeId: "e2" })];
  const music: ClipboardAudioItem = {
    track: "audio",
    source: { kind: "music" },
    inSec: 0,
    outSec: null,
    muted: false,
    curve: [],
    offsetSec: 0,
    rowOffset: 0,
  };
  const tone: ClipboardAudioItem = { ...music, source: { kind: "asset", assetId: "atone00000001" } };

  it("pastes a node's library clips into an edit and skips its connected videos and music", () => {
    expect(pastableItems({ origin: ORIGIN, items: video }, EDIT)).toEqual({
      items: [video[0]],
      skipped: [{ reason: "notInEdit", count: 2 }],
    });
    expect(pastableItems({ origin: ORIGIN, items: [tone, music] }, EDIT)).toEqual({
      items: [tone],
      skipped: [{ reason: "notInEdit", count: 1 }],
    });
  });

  it("pastes an edit's clips into another edit and into any node", () => {
    const fromEdit: StitchClipboard = { origin: { kind: "edit", editId: "ed0000000000b2" }, items: [video[0]] };
    expect(pastableItems(fromEdit, EDIT)).toEqual({ items: [video[0]], skipped: [] });
    const node: PasteTarget = { kind: "node", nodeId: "n1", tabId: "t1", workflowId: "w1", liveEdgeIds: [] };
    expect(pastableItems(fromEdit, node)).toEqual({ items: [video[0]], skipped: [] });
  });

  it("words the reason for one clip and for several", () => {
    expect(skippedMessage([{ reason: "notInEdit", count: 1 }])).toBe(
      "1 clip not pasted: an edit holds only clips from the library, not connected videos or music.",
    );
    expect(skippedMessage([{ reason: "notInEdit", count: 3 }])).toBe(
      "3 clips not pasted: an edit holds only clips from the library, not connected videos or music.",
    );
  });
});

describe("audio items", () => {
  const audio = (source: ClipboardAudioItem["source"], offsetSec = 0, rowOffset = 0): ClipboardAudioItem => ({
    track: "audio",
    source,
    inSec: 0,
    outSec: null,
    muted: false,
    curve: [],
    offsetSec,
    rowOffset,
  });
  const clipboard: StitchClipboard = {
    origin: ORIGIN,
    items: [audio({ kind: "asset", assetId: "atone00000001" }), audio({ kind: "music" }, 2, 1), audio({ kind: "music" }, 3, 2)],
  };
  const own: PasteTarget = { kind: "node", nodeId: "n1", tabId: "t1", workflowId: "w1", liveEdgeIds: [] };

  it("copies offsets from the earliest start and row offsets from the top row", () => {
    const clips = [
      createAudioClip({ kind: "music" }, { id: "m", row: 1, startSec: 4 }),
      createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id: "t", row: 3, startSec: 1.5, inSec: 0.5, outSec: 2 }),
    ];
    expect(copyAudioItems(clips, ["t", "m"])).toEqual([
      { ...audio({ kind: "music" }, 2.5, 0) },
      { ...audio({ kind: "asset", assetId: "atone00000001" }, 0, 2), inSec: 0.5, outSec: 2 },
    ]);
  });

  it("pastes library audio anywhere, and music only into its own node, whether or not it is connected", () => {
    expect(pastableItems(clipboard, own)).toEqual({ items: clipboard.items, skipped: [] });
    for (const other of [
      { ...own, nodeId: "n2" },
      { ...own, tabId: "t2" },
      { ...own, workflowId: "w2" },
      { ...own, workflowId: null },
    ]) {
      expect(pastableItems(clipboard, other)).toEqual({
        items: [clipboard.items[0]],
        skipped: [{ reason: "music", count: 2 }],
      });
    }
  });

  it("words the music reason, after the others", () => {
    expect(skippedMessage([{ reason: "music", count: 1 }])).toBe(
      "1 music clip not pasted: music clips paste only into their own node.",
    );
    expect(skippedMessage([{ reason: "music", count: 2 }])).toBe(
      "2 music clips not pasted: music clips paste only into their own node.",
    );
    expect(
      skippedMessage([
        { reason: "otherNode", count: 1 },
        { reason: "disconnected", count: 2 },
        { reason: "music", count: 1 },
      ]),
    ).toBe(
      "1 clip not pasted: clips from connected videos paste only into their own node. 2 clips not pasted: their videos are no longer connected. 1 music clip not pasted: music clips paste only into their own node.",
    );
  });
});

describe("pasteIntoTimeline in Track", () => {
  const track = () => [edgeClip("a", "e1"), edgeClip("b", "e2", { startSec: 3 }), edgeClip("c", "e3")];
  const items = [item({ kind: "asset", assetId: "x" }, 0, { inSec: 1, outSec: 3, muted: true, volume: 0.25 }), item({ kind: "edge", edgeId: "e1" }, 2)];

  it("inserts after the given index, at the end and at the top", () => {
    expect(ids(pasteIntoTimeline(track(), d, TRACK, items, { afterIndex: 0, startSec: 0 }, counter()).timeline)).toEqual([
      "a",
      "p1",
      "p2",
      "b",
      "c",
    ]);
    expect(ids(pasteIntoTimeline(track(), d, TRACK, items, { afterIndex: 2, startSec: 0 }, counter()).timeline)).toEqual([
      "a",
      "b",
      "c",
      "p1",
      "p2",
    ]);
    expect(ids(pasteIntoTimeline(track(), d, TRACK, items, { afterIndex: 99, startSec: 0 }, counter()).timeline)).toEqual([
      "a",
      "b",
      "c",
      "p1",
      "p2",
    ]);
    expect(ids(pasteIntoTimeline(track(), d, TRACK, items, { afterIndex: -1, startSec: 0 }, counter()).timeline)).toEqual([
      "p1",
      "p2",
      "a",
      "b",
      "c",
    ]);
  });

  it("copies the fields, gives no start, keeps stored starts and pins nothing", () => {
    const before = track();
    const { timeline, ids: pasted } = pasteIntoTimeline(before, d, TRACK, items, { afterIndex: 0, startSec: 12 }, counter());
    expect(pasted).toEqual(["p1", "p2"]);
    expect(timeline[1]).toEqual({ id: "p1", source: { kind: "asset", assetId: "x" }, inSec: 1, outSec: 3, muted: true, volume: 0.25 });
    expect("startSec" in timeline[2]).toBe(false);
    expect(timeline[0]).toBe(before[0]);
    expect(timeline[3]).toBe(before[1]);
    expect(timeline[3].startSec).toBe(3);
    expect(timeline[4].startSec).toBeUndefined();
  });

  it("goes between the pieces of a split: Track has no runs", () => {
    const split = [edgeClip("a1", "e1", { outSec: 2 }), edgeClip("a2", "e1", { inSec: 2 })];
    expect(ids(pasteIntoTimeline(split, d, TRACK, [items[1]], { afterIndex: 0, startSec: 0 }, counter()).timeline)).toEqual([
      "a1",
      "p1",
      "a2",
    ]);
  });

  it("gives new, distinct ids each time, and the same timeline for no items", () => {
    const first = pasteIntoTimeline(track(), d, TRACK, items, { afterIndex: 2, startSec: 0 });
    const second = pasteIntoTimeline(first.timeline, d, TRACK, items, { afterIndex: 4, startSec: 0 });
    const all = ids(second.timeline);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(7);
    const before = track();
    const none = pasteIntoTimeline(before, d, TRACK, [], { afterIndex: 0, startSec: 0 });
    expect(none.timeline).toBe(before);
    expect(none.ids).toEqual([]);
  });
});

describe("pasteIntoTimeline in Stacked", () => {
  const startsOf = (timeline: StitchTimelineClip[]) => layoutSpans(timeline, d, STACKED).map((s) => s.start);

  it("pins a lined-up stack and starts the pasted clips at the playhead plus their offsets, on rows below", () => {
    // Lined up at Overlap 1: 0–5, 4–9, 8–14
    const lined = [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
    const shown = startsOf(lined);
    const items = [item({ kind: "asset", assetId: "x" }, 0), item({ kind: "edge", edgeId: "e1" }, 3.2)];
    const { timeline, ids: pasted } = pasteIntoTimeline(lined, d, STACKED, items, { afterIndex: 1, startSec: 20 }, counter());
    expect(ids(timeline)).toEqual(["a", "b", "p1", "p2", "c"]);
    expect(pasted).toEqual(["p1", "p2"]);
    expect(timeline.map((c) => c.startSec)).toEqual([shown[0], shown[1], 20, 23.2, shown[2]]);
  });

  it("clamps each start at 10:00", () => {
    const items = [item({ kind: "asset", assetId: "x" }, 0), item({ kind: "asset", assetId: "x" }, 5)];
    const { timeline } = pasteIntoTimeline([], d, STACKED, items, { afterIndex: -1, startSec: MAX_START_SEC - 2 });
    expect(timeline.map((c) => c.startSec)).toEqual([MAX_START_SEC - 2, MAX_START_SEC]);
  });

  describe("never inside a split", () => {
    // Clip A split into rows 0–1 (one run), clip B on row 2
    const placed = () => [
      edgeClip("a1", "e1", { startSec: 0, outSec: 3 }),
      edgeClip("a2", "e1", { startSec: 3, inSec: 3 }),
      edgeClip("b", "e2", { startSec: 1.5 }),
    ];
    const one = [item({ kind: "asset", assetId: "x" }, 0)];
    const runOf = (timeline: StitchTimelineClip[], clipId: string) => {
      const spans = layoutSpans(timeline, d, STACKED);
      const env = spansEnvelope(spans, true);
      const unit = env.units.findIndex((u) => spans[u.row].clip.id === clipId);
      return env.runs[env.runOf[unit]].units.map((u) => spans[env.units[u].row].clip.id);
    };

    it("puts the pasted row after the run's last piece, from either piece", () => {
      for (const afterIndex of [0, 1]) {
        const { timeline } = pasteIntoTimeline(placed(), d, STACKED, one, { afterIndex, startSec: 8 }, counter());
        expect(ids(timeline)).toEqual(["a1", "a2", "p1", "b"]);
        expect(runOf(timeline, "a1")).toEqual(["a1", "a2"]);
      }
    });

    it("does the same in a lined-up stack, once pinned", () => {
      const lined = [edgeClip("a1", "e1", { outSec: 3 }), edgeClip("a2", "e1", { inSec: 3 }), edgeClip("b", "e2")];
      const { timeline } = pasteIntoTimeline(lined, d, STACKED, one, { afterIndex: 0, startSec: 8 }, counter());
      expect(ids(timeline)).toEqual(["a1", "a2", "p1", "b"]);
      expect(runOf(timeline, "a1")).toEqual(["a1", "a2"]);
    });

    it("keeps every run of the clips that were there", () => {
      const before = placed();
      const { timeline } = pasteIntoTimeline(before, d, STACKED, one, { afterIndex: 0, startSec: 0.5 }, counter());
      expect(runOf(timeline, "a1")).toEqual(runOf(before, "a1"));
      expect(runOf(timeline, "b")).toEqual(["b"]);
    });
  });
});

describe("duplicateAt", () => {
  it("goes after the last selected clip, starting at the latest selected end", () => {
    const placed = [edgeClip("a", "e1", { startSec: 9 }), edgeClip("b", "e2", { startSec: 2 }), edgeClip("c", "e3", { startSec: 0 })];
    const spans = layoutSpans(placed, d, STACKED);
    expect(duplicateAt(spans, new Set(["a", "b"]))).toEqual({ afterIndex: 1, startSec: 14 });
    expect(duplicateAt(spans, new Set(["b", "c"]))).toEqual({ afterIndex: 2, startSec: 7 });
    expect(duplicateAt(spans, new Set())).toEqual({ afterIndex: 2, startSec: 0 });
  });
});
