import { describe, it, expect, beforeEach, vi } from "vitest";

/** A fresh copy of the module, which reads localStorage when it loads. */
async function load() {
  vi.resetModules();
  return import("@/components/nodes/lowDetail");
}

describe("low detail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is on by default, below 25% zoom", async () => {
    const { getLowDetailSettings, LOW_DETAIL_ZOOM } = await load();
    expect(LOW_DETAIL_ZOOM).toBe(0.25);
    expect(getLowDetailSettings()).toEqual({ enabled: true, zoom: 0.25 });
  });

  it("starts from what was saved", async () => {
    localStorage.setItem("node-banana-low-detail", "off");
    localStorage.setItem("node-banana-low-detail-zoom", "0.4");
    const { getLowDetailSettings } = await load();
    expect(getLowDetailSettings()).toEqual({ enabled: false, zoom: 0.4 });
  });

  it("saves the switch and the zoom, and resets a zoom out of range", async () => {
    const { getLowDetailSettings, setLowDetailEnabled, setLowDetailZoom } = await load();
    setLowDetailEnabled(false);
    setLowDetailZoom(0.35);
    expect(localStorage.getItem("node-banana-low-detail")).toBe("off");
    expect(localStorage.getItem("node-banana-low-detail-zoom")).toBe("0.35");
    expect(getLowDetailSettings()).toEqual({ enabled: false, zoom: 0.35 });
    setLowDetailZoom(5);
    expect(getLowDetailSettings().zoom).toBe(0.25);
  });
});
