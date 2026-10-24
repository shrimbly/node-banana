import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { AssetView } from "@/lib/assets/types";

const api = vi.hoisted(() => ({
  fetchAsset: vi.fn(),
  assetFileUrl: (id: string) => `/api/assets/${id}/file`,
}));
vi.mock("@/lib/assets/client/api", () => api);
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { createAudioClip, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import { createClip } from "@/lib/stitch/timeline";
import { __resetAssetInfoForTests } from "@/lib/stitch/assetInfo";
import type { StitchDraft } from "@/lib/stitch/draft";
import { nodeKindLabel } from "@/lib/stitch/labels";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { __resetWaveformForTests, __setWaveformDecoderForTests } from "@/lib/stitch/waveformCache";
import type { WorkflowNode } from "@/types";
import { useStitchEditorMedia } from "../useStitchEditorMedia";

// What the editor shows for each audio clip, against the real stores and caches, with the library and the
// decoder stubbed.

const TONE = "atone00000001";
const RAIN = "arain00000001";
const GONE = "agone00000001";
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;

const records: Record<string, Partial<AssetView> | null> = {
  [TONE]: { id: TONE, kind: "audio", filename: "tone1320.m4a", durationSec: 3 },
  [RAIN]: { id: RAIN, kind: "audio", filename: "rain.wav", durationSec: 8 },
  [GONE]: null,
};
const decoded: Record<string, number> = { "blob:m": 20, [`/api/assets/${TONE}/file`]: 3.02 };

function seed(music: boolean) {
  const nodes = [
    node("music", "audioInput", { audioFile: "blob:m", filename: "score.mp3", duration: 20, format: "audio/mpeg" }),
    node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
  ];
  const edges = music ? [{ id: "eM", source: "music", target: "stitch", sourceHandle: "audio", targetHandle: "audio" }] : [];
  useWorkflowStore.setState({ nodes, edges });
  const draft: StitchDraft = {
    timeline: [],
    audioClips: [
      createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }),
      createAudioClip({ kind: "asset", assetId: TONE }, { id: "t", row: 1 }),
      createAudioClip({ kind: "asset", assetId: TONE }, { id: "t2", row: 1, startSec: 5 }),
      createAudioClip({ kind: "asset", assetId: RAIN }, { id: "r", row: 2 }),
      createAudioClip({ kind: "asset", assetId: GONE }, { id: "g", row: 3 }),
    ],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
  };
  editor().open({ nodeId: "stitch", draft, canvasGeneration: 1 });
}

const decode = vi.fn(async (src: string) => {
  const duration = decoded[src];
  if (duration === undefined) throw new Error("not audio");
  return { channels: [new Float32Array(16)], duration };
});

beforeEach(() => {
  __resetAssetInfoForTests();
  __resetWaveformForTests();
  __setWaveformDecoderForTests(decode);
  decode.mockClear();
  api.fetchAsset.mockImplementation(async (id: string) => records[id] ?? null);
});
afterEach(() => {
  editor().close();
  __resetWaveformForTests();
});

