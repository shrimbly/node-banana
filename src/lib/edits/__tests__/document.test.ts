import { describe, expect, it } from "vitest";
import type { AssetView } from "@/lib/assets/types";
import { createAudioClip } from "@/lib/stitch/audioClips";
import { sameDraft } from "@/lib/stitch/draft";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import {
  containsMediaString,
  copyName,
  coverEditMedia,
  draftFromEditSequence,
  editAssetIds,
  editMediaOf,
  editSequenceFromDraft,
  emptyEditSequence,
  firstFreeName,
  normalizeEditName,
  parseEditDocument,
  sanitizeEditAssets,
  sanitizeEditMedia,
  sanitizeEditSequence,
  snapshotEditAssets,
  summarizeEdit,
} from "../document";
import { EDIT_KIND, type EditDocument, type EditSequence } from "../types";

const A = "a0000000000001";
const B = "a0000000000002";
const M = "a0000000000003";
const ID = "ed0000000000000001";

const video = (id: string, assetId: string, init: Parameters<typeof createClip>[1] = {}) =>
  createClip({ kind: "asset", assetId }, { id, ...init });
const audio = (id: string, assetId: string, init: Parameters<typeof createAudioClip>[1] = {}) =>
  createAudioClip({ kind: "asset", assetId }, { id, ...init });

function documentOf(overrides: Partial<EditDocument> = {}): EditDocument {
  return {
    kind: EDIT_KIND,
    version: 1,
    id: ID,
    name: "Holiday",
    createdAt: 1,
    updatedAt: 2,
    sequence: { ...emptyEditSequence(), timeline: [video("c1", A)] },
    media: [A],
    assets: { [A]: { name: "a.mp4", kind: "video", project: "Trip", durationSec: 4 } },
    renders: [],
    summary: { clipCount: 1, audioClipCount: 0, durationSec: 4, posterAssetId: A },
    ...overrides,
  };
}

function view(id: string, overrides: Partial<AssetView> = {}): AssetView {
  return {
    v: 1,
    id,
    kind: "video",
    origin: "generated",
    mime: "video/mp4",
    ext: "mp4",
    bytes: 3,
    sha256: "ab".repeat(32),
    md5: "0".repeat(32),
    file: { root: "library", rel: "Generations/2026-10-18/x.mp4" },
    filename: `${id}.mp4`,
    createdAt: 1,
    producer: { nodeId: "n1", nodeType: "generateVideo" },
    workflowId: "wf_1",
    workflowName: "Flow",
    runId: "r0000000000001",
    tags: [],
    favorite: false,
    durationSec: 6,
    workflow: { id: "wf_1", name: "Flow", projectPath: "/Users/me/Node Banana/Spring" },
    displayPath: "/x.mp4",
    ...overrides,
  };
}

describe("parseEditDocument (T-DOC-1)", () => {
  it("reads a valid document as it was written", () => {
    const doc = documentOf();
    expect(parseEditDocument(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, document: doc });
  });

  it("calls a document missing a field unreadable", () => {
    for (const field of ["kind", "version", "id", "name", "createdAt", "updatedAt", "sequence"] as const) {
      const raw: Record<string, unknown> = { ...documentOf() };
      delete raw[field];
      expect(parseEditDocument(raw), field).toMatchObject({ ok: false, problem: "unreadable" });
    }
  });

  it("calls a later version newer and keeps its name and id", () => {
    expect(parseEditDocument({ ...documentOf(), version: 2, sequence: "whatever" })).toEqual({
      ok: false,
      problem: "newer",
      name: "Holiday",
      id: ID,
    });
  });

  it("calls anything that is not an object unreadable", () => {
    for (const raw of [null, "edit", 3, [documentOf()]]) {
      expect(parseEditDocument(raw)).toEqual({ ok: false, problem: "unreadable", name: null, id: null });
    }
  });

  it("fills a missing summary, assets and renders from the sequence", () => {
    const raw: Record<string, unknown> = { ...documentOf() };
    delete raw.summary;
    delete raw.assets;
    delete raw.renders;
    const parsed = parseEditDocument(raw);
    expect(parsed).toMatchObject({
      ok: true,
      document: { assets: {}, renders: [], summary: { clipCount: 1, audioClipCount: 0, durationSec: 0, posterAssetId: A } },
    });
  });
});

