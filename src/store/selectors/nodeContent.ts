import type { WorkflowNode } from "@/types";

/** Content consumers must not subscribe to layout, measurement or selection. */
export type WorkflowNodeContent = Pick<WorkflowNode, "id" | "type" | "data">;

const cache = new WeakMap<WorkflowNode[], WorkflowNodeContent[]>();
let previous: WorkflowNodeContent[] = [];

/**
 * One projection per nodes array, shared by graph analysis and UI subscribers.
 * A drag produces new node objects but keeps their data: retain the content
 * array so consumers neither render nor repeat their derived calculations.
 * Weak keys let old drag frames and their media be collected.
 */
export function selectNodeContent({ nodes }: { nodes: WorkflowNode[] }): WorkflowNodeContent[] {
  const cached = cache.get(nodes);
  if (cached) return cached;
  const unchanged = nodes.length === previous.length && nodes.every((node, i) =>
    node.id === previous[i].id && node.type === previous[i].type && node.data === previous[i].data
  );
  if (!unchanged) previous = nodes.map(({ id, type, data }) => ({ id, type, data }));
  cache.set(nodes, previous);
  return previous;
}
