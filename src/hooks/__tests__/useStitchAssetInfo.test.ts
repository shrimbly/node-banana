import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { AssetView } from "@/lib/assets/types";

const fetchAsset = vi.hoisted(() => vi.fn());
vi.mock("@/lib/assets/client/api", () => ({ fetchAsset }));

import { __resetAssetInfoForTests, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { useStitchAssetInfo } from "../useStitchAssetInfo";

const record = (id: string) => ({ id, producer: { nodeId: "n", nodeType: "generateVideo" } }) as AssetView;

beforeEach(() => {
  __resetAssetInfoForTests();
  fetchAsset.mockReset();
  fetchAsset.mockImplementation(async (id: string) => record(id));
});

afterEach(() => {
  __resetAssetInfoForTests();
});

describe("useStitchAssetInfo", () => {
  it("reads the ids it mounts with again, even when they are known", async () => {
    primeAssetInfo([record("a1")]);
    renderHook(() => useStitchAssetInfo(["a1"]));
    await waitFor(() => expect(fetchAsset).toHaveBeenCalledWith("a1"));
  });

  it("does not read again ids added later whose records are known, when it mounted with none", async () => {
    const { rerender, result } = renderHook(({ ids }) => useStitchAssetInfo(ids), {
      initialProps: { ids: [] as string[] },
    });
    // An Add: the picker primed the picked records
    primeAssetInfo([record("a1"), record("a2")]);
    rerender({ ids: ["a1", "a2"] });
    expect(result.current.get("a1")).toEqual(record("a1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAsset).not.toHaveBeenCalled();
    // An id no one knows yet is still read
    rerender({ ids: ["a1", "a2", "a3"] });
    await waitFor(() => expect(fetchAsset).toHaveBeenCalledWith("a3"));
    expect(fetchAsset).toHaveBeenCalledTimes(1);
  });
});