describe("useStitchEditorMedia's audio clips", () => {
  it("names each clip's file and source, and gives its decoded length, its record's, and its state", async () => {
    seed(true);
    const { result } = renderHook(() => useStitchEditorMedia());
    await waitFor(() => expect(result.current.audioByClip.get("r")?.status).toBe("error"));
    await waitFor(() => expect(result.current.audioByClip.get("t")?.status).toBe("ready"));
    const views = result.current.audioByClip;
    const kind = nodeKindLabel(useWorkflowStore.getState().nodes[0]);
    expect(views.get(MUSIC_CLIP_ID)).toMatchObject({
      key: "music",
      src: "blob:m",
      fileName: "score.mp3",
      railSource: { kind, detail: null },
      duration: 20,
      recordDuration: null,
      status: "ready",
      missing: false,
    });
    expect(views.get("t")).toMatchObject({
      key: `asset:${TONE}`,
      src: `/api/assets/${TONE}/file`,
      fileName: "tone1320.m4a",
      railSource: { kind: "Library", detail: null },
      duration: 3.02,
      recordDuration: 3,
      missing: false,
    });
    // A file that cannot be decoded keeps its record's length for drawing
    expect(views.get("r")).toMatchObject({ duration: null, recordDuration: 8, railSource: { kind: "Library", detail: null } });
    expect(views.get("g")).toMatchObject({ missing: true, duration: null });
  });

  it("names a library clip by the name its file was given", async () => {
    api.fetchAsset.mockImplementation(async (id: string) => (id === RAIN ? { ...records[RAIN], name: "Rain on the roof" } : (records[id] ?? null)));
    seed(true);
    const { result } = renderHook(() => useStitchEditorMedia());
    await waitFor(() => expect(result.current.audioByClip.get("r")?.fileName).toBe("Rain on the roof"));
    expect(result.current.audioByClip.get("t")?.fileName).toBe("tone1320.m4a");
  });

  it("decodes each source once, every clip of the draft, and none the library is known not to have", async () => {
    seed(true);
    const first = renderHook(() => useStitchEditorMedia());
    await waitFor(() => expect(first.result.current.audioByClip.get("g")?.missing).toBe(true));
    await waitFor(() => expect(editor().audioDurations.size).toBe(2));
    first.unmount();
    // The next editor knows the record is gone before it asks for any waveform
    __resetWaveformForTests();
    __setWaveformDecoderForTests(decode);
    decode.mockClear();
    const { result } = renderHook(() => useStitchEditorMedia());
    await waitFor(() => expect(result.current.audioByClip.get("t")?.status).toBe("ready"));
    await waitFor(() => expect(result.current.audioByClip.get("r")?.status).toBe("error"));
    expect(decode.mock.calls.map(([src]) => src).sort()).toEqual(
      ["blob:m", `/api/assets/${RAIN}/file`, `/api/assets/${TONE}/file`].sort(),
    );
  });

  it("pushes the decoded lengths to the store's own map, apart from the video durations", async () => {
    seed(true);
    renderHook(() => useStitchEditorMedia());
    await waitFor(() =>
      expect(editor().audioDurations).toEqual(
        new Map([
          ["music", 20],
          [`asset:${TONE}`, 3.02],
        ]),
      ),
    );
    expect(editor().durations.size).toBe(0);
  });

  it("shows a music clip with no music connected as empty", () => {
    seed(false);
    const { result } = renderHook(() => useStitchEditorMedia());
    expect(result.current.audioByClip.get(MUSIC_CLIP_ID)).toMatchObject({ src: null, status: "empty", fileName: "Audio" });
  });
});

describe("useStitchEditorMedia's snapshot fallback (an edit project's file)", () => {
  const snapshot = {
    [GONE]: { name: "sunset.mp4", kind: "video" as const, project: "Launch film", durationSec: 5 },
    agonesound0001: { name: "waves.m4a", kind: "audio" as const, project: null, durationSec: 4 },
  };
  const assetFallback = (id: string) => snapshot[id as keyof typeof snapshot];

  function openEdit() {
    useWorkflowStore.setState({ nodes: [], edges: [] });
    const draft: StitchDraft = {
      timeline: [createClip({ kind: "asset", assetId: GONE }, { id: "v" })],
      audioClips: [createAudioClip({ kind: "asset", assetId: "agonesound0001" }, { id: "w" })],
      legacyAudio: { curve: [], muted: false },
      loopCount: 1,
      sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
    };
    editor().openEdit({ editId: "ed0000000000a1", draft });
  }

  it("names a clip the library lost by what the file says about it", async () => {
    openEdit();
    const { result } = renderHook(() => useStitchEditorMedia({ assetFallback }));
    await waitFor(() => expect(result.current.byClip.get("v")?.missing).toBe(true));
    expect(result.current.byClip.get("v")).toMatchObject({
      sourceLabel: "sunset.mp4",
      railSource: { kind: "Not in the library", detail: "sunset.mp4" },
      duration: null,
    });
    await waitFor(() => expect(result.current.audioByClip.get("w")?.missing).toBe(true));
    expect(result.current.audioByClip.get("w")).toMatchObject({
      fileName: "waves.m4a",
      railSource: { kind: "Not in the library", detail: "waves.m4a" },
    });
  });

  it("without the fallback (the node's dialog), a lost clip reads as before", async () => {
    openEdit();
    const { result } = renderHook(() => useStitchEditorMedia());
    await waitFor(() => expect(result.current.byClip.get("v")?.missing).toBe(true));
    expect(result.current.byClip.get("v")).toMatchObject({ sourceLabel: "Library", railSource: { kind: "Library", detail: null } });
    expect(result.current.audioByClip.get("w")?.fileName).toBe("Audio");
  });
});
