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

  it("gives connections from one handle a shared bundle id at that end", () => {
    expect(useWorkflowStore.getState().bundleEdges(["e1", "e2"])).toBe(true);
    const [e1, e2, e3] = useWorkflowStore.getState().edges;
    expect(e1.data?.sourceBundleId).toBeTruthy();
    expect(e2.data?.sourceBundleId).toBe(e1.data?.sourceBundleId);
    expect(e1.data?.targetBundleId).toBeUndefined();
    expect(e3.data?.sourceBundleId).toBeUndefined();
  });

  it("bundles the other end without touching the first", () => {
    useWorkflowStore.setState({
      edges: [edge("e1", { target: "gen" }), edge("e2", { target: "gen" }), edge("e9", { source: "z", target: "gen" })],
    });
    useWorkflowStore.getState().bundleEdges(["e1", "e2"], "source");
    expect(useWorkflowStore.getState().bundleEdges(["e1", "e2", "e9"], "target")).toBe(true);
    const [e1, e2, e9] = useWorkflowStore.getState().edges;
    expect(e1.data?.sourceBundleId).toBe(e2.data?.sourceBundleId);
    expect(e1.data?.targetBundleId).toBe(e9.data?.targetBundleId);
    expect(e1.data?.targetBundleId).not.toBe(e1.data?.sourceBundleId);
    // Unbundling one end leaves the other alone
    useWorkflowStore.getState().unbundleEdges(["e1"], "target");
    const after = useWorkflowStore.getState().edges;
    expect(after.some((e) => e.data?.targetBundleId)).toBe(false);
    expect(after[0].data?.sourceBundleId).toBe(after[1].data?.sourceBundleId);
    expect(after[0].data?.sourceBundleId).toBeTruthy();
  });

  it("refuses an end the edges do not share", () => {
    expect(useWorkflowStore.getState().bundleEdges(["e1", "e2"], "target")).toBe(false);
  });

  it("refuses edges on different handles, or fewer than two", () => {
    expect(useWorkflowStore.getState().bundleEdges(["e1", "e3"])).toBe(false);
    expect(useWorkflowStore.getState().bundleEdges(["e1"])).toBe(false);
    expect(useWorkflowStore.getState().edges.some((e) => e.data?.sourceBundleId)).toBe(false);
  });

  it("dissolves the whole bundle from any member and can be undone", () => {
    useWorkflowStore.getState().bundleEdges(["e1", "e2"]);
    useWorkflowStore.getState().unbundleEdges(["e2"]);
    expect(useWorkflowStore.getState().edges.some((e) => e.data?.sourceBundleId)).toBe(false);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edges.filter((e) => e.data?.sourceBundleId)).toHaveLength(2);
  });

  it("ignores edges outside any bundle", () => {
    const before = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().unbundleEdges(["e3"]);
    expect(useWorkflowStore.getState().edges).toBe(before);
  });
});

