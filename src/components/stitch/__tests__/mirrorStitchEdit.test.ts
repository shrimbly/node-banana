import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { useEditProjectStore } from "@/store/editProjectStore";
import { EditApiError } from "@/lib/edits/client";
import type { EditDocument } from "@/lib/edits/types";
import type { AssetView } from "@/lib/assets/types";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import type { StitchDraft } from "@/lib/stitch/draft";
import type { SourceKey } from "@/lib/stitch/timeline";
import type { StitchAudioClip, StitchTimelineClip, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";
import { graphMirrorSources, mirrorStitchEditToEdits, shownAssetId } from "../mirrorStitchEdit";

const show = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show }) } }));

const createEdit = vi.fn();
const saveEdit = vi.fn();
vi.mock("@/lib/edits/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/edits/client")>("@/lib/edits/client");
  return { ...actual, createEdit: (...args: unknown[]) => createEdit(...args), saveEdit: (...args: unknown[]) => saveEdit(...args) };
});

const fetchAsset = vi.fn();
vi.mock("@/lib/assets/client/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/assets/client/api")>("@/lib/assets/client/api");
  return { ...actual, fetchAsset: (id: string) => fetchAsset(id) };
});

const wf = () => useWorkflowStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string, sourceHandle = "video"): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle,
  targetHandle,
});
const view = (id: string, kind: "video" | "audio", filename: string, durationSec: number): AssetView =>
  ({ id, kind, filename, durationSec, workflow: { id: "w", name: null, projectPath: "/lib/Raid" } }) as unknown as AssetView;
const clip = (id: string, source: StitchTimelineClip["source"]): StitchTimelineClip => ({
  id,
  source,
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
});
const music: StitchAudioClip = { id: "audio:music", source: { kind: "music" }, row: 0, startSec: 0, inSec: 0, outSec: null, muted: false, curve: [] };
const draft = (timeline: StitchTimelineClip[], audioClips: StitchAudioClip[] = []): StitchDraft => ({
  timeline,
  audioClips,
  legacyAudio: { curve: [], muted: false },
  loopCount: 1,
  sequenceLayout: { ...DEFAULT_SEQUENCE_LAYOUT },
});
const durations = new Map<SourceKey, number>([
  ["edge:eA", 5],
  ["edge:eB", 4],
]);
const stitchData = () => wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
const document = (id: string, name = "Raid"): EditDocument =>
  ({ id, name, updatedAt: 10, createdAt: 1, assets: {}, renders: [] }) as unknown as EditDocument;

function seed(stitch: Record<string, unknown> = {}) {
  useWorkflowStore.setState({
    workflowName: "Armoured raid",
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a", videoHistory: [{ id: "1", assetId: "A1" }], selectedVideoHistoryIndex: 0 }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b", videoHistory: [{ id: "2", assetId: "B2" }, { id: "1", assetId: "B1" }], selectedVideoHistoryIndex: 1 }),
      node("up", "videoInput", { video: "blob:u" }),
      node("song", "generateAudio", { outputAudio: "blob:s", audioHistory: [{ id: "1", assetId: "S1" }], selectedAudioHistoryIndex: 0 }),
      node("stitch", "videoStitch", { clips: [], clipOrder: ["eA", "eB"], outputVideo: null, loopCount: 1, status: "idle", ...stitch }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1"), edge("eU", "up", "video-2"), edge("eM", "song", "audio", "audio")],
  });
}

beforeEach(() => {
  seed();
  fetchAsset.mockImplementation(async (id: string) =>
    id === "A1" ? view("A1", "video", "a.mp4", 5) : id === "B1" ? view("B1", "video", "b.mp4", 4) : id === "S1" ? view("S1", "audio", "s.mp3", 30) : null,
  );
  createEdit.mockResolvedValue(document("ed000000000new"));
  saveEdit.mockResolvedValue(document("ed000000000old"));
});
afterEach(() => {
  vi.clearAllMocks();
  wf().clearWorkflow();
  useEditProjectStore.setState({ list: { status: "idle", edits: [], problems: [], folder: null, error: null } });
});

describe("shownAssetId", () => {
  it("reads the carousel entry the node shows", () => {
    expect(shownAssetId({ videoHistory: [{ assetId: "N" }, { assetId: "O" }], selectedVideoHistoryIndex: 1 }, "video")).toBe("O");
    expect(shownAssetId({ videoHistory: [{ assetId: "N" }] }, "video")).toBe("N");
    expect(shownAssetId({ videoHistory: [{ id: "no-asset" }] }, "video")).toBeNull();
    expect(shownAssetId({ video: "blob:u" }, "video")).toBeNull();
  });

  it("reads a Comfy app's selected run", () => {
    const data = {
      runHistory: [{ outputs: { out: { type: "video", assetId: "C2" } } }, { outputs: { a: { type: "image", assetId: "I" }, b: { type: "video", assetId: "C1" } } }],
      selectedRunHistoryIndex: 1,
    };
    expect(shownAssetId(data, "video")).toBe("C1");
    expect(shownAssetId(data, "audio")).toBeNull();
  });
});

