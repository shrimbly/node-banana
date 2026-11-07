import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetView } from "@/lib/assets/types";

const api = vi.hoisted(() => ({ fetchAsset: vi.fn() }));
vi.mock("@/lib/assets/client/api", () => api);

import {
  __resetAssetInfoForTests,
  getAssetInfo,
  primeAssetInfo,
  requestAssetInfo,
  subscribeAssetInfo,
} from "../assetInfo";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  assetMediaKey,
  getMediaInfo,
} from "../mediaInfo";

const view = (id: string) => ({ id, filename: `${id}.mp4` }) as AssetView;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  __resetAssetInfoForTests();
  api.fetchAsset.mockReset();
});

afterEach(() => {
  __resetAssetInfoForTests();
  __resetMediaInfoForTests();
  __setMediaExtractorForTests(null);
});

describe("assetInfo", () => {
  it("knows a primed record without asking the library", () => {
    const listener = vi.fn();
    const off = subscribeAssetInfo(listener);
    primeAssetInfo([view("a1")]);
    requestAssetInfo(["a1"]);
    expect(getAssetInfo("a1")?.filename).toBe("a1.mp4");
    expect(api.fetchAsset).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("reads unknown ids one at a time, once each, and keeps a gone one as null", async () => {
    let finishFirst!: (value: AssetView | null) => void;
    api.fetchAsset.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    api.fetchAsset.mockResolvedValueOnce(view("a2"));
    requestAssetInfo(["a1", "a2"]);
    requestAssetInfo(["a1"]);
    expect(api.fetchAsset).toHaveBeenCalledTimes(1);
    expect(getAssetInfo("a1")).toBeUndefined();
    finishFirst(null);
    await settle();
    expect(api.fetchAsset.mock.calls.map((c) => c[0])).toEqual(["a1", "a2"]);
    expect(getAssetInfo("a1")).toBeNull();
    expect(getAssetInfo("a2")?.id).toBe("a2");
  });

  it("leaves an id it could not read unknown, to be asked again", async () => {
    api.fetchAsset.mockRejectedValueOnce(new Error("offline"));
    requestAssetInfo(["a1"]);
    await settle();
    expect(getAssetInfo("a1")).toBeUndefined();
    api.fetchAsset.mockResolvedValueOnce(view("a1"));
    requestAssetInfo(["a1"]);
    await settle();
    expect(getAssetInfo("a1")?.id).toBe("a1");
  });

  it("reads known ids again on a refresh, keeping each record until the new answer", async () => {
    primeAssetInfo([view("a1"), view("a2")]);
    let answerFirst!: (value: AssetView | null) => void;
    api.fetchAsset.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    api.fetchAsset.mockRejectedValueOnce(new Error("offline"));
    requestAssetInfo(["a1", "a2"]);
    expect(api.fetchAsset).not.toHaveBeenCalled();
    requestAssetInfo(["a1", "a2"], { refresh: true });
    expect(api.fetchAsset).toHaveBeenCalledTimes(1);
    // No flicker while it is asked
    expect(getAssetInfo("a1")?.filename).toBe("a1.mp4");
    answerFirst(null);
    await settle();
    // Deleted since it was primed
    expect(getAssetInfo("a1")).toBeNull();
    // A read that failed keeps the last answer
    expect(api.fetchAsset.mock.calls.map((c) => c[0])).toEqual(["a1", "a2"]);
    expect(getAssetInfo("a2")?.filename).toBe("a2.mp4");
  });

  it("reads a file again once its record says it is missing, so what was read of it before no longer counts", async () => {
    const notFound = async (): Promise<never> => {
      throw new Error("Not found");
    };
    __setMediaExtractorForTests({ probe: notFound, open: notFound });
    // The card and the editor read both files before the first one went
    __setMediaInfoForTests(assetMediaKey("a1"), { duration: 5 });
    __setMediaInfoForTests(assetMediaKey("a2"), { duration: 4 });
    primeAssetInfo([view("a1"), view("a2")]);
    // A run got a 404 for a1's file, so the library now says it is missing
    api.fetchAsset.mockResolvedValueOnce({ ...view("a1"), missing: true });
    api.fetchAsset.mockResolvedValueOnce(view("a2"));
    requestAssetInfo(["a1", "a2"], { refresh: true });
    await settle();
    expect(getAssetInfo("a1")?.missing).toBe(true);
    expect(getMediaInfo(assetMediaKey("a1"))?.status).not.toBe("ready");
    await vi.waitFor(() => expect(getMediaInfo(assetMediaKey("a1"))).toMatchObject({ status: "error", duration: null }));
    // A file the library still has keeps its read
    expect(getMediaInfo(assetMediaKey("a2"))).toMatchObject({ status: "ready", duration: 4 });
  });

  it("drops an answer that was in flight when the cache was reset", async () => {
    let answer!: (value: AssetView | null) => void;
    api.fetchAsset.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    requestAssetInfo(["old"]);
    __resetAssetInfoForTests();
    api.fetchAsset.mockResolvedValueOnce(view("new"));
    requestAssetInfo(["new"]);
    await settle();
    answer(view("old"));
    await settle();
    expect(getAssetInfo("old")).toBeUndefined();
    expect(getAssetInfo("new")?.id).toBe("new");
  });
});
