/**
 * A workflow the agent built, in miniature: the boxes and connections the
 * full-page chat draws as a minimap under the call that built it.
 */

import type { AgentGraphPreview } from "../types";
import type { GraphDraft } from "./draft";
import { estimatedNodeHeight } from "./sizes";

/** Past this many nodes the chat draws no map: at 300px it would be noise, and the output would weigh on every later request. */
export const GRAPH_PREVIEW_MAX_NODES = 400;

export function graphPreview(draft: GraphDraft): AgentGraphPreview | undefined {
  if (draft.nodes.size === 0 || draft.nodes.size > GRAPH_PREVIEW_MAX_NODES) return undefined;
  const index = new Map<string, number>();
  const nodes: AgentGraphPreview["nodes"] = [];
  for (const node of draft.nodes.values()) {
    index.set(node.id, nodes.length);
    nodes.push([
      node.type,
      Math.round(node.position.x),
      Math.round(node.position.y),
      Math.round(node.width),
      Math.round(node.height || estimatedNodeHeight(node.type, { data: node.data, width: node.width })),
    ]);
  }
  const edges: AgentGraphPreview["edges"] = [];
  for (const edge of draft.edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source !== undefined && target !== undefined) edges.push([source, target]);
  }
  return { ...(draft.workflowName ? { name: draft.workflowName } : {}), nodes, edges };
}
