import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowEdge } from "@/types";

const initial = useWorkflowStore.getState();
const edge = (id: string, data: Record<string, unknown> = {}): WorkflowEdge =>
  ({ id, source: "a", sourceHandle: "text", target: id, targetHandle: "text", data });

describe("removeEdges", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [edge("b"), edge("c"), edge("d")], groups: {} });
  });

  it("removes the given edges in one undo step", () => {
    useWorkflowStore.getState().removeEdges(["b", "d"]);
    expect(useWorkflowStore.getState().edges.map((e) => e.id)).toEqual(["c"]);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edges.map((e) => e.id)).toEqual(["b", "c", "d"]);
  });

  it("ignores unknown ids", () => {
    useWorkflowStore.getState().removeEdges(["nope"]);
    expect(useWorkflowStore.getState().edges).toHaveLength(3);
  });
});

describe("setEdgesPause", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [edge("b"), edge("c", { hasPause: true })], groups: {} });
  });

  it("pauses and resumes several edges together", () => {
    useWorkflowStore.getState().setEdgesPause(["b", "c"], true);
    expect(useWorkflowStore.getState().edges.every((e) => e.data?.hasPause)).toBe(true);
    useWorkflowStore.getState().setEdgesPause(["b", "c"], false);
    expect(useWorkflowStore.getState().edges.some((e) => e.data?.hasPause)).toBe(false);
  });

  it("does nothing when every edge already matches", () => {
    const before = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().setEdgesPause(["c"], true);
    expect(useWorkflowStore.getState().edges).toBe(before);
  });
});