describe("graphMirrorSources", () => {
  it("maps a socket to the library asset its source shows, and the music to the audio's", () => {
    const sources = graphMirrorSources("stitch");
    expect(sources.videoAssetOfEdge("eA")).toBe("A1");
    expect(sources.videoAssetOfEdge("eB")).toBe("B1");
    expect(sources.videoAssetOfEdge("eU")).toBeNull();
    expect(sources.musicAsset()).toBe("S1");
  });

  it("follows a router to the node it reads from", () => {
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("r", "router", {})],
      edges: [...wf().edges.filter((e) => e.id !== "eA"), { id: "in", source: "gen-a", target: "r", sourceHandle: "video", targetHandle: "video" }, edge("eA", "r", "video-0")],
    });
    expect(graphMirrorSources("stitch").videoAssetOfEdge("eA")).toBe("A1");
  });
});

describe("mirrorStitchEditToEdits", () => {
  const input = () => ({ nodeId: "stitch", draft: draft([clip("c1", { kind: "edge", edgeId: "eA" }), clip("c2", { kind: "edge", edgeId: "eB" })], [music]), durations });

  it("creates the edit on the first write, named after the workflow, and keeps its id on the node", async () => {
    expect(await mirrorStitchEditToEdits(input())).toBe("ed000000000new");
    expect(saveEdit).not.toHaveBeenCalled();
    expect(createEdit).toHaveBeenCalledTimes(1);
    const request = createEdit.mock.calls[0][0];
    expect(request.name).toBe("Armoured raid");
    expect(request.sequence.timeline.map((c: StitchTimelineClip) => c.source)).toEqual([
      { kind: "asset", assetId: "A1" },
      { kind: "asset", assetId: "B1" },
    ]);
    expect(request.sequence.audioClips).toEqual([{ ...music, source: { kind: "asset", assetId: "S1" } }]);
    // The edit's media is what the node's clips use, in first-use order
    expect(request.media).toEqual(["A1", "B1", "S1"]);
    expect(request.assets).toEqual({
      A1: { name: "a.mp4", kind: "video", project: "Raid", durationSec: 5 },
      B1: { name: "b.mp4", kind: "video", project: "Raid", durationSec: 4 },
      S1: { name: "s.mp3", kind: "audio", project: "Raid", durationSec: 30 },
    });
    expect(request.summary).toEqual({ clipCount: 2, audioClipCount: 1, durationSec: 9, posterAssetId: "A1" });
    expect(stitchData().editProjectId).toBe("ed000000000new");
    expect(show).not.toHaveBeenCalled();
  });

  it("names the edit after the node's title when it has one", async () => {
    seed({ customTitle: "Trailer cut" });
    await mirrorStitchEditToEdits(input());
    expect(createEdit.mock.calls[0][0].name).toBe("Trailer cut");
  });

  it("replaces the edit it made before, whatever the view did to it since", async () => {
    seed({ editProjectId: "ed000000000old" });
    expect(await mirrorStitchEditToEdits(input())).toBe("ed000000000old");
    expect(createEdit).not.toHaveBeenCalled();
    expect(saveEdit).toHaveBeenCalledTimes(1);
    expect(saveEdit.mock.calls[0][0]).toBe("ed000000000old");
    expect(saveEdit.mock.calls[0][1]).toMatchObject({ force: true, renders: [] });
    expect(saveEdit.mock.calls[0][1].sequence.timeline).toHaveLength(2);
    // Media the view added to the edit goes: the node is the original
    expect(saveEdit.mock.calls[0][1].media).toEqual(["A1", "B1", "S1"]);
  });

  it("makes a new edit when the one it made is gone from the folder", async () => {
    seed({ editProjectId: "ed000000000old" });
    saveEdit.mockRejectedValueOnce(new EditApiError("gone", 404, "not_found"));
    expect(await mirrorStitchEditToEdits(input())).toBe("ed000000000new");
    expect(createEdit).toHaveBeenCalledTimes(1);
    expect(stitchData().editProjectId).toBe("ed000000000new");
  });

  it("says when clips were left out because the library does not hold them", async () => {
    const d = draft([clip("c1", { kind: "edge", edgeId: "eA" }), clip("cu", { kind: "edge", edgeId: "eU" })]);
    await mirrorStitchEditToEdits({ nodeId: "stitch", draft: d, durations });
    expect(createEdit.mock.calls[0][0].sequence.timeline).toHaveLength(1);
    expect(show).toHaveBeenCalledWith("Saved to Edits without one clip that is not in the library.", "info");
  });

  it("writes nothing when no clip is in the library", async () => {
    const d = draft([clip("cu", { kind: "edge", edgeId: "eU" })]);
    expect(await mirrorStitchEditToEdits({ nodeId: "stitch", draft: d, durations })).toBeNull();
    expect(createEdit).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("reports a failed write in a toast and keeps the node as it is", async () => {
    createEdit.mockRejectedValueOnce(new EditApiError("The library is paused.", 503, "paused"));
    expect(await mirrorStitchEditToEdits(input())).toBeNull();
    expect(show).toHaveBeenCalledWith("The edit was kept on the node but couldn't be saved to Edits: The library is paused.", "error");
    expect(stitchData().editProjectId).toBeUndefined();
  });

  it("refreshes the view's list when it has one", async () => {
    const refreshList = vi.fn().mockResolvedValue(undefined);
    useEditProjectStore.setState({ list: { status: "ready", edits: [], problems: [], folder: "/lib/Edits", error: null }, refreshList });
    await mirrorStitchEditToEdits(input());
    expect(refreshList).toHaveBeenCalledTimes(1);
  });
});
