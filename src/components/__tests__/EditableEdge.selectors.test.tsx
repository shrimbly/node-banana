import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ReactFlowProvider, Position } from "@xyflow/react";
import { EditableEdge } from "@/components/edges/EditableEdge";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";

/**
 * Guard rail for the cost of an edge's store subscriptions on a large graph.
 *
 * Every edge subscribes to the store, and the store updates on every frame
 * of a drag, so anything an edge reads from the other edges must come from
 * an index built once per edges array. These tests watch the edges array
 * itself: a nodes-only update must not read it at all, and an edges update
 * may read each element a bounded number of times in total, not once per
 * edge (which is what a scan in each edge's selector amounts to).
 */

const EDGE_COUNT = 200;

/** An array whose element reads are counted, including reads made by its own methods. */
function countingArray<T>(items: T[]): { array: T[]; reads: () => number } {
  let reads = 0;
  const array = new Proxy(items, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { array, reads: () => reads };
}

function makeGraph() {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < EDGE_COUNT; i++) {
    nodes.push({
      id: `node-${i}`,
      type: i % 2 ? "nanoBanana" : "imageInput",
      position: { x: i * 10, y: 0 },
      data: {},
    } as WorkflowNode);
  }
  for (let i = 0; i < EDGE_COUNT; i++) {
    const source = `node-${(i * 2) % EDGE_COUNT}`;
    const target = `node-${(i * 2 + 1) % EDGE_COUNT}`;
    edges.push({
      id: `edge-${i}`,
      source,
      sourceHandle: "image",
      target,
      targetHandle: "image",
      data: {
        createdAt: 1_000 + i,
        hidden: i % 7 === 0,
        sourceBundleId: i % 5 === 0 ? `bundle-${i % 20}` : undefined,
        hookBundles: i % 3 === 0 ? [{ id: `hook-${i % 6}`, x: 30, y: 20 }, { id: `second-${i % 6}`, x: 70, y: 20 }] : undefined,
      },
    });
  }
  return { nodes, edges };
}

function renderEdges(edges: WorkflowEdge[]) {
  return render(
    <ReactFlowProvider>
      <svg>
        {edges.map((edge) => (
          <EditableEdge
            key={edge.id}
            id={edge.id}
            source={edge.source}
            target={edge.target}
            sourceHandleId={edge.sourceHandle ?? null}
            targetHandleId={edge.targetHandle ?? null}
            sourceX={0}
            sourceY={0}
            targetX={100}
            targetY={0}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            selected={false}
            data={edge.data}
          />
        ))}
      </svg>
    </ReactFlowProvider>
  );
}

describe("EditableEdge store subscriptions on a large graph", () => {
  const initial = useWorkflowStore.getState();

  beforeEach(() => {
    useWorkflowStore.setState({ nodes: [], edges: [] });
  });

  afterEach(() => {
    useWorkflowStore.setState({ nodes: initial.nodes, edges: initial.edges });
  });

  it("does not read the edges when only the nodes change, as on every drag frame", () => {
    const { nodes, edges } = makeGraph();
    const counted = countingArray(edges);
    act(() => useWorkflowStore.setState({ nodes, edges: counted.array }));
    renderEdges(edges);

    const before = counted.reads();
    act(() => useWorkflowStore.setState({ nodes: nodes.map((n) => (n.id === "node-3" ? { ...n, position: { x: 1, y: 1 } } : n)) }));
    expect(counted.reads() - before).toBe(0);
  });

  it("reads each edge a bounded number of times when the edges change, not once per edge", () => {
    const { nodes, edges } = makeGraph();
    act(() => useWorkflowStore.setState({ nodes, edges }));
    renderEdges(edges);

    const next = countingArray(edges.map((e) => (e.id === "edge-3" ? { ...e, data: { ...e.data, label: "renamed" } } : e)));
    act(() => useWorkflowStore.setState({ edges: next.array }));
    // Building the index takes a handful of passes plus a sort; a scan per
    // edge would read every element once per edge, EDGE_COUNT times more.
    expect(next.reads()).toBeLessThan(EDGE_COUNT * 60);
  });
});
