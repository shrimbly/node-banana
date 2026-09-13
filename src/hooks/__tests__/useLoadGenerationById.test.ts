import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLoadGenerationById } from "../useLoadGenerationById";
import { useWorkflowStore } from "@/store/workflowStore";

const mockShow = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: mockShow }) },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("useLoadGenerationById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ json: async () => ({ success: true, image: "data:image/png;base64,ok" }) });
  });

  it("loads from the configured generations folder", async () => {
    useWorkflowStore.setState({ generationsPath: "/proj/generations", saveDirectoryPath: "/proj" });
    const { result } = renderHook(() => useLoadGenerationById("image", "Image"));

    await expect(result.current("abc")).resolves.toBe("data:image/png;base64,ok");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ directoryPath: "/proj/generations", imageId: "abc" });
  });

  it("looks beside the workflow when only its folder is known", async () => {
    useWorkflowStore.setState({ generationsPath: null, saveDirectoryPath: "/proj" });
    const { result } = renderHook(() => useLoadGenerationById("video", "Video"));

    await result.current("clip");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).directoryPath).toBe("/proj/generations");
    expect(mockShow).not.toHaveBeenCalled();
  });

  it("tells the user once when there is no folder to look in", async () => {
    useWorkflowStore.setState({ generationsPath: null, saveDirectoryPath: null });
    const { result } = renderHook(() => useLoadGenerationById("image", "Image"));

    await expect(result.current("a")).resolves.toBeNull();
    await expect(result.current("b")).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledTimes(1);
    expect(mockShow).toHaveBeenCalledWith("Set a project folder to browse image history", "warning");
  });
});
