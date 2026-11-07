/**
 * A video joins the recent-generations list with its recording, and takes
 * the library's length and poster once they are known.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { ensurePoster } from "@/lib/assets/client/poster";
import { pushGenerationToast } from "@/components/GenerationToast";
import type { AssetView, RecordAssetResult, RecordedAssetHandle } from "@/lib/assets/types";
import type { ImageHistoryItem } from "@/types";

vi.mock("@/lib/assets/client/poster", () => ({ ensurePoster: vi.fn() }));
vi.mock("@/components/GenerationToast", () => ({ pushGenerationToast: vi.fn() }));

const initial = useWorkflowStore.getState();
const store = () => useWorkflowStore.getState();
const SHA = "f".repeat(64);

const video: Omit<ImageHistoryItem, "id"> = {
  kind: "video",
  image: "https://cdn.example/clip.mp4",
  timestamp: 1,
  prompt: "a fox in the snow",
  aspectRatio: "16:9",
  model: "Fal Video",
};

function recording(asset: Partial<AssetView> | null): RecordedAssetHandle & { settle: () => void } {
  let settle!: () => void;
  const done = new Promise<RecordAssetResult | null>((resolve) => {
    settle = () =>
      resolve(asset && ({ asset: { id: "a1", kind: "video", mime: "video/mp4", sha256: SHA, ...asset } } as RecordAssetResult));
  });
  return { assetId: "a1", done, settle };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("addToGlobalHistory with a recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState({ ...initial, globalImageHistory: [] });
  });

  it("takes the asset id at once, then the video's length and poster", async () => {
    vi.mocked(ensurePoster).mockResolvedValue(true);
    const handle = recording({ durationSec: 5, hasPoster: false });
    store().addToGlobalHistory(video, handle);

    expect(store().globalImageHistory[0]).toMatchObject({ kind: "video", assetId: "a1" });
    expect(store().globalImageHistory[0].poster).toBeUndefined();
    expect(pushGenerationToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "video", image: video.image }));

    handle.settle();
    await vi.waitFor(() =>
      expect(store().globalImageHistory[0]).toMatchObject({ durationSec: 5, poster: `/api/assets/thumb/${SHA}?w=320` })
    );
    expect(ensurePoster).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("uses a poster the asset already has without making one", async () => {
    const handle = recording({ hasPoster: true });
    store().addToGlobalHistory(video, handle);
    handle.settle();
    await vi.waitFor(() => expect(store().globalImageHistory[0].poster).toBe(`/api/assets/thumb/${SHA}?w=320`));
    expect(ensurePoster).not.toHaveBeenCalled();
  });

  it("keeps the first frame when no poster can be made, or the recording failed", async () => {
    vi.mocked(ensurePoster).mockResolvedValue(false);
    const noPoster = recording({ hasPoster: false });
    const failed = recording(null);
    store().addToGlobalHistory(video, noPoster);
    store().addToGlobalHistory(video, failed);
    noPoster.settle();
    failed.settle();
    await flush();
    expect(store().globalImageHistory.map((entry) => entry.poster)).toEqual([undefined, undefined]);
  });

  it("leaves the list alone once the entry has left it", async () => {
    vi.mocked(ensurePoster).mockResolvedValue(true);
    const handle = recording({ hasPoster: false });
    store().addToGlobalHistory(video, handle);
    store().clearGlobalHistory();
    const cleared = store().globalImageHistory;
    handle.settle();
    await flush();
    expect(store().globalImageHistory).toBe(cleared);
  });

  it("follows nothing for an image", async () => {
    const handle = recording({ hasPoster: false });
    store().addToGlobalHistory({ ...video, kind: "image", image: "data:image/png;base64,x" }, handle);
    handle.settle();
    await flush();
    expect(store().globalImageHistory[0]).toMatchObject({ kind: "image", assetId: "a1" });
    expect(ensurePoster).not.toHaveBeenCalled();
  });
});
