import type { AgentGraphOpBatch } from "../types";

/**
 * The nodes a batch visibly changed, for the canvas shimmer: added, edited,
 * moved, regrouped, or given a new input. Removed nodes are gone, and a
 * node's outgoing wire changes the node it feeds, not the node itself.
 */
export function agentTouchedNodeIds(batch: AgentGraphOpBatch): string[] {
  const touched = new Set<string>();
  const removed = new Set<string>();
  for (const op of batch.ops) {
    switch (op.op) {
      case "addNode":
      case "updateNode":
      case "moveNode":
      case "setNodeGroup":
        touched.add(op.id);
        break;
      case "addEdge":
        touched.add(op.target);
        break;
      case "addGroup":
        for (const id of op.nodeIds) touched.add(id);
        break;
      case "removeNode":
        removed.add(op.id);
        break;
    }
  }
  return [...touched].filter((id) => !removed.has(id));
}
