import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGpuCanvasFailure, getGpuCanvasFailure, reportGpuCanvasFailure, useGpuCanvasFailure } from "../failure";

describe("GPU canvas failure", () => {
  afterEach(() => {
    clearGpuCanvasFailure();
    vi.restoreAllMocks();
  });

  it("keeps the first reason until it is cleared", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useGpuCanvasFailure());
    expect(result.current).toBeNull();

    act(() => reportGpuCanvasFailure("WebGL2 is not available"));
    act(() => reportGpuCanvasFailure("the graphics card reset more than once"));
    expect(result.current).toBe("WebGL2 is not available");

    act(() => clearGpuCanvasFailure());
    expect(result.current).toBeNull();
    expect(getGpuCanvasFailure()).toBeNull();
  });
});
