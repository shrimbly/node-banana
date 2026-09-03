import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowEdge } from "@/types";

const initial = useWorkflowStore.getState();
const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id, source: "a", sourceHandle: "image", target: `t-${id}`, targetHandle: "image", data: {}, ...overrides });

describe("bundleEdges / unbundleEdges", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [edge("e1"), edge("e2"), edge("e3", { sourceHandle: "text" })], groups: {} });
  });

  it("gives connections from one handle a shared bundle id", () => {
    expect(useWorkflowStore.getState().bundleEdges(["e1", "e2"])).toBe(true);
    const [e1, e2, e3] = useWorkflowStore.getState().edges;
    expect(e1.data?.bundleId).toBeTruthy();
    expect(e2.data?.bundleId).toBe(e1.data?.bundleId);
    expect(e3.data?.bundleId).toBeUndefined();
  });

  it("refuses edges on different handles, or fewer than two", () => {
    expect(useWorkflowStore.getState().bundleEdges(["e1", "e3"])).toBe(false);
    expect(useWorkflowStore.getState().bundleEdges(["e1"])).toBe(false);
    expect(useWorkflowStore.getState().edges.some((e) => e.data?.bundleId)).toBe(false);
  });

  it("dissolves the whole bundle from any member and can be undone", () => {
    useWorkflowStore.getState().bundleEdges(["e1", "e2"]);
    useWorkflowStore.getState().unbundleEdges(["e2"]);
    expect(useWorkflowStore.getState().edges.some((e) => e.data?.bundleId)).toBe(false);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edges.filter((e) => e.data?.bundleId)).toHaveLength(2);
  });

  it("ignores edges outside any bundle", () => {
    const before = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().unbundleEdges(["e3"]);
    expect(useWorkflowStore.getState().edges).toBe(before);
  });
});
