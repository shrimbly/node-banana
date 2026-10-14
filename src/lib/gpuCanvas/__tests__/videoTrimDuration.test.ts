import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { watchVideoTrimDurations, type ProbeDuration } from "../videoTrimDuration";

const node = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
const videoEdge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, targetHandle: "video" }) as WorkflowEdge;

function setup(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const pending = new Map<string, { resolve: (d: number | null) => void; signal: AbortSignal }>();
  const probe = vi.fn<ProbeDuration>((url, signal) => new Promise((resolve) => pending.set(url, { resolve, signal })));
  const store = create<{
    nodes: WorkflowNode[]; edges: WorkflowEdge[]; canvasGeneration: number;
    updateNodeData: (id: string, data: { duration: number; endTime: number }) => void;
  }>((set, get) => ({
    nodes, edges, canvasGeneration: 0,
    updateNodeData: (id, data) => set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)) as WorkflowNode[] }),
  }));
  const stop = watchVideoTrimDurations(store, probe);
  const trim = () => store.getState().nodes.find((n) => n.id === "t")!.data as { duration: number | null; endTime: number };
  const setVideo = (url: string) => store.setState({ nodes: store.getState().nodes.map((n) => (n.id === "v" ? { ...n, data: { outputVideo: url } } : n)) as WorkflowNode[] });
  return { store, probe, pending, stop, trim, setVideo };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("watchVideoTrimDurations", () => {
  it("writes the duration and end time once as the source video arrives", async () => {
    const { probe, pending, trim, setVideo } = setup(
      [node("v", "generateVideo", { outputVideo: null }), node("t", "videoTrim", { duration: null, endTime: 0 })],
      [videoEdge("v", "t")],
    );
    expect(probe).not.toHaveBeenCalled();
    setVideo("a.mp4");
    expect(probe).toHaveBeenCalledTimes(1);
    pending.get("a.mp4")!.resolve(12);
    await flush();
    expect(trim()).toMatchObject({ duration: 12, endTime: 12 });
    // Its own write does not probe again.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps an end time the user set", async () => {
    const { pending, trim } = setup(
      [node("v", "generateVideo", { outputVideo: "a.mp4" }), node("t", "videoTrim", { duration: null, endTime: 4 })],
      [videoEdge("v", "t")],
    );
    pending.get("a.mp4")!.resolve(12);
    await flush();
    expect(trim()).toMatchObject({ duration: 12, endTime: 4 });
  });

  it("drops a probe whose source has since changed", async () => {
    const { pending, trim, setVideo } = setup(
      [node("v", "generateVideo", { outputVideo: "a.mp4" }), node("t", "videoTrim", { duration: null, endTime: 0 })],
      [videoEdge("v", "t")],
    );
    const first = pending.get("a.mp4")!;
    setVideo("b.mp4");
    expect(first.signal.aborted).toBe(true);
    first.resolve(99);
    await flush();
    expect(trim()).toMatchObject({ duration: null, endTime: 0 });
    pending.get("b.mp4")!.resolve(7);
    await flush();
    expect(trim()).toMatchObject({ duration: 7, endTime: 7 });
  });

  it("probes again when the canvas is replaced, and stops when unsubscribed", () => {
    const { store, probe, pending, stop } = setup(
      [node("v", "generateVideo", { outputVideo: "a.mp4" }), node("t", "videoTrim", { duration: null, endTime: 0 })],
      [videoEdge("v", "t")],
    );
    store.setState({ canvasGeneration: 1 });
    expect(probe).toHaveBeenCalledTimes(2);
    const signal = pending.get("a.mp4")!.signal;
    stop();
    expect(signal.aborted).toBe(true);
  });
});
