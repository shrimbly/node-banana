/**
 * reconnectEdge: moving one end of an existing edge to a different handle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowNode, WorkflowEdge } from "@/types";

const initial = useWorkflowStore.getState();

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data } as unknown as WorkflowNode);

const edge = (source: string, target: string, data: Record<string, unknown> = {}): WorkflowEdge => ({
  id: `edge-${source}-${target}-image-image`,
  source,
  sourceHandle: "image",
  target,
  targetHandle: "image",
  data,
});

describe("reconnectEdge", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      ...initial,
      nodes: [
        node("a", "imageInput", { image: "data:image/png;base64,AAA" }),
        node("b", "nanoBanana", { inputImages: ["data:image/png;base64,AAA"] }),
        node("c", "nanoBanana", {}),
      ],
      edges: [edge("a", "b", { hasPause: true, createdAt: 123 })],
      groups: {},
    });
  });

  it("moves the edge to the new target and keeps its data", () => {
    const ok = useWorkflowStore.getState().reconnectEdge("edge-a-b-image-image", {
      source: "a",
      sourceHandle: "image",
      target: "c",
      targetHandle: "image",
    });
    expect(ok).toBe(true);
    const edges = useWorkflowStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: "edge-a-c-image-image",
      source: "a",
      target: "c",
      data: { hasPause: true, createdAt: 123 },
    });
    expect(edges[0].data?.isLoop).toBeUndefined();
  });

  it("clears the old target's stale input images", () => {
    useWorkflowStore.getState().reconnectEdge("edge-a-b-image-image", {
      source: "a",
      sourceHandle: "image",
      target: "c",
      targetHandle: "image",
    });
    const b = useWorkflowStore.getState().nodes.find((n) => n.id === "b");
    expect((b?.data as { inputImages?: string[] }).inputImages ?? []).toEqual([]);
  });

  it("refuses when an identical edge already exists", () => {
    useWorkflowStore.setState({
      edges: [edge("a", "b"), edge("a", "c")],
    });
    const ok = useWorkflowStore.getState().reconnectEdge("edge-a-b-image-image", {
      source: "a",
      sourceHandle: "image",
      target: "c",
      targetHandle: "image",
    });
    expect(ok).toBe(false);
    expect(useWorkflowStore.getState().edges).toHaveLength(2);
  });

  it("refuses an unknown edge or an incomplete connection", () => {
    const store = useWorkflowStore.getState();
    expect(store.reconnectEdge("nope", { source: "a", sourceHandle: "image", target: "c", targetHandle: "image" })).toBe(false);
    expect(store.reconnectEdge("edge-a-b-image-image", { source: "a", sourceHandle: "image", target: "", targetHandle: "image" })).toBe(false);
    expect(useWorkflowStore.getState().edges[0].target).toBe("b");
  });

  it("is a no-op when dropped back on the same handle", () => {
    const ok = useWorkflowStore.getState().reconnectEdge("edge-a-b-image-image", {
      source: "a",
      sourceHandle: "image",
      target: "b",
      targetHandle: "image",
    });
    expect(ok).toBe(false);
  });

  it("marks the edge as a loop when the new end closes a cycle", () => {
    useWorkflowStore.setState({
      nodes: [node("a", "nanoBanana"), node("b", "nanoBanana"), node("c", "nanoBanana")],
      edges: [edge("a", "b"), edge("b", "c")],
    });
    // Re-plug b→c so it points back at a: a→b→a is a cycle
    useWorkflowStore.getState().reconnectEdge("edge-b-c-image-image", {
      source: "b",
      sourceHandle: "image",
      target: "a",
      targetHandle: "image",
    });
    const moved = useWorkflowStore.getState().edges.find((e) => e.id === "edge-b-a-image-image");
    expect(moved?.data).toMatchObject({ isLoop: true, loopCount: 3 });
  });

  it("drops loop status when the new end no longer closes a cycle", () => {
    useWorkflowStore.setState({
      nodes: [node("a", "nanoBanana"), node("b", "nanoBanana"), node("c", "nanoBanana")],
      edges: [edge("a", "b"), edge("b", "a", { isLoop: true, loopCount: 5 })],
    });
    useWorkflowStore.getState().reconnectEdge("edge-b-a-image-image", {
      source: "b",
      sourceHandle: "image",
      target: "c",
      targetHandle: "image",
    });
    const moved = useWorkflowStore.getState().edges.find((e) => e.id === "edge-b-c-image-image");
    expect(moved?.data?.isLoop).toBeUndefined();
    expect(moved?.data?.loopCount).toBeUndefined();
  });

  it("can be undone", () => {
    useWorkflowStore.getState().reconnectEdge("edge-a-b-image-image", {
      source: "a",
      sourceHandle: "image",
      target: "c",
      targetHandle: "image",
    });
    useWorkflowStore.getState().undo();
    const edges = useWorkflowStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].target).toBe("b");
  });
});
