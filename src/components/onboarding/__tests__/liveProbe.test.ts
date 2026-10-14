// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { GpuCanvasBridge } from "@/components/gpuCanvas/bridge";
import { createLiveProbe, PROBE_TIMEOUT_MS } from "../liveProbe";

function setup(ids: string[]) {
  const live = new Map<string, Element>();
  const released: string[] = [];
  const holdLive = vi.fn((held: readonly string[]) => ({ ready: Promise.resolve(), release: () => { released.push(...held); } }));
  const bridge = { graph: () => ({ nodes: ids.map((id) => ({ id })) }), holdLive } as unknown as GpuCanvasBridge;
  const probe = createLiveProbe((id) => live.get(id) ?? null);
  const element = (html: string) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div;
  };
  return { live, released, holdLive, bridge, probe, element };
}

describe("the tutorial's live probe", () => {
  const sel = '[data-tutorial="generate-text-input-handle"]';

  it("holds each node live when nothing matches, keeps the one holding a match and lets the rest go", () => {
    const { live, released, holdLive, bridge, probe, element } = setup(["prompt", "generate"]);
    probe.update(bridge, [sel], [sel], () => {}, 0);
    expect(holdLive.mock.calls.map((c) => c[0])).toEqual([["prompt"], ["generate"]]);
    live.set("prompt", element("<span></span>"));
    live.set("generate", element('<span data-tutorial="generate-text-input-handle"></span>'));
    probe.update(bridge, [sel], [], () => {}, 100);
    expect(released).toEqual(["prompt"]);
    expect(probe.holds("generate")).toBe(true);
    // Looked inside once: not held again.
    live.clear();
    probe.update(bridge, [sel], [sel], () => {}, 200);
    expect(holdLive).toHaveBeenCalledTimes(2);
    probe.dispose();
    expect(released).toContain("generate");
  });

  it("tries a node again that did not turn live (out of view)", () => {
    const { holdLive, released, bridge, probe } = setup(["far"]);
    probe.update(bridge, [sel], [sel], () => {}, 0);
    probe.update(bridge, [sel], [sel], () => {}, 100);
    expect(holdLive).toHaveBeenCalledTimes(1);
    probe.update(bridge, [sel], [sel], () => {}, PROBE_TIMEOUT_MS + 1);
    expect(released).toEqual(["far"]);
    probe.update(bridge, [sel], [sel], () => {}, PROBE_TIMEOUT_MS + 2);
    expect(holdLive).toHaveBeenCalledTimes(2);
  });

  it("holds nothing while every selector matches", () => {
    const { holdLive, bridge, probe } = setup(["a"]);
    probe.update(bridge, [sel], [], () => {}, 0);
    expect(holdLive).not.toHaveBeenCalled();
  });
});
