import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { diffNodes, indexOfNode, replaceNodesAt } from "../nodeChanges";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "../workflowStore";
import type { WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined), getCurrentSession: vi.fn().mockReturnValue(null) },
}));

const node = (id: string, prompt = ""): WorkflowNode =>
  ({ id, type: "prompt", position: { x: 0, y: 0 }, data: { prompt } }) as WorkflowNode;

describe("diffNodes", () => {
  it("reports updated, added and removed ids by object identity", () => {
    const a = node("a"), b = node("b"), c = node("c");
    const next = [{ ...a, position: { x: 1, y: 0 } }, b, node("d")];
    const changes = diffNodes([a, b, c], next);
    expect([...changes.updated]).toEqual(["a"]);
    expect([...changes.added]).toEqual(["d"]);
    expect([...changes.removed]).toEqual(["c"]);
  });

  it("takes the ids an in-place replacement recorded without comparing", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const next = replaceNodesAt(nodes, new Map([[1, node("b", "x")]]));
    expect(next[0]).toBe(nodes[0]);
    expect(next[2]).toBe(nodes[2]);
    expect(indexOfNode(next, "c")).toBe(2);
    expect([...diffNodes(nodes, next).updated]).toEqual(["b"]);
  });
});

describe("subscribeToWorkflowNodeChanges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkflowStore.getState().clearWorkflow();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the node a keystroke changed, and nothing for changes that leave nodes alone", () => {
    const store = useWorkflowStore.getState();
    const a = store.addNode("prompt", { x: 0, y: 0 });
    store.addNode("prompt", { x: 400, y: 0 });
    const listener = vi.fn();
    const unsubscribe = subscribeToWorkflowNodeChanges(listener);

    useWorkflowStore.getState().updateNodeData(a, { prompt: "a fox" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect([...listener.mock.calls[0][0].updated]).toEqual([a]);

    useWorkflowStore.getState().setEdgeStyle("curved");
    expect(listener).toHaveBeenCalledTimes(1);

    const c = useWorkflowStore.getState().addNode("prompt", { x: 800, y: 0 });
    expect([...listener.mock.calls[1][0].added]).toEqual([c]);

    useWorkflowStore.getState().removeNode(a);
    expect([...listener.mock.calls[2][0].removed]).toEqual([a]);
    unsubscribe();
  });

  it("selects by replacing only the nodes whose selection flips, keeping the others", () => {
    const store = useWorkflowStore.getState();
    const a = store.addNode("prompt", { x: 0, y: 0 });
    const b = store.addNode("prompt", { x: 400, y: 0 });
    useWorkflowStore.setState({ hasUnsavedChanges: false });
    const before = useWorkflowStore.getState().nodes;
    const listener = vi.fn();
    const unsubscribe = subscribeToWorkflowNodeChanges(listener);

    useWorkflowStore.getState().onNodesChange([{ type: "select", id: a, selected: true }, { type: "select", id: b, selected: false }]);
    const after = useWorkflowStore.getState().nodes;
    expect(after.find((n) => n.id === a)?.selected).toBe(true);
    expect(after.find((n) => n.id === b)).toBe(before.find((n) => n.id === b));
    expect([...listener.mock.calls[0][0].updated]).toEqual([a]);
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(false);

    useWorkflowStore.getState().onNodesChange([{ type: "select", id: a, selected: true }]);
    expect(useWorkflowStore.getState().nodes).toBe(after);
    unsubscribe();
  });
});