describe("sequence ⇄ draft (T-DOC-2)", () => {
  const sequences: Record<string, EditSequence> = {
    track: { ...emptyEditSequence(), timeline: [video("c1", A, { inSec: 1, outSec: 3 }), video("c2", B, { muted: true })] },
    linedUpStack: {
      timeline: [video("c1", A), video("c2", B)],
      audioClips: [],
      loopCount: 2,
      sequenceLayout: { mode: "stacked", overlapSec: 1.5, crossfade: false },
    },
    placedStack: {
      timeline: [video("c1", A, { startSec: 0 }), video("c2", B, { startSec: 2.5, volume: 0.5 })],
      audioClips: [],
      loopCount: 1,
      sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true },
    },
    withAudio: {
      ...emptyEditSequence(),
      timeline: [video("c1", A)],
      audioClips: [
        audio("m1", M, { row: 0, startSec: 0, curve: [{ t: 0, gain: 0.5 }] }),
        audio("m2", M, { row: 1, startSec: 2, inSec: 1, outSec: 4, muted: true }),
      ],
      loopCount: 3,
    },
  };

  for (const [label, sequence] of Object.entries(sequences)) {
    it(`round-trips ${label}`, () => {
      const draft = draftFromEditSequence(sequence);
      expect(draft.legacyAudio).toEqual({ curve: [], muted: false });
      expect(editSequenceFromDraft(draft)).toEqual(sanitizeEditSequence(sequence));
      expect(editSequenceFromDraft(draft)).toEqual(sequence);
      expect(sameDraft(draftFromEditSequence(editSequenceFromDraft(draft)), draft)).toBe(true);
    });
  }

  it("tells different sequences apart", () => {
    const a = draftFromEditSequence(sequences.track);
    const b = draftFromEditSequence({ ...sequences.track, loopCount: 2 });
    expect(sameDraft(a, b)).toBe(false);
  });

  it("compacts the draft's empty audio rows on the way back", () => {
    const draft = { ...draftFromEditSequence(sequences.withAudio) };
    draft.audioClips = draft.audioClips.map((clip) => (clip.id === "m2" ? { ...clip, row: 3 } : clip));
    expect(editSequenceFromDraft(draft).audioClips.map((clip) => clip.row)).toEqual([0, 1]);
  });

  it("lists the asset ids in use, timeline then audio, once each", () => {
    expect(editAssetIds({ timeline: [video("c1", B), video("c2", A), video("c3", B)], audioClips: [audio("m", A), audio("n", M)] })).toEqual([
      B,
      A,
      M,
    ]);
  });
});

describe("sanitizeEditSequence (T-DOC-3)", () => {
  it("keeps library sources only and coerces the rest", () => {
    const seq = sanitizeEditSequence({
      timeline: [
        video("c1", A),
        createClip({ kind: "edge", edgeId: "e1" }, { id: "c2" }),
        { id: "c3", source: { kind: "asset", assetId: "../browse-directory?" }, inSec: 0, outSec: null, muted: false, volume: 1 },
        { ...video("c4", B), startSec: Number.POSITIVE_INFINITY },
      ],
      audioClips: [{ id: "music", source: { kind: "music" }, row: 0, startSec: 0, inSec: 0, outSec: null, muted: false, curve: [] }, audio("m1", M)],
      loopCount: 7,
      sequenceLayout: { mode: "stacked", overlapSec: 2, crossfade: true },
    });
    expect(seq.timeline.map((clip) => clip.id)).toEqual(["c1", "c4"]);
    expect(seq.timeline[1]).not.toHaveProperty("startSec");
    expect(seq.audioClips.map((clip) => clip.id)).toEqual(["m1"]);
    expect(seq.loopCount).toBe(1);
    expect(seq.sequenceLayout).toEqual({ mode: "stacked", overlapSec: 2, crossfade: true });
  });

  it("reads anything else as an empty sequence", () => {
    expect(sanitizeEditSequence(null)).toEqual(emptyEditSequence());
    expect(sanitizeEditSequence({ timeline: "no" })).toEqual(emptyEditSequence());
  });
});