describe("hook bundles", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [edge("e1"), edge("e2", { source: "other", target: "different" }), edge("e3")], groups: {} });
  });

  it("gathers different endpoints into one clamp without rewiring, and supports undo", () => {
    const before = useWorkflowStore.getState().edges;
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 80, y: 90 });
    const [a, b, c] = useWorkflowStore.getState().edges;
    expect(a.data?.hookBundles?.[0]).toEqual(b.data?.hookBundles?.[0]);
    expect(a.data?.hookBundles?.[0]).toMatchObject({ x: 80, y: 90 });
    expect([a, b].map((e) => [e.source, e.target])).toEqual(before.slice(0, 2).map((e) => [e.source, e.target]));
    expect(c.data?.hookBundles?.[0]).toBeUndefined();
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edges.every((e) => !e.data?.hookBundles?.[0])).toBe(true);
  });

  it("moves all members together and removes only the bundle", () => {
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 80, y: 90 });
    const id = useWorkflowStore.getState().edges[0].data!.hookBundles![0].id;
    useWorkflowStore.getState().moveHookBundle(id, { x: 150, y: 120 }, true);
    expect(useWorkflowStore.getState().edges.slice(0, 2).every((e) => e.data?.hookBundles?.[0]?.x === 150)).toBe(true);
    useWorkflowStore.getState().removeHookBundle(id);
    expect(useWorkflowStore.getState().edges).toHaveLength(3);
    expect(useWorkflowStore.getState().edges.every((e) => !e.data?.hookBundles?.[0])).toBe(true);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().edges[0].data?.hookBundles?.[0]?.x).toBe(150);
  });

  it("adds a second handle, moves it independently, and removes only that handle", () => {
    const store = useWorkflowStore.getState();
    store.hookEdges(["e1", "e2"], { x: 80, y: 90 });
    const first = useWorkflowStore.getState().edges[0].data!.hookBundles![0];
    store.hookEdges(["e1", "e2"], { x: 160, y: 90 });
    const handles = useWorkflowStore.getState().edges[0].data!.hookBundles!;
    expect(handles).toHaveLength(2);
    expect(handles[0]).toEqual(first);
    expect(useWorkflowStore.getState().edges[1].data!.hookBundles).toEqual(handles);
    const second = handles[1];
    store.moveHookBundle(second.id, { x: 200, y: 120 }, true);
    expect(useWorkflowStore.getState().edges[0].data!.hookBundles).toEqual([first, { ...second, x: 200, y: 120 }]);
    store.removeHookBundle(second.id);
    expect(useWorkflowStore.getState().edges[0].data!.hookBundles).toEqual([first]);
    expect(useWorkflowStore.getState().edges).toHaveLength(3);
    store.undo();
    expect(useWorkflowStore.getState().edges[0].data!.hookBundles).toHaveLength(2);
  });

  it("preserves a legacy saved handle when adding another", () => {
    const legacy = { id: "legacy", x: 80, y: 90 };
    useWorkflowStore.setState({ edges: [edge("e1", { data: { hookBundle: legacy } }), edge("e2", { data: { hookBundle: legacy } })] });
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 160, y: 90 });
    const data = useWorkflowStore.getState().edges[0].data!;
    expect(data.hookBundles).toHaveLength(2);
    expect(data.hookBundles![0]).toEqual(legacy);
    expect(data.hookBundle).toBeUndefined();
  });

  it("merges an existing bundle when one of its members is hooked", () => {
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 80, y: 90 });
    useWorkflowStore.getState().hookEdges(["e2", "e3"], { x: 120, y: 90 });
    const handles = useWorkflowStore.getState().edges.map((e) => e.data?.hookBundles ?? []);
    expect(handles[0]).toHaveLength(2);
    expect(handles[1]).toHaveLength(2);
    expect(handles[2]).toHaveLength(1);
    expect(handles.every((list) => list.some((handle) => handle.id === handles[2][0].id))).toBe(true);
    expect(useWorkflowStore.getState().edges.every((e) => e.selected)).toBe(true);
  });

  it("ignores hidden and reference edges, single edges and invalid coordinates", () => {
    const edges = [edge("e1"), edge("e2", { data: { hidden: true } }), edge("e3", { type: "reference" })];
    useWorkflowStore.setState({ edges });
    useWorkflowStore.getState().hookEdges(["e1", "e2", "e3"], { x: 0, y: 0 });
    expect(useWorkflowStore.getState().edges).toBe(edges);
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: NaN, y: 0 });
    expect(useWorkflowStore.getState().edges).toBe(edges);
  });

  it("gives a pasted bundle its own clamp and offsets it with the copied nodes", () => {
    useWorkflowStore.setState({
      nodes: ["a", "t-e1", "t-e2"].map((id) => ({ id, type: "prompt", position: { x: 0, y: 0 }, selected: true, data: { prompt: "" } })),
      edges: [edge("e1"), edge("e2")],
    });
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 80, y: 90 });
    const original = useWorkflowStore.getState().edges[0].data!.hookBundles![0];
    useWorkflowStore.getState().hookEdges(["e1", "e2"], { x: 160, y: 90 });
    const originals = useWorkflowStore.getState().edges[0].data!.hookBundles!;
    useWorkflowStore.getState().copySelectedNodes();
    useWorkflowStore.getState().pasteNodes({ x: 100, y: 200 });
    const pasted = useWorkflowStore.getState().edges.slice(2);
    expect(pasted).toHaveLength(2);
    expect(pasted[0].data?.hookBundles?.[0]).toEqual(pasted[1].data?.hookBundles?.[0]);
    const pastedHandles = pasted[0].data!.hookBundles!;
    expect(pastedHandles).toHaveLength(2);
    expect(pastedHandles).toEqual(originals.map((handle) => expect.objectContaining({ x: handle.x + 100, y: handle.y + 200 })));
    expect(pastedHandles.every((handle) => originals.every((old) => old.id !== handle.id))).toBe(true);
    expect(pastedHandles.some((handle) => handle.id === original.id)).toBe(false);
  });
});

describe("setBundleClamp", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      ...initial,
      nodes: [{ id: "a", type: "imageInput", position: { x: 0, y: 0 }, data: {} } as never],
      edges: [],
      groups: {},
    });
  });

  it("stores the split distance on the node's handle, clamped to the allowed range", () => {
    useWorkflowStore.getState().setBundleClamp("a", "source:image", 120.4);
    useWorkflowStore.getState().setBundleClamp("a", "target:image", 2);
    useWorkflowStore.getState().setBundleClamp("a", "source:text", 50000);
    const data = useWorkflowStore.getState().nodes[0].data as { bundleClamps?: Record<string, number> };
    expect(data.bundleClamps).toEqual({ "source:image": 120, "target:image": 16, "source:text": 4000 });
  });

  it("ignores unknown nodes and unchanged values", () => {
    useWorkflowStore.getState().setBundleClamp("a", "source:image", 100);
    const before = useWorkflowStore.getState().nodes;
    useWorkflowStore.getState().setBundleClamp("a", "source:image", 100);
    useWorkflowStore.getState().setBundleClamp("nope", "source:image", 100);
    expect(useWorkflowStore.getState().nodes).toBe(before);
  });
});
