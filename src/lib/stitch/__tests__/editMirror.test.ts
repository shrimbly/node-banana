import { describe, expect, it } from "vitest";
import { mirrorDraft, mirrorIsEmpty, type MirrorSources } from "../editMirror";
import type { StitchDraft } from "../draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "../stack";
import type { SourceKey } from "../timeline";
import type { StitchAudioClip, StitchTimelineClip } from "@/types";

const clip = (id: string, source: StitchTimelineClip["source"], extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source,
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});
const audio = (id: string, source: StitchAudioClip["source"], row = 0): StitchAudioClip => ({
  id,
  source,
  row,
  startSec: 0,
  inSec: 0,
  outSec: null,
  muted: false,
  curve: [],
});
const draft = (timeline: StitchTimelineClip[], audioClips: StitchAudioClip[] = []): StitchDraft => ({
  timeline,
  audioClips,
  legacyAudio: { curve: [{ t: 0, gain: 0.5 }], muted: true },
  loopCount: 2,
  sequenceLayout: { ...DEFAULT_SEQUENCE_LAYOUT },
});
const sources = (videos: Record<string, string | null>, music: string | null = null): MirrorSources => ({
  videoAssetOfEdge: (edgeId) => videos[edgeId] ?? null,
  musicAsset: () => music,
});
const measured = new Map<SourceKey, number>([
  ["edge:eA", 5],
  ["edge:eB", 4],
  ["asset:L1", 3],
]);

describe("mirrorDraft", () => {
  it("replaces each socket clip by the asset it plays and keeps the clip otherwise", () => {
    const d = draft([
      clip("c1", { kind: "edge", edgeId: "eA" }, { inSec: 1, outSec: 4, muted: true, volume: 0.5, startSec: 2 }),
      clip("c2", { kind: "asset", assetId: "L1" }),
    ]);
    const out = mirrorDraft(d, sources({ eA: "A1" }), measured);
    expect(out.draft.timeline).toEqual([
      clip("c1", { kind: "asset", assetId: "A1" }, { inSec: 1, outSec: 4, muted: true, volume: 0.5, startSec: 2 }),
      clip("c2", { kind: "asset", assetId: "L1" }),
    ]);
    expect(out.leftOut).toBe(0);
    expect(out.draft.loopCount).toBe(2);
    expect(out.draft.sequenceLayout).toEqual(DEFAULT_SEQUENCE_LAYOUT);
  });

  it("carries the measured length of a socket clip over to its asset", () => {
    const out = mirrorDraft(draft([clip("c1", { kind: "edge", edgeId: "eA" })]), sources({ eA: "A1" }), measured);
    expect(out.durations.get("asset:A1")).toBe(5);
    expect(out.durations.get("asset:L1")).toBe(3);
  });

  it("leaves out a clip whose video the library does not hold, and counts it", () => {
    const d = draft([clip("c1", { kind: "edge", edgeId: "eA" }), clip("c2", { kind: "edge", edgeId: "eB" })]);
    const out = mirrorDraft(d, sources({ eA: null, eB: "B1" }), measured);
    expect(out.draft.timeline.map((c) => c.id)).toEqual(["c2"]);
    expect(out.leftOut).toBe(1);
  });

  it("turns the music clip into an audio clip of the music's asset, with its row, trim and curve", () => {
    const music: StitchAudioClip = { ...audio("audio:music", { kind: "music" }), inSec: 2, curve: [{ t: 0, gain: 0 }] };
    const d = draft([clip("c1", { kind: "edge", edgeId: "eA" })], [music, audio("a2", { kind: "asset", assetId: "S1" }, 1)]);
    const out = mirrorDraft(d, sources({ eA: "A1" }, "M1"), measured);
    expect(out.draft.audioClips).toEqual([
      { ...music, source: { kind: "asset", assetId: "M1" } },
      audio("a2", { kind: "asset", assetId: "S1" }, 1),
    ]);
    expect(out.draft.legacyAudio).toEqual({ curve: [], muted: false });
  });

  it("leaves out the music when it is not in the library", () => {
    const d = draft([clip("c1", { kind: "edge", edgeId: "eA" })], [audio("audio:music", { kind: "music" })]);
    const out = mirrorDraft(d, sources({ eA: "A1" }, null), measured);
    expect(out.draft.audioClips).toEqual([]);
    expect(out.leftOut).toBe(1);
  });

  it("is empty when no clip survives", () => {
    const out = mirrorDraft(draft([clip("c1", { kind: "edge", edgeId: "eA" })]), sources({}), measured);
    expect(mirrorIsEmpty(out)).toBe(true);
    expect(mirrorIsEmpty(mirrorDraft(draft([clip("c1", { kind: "asset", assetId: "L1" })]), sources({}), measured))).toBe(false);
  });
});
