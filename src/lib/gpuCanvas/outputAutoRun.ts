/**
 * An Output node runs when a connection arrives at it (OutputNode's own
 * effect does this on today's canvas). On the GPU canvas a node is mounted
 * only while it is worked in, and a connection usually arrives at one that
 * is not (dropped from a drag elsewhere, made by the agent), so the canvas
 * watches the store instead: each Output node's incoming connections are
 * counted, and a count that grows runs the node. Counts start over, without
 * running anything, when a workflow is opened or the canvas replaced.
 */
import type { WorkflowEdge, WorkflowNode } from "@/types";

interface AutoRunState {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  canvasGeneration: number;
  regenerateNode: (nodeId: string) => unknown;
}

interface AutoRunStore {
  getState: () => AutoRunState;
  subscribe: (listener: (state: AutoRunState, previous: AutoRunState) => void) => () => void;
}

function incoming(state: AutoRunState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of state.nodes) if (node.type === "output") counts.set(node.id, 0);
  for (const edge of state.edges) {
    const count = counts.get(edge.target);
    if (count != null) counts.set(edge.target, count + 1);
  }
  return counts;
}

/** Runs Output nodes as their connections arrive; returns the unsubscribe. */
export function watchOutputAutoRun(store: AutoRunStore): () => void {
  let counts = incoming(store.getState());
  return store.subscribe((state, previous) => {
    // Nodes matter only as they come and go (typing must not walk the graph).
    const nodesChanged = state.nodes !== previous.nodes && state.nodes.length !== previous.nodes.length;
    if (state.edges === previous.edges && !nodesChanged && state.canvasGeneration === previous.canvasGeneration) return;
    const next = incoming(state);
    const replaced = state.canvasGeneration !== previous.canvasGeneration;
    if (!replaced && state.edges !== previous.edges) {
      // A node seen for the first time takes its count as given (pasted, or added with its connections).
      for (const [id, count] of next) {
        const before = counts.get(id);
        if (before != null && count > before) state.regenerateNode(id);
      }
    }
    counts = next;
  });
}
