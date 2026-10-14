import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { WorkflowNode } from "@/types";
import { watchGenerationErrors } from "../errorToasts";

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;

function setup(nodes: WorkflowNode[]) {
  const show = vi.fn();
  const store = create(() => ({ nodes }));
  const stop = watchGenerationErrors(store, show);
  const set = (id: string, data: Record<string, unknown>) =>
    store.setState({ nodes: store.getState().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)) });
  return { store, show, stop, set };
}

describe("watchGenerationErrors", () => {
  it("shows one toast as a generation node's status turns to error", () => {
    const { show, set, stop } = setup([node("g", "nanoBanana", { status: "idle" }), node("v", "generateVideo", { status: "loading" }), node("p", "prompt", {})]);
    set("g", { status: "loading" });
    set("g", { status: "error", error: "quota" });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("Generation failed", "quota");
    // Still in error: nothing more.
    set("g", { customTitle: "x" });
    expect(show).toHaveBeenCalledTimes(1);
    set("v", { status: "error", error: "bad" });
    expect(show).toHaveBeenLastCalledWith("Video generation failed", "bad");
    // Other types, and errors without a message, show nothing.
    set("p", { status: "error", error: "x" });
    set("g", { status: "idle" });
    set("g", { status: "error", error: null });
    expect(show).toHaveBeenCalledTimes(2);
    stop();
    set("v", { status: "idle" });
    set("v", { status: "error", error: "again" });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("shows nothing for a node that arrives in error", () => {
    const { store, show } = setup([]);
    store.setState({ nodes: [node("t", "generate3d", { status: "error", error: "x" })] });
    expect(show).not.toHaveBeenCalled();
  });
});