describe("snapshotEditAssets (T-DOC-4)", () => {
  const previous = {
    [A]: { name: "old-a.mp4", kind: "video" as const, project: null, durationSec: 3 },
    [B]: { name: "old-b.mp4", kind: "video" as const, project: "Old", durationSec: 5 },
    [M]: { name: "old-m.m4a", kind: "audio" as const, project: null, durationSec: 9 },
  };

  it("takes a known record's facts, keeps the previous entry for one the library lost, and drops unused ids", () => {
    const lookup = (id: string) => (id === A ? view(A) : id === B ? null : undefined);
    expect(snapshotEditAssets([A, B], lookup, previous)).toEqual({
      [A]: { name: `${A}.mp4`, kind: "video", project: "Spring", durationSec: 6 },
      [B]: previous[B],
    });
  });

  it("never invents an entry", () => {
    expect(snapshotEditAssets(["a0000000000099"], () => undefined, previous)).toEqual({});
  });

  it("keeps the name the asset was given rather than its file's", () => {
    const lookup = () => view(A, { name: "Opening shot" });
    expect(snapshotEditAssets([A], lookup, previous)[A]).toMatchObject({ name: "Opening shot" });
  });

  it("says no project for an asset in none", () => {
    const lookup = () => view(M, { kind: "audio", durationSec: undefined, workflow: { id: "w", name: null, projectPath: null } });
    expect(snapshotEditAssets([M], lookup, {})).toEqual({ [M]: { name: `${M}.mp4`, kind: "audio", project: null, durationSec: null } });
  });
});

describe("summarizeEdit (T-DOC-5)", () => {
  const durations = (entries: [string, number][]) => new Map(entries.map(([id, sec]) => [`asset:${id}` as SourceKey, sec]));

  it("counts one loop × loopCount", () => {
    const draft = draftFromEditSequence({ ...emptyEditSequence(), timeline: [video("c1", A), video("c2", B)], loopCount: 3 });
    expect(summarizeEdit(draft, durations([[A, 2], [B, 1.5]]))).toEqual({
      clipCount: 2,
      audioClipCount: 0,
      durationSec: 10.5,
      posterAssetId: A,
    });
  });

  it("measures a placed stack to its latest end", () => {
    const draft = draftFromEditSequence({
      timeline: [video("c1", A, { startSec: 0 }), video("c2", B, { startSec: 5 })],
      audioClips: [audio("m1", M)],
      loopCount: 1,
      sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true },
    });
    expect(summarizeEdit(draft, durations([[A, 3], [B, 2]]))).toMatchObject({ durationSec: 7, audioClipCount: 1 });
  });

  it("uses the lengths it is given for clips not yet measured, so the length is not 0", () => {
    const draft = draftFromEditSequence({ ...emptyEditSequence(), timeline: [video("c1", A)] });
    expect(summarizeEdit(draft, new Map()).durationSec).toBe(0);
    // What provisionalDurations gives for a clip the browser has not measured yet: the record's length.
    expect(summarizeEdit(draft, durations([[A, 6]])).durationSec).toBe(6);
  });

  it("has no poster without a clip", () => {
    expect(summarizeEdit(draftFromEditSequence(emptyEditSequence()), new Map())).toEqual({
      clipCount: 0,
      audioClipCount: 0,
      durationSec: 0,
      posterAssetId: null,
    });
  });
});

describe("names (T-DOC-6)", () => {
  it("normalises", () => {
    expect(normalizeEditName("  Summer \n  cut  ")).toBe("Summer cut");
    expect(normalizeEditName("Café")).toBe("Café");
    expect(normalizeEditName("   ")).toBe("Untitled edit");
    expect(normalizeEditName("")).toBe("Untitled edit");
    expect(normalizeEditName("x".repeat(81))).toBe("x".repeat(80));
    // Never half an emoji: a cut through a surrogate pair drops the pair
    expect(normalizeEditName(`a${"😀".repeat(40)}`)).toBe(`a${"😀".repeat(39)}`);
  });

  it("finds the first free name, comparing case-insensitively", () => {
    const key = (name: string) => name.toLowerCase();
    expect(firstFreeName("Untitled edit", new Set(), key)).toBe("Untitled edit");
    expect(firstFreeName("Untitled edit", new Set(["untitled edit", "untitled edit 2"]), key)).toBe("Untitled edit 3");
    expect(firstFreeName("x".repeat(80), new Set(["x".repeat(80)]), key)).toBe(`${"x".repeat(78)} 2`);
    const emoji = `a${"😀".repeat(39)}`;
    expect(firstFreeName(emoji, new Set([key(emoji)]), key)).toBe(`a${"😀".repeat(38)} 2`);
  });

  it("names a copy", () => {
    expect(copyName("Holiday")).toBe("Holiday copy");
    expect(copyName("y".repeat(80))).toBe(`${"y".repeat(75)} copy`);
    const key = (name: string) => name.toLowerCase();
    expect(firstFreeName(copyName("Holiday"), new Set(["holiday copy"]), key)).toBe("Holiday copy 2");
  });
});

