/**
 * Batch runs in the store: the run count saved with the workflow, runBatch
 * repeating a scope, and the Run button's two-step Stop.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import type { WorkflowEdge, WorkflowNode, WorkflowNodeData } from "@/types";
import { MAX_RUN_COUNT } from "../utils/runBatch";
import { captureWorkflowTabSnapshot } from "../utils/workflowTabs";

const initial = useWorkflowStore.getState();

function makeNode(id: string, type: string, data?: Partial<WorkflowNodeData>): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data: data || {} } as WorkflowNode;
}

function makeEdge(source: string, target: string, data: WorkflowEdge["data"] = {}): WorkflowEdge {
  return { id: `${source}-${target}`, source, target, data } as WorkflowEdge;
}

/** Prompt → output: a graph that runs without any provider. */
function setupGraph(edgeData: WorkflowEdge["data"] = {}) {
  useWorkflowStore.setState({
    nodes: [makeNode("p", "prompt", { prompt: "hills" }), makeNode("o", "output")],
    edges: [makeEdge("p", "o", edgeData)],
  });
}

/** Calls `onStart(runNumber)` each time a run starts; returns the unsubscribe and the run log. */
function watchRuns(onStart?: (run: number) => void) {
  const starts: { index: number | null; count: number | null }[] = [];
  const unsubscribe = useWorkflowStore.subscribe((state, previous) => {
    if (state.isRunning && !previous.isRunning) {
      starts.push({ index: state.batch?.index ?? null, count: state.batch?.count ?? null });
      onStart?.(starts.length);
    }
  });
  return { starts, unsubscribe };
}

describe("run count", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [], groups: {}, runCount: 1, batch: null, hasUnsavedChanges: false });
  });

  it("clamps and marks the workflow changed, since it is saved with it", () => {
    useWorkflowStore.getState().setRunCount(10);
    expect(useWorkflowStore.getState().runCount).toBe(10);
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(true);
    useWorkflowStore.getState().setRunCount(0);
    expect(useWorkflowStore.getState().runCount).toBe(1);
    useWorkflowStore.getState().setRunCount(500);
    expect(useWorkflowStore.getState().runCount).toBe(MAX_RUN_COUNT);
  });

  it("loads from the workflow file, one when the file has none", async () => {
    await useWorkflowStore.getState().loadWorkflow({ version: 1, name: "A", nodes: [], edges: [], edgeStyle: "curved", runCount: 7 });
    expect(useWorkflowStore.getState().runCount).toBe(7);
    await useWorkflowStore.getState().loadWorkflow({ version: 1, name: "B", nodes: [], edges: [], edgeStyle: "curved" });
    expect(useWorkflowStore.getState().runCount).toBe(1);
    await useWorkflowStore.getState().loadWorkflow({ version: 1, name: "C", nodes: [], edges: [], edgeStyle: "curved", runCount: 9000 });
    expect(useWorkflowStore.getState().runCount).toBe(MAX_RUN_COUNT);
  });

  it("is parked with the workflow's tab", () => {
    useWorkflowStore.getState().setRunCount(4);
    expect(captureWorkflowTabSnapshot(useWorkflowStore.getState()).runCount).toBe(4);
  });

  it("resets to one when the canvas is cleared", () => {
    useWorkflowStore.getState().setRunCount(4);
    useWorkflowStore.getState().clearWorkflow();
    expect(useWorkflowStore.getState().runCount).toBe(1);
  });
});

describe("runBatch", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initial, nodes: [], edges: [], groups: {}, isRunning: false, pausedAtNodeId: null, runCount: 1, batch: null });
  });

  afterEach(() => {
    useWorkflowStore.setState({ isRunning: false, batch: null });
  });

  it("runs once, with no batch, at a count of one", async () => {
    setupGraph();
    const { starts, unsubscribe } = watchRuns();
    await useWorkflowStore.getState().runBatch({ kind: "all" });
    unsubscribe();
    expect(starts).toEqual([{ index: null, count: null }]);
  });

  it("runs the whole graph count times, one after another, numbering each run", async () => {
    setupGraph();
    useWorkflowStore.getState().setRunCount(3);
    const { starts, unsubscribe } = watchRuns();
    await useWorkflowStore.getState().runBatch({ kind: "all" });
    unsubscribe();
    expect(starts).toEqual([
      { index: 1, count: 3 },
      { index: 2, count: 3 },
      { index: 3, count: 3 },
    ]);
    expect(useWorkflowStore.getState().batch).toBeNull();
    expect(useWorkflowStore.getState().isRunning).toBe(false);
  });

  it("repeats the selected nodes too", async () => {
    setupGraph();
    useWorkflowStore.getState().setRunCount(2);
    const { starts, unsubscribe } = watchRuns();
    await useWorkflowStore.getState().runBatch({ kind: "nodes", nodeIds: ["p"] });
    unsubscribe();
    expect(starts).toHaveLength(2);
  });

  it("runs a count it is given instead of the saved one, and leaves the saved one alone", async () => {
    setupGraph();
    useWorkflowStore.getState().setRunCount(5);
    useWorkflowStore.setState({ hasUnsavedChanges: false });
    const { starts, unsubscribe } = watchRuns();
    await useWorkflowStore.getState().runBatch({ kind: "all" }, 2);
    await useWorkflowStore.getState().runBatch({ kind: "all" }, 1);
    unsubscribe();
    expect(starts).toEqual([
      { index: 1, count: 2 },
      { index: 2, count: 2 },
      { index: null, count: null },
    ]);
    expect(useWorkflowStore.getState().runCount).toBe(5);
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(false);
  });

  it("first Stop lets the current run finish, then ends the batch", async () => {
    setupGraph();
    useWorkflowStore.getState().setRunCount(5);
    const { starts, unsubscribe } = watchRuns((run) => {
      if (run === 2) useWorkflowStore.getState().requestStop();
    });
    await useWorkflowStore.getState().runBatch({ kind: "all" });
    unsubscribe();
    expect(starts).toHaveLength(2);
    expect(useWorkflowStore.getState().batch).toBeNull();
  });

  it("second Stop stops now", async () => {
    setupGraph();
    useWorkflowStore.getState().setRunCount(5);
    const { starts, unsubscribe } = watchRuns((run) => {
      if (run === 2) {
        useWorkflowStore.getState().requestStop();
        expect(useWorkflowStore.getState().batch?.stopping).toBe(true);
        useWorkflowStore.getState().requestStop();
        expect(useWorkflowStore.getState().batch).toBeNull();
        expect(useWorkflowStore.getState().isRunning).toBe(false);
      }
    });
    await useWorkflowStore.getState().runBatch({ kind: "all" });
    unsubscribe();
    expect(starts).toHaveLength(2);
  });

  it("ends the batch at a pause edge", async () => {
    setupGraph({ hasPause: true });
    useWorkflowStore.getState().setRunCount(4);
    const { starts, unsubscribe } = watchRuns();
    await useWorkflowStore.getState().runBatch({ kind: "all" });
    unsubscribe();
    expect(starts).toHaveLength(1);
    expect(useWorkflowStore.getState().pausedAtNodeId).toBe("o");
    expect(useWorkflowStore.getState().batch).toBeNull();
  });

  it("ignores a second batch while one is going", async () => {
    setupGraph();
    useWorkflowStore.getState().setRunCount(2);
    const { starts, unsubscribe } = watchRuns();
    const first = useWorkflowStore.getState().runBatch({ kind: "all" });
    await useWorkflowStore.getState().runBatch({ kind: "all" });
    await first;
    unsubscribe();
    expect(starts).toHaveLength(2);
  });
});
