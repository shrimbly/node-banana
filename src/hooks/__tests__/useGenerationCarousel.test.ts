import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { carouselTarget, useGenerationCarousel } from "../useGenerationCarousel";
import { useWorkflowStore } from "@/store/workflowStore";

const initial = useWorkflowStore.getState();

describe("useGenerationCarousel", () => {
  const updateNodeData = vi.fn();
  const history = [
    { id: "newest", assetId: "a0000000000002" },
    { id: "older", assetId: "a0000000000001" },
    { id: "legacy" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.setState({ ...initial, updateNodeData });
  });

  it("carries whatever the loader returns to the update, so a run of several outputs loads together", async () => {
    const loadFn = vi.fn().mockResolvedValue([{ handleId: "9", type: "image", value: "data:image/png;base64,x" }]);
    const buildUpdate = vi.fn((outputs: unknown[], index: number) => ({ outputs: { count: outputs.length }, selectedRunHistoryIndex: index }));
    const { result } = renderHook(() =>
      useGenerationCarousel<(typeof history)[number], unknown[]>({ nodeId: "comfy-1", history, currentIndex: 0, loadFn, buildUpdate })
    );

    await act(() => result.current.handleNext());

    expect(buildUpdate).toHaveBeenCalledWith([{ handleId: "9", type: "image", value: "data:image/png;base64,x" }], 1);
    expect(updateNodeData).toHaveBeenCalledWith("comfy-1", { outputs: { count: 1 }, selectedRunHistoryIndex: 1 });
  });

  it("hands the loader the whole entry, so it can use the asset id", async () => {
    const loadFn = vi.fn().mockResolvedValue("data:image/png;base64,older");
    const buildUpdate = (media: string, index: number) => ({ outputImage: media, selectedHistoryIndex: index });
    const { result } = renderHook(() =>
      useGenerationCarousel({ nodeId: "gen-1", history, currentIndex: 0, loadFn, buildUpdate })
    );

    await act(() => result.current.handleNext());

    expect(loadFn).toHaveBeenCalledWith({ id: "older", assetId: "a0000000000001" });
    expect(updateNodeData).toHaveBeenCalledWith("gen-1", { outputImage: "data:image/png;base64,older", selectedHistoryIndex: 1 });
  });

  it("from an output that is not in the history, goes to the newest entry, or back to the oldest", async () => {
    const loadFn = vi.fn(async (item: { id: string }) => `data:image/png;base64,${item.id}`);
    const buildUpdate = (media: string, index: number) => ({ outputImage: media, selectedHistoryIndex: index });
    const { result } = renderHook(() =>
      useGenerationCarousel({ nodeId: "gen-1", history, currentIndex: -1, loadFn, buildUpdate })
    );

    await act(() => result.current.handleNext());
    expect(loadFn).toHaveBeenLastCalledWith({ id: "newest", assetId: "a0000000000002" });
    expect(updateNodeData).toHaveBeenLastCalledWith("gen-1", { outputImage: "data:image/png;base64,newest", selectedHistoryIndex: 0 });

    await act(() => result.current.handlePrevious());
    expect(loadFn).toHaveBeenLastCalledWith({ id: "legacy" });
    expect(updateNodeData).toHaveBeenLastCalledWith("gen-1", { outputImage: "data:image/png;base64,legacy", selectedHistoryIndex: 2 });
  });

  it("names the entry to go to, wrapping at both ends", () => {
    expect(carouselTarget(0, 3, "next")).toBe(1);
    expect(carouselTarget(2, 3, "next")).toBe(0);
    expect(carouselTarget(0, 3, "previous")).toBe(2);
    expect(carouselTarget(undefined, 3, "next")).toBe(1);
    expect(carouselTarget(-1, 3, "next")).toBe(0);
    expect(carouselTarget(-1, 3, "previous")).toBe(2);
    expect(carouselTarget(5, 3, "next")).toBe(0);
  });

  it("wraps to the oldest entry, and leaves the node alone when nothing loads", async () => {
    const loadFn = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() =>
      useGenerationCarousel({ nodeId: "gen-1", history, currentIndex: 0, loadFn, buildUpdate: () => ({}) })
    );

    await act(() => result.current.handlePrevious());

    expect(loadFn).toHaveBeenCalledWith({ id: "legacy" });
    expect(updateNodeData).not.toHaveBeenCalled();
  });
});
