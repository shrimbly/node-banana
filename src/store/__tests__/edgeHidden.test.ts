import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowEdge } from "@/types";

const initial = useWorkflowStore.getState();
const edge = (id: string, data: Record<string, unknown> = {}, selected = false): WorkflowEdge =>
  ({ id, source: "a", sourceHandle: "text", target: id, targetHandle: "text", data, selected });

describe("setEdgesHidden", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [edge("b", {}, true), edge("c")], groups: {} });
  });

  it("hides the given edges and drops their selection", () => {
    useWorkflowStore.getState().setEdgesHidden(["b"], true);
    const b = useWorkflowStore.getState().edges.find((e) => e.id === "b");
    expect(b?.data?.hidden).toBe(true);
    expect(b?.selected).toBe(false);
    expect(useWorkflowStore.getState().edges.find((e) => e.id === "c")?.data?.hidden).toBeUndefined();
  });

  it("shows them again and can be undone", () => {
    useWorkflowStore.getState().setEdgesHidden(["b", "c"], true);
    useWorkflowStore.getState().setEdgesHidden(["c"], false);
    expect(useWorkflowStore.getState().edges.map((e) => Boolean(e.data?.hidden))).toEqual([true, false]);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edges.map((e) => Boolean(e.data?.hidden))).toEqual([true, true]);
  });

  it("does nothing when every edge already matches", () => {
    const before = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().setEdgesHidden(["c"], false);
    expect(useWorkflowStore.getState().edges).toBe(before);
  });
});

describe("setAllEdgesHidden", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [edge("b"), edge("c", { hidden: true })], groups: {} });
  });

  it("hides and shows every edge", () => {
    useWorkflowStore.getState().setAllEdgesHidden(true);
    expect(useWorkflowStore.getState().edges.every((e) => e.data?.hidden)).toBe(true);
    useWorkflowStore.getState().setAllEdgesHidden(false);
    expect(useWorkflowStore.getState().edges.some((e) => e.data?.hidden)).toBe(false);
  });

  it("does nothing when nothing would change", () => {
    useWorkflowStore.getState().setAllEdgesHidden(false);
    const before = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().setAllEdgesHidden(false);
    expect(useWorkflowStore.getState().edges).toBe(before);
  });
});

describe("setHoveredHandle", () => {
  it("stores the handle under the pointer and ignores repeats", () => {
    useWorkflowStore.setState({ ...initial, hoveredHandle: null });
    useWorkflowStore.getState().setHoveredHandle({ nodeId: "a", handleId: "image", type: "source" });
    const first = useWorkflowStore.getState().hoveredHandle;
    expect(first).toEqual({ nodeId: "a", handleId: "image", type: "source" });
    useWorkflowStore.getState().setHoveredHandle({ nodeId: "a", handleId: "image", type: "source" });
    expect(useWorkflowStore.getState().hoveredHandle).toBe(first);
    useWorkflowStore.getState().setHoveredHandle(null);
    expect(useWorkflowStore.getState().hoveredHandle).toBeNull();
  });
});

describe("setExpandedStubGroup", () => {
  it("remembers which handle's hidden connections are expanded", () => {
    useWorkflowStore.setState({ ...initial, expandedStubGroup: null });
    useWorkflowStore.getState().setExpandedStubGroup("b:target:image");
    expect(useWorkflowStore.getState().expandedStubGroup).toBe("b:target:image");
    useWorkflowStore.getState().setExpandedStubGroup(null);
    expect(useWorkflowStore.getState().expandedStubGroup).toBeNull();
  });
});

describe("setStubGroupWidth", () => {
  it("records a collapsed pill's width by group key without churning on repeats", () => {
    useWorkflowStore.setState({ ...initial, stubGroupWidths: {} });
    useWorkflowStore.getState().setStubGroupWidth("b:target:image", 80);
    const widths = useWorkflowStore.getState().stubGroupWidths;
    expect(widths).toEqual({ "b:target:image": 80 });
    useWorkflowStore.getState().setStubGroupWidth("b:target:image", 80);
    expect(useWorkflowStore.getState().stubGroupWidths).toBe(widths);
  });
});
