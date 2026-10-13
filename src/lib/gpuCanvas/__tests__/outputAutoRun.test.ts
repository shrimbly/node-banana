import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { watchOutputAutoRun } from "../outputAutoRun";

const node = (id: string, type = "output") => ({ id, type, position: { x: 0, y: 0 }, data: {} }) as unknown as WorkflowNode;
const edge = (id: string, source: string, target: string) => ({ id, source, target }) as WorkflowEdge;

function setup(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const regenerateNode = vi.fn();
  const store = create(() => ({ nodes, edges, canvasGeneration: 0, regenerateNode }));
  const stop = watchOutputAutoRun(store);
  return { store, regenerateNode, stop };
}

describe("watchOutputAutoRun", () => {
  it("runs an Output node when a connection arrives at it, and only then", () => {
    const { store, regenerateNode, stop } = setup([node("p", "prompt"), node("o"), node("q")], [edge("e0", "p", "q")]);
    store.setState({ edges: [...store.getState().edges, edge("e1", "p", "o")] });
    expect(regenerateNode).toHaveBeenCalledTimes(1);
    expect(regenerateNode).toHaveBeenCalledWith("o");
    // Removing one runs nothing; nor does typing in a node.
    store.setState({ edges: store.getState().edges.filter((e) => e.id !== "e1") });
    store.setState({ nodes: store.getState().nodes.map((n) => (n.id === "p" ? { ...n, data: { prompt: "x" } } : n)) });
    expect(regenerateNode).toHaveBeenCalledTimes(1);
    stop();
    store.setState({ edges: [...store.getState().edges, edge("e2", "p", "o")] });
    expect(regenerateNode).toHaveBeenCalledTimes(1);
  });

  it("counts a new node from when it appears, and starts over when the canvas is replaced", () => {
    const { store, regenerateNode } = setup([node("p", "prompt")], []);
    // Pasted with its connection: nothing to run.
    store.setState({ nodes: [...store.getState().nodes, node("o")], edges: [edge("e1", "p", "o")] });
    expect(regenerateNode).not.toHaveBeenCalled();
    // A later connection runs it.
    store.setState({ edges: [...store.getState().edges, edge("e2", "p", "o")] });
    expect(regenerateNode).toHaveBeenCalledTimes(1);
    // A workflow opened with more connections: nothing runs.
    store.setState({ canvasGeneration: 1, nodes: [node("p", "prompt"), node("o")], edges: [edge("a", "p", "o"), edge("b", "p", "o"), edge("c", "p", "o")] });
    expect(regenerateNode).toHaveBeenCalledTimes(1);
  });

  it("runs a node added on its own and connected afterwards", () => {
    const { store, regenerateNode } = setup([node("p", "prompt")], []);
    store.setState({ nodes: [...store.getState().nodes, node("o")] });
    store.setState({ edges: [edge("e1", "p", "o")] });
    expect(regenerateNode).toHaveBeenCalledWith("o");
  });
});
