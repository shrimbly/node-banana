import { describe, it, expect, beforeEach, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("../canvasSettings");
}

describe("canvas settings", () => {
  beforeEach(() => localStorage.clear());

  it("starts on the defaults", async () => {
    const { getCanvasSettings, DEFAULT_CANVAS_SETTINGS } = await load();
    expect(getCanvasSettings()).toEqual(DEFAULT_CANVAS_SETTINGS);
    expect(DEFAULT_CANVAS_SETTINGS).toEqual({ browserNodes: "painted", pictureQuality: "balanced", waitForPaint: true, loadingScreen: true, connectionDetailZoom: 0.15 });
  });

  it("reads what was stored, the runner's live-nodes switch included, and ignores what is not valid", async () => {
    localStorage.setItem("node-banana-live-nodes", "on");
    localStorage.setItem("node-banana-canvas-performance", JSON.stringify({ pictureQuality: "huge", waitForPaint: false, loadingScreen: "no", connectionDetailZoom: 0.5 }));
    const { getCanvasSettings } = await load();
    expect(getCanvasSettings()).toEqual({ browserNodes: "live", pictureQuality: "balanced", waitForPaint: false, loadingScreen: true, connectionDetailZoom: 0.5 });
  });

  it("stores a change and tells listeners, once", async () => {
    const { setCanvasSettings, subscribeCanvasSettings } = await load();
    const listener = vi.fn();
    const unsubscribe = subscribeCanvasSettings(listener);
    setCanvasSettings({ pictureQuality: "fast" });
    setCanvasSettings({ pictureQuality: "fast" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].pictureQuality).toBe("fast");
    expect(listener.mock.calls[0][1].pictureQuality).toBe("balanced");
    unsubscribe();
    const { getCanvasSettings } = await load();
    expect(getCanvasSettings().pictureQuality).toBe("fast");
  });
});
