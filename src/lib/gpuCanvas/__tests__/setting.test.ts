import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Desktop = Window["nodeBananaDesktop"];

/** The setting module as a page would load it: with or without the desktop bridge, and with HTML-in-Canvas or not. */
async function load({ desktop = false, stored = null as string | null, supported = true } = {}) {
  vi.resetModules();
  localStorage.clear();
  if (stored) localStorage.setItem("node-banana-gpu-canvas", stored);
  const set = vi.fn(async () => true);
  Object.defineProperty(window, "nodeBananaDesktop", { configurable: true, value: desktop ? ({ gpuCanvas: { active: async () => true, set } } as unknown as Desktop) : undefined });
  vi.doMock("../htmlInCanvas", () => ({ detectHtmlInCanvas: () => ({ available: supported }) }));
  return { setting: await import("../setting"), set };
}

afterEach(() => {
  vi.doUnmock("../htmlInCanvas");
  Object.defineProperty(window, "nodeBananaDesktop", { configurable: true, value: undefined });
  vi.spyOn(console, "error").mockRestore();
});

describe("the GPU canvas setting", () => {
  it("is on by default in the desktop app and off in the browser", async () => {
    expect((await load({ desktop: true })).setting.getGpuCanvasEnabled()).toBe(true);
    expect((await load({ desktop: false })).setting.getGpuCanvasEnabled()).toBe(false);
  });

  it("keeps what was chosen, and mirrors a change to the desktop app", async () => {
    expect((await load({ desktop: true, stored: "off" })).setting.getGpuCanvasEnabled()).toBe(false);
    expect((await load({ desktop: false, stored: "on" })).setting.getGpuCanvasEnabled()).toBe(true);
    const { setting, set } = await load({ desktop: true });
    setting.setGpuCanvasEnabled(false);
    expect(localStorage.getItem("node-banana-gpu-canvas")).toBe("off");
    expect(set).toHaveBeenCalledWith(false);
  });

  it("draws only where HTML-in-Canvas exists", async () => {
    const { setting } = await load({ desktop: true, supported: false });
    expect(renderHook(() => setting.useGpuCanvasActive()).result.current).toBe(false);
  });

  it("gives way to the classic canvas for the session after a failure, leaving the setting as it was", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { setting } = await load({ desktop: true });
    const { result } = renderHook(() => setting.useGpuCanvasActive());
    expect(result.current).toBe(true);
    act(() => setting.reportGpuCanvasFailure("a shader failed to compile"));
    expect(result.current).toBe(false);
    expect(setting.getGpuCanvasFailure()).toBe("a shader failed to compile");
    expect(setting.getGpuCanvasEnabled()).toBe(true);
    expect(localStorage.getItem("node-banana-gpu-canvas")).toBeNull();
  });
});