describe("containsMediaString (T-DOC-7)", () => {
  it("finds data: and blob: URLs deep in arrays and objects, keys included", () => {
    expect(containsMediaString({ a: [{ b: { c: ["x", "data:image/png;base64,AAAA"] } }] })).toBe(true);
    expect(containsMediaString([[["blob:http://localhost:3000/5f1c"]]])).toBe(true);
    expect(containsMediaString({ "data:,x": 1 })).toBe(true);
    expect(containsMediaString({ name: "Holiday", n: 3, ok: true, none: null })).toBe(false);
  });

  it("lets a name start with the word", () => {
    expect(containsMediaString({ name: "Data: Q3 review" })).toBe(false);
    expect(containsMediaString({ name: "blob: the movie" })).toBe(false);
  });
});

describe("media (T-DOC-8)", () => {
  const sequence: EditSequence = { ...emptyEditSequence(), timeline: [video("c1", B), video("c2", A)], audioClips: [audio("m1", M)] };

  it("reads a file saved before edits had media as the sequence's assets, in first-use order", () => {
    const raw: Record<string, unknown> = { ...documentOf({ sequence }) };
    delete raw.media;
    const parsed = parseEditDocument(raw);
    expect(parsed).toMatchObject({ ok: true, document: { media: [B, A, M] } });
    expect(sanitizeEditMedia("not a list", sequence)).toEqual([B, A, M]);
  });

  it("keeps asset ids once each in their order, drops anything else, and adds the sequence's assets it lacks", () => {
    const C = "a0000000000004";
    expect(sanitizeEditMedia([C, "../x", 7, A, C, null, "data:,x"], sequence)).toEqual([C, A, B, M]);
    expect(sanitizeEditMedia([], emptyEditSequence())).toEqual([]);
  });

  it("keeps the snapshot of media the timeline does not use, and drops the rest", () => {
    const C = "a0000000000004";
    const parsed = parseEditDocument({
      ...documentOf(),
      media: [C, A],
      assets: {
        [A]: { name: "a.mp4", kind: "video", project: null, durationSec: 4 },
        [C]: { name: "beach.mp4", kind: "video", project: "Trip", durationSec: 2 },
        [B]: { name: "gone.mp4", kind: "video", project: null, durationSec: 1 },
      },
    });
    expect(parsed.ok && parsed.document.media).toEqual([C, A]);
    expect(parsed.ok && Object.keys(parsed.document.assets)).toEqual([C, A]);
    expect(sanitizeEditAssets({ [A]: { name: "a.mp4", kind: "video" } }, [B])).toEqual({});
  });

  it("opens the draft with the edit's media, or the sequence's assets when it has none", () => {
    expect(draftFromEditSequence(sequence, [M, "a0000000000004"]).media).toEqual([M, "a0000000000004", B, A]);
    expect(draftFromEditSequence(sequence).media).toEqual([B, A, M]);
  });

  it("saves the draft's media with any asset its clips use appended", () => {
    const draft = draftFromEditSequence(sequence, [A, B, M]);
    expect(editMediaOf({ ...draft, timeline: [...draft.timeline, video("c3", "a0000000000005")] })).toEqual([
      A,
      B,
      M,
      "a0000000000005",
    ]);
    expect(editMediaOf({ ...draft, media: undefined })).toEqual([B, A, M]);
  });

  it("covers a clip's asset into an edit's media, and leaves a covered draft and a node's draft as they are", () => {
    const draft = draftFromEditSequence(sequence, [M, A, B]);
    expect(coverEditMedia(draft)).toBe(draft);
    const added = { ...draft, audioClips: [...draft.audioClips, audio("m2", "a0000000000005")] };
    expect(coverEditMedia(added).media).toEqual([M, A, B, "a0000000000005"]);
    const node = { ...added, media: undefined };
    expect(coverEditMedia(node)).toBe(node);
  });

  it("tells drafts apart by their media alone, and a node's drafts (no media) still match", () => {
    expect(sameDraft(draftFromEditSequence(sequence, [A, B, M]), draftFromEditSequence(sequence, [B, A, M]))).toBe(false);
    expect(sameDraft(draftFromEditSequence(sequence, [A, B, M]), draftFromEditSequence(sequence, [A, B, M]))).toBe(true);
    const node = { ...draftFromEditSequence(sequence), media: undefined };
    expect(sameDraft(node, { ...node })).toBe(true);
    expect(sameDraft(node, draftFromEditSequence(sequence))).toBe(false);
  });
});
